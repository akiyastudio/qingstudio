export type VideoAspectMode = 'source' | 'contain' | 'cover' | '16:9' | '4:3' | '1:1';
export type VideoRotation = 0 | 90 | 180 | 270;
export type VideoTransform = { aspectMode: VideoAspectMode; rotation: VideoRotation; flipHorizontal: boolean; flipVertical: boolean; crop?: { x: number; y: number; width: number; height: number } };
export type VideoHdrMode = 'auto' | 'sdr' | 'hdr-passthrough' | 'tone-map';
export type VideoToneMapping = 'auto' | 'bt2390' | 'reinhard' | 'mobius' | 'hable';
export type VideoStatisticsLevel = 'off' | 'basic' | 'detailed';

export const DEFAULT_VIDEO_TRANSFORM: VideoTransform = { aspectMode: 'contain', rotation: 0, flipHorizontal: false, flipVertical: false };
const VIDEO_GEOMETRY_EPSILON = 1e-9;
const normalizeCrop = (crop: NonNullable<VideoTransform['crop']>) => {
  const width = Math.max(0.001, Math.min(1, crop.width));
  const height = Math.max(0.001, Math.min(1, crop.height));
  const x = Math.max(0, Math.min(1 - width, crop.x));
  const y = Math.max(0, Math.min(1 - height, crop.y));
  return {
    x,
    y,
    width,
    height,
  };
};
export const normalizeVideoTransform = (value?: Partial<VideoTransform>): VideoTransform => ({
  aspectMode: ['source', 'contain', 'cover', '16:9', '4:3', '1:1'].includes(String(value?.aspectMode)) ? value!.aspectMode! : 'contain',
  rotation: [0, 90, 180, 270].includes(Number(value?.rotation)) ? Number(value!.rotation) as VideoRotation : 0,
  flipHorizontal: value?.flipHorizontal === true,
  flipVertical: value?.flipVertical === true,
  ...(value?.crop && [value.crop.x, value.crop.y, value.crop.width, value.crop.height].every(Number.isFinite) && value.crop.width > 0 && value.crop.height > 0 ? { crop: normalizeCrop(value.crop) } : {}),
});
export const chromiumFrameGeometry = (input: VideoTransform, sourceWidth = 0, sourceHeight = 0, viewportWidth = 0, viewportHeight = 0) => {
  const value = normalizeVideoTransform(input);
  const crop = value.crop || { x: 0, y: 0, width: 1, height: 1 };
  const safeSourceWidth = Number.isFinite(sourceWidth) && sourceWidth > 0 ? sourceWidth : 1;
  const safeSourceHeight = Number.isFinite(sourceHeight) && sourceHeight > 0 ? sourceHeight : 1;
  const safeViewportWidth = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 0;
  const safeViewportHeight = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 0;
  const croppedWidth = safeSourceWidth * crop.width;
  const croppedHeight = safeSourceHeight * crop.height;
  const rotated = value.rotation === 90 || value.rotation === 270;
  const rotatedWidth = rotated ? croppedHeight : croppedWidth;
  const rotatedHeight = rotated ? croppedWidth : croppedHeight;
  const targetRatio = value.aspectMode === '16:9' ? 16 / 9 : value.aspectMode === '4:3' ? 4 / 3 : value.aspectMode === '1:1' ? 1 : 0;
  const viewportRatio = safeViewportWidth > 0 && safeViewportHeight > 0 ? safeViewportWidth / safeViewportHeight : 0;
  const outputRatio = targetRatio || (value.aspectMode === 'cover' && viewportRatio > 0 ? viewportRatio : rotatedWidth / rotatedHeight);
  const outputSize = outputRatio && rotatedWidth / rotatedHeight > outputRatio
    ? { width: Math.max(1, Math.round(rotatedHeight * outputRatio)), height: Math.max(1, Math.round(rotatedHeight)) }
    : { width: Math.max(1, Math.round(rotatedWidth)), height: Math.max(1, Math.round(rotatedWidth / Math.max(0.001, outputRatio))) };
  const fitViewport = (width: number, height: number, mode: 'contain' | 'cover') => {
    if (!(safeViewportWidth > 0 && safeViewportHeight > 0 && width > 0 && height > 0)) return { width, height };
    const scale = mode === 'cover' ? Math.max(safeViewportWidth / width, safeViewportHeight / height) : Math.min(safeViewportWidth / width, safeViewportHeight / height);
    return { width: width * scale, height: height * scale };
  };
  const targetDisplaySize = targetRatio > 0
    ? fitViewport(targetRatio, 1, 'contain')
    : fitViewport(rotatedWidth, rotatedHeight, value.aspectMode === 'cover' ? 'cover' : 'contain');
  const baseScale = safeViewportWidth > 0 && safeViewportHeight > 0
    ? Math.max(safeViewportWidth / safeSourceWidth, safeViewportHeight / safeSourceHeight)
    : 1;
  const baseWidth = safeSourceWidth * baseScale;
  const baseHeight = safeSourceHeight * baseScale;
  const baseCropWidth = baseWidth * crop.width;
  const baseCropHeight = baseHeight * crop.height;
  const rotatedBaseCropWidth = rotated ? baseCropHeight : baseCropWidth;
  const rotatedBaseCropHeight = rotated ? baseCropWidth : baseCropHeight;
  const ratioScaleX = targetDisplaySize.width / Math.max(VIDEO_GEOMETRY_EPSILON, rotatedBaseCropWidth);
  const ratioScaleY = targetDisplaySize.height / Math.max(VIDEO_GEOMETRY_EPSILON, rotatedBaseCropHeight);
  const elementWidth = safeViewportWidth || safeSourceWidth;
  const elementHeight = safeViewportHeight || safeSourceHeight;
  const baseScaleX = baseWidth / elementWidth;
  const baseScaleY = baseHeight / elementHeight;
  const flipX = value.flipHorizontal ? -1 : 1;
  const flipY = value.flipVertical ? -1 : 1;
  const radians = value.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const matrix = {
    a: ratioScaleX * cosine * baseScaleX * flipX,
    b: ratioScaleY * sine * baseScaleX * flipX,
    c: ratioScaleX * -sine * baseScaleY * flipY,
    d: ratioScaleY * cosine * baseScaleY * flipY,
    e: 0,
    f: 0,
  };
  const cropCenterX = (crop.x + crop.width / 2 - .5) * elementWidth;
  const cropCenterY = (crop.y + crop.height / 2 - .5) * elementHeight;
  matrix.e = -(matrix.a * cropCenterX + matrix.c * cropCenterY);
  matrix.f = -(matrix.b * cropCenterX + matrix.d * cropCenterY);
  for (const key of ['a','b','c','d','e','f'] as const) if (Math.abs(matrix[key]) < 1e-12) matrix[key] = 0;
  const visibleSize = value.aspectMode === 'cover' && safeViewportWidth > 0 && safeViewportHeight > 0
    ? { width: safeViewportWidth, height: safeViewportHeight }
    : targetDisplaySize;
  return { value, crop, croppedWidth, croppedHeight, rotated, outputSize, outputRatio, visibleSize, targetDisplaySize, targetRatio, baseWidth, baseHeight, ratioScaleX, ratioScaleY, matrix };
};
export const chromiumVideoStyle = (value: VideoTransform, viewportWidth = 0, viewportHeight = 0, sourceWidth = viewportWidth, sourceHeight = viewportHeight): Record<string, string | number | undefined> => {
  const geometry = chromiumFrameGeometry(value, sourceWidth, sourceHeight, viewportWidth, viewportHeight);
  value = geometry.value;
  const { matrix } = geometry;
  return {
    objectFit: 'fill',
    aspectRatio: 'auto',
    width: '100%', height: '100%', maxWidth: '100%', maxHeight: '100%',
    margin: '0', backgroundColor: '#000', willChange: 'transform',
    transformOrigin: 'center center',
    transform: `matrix(${matrix.a}, ${matrix.b}, ${matrix.c}, ${matrix.d}, ${matrix.e}, ${matrix.f})`,
    clipPath:value.crop?`inset(${value.crop.y*100}% ${Math.max(0,1-value.crop.x-value.crop.width)*100}% ${Math.max(0,1-value.crop.y-value.crop.height)*100}% ${value.crop.x*100}%)`:undefined,
  };
};
export const hdrModeAvailability = ({ requested, hdrFeatures, hdrDisplayAvailable, toneMapping }: { requested: VideoHdrMode; hdrFeatures?: {passthrough:boolean;toneMapping:boolean;algorithms:string[];targetPeakControl:boolean}; hdrDisplayAvailable: boolean;toneMapping?:VideoToneMapping }) => {
  if (requested === 'hdr-passthrough' && !hdrFeatures?.passthrough) return { available: false, reason: '当前播放后端不支持 HDR 直通' };
  if (requested === 'hdr-passthrough' && !hdrDisplayAvailable) return { available: false, reason: '当前显示器未报告可用 HDR 输出' };
  if (requested === 'tone-map' && (!hdrFeatures?.toneMapping || !hdrFeatures.algorithms.includes(toneMapping||'auto'))) return {available:false,reason:'当前播放后端不支持所选色调映射算法'};
  return { available: true, reason: '' };
};
export const playbackCapabilityPresentation = (features: { transforms: {aspectModes:string[];rotation:boolean;flip:boolean;crop:boolean}; hdr: {passthrough:boolean;toneMapping:boolean;algorithms:string[];targetPeakControl:boolean}; statistics:{basic:boolean;decode:boolean;hdr:boolean;timing:boolean;cache:boolean;gpu:boolean}; subtitles:{embedded:boolean;external:boolean;ass:boolean;styles:boolean}; capture:{sourceFrame:boolean;displayedFrame:boolean} } | undefined, hdrDisplayAvailable: boolean) => ({
  transformControls: features?.transforms.aspectModes || [], rotationAvailable:features?.transforms.rotation===true,flipAvailable:features?.transforms.flip===true,cropAvailable:features?.transforms.crop===true,
  hdrControlsAvailable:features?.hdr.passthrough===true||features?.hdr.toneMapping===true,hdrPassthroughAvailable:features?.hdr.passthrough===true&&hdrDisplayAvailable,toneMappingAvailable:features?.hdr.toneMapping===true,toneMappingAlgorithms:features?.hdr.algorithms||[],targetPeakControl:features?.hdr.targetPeakControl===true,
  statisticsGroups:features?.statistics||{basic:false,decode:false,hdr:false,timing:false,cache:false,gpu:false},
  subtitlesAvailable:features?.subtitles.embedded===true||features?.subtitles.external===true,subtitleFormats:[...(features?.subtitles.external?['vtt','srt']:[]),...(features?.subtitles.ass?['ass','ssa']:[])],
  captureAvailable: features?.capture.displayedFrame === true || features?.capture.sourceFrame === true,displayedCaptureAvailable:features?.capture.displayedFrame===true,sourceCaptureAvailable:features?.capture.sourceFrame===true,
});

