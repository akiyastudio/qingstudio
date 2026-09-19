"""Decode and resize image/RAW previews outside Electron's main process."""

from __future__ import annotations

import argparse
import io
import json
import mmap
import os
import sys
import time
import errno
import uuid
from pathlib import Path

from PIL import Image, ImageOps

MAX_OUTPUTS = 32
MAX_OUTPUT_PIXELS = 16384
STAGING_DIRECTORY = ".photoflow-thumbnail-staging"


class InvalidRequestError(ValueError):
    code = "EINVALIDREQUEST"


class OutputError(OSError):
    def __init__(self, error: Exception):
        super().__init__(str(error))
        self.code = "ENOSPC" if isinstance(error, OSError) and error.errno == errno.ENOSPC else "EPERM" if isinstance(error, PermissionError) else "EOUTPUT"


def _error_code(error: Exception) -> str:
    code = getattr(error, "code", None)
    if code:
        return str(code)
    if isinstance(error, PermissionError):
        return "EPERM"
    if isinstance(error, OSError) and error.errno == errno.ENOSPC:
        return "ENOSPC"
    if isinstance(error, Image.DecompressionBombError):
        return "EINVALIDREQUEST"
    return "EIMAGEDECODE"


def _is_link_or_junction(path: Path) -> bool:
    return path.is_symlink() or bool(getattr(os.path, "isjunction", lambda _path: False)(path))


def _validated_outputs(outputs: list[dict]) -> list[dict]:
    if not isinstance(outputs, list) or not outputs or len(outputs) > MAX_OUTPUTS:
        raise InvalidRequestError("图片输出数量无效")
    validated = []
    for output in outputs:
        if not isinstance(output, dict) or not output.get("sizeLabel") or not output.get("path"):
            raise InvalidRequestError("图片输出参数无效")
        pixels = int(output.get("pixels", -1))
        if pixels < 0 or pixels > MAX_OUTPUT_PIXELS:
            raise InvalidRequestError("图片输出尺寸超出限制")
        target = Path(str(output["path"]))
        if not target.is_absolute():
            raise InvalidRequestError("图片输出路径必须为绝对路径")
        if _is_link_or_junction(target):
            raise InvalidRequestError("拒绝将图片写入符号链接")
        target = Path(os.path.abspath(target))
        validated.append({**output, "pixels": pixels, "path": str(target)})
    return validated


def _staged_path(target: Path) -> Path:
    staging = target.parent / STAGING_DIRECTORY
    if _is_link_or_junction(staging):
        raise OutputError(PermissionError("缩略图临时目录不能是符号链接"))
    staging.mkdir(mode=0o700, parents=True, exist_ok=True)
    if _is_link_or_junction(staging):
        raise OutputError(PermissionError("缩略图临时目录不能是符号链接"))
    now = time.time()
    for candidate in staging.glob("*.tmp"):
        try:
            if candidate.is_file() and not _is_link_or_junction(candidate) and now - candidate.stat().st_mtime > 24 * 60 * 60:
                candidate.unlink()
        except OSError:
            pass
    return staging / f"{uuid.uuid4().hex}.tmp"

HEIF_EXTENSIONS = {".heic", ".heif", ".hif", ".avif"}
HEIF_DECODER_AVAILABLE = False
try:
    from pi_heif import register_heif_opener
except ImportError:
    register_heif_opener = None
else:
    # Pillow does not decode HEIC/HEIF by itself. Register pi-heif once when it
    # is available, while keeping ordinary image and RAW workers usable in a
    # lightweight development environment.
    register_heif_opener(thumbnails=False)
    HEIF_DECODER_AVAILABLE = True


def _embedded_jpeg(source_path: str) -> Image.Image:
    best: tuple[int, int] | None = None
    with open(source_path, "rb") as source:
        with mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ) as mapped:
            start = mapped.find(b"\xff\xd8")
            while start >= 0:
                end = mapped.find(b"\xff\xd9", start + 2)
                if end < 0:
                    break
                length = end + 2 - start
                if best is None or length > best[1]:
                    best = (start, length)
                start = mapped.find(b"\xff\xd8", end + 2)
            if best is None or best[1] < 8 * 1024:
                raise ValueError("RAW 文件中没有可用的内嵌 JPEG 预览")
            payload = mapped[best[0]:best[0] + best[1]]
    with Image.open(io.BytesIO(payload)) as embedded:
        return embedded.copy()


