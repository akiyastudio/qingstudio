import type { VideoSubtitleTrack } from '../types';

const SUBTITLE_MEMORY_KEY = 'photoflow.video-player.subtitle-memory.v2';
const LEGACY_SUBTITLE_MEMORY_KEY = 'photoflow.video-player.subtitle-memory.v1';
const MAX_SUBTITLE_MEMORIES = 100;

export type SubtitleMemory = {
  selection: { mode: 'off' } | { mode: 'track'; stableId: string };
  delay: number;
  visible: boolean;
  updatedAt: number;
};

type SubtitleMemoryEntry = SubtitleMemory & { fileKey: string };
type SubtitleMemoryStore = { version: 2; entries: SubtitleMemoryEntry[] };

export const normalizeVideoMemoryFileKey = (filePath: string) => {
  const raw = String(filePath || '').trim().replace(/^file:\/\//i, '');
  const unc = /^[\\/]{2}[^\\/]/.test(raw);
  let normalized = raw.replace(/[\\/]+/g, '/');
  if (unc && !normalized.startsWith('//')) normalized = `/${normalized}`;
  try { normalized = decodeURIComponent(normalized); } catch { /* keep the original path when it is not a valid URI */ }
  if (/^\/[a-z]:\//i.test(normalized)) normalized = normalized.slice(1);
  if (/^[a-z]:\//i.test(normalized) || normalized.startsWith('//')) normalized = normalized.toLowerCase();
  return normalized.length > 3 ? normalized.replace(/\/+$/, '') : normalized;
};

const boundedDelay = (value: unknown) => Math.max(-30, Math.min(30, Number(value) || 0));

const normalizeMemory = (value: unknown): SubtitleMemory | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<SubtitleMemory> & { stableId?: unknown };
  const selection = candidate.selection?.mode === 'off'
    ? { mode: 'off' as const }
    : candidate.selection?.mode === 'track' && typeof candidate.selection.stableId === 'string' && candidate.selection.stableId
      ? { mode: 'track' as const, stableId: candidate.selection.stableId }
      : typeof candidate.stableId === 'string' && candidate.stableId
        ? { mode: 'track' as const, stableId: candidate.stableId }
        : undefined;
  if (!selection) return undefined;
  return {
    selection,
    delay: boundedDelay(candidate.delay),
    visible: candidate.visible !== false,
    updatedAt: Number.isFinite(Number(candidate.updatedAt)) ? Number(candidate.updatedAt) : 0,
  };
};

export const parseSubtitleMemoryStore = (currentRaw: string | null, legacyRaw: string | null = null): SubtitleMemoryStore => {
  const entries: SubtitleMemoryEntry[] = [];
  const add = (filePath: unknown, value: unknown) => {
    if (typeof filePath !== 'string') return;
    const fileKey = normalizeVideoMemoryFileKey(filePath);
    const memory = normalizeMemory(value);
    if (fileKey && memory) entries.push({ fileKey, ...memory });
  };
  try {
    const parsed = JSON.parse(currentRaw || 'null') as unknown;
    if (parsed && typeof parsed === 'object' && (parsed as Partial<SubtitleMemoryStore>).version === 2 && Array.isArray((parsed as Partial<SubtitleMemoryStore>).entries)) {
      for (const item of (parsed as SubtitleMemoryStore).entries) {
        if (!item || typeof item !== 'object') continue;
        add((item as Partial<SubtitleMemoryEntry>).fileKey, item);
      }
    }
  } catch { /* corrupt storage is ignored */ }
  if (!entries.length) {
    try {
      const legacy = JSON.parse(legacyRaw || 'null') as Record<string, unknown> | null;
      if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) for (const [filePath, value] of Object.entries(legacy)) add(filePath, value);
    } catch { /* corrupt legacy storage is ignored */ }
  }
  const newest = new Map<string, SubtitleMemoryEntry>();
  for (const entry of entries.sort((a, b) => b.updatedAt - a.updatedAt)) if (!newest.has(entry.fileKey)) newest.set(entry.fileKey, entry);
  return { version: 2, entries: [...newest.values()].slice(0, MAX_SUBTITLE_MEMORIES) };
};

export const findSubtitleMemory = (store: SubtitleMemoryStore, filePath: string) =>
  store.entries.find(entry => entry.fileKey === normalizeVideoMemoryFileKey(filePath));

export const updateSubtitleMemoryStore = (store: SubtitleMemoryStore, filePath: string, memory: SubtitleMemory, now = Date.now()): SubtitleMemoryStore => {
  const fileKey = normalizeVideoMemoryFileKey(filePath);
  const normalized = normalizeMemory({ ...memory, updatedAt: now });
  if (!fileKey || !normalized) return store;
  return {
    version: 2,
    entries: [{ fileKey, ...normalized }, ...store.entries.filter(entry => entry.fileKey !== fileKey)]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SUBTITLE_MEMORIES),
  };
};

export const resolveRememberedSubtitle = (memory: SubtitleMemory | undefined, tracks: readonly VideoSubtitleTrack[]) => {
  if (!memory) return { mode: 'default' as const };
  const selection = memory.selection;
  if (selection.mode === 'off') return { mode: 'off' as const, delay: memory.delay };
  const track = tracks.find(item => item.stableId === selection.stableId);
  return track
    ? { mode: 'track' as const, track, delay: memory.delay, visible: memory.visible }
    : { mode: 'missing' as const };
};

export const readSubtitleMemory = (storage: Pick<Storage, 'getItem'>, filePath: string) => {
  const store = parseSubtitleMemoryStore(storage.getItem(SUBTITLE_MEMORY_KEY), storage.getItem(LEGACY_SUBTITLE_MEMORY_KEY));
  return findSubtitleMemory(store, filePath);
};

export const writeSubtitleMemory = (storage: Pick<Storage, 'getItem' | 'setItem'>, filePath: string, memory: SubtitleMemory) => {
  const store = parseSubtitleMemoryStore(storage.getItem(SUBTITLE_MEMORY_KEY), storage.getItem(LEGACY_SUBTITLE_MEMORY_KEY));
  storage.setItem(SUBTITLE_MEMORY_KEY, JSON.stringify(updateSubtitleMemoryStore(store, filePath, memory)));
};

export { LEGACY_SUBTITLE_MEMORY_KEY, MAX_SUBTITLE_MEMORIES, SUBTITLE_MEMORY_KEY };
