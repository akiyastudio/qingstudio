# PhotoFlow plugin (component) development

English | [简体中文](PLUGIN_DEVELOPMENT.zh-CN.md)

PhotoFlow calls optional extension packages **components**. This filename retains “Plugin” for discoverability. New packages use Component Host V2 and must not import the host React renderer or Electron main-process code.

## Quick start

For persistent subtitle panels, tracking current video, subtitle seeking, or previews of arbitrary extensions, use the [preview API](PLUGIN_PREVIEW_API.md). A non-media file with an installed matching decoder opens in the preview pane on ordinary click.

File editors can use `project.files.inputToken` for any project-file format, `project.files.watch` for linked-resource state, and `component.transfer` for chunked binary transfer. Side-panel, context-menu, import/export, and command contributions allow 128 RPC methods. See [file resources and large-data API](PLUGIN_FILE_RESOURCES_API.md) for permissions, call order, and limits. Parsing remains the plugin's responsibility.

1. Copy `examples/hello-component` into a directory named after your component ID.
2. Use the single current Host API without version negotiation. Do not declare `componentHost.compatibility` or other Host API version fields. Unknown fields and capabilities are rejected.
3. Add `workspace.toolbarAction` or `component.sidePanel`, a connected `component.fullPage`, and packaged UI/service entries. Panel-only components may omit the toolbar action. Prefer `application.settingsForm` for normal preferences, reserving `application.settingsPage` for custom interaction.
4. Declare all service RPC methods, Host capabilities, permissions, and emitted events. Undeclared access is denied. Legacy data may use explicit `component.storage.previous.v1` and/or `project.output.existing.v1` adoption grants; do not add component business tables or path fields to host code.
5. Run `node scripts/mock-component-service.cjs examples/hello-component/service.cjs` for the introductory protocol. The mock uses that example's fixed RPC methods; adapt tests for custom services.
6. Follow the [example run instructions](../examples/README.md) for `PHOTOFLOW_COMPONENT_DEV_ROOTS`. Keep the example's `package.json` development registration: `component.json` alone does not enable source discovery. See [development registration](COMPONENT_DEVELOPMENT.md).

The full example contains a static page and Node service. The page calls only `window.photoFlowComponent`, and the service requests a media page. `component-sdk/index.d.ts` maps capability requests, results, errors, events, and JSONL frames; `component-sdk/service.cjs` provides `callHost`, `acceptFrame`, and `failAll`.

## Package layout

```text
hello-component/
  component.json
  service.cjs
  ui/index.html
  ui/icon.svg          # optional; PNG or passive SVG only
```

Manifest paths are package-relative. Symlinks, traversal, remote pages/icons, active SVG, missing files, and unknown contribution types invalidate UI registration. Components cannot choose their preload.

## UI guide

```ts
import { host, assertHostApi } from '../../component-sdk/index.js';

const context = await host.getContext();
assertHostApi(context);
const page = await host.rpc('my-component.load.v1', { cursor: null });
const stop = host.onEvent('my-component.progress.v1', update => render(update));
if (host.notify) {
  await host.notify({ tone: 'success', message: 'Settings saved', dedupeKey: 'settings.saved' });
}
window.addEventListener('pagehide', stop, { once: true });
```

The UI runs in a sandboxed `WebContentsView` with Node integration, WebView, arbitrary navigation, new windows, and browser permissions disabled. Use resolved light/dark context and subscribe to theme/context changes. Support keyboards, visible focus, form labels, and reduced motion. Do not assume the host page is always active; release timers and subscriptions on deactivation/destruction.

This sandbox isolates only the UI WebContents. Services, lifecycle actions, and executables are trusted native code installed by the user and run with that user's OS permissions, including accessible files, network, and processes. Host capabilities/permissions are an interoperability and least-privilege contract for cooperating components, not an OS boundary against malicious native code. Supervision controls startup, protocol, timeouts, and shutdown; it is not an OS sandbox. Do not describe offline installation as safe execution of untrusted marketplace plugins.

### File-page panels

`component.sidePanel` uses the built-in tool-panel frame. The host owns title, icon, backdrop, close button, and View sizing; the plugin draws only content, without another modal shell. Context `surface` is `component.sidePanel`. `scopeRelativePath`, `selectedRelativePaths`, and `sourcePageId` bind the originating file page. Each file page has its own instance; page close, uninstall, and upgrade close its panels.

Before display, the host injects the stable `component-sdk/ui.css` color, spacing, radius, form, button, card, and scrollbar contract. Context `panelStyleContractVersion` identifies it. Use `--pf-*`, `.pf-panel-card`, `.pf-panel-section`, `.pf-form-label`, `.pf-form-input`, `.pf-button`, and `.pf-button-primary`; do not copy host Tailwind internals.

