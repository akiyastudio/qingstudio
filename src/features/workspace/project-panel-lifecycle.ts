export type ConverterTriggerAction = 'inspect' | 'close' | 'restore';

export const converterTriggerAction = (panelOpen: boolean, taskRunning: boolean): ConverterTriggerAction => {
  if (taskRunning) return 'restore';
  return panelOpen ? 'close' : 'inspect';
};
