import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { initializeWorkspaceWindow, workspaceWindowContext } from './platform/workspace-window-client'
import { installPageTransferState } from './platform/page-transfer-state'
import { AppDialogProvider } from './components/AppDialogProvider.tsx'
import { LayerProvider } from './components/LayerProvider.tsx'
import { ApplicationQuitController } from './features/app/ApplicationQuitController.tsx'
import { TaskCenterProvider } from './features/background-tasks/TaskCenter.tsx'
import { TopToastProvider, TopToastViewport } from './features/app/useTopToastStack.tsx'
import './index.css'
import { preloadPageKind } from './features/app/lazyPage'

const renderApp = () => ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LayerProvider>
      <AppDialogProvider>
        <ApplicationQuitController />
        <TaskCenterProvider>
          <TopToastProvider>
            <TopToastViewport />
            <App />
          </TopToastProvider>
        </TaskCenterProvider>
      </AppDialogProvider>
    </LayerProvider>
  </React.StrictMode>,
)
void initializeWorkspaceWindow().then(async () => {
  const context = workspaceWindowContext();
  if (context && !context.root) await preloadPageKind(context.seed.kind);
  installPageTransferState(workspaceWindowContext()?.seed.transfer?.state);
  renderApp();
}).catch(error => {
  console.error('窗口初始化失败', error);
  void window.electronAPI?.workspaceWindows?.ready(String(error.message || error)).catch(() => undefined);
  document.getElementById('root')!.textContent = '窗口初始化失败，请关闭后重新打开软件。';
});
