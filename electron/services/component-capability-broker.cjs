const { CAPABILITY_PERMISSIONS, HOST_CAPABILITIES } = require('../component-host-contract.cjs');
const { getComponentLifecycleLease, withComponentLifecycleLease } = require('./component-lifecycle-context.cjs');

const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const APPLICATION_SETTINGS_CAPABILITIES = new Set(['component.settings', 'component.lifecycle', 'dialogs', 'notifications', 'component.secrets']);
const APPLICATION_COMMAND_CAPABILITIES = new Set([...APPLICATION_SETTINGS_CAPABILITIES, 'network.fetch']);

const clonePayload = payload => {
  if (payload === undefined || payload === null) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Component capability payload must be an object');
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) > MAX_PAYLOAD_BYTES) throw new RangeError('Component capability payload is too large');
  return JSON.parse(serialized);
};

class ComponentCapabilityBroker {
  constructor({ lifecycleCoordinator = null } = {}) { this.handlers = new Map(); this.activeByComponent = new Map(); this.blockedComponents = new Map(); this.drainWaiters = new Map(); this.lifecycleCoordinator = lifecycleCoordinator; }

  finishInvocation(componentId) {
    const active = Math.max(0, (this.activeByComponent.get(componentId) || 1) - 1);
    if (active) this.activeByComponent.set(componentId, active);
    else {
      this.activeByComponent.delete(componentId);
      for (const resolve of this.drainWaiters.get(componentId) || []) resolve();
      this.drainWaiters.delete(componentId);
    }
  }

  blockComponent(componentId) {
    const id = String(componentId || '');
    this.blockedComponents.set(id, (this.blockedComponents.get(id) || 0) + 1);
    let released = false;
    return {
      drain: ({ timeoutMs = 7500 } = {}) => {
        if (!this.activeByComponent.get(id)) return Promise.resolve();
        return new Promise((resolve, reject) => {
          const waiters = this.drainWaiters.get(id) || new Set();
          let timer;
          const finish = () => { clearTimeout(timer); waiters.delete(finish); resolve(); };
          waiters.add(finish); this.drainWaiters.set(id, waiters);
          timer = setTimeout(() => { waiters.delete(finish); if (!waiters.size) this.drainWaiters.delete(id); const error = new Error(`Component capability drain timed out: ${id}`); error.code = 'COMPONENT_BUSY'; reject(error); }, Math.max(1, Math.min(60000, Number(timeoutMs) || 7500)));
        });
      },
      release: () => {
        if (released) return;
        released = true;
        const remaining = Math.max(0, (this.blockedComponents.get(id) || 1) - 1);
        if (remaining) this.blockedComponents.set(id, remaining); else this.blockedComponents.delete(id);
      },
    };
  }

  register(method, handler) {
    if (!HOST_CAPABILITIES.has(method)) throw new Error(`Unknown host capability: ${method}`);
    if (typeof handler !== 'function') throw new TypeError(`Host capability handler is required: ${method}`);
    if (this.handlers.has(method)) throw new Error(`Duplicate host capability: ${method}`);
    this.handlers.set(method, handler);
  }

  assertCapabilities(descriptor) {
    const missing = (descriptor?.service?.capabilities || []).filter(method => !this.handlers.has(method));
    if (missing.length) throw new Error(`Component declares unavailable host capabilities: ${descriptor.componentId}: ${missing.join(', ')}`);
    return true;
  }

  invoke(descriptor, method, payload, boundContext) {
    const normalized = String(method || '');
    const componentId = String(descriptor?.componentId || '');
    if (this.blockedComponents.has(componentId)) throw new Error(`Component capabilities are quiesced: ${componentId}`);
    const applicationAllowlist = boundContext?.surface === 'application.settings' ? APPLICATION_SETTINGS_CAPABILITIES : boundContext?.surface === 'application.command' ? APPLICATION_COMMAND_CAPABILITIES : null;
    if (applicationAllowlist && !applicationAllowlist.has(normalized)) {
      throw new Error(`Component capability is not available on the ${boundContext.surface} surface: ${normalized}`);
    }
    if (!descriptor?.service?.capabilities.includes(normalized)) { const error = new Error(`Component capability is not granted: ${normalized}`); error.code = 'COMPONENT_HOST_PERMISSION_DENIED'; throw error; }
    const permission = CAPABILITY_PERMISSIONS[normalized];
    if (permission && !descriptor.service.permissions?.includes(permission)) { const error = new Error(`Component capability permission is not granted: ${permission}`); error.code = 'COMPONENT_HOST_PERMISSION_DENIED'; throw error; }
    const handler = this.handlers.get(normalized);
    if (normalized === 'project.files.inputToken' && !descriptor.service.permissions?.includes('project.input.read')) { const error = new Error('Component capability requires project.input.read'); error.code = 'COMPONENT_HOST_PERMISSION_DENIED'; throw error; }
    if (!handler) throw new Error(`Host capability is unavailable: ${normalized}`);
    const inheritedLease = getComponentLifecycleLease(boundContext);
    const lifecycleLease = this.lifecycleCoordinator?.isActiveWorkLease?.(componentId, inheritedLease)
      ? inheritedLease
      : this.lifecycleCoordinator?.acquireWork?.(componentId, `capability:${normalized}`);
    const ownsLifecycleLease = Boolean(lifecycleLease && lifecycleLease !== inheritedLease);
    const retainedLifecycleLease = !ownsLifecycleLease ? lifecycleLease?.retain?.() : null;
    const internalContext = withComponentLifecycleLease(boundContext, lifecycleLease);
    this.activeByComponent.set(componentId, (this.activeByComponent.get(componentId) || 0) + 1);
    try {
      const result = handler(clonePayload(payload), internalContext, descriptor);
      if (result && typeof result.then === 'function') return Promise.resolve(result).finally(() => { this.finishInvocation(componentId); retainedLifecycleLease?.release(); if (ownsLifecycleLease) lifecycleLease.release(); });
      this.finishInvocation(componentId);
      retainedLifecycleLease?.release();
      if (ownsLifecycleLease) lifecycleLease.release();
      return result;
    } catch (error) {
      this.finishInvocation(componentId);
      retainedLifecycleLease?.release();
      if (ownsLifecycleLease) lifecycleLease.release();
      throw error;
    }
  }
}

module.exports = { APPLICATION_COMMAND_CAPABILITIES, APPLICATION_SETTINGS_CAPABILITIES, ComponentCapabilityBroker, MAX_PAYLOAD_BYTES, clonePayload };
