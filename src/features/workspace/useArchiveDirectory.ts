import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppDialog } from '../../components/AppDialogProvider';
import { archiveDirectoryEntries, type ArchiveResource, type ArchiveSession, type CompressionContext } from '../../contracts/compressed-files';
import { localizedMessage } from '../../i18n/messages';
import { t } from '../../i18n/runtime';
import { compressedFilesRequest } from '../../platform/compressed-files-client';
import type { ProjectFileEntry } from '../../types';
import { usePageState } from '../../platform/page-transfer-state';

const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
const hasMediaInputs = (session: ArchiveSession) => session.entries.every(entry => entry.directory || entry.inputPath?.startsWith('media-token:'));
// Register files explicitly opened as archives. A physical folder named .zip
// must continue to behave like a normal folder. Persist roots for page transfer.
const archiveRoot = (value: string, roots: string[]) => roots.find(root => normalize(value) === root || normalize(value).startsWith(`${root}/`));
const kindFor = (extension: string): ProjectFileEntry['kind'] => /^\.(jpg|jpeg|png|gif|webp|bmp|tif|tiff|heic|heif|hif|avif)$/i.test(extension) ? 'image'
  : /^\.(cr2|cr3|nef|arw|raf|orf|rw2|dng|rwl|3fr|fff|iiq|pef|srw)$/i.test(extension) ? 'raw'
    : /^\.(mp4|mov|m4v|webm|avi|mkv|mpeg|mpg|mts|m2ts|crm)$/i.test(extension) ? 'video' : 'file';
export const isArchiveText = (entry: ProjectFileEntry) => Boolean(entry.archiveMember && entry.size <= 1024 ** 2 && /^\.(txt|md|json|csv|log|xml|yaml|yml|ini|srt|vtt|css|js|ts|html)$/i.test(entry.extension));

/** Supplies virtual directory data to the existing file browser, never a second renderer. */
export const useArchiveDirectory = (context: CompressionContext, currentPath: string) => {
  const dialog = useAppDialog();
  const sessions = useRef(new Map<string, ArchiveSession>());
  const inFlight = useRef(new Map<string, Promise<ArchiveSession | null>>());
  const generation = useRef(0);
  const identity = JSON.stringify([context.workspacePath, context.projectId, context.projectName, context.projectStatus]);
  const [registered, setRegistered] = usePageState<{ identity: string; paths: string[] }>(context.sourcePageId, 'archiveDirectoryRoots', { identity, paths: [] });
  const roots = registered.identity === identity ? registered.paths : [];
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const owned = sessions.current;
    return () => {
      generation.current++;
      for (const session of owned.values()) void compressedFilesRequest({ action: 'close', sessionId: session.sessionId }).catch(() => undefined);
      owned.clear(); inFlight.current.clear();
    };
  }, [context.workspacePath, context.projectId, context.projectName, context.projectStatus, context.sourcePageId]);
  const withPassword = useCallback(async <T,>(run: (password: string) => Promise<T>): Promise<T | null> => {
    const version = generation.current;
    let password = '';
    for (;;) {
      if (version !== generation.current) return null;
      try { return await run(password); }
      catch (error) {
        if ((error as { code?: string }).code !== 'ARCHIVE_PASSWORD_REQUIRED') throw error;
        const answer = await dialog.prompt({ title: localizedMessage('compression.password'), message: localizedMessage('compression.password'), inputType: 'password', confirmLabel: localizedMessage('ui.continue.7c9691') });
        if (answer === null) return null;
        password = answer;
      }
    }
  }, [dialog]);
  const open = useCallback((path: string): Promise<ArchiveSession | null> => {
    const existing = sessions.current.get(path);
    if (existing) {
      if (hasMediaInputs(existing)) return Promise.resolve(existing);
      sessions.current.delete(path);
      void compressedFilesRequest({ action: 'close', sessionId: existing.sessionId }).catch(() => undefined);
      return Promise.reject(new Error(t('compression.restart_required')));
    }
    const pending = inFlight.current.get(path);
    if (pending) return pending;
    const version = generation.current;
    const request = withPassword(password => compressedFilesRequest<ArchiveSession>({ action: 'open', context, relativePath: path, password })).then(async session => {
      if (!session) return null;
      if (!hasMediaInputs(session)) {
        await compressedFilesRequest({ action: 'close', sessionId: session.sessionId });
        throw new Error(t('compression.restart_required'));
      }
      if (version !== generation.current) { await compressedFilesRequest({ action: 'close', sessionId: session.sessionId }); return null; }
      if (sessions.current.size >= 6) {
        const [oldPath, old] = sessions.current.entries().next().value!;
        sessions.current.delete(oldPath);
        await compressedFilesRequest({ action: 'close', sessionId: old.sessionId });
      }
      sessions.current.set(path, session);
      setRegistered(current => ({ identity, paths: [...new Set([path, ...(current.identity === identity ? current.paths : [])])] }));
      setRevision(value => value + 1);
      return session;
    }).finally(() => { if (inFlight.current.get(path) === request) inFlight.current.delete(path); });
    inFlight.current.set(path, request);
    return request;
  }, [context, withPassword, identity, setRegistered]);
  const entriesFor = useCallback((root: string, session: ArchiveSession, directory?: string): ProjectFileEntry[] => {
    const members = directory === undefined ? session.entries : archiveDirectoryEntries(session.entries, directory);
    return members.filter(member => member.directory || member.inputPath?.startsWith('media-token:')).map(member => {
      const name = member.relativePath.split('/').pop()!;
      const extension = name.includes('.') ? `.${name.split('.').pop()!.toLowerCase()}` : '';
      const relativePath = `${root}/${member.relativePath}`;
      return { name, relativePath, path: member.directory ? `archive-directory:${session.sessionId}/${member.relativePath}` : member.inputPath!, kind: member.directory ? 'folder' : kindFor(extension), extension: member.directory ? '' : extension, size: member.size, createdAt: 0, updatedAt: 0, readOnly: true,
        parentRelativePath: relativePath.split('/').slice(0, -1).join('/'), parentName: relativePath.split('/').slice(-2, -1)[0],
        archiveMember: { sessionId: session.sessionId, relativePath: member.relativePath, archivePath: root } };
    });
  }, []);
  const browse = useCallback(async (path: string) => {
    const root = archiveRoot(path, roots);
    if (!root) return null;
    const session = await open(root);
    return session ? { success: true, entries: entriesFor(root, session, normalize(path).slice(root.length).replace(/^\//, '')) } : { success: false, entries: [], error: '' };
  }, [entriesFor, open, roots]);
  const member = useCallback(async (entry: ProjectFileEntry, external = false) => {
    const ref = entry.archiveMember;
    if (!ref) return;
    return withPassword(password => compressedFilesRequest<ArchiveResource>({ action: 'member', sessionId: ref.sessionId, relativePath: ref.relativePath, password, openExternal: external }));
  }, [withPassword]);
  const root = archiveRoot(currentPath, roots);
  const allEntries = useMemo(() => {
    const session = root && sessions.current.get(root);
    return session ? entriesFor(root, session) : root ? [] : undefined;
  }, [root, revision, entriesFor]);
  return { active: Boolean(root), root, allEntries, browse, open, member, contains: (path: string) => Boolean(archiveRoot(path, roots)) };
};
