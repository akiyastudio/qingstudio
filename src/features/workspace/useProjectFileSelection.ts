import { useCallback, useEffect, useRef, useState } from 'react';

type SelectionEntry = { relativePath: string };

export const useProjectFileSelection = (resetKey: string) => {
  const anchorPathRef = useRef('');
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);

  useEffect(() => {
    anchorPathRef.current = '';
    setSelectedPaths([]);
  }, [resetKey]);

  const toggle = useCallback((relativePath: string) => {
    anchorPathRef.current = relativePath;
    setSelectedPaths(current => current.includes(relativePath)
      ? current.filter(path => path !== relativePath)
      : [...current, relativePath]);
  }, []);

  const selectRange = useCallback((relativePath: string, additive: boolean, entries: readonly SelectionEntry[]) => {
    const targetIndex = entries.findIndex(entry => entry.relativePath === relativePath);
    if (targetIndex < 0) return;
    setSelectedPaths(current => {
      const storedAnchorPath = current.includes(anchorPathRef.current) ? anchorPathRef.current : '';
      const selectedAnchorPath = storedAnchorPath || [...current].reverse().find(path => entries.some(entry => entry.relativePath === path)) || '';
      const anchorIndex = current.length ? entries.findIndex(entry => entry.relativePath === selectedAnchorPath) : -1;
      if (anchorIndex < 0) {
        anchorPathRef.current = relativePath;
        return additive ? Array.from(new Set([...current, relativePath])) : [relativePath];
      }
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      const rangePaths = entries.slice(start, end + 1).map(entry => entry.relativePath);
      return additive ? Array.from(new Set([...current, ...rangePaths])) : rangePaths;
    });
  }, []);

  return { anchorPathRef, selectedPaths, setSelectedPaths, selectRange, toggle };
};
