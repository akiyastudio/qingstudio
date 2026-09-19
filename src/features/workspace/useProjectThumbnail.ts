import { useEffect, useRef } from 'react';
import type { ThumbnailState } from '../../types';
import { projectWorkspaceClient } from '../../platform/project-workspace-client';

export const requestThumbnail = <T,>(task: () => Promise<T>) => task();
const thumbnailSizeLabel = (requestedSize: number) => requestedSize <= 320 ? 'small' : requestedSize <= 640 ? 'medium' : 'large';
const mediaThumbnailPreviewCache = new Map<string, string>();
type ThumbnailSubscriber = (update: { state: ThumbnailState; previewUrls?: Partial<Record<'small' | 'medium' | 'large', string>> }) => void;
const thumbnailSubscribers = new Map<string, Set<ThumbnailSubscriber>>();
let releaseThumbnailSubscription: (() => void) | undefined;

export const normalizeThumbnailPathIdentity = (filePath: string) => {
  const slashed = filePath.trim().replace(/\\/g, '/');
  const windowsIdentity = /^(?:[a-z]:\/|\/\/)/i.test(slashed);
  const prefix = slashed.startsWith('//') ? '//' : '';
  const normalized = `${prefix}${slashed.slice(prefix.length).replace(/\/{2,}/g, '/')}`.replace(/\/$/, '');
  return windowsIdentity ? normalized.toLocaleLowerCase() : normalized;
};

const ensureThumbnailSubscription = () => {
  if (releaseThumbnailSubscription) return;
  releaseThumbnailSubscription = projectWorkspaceClient.onThumbnailStateChanged(update => {
    for (const subscriber of thumbnailSubscribers.get(normalizeThumbnailPathIdentity(update.filePath)) || []) subscriber(update);
  });
};

const subscribeThumbnailPath = (filePath: string, subscriber: ThumbnailSubscriber) => {
  const identity = normalizeThumbnailPathIdentity(filePath);
  const subscribers = thumbnailSubscribers.get(identity) || new Set<ThumbnailSubscriber>();
  subscribers.add(subscriber);
  thumbnailSubscribers.set(identity, subscribers);
  ensureThumbnailSubscription();
  return () => {
    subscribers.delete(subscriber);
    if (!subscribers.size) thumbnailSubscribers.delete(identity);
    if (!thumbnailSubscribers.size) {
      releaseThumbnailSubscription?.();
      releaseThumbnailSubscription = undefined;
    }
  };
};

export const getMediaThumbnailPreview = (key: string) => mediaThumbnailPreviewCache.get(key);
export const deleteMediaThumbnailPreview = (key: string) => mediaThumbnailPreviewCache.delete(key);

export const mediaThumbnailPreviewKey = (filePath: string, updatedAt: number, requestedSize: number) => `${normalizeThumbnailPathIdentity(filePath)}|${updatedAt}|${requestedSize}`;

export const forgetMediaThumbnailPreviews = (filePath: string) => {
  const prefix = `${normalizeThumbnailPathIdentity(filePath)}|`;
  for (const key of mediaThumbnailPreviewCache.keys()) if (key.startsWith(prefix)) mediaThumbnailPreviewCache.delete(key);
};

export const rememberMediaThumbnailPreview = (key: string, url: string) => {
  if (mediaThumbnailPreviewCache.size >= 2000 && !mediaThumbnailPreviewCache.has(key)) {
    mediaThumbnailPreviewCache.delete(mediaThumbnailPreviewCache.keys().next().value as string);
  }
  mediaThumbnailPreviewCache.set(key, url);
};

export const findCachedMediaThumbnailPreview = (filePath: string, updatedAt: number) => {
  const prefix = `${normalizeThumbnailPathIdentity(filePath)}|${updatedAt}|`;
  const matches = [...mediaThumbnailPreviewCache.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, url]) => ({ url, size: Number(key.slice(prefix.length)) || 0 }))
    .sort((left, right) => right.size - left.size);
  return matches[0];
};

export const useThumbnailUpdates = (
  filePath: string,
  requestedSize: number,
  onUpdate: (state: ThumbnailState, url?: string) => void,
) => {
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const sizeLabel = thumbnailSizeLabel(requestedSize);
  useEffect(() => subscribeThumbnailPath(filePath, update => {
    onUpdateRef.current(update.state, update.previewUrls?.[sizeLabel]);
  }), [filePath, sizeLabel]);
};
