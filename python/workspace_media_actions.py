"""Media catalog, synchronization, and version action implementation domain."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sqlite3
import time
import uuid

from compatibility.registry import run_hooks as run_compatibility_hooks
from workspace_db_support import meta_value as _meta_value, set_meta as _set_meta
IMAGE_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff",
    ".heic", ".heif", ".hif", ".avif", ".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf",
    ".rw2", ".dng", ".rwl", ".3fr", ".fff", ".iiq", ".pef", ".srw",
}

VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv", ".mpeg", ".mpg", ".mts", ".m2ts", ".crm"}

MEDIA_INCREMENTAL_BATCH_SIZE = 64

MEDIA_INCREMENTAL_COMPLETED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

MEDIA_INCREMENTAL_INCOMPLETE_RETENTION_MS = 24 * 60 * 60 * 1000

MEDIA_INCREMENTAL_INCOMPLETE_SOFT_LIMIT = 32

def directory_identity(path: str):
    try:
        stat = os.stat(path)
        return f"{stat.st_dev}:{stat.st_ino}" if stat.st_ino else None
    except OSError:
        return None

def canonical_path(value: str) -> str:
    # Preserve the user's path casing for display. Case-insensitive matching is
    # handled separately by `file_path_key`, never by the visible path value.
    return os.path.normpath(os.path.abspath(value))

def is_project_descendant(candidate_path: str, project_path: str) -> bool:
    """Return True only for an existing path strictly inside the project."""
    candidate = canonical_path(candidate_path)
    project = canonical_path(project_path)
    if candidate.casefold() == project.casefold():
        return False
    try:
        return os.path.commonpath((candidate, project)).casefold() == project.casefold()
    except ValueError:
        return False

def normalize_external_link_relative_path(value) -> str | None:
    """Validate an Electron-authorized virtual path without accepting an absolute path."""
    if value in (None, ""):
        return None
    normalized = str(value).replace("\\", "/").strip("/")
    if not normalized or len(normalized) > 2048 or os.path.isabs(normalized):
        raise ValueError("external_link_path_invalid: 外链虚拟路径无效")
    segments = normalized.split("/")
    if any(not segment or segment in (".", "..") or "\0" in segment for segment in segments):
        raise ValueError("external_link_path_invalid: 外链虚拟路径包含越界片段")
    link_indexes = [index for index, segment in enumerate(segments) if segment.casefold().endswith(".lnk")]
    if len(link_indexes) != 1:
        raise ValueError("external_link_path_invalid: 外链虚拟路径必须包含一个受管外链")
    return "/".join(segments)

def media_type(path: str):
    extension = os.path.splitext(path)[1].lower()
    if extension in IMAGE_EXTENSIONS:
        return "image"
    if extension in VIDEO_EXTENSIONS:
        return "video"
    return None

def file_identity(path: str):
    try:
        stat = os.stat(path)
        if not stat.st_ino:
            return None
        return f"{stat.st_dev}:{stat.st_ino}"
    except OSError:
        return None

def quick_fingerprint(path: str, stat: os.stat_result | None = None) -> str:
    """A rename-safe, inexpensive identity hint for cross-volume moves."""
    stat = stat or os.stat(path)
    digest = hashlib.sha256()
    digest.update(str(stat.st_size).encode("ascii"))
    sample_size = 128 * 1024
    with open(path, "rb") as source:
        digest.update(source.read(sample_size))
        if stat.st_size > sample_size:
            source.seek(max(0, stat.st_size - sample_size))
            digest.update(source.read(sample_size))
    return digest.hexdigest()

def full_fingerprint(path: str) -> str:
    """Authoritative content identity used after the quick candidate filter."""
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def queue_full_fingerprint(pending_hashes, version_id: str, file_path: str, stat: os.stat_result):
    """Queue one authoritative hash without reading the file while a DB write is open."""
    if pending_hashes is None:
        return
    path = canonical_path(file_path)
    request = {
        "versionId": version_id,
        "filePath": path,
        "fileSize": stat.st_size,
        "modifiedAt": int(stat.st_mtime_ns / 1_000_000),
    }
    for index, existing in enumerate(pending_hashes):
        if existing["versionId"] == version_id:
            pending_hashes[index] = request
            return
    pending_hashes.append(request)

def backfill_full_fingerprints(db, requests: list[dict], fingerprint=None):
    """Hash files with no write transaction held, then persist each result briefly."""
    completed = 0
    for request in requests:
        try:
            db.commit()
            version_id = str(request["versionId"])
            file_path = canonical_path(request["filePath"])
            expected_size = int(request["fileSize"])
            expected_mtime = int(request["modifiedAt"])
            record = db.execute(
                """SELECT current_path,file_size,modified_at,full_hash FROM file_records
                   WHERE owner_type='version' AND owner_id=?""",
                (version_id,),
            ).fetchone()
            if (record is None or record["full_hash"]
                    or canonical_path(record["current_path"]).casefold() != file_path.casefold()
                    or record["file_size"] != expected_size or record["modified_at"] != expected_mtime):
                continue
            before = os.stat(file_path)
            if before.st_size != expected_size or int(before.st_mtime_ns / 1_000_000) != expected_mtime:
                continue
            authoritative_hash = (fingerprint or full_fingerprint)(file_path)
            after = os.stat(file_path)
            if after.st_size != expected_size or int(after.st_mtime_ns / 1_000_000) != expected_mtime:
                continue
            current = db.execute(
                """SELECT current_path,file_size,modified_at,full_hash FROM file_records
                   WHERE owner_type='version' AND owner_id=?""",
                (version_id,),
            ).fetchone()
            if (current is None or current["full_hash"]
                    or canonical_path(current["current_path"]).casefold() != file_path.casefold()
                    or current["file_size"] != expected_size or current["modified_at"] != expected_mtime):
                continue
            db.execute(
                """UPDATE file_records SET full_hash=?,updated_at=?
                   WHERE owner_type='version' AND owner_id=?""",
                (authoritative_hash, int(time.time() * 1000), version_id),
            )
            db.commit()
            completed += 1
        except (FileNotFoundError, PermissionError, OSError, sqlite3.Error):
            db.rollback()
    return completed

def project_row(db, project_name: str):
    row = db.execute("SELECT * FROM projects WHERE name=? COLLATE NOCASE AND status != '' AND is_deleted=0", (project_name,)).fetchone()
    if row is None:
        raise ValueError("项目未登记，请先刷新项目列表")
    return row

def serialize_photo(row):
    if row is None:
        return None
    return {
        "id": row["id"], "projectId": row["project_id"], "mediaType": row["media_type"],
        "originalName": row["original_name"], "displayName": row["display_name"],
        "currentVersionId": row["current_version_id"], "originalFilePath": row["original_file_path"],
        "captureTime": row["capture_time"], "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }

def serialize_version(row):
    return {
        "id": row["id"], "photoId": row["photo_id"], "parentVersionId": row["parent_version_id"],
        "versionNumber": row["version_number"], "versionName": row["version_name"],
        "versionType": row["version_type"], "filePath": row["file_path"],
        "fileSize": row["file_size"], "fileModifiedAt": row["file_modified_at"],
        "thumbnailPath": row["thumbnail_path"], "author": row["author"], "note": row["note"],
        "status": row["status"], "isCurrent": bool(row["is_current"]), "isFinal": bool(row["is_final"]),
        "fileMissing": bool(row["file_missing"]), "contentChanged": bool(row["content_changed"]),
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }

def media_bundle(db, photo_id: str):
    photo = db.execute("SELECT * FROM photos WHERE id=? AND is_deleted=0", (photo_id,)).fetchone()
    versions = db.execute(
        "SELECT * FROM versions WHERE photo_id=? AND is_deleted=0 ORDER BY version_number, created_at", (photo_id,)
    ).fetchall()
    next_version_number = db.execute(
        "SELECT COALESCE(MAX(version_number), -1)+1 FROM versions WHERE photo_id=?", (photo_id,)
    ).fetchone()[0]
    return {
        "photo": serialize_photo(photo), "versions": [serialize_version(row) for row in versions],
        "nextVersionNumber": next_version_number,
    }

def media_versions_snapshot(db, payload: dict):
    """Bounded, side-effect-free version rows for a single registered project and physical scope."""
    project = project_row(db, payload["projectName"])
    scope_path_key = canonical_path(str(payload.get("scopePath") or "")).casefold()
    project_path_key = canonical_path(str(payload.get("projectPath") or "")).casefold()
    if not scope_path_key or not project_path_key or not (scope_path_key == project_path_key or scope_path_key.startswith(project_path_key + os.sep)):
        raise ValueError("version_snapshot_scope_invalid: 查询范围无效")
    requested_limit = int(payload.get("limit") or 5000)
    if requested_limit < 1 or requested_limit > 5000:
        raise ValueError("version_snapshot_limit_invalid: 查询上限无效")
    like_prefix = scope_path_key.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + os.sep.replace("\\", "\\\\") + "%"
    rows = db.execute(
        """SELECT version.* FROM versions AS version
             JOIN photos AS photo ON photo.id=version.photo_id
            WHERE photo.project_id=? AND photo.is_deleted=0 AND version.is_deleted=0
              AND (version.file_path_key=? OR version.file_path_key LIKE ? ESCAPE '\\')
            ORDER BY version.created_at DESC,version.id LIMIT ?""",
        (project["id"], scope_path_key, like_prefix, requested_limit + 1),
    ).fetchall()
    items = [{
        "id": row["id"], "photoId": row["photo_id"], "parentVersionId": row["parent_version_id"],
        "versionNumber": row["version_number"], "versionName": row["version_name"], "versionType": row["version_type"],
        "status": row["status"], "note": row["note"], "isCurrent": bool(row["is_current"]), "isFinal": bool(row["is_final"]),
        "fileMissing": bool(row["file_missing"]), "contentChanged": bool(row["content_changed"]),
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    } for row in rows[:requested_limit]]
    return {"success": True, "versions": items, "truncated": len(rows) > requested_limit}

def upsert_file_record(db, owner_id: str, file_path: str, stat: os.stat_result, identity: str | None,
                       fingerprint: str, full_hash: str | None = None):
    timestamp = int(time.time() * 1000)
    record = db.execute("SELECT id, created_at FROM file_records WHERE owner_type='version' AND owner_id=?", (owner_id,)).fetchone()
    values = (
        canonical_path(file_path), os.path.basename(file_path), os.path.splitext(file_path)[1].lower(), identity,
        str(stat.st_dev), stat.st_size, int(stat.st_mtime_ns / 1_000_000), fingerprint, full_hash, timestamp,
    )
    if record:
        db.execute(
            """UPDATE file_records SET current_path=?, file_name=?, extension=?, windows_file_id=?, volume_id=?,
               file_size=?, modified_at=?, quick_hash=?, full_hash=?, missing=0, updated_at=? WHERE id=?""",
            values + (record["id"],),
        )
    else:
        db.execute(
            """INSERT INTO file_records(id,owner_type,owner_id,current_path,file_name,extension,windows_file_id,
               volume_id,file_size,modified_at,quick_hash,full_hash,missing,created_at,updated_at)
               VALUES(?,'version',?,?,?,?,?,?,?,?,?,?,0,?,?)""",
            (str(uuid.uuid4()), owner_id, *values[:-1], timestamp, timestamp),
        )

def sync_media_file(db, project, file_path: str, pending_hashes=None):
    file_path = canonical_path(file_path)
    kind = media_type(file_path)
    if not kind or not os.path.isfile(file_path):
        return None
    stat = os.stat(file_path)
    identity = file_identity(file_path)
    path_key = file_path.casefold()
    mtime_ms = int(stat.st_mtime_ns / 1_000_000)
    linked_source = db.execute(
        """SELECT batch_items.id AS item_id,batch_items.photo_id,versions.id AS version_id,
                  versions.file_path_key,versions.file_fingerprint,versions.content_changed,
                  file_records.full_hash AS stored_full_hash
           FROM batch_items
           JOIN version_batches ON version_batches.id=batch_items.batch_id
           JOIN versions ON versions.id=batch_items.version_id
           LEFT JOIN file_records ON file_records.owner_type='version' AND file_records.owner_id=versions.id
           WHERE versions.is_deleted=0 AND version_batches.status IN ('importing','applying','needs_repair','ready')
             AND (batch_items.source_path_key=? OR (? IS NOT NULL AND batch_items.source_file_id=?))
           ORDER BY version_batches.sequence DESC LIMIT 1""",
        (path_key, identity, identity),
    ).fetchone()
    # A rename keeps the cached full hash. A quick-hash change invalidates it
    # and queues one replacement after the short metadata transaction commits.
    if linked_source is not None and linked_source["file_path_key"] != path_key:
        fingerprint = quick_fingerprint(file_path, stat)
        fingerprint_changed = bool(
            linked_source["file_fingerprint"] and linked_source["file_fingerprint"] != fingerprint
        )
        content_changed = bool(linked_source["content_changed"] or fingerprint_changed)
        timestamp = int(time.time() * 1000)
        db.execute(
            """UPDATE batch_items SET source_name=?, source_path=?, source_path_key=?,
               source_file_id=?, updated_at=? WHERE id=?""",
            (os.path.basename(file_path), file_path, path_key, identity, timestamp, linked_source["item_id"]),
        )
        db.execute(
            """UPDATE versions SET file_path=?,file_path_key=?,file_id=?,file_fingerprint=?,file_size=?,
               file_modified_at=?,file_missing=0,content_changed=?,
               thumbnail_path=CASE WHEN ?=1 THEN NULL ELSE thumbnail_path END,updated_at=? WHERE id=?""",
            (file_path, path_key, identity, fingerprint, stat.st_size, mtime_ms, int(content_changed),
             int(fingerprint_changed), timestamp, linked_source["version_id"]),
        )
        cached_hash = None if fingerprint_changed else linked_source["stored_full_hash"]
        upsert_file_record(db, linked_source["version_id"], file_path, stat, identity, fingerprint, cached_hash)
        if not cached_hash:
            queue_full_fingerprint(pending_hashes, linked_source["version_id"], file_path, stat)
        return linked_source["photo_id"]

    existing = None
    if identity:
        existing = db.execute(
            """SELECT versions.*,file_records.full_hash AS stored_full_hash
               FROM versions JOIN photos ON photos.id=versions.photo_id
               LEFT JOIN file_records ON file_records.owner_type='version' AND file_records.owner_id=versions.id
               WHERE versions.file_id=? AND versions.is_deleted=0 AND photos.project_id=? LIMIT 1""",
            (identity, project["id"]),
        ).fetchone()
    if existing is None:
        existing = db.execute(
            """SELECT versions.*,file_records.full_hash AS stored_full_hash
               FROM versions JOIN photos ON photos.id=versions.photo_id
               LEFT JOIN file_records ON file_records.owner_type='version' AND file_records.owner_id=versions.id
               WHERE versions.file_path_key=? AND versions.is_deleted=0 AND photos.project_id=? LIMIT 1""",
            (path_key, project["id"]),
        ).fetchone()

    fingerprint = None
    changed = False
    if existing is not None:
        changed = existing["file_size"] != stat.st_size or existing["file_modified_at"] != mtime_ms
        fingerprint = quick_fingerprint(file_path, stat) if (
            changed or not existing["file_fingerprint"] or existing["file_id"] != identity
        ) else existing["file_fingerprint"]
    else:
        fingerprint = quick_fingerprint(file_path, stat)
        tombstone = db.execute(
            """SELECT versions.photo_id,file_records.full_hash FROM versions
               JOIN photos ON photos.id=versions.photo_id
               LEFT JOIN file_records ON file_records.owner_type='version' AND file_records.owner_id=versions.id
               WHERE versions.file_path_key=? AND versions.file_fingerprint=?
                 AND versions.is_deleted=1 AND photos.project_id=?
               ORDER BY versions.updated_at DESC LIMIT 1""",
            (path_key, fingerprint, project["id"]),
        ).fetchone()
        candidates = db.execute(
            """SELECT versions.*,file_records.full_hash AS stored_full_hash FROM versions
               JOIN photos ON photos.id=versions.photo_id
               LEFT JOIN file_records ON file_records.owner_type='version' AND file_records.owner_id=versions.id
               WHERE versions.file_fingerprint=? AND versions.is_deleted=0 AND photos.project_id=?
                 AND (versions.file_missing=1 OR NOT EXISTS (SELECT 1 FROM file_records
                   WHERE owner_type='version' AND owner_id=versions.id AND missing=0))""",
            (fingerprint, project["id"]),
        ).fetchall()
        candidate_hashes = [tombstone["full_hash"] if tombstone is not None else None]
        candidate_hashes.extend(candidate["stored_full_hash"] for candidate in candidates)
        # The expensive pass is only useful when the cheap stages produced an
        # authoritative candidate. Brand-new files are registered immediately.
        authoritative_hash = full_fingerprint(file_path) if any(candidate_hashes) else None
        if tombstone is not None and tombstone["full_hash"] == authoritative_hash:
            return tombstone["photo_id"]
        exact_candidates = [
            candidate for candidate in candidates
            if candidate["stored_full_hash"] and candidate["stored_full_hash"] == authoritative_hash
        ]
        existing = exact_candidates[0] if len(exact_candidates) == 1 else None

    timestamp = int(time.time() * 1000)
    if existing is not None:
        content_changed_now = bool(
            changed and existing["file_id"] == identity and existing["file_fingerprint"]
            and existing["file_fingerprint"] != fingerprint
        )
        content_changed = bool(existing["content_changed"] or content_changed_now)
        db.execute(
            """UPDATE versions SET file_path=?, file_path_key=?, file_id=?, file_fingerprint=?, file_size=?,
               file_modified_at=?, file_missing=0, content_changed=?,
               thumbnail_path=CASE WHEN ?=1 THEN NULL ELSE thumbnail_path END,
               updated_at=? WHERE id=?""",
            (file_path, path_key, identity, fingerprint, stat.st_size, mtime_ms, int(content_changed),
             int(content_changed_now), timestamp, existing["id"]),
        )
        db.execute(
            """UPDATE photos SET original_file_path=CASE WHEN ?=0 THEN ? ELSE original_file_path END,
               original_file_id=CASE WHEN ?=0 THEN ? ELSE original_file_id END,
               original_fingerprint=CASE WHEN ?=0 THEN ? ELSE original_fingerprint END,
               updated_at=? WHERE id=?""",
            (existing["version_number"], file_path, existing["version_number"], identity,
             existing["version_number"], fingerprint, timestamp, existing["photo_id"]),
        )
        cached_hash = None if changed else existing["stored_full_hash"]
        upsert_file_record(db, existing["id"], file_path, stat, identity, fingerprint, cached_hash)
        if not cached_hash:
            queue_full_fingerprint(pending_hashes, existing["id"], file_path, stat)
        return existing["photo_id"]

    photo_id = str(uuid.uuid4())
    version_id = str(uuid.uuid4())
    db.execute(
        """INSERT INTO photos(id,project_id,media_type,original_name,display_name,current_version_id,
           original_file_path,original_file_id,original_fingerprint,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
        (photo_id, project["id"], kind, os.path.basename(file_path), os.path.splitext(os.path.basename(file_path))[0],
         version_id, file_path, identity, fingerprint, timestamp, timestamp),
    )
    db.execute(
        """INSERT INTO versions(id,photo_id,parent_version_id,version_number,version_name,version_type,file_path,
           file_path_key,file_id,file_fingerprint,file_size,file_modified_at,status,is_current,created_at,updated_at)
           VALUES(?,?,NULL,0,'原片','original',?,?,?,?,?,?,'original',1,?,?)""",
        (version_id, photo_id, file_path, path_key, identity, fingerprint, stat.st_size, mtime_ms, timestamp, timestamp),
    )
    upsert_file_record(db, version_id, file_path, stat, identity, fingerprint, None)
    queue_full_fingerprint(pending_hashes, version_id, file_path, stat)
    return photo_id

