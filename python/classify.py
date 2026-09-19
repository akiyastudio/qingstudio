import sys
import os
import shutil
import time
import datetime
import argparse
import subprocess
import re
import json
import functools
import hashlib
import math
import ctypes
import uuid
import stat
import queue
import threading
from contextlib import contextmanager
from pathlib import Path
import gc
from PIL import Image
from event_protocol import ask_user, emit, log_error, log_info, log_progress, log_status, log_success
from thumbnail_image import _embedded_jpeg

EXIFTOOL_PATH = ''
CAPTURE_TIME_MEMORY_CACHE = {}
CAPTURE_TIME_MEMORY_CACHE_LIMIT = 100000
IMPORT_MANIFEST_IDENTITIES = {}

CANCEL_FILE = ''
RESOURCE_PROTOCOL_ENABLED = False
VIDEO_TOOL_REQUEST_SEQUENCE = 0
HOST_CONTROL_POLL_SECONDS = 0.2
HOST_RESOURCE_RESPONSE_TIMEOUT_SECONDS = 30.0
HOST_VIDEO_TOOL_IDLE_TIMEOUT_SECONDS = 30.0
_HOST_CONTROL_EOF = object()
_HOST_CONTROL_STATE = None
_HOST_CONTROL_STATE_LOCK = threading.Lock()
VIDEO_PREVIEW_QUALITY_PROFILES = {
    'low': {'label': '低', 'preset': 'fast'},
    'medium': {'label': '中', 'preset': 'medium'},
    'high': {'label': '高', 'preset': 'slow'},
}


class FFmpegTranscodeError(RuntimeError):
    pass


def _read_host_control_stream(stream, messages):
    try:
        while True:
            line = stream.readline()
            if not line:
                messages.put((_HOST_CONTROL_EOF, None))
                return
            try:
                messages.put(('message', json.loads(line)))
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
    except BaseException as error:
        messages.put(('error', error))


def _host_control_messages():
    global _HOST_CONTROL_STATE
    stream = sys.stdin
    with _HOST_CONTROL_STATE_LOCK:
        state = _HOST_CONTROL_STATE
        if state is not None and state['stream'] is stream and state['thread'].is_alive():
            return state['messages']
        messages = queue.Queue()
        thread = threading.Thread(
            target=_read_host_control_stream,
            args=(stream, messages),
            name='photoflow-host-control',
            daemon=True,
        )
        _HOST_CONTROL_STATE = {'stream': stream, 'messages': messages, 'thread': thread}
        thread.start()
        return messages


def _next_host_control_message(messages, deadline, timeout_message, disconnected_message):
    while True:
        ensure_not_cancelled()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(timeout_message)
        try:
            kind, payload = messages.get(timeout=min(HOST_CONTROL_POLL_SECONDS, remaining))
        except queue.Empty:
            continue
        if kind is _HOST_CONTROL_EOF:
            raise ConnectionError(disconnected_message)
        if kind == 'error':
            raise ConnectionError(disconnected_message) from payload
        return payload


def normalize_video_preview_quality(value):
    return value if value in VIDEO_PREVIEW_QUALITY_PROFILES else 'medium'


def request_video_tool(action, payload):
    global VIDEO_TOOL_REQUEST_SEQUENCE
    if not RESOURCE_PROTOCOL_ENABLED:
        raise FFmpegTranscodeError('视频处理插件协议未启用')
    VIDEO_TOOL_REQUEST_SEQUENCE += 1
    request_id = f'video-{VIDEO_TOOL_REQUEST_SEQUENCE}'
    emit('video_tool_request', action, data={'requestId': request_id, 'action': action, 'payload': payload})
    messages = _host_control_messages()
    deadline = time.monotonic() + HOST_VIDEO_TOOL_IDLE_TIMEOUT_SECONDS
    while True:
        try:
            response = _next_host_control_message(
                messages,
                deadline,
                '视频处理插件长时间未响应',
                '视频处理插件已断开',
            )
        except (TimeoutError, ConnectionError) as error:
            raise FFmpegTranscodeError(str(error)) from error
        if response.get('requestId') != request_id:
            continue
        if response.get('type') == 'video_tool_progress':
            deadline = time.monotonic() + HOST_VIDEO_TOOL_IDLE_TIMEOUT_SECONDS
            message = str(response.get('message') or '').strip()
            if message:
                log_info(message)
            continue
        if response.get('type') != 'video_tool_result':
            continue
        if response.get('ok') is not True:
            raise FFmpegTranscodeError(str(response.get('error') or '视频处理失败'))
        return response.get('result') or {}


def probe_creation_time_values(input_path, timeout=15):
    del timeout
    return tuple(request_video_tool('probe-creation-time', {'inputPath': input_path}).get('values') or [])


def transcode_video_preview(input_path, output_path, quality, on_log=None):
    result = request_video_tool('preview', {'inputPath': input_path, 'outputPath': output_path, 'quality': quality})
    if on_log:
        on_log(f"视频预览编码器：{result.get('encoder') or '自动'}")
    return result.get('encoder') or ''


def split_video_by_size(input_path, split_threshold_bytes=None, target_segment_bytes=None,
                        maximum_segment_bytes=None, keep_original=False, cancel_check=None):
    if cancel_check:
        cancel_check()
    result = request_video_tool('split', {
        'inputPath': input_path,
        'splitThresholdBytes': split_threshold_bytes,
        'targetSegmentBytes': target_segment_bytes,
        'maximumSegmentBytes': maximum_segment_bytes,
        'keepOriginal': keep_original,
        'cancelFile': CANCEL_FILE,
    })
    return list(result.get('outputs') or [])


def transcode_video(input_path, container='mp4', video_mode='h264', quality='balanced',
                    resolution='original', frame_rate='original', audio_mode='aac',
                    subtitle_mode='copy', color_mode='auto', bit_depth='auto',
                    frame_rate_mode='preserve', rotation='auto', aspect_mode='preserve',
                    audio_track='all', video_bitrate_mbps=None, audio_bitrate_kbps=192,
                    encoder_preset='balanced', output_mode='new', destination_directory=None,
                    on_log=None, cancel_check=None, **_unused):
    if cancel_check:
        cancel_check()
    result = request_video_tool('transcode', {
        'inputPath': input_path, 'outputMode': output_mode, 'destinationDirectory': destination_directory,
        'cancelFile': CANCEL_FILE,
        'settings': {
            'container': container, 'videoMode': video_mode, 'quality': quality,
            'resolution': resolution, 'frameRate': frame_rate, 'audioMode': audio_mode,
            'subtitleMode': subtitle_mode, 'colorMode': color_mode, 'bitDepth': bit_depth,
            'frameRateMode': frame_rate_mode, 'rotation': rotation, 'aspectMode': aspect_mode,
            'audioTrack': audio_track, 'videoBitrateMbps': video_bitrate_mbps,
            'audioBitrateKbps': audio_bitrate_kbps, 'encoderPreset': encoder_preset,
        },
    })
    if on_log:
        on_log(f"视频转码完成：{os.path.basename(result.get('outputPath') or input_path)}")
    return result.get('outputPath')


class ImportCancelled(Exception):
    pass


class SourceIdentityMismatch(OSError):
    pass


class ResourceLeaseDenied(RuntimeError):
    pass


def ensure_not_cancelled():
    if CANCEL_FILE and os.path.exists(CANCEL_FILE):
        raise ImportCancelled('导入已取消')


@contextmanager
def task_resource_lease(profile, phase):
    """Wait for a host-owned phase lease before starting resource-intensive work."""
    if not RESOURCE_PROTOCOL_ENABLED:
        yield
        return
    lease_id = f'lease-{uuid.uuid4()}'
    emit('resource_request', phase, data={'leaseId': lease_id, 'profile': profile, 'phase': phase})
    messages = _host_control_messages()
    deadline = time.monotonic() + HOST_RESOURCE_RESPONSE_TIMEOUT_SECONDS
    granted = False
    while True:
        try:
            response = _next_host_control_message(
                messages,
                deadline,
                '等待主程序分配视频处理资源超时',
                '主程序已断开资源调度协议',
            )
        except (TimeoutError, ConnectionError) as error:
            raise ResourceLeaseDenied(str(error)) from error
        if str(response.get('leaseId') or '') != lease_id:
            continue
        if response.get('type') == 'resource_waiting':
            deadline = time.monotonic() + HOST_RESOURCE_RESPONSE_TIMEOUT_SECONDS
            continue
        if response.get('type') == 'resource_granted':
            granted = True
            break
        if response.get('type') == 'resource_denied':
            if CANCEL_FILE and os.path.exists(CANCEL_FILE):
                raise ImportCancelled('导入已取消')
            raise ResourceLeaseDenied(str(response.get('error') or '主程序拒绝了阶段资源请求'))
    try:
        ensure_not_cancelled()
        yield
    finally:
        if granted:
            emit('resource_release', phase, data={'leaseId': lease_id, 'profile': profile})

# --- 2. 辅助工具函数 ---
def safe_chunk_copy(src, dst, chunk_size=4 * 1024 * 1024, on_progress=None, collect_digest=False, durable=False):
    """Copy once, collecting full chunk digests only for destructive-source batches."""
    bytes_copied = 0
    chunk_hashes = [] if collect_digest else None
    try:
        with open(src, 'rb') as fsrc, open(dst, 'wb') as fdst:
            while True:
                ensure_not_cancelled()
                buf = fsrc.read(chunk_size)
                if not buf:
                    break
                fdst.write(buf)
                if chunk_hashes is not None:
                    chunk_hashes.append(hashlib.sha256(buf).hexdigest())
                bytes_copied += len(buf)
                if on_progress:
                    on_progress(bytes_copied)
            if collect_digest or durable:
                fdst.flush()
                os.fsync(fdst.fileno())

        shutil.copystat(src, dst)
        if chunk_hashes is not None:
            return {'algorithm': 'sha256', 'chunkSize': int(chunk_size), 'chunks': chunk_hashes}
        return None
    except Exception as e:
        # 如果中途出错（比如读卡器突然拔出），with open 会确保文件句柄被立即强制关闭
        # 避免 Windows 内核锁死
        try:
            os.remove(dst)
        except OSError:
            pass
        raise e


def _real_path_inside(root, path):
    root_real = os.path.normcase(os.path.realpath(os.path.abspath(root)))
    path_real = os.path.normcase(os.path.realpath(os.path.abspath(path)))
    try:
        return os.path.commonpath((root_real, path_real)) == root_real
    except ValueError:
        return False


def _is_link_or_reparse(path):
    try:
        info = os.lstat(path)
    except OSError:
        return True
    attributes = int(getattr(info, 'st_file_attributes', 0) or 0)
    return stat.S_ISLNK(info.st_mode) or bool(attributes & 0x400)


def _safe_directory_target(root, path):
    root_abs = os.path.abspath(root)
    path_abs = os.path.abspath(path)
    existing_anchor = root_abs
    while not os.path.lexists(existing_anchor):
        parent = os.path.dirname(existing_anchor)
        if parent == existing_anchor:
            return False
        existing_anchor = parent
    if not os.path.isdir(existing_anchor) or existing_anchor != root_abs and _is_link_or_reparse(existing_anchor):
        return False
    try:
        if os.path.commonpath((root_abs, path_abs)) != root_abs or not _real_path_inside(root_abs, path_abs):
            return False
        relative = os.path.relpath(path_abs, root_abs)
    except ValueError:
        return False
    candidates = [root_abs]
    current = root_abs
    if relative not in ('', '.'):
        for part in Path(relative).parts:
            current = os.path.join(current, part)
            candidates.append(current)
    missing_seen = False
    for candidate in candidates:
        if not os.path.lexists(candidate):
            missing_seen = True
            continue
        if missing_seen or not os.path.isdir(candidate):
            return False
    return True


def _regular_file_without_links(path, root=None, nonempty=False):
    """Reject symlinks/junction-like realpath escapes and non-regular outputs."""
    absolute = os.path.abspath(path)
    if root is not None and not _real_path_inside(root, absolute):
        return False
    try:
        info = os.lstat(absolute)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            return False
        if nonempty and info.st_size <= 0:
            return False
    except OSError:
        return False
    return True


def _has_video_container_signature(path, extension):
    try:
        with open(path, 'rb') as media_file:
            header = media_file.read(512)
    except OSError:
        return False
    extension = extension.lower()
    if extension in ('.mp4', '.mov', '.m4v', '.crm'):
        return len(header) >= 12 and header[4:8] == b'ftyp'
    if extension == '.avi':
        return len(header) >= 12 and header[:4] == b'RIFF' and header[8:12] == b'AVI '
    if extension in ('.mpeg', '.mpg'):
        return header.startswith((b'\x00\x00\x01\xba', b'\x00\x00\x01\xb3'))
    if extension in ('.mts', '.m2ts'):
        return bool(header) and (header[0] == 0x47 or len(header) > 4 and header[4] == 0x47)
    if extension in ('.mkv', '.webm'):
        return header.startswith(b'\x1aE\xdf\xa3')
    return False


def validate_tool_output_paths(paths, target_root, input_path='', require_decodable=True, expected_extensions=None):
    """Normalize and validate untrusted split/transcode tool results."""
    normalized = []
    seen = set()
    input_real = os.path.normcase(os.path.realpath(input_path)) if input_path else ''
    allowed_extensions = {
        value.lower() if str(value).startswith('.') else f'.{str(value).lower()}'
        for value in (expected_extensions or VIDEO_OUTPUT_EXTENSIONS)
    }
    for raw_path in paths or []:
        if not isinstance(raw_path, (str, os.PathLike)) or not str(raw_path).strip():
            raise ValueError('视频工具返回了无效输出路径')
        output = os.path.abspath(os.fspath(raw_path))
        key = os.path.normcase(os.path.realpath(output))
        if key in seen or key == input_real:
            raise ValueError('视频工具返回了重复输出或原片路径')
        if not _regular_file_without_links(output, target_root, nonempty=True):
            raise ValueError(f'视频工具输出不是目标树内的普通非空文件：{os.path.basename(output)}')
        extension = os.path.splitext(output)[1].lower()
        if extension not in allowed_extensions:
            raise ValueError(f'视频工具输出扩展名不符合预期：{os.path.basename(output)}')
        if require_decodable and not _has_video_container_signature(output, extension):
            raise ValueError(f'视频工具输出容器签名无效：{os.path.basename(output)}')
        if require_decodable and RESOURCE_PROTOCOL_ENABLED and os.path.splitext(output)[1].lower() in VIDEO_EXTENSIONS:
            # The existing media probe opens and parses the container. A failure
            # is fatal even when no creation-time tag is present.
            probe_creation_time_values(output)
        seen.add(key)
        normalized.append(output)
    if not normalized:
        raise ValueError('视频工具没有返回可验证的输出文件')
    return normalized


class VerificationCheckpointThrottle:
    """Coalesce verification progress across files into bounded durable windows."""
    def __init__(self, checkpoint, interval_seconds=None, interval_bytes=None, clock=None):
        self.checkpoint = checkpoint
        self.interval_seconds = float(interval_seconds or VERIFICATION_CHECKPOINT_INTERVAL_SECONDS)
        self.interval_bytes = int(interval_bytes or VERIFICATION_CHECKPOINT_INTERVAL_BYTES)
        self.clock = clock or time.monotonic
        self.last_checkpoint_at = self.clock()
        self.pending_bytes = 0
        self.dirty = False
        self.checkpoint_count = 0

    def advance(self, verified_bytes):
        self.pending_bytes += max(0, int(verified_bytes or 0))
        self.dirty = True
        if self.pending_bytes >= self.interval_bytes:
            self.flush(now=self.clock())

    def mark_dirty(self):
        self.dirty = True

    def flush(self, force=False, now=None):
        if not self.dirty:
            return False
        current = self.clock() if now is None else now
        if not force and self.pending_bytes < self.interval_bytes:
            return False
        self.checkpoint()
        self.checkpoint_count += 1
        self.pending_bytes = 0
        self.dirty = False
        self.last_checkpoint_at = current
        return True


def _verify_entry_copy_chunks(entry, candidate, checkpoint_throttle=None):
    """Read back only unfinished chunks and durably remember resumable progress."""
    digest = entry.get('copyDigest') or {}
    hashes = digest.get('chunks') if isinstance(digest, dict) else None
    chunk_size = int(digest.get('chunkSize') or 0) if isinstance(digest, dict) else 0
    expected_size = int(entry.get('size') or -1)
    if not hashes or chunk_size <= 0 or not _regular_file_without_links(candidate, nonempty=expected_size > 0):
        return False
    try:
        info = os.lstat(candidate)
    except OSError:
        return False
    def stable_stat_integer(value):
        return int(value) if isinstance(value, int) and not isinstance(value, bool) else 0

    signature = {
        'canonicalPath': os.path.normcase(os.path.realpath(os.path.abspath(candidate))),
        'device': stable_stat_integer(getattr(info, 'st_dev', 0)),
        'fileId': stable_stat_integer(getattr(info, 'st_ino', 0)),
        'size': int(info.st_size),
        'mtimeNs': int(info.st_mtime_ns),
    }
    verification = entry.get('copyVerification') if isinstance(entry.get('copyVerification'), dict) else {}
    previous_signature = verification.get('targetSignature') if isinstance(verification.get('targetSignature'), dict) else {}
    identity_fields = ('device', 'fileId')
    reliable_identity = all(
        isinstance(previous_signature.get(field), int)
        and not isinstance(previous_signature.get(field), bool)
        and previous_signature[field] > 0
        and isinstance(signature.get(field), int)
        and not isinstance(signature.get(field), bool)
        and signature[field] > 0
        for field in identity_fields
    )
    same_identity = reliable_identity and all(
        previous_signature.get(field) == signature.get(field)
        for field in identity_fields
    )
    stable_metadata = all(
        isinstance(previous_signature.get(field), int)
        and not isinstance(previous_signature.get(field), bool)
        and isinstance(signature.get(field), int)
        and not isinstance(signature.get(field), bool)
        and previous_signature.get(field) == signature.get(field)
        for field in ('size', 'mtimeNs')
    )
    unchanged_file = same_identity and stable_metadata
    # An atomic same-volume promotion changes only the canonical path. Reuse
    # completed chunks only when the filesystem provides a reliable identity
    # proving that this is still the exact same file. Cross-volume copies,
    # synthetic/unknown identities and metadata changes always restart at byte 0.
    completed = int(verification.get('verifiedChunks') or 0) if unchanged_file else 0
    if completed < 0 or completed > len(hashes):
        completed = 0
    elif completed and previous_signature != signature:
        verification = {**verification, 'targetSignature': signature}
        entry['copyVerification'] = verification
        if checkpoint_throttle:
            checkpoint_throttle.mark_dirty()
    try:
        with open(candidate, 'rb') as copied:
            copied.seek(completed * chunk_size)
            for index in range(completed, len(hashes)):
                ensure_not_cancelled()
                block = copied.read(chunk_size)
                if hashlib.sha256(block).hexdigest() != hashes[index]:
                    entry.pop('copyVerification', None)
                    if checkpoint_throttle:
                        checkpoint_throttle.mark_dirty()
                        checkpoint_throttle.flush(force=True)
                    return False
                entry['copyVerification'] = {
                    'algorithm': 'sha256', 'targetSignature': signature,
                    'verifiedChunks': index + 1, 'complete': index + 1 == len(hashes),
                }
                if checkpoint_throttle:
                    checkpoint_throttle.advance(len(block))
            if copied.read(1):
                return False
    except OSError:
        return False
    return int(info.st_size) == expected_size and len(hashes) == math.ceil(expected_size / chunk_size)


