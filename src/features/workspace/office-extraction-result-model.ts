import type { OfficeImageExtractionResult } from '../../types';

export type OfficeExtractionPresentation = {
  state: 'success' | 'partial' | 'publication-failed';
  documents: number;
  successful: number;
  images: number;
  failed: number;
  outputFolders: string[];
  extractionFailures: Array<{ documentName: string; error: string }>;
  publicationFailures: Array<{ documentName: string; error: string; outputFolder?: string }>;
  warning?: string;
};

export const presentOfficeExtractionResult = (
  result: OfficeImageExtractionResult,
  requestedDocuments: number,
): OfficeExtractionPresentation | null => {
  const items = Array.isArray(result.results) ? result.results : [];
  const successful = items.filter(item => item.success);
  if (!result.success && !successful.length) return null;
  const extractionFailures = items
    .filter(item => !item.success)
    .map(item => ({ documentName: item.documentName, error: item.error || '提取失败' }));
  const explicitPublicationFailures = successful
    .filter(item => item.publishSuccess === false)
    .map(item => ({ documentName: item.documentName, error: item.publishError || result.error || '发布失败', outputFolder: item.outputFolder }));
  const publicationFailures = result.success
    ? explicitPublicationFailures
    : successful.filter(item => item.publishSuccess !== true).map(item => ({ documentName: item.documentName, error: item.publishError || result.error || '发布状态失败', outputFolder: item.outputFolder }));
  return {
    state: publicationFailures.length ? 'publication-failed' : extractionFailures.length ? 'partial' : 'success',
    documents: result.acceptedCount ?? result.documentCount ?? requestedDocuments,
    successful: result.successfulCount ?? successful.length,
    images: result.imageCount ?? successful.reduce((total, item) => total + (Number(item.count) || 0), 0),
    failed: result.failedCount ?? extractionFailures.length,
    outputFolders: [...new Set(successful.flatMap(item => item.outputFolder ? [item.outputFolder] : []))],
    extractionFailures,
    publicationFailures,
    ...(publicationFailures.length ? { warning: result.warning || result.error || '图片已经提取，但结果发布失败；请从下列输出目录恢复。' } : {}),
  };
};
