import argparse
import ctypes
import errno
import hashlib
import json
import math
import os
import re
import shutil
import stat
import sys
import unicodedata
import uuid
from pathlib import Path

import cv2
import numpy as np
from event_protocol import emit, log_error, log_info, log_progress, log_success, log_warning
from PIL import Image
from send2trash import send2trash


VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".wmv", ".m4v", ".webm", ".mpeg", ".mpg", ".mts", ".m2ts"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png"}
PREVIEW_WIDTH = 384
QUALITY_WIDTH = 640
MIN_FRAME_SHARPNESS = 24.0
BLACK_FRAME_LUMA_P99 = 18.0


class FrameResults(list):
    def __init__(self, values=(), failure_count=0):
        super().__init__(values)
        self.failure_count = failure_count


class PublishCleanupError(OSError):
    def __init__(self, source, destination, cause, cleanup_error, recovery_marker):
        message = (
            f"未提交目标清理失败：{destination}；完整 staging/源保留于 {source}；"
            f"恢复标记：{recovery_marker or '创建失败'}；原错误：{cause}；清理错误：{cleanup_error}"
        )
        super().__init__(message)
        self.source = str(source)
        self.destination = str(destination)
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
    path = os.path.abspath(path)
    root = os.path.abspath(allowed_root)
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
    marker = str(marker)
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


