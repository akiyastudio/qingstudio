export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }
export type SettingsFormValue = string | number | boolean;
export interface SettingsFormOption { value: string; label: string; description?: string }
export type SettingsFormField =
  | { id: string; type: 'toggle'; label: string; description?: string; default: boolean }
  | { id: string; type: 'select'; label: string; description?: string; default: string; options: SettingsFormOption[] }
  | { id: string; type: 'text'; label: string; description?: string; default: string; placeholder?: string; maxLength?: number }
  | { id: string; type: 'number' | 'range'; label: string; description?: string; default: number; min: number; max: number; step?: number; suffix?: string };
export interface SettingsFormGroup { id: string; title: string; description?: string; fields: SettingsFormField[] }
export interface ComponentSettingsFormV1 { help?: Array<{ title: string; description: string }>; schemaVersion: 1; groups: SettingsFormGroup[]; preferenceScope?: 'videoPlayback'; notices?: Array<{ title: string; description: string; license: string; sourceUrl: string; licenseUrl: string }> }
export interface ApplicationSettingsFormContribution { type: 'application.settingsForm'; id: string; label: string; title?: string; form: ComponentSettingsFormV1; customPage?: { title?: string; entry: string; rpcMethods: VersionedName[] } }
export type VersionedName = `${string}.v${number}`;

