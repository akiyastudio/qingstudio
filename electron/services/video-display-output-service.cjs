const createVideoDisplayOutputService = ({ screen }) => {
  const rect = value => {
    if (!value || typeof value !== 'object') return null;
    const x = Number(value.x); const y = Number(value.y); const width = Number(value.width); const height = Number(value.height);
    return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { x, y, width, height } : null;
  };
  const readBounds = (ownerWindow, method) => {
    try { return rect(ownerWindow?.[method]?.()); } catch { return null; }
  };
  const describe = (ownerWindow, physicalSurfaceBounds = null, viewportDipBounds = null) => {
    const contentBounds = readBounds(ownerWindow, 'getContentBounds');
    const windowBounds = readBounds(ownerWindow, 'getBounds');
    // Content bounds provide the exact desktop-DIP origin. A minimized or
    // partially initialized window can report an empty content rect, so retain
    // the outer window bounds as a conservative origin/display fallback.
    const ownerBounds = contentBounds || windowBounds;
    const viewport = rect(viewportDipBounds);
    let target = viewport && ownerBounds ? { x: ownerBounds.x + viewport.x, y: ownerBounds.y + viewport.y, width: viewport.width, height: viewport.height } : viewport;
    if (!target && ownerBounds && physicalSurfaceBounds && Number(physicalSurfaceBounds.width) > 0 && Number(physicalSurfaceBounds.height) > 0) {
      const ownerDisplay = screen.getDisplayMatching(ownerBounds);
      const scale = Number(ownerDisplay?.scaleFactor) || 1;
      target = {
        x: ownerBounds.x + Number(physicalSurfaceBounds.x || 0) / scale,
        y: ownerBounds.y + Number(physicalSurfaceBounds.y || 0) / scale,
        width: Number(physicalSurfaceBounds.width) / scale,
        height: Number(physicalSurfaceBounds.height) / scale,
      };
    }
    target ||= physicalSurfaceBounds && Number(physicalSurfaceBounds.width) > 0 && Number(physicalSurfaceBounds.height) > 0 ? physicalSurfaceBounds : ownerBounds || { x: 0, y: 0, width: 1, height: 1 };
    const display = screen.getDisplayMatching(target);
    const colorSpace = String(display?.colorSpace || '');
    const hdrAvailable = display?.hdrEnabled === true || /(?:hdr|rec(?:\.?|-)2100|pq)/i.test(colorSpace);
    return Object.freeze({
      displayId: String(display?.id ?? ''), scaleFactor: Number(display?.scaleFactor) || 1,
      colorSpace, hdrAvailable,
      reason: hdrAvailable ? '' : '当前显示器未明确报告 HDR 输出能力',
      bounds: display?.bounds || null,
    });
  };
  return { describe };
};
module.exports = { createVideoDisplayOutputService };
