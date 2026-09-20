English | [简体中文](HOST_PLAYER_API.zh-CN.md)

# Host player v1

The application owns the playback UI, keyboard shortcuts, session lifecycle,
Chromium transport and native-backend selection. Plugins own authorized media
sources and business extensions (transcripts, crop geometry, trim ranges and
encoded previews). Each mounted player is an independent instance.

Load the application resources before the plugin's entry script:

```html
<link rel="stylesheet" href="photoflow-player://runtime/v1/player.css">
<script src="photoflow-player://runtime/v1/player.js"></script>
```

The component partition allows these exact URLs and the optional `v1/timeline.js` and `v1/timeline.css` resources. They do not grant
filesystem or media access. A plugin with a CSP must allow `photoflow-player:`
in `script-src` and `style-src`. The application packages these resources under
`artifacts/player-runtime/v1`; `scripts/build-host-player.cjs` builds them from
the same `VideoPlayer` component used by the main application. Plugin builds
and packages must not embed a copy of the player. Existing installed older
plugins may retain their old bundled player until upgraded.

Check `window.PhotoFlowPlayback?.apiVersion === 1` before initializing the
page; otherwise show an update-required message. `mount` also rejects an
incompatible version before creating a React root. A breaking API change gets
a new URL version; keep v1 available while supporting plugins that use it.

```js
const player = PhotoFlowPlayback.mount(container, {
  apiVersion: 1,
  filePath: authorizedRelativeName,
  electronApi: scopedPlaybackFacade,
  onState: ({ time, duration, paused }) => updateBusinessTimeline(time),
  onError: message => showError(message),
});
player.control({ action: 'pause' });
player.playFrom(12.5);
const stoppedAt = await player.pauseAtFrame();
player.close();
```

`scopedPlaybackFacade` adapts existing component-authorized RPCs and direct
Host playback channels. It provides `getVideoPlaybackSource`,
`getVideoPlaybackBackends`, `startVideoPlayer`, `stopVideoPlayer`,
`controlVideoPlayer`, `setVideoPlayerBounds`, `onVideoPlayerState`,
`getVideoDisplayCapabilities`, `captureVideoPlayerFrame`,
`publishVideoPlayerFrame`, `chooseVideoSubtitle`, and
`setHostSurfaceSuspended`. It never replaces `window.electronAPI`. Access to
media, sessions, native bounds, subtitles and saved frames continues through
the existing Host authorization checks. Native bounds arrive in device pixels
with a `viewportDip` rectangle; adapt to component-local DIP bounds and apply
the page's visibility, dialog and clipping rules before submitting them.

Optional mount extensions:

- `timeline`: an existing DOM node inserted above the common controls.
- `surfaceOverlay`: a DOM node inside the playback surface (e.g. a rendered
  output frame); it must not cover the controls.
- `toolbar`: a DOM node inserted into the common toolbar.
- `onNavigate`, `onMetadata`, `onReady({backendId})`: business notifications.
- `playbackEnabled`: false keeps the UI mounted without opening media.
- `controlsVisible`: false hides the toolbar for a background frame reader.
- `editorState: {time,duration,paused,ready}`: an external business timeline,
  including a still-preview state before a playable output exists.
- `onControlRequest(request)`: return true only for controls handled by the
  business workflow (e.g. generating an encoded preview on play, or rendering
  an output frame on seek); return false to use normal playback.

`update(patch)` changes options without replacing the instance's authorization
facade. Create a new instance to change its media authorization scope. The
returned API exposes `control`, `playFrom`, `pauseAtFrame`, `fullscreen`,
`refreshBounds`, `frameAt`, `backendId`, `update`, and idempotent `close`.
`frameAt(time)` pauses and seeks an authorized Chromium source, waits for the
decoded frame, and returns a PNG data URL. It returns null for a native backend
or an unavailable canvas capture; the plugin can then use its existing authorized
Host frame-extraction capability. Closing or replacing the source cancels pending
reads. Crop-frame requests do not require a second player implementation or an
optional native decoder for Chromium-readable media.
`control` is an explicit plugin command; `onControlRequest` intercepts user
transport requests only. Pause-and-mark must use `pauseAtFrame`, which waits
for native acknowledgement rather than accepting optimistic UI state.

Closing removes shared UI listeners, cancels the pending start, closes its
owned playback session, and rejects pending pause requests. Externally supplied
DOM nodes are detached, not destroyed. The plugin must also release its own
business listeners when its page is disposed.

Verification: `scripts/test-host-player-ui.cjs` runs actual Host resource URLs
and two independent native fixtures; the transcode and transcription browser
tests exercise their business flows with the same generated Host bundle.


The optional timeline bundle exposes `PhotoFlowTimeline.mount` and owns noUiSlider,
frame/timecode editing, progress dragging, trim gestures and mark gestures. Both
plugins use this implementation. Omitting `#trim-slider` disables trim UI and
leaves mark editing available; omitting mark controls gives the transcode layout.
Transcode defaults to continuous source playback with spatial transforms; the
explicit output-effect mode retains encoded trial previews for final filters,
audio processing and compression. Continuous playback never runs an encoder.


The shared timeline renders `#timeline-current` as four numeric timecode fields
(hours, minutes, seconds, frames) with fixed colon separators. Enter or leaving
the group commits; Escape restores the playback position. Up/Down adjusts the
focused unit, Left/Right moves between units, and Tab follows normal focus order.
Previous/next frame buttons are beside this editor; timeline mounts suppress the
duplicate frame buttons in the lower player toolbar. Indexed sources step through
actual frame timestamps, including VFR. `setEditorEnabled` gates the editor and
frame buttons while the plugin is busy.
