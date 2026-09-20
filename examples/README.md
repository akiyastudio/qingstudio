# Component Host examples

English | [简体中文](README.zh-CN.md)

These examples include a tool page and service with `component.json`, `service.cjs`, and `ui/index.html`. This is not mandatory for every plugin: a declarative settings-only plugin can omit the tool page and Host service. Copy the example closest to your needs, rather than packaging the whole examples directory.

| Directory | Purpose | Host capabilities |
| --- | --- | --- |
| `hello-component` | Call a service from the UI and read one page of project media | `project.media.page` |
| `panel-only` | Contribute a file-page side panel without a toolbar entry | None |
| `host-api` | Share a page between Host entry points with restricted contexts | None |
| `project-read` | Page through non-media files and sidecars in the authorized scope | `project.files.page` |
| `project-write` | Write media ratings using revisions and idempotency keys | `project.media.ratings.write` |
| `declarative-settings` | Declarative settings with a tool page; includes a [settings-only variant](declarative-settings/README.md) | `component.settings` |

Plugin settings entries, names, icons, and dedicated notices belong in the manifest. Do not hardcode plugin entries or resources in the host sidebar. Existing service-based examples remain supported.

## Quick checks

From the repository root, check the introductory service's JSON Lines protocol:

```powershell
node scripts/mock-component-service.cjs examples/hello-component/service.cjs
```

Check example manifests, permissions, entry points, and development registrations:

```powershell
npm run test:examples
```

## Run in the application

Install application dependencies and Python as described in the root README, then run:

```powershell
$env:PHOTOFLOW_COMPONENT_DEV_ROOTS = (Resolve-Path examples).Path
npm run electron:dev
```

This loads all six examples. To load one, use `examples/hello-component`. Select a local test project and find the entries on its file page. `panel-only` uses a side-panel entry; `declarative-settings` also contributes a settings form. Read examples need corresponding project files; use disposable test media for rating writes.

Each example includes `package.json` development registration and needs no additional npm dependencies, UI build, or copy into user data. Restart the host after manifest or service edits. Development roots apply only to unpackaged builds.

## Create your own plugin

Copy an example into a separate directory. Update its component ID, pages, RPC methods, capabilities, and permissions in `component.json`, keep `package.json` consistent, and point the development root to it. Example code is Apache 2.0.

- [Development guide](../docs/PLUGIN_DEVELOPMENT.md)
- [Host API](../docs/PLUGIN_HOST_API.md)
- [Development registration](../docs/COMPONENT_DEVELOPMENT.md)
- [Service protocol](../docs/COMPONENT_SERVICE_PROTOCOL_V1.md)
- [SDK types](../component-sdk/index.d.ts)

Declare only capabilities and permissions you actually use. Combine features by extending these examples one declaration at a time.
