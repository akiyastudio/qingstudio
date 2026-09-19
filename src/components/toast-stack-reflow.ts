import { useLayoutEffect, useRef, type RefObject } from 'react';

export const TOAST_STACK_REFLOW_MS = 200;

export const useToastStackReflow = (stackRef: RefObject<HTMLElement | null>, layoutKey: string) => {
  const previousPositionsRef = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    const stack = stackRef.current;
    if (!stack) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const nextPositions = new Map<string, number>();
    for (const element of stack.querySelectorAll<HTMLElement>('[data-top-toast-id]')) {
      const id = element.dataset.topToastId;
      if (!id) continue;
      const top = element.getBoundingClientRect().top;
      nextPositions.set(id, top);
      const previousTop = previousPositionsRef.current.get(id);
      if (reducedMotion || previousTop === undefined || Math.abs(previousTop - top) < 1) continue;
      element.animate(
        [{ transform: `translateY(${previousTop - top}px)` }, { transform: 'translateY(0)' }],
        { duration: TOAST_STACK_REFLOW_MS, easing: 'ease-out' },
      );
    }
    previousPositionsRef.current = nextPositions;
  }, [layoutKey, stackRef]);
};