def ensure_import_disk_space(destination, required_bytes, purpose='导入'):
    """Fail before copying when the destination cannot safely hold the requested data."""
    required = max(0, int(required_bytes or 0))
    if not required:
        return
    usage = shutil.disk_usage(destination)
    reserve = max(512 * 1024 * 1024, min(5 * 1024 * 1024 * 1024, int(required * 0.02)))
    if usage.free < required + reserve:
        missing = required + reserve - usage.free
        raise OSError(f'{purpose}磁盘空间不足，还需要约 {missing / (1024 ** 3):.2f} GB 可用空间。')


def _move_file_no_replace(source, destination):
    """Commit one file without ever replacing an independently created target."""
    if os.name == 'nt':
        moved = ctypes.windll.kernel32.MoveFileExW(
            ctypes.c_wchar_p(os.path.abspath(source)),
            ctypes.c_wchar_p(os.path.abspath(destination)),
            0,
        )
        if not moved:
            raise ctypes.WinError()
        return
    os.link(source, destination)
    os.remove(source)


def import_part_path(destination, staged_path):
    """Return the deterministic, session-owned temporary path for a promotion."""
    token = hashlib.sha256(os.path.normcase(os.path.abspath(staged_path)).encode('utf-8', errors='surrogatepass')).hexdigest()[:12]
    return f'{os.path.abspath(destination)}.photoflow-part-{token}'


def _files_have_same_import_content(source, candidate):
    try:
        source_size = os.path.getsize(source)
        if os.path.getsize(candidate) != source_size:
            return False
        return _source_sample_fingerprint(source, source_size) == _source_sample_fingerprint(candidate, source_size)
    except OSError:
        return False


def promote_staged_file(source, destination, on_progress=None, allow_atomic_move=True, temporary_path=None):
    """Safely promote a staged file without exposing partial or overwritten targets."""
    if os.path.exists(destination):
        raise FileExistsError(f'目标中已出现同名文件：{os.path.basename(destination)}')
    expected_temporary = import_part_path(destination, source)
    temporary = os.path.abspath(temporary_path or expected_temporary)
    if temporary != expected_temporary:
        raise ValueError('导入临时文件与当前目标不匹配')
    if allow_atomic_move:
        try:
            same_volume = os.stat(source).st_dev == os.stat(os.path.dirname(destination)).st_dev
        except OSError:
            same_volume = False
        if same_volume:
            try:
                _move_file_no_replace(source, destination)
                if os.path.isfile(temporary):
                    try:
                        os.remove(temporary)
                    except OSError:
                        pass
                return True
            except OSError:
                # Some filesystems or security products can reject metadata-only
                # moves. Retain the verified copy path as a safe fallback.
                if os.path.exists(destination):
                    raise FileExistsError(f'目标中已出现同名文件：{os.path.basename(destination)}')
                if not os.path.exists(source):
                    raise

    if os.path.exists(temporary) and not _files_have_same_import_content(source, temporary):
        os.remove(temporary)
    if not os.path.isfile(temporary):
        safe_chunk_copy(source, temporary, on_progress=on_progress, durable=True)
    if not _files_have_same_import_content(source, temporary):
        raise IOError(f'整理校验失败：{os.path.basename(source)}')
    if os.path.exists(destination):
        raise FileExistsError(f'目标中已出现同名文件：{os.path.basename(destination)}')
    _move_file_no_replace(temporary, destination)
    return False

VALID_MEDIA_EXTENSIONS = ('.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.avif', '.heic', '.heif', '.hif', '.arw', '.cr2', '.cr3', '.dng', '.nef', '.orf', '.mp4', '.mov', '.avi', '.mpeg', '.mpg', '.mts', '.m2ts', '.crm', '.rwl', '.raf', '.3fr', '.fff')
IMPORT_DATE_FILTERS = ('all', 'today', 'today_yesterday')
RAW_EXTENSIONS = ('.arw', '.cr2', '.cr3', '.dng', '.nef', '.orf', '.rwl', '.raf', '.3fr', '.fff')
JPG_EXTENSIONS = ('.jpg', '.jpeg')
VIDEO_EXTENSIONS = ('.mp4', '.mov', '.avi', '.mpeg', '.mpg', '.mts', '.m2ts', '.crm')
VIDEO_OUTPUT_EXTENSIONS = (*VIDEO_EXTENSIONS, '.m4v', '.mkv', '.webm')
FOUR_GB = 4 * 1024 * 1024 * 1024
SPLIT_TARGET_BYTES = int(3.95 * 1024 * 1024 * 1024)


def _parse_capture_timestamp(value):
    text = str(value or '').strip().strip('\x00')
    if not text:
        return None
    normalized = text.replace('Z', '+00:00') if text.endswith('Z') else text
    for parser in (
        lambda: datetime.datetime.fromisoformat(normalized),
        lambda: datetime.datetime.strptime(text[:19], '%Y:%m:%d %H:%M:%S'),
        lambda: datetime.datetime.strptime(text[:19], '%Y-%m-%d %H:%M:%S'),
    ):
        try:
            timestamp = parser().timestamp()
            if timestamp > 0:
                return timestamp
        except (TypeError, ValueError, OverflowError):
            continue
    return None


def _image_capture_timestamp(file_path):
    extension = os.path.splitext(file_path)[1].lower()
    image = None
    try:
        image = _embedded_jpeg(file_path) if extension in RAW_EXTENSIONS else Image.open(file_path)
        exif = image.getexif()
        for tag in (36867, 36868, 306):  # DateTimeOriginal, DateTimeDigitized, DateTime
            timestamp = _parse_capture_timestamp(exif.get(tag))
            if timestamp is not None:
                return timestamp
    except Exception:
        return None
    finally:
        if image is not None:
            image.close()
    return None


def _video_capture_timestamp(file_path):
    try:
        for value in probe_creation_time_values(file_path, timeout=15):
            timestamp = _parse_capture_timestamp(value)
            if timestamp is not None:
                return timestamp
    except (OSError, subprocess.SubprocessError):
        return None
    return None


@functools.lru_cache(maxsize=8192)
def get_file_time(file_path):
    """Prefer the media capture time; use filesystem mtime only as a fallback."""
    extension = os.path.splitext(file_path)[1].lower()
    timestamp = _video_capture_timestamp(file_path) if extension in VIDEO_EXTENSIONS else _image_capture_timestamp(file_path)
    # Reject camera/tool sentinel values and implausible future dates. Filesystem
    # mtime is a safer routing fallback than creating a wildly wrong project.
    if timestamp is not None and -2208988800 <= timestamp <= time.time() + 2 * 24 * 60 * 60:
        return timestamp
    try:
        return os.path.getmtime(file_path)
    except OSError as error:
        raise OSError(f'无法读取媒体文件时间：{file_path}') from error


def _capture_cache_records(file_paths):
    records = []
    for file_path in file_paths:
        ensure_not_cancelled()
        absolute_path = os.path.abspath(file_path)
        stat = os.stat(absolute_path)
        records.append({
            'filePath': absolute_path,
            'cachePath': os.path.normcase(absolute_path),
            'size': int(stat.st_size),
            'mtimeNs': int(stat.st_mtime_ns),
        })
    return records


def _capture_memory_key(record):
    return record['cachePath'], record['size'], record['mtimeNs']


def _remember_capture_times(records, capture_times):
    for record in records:
        timestamp = capture_times.get(record['cachePath'])
        if timestamp is not None and timestamp > 0:
            CAPTURE_TIME_MEMORY_CACHE[_capture_memory_key(record)] = float(timestamp)
    while len(CAPTURE_TIME_MEMORY_CACHE) > CAPTURE_TIME_MEMORY_CACHE_LIMIT:
        CAPTURE_TIME_MEMORY_CACHE.pop(next(iter(CAPTURE_TIME_MEMORY_CACHE)))


def _timestamp_from_exiftool_value(value):
    if isinstance(value, (int, float)) and float(value) > 0:
        return float(value)
    text = str(value or '').strip()
    numeric = re.fullmatch(r'(-?\d+(?:\.\d+)?)', text)
    if numeric:
        try:
            timestamp = float(numeric.group(1))
            if timestamp > 0:
                return timestamp
        except ValueError:
            pass
    return _parse_capture_timestamp(text)


def _read_exiftool_capture_times(file_paths, fast=True):
    if not EXIFTOOL_PATH or not os.path.isfile(EXIFTOOL_PATH) or not file_paths:
        return None
    command = [
        EXIFTOOL_PATH,
        '-charset', 'filename=UTF8',
        '-json', '-G1', '-n', '-fast2' if fast else '-fast', '-d', '%s',
        '-api', 'QuickTimeUTC=1',
        '-DateTimeOriginal', '-CreateDate', '-MediaCreateDate', '-TrackCreateDate', '-CreationDate', '-ModifyDate',
        '-@', '-',
    ]
    argument_stream = '--\n' + '\n'.join(os.path.abspath(file_path) for file_path in file_paths) + '\n'
    try:
        result = subprocess.run(
            command,
            input=argument_stream,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding='utf-8',
            errors='replace',
            timeout=max(30, min(600, len(file_paths) * 2)),
        )
        if result.returncode not in (0, 1) or not result.stdout.strip():
            return None
        payload = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, json.JSONDecodeError):
        return None
    capture_times = {}
    video_priority = ('MediaCreateDate', 'TrackCreateDate', 'CreationDate', 'CreateDate', 'DateTimeOriginal', 'ModifyDate')
    image_priority = ('DateTimeOriginal', 'CreateDate', 'ModifyDate', 'MediaCreateDate', 'TrackCreateDate', 'CreationDate')
    for item in payload if isinstance(payload, list) else []:
        if not isinstance(item, dict):
            continue
        source_path = str(item.get('SourceFile') or '')
        if not source_path:
            continue
        values = {str(key).split(':')[-1]: value for key, value in item.items()}
        extension = os.path.splitext(source_path)[1].lower()
        for tag in video_priority if extension in VIDEO_EXTENSIONS else image_priority:
            timestamp = _timestamp_from_exiftool_value(values.get(tag))
            if timestamp is not None:
                capture_times[os.path.normcase(os.path.abspath(source_path))] = timestamp
                break
    return capture_times


def capture_times_for_files(file_paths, on_progress=None):
    """Read real capture times in one ExifTool process and reuse them only in this task."""
    records = _capture_cache_records(file_paths)
    cached = {
        record['cachePath']: CAPTURE_TIME_MEMORY_CACHE[_capture_memory_key(record)]
        for record in records
        if _capture_memory_key(record) in CAPTURE_TIME_MEMORY_CACHE
    }
    missing_records = [record for record in records if record['cachePath'] not in cached]
    missing_paths = [record['filePath'] for record in missing_records]
    batch_values = _read_exiftool_capture_times(missing_paths, fast=True) if missing_paths else {}
    resolved = dict(cached)
    if batch_values is None:
        for record in missing_records:
            ensure_not_cancelled()
            resolved[record['cachePath']] = get_file_time(record['filePath'])
    else:
        slow_records = [record for record in missing_records if record['cachePath'] not in batch_values]
        if slow_records:
            slow_values = _read_exiftool_capture_times([record['filePath'] for record in slow_records], fast=False)
            if slow_values:
                batch_values.update(slow_values)
        for record in missing_records:
            timestamp = batch_values.get(record['cachePath'])
            resolved[record['cachePath']] = timestamp if timestamp is not None else os.path.getmtime(record['filePath'])
    _remember_capture_times(missing_records, resolved)
    timed_files = []
    total_files = len(records)
    for file_index, record in enumerate(records, start=1):
        ensure_not_cancelled()
        timestamp = resolved[record['cachePath']]
        timed_files.append((record['filePath'], timestamp))
        if on_progress:
            on_progress(file_index, total_files, record['filePath'])
    return timed_files

def scan_sd_media(sd_path):
    normalized_sd = os.path.normpath(sd_path)
    base_sd = os.path.dirname(normalized_sd) if normalized_sd.upper().endswith('DCIM') else normalized_sd
    files = []
    for target_dir in (os.path.join(base_sd, 'DCIM'), os.path.join(base_sd, 'PRIVATE')):
        if not os.path.exists(target_dir):
            continue
        for root, dirs, names in os.walk(target_dir):
            ensure_not_cancelled()
            dirs[:] = [directory for directory in dirs if not directory.startswith('.')]
            files.extend(
                os.path.join(root, name)
                for name in names
                if not name.startswith('.') and name.lower().endswith(VALID_MEDIA_EXTENSIONS)
            )
    return base_sd, files

def scan_direct_media(source_path):
    """Read an explicitly selected file or directory without SD-card layout rules."""
    normalized_source = os.path.normpath(source_path)
    if os.path.isfile(normalized_source):
        files = [normalized_source] if normalized_source.lower().endswith(VALID_MEDIA_EXTENSIONS) else []
        return os.path.dirname(normalized_source), files
    files = []
    if os.path.isdir(normalized_source):
        for root, dirs, names in os.walk(normalized_source):
            ensure_not_cancelled()
            dirs[:] = [directory for directory in dirs if not directory.startswith('.')]
            files.extend(
                os.path.join(root, name)
                for name in names
                if not name.startswith('.') and name.lower().endswith(VALID_MEDIA_EXTENSIONS)
            )
    return normalized_source, files

def scan_import_media(source_path, direct_source=False, source_paths=None):
    if not direct_source:
        return scan_sd_media(source_path)
    selected_sources = source_paths or [source_path]
    files = []
    seen = set()
    for selected_source in selected_sources:
        ensure_not_cancelled()
        _root, selected_files = scan_direct_media(selected_source)
        for file_path in selected_files:
            ensure_not_cancelled()
            normalized = os.path.normcase(os.path.abspath(file_path))
            if normalized in seen:
                continue
            seen.add(normalized)
            files.append(file_path)
    root_label = os.path.dirname(selected_sources[0]) if len(selected_sources) > 1 and os.path.isfile(selected_sources[0]) else selected_sources[0]
    return os.path.normpath(root_label), files


def filter_media_by_capture_date(files, date_filter='all', today=None, on_progress=None):
    """Filter by local capture date without reading metadata when filtering is disabled."""
    normalized_filter = date_filter if date_filter in IMPORT_DATE_FILTERS else 'all'
    if normalized_filter == 'all':
        return list(files), {}
    current_date = today or datetime.date.today()
    allowed_dates = {current_date}
    if normalized_filter == 'today_yesterday':
        allowed_dates.add(current_date - datetime.timedelta(days=1))
    selected = []
    capture_times = {}
    timed_files = capture_times_for_files(files)
    total_files = len(timed_files)
    for file_index, (file_path, timestamp) in enumerate(timed_files, start=1):
        ensure_not_cancelled()
        matched = datetime.datetime.fromtimestamp(timestamp).date() in allowed_dates
        if matched:
            selected.append(file_path)
            capture_times[os.path.normcase(os.path.abspath(file_path))] = float(timestamp)
        if on_progress:
            on_progress(file_index, total_files, file_path, len(selected))
    return selected, capture_times


STAGING_MANIFEST_NAME = '.photoflow-import-manifest.json'
IMPORT_GRAPH_RECEIPT_NAME = '.photoflow-import-graph-receipt.json'
STAGING_PATCH_JOURNAL_NAME = '.photoflow-import-patches.jsonl'
STAGING_RETENTION_SECONDS = 30 * 24 * 60 * 60
SOURCE_FINGERPRINT_BYTES = 64 * 1024
VERIFICATION_CHECKPOINT_INTERVAL_SECONDS = 3.0
VERIFICATION_CHECKPOINT_INTERVAL_BYTES = 2 * 1024 * 1024 * 1024


def _source_volume_identity(source_path):
    absolute_path = os.path.abspath(source_path)
    if os.name == 'nt':
        drive, _tail = os.path.splitdrive(absolute_path)
        root = f'{drive}\\' if drive else absolute_path
        serial = ctypes.c_ulong(0)
        maximum_component = ctypes.c_ulong(0)
        flags = ctypes.c_ulong(0)
        volume_name = ctypes.create_unicode_buffer(261)
        filesystem_name = ctypes.create_unicode_buffer(261)
        try:
            succeeded = ctypes.windll.kernel32.GetVolumeInformationW(
                ctypes.c_wchar_p(root), volume_name, len(volume_name), ctypes.byref(serial),
                ctypes.byref(maximum_component), ctypes.byref(flags), filesystem_name, len(filesystem_name),
            )
            if succeeded:
                return f'windows:{serial.value:08x}:{filesystem_name.value.casefold()}:{volume_name.value.casefold()}'
        except (AttributeError, OSError, ValueError):
            pass
    try:
        return f'posix:{os.stat(absolute_path).st_dev}'
    except OSError:
        return ''


