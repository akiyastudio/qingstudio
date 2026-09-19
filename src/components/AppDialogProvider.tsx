import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useEscapeLayer } from './LayerProvider';

type DialogTone = 'primary' | 'danger';

type ChoiceDialogOption = {
  value: string;
  label: string;
  tone?: DialogTone;
};

type ChoiceDialogOptions = {
  title: string;
  message: string;
  detail?: string;
  choices: ChoiceDialogOption[];
  cancelLabel?: string;
  defaultValue?: string;
  cancelDefault?: boolean;
};

type ConfirmDialogOptions = {
  priority?: boolean;
  requestId?: string;
  cancelDefault?: boolean;
  title: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: DialogTone;
};

type AlertDialogOptions = {
  title: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  tone?: DialogTone;
};

type PromptDialogOptions = {
  title: string;
  message?: string;
  detail?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

type DialogRequest = {
  id: number;
  kind: 'alert' | 'confirm' | 'prompt' | 'choice';
  options: AlertDialogOptions | ConfirmDialogOptions | PromptDialogOptions | ChoiceDialogOptions;
  resolve: (value: boolean | string | null) => void;
};

type AppDialogApi = {
  alert: (options: AlertDialogOptions) => Promise<void>;
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;
  prompt: (options: PromptDialogOptions) => Promise<string | null>;
  choice: (options: ChoiceDialogOptions) => Promise<string | null>;
};

const AppDialogContext = createContext<AppDialogApi | null>(null);

const AppDialogProvider = ({ children }: { children: ReactNode }) => {
  const nextId = useRef(1);
  const resolvingId = useRef<number | null>(null);
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  const [promptValue, setPromptValue] = useState('');
  const dialogRef = useRef<HTMLFormElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const active = queue[0];

  const enqueue = useCallback((kind: DialogRequest['kind'], options: AlertDialogOptions | ConfirmDialogOptions | PromptDialogOptions | ChoiceDialogOptions) => new Promise<boolean | string | null>(resolve => {
    const request = { id: nextId.current++, kind, options, resolve };
    setQueue(current => 'priority' in options && options.priority ? [request, ...current] : [...current, request]);
  }), []);

  const api = useMemo<AppDialogApi>(() => ({
    alert: async options => { await enqueue('alert', options); },
    confirm: async options => (await enqueue('confirm', options)) === true,
    prompt: async options => {
      const result = await enqueue('prompt', options);
      return typeof result === 'string' ? result : null;
    },
    choice: async options => {
      const result = await enqueue('choice', options);
      return typeof result === 'string' ? result : null;
    },
  }), [enqueue]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onAppConfirmation?.(options => api.confirm(options));
    const close = window.electronAPI?.onAppConfirmationClosed?.(requestId => {
      setQueue(current => {
        const cancelled = current.filter(item => 'requestId' in item.options && item.options.requestId === requestId);
        cancelled.forEach(item => item.resolve(false));
        return current.filter(item => !cancelled.includes(item));
      });
    });
    return () => { unsubscribe?.(); close?.(); };
  }, [api]);

  useEffect(() => {
    if (active?.kind === 'prompt') setPromptValue((active.options as PromptDialogOptions).defaultValue || '');
  }, [active?.id, active?.kind]);

  useEffect(() => {
    if (active && !previousFocusRef.current) previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!active && previousFocusRef.current) {
      const previous = previousFocusRef.current; previousFocusRef.current = null;
      window.requestAnimationFrame(() => previous.isConnected && previous.focus());
    }
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      const preferred = dialog?.querySelector<HTMLElement>('[data-default-focus="true"]');
      (preferred || dialog)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active?.id]);

  const finish = useCallback((value: boolean | string | null) => {
    if (!active || resolvingId.current === active.id) return;
    resolvingId.current = active.id;
    active.resolve(value);
    setQueue(current => current.filter(request => request.id !== active.id));
    resolvingId.current = null;
  }, [active]);

  useEscapeLayer(Boolean(active), () => finish(active?.kind === 'confirm' ? false : null), true, true);

  const submitPrompt = (event: FormEvent) => {
    event.preventDefault();
    if (active?.kind === 'prompt') finish(promptValue);
  };

  const options = active?.options;
  const alertOptions = active?.kind === 'alert' ? options as AlertDialogOptions : null;
  const confirmOptions = active?.kind === 'confirm' ? options as ConfirmDialogOptions : null;
  const promptOptions = active?.kind === 'prompt' ? options as PromptDialogOptions : null;
  const choiceOptions = active?.kind === 'choice' ? options as ChoiceDialogOptions : null;
  const confirmClass = (confirmOptions?.tone || alertOptions?.tone) === 'danger'
    ? 'dialog-primary !bg-red-600 hover:!bg-red-500'
    : 'dialog-primary';
  const dangerousConfirm = confirmOptions?.tone === 'danger' || confirmOptions?.cancelDefault === true;
  const dangerousDefaultChoice = choiceOptions?.choices.find(choice => choice.value === choiceOptions.defaultValue)?.tone === 'danger';
  const trapFocus = (event: React.KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== 'Tab') return;
    const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])];
    if (!controls.length) { event.preventDefault(); dialogRef.current?.focus(); return; }
    const first = controls[0]; const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  return <AppDialogContext.Provider value={api}>
    {children}
    {active && options && <div className={`fixed inset-0 ${'priority' in options && options.priority ? 'z-[3000]' : 'z-[1000]'} flex items-center justify-center bg-slate-950/40 p-4`} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) finish(active.kind === 'confirm' ? false : null); }}>
      <form ref={dialogRef} tabIndex={-1} onKeyDown={trapFocus} onSubmit={active.kind === 'prompt' ? submitPrompt : event => event.preventDefault()} role="dialog" aria-modal="true" aria-labelledby={`app-dialog-title-${active.id}`} aria-describedby={options.message ? `app-dialog-message-${active.id}` : undefined} className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <h3 id={`app-dialog-title-${active.id}`} className="font-bold text-slate-800">{options.title}</h3>
          <button type="button" aria-label="关闭对话框" onClick={() => finish(active.kind === 'confirm' ? false : null)} className="shrink-0 rounded p-1 text-slate-500 hover:bg-slate-100"><X size={18}/></button>
        </div>
        {options.message && <p id={`app-dialog-message-${active.id}`} className={`mt-3 whitespace-pre-line text-sm leading-6 ${alertOptions ? 'font-medium text-slate-700' : 'text-slate-500'}`}>{options.message}</p>}
        {options.detail && <p className="mt-2 whitespace-pre-line text-xs leading-5 text-slate-500">{options.detail}</p>}
        {promptOptions && <input aria-label={promptOptions.message || promptOptions.title} data-default-focus="true" value={promptValue} onChange={event => setPromptValue(event.target.value)} placeholder={promptOptions.placeholder} className="form-input mt-4"/>}
        <div className="mt-5 flex justify-end gap-2">
          {!alertOptions && <button type="button" data-default-focus={Boolean(choiceOptions?.cancelDefault || dangerousConfirm || dangerousDefaultChoice)} onClick={() => finish(active.kind === 'confirm' ? false : null)} className="dialog-secondary">{confirmOptions?.cancelLabel || promptOptions?.cancelLabel || choiceOptions?.cancelLabel || '取消'}</button>}
          {alertOptions
            ? <button type="button" data-default-focus="true" onClick={() => finish(null)} className={confirmClass}>{alertOptions.confirmLabel || '知道了'}</button>
            : confirmOptions
            ? <button type="button" data-default-focus={!dangerousConfirm} onClick={() => finish(true)} className={confirmClass}>{confirmOptions.confirmLabel || '确认'}</button>
            : promptOptions
            ? <button type="submit" disabled={!promptValue.trim()} className="dialog-primary">{promptOptions.confirmLabel || '确认'}</button>
            : choiceOptions?.choices.map(choice => <button key={choice.value} type="button" data-default-focus={choice.value === choiceOptions.defaultValue && choice.tone !== 'danger'} onClick={() => finish(choice.value)} className={choice.tone === 'danger' ? 'dialog-primary !bg-red-600 hover:!bg-red-500' : 'dialog-primary'}>{choice.label}</button>)}
        </div>
      </form>
    </div>}
  </AppDialogContext.Provider>;
};

const useAppDialog = () => {
  const value = useContext(AppDialogContext);
  if (!value) throw new Error('useAppDialog must be used inside AppDialogProvider');
  return value;
};

// Provider and hook intentionally live together so every dialog uses the same queue.
// eslint-disable-next-line react-refresh/only-export-components
export { AppDialogProvider, useAppDialog };
export type { AlertDialogOptions, ChoiceDialogOptions, ChoiceDialogOption, ConfirmDialogOptions, PromptDialogOptions };
