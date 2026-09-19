const crypto = require('crypto');
const { DOMAIN_IDS, assertKnownDomain } = require('./domain-ownership.cjs');

const DOMAIN_EVENT_SCHEMA_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKSPACE_ID_PATTERN = /^[0-9a-f]{24,64}$/;
const EVENT_TYPE_PATTERN = /^([a-z][a-z0-9-]*)\.([a-z][a-z0-9-]*)\.([a-z][a-z0-9-]*)\.v([1-9][0-9]*)$/;

const createStableId = () => crypto.randomUUID();

const assertStableEntityId = (value, label = 'entityId') => {
  if (!UUID_PATTERN.test(String(value || ''))) throw new Error(`${label} must be a canonical UUID`);
  return String(value).toLowerCase();
};

const assertStableWorkspaceId = value => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!WORKSPACE_ID_PATTERN.test(normalized)) throw new Error('workspaceId must be the persisted workspace identity');
  return normalized;
};

const parseEventType = value => {
  const match = EVENT_TYPE_PATTERN.exec(String(value || ''));
  if (!match) throw new Error('event type must use domain.entity.action.vN');
  const [, domain, entity, action, version] = match;
  assertKnownDomain(domain);
  return Object.freeze({ domain, entity, action, version: Number(version) });
};

const optionalStableId = (value, label) => value == null ? undefined : assertStableEntityId(value, label);

const createDomainEvent = ({
  type,
  source,
  aggregate,
  payload,
  workspaceId,
  projectId,
  correlationId,
  causationId,
  eventId = createStableId(),
  occurredAt = new Date().toISOString(),
}) => {
  const parsedType = parseEventType(type);
  const normalizedSource = assertKnownDomain(source);
  if (parsedType.domain !== normalizedSource) throw new Error('event type domain must match source');
  if (!aggregate || typeof aggregate !== 'object') throw new Error('aggregate is required');
  const aggregateType = String(aggregate.type || '').trim();
  if (!/^[a-z][a-z0-9-]*$/.test(aggregateType)) throw new Error('aggregate.type must be a stable lowercase name');
  const timestamp = String(occurredAt || '');
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) throw new Error('occurredAt must be an ISO timestamp');
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload must be an object');

  return Object.freeze({
    schemaVersion: DOMAIN_EVENT_SCHEMA_VERSION,
    eventId: assertStableEntityId(eventId, 'eventId'),
    type: String(type),
    source: normalizedSource,
    occurredAt: timestamp,
    aggregate: Object.freeze({ type: aggregateType, id: assertStableEntityId(aggregate.id, 'aggregate.id') }),
    ...(workspaceId == null ? {} : { workspaceId: assertStableWorkspaceId(workspaceId) }),
    ...(projectId == null ? {} : { projectId: assertStableEntityId(projectId, 'projectId') }),
    ...(correlationId == null ? {} : { correlationId: optionalStableId(correlationId, 'correlationId') }),
    ...(causationId == null ? {} : { causationId: optionalStableId(causationId, 'causationId') }),
    payload: Object.freeze({ ...payload }),
  });
};

const assertDomainEvent = event => {
  if (!event || typeof event !== 'object') throw new Error('domain event must be an object');
  if (event.schemaVersion !== DOMAIN_EVENT_SCHEMA_VERSION) throw new Error('unsupported domain event schema');
  return createDomainEvent(event);
};

module.exports = {
  DOMAIN_EVENT_SCHEMA_VERSION,
  DOMAIN_IDS,
  EVENT_TYPE_PATTERN,
  UUID_PATTERN,
  WORKSPACE_ID_PATTERN,
  assertDomainEvent,
  assertStableEntityId,
  assertStableWorkspaceId,
  createDomainEvent,
  createStableId,
  parseEventType,
};