export type ComponentPermission = 'component.panel' | 'project.preview.read' | 'project.preview.control' | 'project.media.read' | 'project.input.read' | 'project.output.write' | 'project.version.create' | 'project.progress' | 'project.files.read' | 'project.versions.read' | 'project.media.ratings.read' | 'project.media.ratings.write' | 'project.version.write' | 'project.version.delete' | 'project.progress.manage' | 'project.import' | 'project.files.write' | 'project.media.process' | 'component.runtime.execute' | 'component.secrets' | 'network.fetch' | 'component.storage' | 'component.settings' | 'component.media' | 'tasks' | 'dialogs' | 'events' | 'component.lifecycle.read' | 'component.lifecycle.manage' | 'notifications';
export type ComponentHostErrorCode = 'COMPONENT_HOST_INVALID_REQUEST' | 'COMPONENT_HOST_PERMISSION_DENIED' | 'COMPONENT_HOST_NOT_FOUND' | 'COMPONENT_HOST_TOKEN_EXPIRED' | 'COMPONENT_HOST_TOKEN_SCOPE' | 'COMPONENT_HOST_LIMIT_EXCEEDED' | 'COMPONENT_HOST_VARIANT_UNAVAILABLE' | 'COMPONENT_HOST_CONFLICT' | 'COMPONENT_HOST_CANCELLED' | 'COMPONENT_HOST_TIMEOUT' | 'COMPONENT_HOST_SERVICE_EXITED' | 'COMPONENT_HOST_INTERNAL';
export interface ComponentHostError extends Error { code: ComponentHostErrorCode | `COMPONENT_SERVICE_${string}`; retryable: boolean; details?: JsonValue }
export interface ComponentContext { /** Host display language; absent on older hosts. */ locale?: string; componentId: string; componentVersion: string; surface: 'project' | 'application.settings' | 'component.sidePanel' | 'media.contextAction' | 'project.contextAction' | 'project.importProvider' | 'project.exportProvider' | 'application.command'; contributionId?: string; contentKind?: 'project' | 'inspiration'; projectId: string; projectName: string; projectStatus: string; scopeRelativePath: string; selectedRelativePaths: string[]; sourcePageId: string; permissions: ComponentPermission[]; events: VersionedName[]; themeContractVersion: 1; uiContractVersion: 1; panelStyleContractVersion: 1; panelLayoutContractVersion: 1; resolvedTheme: 'light' | 'dark' }
export interface MediaPlaybackBackendV1Contribution { type: 'media.playbackBackend'; protocolVersion: 1; backendId: string; displayName: string; backendVersion: `${number}.${number}.${number}${string}`; transport: 'media-playback-backend-v1'; priority: number; probe: { containers: string[]; codecs: { video: string[]; audio: string[] }; extensions: `.${string}`[] }; features: { transforms:{aspectModes:Array<'source'|'contain'|'cover'|'16:9'|'4:3'|'1:1'>;rotation:boolean;flip:boolean;crop:boolean};hdr:{passthrough:boolean;toneMapping:boolean;algorithms:Array<'auto'|'bt2390'|'reinhard'|'mobius'|'hable'>;targetPeakControl:boolean};statistics:{basic:boolean;decode:boolean;hdr:boolean;timing:boolean;cache:boolean;gpu:boolean;maxUpdateHz:number};subtitles:{embedded:boolean;external:boolean;ass:boolean;styles:boolean};hardwareDecoding:{supported:boolean;selectable:boolean;softwareFallback:boolean};capture:{sourceFrame:boolean;displayedFrame:boolean} } }
export interface MediaPlaybackBackendV1Envelope<TPayload extends object = Record<string, unknown>> { protocol: 'media-playback-backend-v1'; protocolVersion: 1; sessionId: string; sequence: number; timestamp: number; event: `command.${string}` | `event.${string}`; payload: TPayload }
export interface MediaPlaybackDisplayOutputV1 { displayId: string; dpiScale: number; hdr: 'unknown' | 'sdr' | 'hdr10' | 'hlg'; colorSpace: 'unknown' | 'srgb' | 'display-p3' | 'rec2020' }
export type MediaKind = 'image' | 'raw' | 'video';
export interface MediaPageRequest { pageSize?: number; cursor?: string | null; kinds?: MediaKind[] }
export interface MediaPageItem { mediaRef: { relativePath: string }; relativePath: string; name: string; kind: MediaKind; extension: string; size: number; updatedAt: number; viaExternalLink?: true }
export interface MediaPageResponse { items: MediaPageItem[]; page: { hasMore: boolean; cursor: string | null; pageSize: number } }
export type MediaVariantName = 'thumbnail' | 'preview' | 'original';
export interface MediaVariantsRequest { photoId?: string; versionId?: string; relativePath?: string; variants?: MediaVariantName[] }
export interface DerivedMediaVariant { url: string; maxEdge: number; derived: true }
export interface OriginalMediaVariant { url: string; byteLength: number; derived: false; sourceRevision?: string }
export interface RestrictedInput { token: string; expiresAt: number }
export interface PreviewVideo { sessionId: string; relativePath: string; time: number; duration: number; paused: boolean; canSeek: boolean }
export interface PreviewSnapshot { revision: number; video: PreviewVideo | null }
export type ProjectPreviewRequest = { action: 'get' | 'subscribe' | 'unsubscribe' } | { action: 'seek'; sessionId: string; time: number };
export type ProjectPreviewResponse = PreviewSnapshot | { accepted: true };
export interface PreviewDecoderDeclaration { id: string; label: string; extensions: string[]; method: VersionedName; priority?: number }
export interface PreviewDecoderRequest { input: RestrictedInput; name: string; extension: string; pageIndex: number; maxEdge: number }
export interface PreviewDecoderResult { inputToken: string; mimeType: 'image/png'; pageIndex: number; pageCount: number }
export interface ProjectFileInputRequest { relativePath: string; expectedDigest?: string }
export interface ProjectFileInputResponse { input: RestrictedInput; relativePath: string; name: string; byteLength: number; sha256: string; fileId: string }
export interface LinkedFile { relativePath: string; fileId: string; revision: string; versionId: string | null; missing?: boolean }
export interface LinkedFileEvent extends LinkedFile { subscriptionId: string; sequence: number; type: 'modified' | 'renamed' | 'deleted' | 'versionChanged'; previousRelativePath: string }
export type ProjectFilesWatchRequest = { action: 'subscribe'; relativePaths: string[]; includeVersions?: boolean } | { action: 'poll'; subscriptionId: string; cursor: number } | { action: 'unsubscribe'; subscriptionId: string };
export type ProjectFilesWatchResponse = { subscriptionId: string; cursor: number; expiresAt: number; files: LinkedFile[]; events?: LinkedFileEvent[]; rescanRequired?: boolean } | { unsubscribed: true };
export type ComponentTransferRequest = { action: 'create'; name: string; byteLength: number } | { action: 'openInput'; token: string } | { action: 'write'; transferId: string; offset: number; base64: string } | { action: 'read'; transferId: string; offset: number; byteLength: number } | { action: 'finish'; transferId: string; expectedDigest: string } | { action: 'close'; transferId: string };
export type ComponentTransferResponse = { transferId: string; byteLength: number; chunkBytes: number; expiresAt: number } | { nextOffset: number } | { offset: number; nextOffset: number; base64: string; eof: boolean } | { input: RestrictedInput; byteLength: number; sha256: string } | { closed: true };
export interface MediaVariantsResponse { mediaRef: { photoId?: string; versionId?: string; relativePath?: string }; metadata: { photoId: string; versionId: string; currentVersionId: string; displayName: string; originalName: string; relativePath: string; isCurrent: boolean; fileMissing: boolean }; variants: { thumbnail?: DerivedMediaVariant; preview?: DerivedMediaVariant; original?: OriginalMediaVariant }; input?: RestrictedInput }
export interface InputMaterializeRequest { action: 'materialize'; token: string }
export interface InputMaterializeResponse { inputId: string; privatePath: string; byteLength: number; expiresAt: number }
export type ComponentStorageRequest = Record<string, never>;
export interface ComponentStorageAdoptionPending {
  schemaVersion: 1; kind: 'component-storage-adoption'; state: 'pending'; componentId: string;
  startedAt: number;
}
export interface ComponentStorageAdoptionCommitted {
  schemaVersion: 1; kind: 'component-storage-adoption'; state: 'committed'; componentId: string;
  adoptedDataRoot: boolean; adoptedDatabase: boolean;
  legacyDataRoot: string; legacyDatabasePath: string; databaseSha256: string;
  copiedFileCount: number; copiedByteCount: number;
}
export type ComponentStorageResponse =
  | { projectId: string; ownership: 'component-private'; adoption: ComponentStorageAdoptionPending }
  | { dataPath: string; databasePath: string; projectId: string; ownership: 'component-private'; adoption?: ComponentStorageAdoptionCommitted };
