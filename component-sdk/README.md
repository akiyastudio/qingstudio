# PhotoFlow component UI contract

Use `application.settingsForm` for ordinary component preferences. PhotoFlow validates the declaration, renders native settings rows, applies defaults, and persists values through `component.settings` without loading component HTML.

When ordinary preferences also need account authorization, environment installation, or diagnostics, add `customPage` to the same `application.settingsForm`. PhotoFlow keeps one navigation item and renders the native form together with the isolated advanced region. Standalone `application.settingsPage` remains available for pages with no declarative fields. Custom pages should import `component-sdk/ui.css` and call `mountUiTheme()` from `component-sdk/index.js`.

UI contract version 1 provides design tokens and framework-free primitives for settings groups, rows, buttons, inputs, selects, switches, status badges, spinners, callouts, dialogs, and path-picker presentation. Custom pages can call `host.notify(...)` and `host.dialog(...)`; dialog file and directory results remain scoped tokens rather than raw persistent paths. `openComponentDirectory` may create and open one direct child directory strictly inside the calling component, including from its application settings surface. Other behavior continues through versioned RPC and lifecycle APIs. CSS classes never grant capabilities.

Declarative field types in schema version 1 are `toggle`, `select`, `text`, `number`, and `range`. Values are stored under the field id in the component-owned settings object. Persistent filesystem paths are intentionally excluded because component input access uses scoped tokens instead of raw path disclosure.

Settings forms may declare `help`, an array of up to 16 plain-text entries with `title` (160 characters) and `description` (2000 characters). Help appears before settings and third-party notices and does not create writable preferences. An informational form can have empty `groups` when it contains at least one help entry or notice.

For an existing native playback session, `host.setPlaybackPaused(sessionId, paused)` sends play/pause directly to the Host player without a component service round trip. It requires `component.runtime.execute` capability and permission, and validates the owning page and project scope. Its promise acknowledges dispatch; use `onPlaybackState` for the actual decoder state. Components supporting older Hosts should feature-detect this method and retain their playback RPC fallback.
