"""Extract the main artwork rectangle from screenshots without overwriting inputs."""

from __future__ import annotations

import argparse
import errno
import json
import os
import uuid
from pathlib import Path

import cv2
import numpy as np
from PIL import Image


SUPPORTED_EXTENSIONS = {".bmp", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"}
MAX_ANALYSIS_EDGE = 1400
MIN_CONFIDENCE = 0.58
MAX_IMAGE_PIXELS = 100_000_000
MAX_COMPRESSED_BYTES = 512 * 1024 * 1024
MAX_DECODED_BYTES = 384 * 1024 * 1024
MAX_TOTAL_WORKING_BYTES = 512 * 1024 * 1024
ANALYSIS_BYTES_PER_PIXEL = 64
_LINK_FALLBACK_ERRORS = {
    errno.EPERM, errno.EACCES, errno.EXDEV, errno.EINVAL, errno.ENOSYS,
    errno.EOPNOTSUPP, getattr(errno, "ENOTSUP", errno.EOPNOTSUPP),
}


def _read_image(path: Path) -> np.ndarray:
    data = np.fromfile(path, dtype=np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
    if image is None:
        raise ValueError("无法读取图片；当前仅支持 JPG、PNG、BMP、WebP 和 TIFF")
    return image


def _probe_image(path: Path) -> tuple[int, int]:
    if path.stat().st_size > MAX_COMPRESSED_BYTES:
        raise ValueError("图片压缩文件大小超过安全上限")
    try:
        with Image.open(path) as probe:
            width, height = probe.size
    except (OSError, ImportError):
        if path.suffix.lower() != ".webp":
            raise
        width, height = _probe_webp_without_pillow(path)
    if width < 1 or height < 1 or width * height > MAX_IMAGE_PIXELS:
        raise ValueError("图片像素数量超过安全上限")
    return width, height


def _probe_webp_without_pillow(path: Path) -> tuple[int, int]:
    with path.open("rb") as source:
        header = source.read(32)
    if len(header) >= 30 and header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        chunk = header[12:16]
        if chunk == b"VP8X" and len(header) >= 30:
            return int.from_bytes(header[24:27], "little") + 1, int.from_bytes(header[27:30], "little") + 1
        if chunk == b"VP8L" and len(header) >= 25 and header[20] == 0x2F:
            bits = int.from_bytes(header[21:25], "little")
            return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
        if chunk == b"VP8 " and header[23:26] == b"\x9d\x01\x2a":
            return int.from_bytes(header[26:28], "little") & 0x3FFF, int.from_bytes(header[28:30], "little") & 0x3FFF
    decoded = _read_image(path)
    return decoded.shape[1], decoded.shape[0]


def _publish_file_no_replace(staging: Path, destination: Path) -> None:
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


class PublicationUnsupportedError(OSError):
    code = "atomic_no_replace_unsupported"

    def __init__(self, staging: Path):
        self.recovery_path = str(staging)
        super().__init__(errno.EOPNOTSUPP, "文件系统不支持安全的排他原子发布；完整 staging 已保留")


def _analysis_bgr(image: np.ndarray) -> np.ndarray:
    if image.dtype != np.uint8:
        maximum = float(np.iinfo(image.dtype).max) if np.issubdtype(image.dtype, np.integer) else 1.0
        image = np.clip(image.astype(np.float32) * (255.0 / maximum), 0, 255).astype(np.uint8)
    if image.ndim == 2:
        return cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    if image.shape[2] == 4:
        return cv2.cvtColor(image, cv2.COLOR_BGRA2BGR)
    if image.shape[2] == 3:
        return image
    raise ValueError("图片通道格式不受支持")


def _estimated_decoded_bytes(path: Path, width: int, height: int) -> int:
    if path.suffix.lower() == ".png":
        with path.open("rb") as source:
            header = source.read(29)
        if len(header) >= 26 and header[:8] == b"\x89PNG\r\n\x1a\n":
            bit_depth, color_type = header[24], header[25]
            # OpenCV expands palette images conservatively to BGR/BGRA and
            # grayscale+alpha PNGs to BGRA, including 16-bit type 4 images.
            channels = {0: 1, 2: 3, 3: 4, 4: 4, 6: 4}.get(color_type, 4)
            return width * height * channels * max(1, (bit_depth + 7) // 8)
    bytes_per_pixel = 4
    try:
        with Image.open(path) as probe:
            if path.suffix.lower() in {".tif", ".tiff"}:
                bits = probe.tag_v2.get(258, (16,))
                samples = int(probe.tag_v2.get(277, 4) or 4)
                if samples == 2:
                    # OpenCV commonly expands grayscale+alpha TIFF to BGRA.
                    samples = 4
                if isinstance(bits, int):
                    bits = (bits,)
                bytes_per_sample = max(1, (max(int(value) for value in bits) + 7) // 8)
                return width * height * samples * bytes_per_sample
            bytes_per_pixel = {
                "1": 1, "L": 1, "P": 1, "LA": 2, "RGB": 3, "RGBA": 4,
                "I;16": 2, "I;16B": 2, "I;16L": 2, "I": 4, "F": 4,
            }.get(probe.mode, 8)
    except (OSError, ImportError):
        pass
    return width * height * bytes_per_pixel


def _smooth(values: np.ndarray, window: int) -> np.ndarray:
    window = max(3, int(window) | 1)
    return cv2.GaussianBlur(values.reshape(-1, 1).astype(np.float32), (1, window), 0).reshape(-1)


def _segments(mask: np.ndarray, minimum: int) -> list[tuple[int, int]]:
    padded = np.pad(mask.astype(np.int8), (1, 1))
    changes = np.flatnonzero(np.diff(padded))
    return [(int(start), int(end)) for start, end in changes.reshape(-1, 2) if end - start >= minimum]


def _merge_segments(parts: list[tuple[int, int]], maximum_gap: int) -> list[tuple[int, int]]:
    merged: list[list[int]] = []
    for start, end in sorted(parts):
        if merged and start - merged[-1][1] <= maximum_gap:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [(start, end) for start, end in merged]


def _analysis_maps(image: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32)
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    size = max(5, (min(image.shape[:2]) // 90) | 1)
    mean = cv2.boxFilter(gray, -1, (size, size), normalize=True)
    mean_square = cv2.boxFilter(gray * gray, -1, (size, size), normalize=True)
    local_std = np.sqrt(np.maximum(0.0, mean_square - mean * mean))
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    gradient = cv2.magnitude(gx, gy)
    saturation = hsv[:, :, 1].astype(np.float32)
    active = ((local_std > 9.0) | (saturation > 34.0) | (gradient > 65.0)).astype(np.uint8)
    return gray, local_std, gradient, active


def _neutral_edge_backgrounds(image: np.ndarray) -> list[np.ndarray]:
    """Return likely black/white app-canvas colors sampled from the corners."""
    height, width = image.shape[:2]
    sample_height = max(8, height // 18)
    sample_width = max(8, width // 18)
    blocks = (
        image[:sample_height, :sample_width],
        image[:sample_height, width - sample_width:],
        image[height - sample_height:, :sample_width],
        image[height - sample_height:, width - sample_width:],
    )
    colors: list[np.ndarray] = []
    for block in blocks:
        color = np.median(block.reshape(-1, 3), axis=0).astype(np.float32)
        if float(color.max() - color.min()) > 18.0 or 45.0 <= float(color.mean()) <= 210.0:
            continue
        if not any(float(np.max(np.abs(color - saved))) < 14.0 for saved in colors):
            colors.append(color)
    return colors


def _background_panel_candidates(
    image: np.ndarray,
    min_width: int,
    min_height: int,
) -> list[tuple[int, int, int, int]]:
    """Find media rectangles set against a neutral social-app background.

    Fixed-source screenshots are commonly either a white feed page or a black
    immersive viewer.  Text and controls occupy too little of a row to look
    like a panel, while the main image differs from the app canvas across a
    large, continuous rectangle.
    """
    height, width = image.shape[:2]
    candidates: list[tuple[int, int, int, int]] = []
    image_float = image.astype(np.float32)
    for background in _neutral_edge_backgrounds(image):
        foreground = np.max(np.abs(image_float - background), axis=2) >= 24.0
        row_occupancy = _smooth(foreground.mean(axis=1), max(3, height // 220))
        row_parts = _merge_segments(
            _segments(row_occupancy > 0.28, max(5, height // 140)),
            max(5, height // 35),
        )
        for top, bottom in row_parts:
            if bottom - top < min_height:
                continue
            column_occupancy = _smooth(foreground[top:bottom].mean(axis=0), max(3, width // 180))
            column_parts = _merge_segments(
                _segments(column_occupancy > 0.24, max(5, width // 120)),
                max(4, width // 45),
            )
            for left, right in column_parts:
                if right - left < min_width:
                    continue
                support = float(foreground[top:bottom, left:right].mean())
                if support >= 0.24:
                    candidates.append((left, top, right, bottom))
    return candidates


def _candidate_rectangles(
    image: np.ndarray,
    maps: tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray] | None = None,
    differences: tuple[np.ndarray, np.ndarray] | None = None,
) -> list[tuple[int, int, int, int]]:
    height, width = image.shape[:2]
    _gray, _local_std, _gradient, active = maps or _analysis_maps(image)
    min_height = max(24, int(height * 0.13))
    min_width = max(24, int(width * 0.34))
    row_activity = _smooth(active.mean(axis=1), max(5, height // 90))
    adaptive_row_threshold = float(np.clip(np.percentile(row_activity, 58) * 0.78, 0.16, 0.46))
    row_parts = _merge_segments(
        _segments(row_activity > adaptive_row_threshold, max(8, height // 45)),
        max(4, height // 45),
    )

    candidates: list[tuple[int, int, int, int]] = []
    candidates.extend(_background_panel_candidates(image, min_width, min_height))
    for top, bottom in row_parts:
        if bottom - top < min_height:
            continue
        band_active = active[top:bottom]
        column_activity = _smooth(band_active.mean(axis=0), max(5, width // 100))
        column_threshold = float(np.clip(np.percentile(column_activity, 55) * 0.68, 0.12, 0.40))
        column_parts = _merge_segments(
            _segments(column_activity > column_threshold, max(8, width // 60)),
            max(4, width // 35),
        )
        plausible = [(left, right) for left, right in column_parts if right - left >= min_width]
        if plausible:
            left, right = max(plausible, key=lambda part: part[1] - part[0])
        else:
            left, right = 0, width
        candidates.append((left, top, right, bottom))

    # Closed texture regions are useful when the artwork is inset from a uniform app background.
    kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT,
        (max(3, width // 55), max(3, height // 80)),
    )
    region_mask = cv2.morphologyEx(active * 255, cv2.MORPH_CLOSE, kernel, iterations=2)
    region_mask = cv2.morphologyEx(region_mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(region_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        left, top, candidate_width, candidate_height = cv2.boundingRect(contour)
        if candidate_width >= min_width and candidate_height >= min_height:
            candidates.append((left, top, left + candidate_width, top + candidate_height))

    # Strong horizontal transitions often mark the media boundaries in social-app screenshots.
    row_difference = differences[0] if differences is not None else np.mean(np.abs(np.diff(image.astype(np.float32), axis=0)), axis=(1, 2))
    row_difference = _smooth(row_difference, max(3, height // 240))
    peak_threshold = max(float(np.percentile(row_difference, 82)), float(row_difference.mean() + row_difference.std() * 0.45))
    peak_indexes = np.flatnonzero(row_difference >= peak_threshold) + 1
    grouped_peaks = _merge_segments([(int(index), int(index) + 1) for index in peak_indexes], max(3, height // 100))
    peak_centers = [int((start + end) / 2) for start, end in grouped_peaks]
    if len(peak_centers) > 28:
        peak_centers = sorted(
            peak_centers,
            key=lambda center: row_difference[min(len(row_difference) - 1, max(0, center - 1))],
            reverse=True,
        )[:28]
    boundaries = [0, height, *peak_centers]
    boundaries = sorted(set(boundaries))
    row_scale = max(3.0, float(np.percentile(row_difference, 85)))
    for first_index, top in enumerate(boundaries):
        for bottom in boundaries[first_index + 1:]:
            candidate_height = bottom - top
            if candidate_height < min_height or candidate_height > height * 0.88:
                continue
            top_boundary = row_difference[max(0, top - 1)] if top else 0.0
            bottom_boundary = row_difference[min(len(row_difference) - 1, bottom - 1)] if bottom < height else 0.0
            pixel_boundary_threshold = max(18.0, row_scale * 1.5)
            top_boundary_coverage = 0.0 if not top else float(np.mean(
                np.mean(np.abs(image[top].astype(np.float32) - image[top - 1].astype(np.float32)), axis=1)
                >= pixel_boundary_threshold
            ))
            bottom_boundary_coverage = 0.0 if bottom >= height else float(np.mean(
                np.mean(np.abs(image[bottom].astype(np.float32) - image[bottom - 1].astype(np.float32)), axis=1)
                >= pixel_boundary_threshold
            ))
            if top > 0 and bottom < height:
                top_transition = np.mean(
                    np.abs(image[top].astype(np.float32) - image[top - 1].astype(np.float32)),
                    axis=1,
                ) >= pixel_boundary_threshold
                bottom_transition = np.mean(
                    np.abs(image[bottom].astype(np.float32) - image[bottom - 1].astype(np.float32)),
                    axis=1,
                ) >= pixel_boundary_threshold
                shared_transition = top_transition & bottom_transition
                transition_parts = _merge_segments(
                    _segments(shared_transition, max(6, width // 80)),
                    max(4, width // 40),
                )
                for left, right in transition_parts:
                    if right - left >= min_width and float(shared_transition[left:right].mean()) >= 0.62:
                        candidates.append((left, top, right, bottom))
            strong_horizontal_frame = (
                top > 0
                and bottom < height
                and top_boundary >= row_scale * 4.0
                and bottom_boundary >= row_scale * 4.0
                and top_boundary_coverage >= 0.94
                and bottom_boundary_coverage >= 0.94
            )
            if strong_horizontal_frame:
                # Sparse sketches and line art can have almost no texture away
                # from their strokes.  Their two full-width frame transitions
                # are still reliable evidence for the complete artwork panel.
                candidates.append((0, top, width, bottom))
            band_active = active[top:bottom]
            if float(band_active.mean()) < 0.19:
                continue
            column_activity = _smooth(band_active.mean(axis=0), max(5, width // 100))
            parts = _merge_segments(_segments(column_activity > 0.15, max(8, width // 70)), max(4, width // 40))
            plausible = [(left, right) for left, right in parts if right - left >= min_width]
            left, right = max(plausible, key=lambda part: part[1] - part[0]) if plausible else (0, width)
            candidates.append((left, top, right, bottom))

    # Deduplicate near-identical rectangles.
    column_difference = differences[1] if differences is not None else np.mean(np.abs(np.diff(image.astype(np.float32), axis=1)), axis=(0, 2))
    unique: list[tuple[int, int, int, int]] = []
    for rectangle in candidates:
        rectangle = _snap_rectangle_to_boundaries(image, rectangle, (row_difference, column_difference))
        rectangle = _expand_weak_single_sided_crops(
            rectangle,
            (row_difference, column_difference),
            width,
            height,
        )
        if rectangle[2] - rectangle[0] < min_width or rectangle[3] - rectangle[1] < min_height:
            continue
        if not any(sum(abs(a - b) for a, b in zip(rectangle, saved)) < (width + height) * 0.025 for saved in unique):
            unique.append(rectangle)
    return unique


def _snap_edge(values: np.ndarray, position: int, radius: int, maximum: int) -> int:
    if position <= 0 or position >= maximum:
        return position
    start = max(1, position - radius)
    end = min(maximum - 1, position + radius)
    if end <= start:
        return position
    window = values[start - 1:end]
    offset = int(np.argmax(window))
    strongest = float(window[offset])
    if strongest < max(3.0, float(np.percentile(values, 78)) * 1.35):
        return position
    return start + offset


def _snap_rectangle_to_boundaries(
    image: np.ndarray,
    rectangle: tuple[int, int, int, int],
    differences: tuple[np.ndarray, np.ndarray] | None = None,
) -> tuple[int, int, int, int]:
    height, width = image.shape[:2]
    left, top, right, bottom = rectangle
    if differences is None:
        row_difference = np.mean(np.abs(np.diff(image.astype(np.float32), axis=0)), axis=(1, 2))
        column_difference = np.mean(np.abs(np.diff(image.astype(np.float32), axis=1)), axis=(0, 2))
    else:
        row_difference, column_difference = differences
    return (
        _snap_edge(column_difference, left, max(4, width // 45), width),
        _snap_edge(row_difference, top, max(4, height // 45), height),
        _snap_edge(column_difference, right, max(4, width // 45), width),
        _snap_edge(row_difference, bottom, max(4, height // 45), height),
    )


def _expand_weak_single_sided_crops(
    rectangle: tuple[int, int, int, int],
    differences: tuple[np.ndarray, np.ndarray],
    width: int,
    height: int,
) -> tuple[int, int, int, int]:
    """Do not remove one side of a screenshot without a credible boundary.

    Texture masks frequently stop at the subject rather than at the edge of the
    actual picture.  When that happens the old detector could keep the outer
    edge on one side and cut through the artwork on the other.  Expanding a
    weak, single-sided crop is intentionally conservative: missing a little UI
    is preferable to deleting part of the main image.
    """
    row_difference, column_difference = differences
    left, top, right, bottom = rectangle
    row_threshold = max(3.0, float(np.percentile(row_difference, 78)) * 1.35)
    column_threshold = max(3.0, float(np.percentile(column_difference, 78)) * 1.35)

    if left > 0 and right >= width:
        if float(column_difference[min(len(column_difference) - 1, left - 1)]) < column_threshold:
            left = 0
    elif left <= 0 and right < width:
        if float(column_difference[min(len(column_difference) - 1, right - 1)]) < column_threshold:
            right = width

    if top > 0 and bottom >= height:
        if float(row_difference[min(len(row_difference) - 1, top - 1)]) < row_threshold:
            top = 0
    elif top <= 0 and bottom < height:
        if float(row_difference[min(len(row_difference) - 1, bottom - 1)]) < row_threshold:
            bottom = height
    return left, top, right, bottom


def _outside_strip_score(values: np.ndarray, rectangle: tuple[int, int, int, int]) -> float:
    left, top, right, bottom = rectangle
    height, width = values.shape[:2]
    strips: list[np.ndarray] = []
    pad_y = max(4, height // 40)
    pad_x = max(4, width // 40)
    if top:
        strips.append(values[max(0, top - pad_y):top, left:right])
    if bottom < height:
        strips.append(values[bottom:min(height, bottom + pad_y), left:right])
    if left:
        strips.append(values[top:bottom, max(0, left - pad_x):left])
    if right < width:
        strips.append(values[top:bottom, right:min(width, right + pad_x)])
    usable = [strip for strip in strips if strip.size]
    return float(np.mean([strip.mean() for strip in usable])) if usable else 0.0


def _panel_background_score(image: np.ndarray, rectangle: tuple[int, int, int, int]) -> float:
    """Measure whether a rectangle is a coherent panel on black/white app chrome."""
    left, top, right, bottom = rectangle
    height, width = image.shape[:2]
    pad_y = max(4, height // 45)
    pad_x = max(4, width // 45)
    strips: list[np.ndarray] = []
    if top:
        strips.append(image[max(0, top - pad_y):top, left:right])
    if bottom < height:
        strips.append(image[bottom:min(height, bottom + pad_y), left:right])
    if left:
        strips.append(image[top:bottom, max(0, left - pad_x):left])
    if right < width:
        strips.append(image[top:bottom, right:min(width, right + pad_x)])
    usable = [strip.reshape(-1, 3) for strip in strips if strip.size]
    if not usable:
        return 0.0
    outside = np.concatenate(usable, axis=0).astype(np.float32)
    background = np.median(outside, axis=0)
    if float(background.max() - background.min()) > 22.0 or 50.0 <= float(background.mean()) <= 205.0:
        return 0.0
    outside_match = float(np.mean(np.max(np.abs(outside - background), axis=1) < 20.0))
    inside = image[top:bottom, left:right].reshape(-1, 3).astype(np.float32)
    inside_difference = float(np.mean(np.max(np.abs(inside - background), axis=1) >= 24.0))
    outside_score = float(np.clip((outside_match - 0.45) / 0.45, 0.0, 1.0))
    inside_score = float(np.clip((inside_difference - 0.16) / 0.64, 0.0, 1.0))
    return outside_score * inside_score


def _score_candidate(
    image: np.ndarray,
    rectangle: tuple[int, int, int, int],
    maps: tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray] | None = None,
    differences: tuple[np.ndarray, np.ndarray] | None = None,
) -> tuple[float, dict[str, float]]:
    height, width = image.shape[:2]
    left, top, right, bottom = rectangle
    candidate_width = right - left
    candidate_height = bottom - top
    area_ratio = candidate_width * candidate_height / float(width * height)
    width_ratio = candidate_width / width
    height_ratio = candidate_height / height
    _gray, local_std, gradient, active = maps or _analysis_maps(image)
    inside_std = float(local_std[top:bottom, left:right].mean())
    outside_std = _outside_strip_score(local_std, rectangle)
    inside_gradient = float(gradient[top:bottom, left:right].mean())
    active_fraction = float(active[top:bottom, left:right].mean())
    row_coverage = active[top:bottom, left:right].mean(axis=1)
    continuity = float(np.mean(row_coverage > 0.20))
    contrast = float(np.clip((inside_std - outside_std + 5.0) / 30.0, 0.0, 1.0))
    panel = _panel_background_score(image, rectangle)
    texture = float(np.clip(inside_std / 34.0, 0.0, 1.0))
    edge = float(np.clip(inside_gradient / 120.0, 0.0, 1.0))
    activity = float(np.clip((active_fraction - 0.12) / 0.55, 0.0, 1.0))
    size_score = float(np.clip((area_ratio - 0.10) / 0.32, 0.0, 1.0))
    unpenalized_size_score = size_score
    if area_ratio > 0.82:
        size_score *= max(0.0, (0.96 - area_ratio) / 0.14)
    width_score = float(np.clip((width_ratio - 0.33) / 0.42, 0.0, 1.0))
    center_x = (left + right) / (2 * width)
    center_score = float(np.clip(1.0 - abs(center_x - 0.5) / 0.36, 0.0, 1.0))
    margin_ratio = (top + height - bottom + left + width - right) / float(2 * (width + height))
    margin_score = float(np.clip(margin_ratio / 0.075, 0.0, 1.0))
    if differences is None:
        row_difference = np.mean(np.abs(np.diff(image.astype(np.float32), axis=0)), axis=(1, 2))
        column_difference = np.mean(np.abs(np.diff(image.astype(np.float32), axis=1)), axis=(0, 2))
    else:
        row_difference, column_difference = differences
    row_scale = max(3.0, float(np.percentile(row_difference, 85)))
    column_scale = max(3.0, float(np.percentile(column_difference, 85)))
    boundary_values = [
        row_difference[max(0, top - 1)] if top else 0.0,
        row_difference[min(len(row_difference) - 1, bottom - 1)] if bottom < height else 0.0,
        column_difference[max(0, left - 1)] if left else 0.0,
        column_difference[min(len(column_difference) - 1, right - 1)] if right < width else 0.0,
    ]
    boundary = float(np.mean([
        np.clip(boundary_values[0] / (row_scale * 2.5), 0.0, 1.0),
        np.clip(boundary_values[1] / (row_scale * 2.5), 0.0, 1.0),
        np.clip(boundary_values[2] / (column_scale * 2.5), 0.0, 1.0),
        np.clip(boundary_values[3] / (column_scale * 2.5), 0.0, 1.0),
    ]))
    row_pixel_threshold = max(18.0, row_scale * 1.5)
    column_pixel_threshold = max(18.0, column_scale * 1.5)
    top_coverage = 0.0 if not top else float(np.mean(
        np.mean(np.abs(image[top].astype(np.float32) - image[top - 1].astype(np.float32)), axis=1)
        >= row_pixel_threshold
    ))
    bottom_coverage = 0.0 if bottom >= height else float(np.mean(
        np.mean(np.abs(image[bottom].astype(np.float32) - image[bottom - 1].astype(np.float32)), axis=1)
        >= row_pixel_threshold
    ))
    left_coverage = 0.0 if not left else float(np.mean(
        np.mean(np.abs(image[:, left].astype(np.float32) - image[:, left - 1].astype(np.float32)), axis=1)
        >= column_pixel_threshold
    ))
    right_coverage = 0.0 if right >= width else float(np.mean(
        np.mean(np.abs(image[:, right].astype(np.float32) - image[:, right - 1].astype(np.float32)), axis=1)
        >= column_pixel_threshold
    ))
    # A screenshot often contains a full-width image between a status/header
    # strip and a footer strip.  Two exceptionally strong opposing transitions
    # are much better frame evidence than a dense subject-shaped texture blob.
    horizontal_frame = (
        width_ratio >= 0.90
        and top > 0
        and bottom < height
        and boundary_values[0] >= row_scale * 4.0
        and boundary_values[1] >= row_scale * 4.0
        and min(top_coverage, bottom_coverage) >= 0.25
        and max(top_coverage, bottom_coverage) >= 0.82
    )
    vertical_frame = (
        height_ratio >= 0.90
        and left > 0
        and right < width
        and boundary_values[2] >= column_scale * 4.0
        and boundary_values[3] >= column_scale * 4.0
        and min(left_coverage, right_coverage) >= 0.25
        and max(left_coverage, right_coverage) >= 0.82
    )
    frame = 1.0 if horizontal_frame or vertical_frame else 0.0
    viewer_layout = 1.0 if (
        width_ratio >= 0.90
        and 0.025 <= top / height <= 0.13
        and 0.70 <= bottom / height <= 0.97
    ) else 0.0
    frame_strength = 0.0
    if horizontal_frame:
        frame_strength = float(np.mean([
            np.clip(boundary_values[0] / (row_scale * 40.0), 0.0, 1.0),
            np.clip(boundary_values[1] / (row_scale * 40.0), 0.0, 1.0),
        ]))
    elif vertical_frame:
        frame_strength = float(np.mean([
            np.clip(boundary_values[2] / (column_scale * 40.0), 0.0, 1.0),
            np.clip(boundary_values[3] / (column_scale * 40.0), 0.0, 1.0),
        ]))
    if frame or panel >= 0.55:
        size_score = unpenalized_size_score

    # A text-only note normally has many edges but low continuous texture and
    # low color activity.  Do not apply that penalty when two strong opposing
    # frame edges already identify the complete media panel: sparse line art is
    # intentionally low-texture and would otherwise look text-like here.
    text_like_penalty = 0.0
    if not frame and panel < 0.55:
        if continuity < 0.58:
            text_like_penalty += (0.58 - continuity) * 0.45
        if texture < 0.32 and edge > 0.20:
            text_like_penalty += 0.16
        if height_ratio < 0.18 or width_ratio < 0.40:
            text_like_penalty += 0.18

    score = (
        0.17 * size_score
        + 0.14 * texture
        + 0.10 * edge
        + 0.12 * activity
        + 0.12 * continuity
        + 0.09 * contrast
        + 0.20 * panel
        + 0.14 * boundary
        + 0.06 * width_score
        + 0.04 * center_score
        + 0.04 * margin_score
        + 0.28 * frame
        + 0.12 * frame_strength
        + 0.12 * viewer_layout
        - text_like_penalty
    )
    features = {
        "area": area_ratio,
        "texture": texture,
        "activity": activity,
        "continuity": continuity,
        "contrast": contrast,
        "panel": panel,
        "margin": margin_ratio,
        "boundary": boundary,
        "frame": frame,
        "frameStrength": frame_strength,
        "viewerLayout": viewer_layout,
    }
    return float(np.clip(score, 0.0, 1.0)), features


def _analyze_main_rectangle(image: np.ndarray) -> tuple[tuple[int, int, int, int], float, str, bool]:
    original_height, original_width = image.shape[:2]
    if original_height < 160 or original_width < 120:
        return (0, 0, original_width, original_height), 0.0, "图片尺寸过小，请手动确认范围", False
    scale = min(1.0, MAX_ANALYSIS_EDGE / max(original_height, original_width))
    bounded = image if scale == 1.0 else cv2.resize(
        image,
        (max(1, round(original_width * scale)), max(1, round(original_height * scale))),
        interpolation=cv2.INTER_AREA,
    )
    analysis = _analysis_bgr(bounded)
    maps = _analysis_maps(analysis)
    differences = (
        np.mean(np.abs(np.diff(analysis.astype(np.float32), axis=0)), axis=(1, 2)),
        np.mean(np.abs(np.diff(analysis.astype(np.float32), axis=1)), axis=(0, 2)),
    )
    candidates = _candidate_rectangles(analysis, maps, differences)
    if not candidates:
        return (0, 0, original_width, original_height), 0.0, "没有找到可信的主图区域，请手动调整", False
    scored = [(*_score_candidate(analysis, rectangle, maps, differences), rectangle) for rectangle in candidates]
    score, features, rectangle = max(scored, key=lambda item: (
        item[0],
        item[1]["panel"],
        item[1]["frameStrength"],
        item[1]["area"],
    ))
    height, width = analysis.shape[:2]
    left, top, right, bottom = rectangle
    removed_ratio = 1.0 - ((right - left) * (bottom - top) / float(width * height))
    inverse_scale = 1.0 / scale
    resolved = (
        max(0, round(left * inverse_scale)),
        max(0, round(top * inverse_scale)),
        min(original_width, round(right * inverse_scale)),
        min(original_height, round(bottom * inverse_scale)),
    )
    if removed_ratio < 0.06:
        return (0, 0, original_width, original_height), score, "候选范围接近整张截图，请手动确认", False
    if not features["frame"] and features["panel"] < 0.55 and (features["continuity"] < 0.44 or (
        features["texture"] < 0.16
        and features["activity"] < 0.28
        and features["boundary"] < 0.70
    )):
        return resolved, score, "画面更像文字或界面，请手动确认范围", False
    if score < MIN_CONFIDENCE:
        return resolved, score, "主图区域置信度不足，请手动确认范围", False
    if resolved[2] - resolved[0] < 80 or resolved[3] - resolved[1] < 80:
        return (0, 0, original_width, original_height), score, "检测到的区域过小，请手动调整", False
    # The frame itself is the main-image boundary.  Trimming uniform white or
    # black lines inside it would remove intentional canvas around sparse art.
    if features["frame"] or features["panel"] >= 0.55:
        return resolved, score, "", True
    if image.dtype == np.uint8 and image.ndim == 3 and image.shape[2] == 3:
        return _trim_uniform_borders(image, resolved), score, "", True
    return resolved, score, "", True


def detect_main_rectangle(image: np.ndarray) -> tuple[tuple[int, int, int, int] | None, float, str]:
    rectangle, score, reason, accepted = _analyze_main_rectangle(image)
    return (rectangle if accepted else None), score, reason


def _strong_axis_guides(image: np.ndarray, axis: int, maximum: int) -> list[int]:
    image_float = image.astype(np.float32)
    if axis == 0:
        differences = np.mean(np.abs(np.diff(image_float, axis=0)), axis=(1, 2))
    else:
        differences = np.mean(np.abs(np.diff(image_float, axis=1)), axis=(0, 2))
    smoothed = _smooth(differences, max(3, maximum // 320))
    threshold = max(4.0, float(np.percentile(smoothed, 82)), float(smoothed.mean() + smoothed.std() * 0.55))
    indexes = np.flatnonzero(smoothed >= threshold) + 1
    grouped = _merge_segments([(int(index), int(index) + 1) for index in indexes], max(2, maximum // 180))
    ranked = sorted(
        (int((start + end) / 2) for start, end in grouped),
        key=lambda position: float(smoothed[min(len(smoothed) - 1, max(0, position - 1))]),
        reverse=True,
    )[:16]
    return sorted(set([0, maximum, *ranked]))


def _snap_guides(image: np.ndarray, rectangle: tuple[int, int, int, int]) -> dict[str, list[int]]:
    height, width = image.shape[:2]
    scale = min(1.0, MAX_ANALYSIS_EDGE / max(height, width))
    bounded = image if scale == 1.0 else cv2.resize(
        image, (max(1, round(width * scale)), max(1, round(height * scale))), interpolation=cv2.INTER_AREA
    )
    analysis = _analysis_bgr(bounded)
    analysis_height, analysis_width = analysis.shape[:2]
    inverse = 1.0 / scale
    left, top, right, bottom = rectangle
    return {
        "x": sorted(set([left, right, *(min(width, round(value * inverse)) for value in _strong_axis_guides(analysis, 1, analysis_width))])),
        "y": sorted(set([top, bottom, *(min(height, round(value * inverse)) for value in _strong_axis_guides(analysis, 0, analysis_height))])),
    }


def _trim_uniform_borders(image: np.ndarray, rectangle: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    left, top, right, bottom = rectangle
    crop = image[top:bottom, left:right]
    height, width = crop.shape[:2]
    if height < 120 or width < 120:
        return rectangle

    def uniform_line(line: np.ndarray) -> bool:
        flattened = line.reshape(-1, 3).astype(np.float32)
        channel_mean = flattened.mean(axis=0)
        return bool(flattened.std(axis=0).max() < 4.0 and (channel_mean.max() < 11.0 or channel_mean.min() > 244.0))

    maximum_y = max(1, int(height * 0.18))
    maximum_x = max(1, int(width * 0.18))
    top_trim = next((index for index in range(maximum_y) if not uniform_line(crop[index:index + 1, :])), maximum_y)
    bottom_trim = next((index for index in range(maximum_y) if not uniform_line(crop[height - index - 1:height - index, :])), maximum_y)
    left_trim = next((index for index in range(maximum_x) if not uniform_line(crop[:, index:index + 1])), maximum_x)
    right_trim = next((index for index in range(maximum_x) if not uniform_line(crop[:, width - index - 1:width - index])), maximum_x)
    if top_trim < max(2, int(height * 0.008)):
        top_trim = 0
    if bottom_trim < max(2, int(height * 0.008)):
        bottom_trim = 0
    if left_trim < max(2, int(width * 0.008)):
        left_trim = 0
    if right_trim < max(2, int(width * 0.008)):
        right_trim = 0
    if width - left_trim - right_trim < 80 or height - top_trim - bottom_trim < 80:
        return rectangle
    return left + left_trim, top + top_trim, right - right_trim, bottom - bottom_trim


def _unique_output_path(source: Path, label: str = "主图") -> Path:
    suffix = source.suffix.lower() if source.suffix.lower() in SUPPORTED_EXTENSIONS else ".png"
    for index in range(1, 10000):
        extra = "" if index == 1 else f"_{index}"
        candidate = source.with_name(f"{source.stem}_{label}{extra}{suffix}")
        marker = candidate.with_name(f".{candidate.name}.photoflow-publishing")
        if not candidate.exists() and not marker.exists():
            return candidate
    raise RuntimeError("无法创建唯一的输出文件名")


def _safe_metadata(source: Path | None) -> dict[str, object]:
    if source is None:
        return {}
    try:
        with Image.open(source) as opened:
            metadata: dict[str, object] = {}
            if opened.info.get("icc_profile"):
                metadata["icc_profile"] = opened.info["icc_profile"]
            if opened.info.get("dpi"):
                metadata["dpi"] = opened.info["dpi"]
            exif = opened.getexif()
            if exif:
                # Orientation and pixel dimensions no longer describe a crop.
                for tag in (256, 257, 274, 40962, 40963):
                    exif.pop(tag, None)
                if exif:
                    metadata["exif"] = exif.tobytes()
            return metadata
    except (OSError, ValueError):
        return {}


def _write_image_atomic(destination: Path, image: np.ndarray, source: Path | None = None, *, expected_source_stat=None) -> None:
    suffix = destination.suffix.lower()
    params: list[int] = []
    if suffix in {".jpg", ".jpeg"}:
        params = [cv2.IMWRITE_JPEG_QUALITY, 100, cv2.IMWRITE_JPEG_OPTIMIZE, 1]
    elif suffix == ".png":
        params = [cv2.IMWRITE_PNG_COMPRESSION, 3]
    elif suffix == ".webp":
        params = [cv2.IMWRITE_WEBP_QUALITY, 100]
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.{uuid.uuid4().hex}.photoflow-part")
    preserve_staging = False
    try:
        metadata = _safe_metadata(source)
        if metadata and image.dtype == np.uint8:
            if image.ndim == 2:
                pil_image = Image.fromarray(image, "L")
            elif image.shape[2] == 4:
                pil_image = Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGRA2RGBA), "RGBA")
            else:
                pil_image = Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB), "RGB")
            try:
                image_format = {".jpg": "JPEG", ".jpeg": "JPEG", ".png": "PNG", ".webp": "WEBP", ".tif": "TIFF", ".tiff": "TIFF", ".bmp": "BMP"}[suffix]
                save_options = dict(metadata)
                if image_format == "JPEG":
                    save_options.update(quality=100, optimize=True)
                elif image_format == "PNG":
                    save_options["compress_level"] = 3
                elif image_format == "WEBP":
                    save_options.update(quality=100, lossless=True)
                pil_image.save(temporary, format=image_format, **save_options)
            finally:
                pil_image.close()
        else:
            success, encoded = cv2.imencode(suffix, image, params)
            if not success:
                raise RuntimeError("无法编码裁剪后的图片")
            encoded.tofile(temporary)
        with temporary.open("r+b") as staged:
            os.fsync(staged.fileno())
        verification = cv2.imdecode(np.fromfile(temporary, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
        if verification is None or verification.shape != image.shape or verification.dtype != image.dtype:
            raise RuntimeError("裁剪输出未通过完整性验证")
        if suffix in {".png", ".bmp", ".tif", ".tiff"} and not np.array_equal(verification, image):
            raise RuntimeError("裁剪输出像素未通过完整性验证")
        try:
            if expected_source_stat is not None:
                current = destination.stat()
                identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
                if source != destination or identity(current) != identity(expected_source_stat):
                    raise RuntimeError("原图已发生变化，请重新打开后裁剪")
                os.replace(temporary, destination)
            else:
                _publish_file_no_replace(temporary, destination)
        except PublicationUnsupportedError:
            preserve_staging = True
            raise
    finally:
        if not preserve_staging:
            temporary.unlink(missing_ok=True)


def _load_source(input_path: str) -> tuple[Path, np.ndarray]:
    source = Path(input_path).resolve()
    if not source.is_file():
        raise ValueError("图片不存在")
    if source.suffix.lower() not in SUPPORTED_EXTENSIONS:
        raise ValueError("当前仅支持 JPG、PNG、BMP、WebP 和 TIFF")
    width, height = _probe_image(source)
    estimated_bytes = _estimated_decoded_bytes(source, width, height)
    analysis_pixels = min(width * height, MAX_ANALYSIS_EDGE * MAX_ANALYSIS_EDGE)
    if estimated_bytes > MAX_DECODED_BYTES or estimated_bytes + analysis_pixels * ANALYSIS_BYTES_PER_PIXEL > MAX_TOTAL_WORKING_BYTES:
        raise ValueError("图片解码后内存大小超过安全上限")
    original = _read_image(source)
    if original.nbytes > MAX_DECODED_BYTES:
        raise ValueError("图片解码后内存大小超过安全上限")
    return source, original


def analyze_main_image(input_path: str) -> dict[str, object]:
    source = Path(input_path).resolve()
    result: dict[str, object] = {"input": str(source), "inputName": source.name, "success": False, "cropped": False}
    try:
        source, image = _load_source(input_path)
        original_height, original_width = image.shape[:2]
        rectangle, confidence, reason, accepted = _analyze_main_rectangle(image)
        left, top, right, bottom = rectangle
        result.update(
            success=True,
            analyzed=True,
            detected=accepted,
            needsReview=not accepted or confidence < 0.78,
            confidence=round(confidence, 4),
            reason=reason,
            originalSize={"width": original_width, "height": original_height},
            crop={"x": left, "y": top, "width": right - left, "height": bottom - top},
            snapGuides=_snap_guides(image, rectangle),
        )
        return result
    except Exception as error:
        result["error"] = str(error)
        return result


def crop_main_image(input_path: str, rectangle: str, output_suffix: str = "主图", replace_source: bool = False) -> dict[str, object]:
    source = Path(input_path).resolve()
    result: dict[str, object] = {"input": str(source), "inputName": source.name, "success": False, "cropped": False}
    try:
        source_stat = source.stat() if replace_source else None
        source, original = _load_source(input_path)
        original_height, original_width = original.shape[:2]
        values = [int(value) for value in rectangle.split(",")]
        if len(values) != 4:
            raise ValueError("裁剪范围格式无效")
        left, top, crop_width, crop_height = values
        right, bottom = left + crop_width, top + crop_height
        if left < 0 or top < 0 or crop_width < 20 or crop_height < 20 or right > original_width or bottom > original_height:
            raise ValueError("裁剪范围超出图片边界")
        if replace_source:
            destination = source
            _write_image_atomic(destination, original[top:bottom, left:right], source, expected_source_stat=source_stat)
        else:
            while True:
                destination = _unique_output_path(source, "裁剪" if output_suffix == "裁剪" else "主图")
                try:
                    _write_image_atomic(destination, original[top:bottom, left:right], source)
                    break
                except FileExistsError:
                    continue
        result.update(
            success=True,
            cropped=True,
            output=str(destination),
            outputName=destination.name,
            crop={"x": left, "y": top, "width": crop_width, "height": crop_height},
            originalSize={"width": original_width, "height": original_height},
            outputSize={"width": crop_width, "height": crop_height},
        )
        return result
    except Exception as error:
        result["error"] = str(error)
        if isinstance(error, PublicationUnsupportedError):
            result.update(code=error.code, recoveryPath=error.recovery_path)
        return result


def extract_main_image(input_path: str) -> dict[str, object]:
    source = Path(input_path).resolve()
    result: dict[str, object] = {
        "input": str(source),
        "inputName": source.name,
        "success": False,
        "cropped": False,
    }
    try:
        source, original = _load_source(input_path)
        image = original
        original_height, original_width = original.shape[:2]
        rectangle, confidence, reason = detect_main_rectangle(image)
        result["confidence"] = round(confidence, 4)
        result["originalSize"] = {"width": original_width, "height": original_height}
        if rectangle is None:
            result.update(success=True, skipped=True, reason=reason)
            return result
        left, top, right, bottom = rectangle
        cropped = original[top:bottom, left:right]
        while True:
            destination = _unique_output_path(source)
            try:
                _write_image_atomic(destination, cropped, source)
                break
            except FileExistsError:
                continue
        result.update(
            success=True,
            cropped=True,
            output=str(destination),
            outputName=destination.name,
            crop={"x": left, "y": top, "width": right - left, "height": bottom - top},
            outputSize={"width": right - left, "height": bottom - top},
        )
        return result
    except Exception as error:
        result["error"] = str(error)
        if isinstance(error, PublicationUnsupportedError):
            result.update(code=error.code, recoveryPath=error.recovery_path)
        return result


def run(args_list: list[str]) -> None:
    parser = argparse.ArgumentParser(description="从截图中提取主图")
    subparsers = parser.add_subparsers(dest="command", required=True)
    extract_parser = subparsers.add_parser("extract")
    extract_parser.add_argument("--input", action="append", required=True, dest="inputs")
    analyze_parser = subparsers.add_parser("analyze")
    analyze_parser.add_argument("--input", action="append", required=True, dest="inputs")
    crop_parser = subparsers.add_parser("crop")
    crop_parser.add_argument("--input", action="append", required=True, dest="inputs")
    crop_parser.add_argument("--rectangle", action="append", required=True, dest="rectangles")
    crop_parser.add_argument("--output-suffix", choices=("主图", "裁剪"), default="主图")
    crop_parser.add_argument("--replace-source", action="store_true")
    args = parser.parse_args(args_list)

    if args.command == "crop" and len(args.inputs) != len(args.rectangles):
        parser.error("每张图片都需要一个裁剪范围")

    results = []
    total = len(args.inputs)
    for index, input_path in enumerate(args.inputs, start=1):
        input_name = Path(input_path).name
        print(json.dumps({
            "type": "progress",
            "phase": "item-start",
            "processedCount": index - 1,
            "totalCount": total,
            "progress": round((index - 1) / max(1, total) * 100),
            "currentName": input_name,
            "message": f"正在识别 {index}/{total} · {input_name}",
        }, ensure_ascii=True), flush=True)
        if args.command == "analyze":
            results.append(analyze_main_image(input_path))
        elif args.command == "crop":
            results.append(crop_main_image(input_path, args.rectangles[index - 1], args.output_suffix, args.replace_source))
        else:
            results.append(extract_main_image(input_path))
        print(json.dumps({
            "type": "progress",
            "phase": "item-complete",
            "processedCount": index,
            "totalCount": total,
            "progress": round(index / max(1, total) * 100),
            "currentName": input_name,
            "message": f"已处理 {index}/{total} · {input_name}",
        }, ensure_ascii=True), flush=True)
    cropped_count = sum(bool(result.get("cropped")) for result in results)
    skipped_count = sum(bool(result.get("skipped")) for result in results)
    failed_count = sum(not bool(result.get("success")) for result in results)
    payload: dict[str, object] = {
        "success": failed_count < len(results),
        "inputCount": len(results),
        "croppedCount": cropped_count,
        "skippedCount": skipped_count,
        "failedCount": failed_count,
        "results": results,
    }
    if failed_count == len(results):
        payload["error"] = str(results[0].get("error") or "提取截图主图失败")
    # Keep the pipe protocol ASCII-only. Packaged Python executables on
    # Chinese Windows can otherwise encode redirected stdout as GBK while
    # Electron correctly expects UTF-8, corrupting every Chinese path.
    print(json.dumps(payload, ensure_ascii=True))


if __name__ == "__main__":
    import sys

    run(sys.argv[1:])