def _is_import_volume_root(source_path):
    absolute_path = os.path.abspath(source_path)
    if os.name == 'nt':
        drive, tail = os.path.splitdrive(absolute_path)
        return bool(drive) and os.path.normpath(tail) == os.path.normpath(os.sep)
    if sys.platform == 'darwin':
        return os.path.dirname(absolute_path.rstrip(os.sep)) == '/Volumes'
    return False


def _source_sample_fingerprint(file_path, size=None):
    file_size = os.path.getsize(file_path) if size is None else int(size)
    digest = hashlib.sha256()
    with open(file_path, 'rb') as source:
        digest.update(source.read(SOURCE_FINGERPRINT_BYTES))
        if file_size > SOURCE_FINGERPRINT_BYTES:
            source.seek(max(0, file_size - SOURCE_FINGERPRINT_BYTES))
            digest.update(source.read(SOURCE_FINGERPRINT_BYTES))
    digest.update(str(file_size).encode('ascii'))
    return digest.hexdigest()


def _source_entry_metadata(file_path):
    link_stat = os.lstat(file_path)
    if stat.S_ISLNK(link_stat.st_mode) or not stat.S_ISREG(link_stat.st_mode):
        raise OSError(f'导入源不是普通文件：{file_path}')
    file_stat = os.stat(file_path)
    return {
        'size': int(file_stat.st_size),
        'sourceMtimeNs': int(file_stat.st_mtime_ns),
        'sourceRealPath': os.path.normcase(os.path.realpath(file_path)),
        'sourceFingerprint': _source_sample_fingerprint(file_path, file_stat.st_size),
    }


def _entry_current_source_status(entry):
    source_path = os.path.abspath(str(entry.get('source') or ''))
    try:
        current = _source_entry_metadata(source_path)
    except OSError:
        return 'missing'
    if current['size'] != int(entry.get('size') or -1):
        return 'changed'
    stored_mtime = entry.get('sourceMtimeNs')
    if isinstance(stored_mtime, int) and stored_mtime != current['sourceMtimeNs']:
        return 'changed'
    stored_real_path = str(entry.get('sourceRealPath') or '')
    if stored_real_path and os.path.normcase(os.path.realpath(source_path)) != stored_real_path:
        return 'changed'
    stored_fingerprint = str(entry.get('sourceFingerprint') or '')
    return 'match' if not stored_fingerprint or stored_fingerprint == current['sourceFingerprint'] else 'changed'


def _entry_matches_current_source(entry):
    return _entry_current_source_status(entry) == 'match'


def _entry_matches_imported_content(entry, file_path, expected_size):
    """Verify that a recovered destination contains this entry's staged media."""
    stored_fingerprint = str(entry.get('sourceFingerprint') or '')
    if not stored_fingerprint:
        return False
    try:
        if not os.path.isfile(file_path) or os.path.getsize(file_path) != expected_size:
            return False
        return _source_sample_fingerprint(file_path, expected_size) == stored_fingerprint
    except OSError:
        return False


def _validate_staged_source_identity(staged_import):
    """Return whether the original source is still present and unchanged."""
    base_source = str(staged_import.get('baseSource') or '')
    if not base_source or not os.path.exists(base_source):
        return False
    if int(staged_import.get('manifestVersion') or 0) < 2:
        raise SourceIdentityMismatch('旧版暂存缺少 SD 卡身份，旧暂存不会用于当前卡。')
    stored_volume = str(staged_import.get('sourceVolumeIdentity') or '')
    current_volume = _source_volume_identity(base_source)
    if stored_volume and current_volume and stored_volume != current_volume:
        raise SourceIdentityMismatch('检测到 SD 卡已经更换，旧暂存不会用于当前卡。')
    entries = staged_import.get('entries') or []
    statuses = [_entry_current_source_status(entry) for entry in entries]
    for entry, status in zip(entries, statuses):
        if status == 'changed':
            raise SourceIdentityMismatch(f"检测到源文件已变化：{os.path.basename(str(entry.get('source') or ''))}")
    return bool(entries) and all(status == 'match' for status in statuses)


def verify_staged_import_for_source_cleanup(staged_import):
    """Fully read back local copies before allowing any destructive source cleanup."""
    entries = staged_import.get('entries') or []
    if not entries:
        return False
    throttle = VerificationCheckpointThrottle(lambda: checkpoint_staged_import(staged_import))
    try:
        for entry in entries:
            candidate = str(entry.get('committedDestination') or entry.get('staged') or '')
            root = staged_import['stagingDir'] if candidate == entry.get('staged') else os.path.dirname(candidate)
            if not _regular_file_without_links(candidate, root=root, nonempty=int(entry.get('size') or 0) > 0):
                throttle.flush(force=True)
                return False
            if not _verify_entry_copy_chunks(entry, candidate, throttle):
                throttle.flush(force=True)
                return False
        throttle.flush(force=True)
        return True
    except BaseException:
        # Cancellation, disconnects and unexpected failures retain the latest
        # in-memory progress at the critical boundary before propagating.
        throttle.flush(force=True)
        raise


def cleanup_expired_import_staging(dest_path, retention_seconds=STAGING_RETENTION_SECONDS):
    staging_root = os.path.join(os.path.abspath(dest_path), '_PhotoFlow_Safety_Temp')
    if not os.path.isdir(staging_root):
        return 0
    cutoff = time.time() - max(0, retention_seconds)
    removed = 0
    for name in os.listdir(staging_root):
        session_dir = os.path.join(staging_root, name)
        manifest_path = _staging_manifest_path(session_dir)
        if os.path.isfile(_import_graph_receipt_path(session_dir)):
            continue
        try:
            if os.path.isdir(session_dir) and os.path.getmtime(manifest_path) < cutoff:
                shutil.rmtree(session_dir)
                removed += 1
        except OSError:
            continue
    try:
        os.rmdir(staging_root)
    except OSError:
        pass
    return removed


def get_import_staging_dir(dest_path, import_session=''):
    session_name = re.sub(r'[^a-zA-Z0-9_-]', '', str(import_session or ''))[:80] or 'default'
    return os.path.join(os.path.abspath(dest_path), '_PhotoFlow_Safety_Temp', session_name)


def _staging_manifest_path(staging_dir):
    return os.path.join(staging_dir, STAGING_MANIFEST_NAME)


def _staging_patch_journal_path(staging_dir):
    return os.path.join(staging_dir, STAGING_PATCH_JOURNAL_NAME)


def _replay_staging_patch_journal(staging_dir, manifest):
    entries = manifest.get('files') if isinstance(manifest, dict) else None
    if not isinstance(entries, list):
        return manifest
    by_staged = {
        os.path.normcase(os.path.abspath(str(entry.get('staged') or ''))): entry
        for entry in entries if isinstance(entry, dict) and entry.get('staged')
    }
    try:
        with open(_staging_patch_journal_path(staging_dir), 'r', encoding='utf-8') as journal:
            for line in journal:
                try:
                    record = json.loads(line)
                    target = by_staged.get(os.path.normcase(os.path.abspath(str(record.get('staged') or ''))))
                    patch = record.get('patch')
                    if target is not None and isinstance(patch, dict):
                        patch_staged_entry_fields(target, patch)
                except (TypeError, ValueError, json.JSONDecodeError):
                    continue
    except OSError:
        pass
    return manifest


def journal_staged_entry(staged_import, entry, patch):
    """Persist one small entry patch without rewriting the full manifest."""
    patch_staged_entry_fields(entry, patch)
    staging_dir = staged_import['stagingDir']
    os.makedirs(staging_dir, exist_ok=True)
    record = {'staged': str(entry.get('staged') or ''), 'patch': patch}
    with open(_staging_patch_journal_path(staging_dir), 'a', encoding='utf-8') as journal:
        journal.write(json.dumps(record, ensure_ascii=False, separators=(',', ':')) + '\n')
        journal.flush()
        os.fsync(journal.fileno())


def compact_staging_patch_journal(staged_import):
    journal_path = _staging_patch_journal_path(staged_import['stagingDir'])
    if not os.path.exists(journal_path):
        return
    checkpoint_staged_import(staged_import)
    try:
        os.remove(journal_path)
    except OSError:
        pass


def _write_staging_manifest(staging_dir, payload):
    os.makedirs(staging_dir, exist_ok=True)
    manifest_path = _staging_manifest_path(staging_dir)
    temporary_path = f'{manifest_path}.tmp-{os.getpid()}'
    with open(temporary_path, 'w', encoding='utf-8') as manifest_file:
        json.dump(payload, manifest_file, ensure_ascii=False, indent=2)
        manifest_file.flush()
        os.fsync(manifest_file.fileno())
    os.replace(temporary_path, manifest_path)


def _import_graph_receipt_path(staging_dir):
    return os.path.join(staging_dir, IMPORT_GRAPH_RECEIPT_NAME)


def write_import_graph_receipt(staging_dir, import_session, manifests):
    """Persist the authoritative graph handoff before reporting import success."""
    session_id = str(import_session or '').strip()
    if not session_id:
        raise ValueError('import_session_required: import session is required before media is moved')
    normalized = list(manifests or [])
    if not normalized or any(not isinstance(item, dict) or item.get('schemaVersion') != 2 or item.get('importSessionId') != session_id for item in normalized):
        raise ValueError('import_receipt_invalid: receipt manifests must use schema version 2 and the active session')
    receipt_manifests = []
    manifest_identities = []
    for index, item in enumerate(normalized):
        manifest_id = str(item.get('manifestId') or IMPORT_MANIFEST_IDENTITIES.get(id(item)) or hashlib.sha256(
            f'{session_id}\0{index}\0{json.dumps(item, sort_keys=True, ensure_ascii=False)}'.encode('utf-8')
        ).hexdigest())
        enriched = dict(item)
        enriched['manifestId'] = manifest_id
        receipt_manifests.append(enriched)
        manifest_identities.append(manifest_id)
    payload = {
        'receiptVersion': 1,
        'importSessionId': session_id,
        'manifests': receipt_manifests,
        'manifestIdentities': manifest_identities,
        'createdAt': int(time.time() * 1000),
    }
    os.makedirs(staging_dir, exist_ok=True)
    receipt_path = _import_graph_receipt_path(staging_dir)
    temporary_path = f'{receipt_path}.tmp-{os.getpid()}'
    with open(temporary_path, 'w', encoding='utf-8') as receipt_file:
        json.dump(payload, receipt_file, ensure_ascii=False, indent=2)
        receipt_file.flush()
        os.fsync(receipt_file.fileno())
    os.replace(temporary_path, receipt_path)
    return receipt_path


def load_import_graph_receipt(staging_dir):
    try:
        with open(_import_graph_receipt_path(staging_dir), 'r', encoding='utf-8') as receipt_file:
            payload = json.load(receipt_file)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get('receiptVersion') != 1 or not str(payload.get('importSessionId') or '').strip() or not isinstance(payload.get('manifests'), list):
        return None
    return payload


def load_staged_import(dest_path, import_session=''):
    staging_dir = get_import_staging_dir(dest_path, import_session)
    manifest_path = _staging_manifest_path(staging_dir)
    try:
        with open(manifest_path, 'r', encoding='utf-8') as manifest_file:
            manifest = json.load(manifest_file)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    manifest = _replay_staging_patch_journal(staging_dir, manifest)
    entries = manifest.get('files') if isinstance(manifest, dict) else None
    if not isinstance(entries, list) or not entries:
        return None
    normalized_staging = os.path.realpath(os.path.abspath(staging_dir))
    normalized_destination_root = os.path.realpath(os.path.abspath(dest_path))
    originals = []
    local_files = []
    normalized_entries = []
    timed_files = []
    has_complete_capture_times = True
    total_bytes = 0
    for entry in entries:
        if not isinstance(entry, dict):
            return None
        raw_source_path = str(entry.get('source') or '')
        raw_staged_path = str(entry.get('staged') or '')
        if not raw_source_path or not raw_staged_path:
            return None
        source_path = os.path.abspath(raw_source_path)
        staged_path = os.path.abspath(raw_staged_path)
        expected_size = int(entry.get('size') or 0)
        committed_path = os.path.abspath(str(entry.get('committedDestination') or entry.get('pendingDestination') or '')) if entry.get('committedDestination') or entry.get('pendingDestination') else ''
        output_paths = [os.path.abspath(str(value)) for value in entry.get('outputPaths', []) if value]
        try:
            inside_staging = _real_path_inside(normalized_staging, staged_path)
            committed_inside_destination = not committed_path or _real_path_inside(normalized_destination_root, committed_path)
            outputs_inside_destination = all(_real_path_inside(normalized_destination_root, value) for value in output_paths)
        except ValueError:
            inside_staging = False
            committed_inside_destination = False
            outputs_inside_destination = False
        staged_valid = inside_staging and _regular_file_without_links(staged_path, normalized_staging) and os.path.getsize(staged_path) == expected_size
        committed_valid = committed_inside_destination and committed_path and _entry_matches_imported_content(entry, committed_path, expected_size)
        outputs_valid = outputs_inside_destination and output_paths and all(_regular_file_without_links(value, normalized_destination_root, nonempty=True) for value in output_paths)
        if expected_size < 0 or not (staged_valid or committed_valid or outputs_valid):
            return None
        local_path = output_paths[0] if outputs_valid else committed_path if committed_valid else staged_path
        normalized_entry = dict(entry)
        normalized_entry.update({'source': source_path, 'staged': staged_path, 'size': expected_size, 'localPath': local_path})
        if committed_valid and not normalized_entry.get('committedDestination'):
            normalized_entry['committedDestination'] = committed_path
        elif not committed_valid:
            normalized_entry.pop('committedDestination', None)
        if not outputs_valid:
            normalized_entry.pop('outputPaths', None)
        originals.append(source_path)
        local_files.append(local_path)
        normalized_entries.append(normalized_entry)
        capture_timestamp = entry.get('captureTimestamp')
        if isinstance(capture_timestamp, (int, float)) and capture_timestamp > 0:
            timed_files.append((local_path, float(capture_timestamp)))
        else:
            has_complete_capture_times = False
        total_bytes += expected_size
    return {
        'stagingDir': staging_dir,
        'baseSource': str(manifest.get('baseSource') or ''),
        'originalFiles': originals,
        'stagedFiles': local_files,
        'entries': normalized_entries,
        'timedFiles': timed_files if has_complete_capture_times else [],
        'totalBytes': total_bytes,
        'dateFilter': str(manifest.get('dateFilter') or 'all'),
        'sourceFileCount': int(manifest.get('sourceFileCount') or len(originals)),
        'sourceVolumeIdentity': str(manifest.get('sourceVolumeIdentity') or ''),
        'manifestVersion': int(manifest.get('version') or 0),
    }


def save_staged_capture_times(staged_import, timed_files):
    """Persist metadata extracted from local copies so confirmation never probes it twice."""
    staging_dir = staged_import['stagingDir']
    manifest_path = _staging_manifest_path(staging_dir)
    with open(manifest_path, 'r', encoding='utf-8') as manifest_file:
        manifest = json.load(manifest_file)
    capture_times = {
        os.path.normcase(os.path.abspath(file_path)): float(timestamp)
        for file_path, timestamp in timed_files
        if timestamp is not None and timestamp > 0
    }
    entries = manifest.get('files') if isinstance(manifest, dict) else None
    if not isinstance(entries, list) or len(capture_times) != len(entries):
        raise IOError('无法保存完整的拍摄时间缓存')
    for entry in entries:
        candidates = [entry.get('staged'), entry.get('committedDestination'), entry.get('pendingDestination'), *(entry.get('outputPaths') or [])]
        matching_path = next((os.path.normcase(os.path.abspath(str(value))) for value in candidates if value and os.path.normcase(os.path.abspath(str(value))) in capture_times), '')
        if not matching_path:
            raise IOError('拍摄时间缓存与暂存文件不一致')
        entry['captureTimestamp'] = capture_times[matching_path]
    _write_staging_manifest(staging_dir, manifest)
    for entry in staged_import.get('entries') or []:
        candidates = [entry.get('staged'), entry.get('committedDestination'), entry.get('pendingDestination'), *(entry.get('outputPaths') or [])]
        matching_path = next((
            os.path.normcase(os.path.abspath(str(value)))
            for value in candidates
            if value and os.path.normcase(os.path.abspath(str(value))) in capture_times
        ), '')
        if matching_path:
            entry['captureTimestamp'] = capture_times[matching_path]
    staged_import['timedFiles'] = [
        (file_path, capture_times[os.path.normcase(os.path.abspath(file_path))])
        for file_path in staged_import['stagedFiles']
    ]


def patch_staged_entry_fields(target, patch):
    """Apply staging state changes directly to one already-resolved entry."""
    for key, value in patch.items():
        if value is None:
            target.pop(key, None)
        else:
            target[key] = value
    return target


def patch_staged_entry(staged_import, staged_path, patch):
    """Resolve and update one in-memory staging entry without a manifest rewrite."""
    normalized_staged = os.path.normcase(os.path.abspath(staged_path))
    target = next((
        entry for entry in staged_import.get('entries') or []
        if os.path.normcase(os.path.abspath(str(entry.get('staged') or ''))) == normalized_staged
    ), None)
    if target is None:
        raise IOError(f'暂存清单中找不到文件：{os.path.basename(staged_path)}')
    return patch_staged_entry_fields(target, patch)


