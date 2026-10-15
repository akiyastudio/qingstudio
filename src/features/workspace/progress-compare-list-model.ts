import type { CompareMatch, ProgressCompareConfirmation } from './project-progress-workflow-types';

export type ProgressCompareFilter = 'recognized' | 'accepted' | 'new' | 'missing';
type ProgressCompareListItem = {
  key: string;
  source?: string;
  reference?: string;
  match?: CompareMatch;
  category: ProgressCompareFilter;
};
const progressCompareCandidatesFor = (compare: ProgressCompareConfirmation) => [...compare.matches, ...compare.suggestions];
const progressCompareMissingReferencesFor = (compare: ProgressCompareConfirmation) => {
  const acceptedSources = new Set(compare.acceptedSources);
  const acceptedReferences = new Set(progressCompareCandidatesFor(compare)
    .filter(match => acceptedSources.has(match.source))
    .map(match => match.reference));
  return compare.unmatchedReferences.filter(reference => !acceptedReferences.has(reference));
};
export const progressCompareNewSourcesFor = (compare: ProgressCompareConfirmation) => {
  const acceptedSources = new Set(compare.acceptedSources);
  return Array.from(new Set([
    ...compare.unmatchedSources,
    ...compare.matches.filter(match => !acceptedSources.has(match.source)).map(match => match.source),
  ])).filter(source => !acceptedSources.has(source));
};
export const buildProgressCompareListItems = (compare: ProgressCompareConfirmation, filter: ProgressCompareFilter): ProgressCompareListItem[] => {
  const candidates = progressCompareCandidatesFor(compare);
  const acceptedSources = new Set(compare.acceptedSources);
  if (filter === 'recognized') return compare.matches.map(match => ({ key: `source:${match.source}`, source: match.source, reference: match.reference, match, category: filter }));
  if (filter === 'accepted') return candidates.filter(match => acceptedSources.has(match.source)).map(match => ({ key: `source:${match.source}`, source: match.source, reference: match.reference, match, category: filter }));
  if (filter === 'new') return progressCompareNewSourcesFor(compare).map(source => {
    const match = candidates.find(candidate => candidate.source === source);
    return { key: `source:${source}`, source, reference: match?.reference, match, category: filter };
  });
  return progressCompareMissingReferencesFor(compare).map(reference => {
    const match = candidates.find(candidate => candidate.reference === reference && !acceptedSources.has(candidate.source));
    return { key: `reference:${reference}`, source: match?.source, reference, match, category: filter };
  });
};
