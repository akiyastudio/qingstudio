import type { BackgroundTask } from '../../types';
import type { TopToastNotice } from './top-toast-notice-model';

export type ToastViewAction = {
  action: 'notice-dismiss' | 'task-dismiss' | 'task-minimize' | 'task-pause' | 'task-continue' | 'task-cancel';
  id: string;
};

export type ToastViewPresentation = {
  visible: boolean;
};

export type ToastViewSnapshot = {
  revision: number;
  dark: boolean;
  top: number;
  width: number;
  height: number;
  notices: TopToastNotice[];
  tasks: BackgroundTask[];
  overflowCount: number;
};

export type ToastViewApi = {
  onSnapshot: (callback: (snapshot: ToastViewSnapshot) => void) => () => void;
  sendAction: (action: ToastViewAction) => void;
  reportLayout: (layout: { revision: number; height: number; reflowMs?: number }) => void;
};