def _open_source(source_path: str, kind: str) -> Image.Image:
    if kind == "raw":
        return _embedded_jpeg(source_path)
    if Path(source_path).suffix.lower() in HEIF_EXTENSIONS and not HEIF_DECODER_AVAILABLE:
        raise RuntimeError("HEIC/HEIF/HIF/AVIF 预览需要安装 pi-heif 解码依赖")
    with Image.open(source_path) as source:
        source.seek(0)
        return ImageOps.exif_transpose(source).copy()


def _rgb(image: Image.Image) -> Image.Image:
    if image.mode == "RGB":
        return image
    if "A" in image.getbands():
        background = Image.new("RGB", image.size, "white")
        background.paste(image, mask=image.getchannel("A"))
        return background
    return image.convert("RGB")


def generate(source_path: str, kind: str, outputs: list[dict]) -> list[dict]:
    outputs = _validated_outputs(outputs)
    opened = _open_source(source_path, kind)
    embedded_orientation = int(opened.getexif().get(274, 1)) if kind == "raw" else 1
    if embedded_orientation < 1 or embedded_orientation > 8:
        embedded_orientation = 1
    image = _rgb(opened)
    if image is not opened:
        opened.close()
    generated = []
    try:
        for output in sorted(outputs, key=lambda item: int(item["pixels"]), reverse=True):
            target = os.path.abspath(output["path"])
            pixels = int(output["pixels"])
            if _is_link_or_junction(Path(target)):
                raise OutputError(PermissionError("拒绝将图片写入符号链接"))
            try:
                Path(target).parent.mkdir(parents=True, exist_ok=True)
            except OSError as error:
                raise OutputError(error) from error
            if not os.path.exists(target):
                resized = image.copy()
                if pixels > 0:
                    resized.thumbnail((pixels, pixels), Image.Resampling.LANCZOS)
                temporary = None
                owns_temporary = False
                try:
                    temporary = _staged_path(Path(target))
                    save_options = {"format": "JPEG", "quality": 84 if pixels >= 960 else 80,
                                    "optimize": True, "progressive": True}
                    if kind == "raw":
                        exif = Image.Exif()
                        exif[274] = embedded_orientation
                        exif[305] = f"PhotoFlow embedded-preview-v2 orientation={embedded_orientation}"
                        save_options["exif"] = exif
                    output_file = temporary.open("xb")
                    owns_temporary = True
                    with output_file:
                        resized.save(output_file, **save_options)
                        output_file.flush()
                        os.fsync(output_file.fileno())
                    os.replace(temporary, target)
                    owns_temporary = False
                except OutputError:
                    raise
                except Exception as error:
                    raise OutputError(error) from error
                finally:
                    if owns_temporary and temporary is not None and not _is_link_or_junction(temporary):
                        temporary.unlink(missing_ok=True)
                    resized.close()
            generated.append({"sizeLabel": output["sizeLabel"], "pixelSize": pixels, "path": target})
    finally:
        image.close()
    return generated


def run_server() -> None:
    # Electron writes JSONL through UTF-8 pipes. On Chinese Windows, Python's
    # redirected stdio can otherwise inherit the legacy system code page and
    # corrupt paths before json.loads sees them.
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            generated = generate(request["source"], request.get("kind", "image"), request["outputs"])
            response = {"id": request.get("id"), "success": True, "generated": generated}
        except Exception as error:
            response = {"id": request.get("id") if isinstance(request, dict) else None,
                        "success": False, "error": str(error),
                        "code": _error_code(error)}
        print(json.dumps(response, ensure_ascii=False), flush=True)


def run(args_list=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", action="store_true")
    parser.add_argument("--source")
    parser.add_argument("--kind", choices=("image", "raw"), default="image")
    parser.add_argument("--outputs")
    args = parser.parse_args(args_list)
    if args.server:
        run_server()
        return
    if not args.source or not args.outputs:
        parser.error("--source and --outputs are required outside server mode")
    outputs = json.loads(args.outputs)
    result = generate(args.source, args.kind, outputs)
    print(json.dumps({"generated": result}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    run()
