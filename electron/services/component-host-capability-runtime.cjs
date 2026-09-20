const { registerComponentProjectCapabilities } = require('./component-project-capabilities.cjs');
const { ComponentCapabilityBroker } = require('./component-capability-broker.cjs');
const { ComponentNotificationService } = require('./component-notification-service.cjs');
const { registerComponentProjectReadCapabilities } = require('./component-project-read-capabilities.cjs');
const { registerComponentProjectWriteCapabilities } = require('./component-project-write-capabilities.cjs');
const { createComponentSecretsService } = require('./component-secrets-service.cjs');
const { createComponentNetworkService } = require('./component-network-service.cjs');
const { createComponentRuntimeExecutionService } = require('./component-runtime-execution-service.cjs');
const { registerComponentFileResources } = require('./component-file-resources.cjs');
const { registerComponentTransferCapabilities } = require('./component-transfer-capabilities.cjs');
const { createComponentPreviewService, setPreviewRuntime } = require('./component-preview-service.cjs');

const createComponentHostCapabilityRuntime = dependencies => {
  const componentCapabilityBroker = new ComponentCapabilityBroker({ lifecycleCoordinator: dependencies.lifecycleCoordinator });
  componentCapabilityBroker.register('component.panel', require('./component-panel-capability.cjs').componentPanelCapability);
  const componentNotificationService = new ComponentNotificationService({ mainWindow: dependencies.mainWindow });
  componentCapabilityBroker.register('notifications', (payload, context, descriptor) => componentNotificationService.publish(descriptor, payload, context));
  const projectDomain = registerComponentProjectCapabilities({ ...dependencies, broker: componentCapabilityBroker });
  const fileResources = registerComponentFileResources({ ...dependencies, broker: componentCapabilityBroker, projectDomain });
  const preview = createComponentPreviewService({ ...dependencies, fileResources });
  const videoPreviews = require('./component-preview-video-service.cjs').createPreviewVideoService({ dependencies, projectDomain });
  setPreviewRuntime({ preview, videoPreviews, fileResources, projectDomain, dependencies });
  componentCapabilityBroker.register('project.preview', preview.invoke);
  const transfers = registerComponentTransferCapabilities({ ...dependencies, broker: componentCapabilityBroker, projectDomain, fileResources });
  registerComponentProjectReadCapabilities({ ...dependencies, broker: componentCapabilityBroker });
  const runtimeExecution = createComponentRuntimeExecutionService({ ...dependencies, broker: componentCapabilityBroker, inputTokens: projectDomain });
  const writeDomain = registerComponentProjectWriteCapabilities({ ...dependencies, broker: componentCapabilityBroker, projectDomain });
  const secretsService = createComponentSecretsService(dependencies); const networkService = createComponentNetworkService({ ...dependencies, secretsService });
  componentCapabilityBroker.register('component.secrets', secretsService.invoke);
  componentCapabilityBroker.register('network.fetch', networkService.invoke);
  const clearComponentCapabilityState = async componentId => { await videoPreviews.clearComponent(componentId); fileResources.clearComponent(componentId); await transfers.clearComponent(componentId); const results=await Promise.allSettled([projectDomain?.clearComponent?.(componentId),runtimeExecution?.clearComponent?.(componentId),writeDomain?.clearComponent?.(componentId)]);const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason);if(errors.length)throw new AggregateError(errors,`Unable to clear every capability state for ${componentId}`); };
  const clearComponentViewState = async componentId => { fileResources.clearComponent(componentId); await transfers.clearComponent(componentId); return projectDomain.clearComponent(componentId, { preserveReservedInputs: true }); };
  return { setComponentPlaybackPaused:runtimeExecution.setPlaybackPaused,updateComponentPlaybackBounds:runtimeExecution.updatePlaybackBounds,refreshComponentPlaybackBounds:runtimeExecution.refreshPlaybackBounds,componentCapabilityBroker, componentInputGrants: projectDomain, componentNotificationService, clearComponentCapabilityState, clearComponentViewState, clearComponentSecretData: secretsService.removeComponentData, abortComponentNetworkRequests: networkService.clearComponent };
};

module.exports = { createComponentHostCapabilityRuntime };
