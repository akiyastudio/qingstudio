// Contract with electron/main.cjs: pluginService.runJson terminates the
// extractor process after this bound. This module does not claim to cancel an
// extraction; its request bound is deliberately larger than the process bound.
const VIDEO_TIMELINE_EXTRACTOR_TIMEOUT_MS = 2 * 60 * 1000;
const VIDEO_TIMELINE_REQUEST_TIMEOUT_MS = 3 * 60 * 1000;

const registerVideoTimelineIpc = ({ ipcMain, extractVideoTimelineFrames, resolveProjectEntry, fs, path, VIDEO_EXTENSIONS, writeLog }) => {
  const inFlight = new Map();
  const waiters = [];
  const MAX_CONCURRENT_EXTRACTIONS = 2;
  if (VIDEO_TIMELINE_REQUEST_TIMEOUT_MS <= VIDEO_TIMELINE_EXTRACTOR_TIMEOUT_MS) throw new Error('视频时间轴请求上限必须大于提取器进程上限');
  let activeExtractions = 0;
  const acquire = deadlineAt => {
    if (activeExtractions < MAX_CONCURRENT_EXTRACTIONS) {
      activeExtractions += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error('视频时间轴帧提取排队超时'));
      }, Math.max(1, deadlineAt - Date.now()));
      waiter.timer.unref?.();
      waiters.push(waiter);
    });
  };
  const release = () => {
    const next = waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    } else activeExtractions -= 1;
  };
  const runLimited = async (worker, deadlineAt) => {
    await acquire(deadlineAt);
    try { return await worker(); } finally { release(); }
  };
  const withTimeout = (promise, deadlineAt) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('视频时间轴帧提取超时')), Math.max(1, deadlineAt - Date.now()));
    timer.unref?.();
    promise.then(resolve, reject).finally(() => clearTimeout(timer)).catch(() => undefined);
  });

  ipcMain.handle('workspace-video-timeline-frames', async (_event, workspacePath, status, projectName, relativePath, times = []) => {
    try {
      const sourcePath = resolveProjectEntry(workspacePath, status, projectName, relativePath);
      const stat = await fs.promises.stat(sourcePath);
      if (!stat.isFile() || !VIDEO_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) throw new Error('请选择项目中的视频文件');
      const safeTimes = (Array.isArray(times) ? times : []).slice(0, 16).map(Number);
      if (!safeTimes.length || safeTimes.some(time => !Number.isFinite(time) || time < 0)) throw new Error('视频时间轴位置无效');
      if (typeof extractVideoTimelineFrames !== 'function') throw new Error('视频播放器组件不支持时间线帧提取');
      const uniqueTimes = [...new Set(safeTimes)].sort((left, right) => left - right);
      const requestKey = `${sourcePath}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}\0${uniqueTimes.join(',')}`;
      const deadlineAt = Date.now() + VIDEO_TIMELINE_REQUEST_TIMEOUT_MS;
      let extraction = inFlight.get(requestKey);
      if (!extraction) {
        extraction = runLimited(() => extractVideoTimelineFrames(sourcePath, uniqueTimes), deadlineAt);
        inFlight.set(requestKey, extraction);
        extraction.finally(() => { if (inFlight.get(requestKey) === extraction) inFlight.delete(requestKey); }).catch(() => undefined);
      }
      const extractedFrames = await withTimeout(extraction, deadlineAt);
      if (!Array.isArray(extractedFrames) || extractedFrames.length !== uniqueTimes.length) return { success: false, error: '无法生成视频时间轴画面' };
      const frameByTime = new Map(uniqueTimes.map((time, index) => [time, extractedFrames[index]]));
      const frames = safeTimes.map(time => frameByTime.get(time));
      return { success: true, frames };
    } catch (error) {
      writeLog('warn', 'Video timeline frame extraction failed', { projectName, relativePath, error: error.message || String(error) });
      return { success: false, error: error.message || String(error) };
    }
  });
};

module.exports = { registerVideoTimelineIpc, VIDEO_TIMELINE_EXTRACTOR_TIMEOUT_MS, VIDEO_TIMELINE_REQUEST_TIMEOUT_MS };
