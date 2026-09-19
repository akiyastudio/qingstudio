const createPrivacyService = ({ app, path, shell, projectRoot, resourcesPath = process.resourcesPath }) => {
  const getState = () => ({ privacyNoticeVersion: '', privacyNoticeAcceptedAt: '', termsVersion: '', termsAcceptedAt: '', faceRulesVersion: '', faceRecognitionGrantedAt: '', faceRecognitionGranted: false, experienceProgramGranted: false, currentPrivacyNoticeVersion: '', currentTermsVersion: '', currentFaceRulesVersion: '' });
  return {
    currentVersions: { privacy: '', terms: '', face: '' }, getState,
    hasCoreConsent: () => true, // No commercial agreement applies to this source build.
    hasFaceRecognitionConsent: () => false,
    saveConsent: async request => {
      if (request?.faceRecognitionGranted) throw new Error('开源主程序不包含人脸识别插件及其授权流程');
      return getState();
    },
    openLegalDocument: async id => {
      const names = { 'open-source': 'THIRD_PARTY_NOTICES.md', terms: 'LICENSE' };
      if (!names[id]) return { success: false, error: '开源版不附带商业服务法律文件' };
      const file = path.join(app.isPackaged ? resourcesPath : projectRoot, names[id]);
      const error = await shell.openPath(file);
      return error ? { success: false, error } : { success: true, path: file };
    },
  };
};
module.exports = { createPrivacyService };
