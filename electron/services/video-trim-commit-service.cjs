const TRANSIENT_RENAME_ERROR_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

const renameWithRetry = async (fs, source, destination, retryDelays) => {
  let lastError;
  for (const delay of retryDelays) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      await fs.promises.rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!TRANSIENT_RENAME_ERROR_CODES.has(String(error?.code || ''))) throw error;
    }
  }
  throw lastError;
};

const replaceVideoFileWithRollback = async ({
  crypto,
  fs,
  path,
  sourcePath,
  replacementPath,
  retryDelays = [0, 100, 200, 400, 800, 1200],
}) => {
  const parsed = path.parse(sourcePath);
  const backupPath = path.join(parsed.dir, `.photoflow-trim-backup-${crypto.randomUUID()}${parsed.ext}`);
  await renameWithRetry(fs, sourcePath, backupPath, retryDelays);
  try {
    // The destination no longer exists, so this works consistently on Windows;
    // renaming directly over sourcePath would fail even when no player holds it.
    await renameWithRetry(fs, replacementPath, sourcePath, retryDelays);
  } catch (commitError) {
    try {
      await renameWithRetry(fs, backupPath, sourcePath, retryDelays);
    } catch (rollbackError) {
      const error = new Error(`裁剪文件提交失败，且原视频自动恢复失败；原视频备份保留在 ${backupPath}`);
      error.code = 'VIDEO_TRIM_ROLLBACK_FAILED';
      error.cause = commitError;
      error.rollbackError = rollbackError;
      error.backupPath = backupPath;
      throw error;
    }
    throw commitError;
  }

  let backupRemoved = true;
  try {
    await fs.promises.rm(backupPath, { force: true });
  } catch {
    // The replacement is already committed. Keeping the hidden backup is safer
    // than reporting failure and encouraging the user to run the trim again.
    backupRemoved = false;
  }
  return { backupPath, backupRemoved };
};

module.exports = { replaceVideoFileWithRollback, renameWithRetry };
