import argparse
import ctypes
import errno
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import time
import uuid

from event_protocol import emit, log_error, log_info, log_progress, log_success, log_warning


IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.bmp', '.gif', '.tif', '.tiff', '.heic', '.heif', '.hif', '.avif', '.webp',
                    '.cr2', '.cr3', '.arw', '.nef', '.orf', '.rwl', '.dng', '.raf', '.3fr', '.fff'}
VIDEO_EXTENSIONS = {'.mp4', '.mov', '.avi', '.m4v', '.mkv', '.mpeg', '.mpg', '.mts', '.m2ts'}
COPY_CHUNK_SIZE = 8 * 1024 * 1024


class TaskCancelled(Exception):
    pass


class CopyTransactionError(RuntimeError):
    def __init__(self, cause, rollback_errors):
        super().__init__(str(cause))
        self.cause = cause
        self.rollback_errors = rollback_errors


class PublishCleanupError(OSError):
    def __init__(self, source, destination, cause, cleanup_error, publication, identity, partial_digest, recovery_marker):
        super().__init__(
            f"未提交目标清理失败：{destination}；完整 staging 保留于 {source}；"
            f"恢复标记：{recovery_marker or '创建失败'}；原错误：{cause}；清理错误：{cleanup_error}"
        )
        self.source = source
        self.destination = destination
        self.cause = cause
        self.cleanup_error = cleanup_error
        self.publication = publication
        self.identity = identity
        self.partial_digest = partial_digest
        self.recovery_marker = recovery_marker
        self.rollback_token = None


def file_identity(path):
    stat = os.stat(path, follow_symlinks=False)
    return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)


