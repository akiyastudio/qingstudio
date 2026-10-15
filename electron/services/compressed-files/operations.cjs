const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const engine = require('./engine.cjs');

const identity = context => `${context.contentKind || 'project'}:${context.projectId}`;
const parent = value => value.split('/').slice(0, -1).join('/');
const join = (...values) => values.filter(Boolean).join('/');
const commonParent = values => {
  const parts = parent(values[0]).split('/').filter(Boolean);
  for (const value of values.slice(1)) while (parts.length && !parent(value).toLowerCase().startsWith(`${parts.join('/').toLowerCase()}/`) && parent(value).toLowerCase() !== parts.join('/').toLowerCase()) parts.pop();
  return parts.join('/');
};
const belongs = (value, root) => value.toLowerCase() === root.toLowerCase() || value.toLowerCase().startsWith(`${root.toLowerCase()}/`);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const publicJob = job => ({ operationId: job.id, state: job.state, progress: job.progress || 0, message: job.message || '', outputs: job.outputs || [], errorCode: job.errorCode || '' });

function createArchiveService(callHost, options = {}) {
  const jobs = new Map();
  const executable = options.executable || engine.enginePath;
  const hostFor = frame => {
    let tail = Promise.resolve(), lastAt = 0;
    const host = (method, payload) => {
      tail = tail.catch(() => undefined).then(async () => {
        const delay = Math.max(0, lastAt + 20 - Date.now());
        if (delay) await wait(delay);
        lastAt = Date.now();
        return callHost(frame.id, method, payload);
      });
      return tail;
    };
    host.flush = () => tail.catch(() => undefined);
    return host;
  };
  const storageFor = async host => {
    const storage = await host('component.storage', {});
    if (!storage.dataPath) throw new Error('插件存储正在迁移，请稍后重试');
    const directory = path.join(storage.dataPath, 'archive-operations');
    await fs.promises.mkdir(directory, { recursive: true });
    return directory;
  };
  const save = async job => {
    const record = { id: job.id, owner: job.owner, createdAt: job.createdAt, state: job.state, progress: job.progress, message: job.message, errorCode: job.errorCode, outputs: job.outputs, stages: job.stages, directories: job.directories };
    const target = path.join(job.storage, `${job.id}.json`), temporary = `${target}.pending`;
    await fs.promises.writeFile(temporary, JSON.stringify(record), { flag: 'w', mode: 0o600 });
    await fs.promises.rename(temporary, target);
  };
  const paged = async (host, method) => {
    let cursor = null;
    const items = [];
    do {
      const result = await host(method, { pageSize: 200, ...(cursor ? { cursor } : {}) });
      if (result.page.truncated) throw new Error('目录过大，无法完整枚举；请缩小选择范围');
      items.push(...result.items);
      cursor = result.page.hasMore ? result.page.cursor : null;
      if (result.page.hasMore && !cursor) throw new Error('文件列表不完整');
    } while (cursor);
    return items;
  };
  const copyInput = async (host, relativePath, target, signal) => {
    engine.checkCancelled(signal);
    const granted = await host('project.files.inputToken', { relativePath });
    const input = await host('project.input.tokens', { action: 'materialize', token: granted.input.token });
    engine.checkCancelled(signal);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.copyFile(input.privatePath, target, fs.constants.COPYFILE_EXCL);
    return granted.byteLength;
  };
  const archiveFamily = (archive, ordinary) => {
    const stem = path.posix.basename(archive), directory = parent(archive);
    const volumeRoot = stem.replace(/\.\d{3,}$/, '').replace(/\.part\d+\.rar$/i, '');
    const dependencies = ordinary.filter(item => item.kind !== 'directory' && parent(item.relativePath) === directory && (
      item.name === stem || item.name.startsWith(`${volumeRoot}.`) && (/\.\d{3,}$/.test(item.name) || /\.part\d+\.rar$/i.test(item.name))
      || /\.zip$/i.test(stem) && item.name.startsWith(stem.slice(0, -4) + '.') && /\.z\d+$/i.test(item.name)
    )).map(item => engine.safeRelative(item.relativePath));
    return [...new Set([archive, ...dependencies])].sort();
  };
  const prepareArchive = async (host, family, inputs, signal) => {
    await fs.promises.mkdir(inputs);
    for (const name of family) await copyInput(host, name, path.join(inputs, path.posix.basename(name)), signal);
    const first = family.find(name => /\.001$|\.part0*1\.rar$/i.test(name)) || family.find(name => /\.zip$/i.test(name)) || family[0];
    return path.join(inputs, path.posix.basename(first));
  };
  const inspectArchive = async (frame, retain = false, signal) => {
    const payload = frame.payload || {}, host = hostFor(frame);
    const archive = engine.safeRelative(payload.relativePath);
    if (!engine.isArchive(archive)) throw new Error('请选择支持的压缩文件');
    const password = payload.password || '';
    if (typeof password !== 'string' || password.length > 256 || /[\x00-\x1f]/.test(password)) throw new Error('密码无效');
    const storage = await storageFor(host), work = path.join(storage, `inspect-${crypto.randomUUID()}`);
    let retained = false;
    try {
      const ordinary = await paged(host, 'project.files.page');
      const source = await prepareArchive(host, archiveFamily(archive, ordinary), work, signal);
      const result = await engine.inspect({ executable: typeof executable === 'function' ? executable() : executable, archive: source, password, maxBytes: 16 * 1024 ** 3, signal });
      retained = retain;
      return { archiveName: path.posix.basename(archive), ...result, ...(retain ? { privateArchive: source, work } : {}) };
    } finally {
      if (!retained && path.dirname(path.resolve(work)) === path.resolve(storage) && /^inspect-[a-f0-9-]{36}$/.test(path.basename(work))) await fs.promises.rm(work, { recursive: true, force: true });
    }
  };
  const publish = async (job, host) => {
    job.state = 'publishing'; job.progress = 95; job.message = '正在保存到原文件所在位置';
    await save(job);
    for (const stage of job.stages) {
      if (stage.committed) continue;
      const result = await host('project.output', { action: 'commit', stageId: stage.id, idempotencyKey: stage.key, onConflict: 'rename' });
      stage.committed = true;
      job.outputs.push(...result.outputs.map(output => ({ relativePath: output.relativePath, commitId: result.commitId, artifactId: output.artifactId })));
      await save(job);
    }
    // File publication creates parent directories. Preserve any remaining empty folders too.
    if (job.directories.length) {
      const existing = await paged(host, 'project.files.page');
      const directoryPaths = new Set(existing.filter(item => item.kind === 'directory').map(item => item.relativePath.toLowerCase()));
      for (const directory of job.directories.sort((a, b) => a.split('/').length - b.split('/').length)) {
        if (directoryPaths.has(directory.toLowerCase())) continue;
        const plan = await host('project.files.mutate', { phase: 'preflight', action: 'mkdir', targetRelativePath: directory });
        await host('project.files.mutate', { phase: 'commit', planToken: plan.planToken, idempotencyKey: `dir-${crypto.createHash('sha256').update(`${job.id}:${directory}`).digest('hex').slice(0, 48)}` });
        directoryPaths.add(directory.toLowerCase());
      }
    }
    job.state = 'completed'; job.progress = 100; job.message = '处理完成，已保留原文件';
    await save(job);
  };
  const loadSaved = async (host, context) => {
    const storage = await storageFor(host);
    const records = (await fs.promises.readdir(storage)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
    for (const name of records.slice(-64)) {
      const record = JSON.parse(await fs.promises.readFile(path.join(storage, name), 'utf8'));
      if (record.owner !== identity(context) || jobs.has(record.id)) continue;
      record.storage = storage;
      if (!['completed', 'failed', 'cancelled', 'publication-failed'].includes(record.state)) {
        record.state = record.stages?.length ? 'publication-failed' : 'failed';
        record.message = record.stages?.length ? '任务已中断，可以重试保存已生成的文件' : '任务已中断，请重新开始';
      }
      jobs.set(record.id, record);
    }
  };
  const execute = async frame => {
    const payload = frame.payload || {}, host = hostFor(frame);
    const selected = [...new Set((payload.relativePaths || []).map(engine.safeRelative))];
    if (!selected.length || selected.length > engine.MAX_FILES) throw new Error('请选择需要处理的文件或文件夹');
    // The Host strips UI entry IDs from service contexts. The panel explicitly
    // sends the requested operation in its RPC payload instead.
    if (!['compress', 'extract'].includes(payload.mode)) throw new Error('请选择压缩或解压操作');
    const extracting = payload.mode === 'extract';
    const format = payload.format || 'zip';
    const comment = payload.comment ?? '';
    if (typeof comment !== 'string' || Buffer.byteLength(comment, 'utf8') > 65535 || comment.includes('\0')) throw new Error('注释过长或包含不支持的字符');
    if (!extracting && format === '7z' && comment) throw new Error('7z 格式不支持压缩包注释');
    if (extracting && selected.some(name => !engine.isArchive(name))) throw new Error('请选择支持的压缩文件');
    const maxBytes = Number(payload.maxGiB ?? 16) * 1024 ** 3;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 ** 3 || maxBytes > engine.MAX_BYTES) throw new Error('体积上限应为 1～64 GB');
    const password = payload.password || '';
    if (typeof password !== 'string' || password.length > 256 || /[\x00-\x1f]/.test(password)) throw new Error('密码无效');
    const job = { id: crypto.randomUUID(), owner: identity(frame.context), createdAt: Date.now(), state: 'running', message: '正在准备文件', progress: 0, outputs: [], stages: [], directories: [], controller: new AbortController() };
    if ([...jobs.values()].some(item => item.owner === job.owner && ['running', 'publishing'].includes(item.state))) throw new Error('已有压缩任务正在进行，请等待完成');
    job.storage = await storageFor(host);
    jobs.set(job.id, job);
    try {
      await host('tasks', { action: 'start', operationId: job.id, title: extracting ? '解压缩文件' : '添加到压缩文件', message: job.message });
      await save(job);
    } catch (error) {
      job.state = 'failed'; job.message = error.message;
      delete job.controller;
      await save(job).catch(() => undefined);
      return publicJob(job);
    }
    let lastProgress = 0, polling = false;
    const poll = setInterval(() => {
      if (polling) return;
      polling = true;
      void host('tasks', { action: 'status', operationId: job.id }).then(result => { if (result.cancelled) job.controller.abort(); }).catch(() => job.controller.abort()).finally(() => { polling = false; });
    }, 1000);
    const progress = value => {
      job.progress = Math.max(job.progress, Math.min(90, value));
      if (Date.now() - lastProgress < 600) return;
      lastProgress = Date.now();
      void host('tasks', { action: 'report', operationId: job.id, progress: job.progress, message: job.message }).catch(() => undefined);
    };
    const work = path.join(job.storage, `work-${job.id}`);
    let stage, publicationStarted = false;
    try {
      await fs.promises.mkdir(work);
      stage = await host('project.output', { action: 'stage', maxBytes });
      const signal = job.controller.signal, exe = typeof executable === 'function' ? executable() : executable;
      let files = [], targetRoot = '';
      if (!extracting) {
        const base = commonParent(selected), source = path.join(work, 'inputs');
        await fs.promises.mkdir(source);
        const ordinary = await paged(host, 'project.files.page');
        const folders = ordinary.filter(item => item.kind === 'directory' && selected.some(name => belongs(item.relativePath, name)));
        const selectedFolders = folders.filter(item => selected.includes(item.relativePath)).map(item => item.relativePath);
        const candidates = new Set(selected.filter(name => !selectedFolders.includes(name)));
        if (selectedFolders.length) {
          const media = await paged(host, 'project.media.page');
          for (const item of [...ordinary.filter(item => item.kind !== 'directory'), ...media]) if (selectedFolders.some(name => belongs(item.relativePath, name))) candidates.add(item.relativePath);
        }
        if (candidates.size + folders.length > engine.MAX_FILES) throw new Error(`一次最多压缩 ${engine.MAX_FILES} 个文件和目录`);
        for (const folder of folders) await fs.promises.mkdir(path.join(source, engine.safeRelative(folder.relativePath.slice(base ? base.length + 1 : 0))), { recursive: true });
        let total = 0, count = 0;
        for (const name of candidates) {
          total += await copyInput(host, name, path.join(source, engine.safeRelative(name.slice(base ? base.length + 1 : 0))), signal);
          if (total > maxBytes) throw new Error('选择的文件总大小超过所选上限');
          progress(10 + ++count / Math.max(1, candidates.size) * 20);
        }
        const requestedName = payload.name || path.posix.basename(base) || frame.context.projectName || '压缩文件';
        const name = engine.safeRelative(requestedName.replace(/\.(zip|7z)$/i, '') + `.${format}`);
        if (name.includes('/')) throw new Error('压缩文件名称不能包含目录');
        targetRoot = base;
        job.message = '正在压缩并校验压缩包';
        const output = path.join(stage.privatePath, name);
        const names = await engine.compress({ executable: exe, source, destination: output, format, comment, level: Number(payload.level ?? 5), password, splitMiB: Number(payload.splitMiB || 0), encryptNames: payload.encryptNames !== false, signal, onProgress: value => progress(30 + value * 0.5) });
        files = names.map(relativePath => ({ relativePath, targetRelativePath: join(targetRoot, relativePath) }));
      } else {
        const ordinary = await paged(host, 'project.files.page');
        const handled = new Set(), occupied = new Set(ordinary.map(item => item.relativePath.toLowerCase()));
        // Include media paths too: a file with the intended folder name must not block publication.
        for (const item of await paged(host, 'project.media.page')) occupied.add(item.relativePath.toLowerCase());
        for (let index = 0; index < selected.length; index++) {
          const archive = selected[index], stem = path.posix.basename(archive), directory = parent(archive);
          const family = archiveFamily(archive, ordinary), familyKey = family.join('|');
          if (handled.has(familyKey)) continue;
          handled.add(familyKey);
          const source = await prepareArchive(host, family, path.join(work, `archive-${index}`), job.controller.signal);
          const sourceName = `extracted-${index}`, destination = path.join(stage.privatePath, sourceName);
          job.message = `正在解压 ${stem}`;
          const output = await engine.extract({ executable: exe, archive: source, destination, password, maxBytes, signal, onProgress: value => progress(10 + (index + value / 100) / selected.length * 70) });
          const folderName = engine.archiveFolderName(stem), baseRoot = join(directory, folderName);
          targetRoot = baseRoot;
          for (let suffix = 2; occupied.has(targetRoot.toLowerCase()); suffix++) targetRoot = `${baseRoot} (${suffix})`;
          occupied.add(targetRoot.toLowerCase());
          job.directories.push(targetRoot);
          for (const item of output.files) files.push({ relativePath: join(sourceName, item.relativePath), targetRelativePath: join(targetRoot, item.relativePath) });
          job.directories.push(...output.directories.map(name => join(targetRoot, name)));
        }
      }
      engine.checkCancelled(job.controller.signal);
      if (files.length + job.directories.length > engine.MAX_FILES) throw new Error(`一次最多输出 ${engine.MAX_FILES} 个文件和目录`);
      for (const file of files) await host('project.output', { action: 'write', stageId: stage.stageId, name: path.posix.basename(file.relativePath), sourceName: file.relativePath, outputRelativePath: file.targetRelativePath });
      if (files.length) {
        await host('project.output', { action: 'validate', stageId: stage.stageId });
        job.stages.push({ id: stage.stageId, key: `archive-${job.id}` });
      } else {
        await host('project.output', { action: 'rollback', stageId: stage.stageId });
        if (!job.directories.length) throw new Error('压缩包中没有可解压的文件');
      }
      job.directories = [...new Set(job.directories)];
      engine.checkCancelled(job.controller.signal);
      publicationStarted = true;
      clearInterval(poll); // Publication is an atomic Host transaction; cancellation stops before it begins.
      await publish(job, host);
      await host('tasks', { action: 'complete', operationId: job.id, message: job.message });
    } catch (error) {
      job.errorCode = error.code || 'ARCHIVE_OPERATION_FAILED';
      job.state = publicationStarted ? 'publication-failed' : job.controller.signal.aborted ? 'cancelled' : 'failed';
      job.message = publicationStarted ? '文件已生成，但保存未完成；请点击“重试保存”，不要重复压缩或解压' : error.message;
      if (!publicationStarted && stage) await host('project.output', { action: 'rollback', stageId: stage.stageId }).catch(() => undefined);
      await save(job);
      await host('tasks', { action: job.state === 'cancelled' ? 'cancel' : 'fail', operationId: job.id, error: job.message }).catch(() => undefined);
    } finally {
      clearInterval(poll);
      if (path.dirname(path.resolve(work)) === path.resolve(job.storage) && /^work-[a-f0-9-]{36}$/.test(path.basename(work))) await fs.promises.rm(work, { recursive: true, force: true }).catch(() => undefined);
      await host.flush();
      delete job.controller;
    }
    return publicJob(job);
  };
  const handle = async frame => {
    const host = hostFor(frame), payload = frame.payload || {};
    if (frame.method === 'compression.preferences.v1') {
      if (payload.format !== undefined && !['zip', '7z'].includes(payload.format)) throw new Error('不支持的压缩格式');
      const result = await host('component.settings', payload.format === undefined ? { action: 'get' } : { action: 'merge', settings: { lastArchiveFormat: payload.format } });
      return { format: result.settings?.lastArchiveFormat === '7z' ? '7z' : 'zip' };
    }
    if (frame.method === 'compression.inspect.v1') return inspectArchive(frame);
    if (frame.method === 'compression.run.v1') return execute(frame);
    if (frame.method === 'compression.current.v1') {
      await loadSaved(host, frame.context);
      const job = payload.operationId ? jobs.get(payload.operationId) : [...jobs.values()].filter(item => item.owner === identity(frame.context)).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).at(-1);
      return job && job.owner === identity(frame.context) ? publicJob(job) : null;
    }
    const job = jobs.get(payload.operationId);
    if (!job || job.owner !== identity(frame.context)) throw new Error('未找到当前任务');
    if (frame.method === 'compression.cancel.v1') {
      if (job.state !== 'running') throw new Error('当前任务已进入保存阶段或已经结束');
      job.controller?.abort();
      await host('tasks', { action: 'cancel', operationId: job.id });
      return publicJob(job);
    }
    if (frame.method === 'compression.publish.v1' && job.state === 'publication-failed') {
      await host('tasks', { action: 'start', operationId: job.id, title: '保存压缩处理结果' });
      try { await publish(job, host); await host('tasks', { action: 'complete', operationId: job.id }); }
      catch { job.state = 'publication-failed'; job.message = '保存仍未完成，请检查目标位置和磁盘空间'; await save(job); await host('tasks', { action: 'fail', operationId: job.id, error: job.message }); }
      return publicJob(job);
    }
    throw new Error('不支持的压缩操作');
  };
  return { handle, jobs, prepareSession: (frame, signal) => inspectArchive(frame, true, signal) };
}

module.exports = { createArchiveService };
