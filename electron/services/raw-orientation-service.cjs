const EXIF_ORIENTATION_MATRICES = {
  1: [1, 0, 0, 1],
  2: [-1, 0, 0, 1],
  3: [-1, 0, 0, -1],
  4: [1, 0, 0, -1],
  5: [0, 1, 1, 0],
  6: [0, 1, -1, 0],
  7: [0, -1, -1, 0],
  8: [0, -1, 1, 0],
};

const fs = require('fs');

const createRawOrientationService = ({ exiftool, maxCacheEntries = 64 }) => {
  const cache = new Map();
  const readExifInfo = async filePath => {
    try {
      const tags = await exiftool.readRaw(filePath, ['-G1', '-Orientation#', '-Software', '-n', '-api', 'largefilesupport=1']);
      const candidates = Object.entries(tags).filter(([name, value]) => /(^|:)Orientation$/i.test(name) && Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 8);
      const priority = name => /(^|:)IFD0:Orientation$/i.test(name) ? 0 : 1;
      candidates.sort(([left], [right]) => priority(left) - priority(right));
      const software = Object.entries(tags).find(([name]) => /(^|:)Software$/i.test(name))?.[1];
      return { orientation: candidates.length ? Number(candidates[0][1]) : 1, candidates, software: String(software || ''), reliable: true };
    } catch {
      return { orientation: 1, candidates: [], software: '', reliable: false };
    }
  };
  const multiply = (left, right) => [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
  ];
  const correction = async (sourcePath, previewPath, stat) => {
    let previewIdentity = 'missing';
    try {
      const previewStat = fs.statSync(previewPath);
      previewIdentity = `${previewStat.size}|${previewStat.mtimeMs}`;
    } catch { /* an in-flight preview must not poison a later cache entry */ }
    const cacheKey = `${sourcePath}|${stat.size}|${stat.mtimeMs}|${previewPath}|${previewIdentity}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    const [rawRead, previewRead] = await Promise.all([readExifInfo(sourcePath), readExifInfo(previewPath)]);
    const rawOrientation = rawRead.orientation;
    const isPhotoFlowPreview = /PhotoFlow (?:embedded-preview-v2|libraw-rawpy-v1)/i.test(previewRead.software);
    let embeddedOrientation = previewRead.orientation;
    let orientationReliable = rawRead.reliable && previewRead.reliable;
    if (!isPhotoFlowPreview && previewRead.orientation === 1) {
      const legacyCandidates = rawRead.candidates
        .filter(([name]) => !/(^|:)IFD0:Orientation$/i.test(name))
        .sort(([left], [right]) => /(?:Preview|IFD1).*Orientation$/i.test(left) ? -1 : /(?:Preview|IFD1).*Orientation$/i.test(right) ? 1 : left.localeCompare(right));
      if (legacyCandidates.length) embeddedOrientation = Number(legacyCandidates[0][1]);
      else {
        // Old previews were physically transposed and saved with Orientation=1.
        // Without a source preview tag, identity is safer than rotating twice.
        embeddedOrientation = rawOrientation;
        orientationReliable = false;
      }
    }
    const rawMatrix = EXIF_ORIENTATION_MATRICES[rawOrientation] || EXIF_ORIENTATION_MATRICES[1];
    const embeddedMatrix = EXIF_ORIENTATION_MATRICES[embeddedOrientation] || EXIF_ORIENTATION_MATRICES[1];
    const embeddedInverse = [embeddedMatrix[0], embeddedMatrix[2], embeddedMatrix[1], embeddedMatrix[3]];
    const matrix = multiply(rawMatrix, embeddedInverse).map(value => Object.is(value, -0) ? 0 : value);
    const result = { matrix, swapsAxes: Math.abs(matrix[1]) === 1 || Math.abs(matrix[2]) === 1, rawOrientation, embeddedOrientation };
    if (orientationReliable && previewIdentity !== 'missing') {
      if (cache.size >= maxCacheEntries) cache.delete(cache.keys().next().value);
      cache.set(cacheKey, result);
    }
    return result;
  };
  return { correction };
};

module.exports = { createRawOrientationService };
