import { LocalizedText } from "../../i18n/LocalizedText";
import { useLocale } from "../../i18n/react";
import { t } from "../../i18n/runtime";
import { useEffect, useMemo, useRef, useState } from 'react';
import { useScopedPageState } from '../../platform/page-transfer-state';
import { File, FileImage, FileVideo, Folder, Loader2, Search, X } from 'lucide-react';
import type { AppConfig, ProjectFileEntry, WorkspaceProject } from '../../types';
import { normalizeWorkspacePaths } from '../../types';
import { projectWorkspaceClient } from '../../platform/project-workspace-client';
import { MediaThumbnail } from '../../components/MediaThumbnail';

const INSPIRATION_PROJECT_NAME = '.__photoflow_inspiration__';
const SEARCH_PAGE_SIZE = 200;
const SEARCH_CONCURRENCY = 4;
export const GLOBAL_SEARCH_RESULT_PAGE_SIZE = 200;
export const GLOBAL_SEARCH_MAX_MOUNTED_RESULTS = 400;
const SEARCH_DATABASE_PREFIX = 'photoflow-global-search-tmp-';
const SEARCH_TREE_MAX_ITEMS = 64;
export const GLOBAL_SEARCH_INDEX_WRITE_CHUNK_SIZE = 8;
const GLOBAL_SEARCH_OPFS_WRITE_CHUNK_SIZE = SEARCH_PAGE_SIZE;
export const GLOBAL_SEARCH_MAX_INDEX_RESIDENT_HITS = SEARCH_TREE_MAX_ITEMS * (GLOBAL_SEARCH_OPFS_WRITE_CHUNK_SIZE + 1);
const SEARCH_TREE_ROOT_DIRECTORY = 'photoflow-global-search-tmp';

export type GlobalSearchSource = {
  id: string;
  kind: 'project' | 'inspiration';
  label: string;
  workspacePath: string;
  project: WorkspaceProject;
};

type SearchHit = { source: GlobalSearchSource; entry: ProjectFileEntry };
type SearchGroup = { id: string; source: GlobalSearchSource; folderPath: string; entries: ProjectFileEntry[] };
type StoredSearchHit = { orderKey: string; groupKey: string; hit: SearchHit };
type SearchStoreSnapshot = { storedCount: number; totalCount: number; groupCount: number; groupsFinalized: boolean; truncated: boolean };

class SearchStorageError extends Error {}

export type GlobalSearchResultStore = {
  append: (source: GlobalSearchSource, entries: ProjectFileEntry[]) => Promise<SearchStoreSnapshot>;
  finalize?: () => Promise<SearchStoreSnapshot>;
  readWindow: (start: number, limit: number) => Promise<SearchGroup[]>;
  dispose: () => Promise<void>;
  readonly storageKind: 'indexeddb' | 'opfs';
};

export type GlobalSearchPageFetcher = (
  source: GlobalSearchSource,
  query: string,
  cursor: string | undefined,
) => ReturnType<typeof projectWorkspaceClient.listProjectFiles>;

// eslint-disable-next-line react-refresh/only-export-components
export const cancelGlobalSearchCursors = async (
  cursors: Set<string>,
  cancelCursor: (cursor: string) => Promise<unknown> = cursor => projectWorkspaceClient.cancelListProjectFiles(cursor),
) => {
  const pending = [...cursors];
  cursors.clear();
  await Promise.allSettled(pending.map(cursor => cancelCursor(cursor)));
};

// eslint-disable-next-line react-refresh/only-export-components
export const createTrailingSearchRefreshScheduler = <T,>(
  apply: (value: T) => void,
  delay = 75,
  schedule: (callback: () => void, milliseconds: number) => number = (callback, milliseconds) => window.setTimeout(callback, milliseconds),
  cancel: (timer: number) => void = timer => window.clearTimeout(timer),
) => {
  let pending: T | undefined;
  let timer: number | undefined;
  const applyPending = () => {
    timer = undefined;
    if (pending === undefined) return;
    const value = pending;
    pending = undefined;
    apply(value);
  };
  const clear = () => {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    pending = undefined;
  };
  return {
    push(value: T) {
      pending = value;
      if (timer === undefined) timer = schedule(applyPending, delay);
    },
    flush() {
      if (timer !== undefined) cancel(timer);
      applyPending();
    },
    clear,
  };
};

// eslint-disable-next-line react-refresh/only-export-components
export const calculateGlobalSearchVirtualWindow = ({ totalCount, scrollTop, viewportHeight, containerWidth }: {
  totalCount: number;
  scrollTop: number;
  viewportHeight: number;
  containerWidth: number;
}) => {
  const gap = 12;
  const columns = Math.max(1, Math.floor((Math.max(144, containerWidth) + gap) / (144 + gap)));
  const columnWidth = Math.max(1, (Math.max(144, containerWidth) - gap * (columns - 1)) / columns);
  const rowHeight = columnWidth + 65;
  const totalRows = Math.ceil(totalCount / columns);
  const firstVisibleRow = Math.max(0, Math.floor(scrollTop / rowHeight));
  const visibleRows = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  const maximumRows = Math.max(1, Math.floor(GLOBAL_SEARCH_MAX_MOUNTED_RESULTS / columns));
  const desiredRows = Math.min(maximumRows, visibleRows + 4);
  const firstRow = Math.max(0, Math.min(Math.max(0, totalRows - desiredRows), firstVisibleRow - 2));
  const endRow = Math.min(totalRows, firstRow + desiredRows);
  const start = firstRow * columns;
  const end = Math.min(totalCount, endRow * columns);
  return {
    start,
    end,
    columns,
    rowHeight,
    topSpacer: firstRow * rowHeight,
    bottomSpacer: Math.max(0, (totalRows - endRow) * rowHeight),
    totalHeight: totalRows * rowHeight,
  };
};

// eslint-disable-next-line react-refresh/only-export-components
export const createRafSearchScrollScheduler = <T,>(
  apply: (value: T) => void,
  request: (callback: () => void) => number = callback => window.requestAnimationFrame(callback),
  cancel: (frame: number) => void = frame => window.cancelAnimationFrame(frame),
) => {
  let pending: T | undefined;
  let frame: number | undefined;
  const flush = () => {
    frame = undefined;
    if (pending === undefined) return;
    const value = pending;
    pending = undefined;
    apply(value);
  };
  return {
    push(value: T) {
      pending = value;
      if (frame === undefined) frame = request(flush);
    },
    clear() {
      if (frame !== undefined) cancel(frame);
      frame = undefined;
      pending = undefined;
    },
  };
};

const normalizePathKey = (value: string) => value.trim().replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();

const naturalSortKey = (value: string) => value.normalize('NFKD').toLocaleLowerCase().replace(/\d+/g, digits => {
  const normalized = digits.replace(/^0+(?=\d)/, '');
  return `\u0001${String(normalized.length).padStart(10, '0')}:${normalized}`;
});