def mark_missing_project_versions(db, project_id: str):
    """Refresh missing flags before matching fingerprints across volumes."""
    timestamp = int(time.time() * 1000)
    rows = db.execute(
        """SELECT versions.id, versions.file_path FROM versions JOIN photos ON photos.id=versions.photo_id
           WHERE photos.project_id=? AND versions.is_deleted=0""", (project_id,)
    ).fetchall()
    for row in rows:
        if os.path.isfile(row["file_path"]):
            continue
        db.execute("UPDATE versions SET file_missing=1, updated_at=? WHERE id=?", (timestamp, row["id"]))
        db.execute(
            "UPDATE file_records SET missing=1, updated_at=? WHERE owner_type='version' AND owner_id=?",
            (timestamp, row["id"]),
        )

def _validated_media_scan_roots(root: str, project, external_roots) -> tuple[list[dict], list[dict]]:
    """Return separate authorization and online-enumeration capabilities.

    Offline registry entries remain authorized for missing reconciliation, but
    they are never realpathed or walked. Online entries are revalidated here so
    a target disappearing between the main process and worker is safely
    downgraded to offline for this snapshot.
    """
    project_path = os.path.join(os.path.abspath(root), project["relative_path"])
    if not isinstance(external_roots, list) or len(external_roots) > 2048:
        raise ValueError("external_media_roots_invalid: 外链媒体根目录无效")
    project_path = canonical_path(project_path)
    roots = [{
        "path": project_path, "realPath": canonical_path(os.path.realpath(project_path)),
        "kind": "folder", "online": True, "authorized": True,
    }]
    for item in external_roots:
        if not isinstance(item, dict):
            raise ValueError("external_media_root_invalid: 外链媒体根目录无效")
        raw_candidate = str(item.get("path") or "").strip()
        candidate = canonical_path(raw_candidate) if raw_candidate else ""
        kind = str(item.get("kind") or "")
        if (not candidate or not os.path.isabs(candidate) or kind not in ("folder", "file")
                or item.get("authorized") is not True or not isinstance(item.get("online"), bool)):
            raise ValueError("external_media_root_invalid: 外链媒体根目录无效")
        online = item["online"]
        real_path = None
        if online:
            try:
                os.stat(candidate)
                kind_matches = os.path.isdir(candidate) if kind == "folder" else os.path.isfile(candidate)
                if not kind_matches:
                    online = False
                else:
                    real_path = canonical_path(os.path.realpath(candidate))
            except (FileNotFoundError, PermissionError, OSError):
                online = False
        roots.append({
            "path": candidate, **({"realPath": real_path} if real_path else {}),
            "kind": kind, "online": online, "authorized": True,
        })
    deduplicated = []
    seen = set()
    for entry in roots:
        key = (canonical_path(entry["path"]).casefold(), entry["kind"])
        if key in seen:
            continue
        seen.add(key)
        deduplicated.append(entry)
    return deduplicated, [entry for entry in deduplicated if entry["online"]]

def _media_path_is_authorized(file_path: str, roots: list[dict], require_online: bool = False) -> bool:
    lexical_candidate = canonical_path(file_path)
    for entry in roots:
        if require_online and not entry["online"]:
            continue
        authorized = canonical_path(entry["path"])
        lexical_match = lexical_candidate.casefold() == authorized.casefold() \
            if entry["kind"] == "file" else (
                lexical_candidate.casefold() == authorized.casefold()
                or is_project_descendant(lexical_candidate, authorized)
            )
        if not lexical_match:
            continue
        if not entry["online"]:
            # Offline authority is deliberately lexical and bounded to the
            # registered root. It can mark missing paths but cannot broaden to
            # a parent or acquire enumeration authority.
            return True
        candidate = canonical_path(os.path.realpath(lexical_candidate))
        real_authorized = canonical_path(entry.get("realPath") or os.path.realpath(authorized))
        if entry["kind"] == "file" and candidate.casefold() == real_authorized.casefold():
            return True
        if entry["kind"] == "folder" and (
                candidate.casefold() == real_authorized.casefold()
                or is_project_descendant(candidate, real_authorized)):
            return True
    return False

