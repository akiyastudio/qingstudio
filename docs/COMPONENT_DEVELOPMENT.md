# Component development registration

English | [简体中文](COMPONENT_DEVELOPMENT.zh-CN.md)

PhotoFlow production builds discover components only from the per-user installed component directory. Source trees, `extensions`, environment overrides, and development manifests are never consulted when `app.isPackaged` is true. Installed packages still pass the normal package, compatibility, integrity, Component Host V2, permission, and path checks.

The component installation/package directory is always the per-user directory in both packaged and unpackaged builds. Development discovery is an additional source overlay only; it never changes the installation directory to a repository-local `components` folder. When the same component exists in both places, an unpackaged build uses the current development source.

Unpackaged development builds additionally discover component packages from `PHOTOFLOW_COMPONENT_DEV_ROOTS`. Separate multiple absolute local directories with the platform `path.delimiter` (`;` on Windows, `:` on POSIX). The project `extensions` directory is a default development root; set `PHOTOFLOW_COMPONENT_DEV_DEFAULTS=0` (also accepts `false` or `off`) to disable that default. Missing, relative, UNC, linked, non-directory, and duplicate roots are ignored.

Each child package opts in through its own `package.json`; the host catalog never names the component:

```json
{
  "photoflowComponent": {
    "manifest": "component.template.json",
    "development": {
      "prepare": "build",
      "runtime": {
        "command": { "win32": ".venv/Scripts/python.exe", "default": ".venv/bin/python" },
        "entry": "algorithm.py",
        "argsPrefix": ["-u"]
      },
      "files": {
        "ui/index.html": "dist/ui/index.html",
        "ui/settings.html": "dist/ui/settings.html",
        "ui/icon.svg": "renderer/icon.svg"
      }
    }
  }
}
```

`manifest` remains the authoritative `component.json`-format declaration: it owns pages, settings pages, icon, RPC methods, Node/executable service, permissions, capabilities, lifecycle actions, and algorithm package entry. `development.files` only maps those already-declared package paths to development build/source files. Unknown fields and mappings to undeclared paths are rejected. Runtime command, runtime entry, mapped files, service files, required files, icons, and lifecycle actions must be regular files inside the component root; traversal, URLs, UNC roots, directory links, and file symlinks are rejected. Component renderers still run in the isolated `WebContentsView` with the Component Host V2 preload and RPC allowlists; no plugin Electron or React module is imported by the host.

For a directly executable native runtime, omit `development.runtime.entry`; the host launches `command` without adding a script path. Script runners such as Python or Node continue to declare `entry`, which is appended after `argsPrefix`.

A component implemented entirely as a `componentHost.service.runtime: "node"` service may omit `development.runtime`. Its service runs with the host's Node runtime, using the mapped service entry; no separate algorithm runtime arguments are supplied. Components with a separate algorithm executable still declare `development.runtime` as above. PSD preview is one use case for this service-only mode, with its service and decoder worker built through `prepare:dev`; official plugin implementations are not included here.

Run `npm run prepare:components:dev` to execute every discovered package's declared `prepare` script. `npm run electron:dev` does this automatically through its lifecycle pre-script. This builds renderer assets only; a component may use its private virtual environment and source algorithm entry without PyInstaller or ZIP packaging. A missing build remains visible in Component Management as an actionable “开发组件不可用” error rather than disappearing. Valid source registrations are visibly labeled “开发组件” and are never represented as integrity-verified installations.

Component Management provides the same Disable/Enable control for development and installed components. Disablement is reversible, preserves the component package and user data, removes the component from runtime and Host discovery, and is persisted under the user component root so the component is not loaded on the next launch. Disabling an active component also closes its surfaces and stops its service, worker processes, and outstanding network activity before the operation completes.
