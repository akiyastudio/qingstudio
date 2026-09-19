const fs = require('node:fs');
const path = require('node:path');
const { records } = require('./rename-performance-diagnostics.cjs');

const runRenamePerformanceProbe = async ({ app, mainWindow }) => {
  const report = { createdAt: new Date().toISOString(), environment: { platform: process.platform, electron: process.versions.electron },
    notes: ['Synthetic isolated workspace on the local drive; no customer folders are renamed.',
      'Native rename duration includes helper startup. Progress commit includes Python/database/filesystem work.',
      'UI timing uses the actual React rename form and waits for its selection control to become enabled.'], samples: [] };
  try {
    report.samples = await mainWindow.webContents.executeJavaScript(`(${rendererRenameProbe.toString()})()`);
  } catch (error) {
    report.error = error.message;
    report.rendererState = await mainWindow.webContents.executeJavaScript('document.body.innerText').catch(() => 'unavailable');
    report.samples = await mainWindow.webContents.executeJavaScript('window.__renameBenchmarkSamples || []').catch(() => []);
  } finally {
    report.backend = records.map(({ started, finished, ...record }) => record);
    if (!report.error && (report.backend.length !== report.samples.length || report.samples.some(sample => {
      const backend = report.backend[sample.backendIndex];
      return !backend?.success || (Number.isFinite(sample.uiActionableMs) && sample.uiActionableMs + 20 < backend.durationMs);
    }))) report.error = 'Renderer samples do not match completed backend rename requests';
    report.summary = [...new Set(report.samples.map(sample => sample.scenario))].map(scenario => {
      const samples = report.samples.filter(sample => sample.scenario === scenario);
      const median = key => { const values = samples.map(sample => sample[key]).filter(Number.isFinite).sort((a, b) => a - b); return values.length ? values[Math.floor(values.length / 2)] : null; };
      return { scenario, samples: samples.length, medianIpcMs: median('ipcMs'), medianDirectoryRefreshMs: median('directoryRefreshMs'), medianUiActionableMs: median('uiActionableMs') };
    });
    fs.writeFileSync(path.join(app.getPath('userData'), 'rename-performance.json'), JSON.stringify(report, null, 2));
    process.stdout.write(`PHOTOFLOW_RENAME_BENCHMARK_RESULT=${JSON.stringify({ summary: report.summary, error: report.error })}\n`);
  }
};

