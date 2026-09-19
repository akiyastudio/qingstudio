const createDomainHealthService = ({ now = () => Date.now() } = {}) => {
  const domains = new Map();
  const update = (domainId, state) => {
    const previous = domains.get(domainId) || {};
    const next = Object.freeze({ domainId, ...previous, ...state, updatedAt: now() });
    domains.set(domainId, next);
    return next;
  };
  const status = () => [...domains.values()].sort((left, right) => left.domainId.localeCompare(right.domainId));
  const get = domainId => domains.get(domainId) || { domainId, state: 'healthy', updatedAt: 0 };
  return { get, status, update };
};

module.exports = { createDomainHealthService };
