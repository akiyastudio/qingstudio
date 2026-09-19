import { useCallback, useMemo } from 'react';
import { useToast, type ToastActivityHandle, type ToastApi, type ToastOptions, type ToastUpdate } from './useTopToastStack';
import { prepareUserFacingNotice, prepareUserFacingUpdate } from './user-facing-notice-model';

export const useUserFacingToast = (): ToastApi => {
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
  return useMemo(() => ({ show, update, dismiss: toast.dismiss, activity }), [activity, show, toast.dismiss, update]);
};

export type { ToastActivityHandle, ToastUpdate };
