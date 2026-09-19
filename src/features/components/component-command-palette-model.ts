export const nextCommandIndex = (current: number, count: number, key: string) => {
  if (count < 1) return -1;
  if (key === 'ArrowDown') return current < 0 ? 0 : (current + 1) % count;
  return current < 0 ? count - 1 : (current - 1 + count) % count;
};

export const clampCommandIndex = (current: number, count: number) => {
  if (count < 1) return -1;
  if (current < 0) return 0;
  return Math.min(current, count - 1);
};

export const shouldRegisterCommandShortcut = (count: number) => count > 0;