def checkpoint_staged_import(staged_import):
    """Atomically persist the current in-memory entries in one durable checkpoint."""
    staging_dir = staged_import['stagingDir']
    manifest_path = _staging_manifest_path(staging_dir)
    with open(manifest_path, 'r', encoding='utf-8') as manifest_file:
        manifest = json.load(manifest_file)
    if not isinstance(manifest, dict) or not isinstance(manifest.get('files'), list):
        raise IOError('暂存清单格式无效')
    manifest['files'] = [
        {key: value for key, value in entry.items() if key != 'localPath'}
        for entry in staged_import.get('entries') or []
    ]
    _write_staging_manifest(staging_dir, manifest)


def update_staged_entry(staged_import, staged_path, patch):
    """Durably update one entry for infrequent post-processing operations."""
    patch_staged_entry(staged_import, staged_path, patch)
    checkpoint_staged_import(staged_import)


def staged_entry_for_local_path(staged_import, local_path):
    normalized_local = os.path.normcase(os.path.abspath(local_path))
    for entry in staged_import.get('entries') or []:
        candidates = [entry.get('localPath'), entry.get('staged'), entry.get('committedDestination'), entry.get('pendingDestination'), *(entry.get('outputPaths') or [])]
        if any(value and os.path.normcase(os.path.abspath(str(value))) == normalized_local for value in candidates):
            return entry
    return None


def post_process_record(entry, kind):
    records = entry.get('postProcesses') if isinstance(entry.get('postProcesses'), dict) else {}
    record = records.get(kind)
    if isinstance(record, dict):
        return record
    legacy = entry.get('postProcess')
    return legacy if isinstance(legacy, dict) and legacy.get('kind') == kind else None


def checkpoint_post_process(staged_import, entry, kind, record=None):
    records = dict(entry.get('postProcesses') or {})
    if record is None:
        records.pop(kind, None)
    else:
        records[kind] = record
    update_staged_entry(staged_import, entry['staged'], {
        'postProcesses': records or None,
        'postProcess': None,
    })


def entry_for_post_process(staged_import, input_path, kind, state=None):
    normalized = os.path.normcase(os.path.realpath(os.path.abspath(input_path)))
    for entry in staged_import.get('entries') or []:
        record = post_process_record(entry, kind)
        if not record or state is not None and record.get('state') != state:
            continue
        recorded_input = str(record.get('inputPath') or '')
        if recorded_input and os.path.normcase(os.path.realpath(os.path.abspath(recorded_input))) == normalized:
            return entry
    return None


def _validated_derived_outputs(paths, target_root, input_path='', image_output=False):
    expected = JPG_EXTENSIONS if image_output else VIDEO_OUTPUT_EXTENSIONS
    outputs = validate_tool_output_paths(
        paths, target_root, input_path,
        require_decodable=not image_output, expected_extensions=expected,
    )
    if image_output:
        for output in outputs:
            try:
                with Image.open(output) as image:
                    image.verify()
            except Exception as error:
                raise ValueError(f'派生产物不可解码：{os.path.basename(output)}') from error
    return outputs


def recover_post_process(staged_import, entry, kind, target_root, image_output=False):
    """Reuse verified committed output, adopt an exact pending output, or clear stale state."""
    record = post_process_record(entry, kind)
    if not record:
        return []
    input_path = str(record.get('inputPath') or entry.get('localPath') or '')
    outputs = list(record.get('outputPaths') or [])
    if record.get('state') == 'committed' and outputs:
        try:
            return _validated_derived_outputs(outputs, target_root, input_path, image_output)
        except ValueError:
            checkpoint_post_process(staged_import, entry, kind, None)
            return []
    pending_output = str(record.get('pendingOutput') or '')
    if record.get('state') == 'pending' and pending_output:
        try:
            outputs = _validated_derived_outputs([pending_output], target_root, input_path, image_output)
            checkpoint_post_process(staged_import, entry, kind, {
                'kind': kind, 'state': 'committed', 'inputPath': input_path, 'outputPaths': outputs,
            })
            return outputs
        except ValueError:
            pass
    if record.get('state') == 'pending' and not pending_output:
        output_directory = str(record.get('outputDirectory') or '')
        baseline = {os.path.normcase(os.path.realpath(value)) for value in record.get('baselineOutputs') or []}
        expected_stem = str(record.get('expectedStem') or '').casefold()
        try:
            candidates = [
                os.path.join(output_directory, name)
                for name in os.listdir(output_directory)
                if os.path.normcase(os.path.realpath(os.path.join(output_directory, name))) not in baseline
                and (not expected_stem or Path(name).stem.casefold().startswith(expected_stem))
            ]
            if len(candidates) == 1:
                outputs = _validated_derived_outputs(candidates, target_root, input_path, image_output)
                checkpoint_post_process(staged_import, entry, kind, {
                    'kind': kind, 'state': 'committed', 'inputPath': input_path, 'outputPaths': outputs,
                })
                return outputs
        except (OSError, ValueError):
            pass
    checkpoint_post_process(staged_import, entry, kind, None)
    return []


def staged_files_with_capture_times(staged_import):
    cached = staged_import.get('timedFiles') or []
    if len(cached) == len(staged_import.get('stagedFiles') or []):
        return cached
    timed_files = capture_times_for_files(staged_import['stagedFiles'])
    save_staged_capture_times(staged_import, timed_files)
    return timed_files


def _unique_staged_path(staging_dir, source_path, used_paths):
    file_name = os.path.basename(source_path)
    stem, extension = os.path.splitext(file_name)
    candidate = os.path.join(staging_dir, file_name)
    normalized = os.path.normcase(os.path.abspath(candidate))
    if normalized not in used_paths and not os.path.exists(candidate):
        used_paths.add(normalized)
        return candidate
    digest = hashlib.sha256(os.path.abspath(source_path).encode('utf-8', errors='surrogatepass')).hexdigest()[:8]
    index = 0
    while True:
        suffix = f'_{digest}' if index == 0 else f'_{digest}_{index}'
        candidate = os.path.join(staging_dir, f'{stem}{suffix}{extension}')
        normalized = os.path.normcase(os.path.abspath(candidate))
        if normalized not in used_paths and not os.path.exists(candidate):
            used_paths.add(normalized)
            return candidate
        index += 1


def _resumable_staging_entries(staging_dir, source_volume_identity=''):
    """Return safe prior manifest entries so a reconnected card can resume."""
    manifest_path = _staging_manifest_path(staging_dir)
    try:
        with open(manifest_path, 'r', encoding='utf-8') as manifest_file:
            manifest = json.load(manifest_file)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return {}
    raw_entries = manifest.get('files') if isinstance(manifest, dict) else None
    if not isinstance(raw_entries, list):
        return {}
    if int(manifest.get('version') or 0) < 2 and raw_entries:
        raise SourceIdentityMismatch('旧版暂存缺少 SD 卡身份，旧暂存不会用于当前卡。')
    stored_volume_identity = str(manifest.get('sourceVolumeIdentity') or '')
    if stored_volume_identity and source_volume_identity and stored_volume_identity != source_volume_identity:
        raise SourceIdentityMismatch('检测到 SD 卡已经更换，旧暂存不会用于当前卡。')
    normalized_staging = os.path.realpath(os.path.abspath(staging_dir))
    entries = {}
    for entry in raw_entries:
        if not isinstance(entry, dict):
            continue
        source_path = os.path.abspath(str(entry.get('source') or ''))
        staged_path = os.path.abspath(str(entry.get('staged') or ''))
        try:
            expected_size = int(entry.get('size'))
            inside_staging = _real_path_inside(normalized_staging, staged_path)
        except (TypeError, ValueError, OSError):
            continue
        if not source_path or not staged_path or not inside_staging or expected_size < 0:
            continue
        entries[os.path.normcase(source_path)] = {
            'source': source_path,
            'staged': staged_path,
            'size': expected_size,
            **({'sourceMtimeNs': entry['sourceMtimeNs']} if isinstance(entry.get('sourceMtimeNs'), int) else {}),
            **({'sourceRealPath': entry['sourceRealPath']} if entry.get('sourceRealPath') else {}),
            **({'sourceFingerprint': entry['sourceFingerprint']} if entry.get('sourceFingerprint') else {}),
            **({'copyDigest': entry['copyDigest']} if isinstance(entry.get('copyDigest'), dict) else {}),
            **({'copyVerification': entry['copyVerification']} if isinstance(entry.get('copyVerification'), dict) else {}),
            **({'captureTimestamp': entry['captureTimestamp']} if isinstance(entry.get('captureTimestamp'), (int, float)) and entry['captureTimestamp'] > 0 else {}),
        }
    return entries


def backfill_missing_copy_digests(staged_import):
    """Safely recopy digestless staged files once when their original source is online."""
    failed = []
    changed = False
    staging_dir = staged_import['stagingDir']
    for entry in staged_import.get('entries') or []:
        digest = entry.get('copyDigest')
        if isinstance(digest, dict) and digest.get('chunks'):
            continue
        source = str(entry.get('source') or '')
        staged = str(entry.get('staged') or '')
        if _entry_current_source_status(entry) != 'match' \
                or not _regular_file_without_links(staged, staging_dir, nonempty=int(entry.get('size') or 0) > 0):
            failed.append(source)
            continue
        temporary = f'{staged}.digest-backfill-{os.getpid()}'
        try:
            if os.path.exists(temporary):
                os.remove(temporary)
            copy_digest = safe_chunk_copy(source, temporary, collect_digest=True)
            if not copy_digest or os.path.getsize(temporary) != int(entry.get('size') or -1):
                raise IOError('摘要补录复制不完整')
            os.replace(temporary, staged)
            entry['copyDigest'] = copy_digest
            entry.pop('copyVerification', None)
            entry['localPath'] = staged
            changed = True
        except (ImportCancelled, KeyboardInterrupt, SystemExit):
            try:
                os.remove(temporary)
            except OSError:
                pass
            if changed:
                checkpoint_staged_import(staged_import)
            raise
        except Exception:
            try:
                os.remove(temporary)
            except OSError:
                pass
            failed.append(source)
    if changed:
        checkpoint_staged_import(staged_import)
    return failed


def stage_media_to_safety_temp(sd_path, dest_path, direct_source=False, source_paths=None, import_session='', progress_end=70, date_filter='all', verify_copy=False):
    cleanup_expired_import_staging(dest_path)
    existing = load_staged_import(dest_path, import_session)
    if existing:
        existing['sourceValidated'] = _validate_staged_source_identity(existing)
        unverified_sources = backfill_missing_copy_digests(existing) if verify_copy else []
        existing['copyVerified'] = verify_staged_import_for_source_cleanup(existing) if verify_copy and not unverified_sources else False
        if verify_copy and unverified_sources:
            existing['sourceCleanupBlockedReason'] = 'verification-unavailable'
            emit(
                'warning',
                '部分已有暂存无法验证所以未清源；将继续使用本地副本完成导入。',
                data={
                    'code': 'source_cleanup_unverified',
                    'sourceCleanupAllowed': False,
                    'unverifiedFiles': [os.path.basename(value) for value in unverified_sources],
                },
            )
        elif verify_copy and not existing['copyVerified']:
            raise IOError('导入副本完整读回校验失败；源文件已保留')
        log_progress(
            '素材已导入，准备读取本地副本...',
            progress_end,
            {'bytesCopied': existing['totalBytes'], 'totalBytes': existing['totalBytes'], 'filesCopied': len(existing['stagedFiles']), 'totalFiles': len(existing['stagedFiles']), 'stagingComplete': True},
        )
        return existing

    log_progress('正在扫描导入来源...', 0, {'bytesCopied': 0, 'totalBytes': 0, 'filesCopied': 0, 'totalFiles': 0})
    base_source, original_files = scan_import_media(sd_path, direct_source, source_paths)
    source_volume_identity = _source_volume_identity(base_source)
    source_file_count = len(original_files)
    normalized_date_filter = date_filter if date_filter in IMPORT_DATE_FILTERS else 'all'
    capture_times = {}
    copy_progress_start = 5
    if normalized_date_filter != 'all' and original_files:
        copy_progress_start = 12
        log_progress('正在按拍摄日期筛选 SD 卡素材...', 1, {'filesProcessed': 0, 'totalFiles': source_file_count, 'matchedFiles': 0})

        def publish_date_filter_progress(file_index, file_count, file_path, matched_count):
            log_progress(
                f'正在读取拍摄时间：{os.path.basename(file_path)}（{file_index}/{file_count}）',
                1 + int((file_index / max(1, file_count)) * 9),
                {'filesProcessed': file_index, 'totalFiles': file_count, 'matchedFiles': matched_count, 'fileName': os.path.basename(file_path)},
            )

        original_files, capture_times = filter_media_by_capture_date(
            original_files,
            normalized_date_filter,
            on_progress=publish_date_filter_progress,
        )
        log_progress(
            f'日期筛选完成：扫描 {source_file_count} 个文件，符合条件 {len(original_files)} 个。',
            10,
            {'filesProcessed': source_file_count, 'totalFiles': source_file_count, 'matchedFiles': len(original_files)},
        )
    if not original_files:
        return {
            'stagingDir': get_import_staging_dir(dest_path, import_session),
            'baseSource': base_source,
            'originalFiles': [],
            'stagedFiles': [],
            'totalBytes': 0,
            'timedFiles': [],
            'dateFilter': normalized_date_filter,
            'sourceFileCount': source_file_count,
            'sourceVolumeIdentity': source_volume_identity,
            'manifestVersion': 2,
            'sourceValidated': bool(base_source and os.path.exists(base_source)),
            'entries': [],
        }

    staging_dir = get_import_staging_dir(dest_path, import_session)
    os.makedirs(staging_dir, exist_ok=True)
    prior_entries = _resumable_staging_entries(staging_dir, source_volume_identity)
    used_paths = set()
    entries = []
    for source_path in original_files:
        ensure_not_cancelled()
        source_path = os.path.abspath(source_path)
        source_metadata = _source_entry_metadata(source_path)
        source_size = source_metadata['size']
        prior_entry = prior_entries.get(os.path.normcase(source_path))
        if prior_entry and prior_entry['size'] == source_size and _entry_matches_current_source(prior_entry):
            staged_path = prior_entry['staged']
            used_paths.add(os.path.normcase(os.path.abspath(staged_path)))
        else:
            staged_path = _unique_staged_path(staging_dir, source_path, used_paths)
        entry = {'source': source_path, 'staged': staged_path, **source_metadata}
        capture_timestamp = capture_times.get(os.path.normcase(source_path))
        if capture_timestamp is None and prior_entry:
            capture_timestamp = prior_entry.get('captureTimestamp')
        if capture_timestamp is not None:
            entry['captureTimestamp'] = capture_timestamp
        entries.append(entry)
    manifest_identity = hashlib.sha256(
        f'{os.path.normcase(os.path.realpath(dest_path))}\0{import_session or "default"}'.encode('utf-8', errors='surrogatepass')
    ).hexdigest()
    manifest = {'version': 2, 'manifestIdentity': manifest_identity, 'baseSource': base_source, 'sourceVolumeIdentity': source_volume_identity, 'dateFilter': normalized_date_filter, 'sourceFileCount': source_file_count, 'files': entries}
    _write_staging_manifest(staging_dir, manifest)

    total_bytes = sum(entry['size'] for entry in entries)
    completed_entries = set()
    completed_bytes = 0
    for entry in entries:
        staged_path = entry['staged']
        try:
            has_digest = isinstance(entry.get('copyDigest'), dict) and bool(entry['copyDigest'].get('chunks'))
            if _regular_file_without_links(staged_path, staging_dir) and os.path.getsize(staged_path) == entry['size'] and (has_digest or not verify_copy):
                completed_entries.add(os.path.normcase(os.path.abspath(staged_path)))
                completed_bytes += entry['size']
            elif os.path.exists(staged_path):
                os.remove(staged_path)
        except OSError:
            try:
                os.remove(staged_path)
            except OSError:
                pass
    transfer_started_at = time.monotonic()
    last_progress_at = 0.0
    completed_file_count = len(completed_entries)
    ensure_import_disk_space(dest_path, total_bytes - completed_bytes, '导入暂存')
    log_progress('扫描完成，正在导入...', copy_progress_start + int((completed_bytes / max(1, total_bytes)) * max(0, progress_end - copy_progress_start)), {'bytesCopied': completed_bytes, 'totalBytes': total_bytes, 'filesCopied': completed_file_count, 'totalFiles': len(entries), 'resumedFiles': completed_file_count})
    for file_index, entry in enumerate(entries, start=1):
        ensure_not_cancelled()
        source_path = entry['source']
        staged_path = entry['staged']
        if os.path.normcase(os.path.abspath(staged_path)) in completed_entries:
            continue

        def publish_staging_progress(current_file_bytes, force=False):
            nonlocal last_progress_at
            now = time.monotonic()
            bytes_copied = min(total_bytes, completed_bytes + current_file_bytes)
            if not force and now - last_progress_at < 0.1 and bytes_copied < total_bytes:
                return
            last_progress_at = now
            elapsed = max(0.001, now - transfer_started_at)
            log_progress(
                f'正在导入：{os.path.basename(source_path)}（{file_index}/{len(entries)}）',
                copy_progress_start + int((bytes_copied / max(1, total_bytes)) * max(0, progress_end - copy_progress_start)),
                {
                    'bytesCopied': bytes_copied,
                    'totalBytes': total_bytes,
                    'bytesPerSecond': bytes_copied / elapsed,
                    'filesCopied': completed_file_count + (1 if force else 0),
                    'totalFiles': len(entries),
                },
            )

        copy_digest = safe_chunk_copy(
            source_path,
            staged_path,
            on_progress=publish_staging_progress,
            collect_digest=verify_copy,
        )
        if copy_digest:
            entry['copyDigest'] = copy_digest
        else:
            entry.pop('copyDigest', None)
        entry.pop('copyVerification', None)
        if os.path.getsize(staged_path) != entry['size']:
            raise IOError(f'导入校验失败：{os.path.basename(source_path)}')
        completed_bytes += entry['size']
        publish_staging_progress(0, True)
        completed_file_count += 1

    # One normal-path manifest sync records all copy-loop digests. Interrupted
    # sessions without a recorded digest conservatively recopy that file.
    _write_staging_manifest(staging_dir, manifest)
    staged_import = {
        'stagingDir': staging_dir, 'baseSource': base_source,
        'originalFiles': [entry['source'] for entry in entries],
        'stagedFiles': [entry['staged'] for entry in entries], 'entries': entries,
        'totalBytes': total_bytes, 'sourceVolumeIdentity': source_volume_identity,
        'manifestVersion': 2,
    }
    copy_verified = verify_staged_import_for_source_cleanup(staged_import) if verify_copy else False
    if verify_copy and not copy_verified:
        raise IOError('导入副本完整读回校验失败；源文件已保留')

    log_progress(
        '素材导入完成，后续处理将使用本地副本。',
        progress_end,
        {'bytesCopied': total_bytes, 'totalBytes': total_bytes, 'filesCopied': len(entries), 'totalFiles': len(entries), 'stagingComplete': True},
    )
    return {
        'stagingDir': staging_dir,
        'baseSource': base_source,
        'originalFiles': [entry['source'] for entry in entries],
        'stagedFiles': [entry['staged'] for entry in entries],
        'timedFiles': [
            (entry['staged'], float(entry['captureTimestamp']))
            for entry in entries
            if isinstance(entry.get('captureTimestamp'), (int, float)) and entry['captureTimestamp'] > 0
        ],
        'totalBytes': total_bytes,
        'dateFilter': normalized_date_filter,
        'sourceFileCount': source_file_count,
        'sourceVolumeIdentity': source_volume_identity,
        'manifestVersion': 2,
        'sourceValidated': True,
        'copyVerified': copy_verified,
        'entries': entries,
    }


