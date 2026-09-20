import { useEffect, useState } from 'react';
import type { PreviewDecoder } from '../../contracts/component-preview';

export const usePreviewDecoders = () => {
  const [decoders, setDecoders] = useState<PreviewDecoder[]>([]);
  useEffect(() => {
    let active = true;
    const refresh = () => { void window.electronAPI.getPreviewDecoders().then(value => { if (active) setDecoders(value); }).catch(() => { if (active) setDecoders([]); }); };
    refresh(); const stop = window.electronAPI.onComponentsStatusChanged(refresh);
    return () => { active = false; stop(); };
  }, []);
  return decoders;
};
export const decoderForFile = (decoders: PreviewDecoder[], name: string) => decoders.find(item => item.extensions.some(extension => extension !== '*' && name.toLowerCase().endsWith(extension))) || decoders.find(item => item.extensions.includes('*'));

