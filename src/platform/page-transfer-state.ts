import { createContext, useContext, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

export type PageTransferSnapshot = Record<string, Record<string, unknown>>;
type Participant = { read: () => unknown; write?: (value: unknown) => void; prepare?: () => void; rollback?: () => void };
const incoming = new Map<string, Record<string, unknown>>();
const participants = new Map<string, Map<string, Participant>>();
export const PageTransferContext = createContext('');
export const installPageTransferState = (snapshot?: PageTransferSnapshot) => {
  const decoded = JSON.parse(JSON.stringify(snapshot || {}), (_key, value) => value && typeof value === 'object' && Object.keys(value).length === 1 && Array.isArray(value.__photoflowSet) ? new Set(value.__photoflowSet) : value) as PageTransferSnapshot;
  for (const [pageId, values] of Object.entries(decoded)) incoming.set(pageId, values);
};
export const readPageTransferValue = <T,>(pageId: string, key: string, fallback: () => T): T => {
  const values = incoming.get(pageId);
  return values && Object.hasOwn(values, key) ? values[key] as T : fallback();
};
export const rememberPageTransferValue = (pageId: string, key: string, value: unknown) => {
  if (!pageId) return;
  const values = { ...incoming.get(pageId) }; delete values[key]; values[key] = value;
  const videos = Object.keys(values).filter(key => key.startsWith('video:'));
  for (const oldKey of videos.slice(0, Math.max(0, videos.length - 64))) delete values[oldKey];
  incoming.set(pageId, values);
};
export const registerPageTransferParticipant = (pageId: string, key: string, participant: Participant) => {
  if (!pageId) return () => undefined;
  const entries = participants.get(pageId) || new Map<string, Participant>();
  participants.set(pageId, entries); entries.set(key, participant);
  return () => { if (entries.get(key) === participant) entries.delete(key); if (!entries.size) participants.delete(pageId); };
};
export const capturePageTransferState = (pageIds: string[]): PageTransferSnapshot => Object.fromEntries(pageIds.map(pageId => {
  const entries = [...(participants.get(pageId)?.entries() || [])];
  const values = { ...incoming.get(pageId), ...Object.fromEntries(entries.map(([key, participant]) => [key, participant.read()])) };
  const snapshot = JSON.parse(JSON.stringify(values, (_key, value) => value instanceof Set ? { __photoflowSet: [...value] } : value));
  for (const [, participant] of entries) participant.prepare?.();
  return [pageId, snapshot];
}));
export const rollbackPageTransfer = (pageIds: string[]) => {
  for (const pageId of pageIds) for (const participant of participants.get(pageId)?.values() || []) participant.rollback?.();
};
export const releasePageTransferState = (pageId: string) => incoming.delete(pageId);
export const usePageTransferParticipant = (key: string, participant: Participant) => {
  const pageId = useContext(PageTransferContext);
  const current = useRef(participant); current.current = participant;
  useEffect(() => registerPageTransferParticipant(pageId, key, {
    read: () => current.current.read(), write: value => current.current.write?.(value),
    prepare: () => current.current.prepare?.(), rollback: () => current.current.rollback?.(),
  }), [pageId, key]);
  return pageId;
};
export const usePageState = <T,>(pageId: string, key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] => {
  const [value, setValue] = useState<T>(() => readPageTransferValue(pageId, key, () => typeof initial === 'function' ? (initial as () => T)() : initial));
  const latest = useRef(value); latest.current = value;
  useEffect(() => registerPageTransferParticipant(pageId, key, { read: () => latest.current, write: next => setValue(next as T) }), [pageId, key]);
  return [value, setValue];
};
export const useRestorePageTransferState = (pageId: string, ready: boolean) => {
  const restored = useRef(false);
  useEffect(() => {
    if (!ready || restored.current) return;
    restored.current = true;
    for (const [key, value] of Object.entries(incoming.get(pageId) || {})) participants.get(pageId)?.get(key)?.write?.(value);
  }, [pageId, ready]);
};
export const useScopedPageState = <T,>(key: string, initial: T | (() => T)) => usePageState(useContext(PageTransferContext), key, initial);
export const useRestoreScopedPageState = (ready: boolean) => useRestorePageTransferState(useContext(PageTransferContext), ready);
