import type { ComponentSettingsPageContribution } from '../../types';

export type ComponentSettingsSection = `component:${string}:${string}`;
export const componentSettingsSectionKey = (page: Pick<ComponentSettingsPageContribution, 'componentId' | 'pageId'>): ComponentSettingsSection => `component:${encodeURIComponent(page.componentId)}:${encodeURIComponent(page.pageId)}`;