const stableNaturalField = (value: string) => `${naturalSortKey(value)}\u0002${value.normalize('NFKD').toLocaleLowerCase()}\u0002${value}`;

const folderPathForEntry = (entry: ProjectFileEntry) => (
  entry.parentRelativePath || entry.relativePath.split(/[\\/]/).slice(0, -1).join('/')
).replace(/\\/g, '/');

const storedHit = (source: GlobalSearchSource, entry: ProjectFileEntry, sourceSequence: number): StoredSearchHit => {
  const folderPath = folderPathForEntry(entry);
  const groupKey = `${source.id}\u0000${folderPath}`;
  return {
    groupKey,
    orderKey: [source.label, source.id, folderPath, entry.name, entry.relativePath, entry.path]
      .map(stableNaturalField).concat(String(sourceSequence).padStart(16, '0')).join('\u0000'),
    hit: { source, entry },
  };
};

const groupWindowHits = (rows: StoredSearchHit[]): SearchGroup[] => {
  const groups: SearchGroup[] = [];
  for (const row of rows) {
    const folderPath = folderPathForEntry(row.hit.entry);
    let group = groups.at(-1);
    if (group?.id !== row.groupKey) {
      group = { id: row.groupKey, source: row.hit.source, folderPath, entries: [] };
      groups.push(group);
    }
    group.entries.push(row.hit.entry);
  }
  return groups;
};

const requestResult = <T,>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败'));
});

const transactionDone = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('IndexedDB 事务失败'));
});

type SearchTreeLeaf = { id: string; kind: 'leaf'; count: number; maxKey: string; rows: StoredSearchHit[] };
type SearchTreeBranchChild = { id: string; count: number; maxKey: string };
type SearchTreeBranch = { id: string; kind: 'branch'; count: number; maxKey: string; children: SearchTreeBranchChild[] };
type SearchTreeNode = SearchTreeLeaf | SearchTreeBranch;
type SearchTreeMeta = { rootId: string; totalCount: number; groupCount: number; nextNodeId: number };
export type SearchTreeAccess = {
  getNode: (id: string) => Promise<SearchTreeNode | undefined>;
  putNode: (node: SearchTreeNode) => void;
  getValue: (key: string) => Promise<unknown>;
  putValue: (key: string, value: unknown) => void;
  flush: () => Promise<void>;
};
export type SearchTreeBackend = {
  readonly kind: 'indexeddb' | 'opfs';
  edit: <T>(operation: (access: SearchTreeAccess) => Promise<T>) => Promise<T>;
  read: <T>(operation: (access: SearchTreeAccess) => Promise<T>) => Promise<T | undefined>;
  scan: <T>(operation: (access: SearchTreeAccess) => Promise<T>) => Promise<T>;
  dispose: () => Promise<void>;
};

const isAbortError = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const nodeReference = (node: SearchTreeNode): SearchTreeBranchChild => ({ id: node.id, count: node.count, maxKey: node.maxKey });

class SearchStorageLease {
  private releaseHold!: () => void;
  private readonly held: Promise<void>;
  readonly name: string;

  private constructor(name: string, held: Promise<void>) { this.name = name; this.held = held; }

  static async acquire(name: string) {
    if (!navigator.locks) throw new Error('Web Locks 不可用');
    let acquired!: () => void;
    const acquiredPromise = new Promise<void>(resolve => { acquired = resolve; });
    let releaseHold!: () => void;
    const hold = new Promise<void>(resolve => { releaseHold = resolve; });
    const held = navigator.locks.request(name, { mode: 'shared' }, async () => {
      acquired();
      await hold;
    }).then(() => undefined);
    const lease = new SearchStorageLease(name, held);
    lease.releaseHold = releaseHold;
    await Promise.race([
      acquiredPromise,
      held.then(() => { throw new Error('搜索存储租约未被授予'); }),
    ]);
    return lease;
  }

  async release() {
    this.releaseHold();
    await this.held;
  }
}

const withUnusedSearchLease = async (name: string, operation: () => Promise<void>) => {
  if (!navigator.locks) return;
  await navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (lock) await operation();
  });
};

const deleteSearchDatabase = (name: string) => new Promise<boolean>(resolve => {
  const request = indexedDB.deleteDatabase(name);
  let settled = false;
  let blockedTimer: ReturnType<typeof setTimeout> | undefined;
  const finish = (deleted: boolean) => {
    if (settled) return;
    settled = true;
    if (blockedTimer !== undefined) clearTimeout(blockedTimer);
    resolve(deleted);
  };
  request.onsuccess = () => finish(true);
  request.onerror = () => finish(false);
  request.onblocked = () => {
    if (blockedTimer === undefined) blockedTimer = setTimeout(() => finish(false), 1_000);
  };
});

export class IndexedDbTreeBackend implements SearchTreeBackend {
  readonly kind = 'indexeddb' as const;
  private activeRead?: IDBTransaction;
  private readonly database: IDBDatabase;
  private readonly databaseName: string;
  private readonly lease: SearchStorageLease;

  constructor(database: IDBDatabase, databaseName: string, lease: SearchStorageLease) {
    this.database = database;
    this.databaseName = databaseName;
    this.lease = lease;
  }

  async edit<T>(operation: (access: SearchTreeAccess) => Promise<T>) {
    const transaction = this.database.transaction(['nodes', 'values'], 'readwrite');
    const done = transactionDone(transaction);
    const nodes = transaction.objectStore('nodes');
    const values = transaction.objectStore('values');
    const nodeCache = new Map<string, SearchTreeNode | undefined>();
    const dirtyNodes = new Map<string, SearchTreeNode>();
    const valueCache = new Map<string, unknown>();
    const dirtyValues = new Map<string, unknown>();
    let keepAlive = true;
    const keepTransactionAlive = () => {
      const request = values.get('__transaction_keepalive__');
      request.onsuccess = () => { if (keepAlive) keepTransactionAlive(); };
    };
    keepTransactionAlive();
    const flush = async () => {
      const requests: IDBRequest[] = [];
      for (const node of dirtyNodes.values()) requests.push(nodes.put(node));
      for (const [key, value] of dirtyValues) requests.push(values.put({ key, value }));
      await Promise.all(requests.map(request => requestResult(request)));
      dirtyNodes.clear();
      dirtyValues.clear();
      nodeCache.clear();
    };
    const access: SearchTreeAccess = {
      getNode: async id => {
        if (!nodeCache.has(id)) nodeCache.set(id, structuredClone(await requestResult(nodes.get(id)) as SearchTreeNode | undefined));
        return nodeCache.get(id);
      },
      putNode: node => {
        nodeCache.set(node.id, node);
        dirtyNodes.set(node.id, node);
      },
      getValue: async key => {
        if (!valueCache.has(key)) valueCache.set(key, (await requestResult(values.get(key)) as { key: string; value: unknown } | undefined)?.value);
        return valueCache.get(key);
      },
      putValue: (key, value) => {
        valueCache.set(key, value);
        dirtyValues.set(key, value);
      },
      flush,
    };
    try {
      const result = await operation(access);
      await flush();
      keepAlive = false;
      await done;
      return result;
    } catch (error) {
      keepAlive = false;
      try { transaction.abort(); } catch { /* already finished */ }
      await done.catch(() => undefined);
      if (isAbortError(error)) throw error;
      throw new SearchStorageError(error instanceof Error ? error.message : String(error));
    }
  }

