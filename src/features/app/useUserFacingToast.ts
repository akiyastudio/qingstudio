import { renderMessage, type StructuredNotice } from '../../i18n/messages';
import { useCallback, useMemo } from 'react';
import { useToast, type ToastActivityHandle, type ToastApi, type ToastOptions, type ToastUpdate } from './useTopToastStack';
import { prepareUserFacingNotice, prepareUserFacingUpdate } from './user-facing-notice-model';

export type UserFacingToastApi = ToastApi & { showLocalized: (notice: StructuredNotice, options?: ToastOptions) => ReturnType<ToastApi['show']> };
export const useUserFacingToast = (): UserFacingToastApi => {
  const toast = useToast();
  const show = useCallback<ToastApi['show']>((message, options) => {
    const prepared = prepareUserFacingNotice(message, options);
    return toast.show(prepared.message, prepared.options);
  }, [toast]);
  const update = useCallback<ToastApi['update']>((idOrKey, value) => {
    toast.update(idOrKey, prepareUserFacingUpdate(value));
  }, [toast]);
  const activity = useCallback<ToastApi['activity']>((message, options = {}): ToastActivityHandle => {
    const prepared = prepareUserFacingNotice(message, options);
    const handle = toast.activity(prepared.message, prepared.options);
    return {
      ...handle,
      update: value => handle.update(prepareUserFacingUpdate(value)),
      succeed: (next, nextOptions = {}) => handle.succeed(next, nextOptions),
      fail: (next, nextOptions = {}) => {
        const failed = prepareUserFacingNotice(next, nextOptions);
        handle.fail(failed.message, (failed.options || {}) as Omit<ToastOptions, 'dedupeKey'>);
      },
    };
  }, [toast]);
  const showLocalized = useCallback((notice: StructuredNotice, options: ToastOptions = {}) => toast.show(renderMessage(notice), { ...options, localizedMessage: notice, tone: notice.severity, ...(notice.persistent === true ? { lifecycle: 'persistent' as const } : notice.persistent === false ? { lifecycle: 'auto' as const, durationMs: options.durationMs ?? 5000 } : {}) }), [toast]);
  return useMemo(() => ({ show, showLocalized, update, dismiss: toast.dismiss, activity }), [activity, show, showLocalized, toast.dismiss, update]);
};

export type { ToastActivityHandle, ToastUpdate };
