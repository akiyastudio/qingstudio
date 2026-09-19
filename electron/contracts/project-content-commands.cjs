const { PROJECT_CONTENT_COMMANDS, assertKnownDomain } = require('./domain-ownership.cjs');
const { assertStableEntityId, assertStableWorkspaceId } = require('./domain-events.cjs');

const PROJECT_CONTENT_COMMAND_SCHEMA_VERSION = 1;

const createProjectContentCommand = ({
  commandId,
  requester,
  operation,
  workspaceId,
  projectId,
  payload = {},
}) => {
  const normalizedRequester = assertKnownDomain(requester);
  const normalizedOperation = String(operation || '');
  if (!PROJECT_CONTENT_COMMANDS.includes(normalizedOperation)) {
    throw new Error(`Unsupported project content operation: ${normalizedOperation}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload must be an object');
  return Object.freeze({
    schemaVersion: PROJECT_CONTENT_COMMAND_SCHEMA_VERSION,
    commandId: assertStableEntityId(commandId, 'commandId'),
    type: `file-operations.project-content.${normalizedOperation}.v1`,
    requester: normalizedRequester,
    target: 'file-operations',
    workspaceId: assertStableWorkspaceId(workspaceId),
    projectId: assertStableEntityId(projectId, 'projectId'),
    payload: Object.freeze({ ...payload }),
  });
};

const assertProjectContentCommand = command => {
  if (!command || typeof command !== 'object') throw new Error('project content command must be an object');
  if (command.schemaVersion !== PROJECT_CONTENT_COMMAND_SCHEMA_VERSION) throw new Error('unsupported project content command schema');
  const operation = /^file-operations\.project-content\.([a-z-]+)\.v1$/.exec(String(command.type || ''))?.[1];
  return createProjectContentCommand({ ...command, operation });
};

module.exports = {
  PROJECT_CONTENT_COMMAND_SCHEMA_VERSION,
  assertProjectContentCommand,
  createProjectContentCommand,
};
