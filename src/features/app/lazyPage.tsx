import { t } from "../../i18n/runtime";
import { Suspense, type ComponentType } from 'react';

// Keep loading local to a page; opening a tool must not hide the application shell.
const pageLoads = new Map<string, Array<() => Promise<unknown>>>();
export const preloadPageKind = async (kind: string) => {
  await Promise.all((pageLoads.get(kind) || []).map(load => load()));
};

export function lazyPage<P extends object>(load: () => Promise<{ default: ComponentType<P> }>, kind?: string) {
  let resolved: ComponentType<P> | undefined;
  let pending: ReturnType<typeof load> | undefined;
  let failed = false;
  let failure: unknown;
  const prepare = () => pending ||= load().then(result => { resolved = result.default; return result; }).catch(error => { failed = true; failure = error; throw error; });
  if (kind) pageLoads.set(kind, [...(pageLoads.get(kind) || []), prepare]);
  function Content(props: P) {
    if (failed) throw failure;
    if (!resolved) throw prepare();
    const Page = resolved;
    return <Page {...props}/>;
  }
  return function DeferredPage(props: P) {
    return <Suspense fallback={<div role="status" className="flex h-full min-h-24 items-center justify-center text-sm text-slate-400">{t("ui.loading.page.0cf062")}</div>}><Content {...props}/></Suspense>;
  };
}
