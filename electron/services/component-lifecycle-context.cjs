const COMPONENT_LIFECYCLE_LEASE = Symbol('PhotoFlow.componentLifecycleLease');

const getComponentLifecycleLease = context => context?.[COMPONENT_LIFECYCLE_LEASE] || null;

const withComponentLifecycleLease = (context, lease) => {
  if (!lease) return context;
  const internalContext = { ...(context || {}) };
  Object.defineProperty(internalContext, COMPONENT_LIFECYCLE_LEASE, {
    value: lease,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return internalContext;
};

module.exports = { COMPONENT_LIFECYCLE_LEASE, getComponentLifecycleLease, withComponentLifecycleLease };
