export const WORKSPACE_PANEL_IDS = ['files', 'preview', 'metadata'] as const;
export type NativeWorkspacePanelId = typeof WORKSPACE_PANEL_IDS[number];
export type ComponentWorkspacePanelId = `component:${string}:${string}`;
export type WorkspacePanelId = NativeWorkspacePanelId | ComponentWorkspacePanelId;
export const componentWorkspacePanelId = (componentId: string, contributionId: string): ComponentWorkspacePanelId => `component:${componentId}:${contributionId}`;
export const PANEL_LAYOUT_CHANGED_EVENT = 'photoflow:panel-layout-changed';
