# PhotoFlow Host API specification

English | [简体中文](PLUGIN_HOST_API.zh-CN.md)

This is the normative guide for new components. Runtime manifest validation is in `electron/component-host-contract.cjs`, machine-readable constraints are in `electron/contracts/schemas/`, and public types are in `component-sdk/index.d.ts`.

## Versioning and deprecation

PhotoFlow exposes one current Host API without version negotiation. Declare `componentHost.contractVersion:2` and explicitly list permissions, capabilities, RPC, and events. Host API version fields such as `componentHost.compatibility` are rejected as unknown.

The UI sandbox disables Node, navigation, and browser permissions for UI WebContents only. Services, lifecycle actions, and executables are trusted native code installed by the user, with that user's OS file, network, and process access. Host permissions are an interoperability and least-privilege contract, not an OS boundary against malicious processes. Supervision controls startup, protocol, timeout, and shutdown. This model does not promise safe execution of untrusted marketplace plugins.

Component RPC/events end in `.vN`; Host capabilities are unversioned. Breaking changes require new RPC/event versions, not changes to published semantics. Business adapters under `electron/compatibility/` are not public and receive no new methods. `window.photoFlowComponent.contractVersion` remains `1`, an independent preload ABI, not a negotiated Host API version. Context has no Host API version field. Its `locale` is the display language; see the [SDK](../component-sdk/README.md#display-language).

## Manifests and permissions

UI/service manifests declare Host contract version 2, contributions, service protocol/runtime/entry, versioned RPC allowlists, unversioned capabilities, and permissions. Explicitly use an empty events array if none are emitted. Do not declare Host API compatibility.

| Capability | Permission | Purpose |
| --- | --- | --- |
| `project.media.page` | `project.media.read` | Bounded recursive media paging |
| `project.media.variants` | `project.media.read` | Thumbnail, preview, original resolution |
| `project.input.tokens` | `project.input.read` | Materialize authorized input privately |
| `project.files.inputToken` | `project.files.read` + `project.input.read` | Any ordinary project file |
| `project.preview` | `project.preview.read`; seek also needs `project.preview.control` | Video state and session-bound seeking |
| `component.panel` | `component.panel` | Current folder-panel title/subtitle |
| `project.files.watch` | `project.files.read`; version tracking also needs `project.versions.read` | Resource state subscriptions |
| `component.transfer` | `project.input.read` | Bounded binary transfer chunks |
| `project.output` | `project.output.write` | Stage, write/register, validate, commit, rollback |
| `version.create` | `project.version.create` | Versions from committed artifacts |
| `component.storage` | `component.storage` | Private data and SQLite locations |
| `component.settings` | `component.settings` | Version-independent JSON settings |
| `tasks` | `tasks` | Progress, checkpoints, cancellation, resume |
| `dialogs` | `dialogs` | Confirmation and bounded selection |
| `component.events` | `events` | Declared versioned events |
| `component.lifecycle` | `component.lifecycle.read` | Grants, actions, lifecycle state |
| `component.media` | `component.media` | Private media variants/open/reveal |
| `component.runtime.execute` | `component.runtime.execute` | Declared runtime operations and playback |
| `project.progress` | `project.progress` | Progress nodes and source relations |
| `notifications` | `notifications` | Short plain-text top Toasts |
| `project.files.page` / `project.files.search` | `project.files.read` | Non-media files, directories, sidecars |
| `project.media.metadata` | `project.media.read` | Allowlisted EXIF, dimensions, color, camera/lens, video |
| `project.versions.page` / `project.version.graph` | `project.versions.read` | Bounded versions and provenance |
| `project.media.ratings` | `project.media.ratings.read` | Actual supported rating fields |
| `project.media.ratings.write` | `project.media.ratings.write` | Per-item rating CAS writes |
| `project.version.update` | `project.version.write` | Atomic version CAS updates |
| `project.version.delete` | `project.version.delete` | CAS deletion with separate permission |
| `project.progress.manage` | `project.progress.manage` | Node update/unregister and edge changes |
| `project.import` | `project.import` | Transactional token-based import |
| `project.files.mutate` | `project.files.write` | Preflight/commit and receipt undo |
| `project.media.process` | `project.media.process` | Timeline frames and Office image extraction |
| `component.secrets` | `component.secrets` | Isolated safeStorage secret references |
| `network.fetch` | `network.fetch` | HTTPS origin allowlists, DNS pinning, secret bindings |

Lifecycle execution additionally requires `component.lifecycle.manage`; describe still checks read permission. Permissions are checked at parsing and every call. Component ID/version, project ID/name/status, and scope are host-bound and cannot be overridden by payload.

`application.settingsPage` validates ID, label, optional title, packaged entry, and RPC methods. Its surface is `application.settings`, without project identity. Methods must be in both the contribution and service allowlists. Allowed capabilities are `component.settings`, `component.lifecycle`, `dialogs`, `notifications`, and `component.secrets`, subject to permissions and action checks. Project capabilities and `network.fetch` are denied here. Application-command context additionally permits authorized `network.fetch`.

### Top notifications

Declare both `notifications` capability and permission. Renderers call `window.photoFlowComponent.notify` with `{tone,message,dedupeKey?}`; services use the equivalent capability only within an existing request. Do not route UI notifications through a service or treat this as arbitrary channel access. Removed `durationMs` is rejected; the host owns lifetime.

Tones are info/success/warning/error. Nonempty plain text is limited to 360 characters before and after trim; optional dedupe keys are ASCII IDs up to 80 characters. Errors persist until dismissed; other tones expire after 3500 ms. Preload enforces the same boundary before copying to main. Unknown fields, HTML, URLs, paths, callbacks, and commands are rejected. Senders bind to admitted component WebContents; permissions are checked per call. Ordinary/error bursts are separately bounded over ten seconds, with 1.2-second content/key deduplication. Destruction/uninstall/upgrade clears state. Main-window unavailability or send races return retryable `NOTIFICATION_HOST_UNAVAILABLE`, not native Electron notifications.

Success is `{accepted:true,id}`; duplicates return `{accepted:false,deduplicated:true,code:"NOTIFICATION_DEDUPLICATED"}`; failures return `{accepted:false,error:{code,message,retryable}}`, with no version. Main uses a bounded buffer before subscriber readiness and re-handshakes/flushes after reload. Uninstall/upgrade purges component scope. Main preload revalidates events before bounded `useTopToastStack`. All tones share host icons, colors, lifetime, stacking, dismissal, and one live region. A transparent native overlay stays above component Views without changing their bounds; empty regions pass pointer input through, while cards/buttons remain interactive. Long work uses tasks; decisions use dialogs.

## Capability contracts

See [preview API](PLUGIN_PREVIEW_API.md) for folder panels, subtitles, and `service.previewDecoders`, including UI-free decoders. See [file resources](PLUGIN_FILE_RESOURCES_API.md) for arbitrary inputs, subscriptions, transfers, and RPC limits. UI reaches service capabilities through declared RPC, except explicitly supported SDK bridges.

### Project media

Files page returns directories, non-media ordinary files, and recognized sidecars. Search also needs a 1–160-character query. Page sizes are 1–200; snapshots examine at most 5,000 entries and search retains at most 500 results. Five-minute cursors bind component/project/scope. Results contain only virtual relative paths. Links, `.photoflow-*` internals, absolute paths, and escapes are rejected.

Media metadata accepts in-scope relative paths. ExifTool uses a fixed allowlist for dimensions, color space/profile, camera/lens/exposure, video/audio codecs, duration, frame rate, and rotation. Missing values are null; SourceFile, directories, and absolute paths are never echoed.

Versions page uses one bounded read-only SQL snapshot for current/parent versions, status, notes, final/current flags, and timestamps: at most 200 per page and 5,000 per snapshot, with `truncated`. It never invokes index-syncing/backfilling `media_get`. Version graph uses read-only `progress_snapshot` for parent-version and persisted progress-source edges, without migration, baseline registration, repair, position sync, or folder paths. Ordinary nodes need a verifiable physical directory canonically inside scope. `includeMissing:true` additionally permits nodes whose lexical path is in scope, nearest existing ancestor is canonically safe, and actual `folderMissing` is set. Unreliable paths, external links, and out-of-scope nodes remain excluded; edges require both endpoints visible. At most 5,000 progress records are scanned and 1,000 visible nodes exposed; either bound sets truncation.

Ratings accepts 1–100 references and returns ratings/file revisions. There is no unified label/selection-state store: `supported.labels` and `supported.selectionState` are false and fields are null, never fabricated.

External file/folder links inside projects have been removed without legacy migration. Old link records, shortcuts, and target paths cannot widen scope. [External project import](PROJECT_IMPORT.md) registers a folder through copy, move, or reference-in-place. A referenced folder becomes the physical root; contents use normal relative paths, without `External/...` or `viaExternalLink`. Roots may be outside the workspace, but access stays inside that project. Importing `D:/Shoot` permits its `RAW/photo.jpg`; another project cannot access it through an old External record. Photo/version ID lookup also checks ownership and physical location.

Media page accepts pageSize 1–200, opaque cursor, and image/raw/video kinds. Cursors expire in five minutes, bind one component/project, and must not be decoded or persisted. Each page examines at most 1,000 entries under the physical root, without following links or old external registries. Imported projects follow the same rule.

Variants accepts `{photoId,versionId}` or `{relativePath}` and a subset of thumbnail/preview/original. Thumbnails are 320-pixel derivatives, never substituted with normal original URLs; previews are 1,600-pixel derivatives; originals have `derived:false`. An empty variants list returns metadata only, with no URL grants, thumbnail requests, or tokens. Original requests also return a ten-minute single-use input token. `project.input.tokens {action:"materialize",token}` consumes it and copies input privately. Tokens bind component/workspace/project; renderers cannot submit raw paths.

### Private storage and settings

Storage returns component-owned workspace application-data locations, not project write authority. Components own schemas/migrations; the host does not inspect business tables. With `component.storage.previous.v1`, the host transactionally copies the same ID's old data root/database, retains source for rollback, and returns source/digest receipts for safe private-path rewriting. Cross-domain references use stable project/media/version IDs.

Large initial adoption is asynchronous. While copying, `adoption.state:"pending"` returns identity and startedAt only, without dataPath/databasePath; never infer them. Show read-only status and disable storage-dependent reads/writes/mutations. Poll with bounded 500–1000 ms backoff. Committed results include paths and a full same-component receipt: adoption flag, old references, DB digest, copied file count/bytes. V1 sources remain; journals discard or resume unfinished trees after crashes.

Component media accepts private-store relative files with variants/open/reveal. Variant semantics match project media; results contain URLs and opaque references, not echoed absolute paths. The component database owns deletion/invalidation. Settings supports get/replace/shallow merge. Settings/checkpoints are JSON objects up to 256 KiB. Atomic updates return monotonic revisions. Preserve unknown keys and migrate your own schemas.

### Secrets, network, and contributions

Secrets is available in project and application settings. Put/list/delete strictly validate fields; list never reveals values. Put receipts are independent from current same-name records, so replaying an old key returns its old result without undoing newer updates. Request-comparison receipt content is also encrypted; no offline-enumerable secret digest is persisted, and ciphertext counts toward capacity. Reads allowlist component ID, record/receipt/deletion shapes, public fields, timestamps, metadata, base64 ciphertext, and unique refs/names. Any violation quarantines the file. Closing a view does not clear locks; explicit data cleanup queues behind the same component lock and prevents racing writes. Atomic storage uses only Electron safeStorage ciphertext and fails closed without encryption.

Network fetch requires canonical origin to exactly match the URL origin and manifest networkOrigins. Headers/secrets must be plain objects; mode/timeout/body types are strict, GET/HEAD cannot have bodies, and base64 must be canonical. One deadline and uninstall controller starts before secret resolution, covering secret-lock/disk waits, DNS, connection, redirects, and response. Every hop rejects non-global addresses and pins validated addresses to `agent:false` TLS lookup, using the original hostname for SNI/Host/certificates. Cross-origin redirects strip authorization/cookie/proxy headers; 301/302/303 switch to GET and clear body. Secrets enter fixed headers only through secretBindings. Uninstall aborts through the capability barrier; counts release in finally. Ordinary view closure does not alter concurrency.

Contributions cover side panels, media/project actions, import/export providers, and application commands, each with ID, label, pageId, and separate RPC allowlist. Pages reference packaged fullPage; methods belong to the service. Ordinary tool components need a toolbar action or side panel; panel-only components need no new tab. Settings-only/decoder-only exceptions are documented separately.

Entries bind invocation scope and selection. Cross-directory selection uses the common ancestor; toolbar receives the complete safe selection for plugin filtering. Inspiration entries carry `contentKind:"inspiration"`; the host ignores renderer path identity and binds the configured inspiration root, without version-tree/progress access. Side panels/project actions may join videoTools/imageTools/officeTools groups. All three toolbar entries remain without selection, Office keeps a one-item dropdown, and inspiration always shows all three. Any panel ID works. A project action sharing a same-component/page toolbar action opens that full page; otherwise normal opening applies. Placed entries are not duplicated in standalone toolbar, Dock, root, or blank-area menus. Clicks carry safe selection/content kind; other contribution types cannot use these placements. Panels are source-page-specific and use the shared frame.

Application commands use project-free context. Only a global Dock with commands registers Ctrl/Cmd+Shift+P. Host toolbars, panels, context/import/export menus, and searchable commands expose entries. All surfaces use the same sandbox preload without navigation, new windows, or Node. Uninstall/upgrade or closing the project/inspiration/source page closes associated Views.

### Runtime playback backends

UI-free runtimes may declare top-level `runtimeContributions` with `media.playbackBackend`, protocol 1: unique backendId, native-process-v1 transport, priority, container/codec/extension probes, and transforms/HDR/statistics/subtitles/hardware-decoding/capture capabilities. Schema, registry parser, and SDK jointly constrain this. The broker validates and combines declarations with Chromium canPlayType into implementation-free descriptors. Extensions are sorting hints, not startup probes; priority compares components and cannot override Chromium probably/maybe. These contributions create no page/settings/renderer surface.

The media-playback-backend-v1 envelope contains sessionId, monotonic sequence, timestamp, event, payload. Frames are at most 256 KiB; images/pixels/audio/video frames cannot travel here. State/statistics are rate-limited/coalesced; closed-session commands expire. Input grants bind backend/process/session. Components return only their surface HWND; core checks PID and owns SetParent/styles/DPI/position/clipping. Components never receive Electron's main-window handle. The host alone creates, validates, and commits capture targets.

### Project mutations and recovery

The seven project-write extensions each require their table permission. Rating batches are 1–100 with per-item outcomes. Only image/RAW rating is writable, not video, labels, or selection state. Checked CAS and legacy outbox share the per-file ExifTool queue. Index fingerprint refresh after successful ExifTool work is nonfatal maintenance and cannot make completed rating effects appear failed.

Version update/delete and progress-node/edge changes use expectedUpdatedAt CAS, with independent deletion permission. Progress scope is rechecked in the DB transaction using Windows case-insensitive path keys. Graph endpoints must be physically in scope and not external links; role/cycle constraints remain.

Import reserves a single-use token bound to component/workspace/project/scope, then stages, validates, and commits. Reservation pauses cleanup but never extends the original ten-minute authorization. Release restores original expiry and immediately removes expired tokens. Concurrent calls sharing an idempotency key share one active owner. Cancellation/conflict/failure releases tokens and rolls back published files with unchanged digests. All import/file/process recovery repeats lstat, rejects links, verifies realpath in current canonical scope, and checks file SHA-256 or directory identity/owner marker. Replaced targets are neither claimed as success nor moved.

File mutation binds short-lived plans to identity/digests and rechecks before commit. Rename/move/mkdir/trash reject overwrite, links, Windows reserved names/trailing dots/spaces, protected roots, progress directories, and escapes by default. Moves journal from/to intent and file SHA-256 or directory identity before effects. Directory moves are same-volume, so recovery can recognize a crash between move and applied. Mkdir uses prepared/applied journals.

Trash uses atomic-replacement command receipts in the file-operations domain. If executing finds any source absent, outcomeUnknown requires manual recovery: never repeat OS trash or claim committed. Preflight reports undoCapability requires-precise-recycle. Commit reports undoAvailable true only if every item has preciseRestore true, permanent false, and PIDL. Otherwise it still reports committed but undoAvailable false and empty undo, and rejects later undo.

Undo journals per-item intent/applied. Move undo checks original digests/identities; mkdir undo removes only an empty directory still owned by the original operation. Recycle restore probes PIDL when originalPath is absent. Uncertain probes or project-target identity mismatch require manual recovery, never repeated restore.

Media process exposes only `video.timelineFrames` and `office.extractImages`, with shapes in the SDK. Timeline input is an in-scope relative video, resolved by the host and sent to an available backend; no general renderer IPC is exposed. Office extraction uses a stable key, supervised long-request lease, background progress, and cooperative cancellation. Even empty output first creates a private-stage owner marker before publishing an empty directory. Legacy video.sources.preview, video.trim, video.transcode.inspect, video.transcode, and video.split are not current Host API actions.

### Output transactions and versions

`project.output` actions:

- `stage`: create private stage and return its path to the supervised backend.
- `write`: register existing stage sourceName, copy an input token, or accept up to 8 MiB inline base64; bind outputRelativePath and return artifact ID.
- `validate`: reject empty, linked, escaped, missing, or oversized stages. Limits: 2,000 files and 2 GiB per stage.
- `commit`: require an ID-shaped idempotency key, reject overwrite by default, and atomically publish into the bound project. Multi-file failure rolls back newly created files. Return commit/artifact IDs; same-key retry returns the same result.
- `rollback`: recursively delete only the private component stage.
- `adopt`: one-time migration with project.output.existing.v1. Accept project-relative outputs or absolute sources from old component records only if canonical, regular, non-linked, and within the bound root. Return relative receipts without echoing absolute paths. This is not general filesystem access.
- `materializeOwned`: verify committed receipts/current digests and copy artifacts into private component storage for migration without retaining project paths.
- `delete`: delete only when old commit/artifact ID and expected digest still match, recording an idempotent deletion receipt.

Stage metadata/registered files persist atomically outside writable payload directories and bind component/workspace/project. Every nonterminal action enforces immutable createdAt + 24h expiry, which removes only the verified stage.

Before publication, commit writes a prepared receipt with stable commit ID, relative targets, artifact IDs, sizes, SHA-256, and per-file states. Each atomic publication is journaled; only complete matching output becomes committed. Restart reuses matching bytes only. Conflicts roll back unchanged host outputs while preserving user edits. Final-receipt write failure rolls back the whole multi-file publication and removes invalid journal state.

Replacement requires `replace:true`, `previousCommitId`, `previousArtifactId`, and `expectedDigest` in write. The previous receipt must own the same target and its current bytes must match. Backups stay in the expiring stage until the new transaction commits. Legacy adoption is manifest-controlled, same-component/project, relative, digest-verified, and independent of component business logic.

Project targets are relative; absolute paths and `..` are invalid. Components cannot publish outside the project or use another component/project's stage/commit.

`version.create` uses committed artifacts and photo/parent-version IDs. Restart resolves commitId directly from receipts without replaying commit. Version IDs derive deterministically from scope and idempotency key; a prepared version receipt precedes DB calls. Retry searches actual photo versions by stable ID, preventing duplicates after crash or final-receipt failure.

Progress supports list/create/relate, returning stable progress/edge IDs without directory paths. Create accepts virtual relativePath, image/video type, version key, structural parent ID, optional sourceProgressIds, and flat sourceMetadata. Category/role/displayName are nonempty, control-free strings up to 128 characters. parentCapability is structural/workflow-input/none. Omitted metadata or `{}` defaults to `{category:'progress',parentCapability:'structural'}`. The host always sets componentId and rejects unknown/nested fields. Lists return nonempty persisted metadata; old empty values stay null. The repository enforces graph roles/cycles.

### Tasks, cancellation, and recovery

Tasks supports start/report/status/cancel/resume/complete/fail. Stable operationId binds component/project, progress is 0–100, and reports may save JSON checkpoints. Cancellation is cooperative: after cancelled true, stop work, leave project contents unchanged, and roll back stages or retain only private resumable data. Resume starts/rebinds with supplied or returned checkpoints. Repeated terminal transitions are harmless.

Do not leave synchronous service requests open indefinitely. Ordinary timeout is 60 seconds. Media process uses a supervised long-request lease; other capabilities receive no compatibility timeout exemption. See [service protocol](COMPONENT_SERVICE_PROTOCOL_V1.md) for long-task budgets.

### Dialogs, events, and lifecycle

Dialogs supports confirm/openFiles/openDirectory/openComponentDirectory/openOutput/revealOutput/openOutputDirectory. Selection returns bounded tokens instead of caller-selected output paths. openComponentDirectory accepts safe relative paths in the calling component, including from settings, without returning absolute paths. openOutputDirectory opens the artifact folder in a new application project tab; other output actions retain system open/reveal semantics. Output actions require committed commitId/artifactId with matching receipts/current digests. Limits: 64 normalized extension filters and 2,000 selections.

Component events uses only declared versioned topics and JSON objects up to 256 KiB. Delivery is best-effort with at-least-once semantics, so consumers must be idempotent. Events contain no file paths and do not change host state.

Lifecycle describe returns installed version, permissions, declared events/actions, and state. With manage permission, preflight/install/repair/uninstall execute only manifest-declared packaged PowerShell entries after version/root/symlink/SHA-256 validation. Payload commands/arguments/paths are rejected. Scripts receive fixed PHOTOFLOW_COMPONENT_LIFECYCLE_ACTION, component ID/version, and a small OS environment allowlist. The host owns page lifecycle and project close.

## Protocol, limits, and errors

UI RPC and service JSONL are JSON objects up to 2 MiB. Method/event names are bounded and versioned. Unknown methods, strict manifest fields, senders, capabilities, permissions, stages, tokens, and topics default to denial. Stdout carries one frame per line; logs go to stderr. component-host-api.schema.json has method-specific request/results; component-service-protocol-v1.schema.json defines envelopes.

Stable codes:

- COMPONENT_HOST_INVALID_REQUEST, COMPONENT_HOST_PERMISSION_DENIED, COMPONENT_HOST_NOT_FOUND
- COMPONENT_HOST_TOKEN_EXPIRED, COMPONENT_HOST_TOKEN_SCOPE, COMPONENT_HOST_LIMIT_EXCEEDED
- COMPONENT_HOST_VARIANT_UNAVAILABLE, COMPONENT_HOST_CONFLICT, COMPONENT_HOST_CANCELLED
- COMPONENT_HOST_TIMEOUT, COMPONENT_HOST_SERVICE_EXITED, COMPONENT_HOST_INTERNAL

Errors have readable messages and may have retryable. Retry only when explicitly allowed or documented idempotent. Never retry an uncertain mutation using a new idempotency key.

## Ownership, security, and compatibility

The host owns projects, media indexes/variants, versions, file safety, tasks, component lifecycle, and grants. Components own private storage, settings schemas, algorithms, UI state, and business entities. Only the host publishes project content; neither updates the other's database.

Only explicitly granted previous-generation adoption sources remain. Old public routes/aliases/adapters/fallbacks have been removed. Component RPC/event versions and service protocol v1 are distinct from Host capability names. Removing component implementations must not break host, SDK, schema, examples, or generic builds/tests. Generic host code must not contain component business tables/fields.

### Component-owned embedded playback

`component.runtime.execute` accepts action playback, relativePaths or retained inputGrants, and a playback request. Source/backends/start/frames require exactly one authorized media file. Recorded outputs require bound-project/canonical-path checks. Operations reuse Chromium source grants and broker/process service, without general renderer playback IPC.

Source returns a view-scoped URL; backends returns broker descriptors; start returns a sender-owned session. Control/bounds/stop require ownership; controls also require original component/project scope. Bounds clip to the component view using trusted display scale and zoom. onPlaybackState subscribes to that view's events. Callers pause/hide on deactivation, obscuring dialogs, and crop editing; view destruction closes native sessions. Frames accepts at most two finite nonnegative times through the installed timeline-frame backend.

Transcoding output is bounded by the project root: `output.relativeDirectory:"."` means that root. Input stays in source scope; output can use sibling directories inside the project. Absolute paths, parent traversal, and escaping links remain forbidden. Recorded output playback may read in-project sibling results.

`ComponentSdk.setPlaybackBounds(sessionId,bounds)` is a one-way layout-only path for authorized sessions; it grants no access or opens media. The host checks main-frame sender, runtime permission, ownership, and original project binding, ignores old sequence numbers, and synchronously clips/converts DPI. No service RPC or filesystem authorization runs per scroll frame. Moving/resizing/suspending a view immediately reapplies its last accepted rectangle. Other operations retain their capability path. `host.setPlaybackPaused` similarly dispatches authorized play/pause; actual decoder state arrives through onPlaybackState.

Runtime `output:{private:true,argument:"--preview-root"}` allocates a unique private preview-cache directory bound to component/project/scope, separate from final project-relative output. Playback resolves privateOutputPath only below the same scope's preview root, rejecting links and cross-scope paths. The service resolves it from its own receipt; renderer gains no arbitrary private-file access.
