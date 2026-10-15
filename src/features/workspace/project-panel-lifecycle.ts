export type ConverterTriggerAction = 'inspect' | 'close' | 'restore';

export const converterTriggerAction = (panelOpen: boolean, taskRunning: boolean): ConverterTriggerAction => {
  if (taskRunning) return 'restore';
  return panelOpen ? 'close' : 'inspect';
};

export type ProjectPanel = 'import' | 'negative-import' | 'broll' | 'file-import' | 'match' | 'research' | 'converter' | 'screenshot-main-image' | 'office-extract' | 'trash' | null;
export type MountedProjectPanel = Exclude<ProjectPanel, null>;
export const PROJECT_PANEL_TITLES: Record<MountedProjectPanel, string> = {
  import: '从 SD 卡导入',
  'negative-import': '导入 · 原始素材',
  broll: '导入 · 花絮',
  'file-import': '导入 · 其他文件',
  match: '从文件名选片',
  research: '截取分镜帧',
  converter: '图片转 JPG',
  'screenshot-main-image': '提取截图主图',
  'office-extract': '提取文档图片',
  trash: '移入回收站',
};
