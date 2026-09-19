import type { ToastOptions, ToastTone, ToastUpdate } from './useTopToastStack';

export type ToastShowOptions = ToastOptions | ToastTone | number | undefined;
export type PreparedUserNotice = { message: string; options?: ToastOptions };

const INTERNAL_CODE = /\b([a-z][a-z0-9]+(?:_[a-z0-9]+)+)\s*[：:]\s*/i;
const SYSTEM_CODE = /\b(EPERM|EACCES|EBUSY|ENOENT|ENOSPC|EROFS|SQLITE_BUSY|SQLITE_LOCKED|SQLITE_READONLY|SQLITE_CORRUPT|SQLITE_IOERR|DATABASE_TIMEOUT|DOMAIN_BACKPRESSURE)\b/i;
const TECHNICAL_DETAIL = /(?:\b(?:error|exception|traceback|spawn|errno|syscall|sqlite|workspace database service|exited with code|timed? out|permission denied|not found)\b|\bat\s+[A-Za-z_$][\w$.[\]]*\s*\(|https?:\/\/|[A-Za-z]:\\)/i;
const ERROR_WORDS = /失败|错误|异常|无法|不能|不存在|无效|冲突|占用|只读|过期|请.*重试/;
const SERIOUS_ERROR = /(?:数据库.*(?:损坏|不可用|失败)|回滚失败|状态不确定|部分.*失败|永久删除|无法安全|无法重试|修复面板|隐私确认失败|备份.*失败|工作区恢复失败|项目恢复失败|提交.*失败|会话释放失败|跟踪启动失败|已.+(?:但|；).+失败)/;
const SERIOUS_SYSTEM_CODE = /\b(?:SQLITE_CORRUPT|SQLITE_IOERR)\b/i;

const CODE_RULES: Array<{ test: RegExp; detail: string; durationMs: number }> = [
  { test: /(?:target|name|key)_conflict|duplicate|output_name_conflict/, detail: '这个名称已经存在，请换一个', durationMs: 4000 },
  { test: /name_reserved/, detail: '这个名称已被项目保留，请换一个', durationMs: 4000 },
  { test: /name_invalid/, detail: '这个名称不能使用，请换一个', durationMs: 4000 },
  { test: /(?:identity|path|project|media)_mismatch|stale_(?:update|layout|revision)|snapshot_stale/, detail: '内容已经发生变化，请刷新后重试', durationMs: 5000 },
  { test: /busy|backpressure|SQLITE_BUSY|SQLITE_LOCKED/i, detail: '当前操作还没结束，请稍后重试', durationMs: 5000 },
  { test: /limit|too_many|exceeded/, detail: '选择的内容太多，请缩小范围', durationMs: 6000 },
  { test: /not_found|missing|ENOENT/i, detail: '文件已经不存在或被移动', durationMs: 5000 },
  { test: /unauthorized|outside|forbidden|unsupported|role_invalid/, detail: '当前内容不支持这个操作', durationMs: 5000 },
  { test: /cycle/, detail: '节点之间不能形成循环关系', durationMs: 5000 },
  { test: /parent_(?:required|invalid)|source_invalid|relation_.*invalid/, detail: '请选择有效的来源节点后重试', durationMs: 5000 },
  { test: /payload_invalid|scope_invalid|cursor_invalid|coordinate_invalid|position_invalid/, detail: '当前请求无效，请调整后重试', durationMs: 5000 },
  { test: /expired/, detail: '操作已过期，请刷新后重试', durationMs: 5000 },
];

const SYSTEM_DETAILS: Record<string, string> = {
  EPERM: '文件正在使用中或没有操作权限',
  EACCES: '没有权限完成此操作',
  EBUSY: '文件正在使用中，请关闭后重试',
  ENOENT: '文件已经不存在或被移动',
  ENOSPC: '磁盘空间不足',
  EROFS: '当前位置是只读的',
  SQLITE_BUSY: '项目数据正在使用中，请稍后重试',
  SQLITE_LOCKED: '项目数据正在使用中，请稍后重试',
  SQLITE_READONLY: '项目数据是只读的',
  SQLITE_CORRUPT: '项目数据可能已损坏，请查看日志并进行修复',
  SQLITE_IOERR: '读取项目数据失败，请检查磁盘后重试',
  DATABASE_TIMEOUT: '读取项目数据超时，请稍后重试',
  DOMAIN_BACKPRESSURE: '当前任务较多，请稍后重试',
};

const detailForContext = (prefix: string) => {
  if (/重命名|新建/.test(prefix)) return '请检查名称后重试';
  if (/打开/.test(prefix)) return '请确认文件还在，然后重试';
  if (/读取|索引|搜索/.test(prefix)) return '请稍后重试';
  if (/复制/.test(prefix)) return '请重试';
  if (/删除|移动|导入|粘贴/.test(prefix)) return '请检查文件后重试';
  if (/保存|更新|设置|标记/.test(prefix)) return '请重试';
  if (/视频|图片|裁剪|转码/.test(prefix)) return '请检查文件后重试';
  return '请重试，仍然失败时查看日志';
};

const chinesePrefixBefore = (message: string, index: number) => {
  const before = message.slice(0, index)
    .replace(/[：:\s]+$/g, '')
    .replace(/(?:Error|Exception)$/i, '')
    .replace(/[：:\s]+$/g, '')
    .trim();
  return /\p{Script=Han}/u.test(before) ? before : '';
};

const withPrefix = (prefix: string, detail: string) => prefix ? `${prefix}：${detail}` : `操作失败：${detail}`;

const normalizeTechnicalMessage = (rawMessage: string) => {
  const message = String(rawMessage || '').trim() || '发生未知错误';
  const internal = INTERNAL_CODE.exec(message);
  if (internal) {
    const prefix = chinesePrefixBefore(message, internal.index);
    const systemDetail = SYSTEM_DETAILS[internal[1].toUpperCase()];
    const rule = CODE_RULES.find(candidate => candidate.test.test(internal[1]));
    const detail = systemDetail || rule?.detail || detailForContext(prefix);
    return { message: withPrefix(prefix, detail), durationMs: rule?.durationMs || 5000, normalizedError: true };
  }

  const system = SYSTEM_CODE.exec(message);
  if (system) {
    const prefix = chinesePrefixBefore(message, system.index);
    const detail = SYSTEM_DETAILS[system[1].toUpperCase()] || detailForContext(prefix);
    return { message: withPrefix(prefix, detail), durationMs: 5000, normalizedError: true };
  }

  const separator = message.search(/[：:]/);
  if (separator >= 0) {
    const prefix = chinesePrefixBefore(message, separator);
    const detail = message.slice(separator + 1).trim();
    if (prefix && TECHNICAL_DETAIL.test(detail)) {
      return { message: withPrefix(prefix, detailForContext(prefix)), durationMs: 5000, normalizedError: true };
    }
  }

  if (!/\p{Script=Han}/u.test(message) && TECHNICAL_DETAIL.test(message)) {
    return { message: '操作失败：请重试，仍然失败时查看日志', durationMs: 5000, normalizedError: true };
  }
  return { message, durationMs: undefined, normalizedError: false };
};

const optionsObject = (options: ToastShowOptions): ToastOptions => {
  if (typeof options === 'number') return { durationMs: options };
  if (typeof options === 'string') return { tone: options };
  return { ...(options || {}) };
};

const positiveTone = (message: string): ToastTone | undefined => {
  if (/^已恢复上次失败/.test(message)) return 'success';
  if (/^已(?:创建|完成|保存|导入|移动|更新).*(?:部分|但).*(?:无法|失败)/.test(message)) return 'warning';
  return undefined;
};

export const prepareUserFacingNotice = (rawMessage: string, rawOptions?: ToastShowOptions): PreparedUserNotice => {
  const seriousRawError = SERIOUS_SYSTEM_CODE.test(String(rawMessage || ''));
  const normalized = normalizeTechnicalMessage(rawMessage);
  const options = optionsObject(rawOptions);
  const tone = positiveTone(normalized.message);
  if (tone && options.tone === undefined) options.tone = tone;

  const hasExplicitLifecycle = options.lifecycle === 'persistent';
  const hasExplicitDuration = options.durationMs !== undefined;
  const errorLike = normalized.normalizedError || ERROR_WORDS.test(normalized.message);
  if (!hasExplicitLifecycle && !hasExplicitDuration && errorLike && !seriousRawError && !SERIOUS_ERROR.test(normalized.message)) {
    options.durationMs = normalized.durationMs
      || (/复制/.test(normalized.message) ? 3500 : /拖入/.test(normalized.message) ? 4000 : 5000);
  }
  return { message: normalized.message, options: Object.keys(options).length ? options : undefined };
};

export const prepareUserFacingUpdate = (value: string | ToastUpdate): string | ToastUpdate => {
  if (typeof value === 'string') return prepareUserFacingNotice(value).message;
  if (value.message === undefined) return value;
  const prepared = prepareUserFacingNotice(value.message, value);
  return { ...value, ...prepared.options, message: prepared.message };
};
