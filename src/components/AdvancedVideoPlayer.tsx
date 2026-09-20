import { useLocale } from "../i18n/react";
import { t } from "../i18n/runtime";
/* eslint-disable react-refresh/only-export-components -- directional input helpers are intentionally colocated with the player contract */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readPageTransferValue, rememberPageTransferValue, usePageTransferParticipant } from '../platform/page-transfer-state';
import { PANEL_LAYOUT_CHANGED_EVENT } from '../contracts/workspace-panels';
import type { ReactNode } from 'react';
import { Camera, Captions, Gauge, Info, Loader2, Pause, Play, Plus, Settings2, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react';
import type { VideoPlaybackBackendDescriptor, VideoPlayerState, VideoPlaybackSettings, VideoSubtitleTrack } from '../types';
import { useHostSurfaceState } from './LayerProvider';
import { readSubtitleMemory, resolveRememberedSubtitle, writeSubtitleMemory } from './video-subtitle-memory';
import { DEFAULT_SUBTITLE_FONT_SIZE, normalizeSubtitleFontSize } from '../features/app/video-player-settings';
import { discoverPlaybackBackends, startPlaybackSession } from '../platform/video-playback/playback-session';
import type { PlaybackSession, PlaybackControl } from '../platform/video-playback/playback-session';
import { DEFAULT_VIDEO_TRANSFORM, hdrModeAvailability, playbackCapabilityPresentation } from '../contracts/video-playback';
import type { VideoTransform } from '../contracts/video-playback';
import { bindingsForArrowMode, normalizeVideoShortcutBindings, resolveVideoShortcut, shortcutInputFromKeyboardEvent, shouldDeferVideoShortcutToFocusedControl, videoShortcutAllowsRepeat } from '../contracts/video-shortcuts';
import type { VideoActionId } from '../contracts/video-shortcuts';

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remaining = whole % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
    : `${minutes}:${String(remaining).padStart(2, '0')}`;
};

