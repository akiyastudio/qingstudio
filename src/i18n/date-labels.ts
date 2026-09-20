import { getLocale } from './runtime';
/** Format an existing month/day value without changing its stored representation. */
export const formatBirthdayLabel = (value: string) => {
  const match = value.trim().match(/^(\d{1,2})(?:\.|月\.?)(\d{1,2})日?$/);
  if (!match) return value;
  const month = Number(match[1]), day = Number(match[2]);
  const date = new Date(2000, month - 1, day);
  if (month < 1 || month > 12 || day < 1 || date.getMonth() !== month - 1 || date.getDate() !== day) return value;
  return new Intl.DateTimeFormat(getLocale(), { month: 'short', day: 'numeric' }).format(date);
};
