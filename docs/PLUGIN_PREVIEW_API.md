# Folder panels, playback integration, and preview decoders

English | [简体中文](PLUGIN_PREVIEW_API.zh-CN.md)

This page describes current source interfaces. Plugins implement subtitle parsing and decoders such as PSD or DOCX. The host mounts panels, provides preview state, handles seeking, and displays decoded output.

## Persistent folder-page panels

Declare a placement on an existing `component.sidePanel` contribution:

```json
{
  "type": "component.sidePanel",
  "id": "subtitles",
  "label": "Subtitles",
  "pageId": "subtitle-ui",
  "placement": "workspace.folderPanel",
  "rpcMethods": ["subtitle.load.v1"]
}
```

Declare the referenced `component.fullPage` too. Plugin panels join the same list as folder, preview, and details panels. Menus and headers share pin/close state; panels support mixed native/plugin drag ordering, Alt+Left/Right ordering, and adjacent-edge resizing. Multiple plugin panels can appear together. Closing a panel or switching file pages hides its view while retaining the body instance; closing its source page or uninstalling releases it. Pin state, order, and width are persisted. In the current source, new plugin panels are open by default, and blank-space clicks do not collapse them. Restore defaults resets order/width, restores native panels, and opens plugin panels unpinned.

The host's shared `WorkspacePanelHeader` draws the header; plugins draw only the body. Manifest `label` is the menu label, `title` the heading, and `description` the default subtitle. To show current document information, declare both capability and permission `component.panel`:

```ts
await host.setPanelInfo({ title: 'Subtitles', subtitle: 'Current video · 120 lines' });
```

Services can call `callHost(parentId, 'component.panel', {action:'update',title,subtitle})` or read with `{action:'get'}`. Only the current folder panel may change its own plain-text title (1–160 characters) and subtitle (0–240). Layout, pin state, and standard controls belong to the user and host. Do not duplicate headers, close buttons, or width sliders in the body.

Directory or selection changes rebind scope/selection and reach the UI through `onContextChange`. `workspace.folderPanel` is exclusive to `component.sidePanel`; floating panels and `workspace.videoTools` keep their existing behavior.

## Current video, position, and seeking

Declare capability `project.preview` and permission `project.preview.read`; seeking additionally needs `project.preview.control`. This applies only to project/inspiration component contexts with a source file page, never global settings.

```ts
const stop = await host.onPreviewChange(({ video }) => {
  if (!video) {
    clearSubtitleHighlight();
    return;
  }
  // A new sessionId means a new preview session: rematch and read subtitles.
  selectSubtitlesFor(video.relativePath, video.sessionId);
  highlightSubtitleAt(video.time);
});
const snapshot = await host.getPreview();
if (snapshot.video?.canSeek) {
  await host.seekPreview(snapshot.video.sessionId, subtitleStartSeconds);
}
// Call stop() when leaving the page.
```

Services can call `project.preview` with `{action:'get'}` or `{action:'seek',sessionId,time}`. Subscribe/unsubscribe requires a live component page; ordinary subtitle UIs should use SDK notifications.

```ts
{
  revision: number,
  video: null | {
    sessionId: string,
    relativePath: string,
    time: number,       // seconds
    duration: number,   // seconds
    paused: boolean,
    canSeek: boolean
  }
}
```

Position is published approximately every 250 ms with pause and duration state. Opening, switching, or closing a video updates the snapshot. Unloaded/closed previews, non-video selection, or out-of-scope video can return `null` or `canSeek:false`. This is suitable for subtitle highlighting, not frame-accurate synchronization. Messages contain only project-relative paths, with no player PID, native handle, or physical path.

State is isolated by application window, source page, workspace, project, and plugin scope. Seek must carry the recently read session ID. Changed sessions, non-seekable media, or out-of-range times conflict; lack of a page acknowledgment times out after three seconds. `accepted:true` confirms that the same preview session accepted the request; subsequent playback state gives the final position. Chromium and native backends share the player seek entry point.

## Decoders for any input format

Register in `componentHost.service.previewDecoders`. There is no fixed input-format allowlist: any valid extension, including Unicode, is accepted. `*` can receive extensionless and unknown files for content inspection.

```json
{
  "id": "documents",
  "label": "Document preview",
  "extensions": [".docx", ".psd", ".custom"],
  "method": "preview.decode.v1",
  "priority": 10
}
```

The method must belong to `service.rpcMethods`; the host marks it host-only, so ordinary component pages cannot expose it. Limits are 16 decoders per component, 64 extension rules per decoder, and priority -100 to 100. Matching order is priority, component ID, then decoder ID; explicit extensions precede `*`. Uninstall/disable refreshes supported formats.

A decoder-only component may use `componentHost.contributions:[]` without empty pages or toolbar buttons. It still requires service declarations, normal installation, and integrity checks.

Declare at least `project.input.tokens` and `component.transfer`, with permission `project.input.read`. Calls contain:

```ts
{
  input: { token: string, expiresAt: number },
  name: string,
  extension: string,
  pageIndex: number,   // zero-based
  maxEdge: number      // requested longest edge, 64–4096
}
```

1. Materialize the input through `project.input.tokens` into a service-only snapshot.
2. Decode the requested page into PNG using the plugin's engine. Neither dimension may exceed `maxEdge`.
3. Use `component.transfer` create/write/finish to obtain an output input-token, then close the session.
4. Return `{inputToken,mimeType:'image/png',pageIndex,pageCount}`. Return one page per call, with 1–10,000 total pages.

The host checks source scope, token ownership, PNG header/dimensions, then decodes and re-encodes the image for display. Output PNGs are limited to 32 MiB. HTML, scripts, arbitrary URLs, and physical paths are rejected. **Input formats are extensible; the current display contract is a bitmap preview.** Text selection, source-document editing, 3D interaction, and audio playback are outside this static protocol. Videos use the existing player/backends first; a matching static decoder can provide a preview if playback fails.

## Click and failure behavior

Clicking a non-media file with an enabled matching decoder previews it instead of immediately opening a system application. With no decoder, existing open behavior remains. Single-click preview also works in double-click-to-open mode; Ctrl/Shift selection follows file-page rules.

Decode failure shows an error, retry, and external-open button without launching another application automatically. Paging requests the specified page again. Rapid file switches discard stale responses. Each source page allows one active decode, with eight across the host; busy requests wait briefly and retry. Ordinary service timeout remains 60 seconds. Changing files stops waiting for old results but does not promise to terminate arbitrary native decoder work already started. Uninstall uses normal service supervision.

An open interface does not include every decoder. Correct format previews require an installed and enabled plugin.