def media_sync_prepare(root: str, db, payload: dict):
    """Build an immutable filesystem enumeration while holding only a read lease."""
    project = project_row(db, payload["projectName"])
    if payload.get("paged") is True:
        return _media_sync_prepare_paged(root, db, payload, project)
    if "availability" in project.keys() and project["availability"] == "missing":
        return {"success": True, "count": 0, "files": [], "baselineVersions": [],
                "authorizedRoots": [], "thumbnailCandidates": [], "projectUnavailable": True}
    authorized_roots, scan_roots = _validated_media_scan_roots(root, project, payload.get("externalRoots") or [])
    files = []
    seen_paths = set()

    def snapshot_file(file_path: str):
        path_key = canonical_path(file_path).casefold()
        if path_key in seen_paths or not media_type(file_path):
            return
        try:
            stat = os.stat(file_path)
        except (FileNotFoundError, PermissionError, OSError):
            return
        if not os.path.isfile(file_path):
            return
        seen_paths.add(path_key)
        files.append({
            "filePath": canonical_path(file_path),
            "fileSize": int(stat.st_size),
            "modifiedAt": int(stat.st_mtime_ns / 1_000_000),
        })

    for scan_root in scan_roots:
        scan_kind = scan_root["kind"]
        scan_root = scan_root["path"]
        if scan_kind == "file":
            snapshot_file(scan_root)
            continue
        real_scan_root = os.path.realpath(scan_root)

        def inside_scan_root(candidate):
            try:
                return os.path.commonpath((os.path.realpath(candidate), real_scan_root)).casefold() == real_scan_root.casefold()
            except ValueError:
                return False

        for directory, directory_names, file_names in os.walk(scan_root):
            directory_names[:] = [name for name in directory_names if inside_scan_root(os.path.join(directory, name))]
            if not inside_scan_root(directory):
                continue
            for name in file_names:
                snapshot_file(os.path.join(directory, name))

    baseline = db.execute(
        """SELECT versions.id,versions.updated_at FROM versions
           JOIN photos ON photos.id=versions.photo_id
           WHERE photos.project_id=? AND versions.is_deleted=0""",
        (project["id"],),
    ).fetchall()
    return {
        "success": True,
        "projectName": project["name"],
        "snapshotId": str(uuid.uuid4()),
        "files": files,
        "baselineVersions": [{"id": row["id"], "updatedAt": int(row["updated_at"])} for row in baseline],
        "authorizedRoots": authorized_roots,
    }

def _full_sync_snapshot_page(db, snapshot, project, page_token=0) -> dict:
    page_size = MEDIA_INCREMENTAL_BATCH_SIZE
    try:
        offset = int(page_token or 0)
    except (TypeError, ValueError) as error:
        raise ValueError("media_sync_page_invalid: 分页游标无效") from error
    if offset < 0 or offset % page_size:
        raise ValueError("media_sync_page_invalid: 分页游标无效")
    total = int(db.execute(
        "SELECT COUNT(*) FROM media_incremental_snapshot_files WHERE snapshot_id=?", (snapshot["snapshot_id"],)
    ).fetchone()[0])
    files = [
        {"filePath": row["file_path"], "fileSize": int(row["file_size"]), "modifiedAt": int(row["modified_at"])}
        for row in db.execute(
            """SELECT file_path,file_size,modified_at FROM media_incremental_snapshot_files
               WHERE snapshot_id=? AND ordinal>=? AND ordinal<? ORDER BY ordinal""",
            (snapshot["snapshot_id"], offset, offset + page_size),
        ).fetchall()
    ]
    next_offset = offset + len(files)
    return {
        "success": True, "paged": True, "projectName": project["name"],
        "snapshotId": snapshot["snapshot_id"], "manifestHash": snapshot["manifest_hash"],
        "files": files, "pageOffset": offset, "pageSize": page_size, "totalFiles": total,
        "nextPageToken": str(next_offset) if next_offset < total else None,
        # The persisted manifest, not capabilities echoed through Node, is the
        # authority for paged apply/finalize.
        "authorizedRoots": [], "baselineVersions": [],
    }

def _media_sync_prepare_paged(root: str, db, payload: dict, project) -> dict:
    """Persist a full-scan manifest and return one bounded immutable page."""
    if "availability" in project.keys() and project["availability"] == "missing":
        return {"success": True, "paged": True, "count": 0, "files": [], "baselineVersions": [],
                "authorizedRoots": [], "thumbnailCandidates": [], "projectUnavailable": True,
                "nextPageToken": None, "totalFiles": 0}
    snapshot_id = str(payload.get("snapshotId") or uuid.uuid4())
    _media_sync_marker(snapshot_id, "full-paged-prepare")
    _cleanup_incremental_snapshots(db, int(time.time() * 1000), snapshot_id, project["id"])
    db.commit()
    persisted = _incremental_snapshot_row(db, snapshot_id)
    if persisted is not None and persisted["state"] == "prepared":
        if persisted["project_id"] != project["id"]:
            raise ValueError("media_sync_snapshot_project_mismatch: 扫描快照属于其他项目")
        _touch_incremental_snapshot_lease(db, snapshot_id, project["id"]); db.commit()
        return _full_sync_snapshot_page(db, persisted, project, payload.get("pageToken") or 0)
    if persisted is not None and persisted["state"] == "preparing":
        error = RuntimeError("media_sync_scan_busy: 扫描 manifest 正在生成")
        error.code = "MEDIA_SYNC_SCAN_BUSY"
        raise error
    if payload.get("pageToken") not in (None, "", 0, "0"):
        raise ValueError("media_sync_snapshot_missing: 分页 manifest 尚未完成")

    authorized_roots, scan_roots = _validated_media_scan_roots(root, project, payload.get("externalRoots") or [])
    now = int(time.time() * 1000)
    db.execute("BEGIN IMMEDIATE")
    try:
        _assert_incremental_snapshot_capacity(db, project["id"], snapshot_id)
        if persisted is not None:
            for table in ("media_incremental_snapshot_batches", "media_incremental_snapshot_baseline",
                          "media_incremental_snapshot_scopes", "media_incremental_snapshot_files"):
                db.execute(f"DELETE FROM {table} WHERE snapshot_id=?", (snapshot_id,))
            db.execute("DELETE FROM media_incremental_snapshots WHERE snapshot_id=?", (snapshot_id,))
        _cleanup_incremental_snapshots(db, now, snapshot_id, project["id"])
        db.execute(
            """INSERT INTO media_incremental_snapshots(
                 snapshot_id,project_id,state,manifest_hash,result_json,created_at,finalized_at)
               VALUES(?,?,'preparing','',NULL,?,NULL)""", (snapshot_id, project["id"], now),
        )
        _touch_incremental_snapshot_lease(db, snapshot_id, project["id"], now)
        db.executemany(
            """INSERT INTO media_incremental_snapshot_scopes(
                 snapshot_id,ordinal,path_key,scope_kind,like_prefix) VALUES(?,?,?,?,?)""",
            [(snapshot_id, ordinal, canonical_path(entry["path"]).casefold(),
              "directory" if entry["kind"] == "folder" else "file",
              _incremental_like_prefix(canonical_path(entry["path"]).casefold()) if entry["kind"] == "folder" else None)
             for ordinal, entry in enumerate(authorized_roots)],
        )
        # Freeze the reconciliation population before filesystem enumeration.
        # Versions created after this commit are intentionally absent and can
        # never be marked missing by this older snapshot.
        db.execute(
            """INSERT INTO media_incremental_snapshot_baseline(snapshot_id,version_id,updated_at)
               SELECT ?,versions.id,versions.updated_at FROM versions
               JOIN photos ON photos.id=versions.photo_id
               WHERE photos.project_id=? AND versions.is_deleted=0""", (snapshot_id, project["id"]),
        )
        db.commit()
    except Exception:
        db.rollback(); raise

    digest = hashlib.sha256()
    ordinal = 0
    last_heartbeat = now

    def heartbeat_if_due(force=False):
        nonlocal last_heartbeat
        current = int(time.time() * 1000)
        if force or current - last_heartbeat >= 30_000:
            _touch_incremental_snapshot_lease(db, snapshot_id, project["id"], current)
            db.commit()
            last_heartbeat = current

    def persist_file(file_path: str):
        nonlocal ordinal
        canonical = canonical_path(file_path)
        if not media_type(canonical):
            return
        try:
            stat = os.stat(canonical)
        except (FileNotFoundError, PermissionError, OSError):
            return
        if not os.path.isfile(canonical):
            return
        entry = {"filePath": canonical, "fileSize": int(stat.st_size), "modifiedAt": int(stat.st_mtime_ns / 1_000_000)}
        inserted = db.execute(
            """INSERT INTO media_incremental_snapshot_files(
                 snapshot_id,ordinal,file_path,file_path_key,file_size,modified_at)
               SELECT ?,?,?,?,?,? WHERE NOT EXISTS(
                 SELECT 1 FROM media_incremental_snapshot_files WHERE snapshot_id=? AND file_path_key=?)""",
            (snapshot_id, ordinal, canonical, canonical.casefold(), entry["fileSize"], entry["modifiedAt"],
             snapshot_id, canonical.casefold()),
        ).rowcount
        if inserted:
            digest.update(json.dumps(entry, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))
            ordinal += 1
            if ordinal % 256 == 0:
                heartbeat_if_due(True)

    try:
        for scan_root in scan_roots:
            scan_path = scan_root["path"]
            if scan_root["kind"] == "file":
                persist_file(scan_path)
                continue
            real_scan_root = os.path.realpath(scan_path)
            def inside_scan_root(candidate):
                try:
                    return os.path.commonpath((os.path.realpath(candidate), real_scan_root)).casefold() == real_scan_root.casefold()
                except ValueError:
                    return False
            for directory, directory_names, file_names in os.walk(scan_path):
                heartbeat_if_due()
                directory_names[:] = [name for name in directory_names if inside_scan_root(os.path.join(directory, name))]
                if inside_scan_root(directory):
                    for name in file_names:
                        persist_file(os.path.join(directory, name))
        db.commit()
        db.execute("BEGIN IMMEDIATE")
        for row in db.execute(
            "SELECT version_id,updated_at FROM media_incremental_snapshot_baseline WHERE snapshot_id=? ORDER BY version_id",
            (snapshot_id,),
        ):
            digest.update(f"\0{row['version_id']}:{int(row['updated_at'])}".encode("utf-8"))
        db.execute(
            "UPDATE media_incremental_snapshots SET state='prepared',manifest_hash=? WHERE snapshot_id=?",
            (digest.hexdigest(), snapshot_id),
        )
        db.commit()
    except Exception:
        if db.in_transaction: db.rollback()
        raise
    return _full_sync_snapshot_page(db, _incremental_snapshot_row(db, snapshot_id), project, 0)

def _media_sync_marker(snapshot_id: str, suffix: str) -> str:
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", snapshot_id):
        raise ValueError("media_sync_snapshot_invalid: 扫描快照无效")
    return f"media_sync:{snapshot_id}:{suffix}"

def media_sync_apply_batch(root: str, db, payload: dict):
    project = project_row(db, payload["projectName"])
    snapshot_id = str(payload.get("snapshotId") or "")
    batch_index = int(payload.get("batchIndex") or 0)
    if batch_index < 0:
        raise ValueError("media_sync_batch_invalid: 扫描批次无效")
    files = payload.get("files") or []
    if not isinstance(files, list) or len(files) > 256:
        raise ValueError("media_sync_batch_invalid: 扫描批次过大")
    payload_digest = _media_operation_digest("media_sync_apply_batch", payload)
    completed_marker = _meta_value(db, _media_sync_marker(snapshot_id, "completed-batches"))
    if completed_marker:
        completed = json.loads(completed_marker).get(str(batch_index))
        if completed:
            if completed.get("payloadDigest") != payload_digest:
                raise MediaSyncBatchMismatch("MEDIA_SYNC_BATCH_MISMATCH: 已完成批次载荷不匹配")
            return completed["result"]
    marker = _media_sync_marker(snapshot_id, f"batch:{batch_index}")
    cached = _meta_value(db, marker)
    if cached:
        cached_digest = _meta_value(db, _media_sync_marker(snapshot_id, f"batch-digest:{batch_index}"))
        if cached_digest and cached_digest != payload_digest:
            raise MediaSyncBatchMismatch("MEDIA_SYNC_BATCH_MISMATCH: 批次载荷与已提交标记不一致")
        return json.loads(cached)
    _authorized_roots, roots = _validated_media_scan_roots(root, project, payload.get("authorizedRoots") or [])
    count = 0
    pending_hashes = []
    for entry in files:
        file_path = canonical_path(str((entry or {}).get("filePath") or ""))
        if not file_path or not _media_path_is_authorized(file_path, roots, require_online=True):
            raise ValueError("media_sync_file_outside_snapshot: 扫描文件超出授权范围")
        try:
            if sync_media_file(db, project, file_path, pending_hashes):
                count += 1
        except (FileNotFoundError, PermissionError, OSError):
            continue
    result = {"success": True, "snapshotId": snapshot_id, "batchIndex": batch_index, "count": count}
    _set_meta(db, marker, json.dumps(result, ensure_ascii=False))
    _set_meta(db, _media_sync_marker(snapshot_id, f"batch-digest:{batch_index}"), payload_digest)
    db.commit()
    # Full-file hashing is deliberately not performed under this writer lease.
    # A later fingerprint-maintenance pass can fill the optional hashes.
    return result