  async read<T>(operation: (access: SearchTreeAccess) => Promise<T>) {
    try { this.activeRead?.abort(); } catch { /* already finished */ }
    const transaction = this.database.transaction(['nodes', 'values'], 'readonly');
    this.activeRead = transaction;
    const done = transactionDone(transaction);
    const nodes = transaction.objectStore('nodes');
    const values = transaction.objectStore('values');
    const access: SearchTreeAccess = {
      getNode: async id => structuredClone(await requestResult(nodes.get(id)) as SearchTreeNode | undefined),
      putNode: () => { throw new Error('只读事务不能写入'); },
      getValue: async key => (await requestResult(values.get(key)) as { key: string; value: unknown } | undefined)?.value,
      putValue: () => { throw new Error('只读事务不能写入'); },
      flush: async () => undefined,
    };
    try {
      const result = await operation(access);
      await done;
      return result;
    } catch (error) {
      await done.catch(() => undefined);
      if (isAbortError(error) || transaction.error?.name === 'AbortError') return undefined;
      throw error;
    } finally {
      if (this.activeRead === transaction) this.activeRead = undefined;
    }
  }

  async scan<T>(operation: (access: SearchTreeAccess) => Promise<T>) {
    const transaction = this.database.transaction(['nodes', 'values'], 'readonly');
    const done = transactionDone(transaction);
    const nodes = transaction.objectStore('nodes');
    const values = transaction.objectStore('values');
    const access: SearchTreeAccess = {
      getNode: async id => structuredClone(await requestResult(nodes.get(id)) as SearchTreeNode | undefined),
      putNode: () => { throw new Error('只读扫描不能写入'); },
      getValue: async key => (await requestResult(values.get(key)) as { key: string; value: unknown } | undefined)?.value,
      putValue: () => { throw new Error('只读扫描不能写入'); },
      flush: async () => undefined,
    };
    try {
      const result = await operation(access);
      await done;
      return result;
    } catch (error) {
      try { transaction.abort(); } catch { /* already finished */ }
      await done.catch(() => undefined);
      throw error;
    }
  }

  async dispose() {
    try { this.activeRead?.abort(); } catch { /* already finished */ }
    this.database.close();
    await this.lease.release();
    await withUnusedSearchLease(this.lease.name, async () => { await deleteSearchDatabase(this.databaseName); });
  }
}

const readOpfsJson = async <T,>(directory: FileSystemDirectoryHandle, name: string): Promise<T | undefined> => {
  try {
    const handle = await directory.getFileHandle(name);
    return JSON.parse(await (await handle.getFile()).text()) as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return undefined;
    throw error;
  }
};

const writeOpfsJson = async (directory: FileSystemDirectoryHandle, name: string, value: unknown) => {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(value));
  await writable.close();
};

export class OpfsTreeBackend implements SearchTreeBackend {
  readonly kind = 'opfs' as const;
  private readGeneration = 0;
  private invalid = false;
  private operationQueue: Promise<unknown> = Promise.resolve();
  private readonly root: FileSystemDirectoryHandle;
  private readonly directory: FileSystemDirectoryHandle;
  private readonly directoryName: string;
  private readonly lease: SearchStorageLease;

  constructor(
    root: FileSystemDirectoryHandle,
    directory: FileSystemDirectoryHandle,
    directoryName: string,
    lease: SearchStorageLease,
  ) {
    this.root = root;
    this.directory = directory;
    this.directoryName = directoryName;
    this.lease = lease;
  }

  private nodeFile(id: string) { return `node-${id}.json`; }
  private valueFile(key: string) { return `value-${key}.json`; }

  async edit<T>(operation: (access: SearchTreeAccess) => Promise<T>) {
    const queued = this.operationQueue.then(() => this.performEdit(operation));
    this.operationQueue = queued.catch(() => undefined);
    return queued;
  }

  private async performEdit<T>(operation: (access: SearchTreeAccess) => Promise<T>) {
    if (this.invalid) throw new SearchStorageError('OPFS 临时索引已失效');
    const dirtyNodes = new Map<string, SearchTreeNode>();
    const dirtyValues = new Map<string, unknown>();
    const flush = async () => {
      await Promise.all([
        ...[...dirtyNodes].map(([id, node]) => writeOpfsJson(this.directory, this.nodeFile(id), node)),
        ...[...dirtyValues].map(([key, value]) => writeOpfsJson(this.directory, this.valueFile(key), value)),
      ]);
      dirtyNodes.clear();
      dirtyValues.clear();
    };
    const access: SearchTreeAccess = {
      getNode: async id => dirtyNodes.get(id) || await readOpfsJson<SearchTreeNode>(this.directory, this.nodeFile(id)),
      putNode: node => { dirtyNodes.set(node.id, node); },
      getValue: async key => dirtyValues.has(key) ? dirtyValues.get(key) : readOpfsJson(this.directory, this.valueFile(key)),
      putValue: (key, value) => { dirtyValues.set(key, value); },
      flush,
    };
    try {
      const result = await operation(access);
      await flush();
      return result;
    } catch (error) {
      if (isAbortError(error)) throw error;
      this.invalid = true;
      this.readGeneration += 1;
      throw new SearchStorageError(error instanceof Error ? error.message : String(error));
    }
  }

  async read<T>(operation: (access: SearchTreeAccess) => Promise<T>) {
    const generation = ++this.readGeneration;
    const queued = this.operationQueue.then(() => {
      if (generation !== this.readGeneration) return undefined;
      return this.performRead(operation, generation);
    });
    this.operationQueue = queued.catch(() => undefined);
    return queued;
  }

  private async performRead<T>(operation: (access: SearchTreeAccess) => Promise<T>, generation: number) {
    if (this.invalid) throw new SearchStorageError('OPFS 临时索引已失效');
    const access: SearchTreeAccess = {
      getNode: async id => {
        const node = await readOpfsJson<SearchTreeNode>(this.directory, this.nodeFile(id));
        if (generation !== this.readGeneration) throw new DOMException('过时的窗口读取', 'AbortError');
        return node;
      },
      putNode: () => { throw new Error('只读操作不能写入'); },
      getValue: async key => readOpfsJson(this.directory, this.valueFile(key)),
      putValue: () => { throw new Error('只读操作不能写入'); },
      flush: async () => undefined,
    };
    try {
      return await operation(access);
    } catch (error) {
      if (isAbortError(error)) return undefined;
      throw error;
    }
  }

