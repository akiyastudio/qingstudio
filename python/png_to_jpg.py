import os
import sys
import argparse
import errno
import uuid
from io import BytesIO
from pathlib import Path
from event_protocol import emit, log_error, log_info, log_progress, log_success, log_warning
from PIL import Image, ImageCms, ImageOps
from send2trash import send2trash


CONVERTIBLE_EXTENSIONS = {
    ".png", ".webp", ".heic", ".heif", ".hif", ".avif",
    ".tif", ".tiff", ".bmp", ".gif",
}
CONVERTIBLE_FORMATS = {"PNG", "WEBP", "HEIF", "AVIF", "TIFF", "BMP", "GIF"}

try:
    from pi_heif import register_heif_opener
except ImportError:
    register_heif_opener = None
else:
    register_heif_opener(thumbnails=False)


# 所有输出统一为 sRGB；这是网页和大多数 Windows 软件的默认色彩空间。
_SRGB_PROFILE = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
_SRGB_ICC_PROFILE = _SRGB_PROFILE.tobytes()
_LINK_FALLBACK_ERRORS = {
    errno.EPERM, errno.EACCES, errno.EXDEV, errno.EINVAL, errno.ENOSYS,
    errno.EOPNOTSUPP, getattr(errno, "ENOTSUP", errno.EOPNOTSUPP),
}


def _publication_marker(destination):
    return destination.with_name(f".{destination.name}.photoflow-publishing")


class PublicationUnsupportedError(OSError):
    code = "atomic_no_replace_unsupported"

    def __init__(self, staging):
        self.recovery_path = str(staging)
        super().__init__(errno.EOPNOTSUPP, "文件系统不支持安全的排他原子发布；完整 staging 已保留")


def publish_file_no_replace(staging, destination):
    try:
        os.link(staging, destination)
        staging.unlink()
        return
    except FileExistsError:
        raise
    except OSError as error:
        if error.errno not in _LINK_FALLBACK_ERRORS:
            raise
    raise PublicationUnsupportedError(staging)


def flatten_transparency(img):
    """将透明像素合成到白色背景，避免 JPEG 中出现黑底。"""
    if "A" not in img.getbands() and "transparency" not in img.info:
        return img
    rgba = img.convert("RGBA")
    try:
        background = Image.new("RGBA", rgba.size, "white")
        try:
            background.alpha_composite(rgba)
            return background.convert("RGB")
        finally:
            background.close()
    finally:
        rgba.close()


def convert_to_srgb(img):
    """将带 ICC 配置文件的图片转换为 sRGB，其他图片按 sRGB 处理。"""
    source_icc_profile = img.info.get("icc_profile")
    flattened = flatten_transparency(img)
    try:
        if not source_icc_profile:
            return flattened.convert("RGB")
        source_profile = ImageCms.ImageCmsProfile(BytesIO(source_icc_profile))
        return ImageCms.profileToProfile(
            flattened, source_profile, _SRGB_PROFILE, outputMode="RGB"
        )
    except (ImageCms.PyCMSError, OSError, ValueError):
        # 配置文件损坏时保持原先的兼容行为，避免一张异常图片中断整个批处理。
        return flattened.convert("RGB")
    finally:
        if flattened is not img:
            flattened.close()


def safe_exif_bytes(image):
    """Keep descriptive/time EXIF while dropping geometry invalidated by conversion."""
    exif = image.getexif()
    for tag in (256, 257, 274, 40962, 40963):
        exif.pop(tag, None)
    return exif.tobytes() if exif else None


def has_convertible_signature(file_path):
    """兼容扩展名错误的常见图片，同时避免对目录中的每个文件做完整解码。"""
    try:
        with open(file_path, "rb") as source:
            header = source.read(16)
    except OSError:
        return False
    if header.startswith((b"\x89PNG\r\n\x1a\n", b"GIF87a", b"GIF89a", b"BM", b"II*\x00", b"MM\x00*")):
        return True
    if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        return True
    return len(header) >= 12 and header[4:8] == b"ftyp" and header[8:12] in {
        b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis",
        b"mif1", b"msf1", b"avif", b"avis",
    }


def is_conversion_candidate(file_path):
    return Path(file_path).suffix.lower() in CONVERTIBLE_EXTENSIONS or has_convertible_signature(file_path)


def unique_jpg_path(file_path):
    source = Path(file_path)
    preferred = source.with_suffix(".jpg")
    if not preferred.exists() and not _publication_marker(preferred).exists():
        return preferred
    fallback = source.with_name(f"{source.stem}_转换.jpg")
    if not fallback.exists() and not _publication_marker(fallback).exists():
        return fallback
    index = 2
    while True:
        candidate = source.with_name(f"{source.stem}_转换_{index}.jpg")
        if not candidate.exists() and not _publication_marker(candidate).exists():
            return candidate
        index += 1


def save_verified_jpeg(image, target, quality):
    temporary = target.with_name(f".{target.name}.photoflow-{uuid.uuid4().hex}.tmp")
    preserve_staging = False
    try:
        save_options = {
            "quality": max(1, min(100, quality)),
            "icc_profile": _SRGB_ICC_PROFILE,
        }
        for key in ("dpi", "exif"):
            value = image.info.get(key)
            if value:
                save_options[key] = value
        image.save(
            temporary,
            "JPEG",
            **save_options,
        )
        with temporary.open("r+b") as staged:
            os.fsync(staged.fileno())
        with Image.open(temporary) as verification:
            verification.load()
            if verification.format != "JPEG":
                raise OSError("生成文件未通过 JPG 格式验证")
        # A hard-link publishes the fully verified same-directory staging file
        # atomically and, unlike replace(), fails if another process won the name.
        try:
            publish_file_no_replace(temporary, target)
        except PublicationUnsupportedError:
            preserve_staging = True
            raise
    finally:
        if temporary.exists() and not preserve_staging:
            temporary.unlink()