export const transformedFrameSize = (width: number, height: number, value: VideoTransform, viewportWidth = 0, viewportHeight = 0) => {
  return chromiumFrameGeometry(value, width, height, viewportWidth, viewportHeight).outputSize;
};

export const drawTransformedVideoFrame = (context: CanvasRenderingContext2D, video: HTMLVideoElement, value: VideoTransform, viewportWidth = 0, viewportHeight = 0) => {
  const geometry = chromiumFrameGeometry(value, video.videoWidth, video.videoHeight, viewportWidth, viewportHeight);
  value = geometry.value;
  const { width, height } = geometry.outputSize;
  context.save(); context.translate(width / 2, height / 2); context.rotate(value.rotation * Math.PI / 180); context.scale(value.flipHorizontal ? -1 : 1, value.flipVertical ? -1 : 1);
  const boxWidth = geometry.rotated ? height : width; const boxHeight = geometry.rotated ? width : height;
  const effectiveWidth=geometry.croppedWidth,effectiveHeight=geometry.croppedHeight;const scale = value.aspectMode === 'cover' ? Math.max(boxWidth / effectiveWidth, boxHeight / effectiveHeight) : 1;
  const drawWidth = value.aspectMode === '16:9' || value.aspectMode === '4:3' || value.aspectMode === '1:1' ? boxWidth : effectiveWidth * scale;
  const drawHeight = value.aspectMode === '16:9' || value.aspectMode === '4:3' || value.aspectMode === '1:1' ? boxHeight : effectiveHeight * scale;
  if(value.crop){const sx=video.videoWidth*value.crop.x,sy=video.videoHeight*value.crop.y,sw=video.videoWidth*value.crop.width,sh=video.videoHeight*value.crop.height;context.drawImage(video,sx,sy,sw,sh,-drawWidth/2,-drawHeight/2,drawWidth,drawHeight);}else context.drawImage(video, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight); context.restore();
  return { width, height };
};