The preload measures body height. The host shrinks to content up to `90vh`, then scrolls within the body View; `panelLayoutContractVersion` identifies this contract. Keep natural body height. Avoid `height:100vh`, fixed height, or unnecessary `min-height` on html/body/root, which would become the reported content height.

```json
{
  "type": "component.sidePanel",
  "id": "panel",
  "label": "Batch processing",
  "title": "Batch image processing",
  "pageId": "panel-ui",
  "rpcMethods": ["my-component.run.v1"]
}
```

Declare the referenced `component.fullPage`; panel-only components need no toolbar action. Listen to `onThemeChange`, `onContextChange`, `onActivate`, and `onDeactivate`. Use `tasks` for long work. See `examples/panel-only`.

To join host tool groups, `component.sidePanel` or `project.contextAction` may declare:

| Placement | Menu |
| --- | --- |
| `workspace.videoTools` | Video tools |
| `workspace.imageTools` | Image tools |
| `workspace.officeTools` | Office documents |

All three menus work in project file pages and the inspiration library. Inspiration keeps all three icons visible. Office retains a dropdown even with one tool. Menus remain accessible without selection; selection-dependent actions are disabled. Contributions append in manifest order and join matching file-selection context-menu groups, without duplicate standalone toolbar/root-menu entries. Panels of any ID can be placed here.

A `project.contextAction` opens the full page if the same component has a toolbar action for the same `pageId`; otherwise it uses normal contribution opening. Side-panel actions open panels. Both receive the full safe file/folder selection, `sourcePageId`, and `contentKind` (`project` or `inspiration`). Unsupported shortcut selections cannot execute. Placement does not filter extensions: the plugin validates input and declares its page, RPC, and permissions. Other contribution types or unknown placements are rejected. `workspace.folderPanel` is only for side panels and is separate from tool menus.

```json
{
  "type": "component.sidePanel",
  "id": "document-tool",
  "label": "My document tool",
  "pageId": "panel-ui",
  "placement": "workspace.officeTools",
  "rpcMethods": ["my-component.run.v1"]
}
```

Include this entry in `componentHost.contributions`, alongside `panel-ui` and the allowed service RPC. Extend `examples/panel-only` with multiple grouped panel contributions.

Renderers normally call component-owned RPC. Explicit SDK UI bridges such as `notify`, dialogs, panel information, preview, and authorized playback remain narrowly validated. `notify` accepts only plain-text status, never HTML, callbacks, URLs, paths, or arbitrary channels. Services request declared Host capabilities through the backend protocol; this does not prevent trusted service code from directly using its OS permissions. Use service `notifications` only for short backend-generated status. Long work and confirmations use `tasks` and `dialogs`.

### Optional application settings

Prefer `application.settingsForm`. The host validates and renders manifest fields, applies defaults, and saves through `component.settings`. See `examples/declarative-settings`.

Plugin settings entries, names, icons, and dedicated licenses must be manifest-owned, never hardcoded or imported into the host sidebar. A component containing only settings forms without `customPage` may omit tool pages, toolbar actions, and service: the host saves settings without starting it. Existing custom-page/service plugins need no migration.

Forms may declare up to 16 plain-text `help` entries, each with `title` (160 characters) and `description` (2000). Help does not create values or actions. Separate `notices` contain `title`, `description`, `license`, `sourceUrl`, and `licenseUrl`, with credential-free HTTPS links. Informational forms may have empty `groups` if at least one help entry or notice exists. Ordinary values remain isolated by component.

Standard video-backend plugins may declare `preferenceScope: "videoPlayback"`, binding `hdrMode`, `toneMapping`, and `targetPeakNits` to existing shared-player preferences. The host checks fields, ranges, and backend capabilities. No other application settings are exposed. Existing values are preserved and read directly by the player, independently of plugin ID.

Use `application.settingsPage` when declarations cannot express the interaction. A valid installed contribution appears after Component Management. It uses a sandboxed View and component preload, with `context.surface: "application.settings"` and no project fields.

```json
{
  "type": "application.settingsPage",
  "id": "settings",
  "label": "Example component",
  "title": "Example component settings",
  "entry": "ui/settings.html",
  "rpcMethods": ["hello.settings.get.v1", "hello.settings.update.v1"]
}
```

Only listed methods that also belong to `service.rpcMethods` can be called. Project/media/task/event capabilities are denied on settings surfaces; use only capabilities explicitly allowed for this surface, including component settings, lifecycle, secrets where authorized, scoped dialogs, and notifications. See the [Host API](PLUGIN_HOST_API.md). Do not call project RPC from settings.

### Display language