  async scan<T>(operation: (access: SearchTreeAccess) => Promise<T>) {
    if (this.invalid) throw new SearchStorageError('OPFS 临时索引已失效');
    return operation({
      getNode: id => readOpfsJson<SearchTreeNode>(this.directory, this.nodeFile(id)),
      putNode: () => { throw new Error('只读扫描不能写入'); },
      getValue: key => readOpfsJson(this.directory, this.valueFile(key)),
      putValue: () => { throw new Error('只读扫描不能写入'); },
      flush: async () => undefined,
    });
  }

  async dispose() {
    this.readGeneration += 1;
    await this.operationQueue.catch(() => undefined);
    await this.lease.release();
    await withUnusedSearchLease(this.lease.name, async () => {
      try { await this.root.removeEntry(this.directoryName, { recursive: true }); } catch { /* best effort */ }
    });
  }
}

const searchSourceCounterKey = async (sourceId: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sourceId));
  return `sequence-${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')}`;
};

export class DiskBPlusTreeSearchStore implements GlobalSearchResultStore {
  readonly storageKind: 'indexeddb' | 'opfs';
  private meta: SearchTreeMeta = { rootId: 'n0', totalCount: 0, groupCount: 0, nextNodeId: 1 };
  private writeQueue: Promise<unknown> = Promise.resolve();
  private readGeneration = 0;
  private groupsFinalized = false;
  private disposed = false;
  private epoch = 0;
  private readonly backend: SearchTreeBackend;

  private constructor(backend: SearchTreeBackend) { this.backend = backend; this.storageKind = backend.kind; }

  static async open(backend: SearchTreeBackend) {
    const store = new DiskBPlusTreeSearchStore(backend);
    await backend.edit(async access => {
      const existing = await access.getValue('tree-meta') as SearchTreeMeta | undefined;
      if (existing) store.meta = existing;
      else {
        access.putNode({ id: 'n0', kind: 'leaf', count: 0, maxKey: '', rows: [] });
        access.putValue('tree-meta', store.meta);
      }
    });
    return store;
  }

  async append(source: GlobalSearchSource, entries: ProjectFileEntry[]) {
    const epoch = this.epoch;
    this.assertCurrent(epoch);
    if (!entries.length) return this.snapshot();
    const counterKey = await searchSourceCounterKey(source.id);
    this.assertCurrent(epoch);
    const appendOperation = this.writeQueue.then(async () => {
      this.assertCurrent(epoch);
      const previousMeta = this.meta;
      const nextMeta = structuredClone(previousMeta);
      try {
        await this.backend.edit(async access => {
          let sourceSequence = Number(await access.getValue(counterKey) || 0);
          const flushInterval = this.backend.kind === 'opfs' ? GLOBAL_SEARCH_OPFS_WRITE_CHUNK_SIZE : GLOBAL_SEARCH_INDEX_WRITE_CHUNK_SIZE;
          for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
            this.assertCurrent(epoch);
            const references = await this.insert(access, nextMeta.rootId, storedHit(source, entries[entryIndex], sourceSequence++), nextMeta);
            if (references.length > 1) {
              const root: SearchTreeBranch = {
                id: `n${nextMeta.nextNodeId++}`,
                kind: 'branch',
                children: references,
                count: references.reduce((count, child) => count + child.count, 0),
                maxKey: references.at(-1)!.maxKey,
              };
              access.putNode(root);
              nextMeta.rootId = root.id;
            }
            if ((entryIndex + 1) % flushInterval === 0) await access.flush();
          }
          nextMeta.totalCount += entries.length;
          access.putValue(counterKey, sourceSequence);
          access.putValue('tree-meta', nextMeta);
        });
        this.assertCurrent(epoch);
        this.meta = nextMeta;
      } catch (error) {
        this.meta = previousMeta;
        throw error;
      }
      this.assertCurrent(epoch);
      return this.snapshot();
    });
    this.writeQueue = appendOperation.catch(() => undefined);
    return appendOperation;
  }

  async finalize() {
    const epoch = this.epoch;
    this.assertCurrent(epoch);
    await this.writeQueue;
    this.assertCurrent(epoch);
    try {
      this.assertCurrent(epoch);
      let groupCount = 0;
      let previousGroupKey = '';
      await this.backend.scan(async access => {
        const visit = async (nodeId: string): Promise<void> => {
          this.assertCurrent(epoch);
          const node = await access.getNode(nodeId);
          this.assertCurrent(epoch);
          if (!node) throw new Error(`搜索索引节点缺失：${nodeId}`);
          if (node.kind === 'leaf') {
            for (const row of node.rows) {
              this.assertCurrent(epoch);
              if (row.groupKey !== previousGroupKey) {
                previousGroupKey = row.groupKey;
                groupCount += 1;
              }
            }
            return;
          }
          for (const child of node.children) await visit(child.id);
        };
        await visit(this.meta.rootId);
      });
      this.assertCurrent(epoch);
      this.meta = { ...this.meta, groupCount };
      this.groupsFinalized = true;
      return this.snapshot();
    } catch (error) {
      if (isAbortError(error)) throw error;
      return this.snapshot();
    }
  }

  async readWindow(start: number, limit: number) {
    const epoch = this.epoch;
    if (this.disposed) return [];
    const generation = ++this.readGeneration;
    await this.writeQueue;
    if (epoch !== this.epoch || generation !== this.readGeneration) return [];
    const rows = await this.backend.read(async access => {
      const output: StoredSearchHit[] = [];
      await this.readFrom(access, this.meta.rootId, Math.max(0, start), Math.max(0, limit), output, () => epoch === this.epoch && generation === this.readGeneration);
      return output;
    });
    if (!rows || epoch !== this.epoch || generation !== this.readGeneration) return [];
    return groupWindowHits(rows);
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch += 1;
    this.readGeneration += 1;
    await this.writeQueue.catch(() => undefined);
    await this.backend.dispose();
  }

  private snapshot(): SearchStoreSnapshot {
    return { storedCount: this.meta.totalCount, totalCount: this.meta.totalCount, groupCount: this.meta.groupCount, groupsFinalized: this.groupsFinalized, truncated: false };
  }

  private assertCurrent(epoch: number) {
    if (this.disposed || epoch !== this.epoch) throw new DOMException('搜索存储已失效', 'AbortError');
  }

  private async insert(access: SearchTreeAccess, nodeId: string, row: StoredSearchHit, meta: SearchTreeMeta): Promise<SearchTreeBranchChild[]> {
    const node = await access.getNode(nodeId);
    if (!node) throw new Error(`搜索索引节点缺失：${nodeId}`);
    if (node.kind === 'leaf') {
      let low = 0;
      let high = node.rows.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (node.rows[middle].orderKey <= row.orderKey) low = middle + 1;
        else high = middle;
      }
      node.rows.splice(low, 0, row);
      node.count = node.rows.length;
      node.maxKey = node.rows.at(-1)?.orderKey || '';
      if (node.rows.length <= SEARCH_TREE_MAX_ITEMS) {
        access.putNode(node);
        return [nodeReference(node)];
      }
      const rightRows = node.rows.splice(Math.ceil(node.rows.length / 2));
      node.count = node.rows.length;
      node.maxKey = node.rows.at(-1)!.orderKey;
      const right: SearchTreeLeaf = { id: `n${meta.nextNodeId++}`, kind: 'leaf', rows: rightRows, count: rightRows.length, maxKey: rightRows.at(-1)!.orderKey };
      access.putNode(node);
      access.putNode(right);
      return [nodeReference(node), nodeReference(right)];
    }
    let childIndex = node.children.findIndex(child => row.orderKey <= child.maxKey);
    if (childIndex < 0) childIndex = node.children.length - 1;
    const replacements = await this.insert(access, node.children[childIndex].id, row, meta);
    node.children.splice(childIndex, 1, ...replacements);
    node.count = node.children.reduce((count, child) => count + child.count, 0);
    node.maxKey = node.children.at(-1)!.maxKey;
    if (node.children.length <= SEARCH_TREE_MAX_ITEMS) {
      access.putNode(node);
      return [nodeReference(node)];
    }
    const rightChildren = node.children.splice(Math.ceil(node.children.length / 2));
    node.count = node.children.reduce((count, child) => count + child.count, 0);
    node.maxKey = node.children.at(-1)!.maxKey;
    const right: SearchTreeBranch = {
      id: `n${meta.nextNodeId++}`,
      kind: 'branch',
      children: rightChildren,
      count: rightChildren.reduce((count, child) => count + child.count, 0),
      maxKey: rightChildren.at(-1)!.maxKey,
    };
    access.putNode(node);
    access.putNode(right);
    return [nodeReference(node), nodeReference(right)];
  }

  private async readFrom(
    access: SearchTreeAccess,
    nodeId: string,
    start: number,
    limit: number,
    output: StoredSearchHit[],
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!isCurrent() || output.length >= limit) throw new DOMException('过时的窗口读取', 'AbortError');
    const node = await access.getNode(nodeId);
    if (!node) throw new Error(`搜索索引节点缺失：${nodeId}`);
    if (node.kind === 'leaf') {
      output.push(...node.rows.slice(start, start + limit - output.length));
      return;
    }
    let remainingStart = start;
    for (const child of node.children) {
      if (remainingStart >= child.count) {
        remainingStart -= child.count;
        continue;
      }
      await this.readFrom(access, child.id, remainingStart, limit, output, isCurrent);
      remainingStart = 0;
      if (output.length >= limit) break;
    }
  }
}