def no_staged_media_message(staged_import, direct_source=False):
    date_filter = staged_import.get('dateFilter', 'all')
    source_file_count = int(staged_import.get('sourceFileCount') or 0)
    if source_file_count and date_filter != 'all':
        date_label = '今天' if date_filter == 'today' else '今天或昨天'
        return f'已扫描 {source_file_count} 个媒体文件，没有找到拍摄日期为{date_label}的素材。'
    base_source = staged_import.get('baseSource', '')
    return f"在 {base_source} 中没有找到媒体文件" if direct_source else f"在 {base_source} 的 DCIM/PRIVATE 目录下没有找到媒体文件"


def source_files_are_safe_to_delete(staged_import):
    entries = staged_import.get('entries') or []
    if not entries:
        return all(os.path.isfile(path) for path in staged_import.get('originalFiles') or [])
    try:
        return all(entry.get('sourceRealPath') for entry in entries) \
            and bool(staged_import.get('copyVerified')) \
            and _validate_staged_source_identity(staged_import)
    except SourceIdentityMismatch:
        return False


def cleanup_import_staging(staging_dir):
    if os.path.isdir(staging_dir):
        shutil.rmtree(staging_dir)
    staging_root = os.path.dirname(staging_dir)
    try:
        os.rmdir(staging_root)
    except OSError:
        pass

ADAPTIVE_GAP_MIN_SECONDS = 30 * 60
ADAPTIVE_GAP_MIN_RATIO = 5.0
ADAPTIVE_GAP_MIN_SEGMENT_FILES = 3
ADAPTIVE_GAP_HARD_HOURS = 4.0


def _adaptive_capture_break_indexes(ordered, split_threshold_hours=2.0):
    """Return indexes that begin a new shoot based on this batch's gap pattern."""
    if len(ordered) < 2:
        return set()

    gaps = [(index, max(0.0, ordered[index][1] - ordered[index - 1][1])) for index in range(1, len(ordered))]
    hard_gap_seconds = max(ADAPTIVE_GAP_HARD_HOURS, float(split_threshold_hours or 0)) * 3600
    hard_breaks = {index for index, gap in gaps if gap >= hard_gap_seconds}

    log_gaps = [math.log(max(1.0, gap)) for _index, gap in gaps]
    adaptive_candidates = []
    if len(log_gaps) >= 2 and max(log_gaps) > min(log_gaps):
        centers = [min(log_gaps), max(log_gaps)]
        for _iteration in range(20):
            clusters = [[], []]
            for value in log_gaps:
                cluster_index = 0 if abs(value - centers[0]) <= abs(value - centers[1]) else 1
                clusters[cluster_index].append(value)
            if not clusters[0] or not clusters[1]:
                break
            next_centers = [sum(cluster) / len(cluster) for cluster in clusters]
            if max(abs(next_centers[index] - centers[index]) for index in (0, 1)) < 1e-6:
                centers = next_centers
                break
            centers = next_centers

        low_center, high_center = sorted(centers)
        normal_gap_seconds = math.exp(low_center)
        center_ratio = math.exp(high_center - low_center)
        adaptive_threshold = max(ADAPTIVE_GAP_MIN_SECONDS, math.exp((low_center + high_center) / 2))
        if center_ratio >= ADAPTIVE_GAP_MIN_RATIO:
            adaptive_candidates = [
                (index, gap)
                for index, gap in gaps
                if gap >= adaptive_threshold and gap >= normal_gap_seconds * ADAPTIVE_GAP_MIN_RATIO
            ]

    # Hard gaps always split. Adaptive gaps are accepted largest-first only when
    # both resulting shoots contain enough material to avoid isolated-file groups.
    breaks = set(hard_breaks)
    for index, _gap in sorted(adaptive_candidates, key=lambda item: item[1], reverse=True):
        if index in breaks:
            continue
        surrounding = [0, *sorted(breaks), len(ordered)]
        left = max(boundary for boundary in surrounding if boundary < index)
        right = min(boundary for boundary in surrounding if boundary > index)
        if index - left >= ADAPTIVE_GAP_MIN_SEGMENT_FILES and right - index >= ADAPTIVE_GAP_MIN_SEGMENT_FILES:
            breaks.add(index)
    return breaks


def _build_capture_groups_from_timed_files(files_with_time, split_threshold_hours=2.0):
    days = {}
    for file_path, timestamp in files_with_time:
        date_key = datetime.datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d')
        days.setdefault(date_key, []).append((file_path, timestamp))

    groups = []
    for date_key in sorted(days):
        ordered = sorted(days[date_key], key=lambda item: item[1])
        break_indexes = _adaptive_capture_break_indexes(ordered, split_threshold_hours)
        day_groups = []
        start_index = 0
        for break_index in sorted(break_indexes):
            day_groups.append(ordered[start_index:break_index])
            start_index = break_index
        day_groups.append(ordered[start_index:])
        for index, group in enumerate(day_groups, start=1):
            groups.append({
                'id': f'{date_key}:{index}',
                'date': date_key,
                'index': index,
                'files': group,
                'count': len(group),
                'startTime': datetime.datetime.fromtimestamp(group[0][1]).strftime('%H:%M'),
                'endTime': datetime.datetime.fromtimestamp(group[-1][1]).strftime('%H:%M'),
            })
    return groups


def build_capture_groups(files, split_threshold_hours=2.0, on_progress=None):
    """Group each capture day and identify statistically distinct shooting gaps."""
    days = {}
    timed_files = capture_times_for_files(files)
    total_files = len(timed_files)
    for file_index, (file_path, timestamp) in enumerate(timed_files, start=1):
        ensure_not_cancelled()
        if not os.path.isfile(file_path):
            raise FileNotFoundError(f'媒体文件已不可用：{file_path}')
        if on_progress:
            on_progress(file_index, total_files, file_path)
        if timestamp is None or timestamp <= 0:
            raise OSError(f'媒体文件的拍摄时间不可用：{file_path}')
        date_key = datetime.datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d')
        days.setdefault(date_key, []).append((file_path, timestamp))
    return _build_capture_groups_from_timed_files(
        [item for date_items in days.values() for item in date_items],
        split_threshold_hours,
    )

def stage_plan_import(sd_path, dest_path, projects_json, import_type='work', split_threshold_hours=2.0, direct_source=False, source_paths=None, import_session='', date_filter='all', delete_source=False):
    if not dest_path or not os.path.isdir(dest_path):
        log_error('导入目标不存在，请重新选择工作目录。')
        return
    try:
        staged_import = stage_media_to_safety_temp(sd_path, dest_path, direct_source, source_paths, import_session, progress_end=75, date_filter=date_filter, verify_copy=delete_source)
    except OSError as error:
        log_error(f'导入失败，源设备可能已断开，请重新连接后重试：{error}')
        return
    base_sd = staged_import['baseSource']
    files = staged_import['stagedFiles']
    if not files:
        log_success(no_staged_media_message(staged_import, direct_source), {'projectNames': [], 'importedCount': 0, 'skipped': True, 'skipReason': 'no-media'})
        return
    try:
        projects = json.loads(projects_json or '[]')
    except (TypeError, ValueError, json.JSONDecodeError):
        projects = []
    total_files = len(files)
    log_progress("素材导入完成，正在从本地副本读取拍摄时间...", 75, {"filesProcessed": 0, "totalFiles": total_files})

    def publish_capture_time_progress(file_index, file_count, file_path):
        completed = file_index - 1
        percent = 75 + int((completed / max(1, file_count)) * 20)
        log_progress(
            f"正在读取本地副本拍摄时间：{os.path.basename(file_path)}（{file_index}/{file_count}）",
            percent,
            {"filesProcessed": completed, "totalFiles": file_count, "fileName": os.path.basename(file_path)},
        )

    try:
        groups = build_capture_groups(files, split_threshold_hours, publish_capture_time_progress)
        save_staged_capture_times(
            staged_import,
            [item for group in groups for item in group['files']],
        )
    except OSError as error:
        log_error(f"读取已导入的本地副本失败，请重试导入：{error}")
        return
    log_progress("拍摄时间读取完成，正在匹配目标项目...", 95, {"filesProcessed": total_files, "totalFiles": total_files})
    payload_groups = []
    automatic_routes = {}
    requires_choice = False
    for group in groups:
        ensure_not_cancelled()
        year, month, day = (int(part) for part in group['date'].split('-'))
        exact = [project for project in projects if project.get('projectDate', {}).get('year') == year and project.get('projectDate', {}).get('month') == month and project.get('projectDate', {}).get('day') == day]
        month_only = [project for project in projects if project.get('projectDate', {}).get('year') == year and project.get('projectDate', {}).get('month') == month and not project.get('projectDate', {}).get('day')]
        if len(exact) == 1:
            # Project paths include the mutable category directory. Keep the
            # stable catalog identity in the plan and let the renderer resolve
            # its current path immediately before committing staged files.
            automatic_routes[group['id']] = exact[0].get('id') or exact[0].get('path', '')
        else:
            requires_choice = True
        payload_groups.append({
            key: group[key] for key in ('id', 'date', 'index', 'count', 'startTime', 'endTime')
        } | {
            'exactProjectPaths': [project.get('path', '') for project in exact],
            'suggestedProjectPaths': [project.get('path', '') for project in (exact or month_only)],
            'exactProjectIds': [project.get('id', '') for project in exact if project.get('id')],
            'suggestedProjectIds': [project.get('id', '') for project in (exact or month_only) if project.get('id')],
        })
    ask_user(
        '检测到需要确认的项目归属' if requires_choice else '已按项目拍摄日期确定导入位置',
        {
            'kind': 'project_routing',
            'importType': import_type,
            'requiresChoice': requires_choice,
            'stagingComplete': True,
            'groups': payload_groups,
            'automaticRoutes': automatic_routes,
        },
    )

def unique_destination(directory, file_name):
    """Never overwrite an earlier card import or another folder's same name."""
    destination = os.path.join(directory, file_name)
    if not os.path.exists(destination):
        return destination
    stem, extension = os.path.splitext(file_name)
    index = 1
    while True:
        candidate = os.path.join(directory, f"{stem} ({index}){extension}")
        if not os.path.exists(candidate):
            return candidate
        index += 1


def reserve_unique_destination(directory, file_name, reserved_paths):
    """Reserve a collision-free destination across disk state and the current import plan."""
    stem, extension = os.path.splitext(file_name)
    index = 0
    while True:
        candidate_name = file_name if index == 0 else f"{stem} ({index}){extension}"
        candidate = os.path.abspath(os.path.join(directory, candidate_name))
        key = os.path.normcase(candidate)
        if key not in reserved_paths and not os.path.exists(candidate):
            reserved_paths.add(key)
            return candidate
        index += 1


def unique_broll_destination(directory, file_name, will_split=False):
    stem, extension = os.path.splitext(file_name)
    index = 0
    while True:
        candidate_name = file_name if index == 0 else f'{stem} ({index}){extension}'
        candidate = os.path.join(directory, candidate_name)
        split_prefix = os.path.splitext(candidate_name)[0] + '_part'
        has_split_collision = will_split and any(
            name.startswith(split_prefix) and name.lower().endswith(extension.lower())
            for name in os.listdir(directory)
        )
        if not os.path.exists(candidate) and not has_split_collision:
            return candidate
        index += 1

CLASSIFY_EXTENSION_MAP = {
    'jpg': ('.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.avif', '.heic', '.heif', '.hif'),
    'raw': ('.arw', '.cr2', '.cr3', '.dng', '.nef', '.orf', '.rwl', '.raf', '.3fr', '.fff'),
    'mov': ('.mp4', '.mov', '.avi', '.mpeg', '.mpg', '.mts', '.m2ts', '.crm'),
}


def classified_destination_directory(folder_path, file_name):
    lowered = file_name.lower()
    subfolder = next((name for name, extensions in CLASSIFY_EXTENSION_MAP.items() if lowered.endswith(extensions)), '')
    return os.path.join(folder_path, subfolder) if subfolder else folder_path


def build_import_graph_manifest(dest_path, target_folder, project_name, import_session,
                                imported_paths, generated_jpg_paths=None, generated_preview_paths=None):
    """Describe importer-owned artifact slots from files already handled by this session."""
    target_folder = os.path.abspath(target_folder)
    if not _safe_directory_target(dest_path, target_folder):
        raise ValueError('导入项目目标包含符号链接、junction 或越界路径')
    imported = {os.path.abspath(value) for value in (imported_paths or [])}
    generated_jpg = {os.path.abspath(value) for value in (generated_jpg_paths or [])}
    generated_preview = {os.path.abspath(value) for value in (generated_preview_paths or [])}
    session_id = str(import_session or '').strip()
    if not session_id:
        raise ValueError('import_session_required: import graph manifest requires a session')
    artifacts_by_path = {}
    display_names = {
        'raw': 'RAW', 'camera_jpg': 'JPG', 'generated_jpg': 'JPG',
        'mov': 'MOV', 'video_transcode': 'MOV_转码',
    }

    def add(file_path, media_kind, import_slot):
        directory = os.path.abspath(os.path.dirname(file_path))
        if not _safe_directory_target(target_folder, directory):
            raise ValueError(f'导入产物不属于目标项目：{os.path.basename(file_path)}')
        relative_path = os.path.relpath(directory, target_folder).replace(os.sep, '/')
        if relative_path in ('', '.'):
            raise ValueError(f'导入产物必须位于项目子目录：{os.path.basename(file_path)}')
        key = relative_path.casefold()
        current = artifacts_by_path.get(key)
        if current:
            if current['importSlot'] == 'camera_jpg' and import_slot == 'generated_jpg':
                return
            if current['importSlot'] != import_slot \
                    and not (current['importSlot'] == 'generated_jpg' and import_slot == 'camera_jpg'):
                raise ValueError(f'同一导入目录包含不兼容的产物语义：{relative_path}')
        artifacts_by_path[key] = {
            'relativePath': relative_path,
            'mediaKind': media_kind,
            'importSlot': import_slot,
            'displayName': display_names[import_slot],
        }

    for file_path in imported:
        lowered = file_path.lower()
        if lowered.endswith(CLASSIFY_EXTENSION_MAP['raw']):
            add(file_path, 'image', 'raw')
        elif lowered.endswith(CLASSIFY_EXTENSION_MAP['mov']):
            add(file_path, 'video', 'mov')
        else:
            add(file_path, 'image', 'camera_jpg')
    for file_path in generated_jpg:
        add(file_path, 'image', 'generated_jpg')
    for file_path in generated_preview:
        add(file_path, 'video', 'video_transcode')
    workspace_real = os.path.normcase(os.path.realpath(os.path.abspath(dest_path)))
    project_real = os.path.normcase(os.path.realpath(target_folder))
    try:
        project_identity = os.path.relpath(project_real, workspace_real).replace(os.sep, '/')
    except ValueError:
        project_identity = project_real
    manifest_id = hashlib.sha256(
        f'{session_id}\0{project_identity}'.encode('utf-8', errors='surrogatepass')
    ).hexdigest()
    payload = {
        'schemaVersion': 2,
        'manifestId': manifest_id,
        'projectName': project_name,
        'importSessionId': session_id,
        'artifacts': sorted(artifacts_by_path.values(), key=lambda item: item['relativePath'].casefold()),
    }
    IMPORT_MANIFEST_IDENTITIES[id(payload)] = manifest_id
    return payload


def classify_files_by_type(folder_path):
    """整理子文件夹"""
    moved_paths = {}
    for f in os.listdir(folder_path):
        src_path = os.path.join(folder_path, f)
        if not os.path.isfile(src_path) or f.startswith('.'): continue
        f_lower = f.lower()
        for sub, exts in CLASSIFY_EXTENSION_MAP.items():
            if f_lower.endswith(exts):
                sub_dir = os.path.join(folder_path, sub)
                os.makedirs(sub_dir, exist_ok=True)
                # 如果子目录已有同名文件，加时间戳
                dst_path = unique_destination(sub_dir, f)
                shutil.move(src_path, dst_path)
                moved_paths[src_path] = dst_path
                break
    return moved_paths