`getContext().locale` reports the host language. Use `mountUiLanguage(onChange)` and dispose its returned subscription when leaving. Components maintain their own dictionaries. Language changes must not rename files or change saved project identities. See the [SDK contract](../component-sdk/README.md#display-language).

## Service guide

The service exchanges UTF-8 JSON Lines over stdin/stdout:

1. After initialization, emit `{ "type":"ready", "protocolVersion":1 }`.
2. Receive `request` with opaque ID, declared versioned method, JSON payload, and path-free project context.
3. Return `response`; for host resources, emit a `capability` bound to `parentId` and await `capability-response`.
4. Write logs to stderr; stdout carries protocol frames only.

See `examples/hello-component/service.cjs`. Ordinary synchronous requests time out after 60 seconds; frames/payloads are limited to 2 MiB. For long work, start `tasks`, checkpoint frequently, return control to the UI, and resume from the last checkpoint after cancellation/restart.

Read extensions require explicit declarations. For example, `callHost(parentId, 'project.files.search', { query:'xmp', pageSize:50 })` also needs `project.files.read`. Metadata uses `project.media.read`; versions and ratings need `project.versions.read` and `project.media.ratings.read`. Results contain virtual project-relative paths and stable IDs. Do not infer absolute paths from cursors, media references, or graph nodes.

Write capabilities have separate permissions. In `examples/project-write`, ratings have per-item semantics; checked writes and the legacy ratings outbox share ExifTool's per-file queue. Versions/progress use database CAS and recheck scope in the transaction. Import reservations never extend the original one-use input-token lifetime. Recovery rechecks canonical scope, links, digests, and owner/identity. File mutation and undo use per-item intent/applied journals; directory moves are same-volume. Unknown OS trash/restore results stop for manual recovery. Office empty output writes an owner marker in private stage before atomic publication. Long media calls currently await completion; use the same idempotency key for status/cancel. Receipt recovery synchronizes task completion, and uninstall cancels active import/process work. Keys, plans, tokens, and receipts bind component/workspace/project/scope and are denied in settings context.

## Safe media-to-version workflow

1. Page through `project.media.page`.
2. Use `variants:[]` for metadata; resolve thumbnail/preview/original only when pixels or URLs are needed.
3. Exchange a returned short-lived, single-use token through `project.input.tokens` when the service needs a private file copy.
4. Create a `project.output` stage, write inside its private directory, register each file with `write`, and `validate`.
5. `commit` with a stable idempotency key. The host publishes only declared relative destinations inside the bound project.
6. Optionally call `version.create` with returned commit/artifact IDs and another stable key.
7. `rollback` abandoned stages.

Stage metadata and registered files persist for 24 hours, allowing validate/commit/rollback after restart. Save `stageId`, `commitId`, and artifact IDs, not private paths. Open/reveal committed artifacts through `dialogs`; `materializeOwned` verifies and adopts them into private storage during migration. Arbitrary output paths are never accepted.

Use `component.media` for private-store media and `project.progress` for progress nodes/source relationships. Creation accepts flat `sourceMetadata`: `category`, `role`, `displayName` (up to 128 characters), and `parentCapability` (`structural`, `workflow-input`, or `none`). The host sets bound `componentId`. Omitted/empty metadata defaults to structural progress; unknown/nested fields are rejected.

If `component.storage` returns `adoption.state === "pending"`, no storage paths are granted. Show migration state, poll with bounded 500–1000 ms backoff, and reject storage-dependent reads/writes/mutations. Do not create published component directories, guess data/database paths, or start another copy. After commit, validate the same-component receipt before rewriting private paths. Track project-output migration separately and incrementally. The host retains V1 sources and resumes interrupted copy journals.

Replacement requires `replace:true`, `previousCommitId`, `previousArtifactId`, and `expectedDigest`. The previous receipt must own the same target and current bytes must match; old contents are journaled during the multi-file transaction. Never implement replacement by deleting the target yourself.

Persist PhotoFlow IDs and component metadata rather than project paths as business identity. Tokens, cursors, stages, commits, and artifact IDs are opaque and scoped to one component/project.

## Testing and releases

- Public-checkout commands are `npm run test:examples`, `npm test`, and the build/smoke commands in the root README. Upstream Host API, architecture, lifecycle, and transaction suites are not exposed here as npm scripts; do not assume they ran for this update.
- Validate the manifest against `electron/contracts/schemas/component-manifest-v2.schema.json` before packaging.
- Package built UI, services, and runtime resources only. Hash declared lifecycle actions. Install in a clean profile, exercise cancellation/restart, and use real V1 data for upgrade/downgrade testing.
- Increment the component business version for every release. Change RPC/event `.vN` only for breaking semantics; retain old and new methods together during migration.

Legacy host business adapters have been removed. Components use the current Host API and explicit adoption grants.