def media_sync_finalize(root: str, db, payload: dict):
    project = project_row(db, payload["projectName"])
    snapshot_id = str(payload.get("snapshotId") or "")
    marker = _media_sync_marker(snapshot_id, "finalize")
    cached = _meta_value(db, marker)
    if cached:
        return json.loads(cached)
    files = payload.get("files") or []
    baseline_versions = payload.get("baselineVersions") or []
    if not isinstance(files, list) or len(files) > 1_000_000 or not isinstance(baseline_versions, list) or len(baseline_versions) > 1_000_000:
        raise ValueError("media_sync_snapshot_invalid: 扫描快照过大")
    roots, _enumeration_roots = _validated_media_scan_roots(root, project, payload.get("authorizedRoots") or [])
    seen_paths = {canonical_path(str((entry or {}).get("filePath") or "")).casefold() for entry in files}
    baseline = {str((entry or {}).get("id") or ""): int((entry or {}).get("updatedAt") or 0) for entry in baseline_versions}
    timestamp = int(time.time() * 1000)
    version_rows = db.execute(
        """SELECT versions.id,versions.updated_at,versions.file_path,versions.file_path_key
           FROM versions JOIN photos ON photos.id=versions.photo_id
           WHERE photos.project_id=? AND versions.is_deleted=0""",
        (project["id"],),
    ).fetchall()
    missing_count = 0
    for row in version_rows:
        # New or interactively changed rows have a different per-row revision;
        # an old filesystem snapshot must never mark them missing.
        if row["id"] not in baseline or int(row["updated_at"]) != baseline[row["id"]]:
            continue
        if row["file_path_key"] in seen_paths:
            continue
        if os.path.isfile(row["file_path"]) and _media_path_is_authorized(row["file_path"], roots):
            continue
        db.execute("UPDATE versions SET file_missing=1,updated_at=? WHERE id=? AND updated_at=?", (timestamp, row["id"], row["updated_at"]))
        db.execute("UPDATE file_records SET missing=1,updated_at=? WHERE owner_type='version' AND owner_id=?", (timestamp, row["id"]))
        missing_count += 1
    thumbnail_rows = db.execute(
        """SELECT versions.id AS version_id,versions.photo_id,versions.file_path,versions.thumbnail_path
           FROM versions JOIN photos ON photos.id=versions.photo_id
           WHERE photos.project_id=? AND versions.is_deleted=0 AND versions.file_missing=0""",
        (project["id"],),
    ).fetchall()
    result = {
        "success": True,
        "snapshotId": snapshot_id,
        "missingCount": missing_count,
        "thumbnailCandidates": [
            {"versionId": row["version_id"], "photoId": row["photo_id"], "filePath": row["file_path"]}
            for row in thumbnail_rows if not row["thumbnail_path"] or not os.path.isfile(row["thumbnail_path"])
        ],
    }
    completed_batches = {}
    result_prefix = f"media_sync:{snapshot_id}:batch:"
    digest_prefix = f"media_sync:{snapshot_id}:batch-digest:"
    digests = {
        row["key"][len(digest_prefix):]: row["value"]
        for row in db.execute("SELECT key,value FROM meta WHERE key LIKE ?", (f"{digest_prefix}%",)).fetchall()
    }
    for row in db.execute("SELECT key,value FROM meta WHERE key LIKE ?", (f"{result_prefix}%",)).fetchall():
        batch_key = row["key"][len(result_prefix):]
        if batch_key in digests:
            completed_batches[batch_key] = {"payloadDigest": digests[batch_key], "result": json.loads(row["value"])}
    _set_meta(db, _media_sync_marker(snapshot_id, "completed-batches"), json.dumps(completed_batches, ensure_ascii=False, sort_keys=True))
    _set_meta(db, _media_sync_marker(snapshot_id, "completed-at"), str(timestamp))
    db.execute("DELETE FROM meta WHERE key LIKE ?", (f"media_sync:{snapshot_id}:batch:%",))
    db.execute("DELETE FROM meta WHERE key LIKE ?", (f"media_sync:{snapshot_id}:batch-digest:%",))
    _set_meta(db, marker, json.dumps(result, ensure_ascii=False))
    _prune_legacy_sync_completions(db, timestamp)
    db.commit()
    return result

def _incremental_like_prefix(path_key: str) -> str:
    """Escape a canonical path for SQLite LIKE without treating %, _ or ! as wildcards."""
    escaped = path_key.replace("!", "!!").replace("%", "!%").replace("_", "!_")
    separator = os.sep.replace("!", "!!").replace("%", "!%").replace("_", "!_")
    return escaped + separator + "%"

def _incremental_authorized_path(candidate: str, roots: list[dict]) -> bool:
    absolute = canonical_path(candidate)
    if not absolute or not os.path.isabs(absolute):
        return False
    for entry in roots:
        authorized = canonical_path(entry["path"])
        lexical_match = absolute.casefold() == authorized.casefold() \
            if entry["kind"] == "file" else (
                absolute.casefold() == authorized.casefold()
                or is_project_descendant(absolute, authorized)
            )
        if not lexical_match:
            continue
        if not entry["online"]:
            return True
        if os.path.lexists(absolute):
            return _media_path_is_authorized(absolute, [entry], require_online=True)
        parent = absolute
        suffix = []
        while parent and not os.path.lexists(parent):
            next_parent, name = os.path.split(parent)
            if next_parent == parent:
                break
            suffix.append(name)
            parent = next_parent
        resolved = canonical_path(os.path.join(os.path.realpath(parent), *reversed(suffix)))
        real_authorized = canonical_path(entry.get("realPath") or os.path.realpath(authorized))
        if entry["kind"] == "file" and resolved.casefold() == real_authorized.casefold():
            return True
        if entry["kind"] == "folder" and (
                resolved.casefold() == real_authorized.casefold()
                or is_project_descendant(resolved, real_authorized)):
            return True
    return False

class MediaSyncBatchMismatch(ValueError):
    code = "MEDIA_SYNC_BATCH_MISMATCH"

def _incremental_manifest_digest(value) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()

def _incremental_snapshot_row(db, snapshot_id: str):
    return db.execute(
        "SELECT * FROM media_incremental_snapshots WHERE snapshot_id=?", (snapshot_id,)
    ).fetchone()

def _incremental_snapshot_files(db, snapshot_id: str) -> list[dict]:
    return [
        {"filePath": row["file_path"], "fileSize": int(row["file_size"]), "modifiedAt": int(row["modified_at"])}
        for row in db.execute(
            """SELECT file_path,file_size,modified_at FROM media_incremental_snapshot_files
               WHERE snapshot_id=? ORDER BY ordinal""",
            (snapshot_id,),
        ).fetchall()
    ]

def _incremental_snapshot_result(db, snapshot, project) -> dict:
    snapshot_id = snapshot["snapshot_id"]
    scopes = [
        {"pathKey": row["path_key"], "kind": row["scope_kind"], "likePrefix": row["like_prefix"]}
        for row in db.execute(
            """SELECT path_key,scope_kind,like_prefix FROM media_incremental_snapshot_scopes
               WHERE snapshot_id=? ORDER BY ordinal""",
            (snapshot_id,),
        ).fetchall()
    ]
    baseline = [
        {"id": row["version_id"], "updatedAt": int(row["updated_at"])}
        for row in db.execute(
            """SELECT version_id,updated_at FROM media_incremental_snapshot_baseline
               WHERE snapshot_id=? ORDER BY version_id""",
            (snapshot_id,),
        ).fetchall()
    ]
    return {
        "success": True,
        "projectName": project["name"],
        "snapshotId": snapshot_id,
        "manifestHash": snapshot["manifest_hash"],
        "files": _incremental_snapshot_files(db, snapshot_id),
        "scopes": scopes,
        "baselineVersions": baseline,
        # Kept for wire compatibility only. Apply/finalize deliberately trust
        # the persisted manifest instead of roots echoed by Node.
        "authorizedRoots": [],
        **({"finalResult": json.loads(snapshot["result_json"])} if snapshot["result_json"] else {}),
    }

def _cleanup_incremental_snapshots(db, now: int, active_snapshot_id: str | None = None,
                                   project_id: str | None = None):
    stale_ids = {
        row[0] for row in db.execute(
            """SELECT snapshot_id FROM media_incremental_snapshots
               WHERE state='finalized' AND finalized_at IS NOT NULL AND finalized_at<?""",
            (now - MEDIA_INCREMENTAL_COMPLETED_RETENTION_MS,),
        ).fetchall()
    }
    values = (project_id,) if project_id else ()
    clause = " AND project_id=?" if project_id else ""
    incomplete = db.execute(
        f"""SELECT snapshot_id,project_id,created_at FROM media_incremental_snapshots
            WHERE state!='finalized'{clause} ORDER BY project_id,created_at DESC,snapshot_id DESC""", values,
    ).fetchall()
    for row in incomplete:
        snapshot_id = str(row["snapshot_id"])
        if snapshot_id == active_snapshot_id:
            continue
        lease_raw = _meta_value(db, f"media_sync_lease:{snapshot_id}")
        try:
            heartbeat = int(json.loads(lease_raw).get("heartbeatAt") or 0) if lease_raw else 0
        except (TypeError, ValueError, json.JSONDecodeError):
            heartbeat = 0
        last_active = max(int(row["created_at"] or 0), heartbeat)
        if last_active < now - MEDIA_INCREMENTAL_INCOMPLETE_RETENTION_MS:
            stale_ids.add(snapshot_id)
    for snapshot_id in stale_ids:
        db.execute("DELETE FROM media_incremental_snapshot_batches WHERE snapshot_id=?", (snapshot_id,))
        db.execute("DELETE FROM media_incremental_snapshot_baseline WHERE snapshot_id=?", (snapshot_id,))
        db.execute("DELETE FROM media_incremental_snapshot_scopes WHERE snapshot_id=?", (snapshot_id,))
        db.execute("DELETE FROM media_incremental_snapshot_files WHERE snapshot_id=?", (snapshot_id,))
        db.execute("DELETE FROM media_incremental_snapshots WHERE snapshot_id=?", (snapshot_id,))
        db.execute("DELETE FROM meta WHERE key=?", (f"media_sync_lease:{snapshot_id}",))

def _touch_incremental_snapshot_lease(db, snapshot_id: str, project_id: str, now: int | None = None) -> None:
    now = int(now or time.time() * 1000)
    _set_meta(db, f"media_sync_lease:{snapshot_id}", json.dumps({
        "projectId": project_id, "heartbeatAt": now,
        "expiresAt": now + MEDIA_INCREMENTAL_INCOMPLETE_RETENTION_MS,
    }, sort_keys=True))

def _assert_incremental_snapshot_capacity(db, project_id: str, snapshot_id: str) -> None:
    existing = db.execute(
        "SELECT 1 FROM media_incremental_snapshots WHERE snapshot_id=? AND project_id=?",
        (snapshot_id, project_id),
    ).fetchone()
    if existing:
        return
    count = int(db.execute(
        "SELECT COUNT(*) FROM media_incremental_snapshots WHERE project_id=? AND state!='finalized'", (project_id,),
    ).fetchone()[0])
    if count >= MEDIA_INCREMENTAL_INCOMPLETE_SOFT_LIMIT:
        error = RuntimeError("media_sync_scan_busy: 同一项目存在过多未完成扫描，请等待或稍后重试")
        error.code = "MEDIA_SYNC_SCAN_BUSY"
        raise error