let orphanCleanupPromise: Promise<void> | null = null;
const cleanupOrphanedSearchStorage = () => {
  if (orphanCleanupPromise) return orphanCleanupPromise;
  orphanCleanupPromise = (async () => {
    try {
      if (typeof indexedDB !== 'undefined' && indexedDB.databases) {
        const databases = await indexedDB.databases();
        await Promise.all(databases.filter(database => database.name?.startsWith(SEARCH_DATABASE_PREFIX)).map(async database => {
          const name = database.name!;
          await withUnusedSearchLease(name, async () => { await deleteSearchDatabase(name); });
        }));
      }
      if (navigator.storage?.getDirectory) {
        const storageRoot = await navigator.storage.getDirectory();
        const root = await storageRoot.getDirectoryHandle(SEARCH_TREE_ROOT_DIRECTORY, { create: true });
        const entries = (root as FileSystemDirectoryHandle & {
          entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
        }).entries();
        for await (const [name] of entries) {
          if (!name.startsWith(SEARCH_DATABASE_PREFIX)) continue;
          await withUnusedSearchLease(name, async () => {
            try { await root.removeEntry(name, { recursive: true }); } catch { /* best effort */ }
          });
        }
      }
    } catch {
      // A fresh uniquely named session remains safe when best-effort orphan cleanup is unavailable.
    }
  })();
  return orphanCleanupPromise;
};

void cleanupOrphanedSearchStorage();

const createIndexedDbSearchStore = async () => {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB 不可用');
  await cleanupOrphanedSearchStorage();
  const databaseName = `${SEARCH_DATABASE_PREFIX}${Date.now()}-${crypto.randomUUID()}`;
  const lease = await SearchStorageLease.acquire(databaseName);
  let backend: IndexedDbTreeBackend | undefined;
  try {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore('nodes', { keyPath: 'id' });
      database.createObjectStore('values', { keyPath: 'key' });
    };
    backend = new IndexedDbTreeBackend(await requestResult(request), databaseName, lease);
    return await DiskBPlusTreeSearchStore.open(backend);
  } catch (error) {
    if (backend) await backend.dispose();
    else await lease.release();
    throw error;
  }
};

// eslint-disable-next-line react-refresh/only-export-components
export const createOpfsSearchStore = async () => {
  if (!navigator.storage?.getDirectory) throw new Error('OPFS 不可用');
  await cleanupOrphanedSearchStorage();
  const directoryName = `${SEARCH_DATABASE_PREFIX}${Date.now()}-${crypto.randomUUID()}`;
  const lease = await SearchStorageLease.acquire(directoryName);
  try {
    const storageRoot = await navigator.storage.getDirectory();
    const root = await storageRoot.getDirectoryHandle(SEARCH_TREE_ROOT_DIRECTORY, { create: true });
    const directory = await root.getDirectoryHandle(directoryName, { create: true });
    return await DiskBPlusTreeSearchStore.open(new OpfsTreeBackend(root, directory, directoryName, lease));
  } catch (error) {
    await lease.release();
    await withUnusedSearchLease(directoryName, async () => {
      try {
        const storageRoot = await navigator.storage.getDirectory();
        const root = await storageRoot.getDirectoryHandle(SEARCH_TREE_ROOT_DIRECTORY, { create: true });
        await root.removeEntry(directoryName, { recursive: true });
      } catch { /* best effort */ }
    });
    throw error;
  }
};

// eslint-disable-next-line react-refresh/only-export-components
export const createSearchResultStore = async (): Promise<{ store: GlobalSearchResultStore; degraded: boolean }> => {
  try {
    return { store: await createIndexedDbSearchStore(), degraded: false };
  } catch {
    return { store: await createOpfsSearchStore(), degraded: true };
  }
};

const entryTypeLabel = (entry: ProjectFileEntry) => {
  if (entry.kind === 'video') return '视频';
  if (entry.kind === 'image') return '图片';
  if (entry.kind === 'raw') return 'RAW';
  if (entry.kind === 'shortcut') return '快捷方式';
  return entry.extension ? entry.extension.replace(/^\./, '').toLocaleUpperCase() : '文件';
};

