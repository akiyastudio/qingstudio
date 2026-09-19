const readProjectDate = project => {
  try {
    const value = JSON.parse(project?.extra_json || '{}')?.projectDate;
    if (!value || !Number.isInteger(value.year) || value.year < 2000 || value.year > 2099 || !Number.isInteger(value.month) || value.month < 1 || value.month > 12) return undefined;
    if (value.day !== undefined) {
      const checked = new Date(value.year, value.month - 1, value.day);
      if (!Number.isInteger(value.day) || value.day < 1 || checked.getFullYear() !== value.year || checked.getMonth() !== value.month - 1 || checked.getDate() !== value.day) return undefined;
    }
    return {
      year: value.year,
      month: value.month,
      ...(Number.isInteger(value.day) ? { day: value.day } : {}),
      precision: Number.isInteger(value.day) ? 'day' : 'month',
    };
  } catch {
    return undefined;
  }
};

const normalizeProjectDate = value => {
  if (!value) return null;
  if (value.year === undefined || value.year === null || String(value.year).trim() === '') throw new Error('年份不能为空');
  let year = Number(value.year);
  const month = Number(value.month);
  const hasDay = value.day !== undefined && value.day !== null && String(value.day).trim() !== '';
  const day = hasDay ? Number(value.day) : undefined;
  if (year >= 0 && year < 100) year += 2000;
  if (!Number.isInteger(year) || year < 2000 || year > 2099) throw new Error('年份请输入 00–99 或 2000–2099');
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('月份请输入 1–12');
  if (hasDay) {
    const checked = new Date(year, month - 1, day);
    if (!Number.isInteger(day) || day < 1 || checked.getFullYear() !== year || checked.getMonth() !== month - 1 || checked.getDate() !== day) throw new Error('日期无效，请检查年月日');
  }
  return { year, month, ...(hasDay ? { day } : {}), precision: hasDay ? 'day' : 'month' };
};

const formatProjectDate = value => value
  ? `${String(value.year).slice(-2)}-${value.month}${value.precision === 'day' ? `-${value.day}` : ''}`
  : '';

module.exports = { formatProjectDate, normalizeProjectDate, readProjectDate };
