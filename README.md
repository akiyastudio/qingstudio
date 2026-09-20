# PhotoFlow

English | [简体中文](README.zh-CN.md)

PhotoFlow is a desktop image-management workspace for photographers, retouchers, and imaging teams. Local projects bring together importing, file organization, previews, ratings, version tracking, and work progress.

This repository contains the main application under **Apache License 2.0**. It provides a runnable desktop host, SDK, API contracts, and small examples for community plugin development.

## Source scope

- `src/`: React UI, frontend state, projects, and media interactions.
- `electron/`: desktop main process, local file services, native helper sources, and component host.
- `python/`: local database, import, and image-processing tools.
- `component-sdk/`: plugin interfaces and SDK.
- `examples/`: six runnable plugin examples.
- `docs/`: development guides, Host API, service protocol, and development registration.
- `scripts/`: public development, build, and verification scripts.

## Start with a plugin

1. Read the [examples and run instructions](examples/README.md). Start with `hello-component` or `panel-only`.
2. Set up the application below and point `PHOTOFLOW_COMPONENT_DEV_ROOTS` at the examples or your plugin directory.
3. Run `npm run test:examples`, then `npm run electron:dev` for integration work.
4. Extend the plugin using the [development guide](docs/PLUGIN_DEVELOPMENT.md), [Host API](docs/PLUGIN_HOST_API.md), and [SDK types](component-sdk/index.d.ts).

The educational examples are also licensed under Apache 2.0.

## Environment

The project's existing validation target is **Windows x64**. The documented toolchain is Node.js 24, npm 11, Python 3.12 (64-bit), and Git. Native helpers use the Windows .NET Framework 4.x C# compiler, whose availability is checked by their build scripts. Other platform code is retained but has not completed full build and runtime validation.

## Installation and development

```powershell
git clone https://github.com/akiyastudio/qingstudio.git
cd qingstudio
npm ci
npm run setup:python
npm run electron:dev
```

`electron:dev` starts Vite, builds native helpers, and launches Electron. `npm run dev` alone starts only the frontend server. Python uses `.venv/`; npm uses the lockfile. Direct Python dependency versions are pinned, while pip resolves transitive dependencies.

## Verification commands

```powershell
npm test
npm run build
npm run build:native
npm run check:python
npm run test:smoke
```

Smoke tests use separate temporary directories and blank configuration, preserve failed runs for diagnosis, and do not read the everyday workspace. These commands cover public source boundaries, selected file-operation safety, component status policy, examples, and startup without plugins; they do not prove every business feature works.

## Build an installer

```powershell
npm run electron:build
```

Local deliverables go to `artifacts/installers/` and are not automatically uploaded. Binary distributors must also satisfy the licenses of bundled dependencies; see [third-party notices](THIRD_PARTY_NOTICES.md). The initial public release of this repository is scoped to source delivery.

## License

Original code is covered by [Apache License 2.0](LICENSE); attribution is in [NOTICE](NOTICE). Third-party dependencies retain their licenses. The license grants no trademark rights.

Issues and improvements are welcome. Remove private paths, credentials, and real customer data before sharing screenshots, logs, or sample projects.
