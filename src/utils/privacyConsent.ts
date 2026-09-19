type ConsentDialog = {
  choice: (options: {
    title: string;
    message: string;
    detail?: string;
    choices: Array<{ value: string; label: string }>;
    cancelLabel?: string;
    defaultValue?: string;
    cancelDefault?: boolean;
  }) => Promise<string | null>;
};

let inFlightConsentRef: Promise<boolean> | null = null;

const requestFaceRecognitionConsent = async (dialog: ConsentDialog) => {
  const api = window.electronAPI;
  if (api?.apiContractVersion !== 1 || typeof api.getPrivacyConsentState !== 'function'
    || typeof api.savePrivacyConsent !== 'function' || typeof api.openLegalDocument !== 'function') return false;
  let state;
  try { state = await api.getPrivacyConsentState(); }
  catch { return false; }
  if (state.faceRecognitionGranted) return true;

  let choice: string | null = 'rules';
  while (choice === 'rules') {
    choice = await dialog.choice({
      title: '单独同意处理人脸信息',
      message: '跨照片人物身份识别会在本机提取人脸身份特征和身体外观特征，用于生成同一人物的候选分组。照片和特征不会因该功能自动上传。',
      detail: '人脸信息属于敏感个人信息。请确认已取得被摄者或其监护人的合法授权；自动结果仅供候选，必须人工确认。不同意不会影响普通人物检测、裁图和手工标记。',
      choices: [
        { value: 'agree', label: '单独同意并继续' },
        { value: 'rules', label: '查看完整规则' },
      ],
      cancelLabel: '暂不启用',
      defaultValue: 'agree',
      cancelDefault: true,
    });
    if (choice === 'rules') {
      try {
        const opened = await api.openLegalDocument('face');
        if (!opened.success) return false;
      } catch { return false; }
    }
  }
  if (choice !== 'agree') return false;
  try {
    const result = await api.savePrivacyConsent({ faceRecognitionGranted: true });
    return result.success && result.state?.faceRecognitionGranted === true;
  } catch { return false; }
};

export const ensureFaceRecognitionConsent = (dialog: ConsentDialog) => {
  if (inFlightConsentRef) return inFlightConsentRef;
  inFlightConsentRef = requestFaceRecognitionConsent(dialog).finally(() => { inFlightConsentRef = null; });
  return inFlightConsentRef;
};
