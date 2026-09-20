"""Persistent SQLite index for the media thumbnail pipeline.

The process runs as a small JSON-lines service. Keeping SQLite in Python avoids
shipping a Node native addon whose ABI must match every Electron release.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import sys
import time
import uuid
from pathlib import Path


THUMBNAIL_STATES = {"NOT_READY", "QUEUED", "GENERATING", "READY", "STALE", "FAILED", "MISSING"}
CACHE_INVALIDATION_BATCH_SIZE = 512
MEDIA_EXTENSIONS = {
    ".jpg": "image", ".jpeg": "image", ".png": "image", ".gif": "image",
    ".webp": "image", ".bmp": "image", ".tif": "image", ".tiff": "image",
    ".heic": "image", ".heif": "image", ".hif": "image", ".avif": "image",
    ".mp4": "video", ".mov": "video", ".m4v": "video", ".webm": "video",
    ".avi": "video", ".mkv": "video", ".mpeg": "video", ".mpg": "video",
    ".mts": "video", ".m2ts": "video",
    ".cr2": "raw", ".cr3": "raw", ".nef": "raw", ".arw": "raw",
    ".raf": "raw", ".orf": "raw", ".rw2": "raw", ".dng": "raw",
    ".rwl": "raw", ".3fr": "raw", ".fff": "raw", ".iiq": "raw",
    ".pef": "raw", ".srw": "raw",
}
JPG_CONVERSION_EXTENSIONS = (
    ".png", ".webp", ".heic", ".heif", ".hif", ".avif",
    ".tif", ".tiff", ".bmp", ".gif",
)


def is_internal_transient_media_path(value: str) -> bool:
    for segment in Path(value).parts:
        normalized = segment.lower()
        if ".photoflow-part" in normalized:
            return True
        if normalized in (".photoflow-workspace-id", "_photoflow_safety_temp"):
            return True
        if normalized.startswith(".") and ".photoflow-" in normalized:
            return True
    return False


def now_ms() -> int:
    return int(time.time() * 1000)


def canonical(value: str) -> str:
    return os.path.normcase(os.path.abspath(value))


def source_hash(file_path: str) -> str:
    digest = hashlib.sha256()
    with open(file_path, "rb") as source:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


class ThumbnailPublishError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class ThumbnailDatabase:
    def __init__(self, database_path: str, recover: bool = True):
        Path(database_path).parent.mkdir(parents=True, exist_ok=True)
        try:
            self.connection = sqlite3.connect(database_path, timeout=30)
            self.connection.execute("PRAGMA schema_version").fetchone()
        except sqlite3.Error as error:
            if getattr(self, "connection", None) is not None:
                self.connection.close()
            raise RuntimeError(f"thumbnail database bootstrap failed: {error}") from error
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=NORMAL")
        self.connection.execute("PRAGMA foreign_keys=ON")
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS files (
                path TEXT PRIMARY KEY,
                project_root TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                kind TEXT NOT NULL,
                size INTEGER NOT NULL,
                mtime_ms REAL NOT NULL,
                source_hash TEXT,
                version INTEGER NOT NULL DEFAULT 1,
                thumbnail_state TEXT NOT NULL DEFAULT 'NOT_READY',
                last_error TEXT,
                exists_on_disk INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS thumbnails (
                file_path TEXT NOT NULL,
                size_label TEXT NOT NULL,
                pixel_size INTEGER NOT NULL,
                thumbnail_path TEXT NOT NULL,
                thumbnail_size INTEGER NOT NULL,
                thumbnail_version INTEGER NOT NULL,
                source_mtime_ms REAL NOT NULL,
                source_hash TEXT,
                cache_epoch INTEGER NOT NULL DEFAULT 1,
                cache_root TEXT NOT NULL DEFAULT '',
                publish_id TEXT NOT NULL DEFAULT '',
                generated_at INTEGER NOT NULL,
                last_accessed_at INTEGER NOT NULL,
                PRIMARY KEY(file_path, size_label),
                FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS project_indexes (
                project_root TEXT PRIMARY KEY,
                state TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                completed_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS maintenance_state (
                key TEXT PRIMARY KEY,
                completed_at INTEGER NOT NULL,
                cursor_json TEXT NOT NULL DEFAULT '{}'
            );

            CREATE TABLE IF NOT EXISTS cache_control (
                singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                cache_epoch INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS thumbnail_publish_receipts (
                publish_id TEXT PRIMARY KEY,
                file_path TEXT NOT NULL,
                cache_epoch INTEGER NOT NULL,
                source_version INTEGER NOT NULL,
                result_json TEXT NOT NULL,
                committed_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS thumbnail_orphan_delete_retries (
                thumbnail_path TEXT PRIMARY KEY,
                cache_root TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 1,
                last_error TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS thumbnail_orphan_scan_state (
                generation TEXT NOT NULL,
                cache_root TEXT NOT NULL,
                root_index INTEGER NOT NULL,
                prepared_at INTEGER NOT NULL,
                started_mtime_ns INTEGER NOT NULL DEFAULT 0,
                completed_mtime_ns INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(generation,cache_root,root_index)
            );
            CREATE TABLE IF NOT EXISTS thumbnail_orphan_scan_entries (
                generation TEXT NOT NULL,
                cache_root TEXT NOT NULL,
                root_index INTEGER NOT NULL,
                thumbnail_path TEXT NOT NULL,
                processed INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(generation,cache_root,root_index,thumbnail_path)
            );
            """
        )
        thumbnail_columns = {
            row["name"] for row in self.connection.execute("PRAGMA table_info(thumbnails)").fetchall()
        }
        if "cache_epoch" not in thumbnail_columns:
            self.connection.execute("ALTER TABLE thumbnails ADD COLUMN cache_epoch INTEGER NOT NULL DEFAULT 1")
        if "cache_root" not in thumbnail_columns:
            self.connection.execute("ALTER TABLE thumbnails ADD COLUMN cache_root TEXT NOT NULL DEFAULT ''")
        if "publish_id" not in thumbnail_columns:
            self.connection.execute("ALTER TABLE thumbnails ADD COLUMN publish_id TEXT NOT NULL DEFAULT ''")
        maintenance_columns = {
            row["name"] for row in self.connection.execute("PRAGMA table_info(maintenance_state)").fetchall()
        }
        if "cursor_json" not in maintenance_columns:
            self.connection.execute("ALTER TABLE maintenance_state ADD COLUMN cursor_json TEXT NOT NULL DEFAULT '{}'")
        orphan_scan_columns = {
            row["name"] for row in self.connection.execute("PRAGMA table_info(thumbnail_orphan_scan_entries)").fetchall()
        }
        if "processed" not in orphan_scan_columns:
            self.connection.execute("ALTER TABLE thumbnail_orphan_scan_entries ADD COLUMN processed INTEGER NOT NULL DEFAULT 0")
        orphan_scan_state_columns = {
            row["name"] for row in self.connection.execute("PRAGMA table_info(thumbnail_orphan_scan_state)").fetchall()
        }
        if "started_mtime_ns" not in orphan_scan_state_columns:
            self.connection.execute("ALTER TABLE thumbnail_orphan_scan_state ADD COLUMN started_mtime_ns INTEGER NOT NULL DEFAULT 0")
        if "completed_mtime_ns" not in orphan_scan_state_columns:
            self.connection.execute("ALTER TABLE thumbnail_orphan_scan_state ADD COLUMN completed_mtime_ns INTEGER NOT NULL DEFAULT 0")
        self.connection.execute(
            """CREATE INDEX IF NOT EXISTS thumbnail_orphan_scan_entries_pending
               ON thumbnail_orphan_scan_entries(generation,cache_root,processed,root_index,thumbnail_path)"""
        )
        # Recovery acknowledgements intentionally update every generation for a
        # path. The paged-scan indexes start with generation/cache_root and cannot
        # serve these lookups; without this index each candidate scans the table.
        self.connection.execute(
            """CREATE INDEX IF NOT EXISTS thumbnail_orphan_scan_entries_path
               ON thumbnail_orphan_scan_entries(thumbnail_path)"""
        )
        self.connection.execute("INSERT OR IGNORE INTO cache_control(singleton,cache_epoch) VALUES(1,1)")
        self.connection.commit()
        # Directory enumeration is deliberately kept outside SQLite and resumed
        # in-process. Sorting the entire cache directory for every recovery page
        # made each small page O(total cache files) and blocked the JSON service
        # for seconds on large caches.
        self._orphan_scan_iterators = {}

    def close(self) -> None:
        for iterator, _offset in self._orphan_scan_iterators.values():
            iterator.close()
        self._orphan_scan_iterators.clear()
        self.connection.commit()
        self.connection.close()

    @staticmethod
    def _directory_mtime_ns(directory: str) -> int:
        try:
            return int(os.stat(directory).st_mtime_ns)
        except OSError:
            return 0

    def _upsert_file(self, project_root: str, file_path: str, kind: str, stat: os.stat_result,
                     calculate_hash: bool = False) -> dict:
        project_root = canonical(project_root)
        file_path = canonical(file_path)
        current = self.connection.execute("SELECT * FROM files WHERE path=?", (file_path,)).fetchone()
        mtime_ms = stat.st_mtime_ns / 1_000_000
        changed = current is None or current["size"] != stat.st_size or current["mtime_ms"] != mtime_ms
        # Size/mtime are the cheap change detector. Hash only new or changed
        # sources (or records imported before hashes existed); unchanged media
        # must not be reread in full on every application launch.
        should_hash = calculate_hash and (changed or current is None or not current["source_hash"])
        # Never carry a hash across a size/mtime change. If a later duplicate
        # check needs it, that explicit operation can calculate a fresh value.
        digest = source_hash(file_path) if should_hash else (current["source_hash"] if current and not changed else None)
        if current is not None and current["source_hash"] and digest and digest != current["source_hash"]:
            changed = True
        timestamp = now_ms()
        inserted = False
        if current is None:
            state = "NOT_READY"
            version = 1
            cursor = self.connection.execute(
                """INSERT OR IGNORE INTO files
                   (path, project_root, relative_path, kind, size, mtime_ms, source_hash, version,
                    thumbnail_state, exists_on_disk, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)""",
                (file_path, project_root, os.path.relpath(file_path, project_root), kind, stat.st_size,
                 mtime_ms, digest, version, state, timestamp, timestamp),
            )
            inserted = cursor.rowcount > 0
            if not inserted:
                # A foreground directory sync and the background project scan
                # may discover the same path concurrently. Treat the winner's
                # row as current instead of aborting the whole scan.
                current = self.connection.execute("SELECT * FROM files WHERE path=?", (file_path,)).fetchone()
                changed = current["size"] != stat.st_size or current["mtime_ms"] != mtime_ms
                if digest is None and not changed:
                    digest = current["source_hash"]
        if not inserted:
            state = "STALE" if changed else current["thumbnail_state"]
            if not changed and state == "MISSING":
                state = "NOT_READY"
            version = current["version"] + 1 if changed else current["version"]
            self.connection.execute(
                """UPDATE files SET project_root=?, relative_path=?, kind=?, size=?, mtime_ms=?,
                   source_hash=?, version=?, thumbnail_state=?, last_error=NULL, exists_on_disk=1,
                   updated_at=? WHERE path=?""",
                (project_root, os.path.relpath(file_path, project_root), kind, stat.st_size, mtime_ms,
                 digest, version, state, timestamp, file_path),
            )
            if changed:
                self.connection.execute("DELETE FROM thumbnails WHERE file_path=?", (file_path,))
        return {"path": file_path, "kind": kind, "state": state, "changed": changed,
                "size": stat.st_size, "mtimeMs": mtime_ms, "sourceHash": digest, "version": version}

    def sync_directory(self, project_root: str, directory: str) -> dict:
        project_root, directory = canonical(project_root), canonical(directory)
        seen = set()
        records = []
        with self.connection:
            for entry in os.scandir(directory):
                if not entry.is_file(follow_symlinks=False):
                    continue
                kind = MEDIA_EXTENSIONS.get(Path(entry.name).suffix.lower())
                if not kind:
                    continue
                record = self._upsert_file(project_root, entry.path, kind, entry.stat(follow_symlinks=False))
                records.append(record)
                seen.add(canonical(entry.path))
            prefix = directory + os.sep
            rows = self.connection.execute(
                "SELECT path FROM files WHERE project_root=? AND path LIKE ? AND exists_on_disk=1",
                (project_root, prefix + "%"),
            ).fetchall()
            timestamp = now_ms()
            for row in rows:
                relative_to_directory = os.path.relpath(row["path"], directory)
                if os.sep in relative_to_directory or row["path"] in seen:
                    continue
                self.connection.execute(
                    "UPDATE files SET thumbnail_state='MISSING', exists_on_disk=0, updated_at=? WHERE path=?",
                    (timestamp, row["path"]),
                )
        return {"records": records}

    def sync_project(self, project_root: str) -> dict:
        project_root = canonical(project_root)
        started_at = now_ms()
        with self.connection:
            self.connection.execute(
                """INSERT INTO project_indexes (project_root, state, started_at, completed_at)
                   VALUES (?, 'BUILDING', ?, NULL)
                   ON CONFLICT(project_root) DO UPDATE SET
                     state='BUILDING', started_at=excluded.started_at, completed_at=NULL""",
                (project_root, started_at),
            )
        seen = set()
        pending = []
        changed_count = 0
        writes_since_commit = 0
        for directory, directory_names, file_names in os.walk(project_root):
            directory_names[:] = [
                name for name in directory_names
                if not is_internal_transient_media_path(os.path.join(directory, name))
            ]
            for name in file_names:
                if is_internal_transient_media_path(os.path.join(directory, name)):
                    continue
                kind = MEDIA_EXTENSIONS.get(Path(name).suffix.lower())
                if not kind:
                    continue
                file_path = canonical(os.path.join(directory, name))
                try:
                    # Opening a project is an index refresh, not a duplicate
                    # verification pass. Size and mtime are sufficient here;
                    # reading every byte of multi-gigabyte videos made cold
                    # starts compete directly with visible previews.
                    record = self._upsert_file(project_root, file_path, kind, os.stat(file_path), calculate_hash=False)
                except (FileNotFoundError, PermissionError, OSError):
                    continue
                seen.add(file_path)
                changed_count += int(record["changed"])
                if record["state"] in {"NOT_READY", "STALE", "QUEUED", "FAILED"}:
                    pending.append(record)
                writes_since_commit += 1
                # Keep writer-lock windows short without forcing a disk commit
                # for every individual file in a large project.
                if writes_since_commit >= 256:
                    self.connection.commit()
                    writes_since_commit = 0
        self.connection.commit()
        timestamp = now_ms()
        with self.connection:
            if pending:
                self.connection.executemany(
                    "UPDATE files SET thumbnail_state='QUEUED', updated_at=? WHERE path=?",
                    [(timestamp, record["path"]) for record in pending],
                )
            for row in self.connection.execute(
                "SELECT path FROM files WHERE project_root=? AND exists_on_disk=1", (project_root,)
            ).fetchall():
                if row["path"] not in seen:
                    self.connection.execute(
                        "UPDATE files SET thumbnail_state='MISSING', exists_on_disk=0, updated_at=? WHERE path=?",
                        (timestamp, row["path"]),
                    )
            self.connection.execute(
                "UPDATE project_indexes SET state='READY', completed_at=? WHERE project_root=?",
                (timestamp, project_root),
            )
        return {"fileCount": len(seen), "changedCount": changed_count, "pending": pending}

    def inspect_tool_sources(self, project_root: str, paths: list[str], collect_videos: bool = False,
                             collect_direct_convertible_images: bool = False,
                             collect_recursive_convertible_images: bool = False) -> dict:
        """Read tool availability from the existing background-built media index."""
        project_root = canonical(project_root)
        index_row = self.connection.execute(
            "SELECT state FROM project_indexes WHERE project_root=?", (project_root,)
        ).fetchone()
        if not index_row or index_row["state"] != "READY":
            return {"indexed": False, "hasVideo": False, "hasConvertibleImage": False,
                    "videoPaths": [], "convertibleImagePaths": []}

        targets = list(dict.fromkeys(canonical(value) for value in paths if value))
        if not targets:
            return {"indexed": True, "hasVideo": False, "hasConvertibleImage": False,
                    "videoPaths": [], "convertibleImagePaths": []}

        has_video = False
        has_convertible_image = False
        video_paths = []
        convertible_image_paths = []
        conversion_condition = "(" + " OR ".join(
            "lower(path) LIKE ?" for _extension in JPG_CONVERSION_EXTENSIONS
        ) + ")"
        conversion_parameters = [f"%{extension}" for extension in JPG_CONVERSION_EXTENSIONS]
        # Keep every query comfortably below SQLite's host-parameter limit,
        # including when the renderer has selected thousands of individual files.
        for offset in range(0, len(targets), 200):
            conditions = []
            parameters: list[str] = [project_root]
            for target in targets[offset:offset + 200]:
                escaped = target.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                conditions.append("(path=? OR path LIKE ? ESCAPE '\\')")
                parameters.extend((target, escaped + os.sep.replace("\\", "\\\\") + "%"))
            scope = " OR ".join(conditions)
            base_query = f"FROM files WHERE project_root=? AND exists_on_disk=1 AND ({scope})"
            chunk_has_video = self.connection.execute(
                f"SELECT 1 {base_query} AND kind='video' LIMIT 1", parameters
            ).fetchone() is not None
            has_video = has_video or chunk_has_video
            if collect_recursive_convertible_images:
                recursive_image_rows = self.connection.execute(
                    f"SELECT path {base_query} AND kind='image' AND {conversion_condition}",
                    [*parameters, *conversion_parameters],
                ).fetchall()
                has_convertible_image = has_convertible_image or bool(recursive_image_rows)
                convertible_image_paths.extend(row["path"] for row in recursive_image_rows)
            elif collect_direct_convertible_images:
                direct_conditions = []
                direct_parameters: list[object] = [project_root]
                for target in targets[offset:offset + 200]:
                    direct_prefix = target + os.sep
                    escaped_prefix = direct_prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                    direct_conditions.append("(path=? OR (path LIKE ? ESCAPE '\\' AND instr(substr(path, ?), ?) = 0))")
                    direct_parameters.extend((target, escaped_prefix + "%", len(direct_prefix) + 1, os.sep))
                direct_scope = " OR ".join(direct_conditions)
                direct_query = (f"FROM files WHERE project_root=? AND exists_on_disk=1 AND ({direct_scope}) "
                                f"AND kind='image' AND {conversion_condition}")
                direct_image_rows = self.connection.execute(
                    f"SELECT path {direct_query}", [*direct_parameters, *conversion_parameters]
                ).fetchall()
                has_convertible_image = has_convertible_image or bool(direct_image_rows)
                convertible_image_paths.extend(row["path"] for row in direct_image_rows)
            else:
                has_convertible_image = has_convertible_image or self.connection.execute(
                    f"SELECT 1 {base_query} AND kind='image' AND {conversion_condition} LIMIT 1",
                    [*parameters, *conversion_parameters],
                ).fetchone() is not None
            if collect_videos and chunk_has_video:
                video_paths.extend(row["path"] for row in self.connection.execute(
                    f"SELECT path {base_query} AND kind='video'", parameters
                ).fetchall())
            if (not collect_videos and not collect_direct_convertible_images
                    and not collect_recursive_convertible_images and has_video and has_convertible_image):
                break
        video_paths.sort(key=str.casefold)
        convertible_image_paths = sorted(dict.fromkeys(convertible_image_paths), key=str.casefold)
        return {
            "indexed": True,
            "hasVideo": has_video,
            "hasConvertibleImage": has_convertible_image,
            "videoPaths": video_paths,
            "convertibleImagePaths": convertible_image_paths,
        }

    def sync_paths(self, project_root: str, paths: list[str], calculate_hash: bool = False) -> dict:
        project_root = canonical(project_root)
        records = []
        with self.connection:
            for value in paths:
                file_path = canonical(value)
                if is_internal_transient_media_path(file_path):
                    continue
                kind = MEDIA_EXTENSIONS.get(Path(file_path).suffix.lower())
                if os.path.isfile(file_path) and kind:
                    records.append(self._upsert_file(project_root, file_path, kind, os.stat(file_path), calculate_hash=calculate_hash))
                else:
                    self.connection.execute(
                        "UPDATE files SET thumbnail_state='MISSING', exists_on_disk=0, updated_at=? WHERE path=?",
                        (now_ms(), file_path),
                    )
                    records.append({"path": file_path, "state": "MISSING", "changed": True})
        return {"records": records}

    def get_file(self, file_path: str) -> dict | None:
        row = self.connection.execute("SELECT * FROM files WHERE path=?", (canonical(file_path),)).fetchone()
        return dict(row) if row else None

    def set_state(self, file_path: str, state: str, error: str | None = None) -> dict:
        if state not in THUMBNAIL_STATES:
            raise ValueError(f"invalid thumbnail state: {state}")
        self.connection.execute(
            "UPDATE files SET thumbnail_state=?, last_error=?, updated_at=? WHERE path=?",
            (state, error, now_ms(), canonical(file_path)),
        )
        self.connection.commit()
        return {"state": state}

    def set_states(self, file_paths: list[str], state: str) -> dict:
        if state not in THUMBNAIL_STATES:
            raise ValueError(f"invalid thumbnail state: {state}")
        timestamp = now_ms()
        with self.connection:
            self.connection.executemany(
                "UPDATE files SET thumbnail_state=?, last_error=NULL, updated_at=? WHERE path=?",
                [(state, timestamp, canonical(file_path)) for file_path in file_paths],
            )
        return {"state": state, "count": len(file_paths)}

    def get_cache_epoch(self) -> dict:
        row = self.connection.execute(
            "SELECT cache_epoch FROM cache_control WHERE singleton=1"
        ).fetchone()
        return {"cacheEpoch": int(row["cache_epoch"] if row else 1)}

    def get_thumbnail_publish(self, file_path: str, size_label: str,
                              source_size: int, source_mtime_ms: float) -> dict | None:
        row = self.connection.execute(
            """SELECT thumbnails.thumbnail_path,thumbnails.thumbnail_size,thumbnails.cache_epoch,
                      thumbnails.thumbnail_version,files.version
               FROM thumbnails JOIN files ON files.path=thumbnails.file_path
               WHERE thumbnails.file_path=? AND thumbnails.size_label=?
                 AND files.size=? AND files.mtime_ms=?
                 AND thumbnails.thumbnail_version=files.version""",
            (canonical(file_path), str(size_label), int(source_size), float(source_mtime_ms)),
        ).fetchone()
        if row is None or not os.path.isfile(row["thumbnail_path"]):
            return None
        return {
            "thumbnailPath": row["thumbnail_path"],
            "verifiedFile": True,
            "thumbnailSize": int(row["thumbnail_size"]),
            "cacheEpoch": int(row["cache_epoch"]),
            "sourceVersion": int(row["version"]),
        }

    def bump_cache_epoch(self) -> dict:
        with self.connection:
            self.connection.execute(
                "UPDATE cache_control SET cache_epoch=cache_epoch+1 WHERE singleton=1"
            )
            row = self.connection.execute(
                "SELECT cache_epoch FROM cache_control WHERE singleton=1"
            ).fetchone()
        return {"cacheEpoch": int(row["cache_epoch"])}

    def begin_cache_maintenance(self) -> dict:
        with self.connection:
            self.connection.execute(
                "UPDATE cache_control SET cache_epoch=cache_epoch+1 WHERE singleton=1"
            )
            epoch = int(self.connection.execute(
                "SELECT cache_epoch FROM cache_control WHERE singleton=1"
            ).fetchone()[0])
        return {"cacheEpoch": epoch}

    def capture_thumbnail_publish(self, file_path: str, kind: str,
                                  project_root: str | None = None) -> dict:
        file_path = canonical(file_path)
        stat = os.stat(file_path)
        existing = self.connection.execute(
            "SELECT project_root FROM files WHERE path=?", (file_path,)
        ).fetchone()
        root = canonical(project_root or (existing["project_root"] if existing else os.path.dirname(file_path)))
        with self.connection:
            record = self._upsert_file(root, file_path, kind, stat, calculate_hash=False)
        epoch = self.get_cache_epoch()["cacheEpoch"]
        return {
            "cacheEpoch": epoch,
            "filePath": file_path,
            "sourceVersion": int(record["version"]),
            "sourceSize": int(record["size"]),
            "sourceMtimeMs": float(record["mtimeMs"]),
        }

    def resolve_thumbnail_publish(self, publish_id: str) -> dict:
        identifier = str(publish_id or "")
        row = self.connection.execute(
            "SELECT result_json FROM thumbnail_publish_receipts WHERE publish_id=?", (identifier,)
        ).fetchone()
        if row is None:
            return {"state": "NOT_FOUND", "committed": False, "publishId": identifier}
        result = json.loads(row["result_json"])
        return {"state": "COMMITTED", "committed": True, "publishId": identifier, "result": result}

    def claim_thumbnail_backup_recovery(self, publish_id: str, thumbnail_paths: list[str]) -> dict:
        identifier = str(publish_id or "")
        normalized = list(dict.fromkeys(canonical(value) for value in (thumbnail_paths or []) if value))
        with self.connection:
            receipt = self.connection.execute(
                "SELECT 1 FROM thumbnail_publish_receipts WHERE publish_id=?", (identifier,)
            ).fetchone()
            if receipt:
                return {"state": "COMMITTED", "committed": True, "publishId": identifier}
            owners = []
            for offset in range(0, len(normalized), 400):
                chunk = normalized[offset:offset + 400]
                placeholders = ",".join("?" for _ in chunk)
                owners.extend(self.connection.execute(
                    f"SELECT thumbnail_path,publish_id,file_path,size_label FROM thumbnails WHERE thumbnail_path IN ({placeholders})",
                    chunk,
                ).fetchall())
            if owners:
                return {
                    "state": "SUPERSEDED", "committed": False, "publishId": identifier,
                    "owners": [
                        {"thumbnailPath": row["thumbnail_path"], "publishId": row["publish_id"],
                         "filePath": row["file_path"], "sizeLabel": row["size_label"]}
                        for row in owners
                    ],
                }
            return {"state": "CLAIMED", "committed": False, "publishId": identifier}

    def commit_thumbnail_publish(self, publish_id: str, file_path: str, cache_epoch: int,
                                 source_version: int, source_size: int,
                                 source_mtime_ms: float, thumbnails: list[dict],
                                 source_digest: str | None = None) -> dict:
        identifier = str(publish_id or "")
        if not identifier or len(identifier) > 128:
            raise ValueError("invalid thumbnail publish ID")
        previous = self.resolve_thumbnail_publish(identifier)
        if previous["committed"]:
            return previous["result"]
        file_path = canonical(file_path)
        epoch = self.get_cache_epoch()["cacheEpoch"]
        if int(cache_epoch) != epoch:
            raise ThumbnailPublishError("EPOCH_STALE", "thumbnail cache epoch changed")
        row = self.connection.execute(
            "SELECT version,size,mtime_ms FROM files WHERE path=?", (file_path,)
        ).fetchone()
        if (row is None or int(row["version"]) != int(source_version) \
                or int(row["size"]) != int(source_size) \
                or float(row["mtime_ms"]) != float(source_mtime_ms)):
            raise ThumbnailPublishError("SOURCE_STALE", "thumbnail source revision changed")
        try:
            source_stat = os.stat(file_path)
        except OSError as error:
            raise ThumbnailPublishError("SOURCE_STALE", "thumbnail source disappeared") from error
        if int(source_stat.st_size) != int(source_size) \
                or float(source_stat.st_mtime_ns / 1_000_000) != float(source_mtime_ms):
            raise ThumbnailPublishError("SOURCE_STALE", "thumbnail source identity changed")
        normalized = []
        for item in thumbnails:
            final_path = canonical(item["path"])
            if not os.path.isfile(final_path):
                raise ThumbnailPublishError("SOURCE_STALE", "published thumbnail does not exist")
            stat = os.stat(final_path)
            if int(stat.st_size) != int(item["fileSize"]):
                raise ThumbnailPublishError("SOURCE_STALE", "published thumbnail size changed")
            normalized.append((item, final_path, stat))
        timestamp = now_ms()
        result = {
            "state": "READY",
            "cacheEpoch": int(cache_epoch),
            "sourceVersion": int(source_version),
            "publishId": identifier,
        }
        with self.connection:
            # Recheck epoch inside the write transaction.
            current_epoch = self.connection.execute(
                "SELECT cache_epoch FROM cache_control WHERE singleton=1"
            ).fetchone()[0]
            if int(current_epoch) != int(cache_epoch):
                raise ThumbnailPublishError("EPOCH_STALE", "thumbnail cache epoch changed")
            updated = self.connection.execute(
                """UPDATE files SET thumbnail_state='READY',source_hash=COALESCE(?,source_hash),
                   last_error=NULL,exists_on_disk=1,updated_at=?
                   WHERE path=? AND version=? AND size=? AND mtime_ms=?""",
                (source_digest, timestamp, file_path, int(source_version), int(source_size), float(source_mtime_ms)),
            ).rowcount
            if updated != 1:
                raise ThumbnailPublishError("SOURCE_STALE", "thumbnail source revision changed")
            for item, final_path, _stat in normalized:
                self.connection.execute(
                    """INSERT INTO thumbnails
                       (file_path,size_label,pixel_size,thumbnail_path,thumbnail_size,
                        thumbnail_version,source_mtime_ms,source_hash,cache_epoch,cache_root,publish_id,
                        generated_at,last_accessed_at)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(file_path,size_label) DO UPDATE SET
                         pixel_size=excluded.pixel_size,thumbnail_path=excluded.thumbnail_path,
                         thumbnail_size=excluded.thumbnail_size,thumbnail_version=excluded.thumbnail_version,
                         source_mtime_ms=excluded.source_mtime_ms,source_hash=excluded.source_hash,
                         cache_epoch=excluded.cache_epoch,cache_root=excluded.cache_root,publish_id=excluded.publish_id,
                         generated_at=excluded.generated_at,last_accessed_at=excluded.last_accessed_at""",
                    (file_path, item["sizeLabel"], item["pixelSize"], final_path,
                     item["fileSize"], int(source_version), float(source_mtime_ms), source_digest,
                    int(cache_epoch), canonical(os.path.dirname(final_path)), identifier, timestamp, timestamp),
                )
            self.connection.execute(
                """INSERT INTO thumbnail_publish_receipts
                   (publish_id,file_path,cache_epoch,source_version,result_json,committed_at)
                   VALUES(?,?,?,?,?,?)""",
                (identifier, file_path, int(cache_epoch), int(source_version), json.dumps(result, ensure_ascii=False), timestamp),
            )
        return result

    def touch_thumbnails(self, touches: list[dict]) -> dict:
        timestamp = now_ms()
        unique = {(canonical(item["file_path"]), str(item["size_label"])) for item in touches}
        with self.connection:
            self.connection.executemany(
                "UPDATE thumbnails SET last_accessed_at=? WHERE file_path=? AND size_label=?",
                [(timestamp, file_path, size_label) for file_path, size_label in unique],
            )
        return {"success": True, "count": len(unique)}

    def mark_ready(self, file_path: str, source_mtime_ms: float, source_digest: str | None,
                   thumbnails: list[dict]) -> dict:
        file_path = canonical(file_path)
        timestamp = now_ms()
        cache_epoch = self.get_cache_epoch()["cacheEpoch"]
        with self.connection:
            self.connection.execute(
                """UPDATE files SET thumbnail_state='READY', source_hash=COALESCE(?, source_hash),
                   last_error=NULL, exists_on_disk=1, updated_at=? WHERE path=?""",
                (source_digest, timestamp, file_path),
            )
            row = self.connection.execute("SELECT version FROM files WHERE path=?", (file_path,)).fetchone()
            # A queued thumbnail can finish after its project scan was cancelled
            # or its database service was recycled. In that case the parent
            # `files` row no longer exists and inserting a thumbnail would break
            # the foreign-key constraint. The next scan will register and queue
            # the file again, so safely defer this stale completion.
            if row is None:
                return {"state": "NOT_READY", "deferred": True}
            source_version = row["version"]
            for item in thumbnails:
                self.connection.execute(
                    """INSERT INTO thumbnails
                       (file_path, size_label, pixel_size, thumbnail_path, thumbnail_size,
                        thumbnail_version, source_mtime_ms, source_hash, cache_epoch, cache_root,
                        generated_at, last_accessed_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(file_path, size_label) DO UPDATE SET
                         pixel_size=excluded.pixel_size, thumbnail_path=excluded.thumbnail_path,
                         thumbnail_size=excluded.thumbnail_size, thumbnail_version=excluded.thumbnail_version,
                         source_mtime_ms=excluded.source_mtime_ms, source_hash=excluded.source_hash,
                         cache_epoch=excluded.cache_epoch, cache_root=excluded.cache_root,
                         publish_id='',
                         generated_at=excluded.generated_at, last_accessed_at=excluded.last_accessed_at""",
                    (file_path, item["sizeLabel"], item["pixelSize"], canonical(item["path"]),
                     item["fileSize"], source_version, source_mtime_ms, source_digest, cache_epoch,
                     canonical(os.path.dirname(item["path"])), timestamp, timestamp),
                )
        return {"state": "READY"}

    def touch_thumbnail(self, file_path: str, size_label: str) -> dict:
        self.connection.execute(
            "UPDATE thumbnails SET last_accessed_at=? WHERE file_path=? AND size_label=?",
            (now_ms(), canonical(file_path), size_label),
        )
        self.connection.commit()
        return {"success": True}

    def detach_cache_batch(self, cache_root: str | None = None,
                           before_ms: int | None = None,
                           thumbnail_paths: list[str] | None = None,
                           source_paths: list[str] | None = None,
                           exclude_paths: list[str] | None = None,
                           all_cache: bool = False, limit: int = 512) -> dict:
        limit = max(1, min(CACHE_INVALIDATION_BATCH_SIZE, int(limit)))
        conditions = []
        parameters: list[object] = []
        if cache_root:
            conditions.append("cache_root=?")
            parameters.append(canonical(cache_root))
        if before_ms is not None:
            conditions.append("last_accessed_at<?")
            parameters.append(int(before_ms))
        if thumbnail_paths is not None:
            normalized = list(dict.fromkeys(canonical(value) for value in thumbnail_paths if value))[:limit]
            if not normalized:
                return {"success": True, "thumbnailPaths": [], "detachedCount": 0, "detachedBytes": 0, "done": True}
            placeholders = ",".join("?" for _ in normalized)
            conditions.append(f"thumbnail_path IN ({placeholders})")
            parameters.extend(normalized)
        if source_paths is not None:
            normalized_sources = list(dict.fromkeys(canonical(value) for value in source_paths if value))[:limit]
            if not normalized_sources:
                return {"success": True, "thumbnailPaths": [], "detachedCount": 0, "detachedBytes": 0, "done": True}
            placeholders = ",".join("?" for _ in normalized_sources)
            conditions.append(f"file_path IN ({placeholders})")
            parameters.extend(normalized_sources)
        excluded = list(dict.fromkeys(canonical(value) for value in (exclude_paths or []) if value))[:limit]
        if excluded:
            placeholders = ",".join("?" for _ in excluded)
            conditions.append(f"thumbnail_path NOT IN ({placeholders})")
            parameters.extend(excluded)
        if not conditions and not all_cache:
            raise ValueError("cache detach requires a bounded selector")
        where_sql = " AND ".join(conditions) if conditions else "1=1"
        rows = self.connection.execute(
            f"""SELECT rowid,file_path,thumbnail_path,thumbnail_size,cache_root FROM thumbnails
                WHERE {where_sql} ORDER BY last_accessed_at,rowid LIMIT ?""",
            (*parameters, limit),
        ).fetchall()
        affected_sources = list(dict.fromkeys(row["file_path"] for row in rows))
        timestamp = now_ms()
        with self.connection:
            if rows:
                placeholders = ",".join("?" for _ in rows)
                self.connection.execute(
                    f"DELETE FROM thumbnails WHERE rowid IN ({placeholders})",
                    [row["rowid"] for row in rows],
                )
            for file_path in affected_sources:
                self.connection.execute(
                    """UPDATE files SET thumbnail_state='STALE',updated_at=?
                       WHERE path=? AND thumbnail_state='READY' AND NOT EXISTS(
                         SELECT 1 FROM thumbnails WHERE thumbnails.file_path=files.path)""",
                    (timestamp, file_path),
                )
            if source_paths is not None and not rows:
                self.connection.executemany(
                    "UPDATE files SET thumbnail_state='STALE',updated_at=? WHERE path=?",
                    [(timestamp, value) for value in normalized_sources],
                )
        return {
            "success": True,
            "thumbnailPaths": list(dict.fromkeys(row["thumbnail_path"] for row in rows if row["thumbnail_path"])),
            "deletionClaims": [
                {"path": row["thumbnail_path"], "cacheRoot": row["cache_root"]}
                for row in rows if row["thumbnail_path"] and row["cache_root"]
            ],
            "detachedCount": len(rows),
            "detachedBytes": sum(int(row["thumbnail_size"] or 0) for row in rows),
            "done": len(rows) < limit,
        }

    def prune_missing_batch(self, limit: int = 512, cache_root: str | None = None) -> dict:
        limit = max(1, min(CACHE_INVALIDATION_BATCH_SIZE, int(limit)))
        root = canonical(cache_root) if cache_root else None
        rows = self.connection.execute(
            """SELECT thumbnails.rowid,thumbnails.file_path,thumbnails.thumbnail_path,thumbnails.cache_root
               FROM thumbnails JOIN files ON files.path=thumbnails.file_path
               WHERE (files.exists_on_disk=0 OR files.thumbnail_state='MISSING')
                 AND (? IS NULL OR thumbnails.cache_root=?)
               ORDER BY thumbnails.rowid LIMIT ?""",
            (root, root, limit),
        ).fetchall()
        with self.connection:
            if rows:
                placeholders = ",".join("?" for _ in rows)
                self.connection.execute(
                    f"DELETE FROM thumbnails WHERE rowid IN ({placeholders})",
                    [row["rowid"] for row in rows],
                )
            removable = self.connection.execute(
                """SELECT path FROM files
                   WHERE (exists_on_disk=0 OR thumbnail_state='MISSING')
                     AND NOT EXISTS(SELECT 1 FROM thumbnails WHERE thumbnails.file_path=files.path)
                   LIMIT ?""",
                (limit,),
            ).fetchall()
            if removable:
                placeholders = ",".join("?" for _ in removable)
                self.connection.execute(
                    f"DELETE FROM files WHERE path IN ({placeholders})",
                    [row["path"] for row in removable],
                )
        remaining = self.connection.execute(
            """SELECT 1 FROM thumbnails JOIN files ON files.path=thumbnails.file_path
               WHERE (files.exists_on_disk=0 OR files.thumbnail_state='MISSING')
                 AND (? IS NULL OR thumbnails.cache_root=?) LIMIT 1""",
            (root, root),
        ).fetchone()
        remaining_sources = self.connection.execute(
            """SELECT 1 FROM files
               WHERE (exists_on_disk=0 OR thumbnail_state='MISSING')
                 AND NOT EXISTS(SELECT 1 FROM thumbnails WHERE thumbnails.file_path=files.path)
               LIMIT 1"""
        ).fetchone()
        return {
            "success": True,
            "thumbnailPaths": list(dict.fromkeys(row["thumbnail_path"] for row in rows if row["thumbnail_path"])),
            "deletionClaims": [
                {"path": row["thumbnail_path"], "cacheRoot": row["cache_root"]}
                for row in rows if row["thumbnail_path"] and row["cache_root"]
            ],
            "detachedCount": len(rows),
            "sourceCount": len(removable),
            "done": remaining is None and remaining_sources is None,
        }

    def recover_cache_publications(self, cache_root: str, before_ms: int | None = None,
                                   exclude_paths: list[str] | None = None,
                                   scan_root_orphans: bool = True,
                                   after_row_id: int = 0,
                                   generation: str = "",
                                   generation_max_row_id: int = 0,
                                   inspect_limit: int = 2048,
                                   delete_limit: int = 512,
                                   directory_inspect_limit: int = 2048,
                                   directory_cursor: dict | None = None,
                                   orphan_recheck_at: int = 0,
                                   orphan_retention_ms: int = 0) -> dict:
        root = canonical(cache_root)
        inspect_limit = max(1, min(8192, int(inspect_limit)))
        delete_limit = max(1, min(CACHE_INVALIDATION_BATCH_SIZE, int(delete_limit)))
        directory_inspect_limit = max(1, min(8192, int(directory_inspect_limit)))
        generation = str(generation or "") or f"legacy-{uuid.uuid4().hex}"
        after_row_id = max(0, int(after_row_id or 0))
        generation_max_row_id = int(generation_max_row_id or 0)
        if generation_max_row_id == 0:
            captured_max_row_id = int(self.connection.execute(
                "SELECT COALESCE(MAX(rowid),0) FROM thumbnails WHERE cache_root=?", (root,)
            ).fetchone()[0])
            # -1 distinguishes an initialized empty snapshot from the 0 value
            # that requests a fresh generation boundary.
            generation_max_row_id = captured_max_row_id if captured_max_row_id > 0 else -1
        excluded = {canonical(value) for value in (exclude_paths or []) if value}
        window = self.connection.execute(
            """SELECT rowid,file_path,thumbnail_path FROM thumbnails
               WHERE cache_root=? AND rowid>? AND rowid<=? ORDER BY rowid LIMIT ?""",
            (root, after_row_id, generation_max_row_id, inspect_limit),
        ).fetchall()
        missing = []
        next_row_id = after_row_id
        stopped_at_delete_limit = False
        for row in window:
            next_row_id = int(row["rowid"])
            if not os.path.isfile(row["thumbnail_path"]):
                missing.append(row)
                if len(missing) >= delete_limit:
                    stopped_at_delete_limit = True
                    break
        if missing:
            with self.connection:
                placeholders = ",".join("?" for _ in missing)
                self.connection.execute(
                    f"DELETE FROM thumbnails WHERE rowid IN ({placeholders})",
                    [row["rowid"] for row in missing],
                )
                self.connection.executemany(
                    """UPDATE files SET thumbnail_state='STALE',updated_at=?
                       WHERE path=? AND thumbnail_state='READY' AND NOT EXISTS
                         (SELECT 1 FROM thumbnails WHERE thumbnails.file_path=files.path)""",
                    [(now_ms(), row["file_path"]) for row in missing],
                )
        publication_done = not stopped_at_delete_limit and len(window) < inspect_limit

        scan_roots = [os.path.join(root, ".staging")]
        if scan_root_orphans:
            scan_roots.insert(0, root)
        cursor = directory_cursor if isinstance(directory_cursor, dict) else {}
        root_index = max(0, min(len(scan_roots), int(cursor.get("rootIndex") or 0)))
        entry_offset = max(0, int(cursor.get("entryOffset") or 0))
        with self.connection:
            self.connection.execute(
                "DELETE FROM thumbnail_orphan_scan_entries WHERE cache_root=? AND generation<>?", (root, generation)
            )
            self.connection.execute(
                "DELETE FROM thumbnail_orphan_scan_state WHERE cache_root=? AND generation<>?", (root, generation)
            )
        for iterator_key, (iterator, _offset) in list(self._orphan_scan_iterators.items()):
            if iterator_key[1] == root and iterator_key[0] != generation:
                iterator.close()
                self._orphan_scan_iterators.pop(iterator_key, None)
        retry_rows = self.connection.execute(
            """SELECT thumbnail_path FROM thumbnail_orphan_delete_retries
               WHERE cache_root=? ORDER BY updated_at,thumbnail_path LIMIT ?""",
            (root, delete_limit),
        ).fetchall()
        retry_candidates = [canonical(row["thumbnail_path"]) for row in retry_rows]
        candidates = list(dict.fromkeys(retry_candidates))
        retry_candidate_set = set(candidates)
        cutoff = int(before_ms) if before_ms is not None else None
        next_orphan_recheck_at = max(0, int(orphan_recheck_at or 0))
        remaining_limit = delete_limit - len(candidates)
        scan_rows = self.connection.execute(
            """SELECT thumbnail_path FROM thumbnail_orphan_scan_entries
               WHERE generation=? AND cache_root=? AND processed=0
               ORDER BY root_index,thumbnail_path LIMIT ?""",
            (generation, root, remaining_limit),
        ).fetchall() if remaining_limit > 0 else []
        snapshots_stable = True
        if root_index >= len(scan_roots) and len(scan_rows) < remaining_limit:
            state_rows = self.connection.execute(
                """SELECT root_index,completed_mtime_ns FROM thumbnail_orphan_scan_state
                   WHERE generation=? AND cache_root=? AND prepared_at>0""",
                (generation, root),
            ).fetchall()
            for state_row in state_rows:
                state_root_index = int(state_row["root_index"])
                if state_root_index < 0 or state_root_index >= len(scan_roots):
                    continue
                scan_root = scan_roots[state_root_index]
                verification_started_mtime = self._directory_mtime_ns(scan_root)
                if int(state_row["completed_mtime_ns"] or 0) == verification_started_mtime:
                    continue
                verification_rows = []
                try:
                    for name in os.listdir(scan_root):
                        suffix = Path(name).suffix.lower()
                        stem = Path(name).stem.lower()
                        if suffix != ".jpg":
                            continue
                        if scan_root == root:
                            if len(stem) != 64 or any(character not in "0123456789abcdef" for character in stem):
                                continue
                        else:
                            try:
                                uuid.UUID(stem)
                            except ValueError:
                                continue
                        candidate = canonical(os.path.join(scan_root, name))
                        if candidate not in excluded:
                            verification_rows.append((generation, root, state_root_index, candidate))
                except OSError:
                    verification_rows = []
                verification_completed_mtime = self._directory_mtime_ns(scan_root)
                if verification_rows:
                    with self.connection:
                        self.connection.executemany(
                            """INSERT OR IGNORE INTO thumbnail_orphan_scan_entries
                               (generation,cache_root,root_index,thumbnail_path) VALUES(?,?,?,?)""",
                            verification_rows,
                        )
                if verification_started_mtime == verification_completed_mtime:
                    with self.connection:
                        self.connection.execute(
                            """UPDATE thumbnail_orphan_scan_state SET completed_mtime_ns=?
                               WHERE generation=? AND cache_root=? AND root_index=?""",
                            (verification_completed_mtime, generation, root, state_root_index),
                        )
                else:
                    snapshots_stable = False
            scan_rows = self.connection.execute(
                """SELECT thumbnail_path FROM thumbnail_orphan_scan_entries
                   WHERE generation=? AND cache_root=? AND processed=0
                   ORDER BY root_index,thumbnail_path LIMIT ?""",
                (generation, root, remaining_limit),
            ).fetchall() if remaining_limit > 0 else []
        # Drain durable scan work before enumerating more names. This keeps the
        # queue bounded and lets dozens of delete pages run without touching the
        # large directory again.
        if not scan_rows and remaining_limit > 0:
            while root_index < len(scan_roots):
                scan_root = scan_roots[root_index]
                prepared = self.connection.execute(
                    """SELECT prepared_at,completed_mtime_ns FROM thumbnail_orphan_scan_state
                       WHERE generation=? AND cache_root=? AND root_index=?""",
                    (generation, root, root_index),
                ).fetchone()
                if prepared and int(prepared["prepared_at"] or 0) > 0:
                    if int(prepared["completed_mtime_ns"] or 0) == self._directory_mtime_ns(scan_root):
                        root_index += 1
                        entry_offset = 0
                        continue
                    with self.connection:
                        self.connection.execute(
                            """UPDATE thumbnail_orphan_scan_state
                               SET prepared_at=0,started_mtime_ns=?,completed_mtime_ns=0
                               WHERE generation=? AND cache_root=? AND root_index=?""",
                            (self._directory_mtime_ns(scan_root), generation, root, root_index),
                        )
                    entry_offset = 0
                    prepared = None
                iterator_key = (generation, root, root_index)
                iterator_state = self._orphan_scan_iterators.get(iterator_key)
                restarted = iterator_state is None and entry_offset > 0
                inserted_count = 0
                try:
                    if iterator_state is None:
                        iterator = os.scandir(scan_root)
                        with self.connection:
                            self.connection.execute(
                                """INSERT INTO thumbnail_orphan_scan_state
                                   (generation,cache_root,root_index,prepared_at,started_mtime_ns,completed_mtime_ns)
                                   VALUES(?,?,?,0,?,0)
                                   ON CONFLICT(generation,cache_root,root_index) DO UPDATE SET
                                     started_mtime_ns=CASE WHEN prepared_at=0 AND started_mtime_ns<>0 THEN started_mtime_ns ELSE excluded.started_mtime_ns END,
                                     prepared_at=0,completed_mtime_ns=0""",
                                (generation, root, root_index, self._directory_mtime_ns(scan_root)),
                            )
                        skipped = 0
                        iterator_state = (iterator, skipped)
                    iterator, current_offset = iterator_state
                    while True:
                        page_entries = []
                        exhausted = False
                        for _index in range(directory_inspect_limit):
                            try:
                                page_entries.append(next(iterator))
                            except StopIteration:
                                exhausted = True
                                break
                        current_offset += len(page_entries)
                        insert_rows = []
                        for entry in page_entries:
                            name = entry.name
                            suffix = Path(name).suffix.lower()
                            stem = Path(name).stem.lower()
                            if suffix != ".jpg":
                                continue
                            if scan_root == root:
                                if len(stem) != 64 or any(character not in "0123456789abcdef" for character in stem):
                                    continue
                            else:
                                try:
                                    uuid.UUID(stem)
                                except ValueError:
                                    continue
                            candidate = canonical(os.path.join(scan_root, name))
                            if candidate not in excluded:
                                insert_rows.append((generation, root, root_index, candidate))
                        changes_before = self.connection.total_changes
                        if insert_rows:
                            with self.connection:
                                self.connection.executemany(
                                    """INSERT OR IGNORE INTO thumbnail_orphan_scan_entries
                                       (generation,cache_root,root_index,thumbnail_path) VALUES(?,?,?,?)""",
                                    insert_rows,
                                )
                        inserted_count = self.connection.total_changes - changes_before
                        # After a process restart, replay the durable snapshot
                        # prefix until new names are found. This never skips by
                        # unstable filesystem order and never sorts the whole
                        # directory on ordinary pages.
                        if inserted_count or exhausted or not restarted:
                            break
                    if exhausted:
                        iterator.close()
                        self._orphan_scan_iterators.pop(iterator_key, None)
                    else:
                        self._orphan_scan_iterators[iterator_key] = (iterator, current_offset)
                except (OSError, StopIteration):
                    iterator = iterator_state[0] if iterator_state else None
                    iterator and iterator.close()
                    self._orphan_scan_iterators.pop(iterator_key, None)
                    page_entries = []
                    exhausted = True
                    current_offset = entry_offset
                if exhausted:
                    state = self.connection.execute(
                        """SELECT started_mtime_ns FROM thumbnail_orphan_scan_state
                           WHERE generation=? AND cache_root=? AND root_index=?""",
                        (generation, root, root_index),
                    ).fetchone()
                    completed_mtime_ns = self._directory_mtime_ns(scan_root)
                    stable_snapshot = int(state["started_mtime_ns"] or 0) == completed_mtime_ns if state else completed_mtime_ns == 0
                    with self.connection:
                        if stable_snapshot:
                            self.connection.execute(
                                """UPDATE thumbnail_orphan_scan_state
                                   SET prepared_at=?,completed_mtime_ns=?
                                   WHERE generation=? AND cache_root=? AND root_index=?""",
                                (now_ms(), completed_mtime_ns, generation, root, root_index),
                            )
                        else:
                            self.connection.execute(
                                """UPDATE thumbnail_orphan_scan_state
                                   SET prepared_at=0,started_mtime_ns=?,completed_mtime_ns=0
                                   WHERE generation=? AND cache_root=? AND root_index=?""",
                                (completed_mtime_ns, generation, root, root_index),
                            )
                    if stable_snapshot:
                        root_index += 1
                    entry_offset = 0
                else:
                    # A restarted iterator can find a new name before the old
                    # offset. Report its actual position so subsequent replay
                    # pages advance instead of appearing stalled at that offset.
                    entry_offset = current_offset
                if inserted_count or not exhausted:
                    break
            scan_rows = self.connection.execute(
                """SELECT thumbnail_path FROM thumbnail_orphan_scan_entries
                   WHERE generation=? AND cache_root=? AND processed=0
                   ORDER BY root_index,thumbnail_path LIMIT ?""",
                (generation, root, remaining_limit),
            ).fetchall()
        candidates.extend(canonical(row["thumbnail_path"]) for row in scan_rows)
        next_directory_cursor = {"rootIndex": root_index, "entryOffset": entry_offset}
        directory_done = snapshots_stable and root_index >= len(scan_roots) and len(scan_rows) < remaining_limit

        indexed = set()
        for offset_index in range(0, len(candidates), 400):
            chunk = candidates[offset_index:offset_index + 400]
            placeholders = ",".join("?" for _ in chunk)
            rows = self.connection.execute(
                f"SELECT thumbnail_path FROM thumbnails WHERE thumbnail_path IN ({placeholders})",
                chunk,
            ).fetchall()
            indexed.update(canonical(row["thumbnail_path"]) for row in rows)
        candidates = [candidate for candidate in candidates if candidate not in indexed]
        indexed_retry_consumed_count = len(indexed.intersection(retry_candidate_set))
        if indexed:
            with self.connection:
                self.connection.executemany(
                    "DELETE FROM thumbnail_orphan_delete_retries WHERE thumbnail_path=?",
                    [(candidate,) for candidate in indexed],
                )
                self.connection.executemany(
                    "UPDATE thumbnail_orphan_scan_entries SET processed=1 WHERE thumbnail_path=?",
                    [(candidate,) for candidate in indexed],
                )
        rejected_scan_candidates = []
        for candidate in candidates:
            if candidate in retry_candidate_set:
                continue
            try:
                if not os.path.isfile(candidate):
                    rejected_scan_candidates.append(candidate)
                elif cutoff is not None:
                    modified_at = int(os.path.getmtime(candidate) * 1000)
                    if modified_at >= cutoff:
                        rejected_scan_candidates.append(candidate)
                        if orphan_retention_ms > 0:
                            eligible_at = modified_at + int(orphan_retention_ms)
                            next_orphan_recheck_at = eligible_at if next_orphan_recheck_at <= 0 else min(next_orphan_recheck_at, eligible_at)
            except OSError:
                rejected_scan_candidates.append(candidate)
        if rejected_scan_candidates:
            rejected_set = set(rejected_scan_candidates)
            candidates = [candidate for candidate in candidates if candidate not in rejected_set]
            with self.connection:
                self.connection.executemany(
                    "UPDATE thumbnail_orphan_scan_entries SET processed=1 WHERE thumbnail_path=?",
                    [(candidate,) for candidate in rejected_scan_candidates],
                )
        recovery_cursor = {
            "generation": generation,
            "generationMaxRowId": generation_max_row_id,
            "afterRowId": next_row_id,
            "lastCompletedAt": 0,
            "directory": next_directory_cursor,
            "orphanRecheckAt": next_orphan_recheck_at,
        }
        return {
            "success": True,
            "orphanPaths": candidates,
            "inspectedCount": len(window),
            "repairedMissingCount": len(missing),
            "orphanScanConsumedCount": len(scan_rows),
            "retryConsumedCount": indexed_retry_consumed_count,
            "orphanProgressCount": len(scan_rows) + indexed_retry_consumed_count,
            "orphanRecheckAt": next_orphan_recheck_at,
            "generationMaxRowId": generation_max_row_id,
            "afterRowId": next_row_id,
            "directoryCursor": next_directory_cursor,
            "cursor": recovery_cursor,
            "publicationDone": publication_done,
            "orphanDone": directory_done,
            "done": publication_done and directory_done,
        }

    def record_orphan_delete_failures(self, cache_root: str, failures: list[dict]) -> dict:
        root = canonical(cache_root)
        timestamp = now_ms()
        normalized = []
        for failure in failures or []:
            raw_path = str(failure.get("path") or "").strip()
            if not raw_path:
                continue
            thumbnail_path = canonical(raw_path)
            normalized.append((thumbnail_path, root, str(failure.get("error") or "")[:2000], timestamp, timestamp))
        with self.connection:
            self.connection.executemany(
                """INSERT INTO thumbnail_orphan_delete_retries
                   (thumbnail_path,cache_root,attempts,last_error,created_at,updated_at)
                   VALUES(?,?,1,?,?,?)
                   ON CONFLICT(thumbnail_path) DO UPDATE SET
                     cache_root=excluded.cache_root,attempts=attempts+1,
                     last_error=excluded.last_error,updated_at=excluded.updated_at""",
                normalized,
            )
            self.connection.executemany(
                "UPDATE thumbnail_orphan_scan_entries SET processed=1 WHERE thumbnail_path=?",
                [(value[0],) for value in normalized],
            )
        return {"success": True, "count": len(normalized)}

    def clear_orphan_delete_retries(self, thumbnail_paths: list[str]) -> dict:
        normalized = [canonical(value) for value in thumbnail_paths or [] if value]
        with self.connection:
            self.connection.executemany(
                "DELETE FROM thumbnail_orphan_delete_retries WHERE thumbnail_path=?",
                [(value,) for value in normalized],
            )
            self.connection.executemany(
                "UPDATE thumbnail_orphan_scan_entries SET processed=1 WHERE thumbnail_path=?",
                [(value,) for value in normalized],
            )
        return {"success": True, "count": len(normalized)}

    def prepare_thumbnail_deletions(self, thumbnail_paths: list[str]) -> dict:
        normalized = list(dict.fromkeys(canonical(value) for value in thumbnail_paths or [] if value))
        indexed = set()
        for offset in range(0, len(normalized), 400):
            chunk = normalized[offset:offset + 400]
            placeholders = ",".join("?" for _ in chunk)
            rows = self.connection.execute(
                f"SELECT thumbnail_path FROM thumbnails WHERE thumbnail_path IN ({placeholders})",
                chunk,
            ).fetchall()
            indexed.update(canonical(row["thumbnail_path"]) for row in rows)
        if indexed:
            with self.connection:
                self.connection.executemany(
                    "DELETE FROM thumbnail_orphan_delete_retries WHERE thumbnail_path=?",
                    [(value,) for value in indexed],
                )
                self.connection.executemany(
                    "UPDATE thumbnail_orphan_scan_entries SET processed=1 WHERE thumbnail_path=?",
                    [(value,) for value in indexed],
                )
        return {
            "success": True,
            "deletablePaths": [value for value in normalized if value not in indexed],
            "indexedPaths": [value for value in normalized if value in indexed],
        }

    def check_integrity(self) -> dict:
        result = str(self.connection.execute("PRAGMA quick_check").fetchone()[0])
        if result != "ok":
            raise RuntimeError(f"thumbnail database integrity check failed: {result}")
        return {"success": True, "result": result}

    def run_thumbnail_cache_migration(self, migration_version: str,
                                      cursor: dict | None = None,
                                      limit: int = 512) -> dict:
        version = str(migration_version or "")
        if version != "thumbnail-cache-migration-v2":
            raise ValueError("unsupported thumbnail cache migration")
        target_user_version = 2
        current_user_version = int(self.connection.execute("PRAGMA user_version").fetchone()[0])
        if current_user_version >= target_user_version:
            return {"success": True, "done": True, "userVersion": current_user_version,
                    "cursor": {"phase": "complete", "afterRowId": 0, "indexOffset": 11}}
        state = cursor if isinstance(cursor, dict) else {}
        phase = str(state.get("phase") or "reset-generating")
        after_row_id = max(0, int(state.get("afterRowId") or 0))
        limit = max(1, min(512, int(limit)))
        if phase == "reset-generating":
            rows = self.connection.execute(
                "SELECT rowid FROM files WHERE rowid>? AND thumbnail_state='GENERATING' ORDER BY rowid LIMIT ?",
                (after_row_id, limit),
            ).fetchall()
            if rows:
                with self.connection:
                    self.connection.executemany(
                        "UPDATE files SET thumbnail_state='QUEUED',updated_at=? WHERE rowid=?",
                        [(now_ms(), row["rowid"]) for row in rows],
                    )
                return {
                    "success": True, "done": False, "processed": len(rows), "userVersion": current_user_version,
                    "cursor": {"phase": "reset-generating", "afterRowId": int(rows[-1]["rowid"]), "indexOffset": 0},
                }
            phase = "backfill"
            after_row_id = 0
        if phase == "backfill":
            rows = self.connection.execute(
                """SELECT rowid,thumbnail_path FROM thumbnails
                   WHERE rowid>? AND cache_root='' ORDER BY rowid LIMIT ?""",
                (after_row_id, limit),
            ).fetchall()
            if rows:
                with self.connection:
                    self.connection.executemany(
                        "UPDATE thumbnails SET cache_root=? WHERE rowid=?",
                        [(canonical(os.path.dirname(row["thumbnail_path"])), row["rowid"]) for row in rows],
                    )
                next_cursor = {"phase": "backfill", "afterRowId": int(rows[-1]["rowid"]), "indexOffset": 0}
                return {"success": True, "done": False, "processed": len(rows), "userVersion": current_user_version, "cursor": next_cursor}
            phase = "indexes"
            state = {"phase": phase, "afterRowId": after_row_id, "indexOffset": 0}
        indexes = [
            ("files_project_relative", "CREATE INDEX IF NOT EXISTS files_project_relative ON files(project_root,relative_path)"),
            ("files_state", "CREATE INDEX IF NOT EXISTS files_state ON files(project_root,thumbnail_state)"),
            ("files_missing", "CREATE INDEX IF NOT EXISTS files_missing ON files(exists_on_disk,thumbnail_state,path)"),
            ("thumbnails_accessed", "CREATE INDEX IF NOT EXISTS thumbnails_accessed ON thumbnails(last_accessed_at)"),
            ("thumbnails_path", "CREATE INDEX IF NOT EXISTS thumbnails_path ON thumbnails(thumbnail_path)"),
            ("thumbnails_cache_access", "CREATE INDEX IF NOT EXISTS thumbnails_cache_access ON thumbnails(cache_root,last_accessed_at)"),
            ("thumbnail_publish_receipts_file", "CREATE INDEX IF NOT EXISTS thumbnail_publish_receipts_file ON thumbnail_publish_receipts(file_path,committed_at)"),
            ("thumbnail_orphan_delete_retries_root", "CREATE INDEX IF NOT EXISTS thumbnail_orphan_delete_retries_root ON thumbnail_orphan_delete_retries(cache_root,updated_at,thumbnail_path)"),
            ("thumbnail_orphan_scan_entries_page", "CREATE INDEX IF NOT EXISTS thumbnail_orphan_scan_entries_page ON thumbnail_orphan_scan_entries(generation,cache_root,root_index,thumbnail_path)"),
            ("thumbnail_orphan_scan_entries_cleanup", "CREATE INDEX IF NOT EXISTS thumbnail_orphan_scan_entries_cleanup ON thumbnail_orphan_scan_entries(cache_root,generation)"),
            ("thumbnail_orphan_scan_state_cleanup", "CREATE INDEX IF NOT EXISTS thumbnail_orphan_scan_state_cleanup ON thumbnail_orphan_scan_state(cache_root,generation)"),
        ]
        if phase == "indexes":
            index_offset = max(0, int(state.get("indexOffset") or 0))
            if index_offset < len(indexes):
                index_name, statement = indexes[index_offset]
                with self.connection:
                    self.connection.execute(statement)
                return {
                    "success": True, "done": False, "createdIndex": index_name,
                    "userVersion": current_user_version,
                    "cursor": {"phase": "indexes", "afterRowId": after_row_id, "indexOffset": index_offset + 1},
                }
        integrity = self.check_integrity()
        with self.connection:
            self.connection.execute(f"PRAGMA user_version={target_user_version}")
        return {
            "success": True, "done": True, "userVersion": target_user_version,
            "integrity": integrity["result"],
            "cursor": {"phase": "complete", "afterRowId": after_row_id, "indexOffset": len(indexes)},
        }

    def maintenance_state_get(self, key: str) -> dict:
        normalized = str(key or "").strip()[:500]
        if not normalized:
            raise ValueError("maintenance state key is required")
        row = self.connection.execute(
            "SELECT completed_at,cursor_json FROM maintenance_state WHERE key=?",
            (normalized,),
        ).fetchone()
        cursor = {}
        if row:
            try:
                cursor = json.loads(row["cursor_json"] or "{}")
            except (TypeError, ValueError, json.JSONDecodeError):
                cursor = {}
        return {
            "success": True,
            "completed": bool(row and int(row["completed_at"]) > 0),
            "completedAt": int(row["completed_at"]) if row else 0,
            "cursor": cursor,
        }

    def maintenance_state_save(self, key: str, cursor: dict) -> dict:
        normalized = str(key or "").strip()[:500]
        if not normalized:
            raise ValueError("maintenance state key is required")
        payload = cursor if isinstance(cursor, dict) else {}
        with self.connection:
            self.connection.execute(
                """INSERT INTO maintenance_state(key,completed_at,cursor_json) VALUES(?,0,?)
                   ON CONFLICT(key) DO UPDATE SET completed_at=0,cursor_json=excluded.cursor_json""",
                (normalized, json.dumps(payload, ensure_ascii=False)),
            )
        return {"success": True, "cursor": payload}

    def maintenance_state_complete(self, key: str, cursor: dict | None = None) -> dict:
        normalized = str(key or "").strip()[:500]
        if not normalized:
            raise ValueError("maintenance state key is required")
        timestamp = now_ms()
        payload = dict(cursor) if isinstance(cursor, dict) else {}
        if payload:
            payload["lastCompletedAt"] = timestamp
        with self.connection:
            self.connection.execute(
                """INSERT INTO maintenance_state(key,completed_at,cursor_json) VALUES(?,?,?)
                   ON CONFLICT(key) DO UPDATE SET completed_at=excluded.completed_at,cursor_json=excluded.cursor_json""",
                (normalized, timestamp, json.dumps(payload, ensure_ascii=False)),
            )
        return {"success": True, "completedAt": timestamp, "cursor": payload}

    def maintenance_state_list_prefix(self, prefix: str, after_key: str = "", limit: int = 128) -> dict:
        normalized = str(prefix or "").strip()[:500]
        if not normalized:
            raise ValueError("maintenance state prefix is required")
        bounded_limit = max(1, min(512, int(limit)))
        rows = self.connection.execute(
            """SELECT key,cursor_json FROM maintenance_state
               WHERE key LIKE ? AND key>? AND completed_at=0 ORDER BY key LIMIT ?""",
            (f"{normalized}%", str(after_key or ""), bounded_limit),
        ).fetchall()
        entries = []
        for row in rows:
            try:
                cursor = json.loads(row["cursor_json"] or "{}")
            except (TypeError, ValueError, json.JSONDecodeError):
                cursor = {}
            entries.append({"key": row["key"], "cursor": cursor})
        return {
            "success": True,
            "entries": entries,
            "afterKey": rows[-1]["key"] if rows else str(after_key or ""),
            "done": len(rows) < bounded_limit,
        }

    def maintenance_state_delete(self, key: str) -> dict:
        normalized = str(key or "").strip()[:500]
        if not normalized:
            raise ValueError("maintenance state key is required")
        with self.connection:
            deleted = self.connection.execute("DELETE FROM maintenance_state WHERE key=?", (normalized,)).rowcount
        return {"success": True, "deletedCount": max(0, int(deleted or 0))}

    def list_cache_cleanup(self, before_ms: int, cache_root: str | None = None) -> dict:
        if cache_root:
            rows = self.connection.execute(
                """SELECT DISTINCT thumbnail_path FROM thumbnails
                   WHERE cache_root=? AND last_accessed_at < ? AND thumbnail_path <> ''""",
                (canonical(cache_root), int(before_ms)),
            ).fetchall()
        else:
            rows = self.connection.execute(
                """SELECT DISTINCT thumbnail_path FROM thumbnails
                   WHERE last_accessed_at < ? AND thumbnail_path <> ''""",
                (int(before_ms),),
            ).fetchall()
        return {
            "success": True,
            "thumbnailPaths": [row["thumbnail_path"] for row in rows],
        }

    def cleanup_orphan_cache(self, cache_root: str, before_ms: int, interval_ms: int) -> dict:
        root = canonical(cache_root)
        _ = interval_ms  # compatibility argument; retries must never be suppressed
        indexed = {
            canonical(row["thumbnail_path"])
            for row in self.connection.execute("SELECT thumbnail_path FROM thumbnails").fetchall()
            if row["thumbnail_path"]
        }
        checked_count = 0
        orphan_paths = []
        if os.path.isdir(root):
            for entry in os.scandir(root):
                try:
                    name = entry.name.lower()
                    stem, extension = os.path.splitext(name)
                    if (not entry.is_file(follow_symlinks=False) or extension != ".jpg"
                            or len(stem) != 64 or any(character not in "0123456789abcdef" for character in stem)):
                        continue
                    candidate = canonical(entry.path)
                    if candidate in indexed:
                        continue
                    checked_count += 1
                    if entry.stat(follow_symlinks=False).st_mtime * 1000 < int(before_ms):
                        orphan_paths.append(canonical(entry.path))
                except OSError:
                    continue
        return {
            "success": True,
            "skipped": False,
            "checkedCount": checked_count,
            "deletedCount": 0,
            "orphanPaths": orphan_paths,
        }

    def invalidate_cache(self, deleted_paths: list[str] | None = None, before_ms: int | None = None) -> dict:
        deleted_count = 0

        def delete_rowids(rowids) -> None:
            nonlocal deleted_count
            if not rowids:
                return
            placeholders = ",".join("?" for _ in rowids)
            with self.connection:
                cursor = self.connection.execute(
                    f"DELETE FROM thumbnails WHERE rowid IN ({placeholders})",
                    rowids,
                )
            deleted_count += max(0, int(cursor.rowcount or 0))

        if deleted_paths is not None:
            normalized = list(dict.fromkeys(canonical(value) for value in deleted_paths if value))
            for offset in range(0, len(normalized), CACHE_INVALIDATION_BATCH_SIZE):
                chunk = normalized[offset:offset + CACHE_INVALIDATION_BATCH_SIZE]
                placeholders = ",".join("?" for _ in chunk)
                rows = self.connection.execute(
                    f"SELECT rowid FROM thumbnails WHERE thumbnail_path IN ({placeholders})",
                    chunk,
                ).fetchall()
                delete_rowids([row["rowid"] for row in rows])
        else:
            where_sql = "WHERE last_accessed_at < ?" if before_ms is not None else ""
            parameters = (int(before_ms),) if before_ms is not None else ()
            while True:
                rows = self.connection.execute(
                    f"SELECT rowid FROM thumbnails {where_sql} LIMIT ?",
                    (*parameters, CACHE_INVALIDATION_BATCH_SIZE),
                ).fetchall()
                if not rows:
                    break
                delete_rowids([row["rowid"] for row in rows])

        stale_count = 0
        timestamp = now_ms()
        while True:
            rows = self.connection.execute(
                """SELECT path FROM files WHERE thumbnail_state='READY' AND NOT EXISTS
                     (SELECT 1 FROM thumbnails WHERE thumbnails.file_path=files.path)
                     LIMIT ?""",
                (CACHE_INVALIDATION_BATCH_SIZE,),
            ).fetchall()
            if not rows:
                break
            with self.connection:
                cursor = self.connection.executemany(
                    "UPDATE files SET thumbnail_state='STALE', updated_at=? WHERE path=? AND thumbnail_state='READY'",
                    [(timestamp, row["path"]) for row in rows],
                )
            stale_count += max(0, int(cursor.rowcount or 0))
        return {"success": True, "deletedCount": deleted_count, "staleCount": stale_count}

    def invalidate_sources(self, source_paths: list[str] | None = None) -> dict:
        normalized = list(dict.fromkeys(canonical(value) for value in (source_paths or []) if value))
        if not normalized:
            return {"success": True, "thumbnailPaths": [], "sourceCount": 0}
        thumbnail_paths = []
        for offset in range(0, len(normalized), CACHE_INVALIDATION_BATCH_SIZE):
            chunk = normalized[offset:offset + CACHE_INVALIDATION_BATCH_SIZE]
            while True:
                result = self.detach_cache_batch(source_paths=chunk)
                thumbnail_paths.extend(result["thumbnailPaths"])
                if result["done"]:
                    break
        return {
            "success": True,
            "thumbnailPaths": list(dict.fromkeys(thumbnail_paths)),
            "sourceCount": len(normalized),
        }

    def prune_missing_sources(self) -> dict:
        """Compatibility wrapper over bounded prune_missing_batch transactions."""
        thumbnail_paths = []
        source_count = 0
        while True:
            result = self.prune_missing_batch()
            thumbnail_paths.extend(result["thumbnailPaths"])
            source_count += int(result["sourceCount"])
            if result["done"]:
                break
        return {
            "success": True,
            "thumbnailPaths": list(dict.fromkeys(thumbnail_paths)),
            "sourceCount": source_count,
        }


