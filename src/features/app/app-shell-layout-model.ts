export const clampNumber = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

export const BACKGROUND_TASK_DRAWER_STORAGE_KEY = 'photoflow:background-task-drawer-width';
export const BACKGROUND_TASK_DRAWER_DEFAULT_WIDTH = 320;
export const BACKGROUND_TASK_DRAWER_MIN_WIDTH = 260;
export const BACKGROUND_TASK_DRAWER_MAX_WIDTH = 640;

export const readStoredNumber = (key: string, fallback: number) => {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
};
