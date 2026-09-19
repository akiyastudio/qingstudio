const DATE_PATTERN = /^\d{2}\.\d{1,2}\.\d{1,2}$/;
const RELEASE_PATTERN = /^\d{2}\.\d{1,2}\.\d{1,2}\.[1-9]\d*$/;
// Windows file/installer versions have four unsigned 16-bit fields.
const MAX_REVISION = 65535;

const normalizeDate = value => {
  if (!DATE_PATTERN.test(value)) throw new Error(`日期必须使用 YY.M.D 格式：${value}`);
  const [year, month, day] = value.split('.').map(Number);
  const date = new Date(2000 + year, month - 1, day);
  if (date.getFullYear() !== 2000 + year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`版本号不是有效日期：${value}`);
  }
  return `${String(year).padStart(2, '0')}.${month}.${day}`;
};

const parseReleaseVersion = version => {
  if (!RELEASE_PATTERN.test(version)) throw new Error(`版本号必须使用 YY.M.D.N 格式：${version}`);
  const fields = version.split('.').map(Number);
  const date = normalizeDate(version.split('.').slice(0, 3).join('.'));
  if (!Number.isSafeInteger(fields[3]) || fields[3] > MAX_REVISION) throw new Error(`版本序号 N 必须在 1 到 ${MAX_REVISION} 之间：${version}`);
  return { date, revision: fields[3], fields };
};

const nextReleaseVersion = (date, versions) => {
  const normalized = normalizeDate(date);
  let revision = 0;
  for (const version of versions) {
    // Legacy three-part and non-date plugin versions precede revision 1.
    if (!RELEASE_PATTERN.test(version)) continue;
    const previous = parseReleaseVersion(version);
    if (previous.date === normalized) revision = Math.max(revision, previous.revision);
  }
  const next = `${normalized}.${revision + 1}`;
  parseReleaseVersion(next);
  return next;
};

const releaseVersionCode = version => {
  const { fields: [year, month, day, revision] } = parseReleaseVersion(version);
  return (year * 10_000 + month * 100 + day) * 100_000 + revision;
};

module.exports = { DATE_PATTERN, RELEASE_PATTERN, MAX_REVISION, normalizeDate, parseReleaseVersion, nextReleaseVersion, releaseVersionCode };
