import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createHostLayerRegistry, type HostSurfaceState } from './host-layer-state';

type LayerState = {
  enabled: boolean;
  onEscape: () => void;
};

type LayerRegistration = {
  id: string;
  read: () => LayerState;
};

type LayerContextValue = {
  register: (layer: LayerRegistration) => () => void;
  acquireHostSurfaceSuspension: (token: string) => () => void;
  hostSurfaceState: HostSurfaceState;
  rendererToken: string;
};

const LayerContext = createContext<LayerContextValue | null>(null);

const LayerProvider = ({ children }: { children: ReactNode }) => {
  const layersRef = useRef<LayerRegistration[]>([]);
  const [hostSurfaceState, setHostSurfaceState] = useState<HostSurfaceState>({ revision: 0, suspended: false, referenceCount: 0 });
  const hostLayerRegistry = useMemo(() => createHostLayerRegistry(setHostSurfaceState), []);
  const rendererTokenRef = useRef(globalThis.crypto?.randomUUID?.() || `renderer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`);

  const register = useCallback((layer: LayerRegistration) => {
    layersRef.current = [...layersRef.current.filter(item => item.id !== layer.id), layer];
    return () => {
      layersRef.current = layersRef.current.filter(item => item.id !== layer.id);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const top = layersRef.current.at(-1);
      if (!top) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const state = top.read();
      if (state.enabled) state.onEscape();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  useEffect(() => {
    void window.electronAPI.setHostSurfaceSuspended({
      rendererToken: rendererTokenRef.current,
      revision: hostSurfaceState.revision,
      suspended: hostSurfaceState.suspended,
    });
  }, [hostSurfaceState.revision, hostSurfaceState.suspended]);

  const contextValue = useMemo<LayerContextValue>(() => ({
    register,
    acquireHostSurfaceSuspension: hostLayerRegistry.acquire,
    hostSurfaceState,
    rendererToken: rendererTokenRef.current,
  }), [hostLayerRegistry, hostSurfaceState, register]);

  return <LayerContext.Provider value={contextValue}>{children}</LayerContext.Provider>;
};

const useHostSurfaceSuspension = (active: boolean) => {
  const context = useContext(LayerContext);
  if (!context) throw new Error('useHostSurfaceSuspension must be used inside LayerProvider');
  const id = useId();
  const acquireHostSurfaceSuspension = context.acquireHostSurfaceSuspension;
  useEffect(() => {
    if (!active) return;
    return acquireHostSurfaceSuspension(id);
  }, [acquireHostSurfaceSuspension, active, id]);
};

const useHostSurfaceState = () => {
  const context = useContext(LayerContext);
  if (!context) throw new Error('useHostSurfaceState must be used inside LayerProvider');
  return context.hostSurfaceState;
};

const useHostRendererToken = () => {
  const context = useContext(LayerContext);
  if (!context) throw new Error('useHostRendererToken must be used inside LayerProvider');
  return context.rendererToken;
};

const useEscapeLayer = (open: boolean, onEscape: () => void, enabled = true, suspendExternalSurfaces = false) => {
  const context = useContext(LayerContext);
  if (!context) throw new Error('useEscapeLayer must be used inside LayerProvider');
  const id = useId();
  const register = context.register;
  const stateRef = useRef<LayerState>({ enabled, onEscape });
  stateRef.current = { enabled, onEscape };
  useHostSurfaceSuspension(open && suspendExternalSurfaces);

  useEffect(() => {
    if (!open) return;
    return register({ id, read: () => stateRef.current });
  }, [id, open, register]);
};

// Provider and hook intentionally share the same private layer registry.
// eslint-disable-next-line react-refresh/only-export-components
export { LayerProvider, useEscapeLayer, useHostRendererToken, useHostSurfaceState, useHostSurfaceSuspension };
