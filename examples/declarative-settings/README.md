# Declarative settings example

English | [简体中文](README.zh-CN.md)

The current `component.json` demonstrates a tool page, Host service, and declarative settings. This remains supported: the tool page calls the service, while the host renders the declared settings form. No service or UI changes are needed to accommodate settings-only support.

## When only a settings entry is needed

A runtime or command-line plugin without a tool page can use this `componentHost` value. It omits `workspace.toolbarAction`, `component.fullPage`, and `service`:

```json
{
  "contractVersion": 2,
  "contributions": [
    {
      "type": "application.settingsForm",
      "id": "settings",
      "label": "Runtime settings",
      "title": "Runtime settings",
      "form": {
        "schemaVersion": 1,
        "groups": [
          {
            "id": "general",
            "title": "General",
            "fields": [
              {
                "id": "enabled",
                "type": "toggle",
                "label": "Enable automatic processing",
                "default": true
              }
            ]
          }
        ]
      }
    }
  ]
}
```

This is the value of `componentHost`, not a complete manifest. Retain the top-level `entrypoints`, runtime files, and platform declarations the plugin actually uses; a runtime entry is different from a Host UI service. Remove unused `requiredFiles` and development mappings so no declaration refers to deleted UI or service files. Values are saved in the component's own `componentSettings` without starting a service. The plugin must use those values when it runs; declaring a form does not add processing behavior.

A Host service may be omitted only when every contribution is `application.settingsForm` and none has a `customPage`. Keep the service and permission declarations when custom pages or RPC are needed.

## Icons and notices

Declare the packaged icon through top-level `icon`, and include it in development mappings and package contents. The host reads the name, settings pages, and icon from the component registry; sidebar code does not need changes.

Use `form.notices` for third-party notices, with `title`, `description`, `license`, `sourceUrl`, and `licenseUrl`. URLs must use HTTPS without credentials. A notices-only page may use `groups: []` but must have at least one notice. Use the versions and licenses of the dependencies the plugin actually includes.

A standard video-playback backend may declare `form.preferenceScope: "videoPlayback"` to access the shared player's `hdrMode`, `toneMapping`, and `targetPeakNits` display preferences, subject to Host field and backend-capability validation. Ordinary plugins omit this field and use isolated component settings.

See the [development guide](../../docs/PLUGIN_DEVELOPMENT.md) for the full contract.