const PLAYBACK_SPEEDS = [0.5, 1, 1.25, 1.5, 2, 3, 4];
const SKIP_SECONDS = 5;
const SUBTITLE_FONT_SIZE_PRESETS = [{ get label() { return t("ui.small.6a7339"); }, value: 20 }, { get label() { return t("ui.medium.a567bd"); }, value: 30 }, { get label() { return t("ui.large.7d4ca7"); }, value: 40 }, { get label() { return t("ui.default.844b8c"); }, value: DEFAULT_SUBTITLE_FONT_SIZE }] as const;
const DEFAULT_VIDEO_SETTINGS: VideoPlaybackSettings = { arrowKeyAction: 'seek', subtitlesEnabled: false, subtitlePreferredLanguages: ['zh', 'chi', 'zho'], subtitleSize: DEFAULT_SUBTITLE_FONT_SIZE, subtitleStyle: 'standard', hdrMode: 'auto', toneMapping: 'auto', targetPeakNits: 400, shortcuts: {} };
const createPlaybackToken = () => globalThis.crypto?.randomUUID?.() || `video_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

type VideoDirectionalInputGroup = 'arrows' | 'forward-back';
type VideoDirectionalAction = 'navigate' | 'seek';
type VideoControlPanel = 'speed' | 'volume' | 'subtitles' | 'display' | 'basic-info' | 'info' | null;
type AddedSubtitleRequest = { phase: 'choosing' | 'awaiting-track'; requestId: string; sessionId: string; previousMemoryRestored: boolean; knownStableIds: string[]; chosenPath?: string };
const comparableSubtitlePath = (value: string | undefined) => String(value || '').trim().replace(/[\\/]+/g, '/').toLowerCase();
const videoDirectionalAction = (arrowKeyAction: VideoPlaybackSettings['arrowKeyAction'], group: VideoDirectionalInputGroup): VideoDirectionalAction => {
  if (group === 'arrows') return arrowKeyAction === 'navigate' ? 'navigate' : 'seek';
  return arrowKeyAction === 'navigate' ? 'seek' : 'navigate';
};

const videoDirectionalKeyboardInput = (key: string): { direction: -1 | 1; group: VideoDirectionalInputGroup } | null => {
  if (key === 'ArrowLeft') return { direction: -1, group: 'arrows' };
  if (key === 'ArrowRight') return { direction: 1, group: 'arrows' };
  return null;
};

const validVideoControlPanelForMode = (panel: VideoControlPanel, chromiumMode: boolean): VideoControlPanel => {
  if (panel === 'basic-info' && !chromiumMode || panel === 'info' && chromiumMode) return null;
  return panel;
};

const shouldRestoreVideoSurfaceFocus = (focusWasInRemovedControl: boolean, activeElementIsDocumentFallback: boolean, surfaceAlreadyFocused: boolean) =>
  focusWasInRemovedControl && (activeElementIsDocumentFallback || surfaceAlreadyFocused);

type VideoPlayerProps = {
  filePath: string;
  poster?: string;
  onError: (message: string) => void;
  onMetadata: (metadata: { width?: number; height?: number; duration?: number }) => void;
  onNavigate?: (direction: -1 | 1) => void;
  onContextMenuAt?: (x: number, y: number) => void;
  onPointerActivity?: () => void;
  topRightOverlayHole?: number;
  controlsVisible?: boolean;
  controlsOverlay?: boolean;
  onEscape?: () => void;
  onToggleFullscreen?: () => void;
  bottomControls?: ReactNode;
  controlsFooter?: ReactNode;
  progressRail?: ReactNode;
  toolbarExtras?: ReactNode;
  externalTimeline?: boolean;
  editorControlRequest?: { id: number; control: PlaybackControl };
  editorSeekRequest?: { id: number; time: number; pause?: boolean };
  onPlaybackState?: (state: { time: number; duration: number; paused: boolean }) => void;
  keyboardSettings?: VideoPlaybackSettings;
};

const initialState = (): VideoPlayerState => ({
  sessionId: '',
  playerId: '',
  requestId: '',
  type: 'loading',
  paused: true,
  buffering: true,
  volume: 100,
  muted: false,
  speed: 1,
  time: 0,
  duration: 0,
});

const VideoPlayer = ({ filePath, poster, onError, onMetadata, onNavigate, onContextMenuAt, onPointerActivity, topRightOverlayHole = 0, controlsVisible = true, controlsOverlay = false, onEscape, onToggleFullscreen, bottomControls, controlsFooter, progressRail, toolbarExtras, externalTimeline = false, editorControlRequest, editorSeekRequest, onPlaybackState, keyboardSettings = DEFAULT_VIDEO_SETTINGS }: VideoPlayerProps) => {
  useLocale();
  const { suspended: hostSurfaceSuspended } = useHostSurfaceState();
  const navigate = onNavigate || (() => undefined);
  const showNavigation = Boolean(onNavigate);
  const playerRootRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlPanelRef = useRef<HTMLDivElement>(null);
  const speedTriggerRef = useRef<HTMLButtonElement>(null);
  const subtitlesTriggerRef = useRef<HTMLButtonElement>(null);
  const displayTriggerRef = useRef<HTMLButtonElement>(null);
  const basicInfoTriggerRef = useRef<HTMLButtonElement>(null);
  const infoTriggerRef = useRef<HTMLButtonElement>(null);
  const volumeTriggerRef = useRef<HTMLButtonElement>(null);
  const suppressPanelFocusOpenRef = useRef<'speed' | 'volume' | null>(null);
  const builtInControlsFocusedRef = useRef(false);
  const subtitlesControlFocusedRef = useRef(false);
  const informationControlFocusedRef = useRef<'basic-info' | 'info' | null>(null);
  const surfaceFocusFrameRef = useRef(0);
  const controlsOverlayRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<PlaybackSession | null>(null);
  const playerIdRef = useRef(createPlaybackToken());
  const requestIdRef = useRef('');
  const errorReportedRef = useRef(false);
  const metadataKeyRef = useRef('');
  const onErrorRef = useRef(onError);
  const onMetadataRef = useRef(onMetadata);
  const onNavigateRef = useRef(navigate);
  const onContextMenuAtRef = useRef(onContextMenuAt);
  const onPointerActivityRef = useRef(onPointerActivity);
  const onEscapeRef = useRef(onEscape);
  const onToggleFullscreenRef = useRef(onToggleFullscreen);
  const shortcutActionRef = useRef<(action: VideoActionId) => void>(() => undefined);
  const dispatchShortcutRef = useRef<(action: VideoActionId, repeat?: boolean) => void>(() => undefined);
  const onPlaybackStateRef = useRef(onPlaybackState);
  const playbackPositionRef = useRef({ time: 0, duration: 0, paused: true });
  const nativeContextMenuOpenRef = useRef(false);
  const displayCapabilityGenerationRef = useRef(0);
  const captureGenerationRef = useRef(0);
  const captureInFlightRef = useRef(false);
  onErrorRef.current = onError;
  onMetadataRef.current = onMetadata;
  onNavigateRef.current = navigate;
  onContextMenuAtRef.current = onContextMenuAt;
  onPointerActivityRef.current = onPointerActivity;
  onEscapeRef.current = onEscape;
  onToggleFullscreenRef.current = onToggleFullscreen;
  onPlaybackStateRef.current = onPlaybackState;
  const [sessionId, setSessionId] = useState('');
  const [starting, setStarting] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [captureNotice, setCaptureNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [controlPanel, setControlPanel] = useState<VideoControlPanel>(null);
  const controlPanelIds = useMemo(() => ({
    speed: `${playerIdRef.current}-speed-panel`,
    subtitles: `${playerIdRef.current}-subtitles-panel`,
    display: `${playerIdRef.current}-display-panel`,
    basicInfo: `${playerIdRef.current}-basic-info-panel`,
    info: `${playerIdRef.current}-info-panel`,
    volume: `${playerIdRef.current}-volume-panel`,
  }), []);
  const [videoTransform, setVideoTransform] = useState<VideoTransform>(DEFAULT_VIDEO_TRANSFORM);
  const [activeBackendId, setActiveBackendId] = useState('');
  const chromiumMode = activeBackendId === 'core.chromium';
  const [availableBackends, setAvailableBackends] = useState<VideoPlaybackBackendDescriptor[]>([]);
  const [displayCapability, setDisplayCapability] = useState({ hdrAvailable: false, reason: '尚未检测当前显示器' });
  const activeBackend = availableBackends.find(item => item.backendId === activeBackendId);
  const capabilityPresentation = playbackCapabilityPresentation(activeBackend?.features, displayCapability.hdrAvailable);
  const hdrAvailability = hdrModeAvailability({ requested: keyboardSettings.hdrMode, hdrFeatures: activeBackend?.features.hdr, hdrDisplayAvailable: displayCapability.hdrAvailable, toneMapping: keyboardSettings.toneMapping });
  const effectiveControlPanel = validVideoControlPanelForMode(controlPanel, chromiumMode);
  const [subtitleFontSize, setSubtitleFontSize] = useState(() => normalizeSubtitleFontSize(keyboardSettings.subtitleSize));
  const subtitleMemoryRestoredRef = useRef(false);
  const rememberAddedSubtitleRef = useRef<AddedSubtitleRequest | null>(null);
  const [state, setState] = useState<VideoPlayerState>(initialState);
  const latestStateRef = useRef(state);
  latestStateRef.current = state;
  const latestTransformRef = useRef(videoTransform);
  latestTransformRef.current = videoTransform;
  const playingBeforeTransfer = useRef(false);
  const transferPrepared = useRef(false);
  const playbackSnapshot = () => {
    const value = latestStateRef.current;
    return { time: Number(value.time) || 0, paused: value.paused !== false, volume: value.volume ?? 100, muted: Boolean(value.muted), speed: value.speed || 1, transform: latestTransformRef.current };
  };
  const transferPageId = usePageTransferParticipant(`video:${filePath}`, {
    read: playbackSnapshot,
    prepare: () => { transferPrepared.current = true; playingBeforeTransfer.current = latestStateRef.current.paused === false; sessionRef.current?.control({ action: 'pause' }); },
    rollback: () => { if (transferPrepared.current && playingBeforeTransfer.current) sessionRef.current?.control({ action: 'play' }); transferPrepared.current = false; },
  });
  const restoredPlayback = useRef('');
  useEffect(() => {
    if (!sessionId || starting || restoredPlayback.current === sessionId) return;
    restoredPlayback.current = sessionId;
    const saved = readPageTransferValue<ReturnType<typeof playbackSnapshot> | null>(transferPageId, `video:${filePath}`, () => null);
    if (!saved || !sessionRef.current) return;
    for (const [action, value] of [['seek', saved.time], ['volume', saved.volume], ['mute', saved.muted], ['speed', saved.speed]] as const) sessionRef.current.control({ action, value });
    if (saved.transform) { setVideoTransform(saved.transform); sessionRef.current.control({ action: 'transform', transform: saved.transform }); }
    sessionRef.current.control({ action: saved.paused ? 'pause' : 'play' });
  }, [filePath, sessionId, starting, transferPageId]);
  useEffect(() => () => rememberPageTransferValue(transferPageId, `video:${filePath}`, playbackSnapshot()), [filePath, transferPageId]);
  const consumeAddedSubtitle = (nextState = latestStateRef.current) => {
    const pending = rememberAddedSubtitleRef.current;
    if (!pending || pending.phase !== 'awaiting-track' || pending.requestId !== requestIdRef.current || pending.sessionId !== sessionId || !nextState.subtitleTracks?.length) return;
    const known = new Set(pending.knownStableIds);
    const chosenPath = comparableSubtitlePath(pending.chosenPath);
    const candidates = nextState.subtitleTracks.filter(track => !known.has(track.stableId) || Boolean(chosenPath && comparableSubtitlePath(track.path) === chosenPath));
    const selected = candidates.find(track => track.id === String(nextState.subtitleTrackId ?? '')) || candidates.find(track => track.selected) || candidates.find(track => Boolean(chosenPath && comparableSubtitlePath(track.path) === chosenPath));
    if (!selected) return;
    rememberAddedSubtitleRef.current = null;
    try { writeSubtitleMemory(localStorage, filePath, { selection: { mode: 'track', stableId: selected.stableId }, delay: Number(nextState.subtitleDelay) || 0, visible: nextState.subtitleVisible !== false, updatedAt: Date.now() }); } catch { /* storage can be unavailable */ }
  };
  const restoreRememberedSubtitle = (tracks: readonly VideoSubtitleTrack[]) => {
    if (subtitleMemoryRestoredRef.current || !sessionRef.current || !tracks.length) return;
    let memory;
    try { memory = readSubtitleMemory(localStorage, filePath); } catch { return; }
    const resolution = resolveRememberedSubtitle(memory, tracks);
    if (resolution.mode === 'default') { subtitleMemoryRestoredRef.current = true; return; }
    if (resolution.mode === 'missing') return;
    subtitleMemoryRestoredRef.current = true;
    if (resolution.mode === 'off') {
      sessionRef.current.control({ action: 'subtitle-select', value: '' });
      sessionRef.current.control({ action: 'subtitle-delay', value: resolution.delay });
      return;
    }
    sessionRef.current.control({ action: 'subtitle-select', value: resolution.track.id });
    sessionRef.current.control({ action: 'subtitle-delay', value: resolution.delay });
    sessionRef.current.control({ action: 'subtitle-visible', value: resolution.visible });
  };
  const shortcutBindings = useMemo(() => bindingsForArrowMode(normalizeVideoShortcutBindings(keyboardSettings.shortcuts), keyboardSettings.arrowKeyAction), [keyboardSettings.arrowKeyAction, keyboardSettings.shortcuts]);
  const scheduleSurfaceFocusRestore = useCallback((focusWasInRemovedControl: boolean) => {
    if (!focusWasInRemovedControl) return;
    window.cancelAnimationFrame(surfaceFocusFrameRef.current);
    surfaceFocusFrameRef.current = window.requestAnimationFrame(() => {
      surfaceFocusFrameRef.current = 0;
      const activeElement = document.activeElement;
      const activeElementIsDocumentFallback = !activeElement || activeElement === document.body || activeElement === document.documentElement;
      const surfaceAlreadyFocused = activeElement === surfaceRef.current;
      if (shouldRestoreVideoSurfaceFocus(focusWasInRemovedControl, activeElementIsDocumentFallback, surfaceAlreadyFocused)) surfaceRef.current?.focus();
    });
  }, []);

  useEffect(() => () => window.cancelAnimationFrame(surfaceFocusFrameRef.current), []);

  useEffect(() => setSubtitleFontSize(normalizeSubtitleFontSize(keyboardSettings.subtitleSize)), [keyboardSettings.subtitleSize]);
  useEffect(()=>{if(!sessionRef.current||chromiumMode)return;sessionRef.current.control({action:'hdr-mode',hdrMode:keyboardSettings.hdrMode});sessionRef.current.control({action:'tone-mapping',toneMapping:keyboardSettings.toneMapping,targetPeakNits:keyboardSettings.targetPeakNits});},[chromiumMode,keyboardSettings.hdrMode,keyboardSettings.toneMapping,keyboardSettings.targetPeakNits,sessionId]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const requestId = createPlaybackToken();
    requestIdRef.current = requestId;
    sessionRef.current = null;
    nativeContextMenuOpenRef.current = false;
    errorReportedRef.current = false;
    metadataKeyRef.current = '';
    setStarting(true);
    setSessionId('');
    setCapturing(false);
    captureGenerationRef.current += 1;
    captureInFlightRef.current = false;
    setCaptureNotice(null);
    setControlPanel(null);
    setVideoTransform(DEFAULT_VIDEO_TRANSFORM);
    setActiveBackendId('');
    setAvailableBackends([]);
    subtitleMemoryRestoredRef.current = false;
    rememberAddedSubtitleRef.current = null;
    setState(initialState());
    const handleState = (update: VideoPlayerState) => {
      if (update.playerId !== playerIdRef.current || update.requestId !== requestIdRef.current) return;
      if (sessionRef.current) setActiveBackendId(sessionRef.current.backendId);
      if (update.type === 'input' && update.input) {
        const input = update.input;
        if (input.kind === 'pointer-move') onPointerActivityRef.current?.();
        else if (input.kind === 'pointer-button' && input.button === 'left') {
          dispatchShortcutRef.current('video.playPause', input.repeat === true);
        } else if (input.kind === 'pointer-button' && input.button === 'right') {
          if (!onContextMenuAtRef.current) return;
          const rect = surfaceRef.current?.getBoundingClientRect();
          if (rect) {
            nativeContextMenuOpenRef.current = true;
            sessionRef.current?.setBounds({ x: 0, y: 0, width: 0, height: 0, visible: false });
            onContextMenuAtRef.current(rect.left + Number(input.x || 0), rect.top + Number(input.y || 0));
          }
        } else if (input.kind === 'key') {
          const action = resolveVideoShortcut({ key: input.key || '', code: input.code || input.key || '', ctrl: input.ctrl === true, alt: input.alt === true, shift: input.shift === true, meta: input.meta === true, repeat: input.repeat === true }, shortcutBindings, { scope: 'player' });
          if (action) dispatchShortcutRef.current(action, input.repeat === true);
        }
        return;
      }
      if (update.type === 'navigate') {
        dispatchShortcutRef.current(update.direction === -1 ? 'media.previous' : 'media.next');
        return;
      }
      if (update.type === 'context-menu') {
        if (!onContextMenuAtRef.current) return;
        const rect = surfaceRef.current?.getBoundingClientRect();
        if (rect) {
          nativeContextMenuOpenRef.current = true;
          sessionRef.current?.setBounds({ x: 0, y: 0, width: 0, height: 0, visible: false });
          onContextMenuAtRef.current(rect.left + Number(update.x || 0), rect.top + Number(update.y || 0));
        }
        return;
      }
      if (update.type === 'pointer-activity') {
        onPointerActivityRef.current?.();
        return;
      }
      if (update.type === 'escape') {
        onEscapeRef.current?.();
        return;
      }
      if (update.type === 'fatal' || update.type === 'error') {
        if (!errorReportedRef.current) {
          errorReportedRef.current = true;
          onErrorRef.current(update.error || 'Chromium 与高级视频解码组件均无法播放此视频；请安装或修复高级解码组件，或使用系统播放器');
        }
        return;
      }
      if (update.type === 'display-output' && update.display) {
        displayCapabilityGenerationRef.current += 1;
        setDisplayCapability({ hdrAvailable: update.display.hdrAvailable, reason: update.display.reason });
      }
      if (update.type === 'stopped') {
        setStarting(false);
        setState(current => ({ ...current, ...update, paused: true, time: 0, buffering: false }));
      } else if (update.type === 'subtitle-tracks') {
        setState(current => ({ ...current, ...update }));
      } else if (update.type === 'loading') setState(current => ({ ...current, ...update, buffering: true }));
      else if (update.type === 'file-loaded') {
        setStarting(false);
        setState(current => ({ ...current, ...update, buffering: false }));
      } else if (update.type === 'ended') setState(current => ({ ...current, ...update, paused: true, time: current.duration || current.time }));
      else {
        if (update.type === 'state' && update.buffering === false) setStarting(false);
        setState(current => ({ ...current, ...update }));
      }
      if (update.type === 'diagnostic' && update.diagnostic?.severity === 'warning') {
        setCaptureNotice({ text: update.diagnostic.message || update.diagnostic.code, error: true });
      }
    };
    const video = videoRef.current;
    if (!video) return undefined;
    void discoverPlaybackBackends({ filePath, video, electronApi: window.electronAPI, signal: controller.signal }).then(backends => startPlaybackSession({
      backends,
      context: {
        filePath,
        settings: keyboardSettings,
        playerId: playerIdRef.current,
        requestId,
        video,
        electronApi: window.electronAPI,
        onState: handleState,
        signal: controller.signal,
      },
    })).then(session => {
      if (!active || requestIdRef.current !== requestId) {
        void session.close().catch(() => undefined);
        return;
      }
      sessionRef.current = session;
      setActiveBackendId(session.backendId);
      setAvailableBackends(session.availableBackends || []);
      setSessionId(requestId);
    }).catch(error => {
      if (active && (error as { code?: string })?.code !== 'CANCELLED' && !errorReportedRef.current) {
        errorReportedRef.current = true;
        onErrorRef.current(`视频无法播放：${error instanceof Error ? error.message : String(error)}。请安装或修复高级解码组件，或使用系统播放器。`);
      }
    });
    return () => {
      active = false;
      controller.abort();
      captureGenerationRef.current += 1;
      if (requestIdRef.current === requestId) requestIdRef.current = '';
      const currentSession = sessionRef.current;
      sessionRef.current = null;
      void currentSession?.close().catch(() => undefined);
    };
  }, [filePath, keyboardSettings.arrowKeyAction, keyboardSettings.subtitlesEnabled, keyboardSettings.subtitlePreferredLanguages.join(','), keyboardSettings.subtitleSize, keyboardSettings.subtitleStyle, JSON.stringify(keyboardSettings.shortcuts)]);

  useEffect(() => {
    if (!sessionId) return;
    restoreRememberedSubtitle(state.subtitleTracks || []);
  }, [filePath, sessionId, state.subtitleTracks]);

  useEffect(() => {
    consumeAddedSubtitle(state);
  }, [filePath, sessionId, state.subtitleDelay, state.subtitleTrackId, state.subtitleTracks, state.subtitleVisible]);

  useEffect(() => {
    if (!captureNotice) return;
    const timer = window.setTimeout(() => setCaptureNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [captureNotice]);

  useEffect(() => {
    if (controlsVisible) return;
    setControlPanel(null);
    const focusWasInRemovedControl = builtInControlsFocusedRef.current;
    builtInControlsFocusedRef.current = false;
    subtitlesControlFocusedRef.current = false;
    informationControlFocusedRef.current = null;
    scheduleSurfaceFocusRestore(focusWasInRemovedControl);
  }, [controlsVisible, scheduleSurfaceFocusRestore]);

  useEffect(() => {
    if (capabilityPresentation.subtitlesAvailable) return;
    setControlPanel(current => current === 'subtitles' ? null : current);
    const focusWasInRemovedControl = subtitlesControlFocusedRef.current;
    subtitlesControlFocusedRef.current = false;
    if (focusWasInRemovedControl) builtInControlsFocusedRef.current = false;
    scheduleSurfaceFocusRestore(focusWasInRemovedControl);
  }, [capabilityPresentation.subtitlesAvailable, scheduleSurfaceFocusRestore]);

  useEffect(() => {
    if (effectiveControlPanel === controlPanel) return;
    const focusWasInRemovedControl = informationControlFocusedRef.current === controlPanel;
    informationControlFocusedRef.current = null;
    if (focusWasInRemovedControl) builtInControlsFocusedRef.current = false;
    setControlPanel(effectiveControlPanel);
    scheduleSurfaceFocusRestore(focusWasInRemovedControl);
  }, [controlPanel, effectiveControlPanel, scheduleSurfaceFocusRestore]);

  useEffect(() => {
    if (!sessionRef.current) return;
    const descriptor = sessionRef.current.availableBackends?.find(item => item.backendId === sessionRef.current?.backendId);
    const stats = descriptor?.features.statistics; const level = stats && (stats.decode || stats.hdr || stats.cache || stats.gpu) ? 'detailed' : 'basic';
    sessionRef.current.control({ action: 'statistics-level', statisticsLevel: effectiveControlPanel === 'info' || effectiveControlPanel === 'basic-info' ? level : 'off' });
  }, [activeBackendId, effectiveControlPanel, sessionId]);

  useEffect(() => {
    if (controlPanel !== 'display') return;
    const generation = displayCapabilityGenerationRef.current;
    void window.electronAPI.getVideoDisplayCapabilities().then(result => {
      if (result.success && generation === displayCapabilityGenerationRef.current) setDisplayCapability({ hdrAvailable: result.display.hdrAvailable, reason: result.display.reason });
    });
  }, [controlPanel]);

  const syncBounds = useCallback(() => {
    const surface = surfaceRef.current;
    if (!surface || !sessionRef.current) return;
    const rect = surface.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    const panelElement = controlPanelRef.current?.firstElementChild as HTMLElement | null;
    const panelRect = panelElement?.getBoundingClientRect();
    const panelRadius = panelElement ? Number.parseFloat(window.getComputedStyle(panelElement).borderTopLeftRadius) || 0 : 0;
    const panelLeft = panelRect ? Math.max(rect.left, panelRect.left) : 0;
    const panelTop = panelRect ? Math.max(rect.top, panelRect.top) : 0;
    const panelRight = panelRect ? Math.min(rect.right, panelRect.right) : 0;
    const panelBottom = panelRect ? Math.min(rect.bottom, panelRect.bottom) : 0;
    const overlayHole = panelRect && panelRight > panelLeft && panelBottom > panelTop ? {
      x: Math.round((panelLeft - rect.left) * scale),
      y: Math.round((panelTop - rect.top) * scale),
      width: Math.round((panelRight - panelLeft) * scale),
      height: Math.round((panelBottom - panelTop) * scale),
      radius: Math.round(panelRadius * scale),
    } : undefined;
    const controlsRect = controlsOverlay && controlsVisible ? controlsOverlayRef.current?.getBoundingClientRect() : undefined;
    const controlsLeft = controlsRect ? Math.max(rect.left, controlsRect.left) : 0;
    const controlsTop = controlsRect ? Math.max(rect.top, controlsRect.top) : 0;
    const controlsRight = controlsRect ? Math.min(rect.right, controlsRect.right) : 0;
    const controlsBottom = controlsRect ? Math.min(rect.bottom, controlsRect.bottom) : 0;
    const controlsOverlayHole = controlsRect && controlsRight > controlsLeft && controlsBottom > controlsTop ? {
      x: Math.round((controlsLeft - rect.left) * scale),
      y: Math.round((controlsTop - rect.top) * scale),
      width: Math.round((controlsRight - controlsLeft) * scale),
      height: Math.round((controlsBottom - controlsTop) * scale),
    } : undefined;
    const cornerSize = Math.max(0, Math.min(rect.width, rect.height, topRightOverlayHole));
    const cornerInset = Math.min(10, Math.max(0, (Math.min(rect.width, rect.height) - cornerSize) / 2));
    const cornerOverlayHole = cornerSize > 0 ? {
      x: Math.round((rect.width - cornerSize - cornerInset) * scale),
      y: Math.round(cornerInset * scale),
      width: Math.round(cornerSize * scale),
      height: Math.round(cornerSize * scale),
    } : undefined;
    const visible = !hostSurfaceSuspended && !nativeContextMenuOpenRef.current && document.visibilityState === 'visible' && rect.width > 1 && rect.height > 1
      && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
    sessionRef.current.setBounds({
      x: Math.round(rect.left * scale),
      y: Math.round(rect.top * scale),
      width: Math.round(rect.width * scale),
      height: Math.round(rect.height * scale),
      visible,
      viewportDip: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      overlayHole,
      controlsOverlayHole,
      cornerOverlayHole,
    });
  }, [controlsOverlay, controlsVisible, hostSurfaceSuspended, topRightOverlayHole]);

  useEffect(() => {
    if (!sessionId) return;
    let frame = 0;
    let windowPosition = `${window.screenX}:${window.screenY}:${window.devicePixelRatio}`;
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(syncBounds);
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    if (surfaceRef.current) observer.observe(surfaceRef.current);
    if (controlPanelRef.current) observer.observe(controlPanelRef.current);
    const panelElement = controlPanelRef.current?.firstElementChild;
    if (panelElement) observer.observe(panelElement);
    if (controlsOverlayRef.current) observer.observe(controlsOverlayRef.current);
    window.addEventListener('resize', schedule);
    window.addEventListener(PANEL_LAYOUT_CHANGED_EVENT, schedule);
    window.addEventListener('scroll', schedule, true);
    document.addEventListener('visibilitychange', schedule);
    const moveTimer = window.setInterval(() => {
      const nextPosition = `${window.screenX}:${window.screenY}:${window.devicePixelRatio}`;
      if (nextPosition !== windowPosition) { windowPosition = nextPosition; schedule(); }
    }, 500);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(moveTimer);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener(PANEL_LAYOUT_CHANGED_EVENT, schedule);
      window.removeEventListener('scroll', schedule, true);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [controlPanel, sessionId, syncBounds]);

  useEffect(() => {
    if (!sessionId) return;
    const frame = window.requestAnimationFrame(syncBounds);
    return () => window.cancelAnimationFrame(frame);
  }, [controlPanel, controlsOverlay, controlsVisible, sessionId, syncBounds]);

  useEffect(() => {
    const width = Number(state.width) || 0;
    const height = Number(state.height) || 0;
    const duration = Number(state.duration) || 0;
    if (!width && !height && !duration) return;
    const key = `${width}:${height}:${duration}`;
    if (metadataKeyRef.current === key) return;
    metadataKeyRef.current = key;
    onMetadataRef.current({ width: width || undefined, height: height || undefined, duration: duration || undefined });
  }, [state.width, state.height, state.duration]);

  const control = (action: 'play' | 'pause' | 'seek' | 'volume' | 'mute' | 'speed' | 'stop' | 'subtitle-select' | 'subtitle-visible' | 'subtitle-delay', value?: number | boolean | string) => {
    if (!sessionRef.current) return;
    sessionRef.current.control({ action, value });
  };
  const paused = state.paused !== false;
  const duration = Math.max(0, Number(state.duration) || 0);
  const time = Math.max(0, Math.min(duration || Number.MAX_SAFE_INTEGER, Number(state.time) || 0));
  playbackPositionRef.current = { time, duration, paused };
  const speed = Math.max(0.25, Math.min(4, Number(state.speed) || 1));
  const muted = Boolean(state.muted);
  const volume = Math.max(0, Math.min(100, Number(state.volume) || 0));
  const togglePlayback = () => {
    const action = playbackPositionRef.current.paused ? 'play' : 'pause';
    playbackPositionRef.current.paused = action !== 'play';
    control(action);
  };
  const cyclePlaybackSpeed = () => {
    const currentIndex = PLAYBACK_SPEEDS.findIndex(value => Math.abs(value - speed) < 0.001);
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % PLAYBACK_SPEEDS.length : 0;
    control('speed', PLAYBACK_SPEEDS[nextIndex]);
  };
  const changeVolume = (nextVolume: number) => {
    if (muted) control('mute', false);
    control('volume', nextVolume);
  };
  const closeControlPanelToTrigger = (panel: NonNullable<VideoControlPanel>, trigger: HTMLButtonElement | null) => {
    setControlPanel(current => current === panel ? null : current);
    window.requestAnimationFrame(() => {
      if (panel === 'speed' || panel === 'volume') suppressPanelFocusOpenRef.current = panel;
      trigger?.focus();
      suppressPanelFocusOpenRef.current = null;
    });
  };
  const closeControlPanelOnEscape = (event: React.KeyboardEvent<HTMLDivElement>, panel: NonNullable<VideoControlPanel>, trigger: HTMLButtonElement | null) => {
    if (event.key !== 'Escape' || controlPanel !== panel) return;
    event.preventDefault();
    event.stopPropagation();
    closeControlPanelToTrigger(panel, trigger);
  };

  useEffect(() => {
    onPlaybackStateRef.current?.({ time, duration, paused });
  }, [time, duration, paused]);

  useEffect(() => {
    if (!sessionId || !editorSeekRequest) return;
    if (editorSeekRequest.pause) control('pause');
    control('seek', editorSeekRequest.time);
  }, [sessionId, editorSeekRequest?.id]);
  useEffect(() => { if (sessionId && editorControlRequest) sessionRef.current?.control(editorControlRequest.control); }, [sessionId, editorControlRequest]);
  const seekRelative = useCallback((seconds: number) => {
    if (!sessionRef.current) return;
    const current = playbackPositionRef.current;
    const nextTime = Math.max(0, Math.min(current.duration || Number.MAX_SAFE_INTEGER, current.time + seconds));
    current.time = nextTime;
    sessionRef.current.control({ action: 'seek', value: nextTime });
  }, []);

  useEffect(() => {
    let restoreTimer = 0;
    const restoreAfterMenuAction = () => {
      if (!nativeContextMenuOpenRef.current) return;
      window.clearTimeout(restoreTimer);
      restoreTimer = window.setTimeout(() => {
        nativeContextMenuOpenRef.current = false;
        syncBounds();
      }, 120);
    };
    window.addEventListener('pointerdown', restoreAfterMenuAction, true);
    window.addEventListener('keydown', restoreAfterMenuAction, true);
    return () => {
      window.clearTimeout(restoreTimer);
      window.removeEventListener('pointerdown', restoreAfterMenuAction, true);
      window.removeEventListener('keydown', restoreAfterMenuAction, true);
    };
  }, [syncBounds]);
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const visiblePlayers = [...document.querySelectorAll<HTMLElement>('[data-video-player="true"]')]
        .filter(player => player.getClientRects().length > 0);
      if (visiblePlayers.length > 1 && !playerRootRef.current?.contains(document.activeElement)) return;
      if (event.key === 'Escape') {
        const openPanelTrigger = controlPanel === 'speed' ? speedTriggerRef.current
          : controlPanel === 'volume' ? volumeTriggerRef.current
            : controlPanel === 'subtitles' ? subtitlesTriggerRef.current
              : controlPanel === 'display' ? displayTriggerRef.current
                : controlPanel === 'basic-info' ? basicInfoTriggerRef.current
                  : controlPanel === 'info' ? infoTriggerRef.current : null;
        if (controlPanel) {
          event.preventDefault();
          event.stopPropagation();
          if (openPanelTrigger) closeControlPanelToTrigger(controlPanel, openPanelTrigger);
          else setControlPanel(null);
          return;
        }
      }
      const target = event.target as HTMLElement | null;
      const editable = Boolean(target?.closest('input, textarea, select, [contenteditable="true"]'));
      const focusedControl = target?.closest('button, a[href], [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]');
      const shortcutInput = shortcutInputFromKeyboardEvent(event);
      if (shouldDeferVideoShortcutToFocusedControl(shortcutInput, Boolean(focusedControl))) return;
      const action = resolveVideoShortcut(shortcutInput, shortcutBindings, { editable, scope: 'player' });
      if (!action) return;
      if ((action === 'media.previous' || action === 'media.next') && !showNavigation) return;
      event.preventDefault();
      event.stopPropagation();
      dispatchShortcutRef.current(action, event.repeat);
    };
    window.addEventListener('keydown', handleShortcut);
    return () => {
      window.removeEventListener('keydown', handleShortcut);
    };
  }, [controlPanel, shortcutBindings, showNavigation]);
  const captureFrame = async () => {
    const currentSession = sessionRef.current;
    if (!currentSession || captureInFlightRef.current) return;
    const generation = captureGenerationRef.current;
    const requestId = requestIdRef.current;
    captureInFlightRef.current = true;
    setCapturing(true);
    setCaptureNotice(null);
    try {
      const descriptor = currentSession.availableBackends?.find(item => item.backendId === currentSession.backendId);
      const result = descriptor?.features.capture.displayedFrame
        ? await currentSession.capture()
        : await currentSession.capture('sourceFrame');
      if (generation !== captureGenerationRef.current || requestId !== requestIdRef.current || currentSession !== sessionRef.current) return;
      setCaptureNotice(result.success
        ? { text: '当前帧已保存' }
        : { text: result.error || '截图失败', error: true });
    } catch (error) {
      if (generation !== captureGenerationRef.current || requestId !== requestIdRef.current || currentSession !== sessionRef.current) return;
      setCaptureNotice({ text: error instanceof Error ? error.message : '截图失败', error: true });
    } finally {
      if (generation === captureGenerationRef.current && requestId === requestIdRef.current && currentSession === sessionRef.current) {
        captureInFlightRef.current = false;
        setCapturing(false);
      }
    }
  };
  const subtitleTracks = state.subtitleTracks || [];
  const selectedSubtitle = subtitleTracks.find(track => track.id === String(state.subtitleTrackId ?? '')) || subtitleTracks.find(track => track.selected);
  const subtitleDelay = Math.max(-30, Math.min(30, Number(state.subtitleDelay) || 0));
  const audioTracks = state.audioTracks || [];
  const rememberSubtitle = (track: VideoSubtitleTrack | undefined = selectedSubtitle, delay = subtitleDelay, visible = state.subtitleVisible !== false) => {
    if (!track) return;
    try { writeSubtitleMemory(localStorage, filePath, { selection: { mode: 'track', stableId: track.stableId }, delay, visible, updatedAt: Date.now() }); } catch { /* storage can be unavailable */ }
  };
  const disableSubtitles = () => {
    control('subtitle-select', '');
    try { writeSubtitleMemory(localStorage, filePath, { selection: { mode: 'off' }, delay: subtitleDelay, visible: false, updatedAt: Date.now() }); } catch { /* storage can be unavailable */ }
  };
  const selectSubtitle = (id: string) => {
    control('subtitle-select', id);
    const track = subtitleTracks.find(item => item.id === id);
    if (track) rememberSubtitle(track, subtitleDelay, true);
  };
  const changeSubtitleDelay = (delay: number) => {
    const bounded = Math.max(-30, Math.min(30, delay));
    control('subtitle-delay', bounded);
    rememberSubtitle(selectedSubtitle, bounded);
  };
  const changeSubtitleFontSize = (fontSize: number) => {
    const normalized = normalizeSubtitleFontSize(fontSize);
    setSubtitleFontSize(normalized);
    sessionRef.current?.control({ action: 'subtitle-style', fontSize: normalized, style: keyboardSettings.subtitleStyle });
  };
  const addSubtitle = async () => {
    if (!sessionRef.current) return;
    // Choosing a new subtitle is an explicit override of a remembered "off" state.
    const previousMemoryRestored = subtitleMemoryRestoredRef.current;
    subtitleMemoryRestoredRef.current = true;
    const currentSession = sessionRef.current;
    const requestId = requestIdRef.current;
    const marker: AddedSubtitleRequest = { phase: 'choosing', requestId, sessionId, previousMemoryRestored, knownStableIds: subtitleTracks.map(track => track.stableId) };
    rememberAddedSubtitleRef.current = marker;
    const chosen = await currentSession.chooseSubtitle();
    if (currentSession !== sessionRef.current || requestId !== requestIdRef.current) return;
    if (!chosen.success || chosen.cancelled) {
      if (rememberAddedSubtitleRef.current !== marker) return;
      rememberAddedSubtitleRef.current = null;
      subtitleMemoryRestoredRef.current = previousMemoryRestored;
      if (!previousMemoryRestored) restoreRememberedSubtitle(latestStateRef.current.subtitleTracks || []);
      if (!chosen.success) setCaptureNotice({ text: chosen.requiresFeature ? `${chosen.error}；可在显示设置中切换后端` : chosen.error || '字幕加载失败', error: true });
      return;
    }
    if (rememberAddedSubtitleRef.current !== marker) return;
    rememberAddedSubtitleRef.current = { ...marker, phase: 'awaiting-track', chosenPath: chosen.path };
    consumeAddedSubtitle(latestStateRef.current);
  };
  const changeTransform = (patch: Partial<VideoTransform>) => {
    const next = { ...videoTransform, ...patch };
    setVideoTransform(next);
    sessionRef.current?.control({ action: 'transform', transform: next });
  };
  const switchPlaybackBackend = async (backendId: string) => {
    const currentSession = sessionRef.current;
    const requestId = requestIdRef.current;
    const result = await currentSession?.switchBackend?.(backendId);
    if (currentSession !== sessionRef.current || requestId !== requestIdRef.current) return;
    if (!result?.success) setCaptureNotice({ text: result?.error || '无法切换播放后端', error: true });
    else { setActiveBackendId(sessionRef.current?.backendId || backendId); setCaptureNotice({ text: '播放后端已切换' }); }
  };
  shortcutActionRef.current = action => {
    if (action === 'video.playPause') togglePlayback();
    else if (action === 'video.stop') control('stop');
    else if (action === 'video.seekBackward') seekRelative(-SKIP_SECONDS);
    else if (action === 'video.seekForward') seekRelative(SKIP_SECONDS);
    else if (action === 'video.frameBackward') sessionRef.current?.control({action:'frame-back-step'});
    else if (action === 'video.frameForward') sessionRef.current?.control({action:'frame-step'});
    else if (action === 'video.volumeUp') changeVolume(Math.min(100, volume + 5));
    else if (action === 'video.volumeDown') changeVolume(Math.max(0, volume - 5));
    else if (action === 'video.mute') control('mute', !muted);
    else if (action === 'video.speedUp' || action === 'video.speedDown') { const index = PLAYBACK_SPEEDS.findIndex(value => value >= speed); const next = action === 'video.speedUp' ? PLAYBACK_SPEEDS[Math.min(PLAYBACK_SPEEDS.length - 1, Math.max(0, index + 1))] : PLAYBACK_SPEEDS[Math.max(0, (index < 0 ? PLAYBACK_SPEEDS.length : index) - 1)]; control('speed', next); }
    else if (action === 'video.resetSpeed') control('speed', 1);
    else if (action === 'video.fullscreen') onToggleFullscreenRef.current?.();
    else if (action === 'video.exitFullscreen') onEscapeRef.current?.();
    else if (action === 'video.capture') { if(capabilityPresentation.captureAvailable)void captureFrame();else setCaptureNotice({text:'当前后端不支持截图',error:true}); }
    else if(action==='video.fitSource'||action==='video.fitContain'||action==='video.fitCover'){const aspectMode=action==='video.fitSource'?'source':action==='video.fitContain'?'contain':'cover';if(capabilityPresentation.transformControls.includes(aspectMode))changeTransform({aspectMode});else setCaptureNotice({text:'当前后端不支持此画面模式',error:true});}
    else if(action==='video.rotateClockwise'||action==='video.rotateCounterclockwise'){if(capabilityPresentation.rotationAvailable)changeTransform({rotation:((videoTransform.rotation+(action==='video.rotateClockwise'?90:270))%360)as VideoTransform['rotation']});else setCaptureNotice({text:'当前后端不支持旋转',error:true});}
    else if (action === 'video.toggleSubtitles') { if(!capabilityPresentation.subtitlesAvailable)setCaptureNotice({text:'Chromium 模式未启用字幕功能',error:true});else if(selectedSubtitle){const visible=state.subtitleVisible===false;control('subtitle-visible',visible);rememberSubtitle(selectedSubtitle,subtitleDelay,visible);}else setControlPanel('subtitles'); }
    else if(action==='video.nextSubtitle'){if(!capabilityPresentation.subtitlesAvailable)setCaptureNotice({text:'Chromium 模式未启用字幕功能',error:true});else{const index=selectedSubtitle?subtitleTracks.findIndex(item=>item.stableId===selectedSubtitle.stableId):-1;const next=subtitleTracks[(index+1)%Math.max(1,subtitleTracks.length)];if(next)selectSubtitle(next.id);}}
    else if(action==='video.nextAudioTrack'){if(chromiumMode)setCaptureNotice({text:'Chromium 模式未启用音轨选择',error:true});else{const explicitIndex=audioTracks.findIndex(item=>item.id===String(state.audioTrackId??'')),index=explicitIndex>=0?explicitIndex:audioTracks.findIndex(item=>item.selected),next=audioTracks[(index+1)%Math.max(1,audioTracks.length)];if(next)sessionRef.current?.control({action:'audio-select',value:next.id});else setCaptureNotice({text:'当前后端未提供可选音轨',error:true});}}
    else if (action === 'video.toggleStatistics') { if(capabilityPresentation.statisticsGroups.basic){const panel=chromiumMode?'basic-info':'info';setControlPanel(current => current === panel ? null : panel);}else setCaptureNotice({text:'当前后端不提供播放统计',error:true}); }
    else if(action==='video.switchBackend'){const index=availableBackends.findIndex(item=>item.backendId===activeBackendId),next=availableBackends[(index+1)%Math.max(1,availableBackends.length)];if(next&&next.backendId!==activeBackendId)void switchPlaybackBackend(next.backendId);else setCaptureNotice({text:'没有其他可切换后端',error:true});}
    else if (action === 'media.previous') onNavigateRef.current(-1);
    else if (action === 'media.next') onNavigateRef.current(1);
  };
  dispatchShortcutRef.current = (action, repeat = false) => {
    if ((action === 'media.previous' || action === 'media.next') && !showNavigation) return;
    if (repeat && !videoShortcutAllowsRepeat(action)) return;
    shortcutActionRef.current(action);
  };

  const forwardBackAction = videoDirectionalAction(keyboardSettings.arrowKeyAction, 'forward-back');
  const runForwardBackControl = (direction: -1 | 1) => {
    if (forwardBackAction === 'navigate') onNavigateRef.current(direction);
    else seekRelative(direction * SKIP_SECONDS);
  };
  const backwardControlLabel = forwardBackAction === 'navigate' ? '上一个视频' : '快退 5 秒';
  const forwardControlLabel = forwardBackAction === 'navigate' ? '下一个视频' : '快进 5 秒';
  const playbackControls = bottomControls || <div onFocusCapture={() => { builtInControlsFocusedRef.current = true; }} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) builtInControlsFocusedRef.current = false; }} className={`relative z-20 flex h-12 shrink-0 items-center gap-1 px-2 text-white ${controlsOverlay ? 'bg-[#070b15]/95 shadow-[0_-10px_24px_rgba(0,0,0,.35)]' : 'border-t border-white/10 bg-[#070b15]'}`}>
        {showNavigation && <button type="button" onClick={() => runForwardBackControl(-1)} title={backwardControlLabel} aria-label={backwardControlLabel} className="rounded p-1.5 text-slate-100 hover:bg-white/10"><SkipBack size={16}/></button>}
        <button type="button" disabled={!sessionId} onClick={togglePlayback} title={paused ? t("ui.play.c33961") : t("ui.pause.8d12fc")} aria-label={paused ? t("ui.play.c33961") : t("ui.pause.8d12fc")} className="rounded p-1.5 text-slate-100 hover:bg-white/10 disabled:opacity-40">{paused ? <Play size={17} fill="currentColor"/> : <Pause size={17} fill="currentColor"/>}</button>
        {showNavigation && <button type="button" onClick={() => runForwardBackControl(1)} title={forwardControlLabel} aria-label={forwardControlLabel} className="rounded p-1.5 text-slate-100 hover:bg-white/10"><SkipForward size={16}/></button>}
        {externalTimeline ? <span className="flex-1"/> : <>
        <span className="w-10 text-right text-[11px] tabular-nums text-slate-300">{formatTime(time)}</span>
        <input type="range" min={0} max={Math.max(0.01, duration)} step={0.01} value={Math.min(time, Math.max(0.01, duration))} disabled={!duration} onChange={event => control('seek', Number(event.currentTarget.value))} aria-label={t("ui.playback.position.fc16e2")} className="min-w-12 flex-1 accent-blue-500 disabled:opacity-40"/>
        <span className="w-10 text-[11px] tabular-nums text-slate-300">{formatTime(duration)}</span>
        </>}
        {toolbarExtras}
        <div className="relative shrink-0" onPointerEnter={() => setControlPanel('speed')} onPointerLeave={() => setControlPanel(null)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setControlPanel(null); }} onKeyDown={event => closeControlPanelOnEscape(event, 'speed', speedTriggerRef.current)}>
          <button ref={speedTriggerRef} type="button" disabled={!sessionId} onFocus={() => { if (suppressPanelFocusOpenRef.current !== 'speed') setControlPanel('speed'); }} onClick={cyclePlaybackSpeed} title={t("ui.playback.speed.value0.click.to.cycle.b18261", { value0: speed })} aria-label={t("ui.playback.speed.value0.click.for.the.ad365c", { value0: speed })} aria-haspopup="dialog" aria-expanded={controlPanel === 'speed'} aria-controls={controlPanelIds.speed} className={`rounded p-1.5 text-slate-200 hover:bg-white/10 focus-visible:ring-1 focus-visible:ring-blue-400 disabled:opacity-40 ${controlPanel === 'speed' ? 'bg-white/10' : ''}`}><Gauge size={16}/></button>
          {controlPanel === 'speed' && <div ref={controlPanelRef} className="absolute bottom-full right-1/2 z-30 w-32 translate-x-1/2 pb-2" onClick={event => event.stopPropagation()}>
            <div id={controlPanelIds.speed} role="dialog" aria-label={t("ui.playback.speed.c114a6")} className="rounded-lg border border-white/15 bg-[#101827] p-2 shadow-2xl shadow-black/70">
              <div className="mb-1.5 flex items-center justify-between text-[10px] font-medium text-slate-300"><span>{t("ui.playback.speed.c114a6")}</span><span className="tabular-nums">{speed}×</span></div>
              <div className="grid grid-cols-2 gap-1">
                {PLAYBACK_SPEEDS.map(value => <button key={value} type="button" onClick={() => control('speed', value)} aria-label={t("ui.set.playback.speed.to.value0.0cb769", { value0: value })} aria-pressed={Math.abs(value - speed) < 0.001} className={`rounded px-1 py-1.5 text-[11px] font-semibold tabular-nums transition-colors ${Math.abs(value - speed) < 0.001 ? 'bg-blue-500 text-white' : 'bg-white/5 text-slate-200 hover:bg-white/15'}`}>{value}×</button>)}
              </div>
            </div>
          </div>}
        </div>
        <button type="button" disabled={!sessionId || starting || capturing || !capabilityPresentation.captureAvailable} onClick={() => void captureFrame()} title={t("ui.capture.the.current.frame.and.save.0a2f9b")} aria-label={t("ui.capture.current.frame.a8bf04")} className="rounded p-1.5 text-slate-200 hover:bg-white/10 disabled:opacity-40">{capturing ? <Loader2 size={16} className="animate-spin"/> : <Camera size={16}/>}</button>
        {capabilityPresentation.subtitlesAvailable&&<div className="relative shrink-0" onFocusCapture={() => { subtitlesControlFocusedRef.current = true; }} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) subtitlesControlFocusedRef.current = false; }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setControlPanel(null); }} onKeyDown={event => closeControlPanelOnEscape(event, 'subtitles', subtitlesTriggerRef.current)}>
          <button ref={subtitlesTriggerRef} type="button" disabled={!sessionId} onClick={() => setControlPanel(current => current === 'subtitles' ? null : 'subtitles')} title={t("ui.subtitles.60033a")} aria-label={t("ui.subtitle.settings.70355c")} aria-haspopup="dialog" aria-expanded={controlPanel === 'subtitles'} aria-controls={controlPanelIds.subtitles} className={`rounded p-1.5 text-slate-200 hover:bg-white/10 focus-visible:ring-1 focus-visible:ring-blue-400 disabled:opacity-40 ${controlPanel === 'subtitles' ? 'bg-white/10' : ''}`}><Captions size={17}/></button>
          {controlPanel === 'subtitles' && <div ref={controlPanelRef} className="absolute bottom-full right-0 z-30 w-72 pb-2" onClick={event => event.stopPropagation()}>
            <div id={controlPanelIds.subtitles} role="dialog" aria-label={t("ui.subtitle.settings.70355c")} className="max-h-80 overflow-auto rounded-lg border border-white/15 bg-[#101827] p-2 text-xs shadow-2xl shadow-black/70">
              <div className="mb-2 flex items-center justify-between px-1 text-slate-300"><span className="font-bold">{t("ui.subtitles.60033a")}</span><button type="button" onClick={() => void addSubtitle()} className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-white/10"><Plus size={13}/>{t("ui.add.local.subtitles.a6787d")}</button></div>
              <div role="group" aria-label={t("ui.subtitle.track.3ee844")}>
                <button aria-pressed={!selectedSubtitle} type="button" onClick={disableSubtitles} className={`block w-full rounded px-2 py-1.5 text-left ${!selectedSubtitle ? 'bg-blue-500 text-white' : 'text-slate-200 hover:bg-white/10'}`}>{t("common.close")}</button>
                {subtitleTracks.map(track => <button key={track.stableId} aria-pressed={selectedSubtitle?.stableId === track.stableId} type="button" onClick={() => selectSubtitle(track.id)} className={`block w-full truncate rounded px-2 py-1.5 text-left ${selectedSubtitle?.stableId === track.stableId ? 'bg-blue-500 text-white' : 'text-slate-200 hover:bg-white/10'}`}>{track.source === 'external' ? t("ui.external.6b95fd") : t("ui.embedded.975f9d")} · {track.title || track.language || track.format || t("ui.track.value0.d5c202", { value0: track.id })}</button>)}
              </div>
              <div className="mt-2 border-t border-white/10 pt-2">
                <button type="button" disabled={!selectedSubtitle} onClick={() => { const visible = state.subtitleVisible === false; control('subtitle-visible', visible); rememberSubtitle(selectedSubtitle, subtitleDelay, visible); }} className="w-full rounded px-2 py-1.5 text-left text-slate-200 hover:bg-white/10 disabled:opacity-40">{state.subtitleVisible === false ? t("ui.show.subtitles.526761") : t("ui.hide.subtitles.6cde93")}</button>
                <div className="flex items-center gap-1 px-2 py-1 text-slate-300"><span className="mr-auto">{t("message.28fa4857ebca", { value0: subtitleDelay > 0 ? `+${subtitleDelay.toFixed(1)}` : subtitleDelay.toFixed(1) })}</span><button type="button" onClick={() => changeSubtitleDelay(subtitleDelay - 0.5)} className="rounded bg-white/5 px-2 py-1 hover:bg-white/15">{t("ui.earlier.728e91")}</button><button type="button" onClick={() => changeSubtitleDelay(0)} className="rounded bg-white/5 px-2 py-1 hover:bg-white/15">{t("ui.reset.offset.803091")}</button><button type="button" onClick={() => changeSubtitleDelay(subtitleDelay + 0.5)} className="rounded bg-white/5 px-2 py-1 hover:bg-white/15">{t("ui.later.876d80")}</button></div>
                <div className="mt-1 flex items-center gap-1 px-2 py-1 text-slate-300"><span className="mr-auto">{t("ui.font.size.f71561")}</span>{SUBTITLE_FONT_SIZE_PRESETS.map(preset => <button key={preset.label} type="button" aria-label={t("ui.subtitle.font.size.value0.1f06d5", { value0: preset.label })} aria-pressed={subtitleFontSize === preset.value} onClick={() => changeSubtitleFontSize(preset.value)} className={`rounded px-2.5 py-1 font-bold transition ${subtitleFontSize === preset.value ? 'bg-blue-500 text-white' : 'bg-white/5 text-slate-200 hover:bg-white/15'}`}>{preset.label}</button>)}</div>
              </div>
            </div>
          </div>}
        </div>}
        <div className="relative shrink-0" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setControlPanel(null); }} onKeyDown={event => closeControlPanelOnEscape(event, 'display', displayTriggerRef.current)}>
          <button ref={displayTriggerRef} type="button" disabled={!sessionId} onClick={() => setControlPanel(current => current === 'display' ? null : 'display')} title={t("ui.display.settings.32e62e")} aria-label={t("ui.display.settings.32e62e")} aria-haspopup="dialog" aria-expanded={controlPanel === 'display'} aria-controls={controlPanelIds.display} className={`rounded p-1.5 text-slate-200 hover:bg-white/10 disabled:opacity-40 ${controlPanel === 'display' ? 'bg-white/10' : ''}`}><Settings2 size={16}/></button>
          {controlPanel === 'display' && <div ref={controlPanelRef} className="absolute bottom-full right-0 z-30 w-80 pb-2" onClick={event => event.stopPropagation()}><div id={controlPanelIds.display} role="dialog" aria-label={t("ui.display.settings.32e62e")} className="max-h-96 overflow-auto rounded-lg border border-white/15 bg-[#101827] p-3 text-xs text-slate-200 shadow-2xl shadow-black/70">
            <div className="mb-2 font-bold">{t("ui.display.and.playback.backend.7f36e2")}</div>
            <div className="mb-2 grid grid-cols-2 gap-1">{availableBackends.map(backend => <button key={backend.backendId} type="button" aria-pressed={backend.backendId === activeBackendId} onClick={() => void switchPlaybackBackend(backend.backendId)} className={`truncate rounded px-2 py-1.5 text-left ${backend.backendId === activeBackendId ? 'bg-blue-500 text-white' : 'bg-white/5 hover:bg-white/15'}`}>{backend.displayName}</button>)}</div>
            <div className="border-t border-white/10 pt-2"><span className="text-slate-400">{t("ui.aspect.ratio.5c6d39")}</span><div className="mt-1 grid grid-cols-3 gap-1">{(['source','contain','cover','16:9','4:3','1:1'] as const).filter(mode => capabilityPresentation.transformControls.includes(mode)).map(mode => <button key={mode} type="button" aria-pressed={videoTransform.aspectMode === mode} onClick={() => changeTransform({ aspectMode: mode })} className={`rounded px-1 py-1 ${videoTransform.aspectMode === mode ? 'bg-blue-500 text-white' : 'bg-white/5 hover:bg-white/15'}`}>{mode}</button>)}</div></div>
            <div className="mt-2 flex gap-1">{capabilityPresentation.rotationAvailable&&<button type="button" onClick={() => changeTransform({ rotation: ((videoTransform.rotation + 90) % 360) as VideoTransform['rotation'] })} className="rounded bg-white/5 px-2 py-1 hover:bg-white/15">{t("ui.rotate.90.1a9d08")}</button>}{capabilityPresentation.flipAvailable&&<><button type="button" aria-pressed={videoTransform.flipHorizontal} onClick={() => changeTransform({ flipHorizontal: !videoTransform.flipHorizontal })} className="rounded bg-white/5 px-2 py-1 hover:bg-white/15">{t("ui.flip.horizontally.44775f")}</button><button type="button" aria-pressed={videoTransform.flipVertical} onClick={() => changeTransform({ flipVertical: !videoTransform.flipVertical })} className="rounded bg-white/5 px-2 py-1 hover:bg-white/15">{t("ui.flip.vertically.fcd75e")}</button></>}</div>
            {capabilityPresentation.hdrControlsAvailable&&<div className="mt-2 border-t border-white/10 pt-2"><span>{t("video.stats.hdr")}{keyboardSettings.hdrMode}</span><p className={`mt-1 text-[10px] ${hdrAvailability.available ? 'text-emerald-300' : 'text-amber-300'}`}>{hdrAvailability.available ? t("ui.available.with.this.backend.value0.3cab14", { value0: keyboardSettings.hdrMode === 'hdr-passthrough' ? t("ui.display.reports.hdr.support.5e9d14") : '' }) : hdrAvailability.reason || displayCapability.reason}</p>{keyboardSettings.hdrMode==='tone-map'&&<p className={`mt-1 text-[10px] ${capabilityPresentation.toneMappingAlgorithms.includes(keyboardSettings.toneMapping)?'text-slate-300':'text-amber-300'}`}>{t("message.dfc962124b6e", { value0: keyboardSettings.toneMapping, value1: capabilityPresentation.targetPeakControl?`${keyboardSettings.targetPeakNits} nits`:t("ui.not.adjustable.with.this.backend.873402") })}</p>}</div>}
            {!chromiumMode&&audioTracks.length>0&&<div className="mt-2 border-t border-white/10 pt-2"><span className="text-slate-400">{t("ui.audio.track.b6dd16")}</span><div className="mt-1 space-y-1">{audioTracks.map(track=><button key={track.stableId} type="button" onClick={()=>sessionRef.current?.control({action:'audio-select',value:track.id})} className={`block w-full truncate rounded px-2 py-1 text-left ${track.id===String(state.audioTrackId??'')||track.selected?'bg-blue-500 text-white':'bg-white/5'}`}>{track.title||track.language||track.codec||t("ui.audio.track.value0.bcef04", { value0: track.id })}</button>)}</div></div>}
          </div></div>}
        </div>
        {chromiumMode&&<div className="relative shrink-0" onFocusCapture={() => { informationControlFocusedRef.current = 'basic-info'; }} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget) && informationControlFocusedRef.current === 'basic-info') informationControlFocusedRef.current = null; }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setControlPanel(null); }} onKeyDown={event => closeControlPanelOnEscape(event, 'basic-info', basicInfoTriggerRef.current)}>
          <button ref={basicInfoTriggerRef} type="button" disabled={!sessionId} onClick={() => setControlPanel(current => current === 'basic-info' ? null : 'basic-info')} title={t("ui.basic.playback.information.bd7726")} aria-label={t("ui.basic.playback.information.bd7726")} aria-haspopup="dialog" aria-expanded={controlPanel === 'basic-info'} aria-controls={controlPanelIds.basicInfo} className={`rounded p-1.5 text-slate-200 hover:bg-white/10 disabled:opacity-40 ${controlPanel === 'basic-info' ? 'bg-white/10' : ''}`}><Info size={16}/></button>
          {controlPanel === 'basic-info' && <div ref={controlPanelRef} className="absolute bottom-full right-0 z-30 w-72 pb-2" onClick={event => event.stopPropagation()}><div id={controlPanelIds.basicInfo} role="dialog" aria-label={t("ui.basic.playback.information.bd7726")} className="rounded-lg border border-white/15 bg-[#101827] p-3 text-[11px] text-slate-200 shadow-2xl shadow-black/70"><div className="mb-2 font-bold">{t("ui.basic.playback.information.bd7726")}</div>{state.statistics?<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1"><dt>{t("ui.container.6d23f0")}</dt><dd>{state.statistics.container||t("common.unknown")}</dd><dt>{t("ui.frame.size.b55f9f")}</dt><dd>{state.width&&state.height?`${state.width} × ${state.height}`:'—'}</dd><dt>{t("ui.duration.04a95e")}</dt><dd>{formatTime(duration)}</dd><dt>{t("ui.position.cbc1b8")}</dt><dd>{formatTime(time)}</dd><dt>{t("ui.source.display.fps.81f6ab")}</dt><dd>{state.statistics.sourceFps?.toFixed(2)||'—'} / {state.statistics.displayFps?.toFixed(2)||'—'}</dd><dt>{t("ui.dropped.frames.16454f")}</dt><dd>{state.statistics.droppedFrames??'—'}</dd><dt>{t("ui.renderer.5eea85")}</dt><dd>{state.statistics.renderer||'Chromium HTMLVideoElement'}</dd></dl>:<p className="text-slate-400">{t("ui.collecting.chromium.playback.information.2fefc1")}</p>}</div></div>}
        </div>}
        {!chromiumMode&&<div className="relative shrink-0" onFocusCapture={() => { informationControlFocusedRef.current = 'info'; }} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget) && informationControlFocusedRef.current === 'info') informationControlFocusedRef.current = null; }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setControlPanel(null); }} onKeyDown={event => closeControlPanelOnEscape(event, 'info', infoTriggerRef.current)}>
          <button ref={infoTriggerRef} type="button" disabled={!sessionId} onClick={() => setControlPanel(current => current === 'info' ? null : 'info')} title={t("ui.playback.information.e3c4de")} aria-label={t("ui.playback.information.e3c4de")} aria-haspopup="dialog" aria-expanded={controlPanel === 'info'} aria-controls={controlPanelIds.info} className={`rounded p-1.5 text-slate-200 hover:bg-white/10 disabled:opacity-40 ${controlPanel === 'info' ? 'bg-white/10' : ''}`}><Info size={16}/></button>
          {controlPanel === 'info' && <div ref={controlPanelRef} className="absolute bottom-full right-0 z-30 w-72 pb-2" onClick={event => event.stopPropagation()}><div id={controlPanelIds.info} role="dialog" aria-label={t("ui.playback.information.e3c4de")} className="max-h-96 overflow-auto rounded-lg border border-white/15 bg-[#101827] p-3 text-[11px] text-slate-200 shadow-2xl shadow-black/70"><div className="mb-2 font-bold">{t("ui.playback.information.e3c4de")}</div>{state.statistics ? <div className="space-y-2"><dl className="grid grid-cols-[auto_1fr] gap-x-3"><dt>{t("ui.container.6d23f0")}</dt><dd>{state.statistics.container||t("common.unknown")}</dd><dt>{t("ui.video.audio.75764b")}</dt><dd>{state.statistics.videoCodec||'—'} / {state.statistics.audioCodec||'—'}</dd></dl><dl className="grid grid-cols-[auto_1fr] gap-x-3 border-t border-white/10 pt-1"><dt>{t("ui.decoder.65b919")}</dt><dd>{state.statistics.decoder||'—'}</dd><dt>{t("ui.hardware.decoding.1faddf")}</dt><dd>{state.statistics.hardwareDecoding?state.statistics.hardwareDecoder||t("ui.yes.b5141d"):t("ui.no.unknown.99e705")}</dd><dt>{t("ui.pixels.b512ac")}</dt><dd>{state.statistics.pixelFormat||'—'} {state.statistics.bitDepth?`${state.statistics.bitDepth}bit`:''}</dd></dl><dl className="grid grid-cols-[auto_1fr] gap-x-3 border-t border-white/10 pt-1"><dt>HDR</dt><dd>{state.statistics.hdrFormat||'—'}</dd><dt>{t("video.stats.primaries")}</dt><dd>{state.statistics.colorPrimaries||'—'}</dd><dt>{t("video.stats.transferMatrix")}</dt><dd>{state.statistics.transfer||'—'} / {state.statistics.colorMatrix||'—'}</dd><dt>{t("video.stats.toneMap")}</dt><dd>{state.statistics.toneMapping||'—'}</dd></dl><dl className="grid grid-cols-[auto_1fr] gap-x-3 border-t border-white/10 pt-1"><dt>{t("ui.source.display.fps.81f6ab")}</dt><dd>{state.statistics.sourceFps?.toFixed(2)||'—'} / {state.statistics.displayFps?.toFixed(2)||'—'}</dd><dt>{t("ui.dropped.frames.latency.b9e9d8")}</dt><dd>{state.statistics.droppedFrames??'—'} / {state.statistics.delayedFrames??'—'}</dd><dt>{t("ui.a.v.sync.39efa5")}</dt><dd>{state.statistics.avSyncMs?.toFixed(1)||'—'} ms</dd></dl><dl className="grid grid-cols-[auto_1fr] gap-x-3 border-t border-white/10 pt-1"><dt>{t("ui.cache.e3ca04")}</dt><dd>{state.statistics.cacheSeconds?.toFixed(1)||'—'} s / {state.statistics.cacheBytes??'—'} B</dd><dt>GPU</dt><dd>{state.statistics.gpuApi||'—'} · {state.statistics.gpuAdapter||'—'}</dd><dt>{t("ui.renderer.5eea85")}</dt><dd>{state.statistics.renderer||activeBackend?.displayName||'—'}</dd></dl></div> : <p className="text-slate-400">{t("ui.collecting.available.playback.information.b5d953")}</p>}</div></div>}
        </div>}
        <div className="relative shrink-0" onPointerEnter={() => setControlPanel('volume')} onPointerLeave={() => setControlPanel(null)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setControlPanel(null); }} onKeyDown={event => closeControlPanelOnEscape(event, 'volume', volumeTriggerRef.current)}>
          <button ref={volumeTriggerRef} type="button" disabled={!sessionId} onFocus={() => { if (suppressPanelFocusOpenRef.current !== 'volume') setControlPanel('volume'); }} onClick={() => control('mute', !muted)} title={t("ui.value0.hover.to.adjust.volume.ad049a", { value0: muted ? t("ui.unmute.d10a1e") : t("ui.mute.14273a") })} aria-label={muted ? t("ui.unmute.d10a1e") : t("ui.mute.14273a")} aria-haspopup="dialog" aria-expanded={controlPanel === 'volume'} aria-controls={controlPanelIds.volume} className={`rounded p-1.5 text-slate-200 hover:bg-white/10 focus-visible:ring-1 focus-visible:ring-blue-400 disabled:opacity-40 ${controlPanel === 'volume' ? 'bg-white/10' : ''}`}>{muted || volume === 0 ? <VolumeX size={16}/> : <Volume2 size={16}/>}</button>
          {controlPanel === 'volume' && <div ref={controlPanelRef} className="absolute bottom-full right-0 z-30 w-44 pb-2" onClick={event => event.stopPropagation()}>
            <div id={controlPanelIds.volume} role="dialog" aria-label={t("ui.volume.8bf8b9")} className="rounded-lg border border-white/15 bg-[#101827] p-3 shadow-2xl shadow-black/70">
              <div className="mb-2 flex items-center justify-between text-[11px] font-medium text-slate-300"><span>{t("ui.volume.8bf8b9")}</span><span className="tabular-nums">{muted ? 0 : Math.round(volume)}%</span></div>
              <input type="range" min={0} max={100} step={1} value={muted ? 0 : volume} onChange={event => changeVolume(Number(event.currentTarget.value))} aria-label={t("ui.adjust.volume.15e5fd")} className="block w-full accent-blue-500"/>
            </div>
          </div>}
        </div>
        {(starting || state.buffering) && <span role="status" className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-blue-200"><Loader2 size={13} className="animate-spin"/>{t("ui.loading.d04fcb")}</span>}
        {captureNotice && <span role="status" aria-live="polite" title={captureNotice.text} className={`max-w-24 truncate whitespace-nowrap text-[11px] ${captureNotice.error ? 'text-red-300' : 'text-emerald-300'}`}>{captureNotice.text}</span>}
    </div>;

  return <div ref={playerRootRef} data-video-player="true" className="absolute inset-0 flex min-h-0 flex-col bg-black">
    <div
      ref={surfaceRef}
      role="button"
      tabIndex={0}
      aria-label={paused ? t("ui.play.video.327c57") : t("ui.pause.video.550c18")}
      onClick={togglePlayback}
      onContextMenu={event => {
        if (!onContextMenuAtRef.current) return;
        event.preventDefault();
        onContextMenuAtRef.current(event.clientX, event.clientY);
      }}
      onPointerMove={() => onPointerActivityRef.current?.()}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          dispatchShortcutRef.current('video.playPause', event.repeat);
        }
      }}
      className="relative min-h-0 flex-1 cursor-pointer overflow-hidden bg-black bg-contain bg-center bg-no-repeat outline-none"
      style={poster && !sessionId ? { backgroundImage: `url(${JSON.stringify(poster).slice(1, -1)})` } : undefined}
    >
      <video ref={videoRef} className="pointer-events-none absolute inset-0 h-full w-full bg-black object-contain" aria-hidden="true"/>
    </div>
    {controlsVisible && progressRail}
    {controlsVisible && (controlsOverlay ? <div ref={controlsOverlayRef} className="absolute inset-x-0 bottom-0 z-20">{playbackControls}</div> : playbackControls)}
    {controlsFooter}
  </div>;
};

/** Legacy export name retained only for source compatibility during migration. */
const AdvancedVideoPlayer = VideoPlayer;
export { AdvancedVideoPlayer, VideoPlayer, videoDirectionalAction, videoDirectionalKeyboardInput };