export type ComponentSettingsRequest = { action: 'get' } | { action: 'replace' | 'merge'; settings: JsonObject };
export interface ComponentSettingsResponse { revision: number; settings: JsonObject }
/** One-time adoption source allowed only with the versioned project.output.existing.v1 grant. */
export type ExistingOutputSource = ({ relativePath: string; sourcePath?: never } | { sourcePath: string; relativePath?: never }) & { artifactId?: string };
export type ProjectOutputRequest = { action: 'stage' } | { action: 'write'; stageId: string; name: string; outputRelativePath: string; sourceName?: string; inputToken?: string; base64?: string; replace?: boolean; previousCommitId?: string; previousArtifactId?: string; expectedDigest?: string } | { action: 'validate' | 'rollback'; stageId: string } | { action: 'commit'; stageId: string; idempotencyKey: string; onConflict?: 'error' | 'rename' } | { action: 'adopt'; migrationId: string; outputs: ExistingOutputSource[] } | { action: 'delete'; previousCommitId: string; previousArtifactId: string; expectedDigest: string; idempotencyKey: string } | { action: 'materializeOwned'; commitId: string; artifactId: string };
export interface CommittedOutput { artifactId: string; relativePath: string; requestedRelativePath?: string; filePath?: string; byteLength: number; sha256: string }
export type ProjectOutputResponse = { stageId: string; privatePath: string; expiresAt: number } | { stageId: string; artifactId: string; byteLength: number } | { stageId: string; valid: true; fileCount: number; totalBytes: number } | { stageId: string; rolledBack: true } | { commitId: string; idempotencyKey: string; outputs: CommittedOutput[] } | { deletionId: string; deleted: true; relativePath: string } | { importId: string; privatePath: string; byteLength: number; sha256: string; outputRef: { commitId: string; artifactId: string } };
export interface VersionCreateRequest { commitId: string; artifactId: string; photoId: string; parentVersionId: string; idempotencyKey: string; name?: string; type?: string; note?: string; isFinal?: boolean; status?: string }
export interface VersionCreateResponse { versionId: string; result: JsonObject }
export type TaskAction = 'start' | 'report' | 'status' | 'cancel' | 'resume' | 'complete' | 'fail';
export interface TasksRequest { action: TaskAction; operationId: string; title?: string; message?: string; progress?: number; phase?: string; checkpoint?: JsonObject; error?: string }
export interface ComponentTaskSnapshot { id: string; state: string; checkpoint?: JsonObject; progress?: number; message?: string; error?: string }
export interface TasksResponse { task: ComponentTaskSnapshot | null; cancelled: boolean; checkpoint?: JsonObject }
export type DialogsRequest = { kind: 'confirm'; title?: string; message?: string } | { kind: 'openFiles'; title?: string; extensions?: string[]; multiple?: boolean } | { kind: 'openDirectory'; title?: string; extensions?: string[]; recursive?: boolean; directoryToken?: boolean } | { kind: 'openComponentDirectory'; relativePath: string } | { kind: 'openOutput' | 'revealOutput' | 'openOutputDirectory'; commitId: string; artifactId: string };
export type ComponentAuthorizedInput = { name: string; relativeName: string; kind?: 'file' | 'directory'; token: string; expiresAt: number };
export type DialogsResponse = { confirmed: boolean } | { cancelled: boolean; inputs: ComponentAuthorizedInput[]; truncated?: boolean } | { opened: true; componentDirectory: { relativePath: string } } | { opened: true; outputRef: { commitId: string; artifactId: string } };
export interface ComponentEventRequest<T extends JsonObject = JsonObject> { topic: VersionedName; event: T }
export interface ComponentEventResponse { emitted: true }
export type ComponentLifecycleRequest = { action: 'describe' } | { action: 'preflight' | 'verify-package' | 'install' | 'repair' | 'uninstall' };
export type ComponentLifecycleResponse = { componentId: string; componentVersion: string; permissions: ComponentPermission[]; events: VersionedName[]; lifecycleActions: string[]; state: 'active' | 'termination-unconfirmed' } | { success: true; action: 'preflight' | 'verify-package' | 'install' | 'repair' | 'uninstall'; taskId: string; message: string };
export type NotificationTone = 'info' | 'success' | 'warning' | 'error';
export interface NotificationRequest { tone: NotificationTone; message: string; dedupeKey?: string }
export type NotificationResult = { accepted: true; id: string } | { accepted: false; deduplicated: true; code: 'NOTIFICATION_DEDUPLICATED' } | { accepted: false; error: { code: string; message: string; retryable: boolean } };
export interface ComponentMediaRequest { action: 'variants' | 'open' | 'reveal'; relativePath: string; variants?: MediaVariantName[] }
export type ComponentMediaResponse = { opaqueRef: string; variants: MediaVariantsResponse['variants'] } | { opaqueRef: string; action: 'open' | 'reveal'; opened: true };
export interface VersionSourceMetadata { category?: string; role?: string; displayName?: string; componentId?: string; parentCapability?: 'structural' | 'workflow-input' | 'none' }
export type ProjectProgressRequest = { action: 'list'; includeMissing?: boolean } | { action: 'create'; relativePath: string; mediaKind: 'image' | 'video'; versionKey: string; parentProgressId: string; displayName?: string; trackingEnabled?: boolean; sourceMetadata?: VersionSourceMetadata; sourceProgressIds?: string[] } | { action: 'relate'; childProgressId: string; parentProgressId: string; expectedUpdatedAt?: number };
export type ProjectProgressResponse = { progress: JsonObject[]; edges: JsonObject[] } | { progress: JsonObject; edges: JsonObject[] } | { result: JsonObject };
export interface BoundedPage { cursor: string | null; hasMore: boolean; pageSize: number; truncated: boolean }
export interface ProjectFileItem { relativePath: string; name: string; kind: 'directory' | 'file' | 'sidecar'; extension?: string; size?: number; updatedAt?: number }
export interface ProjectFilesPageRequest { pageSize?: number; cursor?: string | null }
export interface ProjectFilesSearchRequest extends ProjectFilesPageRequest { query: string }
export interface ProjectFilesPageResponse { items: ProjectFileItem[]; page: BoundedPage }
export interface ProjectMediaMetadataRequest { relativePath: string }
export interface ProjectMediaMetadataResponse { mediaRef: { relativePath: string }; kind: MediaKind; size: number; updatedAt: number; dimensions: { width: number | null; height: number | null }; colorSpace: JsonValue; camera: { make: JsonValue; model: JsonValue; lens: JsonValue }; capture: { aperture: number | null; exposureTime: JsonValue; iso: number | null; focalLength: number | null; takenAt: JsonValue }; video: { codec: JsonValue; audioCodec: JsonValue; durationSeconds: number | null; frameRate: number | null; rotation: number | null } | null }
export interface ProjectVersion { id: string; photoId: string; parentVersionId: string | null; versionNumber: number; name: string; type: string; status: string; note: string; isCurrent: boolean; isFinal: boolean; fileMissing: boolean; contentChanged: boolean; createdAt: number; updatedAt: number }
export interface ProjectVersionsPageResponse { items: ProjectVersion[]; page: BoundedPage }
export interface ProjectVersionGraphResponse { progress: JsonObject[]; versions: ProjectVersion[]; edges: Array<{ sourceId: string; targetId: string; kind: string }>; truncated: boolean }
export interface ProjectMediaRatingsRequest { mediaRefs: Array<{ relativePath: string }> }
export interface ProjectMediaRating { mediaRef: { relativePath: string }; revision: number; rating: number | null; labels: null; selectionState: null }
export interface ProjectMediaRatingsResponse { supported: { rating: true; labels: false; selectionState: false }; items: ProjectMediaRating[] }
export interface ProjectMediaRatingWriteItem { relativePath: string; rating: 0 | 1 | 2 | 3 | 4 | 5; expectedRevision: number }
export interface ProjectMediaRatingsWriteRequest { items: ProjectMediaRatingWriteItem[]; idempotencyKey: string }
export interface ProjectMediaRatingsWriteResponse { semantics: 'per-item'; succeeded: number; failed: number; items: Array<{ mediaRef: { relativePath: string }; ok: boolean; rating?: number; previousRevision?: number; revision?: number; error?: { code: ComponentHostErrorCode; message: string } }> }
export interface ProjectVersionUpdateRequest { versionId: string; expectedUpdatedAt: number; idempotencyKey: string; versionName?: string; note?: string; status?: string; isFinal?: boolean; makeCurrent?: true }
export interface ProjectVersionDeleteRequest { versionId: string; expectedUpdatedAt: number; idempotencyKey: string }
export type ProjectVersionMutationResponse = { receiptId: string; version?: ProjectVersion; versionId?: string; deleted?: true };
export type ProjectProgressManageRequest = { action: 'update' | 'unregister' | 'edgeCreate' | 'edgeDelete' | 'edgeReplaceSource'; idempotencyKey: string; expectedUpdatedAt: number; progressId?: string; displayName?: string; trackingEnabled?: boolean; sourceProgressId?: string; targetProgressId?: string; newSourceProgressId?: string; edgeKind?: string };
export type ProjectProgressManageResponse = { action: 'update'; receiptId: string; progress: JsonObject } | { action: 'unregister'; receiptId: string; progressId: string } | { action: 'edgeCreate' | 'edgeReplaceSource'; receiptId: string; edge: JsonObject } | { action: 'edgeDelete'; receiptId: string };
export type ProjectImportRequest = { action: 'commit'; idempotencyKey: string; items: Array<{ inputToken: string; targetRelativePath: string }> } | { action: 'cancel'; idempotencyKey: string };
export interface ProjectImportResponse { operationId: string; receiptId?: string; committed?: true; cancelled?: boolean; outputs?: Array<{ relativePath: string; size: number; sha256: string }> }
export type ProjectFilesMutateRequest = { phase: 'preflight'; action: 'rename' | 'move' | 'mkdir' | 'trash'; relativePaths?: string[]; targetRelativePath?: string; newName?: string } | { phase: 'commit'; planToken: string; idempotencyKey: string } | { phase: 'undo'; receiptId: string; idempotencyKey: string };
export type ProjectFilesMutateResponse = { planToken: string; expiresAt: number; action: string; undoCapability: 'available' | 'requires-precise-recycle'; items: JsonObject[] } | { receiptId: string; committed: true; action: string; undoAvailable: boolean; undo: JsonObject[] } | { receiptId: string; undoneReceiptId: string; undone: true };
export type ProjectMediaProcessRequest = { action: 'video.timelineFrames'; relativePath: string; times: number[] } | { action: 'office.extractImages'; idempotencyKey: string; relativePath: string; outputDirectory: string };
export type ProjectMediaProcessResponse = { action: 'video.timelineFrames'; frames: string[] } | { action: 'office.extractImages'; receiptId: string; operationId: string; outputs: Array<{ relativePath: string; size: number; sha256: string }> };
/** projectArtifacts requires project.progress capability and permission. It registers the worker's
 * folderOutputs [{sourceFolder, outputFolder}] before task completion, using authorized project
 * folder inputs and existing source nodes. External inputs and unregistered sources are skipped. */