async function rendererRenameProbe() {
  const samples = window.__renameBenchmarkSamples = [];
  const api = window.electronAPI;
  let backendIndex = 0;
  const visible = selector => [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length > 0);
  const config = await api.loadConfig();
  const check = result => { if (!result?.success) throw new Error(result?.error || 'Benchmark API failed'); return result; };
  const waitFor = async (predicate, label, timeout = 20000) => {
    const start = performance.now();
    while (performance.now() - start < timeout) { const result = predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error(`Timed out: ${label}`);
  };
  const workspace = check(await api.getWorkspaceProjects(config.workspacePath));
  const projects = workspace.statuses.flatMap(group => group.projects.map(project => ({ ...project, status: group.status })));
  for (const project of projects.filter(project => project.name.startsWith('Rename-')).sort((left, right) => right.name.localeCompare(left.name))) {
    let ordinaryPath = '000-ordinary-a';
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const nextName = `000-ordinary-${iteration % 2 ? 'a' : 'b'}`;
      const started = performance.now();
      check(await api.projectFileOperation(config.workspacePath, project.status, project.name, 'rename', [ordinaryPath], '', nextName));
      samples.push({ scenario: project.name + '/unregistered', backendIndex: backendIndex++, iteration, ipcMs: performance.now() - started });
      ordinaryPath = nextName;
    }
    const original = check(await api.adoptVersionTreeFolder(config.workspacePath, project.status, {
      projectName: project.name, relativePath: 'fixture-0000', mode: 'original', mediaKind: 'image',
    }));
    const progressResult = check(await api.createProgressFolder(config.workspacePath, project.status, project.name, {
      mediaKind: 'image', versionKey: '1', displayName: 'Benchmark progress', parentProgressId: original.progressFolder.id,
    }));
    let progress = progressResult.progressFolder;
    let progressPath = progressResult.folder.relativePath;
    let filePath = '001-file-a.txt';
    for (const kind of ['ordinary', 'progress']) {
      for (let iteration = 0; iteration < 5; iteration += 1) {
        const nextName = kind === 'ordinary' ? `000-ordinary-${iteration % 2 ? 'b' : 'a'}` : `000-progress-${iteration % 2 ? 'a' : 'b'}`;
        const started = performance.now();
        const result = check(kind === 'ordinary'
          ? await api.projectFileOperation(config.workspacePath, project.status, project.name, 'rename', [ordinaryPath], '', nextName)
          : await api.renameProgressFolder(config.workspacePath, project.status, project.name, {
            progressId: progress.id, expectedFolderId: progress.folderId, expectedRelativePath: progressPath, newName: nextName,
          }));
        const ipcMs = performance.now() - started;
        if (kind === 'ordinary') ordinaryPath = nextName;
        else { progress = result.progressFolder; progressPath = result.newRelativePath; }
        const refreshStarted = performance.now();
        check(await api.browseProjectFiles(config.workspacePath, project.status, project.name, '', config.mediaCache));
        const directoryRefreshMs = performance.now() - refreshStarted;
        const contentsStarted = performance.now();
        check(await api.getProjectContents(config.workspacePath, project.status, project.name));
        samples.push({ scenario: project.name + '/' + kind, backendIndex: backendIndex++, iteration, ipcMs, directoryRefreshMs, projectContentsMs: performance.now() - contentsStarted });
      }
    }
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const nextName = `001-file-${iteration % 2 ? 'a' : 'b'}.txt`;
      const started = performance.now();
      check(await api.projectFileOperation(config.workspacePath, project.status, project.name, 'rename', [filePath], '', nextName));
      samples.push({ scenario: project.name + '/file', backendIndex: backendIndex++, iteration, ipcMs: performance.now() - started });
      filePath = nextName;
    }
    // Open the same isolated project through the actual project navigator.
    const projectButton = await waitFor(() => [...document.querySelectorAll('.project-row button')].find(button => button.textContent.trim() === project.name), 'project navigator ' + project.name);
    projectButton.click();
    await waitFor(() => visible('[data-project-overview] h2').some(heading => heading.textContent === project.name), 'active project ' + project.name);
    (await waitFor(() => visible('button[aria-label="列表模式"]')[0], 'list view')).click();
    (await waitFor(() => visible('button[aria-label="排序"]')[0], 'sort menu')).click();
    (await waitFor(() => visible('.sort-menu button').find(button => button.textContent.trim() === '文件名'), 'name sort')).click();
    for (const [kind, oldPath] of [['ordinary', ordinaryPath], ['progress', progressPath]]) {
      for (const selected of visible('[data-entry-path] button[aria-pressed="true"][aria-label^="取消选择 "]')) selected.click();
      await new Promise(resolve => setTimeout(resolve, 30));
      const row = await waitFor(() => visible('[data-entry-path]').find(entry => entry.dataset.entryPath === oldPath), 'file row ' + kind);
      const select = row.querySelector('button[aria-pressed]');
      if (!select) throw new Error('Selection control is missing');
      if (select.getAttribute('aria-pressed') !== 'true') select.click();
      await new Promise(resolve => setTimeout(resolve, 30));
      row.focus();
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
      const input = await waitFor(() => visible('[data-inline-rename-input]')[0], 'rename input ' + kind);
      const newName = '000-' + project.name + '-' + kind + '-ui';
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, newName);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 20));
      const started = performance.now();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await waitFor(() => {
        const entry = visible('[data-entry-path]').find(candidate => candidate.dataset.entryPath === newName);
        const control = entry?.querySelector('button[aria-pressed]');
        return control && !control.disabled && !visible('[data-inline-rename-input]').length;
      }, 'renamed folder actionable ' + kind);
      const uiActionableMs = performance.now() - started;
      const newRow = visible('[data-entry-path]').find(entry => entry.dataset.entryPath === newName);
      newRow.focus();
      const followUpStarted = performance.now();
      newRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
      const followUpInput = await waitFor(() => visible('[data-inline-rename-input]')[0], 'immediate second rename ' + kind);
      if (followUpInput.value !== newName) throw new Error('Second rename opened a stale path');
      const followUpRenameReadyMs = performance.now() - followUpStarted;
      followUpInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await waitFor(() => !visible('[data-inline-rename-input]').length, 'cancel follow-up rename');
      const verified = check(await api.browseProjectFiles(config.workspacePath, project.status, project.name, '', config.mediaCache));
      if (!verified.entries.some(entry => entry.relativePath === newName)) throw new Error('UI rename did not commit in the intended project');
      samples.push({ scenario: project.name + '/' + kind + '/ui', backendIndex: backendIndex++, uiActionableMs, followUpRenameReadyMs });
    }
    // Exercise the real single-click handler while the selected rename source
    // still belongs to an in-flight operation. This used to add the sibling
    // to selection instead of opening it.
    for (const selected of visible('[data-entry-path] button[aria-pressed="true"]')) selected.click();
    await new Promise(resolve => setTimeout(resolve, 30));
    const sourceName = '000-' + project.name + '-ordinary-ui';
    const row = await waitFor(() => visible('[data-entry-path]').find(entry => entry.dataset.entryPath === sourceName), 'interaction rename source');
    row.querySelector('button[aria-pressed]').click();
    await new Promise(resolve => setTimeout(resolve, 30));
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
    const input = await waitFor(() => visible('[data-inline-rename-input]')[0], 'interaction rename input');
    const nextName = sourceName + '-next';
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, nextName);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 20));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor(() => !visible('[data-inline-rename-input]').length, 'interaction rename submitted');
    const pendingRow = visible('[data-entry-path]').find(entry => entry.dataset.entryPath === nextName);
    const openedWhileRenamePending = pendingRow?.querySelector('button[aria-pressed]')?.disabled === true;
    if (!openedWhileRenamePending) throw new Error('Interaction probe missed the pending rename window');
    const sibling = visible('[data-entry-path]').find(entry => entry.dataset.entryPath === '000-open-other');
    if (!sibling) throw new Error('Interaction probe sibling is not visible');
    const openStarted = performance.now();
    sibling.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    await waitFor(() => visible('[data-entry-path]').some(entry => entry.dataset.entryPath === '000-open-other/opened.txt'), 'opening a sibling during rename');
    const unrelatedOpenMs = performance.now() - openStarted;
    // Let the real backend finish before moving to the next project.
    for (let attempt = 0; ; attempt += 1) {
      const listing = check(await api.browseProjectFiles(config.workspacePath, project.status, project.name, '', config.mediaCache));
      if (listing.entries.some(entry => entry.relativePath === nextName)) break;
      if (attempt >= 100) throw new Error('Interaction rename never committed');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    samples.push({ scenario: project.name + '/ordinary/ui-interaction', backendIndex: backendIndex++, unrelatedOpenMs, openedWhileRenamePending });
  }
  return samples;
}

module.exports = { runRenamePerformanceProbe };
