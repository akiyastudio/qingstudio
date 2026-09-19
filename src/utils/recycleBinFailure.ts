const RECYCLE_BIN_FAILURE_DIALOG = {
  title: '无法移入回收站',
  message: 'Windows 未能完成全部回收站操作，请刷新目录确认文件状态。',
  detail: '可能因回收站容量不足、文件过大、磁盘不支持回收站、权限或文件占用等。批量操作可能只完成了一部分；请刷新目录，并可在系统回收站中检查或恢复已删除项目。',
  confirmLabel: '知道了',
  tone: 'danger',
} as const;

const RECYCLE_BIN_FAILURE_CODES = new Set([
  'RECYCLE_BIN_FAILED',
  'RECYCLE_UNAVAILABLE',
  'RECYCLE_SERVICE_MISSING',
  'EPERM',
  'EACCES',
  'EBUSY',
]);

const isRecycleBinFailure = (value?: string, code?: string) => Boolean(
  code && RECYCLE_BIN_FAILURE_CODES.has(code)
  || value && /回收站|系统取消了删除操作|可恢复删除|拒绝访问|访问被拒绝|文件.*占用|没有访问权限|权限不足|access (?:is )?denied|being used by another process/i.test(value),
);

export { RECYCLE_BIN_FAILURE_DIALOG, isRecycleBinFailure };