/** timeoutMs: 0 disables the deadline only for cancellable background executions. */
export type ComponentRuntimeExecuteRequest = {action:'inputs.retain';inputTokens:string[];input:{extensions:string[]}} | {action:'inputs.revoke';inputGrants:string[]} | { action:'execute'; runtimeCapability:string; arguments:string[]; relativePaths?:string[]; inputTokens?:string[]; inputGrants?:string[]; output?:{relativeDirectory:string;argument:string}|{private:true;argument:string}; input?:{extensions?:string[];prefixArgumentCount?:number;directoryArgument?:string}; operationKey?:string; idempotencyKey?:string; eventName?:string; timeoutMs?:number; task?:{background?:boolean;title?:string;runningMessage?:string;completeMessage?:string;concurrencyGroup?:string;concurrencyLimit?:number;concurrencyWriteLimit?:number}; control?:{cancelArgument?:string;pauseArgument?:string}; projectArtifacts?:{mode:'preview'|'transcode';mediaKind:'image'|'video'} } | { action:'playback'; relativePaths?:string[]; inputGrants?:string[]; playback:ComponentPlaybackRequest } | { action:'inputs.preview'; relativePaths?:string[]; inputTokens?:string[]; input:{extensions:string[];prefixArgumentCount?:number} } | { action:'status'|'cancel'|'pause'|'resume'; runtimeCapability:string; operationKey:string; idempotencyKey:string };
export type ComponentRuntimeExecuteResponse = {success?:boolean;mediaUrl?:string;sessionId?:string;playerId?:string;requestId?:string;backends?:JsonObject[];frames?:string[]} | {grants:Array<{id:string;name:string;kind:'file'|'directory'}>} | {revoked:true} | { sourcePreviews: JsonObject[] } | { operationId: string; result: JsonObject; task?: JsonObject | null } | { operationId: string; task: JsonObject | null } | { operationId: string; cancelled: boolean; task: JsonObject | null };
export type ComponentSecretsRequest = { action: 'put'; name: string; value: string; metadata?: JsonObject; idempotencyKey: string } | { action: 'list' } | { action: 'delete'; secretRef: string; idempotencyKey: string };
export type ComponentSecretRecord = { secretRef: string; name: string; metadata: JsonObject; createdAt: number; updatedAt: number };
export type ComponentSecretsResponse = ComponentSecretRecord | { items: ComponentSecretRecord[] } | { secretRef: string; deleted: true };
export type NetworkFetchRequest = { url: string; origin: `https://${string}`; method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; headers?: Record<string, string>; body?: string | JsonValue; bodyMode?: 'text' | 'json' | 'base64'; responseMode?: 'text' | 'json' | 'base64'; timeoutMs?: number; secrets?: Record<string, string> };
export type NetworkFetchResponse = { status: number; headers: Record<string, string>; body: { text: string } | { json: JsonValue } | { base64: string }; truncated: false };
export interface HostCapabilityMap {
  'component.panel': { request: { action: 'get' } | ({ action: 'update' } & Partial<ComponentPanelInfo>); response: ComponentPanelInfo };
  'project.preview': { request: ProjectPreviewRequest; response: ProjectPreviewResponse };
  'project.media.page': { request: MediaPageRequest; response: MediaPageResponse };
  'project.media.variants': { request: MediaVariantsRequest; response: MediaVariantsResponse };
  'project.input.tokens': { request: InputMaterializeRequest; response: InputMaterializeResponse };
  'project.files.inputToken': { request: ProjectFileInputRequest; response: ProjectFileInputResponse };
  'project.files.watch': { request: ProjectFilesWatchRequest; response: ProjectFilesWatchResponse };
  'component.transfer': { request: ComponentTransferRequest; response: ComponentTransferResponse };
  'component.storage': { request: ComponentStorageRequest; response: ComponentStorageResponse };
  'component.settings': { request: ComponentSettingsRequest; response: ComponentSettingsResponse };
  'project.output': { request: ProjectOutputRequest; response: ProjectOutputResponse };
  'version.create': { request: VersionCreateRequest; response: VersionCreateResponse };
  'tasks': { request: TasksRequest; response: TasksResponse };
  'dialogs': { request: DialogsRequest; response: DialogsResponse };
  'component.events': { request: ComponentEventRequest; response: ComponentEventResponse };
  'component.lifecycle': { request: ComponentLifecycleRequest; response: ComponentLifecycleResponse };
  'component.media': { request: ComponentMediaRequest; response: ComponentMediaResponse };
  'project.progress': { request: ProjectProgressRequest; response: ProjectProgressResponse };
  'notifications': { request: NotificationRequest; response: NotificationResult };
  'project.files.page': { request: ProjectFilesPageRequest; response: ProjectFilesPageResponse };
  'project.files.search': { request: ProjectFilesSearchRequest; response: ProjectFilesPageResponse };
  'project.media.metadata': { request: ProjectMediaMetadataRequest; response: ProjectMediaMetadataResponse };
  'project.versions.page': { request: ProjectFilesPageRequest; response: ProjectVersionsPageResponse };
  'project.version.graph': { request: { includeMissing?: boolean }; response: ProjectVersionGraphResponse };
  'project.media.ratings': { request: ProjectMediaRatingsRequest; response: ProjectMediaRatingsResponse };
  'project.media.ratings.write': { request: ProjectMediaRatingsWriteRequest; response: ProjectMediaRatingsWriteResponse };
  'project.version.update': { request: ProjectVersionUpdateRequest; response: ProjectVersionMutationResponse };
  'project.version.delete': { request: ProjectVersionDeleteRequest; response: ProjectVersionMutationResponse };
  'project.progress.manage': { request: ProjectProgressManageRequest; response: ProjectProgressManageResponse };
  'project.import': { request: ProjectImportRequest; response: ProjectImportResponse };
  'project.files.mutate': { request: ProjectFilesMutateRequest; response: ProjectFilesMutateResponse };
  'project.media.process': { request: ProjectMediaProcessRequest; response: ProjectMediaProcessResponse };
  'component.runtime.execute': { request: ComponentRuntimeExecuteRequest; response: ComponentRuntimeExecuteResponse };
  'component.secrets': { request: ComponentSecretsRequest; response: ComponentSecretsResponse };
  'network.fetch': { request: NetworkFetchRequest; response: NetworkFetchResponse };
}
export type HostCapability = keyof HostCapabilityMap;
export interface ComponentPanelInfo { title: string; subtitle: string }
export type HostCapabilityRequest<K extends HostCapability> = HostCapabilityMap[K]['request'];
export type HostCapabilityResponse<K extends HostCapability> = HostCapabilityMap[K]['response'];
export interface ServiceHostCaller { callHost<K extends HostCapability>(parentId: string, method: K, payload: HostCapabilityRequest<K>): Promise<HostCapabilityResponse<K>> }
export interface ReadyFrame { type: 'ready'; protocolVersion: 1 }
export interface ServiceRequestFrame<M extends VersionedName = VersionedName, P extends JsonObject = JsonObject> { type: 'request'; id: string; method: M; payload: P; context: Omit<ComponentContext, 'scopeRelativePath' | 'selectedRelativePaths' | 'sourcePageId' | 'events' | 'resolvedTheme'> }
export interface ServiceSuccessFrame<R extends JsonValue = JsonValue> { type: 'response'; id: string; ok: true; result: R }
export interface ServiceFailureFrame { type: 'response'; id: string; ok: false; error: string; errorCode: ComponentHostErrorCode | `COMPONENT_SERVICE_${string}`; retryable?: boolean }
export type CapabilityRequestFrame<K extends HostCapability = HostCapability> = K extends HostCapability ? { type: 'capability'; id: string; parentId: string; method: K; payload: HostCapabilityRequest<K> } : never;
export type CapabilityResponseFrame<K extends HostCapability = HostCapability> = { type: 'capability-response'; id: string; ok: true; result: HostCapabilityResponse<K> } | { type: 'capability-response'; id: string; ok: false; error: string; errorCode: ComponentHostErrorCode; retryable?: boolean };
export type ComponentServiceInboundFrame = ServiceRequestFrame | CapabilityResponseFrame;
export type ComponentServiceOutboundFrame = ReadyFrame | ServiceSuccessFrame | ServiceFailureFrame | CapabilityRequestFrame;
export type ComponentPlaybackRequest = { action:'source'|'backends'|'start'|'frames'|'control'|'bounds'|'stop'; outputPath?:string; privateOutputPath?:string; browserProbe?:'probably'|'maybe'|'unknown'; playerId?:string; requestId?:string; backendId?:string; sessionId?:string; settings?:JsonObject; control?:JsonObject; bounds?:{x:number;y:number;width:number;height:number;visible:boolean}; times?:number[] };
export interface ComponentSdk { readonly contractVersion: 1; setPlaybackPaused(sessionId:string,paused:boolean):Promise<void>; onPlaybackState(callback:(state:JsonObject)=>void):()=>void; setPlaybackBounds(sessionId:string,bounds:{x:number;y:number;width:number;height:number;visible:boolean;overlayHole?:{x:number;y:number;width:number;height:number;radius?:number};controlsOverlayHole?:{x:number;y:number;width:number;height:number};cornerOverlayHole?:{x:number;y:number;width:number;height:number}}):void; getContext(): Promise<ComponentContext>; setPanelInfo(info: Partial<ComponentPanelInfo>): Promise<ComponentPanelInfo>; getPreview(): Promise<PreviewSnapshot>; seekPreview(sessionId: string, time: number): Promise<{ accepted: true }>; onPreviewChange(callback: (value: PreviewSnapshot) => void): Promise<() => void>; authorizeFiles(files: FileList | readonly File[]): Promise<{ inputs: ComponentAuthorizedInput[] }>; readonly notify?: (payload: NotificationRequest) => Promise<NotificationResult>; dialog(payload: DialogsRequest): Promise<DialogsResponse>; rpc<T = unknown>(method: VersionedName, payload?: Record<string, unknown>): Promise<T>; onEvent<T = JsonObject>(topic: VersionedName, callback: (payload: T) => void): () => void; onActivate(callback: () => void): () => void; onDeactivate(callback: () => void): () => void; onLocaleChange?(callback: (value: { contractVersion: 1; locale: string }) => void): () => void; onThemeChange(callback: (value: { contractVersion: 1; resolvedTheme: 'light' | 'dark' }) => void): () => void; onContextChange(callback: (context: ComponentContext) => void): () => void }
declare global { interface Window { photoFlowComponent: ComponentSdk } }
export const host: ComponentSdk;
export const uiContractVersion: 1;
export function applyUiTheme(resolvedTheme: 'light' | 'dark', root?: HTMLElement): 'light' | 'dark';
export function mountUiTheme(root?: HTMLElement): Promise<() => void>;
export function assertHostApi(context: ComponentContext): asserts context is ComponentContext;

/** Follow the host language without reloading or remounting the component. */
export function mountUiLanguage(onChange?: (locale: string) => void, root?: HTMLElement): Promise<() => void>;
