import os
import shutil
import sys
import argparse
import subprocess
import json
import base64
import ctypes
import errno
import hashlib
import re
import stat
import tempfile
import uuid
from event_protocol import emit, log_error, log_info, log_progress, log_success, log_warning
from PIL import Image

VIDEO_TOOLS_COMMAND = ''
VIDEO_TOOLS_ARGS = []

try:
    from pi_heif import register_heif_opener
except ImportError:
    register_heif_opener = None
else:
    register_heif_opener(thumbnails=False)

IMAGE_EXTENSIONS = ('.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp', '.tif', '.tiff', '.heic', '.heif', '.hif', '.avif')
HEIF_EXTENSIONS = ('.heic', '.heif', '.hif', '.avif')
VIDEO_EXTENSIONS = ('.mp4', '.mov', '.avi', '.m4v', '.mkv', '.webm', '.mpeg', '.mpg', '.mts', '.m2ts', '.crm')
RAW_EXTENSIONS = ('.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.dng', '.rwl', '.3fr', '.fff', '.iiq', '.pef', '.srw')
FFMPEG_IMAGE_EXTENSIONS = RAW_EXTENSIONS
JPG_PROXY_EXTENSIONS = ('.jpg', '.jpeg')
JPG_PROXY_FOLDER_NAMES = {'jpg'}


class MoveTransactionError(RuntimeError):
    def __init__(self, cause, rollback_errors):
        super().__init__(str(cause))
        self.cause = cause
        self.rollback_errors = rollback_errors


class PartialOperationError(RuntimeError):
    pass


class PublishCleanupError(OSError):
    def __init__(self, source, destination, cause, cleanup_error, recovery_marker):
        super().__init__(
            f"未提交目标清理失败：{destination}；完整 staging/源保留于 {source}；"
            f"恢复标记：{recovery_marker or '创建失败'}；原错误：{cause}；清理错误：{cleanup_error}"
        )
        self.source = os.path.abspath(source)
        self.destination = os.path.abspath(destination)
        self.cause = cause
        self.cleanup_error = cleanup_error
        self.recovery_marker = recovery_marker


def file_identity(path):
    stat = os.stat(path, follow_symlinks=False)
    return [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns]


