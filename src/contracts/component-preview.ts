export interface PreviewPageContext { workspacePath: string; projectId: string; projectName: string; projectStatus: string; scopeRelativePath: string; sourcePageId: string; contentKind?: 'project' | 'inspiration' }
export interface PreviewVideo { sessionId: string; relativePath: string; time: number; duration: number; paused: boolean; canSeek: boolean }
export interface PreviewSnapshot { revision: number; video: PreviewVideo | null }
export interface PreviewSeekCommand { requestId: string; sourcePageId: string; sessionId: string; time: number }
export interface PreviewDecoder { componentId: string; id: string; label: string; extensions: string[]; priority: number; thumbnails?: boolean; version?: string }
export interface PreviewDecodeRequest { componentId: string; decoderId: string; relativePath: string; pageIndex: number; maxEdge: number; context: PreviewPageContext; requestId?: string }
export type PreviewDecodeResult = { success: true; kind?: 'image'; pageIndex: number; pageCount: number; width: number; height: number; dataUrl: string } | { success: true; kind: 'video'; previewId: string; mimeType: 'video/mp4' | 'video/quicktime'; pageIndex: number; pageCount: number; poster?: string; presentation?: 'live-photo' } | { success: false; error: string; errorCode: string };
export interface PreviewPlaybackRequest { previewId: string; action: 'source' | 'backends' | 'start' | 'keepalive' | 'release'; browserProbe?: string; settings?: import('../types').VideoPlaybackSettings; playerId?: string; requestId?: string; backendId?: string }
export interface PreviewPlaybackResult { success: boolean; mediaUrl?: string; backends?: import('../types').VideoPlaybackBackendDescriptor[]; sessionId?: string; playerId?: string; requestId?: string; error?: string }
