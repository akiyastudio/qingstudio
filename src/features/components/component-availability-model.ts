import type { ComponentStatus } from '../../types';

const unusableStatuses = new Set(['disabled', 'incompatible', 'invalid', 'integrity-invalid', 'package-invalid']);

export const componentRuntimeIsAvailable = (components: readonly ComponentStatus[], componentId: string) => {
  const component = components.find(item => item.id === componentId);
  return Boolean(component?.installed
    && component.enabled !== false
    && component.compatible
    && component.runtimeAvailable !== false
    && !unusableStatuses.has(String(component.status || '')));
};

export const componentCapabilityIsAvailable = (components: readonly ComponentStatus[], capability: string) =>
  components.some(component => (component.capabilities || [component.capability]).includes(capability)
    && componentRuntimeIsAvailable(components, component.id));

export const componentCapabilityUnavailableMessage = (components: readonly ComponentStatus[], capability: string, displayName: string) => {
  const component = components.find(item => (item.capabilities || [item.capability]).includes(capability));
  return component ? componentUnavailableMessage(components, component.id, displayName) : `需要安装${displayName}`;
};

export const availableComponentIds = (components: readonly ComponentStatus[]) => new Set(
  components.filter(component => componentRuntimeIsAvailable(components, component.id)).map(component => component.id),
);

export const componentUnavailableMessage = (components: readonly ComponentStatus[], componentId: string, displayName: string) => {
  const component = components.find(item => item.id === componentId);
  if (!component?.installed) return `需要安装${displayName}`;
  if (component.enabled === false || component.status === 'disabled') return `需要启用${displayName}`;
  if (!component.compatible || component.status === 'incompatible') return `${displayName}与当前版本不兼容`;
  if (component.runtimeAvailable === false) return `${displayName}运行时不可用`;
  return `${displayName}当前不可用`;
};
