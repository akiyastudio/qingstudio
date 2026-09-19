"""Extract images embedded in Microsoft Office Open XML documents."""

from __future__ import annotations

import argparse
import ctypes
import errno
import json
import os
import re
import shutil
import sys
import time
import uuid
import zipfile
from pathlib import Path, PurePosixPath


WORD_EXTENSIONS = {".docx", ".docm", ".dotx", ".dotm"}
POWERPOINT_EXTENSIONS = {".pptx", ".pptm", ".potx", ".potm", ".ppsx", ".ppsm", ".ppam"}
EXCEL_EXTENSIONS = {".xlsx", ".xlsm", ".xltx", ".xltm", ".xlam", ".xlsb"}
IMAGE_EXTENSIONS = {
    ".avif", ".bmp", ".emf", ".gif", ".heic", ".heif", ".hif", ".ico",
    ".jfif", ".jpe", ".jpeg", ".jpg", ".png", ".svg", ".tif",
    ".tiff", ".webp", ".wmf",
}
WINDOWS_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}


def media_root_for(document: Path) -> str | None:
    extension = document.suffix.lower()
    if extension in WORD_EXTENSIONS:
        return "word"
    if extension in POWERPOINT_EXTENSIONS:
        return "ppt"
    if extension in EXCEL_EXTENSIONS:
        return "xl"
    return None


def _truncate_utf8(value: str, maximum_bytes: int) -> str:
    encoded = value.encode("utf-8")
    if len(encoded) <= maximum_bytes:
        return value
    return encoded[:maximum_bytes].decode("utf-8", errors="ignore")


def safe_name(value: str, fallback: str, maximum_bytes: int = 180) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value).rstrip(". ") or fallback
    if Path(name).stem.upper() in WINDOWS_RESERVED_NAMES:
        name = f"_{name}"
    if len(name.encode("utf-8")) <= maximum_bytes:
        return name
    suffix = Path(name).suffix
    suffix_bytes = len(suffix.encode("utf-8"))
    if suffix and suffix_bytes < min(32, maximum_bytes):
        return f"{_truncate_utf8(name[:-len(suffix)], maximum_bytes - suffix_bytes)}{suffix}"
    return _truncate_utf8(name, maximum_bytes)


def create_unique_directory(parent: Path, preferred_name: str) -> Path:
    base_name = safe_name(preferred_name, "文档_media")
    for index in range(1, 10000):
        candidate = parent / (base_name if index == 1 else f"{base_name}_{index}")
        try:
            candidate.mkdir()
            return candidate
        except FileExistsError:
            continue
    raise RuntimeError("无法创建唯一的图片输出文件夹")


def unique_file_path(directory: Path, file_name: str) -> Path:
    safe_file_name = safe_name(file_name, "image")
    candidate = directory / safe_file_name
    if not candidate.exists():
        return candidate
    stem = Path(safe_file_name).stem
    suffix = Path(safe_file_name).suffix
    for index in range(2, 10000):
        candidate = directory / f"{stem}_{index}{suffix}"
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"无法为图片生成唯一名称：{safe_file_name}")


def image_members(archive: zipfile.ZipFile, media_root: str) -> list[zipfile.ZipInfo]:
    prefix = f"{media_root}/media/"
    members: list[zipfile.ZipInfo] = []
    for member in archive.infolist():
        normalized = member.filename.replace("\\", "/")
        pure_path = PurePosixPath(normalized)
        if member.is_dir() or not normalized.lower().startswith(prefix):
            continue
        if len(pure_path.parts) != 3 or pure_path.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        members.append(member)
    return members


def _cancel(cancel_check, cancel_file: str | None = None) -> None:
    if cancel_file and Path(cancel_file).exists():
        raise RuntimeError("Office 图片提取已取消")
    if cancel_check is not None:
        cancel_check()


