export type RendererErrorOccurrence = { fingerprint: string; reportedAt: number };

const MAXIMUM_UPDATE_DEPTH_NOTICE = '界面状态更新发生循环，详细信息已写入日志。';
const NOTICE_LIMIT = 180;
const DEDUPLICATION_WINDOW_MS = 5_000;
const MAX_RECENT_OCCURRENCES = 64;

const firstUsefulLine = (message: string) => message
  .split(/\r?\n/)
  .map(line => line.trim())
  .find(line => line && !/^\s*at\s/.test(line)) || '界面操作失败';

export const rendererErrorFingerprint = (message: string) => {
  if (/maximum update depth exceeded/i.test(message)) return 'react:maximum-update-depth';
  return firstUsefulLine(message)
    .replace(/%[sdifoOc]/g, '')
    .replace(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/\S*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
};

export const rendererErrorNoticeSummary = (message: string) => {
  if (/maximum update depth exceeded/i.test(message)) return MAXIMUM_UPDATE_DEPTH_NOTICE;
  const summary = firstUsefulLine(message)
    .replace(/%[sdifoOc]/g, '')
    .replace(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/\S*/gi, '')
    .replace(/\s+/g, ' ')
    .trim() || '界面操作失败';
  return summary.length <= NOTICE_LIMIT ? summary : `${summary.slice(0, NOTICE_LIMIT - 1)}…`;
};

export const shouldReportRendererError = (
  previous: RendererErrorOccurrence | null,
  next: string,
  now: number,
) => !previous || previous.fingerprint !== rendererErrorFingerprint(next) || now - previous.reportedAt >= DEDUPLICATION_WINDOW_MS;

export const recordRendererError = (
  previous: RendererErrorOccurrence[],
  next: string,
  now: number,
) => {
  const fingerprint = rendererErrorFingerprint(next);
  const occurrences = previous
    .slice(-MAX_RECENT_OCCURRENCES)
    .filter(item => now - item.reportedAt < DEDUPLICATION_WINDOW_MS)
    .slice(-(MAX_RECENT_OCCURRENCES - 1));
  if (occurrences.some(item => item.fingerprint === fingerprint)) return { report: false, occurrences };
  return { report: true, occurrences: [...occurrences, { fingerprint, reportedAt: now }] };
};
