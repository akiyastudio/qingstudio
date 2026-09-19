// Python's base64 decoder requires padding. Keep it on the host so existing
// installed video workers can also read requests from an updated application.
const encodeImportVideoToolRequest = (payload, action) => Buffer.from(JSON.stringify({ ...payload, action }), 'utf8').toString('base64');

// Frozen Windows workers may read stdin using the system code page. JSON
// escapes keep returned Chinese paths intact across both old and new workers.
const serializeImportWorkerControl = payload => `${JSON.stringify(payload).replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;

const importWorkerCompletionIssue = (event, deleteSourceRequested = false) => {
  if (!['success', 'partial'].includes(event?.type)) return '';
  const data = event.data || {};
  if (event.type === 'partial' || data.partialFailure === true || Number(data.failedCount) > 0) {
    return data.sourceFilesDeleted === false
      ? '文件已导入，但部分后处理失败；源文件已保留，请查看导入日志。'
      : '文件已导入，但部分处理未完成；请查看导入日志。';
  }
  if (deleteSourceRequested && data.sourceFilesDeleted === false && Number(data.importedCount) > 0) {
    return '文件已导入，但源文件未全部清理；请查看导入日志。';
  }
  return '';
};

module.exports = { encodeImportVideoToolRequest, importWorkerCompletionIssue, serializeImportWorkerControl };
