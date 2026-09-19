export const DOMAIN_IDS = [
  'shell',
  'workspace',
  'file-operations',
  'import',
  'media',
  'versioning',
  'backup-archive',
  'components',
  'inspiration-tools',
  'telemetry',
] as const;

export type DomainId = typeof DOMAIN_IDS[number] | `component:${string}`;
export type StableEntityId = string;
export type StableWorkspaceId = string;
export type DomainEventType = `${DomainId}.${string}.${string}.v${number}`;

export interface DomainEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  schemaVersion: 1;
  eventId: StableEntityId;
  type: DomainEventType;
  source: DomainId;
  occurredAt: string;
  aggregate: {
    type: string;
    id: StableEntityId;
  };
  workspaceId?: StableWorkspaceId;
  projectId?: StableEntityId;
  correlationId?: StableEntityId;
  causationId?: StableEntityId;
  payload: TPayload;
}

export interface ProjectContentMutatedPayload extends Record<string, unknown> {
  commandId: StableEntityId;
  operation: 'copy' | 'move' | 'rename' | 'trash' | 'restore' | 'create-directory' | 'create-file' | 'commit-import' | 'commit-version';
  affectedFileIds: StableEntityId[];
  affectedPaths: string[];
}

export interface ProjectContentCommand<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  schemaVersion: 1;
  commandId: StableEntityId;
  type: `file-operations.project-content.${ProjectContentMutatedPayload['operation']}.v1`;
  requester: DomainId;
  target: 'file-operations';
  workspaceId: StableWorkspaceId;
  projectId: StableEntityId;
  payload: TPayload;
}

export type ProjectContentMutatedEvent = DomainEvent<ProjectContentMutatedPayload> & {
  type: 'file-operations.project-content.mutated.v1';
  source: 'file-operations';
};
