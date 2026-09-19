const path = require('path');
const { physicalPathKey, capturePathIdentity } = require('./file-identity-service.cjs');
const { removeCreatedPasteTargets, releaseCleanupOwnership } = require('./file-transfer-service.cjs');

const SELECTION_LIMITS = Object.freeze({
  sourceFolderPageSize: 500,
  maxDirectoryDepth: 32,
  maxDirectoriesPerTask: 10000,
  maxSourceFiles: 50000,
  cursorTtlMs: 15 * 60 * 1000,
  maxActiveFolderListings: 100,
});

const normalizeRelativePath = value => {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || path.posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized)) throw new Error('必须选择项目内相对路径');
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) throw new Error('相对路径包含越界片段');
  return segments.join('/');
};

const filenameSelectionKey = fileName => path.parse(fileName).name.match(/(\d{3,})$/)?.[1] || '';
const parseSelectionKeywords = values => {
  const tokens = String(Array.isArray(values) ? values.join(' ') : values || '').match(/[\p{L}\p{N}_.-]+/gu) || [];
  const keywords = [];
  const seen = new Set();
  const append = keyword => {
    const identity = /\p{L}/u.test(keyword) ? keyword.toLocaleLowerCase() : keyword;
    if (!seen.has(identity)) {
      seen.add(identity);
      keywords.push(keyword);
    }
  };
  for (const token of tokens) {
    if (/\p{L}/u.test(token)) {
      const filename = token.replace(/^[._-]+|[._-]+$/g, '');
      if (/\d{3,}/.test(filename) || /\.[\p{L}\p{N}]+$/u.test(filename)) append(filename);
      continue;
    }
    for (const match of token.matchAll(/\d{3,}/g)) append(match[0]);
  }
  return keywords;
};

