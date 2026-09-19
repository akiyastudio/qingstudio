export interface PreviewPageContext { workspacePath: string; projectId: string; projectName: string; projectStatus: string; scopeRelativePath: string; sourcePageId: string; contentKind?: 'project' | 'inspiration' }
export interface PreviewVideo { sessionId: string; relativePath: string; time: number; duration: number; paused: boolean; canSeek: boolean }
export interface PreviewSnapshot { revision: number; video: PreviewVideo | null }
export interface PreviewSeekCommand { requestId: string; sourcePageId: string; sessionId: string; time: number }
export interface PreviewDecoder { componentId: string; id: string; label: string; extensions: string[]; priority: number }
export interface PreviewDecodeRequest { componentId: string; decoderId: string; relativePath: string; pageIndex: number; maxEdge: number; context: PreviewPageContext }
export type PreviewDecodeResult = { success: true; pageIndex: number; pageCount: number; width: number; height: number; dataUrl: string } | { success: false; error: string; errorCode: string };
