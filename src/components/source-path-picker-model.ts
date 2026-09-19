const cleanSourcePath = (value: string) => value
  .trim()
  .replace(/^[\u201c\u201d"']+|[\u201c\u201d"']+$/g, '')
  .trim();

const sourcePathKey = (value: string) => {
  const cleaned = cleanSourcePath(value);
  const windowsPath = /^[a-z]:([\\/]|$)/i.test(cleaned) || /^[/\\]{2}[^/\\]+[/\\]+[^/\\]+/.test(cleaned);
  if (!windowsPath) {
    const normalized = cleaned.replace(/\/{2,}/g, '/');
    return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
  }
  const normalized = cleaned.replace(/\//g, '\\').replace(/\\{2,}/g, '\\');
  const rooted = cleaned.startsWith('\\\\') || cleaned.startsWith('//') ? `\\\\${normalized.replace(/^\\+/, '')}` : normalized;
  return rooted.replace(/\\+$/, match => /^[a-z]:\\$/i.test(rooted) ? match : '').toLocaleLowerCase();
};

export const mergeSourcePaths = (...groups: ReadonlyArray<readonly string[]>) => {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const value of groups.flat()) {
    const path = cleanSourcePath(value);
    if (!path) continue;
    const key = sourcePathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(path);
  }
  return merged;
};

export const parseSourcePathText = (text: string) => {
  const paths: string[] = [];
  for (const line of text.replace(/\0/g, '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const quoted = [...trimmed.matchAll(/["\u201c]([^"\u201d]+)["\u201d]|'([^']+)'/g)];
    if (quoted.length) {
      paths.push(...quoted.map(match => match[1] || match[2] || ''));
      const remainder = trimmed.replace(/["\u201c][^"\u201d]+["\u201d]|'[^']+'/g, '').trim();
      if (remainder) paths.push(...remainder.split(/\s*;\s*/));
    } else {
      paths.push(...trimmed.split(/\s*;\s*/));
    }
  }
  return mergeSourcePaths(paths);
};

export const sourcePathIdentity = sourcePathKey;

export const removeSourcePath = (paths: readonly string[], sourcePath: string) => {
  const removedKey = sourcePathKey(cleanSourcePath(sourcePath));
  return mergeSourcePaths(paths).filter(value => sourcePathKey(value) !== removedKey);
};