def find_missing_raw_jpg_candidates(target_folder, imported_paths):
    """Return RAW files from this import that do not have a same-stem JPG."""
    jpg_dir = os.path.join(target_folder, 'jpg')
    jpg_stems = set()
    if os.path.isdir(jpg_dir):
        jpg_stems = {
            os.path.splitext(name)[0].casefold()
            for name in os.listdir(jpg_dir)
            if os.path.isfile(os.path.join(jpg_dir, name)) and name.lower().endswith(JPG_EXTENSIONS)
        }
    candidates = []
    seen = set()
    for file_path in imported_paths:
        normalized = os.path.normcase(os.path.abspath(file_path))
        stem, extension = os.path.splitext(os.path.basename(file_path))
        if extension.lower() not in RAW_EXTENSIONS or stem.casefold() in jpg_stems or normalized in seen:
            continue
        seen.add(normalized)
        jpg_stems.add(stem.casefold())
        candidates.append(file_path)
    return candidates


def generate_raw_jpg(source_path, target_path, raw_decoder=None):
    """Create a JPG proxy from an embedded preview, with LibRaw as fallback."""
    try:
        image = _embedded_jpeg(source_path)
    except Exception as embedded_error:
        try:
            if raw_decoder is None:
                from raw_decoder import decode as raw_decoder
            raw_decoder(source_path, [{
                'sizeLabel': 'generated-jpg',
                'pixels': 0,
                'path': os.path.abspath(target_path),
            }])
            if not os.path.isfile(target_path):
                raise RuntimeError('LibRaw 解码完成但没有生成 JPG 文件')
            shutil.copystat(source_path, target_path)
            return
        except Exception as decoder_error:
            raise RuntimeError(
                f'无法读取内嵌预览（{embedded_error}），LibRaw 显影也失败（{decoder_error}）'
            ) from decoder_error
    temporary = f"{target_path}.tmp-{os.getpid()}"
    try:
        rgb_image = image if image.mode == 'RGB' else image.convert('RGB')
        try:
            rgb_image.save(temporary, format='JPEG', quality=95, optimize=True, progressive=True)
        finally:
            if rgb_image is not image:
                rgb_image.close()
        os.replace(temporary, target_path)
        shutil.copystat(source_path, target_path)
    finally:
        image.close()
        if os.path.exists(temporary):
            os.remove(temporary)


def generate_missing_raw_jpgs(target_folder, imported_paths, converter=generate_raw_jpg, on_progress=None, on_generated=None, on_pending=None, on_result=None, on_failure=None):
    candidates = find_missing_raw_jpg_candidates(target_folder, imported_paths)
    if not candidates:
        return 0, 0
    jpg_dir = os.path.join(target_folder, 'jpg')
    os.makedirs(jpg_dir, exist_ok=True)
    succeeded = 0
    for index, source_path in enumerate(candidates, start=1):
        ensure_not_cancelled()
        stem = os.path.splitext(os.path.basename(source_path))[0]
        target_path = os.path.join(jpg_dir, f'{stem}.jpg')
        try:
            if on_pending:
                on_pending(source_path, target_path)
            with task_resource_lease('raw-jpg', f'正在从 RAW 生成 JPG：{os.path.basename(source_path)}'):
                converter(source_path, target_path)
            succeeded += 1
            if on_generated:
                on_generated(target_path)
            if on_result:
                on_result(source_path, target_path)
        except (ImportCancelled, ResourceLeaseDenied):
            raise
        except Exception as error:
            if on_failure:
                on_failure(source_path, error)
            emit('warning', f'无法从 RAW 生成 JPG，已保留 RAW 文件 {os.path.basename(source_path)}：{error}')
        if on_progress:
            on_progress(index, len(candidates), os.path.basename(source_path))
    return succeeded, len(candidates)

def generate_video_previews(target_folder, quality='medium', on_generated=None, source_paths=None, on_pending=None, on_result=None, on_failure=None):
    """Create H.264 MP4 previews for the already classified video files."""
    quality = normalize_video_preview_quality(quality)
    profile = VIDEO_PREVIEW_QUALITY_PROFILES[quality]
    source_dir = os.path.join(target_folder, 'mov')
    if not os.path.isdir(source_dir):
        return 0, 0

    video_extensions = ('.mp4', '.mov', '.avi', '.mpeg', '.mpg', '.mts', '.m2ts', '.crm')
    if source_paths is None:
        video_files = [
            name for name in os.listdir(source_dir)
            if os.path.isfile(os.path.join(source_dir, name)) and name.lower().endswith(video_extensions)
        ]
    else:
        video_files = [
            os.path.basename(file_path) for file_path in source_paths
            if os.path.dirname(os.path.abspath(file_path)) == os.path.abspath(source_dir)
            and os.path.isfile(file_path) and file_path.lower().endswith(video_extensions)
        ]
    if not video_files:
        return 0, 0

    output_dir = os.path.join(target_folder, 'mov_转码')
    os.makedirs(output_dir, exist_ok=True)
    announced_encoder = ''
    succeeded = 0

    log_info(f"正在生成 {len(video_files)} 个{profile['label']}质量视频预览版...")
    for index, file_name in enumerate(video_files, start=1):
        input_path = os.path.join(source_dir, file_name)
        output_name = f"{Path(file_name).stem}.mp4"
        output_path = os.path.join(output_dir, output_name)
        if os.path.exists(output_path):
            output_path = os.path.join(output_dir, f"{Path(file_name).stem}_{int(time.time())}.mp4")

        try:
            if on_pending:
                on_pending(input_path, output_path)
            with task_resource_lease('video-preview', f'正在生成视频预览：{file_name}'):
                used_encoder = transcode_video_preview(input_path, output_path, quality, on_log=log_info)
            validate_tool_output_paths([output_path], output_dir, input_path, expected_extensions={'.mp4'})
            succeeded += 1
            if used_encoder and announced_encoder != used_encoder:
                announced_encoder = used_encoder
                log_info(f"视频预览使用{' GPU' if used_encoder != 'libx264' else ' CPU'} 编码器：{used_encoder}")
            if on_generated:
                on_generated(output_path)
            if on_result:
                on_result(input_path, output_path)
            log_info(f"视频预览版 {index}/{len(video_files)}：{os.path.basename(output_path)}")
        except FFmpegTranscodeError as error:
            if on_failure:
                on_failure(input_path, error)
            emit('warning', f"视频预览生成失败，已保留原视频 {file_name}：{error}")

    return succeeded, len(video_files)

def split_large_videos(target_folder, on_split=None, source_paths=None, on_pending=None, on_failure=None):
    """Losslessly split imported videos for FAT32 and cloud single-file limits."""
    source_dir = os.path.join(target_folder, 'mov')
    if not os.path.isdir(source_dir):
        return 0

    target_size = SPLIT_TARGET_BYTES
    split_count = 0
    file_names = list(os.listdir(source_dir)) if source_paths is None else [
        os.path.basename(file_path) for file_path in source_paths
        if os.path.dirname(os.path.abspath(file_path)) == os.path.abspath(source_dir)
    ]
    large_paths = [os.path.join(source_dir, name) for name in file_names if os.path.isfile(os.path.join(source_dir, name)) and os.path.getsize(os.path.join(source_dir, name)) > target_size]
    ensure_import_disk_space(target_folder, max((os.path.getsize(file_path) for file_path in large_paths), default=0), '大视频分割')
    for file_name in file_names:
        input_path = os.path.join(source_dir, file_name)
        if not os.path.isfile(input_path) or os.path.getsize(input_path) <= target_size:
            continue

        log_info(f'正在将超过 4GB 的视频分割为约 3.95GB：{file_name}')
        try:
            if on_pending:
                on_pending(input_path)
            with task_resource_lease('video-split', f'正在分割大视频：{file_name}'):
                segment_paths = split_video_by_size(
                    input_path,
                    split_threshold_bytes=target_size,
                    target_segment_bytes=target_size,
                    maximum_segment_bytes=FOUR_GB,
                    keep_original=True,
                    cancel_check=ensure_not_cancelled,
                )
            segment_paths = validate_tool_output_paths(
                segment_paths, source_dir, input_path,
                expected_extensions={os.path.splitext(input_path)[1].lower()},
            )
            if on_split:
                on_split(input_path, segment_paths)
            os.remove(input_path)
            split_count += 1
            log_info(f'视频分割完成：{file_name} → {len(segment_paths)} 段')
        except (FFmpegTranscodeError, OSError, ValueError) as error:
            if on_failure:
                on_failure(input_path, error)
            emit('warning', f'视频分割失败，已保留原文件 {file_name}：{error}')
    return split_count


def video_transcode_settings_kwargs(settings):
    settings = settings or {}
    return {
        'container': settings.get('container', 'mp4'),
        'video_mode': settings.get('videoMode', 'h264'),
        'quality': settings.get('quality', 'balanced'),
        'resolution': settings.get('resolution', 'original'),
        'frame_rate': settings.get('frameRate', 'original'),
        'audio_mode': settings.get('audioMode', 'aac'),
        'subtitle_mode': settings.get('subtitleMode', 'copy'),
        'color_mode': settings.get('colorMode', 'auto'),
        'bit_depth': settings.get('bitDepth', 'auto'),
        'frame_rate_mode': settings.get('frameRateMode', 'preserve'),
        'rotation': settings.get('rotation', 'auto'),
        'aspect_mode': settings.get('aspectMode', 'preserve'),
        'audio_track': settings.get('audioTrack', 'all'),
        'video_bitrate_mbps': settings.get('videoBitrateMbps'),
        'audio_bitrate_kbps': settings.get('audioBitrateKbps', 192),
        'encoder_preset': settings.get('encoderPreset', 'balanced'),
    }


def transcode_imported_video_folder(source_dir, settings, on_transcoded=None, source_paths=None, on_pending=None, on_result=None, on_failure=None):
    """Transcode every imported video in one media folder into its sibling ``*_转码`` folder."""
    source_dir = os.path.abspath(source_dir)
    output_dir = f'{source_dir}_转码'
    candidates = [
        os.path.abspath(file_path) for file_path in (source_paths or [])
        if os.path.isfile(file_path)
        and os.path.commonpath((source_dir, os.path.abspath(file_path))) == source_dir
        and os.path.splitext(file_path)[1].lower() in VIDEO_EXTENSIONS
    ]
    succeeded = 0
    outputs = []
    for input_path in candidates:
        ensure_not_cancelled()
        try:
            if on_pending:
                on_pending(input_path)
            with task_resource_lease('video-transcode', f'正在转码导入视频：{os.path.basename(input_path)}'):
                output_path = transcode_video(
                    input_path,
                    **video_transcode_settings_kwargs(settings),
                    output_mode='new',
                    destination_directory=output_dir,
                    on_log=log_info,
                    cancel_check=ensure_not_cancelled,
                )
            expected_container = str((settings or {}).get('container') or 'mp4').lower()
            output_path = validate_tool_output_paths(
                [output_path], output_dir, input_path, expected_extensions={f'.{expected_container}'},
            )[0]
            succeeded += 1
            outputs.append(output_path)
            if on_transcoded:
                on_transcoded(output_path)
            if on_result:
                on_result(input_path, output_path)
        except (FFmpegTranscodeError, OSError, ValueError) as error:
            if on_failure:
                on_failure(input_path, error)
            emit('warning', f'视频转码失败，已保留原文件 {os.path.basename(input_path)}：{error}')
    return succeeded, len(candidates), outputs


def transcode_imported_videos(target_folder, settings, on_transcoded=None, source_paths=None, on_pending=None, on_result=None, on_failure=None):
    """Apply the shared video-transcode panel settings to this work-import batch."""
    return transcode_imported_video_folder(
        os.path.join(target_folder, 'mov'),
        settings,
        on_transcoded=on_transcoded,
        source_paths=source_paths,
        on_pending=on_pending,
        on_result=on_result,
        on_failure=on_failure,
    )
# --- 3. 核心导入流程 ---
def split_broll_video(input_path, keep_original=False):
    """Losslessly split one imported B-roll video and return its new segments."""
    if not os.path.isfile(input_path) or os.path.getsize(input_path) <= FOUR_GB:
        return []
    ensure_not_cancelled()
    log_info(f'正在将超过 4GB 的花絮视频分割为约 3.95GB：{os.path.basename(input_path)}')
    try:
        with task_resource_lease('video-split', f'正在分割花絮视频：{os.path.basename(input_path)}'):
            segments = split_video_by_size(
                input_path,
                split_threshold_bytes=FOUR_GB,
                target_segment_bytes=SPLIT_TARGET_BYTES,
                maximum_segment_bytes=FOUR_GB,
                keep_original=keep_original,
                cancel_check=ensure_not_cancelled,
            )
        segments = validate_tool_output_paths(
            segments, os.path.dirname(input_path), input_path,
            expected_extensions={os.path.splitext(input_path)[1].lower()},
        )
    except FFmpegTranscodeError as error:
        raise IOError(f'无法安全分割 {os.path.basename(input_path)}：{error}') from error
    log_info(f'花絮视频分割完成：{os.path.basename(input_path)} → {len(segments)} 段')
    return segments