def file_digest(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(COPY_CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write_recovery_payload(marker, payload, create):
    temporary = f"{marker}.{uuid.uuid4().hex}.tmp"
    try:
        with open(temporary, "xb") as output:
            output.write(json.dumps(payload, ensure_ascii=False).encode("utf-8")); output.flush(); os.fsync(output.fileno())
        if create:
            if not try_atomic_rename_no_replace(temporary, marker): os.rename(temporary, marker)
        else:
            os.replace(temporary, marker)
        return True
    except OSError:
        try: os.unlink(temporary)
        except OSError: pass
        return False


def write_recovery_marker(source, destination, cause=None, cleanup_error=None, identity=None,
                          partial_digest=None, state="uncommitted", recovery_path=None):
    operation_id = uuid.uuid4().hex
    marker = os.path.join(
        os.path.dirname(destination),
        f".{os.path.basename(destination)}.photoflow-recovery-{operation_id}.json",
    )
    identity = identity or (file_identity(destination) if os.path.exists(destination) else None)
    staging_identity = file_identity(source) if os.path.isfile(source) else None
    payload = {
        "version": 1, "operationId": operation_id, "state": state,
        "stagingPath": os.path.abspath(source),
        "partialPath": os.path.abspath(destination),
        "recoveryPath": os.path.abspath(destination),
        "stagingIdentity": list(staging_identity) if staging_identity else None,
        "stagingSize": staging_identity[2] if staging_identity else None,
        "stagingDigest": file_digest(source) if staging_identity else None,
        "ownershipIdentity": list(identity[:2]) if identity else None,
        "partialIdentity": list(identity) if identity else None,
        "partialDigest": partial_digest,
        "error": str(cause) if cause is not None else "",
        "cleanupError": str(cleanup_error) if cleanup_error is not None else "",
    }
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
    if not is_within_project(marker_path, allowed_root) or os.path.dirname(marker_path) != expected_directory:
        raise ValueError(f"恢复 marker 超出允许目录：{marker_path}")
    match = re.fullmatch(r"\.(?P<base>[^/\\]+)\.photoflow-recovery-(?P<op>[0-9a-f]{32})\.json", os.path.basename(marker_path))
    if not match:
        raise ValueError(f"恢复 marker 命名无效：{marker_path}")
    with open(marker_path, "r", encoding="utf-8") as source:
        payload = json.load(source)
    if payload.get("version") != 1 or payload.get("operationId") != match.group("op") or payload.get("state") not in {"reservation", "copying", "ready", "committing", "uncommitted", "committed"}:
        raise ValueError(f"恢复 marker schema/state 无效：{marker_path}")
    partial = os.path.join(expected_directory, match.group("base"))
    staging = payload.get("stagingPath", "")
    if os.path.abspath(payload.get("partialPath", "")) != partial or os.path.abspath(payload.get("recoveryPath", "")) != partial:
        raise ValueError(f"恢复 marker 目标关系无效：{marker_path}")
    staging_name = os.path.basename(staging)
    if (os.path.dirname(os.path.abspath(staging)) != expected_directory or not staging_name.startswith(".")
            or ".photoflow-" not in staging_name or not staging_name.endswith(".part") or not is_within_project(staging, allowed_root)):
        raise ValueError(f"恢复 staging 路径无效：{staging}")
    state = payload["state"]
    if state in {"ready", "committing", "committed"} and os.path.isfile(partial):
        final_valid = (
            file_identity(partial) == tuple(payload.get("finalIdentity") or ())
            and os.path.getsize(partial) == payload.get("finalSize")
            and file_digest(partial) == payload.get("finalDigest")
        )
        if final_valid:
            if os.path.exists(staging):
                if (file_identity(staging) != tuple(payload.get("stagingIdentity") or ())
                        or file_digest(staging) != payload.get("stagingDigest")):
                    raise ValueError(f"提交清理 staging 身份不匹配：{staging}")
                os.unlink(staging)
            os.unlink(marker_path)
            return partial
    if not os.path.exists(staging) or stat.S_ISLNK(os.lstat(staging).st_mode) or not stat.S_ISREG(os.lstat(staging).st_mode):
        raise ValueError(f"恢复 staging 不是普通文件：{staging}")
    if not os.path.isfile(staging):
        raise FileNotFoundError(f"恢复所需的完整 staging 不存在：{staging}")
    if file_identity(staging) != tuple(payload.get("stagingIdentity") or ()) or os.path.getsize(staging) != payload.get("stagingSize") or file_digest(staging) != payload.get("stagingDigest"):
        raise ValueError(f"恢复 staging 身份校验失败：{staging}")
    if os.path.exists(partial):
        ownership = tuple(payload.get("ownershipIdentity") or ())
        if not ownership or file_identity(partial)[:2] != ownership:
            raise OSError(f"正式目标身份不匹配，拒绝清理：{partial}")
        expected_digest = payload.get("partialDigest")
        if expected_digest and file_digest(partial) != expected_digest:
            raise OSError(f"正式目标内容已变化：{partial}")
        os.unlink(partial)
    move_file_no_replace(staging, partial)
    os.unlink(marker_path)
    return partial


def recover_pending_publications(directory, allowed_root=None):
    if not os.path.isdir(directory):
        return []
    recovered = []
    for name in sorted(os.listdir(directory)):
        if name.startswith(".") and ".photoflow-recovery-" in name and name.endswith(".json"):
            recovered.append(recover_incomplete_publication(os.path.join(directory, name), allowed_root or directory, directory))
    return recovered


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


def move_file_no_replace(source, destination):
    if try_atomic_rename_no_replace(source, destination):
        return "atomic"
    created = False
    marker = write_recovery_marker(
        source, destination, state="reservation", recovery_path=destination
    )
    if not marker:
        raise OSError("无法在正式目标创建前持久化 fallback reservation")
    try:
        with open(source, "rb") as input_file, open(destination, "xb") as output_file:
            created = True
            identity = file_identity(destination)
            if not update_recovery_marker(
                marker, state="copying", ownershipIdentity=list(identity[:2]), partialIdentity=list(identity)
            ):
                raise OSError("无法持久化 fallback 目标 ownership")
            shutil.copyfileobj(input_file, output_file, COPY_CHUNK_SIZE)
            output_file.flush()
            os.fsync(output_file.fileno())
        shutil.copystat(source, destination)
        with open(destination, "r+b") as output_file:
            os.fsync(output_file.fileno())
        identity = file_identity(destination)
        final_digest = file_digest(destination)
        if not update_recovery_marker(
            marker, state="ready", partialIdentity=list(identity),
            finalIdentity=list(identity), finalSize=identity[2], finalDigest=final_digest,
        ):
            raise OSError("无法持久化 fallback ready 状态")
        if not update_recovery_marker(marker, state="committing"):
            raise OSError("无法持久化 fallback committing 状态")
        try:
            os.unlink(source)
        except BaseException as cause:
            identity = file_identity(destination)
            partial_digest = file_digest(destination)
            try:
                os.unlink(destination)
            except BaseException as cleanup_error:
                if marker:
                    update_recovery_marker(
                        marker, state="uncommitted", partialIdentity=list(identity),
                        partialDigest=partial_digest, error=str(cause), cleanupError=str(cleanup_error),
                    )
                else:
                    marker = write_recovery_marker(
                        source, destination, cause, cleanup_error, identity, partial_digest,
                        recovery_path=destination,
                    )
                raise PublishCleanupError(
                    source, destination, cause, cleanup_error, "safe-fallback", identity, partial_digest, marker
                ) from cause
            raise
        update_recovery_marker(marker, state="committed")
        try:
            os.unlink(marker)
            marker = None
        except OSError:
            log_warning(f"目标已完整提交，但恢复 marker 清理失败，将在下次运行重试：{marker}")
        log_warning("当前文件系统不支持原子 no-replace；已安全降级为不覆盖复制，异常崩溃可能留下不完整目标文件")
        return "safe-fallback"
    except PublishCleanupError:
        raise
    except BaseException as cause:
        if created:
            try:
                os.unlink(destination)
            except OSError as cleanup_error:
                identity = file_identity(destination)
                partial_digest = file_digest(destination)
                if marker:
                    update_recovery_marker(
                        marker, state="uncommitted", partialIdentity=list(identity),
                        partialDigest=partial_digest, error=str(cause), cleanupError=str(cleanup_error),
                    )
                else:
                    marker = write_recovery_marker(
                        source, destination, cause, cleanup_error, identity, partial_digest
                    )
                raise PublishCleanupError(
                    source, destination, cause, cleanup_error, "safe-fallback", identity, partial_digest, marker
                ) from cause
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


def is_within_project(path, project_dir):
    try:
        project_realpath = os.path.normcase(os.path.realpath(project_dir))
        common = os.path.commonpath((os.path.realpath(path), project_realpath))
        return os.path.normcase(common) == project_realpath
    except ValueError:
        return False


def validate_folder_name(name, label):
    name = str(name)
    if (not name or name in {".", ".."} or os.path.isabs(name)
            or os.path.basename(name) != name or "/" in name or "\\" in name or "\x00" in name):
        raise ValueError(f"{label}必须是项目内的单个文件夹名称。")
    return name


def parse_search_names(text):
    """Extract selection keys without treating a camera filename prefix as a key."""
    search_names = []
    seen = set()
    for token in re.findall(r'[A-Za-z0-9_.]+', text):
        if token.isdigit():
            match = token if len(token) >= 3 else None
        else:
            trailing = re.search(r'(\d{3,})(?:\.[A-Za-z0-9]+)?$', token)
            match = trailing.group(1) if trailing else None
        if match and match not in seen:
            seen.add(match)
            search_names.append(match)
    return search_names


def filename_selection_key(filename):
    """Return the final numeric camera sequence, never a prefix such as 618 in 618A7394."""
    stem = os.path.splitext(filename)[0]
    match = re.search(r'(\d{3,})$', stem)
    return match.group(1) if match else None


def find_project_folder(project_dir, wanted_name):
    if not wanted_name or not os.path.isdir(project_dir):
        return None
    for entry in os.scandir(project_dir):
        if entry.is_dir() and entry.name.casefold() == wanted_name.casefold():
            return entry.path
    return None


def ensure_not_cancelled(cancel_file):
    if cancel_file and os.path.exists(cancel_file):
        raise TaskCancelled()


def scan_media(source_dir, extensions, cancel_file=None):
    """Scan a source tree once and index supported media by its final numeric sequence."""
    index = {}
    if not source_dir:
        return index
    for root, _, files in os.walk(source_dir):
        ensure_not_cancelled(cancel_file)
        for name in files:
            if os.path.splitext(name)[1].lower() not in extensions:
                continue
            key = filename_selection_key(name)
            if not key:
                continue
            path = os.path.join(root, name)
            try:
                size = os.path.getsize(path)
            except OSError:
                continue
            index.setdefault(key, []).append({"source": path, "name": name, "size": size})
    return index


def summarize_plan(plan):
    return {
        "keywordCount": len(plan["keywords"]),
        "matchedKeywordCount": len(plan["matched_keywords"]),
        "filesToCopy": len(plan["files"]),
        "totalBytes": sum(item["size"] for item in plan["files"]),
        "imageCount": sum(item["kind"] == "image" for item in plan["files"]),
        "videoCount": sum(item["kind"] == "video" for item in plan["files"]),
        "existingCount": len(plan["existing"]),
        "conflictCount": len(plan["conflicts"]),
        "missingKeywords": plan["missing"],
        "existingNames": [item["name"] for item in plan["existing"][:20]],
        "conflictNames": plan["conflicts"][:20],
        "signature": plan["signature"],
    }


def build_selection_plan(project_dir, image_dest_name, video_dest_name, image_source_name,
                          video_source_name, search_names, cancel_file=None):
    project_dir = os.path.realpath(os.path.abspath(project_dir))
    if not os.path.isdir(project_dir):
        raise FileNotFoundError("项目文件夹不存在。")
    image_dest_name = validate_folder_name(image_dest_name, "图片目标名称")
    video_dest_name = validate_folder_name(video_dest_name, "视频目标名称")
    raw_dir = find_project_folder(project_dir, image_source_name)
    mov_dir = find_project_folder(project_dir, video_source_name)
    if not raw_dir and not mov_dir:
        raise FileNotFoundError("项目中没有找到配置的图片或视频来源文件夹。")
    for source_dir in (raw_dir, mov_dir):
        if source_dir and not is_within_project(source_dir, project_dir):
            raise ValueError("来源文件夹的真实路径超出项目边界。")

    image_index = scan_media(raw_dir, IMAGE_EXTENSIONS, cancel_file)
    video_index = scan_media(mov_dir, VIDEO_EXTENSIONS, cancel_file)
    image_target = os.path.join(project_dir, image_dest_name)
    video_target = os.path.join(project_dir, video_dest_name)
    if not is_within_project(image_target, project_dir) or not is_within_project(video_target, project_dir):
        raise ValueError("目标文件夹的真实路径超出项目边界。")
    for target_directory in (image_target, video_target):
        recovered = recover_pending_publications(target_directory, allowed_root=target_directory)
        if recovered:
            log_info(f"已恢复 {len(recovered)} 个上次未完成的选片文件发布")
    candidates = []
    matched_keywords = []
    missing = []

    for keyword in search_names:
        ensure_not_cancelled(cancel_file)
        matches = image_index.get(keyword, [])
        kind = "image"
        target_dir = image_target
        if not matches:
            matches = video_index.get(keyword, [])
            kind = "video"
            target_dir = video_target
        if not matches:
            missing.append(keyword)
            continue
        matched_keywords.append(keyword)
        for match in matches:
            if not is_within_project(match["source"], project_dir):
                raise ValueError(f"来源文件的真实路径超出项目边界：{match['name']}")
            candidates.append({
                **match,
                "kind": kind,
                "destination": os.path.join(target_dir, match["name"]),
            })

    # One source can be found by only one exact key, but keep this guard for future parser changes.
    unique_sources = {}
    for item in candidates:
        unique_sources.setdefault(os.path.normcase(os.path.abspath(item["source"])), item)
    candidates = list(unique_sources.values())

    destination_groups = {}
    for item in candidates:
        destination_groups.setdefault(os.path.normcase(item["destination"]), []).append(item)

    conflicts = []
    existing = []
    files = []
    for group in destination_groups.values():
        if len(group) > 1:
            conflicts.append(group[0]["name"])
            continue
        item = group[0]
        if os.path.exists(item["destination"]):
            existing.append(item)
        else:
            files.append(item)

    signature_payload = [{
        "source": os.path.normcase(os.path.abspath(item["source"])),
        "destination": os.path.normcase(os.path.abspath(item["destination"])),
        "size": item["size"],
        "mtime": os.path.getmtime(item["source"]),
    } for item in sorted(files, key=lambda value: os.path.normcase(value["source"]))]
    signature = hashlib.sha256(json.dumps(signature_payload, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    return {
        "project_dir": project_dir,
        "keywords": search_names,
        "matched_keywords": matched_keywords,
        "missing": missing,
        "existing": existing,
        "conflicts": conflicts,
        "files": files,
        "signature": signature,
    }


def copy_file_atomically(source, destination, cancel_file, on_bytes):
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    temporary = os.path.join(
        os.path.dirname(destination),
        f".{os.path.basename(destination)}.photoflow-{uuid.uuid4().hex}.part",
    )
    digest = hashlib.sha256()
    cleanup_temporary = True
    try:
        with open(source, "rb") as source_file, open(temporary, "xb") as target_file:
            while True:
                ensure_not_cancelled(cancel_file)
                chunk = source_file.read(COPY_CHUNK_SIZE)
                if not chunk:
                    break
                digest.update(chunk)
                target_file.write(chunk)
                on_bytes(len(chunk))
            target_file.flush()
            os.fsync(target_file.fileno())
        shutil.copystat(source, temporary)
        with open(temporary, "r+b") as durable_copy:
            os.fsync(durable_copy.fileno())
        ensure_not_cancelled(cancel_file)
        try:
            publication = move_file_no_replace(temporary, destination)
        except PublishCleanupError as error:
            cleanup_temporary = False
            error.rollback_token = {
                "identity": error.identity,
                "digest": error.partial_digest,
                "temporary": temporary,
                "publication": error.publication,
                "recoveryMarker": error.recovery_marker,
            }
            raise
        return {
            "identity": file_identity(destination),
            "digest": digest.hexdigest(),
            "temporary": None,
            "publication": publication,
            "recoveryMarker": None,
        }
    finally:
        if cleanup_temporary and os.path.exists(temporary):
            try:
                os.remove(temporary)
            except OSError:
                pass


def rollback_published_file(destination, ownership_token):
    """Quarantine first, then remove only a destination still owned by this run."""
    if not ownership_token:
        return
    temporary = ownership_token.get("temporary")
    marker = ownership_token.get("recoveryMarker")
    if not os.path.exists(destination):
        if temporary and os.path.exists(temporary):
            os.remove(temporary)
        if marker and os.path.exists(marker):
            os.remove(marker)
        return
    if marker:
        owned = (file_identity(destination) == ownership_token["identity"]
                 and file_digest(destination) == ownership_token["digest"])
        if not owned:
            raise OSError(f"正式目标已被其他文件替换，已保留完整 staging：{temporary}")
        os.unlink(destination)
        if temporary and os.path.exists(temporary):
            os.remove(temporary)
        if os.path.exists(marker):
            os.remove(marker)
        return
    quarantine = os.path.join(
        os.path.dirname(destination),
        f".{os.path.basename(destination)}.photoflow-rollback-{uuid.uuid4().hex}.part",
    )
    os.rename(destination, quarantine)
    rollback_complete = False
    try:
        owned = (file_identity(quarantine) == ownership_token["identity"]
                 and file_digest(quarantine) == ownership_token["digest"])
        if owned:
            os.remove(quarantine)
            rollback_complete = True
        else:
            move_file_no_replace(quarantine, destination)
            raise OSError(f"正式目标已被其他文件替换，已保留完整 staging：{temporary or '原始来源'}")
    finally:
        if rollback_complete:
            if temporary and os.path.exists(temporary):
                os.remove(temporary)
            if marker and os.path.exists(marker):
                os.remove(marker)


def execute_plan(plan, cancel_file=None):
    files = plan["files"]
    total_bytes = sum(item["size"] for item in files)
    if total_bytes:
        free_bytes = shutil.disk_usage(plan["project_dir"]).free
        if free_bytes < total_bytes:
            raise OSError(f"目标磁盘空间不足：还需要 {total_bytes - free_bytes} 字节。")

    created = []
    copied_bytes = 0
    last_progress_at = 0.0
    current_file_name = ""
    current_file_index = 0

    def report_bytes(byte_count):
        nonlocal copied_bytes, last_progress_at
        copied_bytes += byte_count
        now = time.monotonic()
        if now - last_progress_at >= 0.25 or copied_bytes >= total_bytes:
            percent = 100 if total_bytes == 0 else min(99, round(copied_bytes * 100 / total_bytes))
            log_progress(f"正在复制：{current_file_name}（{current_file_index}/{len(files)}）", percent, {
                "bytesCopied": copied_bytes,
                "totalBytes": total_bytes,
                "fileName": current_file_name,
                "fileIndex": current_file_index,
                "totalFiles": len(files),
            })
            last_progress_at = now

    try:
        ensure_not_cancelled(cancel_file)
        for index, item in enumerate(files, start=1):
            if (not is_within_project(item["source"], plan["project_dir"])
                    or not is_within_project(item["destination"], plan["project_dir"])):
                raise ValueError("复制前检测到文件真实路径超出项目边界。")
            current_file_name = item["name"]
            current_file_index = index
            percent = 0 if total_bytes == 0 else min(99, round(copied_bytes * 100 / total_bytes))
            log_progress(f"正在复制：{current_file_name}（{current_file_index}/{len(files)}）", percent, {
                "bytesCopied": copied_bytes,
                "totalBytes": total_bytes,
                "fileName": current_file_name,
                "fileIndex": current_file_index,
                "totalFiles": len(files),
                "fileStarted": True,
            })
            try:
                token = copy_file_atomically(item["source"], item["destination"], cancel_file, report_bytes)
            except PublishCleanupError as error:
                if error.rollback_token:
                    created.append((item["destination"], error.rollback_token))
                raise
            created.append((item["destination"], token))
            ensure_not_cancelled(cancel_file)
        ensure_not_cancelled(cancel_file)
        return len(created)
    except BaseException as cause:
        rollback_errors = []
        for destination, token in reversed(created):
            try:
                rollback_published_file(destination, token)
            except BaseException as rollback_error:
                rollback_errors.append((destination, rollback_error))
        if rollback_errors:
            raise CopyTransactionError(cause, rollback_errors) from cause
        raise


def run(arguments):
    if sys.platform.startswith('win'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')

    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, help="项目文件夹路径")
    parser.add_argument("--keywords", nargs='+', required=True, help="包含文件名的混合文本")
    parser.add_argument("--image_dest_name", default="图片选片")
    parser.add_argument("--video_dest_name", default="视频选片")
    parser.add_argument("--image_source_name", default="raw")
    parser.add_argument("--video_source_name", default="mov")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--expected_signature", default="")
    parser.add_argument("--cancel_file", default="")
    args = parser.parse_args(arguments)

    project_dir = args.source.strip().strip('"').strip("'")
    search_names = parse_search_names(" ".join(args.keywords))
    if not search_names:
        log_error("未从输入内容中提取到可用的文件编号（至少 3 位数字）。")
        return

    try:
        log_info("正在扫描来源文件夹并生成选片计划……")
        plan = build_selection_plan(
            project_dir, args.image_dest_name, args.video_dest_name,
            args.image_source_name, args.video_source_name, search_names, args.cancel_file,
        )
        summary = summarize_plan(plan)
        if not args.execute:
            emit("preview", "选片计划已生成", data=summary)
            return
        if not args.expected_signature or args.expected_signature != plan["signature"]:
            log_error("来源或目标文件在确认后发生了变化，请重新预检。")
            return
        if not plan["files"]:
            log_success("没有需要复制的新文件。", data=summary)
            return
        log_info(f"开始复制 {len(plan['files'])} 个媒体文件。")
        copied = execute_plan(plan, args.cancel_file)
        log_progress("复制完成", 100, {"bytesCopied": summary["totalBytes"], "totalBytes": summary["totalBytes"]})
        log_success(f"选片完成，共复制 {copied} 个文件。", data=summary)
    except TaskCancelled:
        emit("cancelled", "任务已取消，已回滚本次复制的文件。")
    except CopyTransactionError as error:
        log_error(f"选片失败，且有 {len(error.rollback_errors)} 个文件未能安全回滚：{error.cause}")
    except Exception as error:
        log_error(f"选片失败，已回滚本次复制的文件：{error}")


if __name__ == "__main__":
    run(sys.argv[1:])
