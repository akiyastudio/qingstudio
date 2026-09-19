import { useEffect, useState } from 'react';
import { Puzzle } from 'lucide-react';

/** Shared renderer for host-issued component icons with a safe generic fallback. */
export const ComponentIcon = ({ src, size, className = 'shrink-0' }: { src?: string; size: number; className?: string }) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return src && !failed
    ? <img src={src} width={size} height={size} className={`${className} object-contain`} alt="" onError={() => setFailed(true)}/>
    : <Puzzle size={size} className={className}/>;
};