def write_recovery_marker(source, destination, cause=None, cleanup_error=None, recovery_path=None,
                          marker_path=None, state="uncommitted"):
    destination = Path(destination)
    operation_id = uuid.uuid4().hex
    marker = Path(marker_path) if marker_path else destination.with_name(
        f".{destination.name}.photoflow-recovery-{operation_id}.json"
    )
    if marker_path:
        match = re.fullmatch(r"\..+\.photoflow-recovery-([0-9a-f]{32})\.json", marker.name)
        operation_id = match.group(1) if match else ""
    identity = file_identity(destination) if destination.exists() else None
    staging_identity = file_identity(source) if os.path.isfile(source) else None
    payload = {
        "version": 1,
        "operationId": operation_id,
        "state": state,
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
    return str(marker) if atomic_write_recovery_payload(marker, payload, create=not marker_path) else None


def update_recovery_marker(marker, **updates):
    try:
        with open(marker, "r", encoding="utf-8") as source:
            payload = json.load(source)
        payload.update(updates)
        return atomic_write_recovery_payload(marker, payload, create=False)
    except (OSError, ValueError):
        return False


def recover_incomplete_publication(marker_path, allowed_root, expected_directory):
    """Remove an owned partial target while preserving/restoring the full staging file."""
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
    with open(marker_path, "r", encoding="utf-8") as marker_file:
        payload = json.load(marker_file)
    if payload.get("version") != 1 or payload.get("operationId") != match.group("op"):
        raise ValueError(f"恢复 marker schema/version 无效：{marker_path}")
    if payload.get("state") not in {"reservation", "copying", "ready", "committing", "uncommitted", "committed"}:
        raise ValueError(f"恢复 marker state 无效：{marker_path}")
    derived_partial = os.path.join(expected_directory, match.group("base"))
    staging = payload["stagingPath"]
    partial = derived_partial
    if os.path.abspath(payload.get("partialPath", "")) != partial or os.path.abspath(payload.get("recoveryPath", "")) != partial:
        raise ValueError(f"恢复 marker 目标关系无效：{marker_path}")
    staging_name = os.path.basename(staging)
    if (os.path.dirname(os.path.abspath(staging)) != expected_directory
            or not staging_name.startswith(".") or ".photoflow-" not in staging_name or not staging_name.endswith(".part")
            or not path_is_within(staging, allowed_root)):
        raise ValueError(f"恢复 staging 路径无效：{staging}")
    state = payload.get("state")
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
            os.unlink(marker_path)
            return partial
    if not os.path.exists(staging) or stat.S_ISLNK(os.lstat(staging).st_mode) or not stat.S_ISREG(os.lstat(staging).st_mode):
        raise ValueError(f"恢复 staging 不是普通文件：{staging}")
    if not os.path.exists(partial) and state == "reservation":
        if os.path.isfile(staging):
            if file_identity(staging) != payload.get("stagingIdentity") or os.path.getsize(staging) != payload.get("stagingSize") or file_digest(staging) != payload.get("stagingDigest"):
                raise ValueError(f"恢复 staging 身份校验失败：{staging}")
            move_file_no_replace(staging, partial)
            staging = partial
        os.unlink(marker_path)
        return staging
    if not os.path.isfile(staging):
        raise FileNotFoundError(f"恢复所需的完整 staging 不存在：{staging}")
    if file_identity(staging) != payload.get("stagingIdentity") or os.path.getsize(staging) != payload.get("stagingSize") or file_digest(staging) != payload.get("stagingDigest"):
        raise ValueError(f"恢复 staging 身份校验失败：{staging}")
    if os.path.exists(partial):
        ownership_identity = payload.get("ownershipIdentity")
        if not ownership_identity:
            raise OSError(f"reservation 后出现无身份目标，拒绝自动清理：{partial}")
        if ownership_identity and file_identity(partial)[:2] != ownership_identity:
            raise OSError(f"正式目标已被其他文件替换，拒绝清理：{partial}")
        os.unlink(partial)
    recovery_path = partial
    if recovery_path and os.path.abspath(staging) != os.path.abspath(recovery_path):
        if os.path.exists(recovery_path):
            raise FileExistsError(f"恢复路径已存在：{recovery_path}")
        move_file_no_replace(staging, recovery_path)
        staging = recovery_path
    os.unlink(marker_path)
    return staging


def recover_pending_publications(directory, allowed_root=None):
    directory = Path(directory)
    if not directory.is_dir():
        return []
    recovered = []
    for marker in sorted(directory.glob(".*.photoflow-recovery-*.json")):
        recovered.append(recover_incomplete_publication(marker, allowed_root or directory, directory))
    return recovered


def paths_identify_same_file(source, destination):
    try:
        return os.path.exists(destination) and os.path.samefile(source, destination)
    except OSError:
        return False


def try_atomic_rename_no_replace(source, destination):
    """Use a platform no-replace rename, returning False when unavailable."""
    if paths_identify_same_file(source, destination):
        os.rename(source, destination)
        return True
    if os.name == "nt":
        # MoveFileEx without MOVEFILE_REPLACE_EXISTING is atomic and refuses an
        # existing target; Python's os.rename maps to those semantics.
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
    """Move without overwrite.

    The fallback claims the destination with ``xb`` and never overwrites it.
    Unlike native rename, a process or machine crash can leave a partial target
    alongside the intact source; callers report this degraded crash guarantee.
    """
    if try_atomic_rename_no_replace(source, destination):
        return "atomic"
    original_source = os.path.abspath(source)
    source_name = os.path.basename(original_source)
    if (os.path.dirname(original_source) != os.path.dirname(os.path.abspath(destination))
            or not source_name.startswith(".") or ".photoflow-" not in source_name or not source_name.endswith(".part")):
        fallback_staging = os.path.join(
            os.path.dirname(destination),
            f".{os.path.basename(destination)}.photoflow-staging-{uuid.uuid4().hex}.part",
        )
        shutil.copy2(original_source, fallback_staging)
        with open(fallback_staging, "r+b") as durable_staging:
            os.fsync(durable_staging.fileno())
        source = fallback_staging
    created = False
    marker = write_recovery_marker(source, destination, recovery_path=destination, state="reservation")
    if not marker:
        raise OSError("无法在正式目标创建前持久化 fallback reservation")
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
        if original_source != os.path.abspath(source):
            os.unlink(original_source)
        os.unlink(source)
        update_recovery_marker(marker, state="committed")
        try:
            os.unlink(marker)
            marker = None
        except OSError:
            log_warning(f"目标已完整提交，但恢复 marker 清理失败，将在下次运行重试：{marker}")
        return "safe-fallback"
    except PublishCleanupError:
        raise
    except BaseException as cause:
        if created:
            try:
                os.unlink(destination)
            except OSError as cleanup_error:
                marker = write_recovery_marker(
                    source, destination, cause, cleanup_error, marker_path=marker, state="uncommitted"
                )
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


def atomic_publish_bytes_no_replace(destination, payload, validator=None):
    """Durably write beside the destination and atomically publish without replacement."""
    destination = Path(destination)
    temporary = destination.with_name(f".{destination.name}.photoflow-{uuid.uuid4().hex}.part")
    preserve_temporary = False
    try:
        with open(temporary, "xb") as target:
            target.write(payload)
            target.flush()
            os.fsync(target.fileno())
        if validator is not None:
            validator(temporary)
        try:
            return move_file_no_replace(temporary, destination)
        except PublishCleanupError:
            preserve_temporary = True
            raise
    finally:
        if not preserve_temporary:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass


def validate_jpeg(path):
    with Image.open(path) as image:
        if image.format != "JPEG":
            raise ValueError("截图临时文件不是有效的 JPEG")
        image.verify()


def atomic_move_no_replace(source, destination):
    return move_file_no_replace(source, destination)


def detected_video_container(file_path):
    """Identify supported video containers without trusting the file extension."""
    try:
        with open(file_path, "rb") as source:
            header = source.read(4096)
    except OSError:
        return None
    if len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"AVI ":
        return "avi"
    if header.startswith(b"\x1aE\xdf\xa3"):
        return "matroska"
    if header.startswith(b"\x30\x26\xb2\x75\x8e\x66\xcf\x11\xa6\xd9\x00\xaa\x00\x62\xce\x6c"):
        return "asf"
    # ISO BMFF files normally begin with an ftyp box, while older QuickTime MOV
    # files may begin directly with moov/mdat. Parse bounded top-level boxes so
    # random HTML/JavaScript containing one of those strings is not accepted.
    offset = 0
    while offset + 8 <= len(header):
        size = int.from_bytes(header[offset:offset + 4], "big")
        box_type = header[offset + 4:offset + 8]
        if box_type in {b"ftyp", b"moov", b"mdat", b"styp", b"moof"}:
            return "iso-bmff"
        if box_type not in {b"free", b"skip", b"wide", b"sidx"}:
            break
        if size == 1 and offset + 16 <= len(header):
            size = int.from_bytes(header[offset + 8:offset + 16], "big")
        if size < 8 or offset + size > len(header):
            break
        offset += size
    return None


def configure_text_streams():
    """Keep the JSON event stream UTF-8 on Windows, regardless of its code page."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="backslashreplace")


configure_text_streams()


def sanitize_filename(filename):
    """Return a Windows-safe name without discarding valid Unicode characters."""
    invalid_chars = r'\\/:*?"<>|'
    filename = unicodedata.normalize("NFC", str(filename))
    filename = "".join(
        "_" if char in invalid_chars or unicodedata.category(char) in {"Cc", "Cs"} else char
        for char in filename
    )
    # Windows silently rejects names ending in a space/dot and reserves these
    # device names even when an extension is present.
    filename = filename.strip().rstrip(" .")
    if not filename:
        return "未命名"
    reserved = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
    if filename.split(".", 1)[0].upper() in reserved:
        filename = f"_{filename}"
    return filename


def windows_short_path(path):
    """Use an ASCII-compatible 8.3 path when a Windows OpenCV build needs it."""
    if os.name != "nt":
        return path
    try:
        get_short_path = ctypes.windll.kernel32.GetShortPathNameW
        get_short_path.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint]
        get_short_path.restype = ctypes.c_uint
        size = get_short_path(path, None, 0)
        if not size:
            return path
        buffer = ctypes.create_unicode_buffer(size)
        if not get_short_path(path, buffer, size):
            return path
        return buffer.value
    except (AttributeError, OSError, ValueError):
        return path


def open_video(video_path):
    """Open paths containing Chinese, emoji, and other Unicode characters."""
    candidates = []
    short_path = windows_short_path(os.path.abspath(video_path))
    if short_path != video_path:
        candidates.append(short_path)
    candidates.append(video_path)
    for candidate in dict.fromkeys(candidates):
        cap = cv2.VideoCapture(candidate, cv2.CAP_ANY)
        if cap.isOpened():
            return cap
        cap.release()
    return cv2.VideoCapture()


def preview_features(frame):
    """Return inexpensive features that are relatively robust to camera motion."""
    height, width = frame.shape[:2]
    if width > PREVIEW_WIDTH:
        frame = cv2.resize(frame, (PREVIEW_WIDTH, max(1, round(height * PREVIEW_WIDTH / width))))
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    histogram = cv2.calcHist([hsv], [0, 1], None, [16, 16], [0, 180, 0, 256])
    histogram = cv2.normalize(histogram, histogram).flatten()
    edges = cv2.Canny(gray, 80, 160)
    return gray, histogram, edges


def frame_difference(previous, current):
    previous_gray, previous_hist, previous_edges = previous
    current_gray, current_hist, current_edges = current

    colour = cv2.compareHist(previous_hist.astype(np.float32), current_hist.astype(np.float32), cv2.HISTCMP_BHATTACHARYYA)
    luminance = float(np.mean(cv2.absdiff(previous_gray, current_gray))) / 255.0

    # Dilating first tolerates a small camera pan while retaining the strong signal
    # caused by a real cut.
    kernel = np.ones((3, 3), np.uint8)
    old_edges = cv2.dilate(previous_edges, kernel)
    new_edges = cv2.dilate(current_edges, kernel)
    previous_count = max(1, int(np.count_nonzero(previous_edges)))
    current_count = max(1, int(np.count_nonzero(current_edges)))
    disappeared = np.count_nonzero((previous_edges > 0) & (new_edges == 0)) / previous_count
    appeared = np.count_nonzero((current_edges > 0) & (old_edges == 0)) / current_count
    edge_change = max(disappeared, appeared)
    return float(0.55 * colour + 0.25 * edge_change + 0.20 * luminance)


def normalize_sensitivity(sensitivity):
    if sensitivity in {"low", "standard", "high"}:
        return sensitivity
    # Compatibility for direct callers and old --threshold values.
    try:
        threshold = float(sensitivity)
        return "high" if threshold >= 0.98 else "low" if threshold <= 0.85 else "standard"
    except (TypeError, ValueError):
        return "standard"


def robust_thresholds(scores, sensitivity):
    values = np.asarray(scores, dtype=np.float32)
    median = float(np.median(values))
    mad = float(np.median(np.abs(values - median))) + 1e-6
    settings = {
        "low": (0.18, 0.985, 7.0, 0.06, 3.0),
        "standard": (0.12, 0.96, 5.0, 0.04, 2.2),
        "high": (0.08, 0.90, 3.5, 0.025, 1.5),
    }
    hard_floor, quantile, hard_mad, soft_floor, soft_mad = settings[normalize_sensitivity(sensitivity)]
    hard = max(hard_floor, float(np.quantile(values, quantile)), median + hard_mad * mad)
    soft = max(soft_floor, median + soft_mad * mad)
    return hard, min(soft, hard * 0.85)


def find_boundaries(scores, fps, sensitivity, min_duration):
    if not scores:
        return []
    sensitivity = normalize_sensitivity(sensitivity)
    hard, soft = robust_thresholds(scores, sensitivity)
    candidates = []
    prominence_floor = {"low": 0.08, "standard": 0.05, "high": 0.025}[sensitivity]

    # Sharp cuts are local maxima above the per-video adaptive threshold.
    for index, score in enumerate(scores):
        left = scores[index - 1] if index else -1.0
        right = scores[index + 1] if index + 1 < len(scores) else -1.0
        neighbours = scores[max(0, index - 5):index] + scores[index + 1:min(len(scores), index + 6)]
        local_baseline = float(np.median(neighbours)) if neighbours else 0.0
        if score >= hard and score - local_baseline >= prominence_floor and score >= left and score >= right:
            candidates.append((index + 1, score, "cut"))

    # A fade/dissolve yields a run of moderate change instead of one large peak.
    run_start = None
    max_index = -1
    max_score = -1.0
    max_gap = max(1, round(fps * 0.08))
    last_active = -1
    for index, score in enumerate(scores if sensitivity != "low" else []):
        if score >= soft:
            if run_start is None or index - last_active > max_gap:
                if run_start is not None and last_active - run_start + 1 >= max(3, round(fps * (0.12 if sensitivity == "high" else 0.22))):
                    candidates.append((max_index + 1, max_score, "gradual"))
                run_start, max_index, max_score = index, index, score
            elif score > max_score:
                max_index, max_score = index, score
            last_active = index
    if run_start is not None and last_active - run_start + 1 >= max(3, round(fps * (0.12 if sensitivity == "high" else 0.22))):
        candidates.append((max_index + 1, max_score, "gradual"))

    # Do not create unusably short shots.  For conflicting detections retain the
    # stronger one, which is normally the actual edit point.
    minimum_shot_seconds = {"low": 1.25, "standard": 0.65, "high": 0.30}[sensitivity]
    minimum_gap = max(1, round(fps * max(min_duration, minimum_shot_seconds)))
    selected = []
    for candidate in sorted(candidates, key=lambda item: item[0]):
        if not selected or candidate[0] - selected[-1][0] >= minimum_gap:
            selected.append(candidate)
        elif candidate[1] > selected[-1][1]:
            selected[-1] = candidate
    return selected


def frame_quality_metrics(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape[:2]
    longest_edge = max(height, width)
    if longest_edge > QUALITY_WIDTH:
        scale = QUALITY_WIDTH / longest_edge
        gray = cv2.resize(
            gray,
            (max(1, round(width * scale)), max(1, round(height * scale))),
            interpolation=cv2.INTER_AREA,
        )
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    mean = float(gray.mean())
    clipped = float(((gray <= 5) | (gray >= 250)).mean())
    luma_p99 = float(np.percentile(gray, 99))
    black_pixel_ratio = float((gray <= 12).mean())
    is_black = luma_p99 <= BLACK_FRAME_LUMA_P99 or (mean <= 10.0 and black_pixel_ratio >= 0.98)
    is_blurry = sharpness < MIN_FRAME_SHARPNESS
    # Extreme exposure and nearly blank frames should not win merely due to noise.
    exposure = max(0.0, 1.0 - abs(mean - 128.0) / 128.0) * (1.0 - clipped)
    return {
        "quality": sharpness * (0.35 + 0.65 * exposure),
        "sharpness": sharpness,
        "brightness": mean,
        "luma_p99": luma_p99,
        "black_pixel_ratio": black_pixel_ratio,
        "is_black": is_black,
        "is_blurry": is_blurry,
    }


def calculate_frame_quality(frame):
    """Keep the legacy tuple contract for callers that only need ranking data."""
    metrics = frame_quality_metrics(frame)
    return metrics["quality"], metrics["sharpness"], metrics["brightness"]


def extract_best_frames(video_path, shots, fps, original_name):
    if not math.isfinite(fps) or fps <= 0:
        fps = 25.0
    cap = open_video(video_path)
    if not cap.isOpened():
        cap.release()
        raise RuntimeError("无法重新打开视频以提取截图")

    output_dir = os.path.dirname(video_path)
    base_name = sanitize_filename(os.path.splitext(original_name)[0])
    metadata = FrameResults()
    skipped_black_shots = 0
    skipped_blurry_shots = 0
    try:
        for number, (start, end) in enumerate(shots, 1):
            length = end - start + 1
            margin = min(max(2, round(fps * 0.15)), max(0, (length - 1) // 3))
            search_start, search_end = start + margin, end - margin
            stride = max(1, round((search_end - search_start + 1) / 90))
            cap.set(cv2.CAP_PROP_POS_FRAMES, search_start)

            best = None
            sampled_count = 0
            non_black_count = 0
            for frame_index in range(search_start, search_end + 1):
                ok, frame = cap.read()
                if not ok:
                    break
                if (frame_index - search_start) % stride:
                    continue
                sampled_count += 1
                metrics = frame_quality_metrics(frame)
                if metrics["is_black"]:
                    continue
                non_black_count += 1
                if metrics["is_blurry"]:
                    continue
                if best is None or metrics["quality"] > best[0]:
                    best = (
                        metrics["quality"], metrics["sharpness"], metrics["brightness"],
                        metrics["luma_p99"], metrics["black_pixel_ratio"], frame_index, frame,
                    )

            if best is None:
                if sampled_count and not non_black_count:
                    skipped_black_shots += 1
                elif non_black_count:
                    skipped_blurry_shots += 1
                continue
            _, sharpness, brightness, luma_p99, black_pixel_ratio, frame_index, frame = best
            filename = f"{base_name}_{number:03d}_{frame_index / fps:.3f}s.jpg"
            output_path = os.path.join(output_dir, filename)
            ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
            if not ok:
                metadata.failure_count += 1
                continue
            try:
                publication = atomic_publish_bytes_no_replace(output_path, encoded.tobytes(), validate_jpeg)
            except FileExistsError:
                metadata.failure_count += 1
                log_warning(f"截图已存在，未覆盖：{filename}")
                continue
            if publication == "safe-fallback":
                log_warning("当前文件系统不支持原子 no-replace；已安全降级为不覆盖复制，异常崩溃可能留下不完整目标文件")
            metadata.append({
            "shot": number,
            "start_seconds": round(start / fps, 3),
            "end_seconds": round(end / fps, 3),
            "selected_seconds": round(frame_index / fps, 3),
            "selected_frame": frame_index,
            "sharpness": round(sharpness, 2),
            "brightness": round(brightness, 2),
            "luma_p99": round(luma_p99, 2),
            "black_pixel_ratio": round(black_pixel_ratio, 4),
            "file": filename,
            })
    finally:
        cap.release()
    if skipped_black_shots or skipped_blurry_shots:
        log_info(
            f"{original_name}：质量筛选跳过 {skipped_black_shots} 个黑场分镜、"
            f"{skipped_blurry_shots} 个无清晰候选帧的分镜"
        )
    return metadata


def analyze_video(video_path, sensitivity, min_duration):
    name = os.path.basename(video_path)
    log_info(f"正在分析视频：{name}")
    cap = open_video(video_path)
    if not cap.isOpened():
        cap.release()
        return None
    try:
        fps = float(cap.get(cv2.CAP_PROP_FPS))
        if not math.isfinite(fps) or fps <= 0:
            fps = 25.0
            log_warning(f"{name}：视频缺少有效 FPS 元数据，已安全回退为 25 FPS")
        ok, first = cap.read()
        if not ok:
            return None

        previous = preview_features(first)
        scores = []
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            current = preview_features(frame)
            scores.append(frame_difference(previous, current))
            previous = current
    finally:
        cap.release()
    if not scores:
        return []

    boundaries = find_boundaries(scores, fps, sensitivity, min_duration)
    total = len(scores) + 1
    starts = [0] + [frame for frame, _, _ in boundaries]
    ends = [frame - 1 for frame, _, _ in boundaries] + [total - 1]
    shots = [(start, end) for start, end in zip(starts, ends) if end >= start]
    frames = extract_best_frames(video_path, shots, fps, name)
    log_info(f"{name}：识别 {len(boundaries)} 个转场，导出 {len(frames)} 张截图")
    return frames


def perceptual_hash(image, hash_size=8, highfreq_factor=4):
    """Return the same pHash value as ImageHash without its SciPy dependency."""
    if hash_size < 2:
        raise ValueError("Hash size must be greater than or equal to 2")
    image_size = hash_size * highfreq_factor
    pixels = np.asarray(
        image.convert("L").resize((image_size, image_size), Image.Resampling.LANCZOS),
        dtype=np.float64,
    )
    normalized_dct = cv2.dct(pixels)
    # OpenCV uses an orthonormal DCT while ImageHash/SciPy used the unnormalised
    # DCT-II. Restoring those scale factors keeps every existing hash bit stable.
    scales = np.full(image_size, np.sqrt(2.0 * image_size), dtype=np.float64)
    scales[0] = 2.0 * np.sqrt(image_size)
    coefficients = normalized_dct * scales[:, None] * scales[None, :]
    low_frequencies = coefficients[:hash_size, :hash_size]
    bits = (low_frequencies > np.median(low_frequencies)).flatten()
    bit_string = "".join("1" if value else "0" for value in bits)
    width = (len(bit_string) + 3) // 4
    return f"{int(bit_string, 2):0{width}x}"


def calculate_image_hash(file_path):
    try:
        with Image.open(file_path) as image:
            return perceptual_hash(image)
    except Exception:
        return None


def images_are_strong_duplicates(first, second):
    try:
        with Image.open(first) as left, Image.open(second) as right:
            if left.size != right.size:
                return False
            return np.array_equal(np.asarray(left.convert("RGB")), np.asarray(right.convert("RGB")))
    except Exception:
        return False


def process_images_deduplication(generated_files):
    files = [Path(path) for path in generated_files if Path(path).is_file() and Path(path).suffix.lower() in IMAGE_EXTENSIONS]
    result = {"duplicateCount": 0, "recycledCount": 0, "failedCount": 0}
    if not files:
        return result
    hashes = {}
    for path in files:
        image_hash = calculate_image_hash(path)
        if image_hash:
            hashes.setdefault(image_hash, []).append(path)
    duplicates = []
    for paths in hashes.values():
        if len(paths) > 1:
            paths.sort(key=lambda path: path.stat().st_size, reverse=True)
            keepers = []
            for path in paths:
                if any(images_are_strong_duplicates(path, keeper) for keeper in keepers):
                    duplicates.append(path)
                else:
                    keepers.append(path)
    result["duplicateCount"] = len(duplicates)
    for path in duplicates:
        try:
            send2trash(str(path))
            result["recycledCount"] += 1
        except Exception as error:
            result["failedCount"] += 1
            log_warning(f"重复截图回收失败：{path.name}（{error}）")
    log_info(f"图片去重完成：发现 {len(duplicates)} 张重复截图，移入回收站 {result['recycledCount']} 张")
    return result


def move_txt_files(directory):
    result = {"movedCount": 0, "failedCount": 0}
    directory = Path(directory)
    data_dir = directory / "data"
    data_dir.mkdir(exist_ok=True)
    try:
        recovered = recover_pending_publications(data_dir, allowed_root=data_dir)
        for recovered_path in recovered:
            recovered_path = Path(recovered_path)
            source_path = directory / recovered_path.name
            if source_path.is_file():
                if source_path.stat().st_size != recovered_path.stat().st_size or file_digest(source_path) != file_digest(recovered_path):
                    raise OSError(f"恢复后的 TXT 与源文件内容不一致：{source_path.name}")
                source_path.unlink()
            result["movedCount"] += 1
    except Exception as error:
        result["failedCount"] += 1
        log_warning(f"TXT 自动恢复失败：{error}")
        return result
    txt_files = [path for path in directory.iterdir() if path.suffix.lower() == ".txt"]
    if not txt_files:
        return result
    for path in txt_files:
        try:
            publication = atomic_move_no_replace(path, data_dir / path.name)
            result["movedCount"] += 1
            if publication == "safe-fallback":
                log_warning("当前文件系统不支持原子 no-replace；TXT 整理已安全降级，异常崩溃可能同时保留源文件和不完整目标")
        except Exception as error:
            result["failedCount"] += 1
            log_warning(f"TXT 文件整理失败：{path.name}（{error}）")
    log_info(f"已将 {result['movedCount']} 个 TXT 文件移至 data 文件夹")
    return result


def collect_video_inputs(raw_paths):
    """Expand selected files/folders into a stable, de-duplicated video list."""
    videos = []
    selected_directories = []
    seen_videos = set()
    seen_directories = set()
    missing_paths = []
    unsupported_paths = []

    for raw_path in raw_paths:
        target = Path(raw_path)
        if not target.exists():
            missing_paths.append(target)
            continue
        if target.is_file():
            if target.suffix.lower() not in VIDEO_EXTENSIONS:
                unsupported_paths.append(target)
                continue
            candidates = [target]
        elif target.is_dir():
            directory_key = os.path.normcase(os.path.abspath(target))
            if directory_key not in seen_directories:
                seen_directories.add(directory_key)
                selected_directories.append(target)
            candidates = sorted(
                (path for path in target.rglob("*") if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS),
                key=lambda path: os.path.normcase(str(path)),
            )
        else:
            unsupported_paths.append(target)
            continue
        for candidate in candidates:
            key = os.path.normcase(os.path.abspath(candidate))
            if key in seen_videos:
                continue
            seen_videos.add(key)
            videos.append(candidate)
    return videos, selected_directories, missing_paths, unsupported_paths


def run(args_list):
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", action="append", required=True, help="目标视频或文件夹，可重复传入")
    parser.add_argument("--sensitivity", choices=("low", "standard", "high"), help="转场检测灵敏度")
    parser.add_argument("--threshold", type=float, help=argparse.SUPPRESS)
    parser.add_argument("--min_duration", type=float, default=0.2, help="最短镜头时长（秒）")
    parser.add_argument("--organize-data", action="store_true", help="把目录中的 TXT 文件移入 data 文件夹")
    parser.add_argument("--no-deduplicate", action="store_true", help="保留本次生成的重复截图，不自动去重")
    args = parser.parse_args(args_list)
    videos, selected_directories, missing_paths, unsupported_paths = collect_video_inputs(args.path)
    for target in missing_paths:
        log_warning(f"路径不存在，已跳过：{target}")
    for target in unsupported_paths:
        log_warning(f"不是支持的视频文件或文件夹，已跳过：{target}")
    if not videos and not selected_directories:
        log_error("没有可处理的视频或文件夹")
        return
    recovery_directories = []
    seen_recovery_directories = set()
    for directory in [*selected_directories, *(video.parent for video in videos)]:
        key = os.path.normcase(os.path.abspath(directory))
        if key not in seen_recovery_directories:
            seen_recovery_directories.add(key)
            recovery_directories.append(directory)
    try:
        for directory in recovery_directories:
            recovered = recover_pending_publications(directory, allowed_root=directory)
            if recovered:
                log_info(f"已恢复 {len(recovered)} 个上次未完成的文件发布")
    except Exception as error:
        log_error(f"检测到无法自动恢复的未提交文件，请按恢复标记处理：{error}")
        return
    log_progress("扫描视频文件…", 0)
    sensitivity = args.sensitivity or normalize_sensitivity(args.threshold)
    skipped_videos = []
    processed_videos = 0
    generated_files = []
    operation_failures = 0
    for index, video in enumerate(videos, 1):
        if detected_video_container(video) is None:
            skipped_videos.append(video.name)
        else:
            try:
                result = analyze_video(str(video), sensitivity, max(0.05, args.min_duration))
            except Exception as error:
                log_warning(f"视频处理失败，已跳过：{video.name}（{error}）")
                result = None
            if result is None:
                skipped_videos.append(video.name)
            else:
                processed_videos += 1
                operation_failures += getattr(result, "failure_count", 0)
                generated_files.extend(video.parent / item["file"] for item in result)
        log_progress(f"处理视频：{index}/{len(videos)}", int(index / max(1, len(videos)) * 90))
    if not videos:
        log_info("所选文件夹中未找到视频文件，跳过分镜识别")
    # Only this run's generated screenshots are eligible, including direct video
    # selections. Never include pre-existing sibling images.
    if generated_files and not args.no_deduplicate:
        deduplication_result = process_images_deduplication(generated_files) or {}
        operation_failures += deduplication_result.get("failedCount", 0)
    if args.organize_data:
        for directory in selected_directories:
            organization_result = move_txt_files(directory) or {}
            operation_failures += organization_result.get("failedCount", 0)
    if skipped_videos:
        preview_names = "、".join(f"“{name}”" for name in skipped_videos[:5])
        remaining = len(skipped_videos) - min(5, len(skipped_videos))
        suffix = f"等 {len(skipped_videos)} 个文件" if remaining else ""
        log_warning(
            f"已跳过 {preview_names}{suffix}：文件内容不是受支持的视频容器，或没有可解码的画面。",
            data={"skippedCount": len(skipped_videos), "processedCount": processed_videos},
        )
    log_progress("任务全部完成", 100)
    message = f"分镜处理完成：成功处理 {processed_videos} 个视频，跳过 {len(skipped_videos)} 个无效或不可读文件。"
    data = {"processedCount": processed_videos, "skippedCount": len(skipped_videos)}
    if skipped_videos or operation_failures:
        emit("error", message, data=data)
    else:
        log_success(message, data=data)


if __name__ == "__main__":
    try:
        run(sys.argv[1:])
    except Exception as error:
        log_error(f"脚本发生严重错误：{error}")
        raise
