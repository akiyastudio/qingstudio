export type HostSurfaceState = {
  revision: number;
  suspended: boolean;
  referenceCount: number;
};

type HostLayerRegistry = {
  acquire: (token: string) => () => void;
  snapshot: () => HostSurfaceState;
};

const createHostLayerRegistry = (onChange: (state: HostSurfaceState) => void): HostLayerRegistry => {
  const acquisitions = new Map<string, Set<number>>();
  let nextAcquisitionId = 1;
  let revision = 0;

  const snapshot = (): HostSurfaceState => {
    const referenceCount = [...acquisitions.values()].reduce((count, entries) => count + entries.size, 0);
    return { revision, suspended: referenceCount > 0, referenceCount };
  };
  const publish = () => {
    revision += 1;
    onChange(snapshot());
  };

  return {
    acquire(token) {
      const acquisitionId = nextAcquisitionId++;
      const entries = acquisitions.get(token) || new Set<number>();
      entries.add(acquisitionId);
      acquisitions.set(token, entries);
      publish();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const current = acquisitions.get(token);
        if (!current?.delete(acquisitionId)) return;
        if (current.size === 0) acquisitions.delete(token);
        publish();
      };
    },
    snapshot,
  };
};

export { createHostLayerRegistry };