def stage_import_and_organize(sd_path, dest_path, split_threshold_hours=2.0, should_split=None, generate_video_preview=False, split_large_files=False, project_routes=None, direct_project=False, video_preview_quality='medium', direct_source=False, source_paths=None, delete_source=False, generate_jpg_from_raw=False, import_session='', date_filter='all', split_import_videos=False, transcode_import_videos=False, transcode_settings=None):
    # 记录原始文件列表，用于最后的清理
    original_sd_files = []
    success_imported_count = 0
    created_projects = []

    import_session = str(import_session or '').strip() or str(uuid.uuid4())
    try:
        # Step 1-2: 先完整复制到安全暂存区；若规划阶段已完成，则直接复用本地副本。
        staged_import = stage_media_to_safety_temp(sd_path, dest_path, direct_source, source_paths, import_session, progress_end=75, date_filter=date_filter, verify_copy=delete_source)
        base_sd = staged_import['baseSource']
        original_sd_files = staged_import['originalFiles']
        temp_files_list = staged_import['stagedFiles']
        temp_dir = staged_import['stagingDir']
        total_bytes = staged_import['totalBytes']
        if not original_sd_files:
            log_success(no_staged_media_message(staged_import, direct_source), {'projectNames': [], 'importedCount': 0, 'skipped': True, 'skipReason': 'no-media'})
            return

        route_map = project_routes or {}
        # A fixed project does not need capture-time routing or shooting-gap analysis.
        if direct_project:
            files_with_time = [(file_path, None) for file_path in temp_files_list]
            capture_groups = []
            need_split_check = False
        else:
            files_with_time = staged_files_with_capture_times(staged_import)
            ensure_not_cancelled()
            files_with_time.sort(key=lambda x: x[1])
            # 使用与规划阶段相同的自适应断层结果，避免前后两次分组不一致。
            capture_groups = _build_capture_groups_from_timed_files(files_with_time, split_threshold_hours)
            need_split_check = len(capture_groups) > 1

        if not route_map and not direct_project and need_split_check and should_split is None:
            ask_user("根据拍摄时间间隙识别出多个拍摄时段，是否分文件夹整理？", {"need_split": True, "files_count": len(temp_files_list)})
            return

        # Step 4: 移动到最终目的地并分类
        groups = []
        if route_map:
            groups = capture_groups
        elif direct_project:
            groups = [{'id': 'direct', 'files': files_with_time}]
        elif should_split and need_split_check:
            groups = [group['files'] for group in capture_groups]
        else:
            groups = [files_with_time]

        log_info(f"正在整理到目标文件夹...")
        log_progress("正在整理并分类文件...", 75, {"bytesCopied": total_bytes, "totalBytes": total_bytes, "filesCopied": len(original_sd_files), "totalFiles": len(original_sd_files)})
        processed_targets = set()
        imported_paths_by_target = {}
        imported_output_paths = set()
        organized_items = []
        entries_by_local_path = {}
        for entry in staged_import.get('entries') or []:
            candidates = [entry.get('localPath'), entry.get('staged'), entry.get('committedDestination'), entry.get('pendingDestination'), *(entry.get('outputPaths') or [])]
            for candidate in candidates:
                if candidate:
                    entries_by_local_path[os.path.normcase(os.path.abspath(str(candidate)))] = entry

        for idx, group_record in enumerate(groups):
            ensure_not_cancelled()
            group = group_record['files'] if isinstance(group_record, dict) else group_record
            # 命名文件夹
            if route_map:
                target_folder = os.path.abspath(route_map.get(group_record['id'], ''))
                if not target_folder or not _safe_directory_target(dest_path, target_folder):
                    raise ValueError(f"分组 {group_record['id']} 的目标项目无效，请重新选择")
                date_str = os.path.basename(target_folder)
            elif direct_project:
                target_folder = os.path.abspath(dest_path)
                date_str = os.path.basename(target_folder)
            else:
                first_time = group[0][1]
                date_str = datetime.datetime.fromtimestamp(first_time).strftime('%m-%d').lstrip('0').replace('-0', '-')
                if len(groups) > 1:
                    date_str = f"{date_str}-{idx+1}"
                target_folder = os.path.join(dest_path, date_str)
            os.makedirs(target_folder, exist_ok=True)
            if date_str not in created_projects:
                created_projects.append(date_str)

            for f_path, _ in group:
                ensure_not_cancelled()
                entry = entries_by_local_path.get(os.path.normcase(os.path.abspath(f_path)))
                if entry is None:
                    raise IOError(f'暂存清单缺少文件：{os.path.basename(f_path)}')
                organized_items.append({'sourcePath': f_path, 'entry': entry, 'targetFolder': target_folder})
            processed_targets.add(target_folder)

        # Persist every intended destination before the first filesystem mutation.
        # A retry can then distinguish already-promoted files from files that are
        # still in staging without rewriting and fsyncing the full manifest twice
        # for every item.
        reserved_destinations = set()
        has_planned_moves = False
        for item in organized_items:
            ensure_not_cancelled()
            entry = item['entry']
            target_folder = item['targetFolder']
            committed_outputs = [os.path.abspath(value) for value in entry.get('outputPaths', []) if os.path.isfile(value)]
            committed_destination = os.path.abspath(str(entry.get('committedDestination') or '')) if entry.get('committedDestination') else ''
            if committed_outputs:
                item['importedPaths'] = committed_outputs
                continue
            if committed_destination and _entry_matches_imported_content(entry, committed_destination, int(entry.get('size') or 0)):
                item['importedPaths'] = [committed_destination]
                continue

            original_name = os.path.basename(str(entry.get('source') or item['sourcePath']))
            destination_dir = classified_destination_directory(target_folder, original_name)
            os.makedirs(destination_dir, exist_ok=True)
            pending_destination = os.path.abspath(str(entry.get('pendingDestination') or '')) if entry.get('pendingDestination') else ''
            previous_temporary = os.path.abspath(str(entry.get('pendingTemporary') or '')) if entry.get('pendingTemporary') else ''
            pending_key = os.path.normcase(pending_destination) if pending_destination else ''
            if pending_destination \
                    and os.path.dirname(pending_destination) == os.path.abspath(destination_dir) \
                    and pending_key not in reserved_destinations \
                    and not os.path.exists(pending_destination):
                destination = pending_destination
                reserved_destinations.add(pending_key)
            else:
                destination = reserve_unique_destination(destination_dir, original_name, reserved_destinations)
            temporary = import_part_path(destination, entry['staged'])
            expected_previous_temporary = import_part_path(pending_destination, entry['staged']) if pending_destination else ''
            if previous_temporary \
                    and previous_temporary == expected_previous_temporary \
                    and previous_temporary != temporary \
                    and os.path.isfile(previous_temporary):
                os.remove(previous_temporary)
            patch_staged_entry_fields(entry, {
                'pendingDestination': destination,
                'pendingTemporary': temporary,
                'committedDestination': None,
            })
            item['destination'] = destination
            item['temporary'] = temporary
            has_planned_moves = True

        if has_planned_moves:
            checkpoint_staged_import(staged_import)

        last_organize_progress_at = 0.0
        for item_index, item in enumerate(organized_items, start=1):
            ensure_not_cancelled()
            entry = item['entry']
            target_folder = item['targetFolder']
            imported_paths = item.get('importedPaths')
            if imported_paths is None:
                destination = item['destination']
                if not _safe_directory_target(target_folder, os.path.dirname(destination)):
                    raise ValueError('导入写入目标包含符号链接、junction 或越界路径')
                promote_staged_file(item['sourcePath'], destination, temporary_path=item['temporary'])
                patch_staged_entry_fields(entry, {
                    'committedDestination': destination,
                    'pendingDestination': None,
                    'pendingTemporary': None,
                    'localPath': destination,
                })
                imported_paths = [destination]

            if any(os.path.commonpath((os.path.abspath(target_folder), path)) != os.path.abspath(target_folder) for path in imported_paths):
                raise ValueError(f'已提交文件与当前项目归属不一致：{os.path.basename(entry["source"])}')
            imported_paths_by_target.setdefault(target_folder, []).extend(imported_paths)
            imported_output_paths.update(imported_paths)
            success_imported_count += 1

            now = time.monotonic()
            if item_index == 1 or item_index == len(organized_items) or now - last_organize_progress_at >= 0.1:
                last_organize_progress_at = now
                log_progress(
                    f"正在整理并分类文件：{os.path.basename(entry['source'])}（{item_index}/{len(organized_items)}）",
                    75 + int((item_index / max(1, len(organized_items))) * 15),
                    {
                        "bytesCopied": total_bytes,
                        "totalBytes": total_bytes,
                        "filesCopied": success_imported_count,
                        "totalFiles": len(original_sd_files),
                        "filesProcessed": item_index,
                        "phase": "organizing",
                    },
                )

        if has_planned_moves:
            checkpoint_staged_import(staged_import)

        organized_copy_verified = verify_staged_import_for_source_cleanup(staged_import) if delete_source else False

        processed_target_list = list(processed_targets)
        post_process_failed = False
        generated_jpg_count = 0
        generated_jpg_paths_by_target = {}
        generated_video_paths_by_target = {}
        raw_without_jpg_count = 0
        if generate_jpg_from_raw:
            for target_folder in processed_target_list:
                for source_path in imported_paths_by_target.get(target_folder, []):
                    entry = staged_entry_for_local_path(staged_import, source_path)
                    if not entry or os.path.splitext(source_path)[1].lower() not in RAW_EXTENSIONS:
                        continue
                    recovered = recover_post_process(staged_import, entry, 'raw_jpg', os.path.join(target_folder, 'jpg'), image_output=True)
                    for output_path in recovered:
                        imported_output_paths.add(output_path)
                        generated_jpg_paths_by_target.setdefault(target_folder, []).append(output_path)
            all_candidates = [
                (target_folder, source_path)
                for target_folder in processed_target_list
                for source_path in find_missing_raw_jpg_candidates(target_folder, imported_paths_by_target.get(target_folder, []))
            ]
            completed_candidates = 0
            for target_folder in processed_target_list:
                ensure_not_cancelled()
                def publish_raw_jpg_progress(_index, _total, file_name):
                    nonlocal completed_candidates
                    completed_candidates += 1
                    log_progress(
                        f"正在从 RAW 生成 JPG：{file_name}",
                        90 + int((completed_candidates / max(1, len(all_candidates))) * 4),
                        {"bytesCopied": total_bytes, "totalBytes": total_bytes, "filesCopied": success_imported_count, "totalFiles": len(original_sd_files)},
                    )

                def mark_raw_jpg_pending(source_path, target_path):
                    entry = staged_entry_for_local_path(staged_import, source_path)
                    if entry:
                        checkpoint_post_process(staged_import, entry, 'raw_jpg', {
                            'kind': 'raw_jpg', 'state': 'pending',
                            'inputPath': os.path.abspath(source_path), 'pendingOutput': os.path.abspath(target_path),
                        })

                def commit_raw_jpg(source_path, target_path):
                    entry = entry_for_post_process(staged_import, source_path, 'raw_jpg', 'pending')
                    if entry:
                        checkpoint_post_process(staged_import, entry, 'raw_jpg', {
                            'kind': 'raw_jpg', 'state': 'committed',
                            'inputPath': os.path.abspath(source_path), 'outputPaths': [os.path.abspath(target_path)],
                        })

                def clear_raw_jpg_pending(source_path, _error):
                    entry = entry_for_post_process(staged_import, source_path, 'raw_jpg', 'pending')
                    if entry:
                        checkpoint_post_process(staged_import, entry, 'raw_jpg', None)

                generated, candidate_count = generate_missing_raw_jpgs(
                    target_folder,
                    imported_paths_by_target.get(target_folder, []),
                    on_progress=publish_raw_jpg_progress,
                    on_generated=lambda generated_path, target=target_folder: (
                        imported_output_paths.add(generated_path),
                        generated_jpg_paths_by_target.setdefault(target, []).append(generated_path),
                    ),
                    on_pending=mark_raw_jpg_pending,
                    on_result=commit_raw_jpg,
                    on_failure=clear_raw_jpg_pending,
                )
                generated_jpg_count += generated
                raw_without_jpg_count += candidate_count
            if raw_without_jpg_count:
                log_info(f"RAW 转 JPG 完成：{generated_jpg_count}/{raw_without_jpg_count} 个文件已保存到 jpg 文件夹")
        for target_index, target_folder in enumerate(processed_target_list):
            ensure_not_cancelled()
            def mark_post_process_pending(input_path, kind, pending_output=''):
                entry = staged_entry_for_local_path(staged_import, input_path)
                if entry:
                    record = {
                        'kind': kind, 'state': 'pending', 'inputPath': os.path.abspath(input_path),
                        'pendingOutput': os.path.abspath(pending_output) if pending_output else '',
                    }
                    if kind == 'transcode':
                        output_directory = os.path.join(target_folder, 'mov_转码')
                        record.update({
                            'outputDirectory': output_directory,
                            'baselineOutputs': [os.path.join(output_directory, name) for name in os.listdir(output_directory)] if os.path.isdir(output_directory) else [],
                            'expectedStem': Path(input_path).stem,
                        })
                    checkpoint_post_process(staged_import, entry, kind, {
                        **record,
                    })

            def clear_post_process_pending(input_path, kind):
                entry = entry_for_post_process(staged_import, input_path, kind, 'pending')
                if entry:
                    checkpoint_post_process(staged_import, entry, kind, None)

            if split_large_files or split_import_videos:
                def record_split_failure(_input_path, _error):
                    nonlocal post_process_failed
                    post_process_failed = True

                def record_split_output(input_path, segment_paths):
                    imported_output_paths.discard(input_path)
                    imported_output_paths.update(segment_paths)
                    target_paths = imported_paths_by_target.get(target_folder, [])
                    imported_paths_by_target[target_folder] = [path for path in target_paths if path != input_path] + list(segment_paths)
                    entry = staged_entry_for_local_path(staged_import, input_path)
                    if entry:
                        patch_staged_entry_fields(entry, {'outputPaths': list(segment_paths)})
                        checkpoint_post_process(staged_import, entry, 'split', {
                            'kind': 'split', 'state': 'committed', 'inputPath': os.path.abspath(input_path), 'outputPaths': list(segment_paths),
                        })

                split_count = split_large_videos(
                    target_folder,
                    on_split=record_split_output,
                    source_paths=imported_paths_by_target.get(target_folder, []),
                    on_pending=lambda input_path: mark_post_process_pending(input_path, 'split'),
                    on_failure=record_split_failure,
                )
                if split_count:
                    log_info(f'大文件分割完成：共处理 {split_count} 个视频')
            if transcode_import_videos:
                transcode_sources = []
                for input_path in imported_paths_by_target.get(target_folder, []):
                    entry = staged_entry_for_local_path(staged_import, input_path)
                    recovered = recover_post_process(staged_import, entry, 'transcode', f'{os.path.join(target_folder, "mov")}_转码') if entry else []
                    if recovered:
                        imported_output_paths.update(recovered)
                        generated_video_paths_by_target.setdefault(target_folder, []).extend(recovered)
                    else:
                        transcode_sources.append(input_path)

                def record_transcode_output(input_path, output_path, target=target_folder):
                    imported_output_paths.add(output_path)
                    generated_video_paths_by_target.setdefault(target, []).append(output_path)
                    source_entry = entry_for_post_process(staged_import, input_path, 'transcode', 'pending')
                    if source_entry:
                        checkpoint_post_process(staged_import, source_entry, 'transcode', {
                            'kind': 'transcode', 'state': 'committed', 'inputPath': os.path.abspath(input_path), 'outputPaths': [output_path],
                        })

                transcode_count, video_count, _transcode_outputs = transcode_imported_videos(
                    target_folder,
                    transcode_settings or {},
                    source_paths=transcode_sources,
                    on_pending=lambda input_path: mark_post_process_pending(input_path, 'transcode'),
                    on_result=record_transcode_output,
                    on_failure=lambda input_path, _error: clear_post_process_pending(input_path, 'transcode'),
                )
                if transcode_count != video_count:
                    post_process_failed = True
                if video_count:
                    log_info(f'视频转码完成：{transcode_count}/{video_count} 个文件已保存到 mov_转码')
            if generate_video_preview:
                preview_sources = []
                for input_path in imported_paths_by_target.get(target_folder, []):
                    entry = staged_entry_for_local_path(staged_import, input_path)
                    recovered = recover_post_process(staged_import, entry, 'preview', os.path.join(target_folder, 'mov_转码')) if entry else []
                    if recovered:
                        imported_output_paths.update(recovered)
                        generated_video_paths_by_target.setdefault(target_folder, []).extend(recovered)
                    else:
                        preview_sources.append(input_path)

                def record_generated_preview(input_path, generated_path, target=target_folder):
                    imported_output_paths.add(generated_path)
                    generated_video_paths_by_target.setdefault(target, []).append(generated_path)
                    source_entry = entry_for_post_process(staged_import, input_path, 'preview', 'pending')
                    if source_entry:
                        checkpoint_post_process(staged_import, source_entry, 'preview', {
                            'kind': 'preview', 'state': 'committed', 'inputPath': os.path.abspath(input_path), 'outputPaths': [generated_path],
                        })

                preview_count, video_count = generate_video_previews(
                    target_folder,
                    video_preview_quality,
                    source_paths=preview_sources,
                    on_pending=lambda input_path, output_path: mark_post_process_pending(input_path, 'preview', output_path),
                    on_result=record_generated_preview,
                    on_failure=lambda input_path, _error: clear_post_process_pending(input_path, 'preview'),
                )
                if preview_count != video_count:
                    post_process_failed = True
                if video_count:
                    log_info(f"视频转码完成：{preview_count}/{video_count} 个文件已保存到 mov_转码")
            log_progress(
                f"正在完成导入后处理：{target_index + 1}/{len(processed_target_list)}",
                94 + int(((target_index + 1) / max(1, len(processed_target_list))) * 2),
                {"bytesCopied": total_bytes, "totalBytes": total_bytes, "filesCopied": success_imported_count, "totalFiles": len(original_sd_files)},
            )
        # Step 5: 最终校验与清理 SD 卡
        if success_imported_count == len(original_sd_files):
            log_info(f"整理完成，共处理 {success_imported_count} 个文件")
            import_manifests = [
                build_import_graph_manifest(
                    dest_path, target_folder, os.path.basename(target_folder), import_session,
                    imported_paths_by_target.get(target_folder, []),
                    generated_jpg_paths_by_target.get(target_folder, []),
                    generated_video_paths_by_target.get(target_folder, []),
                )
                for target_folder in sorted(processed_target_list)
            ]
            write_import_graph_receipt(temp_dir, import_session, import_manifests)

            deleted_source_count = 0
            should_delete_sources = False
            if delete_source:
                staged_import['copyVerified'] = organized_copy_verified
                source_cleanup_allowed = not post_process_failed and source_files_are_safe_to_delete(staged_import)
                if source_cleanup_allowed:
                    log_info("正在安全清理导入源文件...")
                    for cleanup_index, f in enumerate(original_sd_files):
                        ensure_not_cancelled()
                        try:
                            os.remove(f)
                            deleted_source_count += 1
                        except OSError:
                            pass
                        log_progress(
                            f"正在完成源文件清理：{cleanup_index + 1}/{len(original_sd_files)}",
                            96 + int(((cleanup_index + 1) / max(1, len(original_sd_files))) * 3),
                            {"bytesCopied": total_bytes, "totalBytes": total_bytes, "filesCopied": success_imported_count, "totalFiles": len(original_sd_files)},
                        )
                else:
                    emit('warning', '导入校验或后处理未完整成功；为避免误删，本次不会清理任何源文件。')
                should_delete_sources = deleted_source_count == len(original_sd_files)
                if source_cleanup_allowed and not should_delete_sources:
                    emit('warning', f'导入已完成，但源设备不可用或部分源文件无法删除；已删除 {deleted_source_count}/{len(original_sd_files)} 个源文件。')
            else:
                log_progress("正在保留源文件...", 99, {"bytesCopied": total_bytes, "totalBytes": total_bytes, "filesCopied": success_imported_count, "totalFiles": len(original_sd_files)})

            log_progress("导入流程全部完成", 100, {"bytesCopied": total_bytes, "totalBytes": total_bytes, "filesCopied": success_imported_count, "totalFiles": len(original_sd_files)})
            imported_paths_by_project = {}
            for target_folder in sorted(processed_targets):
                target_absolute = os.path.abspath(target_folder)
                project_paths = []
                for imported_path in imported_output_paths:
                    try:
                        if os.path.commonpath((target_absolute, os.path.abspath(imported_path))) == target_absolute:
                            project_paths.append(os.path.abspath(imported_path))
                    except ValueError:
                        continue
                if project_paths:
                    imported_paths_by_project[os.path.basename(target_absolute)] = sorted(set(project_paths))
            public_import_manifests = [dict(manifest) for manifest in import_manifests]
            success_payload = {"projectNames": created_projects, "importedCount": success_imported_count, "sourceFilesDeleted": should_delete_sources, "generatedJpgCount": generated_jpg_count, "importedPaths": sorted(imported_output_paths), "importedPathsByProject": imported_paths_by_project, "importSessionId": import_session, "importManifests": public_import_manifests, "receiptPending": True}
            if post_process_failed:
                success_payload['partialFailure'] = True
            log_success("导入完成，源文件已按设置处理", success_payload)
        else:
            log_error(f"警告：导入数量不匹配（应有{len(original_sd_files)}，实际{success_imported_count}）。SD 卡未清理，请检查桌面临时文件夹。")

    except ImportCancelled:
        emit('cancelled', '导入已取消；源文件未删除，已完成的目标文件已保留。')
        gc.collect()
    except Exception as e:
        log_error(f"流程异常: {str(e)}")
        # 异常情况下保留临时文件夹和 SD 卡文件，确保数据不丢
        gc.collect()