def file_digest(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def path_is_within(path, allowed_root):
    path, root = os.path.abspath(path), os.path.abspath(allowed_root)
    try:
        if os.path.normcase(os.path.commonpath((path, root))) != os.path.normcase(root):
            return False
        probe = path
        while not os.path.exists(probe):
            parent = os.path.dirname(probe)
            if parent == probe:
                return False
            probe = parent
        return os.path.normcase(os.path.commonpath((os.path.realpath(probe), os.path.realpath(root)))) == os.path.normcase(os.path.realpath(root))
    except ValueError:
        return False


def atomic_write_recovery_payload(marker, payload, create):
    temporary = f"{marker}.{uuid.uuid4().hex}.tmp"
    try:
        with open(temporary, "xb") as output:
            output.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
            output.flush()
            os.fsync(output.fileno())
        if create:
            if not try_atomic_rename_no_replace(temporary, marker):
                os.rename(temporary, marker)
        else:
            os.replace(temporary, marker)
        return True
    except OSError:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        return False


def write_recovery_marker(source, destination, cause=None, cleanup_error=None, recovery_path=None,
                          state="uncommitted", initial_fields=None):
    operation_id = uuid.uuid4().hex
    marker = os.path.join(
        os.path.dirname(destination),
        f".{os.path.basename(destination)}.photoflow-recovery-{operation_id}.json",
    )
    identity = file_identity(destination) if os.path.exists(destination) else None
    staging_identity = file_identity(source) if os.path.isfile(source) else None
    payload = {
        "version": 1, "operationId": operation_id, "state": state,
        "stagingPath": os.path.abspath(source),
        "partialPath": os.path.abspath(destination),
        "recoveryPath": os.path.abspath(destination),
        "stagingIdentity": staging_identity,
        "stagingSize": staging_identity[2] if staging_identity else None,
        "stagingDigest": file_digest(source) if staging_identity else None,
        "ownershipIdentity": identity[:2] if identity else None,
        "partialIdentity": identity,
        "error": str(cause) if cause is not None else "",
        "cleanupError": str(cleanup_error) if cleanup_error is not None else "",
    }
    payload.update(initial_fields or {})
    return marker if atomic_write_recovery_payload(marker, payload, create=True) else None


def update_recovery_marker(marker, **updates):
    if not marker:
        return False
    try:
        with open(marker, "r", encoding="utf-8") as source:
            payload = json.load(source)
        payload.update(updates)
        return atomic_write_recovery_payload(marker, payload, create=False)
    except (OSError, ValueError):
        return False


def recover_incomplete_publication(marker_path, allowed_root, expected_directory):
    marker_path = os.path.abspath(marker_path)
    marker_stat = os.lstat(marker_path)
    if stat.S_ISLNK(marker_stat.st_mode) or not stat.S_ISREG(marker_stat.st_mode) or marker_stat.st_size > 64 * 1024:
        raise ValueError(f"无效恢复 marker 文件：{marker_path}")
    expected_directory = os.path.abspath(expected_directory)
    if not path_is_within(marker_path, allowed_root) or os.path.dirname(marker_path) != expected_directory:
        raise ValueError(f"恢复 marker 超出允许目录：{marker_path}")
    match = re.fullmatch(r"\.(?P<base>[^/\\]+)\.photoflow-recovery-(?P<op>[0-9a-f]{32})\.json", os.path.basename(marker_path))
    if not match:
        raise ValueError(f"恢复 marker 命名无效：{marker_path}")
    with open(marker_path, "r", encoding="utf-8") as source:
        payload = json.load(source)
    if payload.get("version") != 1 or payload.get("operationId") != match.group("op") or payload.get("state") not in {"staging-preparing", "reservation", "copying", "ready", "committing", "uncommitted", "committed"}:
        raise ValueError(f"恢复 marker schema/state 无效：{marker_path}")
    derived_partial = os.path.join(expected_directory, match.group("base"))
    staging = payload["stagingPath"]
    partial = derived_partial
    if os.path.abspath(payload.get("partialPath", "")) != partial or os.path.abspath(payload.get("recoveryPath", "")) != partial:
        raise ValueError(f"恢复 marker 目标关系无效：{marker_path}")
    staging_name = os.path.basename(staging)
    if (os.path.dirname(os.path.abspath(staging)) != expected_directory or not staging_name.startswith(".")
            or ".photoflow-" not in staging_name or not staging_name.endswith(".part") or not path_is_within(staging, allowed_root)):
        raise ValueError(f"恢复 staging 路径无效：{staging}")
    state = payload.get("state")
    if state == "staging-preparing":
        preparation_source = payload.get("preparationSourcePath", "")
        if (not path_is_within(preparation_source, allowed_root) or not os.path.isfile(preparation_source)
                or stat.S_ISLNK(os.lstat(preparation_source).st_mode)):
            raise ValueError(f"staging preparation 来源无效：{preparation_source}")
        if (file_identity(preparation_source) != payload.get("preparationSourceIdentity")
                or os.path.getsize(preparation_source) != payload.get("preparationSourceSize")
                or file_digest(preparation_source) != payload.get("preparationSourceDigest")):
            raise ValueError(f"staging preparation 来源身份不匹配：{preparation_source}")
        if os.path.exists(partial):
            raise OSError(f"staging preparation 阶段出现正式目标，拒绝自动处理：{partial}")
        if os.path.exists(staging):
            staging_stat = os.lstat(staging)
            expected_owner = payload.get("stagingOwnershipIdentity")
            if stat.S_ISLNK(staging_stat.st_mode):
                raise ValueError(f"半 staging ownership 不匹配：{staging}")
            if not expected_owner:
                os.unlink(marker_path)
                return preparation_source
            if file_identity(staging)[:2] != expected_owner:
                raise ValueError(f"半 staging ownership 不匹配：{staging}")
            os.unlink(staging)
        os.unlink(marker_path)
        return preparation_source
    cleanup_path = None
    cleanup_name = payload.get("ownedCleanupName")
    if cleanup_name:
        if not re.fullmatch(r"\..+\.photoflow-(?:rename|copy)-[0-9a-f]{32}\.part", cleanup_name):
            raise ValueError(f"恢复 cleanup 命名无效：{cleanup_name}")
        cleanup_path = os.path.join(expected_directory, cleanup_name)
        if cleanup_path in {os.path.abspath(staging), partial} or not path_is_within(cleanup_path, allowed_root):
            raise ValueError(f"恢复 cleanup 路径无效：{cleanup_path}")
        if os.path.exists(cleanup_path):
            cleanup_stat = os.lstat(cleanup_path)
            if stat.S_ISLNK(cleanup_stat.st_mode) or not stat.S_ISREG(cleanup_stat.st_mode):
                raise ValueError(f"恢复 cleanup 不是普通文件：{cleanup_path}")
            if (file_identity(cleanup_path) != payload.get("ownedCleanupIdentity")
                    or os.path.getsize(cleanup_path) != payload.get("ownedCleanupSize")
                    or file_digest(cleanup_path) != payload.get("ownedCleanupDigest")):
                raise ValueError(f"恢复 cleanup 身份校验失败：{cleanup_path}")
        elif state not in {"ready", "committing", "committed"}:
            raise FileNotFoundError(f"恢复 cleanup 文件不存在：{cleanup_path}")
    if state in {"ready", "committing", "committed"} and os.path.isfile(partial):
        final_valid = (
            file_identity(partial) == payload.get("finalIdentity")
            and os.path.getsize(partial) == payload.get("finalSize")
            and file_digest(partial) == payload.get("finalDigest")
        )
        if final_valid:
            if os.path.exists(staging):
                if (file_identity(staging) != payload.get("stagingIdentity")
                        or file_digest(staging) != payload.get("stagingDigest")):
                    raise ValueError(f"提交清理 staging 身份不匹配：{staging}")
                os.unlink(staging)
            if cleanup_path and os.path.exists(cleanup_path):
                os.unlink(cleanup_path)
            os.unlink(marker_path)
            return partial
    if not os.path.exists(staging) or stat.S_ISLNK(os.lstat(staging).st_mode) or not stat.S_ISREG(os.lstat(staging).st_mode):
        raise ValueError(f"恢复 staging 不是普通文件：{staging}")
    if not os.path.exists(partial) and state == "reservation":
        recovery_path = payload.get("recoveryPath")
        if os.path.isfile(staging) and recovery_path and os.path.abspath(staging) != os.path.abspath(recovery_path):
            if file_identity(staging) != payload.get("stagingIdentity") or os.path.getsize(staging) != payload.get("stagingSize") or file_digest(staging) != payload.get("stagingDigest"):
                raise ValueError(f"恢复 staging 身份校验失败：{staging}")
            if os.path.exists(recovery_path):
                raise FileExistsError(f"恢复路径已存在：{recovery_path}")
            atomic_move_no_replace(staging, recovery_path)
            staging = recovery_path
        if cleanup_path and os.path.exists(cleanup_path):
            os.unlink(cleanup_path)
        os.unlink(marker_path)
        return staging
    if not os.path.isfile(staging):
        raise FileNotFoundError(f"恢复所需的完整 staging 不存在：{staging}")
    if file_identity(staging) != payload.get("stagingIdentity") or os.path.getsize(staging) != payload.get("stagingSize") or file_digest(staging) != payload.get("stagingDigest"):
        raise ValueError(f"恢复 staging 身份校验失败：{staging}")
    if os.path.exists(partial):
        expected = payload.get("ownershipIdentity")
        if not expected:
            raise OSError(f"reservation 后出现无身份目标，拒绝自动清理：{partial}")
        if expected and file_identity(partial)[:2] != expected:
            raise OSError(f"正式目标已被其他文件替换，拒绝清理：{partial}")
        os.unlink(partial)
    recovery_path = partial
    if recovery_path and os.path.abspath(staging) != os.path.abspath(recovery_path):
        if os.path.exists(recovery_path):
            raise FileExistsError(f"恢复路径已存在：{recovery_path}")
        atomic_move_no_replace(staging, recovery_path)
        staging = recovery_path
    if cleanup_path and os.path.exists(cleanup_path):
        os.unlink(cleanup_path)
    os.unlink(marker_path)
    return staging


def recover_pending_publications(directory, allowed_root=None):
    if not os.path.isdir(directory):
        return []
    recovered = []
    for name in sorted(os.listdir(directory)):
        if name.startswith(".") and ".photoflow-recovery-" in name and name.endswith(".json"):
            recovered.append(recover_incomplete_publication(os.path.join(directory, name), allowed_root or directory, directory))
    return recovered


def atomic_move_no_replace(source, destination, recovery_path=None):
    """Prefer native atomic no-replace, with a no-overwrite copy fallback.

    The fallback keeps the source until a durable destination exists. A process
    crash may therefore leave both the source and a partial destination, but it
    can never overwrite a pre-existing destination.
    """
    if try_atomic_rename_no_replace(source, destination):
        return "atomic"
    original_source = os.path.abspath(source)
    original_name = os.path.basename(original_source)
    controlled_source = (
        os.path.dirname(original_source) == os.path.dirname(os.path.abspath(destination))
        and re.fullmatch(r"\..+\.photoflow-(?:rename|copy)-[0-9a-f]{32}\.part", original_name)
    )
    source = original_source
    marker = None
    if controlled_source:
        marker = write_recovery_marker(source, destination, state="reservation")
    else:
        fallback_staging = os.path.join(
            os.path.dirname(destination),
            f".{os.path.basename(destination)}.photoflow-staging-{uuid.uuid4().hex}.part",
        )
        source = fallback_staging
        original_identity = file_identity(original_source)
        marker = write_recovery_marker(
            source, destination, state="staging-preparing",
            initial_fields={
                "preparationSourcePath": original_source,
                "preparationSourceIdentity": original_identity,
                "preparationSourceSize": original_identity[2],
                "preparationSourceDigest": file_digest(original_source),
            },
        )
        if marker:
            try:
                with open(original_source, "rb") as input_file, open(source, "xb") as staging_file:
                    staging_identity = file_identity(source)
                    if not update_recovery_marker(marker, stagingOwnershipIdentity=staging_identity[:2]):
                        raise OSError("无法持久化 staging preparation ownership")
                    shutil.copyfileobj(input_file, staging_file, 8 * 1024 * 1024)
                    staging_file.flush()
                    os.fsync(staging_file.fileno())
                shutil.copystat(original_source, source)
                with open(source, "r+b") as durable_staging:
                    os.fsync(durable_staging.fileno())
                staging_identity = file_identity(source)
                if not update_recovery_marker(
                    marker, state="reservation", stagingIdentity=staging_identity,
                    stagingSize=staging_identity[2], stagingDigest=file_digest(source),
                ):
                    raise OSError("无法持久化 prepared staging")
            except BaseException:
                raise
    if not marker:
        raise OSError("无法在正式目标创建前持久化 fallback reservation")
    created = False
    try:
        with open(source, "rb") as input_file, open(destination, "xb") as output_file:
            created = True
            identity = file_identity(destination)
            if not update_recovery_marker(
                marker, state="copying", ownershipIdentity=identity[:2], partialIdentity=identity
            ):
                raise OSError("无法持久化 fallback 目标 ownership")
            shutil.copyfileobj(input_file, output_file, 8 * 1024 * 1024)
            output_file.flush()
            os.fsync(output_file.fileno())
        shutil.copystat(source, destination)
        with open(destination, "r+b") as output_file:
            os.fsync(output_file.fileno())
        identity = file_identity(destination)
        final_digest = file_digest(destination)
        if not update_recovery_marker(
            marker, state="ready", partialIdentity=identity,
            finalIdentity=identity, finalSize=identity[2], finalDigest=final_digest,
        ):
            raise OSError("无法持久化 fallback ready 状态")
        if not update_recovery_marker(marker, state="committing"):
            raise OSError("无法持久化 fallback committing 状态")
        try:
            if original_source != os.path.abspath(source):
                os.unlink(original_source)
            os.unlink(source)
        except BaseException as cause:
            try:
                os.unlink(destination)
            except BaseException as cleanup_error:
                if marker:
                    update_recovery_marker(
                        marker, state="uncommitted", partialIdentity=file_identity(destination),
                        error=str(cause), cleanupError=str(cleanup_error),
                    )
                else:
                    marker = write_recovery_marker(source, destination, cause, cleanup_error)
                raise PublishCleanupError(source, destination, cause, cleanup_error, marker) from cause
            raise
        update_recovery_marker(marker, state="committed")
        try:
            os.unlink(marker)
            marker = None
        except OSError:
            log_warning(f"目标已完整提交，但恢复 marker 清理失败，将在下次运行重试：{marker}")
        log_warning("当前文件系统不支持原子 no-replace；已安全降级为不覆盖复制，异常崩溃可能同时保留源文件和不完整目标")
        return "safe-fallback"
    except PublishCleanupError:
        raise
    except BaseException as cause:
        if created:
            try:
                os.unlink(destination)
            except OSError as cleanup_error:
                if marker:
                    update_recovery_marker(
                        marker, state="uncommitted", partialIdentity=file_identity(destination),
                        error=str(cause), cleanupError=str(cleanup_error),
                    )
                else:
                    marker = write_recovery_marker(source, destination, cause, cleanup_error)
                raise PublishCleanupError(source, destination, cause, cleanup_error, marker) from cause
            if marker and os.path.exists(marker):
                try:
                    os.unlink(marker)
                except OSError:
                    pass
        elif marker and os.path.exists(marker):
            try:
                os.unlink(marker)
            except OSError:
                pass
        raise


def paths_identify_same_file(source, destination):
    try:
        return os.path.exists(destination) and os.path.samefile(source, destination)
    except OSError:
        return False


def try_atomic_rename_no_replace(source, destination):
    if paths_identify_same_file(source, destination):
        os.rename(source, destination)
        return True
    if os.name == "nt":
        os.rename(source, destination)
        return True
    if sys.platform.startswith("linux"):
        renameat2 = getattr(ctypes.CDLL(None, use_errno=True), "renameat2", None)
        if renameat2 is None:
            return False
        renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        renameat2.restype = ctypes.c_int
        if renameat2(-100, os.fsencode(source), -100, os.fsencode(destination), 1) == 0:
            return True
        error_number = ctypes.get_errno()
        if error_number in {errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP, errno.ENOTSUP}:
            return False
        raise OSError(error_number, os.strerror(error_number), destination)
    if sys.platform == "darwin":
        renamex_np = getattr(ctypes.CDLL(None, use_errno=True), "renamex_np", None)
        if renamex_np is None:
            return False
        renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        renamex_np.restype = ctypes.c_int
        if renamex_np(os.fsencode(source), os.fsencode(destination), 0x00000004) == 0:
            return True
        error_number = ctypes.get_errno()
        if error_number in {errno.ENOTSUP, errno.EINVAL}:
            return False
        raise OSError(error_number, os.strerror(error_number), destination)
    return False


def execute_two_phase_moves(moves):
    """Stage every source first, then publish all targets; roll back as one batch."""
    entries = []
    for source, destination in moves:
        source = os.path.abspath(source)
        destination = os.path.abspath(destination)
        if source == destination:
            continue
        temporary = os.path.join(
            os.path.dirname(source),
            f".{os.path.basename(source)}.photoflow-rename-{uuid.uuid4().hex}.part",
        )
        entries.append({"source": source, "temporary": temporary, "destination": destination, "state": "original"})

    recovery_directories = {
        os.path.dirname(path)
        for entry in entries
        for path in (entry["source"], entry["destination"])
    }
    recovered_targets = set()
    recovery_allowed_root = os.path.commonpath(recovery_directories) if recovery_directories else ""
    for directory in sorted(recovery_directories):
        recovered_targets.update(
            os.path.normcase(os.path.abspath(path))
            for path in recover_pending_publications(directory, allowed_root=recovery_allowed_root or directory)
        )
    recovered_entry_count = 0
    pending_entries = []
    for entry in entries:
        destination_key = os.path.normcase(os.path.abspath(entry["destination"]))
        if not os.path.exists(entry["source"]) and destination_key in recovered_targets:
            recovered_entry_count += 1
        else:
            pending_entries.append(entry)
    entries = pending_entries

    try:
        for entry in entries:
            try:
                atomic_move_no_replace(entry["source"], entry["temporary"], recovery_path=entry["source"])
            except PublishCleanupError as error:
                entry["state"] = "original_and_staged"
                entry["publication_error"] = error
                raise
            entry["state"] = "staged"
        for entry in entries:
            os.makedirs(os.path.dirname(entry["destination"]), exist_ok=True)
            try:
                atomic_move_no_replace(entry["temporary"], entry["destination"], recovery_path=entry["source"])
            except PublishCleanupError as error:
                entry["state"] = "staged_and_published"
                entry["publication_error"] = error
                raise
            entry["state"] = "published"
    except BaseException as cause:
        rollback_errors = []
        for entry in reversed(entries):
            try:
                if entry["state"] == "original_and_staged":
                    os.unlink(entry["temporary"])
                    fallback_staging = entry["publication_error"].source
                    if fallback_staging != entry["source"] and os.path.exists(fallback_staging):
                        os.unlink(fallback_staging)
                    marker = entry["publication_error"].recovery_marker
                    if marker and os.path.exists(marker):
                        os.unlink(marker)
                elif entry["state"] == "staged_and_published":
                    os.unlink(entry["destination"])
                    atomic_move_no_replace(entry["temporary"], entry["source"])
                    fallback_staging = entry["publication_error"].source
                    if fallback_staging != entry["temporary"] and os.path.exists(fallback_staging):
                        os.unlink(fallback_staging)
                    marker = entry["publication_error"].recovery_marker
                    if marker and os.path.exists(marker):
                        os.unlink(marker)
                elif entry["state"] == "published":
                    atomic_move_no_replace(entry["destination"], entry["source"])
                elif entry["state"] == "staged":
                    atomic_move_no_replace(entry["temporary"], entry["source"])
                else:
                    continue
                entry["state"] = "original"
            except BaseException as rollback_error:
                rollback_errors.append((entry["state"], entry["source"], rollback_error))
        raise MoveTransactionError(cause, rollback_errors) from cause
    return recovered_entry_count + len(entries)


def copy_file_no_replace(source, destination):
    temporary = os.path.join(
        os.path.dirname(destination),
        f".{os.path.basename(destination)}.photoflow-copy-{uuid.uuid4().hex}.part",
    )
    preserve_temporary = False
    try:
        shutil.copy2(source, temporary)
        with open(temporary, "r+b") as copied:
            os.fsync(copied.fileno())
        try:
            atomic_move_no_replace(temporary, destination)
        except PublishCleanupError:
            preserve_temporary = True
            raise
    finally:
        if not preserve_temporary:
            try:
                os.remove(temporary)
            except FileNotFoundError:
                pass


def find_selection_jpg_proxy_folder(reference_folder):
    """Find the canonical sibling ``jpg`` folder for an imported version folder."""
    reference_folder = os.path.abspath(reference_folder)
    project_folder = os.path.dirname(reference_folder)
    try:
        candidates = [
            entry.path for entry in os.scandir(project_folder)
            if entry.is_dir()
            and os.path.abspath(entry.path) != reference_folder
            and entry.name.casefold() in JPG_PROXY_FOLDER_NAMES
        ]
    except OSError:
        return None
    return candidates[0] if len(candidates) == 1 else None


def build_jpg_proxy_index(proxy_folder):
    """Index unique JPG/JPEG files by basename without claiming them as versions."""
    candidates = {}
    if not proxy_folder:
        return candidates
    proxy_folders = [proxy_folder] if isinstance(proxy_folder, (str, os.PathLike)) else list(proxy_folder)
    for root in proxy_folders:
        for directory, _directory_names, file_names in os.walk(root):
            for file_name in file_names:
                if not file_name.lower().endswith(JPG_PROXY_EXTENSIONS):
                    continue
                stem = os.path.splitext(file_name)[0].casefold()
                candidate_path = os.path.join(directory, file_name)
                paths = candidates.setdefault(stem, [])
                if os.path.normcase(os.path.abspath(candidate_path)) not in {os.path.normcase(os.path.abspath(path)) for path in paths}:
                    paths.append(candidate_path)
    # A duplicated camera filename is ambiguous. Falling back to the RAW preview
    # is safer than linking a returned edit to the wrong photo.
    return {stem: paths[0] for stem, paths in candidates.items() if len(paths) == 1}


def visual_reference_path(reference_path, jpg_proxy_index):
    if os.path.splitext(reference_path)[1].lower() not in RAW_EXTENSIONS:
        return reference_path
    return jpg_proxy_index.get(os.path.splitext(os.path.basename(reference_path))[0].casefold(), reference_path)


def load_visual_frame(media_path):
    extension = os.path.splitext(media_path)[1].lower()
    if extension in VIDEO_EXTENSIONS or extension in FFMPEG_IMAGE_EXTENSIONS:
        if not VIDEO_TOOLS_COMMAND:
            raise RuntimeError('视频处理插件未安装，无法分析此媒体版本')
        output = os.path.join(tempfile.gettempdir(), f'photoflow-version-frame-{os.getpid()}-{abs(hash(media_path))}.png')
        payload = base64.urlsafe_b64encode(json.dumps({'action': 'frame', 'inputPath': media_path, 'outputPath': output}).encode('utf-8')).decode('ascii')
        result = subprocess.run([VIDEO_TOOLS_COMMAND, *VIDEO_TOOLS_ARGS, 'bridge', payload], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='replace', timeout=60)
        if result.returncode != 0 or not os.path.isfile(output):
            raise RuntimeError(result.stderr.strip() or '无法提取视频画面')
        image = Image.open(output); image.load(); os.remove(output)
        return image
    return Image.open(media_path)

def calculate_hashes(media_path):
    try:
        with load_visual_frame(media_path) as img:
            img_gray = img.convert('L')

            # 1. 粗略哈希 (aHash 8x8 -> 64 bits) - 用于快速筛选
            img_coarse = img_gray.resize((8, 8), Image.LANCZOS)
            pixels_coarse = list(img_coarse.getdata())
            avg = sum(pixels_coarse) / len(pixels_coarse)
            coarse_hash = 0
            for i, p in enumerate(pixels_coarse):
                if p > avg: coarse_hash |= 1 << i

            # 2. 精细哈希 (dHash 16x16 -> 256 bits) - 用于精准区分细节
            # dHash 原理：对比相邻像素的明暗，能极其敏锐地捕捉画面结构的微小变化
            img_fine = img_gray.resize((17, 16), Image.LANCZOS)
            pixels_fine = list(img_fine.getdata())
            fine_hash = 0
            for row in range(16):
                for col in range(16):
                    # 对比当前像素和右边相邻像素
                    if pixels_fine[row * 17 + col] > pixels_fine[row * 17 + col + 1]:
                        fine_hash |= 1 << (row * 16 + col)

            return coarse_hash, fine_hash
    except Exception:
        return None, None

def hamming_distance(hash1, hash2):
    if hash1 is None or hash2 is None: return float('inf')
    return bin(hash1 ^ hash2).count('1')


def media_kind(file_name):
    return 'video' if file_name.lower().endswith(VIDEO_EXTENSIONS) else 'image'


def unique_stem_index(file_names):
    """Return only unambiguous, case-insensitive filename stems."""
    candidates = {}
    for file_name in file_names:
        stem = os.path.splitext(file_name)[0].casefold()
        candidates.setdefault(stem, []).append(file_name)
    return {stem: names[0] for stem, names in candidates.items() if len(names) == 1}


def lightweight_image_dimensions(media_path):
    """Read image dimensions without decoding pixels or launching FFmpeg."""
    extension = os.path.splitext(media_path)[1].lower()
    if extension not in IMAGE_EXTENSIONS:
        return None
    try:
        with Image.open(media_path) as image:
            width, height = image.size
        if width > 0 and height > 0:
            return width, height
    except Exception:
        pass
    return None


def lightweight_capture_time(media_path):
    """Read the original capture timestamp when an ordinary image retains it."""
    extension = os.path.splitext(media_path)[1].lower()
    if extension not in IMAGE_EXTENSIONS:
        return None
    try:
        with Image.open(media_path) as image:
            exif = image.getexif()
            value = exif.get(36867) or exif.get(36868)  # DateTimeOriginal / DateTimeDigitized
        return str(value).strip() if value else None
    except Exception:
        return None


def filename_dimensions_compatible(reference_path, source_path, jpg_proxy_index, tolerance=0.08):
    """Reject obvious aspect-ratio or retained capture-time conflicts."""
    reference_visual_path = visual_reference_path(reference_path, jpg_proxy_index)
    reference_dimensions = lightweight_image_dimensions(reference_visual_path)
    source_dimensions = lightweight_image_dimensions(source_path)
    if reference_dimensions is not None and source_dimensions is not None:
        reference_ratio = max(reference_dimensions) / min(reference_dimensions)
        source_ratio = max(source_dimensions) / min(source_dimensions)
        if abs(reference_ratio - source_ratio) / max(reference_ratio, source_ratio) > tolerance:
            return False
    reference_capture_time = lightweight_capture_time(reference_visual_path)
    source_capture_time = lightweight_capture_time(source_path)
    return not (reference_capture_time and source_capture_time and reference_capture_time != source_capture_time)

def copy_unmatched_a_files(unmatched_files_a, folder_a):
    if not unmatched_files_a:
        return 0
    unmatched_a_folder = os.path.join(folder_a, "未匹配的图片_A")
    os.makedirs(unmatched_a_folder, exist_ok=True)
    recovered_paths = {
        os.path.normcase(os.path.abspath(path)): path
        for path in recover_pending_publications(unmatched_a_folder, allowed_root=folder_a)
    }

    log_info(f"正在复制 文件夹A 中未匹配的 {len(unmatched_files_a)} 个文件...")
    created = []
    recovered_count = 0
    try:
        for filename in unmatched_files_a:
            src = os.path.join(folder_a, filename)
            dst = os.path.join(unmatched_a_folder, filename)
            recovered_path = recovered_paths.get(os.path.normcase(os.path.abspath(dst)))
            if recovered_path:
                if os.path.getsize(src) != os.path.getsize(recovered_path) or file_digest(src) != file_digest(recovered_path):
                    raise OSError(f"恢复后的未匹配文件与来源不一致：{filename}")
                recovered_count += 1
                continue
            counter = 1
            while os.path.exists(dst):
                name, ext = os.path.splitext(filename)
                dst = os.path.join(unmatched_a_folder, f"{name}_{counter}{ext}")
                counter += 1
            copy_file_no_replace(src, dst)
            created.append(dst)
    except BaseException:
        for path in reversed(created):
            try:
                os.remove(path)
            except OSError:
                pass
        raise
    return recovered_count + len(created)

def process_folders(folder_a, folder_b, threshold, auto_copy_unmatched, preview_only=False, move_unmatched=False, source_files=None):
    for recovery_folder in dict.fromkeys((folder_a, folder_b)):
        recovered = recover_pending_publications(recovery_folder, allowed_root=recovery_folder)
        if recovered:
            log_info(f"已恢复 {len(recovered)} 个上次未完成的文件发布")
    unmatched_b_folder = os.path.join(folder_b, "未匹配的图片")
    if os.path.isdir(unmatched_b_folder):
        recovered = recover_pending_publications(unmatched_b_folder, allowed_root=folder_b)
        for recovered_path in recovered:
            source_path = os.path.join(folder_b, os.path.basename(recovered_path))
            if os.path.isfile(source_path):
                if os.path.getsize(source_path) != os.path.getsize(recovered_path) or file_digest(source_path) != file_digest(recovered_path):
                    raise OSError(f"恢复后的未匹配移动文件与来源不一致：{os.path.basename(source_path)}")
                os.unlink(source_path)
        if recovered:
            log_info(f"已恢复 {len(recovered)} 个未匹配待处理文件移动")
    media_extensions = IMAGE_EXTENSIONS + FFMPEG_IMAGE_EXTENSIONS + VIDEO_EXTENSIONS
    jpg_proxy_folder = find_selection_jpg_proxy_folder(folder_a)
    # Companion JPGs may live beside the RAW files or in the canonical sibling
    # jpg folder. They are visual adapters, not separate version assets.
    jpg_proxy_index = build_jpg_proxy_index([folder_a, *([jpg_proxy_folder] if jpg_proxy_folder else [])])
    proxy_count = 0
    list_a = [f for f in os.listdir(folder_a) if f.lower().endswith(media_extensions)]
    raw_stems = {os.path.splitext(file_name)[0].casefold() for file_name in list_a if file_name.lower().endswith(RAW_EXTENSIONS)}
    list_a = [file_name for file_name in list_a if not (file_name.lower().endswith(JPG_PROXY_EXTENSIONS) and os.path.splitext(file_name)[0].casefold() in raw_stems)]
    list_b = [f for f in os.listdir(folder_b) if f.lower().endswith(media_extensions)]
    if source_files is not None:
        selected_names = {str(file_name).casefold() for file_name in source_files}
        list_b = [file_name for file_name in list_b if file_name.casefold() in selected_names]
    if register_heif_opener is None and any(file_name.lower().endswith(HEIF_EXTENSIONS) for file_name in [*list_a, *list_b]):
        log_error("HEIC/HEIF/HIF/AVIF 匹配需要 pi-heif；请运行 npm run setup:python")
        return False
    if not VIDEO_TOOLS_COMMAND and any(file_name.lower().endswith(VIDEO_EXTENSIONS + RAW_EXTENSIONS) for file_name in [*list_a, *list_b]):
        log_info("未安装视频处理插件；将跳过需要视频/RAW 抽帧的视觉匹配，普通图片仍会继续处理")
    all_a = {f: (os.path.join(folder_a, f), media_kind(f)) for f in list_a}
    all_b = {f: (os.path.join(folder_b, f), media_kind(f)) for f in list_b}

    if not all_a:
        log_error("文件夹A 中没有可用于对照的图片或视频")
        return False
    if not all_b:
        log_error("文件夹B 中没有图片或视频")
        return False

    # Resolve safe filename matches before starting any expensive media decode.
    # Only unique stems are eligible; duplicates and obvious metadata conflicts
    # deliberately fall through to the existing visual matcher.
    unique_a = unique_stem_index(list_a)
    unique_b = unique_stem_index(list_b)
    filename_matches = []
    filename_conflicts = []
    for file_b in list_b:
        stem = os.path.splitext(file_b)[0].casefold()
        if unique_b.get(stem) != file_b or stem not in unique_a:
            continue
        file_a = unique_a[stem]
        path_a, kind_a = all_a[file_a]
        path_b, kind_b = all_b[file_b]
        if kind_a != kind_b or not filename_dimensions_compatible(path_a, path_b, jpg_proxy_index):
            filename_conflicts.append(file_b)
            continue
        filename_matches.append((file_a, file_b))

    filename_sources = {file_b for _file_a, file_b in filename_matches}
    unresolved_b = [file_b for file_b in list_b if file_b not in filename_sources]
    if filename_matches:
        log_info(f"已按唯一同名主文件名直接匹配 {len(filename_matches)} 个文件")
    if filename_conflicts:
        log_info(f"有 {len(filename_conflicts)} 个同名文件的媒体类型、宽高比或拍摄时间不一致，改用视觉匹配确认")

    # 1. 分析 文件夹A
    log_info("正在分析 文件夹A (参照组)...")
    files_a = {}
    for i, f in enumerate(list_a if unresolved_b else []):
        path = os.path.join(folder_a, f)
        visual_path = visual_reference_path(path, jpg_proxy_index)
        h_coarse, h_fine = calculate_hashes(visual_path)
        if h_coarse is None and visual_path != path:
            # A corrupt or unreadable proxy must not make a decodable RAW worse.
            visual_path = path
            h_coarse, h_fine = calculate_hashes(path)
        if h_coarse is not None and visual_path != path:
            proxy_count += 1
        if h_coarse is not None: files_a[f] = (path, h_coarse, h_fine, 'video' if f.lower().endswith(VIDEO_EXTENSIONS) else 'image')
        if i % 10 == 0: log_progress(f"分析 A: {i}/{len(list_a)}", int(i/len(list_a)*20))
    if proxy_count:
        log_info(f"已使用 {proxy_count} 个同名 JPG 作为 RAW 的视觉代理")

    # 2. 分析 文件夹B
    log_info("正在分析 文件夹B (待处理组)...")
    files_b = {}
    for i, f in enumerate(unresolved_b):
        path = os.path.join(folder_b, f)
        h_coarse, h_fine = calculate_hashes(path)
        if h_coarse is not None: files_b[f] = (path, h_coarse, h_fine, 'video' if f.lower().endswith(VIDEO_EXTENSIONS) else 'image')
        if i % 10 == 0: log_progress(f"分析 B: {i}/{len(unresolved_b)}", 20 + int(i/len(unresolved_b)*20))

    if not files_a and not filename_matches:
        log_error("文件夹A 中没有可用于对照的图片或视频")
        return False
    if not files_b and not filename_matches:
        log_error("文件夹B 中没有图片或视频")
        return False

    # 3. 收集并计算所有候选匹配对 (粗筛)
    log_info("正在进行深度交叉比对...")
    # A negative distance gives safe filename matches first allocation priority.
    potential_matches = [(-1, -1, file_a, file_b) for file_a, file_b in filename_matches]
    best_candidates_b = {}

    total_a = len(files_a)
    for idx, (file_a, (path_a, coarse_a, fine_a, kind_a)) in enumerate(files_a.items()):
        for file_b, (path_b, coarse_b, fine_b, kind_b) in files_b.items():
            if kind_a != kind_b:
                continue
            rough_dist = hamming_distance(coarse_a, coarse_b)
            fine_dist = hamming_distance(fine_a, fine_b)
            candidate = (fine_dist, rough_dist, file_a)
            if file_b not in best_candidates_b or candidate < best_candidates_b[file_b]:
                best_candidates_b[file_b] = candidate
            # 如果粗略差距在阈值内，视为候选对象
            if rough_dist <= threshold:
                # Very different fine hashes are more likely a false match than
                # an edited version of the same frame.
                if fine_dist <= 96:
                    potential_matches.append((fine_dist, rough_dist, file_a, file_b))

        if idx % 5 == 0:
            log_progress(f"交叉比对: {idx}/{total_a}", 40 + int(idx/total_a*10))

    # 核心改动：全局排序 (精筛)
    # 按 精细差距(第一优先) 和 粗略差距(第二优先) 从小到大排序
    potential_matches.sort(key=lambda x: (x[0], x[1]))

    # 4. 执行重命名 (最优分配)
    log_info("开始执行精准重命名...")
    processed_b = set()
    matched_a = {f: 0 for f in list_a}
    preview_matches = []
    reserved_targets = set()
    planned_moves = []

    total_matches = len(potential_matches)
    for idx, (fine_dist, rough_dist, file_a, file_b) in enumerate(potential_matches):
        # 如果这个待处理文件已经被最适合它的参照文件领走了，跳过
        if file_b in processed_b:
            continue

        path_b = all_b[file_b][0]
        name, _reference_ext = os.path.splitext(file_a)
        _current_name, ext = os.path.splitext(file_b)

        m_idx = matched_a[file_a] + 1

        # 命名逻辑
        if m_idx == 1: new_name = f"{name}{ext}"
        else: new_name = f"{name}_{m_idx}{ext}"

        new_path_b = os.path.join(folder_b, new_name)

        # 防止同名覆盖，也在预览阶段预留已经分配的目标文件名。
        c = 1
        while (new_name.casefold() in reserved_targets
               or (os.path.exists(new_path_b) and os.path.normcase(os.path.abspath(new_path_b)) != os.path.normcase(os.path.abspath(path_b)))):
            if m_idx == 1: new_name = f"{name}_{c}{ext}"
            else: new_name = f"{name}_{m_idx+c-1}{ext}"
            new_path_b = os.path.join(folder_b, new_name)
            c += 1

        filename_match = fine_dist < 0
        confidence = "高" if filename_match or fine_dist <= 40 else "中" if fine_dist <= 72 else "低"
        preview_matches.append({"source": file_b, "reference": file_a, "target": new_name, "confidence": confidence, "distance": 0 if filename_match else fine_dist})
        reserved_targets.add(new_name.casefold())
        processed_b.add(file_b)
        matched_a[file_a] += 1
        if not preview_only and os.path.normcase(os.path.abspath(path_b)) != os.path.normcase(os.path.abspath(new_path_b)):
            planned_moves.append((path_b, new_path_b))

        if idx % 10 == 0:
            log_progress(f"重命名进度: {idx}/{total_matches}", 50 + int(idx/total_matches*40))

    # 5. 处理未匹配
    unmatched_b = [f for f in list_b if f not in processed_b]
    suggestions = []
    for file_b in unmatched_b:
        candidate = best_candidates_b.get(file_b)
        if candidate is None:
            continue
        fine_dist, _rough_dist, file_a = candidate
        name, _reference_ext = os.path.splitext(file_a)
        _current_name, ext = os.path.splitext(file_b)
        new_name = f"{name}{ext}"
        new_path_b = os.path.join(folder_b, new_name)
        counter = 1
        source_path_b = os.path.join(folder_b, file_b)
        while (new_name.casefold() in reserved_targets
               or (os.path.exists(new_path_b) and os.path.normcase(os.path.abspath(new_path_b)) != os.path.normcase(os.path.abspath(source_path_b)))):
            new_name = f"{name}_{counter}{ext}"
            new_path_b = os.path.join(folder_b, new_name)
            counter += 1
        reserved_targets.add(new_name.casefold())
        suggestions.append({
            "source": file_b,
            "reference": file_a,
            "target": new_name,
            "confidence": "候选",
            "distance": fine_dist,
        })
    if unmatched_b and not preview_only and move_unmatched:
        sub_folder = os.path.join(folder_b, "未匹配的图片")
        for f in unmatched_b:
            src = all_b[f][0]
            dst = os.path.join(sub_folder, f)
            c = 1
            while os.path.exists(dst):
                n, e = os.path.splitext(f)
                dst = os.path.join(sub_folder, f"{n}_{c}{e}")
                c += 1
            planned_moves.append((src, dst))

    unmatched_a = [f for f in list_a if matched_a[f] == 0]

    stats = (f"待处理组匹配成功:{len(processed_b)}/{len(all_b)}, 参照组已被匹配:{sum(1 for v in matched_a.values() if v>0)}/{len(all_a)}")
    if preview_only:
        emit('preview', f"预览完成：找到 {len(preview_matches)} 个匹配", {"matches": preview_matches, "suggestions": suggestions, "unmatched": unmatched_b, "unmatchedReference": unmatched_a})
        log_info(f"预览完成，尚未修改文件。{stats}")
        return True
    moved_count = execute_two_phase_moves(planned_moves)
    log_info(f"完成! {stats}")

    if unmatched_a and auto_copy_unmatched:
        try:
            copy_unmatched_a_files(unmatched_a, folder_a)
        except Exception as error:
            if moved_count:
                raise PartialOperationError(f"重命名已完成，但复制参照组未匹配文件失败：{error}") from error
            raise
        log_info("已复制参照组中未匹配的文件")
    return True

def run(args_list):
    global VIDEO_TOOLS_COMMAND, VIDEO_TOOLS_ARGS
    if sys.platform.startswith('win'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')

    parser = argparse.ArgumentParser()
    parser.add_argument("--folder_a", required=True)
    parser.add_argument("--folder_b", required=True)
    parser.add_argument("--copy_unmatched", action="store_true")
    parser.add_argument("--threshold", type=int, default=5)
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--move_unmatched", action="store_true")
    parser.add_argument("--source_files", default="")
    parser.add_argument("--source_files_file", default="")
    parser.add_argument("--video_tools_command", default="")
    parser.add_argument("--video_tools_arg", action="append", default=[])
    args = parser.parse_args(args_list)
    VIDEO_TOOLS_COMMAND = args.video_tools_command
    VIDEO_TOOLS_ARGS = list(args.video_tools_arg)

    # 清理路径
    fa = args.folder_a.strip('"').strip("'")
    fb = args.folder_b.strip('"').strip("'")

    if not os.path.exists(fa) or not os.path.exists(fb):
        log_error("文件夹不存在")
        return

    try:
        if args.source_files_file:
            with open(args.source_files_file, "r", encoding="utf-8") as source_file:
                source_files = json.load(source_file)
        else:
            source_files = json.loads(args.source_files) if args.source_files else None
        if process_folders(fa, fb, args.threshold, args.copy_unmatched, args.preview, args.move_unmatched, source_files):
            emit('success', "所有任务结束")
    except MoveTransactionError as e:
        if e.rollback_errors:
            log_error(f"批量重命名失败，且有 {len(e.rollback_errors)} 项未能回滚：{e.cause}")
        else:
            log_error(f"批量重命名失败，已完整回滚：{e.cause}")
    except PartialOperationError as e:
        log_error(str(e))
    except Exception as e:
        log_error(f"错误: {e}")

if __name__ == "__main__":
    try:
        run(sys.argv[1:])
    except Exception as e:
        log_error(f"脚本运行出错: {str(e)}")
