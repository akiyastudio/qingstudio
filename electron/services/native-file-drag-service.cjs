const FALLBACK_ICON_SIZE = 32;

const usableDragIcon = icon => Boolean(icon)
  && icon.isEmpty?.() !== true
  && (!icon.getSize || (() => {
    const size = icon.getSize();
    return Number(size?.width) > 0 && Number(size?.height) > 0;
  })());

const createFallbackDragIcon = nativeImage => {
  if (!nativeImage?.createFromBitmap) throw new Error('无法创建原生拖拽图标');
  const bitmap = Buffer.alloc(FALLBACK_ICON_SIZE * FALLBACK_ICON_SIZE * 4);
  for (let y = 3; y < FALLBACK_ICON_SIZE - 3; y += 1) {
    for (let x = 5; x < FALLBACK_ICON_SIZE - 5; x += 1) {
      const offset = (y * FALLBACK_ICON_SIZE + x) * 4;
      const border = x < 7 || x > FALLBACK_ICON_SIZE - 8 || y < 5 || y > FALLBACK_ICON_SIZE - 6;
      bitmap[offset] = border ? 0xc4 : 0xff;
      bitmap[offset + 1] = border ? 0x73 : 0xff;
      bitmap[offset + 2] = border ? 0x25 : 0xff;
      bitmap[offset + 3] = 0xff;
    }
  }
  const icon = nativeImage.createFromBitmap(bitmap, {
    width: FALLBACK_ICON_SIZE,
    height: FALLBACK_ICON_SIZE,
    scaleFactor: 1,
  });
  if (!usableDragIcon(icon)) throw new Error('原生拖拽备用图标为空');
  return icon;
};

module.exports = { createFallbackDragIcon, usableDragIcon };
