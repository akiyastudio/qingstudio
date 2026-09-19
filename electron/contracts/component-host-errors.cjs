const COMPONENT_HOST_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'COMPONENT_HOST_INVALID_REQUEST',
  PERMISSION_DENIED: 'COMPONENT_HOST_PERMISSION_DENIED',
  NOT_FOUND: 'COMPONENT_HOST_NOT_FOUND',
  TOKEN_EXPIRED: 'COMPONENT_HOST_TOKEN_EXPIRED',
  TOKEN_SCOPE: 'COMPONENT_HOST_TOKEN_SCOPE',
  LIMIT_EXCEEDED: 'COMPONENT_HOST_LIMIT_EXCEEDED',
  VARIANT_UNAVAILABLE: 'COMPONENT_HOST_VARIANT_UNAVAILABLE',
  CONFLICT: 'COMPONENT_HOST_CONFLICT',
  CANCELLED: 'COMPONENT_HOST_CANCELLED',
  TIMEOUT: 'COMPONENT_HOST_TIMEOUT',
  SERVICE_EXITED: 'COMPONENT_HOST_SERVICE_EXITED',
  INTERNAL: 'COMPONENT_HOST_INTERNAL',
});

class ComponentHostError extends Error {
  constructor(code, message, options = {}) {
    super(String(message || code));
    this.name = 'ComponentHostError';
    this.code = code;
    this.retryable = options.retryable === true;
    if (options.details !== undefined) this.details = options.details;
  }
}

const hostError = (code, message, options) => new ComponentHostError(code, message, options);

module.exports = { COMPONENT_HOST_ERROR_CODES, ComponentHostError, hostError };
