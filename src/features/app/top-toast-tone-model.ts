export type TopToastTone = 'info' | 'success' | 'warning' | 'error';
export const hostNoticeTone = (message: string): TopToastTone => /失败|错误|异常|无法/.test(message) ? 'error' : 'info';

export const topToastTonePresentation = (tone: TopToastTone) => ({
  tone,
  role: tone === 'error' ? 'alert' as const : 'status' as const,
  ariaLive: tone === 'error' ? 'assertive' as const : 'polite' as const,
  icon: tone === 'success' ? 'check' as const : tone === 'warning' ? 'warning' as const : tone === 'error' ? 'error' as const : 'info' as const,
});

export const topToastTonePolicy = (tone: TopToastTone) => ({
  persistent: tone === 'error',
  durationMs: tone === 'error' ? null : 3500,
});