def media_sync_paths_prepare(root: str, db, payload: dict):
    project = project_row(db, payload["projectName"])
    snapshot_id = str(payload.get("snapshotId") or uuid.uuid4())
    _media_sync_marker(snapshot_id, "paths-prepare")
    _cleanup_incremental_snapshots(db, int(time.time() * 1000), snapshot_id, project["id"])
    db.commit()
    persisted = _incremental_snapshot_row(db, snapshot_id)
    if persisted is not None:
        if persisted["project_id"] != project["id"]:
            raise ValueError("media_sync_snapshot_project_mismatch: 增量快照属于其他项目")
        if persisted["state"] == "prepared" or persisted["state"] == "finalized":
            if persisted["state"] == "prepared":
                _touch_incremental_snapshot_lease(db, snapshot_id, project["id"]); db.commit()
            return _incremental_snapshot_result(db, persisted, project)
        error = RuntimeError("media_sync_scan_busy: 增量扫描 manifest 正在生成")
        error.code = "MEDIA_SYNC_SCAN_BUSY"
        raise error
    changes = payload.get("changes") or []
    if not isinstance(changes, list) or len(changes) > 2048:
        raise ValueError("media_sync_paths_limit: 增量路径批次无效或超过 2048 条")
    authorized_roots, enumeration_roots = _validated_media_scan_roots(root, project, payload.get("externalRoots") or [])
    started_at = int(time.time() * 1000)
    db.execute("BEGIN IMMEDIATE")
    try:
        _assert_incremental_snapshot_capacity(db, project["id"], snapshot_id)
        db.execute(
            """INSERT INTO media_incremental_snapshots(
                 snapshot_id,project_id,state,manifest_hash,result_json,created_at,finalized_at)
               VALUES(?,?,'preparing','',NULL,?,NULL)""", (snapshot_id, project["id"], started_at),
        )
        _touch_incremental_snapshot_lease(db, snapshot_id, project["id"], started_at)
        db.commit()
    except Exception:
        db.rollback(); raise
    files = []
    scopes = []
    seen = set()
    last_heartbeat = started_at

    def heartbeat_if_due():
        nonlocal last_heartbeat
        current = int(time.time() * 1000)
        if current - last_heartbeat >= 30_000:
            _touch_incremental_snapshot_lease(db, snapshot_id, project["id"], current)
            db.commit(); last_heartbeat = current

    def snapshot_file(file_path: str):
        canonical = canonical_path(file_path)
        key = canonical.casefold()
        if key in seen or not media_type(canonical) or not _media_path_is_authorized(canonical, enumeration_roots, require_online=True):
            return
        try:
            stat = os.stat(canonical)
        except (FileNotFoundError, PermissionError, OSError):
            return
        if not os.path.isfile(canonical):
            return
        seen.add(key)
        files.append({"filePath": canonical, "fileSize": int(stat.st_size), "modifiedAt": int(stat.st_mtime_ns / 1_000_000)})

    for change in changes:
        if not isinstance(change, dict):
            raise ValueError("media_sync_path_invalid: 增量路径无效")
        candidate = canonical_path(str(change.get("path") or ""))
        if not _incremental_authorized_path(candidate, authorized_roots):
            raise ValueError("media_sync_path_unauthorized: 增量路径超出项目或授权外链")
        declared_kind = str(change.get("kind") or "")
        exists = os.path.lexists(candidate)
        actual_kind = "directory" if exists and os.path.isdir(candidate) else "file" if exists and os.path.isfile(candidate) else "missing"
        scope_kind = "directory" if declared_kind == "directory" or actual_kind == "directory" \
            or actual_kind == "missing" and not media_type(candidate) else "file"
        scopes.append({"pathKey": candidate.casefold(), "kind": scope_kind})
        if actual_kind == "file":
            snapshot_file(candidate)
        elif actual_kind == "directory":
            real_root = canonical_path(os.path.realpath(candidate))
            def inside_incremental_root(value):
                resolved = canonical_path(os.path.realpath(value))
                if resolved.casefold() == real_root.casefold():
                    return True
                return is_project_descendant(resolved, real_root)
            for directory, directory_names, file_names in os.walk(candidate):
                heartbeat_if_due()
                directory_names[:] = [name for name in directory_names if inside_incremental_root(os.path.join(directory, name))]
                if not inside_incremental_root(directory):
                    continue
                for name in file_names:
                    snapshot_file(os.path.join(directory, name))

    files.sort(key=lambda entry: (canonical_path(entry["filePath"]).casefold(), canonical_path(entry["filePath"])))
    deduplicated_scopes = {
        (scope["pathKey"], scope["kind"]): scope for scope in scopes
    }
    scopes = [deduplicated_scopes[key] for key in sorted(deduplicated_scopes)]
    now = int(time.time() * 1000)
    db.execute("BEGIN IMMEDIATE")
    try:
        persisted = _incremental_snapshot_row(db, snapshot_id)
        if persisted is None or persisted["project_id"] != project["id"] or persisted["state"] != "preparing":
            raise RuntimeError("media_sync_snapshot_lease_lost: 增量扫描租约已丢失")
        _cleanup_incremental_snapshots(db, now, snapshot_id, project["id"])
        db.executemany(
            """INSERT INTO media_incremental_snapshot_files(
                 snapshot_id,ordinal,file_path,file_path_key,file_size,modified_at)
               VALUES(?,?,?,?,?,?)""",
            [(snapshot_id, ordinal, entry["filePath"], canonical_path(entry["filePath"]).casefold(),
              int(entry["fileSize"]), int(entry["modifiedAt"])) for ordinal, entry in enumerate(files)],
        )
        db.executemany(
            """INSERT INTO media_incremental_snapshot_scopes(
                 snapshot_id,ordinal,path_key,scope_kind,like_prefix) VALUES(?,?,?,?,?)""",
            [(snapshot_id, ordinal, scope["pathKey"], scope["kind"],
              _incremental_like_prefix(scope["pathKey"]) if scope["kind"] == "directory" else None)
             for ordinal, scope in enumerate(scopes)],
        )
        # A relational EXISTS handles thousands of scopes without constructing
        # a deeply nested OR expression.
        db.execute(
            """INSERT INTO media_incremental_snapshot_baseline(snapshot_id,version_id,updated_at)
               SELECT ?,versions.id,versions.updated_at
               FROM versions JOIN photos ON photos.id=versions.photo_id
               WHERE photos.project_id=? AND versions.is_deleted=0 AND EXISTS(
                 SELECT 1 FROM media_incremental_snapshot_scopes scope
                 WHERE scope.snapshot_id=? AND (
                   (scope.scope_kind='file' AND versions.file_path_key=scope.path_key) OR
                   (scope.scope_kind='directory' AND (
                     versions.file_path_key=scope.path_key OR
                     versions.file_path_key LIKE scope.like_prefix ESCAPE '!'
                   ))
                 )
               )""",
            (snapshot_id, project["id"], snapshot_id),
        )
        baseline = [
            {"id": row["version_id"], "updatedAt": int(row["updated_at"])}
            for row in db.execute(
                """SELECT version_id,updated_at FROM media_incremental_snapshot_baseline
                   WHERE snapshot_id=? ORDER BY version_id""", (snapshot_id,)
            ).fetchall()
        ]
        manifest_hash = _incremental_manifest_digest({
            "projectId": project["id"], "files": files, "scopes": scopes, "baseline": baseline,
        })
        db.execute(
            "UPDATE media_incremental_snapshots SET state='prepared',manifest_hash=? WHERE snapshot_id=?",
            (manifest_hash, snapshot_id),
        )
        db.commit()
    except Exception:
        if db.in_transaction:
            db.rollback()
        raise
    return _incremental_snapshot_result(db, _incremental_snapshot_row(db, snapshot_id), project)

def media_sync_paths_apply_batch(root: str, db, payload: dict):
    del root
    project = project_row(db, payload["projectName"])
    snapshot_id = str(payload.get("snapshotId") or "")
    _media_sync_marker(snapshot_id, "paths-batch")
    batch_index = int(payload.get("batchIndex") or 0)
    if batch_index < 0:
        raise ValueError("media_sync_batch_invalid: 扫描批次无效")
    snapshot = _incremental_snapshot_row(db, snapshot_id)
    if snapshot is None or snapshot["project_id"] != project["id"]:
        raise ValueError("media_sync_snapshot_missing: 增量快照不存在或项目不匹配")
    _touch_incremental_snapshot_lease(db, snapshot_id, project["id"]); db.commit()
    files = payload.get("files") or []
    if not isinstance(files, list) or len(files) > MEDIA_INCREMENTAL_BATCH_SIZE:
        raise ValueError("media_sync_batch_invalid: 扫描批次过大")
    normalized = [
        {"filePath": canonical_path(str((entry or {}).get("filePath") or "")),
         "fileSize": int((entry or {}).get("fileSize") or 0),
         "modifiedAt": int((entry or {}).get("modifiedAt") or 0)}
        for entry in files
    ]
    payload_hash = _incremental_manifest_digest(normalized)
    expected = [
        {"filePath": row["file_path"], "fileSize": int(row["file_size"]), "modifiedAt": int(row["modified_at"])}
        for row in db.execute(
            """SELECT file_path,file_size,modified_at FROM media_incremental_snapshot_files
               WHERE snapshot_id=? AND ordinal>=? AND ordinal<? ORDER BY ordinal""",
            (snapshot_id, batch_index * MEDIA_INCREMENTAL_BATCH_SIZE,
             (batch_index + 1) * MEDIA_INCREMENTAL_BATCH_SIZE),
        ).fetchall()
    ]
    marker = db.execute(
        """SELECT payload_hash,result_json FROM media_incremental_snapshot_batches
           WHERE snapshot_id=? AND batch_index=?""", (snapshot_id, batch_index)
    ).fetchone()
    if marker is not None:
        if marker["payload_hash"] != payload_hash:
            raise MediaSyncBatchMismatch("MEDIA_SYNC_BATCH_MISMATCH: 批次载荷与已提交标记不一致")
        return json.loads(marker["result_json"])
    if not expected or normalized != expected:
        raise MediaSyncBatchMismatch("MEDIA_SYNC_BATCH_MISMATCH: 批次载荷与不可变 manifest 不一致")
    db.execute("BEGIN IMMEDIATE")
    try:
        marker = db.execute(
            """SELECT payload_hash,result_json FROM media_incremental_snapshot_batches
               WHERE snapshot_id=? AND batch_index=?""", (snapshot_id, batch_index)
        ).fetchone()
        if marker is not None:
            db.rollback()
            if marker["payload_hash"] != payload_hash:
                raise MediaSyncBatchMismatch("MEDIA_SYNC_BATCH_MISMATCH: 批次载荷与已提交标记不一致")
            return json.loads(marker["result_json"])
        count = 0
        pending_hashes = []
        for entry in expected:
            try:
                if sync_media_file(db, project, entry["filePath"], pending_hashes):
                    count += 1
            except (FileNotFoundError, PermissionError, OSError):
                continue
        result = {"success": True, "snapshotId": snapshot_id, "batchIndex": batch_index, "count": count}
        db.execute(
            """INSERT INTO media_incremental_snapshot_batches(
                 snapshot_id,batch_index,payload_hash,result_json) VALUES(?,?,?,?)""",
            (snapshot_id, batch_index, payload_hash, json.dumps(result, ensure_ascii=False)),
        )
        db.commit()
        return result
    except Exception:
        if db.in_transaction:
            db.rollback()
        raise

