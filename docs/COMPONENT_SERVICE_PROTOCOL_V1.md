# Component Service Protocol V1

English | [简体中文](COMPONENT_SERVICE_PROTOCOL_V1.zh-CN.md)

Component Service Protocol V1 is the current process transport used by
Component Host V2. The protocol version describes the JSON Lines envelope; it
is independent from the unversioned current Host API and
from component-owned RPC method versions such as `.v1` or `.v2`.

Component renderers run in host-managed sandbox `WebContentsView` instances.
A component service is launched as a supervised `node` or `executable` child
process. Electron never imports or `require`s component business code.

## Manifest boundary

`componentHost.service` declares:

- `protocolVersion: 1`;
- runtime and platform entrypoints;
- a bounded, versioned component RPC allowlist;
- exact Host API capability and permission allowlists;
- emitted events and optional runtime/lifecycle actions;
- network origins and secret bindings when those capabilities are requested.

Entrypoints and lifecycle files must resolve to regular, non-symbolic-link files
inside the installed component root. Discovery rejects unknown fields,
undeclared files, duplicate or unversioned component RPC methods, path traversal,
external absolute paths, unknown capabilities and missing permissions.

## Current Host API capabilities

The authoritative vocabulary is `HostCapabilityMap` in
`component-sdk/index.d.ts` and the enum in
`electron/contracts/schemas/component-manifest-v2.schema.json`:

- media and inputs: `project.media.page`, `project.media.variants`,
  `project.input.tokens`, `project.media.metadata`, `project.media.ratings`,
  `project.media.ratings.write`, `project.media.process`;
- project files and versions: `project.files.page`, `project.files.search`,
  `project.files.inputToken`, `project.files.watch`, `project.files.mutate`, `project.versions.page`, `project.version.graph`,
  `project.version.update`, `project.version.delete`, `project.progress`,
  `project.progress.manage`, `project.import`, `project.output`, `version.create`;
- component services: `component.storage`, `component.settings`,
  `component.events`, `component.lifecycle`, `component.media`,
  `component.runtime.execute`, `component.secrets`, `component.transfer`,
  `component.panel`, `network.fetch`;
- host interaction: `tasks`, `dialogs`, `notifications`, `project.preview`.

Capability names are stable Host API method names and do not carry `.vN`.
Component-owned RPC methods and emitted component events remain explicitly
versioned. Declaring a capability does not grant it: every invocation checks the
installed manifest, permission allowlist and bound component/project context.

## Process protocol

Transport uses bounded JSON objects, one frame per line on private stdin/stdout:

1. The service sends `ready` with the negotiated protocol version.
2. The host sends a `request` containing an ID, versioned component RPC method,
   payload and bounded context.
3. While processing that request, the service may send a `capability` frame tied
   to the parent request.
4. The host returns `capability-response` after authorization and validation.
5. The service completes the parent call with a success or failure `response`.

Frames and payloads are bounded to 2 MiB. Unknown, malformed or oversized frames
are rejected. A service receives a minimal environment rather than the complete
host environment. Raw workspace paths remain in the host unless a specific
capability returns a bounded token or authorized project-relative reference.

Unexpected process exit fails in-flight requests. Component services have a
bounded supervised restart policy, but requests are never silently replayed.
Callers retry mutations only with operation-specific idempotency keys.

Each ordinary parent RPC permits at most 128 nested capability calls. After a
successful `tasks.start` or `tasks.resume` result returns a non-cancelled Host
task, that parent receives a bounded long-task budget of 262,144 calls. This
supports cancellation polling, progress and output publication during the
four-hour task deadline without exhausting the ordinary RPC budget during model
initialization. A failed task call, status query, or permission declaration alone
does not grant this budget.

Long-task calls are additionally limited to 128 per one-second window. All
parents retain the eight-concurrent-capability limit, duplicate-ID rejection and
frame-size limits. Capability IDs are limited to 128 characters, and the finite
per-parent call budget bounds the retained duplicate-ID set. Capabilities still
pass the broker's normal permission and project-scope checks on every call.

## Data, output and migration

`component.storage` returns component-private locations and may report an
asynchronous adoption state. A pending adoption is read-only and does not expose
the destination paths. Project content is written only through transactional
Host API capabilities such as `project.output`, `version.create`,
`project.files.mutate` or the bounded import/progress capabilities.

Legacy data is accepted only through migration paths authorized by explicit adoption grants. New component business tables, routes and fields must not be added to
the host database or general Electron modules.

## Sources of truth

- manifest: `electron/contracts/schemas/component-manifest-v2.schema.json`;
- wire envelope: `electron/contracts/schemas/component-service-protocol-v1.schema.json`;
- Host API request/results: `electron/contracts/schemas/component-host-api.schema.json`;
- public TypeScript API: `component-sdk/index.d.ts`;
- runtime validation and supervision: `electron/component-host-contract.cjs` and
  `electron/services/component-service-manager.cjs`.