def stage_import_broll(sd_path, dest_path, project_routes=None, direct_source=False, source_paths=None, delete_source=False, split_large_files=False, import_session='', date_filter='all', split_import_videos=False, transcode_import_videos=False, transcode_settings=None):
    """Promote staged media into each selected project's B-roll folder."""
    created_files = []
    created_broll_folders = []
    moved_staged_files = {}
    split_originals = []
    imported_video_paths_by_folder = {}
    source_cleanup_started = False
    deleted_source_count = 0
    post_process_failed = False

    try:
        staged_import = stage_media_to_safety_temp(sd_path, dest_path, direct_source, source_paths, import_session, progress_end=75, date_filter=date_filter, verify_copy=delete_source)
        base_sd = staged_import['baseSource']
        original_files = staged_import['originalFiles']
        import_files = staged_import['stagedFiles']
        staging_dir = staged_import['stagingDir']
        if not original_files:
            log_success(no_staged_media_message(staged_import, direct_source), {'projectNames': [], 'importedCount': 0, 'skipped': True, 'skipReason': 'no-media'})
            return

        if not dest_path or not os.path.isdir(dest_path):
            log_error("花絮目标项目不存在，请重新选择项目")
            return
        route_map = project_routes or {}
        file_routes = {}
        if route_map:
            timed_files = staged_files_with_capture_times(staged_import)
            for group in _build_capture_groups_from_timed_files(timed_files):
                project_path = os.path.abspath(route_map.get(group['id'], ''))
                if not project_path or not _safe_directory_target(dest_path, project_path):
                    raise ValueError(f"分组 {group['id']} 的目标项目无效，请重新选择")
                for file_path, _timestamp in group['files']:
                    file_routes[file_path] = project_path
        total_bytes = staged_import['totalBytes']
        log_progress("素材导入完成，准备整理花絮...", 75, {"bytesCopied": total_bytes, "totalBytes": total_bytes, "filesCopied": 0, "totalFiles": len(import_files)})
        completed_bytes = 0
        last_progress_at = 0.0
        log_info(f"正在把 {len(import_files)} 个已导入文件整理到花絮...")
        for index, source in enumerate(import_files):
            ensure_not_cancelled()
            entry = staged_entry_for_local_path(staged_import, source)
            project_path = file_routes.get(source, dest_path)
            broll_folder = os.path.join(project_path, '花絮')
            if not os.path.isdir(broll_folder):
                os.makedirs(broll_folder, exist_ok=False)
                created_broll_folders.append(broll_folder)
            recovered_segments = []
            split_record = post_process_record(entry, 'split') if entry else None
            if split_record and split_record.get('state') == 'committed' and split_record.get('outputPaths'):
                split_input = str(split_record.get('inputPath') or '')
                try:
                    recovered_segments = validate_tool_output_paths(
                        split_record['outputPaths'], broll_folder, split_input,
                        expected_extensions={os.path.splitext(split_input)[1].lower()},
                    )
                except ValueError:
                    checkpoint_post_process(staged_import, entry, 'split', None)
                    recovered_segments = []
            source_size = int(entry.get('size') or 0) if recovered_segments else os.path.getsize(source)
            will_split = (split_large_files or split_import_videos) and os.path.splitext(source)[1].lower() in VIDEO_EXTENSIONS and source_size > FOUR_GB
            if will_split:
                ensure_import_disk_space(project_path, source_size, '花絮视频分割')
            committed_destination = str(entry.get('committedDestination') or '') if entry else ''
            already_committed = bool(entry and committed_destination and _entry_matches_imported_content(entry, committed_destination, int(entry.get('size') or 0)))
            destination = os.path.abspath(committed_destination) if already_committed else unique_broll_destination(broll_folder, os.path.basename(source), will_split)

            def publish_broll_progress(current_file_bytes, force=False):
                nonlocal last_progress_at
                now = time.monotonic()
                bytes_copied = min(total_bytes, completed_bytes + current_file_bytes)
                if not force and now - last_progress_at < 0.1 and bytes_copied < total_bytes:
                    return
                last_progress_at = now
                log_progress(
                    f"导入花絮：{os.path.basename(source)}",
                    75 + int((bytes_copied / max(1, total_bytes)) * 15),
                    {
                        "bytesCopied": total_bytes,
                        "totalBytes": total_bytes,
                        "bytesPerSecond": 0,
                        "filesCopied": index + (1 if force else 0),
                        "totalFiles": len(original_files),
                        "phase": "organizing",
                    },
                )

            if recovered_segments:
                for segment in recovered_segments:
                    if segment not in created_files:
                        created_files.append(segment)
                split_input = str(split_record.get('inputPath') or '')
                if split_input and os.path.isfile(split_input) and split_input not in split_originals:
                    split_originals.append(split_input)
                if transcode_import_videos:
                    imported_video_paths_by_folder.setdefault(broll_folder, []).extend(recovered_segments)
                completed_bytes += source_size
                publish_broll_progress(0, True)
                continue

            moved_from_staging = False
            if not already_committed:
                if not _safe_directory_target(project_path, os.path.dirname(destination)):
                    raise ValueError('花絮写入目标包含符号链接、junction 或越界路径')
                if entry:
                    journal_staged_entry(staged_import, entry, {
                        'pendingDestination': destination,
                        'promotion': {'state': 'pending', 'destination': destination},
                    })
                moved_from_staging = promote_staged_file(
                    source,
                    destination,
                    on_progress=publish_broll_progress,
                    allow_atomic_move=True,
                )
                if entry:
                    journal_staged_entry(staged_import, entry, {
                        'pendingDestination': None,
                        'committedDestination': destination,
                        'localPath': destination,
                        'promotion': {'state': 'committed', 'destination': destination},
                    })
            if os.path.getsize(destination) != source_size:
                try:
                    os.remove(destination)
                except OSError:
                    pass
                raise IOError(f"整理校验失败：{os.path.basename(source)}")
            created_files.append(destination)
            if moved_from_staging:
                moved_staged_files[destination] = source
            post_process_video_paths = [destination]
            if will_split:
                if entry:
                    checkpoint_post_process(staged_import, entry, 'split', {
                        'kind': 'split', 'state': 'pending', 'inputPath': destination,
                    })
                log_progress(
                    f"正在分割花絮大视频：{os.path.basename(destination)}",
                    75 + int(((completed_bytes + source_size) / max(1, total_bytes)) * 15),
                    {"bytesCopied": total_bytes, "totalBytes": total_bytes, "bytesPerSecond": 0, "filesCopied": index, "totalFiles": len(original_files), "phase": "splitting"},
                )
                segments = split_broll_video(destination, keep_original=True)
                if segments:
                    created_files.remove(destination)
                    created_files.extend(segments)
                    split_originals.append(destination)
                    post_process_video_paths = segments
                    if entry:
                        patch_staged_entry_fields(entry, {'outputPaths': list(segments)})
                        checkpoint_post_process(staged_import, entry, 'split', {
                            'kind': 'split', 'state': 'committed', 'inputPath': destination, 'outputPaths': list(segments),
                        })
            if transcode_import_videos:
                imported_video_paths_by_folder.setdefault(broll_folder, []).extend(post_process_video_paths)
            completed_bytes += source_size
            publish_broll_progress(0, True)

        transcode_count = 0
        transcode_candidate_count = 0
        organized_copy_verified = verify_staged_import_for_source_cleanup(staged_import) if delete_source else False
        for broll_folder, imported_video_paths in imported_video_paths_by_folder.items():
            output_folder = f'{os.path.abspath(broll_folder)}_转码'
            output_folder_existed = os.path.isdir(output_folder)
            pending_transcode_paths = []
            for input_path in imported_video_paths:
                recovered_entry = staged_entry_for_local_path(staged_import, input_path)
                recovered = recover_post_process(staged_import, recovered_entry, 'transcode', output_folder) if recovered_entry else []
                if recovered:
                    created_files.extend(recovered)
                else:
                    pending_transcode_paths.append(input_path)

            def mark_broll_transcode_pending(input_path):
                pending_entry = staged_entry_for_local_path(staged_import, input_path)
                if pending_entry:
                    checkpoint_post_process(staged_import, pending_entry, 'transcode', {
                        'kind': 'transcode', 'state': 'pending', 'inputPath': os.path.abspath(input_path),
                        'outputDirectory': output_folder,
                        'baselineOutputs': [os.path.join(output_folder, name) for name in os.listdir(output_folder)] if os.path.isdir(output_folder) else [],
                        'expectedStem': Path(input_path).stem,
                    })

            def commit_broll_transcode(input_path, output_path):
                created_files.append(output_path)
                pending_entry = entry_for_post_process(staged_import, input_path, 'transcode', 'pending')
                if pending_entry:
                    checkpoint_post_process(staged_import, pending_entry, 'transcode', {
                        'kind': 'transcode', 'state': 'committed',
                        'inputPath': os.path.abspath(input_path), 'outputPaths': [output_path],
                    })
            def clear_broll_transcode_pending(input_path, _error):
                pending_entry = entry_for_post_process(staged_import, input_path, 'transcode', 'pending')
                if pending_entry:
                    checkpoint_post_process(staged_import, pending_entry, 'transcode', None)
            try:
                succeeded, candidate_count, _outputs = transcode_imported_video_folder(
                    broll_folder,
                    transcode_settings or {},
                    source_paths=pending_transcode_paths,
                    on_pending=mark_broll_transcode_pending,
                    on_result=commit_broll_transcode,
                    on_failure=clear_broll_transcode_pending,
                )
            finally:
                if not output_folder_existed and os.path.isdir(output_folder):
                    created_broll_folders.append(output_folder)
            transcode_count += succeeded
            transcode_candidate_count += candidate_count
            if succeeded != candidate_count:
                post_process_failed = True
        if transcode_candidate_count:
            log_info(f'花絮视频转码完成：{transcode_count}/{transcode_candidate_count} 个文件已保存到 花絮_转码')

        # All segments are complete before their full-size inputs are removed.
        # From this point onward target files are the durable local copies.
        if split_originals:
            source_cleanup_started = True
            for original in split_originals:
                os.remove(original)

        # The source card is only cleaned after every destination file has passed validation.
        should_delete_sources = False
        if delete_source:
            staged_import['copyVerified'] = organized_copy_verified
            source_cleanup_allowed = not post_process_failed and source_files_are_safe_to_delete(staged_import)
            if source_cleanup_allowed:
                source_cleanup_started = True
                for cleanup_index, source in enumerate(original_files):
                    ensure_not_cancelled()
                    try:
                        os.remove(source)
                        deleted_source_count += 1
                    except OSError:
                        pass
                    log_progress(
                        f"正在完成花絮源文件清理：{cleanup_index + 1}/{len(original_files)}",
                        90 + int(((cleanup_index + 1) / max(1, len(original_files))) * 9),
                        {"bytesCopied": total_bytes, "totalBytes": total_bytes, "filesCopied": len(original_files), "totalFiles": len(original_files)},
                    )
            else:
                emit('warning', '导入校验或后处理未完整成功；为避免误删，本次不会清理任何源文件。')
            should_delete_sources = deleted_source_count == len(original_files)
            if source_cleanup_allowed and not should_delete_sources:
                emit('warning', f'花絮导入已完成，但源设备不可用或部分源文件无法删除；已删除 {deleted_source_count}/{len(original_files)} 个源文件。')
        else:
            log_progress("正在保留源文件...", 99, {"bytesCopied": total_bytes, "totalBytes": total_bytes, "filesCopied": len(original_files), "totalFiles": len(original_files)})
        compact_staging_patch_journal(staged_import)
        cleanup_import_staging(staging_dir)
        log_progress("花絮导入流程全部完成", 100, {"bytesCopied": total_bytes, "totalBytes": total_bytes, "filesCopied": len(original_files), "totalFiles": len(original_files)})
        broll_projects = sorted({os.path.abspath(project_path) for project_path in (file_routes.values() or [dest_path])})
        imported_paths_by_project = {}
        for project_path in broll_projects:
            project_files = []
            for created_file in created_files:
                try:
                    if os.path.commonpath((project_path, os.path.abspath(created_file))) == project_path:
                        project_files.append(os.path.abspath(created_file))
                except ValueError:
                    continue
            if project_files:
                imported_paths_by_project[os.path.basename(os.path.normpath(project_path))] = sorted(set(project_files))
        success_payload = {
            "projectNames": [os.path.basename(os.path.normpath(project_path)) for project_path in broll_projects],
            "importedCount": len(original_files),
            "destination": dest_path,
            "brollFolders": sorted({os.path.dirname(file_path) for file_path in created_files}),
            "sourceFilesDeleted": should_delete_sources,
            "transcodeCount": transcode_count,
            "importedPaths": sorted(created_files),
            "importedPathsByProject": imported_paths_by_project,
        }
        if post_process_failed:
            success_payload['partialFailure'] = True
        log_success("花絮导入完成，源文件已按设置处理", success_payload)
    except Exception as error:
        # Before source cleanup starts, remove a partial destination so retrying
        # is unambiguous. Once cleanup has begun, destination copies are the
        # only remaining copy for any source already deleted and must be kept.
        if not source_cleanup_started:
            for original in split_originals:
                staged_source = moved_staged_files.get(original)
                if staged_source and os.path.exists(original) and not os.path.exists(staged_source):
                    try:
                        os.replace(original, staged_source)
                    except OSError:
                        pass
            for destination in created_files:
                staged_source = moved_staged_files.get(destination)
                if staged_source and os.path.exists(destination) and not os.path.exists(staged_source):
                    try:
                        os.replace(destination, staged_source)
                        continue
                    except OSError:
                        # Keep the destination when rollback cannot restore the
                        # staged path; deleting it could remove the only local copy.
                        continue
                try:
                    os.remove(destination)
                except OSError:
                    pass
            for directory in reversed(created_broll_folders):
                try:
                    os.rmdir(directory)
                except OSError:
                    pass
            if isinstance(error, ImportCancelled):
                emit('cancelled', '花絮导入已取消；本次新增目标已回滚，源文件未删除。')
            else:
                log_error(f"花絮导入失败，SD 卡原文件已保留：{error}")
        elif isinstance(error, ImportCancelled):
            emit('cancelled', f'花絮导入已取消；已停止继续清理源文件，已删除 {deleted_source_count}/{len(original_files)} 个源文件，目标文件均已保留。')
        else:
            log_error(f"花絮文件已完整复制，但清理 SD 卡时失败；目标文件已保留，请手动检查卡内剩余文件：{error}")
        gc.collect()


def discard_import_session(dest_path, import_session):
    staging_dir = get_import_staging_dir(dest_path, import_session)
    cleanup_import_staging(staging_dir)
    log_success('已丢弃本次导入暂存', {'discarded': True})

def run(args_list):
    if sys.platform.startswith('win'):
        if sys.stdout: sys.stdout.reconfigure(encoding='utf-8')
        if sys.stderr: sys.stderr.reconfigure(encoding='utf-8')

    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", required=True)
    parser.add_argument("--sd_path", default="")
    parser.add_argument("--dest_path", default="")
    parser.add_argument("--time_gap", type=float, default=2.0)
    parser.add_argument("--should_split", type=str, default="")
    parser.add_argument("--generate_video_preview", action="store_true")
    parser.add_argument("--video_preview_quality", choices=tuple(VIDEO_PREVIEW_QUALITY_PROFILES), default="medium")
    parser.add_argument("--split_large_files", action="store_true")
    parser.add_argument("--split_import_videos", action="store_true")
    parser.add_argument("--transcode_import_videos", action="store_true")
    parser.add_argument("--transcode_settings", default="{}")
    parser.add_argument("--projects_json", default="[]")
    parser.add_argument("--project_routes", default="{}")
    parser.add_argument("--import_type", choices=("work", "broll"), default="work")
    parser.add_argument("--direct_project", action="store_true")
    parser.add_argument("--direct_source", action="store_true")
    parser.add_argument("--source_paths", default="[]")
    parser.add_argument("--delete_source", action="store_true")
    parser.add_argument("--generate_jpg_from_raw", action="store_true")
    parser.add_argument("--import_session", default="")
    parser.add_argument("--date_filter", choices=IMPORT_DATE_FILTERS, default="all")
    parser.add_argument("--exiftool_path", default="")
    parser.add_argument("--cancel_file", default="")
    parser.add_argument("--resource_protocol", action="store_true")

    args, _ = parser.parse_known_args(args_list)
    global CANCEL_FILE, EXIFTOOL_PATH, RESOURCE_PROTOCOL_ENABLED
    CANCEL_FILE = os.path.abspath(args.cancel_file) if args.cancel_file else ''
    EXIFTOOL_PATH = os.path.abspath(args.exiftool_path) if args.exiftool_path else ''
    RESOURCE_PROTOCOL_ENABLED = bool(args.resource_protocol)
    try:
        source_paths = [str(value) for value in json.loads(args.source_paths or '[]') if str(value).strip()]
    except (TypeError, ValueError, json.JSONDecodeError):
        source_paths = []

    split_val = None
    if args.should_split.lower() == 'true': split_val = True
    elif args.should_split.lower() == 'false': split_val = False

    try:
        if args.stage == 'check':
            connected = os.path.isdir(args.sd_path) and _is_import_volume_root(args.sd_path)
            log_status("SD Card Detected" if connected else "No Device", {"connected": connected, "path": args.sd_path})
        elif args.stage == 'plan':
            stage_plan_import(args.sd_path, args.dest_path, args.projects_json, args.import_type, args.time_gap, args.direct_source, source_paths, args.import_session, args.date_filter, args.delete_source)
        elif args.stage == 'import':
            stage_import_and_organize(args.sd_path, args.dest_path, args.time_gap, split_val, args.generate_video_preview, args.split_large_files, json.loads(args.project_routes or '{}'), args.direct_project, args.video_preview_quality, args.direct_source, source_paths, args.delete_source, args.generate_jpg_from_raw, args.import_session, args.date_filter, args.split_import_videos, args.transcode_import_videos, json.loads(args.transcode_settings or '{}'))
        elif args.stage == 'broll':
            stage_import_broll(args.sd_path, args.dest_path, json.loads(args.project_routes or '{}'), args.direct_source, source_paths, args.delete_source, args.split_large_files, args.import_session, args.date_filter, args.split_import_videos, args.transcode_import_videos, json.loads(args.transcode_settings or '{}'))
        elif args.stage == 'discard':
            discard_import_session(args.dest_path, args.import_session)
        else:
            raise ValueError(f'未知导入阶段：{args.stage}')
    except ImportCancelled:
        emit('cancelled', '素材分析已取消' if args.stage == 'plan' else '导入已取消')
    except Exception as error:
        log_error(str(error))

if __name__ == "__main__":
    run(sys.argv[1:])