const createSelectionService = ({ fs, crypto, copyFileAtomic, versionService, projectVirtualPaths, imageExtensions, rawExtensions, videoExtensions }) => {
  const activeOperations = new Map();
  const folderListingCursors = new Map();
  const folderListingOperations = new Map();
  const mediaKind = filePath => {
    const extension = path.extname(filePath).toLocaleLowerCase();
    if (videoExtensions.has(extension)) return 'video';
    if (imageExtensions.has(extension) || rawExtensions.has(extension)) return 'image';
    return '';
  };
  const comparable = physicalPathKey;
  const inside = (parent, candidate, allowSame = false) => {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return (allowSame && !relative) || Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  };
  const resolveProjectEntry = (projectRoot, relativePath, { directory = false } = {}) => {
    const normalized = normalizeRelativePath(relativePath);
    const resolution = projectVirtualPaths?.resolve(projectRoot, normalized, { externalRootMode: 'target' });
    const candidate = resolution?.physicalPath || path.resolve(projectRoot, ...normalized.split('/'));
    const projectReal = fs.realpathSync.native(projectRoot);
    if (!resolution && !inside(projectRoot, candidate)) throw new Error('选择路径超出项目范围');
    if (!fs.existsSync(candidate)) throw new Error(`项目内路径不存在：${normalized}`);
    const real = fs.realpathSync.native(candidate);
    if (!inside(projectReal, real, true)) throw new Error('快捷方式或重解析目录指向项目外部');
    const stat = fs.statSync(candidate);
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(directory ? '来源必须是项目内文件夹' : '选择项必须是媒体文件');
    return { normalized, path: candidate, real, projectReal, resolution };
  };
  const targetForSource = (projectRoot, source) => {
    const sourceName = source.resolution?.externalDisplayName || path.basename(source.path);
    const normalizedSourceName = sourceName.toLocaleLowerCase();
    const outputName = normalizedSourceName === 'raw'
      ? '图片选片'
      : normalizedSourceName === 'mov'
        ? '视频选片'
        : `${sourceName}_选片`;
    const targetPath = path.join(path.dirname(source.path), outputName);
    const targetRelativePath = path.relative(projectRoot, targetPath).replace(/\\/g, '/');
    const parentReal = fs.realpathSync.native(path.dirname(targetPath));
    const outputRoot = source.projectReal;
    if (!inside(outputRoot, parentReal, true)) throw new Error('输出位置的父目录指向项目外部');
    if (fs.existsSync(targetPath)) {
      const targetReal = fs.realpathSync.native(targetPath);
      if (!inside(outputRoot, targetReal)) throw new Error('选片输出快捷方式或重解析目录指向允许范围外部');
      if (!fs.statSync(targetPath).isDirectory()) throw new Error('output_name_conflict：输出名称已被文件占用');
    }
    return { outputName, targetPath, targetRelativePath, recoveryMarkerPath: `${targetPath}.photoflow-selection-pending` };
  };
  const cancelledError = () => Object.assign(new Error('选片任务已取消'), { code: 'TASK_CANCELLED' });
  const ensureActive = job => { if (job?.cancelled) throw cancelledError(); };
  const publishProgress = (request, payload) => request.onProgress?.({ operationId: request.operationId, ...payload });
  const listFiles = async (source, request, job) => {
    const files = [];
    const queue = [{ directory: source.path, depth: 0 }];
    const visited = new Set();
    let directoriesScanned = 0;
    while (queue.length) {
      ensureActive(job);
      const { directory, depth } = queue.shift();
      const directoryReal = fs.realpathSync.native(directory);
      if (!inside(source.real, directoryReal, true)) throw new Error('来源子目录指向来源文件夹外部');
      const directoryKey = comparable(directoryReal);
      if (visited.has(directoryKey)) continue;
      visited.add(directoryKey);
      directoriesScanned += 1;
      if (directoriesScanned > SELECTION_LIMITS.maxDirectoriesPerTask) throw new Error(`selection_directory_limit_exceeded：来源文件夹超过 ${SELECTION_LIMITS.maxDirectoriesPerTask} 个目录，请缩小范围`);
      const entries = await fs.promises.readdir(directory, { withFileTypes: true });
      ensureActive(job);
      entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }));
      for (const entry of entries) {
        ensureActive(job);
        const candidate = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          const linkedReal = fs.realpathSync.native(candidate);
          if (!inside(source.real, linkedReal, true)) throw new Error('来源快捷方式或重解析目录指向来源外部');
          continue;
        }
        if (entry.isDirectory()) {
          const childReal = fs.realpathSync.native(candidate);
          if (!inside(source.real, childReal, true)) throw new Error('来源子目录指向来源文件夹外部');
          if (depth + 1 > SELECTION_LIMITS.maxDirectoryDepth) throw new Error(`selection_depth_limit_exceeded：来源文件夹深度超过 ${SELECTION_LIMITS.maxDirectoryDepth} 层，请缩小范围`);
          queue.push({ directory: candidate, depth: depth + 1 });
        } else if (entry.isFile()) {
          files.push(candidate);
          if (files.length > SELECTION_LIMITS.maxSourceFiles) throw new Error(`selection_file_limit_exceeded：来源文件超过 ${SELECTION_LIMITS.maxSourceFiles} 个，请缩小范围`);
        }
      }
      if (directoriesScanned % 25 === 0 || !queue.length) publishProgress(request, { phase: 'scanning_source', directoriesScanned, filesScanned: files.length, maxDirectories: SELECTION_LIMITS.maxDirectoriesPerTask, maxFiles: SELECTION_LIMITS.maxSourceFiles });
    }
    return files.sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));
  };
  const progressContext = async (workspaceRoot, projectName, source, target) => {
    const listed = await versionService.listProgress(workspaceRoot, projectName, true);
    const nodes = listed.progressFolders || [];
    const sourceNode = nodes.find(node => comparable(node.folderPath) === comparable(source.path) && !node.folderMissing);
    if (sourceNode && (!['original', 'progress'].includes(sourceNode.nodeRole)
      || sourceNode.nodeRole === 'progress' && (!sourceNode.parentProgressId || sourceNode.relationKind !== 'main'))) {
      throw new Error('selection/附属分支/花絮等节点不能作为新的选片来源；只有原始素材或有效版本进度可以使用');
    }
    const targetNode = nodes.find(node => comparable(node.folderPath) === comparable(target.targetPath));
    const sourceSelections = sourceNode ? nodes.filter(node => node.nodeRole === 'selection' && node.parentProgressId === sourceNode.id) : [];
    let recoverableEmptyTarget = false;
    if (!targetNode && fs.existsSync(target.recoveryMarkerPath)) {
      try {
        const marker = JSON.parse(fs.readFileSync(target.recoveryMarkerPath, 'utf8'));
        recoverableEmptyTarget = marker?.sourceFolderRelativePath === source.normalized
          && marker?.targetFolderRelativePath === target.targetRelativePath
          && (!fs.existsSync(target.targetPath) || fs.readdirSync(target.targetPath).length === 0);
      } catch { recoverableEmptyTarget = false; }
    }
    let outputConflict = '';
    if (fs.existsSync(target.targetPath) && !recoverableEmptyTarget && (!targetNode || !sourceNode || targetNode.nodeRole !== 'selection' || targetNode.parentProgressId !== sourceNode.id)) {
      outputConflict = 'output_name_conflict';
    }
    if (sourceSelections.some(node => comparable(node.folderPath) !== comparable(target.targetPath))) outputConflict = 'output_name_conflict';
    return { nodes, sourceNode, targetNode, outputConflict, recoverableEmptyTarget };
  };
  const planFromFiles = async ({ workspaceRoot, projectName, projectRoot, sourceFolderRelativePath, mediaKind: requestedMediaKind, files, keywords = [], missingKeywords = [], unsupportedPaths = [] }) => {
    const source = resolveProjectEntry(projectRoot, sourceFolderRelativePath, { directory: true });
    const target = targetForSource(projectRoot, source);
    const context = await progressContext(workspaceRoot, projectName, source, target);
    const candidates = [];
    const destinationGroups = new Map();
    for (const filePath of files) {
      const kind = mediaKind(filePath);
      if (!kind) continue;
      const sourceRelativePath = path.relative(projectRoot, filePath).replace(/\\/g, '/');
      const relativeInsideSource = path.relative(source.path, filePath);
      if (!inside(source.path, filePath)) throw new Error(`媒体不属于来源文件夹：${sourceRelativePath}`);
      const destination = path.join(target.targetPath, relativeInsideSource);
      const item = {
        sourcePath: filePath,
        sourceRelativePath,
        relativeInsideSource: relativeInsideSource.replace(/\\/g, '/'),
        destination,
        destinationRelativePath: [target.targetRelativePath, relativeInsideSource.replace(/\\/g, '/')].filter(Boolean).join('/'),
        name: path.basename(filePath), kind,
        size: fs.statSync(filePath).size,
        modifiedAt: fs.statSync(filePath).mtimeMs,
      };
      candidates.push(item);
      const key = comparable(destination);
      if (!destinationGroups.has(key)) destinationGroups.set(key, []);
      destinationGroups.get(key).push(item);
    }
    const conflicts = [];
    const existing = [];
    const copyItems = [];
    for (const group of destinationGroups.values()) {
      if (group.length > 1) conflicts.push(...group.map(item => item.destinationRelativePath));
      else if (fs.existsSync(group[0].destination)) existing.push(group[0]);
      else copyItems.push(group[0]);
    }
    if (context.outputConflict) conflicts.unshift(target.targetRelativePath);
    const existingKeys = new Set(existing.map(item => comparable(item.destination)));
    const conflictKeys = new Set(conflicts.map(item => comparable(path.join(projectRoot, item))));
    const items = candidates.map(item => ({
      sourceRelativePath: item.sourceRelativePath,
      destinationRelativePath: item.destinationRelativePath,
      mediaKind: item.kind,
      status: conflictKeys.has(comparable(item.destination)) ? 'destination_collision' : existingKeys.has(comparable(item.destination)) ? 'skipped_existing' : 'planned',
    })).concat(unsupportedPaths.map(sourceRelativePath => ({ sourceRelativePath, status: 'unsupported' })));
    const kinds = new Set(candidates.map(item => item.kind));
    const detectedMediaKind = kinds.size > 1 ? 'mixed' : [...kinds][0] || context.sourceNode?.mediaKind || 'image';
    if (context.sourceNode && context.sourceNode.mediaKind !== 'mixed' && kinds.size && !kinds.has(context.sourceNode.mediaKind)) {
      throw new Error('选片媒体类型与来源节点不兼容');
    }
    const signaturePayload = {
      sourceFolderRelativePath: source.normalized,
      requestedMediaKind: requestedMediaKind || '',
      targetRelativePath: target.targetRelativePath,
      keywords,
      unsupportedPaths,
      outputConflict: context.outputConflict,
      files: candidates.map(item => ({ source: item.sourceRelativePath, destination: item.destinationRelativePath, size: item.size, modifiedAt: item.modifiedAt })),
      existing: existing.map(item => item.destinationRelativePath),
    };
    const signature = crypto.createHash('sha256').update(JSON.stringify(signaturePayload)).digest('hex');
    return {
      source, target, context, candidates, copyItems, existing, conflicts,
      keywords, missingKeywords, unsupportedPaths, detectedMediaKind, signature,
      summary: {
        success: true,
        sourceFolderRelativePath: source.normalized,
        targetFolderRelativePath: target.targetRelativePath,
        outputFolderName: target.outputName,
        matchedCount: candidates.length,
        filesToCopy: copyItems.length,
        existingCount: existing.length,
        conflictCount: conflicts.length,
        missingCount: missingKeywords.length,
        unsupportedCount: unsupportedPaths.length,
        imageCount: candidates.filter(item => item.kind === 'image').length,
        videoCount: candidates.filter(item => item.kind === 'video').length,
        totalBytes: copyItems.reduce((sum, item) => sum + item.size, 0),
        existingPaths: existing.slice(0, 50).map(item => item.destinationRelativePath),
        conflictPaths: conflicts.slice(0, 50),
        missingKeywords,
        unsupportedPaths,
        items,
        signature,
      },
    };
  };
  const preflightFilename = async (request, job) => {
    const source = resolveProjectEntry(request.projectRoot, request.sourceFolderRelativePath, { directory: true });
    const keywords = parseSelectionKeywords(request.keywords);
    if (!keywords.length) throw new Error('没有可用的文件名编号');
    const allFiles = await listFiles(source, request, job);
    const byKeyword = new Map();
    const byFilename = new Map();
    const byStem = new Map();
    const addToIndex = (index, key, filePath) => {
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(filePath);
    };
    for (const filePath of allFiles) {
      const fileName = path.basename(filePath);
      const key = filenameSelectionKey(fileName);
      if (key) addToIndex(byKeyword, key, filePath);
      addToIndex(byFilename, fileName.toLocaleLowerCase(), filePath);
      addToIndex(byStem, path.parse(fileName).name.toLocaleLowerCase(), filePath);
    }
    const files = [];
    const unsupportedPaths = [];
    const missingKeywords = [];
    for (const keyword of keywords) {
      const normalizedKeyword = keyword.toLocaleLowerCase();
      const matches = /^\d{3,}$/.test(keyword)
        ? byKeyword.get(keyword) || []
        : path.extname(keyword)
          ? byFilename.get(normalizedKeyword) || []
          : byStem.get(normalizedKeyword) || [];
      const supported = matches.filter(filePath => {
        const kind = mediaKind(filePath);
        return kind && (!request.mediaKind || kind === request.mediaKind);
      });
      const unsupported = matches.filter(filePath => !mediaKind(filePath));
      unsupportedPaths.push(...unsupported.map(filePath => path.relative(request.projectRoot, filePath).replace(/\\/g, '/')));
      if (request.mediaKind ? !supported.length : !matches.length) missingKeywords.push(keyword);
      else files.push(...supported);
    }
    return planFromFiles({ ...request, files: [...new Set(files)], keywords, missingKeywords, unsupportedPaths: [...new Set(unsupportedPaths)] });
  };
  const purgeExpiredCursors = () => {
    const cutoff = Date.now() - SELECTION_LIMITS.cursorTtlMs;
    for (const [cursor, state] of folderListingCursors) if (state.updatedAt < cutoff) {
      folderListingCursors.delete(cursor);
      folderListingOperations.delete(state.operationId);
    }
  };
  const listSourceFolders = async request => {
    purgeExpiredCursors();
    const pageSize = Math.max(1, Math.min(SELECTION_LIMITS.sourceFolderPageSize, Number(request.pageSize) || SELECTION_LIMITS.sourceFolderPageSize));
    const binding = `${comparable(request.workspaceRoot)}\u0000${String(request.projectName).toLocaleLowerCase()}\u0000${comparable(request.projectRoot)}`;
    let state;
    if (request.cursor) {
      state = folderListingCursors.get(String(request.cursor));
      folderListingCursors.delete(String(request.cursor));
      if (!state || state.binding !== binding) {
        if (state) folderListingOperations.delete(state.operationId);
        throw new Error('selection_cursor_invalid：cursor 无效、已过期或不属于当前项目');
      }
    } else {
      if (folderListingOperations.size >= SELECTION_LIMITS.maxActiveFolderListings) throw new Error('selection_listing_busy：待完成的文件夹列表任务过多');
      const operationId = String(request.operationId || crypto.randomUUID());
      if (!/^[0-9a-z-]{8,128}$/i.test(operationId) || folderListingOperations.has(operationId)) throw new Error('文件夹列表 operationId 无效或重复');
      const projectReal = fs.realpathSync.native(request.projectRoot);
      state = { binding, operationId, projectReal, queue: [{ directory: request.projectRoot, depth: 0 }], pending: [], visited: new Set(), directoriesDiscovered: 0, directoriesScanned: 0, truncated: false, cancelled: false, updatedAt: Date.now() };
      folderListingOperations.set(operationId, state);
    }
    request.operationId = state.operationId;
    try {
    if (state.cancelled) {
      folderListingOperations.delete(state.operationId);
      return { success: false, cancelled: true, operationId: state.operationId, folders: [], nextCursor: null, truncated: state.truncated };
    }
    while (state.pending.length < pageSize && state.queue.length && !state.truncated) {
      ensureActive(state);
      const { directory, depth } = state.queue.shift();
      const real = fs.realpathSync.native(directory);
      if (!inside(state.projectReal, real, true)) throw new Error('项目目录中的重解析目录指向项目外部');
      const realKey = comparable(real);
      if (state.visited.has(realKey)) continue;
      state.visited.add(realKey);
      state.directoriesScanned += 1;
      const entries = await fs.promises.readdir(directory, { withFileTypes: true });
      ensureActive(state);
      entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }));
      for (const entry of entries) {
        ensureActive(state);
        if ((!entry.isDirectory() && !entry.isSymbolicLink()) || entry.name.startsWith('.photoflow-') || entry.name.toLocaleLowerCase() === '_photoflow_safety_temp') continue;
        const candidate = path.join(directory, entry.name);
        const candidateReal = fs.realpathSync.native(candidate);
        if (!inside(state.projectReal, candidateReal)) throw new Error('项目快捷方式或重解析目录指向项目外部');
        if (entry.isSymbolicLink()) continue;
        const nextDepth = depth + 1;
        if (nextDepth > SELECTION_LIMITS.maxDirectoryDepth) { state.truncated = true; break; }
        const relativePath = path.relative(request.projectRoot, candidate).replace(/\\/g, '/');
        state.pending.push({ name: entry.name, relativePath });
        state.directoriesDiscovered += 1;
        if (state.directoriesDiscovered >= SELECTION_LIMITS.maxDirectoriesPerTask) { state.truncated = true; state.queue = []; break; }
        if (nextDepth < SELECTION_LIMITS.maxDirectoryDepth) state.queue.push({ directory: candidate, depth: nextDepth });
        else state.truncated = true;
      }
      if (state.directoriesScanned % 25 === 0 || !state.queue.length || state.pending.length >= pageSize) publishProgress(request, { phase: 'listing_source_folders', directoriesScanned: state.directoriesScanned, directoriesDiscovered: state.directoriesDiscovered, maxDirectories: SELECTION_LIMITS.maxDirectoriesPerTask });
    }
    const folders = state.pending.splice(0, pageSize);
    const hasMore = state.pending.length > 0 || state.queue.length > 0 && !state.truncated;
    let nextCursor = null;
    if (hasMore) {
      nextCursor = crypto.randomBytes(32).toString('base64url');
      state.updatedAt = Date.now();
      folderListingCursors.set(nextCursor, state);
    } else folderListingOperations.delete(state.operationId);
    return { success: true, operationId: state.operationId, folders, nextCursor, truncated: state.truncated };
    } catch (error) {
      folderListingOperations.delete(state.operationId);
      for (const [cursor, candidate] of folderListingCursors) if (candidate === state) folderListingCursors.delete(cursor);
      if (state.cancelled || error?.code === 'TASK_CANCELLED') return { success: false, cancelled: true, operationId: state.operationId, folders: [], nextCursor: null, truncated: state.truncated };
      throw error;
    }
  };
  const preflightManual = async request => {
    const source = resolveProjectEntry(request.projectRoot, request.sourceFolderRelativePath, { directory: true });
    if (!Array.isArray(request.relativePaths) || !request.relativePaths.length) throw new Error('没有选择媒体文件');
    if (request.relativePaths.length > SELECTION_LIMITS.maxSourceFiles) throw new Error(`selection_file_limit_exceeded：手动选择文件超过 ${SELECTION_LIMITS.maxSourceFiles} 个，请缩小范围`);
    const files = request.relativePaths.map(relativePath => {
      const item = resolveProjectEntry(request.projectRoot, relativePath);
      if (!inside(source.path, item.path)) throw new Error(`媒体不属于来源文件夹：${item.normalized}`);
      if (!mediaKind(item.path)) throw new Error(`不支持的媒体文件：${item.normalized}`);
      return item.path;
    });
    return planFromFiles({ ...request, files: [...new Set(files)] });
  };
  const runPreflight = async (request, buildPlan) => {
    const operationId = String(request.operationId || crypto.randomUUID());
    if (!/^[0-9a-z-]{8,128}$/i.test(operationId) || activeOperations.has(operationId)) throw new Error('选片 operationId 无效或重复');
    const job = { cancelled: false };
    const normalizedRequest = { ...request, operationId };
    activeOperations.set(operationId, job);
    try {
      const plan = await buildPlan(normalizedRequest, job);
      return { ...plan.summary, operationId };
    } catch (error) {
      if (job.cancelled || error?.code === 'TASK_CANCELLED') return { success: false, cancelled: true, operationId, error: '选片任务已取消' };
      throw error;
    } finally {
      activeOperations.delete(operationId);
    }
  };
  const ensureNodes = async (request, plan) => {
    let { sourceNode, targetNode, nodes } = plan.context;
    const sourceDisplayName = nodes.some(node => node.id !== sourceNode?.id && node.displayName.toLocaleLowerCase() === path.basename(plan.source.path).toLocaleLowerCase())
      ? plan.source.normalized : path.basename(plan.source.path);
    if (!sourceNode) {
      sourceNode = (await versionService.registerProgress(request.workspaceRoot, {
        projectName: request.projectName,
        mediaKind: plan.detectedMediaKind,
        versionKey: `source-${crypto.createHash('sha256').update(plan.source.normalized.toLocaleLowerCase()).digest('hex').slice(0, 20)}`,
        displayName: sourceDisplayName,
        folderPath: plan.source.path,
        nodeRole: 'original', relationKind: null, parentProgressId: null,
        trackingEnabled: false, renameFromParent: false, copyMissingFromParent: false, trackingState: 'disabled',
      })).progressFolder;
    }
    if (!sourceNode || !['original', 'progress'].includes(sourceNode.nodeRole)
      || sourceNode.nodeRole === 'progress' && (!sourceNode.parentProgressId || sourceNode.relationKind !== 'main')) {
      throw new Error('selection_source_invalid：selection/附属分支/花絮等节点不能作为新的选片来源；只有原始素材或有效版本进度可以使用');
    }
    if (targetNode && (targetNode.nodeRole !== 'selection' || targetNode.parentProgressId !== sourceNode.id)) throw new Error('output_name_conflict');
    const selectionDisplayName = nodes.some(node => node.id !== targetNode?.id && node.displayName.toLocaleLowerCase() === plan.target.outputName.toLocaleLowerCase())
      ? plan.target.targetRelativePath : plan.target.outputName;
    targetNode = (await versionService.registerProgress(request.workspaceRoot, {
      projectName: request.projectName,
      ...(targetNode ? { progressId: targetNode.id } : {}),
      mediaKind: sourceNode.mediaKind || plan.detectedMediaKind,
      versionKey: `selection-${sourceNode.id}`,
      displayName: selectionDisplayName,
      folderPath: plan.target.targetPath,
      nodeRole: 'selection', relationKind: 'auxiliary', parentProgressId: sourceNode.id,
      trackingEnabled: false, renameFromParent: false, copyMissingFromParent: false, trackingState: 'disabled',
    })).progressFolder;
    return { sourceNode, selectionNode: targetNode };
  };
  const executePlan = async (request, buildPlan) => {
    const operationId = String(request.operationId || crypto.randomUUID());
    if (!/^[0-9a-z-]{8,128}$/i.test(operationId) || activeOperations.has(operationId)) throw new Error('选片 operationId 无效或重复');
    const job = { cancelled: false };
    const ownershipToken = `selection-${operationId}-${crypto.randomUUID()}`;
    activeOperations.set(operationId, job);
    const createdFiles = [];
    const createdDirectories = [];
    let nodesReady = false;
    let plan;
    let ownsRecoveryMarker = false;
    let recoveryMarkerIdentity = null;
    try {
      plan = await buildPlan(job);
      if (!request.expectedSignature || request.expectedSignature !== plan.signature) throw new Error('预检结果已经过期，请重新预检');
      // A filename-selection request may scan both the configured image and
      // video sources. A source with no matching media is only a search miss;
      // it must not materialize an empty selection folder or database node.
      if (!plan.candidates.length) {
        releaseCleanupOwnership(ownershipToken);
        return {
          ...plan.summary,
          success: true,
          operationId,
          copiedCount: 0,
        };
      }
      if (plan.context.outputConflict || plan.conflicts.length) throw new Error('output_name_conflict：选片输出名称或文件目标存在冲突');
      if (!plan.context.targetNode) {
        if (!plan.context.recoverableEmptyTarget) {
          await fs.promises.writeFile(plan.target.recoveryMarkerPath, JSON.stringify({
            sourceFolderRelativePath: plan.source.normalized,
            targetFolderRelativePath: plan.target.targetRelativePath,
          }), { encoding: 'utf8', flag: 'wx' });
        }
        ownsRecoveryMarker = true;
        recoveryMarkerIdentity = await capturePathIdentity(plan.target.recoveryMarkerPath);
      }
      if (!fs.existsSync(plan.target.targetPath)) {
        await fs.promises.mkdir(plan.target.targetPath, { recursive: false });
        createdDirectories.push({ path: plan.target.targetPath, identity: await capturePathIdentity(plan.target.targetPath), ownershipToken });
      }
      // Persist the explicit source -> selection relationship before copying.
      // If the process stops mid-copy, the next run can resume against a valid
      // selection node instead of leaving an unregistered output directory.
      const nodes = await ensureNodes(request, plan);
      nodesReady = true;
      if (ownsRecoveryMarker) {
        const markerCleanup = await removeCreatedPasteTargets([{ path: plan.target.recoveryMarkerPath, identity: recoveryMarkerIdentity, ownershipToken }], { ownershipToken });
        if (!markerCleanup.success) throw new Error('选片恢复标记已被替换，无法安全继续');
        ownsRecoveryMarker = false;
      }
      const totalCopyBytes = plan.copyItems.reduce((sum, item) => sum + item.size, 0);
      let completedCopyBytes = 0;
      let lastCopyProgressAt = 0;
      const reportCopyProgress = (item, fileIndex, fileBytesCopied, force = false) => {
        const now = Date.now();
        if (!force && now - lastCopyProgressAt < 250) return;
        lastCopyProgressAt = now;
        const bytesCopied = Math.min(totalCopyBytes, completedCopyBytes + Math.max(0, Number(fileBytesCopied) || 0));
        publishProgress(request, {
          phase: 'copying',
          fileName: item.name,
          fileIndex,
          totalFiles: plan.copyItems.length,
          fileBytesCopied: Math.min(item.size, Math.max(0, Number(fileBytesCopied) || 0)),
          fileTotalBytes: item.size,
          bytesCopied,
          totalBytes: totalCopyBytes,
          progress: totalCopyBytes ? Math.min(100, bytesCopied * 100 / totalCopyBytes) : 100,
        });
      };
      for (const [index, item] of plan.copyItems.entries()) {
        if (job.cancelled) throw Object.assign(new Error('选片任务已取消'), { code: 'TASK_CANCELLED' });
        const fileIndex = index + 1;
        reportCopyProgress(item, fileIndex, 0, true);
        const destinationDirectory = path.dirname(item.destination);
        if (!fs.existsSync(destinationDirectory)) {
          await fs.promises.mkdir(destinationDirectory, { recursive: true });
          createdDirectories.push({ path: destinationDirectory, identity: await capturePathIdentity(destinationDirectory), ownershipToken });
        }
        if (fs.existsSync(item.destination)) throw new Error(`目标文件已存在：${item.destinationRelativePath}`);
        const copied = await copyFileAtomic(item.sourcePath, item.destination, {
          isCancelled: () => job.cancelled,
          onProgress: copyProgress => reportCopyProgress(item, fileIndex, copyProgress.bytesCopied),
          ownershipToken,
        });
        createdFiles.push({ path: item.destination, identity: copied?.publishedIdentity || await capturePathIdentity(item.destination, { digest: true }), ownershipToken });
        reportCopyProgress(item, fileIndex, item.size, true);
        completedCopyBytes += item.size;
      }
      if (job.cancelled) throw Object.assign(new Error('选片任务已取消'), { code: 'TASK_CANCELLED' });
      releaseCleanupOwnership(ownershipToken);
      return {
        ...plan.summary, success: true, operationId, copiedCount: createdFiles.length,
        items: plan.summary.items.map(item => item.status === 'planned' ? { ...item, status: 'copied' } : item),
        sourceProgressId: nodes.sourceNode.id, selectionProgressId: nodes.selectionNode.id,
        selectionNode: nodes.selectionNode,
      };
    } catch (error) {
      if (ownsRecoveryMarker && plan?.target?.recoveryMarkerPath) await removeCreatedPasteTargets([{ path: plan.target.recoveryMarkerPath, identity: recoveryMarkerIdentity, ownershipToken }], { ownershipToken }).catch(() => undefined);
      await removeCreatedPasteTargets(createdFiles.reverse(), { ownershipToken }).catch(() => undefined);
      const directories = [...new Map(createdDirectories.map(item => [physicalPathKey(item.path), item])).values()].sort((left, right) => right.path.length - left.path.length);
      for (const directory of directories) {
        if (nodesReady && physicalPathKey(directory.path) === physicalPathKey(plan?.target?.targetPath || '')) continue;
        await removeCreatedPasteTargets([directory], { ownershipToken }).catch(() => undefined);
      }
      if (job.cancelled || error?.code === 'TASK_CANCELLED') return { success: false, cancelled: true, operationId, error: '选片任务已取消' };
      throw error;
    } finally {
      activeOperations.delete(operationId);
    }
  };

  return {
    listSourceFolders,
    preflightFilename: request => runPreflight(request, (normalizedRequest, job) => preflightFilename(normalizedRequest, job)),
    executeFilename: request => executePlan(request, job => preflightFilename(request, job)),
    preflightManual: request => runPreflight(request, normalizedRequest => preflightManual(normalizedRequest)),
    executeManual: request => executePlan(request, () => preflightManual(request)),
    cancel: operationId => {
      const normalizedOperationId = String(operationId || '');
      const job = activeOperations.get(normalizedOperationId) || folderListingOperations.get(normalizedOperationId);
      if (!job) return false;
      job.cancelled = true;
      for (const [cursor, state] of folderListingCursors) if (state === job) folderListingCursors.delete(cursor);
      folderListingOperations.delete(normalizedOperationId);
      return true;
    },
  };
};

module.exports = { SELECTION_LIMITS, createSelectionService, filenameSelectionKey, normalizeRelativePath, parseSelectionKeywords };