def run(args_list):
    if sys.platform.startswith('win'):
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding='utf-8')
        if hasattr(sys.stderr, "reconfigure"):
            sys.stderr.reconfigure(encoding='utf-8')

    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs='+', help="要处理的文件或目录路径")
    parser.add_argument("--quality", type=int, default=100)
    parser.add_argument("--keep-original", action="store_true")
    args = parser.parse_args(args_list)

    # 扫描所选文件以及所选目录的全部子目录。路径可能同时包含父目录、
    # 子目录和其中的文件，因此稍后以规范化绝对路径去重。
    candidate_files = []
    for raw_path in args.paths:
        target_path = raw_path.strip('"')
        if os.path.isfile(target_path):
            candidate_files.append(target_path)
            continue
        if os.path.isdir(target_path):
            try:
                for directory, directory_names, file_names in os.walk(target_path):
                    directory_names[:] = [
                        name for name in directory_names
                        if not os.path.islink(os.path.join(directory, name))
                    ]
                    candidate_files.extend(os.path.join(directory, name) for name in file_names)
            except OSError as error:
                log_error(f"无法读取目录 '{target_path}': {str(error)}")
                return
            continue
        log_error(f"路径不存在：'{target_path}'")
        return

    # 不只看扩展名：部分素材扩展名错误，但内容仍是受支持的图片格式。
    image_files = []
    seen_paths = set()
    for file_path in candidate_files:
        normalized_path = os.path.normcase(os.path.abspath(file_path))
        if normalized_path in seen_paths or not os.path.isfile(file_path):
            continue
        seen_paths.add(normalized_path)
        if is_conversion_candidate(file_path):
            image_files.append(file_path)
    total_files = len(image_files)

    if total_files == 0:
        log_success("所选文件或文件夹中未发现可转换的图片。")
        return

    log_info(f"找到 {total_files} 个可转换图片，准备开始转换...")

    success_count = 0
    failures = []

    for index, file_path in enumerate(image_files):
        filename = os.path.basename(file_path)
        try:
            with Image.open(file_path) as img:
                img.seek(0)
                if img.format not in CONVERTIBLE_FORMATS:
                    raise ValueError(f"不支持的图片格式：{img.format or '未知'}")
                frame_count = int(getattr(img, "n_frames", 1) or 1)
                protect_multiframe = frame_count > 1
                if frame_count > 1:
                    log_warning(
                        f"检测到多帧图片，将按现有行为仅转换首帧：{filename}",
                        data={
                            "code": "multi_frame_first_frame",
                            "input": str(Path(file_path).resolve()),
                            "format": img.format,
                            "frameCount": frame_count,
                            "sourceProtected": True,
                        },
                    )
                oriented = ImageOps.exif_transpose(img)
                # Preserve metadata that remains safe and meaningful for JPEG.
                if img.info.get("dpi"):
                    oriented.info["dpi"] = img.info["dpi"]
                safe_exif = safe_exif_bytes(img)
                if safe_exif:
                    oriented.info["exif"] = safe_exif
                rgb_img = convert_to_srgb(oriented)
                for key in ("dpi", "exif"):
                    if oriented.info.get(key):
                        rgb_img.info[key] = oriented.info[key]
                try:
                    while True:
                        jpg_file_path = unique_jpg_path(file_path)
                        try:
                            save_verified_jpeg(rgb_img, jpg_file_path, args.quality)
                            break
                        except FileExistsError:
                            continue
                finally:
                    if rgb_img is not oriented:
                        rgb_img.close()
                    if oriented is not img:
                        oriented.close()

            try:
                source_stat = os.stat(file_path)
                os.utime(jpg_file_path, ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns))
            except OSError as metadata_error:
                log_warning(
                    f"JPG 已成功发布，但无法保留文件时间：{filename}",
                    data={"code": "timestamp_preservation_failed", "output": str(jpg_file_path), "detail": str(metadata_error)},
                )

            if not args.keep_original and not protect_multiframe:
                # 只有 JPG 成功写入并通过解码验证后才处理原文件。
                send2trash(file_path)

            success_count += 1

            percent = int(((index + 1) / total_files) * 100)
            log_progress(f"转换完成: {filename} -> {jpg_file_path.name}", percent)

        except Exception as e:
            failure_data = {
                "input": str(Path(file_path).resolve()),
                "detail": str(e),
            }
            if isinstance(e, PublicationUnsupportedError):
                failure_data.update({
                    "code": e.code,
                    "recoveryPath": e.recovery_path,
                })
            else:
                failure_data["code"] = "conversion_failed"
            failures.append(failure_data)
            emit("warning", f"转换失败 '{filename}': {str(e)}", data=failure_data)

    terminal_data = {
        "successCount": success_count,
        "failedCount": len(failures),
        "totalCount": total_files,
    }
    if success_count == total_files:
        log_success(f"处理完成！成功转换 {success_count}/{total_files} 个文件。", terminal_data)
    elif success_count:
        emit("partial", f"部分处理完成：成功转换 {success_count}/{total_files} 个文件。", data={
            **terminal_data,
            "failedSources": [failure["input"] for failure in failures],
        })
    else:
        emit("error", f"处理失败：成功转换 0/{total_files} 个文件。", data={
            **terminal_data,
            "failedSources": [failure["input"] for failure in failures],
        })

if __name__ == "__main__":
    try:
        run(sys.argv[1:])
    except Exception as e:
        log_error(f"脚本运行出错: {str(e)}")