def _publish_directory_no_replace(staging: Path, parent: Path, preferred_name: str) -> Path:
    base_name = safe_name(preferred_name, "文档_media")
    for index in range(1, 10000):
        destination = parent / (base_name if index == 1 else f"{base_name}_{index}")
        if os.path.lexists(destination):
            continue
        try:
            if not _native_rename_no_replace(staging, destination):
                _fallback_publish_directory(staging, destination)
            return destination
        except FileExistsError:
            continue
        except OSError:
            if os.path.lexists(destination):
                continue
            raise
    raise RuntimeError("无法创建唯一的图片输出文件夹")


def _native_rename_no_replace(staging: Path, destination: Path) -> bool:
    if os.name == "nt":
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        move_file = kernel32.MoveFileExW
        move_file.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint]
        move_file.restype = ctypes.c_int
        if move_file(str(staging), str(destination), 0x8):  # MOVEFILE_WRITE_THROUGH, never replace
            return True
        code = ctypes.get_last_error()
        if code in (80, 183):
            raise FileExistsError(code, "目标目录已存在", str(destination))
        raise OSError(code, "无法排他发布 Office 图片目录", str(destination))

    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is not None:
        renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        renameat2.restype = ctypes.c_int
        result = renameat2(-100, os.fsencode(staging), -100, os.fsencode(destination), 1)
        if result == 0:
            return True
        code = ctypes.get_errno()
        if code in (errno.EEXIST, errno.ENOTEMPTY):
            raise FileExistsError(code, "目标目录已存在", str(destination))
        if code not in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP, getattr(errno, "ENOTSUP", errno.EOPNOTSUPP)):
            raise OSError(code, "无法排他发布 Office 图片目录", str(destination))
    renamex_np = getattr(libc, "renamex_np", None)
    if renamex_np is not None:
        renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        renamex_np.restype = ctypes.c_int
        if renamex_np(os.fsencode(staging), os.fsencode(destination), 0x4) == 0:  # RENAME_EXCL
            return True
        code = ctypes.get_errno()
        if code in (errno.EEXIST, errno.ENOTEMPTY):
            raise FileExistsError(code, "目标目录已存在", str(destination))
        if code not in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP, getattr(errno, "ENOTSUP", errno.EOPNOTSUPP)):
            raise OSError(code, "无法排他发布 Office 图片目录", str(destination))
    return False


def _fallback_publish_directory(staging: Path, destination: Path) -> None:
    del destination
    raise PublicationUnsupportedError(staging)


class PublicationUnsupportedError(OSError):
    code = "atomic_no_replace_unsupported"

    def __init__(self, staging: Path):
        self.recovery_path = str(staging)
        super().__init__(errno.EOPNOTSUPP, "文件系统不支持安全的排他原子目录发布；完整 staging 已保留")


def _cleanup_stale_staging(parent: Path, stem: str) -> None:
    cutoff = time.time() - 24 * 60 * 60
    pattern = f".{safe_name(stem, '文档')}.photoflow-staging-*"
    for candidate in parent.glob(pattern):
        try:
            if candidate.is_dir() and candidate.stat().st_mtime < cutoff:
                shutil.rmtree(candidate)
        except OSError:
            continue


