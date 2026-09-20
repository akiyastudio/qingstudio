import { useLocale } from "../../i18n/react";
import { t } from "../../i18n/runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { ComponentStatus } from '../../types';
import { useUserFacingToast } from './useUserFacingToast';

type DomainHealthSnapshot = Awaited<ReturnType<Window['electronAPI']['getDomainHealth']>>;

const DOMAIN_LABELS: Record<string, string> = {
  get workspace() { return t("ui.project.folders.f1e172"); }, get 'workspace-maintenance'() { return t("ui.workspace.maintenance.d0077c"); }, get 'file-operations'() { return t("ui.file.operations.a6a7e4"); },
  get 'media-background'() { return t("ui.media.index.8a7074"); }, get 'media-interaction'() { return t("ui.media.browsing.c89ef5"); }, get 'media-scan'() { return t("ui.media.scan.0e7411"); },
  get 'tracking-scan'() { return t("ui.version.tracking.c4c7df"); }, get components() { return t("ui.component.data.09f600"); },
};

export const DomainHealthBanner = ({ components }: { components: ComponentStatus[] }) => {
  useLocale();
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
    <span className="min-w-0 flex-1 truncate"><strong>{t("ui.some.features.are.isolated.3e1569")}</strong> · {domains.map(domain => domainLabel(domain)).join('、') || t("ui.cross.domain.tasks.17e0fd")}</span>
    {commands.some(command => command.status === 'dead') && <button type="button" disabled={retryBusy} aria-busy={retryBusy} onClick={() => void retryDead()} className="shrink-0 rounded border border-current px-1.5 py-0.5 font-bold hover:bg-white/60 disabled:cursor-wait disabled:opacity-60">{retryBusy ? t("ui.retrying.ed1410") : t("ui.retry.b8784c")}</button>}
  </div>;
};
