const flushers = new Set<() => Promise<void>>();

export const registerApplicationQuitFlush = (flush: () => Promise<void>) => {
  flushers.add(flush);
  return () => { flushers.delete(flush); };
};

export const flushApplicationBeforeQuit = () => Promise.all([...flushers].map(flush => flush()));
