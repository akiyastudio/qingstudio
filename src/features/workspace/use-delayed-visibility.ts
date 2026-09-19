import { useEffect, useState } from 'react';

export const useDelayedVisibility = (requested: boolean, delayMs: number) => {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!requested) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, requested]);
  return visible;
};
