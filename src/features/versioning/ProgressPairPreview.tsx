import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { AppConfig } from '../../types';
import { ImageComparisonView, type ImageComparisonMode } from '../../components/ImageComparisonView';
import { versioningMediaKind } from './versioning-v2-model';

// The centralized registry includes legacy video suffixes '.mpeg', '.mpg', '.mts' and '.m2ts'.

export type ProgressPairPreviewMode = ImageComparisonMode;

type ProgressPairPreviewProps = {
  referencePath?: string;
  sourcePath?: string;
  referenceLabel?: string;
  sourceLabel?: string;
  referenceMissing?: boolean;
  mode: ProgressPairPreviewMode;
  swapped: boolean;
  cacheConfig: AppConfig['mediaCache'];
  onModeChange: (mode: ProgressPairPreviewMode) => void;
  onSwappedChange: (swapped: boolean) => void;
};

export const ProgressPairPreview = ({ referencePath = '', sourcePath = '', referenceLabel = '上一版本', sourceLabel = '当前版本', referenceMissing = false, mode, swapped, cacheConfig, onModeChange, onSwappedChange }: ProgressPairPreviewProps) => {
  const [resources, setResources] = useState<{ reference?: string; source?: string; loading: boolean; error?: string }>({ loading: false });
  const requestSequenceRef = useRef(0);

  useEffect(() => {
    const requestSequence = ++requestSequenceRef.current;
    setResources({ loading: Boolean((referencePath && !referenceMissing) || sourcePath) });
    const paths = new Map<string, Array<'reference' | 'source'>>();
    const addPath = (path: string, side: 'reference' | 'source') => {
      const key = path.toLocaleLowerCase();
      paths.set(key, [...(paths.get(key) || []), side]);
    };
    if (referencePath && !referenceMissing) addPath(referencePath, 'reference');
    if (sourcePath) addPath(sourcePath, 'source');
    const unsubscribe = window.electronAPI.onThumbnailStateChanged(update => {
      if (requestSequenceRef.current !== requestSequence || update.state !== 'READY') return;
      const sides = paths.get(update.filePath.toLocaleLowerCase());
      const url = update.previewUrls?.large || update.previewUrls?.medium;
      if (sides?.length && url) setResources(current => sides.reduce((next, side) => ({ ...next, [side]: url }), current));
    });
    Promise.all([
      referencePath && !referenceMissing ? window.electronAPI.getMediaThumbnail(referencePath, versioningMediaKind(referencePath), cacheConfig, 1600, 0, -2) : Promise.resolve(undefined),
      sourcePath ? window.electronAPI.getMediaThumbnail(sourcePath, versioningMediaKind(sourcePath), cacheConfig, 1600, 0, -1) : Promise.resolve(undefined),
    ]).then(([reference, source]) => {
      if (requestSequenceRef.current !== requestSequence) return;
      setResources(current => ({
        reference: current.reference || reference?.previewUrl || reference?.mediaUrl,
        source: current.source || source?.previewUrl || source?.mediaUrl,
        loading: false,
        error: reference && !reference.success || source && !source.success ? reference?.error || source?.error || '对比预览加载失败' : undefined,
      }));
    }).catch(error => {
      if (requestSequenceRef.current === requestSequence) setResources(current => ({ ...current, loading: false, error: error instanceof Error ? error.message : String(error) }));
    });
    return () => {
      requestSequenceRef.current += 1;
      unsubscribe();
    };
  }, [referencePath, sourcePath, referenceMissing, cacheConfig.directory, cacheConfig.maxSizeGB]);

  const image = (url: string | undefined, label: string, missing: boolean) => missing
    ? <div className="tracking-confirmation-missing">{referencePath ? '上一版本引用不可用，请重新定位或拒绝。' : '未关联上一版本'}</div>
    : url ? <img src={url} alt={label} draggable={false} className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain"/>
    : <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-400">{resources.loading ? <Loader2 size={22} className="animate-spin"/> : '没有可用预览'}</div>;

  return <section className="tracking-confirmation-preview">
    <ImageComparisonView
      left={{ label: referenceLabel, content: image(resources.reference, referenceLabel, referenceMissing) }}
      right={{ label: sourceLabel, content: image(resources.source, sourceLabel, false) }}
      mode={mode}
      onModeChange={onModeChange}
      swapped={swapped}
      onSwappedChange={onSwappedChange}
      comparisonKey={`${referencePath}|${sourcePath}`}
      unavailable={referenceMissing || !resources.reference || !resources.source}
    />
    {resources.error && <p className="border-t border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-300">{resources.error}</p>}
  </section>;
};
