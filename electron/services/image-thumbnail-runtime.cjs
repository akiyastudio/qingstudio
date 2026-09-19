const path = require('path');

const MAX_JSONL_BUFFER = 1024 * 1024;
const MAX_DIAGNOSTIC_BUFFER = 64 * 1024;
const MAX_OUTPUTS = 32;
const MAX_THUMBNAIL_PIXELS = 16384;

const createImageThumbnailRuntime = ({
  crypto, fs, nativeImage, spawn, processSupervisor = null, getRunConfig, runPythonJsonAction,
  getMediaCacheDir, mediaThumbnailCacheFile, copyWindowsShellThumbnail,
  thumbnailVersion,
}) => {
  let runtimeStopped = false;
  const stopWaiters = new Set();
  const stoppedError = () => Object.assign(new Error('图片解码服务已经停止'), { code: 'EWORKERSTOPPED' });
  const throwIfStopped = () => { if (runtimeStopped) throw stoppedError(); };
  const trackOperation = factory => {
    if (runtimeStopped) return Promise.reject(stoppedError());
    const operation = new Promise((resolve, reject) => {
      let settled = false;
      const settle = callback => value => {
        if (settled) return;
        settled = true;
        stopWaiters.delete(stop);
        callback(value);
      };
      const succeed = settle(resolve);
      const fail = settle(reject);
      const stop = () => fail(stoppedError());
      stopWaiters.add(stop);
      Promise.resolve().then(() => { throwIfStopped(); return factory(); }).then(value => {
        try { throwIfStopped(); succeed(value); } catch (error) { fail(error); }
      }, fail);
    });
    operation.catch(() => undefined);
    return operation;
  };
  const pathKey = value => {
    const resolved = path.resolve(String(value || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const realpath = value => (fs.realpathSync.native || fs.realpathSync)(value);
  const assertManagedTarget = (target, trustedRoots) => {
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw Object.assign(new Error('拒绝将缩略图写入符号链接'), { code: 'EINVALIDREQUEST' });
    const realParent = realpath(path.dirname(target));
    const contained = trustedRoots.some(root => {
      const relative = path.relative(realpath(root), realParent);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    if (!contained) throw Object.assign(new Error('缩略图输出路径超出受管缓存目录'), { code: 'EINVALIDREQUEST' });
  };
  let imageWorkerSequence = 0;
  class ThumbnailImageWorkerPool {
    constructor(size) {
      this.size = size;
      this.workers = [];
      this.queue = [];
      this.nextId = 0;
      this.stopped = false;
    }

    run(source, kind, outputs, urgent = false, trustedRoots = []) {
      if (this.stopped) return Promise.reject(new Error('图片解码服务已经停止'));
      if (!Array.isArray(outputs) || !outputs.length || outputs.length > MAX_OUTPUTS) return Promise.reject(Object.assign(new Error('图片输出数量超出限制'), { code: 'EINVALIDREQUEST' }));
      const normalizedOutputs = outputs.map(output => {
        const pixels = Number(output?.pixels);
        const suppliedPath = String(output?.path || '');
        if (!Number.isInteger(pixels) || pixels < 0 || pixels > MAX_THUMBNAIL_PIXELS || !output?.sizeLabel || !path.isAbsolute(suppliedPath)) throw Object.assign(new Error('图片输出参数无效'), { code: 'EINVALIDREQUEST' });
        const target = path.resolve(suppliedPath);
        assertManagedTarget(target, trustedRoots);
        return { ...output, pixels, path: target };
      });
      return new Promise((resolve, reject) => {
        const job = { id: ++this.nextId, source, kind, outputs: normalizedOutputs, trustedRoots, resolve, reject, settled: false };
        if (urgent) this.queue.unshift(job);
        else this.queue.push(job);
        this.pump();
      });
    }

    settleJob(worker, job, error, value) {
      if (!job || job.settled) return;
      job.settled = true;
      if (worker.job === job) worker.job = null;
      clearTimeout(worker.timer);
      worker.timer = null;
      if (error) job.reject(error);
      else job.resolve(value);
    }

    retireWorker(worker, reason) {
      if (worker.dead) return;
      worker.dead = true;
      this.workers = this.workers.filter(item => item !== worker);
      if (worker.managedProcess) {
        let stopResult;
        try {
          stopResult = worker.managedProcess.stop(reason, { timeoutMs: 2000 });
          void Promise.resolve(stopResult).catch(() => undefined);
          return;
        } catch { /* fall back to direct process termination */ }
      }
      try { worker.child.kill('SIGTERM'); } catch { /* already gone */ }
      const killTimer = setTimeout(() => { try { worker.child.kill('SIGKILL'); } catch { /* already gone */ } }, 500);
      killTimer.unref?.();
    }

    createWorker() {
      const { command, args } = getRunConfig('thumbnail_image.py', ['--server']);
      let managedProcess;
      let child;
      try {
        managedProcess = processSupervisor?.launch({
          id: `python:thumbnail-image:${++imageWorkerSequence}`,
          kind: 'python-worker', command, args, options: { stdio: ['pipe', 'pipe', 'pipe'] }, ephemeral: true,
        });
        child = managedProcess?.child || spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        error.code ||= 'EWORKERSPAWN';
        throw error;
      }
      const worker = { child, managedProcess, output: '', stderr: '', job: null, timer: null, dead: false };
      this.workers.push(worker);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', data => {
        if (worker.dead) return;
        worker.output += data;
        if (worker.output.length > MAX_JSONL_BUFFER) {
          const error = Object.assign(new Error('图片解码服务输出超出限制'), { code: 'EWORKERPROTOCOL' });
          this.settleJob(worker, worker.job, error);
          this.retireWorker(worker, 'thumbnail-image-output-limit');
          this.pump();
          return;
        }
        const lines = worker.output.split(/\r?\n/);
        worker.output = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let response;
          try { response = JSON.parse(line); } catch {
            const error = Object.assign(new Error('图片解码服务返回了无效协议数据'), { code: 'EWORKERPROTOCOL' });
            this.settleJob(worker, worker.job, error);
            this.retireWorker(worker, 'thumbnail-image-invalid-json');
            this.pump();
            return;
          }
          if (!worker.job || response.id !== worker.job.id) continue;
          worker.managedProcess?.markHealthy({ protocol: 'json-lines' });
          const job = worker.job;
          if (response.success) {
            let generated;
            try { generated = this.validateGenerated(job, response.generated); }
            catch (error) {
              this.settleJob(worker, job, error);
              this.retireWorker(worker, 'thumbnail-image-invalid-output');
              this.pump();
              continue;
            }
            this.settleJob(worker, job, null, generated);
          }
          else {
            const error = new Error(response.error || '图片解码失败');
            error.code = response.code || 'EIMAGEDECODE';
            this.settleJob(worker, job, error);
          }
          this.pump();
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', data => {
        if (worker.dead) return;
        worker.stderr += data;
        if (worker.stderr.length > MAX_DIAGNOSTIC_BUFFER) {
          const error = Object.assign(new Error('图片解码服务错误输出超出限制'), { code: 'EWORKERPROTOCOL' });
          this.settleJob(worker, worker.job, error);
          this.retireWorker(worker, 'thumbnail-image-stderr-limit');
          this.pump();
        }
      });
      const finish = error => {
        if (worker.dead) return;
        worker.dead = true;
        clearTimeout(worker.timer);
        error.code ||= 'EWORKEREXIT';
        this.settleJob(worker, worker.job, error);
        this.workers = this.workers.filter(item => item !== worker);
        if (!this.stopped) this.pump();
      };
      child.on('error', finish);
      child.on('exit', code => finish(new Error(worker.stderr.trim() || `图片解码服务退出，代码 ${code}`)));
      return worker;
    }

    validateGenerated(job, generated) {
      if (!Array.isArray(generated) || generated.length !== job.outputs.length) throw Object.assign(new Error('图片解码服务返回了无效输出列表'), { code: 'EWORKERPROTOCOL' });
      const expected = new Map(job.outputs.map(output => [`${String(output.sizeLabel)}\0${output.pixels}`, output.path]));
      for (const item of generated) {
        const expectedPath = expected.get(`${String(item?.sizeLabel)}\0${Number(item?.pixelSize)}`);
        if (!expectedPath || pathKey(item?.path) !== pathKey(expectedPath)) throw Object.assign(new Error('图片解码服务返回了未授权的输出路径'), { code: 'EWORKERPROTOCOL' });
        assertManagedTarget(expectedPath, job.trustedRoots);
        expected.delete(`${String(item.sizeLabel)}\0${Number(item.pixelSize)}`);
      }
      if (expected.size) throw Object.assign(new Error('图片解码服务缺少预期输出'), { code: 'EWORKERPROTOCOL' });
      return generated;
    }

    pump() {
      if (this.stopped) return;
      while (this.workers.length < this.size && this.queue.length > this.workers.filter(worker => !worker.job && !worker.dead).length) {
        try { this.createWorker(); }
        catch (error) { this.queue.shift()?.reject(error); }
      }
      for (const worker of this.workers) {
        if (worker.dead || worker.job || !this.queue.length) continue;
        const job = this.queue.shift();
        worker.job = job;
        worker.stderr = '';
        worker.timer = setTimeout(() => {
          if (worker.job !== job) return;
          this.settleJob(worker, job, Object.assign(new Error('图片解码超时'), { code: 'EWORKERTIMEOUT' }));
          this.retireWorker(worker, 'thumbnail-image-timeout');
          this.pump();
        }, 120000);
        try {
          worker.child.stdin.write(`${JSON.stringify({ id: job.id, source: job.source, kind: job.kind, outputs: job.outputs })}\n`, error => {
            if (!error || worker.dead || worker.job !== job) return;
            error.code ||= 'EWORKERPIPE';
            this.settleJob(worker, job, error);
            this.retireWorker(worker, 'thumbnail-image-write-error');
            this.pump();
          });
        } catch (error) {
          error.code ||= 'EWORKERPIPE';
          this.settleJob(worker, job, error);
          this.retireWorker(worker, 'thumbnail-image-write-error');
          this.pump();
        }
      }
    }

    stop() {
      this.stopped = true;
      for (const job of this.queue.splice(0)) job.reject(new Error('图片解码服务已经停止'));
      for (const worker of this.workers) {
        this.settleJob(worker, worker.job, Object.assign(new Error('图片解码服务已经停止'), { code: 'EWORKERSTOPPED' }));
        this.retireWorker(worker, 'thumbnail-image-pool-stop');
      }
    }
  }

  let thumbnailPool = null;
  let originalPreviewPool = null;
  const activeVideoProcesses = new Set();
  const activeRawProcesses = new Set();
  const waitForExit = (child, timeoutMs) => {
    if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve();
    return new Promise(resolve => {
      let timer;
      const finish = () => {
        clearTimeout(timer);
        child.removeListener?.('exit', finish);
        child.removeListener?.('close', finish);
        resolve();
      };
      child.once('exit', finish);
      child.once('close', finish);
      timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
    });
  };
  const runRawDecoder = (sourcePath, outputs) => new Promise((resolve, reject) => {
    try { throwIfStopped(); } catch (error) { reject(error); return; }
    const token = crypto.randomUUID().replace(/-/g, '').toLowerCase();
    const outputPaths = outputs.map(output => path.resolve(output.path));
    const { command, args } = getRunConfig('raw_decoder.py', ['--source', sourcePath, '--outputs', JSON.stringify(outputs)]);
    let managedProcess;
    let child;
    try {
      const options = { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PHOTOFLOW_RAW_JOB_TOKEN: token } };
      managedProcess = processSupervisor?.launch({
        id: `python:raw-decoder:${++imageWorkerSequence}`,
        kind: 'python-job', command, args, options, ephemeral: true,
      });
      child = managedProcess?.child || spawn(command, args, { windowsHide: true, ...options });
    } catch (error) {
      error.code ||= 'EWORKERSPAWN';
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const cleanup = async () => {
      for (const outputPath of outputPaths) {
        const staging = path.join(path.dirname(outputPath), '.photoflow-thumbnail-staging');
        let names = [];
        try {
          if (fs.lstatSync(staging).isSymbolicLink()) continue;
          const expectedStaging = path.join(realpath(path.dirname(outputPath)), '.photoflow-thumbnail-staging');
          if (pathKey(realpath(staging)) !== pathKey(expectedStaging)) continue;
          names = await fs.promises.readdir(staging);
        } catch { continue; }
        await Promise.all(names.filter(name => name.startsWith(`${token}-`) && name.endsWith('.tmp')).map(async name => {
          const candidate = path.join(staging, name);
          try {
            const stat = await fs.promises.lstat(candidate);
            if (stat.isFile() && !stat.isSymbolicLink()) await fs.promises.unlink(candidate);
          } catch { /* confined best-effort cleanup */ }
        }));
      }
    };
    const terminate = async (error, reason) => {
      settle(error);
      if (managedProcess) {
        try { await Promise.resolve(managedProcess.stop(reason, { timeoutMs: 2000 })); }
        catch { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
      }
      if (child.exitCode == null && child.signalCode == null) {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        await waitForExit(child, 500);
        if (child.exitCode == null && child.signalCode == null) {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          await waitForExit(child, 1500);
        }
      }
      await cleanup();
      activeRawProcesses.delete(record);
    };
    const record = { terminate };
    activeRawProcesses.add(record);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => {
      if (settled) return;
      stdout += data;
      if (stdout.length > MAX_JSONL_BUFFER) void terminate(Object.assign(new Error('RAW 解码器输出超出限制'), { code: 'EWORKERPROTOCOL' }), 'raw-decoder-output-limit');
    });
    child.stderr.on('data', data => {
      if (settled) return;
      stderr += data;
      if (stderr.length > MAX_DIAGNOSTIC_BUFFER) void terminate(Object.assign(new Error('RAW 解码器错误输出超出限制'), { code: 'EWORKERPROTOCOL' }), 'raw-decoder-stderr-limit');
    });
    child.on('error', error => { error.code ||= 'EWORKERSPAWN'; void terminate(error, 'raw-decoder-error'); });
    child.on('close', code => {
      activeRawProcesses.delete(record);
      if (settled) return;
      const payloads = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      const payload = payloads[payloads.length - 1];
      if (code !== 0 || !payload) settle(Object.assign(new Error(stderr.trim() || 'RAW 解码器未返回有效结果'), { code: 'EWORKERPROTOCOL' }));
      else settle(null, payload);
    });
    timer = setTimeout(() => void terminate(Object.assign(new Error('RAW 解码超时'), { code: 'EWORKERTIMEOUT' }), 'raw-decoder-timeout'), 5 * 60 * 1000);
    timer.unref?.();
  });
  const validateExternalGenerated = (outputs, generated, trustedRoots) => {
    if (!Array.isArray(generated) || generated.length !== outputs.length) throw Object.assign(new Error('RAW 解码器返回了无效输出列表'), { code: 'EWORKERPROTOCOL' });
    const expected = new Map(outputs.map(output => [`${String(output.sizeLabel)}\0${Number(output.pixels)}`, path.resolve(output.path)]));
    for (const item of generated) {
      const key = `${String(item?.sizeLabel)}\0${Number(item?.pixelSize)}`;
      if (!expected.has(key) || pathKey(item?.path) !== pathKey(expected.get(key))) throw Object.assign(new Error('RAW 解码器返回了未授权的输出路径'), { code: 'EWORKERPROTOCOL' });
      assertManagedTarget(path.resolve(item.path), trustedRoots);
      expected.delete(key);
    }
    return generated;
  };
  const runImageDecoderWithRawFallback = async (pool, sourcePath, kind, outputs, urgent, trustedRoots) => {
    try {
      return await pool.run(sourcePath, kind, outputs, urgent, trustedRoots);
    } catch (embeddedError) {
      if (kind !== 'raw' || embeddedError?.code !== 'EIMAGEDECODE') throw embeddedError;
      throwIfStopped();
      const result = await runRawDecoder(sourcePath, outputs);
      throwIfStopped();
      if (!result?.success || !Array.isArray(result.generated)) throw new Error(result?.error || '内置 RAW 解码器未能生成预览');
      return validateExternalGenerated(outputs, result.generated, trustedRoots);
    }
  };
  const generateImageThumbnailFiles = (sourcePath, kind, outputs, urgent = false, trustedRoots = [...new Set(outputs.map(output => path.dirname(path.resolve(output.path))))]) => {
    throwIfStopped();
    if (!thumbnailPool) thumbnailPool = new ThumbnailImageWorkerPool(2);
    return runImageDecoderWithRawFallback(thumbnailPool, sourcePath, kind, outputs, urgent, trustedRoots);
  };
  const generateOriginalImagePreviewFile = (sourcePath, kind, outputs) => {
    throwIfStopped();
    if (!originalPreviewPool) originalPreviewPool = new ThumbnailImageWorkerPool(1);
    const trustedRoots = [...new Set(outputs.map(output => path.dirname(path.resolve(output.path))))];
    return runImageDecoderWithRawFallback(originalPreviewPool, sourcePath, kind, outputs, true, trustedRoots);
  };
  const generateVideoCoverSource = (sourcePath, stat, cacheDir, requestedSize) => new Promise((resolve, reject) => {
    try { throwIfStopped(); } catch (error) { reject(error); return; }
    const cacheKey = crypto.createHash('sha256').update(`scheduler-video-cover|v${thumbnailVersion}|${requestedSize}|${sourcePath}|${stat.size}|${stat.mtimeMs}`).digest('hex');
    const toolArgs = ['--source', sourcePath, '--output_dir', cacheDir, '--cache_key', cacheKey, '--size', String(requestedSize)];
    const { command, args } = getRunConfig('video_preview.py', toolArgs);
    const managedProcess = processSupervisor?.launch({
      id: `python:video-preview:${++imageWorkerSequence}`,
      kind: 'python-job', command, args, options: {}, ephemeral: true,
    });
    const child = managedProcess?.child || spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = error => { if (!settled) { settled = true; reject(error); } };
    const recycle = reason => {
      if (managedProcess) {
        let stopResult;
        try {
          stopResult = managedProcess.stop(reason, { timeoutMs: 2000 });
          void Promise.resolve(stopResult).catch(() => undefined);
          return;
        } catch { /* fall back to direct process termination */ }
      }
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 500);
      killTimer.unref?.();
    };
    const activeVideo = { recycle, fail };
    activeVideoProcesses.add(activeVideo);
    const timer = setTimeout(() => { fail(Object.assign(new Error('视频封面生成超时'), { code: 'EWORKERTIMEOUT' })); recycle('video-preview-timeout'); }, 120000);
    child.stdout.on('data', data => { if (settled) return; stdout += data.toString(); if (stdout.length > MAX_JSONL_BUFFER) { fail(new Error('视频封面输出超出限制')); recycle('video-preview-output-limit'); } });
    child.stderr.on('data', data => { if (settled) return; stderr += data.toString(); if (stderr.length > MAX_DIAGNOSTIC_BUFFER) { fail(new Error('视频封面错误输出超出限制')); recycle('video-preview-stderr-limit'); } });
    child.on('error', error => { clearTimeout(timer); activeVideoProcesses.delete(activeVideo); fail(error); });
    child.on('close', code => {
      clearTimeout(timer);
      activeVideoProcesses.delete(activeVideo);
      try {
        const payloads = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
        const payload = [...payloads].reverse().find(item => Array.isArray(item.frames) && item.frames.length);
        const errorPayload = [...payloads].reverse().find(item => item?.error || item?.message);
        const framePath = payload?.frames?.[0] ? path.resolve(payload.frames[0]) : '';
        const relativeFrame = framePath ? path.relative(path.resolve(cacheDir), framePath) : '..';
        if (code !== 0 || !payload || relativeFrame.startsWith('..') || path.isAbsolute(relativeFrame) || !fs.existsSync(framePath) || fs.lstatSync(framePath).isSymbolicLink()) {
          throw new Error(stderr.trim() || errorPayload?.error || errorPayload?.message || 'FFmpeg 未能生成视频封面');
        }
        if (!settled) { settled = true; resolve(framePath); }
      } catch (error) { fail(error); }
    });
  });
  const writeThumbnailJpeg = async (target, image, quality) => {
    const stagingDirectory = path.join(path.dirname(target), '.photoflow-thumbnail-staging');
    await fs.promises.mkdir(stagingDirectory, { recursive: true });
    if (fs.lstatSync(stagingDirectory).isSymbolicLink()) throw new Error('缩略图临时目录不能是符号链接');
    const staleBefore = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of await fs.promises.readdir(stagingDirectory)) {
      if (!name.endsWith('.tmp')) continue;
      const candidate = path.join(stagingDirectory, name);
      try {
        const candidateStat = await fs.promises.lstat(candidate);
        if (candidateStat.isFile() && !candidateStat.isSymbolicLink() && candidateStat.mtimeMs < staleBefore) await fs.promises.unlink(candidate);
      } catch { /* cleanup is best effort and remains confined to the staging directory */ }
    }
    const temporary = path.join(stagingDirectory, `${crypto.randomUUID()}.tmp`);
    let ownsTemporary = false;
    try {
      await fs.promises.writeFile(temporary, image.toJPEG(quality), { flag: 'wx' });
      ownsTemporary = true;
      if (fs.existsSync(target)) {
        await fs.promises.unlink(temporary);
        ownsTemporary = false;
      } else {
        await fs.promises.rename(temporary, target);
        ownsTemporary = false;
      }
    } finally {
      if (ownsTemporary && fs.existsSync(temporary)) await fs.promises.unlink(temporary);
    }
  };
  const generateThumbnailSet = async (sourcePath, stat, kind, cacheConfig, sizes) => {
    throwIfStopped();
    if (!Array.isArray(sizes) || !sizes.length || sizes.length > MAX_OUTPUTS || sizes.some(size => !size?.label || !Number.isInteger(Number(size.pixels)) || Number(size.pixels) <= 0 || Number(size.pixels) > MAX_THUMBNAIL_PIXELS)) {
      throw Object.assign(new Error('缩略图请求超出资源限制'), { code: 'EINVALIDREQUEST' });
    }
    const cacheDir = getMediaCacheDir(cacheConfig);
    const ordered = [...sizes].sort((left, right) => right.pixels - left.pixels);
    const targets = new Map(ordered.map(size => [
      size.label,
      size.path ? path.resolve(size.path) : mediaThumbnailCacheFile(sourcePath, stat, cacheDir, size.pixels, thumbnailVersion),
    ]));
    for (const target of targets.values()) assertManagedTarget(target, [cacheDir]);
    let missing = ordered.filter(size => !fs.existsSync(targets.get(size.label)));
    if (!missing.length) return ordered.map(size => ({ sizeLabel: size.label, pixelSize: size.pixels, path: targets.get(size.label) }));
    const largest = missing[0];
    const largestTarget = targets.get(largest.label);
    let generatedByShell = await copyWindowsShellThumbnail(sourcePath, largestTarget, largest.pixels, true);
    throwIfStopped();
    if (!generatedByShell) generatedByShell = await copyWindowsShellThumbnail(sourcePath, largestTarget, largest.pixels, false);
    throwIfStopped();
    if (generatedByShell) {
      missing = missing.slice(1);
      if (missing.length) await generateImageThumbnailFiles(largestTarget, 'image', missing.map(size => ({ sizeLabel: size.label, pixels: size.pixels, path: targets.get(size.label) })), false, [cacheDir]);
    } else if (kind === 'video') {
      const coverPath = await generateVideoCoverSource(sourcePath, stat, cacheDir, largest.pixels);
      throwIfStopped();
      await generateImageThumbnailFiles(coverPath, 'image', missing.map(size => ({ sizeLabel: size.label, pixels: size.pixels, path: targets.get(size.label) })), false, [cacheDir]);
    } else {
      try {
        await generateImageThumbnailFiles(sourcePath, kind === 'raw' ? 'raw' : 'image', missing.map(size => ({ sizeLabel: size.label, pixels: size.pixels, path: targets.get(size.label) })), false, [cacheDir]);
      } catch (decodeError) {
        if (kind === 'raw') throw decodeError;
        let fallbackGenerated = false;
        for (const size of missing) {
          throwIfStopped();
          const target = targets.get(size.label);
          let thumbnail = nativeImage.createEmpty();
          try { thumbnail = await nativeImage.createThumbnailFromPath(sourcePath, { width: size.pixels, height: size.pixels }); } catch {}
          throwIfStopped();
          if (!thumbnail.isEmpty()) {
            await writeThumbnailJpeg(target, thumbnail, size.pixels >= 960 ? 84 : 80);
            fallbackGenerated = true;
          }
        }
        if (!fallbackGenerated) throw decodeError;
      }
    }
    throwIfStopped();
    return ordered.filter(size => fs.existsSync(targets.get(size.label))).map(size => ({ sizeLabel: size.label, pixelSize: size.pixels, path: targets.get(size.label) }));
  };
  return {
    generateOriginalImagePreviewFile: (...args) => trackOperation(() => generateOriginalImagePreviewFile(...args)),
    generateThumbnailSet: (...args) => trackOperation(() => generateThumbnailSet(...args)),
    stop: () => {
      if (runtimeStopped) return;
      runtimeStopped = true;
      for (const stop of [...stopWaiters]) stop();
      thumbnailPool?.stop();
      originalPreviewPool?.stop();
      for (const active of [...activeVideoProcesses]) {
        active.fail(stoppedError());
        active.recycle('thumbnail-runtime-stop');
      }
      activeVideoProcesses.clear();
      return Promise.all([...activeRawProcesses].map(active => active.terminate(stoppedError(), 'thumbnail-runtime-stop'))).then(() => undefined);
    },
  };
};

module.exports = { createImageThumbnailRuntime };
