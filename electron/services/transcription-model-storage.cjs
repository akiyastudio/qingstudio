// User-installed models are data, not part of the replaceable component runtime.
const transcriptionModelOwner = (path, componentRoot) => {
  const root = path.resolve(componentRoot);
  return path.basename(root) === 'runtime' && path.basename(path.dirname(root)) === 'video-transcription'
    ? path.dirname(root) : root;
};

const preserveTranscriptionModels = async ({ fs, path, componentId, sourceRoot, container, assertPath, captureTreeIdentity, verifyTreeIdentity }) => {
  if (componentId !== 'video-transcription') return;
  const source = path.join(sourceRoot, 'models');
  const existing = target => fs.promises.lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!await existing(source)) return;
  await assertPath(source);
  const expected = await captureTreeIdentity(source); // Reject links and hash every source file before publishing anything.
  const destination = path.join(container, 'models');
  await assertPath(destination, true);
  await fs.promises.mkdir(destination, { recursive: true });
  const alreadyStored = await captureTreeIdentity(destination);
  const portable = entries => entries.map(({ node, ...entry }) => entry);
  const same = (actual, wanted) => JSON.stringify(portable(actual)) === JSON.stringify(portable(wanted));
  const tops = expected.filter(entry => !entry.path.includes('/'));
  for (const top of tops) {
    const wanted = expected.filter(entry => entry.path === top.path || entry.path.startsWith(`${top.path}/`));
    const target = path.join(destination, top.path);
    await assertPath(target, true);
    if (await existing(target)) {
      const actual = alreadyStored.filter(entry => entry.path === top.path || entry.path.startsWith(`${top.path}/`));
      if (!same(actual, wanted)) throw new Error(`模型迁移冲突：${top.path}；已保留原模型，请核对两个模型目录后重试更新`);
      continue;
    }
    // Each top-level model is published only after a complete verified copy.
    // A crash leaves the original intact and a separate pending copy; retries
    // never mistake a partial model for an installed one or overwrite it.
    const pending = await fs.promises.mkdtemp(path.join(container, '.models-migration-'));
    await fs.promises.cp(path.join(source, top.path), path.join(pending, top.path), { recursive: true, force: false, errorOnExist: true });
    await verifyTreeIdentity(pending, wanted);
    await assertPath(destination);
    if (await existing(target)) throw new Error(`模型迁移目标已存在：${top.path}；已保留原模型`);
    if (top.kind === 'directory') await fs.promises.rename(path.join(pending, top.path), target);
    else {
      // link publishes a file exclusively; rename could overwrite a concurrent file.
      await fs.promises.link(path.join(pending, top.path), target);
      await fs.promises.unlink(path.join(pending, top.path));
    }
    await fs.promises.rmdir(pending);
  }
  await verifyTreeIdentity(source, expected, { includeNode: true });
  const copied = await captureTreeIdentity(destination);
  const expectedPaths = new Set(expected.map(entry => entry.path));
  if (!same(copied.filter(entry => expectedPaths.has(entry.path)), expected)) throw new Error('模型迁移校验失败；已保留原模型');
};

module.exports = { transcriptionModelOwner, preserveTranscriptionModels };