def extract_document(document_path: str, max_files: int = 2000, max_bytes: int = 2 * 1024 * 1024 * 1024, cancel_check=None, cancel_file: str | None = None) -> dict[str, object]:
    document = Path(document_path).resolve()
    result: dict[str, object] = {
        "document": str(document),
        "documentName": document.name,
        "success": False,
        "count": 0,
    }
    staging_directory: Path | None = None
    try:
        if not document.is_file():
            raise ValueError("文档不存在")
        media_root = media_root_for(document)
        if not media_root:
            raise ValueError("不支持此 Office 文件格式")
        if not zipfile.is_zipfile(document):
            raise ValueError("文档不是有效的 Office Open XML 文件")
        _cleanup_stale_staging(document.parent, document.stem)

        with zipfile.ZipFile(document, "r") as archive:
            _cancel(cancel_check, cancel_file)
            members = image_members(archive, media_root)
            expected_bytes = sum(max(0, int(member.file_size)) for member in members)
            if len(members) > max_files or expected_bytes > max_bytes:
                raise ValueError("文档内图片数量或总大小超过安全上限")
            if not members:
                result.update(success=True, message="文档中没有图片")
                return result
            free_bytes = shutil.disk_usage(document.parent).free
            if free_bytes < expected_bytes + max(16 * 1024 * 1024, expected_bytes // 20):
                raise OSError("磁盘可用空间不足，无法安全提取 Office 图片")
            staging_directory = document.parent / f".{safe_name(document.stem, '文档')}.photoflow-staging-{uuid.uuid4().hex}"
            staging_directory.mkdir()
            extracted_names: list[str] = []
            total_bytes = 0
            for member in members:
                _cancel(cancel_check, cancel_file)
                output_path = unique_file_path(staging_directory, PurePosixPath(member.filename).name)
                with archive.open(member, "r") as source, output_path.open("xb") as target:
                    member_bytes = 0
                    while True:
                        _cancel(cancel_check, cancel_file)
                        chunk = source.read(1024 * 1024)
                        if not chunk:
                            break
                        member_bytes += len(chunk)
                        if total_bytes + member_bytes > max_bytes:
                            raise ValueError("文档内图片总大小超过安全上限")
                        target.write(chunk)
                    target.flush()
                    os.fsync(target.fileno())
                extracted_names.append(output_path.name)
                extracted_size = output_path.stat().st_size
                if extracted_size != int(member.file_size):
                    raise OSError(f"提取图片未完整写入：{output_path.name}")
                total_bytes += extracted_size
                if total_bytes > max_bytes:
                    raise ValueError("文档内图片总大小超过安全上限")
            _cancel(cancel_check, cancel_file)
            output_directory = _publish_directory_no_replace(staging_directory, document.parent, f"{document.stem}_media")
            staging_directory = None
            extracted_files = [str(output_directory / name) for name in extracted_names]

        result.update(
            success=True,
            count=len(extracted_files),
            totalBytes=total_bytes,
            outputFolder=str(output_directory),
            files=extracted_files,
        )
        return result
    except Exception as error:
        if staging_directory and staging_directory.exists() and not isinstance(error, PublicationUnsupportedError):
            shutil.rmtree(staging_directory, ignore_errors=True)
        result["error"] = str(error)
        if isinstance(error, PublicationUnsupportedError):
            result.update(code=error.code, recoveryPath=error.recovery_path)
        return result


def run(args_list: list[str]) -> None:
    parser = argparse.ArgumentParser(description="提取 Office Open XML 文档中的图片")
    subparsers = parser.add_subparsers(dest="command", required=True)
    extract_parser = subparsers.add_parser("extract")
    extract_parser.add_argument("--input", action="append", required=True, dest="inputs")
    extract_parser.add_argument("--max-files", type=int, default=2000)
    extract_parser.add_argument("--max-bytes", type=int, default=2 * 1024 * 1024 * 1024)
    extract_parser.add_argument("--cancel-file")
    args = parser.parse_args(args_list)

    if args.max_files < 1 or args.max_files > 2000 or args.max_bytes < 1 or args.max_bytes > 2 * 1024 * 1024 * 1024:
        raise ValueError("Office 图片提取安全上限无效")
    results = [extract_document(document, args.max_files, args.max_bytes, cancel_file=args.cancel_file) for document in args.inputs]
    successful = [result for result in results if result.get("success")]
    failed = [result for result in results if not result.get("success")]
    payload = {
        "success": bool(successful) or not failed,
        "documentCount": len(results),
        "successfulCount": len(successful),
        "failedCount": len(failed),
        "imageCount": sum(int(result.get("count", 0)) for result in successful),
        "results": results,
    }
    if failed and not successful:
        payload["error"] = str(failed[0].get("error") or "提取图片失败")
    # The Electron protocol is UTF-8 in development and packaged builds. Writing
    # bytes avoids the Windows redirected-stdout code page, while compact Unicode
    # JSON keeps a 2000-image result substantially smaller than ASCII escaping.
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(encoded + b"\n")


if __name__ == "__main__":
    run(sys.argv[1:])
