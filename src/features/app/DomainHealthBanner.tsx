import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { ComponentStatus } from '../../types';
import { useUserFacingToast } from './useUserFacingToast';

type DomainHealthSnapshot = Awaited<ReturnType<Window['electronAPI']['getDomainHealth']>>;

const DOMAIN_LABELS: Record<string, string> = {
  workspace: '项目目录', 'workspace-maintenance': '工作区维护', 'file-operations': '文件操作',
  'media-background': '媒体索引', 'media-interaction': '媒体浏览', 'media-scan': '媒体扫描',
  'tracking-scan': '版本跟踪', components: '组件数据',
};

export const DomainHealthBanner = ({ components }: { components: ComponentStatus[] }) => {
  const toast = useUserFacingToast();
  const [snapshot, setSnapshot] = useState<DomainHealthSnapshot>({ success: true, domains: [], commands: [] });
  const [retryBusy, setRetryBusy] = useState(false);
  const mountedRef = useRef(true);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    const request = window.electronAPI.getDomainHealth().then(status => {
      if (mountedRef.current && status?.success) setSnapshot(status);
    }).catch(() => { /* Health reporting must never interfere with navigation. */ }).finally(() => {
      if (refreshInFlightRef.current === request) refreshInFlightRef.current = null;
    });
    refreshInFlightRef.current = request;
    return request;
  }, []);
  useEffect(() => {
    let active = true;
    mountedRef.current = true;
    let timer: number | undefined;
    const poll = async () => {
      if (!active) return;
      await refresh();
      if (active) timer = window.setTimeout(() => { void poll(); }, 3000);
    };
    void poll();
    return () => {
      active = false;
      mountedRef.current = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refresh]);
  const domains = useMemo(() => snapshot.domains.filter(domain => domain.state !== 'healthy'), [snapshot.domains]);
  const commands = useMemo(() => snapshot.commands.filter(command => command.status === 'dead' || command.attempts > 0), [snapshot.commands]);
  if (!domains.length && !commands.length) return null;
  const hasFailure = domains.some(domain => domain.state === 'unavailable') || commands.some(command => command.status === 'dead');
  const componentNames = new Map(components.map(component => [component.id, component.name]));
  const domainLabel = (domain: DomainHealthSnapshot['domains'][number]) => {
    const componentId = domain.componentId;
    return domain.displayName || (componentId ? componentNames.get(componentId) : undefined) || DOMAIN_LABELS[domain.domainId] || domain.domainId;
  };
  const retryDead = async () => {
    if (retryBusy) return;
    const dead = commands.filter(command => command.status === 'dead');
    if (!dead.length) return;
    setRetryBusy(true);
    try {
      const results = await Promise.allSettled(dead.map(command => window.electronAPI.retryDomainCommand(command.commandId)));
      const failed = results.filter(result => result.status === 'rejected' || !result.value.success);
      toast.show(failed.length ? `${failed.length} 个跨域任务无法重试` : `已重新提交 ${dead.length} 个跨域任务`, { tone: failed.length ? 'error' : 'success', dedupeKey: 'domain-health-retry' });
      await refresh();
    } catch (retryError) {
      toast.show(`跨域任务重试失败：${retryError instanceof Error ? retryError.message : String(retryError)}`, { tone: 'error', dedupeKey: 'domain-health-retry' });
    } finally {
      if (mountedRef.current) setRetryBusy(false);
    }
  };
  return <div role="status" title={domains.map(domainLabel).join('、')} className={`app-titlebar-control flex h-8 max-w-sm shrink-0 items-center gap-2 rounded-md border px-2 text-[11px] ${hasFailure ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
    <AlertTriangle size={15} className="shrink-0"/>
    <span className="min-w-0 flex-1 truncate"><strong>部分功能已隔离</strong> · {domains.map(domain => domainLabel(domain)).join('、') || '跨域任务'}</span>
    {commands.some(command => command.status === 'dead') && <button type="button" disabled={retryBusy} aria-busy={retryBusy} onClick={() => void retryDead()} className="shrink-0 rounded border border-current px-1.5 py-0.5 font-bold hover:bg-white/60 disabled:cursor-wait disabled:opacity-60">{retryBusy ? '重试中…' : '重试'}</button>}
  </div>;
};
