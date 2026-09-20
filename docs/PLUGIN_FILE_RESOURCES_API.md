# File resources and large-data API

English | [简体中文](PLUGIN_FILE_RESOURCES_API.zh-CN.md)

This page supplements the current Host API. Types are in `component-sdk/index.d.ts`; request/result schemas are in `component-host-api.schema.json`. The component service calls Host capabilities. Renderers forward requests through declared component `.vN` RPC methods and receive neither local paths nor arbitrary filesystem access.

## Project files of any format

Declare capability `project.files.inputToken` and both `project.files.read` and `project.input.read` permissions.

```js
const file = await host.callHost(parentId, 'project.files.inputToken', {
  relativePath: 'Design/proposal.qs',
  // expectedDigest: 'optional SHA-256 from the previous save'
});
const snapshot = await host.callHost(parentId, 'project.input.tokens', {
  action: 'materialize', token: file.input.token
});
// The service reads snapshot.privatePath; never forward that path to the UI.
```

Here `host` comes from the SDK's `createServiceHostClient`; `parentId` identifies the active component RPC request. Materialization also requires the `project.input.tokens` capability.

Any ordinary file inside scope is accepted, with any extension or none, including images, QS, ABR, and fonts. Parsing, display, and editing belong to the plugin. The result is `{input:{token,expiresAt},relativePath,name,byteLength,sha256,fileId}`. Paths use `/`; absolute paths, `..`, symlinks/junctions, NTFS streams, and `.photoflow-*` internal entries are rejected.

Tokens expire after ten minutes, are consumed once, and bind component/workspace/project/scope. Changes during authorization or copying, or an `expectedDigest` mismatch, return `COMPONENT_HOST_CONFLICT`. SHA-256 is streamed over the full file without loading it into memory. `fileId` identifies the physical file within its scope/source page; renaming preserves it, while replacement may change it. Paging still uses the existing division between `project.files.page/search` and `project.media.page`.

## Linked resource state

Declare `project.files.watch` and permission `project.files.read`.

| Action | Parameters | Result |
| --- | --- | --- |
| `subscribe` | `relativePaths` (1–256 unique existing files), optional `includeVersions` | `subscriptionId,cursor,expiresAt,files` |
| `poll` | `subscriptionId,cursor` | `subscriptionId,cursor,expiresAt,files,events,rescanRequired` |
| `unsubscribe` | `subscriptionId` | `unsubscribed:true` |

Files include `relativePath,fileId,revision,versionId`, with `missing:true` when absent. Events are `modified`, `renamed`, `deleted`, or `versionChanged`, carrying file information, `subscriptionId`, monotonic `sequence`, and `previousRelativePath`. Deduplicate by sequence and retain the returned cursor. A restored original path emits `modified`. Version tracking applies only to projects, additionally requires `project.versions.read`, and tracks the associated photo's current version ID.

This is a **state subscription**, not an operation log: changes between polls are coalesced and transient intermediate states are not retained. A scan visits at most 20,000 scope entries. Truncated scans/version snapshots, cursor mismatches, or intervals exceeding 30 seconds return `rescanRequired:true`; the caller must reconcile resources. A truncated scan does not treat undiscovered files as deleted. Multiple hard links with the same inode do not lead to guessed rename targets.

Poll visible pages every 2–5 seconds, without concurrent polls for one subscription. Unchanged state returns empty events. Obtain a separate read token after a change; subscriptions do not authorize reading.

Subscriptions bind component, workspace, project, scope, and source page. Limits are 16 per component and 256 per host. They expire after five minutes without a call and are released on view cleanup or component uninstall/upgrade. Reconnect with the old cursor to reconcile; after expiry, subscribe again for a new baseline.

## Large binary transfers

Declare `component.transfer` and permission `project.input.read`. Prefer streaming token materialization inside the host for original images/ABR, and direct output-stage writes for service exports. Use transfer sessions when crossing the renderer/service boundary.

Upload:

1. `{action:'create',name,byteLength}` returns `transferId,byteLength,chunkBytes,expiresAt`.
2. `{action:'write',transferId,offset,base64}` writes sequentially to a private file and returns `nextOffset`. Wait for acknowledgment before the next chunk. Identical retries at the same offset work; different bytes or skipped offsets conflict.
3. `{action:'finish',transferId,expectedDigest}` checks full size and SHA-256 and returns `input,byteLength,sha256`. Repeating finish with the same digest returns the same result, but the token remains single-use.
4. `{action:'close',transferId}` releases transfer files. The finished token remains materializable, or can be passed to `project.output` `write`, followed by validate/commit.

Download: `{action:'openInput',token}` consumes the token and returns a read session. `{action:'read',transferId,offset,byteLength}` returns `offset,nextOffset,base64,eof`; close when finished. A range can be read repeatedly. Empty files are supported; directory inputs are not.

Raw chunks are at most 1 MiB. The per-file upload limit and aggregate active upload budget per component are both 2 GiB. Limits are eight sessions per component and 64 per host. Sessions use the same binding as subscriptions, require serial calls within each session, expire after ten idle minutes, and are released on view cleanup or uninstall. Retry within a live session; after host restart or expiry, create a new session. Persistent resume is not provided.

Forward each chunk through a separate component RPC to avoid exceeding 128 nested capability calls or the parent request timeout. Transport remains base64 JSON with a 2 MiB frame limit and existing concurrency limits. This bounds transfer memory and frame size; it is not zero-copy. Finish creates a verified private snapshot.

## RPC counts

Each `component.sidePanel`, `media.contextAction`, `project.contextAction`, `project.importProvider`, `project.exportProvider`, and `application.command` contribution allows **128** `rpcMethods`, increased from 16 to match the service limit. Methods must remain unique, versioned, declared by the service, and not host-only. Settings pages remain limited to 32; other contribution-count limits are unchanged.

Saving outside the project, optional capability negotiation, and plugin painting-engine features are outside this change's scope.