def run_server(database_path: str, recover: bool = True, crash_after_publish_commit: bool = False) -> None:
    # Keep the JSONL protocol independent of the Windows system code page;
    # project and media paths commonly contain Chinese characters.
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    database = ThumbnailDatabase(database_path, recover=recover)
    allowed_operations = {
        "sync_directory", "sync_project", "inspect_tool_sources", "sync_paths",
        "get_file", "set_state", "set_states", "get_cache_epoch", "get_thumbnail_publish",
        "bump_cache_epoch", "begin_cache_maintenance", "capture_thumbnail_publish",
        "resolve_thumbnail_publish", "commit_thumbnail_publish", "touch_thumbnails", "mark_ready",
        "claim_thumbnail_backup_recovery",
        "touch_thumbnail", "detach_cache_batch", "prune_missing_batch", "recover_cache_publications",
        "record_orphan_delete_failures", "clear_orphan_delete_retries", "prepare_thumbnail_deletions",
        "check_integrity", "run_thumbnail_cache_migration", "maintenance_state_get",
        "maintenance_state_save", "maintenance_state_complete", "maintenance_state_list_prefix",
        "maintenance_state_delete", "list_cache_cleanup",
        "cleanup_orphan_cache", "invalidate_cache", "invalidate_sources", "prune_missing_sources",
    }
    print(json.dumps({"type": "ready", "success": True, "userVersion": int(database.connection.execute("PRAGMA user_version").fetchone()[0])}), flush=True)
    try:
        for line in sys.stdin:
            request = None
            try:
                request = json.loads(line)
                request_id = request.get("id")
                operation = request["op"]
                args = request.get("args", {})
                if operation not in allowed_operations:
                    raise ValueError("unsupported thumbnail database operation")
                handler = getattr(database, operation)
                result = handler(**args)
                if crash_after_publish_commit and operation == "commit_thumbnail_publish":
                    # Integration fault injection: SQLite is committed, but no
                    # JSONL response is written, reproducing ambiguous commit.
                    os._exit(91)
                response = {"id": request_id, "success": True, "result": result}
            except Exception as error:  # service errors must not terminate the index
                database.connection.rollback()
                response = {"id": request.get("id") if isinstance(request, dict) else None,
                            "success": False, "error": str(error),
                            "code": getattr(error, "code", "THUMBNAIL_DATABASE_ERROR")}
            print(json.dumps(response, ensure_ascii=False), flush=True)
    finally:
        database.close()


def run(args_list=None):
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--server", action="store_true")
    parser.add_argument("--db", required=True)
    parser.add_argument("--no-recover", action="store_true")
    parser.add_argument("--crash-after-publish-commit", action="store_true")
    args = parser.parse_args(args_list)
    if not args.server:
        raise SystemExit("thumbnail_db must run in server mode")
    run_server(args.db, recover=not args.no_recover, crash_after_publish_commit=args.crash_after_publish_commit)


if __name__ == "__main__":
    run()