const discoverSources = async (config: AppConfig): Promise<{ sources: GlobalSearchSource[]; errors: string[] }> => {
  const roots = normalizeWorkspacePaths(config.workspacePath, config.workspacePaths);
  const catalogs = await Promise.all(roots.map(async requestedRoot => {
    try {
      return { requestedRoot, result: await projectWorkspaceClient.getWorkspaceProjects(requestedRoot) };
    } catch(catalogError) {
      return { requestedRoot, result: { success: false as const, statuses: [], error: catalogError instanceof Error ? catalogError.message : String(catalogError) } };
    }
  }));
  const errors: string[] = [];
  const projectSources: GlobalSearchSource[] = [];
  const seenPaths = new Set<string>();
  for (const { requestedRoot, result } of catalogs) {
    if (!result.success) {
      errors.push(`${requestedRoot}：${result.error || '无法读取项目'}`);
      continue;
    }
    for (const project of result.statuses.flatMap(group => group.projects)) {
      if (project.availability === 'missing' || project.archived) continue;
      const key = normalizePathKey(project.path);
      if (!key || seenPaths.has(key)) continue;
      seenPaths.add(key);
      const workspacePath = project.workspacePath || result.root || requestedRoot;
      projectSources.push({
        id: `project:${key}`,
        kind: 'project',
        label: project.name,
        workspacePath,
        project: { ...project, workspacePath },
      });
    }
  }
  const inspirationRoot = config.inspirationLibrary.rootPath.trim();
  const sources: GlobalSearchSource[] = inspirationRoot ? [{
    id: `inspiration:${normalizePathKey(inspirationRoot)}`,
    kind: 'inspiration' as const,
    label: t("ui.inspiration.library.9ac871"),
    workspacePath: inspirationRoot,
    project: {
      id: `inspiration:${inspirationRoot}`,
      name: INSPIRATION_PROJECT_NAME,
      path: inspirationRoot,
      workspacePath: inspirationRoot,
      status: '未分类',
      updatedAt: Date.now(),
    },
  }, ...projectSources] : projectSources;
  sources.sort((left, right) => left.label.localeCompare(right.label, 'zh-CN', { numeric: true, sensitivity: 'base' })
    || left.id.localeCompare(right.id, 'zh-CN', { numeric: true, sensitivity: 'base' }));
  return { sources, errors };
};

// eslint-disable-next-line react-refresh/only-export-components
export const streamGlobalSearchSource = async ({
  source,
  query,
  isCurrent,
  activeCursors,
  store,
  fetchPage = (currentSource, currentQuery, cursor) => projectWorkspaceClient.listProjectFiles(
    currentSource.workspacePath,
    currentSource.project.status,
    currentSource.project.name,
    '',
    SEARCH_PAGE_SIZE,
    cursor,
    { query: currentQuery },
  ),
  cancelCursor = cursor => projectWorkspaceClient.cancelListProjectFiles(cursor),
  onStored,
}: {
  source: GlobalSearchSource;
  query: string;
  isCurrent: () => boolean;
  activeCursors: Set<string>;
  store: GlobalSearchResultStore;
  fetchPage?: GlobalSearchPageFetcher;
  cancelCursor?: (cursor: string) => Promise<unknown>;
  onStored?: (snapshot: SearchStoreSnapshot) => void;
}) => {
  let cursor = '';
  do {
    if (cursor) activeCursors.add(cursor);
    let result: Awaited<ReturnType<GlobalSearchPageFetcher>>;
    try {
      result = await fetchPage(source, query, cursor || undefined);
    } catch (fetchError) {
      if (cursor && activeCursors.delete(cursor)) await cancelCursor(cursor);
      throw fetchError;
    }
    if (cursor) activeCursors.delete(cursor);
    if (!isCurrent()) {
      const staleCursor = result.cursor || cursor;
      if (staleCursor) await cancelCursor(staleCursor);
      return;
    }
    if (!result.success) {
      const failedCursor = result.cursor || cursor;
      if (failedCursor) await cancelCursor(failedCursor);
      throw new Error(result.error || '读取文件失败');
    }
    const nextCursor = result.cursor || '';
    if (result.hasMore && nextCursor) activeCursors.add(nextCursor);
    let snapshot: SearchStoreSnapshot;
    try {
      snapshot = await store.append(source, result.entries);
    } catch (appendError) {
      if (nextCursor && activeCursors.delete(nextCursor)) await cancelCursor(nextCursor);
      throw appendError;
    }
    if (!isCurrent()) {
      if (nextCursor && activeCursors.delete(nextCursor)) await cancelCursor(nextCursor);
      return;
    }
    onStored?.(snapshot);
    cursor = nextCursor;
    if (!result.hasMore) {
      if (cursor) activeCursors.delete(cursor);
      break;
    }
  } while (cursor);
};

const SearchResultIcon = ({ entry, config, queueOrder }: { entry: ProjectFileEntry; config: AppConfig; queueOrder: number }) => {
  if (entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video') {
    return <MediaThumbnail entry={entry} cacheConfig={config.mediaCache} requestedSize={320} queueOrder={queueOrder}/>;
  }
  if (entry.kind === 'shortcut') return <Folder size={46} strokeWidth={1.4} className="text-blue-500"/>;
  if (entry.extension.match(/^\.(jpe?g|png|gif|webp|bmp|tiff?)$/i)) return <FileImage size={42} strokeWidth={1.4} className="text-violet-500"/>;
  if (entry.extension.match(/^\.(mp4|mov|mkv|avi|webm)$/i)) return <FileVideo size={42} strokeWidth={1.4} className="text-rose-500"/>;
  return <File size={42} strokeWidth={1.4} className="text-slate-400"/>;
};