def media_sync_paths_finalize(root: str, db, payload: dict):
    del root
    project = project_row(db, payload["projectName"])
    snapshot_id = str(payload.get("snapshotId") or "")
    _media_sync_marker(snapshot_id, "paths-finalize")
    snapshot = _incremental_snapshot_row(db, snapshot_id)
    if snapshot is None or snapshot["project_id"] != project["id"]:
        raise ValueError("media_sync_snapshot_missing: 增量快照不存在或项目不匹配")
    if snapshot["result_json"]:
        db.execute("DELETE FROM meta WHERE key=?", (f"media_sync_lease:{snapshot_id}",)); db.commit()
        return json.loads(snapshot["result_json"])
    db.execute("BEGIN IMMEDIATE")
    try:
        snapshot = _incremental_snapshot_row(db, snapshot_id)
        if snapshot["result_json"]:
            db.rollback()
            return json.loads(snapshot["result_json"])
        file_count = db.execute(
            "SELECT COUNT(*) FROM media_incremental_snapshot_files WHERE snapshot_id=?", (snapshot_id,)
        ).fetchone()[0]
        expected_batches = math.ceil(file_count / MEDIA_INCREMENTAL_BATCH_SIZE)
        applied_batches = db.execute(
            "SELECT COUNT(*) FROM media_incremental_snapshot_batches WHERE snapshot_id=?", (snapshot_id,)
        ).fetchone()[0]
        if applied_batches != expected_batches:
            raise ValueError(
                f"media_sync_snapshot_incomplete: 增量快照批次不完整 {applied_batches}/{expected_batches}"
            )
        rows = db.execute(
            """SELECT versions.id,versions.updated_at,versions.file_path,versions.file_path_key,
                      versions.photo_id,versions.thumbnail_path,baseline.updated_at AS baseline_updated_at,
                      EXISTS(SELECT 1 FROM media_incremental_snapshot_files file
                             WHERE file.snapshot_id=baseline.snapshot_id
                               AND file.file_path_key=versions.file_path_key) AS was_seen
               FROM media_incremental_snapshot_baseline baseline
               JOIN versions ON versions.id=baseline.version_id
               JOIN photos ON photos.id=versions.photo_id
               WHERE baseline.snapshot_id=? AND photos.project_id=? AND versions.is_deleted=0""",
            (snapshot_id, project["id"]),
        ).fetchall()
        timestamp = int(time.time() * 1000)
        missing_count = 0
        for row in rows:
            if int(row["updated_at"]) != int(row["baseline_updated_at"]) or row["was_seen"]:
                continue
            changed = db.execute(
                "UPDATE versions SET file_missing=1,updated_at=? WHERE id=? AND updated_at=?",
                (timestamp, row["id"], row["updated_at"]),
            ).rowcount
            if not changed:
                continue
            db.execute("UPDATE file_records SET missing=1,updated_at=? WHERE owner_type='version' AND owner_id=?", (timestamp, row["id"]))
            missing_count += 1
        candidates = db.execute(
            """SELECT versions.id,versions.photo_id,versions.file_path,versions.thumbnail_path
               FROM media_incremental_snapshot_files file
               JOIN versions ON versions.file_path_key=file.file_path_key
               JOIN photos ON photos.id=versions.photo_id
               WHERE file.snapshot_id=? AND photos.project_id=? AND versions.is_deleted=0
                 AND versions.file_missing=0""",
            (snapshot_id, project["id"]),
        ).fetchall()
        result = {
            "success": True, "snapshotId": snapshot_id, "missingCount": missing_count,
            "thumbnailCandidates": [{"versionId": row["id"], "photoId": row["photo_id"], "filePath": row["file_path"]}
                                    for row in candidates if not row["thumbnail_path"] or not os.path.isfile(row["thumbnail_path"])],
        }
        serialized = json.dumps(result, ensure_ascii=False)
        updated = db.execute(
            """UPDATE media_incremental_snapshots
               SET state='finalized',result_json=?,finalized_at=?
               WHERE snapshot_id=? AND result_json IS NULL""",
            (serialized, timestamp, snapshot_id),
        ).rowcount
        if not updated:
            persisted = _incremental_snapshot_row(db, snapshot_id)
            db.rollback()
            return json.loads(persisted["result_json"])
        _prune_incremental_sync_completions(db, timestamp)
        db.execute("DELETE FROM meta WHERE key=?", (f"media_sync_lease:{snapshot_id}",))
        db.commit()
        return result
    except Exception:
        if db.in_transaction:
            db.rollback()
        raise

def media_sync_abort(root: str, db, payload: dict):
    """Remove an unfinished immutable scan after cooperative foreground preemption."""
    del root
    project = project_row(db, payload["projectName"])
    snapshot_id = str(payload.get("snapshotId") or "")
    _media_sync_marker(snapshot_id, "abort")
    snapshot = _incremental_snapshot_row(db, snapshot_id)
    if snapshot is None or snapshot["project_id"] != project["id"]:
        return {"success": True, "removed": False, "snapshotId": snapshot_id}
    if snapshot["state"] == "finalized":
        return {"success": True, "removed": False, "finalized": True, "snapshotId": snapshot_id}
    db.execute("BEGIN IMMEDIATE")
    try:
        for table in ("media_incremental_snapshot_batches", "media_incremental_snapshot_baseline",
                      "media_incremental_snapshot_scopes", "media_incremental_snapshot_files"):
            db.execute(f"DELETE FROM {table} WHERE snapshot_id=?", (snapshot_id,))
        db.execute("DELETE FROM media_incremental_snapshots WHERE snapshot_id=?", (snapshot_id,))
        db.execute("DELETE FROM meta WHERE key LIKE ?", (f"media_sync:{snapshot_id}:%",))
        db.execute("DELETE FROM meta WHERE key=?", (f"media_sync_lease:{snapshot_id}",))
        db.commit()
        return {"success": True, "removed": True, "snapshotId": snapshot_id}
    except Exception:
        db.rollback()
        raise

def _legacy_media_sync_project(root: str, db, payload: dict):
    project = project_row(db, payload["projectName"])
    if "availability" in project.keys() and project["availability"] == "missing":
        return {"success": True, "count": 0, "thumbnailCandidates": [], "projectUnavailable": True}
    project_path = os.path.join(os.path.abspath(root), project["relative_path"])
    # Mark disappeared sources first so a same-content file discovered on a
    # different volume can retain its Photo ID instead of becoming a duplicate.
    mark_missing_project_versions(db, project["id"])
    db.commit()
    seen_paths = set()
    created_or_updated = 0
    scan_roots = [(project_path, "folder")]
    external_roots = payload.get("externalRoots") or []
    if not isinstance(external_roots, list) or len(external_roots) > 2048:
        raise ValueError("external_media_roots_invalid: 外链媒体根目录无效")
    for item in external_roots:
        if not isinstance(item, dict):
            raise ValueError("external_media_root_invalid: 外链媒体根目录无效")
        raw_candidate = str(item.get("path") or "").strip()
        candidate = canonical_path(raw_candidate) if raw_candidate else ""
        kind = str(item.get("kind") or "")
        if not candidate or not os.path.isabs(candidate) or kind not in ("folder", "file"):
            raise ValueError("external_media_root_invalid: 外链媒体根目录无效")
        if kind == "folder" and os.path.isdir(candidate) or kind == "file" and os.path.isfile(candidate):
            scan_roots.append((candidate, kind))
    deduplicated_roots = []
    root_keys = set()
    for candidate, kind in scan_roots:
        key = canonical_path(candidate).casefold()
        if key in root_keys:
            continue
        root_keys.add(key)
        deduplicated_roots.append((candidate, kind))

    def scan_file(file_path: str):
        nonlocal created_or_updated
        path_key = canonical_path(file_path).casefold()
        if path_key in seen_paths or not media_type(file_path):
            return
        pending_hashes = []
        try:
            if sync_media_file(db, project, file_path, pending_hashes):
                seen_paths.add(path_key)
                created_or_updated += 1
        except (FileNotFoundError, PermissionError, OSError):
            return
        db.commit()
        backfill_full_fingerprints(db, pending_hashes)

    for scan_root, scan_kind in deduplicated_roots:
        if scan_kind == "file":
            scan_file(scan_root)
            continue
        real_scan_root = os.path.realpath(scan_root)
        def inside_scan_root(candidate):
            try:
                return os.path.commonpath((os.path.realpath(candidate), real_scan_root)).casefold() == real_scan_root.casefold()
            except ValueError:
                return False
        for directory, directory_names, file_names in os.walk(scan_root):
            directory_names[:] = [name for name in directory_names if inside_scan_root(os.path.join(directory, name))]
            if not inside_scan_root(directory):
                continue
            for name in file_names:
                scan_file(os.path.join(directory, name))
    timestamp = int(time.time() * 1000)
    version_rows = db.execute(
        """SELECT versions.id, versions.file_path, versions.file_path_key FROM versions
           JOIN photos ON photos.id=versions.photo_id
           WHERE photos.project_id=? AND versions.is_deleted=0""", (project["id"],)
    ).fetchall()
    authorized_file_keys = {
        canonical_path(os.path.realpath(scan_root)).casefold()
        for scan_root, scan_kind in deduplicated_roots if scan_kind == "file"
    }
    authorized_folder_roots = [
        canonical_path(os.path.realpath(scan_root))
        for scan_root, scan_kind in deduplicated_roots if scan_kind == "folder"
    ]
    for row in version_rows:
        row_path = canonical_path(os.path.realpath(row["file_path"]))
        is_authorized = row_path.casefold() in authorized_file_keys \
            or any(is_project_descendant(row_path, scan_root) for scan_root in authorized_folder_roots)
        if row["file_path_key"] not in seen_paths and (
            not os.path.isfile(row["file_path"])
            or not is_authorized
        ):
            db.execute("UPDATE versions SET file_missing=1, updated_at=? WHERE id=?", (timestamp, row["id"]))
            db.execute("UPDATE file_records SET missing=1, updated_at=? WHERE owner_type='version' AND owner_id=?", (timestamp, row["id"]))
    db.commit()
    thumbnail_rows = db.execute(
        """SELECT versions.id AS version_id, versions.photo_id, versions.file_path, versions.thumbnail_path
           FROM versions JOIN photos ON photos.id=versions.photo_id
           WHERE photos.project_id=? AND versions.is_deleted=0 AND versions.file_missing=0""",
        (project["id"],),
    ).fetchall()
    thumbnail_candidates = [
        {"versionId": row["version_id"], "photoId": row["photo_id"], "filePath": row["file_path"]}
        for row in thumbnail_rows
        if not row["thumbnail_path"] or not os.path.isfile(row["thumbnail_path"])
    ]
    return {"success": True, "count": created_or_updated, "thumbnailCandidates": thumbnail_candidates}

def media_sync_project(root: str, db, payload: dict):
    prepared = media_sync_prepare(root, db, payload)
    if prepared.get("projectUnavailable"):
        return prepared
    count = 0
    batch_size = 64
    database = db.execute("PRAGMA database_list").fetchone()[2]
    monolithic = db.execute("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='versions'").fetchone() is not None
    for offset in range(0, len(prepared["files"]), batch_size):
        batch_index = offset // batch_size
        batch_payload = {
            "projectName": payload["projectName"],
            "snapshotId": prepared["snapshotId"],
            "batchIndex": batch_index,
            "authorizedRoots": prepared["authorizedRoots"],
            "files": prepared["files"][offset:offset + batch_size],
        }
        applied = media_sync_apply_batch(root, db, batch_payload) if monolithic else mutate(
            root, database, "media_sync_apply_batch", batch_payload,
            f"direct-media-sync:{prepared['snapshotId']}:batch:{batch_index}",
        )
        count += int(applied.get("count") or 0)
    finalize_payload = {
        "projectName": payload["projectName"],
        "snapshotId": prepared["snapshotId"],
        "authorizedRoots": prepared["authorizedRoots"],
        "files": prepared["files"],
        "baselineVersions": prepared["baselineVersions"],
    }
    finalized = media_sync_finalize(root, db, finalize_payload) if monolithic else mutate(
        root, database, "media_sync_finalize", finalize_payload,
        f"direct-media-sync:{prepared['snapshotId']}:finalize",
    )
    finalized["count"] = count
    return finalized

def media_get(root: str, db, payload: dict):
    project = project_row(db, payload["projectName"])
    file_path = canonical_path(payload["filePath"])
    mark_missing_project_versions(db, project["id"])
    db.commit()
    pending_hashes = []
    photo_id = sync_media_file(db, project, file_path, pending_hashes)
    db.commit()
    backfill_full_fingerprints(db, pending_hashes)
    if not photo_id:
        raise ValueError("该文件不是可追踪的图片或视频")
    return {"success": True, **media_bundle(db, photo_id)}

def media_get_photo(db, payload: dict):
    bundle = media_bundle(db, payload["photoId"])
    if not bundle["photo"]:
        raise ValueError("素材版本记录不存在")
    return {"success": True, **bundle}

