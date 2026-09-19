const assert = require('node:assert/strict');
const runElectronSmokeProbe = async ({ app, mainWindow, loadRenderer }) => {
  const timeout = setTimeout(() => app.exit(1), 45000);
  try {
    if (mainWindow.webContents.isLoading()) await new Promise(resolve => mainWindow.webContents.once('did-finish-load', resolve));
    else if (!mainWindow.webContents.getURL()) await loadRenderer();
    const deadline = Date.now() + 30000;
    let result;
    while (Date.now() < deadline) {
      result = await mainWindow.webContents.executeJavaScript(`(async () => {
        const api = window.electronAPI;
        if (!api || !document.querySelector('#root')?.textContent?.trim()) return null;
        const consent = await api.getPrivacyConsentState();
        const tasks = await api.getBackgroundTasks();
        return { renderer: true, preload: true, noCommercialGate: consent.privacyNoticeVersion === consent.currentPrivacyNoticeVersion && consent.termsVersion === consent.currentTermsVersion, tasks: Array.isArray(tasks.tasks), biometricDisabled: !consent.faceRecognitionGranted };
      })()`);
      if (result) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert(result?.renderer && result.preload && result.tasks && result.noCommercialGate && result.biometricDisabled);
    console.log('QINGSTUDIO_SMOKE_RESULT=' + JSON.stringify(result));
    app.quit();
  } catch (error) { console.error(error); app.exit(1); }
  finally { clearTimeout(timeout); }
};
module.exports = { runElectronSmokeProbe };