export const SearchAllPage = ({ active, config, onOpenFolder, onNotice }: {
  active: boolean;
  config: AppConfig;
  onOpenFolder: (source: GlobalSearchSource, relativePath: string) => void;
  onNotice: (message: string, durationOrTone?: number | 'info' | 'success' | 'warning' | 'error') => void;
}) => {
  useLocale();
  const [query, setQuery] = useScopedPageState('search:query', '');
  const [debouncedQuery, setDebouncedQuery] = useScopedPageState('search:debouncedQuery', '');
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [completedSources, setCompletedSources] = useState(0);
  const [sourceCount, setSourceCount] = useState(0);
  const [resultCount, setResultCount] = useState(0);
  const [storedCount, setStoredCount] = useState(0);
  const [groupCount, setGroupCount] = useState(0);
  const [groupsFinalized, setGroupsFinalized] = useState(false);
  const [storeRevision, setStoreRevision] = useState(0);
  const [degraded, setDegraded] = useState(false);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 600, width: 1152 });
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const resultContentRef = useRef<HTMLDivElement>(null);
  const requestSequenceRef = useRef(0);
  const activeStoreRef = useRef<GlobalSearchResultStore | null>(null);
  const activeCursorsRef = useRef(new Set<string>());
  const windowReadSequenceRef = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!active) return;
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, [active]);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    const resultContent = resultContentRef.current;
    if (!scrollContainer || !resultContent) return;
    const updateSize = () => setViewport(current => ({
      ...current,
      height: Math.max(1, scrollContainer.clientHeight),
      width: Math.max(144, resultContent.clientWidth),
    }));
    const scrollScheduler = createRafSearchScrollScheduler<number>(scrollTop => {
      setViewport(current => current.scrollTop === scrollTop ? current : { ...current, scrollTop });
    });
    const onScroll = () => scrollScheduler.push(scrollContainer.scrollTop);
    const observer = new ResizeObserver(updateSize);
    observer.observe(scrollContainer);
    observer.observe(resultContent);
    scrollContainer.addEventListener('scroll', onScroll, { passive: true });
    updateSize();
    return () => {
      scrollScheduler.clear();
      observer.disconnect();
      scrollContainer.removeEventListener('scroll', onScroll);
    };
  }, []);

  useEffect(() => {
    const sequence = ++requestSequenceRef.current;
    const isCurrent = () => requestSequenceRef.current === sequence;
    const refreshScheduler = createTrailingSearchRefreshScheduler<SearchStoreSnapshot>(snapshot => {
      if (!isCurrent()) return;
      setResultCount(snapshot.totalCount);
      setStoredCount(snapshot.storedCount);
      setGroupCount(snapshot.groupCount);
      setGroupsFinalized(snapshot.groupsFinalized);
      setStoreRevision(value => value + 1);
    });
    const previousStore = activeStoreRef.current;
    activeStoreRef.current = null;
    if (previousStore) void previousStore.dispose();
    void cancelGlobalSearchCursors(activeCursorsRef.current);
    setSelectedId('');
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
    setViewport(current => ({ ...current, scrollTop: 0 }));
    setGroups([]);
    setResultCount(0);
    setStoredCount(0);
    setGroupCount(0);
    setGroupsFinalized(false);
    setDegraded(false);
    if (!active || !debouncedQuery) {
      setLoading(false);
      if (!debouncedQuery) {
        setError('');
        setCompletedSources(0);
        setSourceCount(0);
      }
      return;
    }
    setLoading(true);
    setError('');
    setCompletedSources(0);
    setSourceCount(0);
    void (async () => {
      const discovery = await discoverSources(config);
      if (!isCurrent()) return;
      setSourceCount(discovery.sources.length);
      const scanWithStore = async (store: GlobalSearchResultStore) => {
        const failures = [...discovery.errors];
        let nextSourceIndex = 0;
        const isAttemptCurrent = () => isCurrent() && activeStoreRef.current === store;
        const worker = async () => {
          while (isAttemptCurrent()) {
            const sourceIndex = nextSourceIndex++;
            const source = discovery.sources[sourceIndex];
            if (!source) return;
            try {
              await streamGlobalSearchSource({
                source,
                query: debouncedQuery,
                isCurrent: isAttemptCurrent,
                activeCursors: activeCursorsRef.current,
                store,
                onStored: snapshot => {
                  if (!isAttemptCurrent()) return;
                  refreshScheduler.push(snapshot);
                },
              });
            } catch (sourceError) {
              if (sourceError instanceof SearchStorageError) throw sourceError;
              failures.push(`${source.label}：${sourceError instanceof Error ? sourceError.message : String(sourceError)}`);
            } finally {
              if (isAttemptCurrent()) setCompletedSources(value => value + 1);
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(SEARCH_CONCURRENCY, discovery.sources.length) }, () => worker()));
        if (isAttemptCurrent() && store.finalize) refreshScheduler.push(await store.finalize());
        return failures;
      };

      let storage = await createSearchResultStore();
      if (!isCurrent()) {
        await storage.store.dispose();
        return;
      }
      activeStoreRef.current = storage.store;
      setDegraded(storage.degraded);
      let failures: string[];
      try {
        failures = await scanWithStore(storage.store);
      } catch (storageError) {
        if (!(storageError instanceof SearchStorageError) || !isCurrent()) throw storageError;
        if (storage.store.storageKind !== 'indexeddb') throw storageError;
        activeStoreRef.current = null;
        await cancelGlobalSearchCursors(activeCursorsRef.current);
        await storage.store.dispose();
        refreshScheduler.clear();
        storage = { store: await createOpfsSearchStore(), degraded: true };
        if (!isCurrent()) {
          await storage.store.dispose();
          return;
        }
        activeStoreRef.current = storage.store;
        setDegraded(true);
        setCompletedSources(0);
        setSelectedId('');
        setGroups([]);
        setResultCount(0);
        setStoredCount(0);
        setGroupCount(0);
        setGroupsFinalized(false);
        failures = await scanWithStore(storage.store);
      }
      if (!isCurrent() || activeStoreRef.current !== storage.store) return;
      refreshScheduler.flush();
      setDegraded(storage.degraded);
      const messages = [];
      if (storage.degraded) messages.push('已切换到兼容磁盘索引；全部结果仍可连续浏览');
      if (failures.length) messages.push(`${failures.length} 个位置暂时无法检索，其余结果已显示`);
      setError(messages.join('；'));
    })().catch(searchError => {
      if (isCurrent()) {
        const failedStore = activeStoreRef.current;
        activeStoreRef.current = null;
        if (failedStore) void failedStore.dispose();
        setError(searchError instanceof Error ? searchError.message : String(searchError));
      }
    }).finally(() => {
      if (isCurrent()) setLoading(false);
    });
    return () => {
      requestSequenceRef.current += 1;
      refreshScheduler.clear();
      void cancelGlobalSearchCursors(activeCursorsRef.current);
      const store = activeStoreRef.current;
      activeStoreRef.current = null;
      if (store) void store.dispose();
    };
  }, [active, config, debouncedQuery]);

  const virtualWindow = useMemo(() => calculateGlobalSearchVirtualWindow({
    totalCount: storedCount,
    scrollTop: viewport.scrollTop,
    viewportHeight: viewport.height,
    containerWidth: viewport.width,
  }), [storedCount, viewport]);

  useEffect(() => {
    const store = activeStoreRef.current;
    const limit = virtualWindow.end - virtualWindow.start;
    if (!store || limit <= 0) {
      setGroups([]);
      return;
    }
    const sequence = requestSequenceRef.current;
    const windowReadSequence = ++windowReadSequenceRef.current;
    void store.readWindow(virtualWindow.start, limit).then(windowGroups => {
      if (requestSequenceRef.current === sequence && windowReadSequenceRef.current === windowReadSequence && activeStoreRef.current === store) setGroups(windowGroups);
    }).catch(windowError => {
      if (requestSequenceRef.current === sequence && windowReadSequenceRef.current === windowReadSequence) setError(windowError instanceof Error ? windowError.message : String(windowError));
    });
    return () => { windowReadSequenceRef.current += 1; };
  }, [storeRevision, virtualWindow.end, virtualWindow.start]);

  const windowHitCount = useMemo(() => groups.reduce((count, group) => count + group.entries.length, 0), [groups]);
  const windowHits = useMemo(() => groups.flatMap(group => group.entries.map(entry => ({ group, entry }))), [groups]);

  const openEntry = async (source: GlobalSearchSource, entry: ProjectFileEntry) => {
    try {
      const result = await projectWorkspaceClient.openProjectEntry(source.workspacePath, source.project.status, source.project.name, entry.relativePath);
      if (!result.success) onNotice(`打开文件失败：${result.error || '未知错误'}`, 'error');
    } catch (openError) {
      onNotice(`打开文件失败：${openError instanceof Error ? openError.message : String(openError)}`, 'error');
    }
  };

  const openFolder = async (group: SearchGroup) => {
    try {
      await Promise.resolve(onOpenFolder(group.source, group.folderPath));
    } catch (openError) {
      onNotice(`打开文件夹失败：${openError instanceof Error ? openError.message : String(openError)}`, 'error');
    }
  };

  return <section className="flex h-full min-h-0 flex-col bg-slate-50">
    <header className="shrink-0 border-b border-slate-200 bg-white px-7 py-5">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-center justify-between gap-4">
          <div><h1 className="text-xl font-bold text-slate-900">{t("ui.global.search.f1c10d")}</h1><p className="mt-1 text-xs text-slate-500">{t("ui.search.all.project.workspaces.and.inspiration.081527")}</p></div>
          {loading && <p role="status" aria-live="polite" className="flex shrink-0 items-center gap-2 text-xs text-blue-600"><Loader2 size={14} className="animate-spin"/>{t("message.42f2848525ab", { value0: completedSources, value1: sourceCount || '…' })}</p>}
        </div>
        <div className="mt-4 flex h-11 items-center gap-3 rounded-xl border border-slate-300 bg-slate-50 px-4 shadow-sm focus-within:border-blue-500 focus-within:bg-white focus-within:ring-2 focus-within:ring-blue-100">
          <Search size={19} className="shrink-0 text-slate-400"/>
          <input ref={inputRef} value={query} onChange={event => setQuery(event.target.value)} placeholder={t("ui.enter.file.name.keywords.a150e4")} aria-label={t("ui.search.all.files.6b6b24")} className="min-w-0 flex-1 bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400"/>
          {query && <button type="button" onClick={() => setQuery('')} aria-label={t("ui.clear.search.ee32f2")} title={t("ui.clear.search.ee32f2")} className="rounded-md p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700"><X size={16}/></button>}
        </div>
        {debouncedQuery && <p role="status" aria-live="polite" className="mt-3 text-xs text-slate-500">{loading ? t("ui.found.de03ee") : t("ui.found.0ccc28")} <span className="font-bold text-slate-700">{resultCount}</span> {t("message.90fd6e784f7d", { count: resultCount, value0: groupsFinalized ? t("legacy.message.3b9f977492e2", { value0: groupCount }) : '', value1: degraded ? t("ui.compatible.disk.index.87ec9e") : '' })}</p>}
        {error && <p role="alert" className="mt-2 text-xs text-amber-600"><LocalizedText value={error}/></p>}
      </div>
    </header>
    <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
      <div ref={resultContentRef} className="mx-auto max-w-6xl pb-8">
        {!debouncedQuery && <div className="flex min-h-[360px] items-center justify-center text-center"><div><span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-50 text-blue-500"><Search size={30}/></span><h2 className="mt-5 text-base font-bold text-slate-700">{t("ui.find.any.file.in.your.projects.b8b487")}</h2><p className="mt-2 text-sm text-slate-400">{t("ui.enter.file.name.keywords.results.are.817a4b")}</p></div></div>}
        {debouncedQuery && loading && !windowHitCount && <p className="py-20 text-center text-sm text-slate-400"><Loader2 size={18} className="mr-2 inline animate-spin"/>{t("ui.searching.all.locations.9de4cc")}</p>}
        {debouncedQuery && !loading && !resultCount && <div className="py-20 text-center"><Search size={32} className="mx-auto text-slate-300"/><p className="mt-4 text-sm text-slate-500">{t("message.07220178fa1a", { value0: debouncedQuery })}</p></div>}
        <div role="list" aria-label={t("ui.global.search.results.e63bed")}>
          <div aria-hidden="true" style={{ height: virtualWindow.topSpacer }}/>
          <div className="grid w-full content-start gap-x-3" style={{ gridTemplateColumns: `repeat(${virtualWindow.columns}, minmax(0, 1fr))` }}>
            {windowHits.map(({ group, entry }, windowIndex) => {
              const id = `${group.id}\0${entry.relativePath}\0${entry.path}`;
              return <div key={`${id}\0${virtualWindow.start + windowIndex}`} role="listitem" aria-setsize={storedCount} aria-posinset={virtualWindow.start + windowIndex + 1} style={{ height: virtualWindow.rowHeight }} className="min-w-0 overflow-hidden px-0.5 pt-0.5">
                <button type="button" aria-pressed={selectedId === id} aria-label={`${entry.name}，${entryTypeLabel(entry)}`} title={entry.relativePath} onClick={() => setSelectedId(id)} onDoubleClick={() => void openEntry(group.source, entry)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void openEntry(group.source, entry); } }} className={`group block w-full min-w-0 cursor-default overflow-hidden rounded-lg p-2 text-left transition hover:bg-blue-50 ${selectedId === id ? 'bg-blue-50 ring-1 ring-blue-400' : ''}`}>
                  <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-md bg-white shadow-sm ring-1 ring-slate-200/80"><SearchResultIcon entry={entry} config={config} queueOrder={windowIndex}/></div>
                  <p className="mt-2 truncate text-xs font-medium text-slate-700">{entry.name}</p><p className="mt-0.5 truncate text-[10px] uppercase text-slate-400">{entryTypeLabel(entry)}</p>
                </button>
                <button type="button" onClick={() => void openFolder(group)} title={t("ui.open.value0.value1.91fe29", { value0: group.source.label, value1: group.folderPath || t("ui.project.root.3db07c") })} className="mt-1 flex w-full min-w-0 items-center gap-1 px-2 text-left text-[10px] text-slate-400 hover:text-blue-600"><Folder size={11} className="shrink-0"/><span className="truncate">{group.source.label} / {group.folderPath || t("ui.project.root.3db07c")}</span></button>
              </div>;
            })}
          </div>
          <div aria-hidden="true" style={{ height: virtualWindow.bottomSpacer }}/>
        </div>
      </div>
    </div>
  </section>;
};