def media_create_version(db, payload: dict):
    photo_id = payload["photoId"]
    source = db.execute("SELECT * FROM versions WHERE id=? AND photo_id=? AND is_deleted=0", (payload["parentVersionId"], photo_id)).fetchone()
    if source is None:
        raise ValueError("基础版本不存在")
    file_path = canonical_path(payload["filePath"])
    if not os.path.isfile(file_path):
        raise ValueError("新版本文件不存在或不可读取")
    stat = os.stat(file_path)
    identity = file_identity(file_path)
    fingerprint = quick_fingerprint(file_path, stat)
    authoritative_hash = full_fingerprint(file_path)
    timestamp = int(time.time() * 1000)
    next_number = db.execute("SELECT COALESCE(MAX(version_number), -1)+1 FROM versions WHERE photo_id=?", (photo_id,)).fetchone()[0]
    version_id = payload.get("versionId") or str(uuid.uuid4())
    db.execute("UPDATE versions SET is_current=0, updated_at=? WHERE photo_id=?", (timestamp, photo_id))
    if payload.get("isFinal"):
        db.execute("UPDATE versions SET is_final=0, updated_at=? WHERE photo_id=?", (timestamp, photo_id))
    db.execute(
        """INSERT INTO versions(id,photo_id,parent_version_id,version_number,version_name,version_type,file_path,
           file_path_key,file_id,file_fingerprint,file_size,file_modified_at,author,note,status,is_current,is_final,
           created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (version_id, photo_id, source["id"], next_number, payload.get("versionName") or f"版本 {next_number}",
         payload.get("versionType") or "custom", file_path, file_path.casefold(), identity, fingerprint, stat.st_size,
         int(stat.st_mtime_ns / 1_000_000), payload.get("author") or os.environ.get("USERNAME") or "本机用户",
         payload.get("note") or "", payload.get("status") or "draft", 1, int(bool(payload.get("isFinal"))), timestamp, timestamp),
    )
    db.execute("UPDATE photos SET current_version_id=?, updated_at=? WHERE id=?", (version_id, timestamp, photo_id))
    upsert_file_record(db, version_id, file_path, stat, identity, fingerprint, authoritative_hash)
    db.commit()
    return {"success": True, **media_bundle(db, photo_id)}

def media_update_version(db, payload: dict):
    row = db.execute("SELECT * FROM versions WHERE id=? AND is_deleted=0", (payload["versionId"],)).fetchone()
    if row is None:
        raise ValueError("版本不存在")
    timestamp = int(time.time() * 1000)
    fields, values = [], []
    if "versionName" in payload:
        name = str(payload["versionName"]).strip()
        if not name:
            raise ValueError("版本名称不能为空")
        fields.append("version_name=?")
        values.append(name)
    if "note" in payload:
        fields.append("note=?")
        values.append(str(payload["note"]))
    if "isFinal" in payload:
        if payload["isFinal"]:
            db.execute("UPDATE versions SET is_final=0 WHERE photo_id=?", (row["photo_id"],))
        fields.append("is_final=?")
        values.append(int(bool(payload["isFinal"])))
    if payload.get("makeCurrent"):
        db.execute("UPDATE versions SET is_current=0 WHERE photo_id=?", (row["photo_id"],))
        fields.append("is_current=1")
        db.execute("UPDATE photos SET current_version_id=?, updated_at=? WHERE id=?", (row["id"], timestamp, row["photo_id"]))
    fields.append("updated_at=?")
    values.append(timestamp)
    values.append(row["id"])
    db.execute(f"UPDATE versions SET {', '.join(fields)} WHERE id=?", values)
    db.commit()
    return {"success": True, **media_bundle(db, row["photo_id"])}

def _component_version_row(db, payload: dict):
    allowed = {"projectId", "projectPath", "scopePath", "versionId", "expectedUpdatedAt", "versionName", "note", "status", "isFinal", "makeCurrent"}
    if not isinstance(payload, dict) or set(payload) - allowed:
        raise ValueError("component_version_payload_invalid")
    project_id = str(payload.get("projectId") or "").strip()
    project_path = canonical_path(str(payload.get("projectPath") or ""))
    scope_path = canonical_path(str(payload.get("scopePath") or ""))
    project_key = project_path.casefold(); scope_key = scope_path.casefold()
    if not project_id or not project_path or not scope_path or not (scope_key == project_key or scope_key.startswith(project_key + os.sep.casefold())):
        raise ValueError("component_version_scope_invalid")
    row = db.execute(
        """SELECT version.*,photo.project_id FROM versions AS version
             JOIN photos AS photo ON photo.id=version.photo_id
            WHERE version.id=? AND version.is_deleted=0 AND photo.is_deleted=0 AND photo.project_id=?""",
        (str(payload.get("versionId") or ""), project_id),
    ).fetchone()
    if row is None:
        raise ValueError("component_version_not_found")
    file_key = canonical_path(row["file_path"]).casefold()
    if not (file_key == scope_key or file_key.startswith(scope_key + os.sep.casefold())):
        raise ValueError("component_version_scope_invalid")
    expected = payload.get("expectedUpdatedAt")
    if not isinstance(expected, (int, float)) or isinstance(expected, bool) or not float(expected).is_integer() or int(expected) != int(row["updated_at"]):
        raise ValueError("component_version_stale")
    return row

def media_component_update_version(db, payload: dict):
    row = _component_version_row(db, payload)
    changed = [field for field in ("versionName", "note", "status", "isFinal", "makeCurrent") if field in payload]
    if not changed:
        raise ValueError("component_version_update_empty")
    fields, values = [], []
    if "versionName" in payload:
        name = str(payload["versionName"]).strip()
        if not name or len(name) > 160:
            raise ValueError("component_version_name_invalid")
        fields.append("version_name=?"); values.append(name)
    if "note" in payload:
        note = str(payload["note"])
        if len(note) > 2000:
            raise ValueError("component_version_note_invalid")
        fields.append("note=?"); values.append(note)
    if "status" in payload:
        status = str(payload["status"]).strip()
        if not status or len(status) > 80 or any(ord(char) < 32 for char in status):
            raise ValueError("component_version_status_invalid")
        fields.append("status=?"); values.append(status)
    timestamp = max(int(time.time() * 1000), int(row["updated_at"]) + 1)
    with db:
        current = db.execute("SELECT updated_at FROM versions WHERE id=? AND is_deleted=0", (row["id"],)).fetchone()
        if current is None or int(current["updated_at"]) != int(row["updated_at"]):
            raise ValueError("component_version_stale")
        if "isFinal" in payload:
            if not isinstance(payload["isFinal"], bool): raise ValueError("component_version_final_invalid")
            if payload["isFinal"]: db.execute("UPDATE versions SET is_final=0,updated_at=? WHERE photo_id=? AND id!=?", (timestamp, row["photo_id"], row["id"]))
            fields.append("is_final=?"); values.append(int(payload["isFinal"]))
        if "makeCurrent" in payload:
            if not isinstance(payload["makeCurrent"], bool) or not payload["makeCurrent"]: raise ValueError("component_version_current_invalid")
            db.execute("UPDATE versions SET is_current=0,updated_at=? WHERE photo_id=? AND id!=?", (timestamp, row["photo_id"], row["id"]))
            db.execute("UPDATE photos SET current_version_id=?,updated_at=? WHERE id=?", (row["id"], timestamp, row["photo_id"]))
            fields.append("is_current=1")
        fields.append("updated_at=?"); values.append(timestamp); values.extend((row["id"], row["updated_at"]))
        updated = db.execute(f"UPDATE versions SET {', '.join(fields)} WHERE id=? AND updated_at=? AND is_deleted=0", values)
        if updated.rowcount != 1: raise ValueError("component_version_stale")
    result = db.execute("SELECT * FROM versions WHERE id=?", (row["id"],)).fetchone()
    return {"success": True, "version": {key: value for key, value in serialize_version(result).items() if key not in ("filePath", "thumbnailPath")}}

def media_component_delete_version(db, payload: dict):
    if set(payload or {}) - {"projectId", "projectPath", "scopePath", "versionId", "expectedUpdatedAt"}:
        raise ValueError("component_version_payload_invalid")
    row = _component_version_row(db, payload)
    if int(row["version_number"]) == 0: raise ValueError("component_version_original_protected")
    with db:
        current = db.execute("SELECT updated_at FROM versions WHERE id=? AND is_deleted=0", (row["id"],)).fetchone()
        if current is None or int(current["updated_at"]) != int(row["updated_at"]): raise ValueError("component_version_stale")
        cleanup = delete_version_rows(db, [row])
    return {"success": True, "versionId": row["id"], "photoId": row["photo_id"], **cleanup}

def media_refresh_metadata_fingerprint(db, payload: dict):
    """Accept an in-app metadata-only write without flagging a visual version change."""
    file_path = canonical_path(payload["filePath"])
    if not os.path.isfile(file_path):
        return {"success": True, "updatedCount": 0}
    rows = db.execute(
        """SELECT id,photo_id,version_number FROM versions
           WHERE file_path_key=? AND is_deleted=0""",
        (file_path.casefold(),),
    ).fetchall()
    if not rows:
        return {"success": True, "updatedCount": 0}
    stat = os.stat(file_path)
    identity = file_identity(file_path)
    fingerprint = quick_fingerprint(file_path, stat)
    authoritative_hash = full_fingerprint(file_path)
    modified_at = int(stat.st_mtime_ns / 1_000_000)
    timestamp = int(time.time() * 1000)
    for row in rows:
        db.execute(
            """UPDATE versions SET file_id=?,file_fingerprint=?,file_size=?,file_modified_at=?,
               file_missing=0,updated_at=? WHERE id=?""",
            (identity, fingerprint, stat.st_size, modified_at, timestamp, row["id"]),
        )
        if row["version_number"] == 0:
            db.execute(
                """UPDATE photos SET original_file_path=?,original_file_id=?,original_fingerprint=?,updated_at=?
                   WHERE id=?""",
                (file_path, identity, fingerprint, timestamp, row["photo_id"]),
            )
        upsert_file_record(db, row["id"], file_path, stat, identity, fingerprint, authoritative_hash)
    db.commit()
    return {"success": True, "updatedCount": len(rows)}

def final_version_list(db, payload: dict):
    project = project_row(db, payload["projectName"])
    rows = db.execute(
        """SELECT versions.*,photos.display_name AS photo_display_name
             FROM versions JOIN photos ON photos.id=versions.photo_id
            WHERE photos.project_id=? AND photos.media_type='image'
              AND versions.is_deleted=0 AND versions.is_final=1
            ORDER BY photos.display_name COLLATE NOCASE,versions.version_number""",
        (project["id"],),
    ).fetchall()
    items = []
    for row in rows:
        exists = os.path.isfile(row["file_path"])
        items.append({
            "id": row["id"],
            "photoId": row["photo_id"],
            "displayName": row["photo_display_name"],
            "versionNumber": row["version_number"],
            "versionName": row["version_name"],
            "filePath": row["file_path"],
            "fileName": os.path.basename(row["file_path"]),
            "fileMissing": not exists,
        })
    available_count = sum(1 for item in items if not item["fileMissing"])
    return {
        "success": True,
        "count": len(items),
        "availableCount": available_count,
        "missingCount": len(items) - available_count,
        "versions": items,
    }

def media_set_thumbnail(db, payload: dict):
    version = db.execute(
        "SELECT photo_id FROM versions WHERE id=? AND is_deleted=0", (payload["versionId"],)
    ).fetchone()
    if version is None:
        raise ValueError("版本不存在")
    thumbnail_path = canonical_path(payload["thumbnailPath"])
    db.execute(
        "UPDATE versions SET thumbnail_path=?, updated_at=? WHERE id=?",
        (thumbnail_path, int(time.time() * 1000), payload["versionId"]),
    )
    db.commit()
    return {"success": True, "thumbnailPath": thumbnail_path}

def media_relocate_version(db, payload: dict):
    row = db.execute("SELECT * FROM versions WHERE id=? AND is_deleted=0", (payload["versionId"],)).fetchone()
    if row is None:
        raise ValueError("版本不存在")
    file_path = canonical_path(payload["filePath"])
    if not os.path.isfile(file_path) or not media_type(file_path):
        raise ValueError("所选文件不是可读取的图片或视频")
    stat = os.stat(file_path)
    identity = file_identity(file_path)
    fingerprint = quick_fingerprint(file_path, stat)
    source_full_hash = full_fingerprint(file_path)
    stored_record = db.execute(
        "SELECT full_hash FROM file_records WHERE owner_type='version' AND owner_id=?",
        (row["id"],),
    ).fetchone()
    stored_full_hash = stored_record["full_hash"] if stored_record is not None else None
    fingerprint_matches = bool(
        row["file_fingerprint"] and row["file_fingerprint"] == fingerprint
        and stored_full_hash and stored_full_hash == source_full_hash
    )
    if not fingerprint_matches and not payload.get("force"):
        return {"success": False, "fingerprintMismatch": True, "error": "所选文件与原版本的内容指纹不一致"}
    duplicate = db.execute(
        """SELECT id FROM versions WHERE id<>? AND is_deleted=0
           AND (file_path_key=? OR (? IS NOT NULL AND file_id=?)) LIMIT 1""",
        (row["id"], file_path.casefold(), identity, identity),
    ).fetchone()
    if duplicate:
        raise ValueError("所选文件已经属于另一个版本")
    timestamp = int(time.time() * 1000)
    db.execute(
        """UPDATE versions SET file_path=?, file_path_key=?, file_id=?, file_fingerprint=?, file_size=?,
           file_modified_at=?, thumbnail_path=NULL, file_missing=0,
           content_changed=?, updated_at=? WHERE id=?""",
        (file_path, file_path.casefold(), identity, fingerprint, stat.st_size,
         int(stat.st_mtime_ns / 1_000_000), int(bool(row["content_changed"] or not fingerprint_matches)),
         timestamp, row["id"]),
    )
    if row["version_number"] == 0:
        db.execute(
            """UPDATE photos SET original_file_path=?, original_file_id=?, original_fingerprint=?,
               updated_at=? WHERE id=?""",
            (file_path, identity, fingerprint, timestamp, row["photo_id"]),
        )
    upsert_file_record(db, row["id"], file_path, stat, identity, fingerprint, source_full_hash)
    db.commit()
    return {"success": True, **media_bundle(db, row["photo_id"])}

def delete_version_rows(db, rows) -> dict:
    timestamp = int(time.time() * 1000)
    version_ids = [row["id"] for row in rows]
    if not version_ids:
        return {"deletedVersions": [], "sourcePaths": []}
    placeholders = ",".join("?" for _ in version_ids)
    reparented_count = 0
    for row in rows:
        cursor = db.execute(
            """UPDATE versions SET parent_version_id=?,updated_at=?
               WHERE parent_version_id=? AND is_deleted=0""",
            (row["parent_version_id"], timestamp, row["id"]),
        )
        reparented_count += cursor.rowcount
    compatibility_cleanup = {}
    for report in run_compatibility_hooks("delete_versions", db, version_ids, timestamp):
        compatibility_cleanup.update(report or {})
    db.execute(
        f"UPDATE versions SET is_deleted=1,is_current=0,is_final=0,updated_at=? WHERE id IN ({placeholders})",
        (timestamp, *version_ids),
    )
    db.execute(
        f"DELETE FROM file_records WHERE owner_type='version' AND owner_id IN ({placeholders})",
        version_ids,
    )
    for photo_id in dict.fromkeys(row["photo_id"] for row in rows if row["is_current"]):
        replacement = db.execute(
            "SELECT id FROM versions WHERE photo_id=? AND is_deleted=0 ORDER BY version_number DESC LIMIT 1",
            (photo_id,),
        ).fetchone()
        replacement_id = replacement["id"] if replacement else None
        if replacement_id:
            db.execute("UPDATE versions SET is_current=1 WHERE id=?", (replacement_id,))
        db.execute(
            "UPDATE photos SET current_version_id=?,updated_at=? WHERE id=?",
            (replacement_id, timestamp, photo_id),
        )
    return {
        "deletedVersions": [{
            "id": row["id"], "photoId": row["photo_id"], "filePath": row["file_path"],
            "thumbnailPath": row["thumbnail_path"], "versionNumber": row["version_number"],
        } for row in rows],
        **compatibility_cleanup,
        "sourcePaths": list(dict.fromkeys(row["file_path"] for row in rows if row["file_path"])),
        "reparentedCount": reparented_count,
    }

def media_version_delete_scope(db, payload: dict):
    row = db.execute(
        """SELECT versions.*,photos.project_id FROM versions
           JOIN photos ON photos.id=versions.photo_id
           WHERE versions.id=? AND versions.is_deleted=0""",
        (payload["versionId"],),
    ).fetchone()
    if row is None:
        raise ValueError("版本不存在")
    rows = db.execute(
        """SELECT versions.id,versions.file_missing FROM versions
           JOIN photos ON photos.id=versions.photo_id
           WHERE photos.project_id=? AND versions.version_number=? AND versions.is_deleted=0""",
        (row["project_id"], row["version_number"]),
    ).fetchall()
    version_ids = [item["id"] for item in rows]
    child_count = 0
    if version_ids:
        placeholders = ",".join("?" for _ in version_ids)
        child_count = db.execute(
            f"SELECT COUNT(*) AS count FROM versions WHERE parent_version_id IN ({placeholders}) AND is_deleted=0",
            version_ids,
        ).fetchone()["count"]
    selected_child_count = db.execute(
        "SELECT COUNT(*) AS count FROM versions WHERE parent_version_id=? AND is_deleted=0",
        (row["id"],),
    ).fetchone()["count"]
    missing_count = sum(int(item["file_missing"]) for item in rows)
    return {
        "success": True,
        "versionNumber": row["version_number"],
        "versionCount": len(rows),
        "missingCount": missing_count,
        "allMissing": bool(rows) and missing_count == len(rows),
        "childCount": int(child_count),
        "selectedChildCount": int(selected_child_count),
    }

def media_delete_version(db, payload: dict):
    row = db.execute("SELECT * FROM versions WHERE id=? AND is_deleted=0", (payload["versionId"],)).fetchone()
    if row is None:
        raise ValueError("版本不存在")
    if row["version_number"] == 0:
        raise ValueError("原片版本 V0 受保护，不能删除")
    cleanup = delete_version_rows(db, [row])
    db.commit()
    return {"success": True, **media_bundle(db, row["photo_id"]), **cleanup}

def media_delete_project_missing_version(db, payload: dict):
    selected = db.execute(
        """SELECT versions.*,photos.project_id FROM versions
           JOIN photos ON photos.id=versions.photo_id
           WHERE versions.id=? AND versions.is_deleted=0""",
        (payload["versionId"],),
    ).fetchone()
    if selected is None:
        raise ValueError("版本不存在")
    if selected["version_number"] == 0:
        raise ValueError("原片版本 V0 受保护，不能删除")
    rows = db.execute(
        """SELECT versions.* FROM versions JOIN photos ON photos.id=versions.photo_id
           WHERE photos.project_id=? AND versions.version_number=? AND versions.is_deleted=0""",
        (selected["project_id"], selected["version_number"]),
    ).fetchall()
    if not rows or any(not row["file_missing"] for row in rows):
        raise ValueError("该版本仍有文件存在，不能批量删除")
    cleanup = delete_version_rows(db, rows)
    db.commit()
    return {"success": True, "deletedCount": len(rows), "versionNumber": selected["version_number"], **cleanup}

def media_record_compare(db, payload: dict):
    timestamp = int(time.time() * 1000)
    db.execute(
        "INSERT INTO version_compare_history(id,photo_id,left_version_id,right_version_id,compare_mode,created_at) VALUES(?,?,?,?,?,?)",
        (str(uuid.uuid4()), payload["photoId"], payload["leftVersionId"], payload["rightVersionId"], payload.get("compareMode") or "side-by-side", timestamp),
    )
    db.commit()
    return {"success": True}

MEDIA_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

MEDIA_RECEIPT_RECENT_MS = 7 * 24 * 60 * 60 * 1000

SYNC_COMPLETION_SOFT_LIMIT = 128

def _prune_legacy_sync_completions(db, now: int | None = None) -> int:
    now = int(now or time.time() * 1000)
    suffix = ":completed-at"
    rows = []
    for row in db.execute("SELECT key,value FROM meta WHERE key LIKE 'media_sync:%:completed-at'").fetchall():
        key = str(row[0])
        try:
            completed_at = int(row[1])
        except (TypeError, ValueError):
            continue
        snapshot_id = key[len("media_sync:"):-len(suffix)]
        if re.fullmatch(r"[0-9a-fA-F-]{36}", snapshot_id):
            rows.append((snapshot_id, completed_at))
    rows.sort(key=lambda item: (item[1], item[0]), reverse=True)
    removed = 0
    for index, (snapshot_id, completed_at) in enumerate(rows):
        expired = now - completed_at > MEDIA_RECEIPT_RETENTION_MS
        beyond_limit = index >= SYNC_COMPLETION_SOFT_LIMIT and now - completed_at > MEDIA_RECEIPT_RECENT_MS
        if expired or beyond_limit:
            removed += db.execute("DELETE FROM meta WHERE key LIKE ?", (f"media_sync:{snapshot_id}:%",)).rowcount
    return removed

def _prune_incremental_sync_completions(db, now: int | None = None) -> int:
    now = int(now or time.time() * 1000)
    rows = db.execute(
        """SELECT snapshot_id,finalized_at FROM media_incremental_snapshots
           WHERE state='finalized' AND finalized_at IS NOT NULL
           ORDER BY finalized_at DESC,snapshot_id DESC"""
    ).fetchall()
    removed = 0
    for index, row in enumerate(rows):
        completed_at = int(row["finalized_at"] or 0)
        expired = completed_at > 0 and now - completed_at > MEDIA_RECEIPT_RETENTION_MS
        beyond_limit = index >= SYNC_COMPLETION_SOFT_LIMIT and completed_at > 0 and now - completed_at > MEDIA_RECEIPT_RECENT_MS
        if expired or beyond_limit:
            removed += db.execute("DELETE FROM media_incremental_snapshots WHERE snapshot_id=?", (row["snapshot_id"],)).rowcount
    return removed

def _media_operation_digest(action: str, payload: dict) -> str:
    encoded = json.dumps({"action": action, "payload": payload}, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()

ROOT_ACTIONS = frozenset((
    "media_sync_prepare", "media_sync_apply_batch", "media_sync_finalize",
    "media_sync_paths_prepare", "media_sync_paths_apply_batch", "media_sync_paths_finalize",
    "media_sync_abort",
    "media_get",
))

ACTION_HANDLERS = {
    "media_sync_prepare": media_sync_prepare,
    "media_sync_apply_batch": media_sync_apply_batch,
    "media_sync_finalize": media_sync_finalize,
    "media_sync_paths_prepare": media_sync_paths_prepare,
    "media_sync_paths_apply_batch": media_sync_paths_apply_batch,
    "media_sync_paths_finalize": media_sync_paths_finalize,
    "media_sync_abort": media_sync_abort,
    "media_get": media_get,
    "media_get_photo": media_get_photo,
    "media_versions_snapshot": media_versions_snapshot,
    "media_create_version": media_create_version,
    "media_update_version": media_update_version,
    "media_component_update_version": media_component_update_version,
    "media_component_delete_version": media_component_delete_version,
    "media_refresh_metadata_fingerprint": media_refresh_metadata_fingerprint,
    "final_version_list": final_version_list,
    "media_set_thumbnail": media_set_thumbnail,
    "media_relocate_version": media_relocate_version,
    "media_delete_version": media_delete_version,
    "media_version_delete_scope": media_version_delete_scope,
    "media_delete_project_missing_version": media_delete_project_missing_version,
    "media_record_compare": media_record_compare,
}
ACTION_NAMES = frozenset(ACTION_HANDLERS)
CLOSE_ON_ERROR_ACTIONS = frozenset((
    "media_sync_apply_batch", "media_sync_finalize",
    "media_sync_paths_apply_batch", "media_sync_paths_finalize", "media_get",
    "media_create_version", "media_update_version", "media_component_update_version",
    "media_component_delete_version", "media_refresh_metadata_fingerprint",
    "media_set_thumbnail", "media_relocate_version", "media_delete_version",
    "media_delete_project_missing_version", "media_record_compare",
))


def dispatch_action(action: str, root: str, db, payload: dict):
    handler = ACTION_HANDLERS.get(action)
    if handler is None:
        raise ValueError(f"unknown media domain action: {action}")
    if action in ROOT_ACTIONS:
        return handler(root, db, payload)
    return handler(db, payload)
