"""SQLite-backed workspace catalog stored outside the user's project folders."""

from __future__ import annotations

import argparse
import base64
import gc
import hashlib
import json
import math
import os
import re
import shutil
import sqlite3
import sys
import time
import uuid
from pathlib import Path

try:
    from compatibility.registry import action_names as compatibility_action_names
    from compatibility.registry import dispatch_action as dispatch_compatibility_action
    from compatibility.registry import integrated_action_names, resolve_export as resolve_compatibility_export, run_hooks as run_compatibility_hooks
    from database_error_codes import error_response
    from workspace_db_domains import ALL_ACTIONS, MEDIA_ACTIONS, PROGRESS_ACTIONS, READ_ONLY_ACTIONS, TRACKING_ACTIONS, VERSIONING_ONLY_ACTIONS
    from workspace_db_support import meta_value as _meta_value, set_meta as _set_meta
    from workspace_media_actions import (
        ACTION_NAMES as MEDIA_DOMAIN_ACTIONS, CLOSE_ON_ERROR_ACTIONS as MEDIA_CLOSE_ON_ERROR_ACTIONS,
        dispatch_action as dispatch_media_action,
        MEDIA_INCREMENTAL_INCOMPLETE_RETENTION_MS, MEDIA_INCREMENTAL_INCOMPLETE_SOFT_LIMIT,
        MEDIA_RECEIPT_RECENT_MS, MEDIA_RECEIPT_RETENTION_MS, SYNC_COMPLETION_SOFT_LIMIT,
        MediaSyncBatchMismatch,
        _assert_incremental_snapshot_capacity, _cleanup_incremental_snapshots,
        _component_version_row,
        _incremental_snapshot_row, _media_operation_digest, _media_sync_marker,
        _prune_incremental_sync_completions, _prune_legacy_sync_completions,
        backfill_full_fingerprints as _media_backfill_full_fingerprints,
        canonical_path, delete_version_rows, directory_identity,
        file_identity, full_fingerprint, is_project_descendant, media_bundle, media_type,
        normalize_external_link_relative_path, project_row, queue_full_fingerprint,
        quick_fingerprint, serialize_version, sync_media_file, upsert_file_record,
        final_version_list, media_component_delete_version, media_component_update_version,
        media_create_version, media_delete_project_missing_version, media_delete_version,
        media_get, media_get_photo, media_record_compare, media_refresh_metadata_fingerprint,
        media_relocate_version, media_set_thumbnail, media_sync_apply_batch,
        media_sync_abort, media_sync_finalize, media_sync_paths_apply_batch, media_sync_paths_finalize,
        media_sync_paths_prepare, media_sync_prepare, media_sync_project, media_update_version,
        media_version_delete_scope, media_versions_snapshot,
    )
    from workspace_domain_storage import DOMAIN_TABLES, attach_and_migrate as attach_workspace_domain_storage, database_path_for_workspace_database
    from workspace_db_migrations import (
        MIGRATION_OWNERS, migration_26, migration_27, migration_28, migration_29,
        migration_30, migration_31, migration_32, migration_33, migration_34,
    )
except ModuleNotFoundError:
    # Some regression tests load this file directly through importlib instead
    # of importing it from the Python source directory.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from compatibility.registry import action_names as compatibility_action_names
    from compatibility.registry import dispatch_action as dispatch_compatibility_action
    from compatibility.registry import integrated_action_names, resolve_export as resolve_compatibility_export, run_hooks as run_compatibility_hooks
    from database_error_codes import error_response
    from workspace_db_domains import ALL_ACTIONS, MEDIA_ACTIONS, PROGRESS_ACTIONS, READ_ONLY_ACTIONS, TRACKING_ACTIONS, VERSIONING_ONLY_ACTIONS
    from workspace_db_support import meta_value as _meta_value, set_meta as _set_meta
    from workspace_media_actions import (
        ACTION_NAMES as MEDIA_DOMAIN_ACTIONS, CLOSE_ON_ERROR_ACTIONS as MEDIA_CLOSE_ON_ERROR_ACTIONS,
        dispatch_action as dispatch_media_action,
        MEDIA_INCREMENTAL_INCOMPLETE_RETENTION_MS, MEDIA_INCREMENTAL_INCOMPLETE_SOFT_LIMIT,
        MEDIA_RECEIPT_RECENT_MS, MEDIA_RECEIPT_RETENTION_MS, SYNC_COMPLETION_SOFT_LIMIT,
        MediaSyncBatchMismatch,
        _assert_incremental_snapshot_capacity, _cleanup_incremental_snapshots,
        _component_version_row,
        _incremental_snapshot_row, _media_operation_digest, _media_sync_marker,
        _prune_incremental_sync_completions, _prune_legacy_sync_completions,
        backfill_full_fingerprints as _media_backfill_full_fingerprints,
        canonical_path, delete_version_rows, directory_identity,
        file_identity, full_fingerprint, is_project_descendant, media_bundle, media_type,
        normalize_external_link_relative_path, project_row, queue_full_fingerprint,
        quick_fingerprint, serialize_version, sync_media_file, upsert_file_record,
        final_version_list, media_component_delete_version, media_component_update_version,
        media_create_version, media_delete_project_missing_version, media_delete_version,
        media_get, media_get_photo, media_record_compare, media_refresh_metadata_fingerprint,
        media_relocate_version, media_set_thumbnail, media_sync_apply_batch,
        media_sync_abort, media_sync_finalize, media_sync_paths_apply_batch, media_sync_paths_finalize,
        media_sync_paths_prepare, media_sync_prepare, media_sync_project, media_update_version,
        media_version_delete_scope, media_versions_snapshot,
    )
    from workspace_domain_storage import DOMAIN_TABLES, attach_and_migrate as attach_workspace_domain_storage, database_path_for_workspace_database
    from workspace_db_migrations import (
        MIGRATION_OWNERS, migration_26, migration_27, migration_28, migration_29,
        migration_30, migration_31, migration_32, migration_33, migration_34,
    )


class UndoRecordRetiredError(RuntimeError):
    code = "UNDO_RECORD_RETIRED"


def backfill_full_fingerprints(db, requests: list[dict]):
    """Compatibility adapter preserving the core fingerprint injection seam."""
    return _media_backfill_full_fingerprints(db, requests, full_fingerprint)


STATUSES = ("未分类", "策划中", "待拍摄", "后期中", "已归档")
SQLITE_BUSY_TIMEOUT_MS = 15_000
LEGACY_PROGRESS_MIGRATION_KEY = "legacy_progress_folders_migrated"
LEGACY_MEDIA_WORKFLOW_MIGRATION_KEY = "legacy_media_workflow_graph_migrated_v1"
LEGACY_SELECTION_INDEPENDENT_KEY_PREFIX = "legacy_selection_independent:"
SELECTION_MAINLINE_REPAIR_REVISION = "1"
VERSION_TREE_DEFAULT_LAYOUT_REVISION = "2"
PROGRESS_PURPOSE_CONSTRAINT_REVISION = "1"
TRANSCODE_GRAPH_SCHEMA_REVISION = "1"
LEGACY_PROGRESS_PARENT_REPAIR_REVISION = "1"
TARGET_SCHEMA_VERSION = 34
PROGRESS_NODE_ROLES = ("original", "progress", "selection", "artifact", "workflow", "broll")
PROGRESS_RELATION_KINDS = ("main", "auxiliary")
OPAQUE_ARTIFACT_KIND = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
VERSION_GRAPH_EDGE_KINDS = ("media_companion", "derived_preview", "derived_transcode", "workflow_input")
IMPORT_ARTIFACT_SLOTS = ("raw", "camera_jpg", "generated_jpg", "mov", "video_transcode")
IMPORT_ARTIFACT_SLOT_SHAPES = {
    "raw": ("image", "original", None),
    "camera_jpg": ("image", "original", "companion"),
    "generated_jpg": ("image", "artifact", "preview"),
    "mov": ("video", "original", None),
    "video_transcode": ("video", "artifact", "transcode"),
}
PROGRESS_TRACKING_STATES = (
    "disabled", "pending_compare", "pending_confirm", "committing", "ready", "stale", "needs_repair",
)
PROGRESS_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
TRACKING_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000
INTEGRITY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
MIGRATION_BACKUP_LIMIT = 5
AUTOMATIC_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000
AUTOMATIC_BACKUP_LIMIT = 7
MIGRATION_JOURNAL_SUFFIX = ".migration-journal-v1.json"
_CONNECT_ATTEMPTS = []


class DatabaseWriteRequired(RuntimeError):
    code = "DATABASE_WRITE_REQUIRED"


COORDINATED_READ_ONLY_ACTIONS = frozenset((
    "media_version_delete_scope", "progress_snapshot", "progress_stale_prepare", "version_tree_layout_get",
))


def __getattr__(name):
    run_compatibility_hooks("bind_core", globals())
    return resolve_compatibility_export(name)


def valid_project_status(value) -> bool:
    return (
        isinstance(value, str)
        and value == value.strip()
        and 0 < len(value) <= 24
        and all(ord(character) >= 32 and ord(character) != 127 for character in value)
    )


def is_internal_workspace_directory(value: str) -> bool:
    name = str(value or "").replace("\\", "/").rstrip("/").rsplit("/", 1)[-1].casefold()
    return name == "_photoflow_safety_temp" or name.startswith(".photoflow-")


def _table_columns(db, table: str) -> set[str]:
    return {row[1] for row in db.execute(f"PRAGMA table_info({table})").fetchall()}


def _table_schema(db, table: str, preferred: str | None = None) -> str | None:
    schemas = [str(row[1]) for row in db.execute("PRAGMA database_list").fetchall()]
    ordered = list(dict.fromkeys(([preferred] if preferred in schemas else []) + schemas))
    for schema in ordered:
        quoted = schema.replace('"', '""')
        if db.execute(f'SELECT 1 FROM "{quoted}".sqlite_master WHERE type=\'table\' AND name=?', (table,)).fetchone():
            return schema
    return None


def _table_exists(db, table: str, schema: str | None = None) -> bool:
    return _table_schema(db, table, schema) is not None


def _qualified_table(db, table: str, preferred: str | None = None) -> str:
    schema = _table_schema(db, table, preferred)
    if schema is None:
        raise RuntimeError(f"required table is not attached: {table}")
    quoted = schema.replace('"', '""')
    return f'"{quoted}"."{table}"'


def _fsync_directory(directory: str) -> None:
    try:
        descriptor = os.open(directory, os.O_RDONLY)
    except OSError as error:
        if getattr(error, "winerror", None) in (5, 50) or error.errno in (13, 22):
            return
        raise
    try:
        os.fsync(descriptor)
    except OSError as error:
        if getattr(error, "winerror", None) not in (5, 50) and error.errno not in (13, 22):
            raise
    finally:
        os.close(descriptor)


def _durable_json_write(path: str, payload: dict) -> None:
    temporary = f"{path}.{uuid.uuid4().hex}.tmp"
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb", closefd=True) as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        _fsync_directory(os.path.dirname(path))
    finally:
        try: os.remove(temporary)
        except FileNotFoundError: pass


def _migration_journal_path(database: str) -> str:
    return os.path.abspath(database) + MIGRATION_JOURNAL_SUFFIX


def _restore_migration_preimage(database: str, journal: dict) -> None:
    preimage = os.path.abspath(str(journal.get("preimage") or ""))
    if not preimage or not os.path.isfile(preimage):
        raise RuntimeError("数据库迁移恢复缺少 preimage")
    source = sqlite3.connect(f"{Path(preimage).resolve().as_uri()}?mode=ro", uri=True, timeout=30)
    target = sqlite3.connect(os.path.abspath(database), timeout=30)
    try:
        target.execute("PRAGMA synchronous=FULL")
        if source.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise RuntimeError("数据库迁移 preimage 已损坏")
        schema = source.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        if (int(schema[0]) if schema else 0) != int(journal.get("schemaVersion") or 0):
            raise RuntimeError("数据库迁移 preimage 版本与 journal 不匹配")
        source.backup(target)
        target.commit()
        if target.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise RuntimeError("数据库迁移 preimage 恢复验证失败")
    finally:
        target.close()
        source.close()


def _recover_interrupted_migration(database: str) -> None:
    journal_path = _migration_journal_path(database)
    if not os.path.isfile(journal_path):
        return
    try:
        with open(journal_path, "r", encoding="utf-8") as stream:
            journal = json.load(stream)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise RuntimeError("数据库迁移 journal 无法读取，拒绝开放业务连接") from error
    if os.path.abspath(str(journal.get("database") or "")) != os.path.abspath(database):
        raise RuntimeError("数据库迁移 journal 目标不匹配")
    _restore_migration_preimage(database, journal)
    os.remove(journal_path)
    _fsync_directory(os.path.dirname(journal_path))


def _complete_migration_journal(database: str) -> None:
    journal_path = _migration_journal_path(database)
    try:
        os.remove(journal_path)
    except FileNotFoundError:
        return
    _fsync_directory(os.path.dirname(journal_path))


def _database_needs_initialization(database: str) -> bool:
    if not os.path.isfile(database) or os.path.getsize(database) == 0:
        return True
    try:
        probe = sqlite3.connect(f"{Path(database).resolve().as_uri()}?mode=ro", uri=True, timeout=5)
        try:
            return probe.execute("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").fetchone() is None
        finally:
            probe.close()
    except sqlite3.Error:
        return False


def _initialize_database_staged(root: str, database: str) -> None:
    staged = f"{database}.initialize-{uuid.uuid4().hex}.tmp"
    connection = None
    try:
        connection = connect(root, staged, include_domains=False, include_compatibility=False, _staging_init=True)
        _check_integrity(connection, force=True)
        checkpoint = connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        if checkpoint and checkpoint[0]:
            raise RuntimeError(f"首次初始化 staging checkpoint 失败：{tuple(checkpoint)}")
        if str(connection.execute("PRAGMA journal_mode=DELETE").fetchone()[0]).casefold() != "delete":
            raise RuntimeError("首次初始化 staging 无法退出 WAL")
        connection.close()
        connection = None
        os.replace(staged, database)
        _fsync_directory(os.path.dirname(database))
    finally:
        if connection is not None:
            connection.close()
        for suffix in ("", "-wal", "-shm"):
            try: os.remove(staged + suffix)
            except FileNotFoundError: pass


def _backup_before_migration(db, database: str, schema_version: int) -> str:
    backup_dir = os.path.join(os.path.dirname(database), "backups")
    os.makedirs(backup_dir, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup_path = os.path.join(backup_dir, f"{os.path.basename(database)}.v{schema_version}.{stamp}.{uuid.uuid4().hex}.bak")
    descriptor = os.open(backup_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    backup = sqlite3.connect(backup_path)
    try:
        db.backup(backup)
        if backup.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise RuntimeError("迁移备份完整性检查失败")
        backup.commit()
    finally:
        backup.close()
    sync_descriptor = os.open(backup_path, os.O_RDWR)
    try: os.fsync(sync_descriptor)
    finally: os.close(sync_descriptor)
    _fsync_directory(backup_dir)
    _durable_json_write(_migration_journal_path(database), {
        "version": 1, "database": os.path.abspath(database), "preimage": backup_path,
        "schemaVersion": int(schema_version), "state": "prepared", "createdAt": int(time.time() * 1000),
    })
    prefix = f"{os.path.basename(database)}.v"
    backups = sorted(
        (
            os.path.join(backup_dir, name)
            for name in os.listdir(backup_dir)
            if name.startswith(prefix) and name.endswith(".bak")
        ),
        key=os.path.getmtime,
        reverse=True,
    )
    retained = {backup_path, *[path for path in backups if path != backup_path][:MIGRATION_BACKUP_LIMIT - 1]}
    for stale_path in (path for path in backups if path not in retained):
        try:
            os.remove(stale_path)
        except OSError:
            pass
    return backup_path


def _automatic_backup_if_due(db, database: str):
    now = int(time.time() * 1000)
    db.execute("BEGIN IMMEDIATE")
    try:
        last_attempt = int(_meta_value(db, "last_automatic_backup_attempt_at") or 0)
        if now - last_attempt < AUTOMATIC_BACKUP_INTERVAL_MS:
            db.rollback()
            return
        _set_meta(db, "last_automatic_backup_attempt_at", now)
        db.commit()
    except Exception:
        db.rollback()
        raise

    backup_dir = os.path.join(os.path.dirname(database), "backups")
    os.makedirs(backup_dir, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup_path = os.path.join(
        backup_dir,
        f"{os.path.basename(database)}.auto.{stamp}.{uuid.uuid4().hex[:6]}.bak",
    )
    try:
        backup = sqlite3.connect(backup_path)
        try:
            db.backup(backup)
            if backup.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise RuntimeError("自动备份完整性检查失败")
        finally:
            backup.close()
        backups = sorted(
            (
                os.path.join(backup_dir, name)
                for name in os.listdir(backup_dir)
                if name.startswith(f"{os.path.basename(database)}.auto.") and name.endswith(".bak")
            ),
            key=os.path.getmtime,
            reverse=True,
        )
        for stale_path in backups[AUTOMATIC_BACKUP_LIMIT:]:
            try:
                os.remove(stale_path)
            except OSError:
                pass
        _set_meta(db, "last_automatic_backup_at", now)
        _set_meta(db, "last_automatic_backup", backup_path)
        _set_meta(db, "last_automatic_backup_error", "")
    except Exception as error:
        try:
            os.remove(backup_path)
        except OSError:
            pass
        _set_meta(db, "last_automatic_backup_error", str(error))
    db.commit()


def _migration_11(db):
    columns = _table_columns(db, "projects")
    if "filesystem_id" not in columns:
        db.execute("ALTER TABLE projects ADD COLUMN filesystem_id TEXT")
    if "is_deleted" not in columns:
        db.execute("ALTER TABLE projects ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0")
    run_compatibility_hooks("migrate", db, 11)


def _migration_12(db):
    """Make every file record owned by a real version and discard legacy orphans."""
    removed = db.execute(
        """SELECT COUNT(*) FROM file_records
           WHERE owner_type!='version' OR NOT EXISTS(
             SELECT 1 FROM versions WHERE versions.id=file_records.owner_id
           )"""
    ).fetchone()[0]
    foreign_keys = db.execute("PRAGMA foreign_key_list(file_records)").fetchall()
    has_owner_fk = any(row[2] == "versions" and row[3] == "owner_id" and row[4] == "id" for row in foreign_keys)
    if not has_owner_fk:
        db.execute("DROP TABLE IF EXISTS file_records_v12")
        db.execute(
            """CREATE TABLE file_records_v12 (
                id TEXT PRIMARY KEY,
                owner_type TEXT NOT NULL CHECK(owner_type='version'),
                owner_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
                current_path TEXT NOT NULL,
                file_name TEXT NOT NULL,
                extension TEXT NOT NULL,
                windows_file_id TEXT,
                volume_id TEXT,
                file_size INTEGER NOT NULL CHECK(file_size>=0),
                modified_at INTEGER,
                quick_hash TEXT,
                full_hash TEXT,
                missing INTEGER NOT NULL DEFAULT 0 CHECK(missing IN (0,1)),
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE(owner_type, owner_id)
            )"""
        )
        db.execute(
            """INSERT INTO file_records_v12
               SELECT records.* FROM file_records records
               JOIN versions ON versions.id=records.owner_id
               WHERE records.owner_type='version'"""
        )
        db.execute("DROP TABLE file_records")
        db.execute("ALTER TABLE file_records_v12 RENAME TO file_records")
    else:
        db.execute(
            """DELETE FROM file_records
               WHERE owner_type!='version' OR NOT EXISTS(
                 SELECT 1 FROM versions WHERE versions.id=file_records.owner_id
               )"""
        )
    _set_meta(db, "migration_12_orphan_file_records_removed", removed)


def _repair_version_flags(db):
    for duplicate in db.execute(
        """SELECT photo_id FROM versions
           WHERE is_current=1 AND is_deleted=0 GROUP BY photo_id HAVING COUNT(*)>1"""
    ).fetchall():
        photo_id = duplicate[0]
        preferred = db.execute(
            """SELECT versions.id FROM versions JOIN photos ON photos.id=versions.photo_id
               WHERE versions.photo_id=? AND versions.is_current=1 AND versions.is_deleted=0
               ORDER BY versions.id=photos.current_version_id DESC, versions.version_number DESC LIMIT 1""",
            (photo_id,),
        ).fetchone()[0]
        db.execute("UPDATE versions SET is_current=(id=?) WHERE photo_id=? AND is_deleted=0", (preferred, photo_id))
    for duplicate in db.execute(
        """SELECT photo_id FROM versions
           WHERE is_final=1 AND is_deleted=0 GROUP BY photo_id HAVING COUNT(*)>1"""
    ).fetchall():
        photo_id = duplicate[0]
        preferred = db.execute(
            """SELECT id FROM versions WHERE photo_id=? AND is_final=1 AND is_deleted=0
               ORDER BY version_number DESC, updated_at DESC LIMIT 1""",
            (photo_id,),
        ).fetchone()[0]
        db.execute("UPDATE versions SET is_final=(id=?) WHERE photo_id=? AND is_deleted=0", (preferred, photo_id))


def _migration_13(db):
    columns = _table_columns(db, "projects")
    if "availability" not in columns:
        db.execute(
            "ALTER TABLE projects ADD COLUMN availability TEXT NOT NULL DEFAULT 'available' "
            "CHECK(availability IN ('available','missing'))"
        )
    if "missing_since" not in columns:
        db.execute("ALTER TABLE projects ADD COLUMN missing_since INTEGER")
    if "missing_checks" not in columns:
        db.execute("ALTER TABLE projects ADD COLUMN missing_checks INTEGER NOT NULL DEFAULT 0 CHECK(missing_checks>=0)")
    _repair_version_flags(db)
    db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS versions_one_current "
        "ON versions(photo_id) WHERE is_current=1 AND is_deleted=0"
    )
    db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS versions_one_final "
        "ON versions(photo_id) WHERE is_final=1 AND is_deleted=0"
    )
    db.execute(
        """CREATE TRIGGER IF NOT EXISTS versions_parent_same_photo_insert
           BEFORE INSERT ON versions WHEN NEW.parent_version_id IS NOT NULL
           AND NOT EXISTS(SELECT 1 FROM versions parent WHERE parent.id=NEW.parent_version_id AND parent.photo_id=NEW.photo_id)
           BEGIN SELECT RAISE(ABORT,'parent version belongs to another photo'); END"""
    )
    db.execute(
        """CREATE TRIGGER IF NOT EXISTS versions_parent_same_photo_update
           BEFORE UPDATE OF parent_version_id,photo_id ON versions WHEN NEW.parent_version_id IS NOT NULL
           AND NOT EXISTS(SELECT 1 FROM versions parent WHERE parent.id=NEW.parent_version_id AND parent.photo_id=NEW.photo_id)
           BEGIN SELECT RAISE(ABORT,'parent version belongs to another photo'); END"""
    )
    db.execute(
        """CREATE TRIGGER IF NOT EXISTS photos_current_version_same_photo
           BEFORE UPDATE OF current_version_id ON photos WHEN NEW.current_version_id IS NOT NULL
           AND NOT EXISTS(SELECT 1 FROM versions WHERE id=NEW.current_version_id AND photo_id=NEW.id AND is_deleted=0)
           BEGIN SELECT RAISE(ABORT,'current version belongs to another photo'); END"""
    )
    guards = (
        (
            "version_batches_parent_project",
            "version_batches",
            "parent_batch_id,project_id",
            "NEW.parent_batch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM version_batches parent WHERE parent.id=NEW.parent_batch_id AND parent.project_id=NEW.project_id)",
            "parent batch belongs to another project",
        ),
        (
            "progress_folders_parent_project",
            "progress_folders",
            "parent_progress_id,project_id,media_kind",
            "NEW.parent_progress_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM progress_folders parent WHERE parent.id=NEW.parent_progress_id AND parent.project_id=NEW.project_id AND parent.media_kind=NEW.media_kind)",
            "parent progress folder belongs to another project or media kind",
        ),
        (
            "batch_items_owner_consistency",
            "batch_items",
            "batch_id,photo_id,version_id",
            "NOT EXISTS(SELECT 1 FROM version_batches batch JOIN photos ON photos.project_id=batch.project_id JOIN versions ON versions.photo_id=photos.id WHERE batch.id=NEW.batch_id AND photos.id=NEW.photo_id AND versions.id=NEW.version_id)",
            "batch item owners are inconsistent",
        ),
    )
    for name, table, update_columns, condition, message in guards:
        db.execute(
            f"""CREATE TRIGGER IF NOT EXISTS {name}_insert
                BEFORE INSERT ON {table} WHEN {condition}
                BEGIN SELECT RAISE(ABORT,'{message}'); END"""
        )
        db.execute(
            f"""CREATE TRIGGER IF NOT EXISTS {name}_update
                BEFORE UPDATE OF {update_columns} ON {table} WHEN {condition}
                BEGIN SELECT RAISE(ABORT,'{message}'); END"""
        )


def _migration_14(db):
    progress_columns = _table_columns(db, "progress_folders")
    if "tracking_state" not in progress_columns:
        db.execute(
            "ALTER TABLE progress_folders ADD COLUMN tracking_state TEXT NOT NULL DEFAULT 'disabled'"
        )
    db.execute(
        """UPDATE progress_folders SET tracking_state=CASE
             WHEN tracking_enabled=1 THEN 'ready' ELSE 'disabled' END
           WHERE tracking_state IS NULL OR tracking_state='' OR tracking_state='disabled'"""
    )
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS batch_file_operations (
            id TEXT PRIMARY KEY,
            batch_id TEXT NOT NULL REFERENCES version_batches(id) ON DELETE CASCADE,
            operation_type TEXT NOT NULL CHECK(operation_type IN ('rename','copy')),
            source_path TEXT NOT NULL,
            target_path TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','succeeded','failed','skipped')),
            attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
            error TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(batch_id, operation_type, source_path, target_path)
        );
        CREATE INDEX IF NOT EXISTS batch_file_operations_batch
          ON batch_file_operations(batch_id, status, created_at);
        """
    )


def _migration_15(db):
    run_compatibility_hooks("migrate", db, 15)


def _migration_16(db):
    """Keep progress-folder tombstones recoverable after their directory disappears."""
    columns = _table_columns(db, "progress_folders")
    if "missing_since" not in columns:
        db.execute("ALTER TABLE progress_folders ADD COLUMN missing_since INTEGER")


def _migration_17(db):
    run_compatibility_hooks("migrate", db, 17)


def _progress_relation_cycles(db) -> list[tuple[str, ...]]:
    """Find every parent-pointer cycle without recursive SQL or Python recursion."""
    rows = db.execute("SELECT id,parent_progress_id FROM progress_folders ORDER BY id").fetchall()
    parents = {str(row["id"]): str(row["parent_progress_id"]) if row["parent_progress_id"] else None for row in rows}
    finished: set[str] = set()
    cycles: list[tuple[str, ...]] = []
    for start_id in sorted(parents):
        if start_id in finished:
            continue
        path: list[str] = []
        path_indexes: dict[str, int] = {}
        current_id: str | None = start_id
        while current_id is not None and current_id in parents and current_id not in finished:
            if current_id in path_indexes:
                cycles.append(tuple(sorted(path[path_indexes[current_id]:])))
                break
            path_indexes[current_id] = len(path)
            path.append(current_id)
            current_id = parents[current_id]
        finished.update(path)
    return sorted(set(cycles))


def _version_graph_adjacency(db, project_id: str, exclude_edge_id: str | None = None) -> dict[str, set[str]]:
    progress_table = _qualified_table(db, "progress_folders", "versioning")
    rows = db.execute(
        f"SELECT id,parent_progress_id FROM {progress_table} WHERE project_id=?",
        (project_id,),
    ).fetchall()
    adjacency = {str(row["id"]): set() for row in rows}
    for row in rows:
        if row["parent_progress_id"]:
            adjacency.setdefault(str(row["parent_progress_id"]), set()).add(str(row["id"]))
    edge_schema = _table_schema(db, "version_graph_edges", "versioning")
    edge_rows = [] if edge_schema is None else db.execute(
        f'SELECT id,source_progress_id,target_progress_id FROM "{edge_schema}"."version_graph_edges" WHERE project_id=?',
        (project_id,),
    ).fetchall()
    for edge in edge_rows:
        if exclude_edge_id and str(edge["id"]) == exclude_edge_id:
            continue
        adjacency.setdefault(str(edge["source_progress_id"]), set()).add(str(edge["target_progress_id"]))
    return adjacency


def _version_graph_reaches(db, project_id: str, start_id: str, target_id: str, exclude_edge_id: str | None = None) -> bool:
    adjacency = _version_graph_adjacency(db, project_id, exclude_edge_id)
    pending = [start_id]
    visited: set[str] = set()
    while pending:
        current = pending.pop()
        if current == target_id:
            return True
        if current in visited:
            continue
        visited.add(current)
        pending.extend(adjacency.get(current, ()))
    return False


def _version_graph_cycle_nodes(db) -> set[str]:
    if not _table_exists(db, "version_graph_edges"):
        return set()
    projects = [str(row[0]) for row in db.execute("SELECT id FROM projects").fetchall()]
    cyclic: set[str] = set()
    for project_id in projects:
        adjacency = _version_graph_adjacency(db, project_id)
        indegree = {node_id: 0 for node_id in adjacency}
        for targets in adjacency.values():
            for target_id in targets:
                indegree[target_id] = indegree.get(target_id, 0) + 1
        pending = [node_id for node_id, degree in indegree.items() if degree == 0]
        removed: set[str] = set()
        while pending:
            node_id = pending.pop()
            if node_id in removed:
                continue
            removed.add(node_id)
            for target_id in adjacency.get(node_id, ()):
                indegree[target_id] -= 1
                if indegree[target_id] == 0:
                    pending.append(target_id)
        cyclic.update(set(indegree) - removed)
    return cyclic


def _repair_progress_relation_cycles(db) -> list[dict]:
    """Deterministically break one edge per legacy cycle and retain an audit log."""
    # A database may have been opened by a newer build and then deliberately
    # downgraded in a migration recovery/test scenario. Cycle repair must be
    # able to preserve one legacy orphan before schema 24 reinstalls the strict
    # parent-required trigger; it never deletes the physical folder.
    for schema in [row[1] for row in db.execute("PRAGMA database_list").fetchall()]:
        db.execute(f'DROP TRIGGER IF EXISTS "{schema}".progress_folders_v2_shape_update')
        db.execute(f'DROP TRIGGER IF EXISTS "{schema}".progress_folders_v2_policy_update')
        db.execute(f'DROP TRIGGER IF EXISTS "{schema}".progress_folders_graph_endpoint_update')
    db.execute(
        """CREATE TABLE IF NOT EXISTS progress_relation_repair_log(
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             repaired_progress_id TEXT NOT NULL,
             previous_parent_progress_id TEXT NOT NULL,
             cycle_node_ids_json TEXT NOT NULL,
             repair_kind TEXT NOT NULL,
             repaired_at INTEGER NOT NULL
           )"""
    )
    timestamp = int(time.time() * 1000)
    repairs = []
    for cycle_node_ids in _progress_relation_cycles(db):
        repaired_id = min(cycle_node_ids)
        row = db.execute(
            "SELECT parent_progress_id,node_role FROM progress_folders WHERE id=?",
            (repaired_id,),
        ).fetchone()
        if row is None or not row["parent_progress_id"]:
            continue
        previous_parent_id = str(row["parent_progress_id"])
        db.execute(
            """UPDATE progress_folders
               SET parent_progress_id=NULL,relation_kind=NULL,
                   node_role='original',tracking_enabled=0,tracking_state='disabled',
                   rename_from_parent=0,copy_missing_from_parent=0,
                   updated_at=? WHERE id=?""",
            (timestamp, repaired_id),
        )
        cycle_json = json.dumps(list(cycle_node_ids), ensure_ascii=False, separators=(",", ":"))
        db.execute(
            """INSERT INTO progress_relation_repair_log(
                 repaired_progress_id,previous_parent_progress_id,cycle_node_ids_json,repair_kind,repaired_at)
               VALUES(?,?,?,'legacy_cycle_rooted',?)""",
            (repaired_id, previous_parent_id, cycle_json, timestamp),
        )
        repairs.append({
            "repairedProgressId": repaired_id,
            "previousParentProgressId": previous_parent_id,
            "cycleNodeIds": list(cycle_node_ids),
        })
    if repairs:
        _set_meta(db, "last_progress_relation_cycle_repair", json.dumps(repairs, ensure_ascii=False, separators=(",", ":")))
    return repairs


def _migration_18(db):
    """Add the explicit V2 folder-node model without inferring branches from names."""
    columns = _table_columns(db, "progress_folders")
    additions = (
        ("node_role", "TEXT NOT NULL DEFAULT 'progress'"),
        ("relation_kind", "TEXT"),
        ("rename_from_parent", "INTEGER NOT NULL DEFAULT 0"),
        ("copy_missing_from_parent", "INTEGER NOT NULL DEFAULT 0"),
        ("last_tracked_at", "INTEGER"),
        ("tracking_snapshot_json", "TEXT NOT NULL DEFAULT '{}'"),
        ("folder_signature", "TEXT"),
        ("tombstone_json", "TEXT NOT NULL DEFAULT '{}'"),
    )
    for name, declaration in additions:
        if name not in columns:
            db.execute(f"ALTER TABLE progress_folders ADD COLUMN {name} {declaration}")

    # Old underscore versions remain main progress nodes. Only explicit root
    # baseline identities are promoted to original; the version key format is
    # never used to infer an auxiliary relation.
    db.execute(
        """UPDATE progress_folders
           SET node_role=CASE
             WHEN parent_progress_id IS NULL AND (
               version_key='0' OR lower(display_name) IN ('raw','jpg','mov')
               OR lower(replace(folder_path,'\','/')) LIKE '%/raw'
               OR lower(replace(folder_path,'\','/')) LIKE '%/jpg'
               OR lower(replace(folder_path,'\','/')) LIKE '%/mov'
             ) THEN 'original' ELSE 'progress' END,
             relation_kind=CASE WHEN parent_progress_id IS NULL THEN NULL ELSE 'main' END,
             tracking_state=CASE
               WHEN tracking_state IN ('disabled','pending_compare','pending_confirm','committing','ready','stale','needs_repair')
                 THEN tracking_state
               WHEN tracking_enabled=1 THEN 'ready' ELSE 'disabled' END,
             tracking_enabled=CASE
               WHEN tracking_state='disabled' THEN 0 ELSE 1 END,
             rename_from_parent=0,
             copy_missing_from_parent=0,
             last_tracked_at=CASE WHEN tracking_state='ready' THEN COALESCE(last_tracked_at,updated_at) ELSE last_tracked_at END,
             tracking_snapshot_json=COALESCE(NULLIF(tracking_snapshot_json,''),'{}'),
             tombstone_json=COALESCE(NULLIF(tombstone_json,''),'{}')"""
    )
    # Originals and auxiliary nodes never carry active tracking policy.
    db.execute(
        """UPDATE progress_folders SET tracking_enabled=0,rename_from_parent=0,
           copy_missing_from_parent=0,tracking_state='disabled'
           WHERE node_role='original' OR relation_kind='auxiliary'"""
    )
    # Existing schema-17 data may already contain cycles. Repair it before
    # installing V2 triggers or running the post-migration integrity check.
    _repair_progress_relation_cycles(db)
    db.executescript(
        """
        CREATE INDEX IF NOT EXISTS progress_folders_missing
          ON progress_folders(project_id, missing_since);
        CREATE INDEX IF NOT EXISTS progress_folders_branch
          ON progress_folders(project_id, media_kind, relation_kind, parent_progress_id);

        DROP TRIGGER IF EXISTS progress_folders_v2_shape_insert;
        DROP TRIGGER IF EXISTS progress_folders_v2_shape_update;
        DROP TRIGGER IF EXISTS progress_folders_parent_validate_insert;
        DROP TRIGGER IF EXISTS progress_folders_parent_validate_update;
        DROP TRIGGER IF EXISTS progress_folders_structural_parent_update;
        DROP TRIGGER IF EXISTS progress_folders_v2_parent_insert;
        DROP TRIGGER IF EXISTS progress_folders_v2_parent_update;
        DROP TRIGGER IF EXISTS progress_folders_v2_cycle_insert;
        DROP TRIGGER IF EXISTS progress_folders_v2_cycle_update;
        DROP TRIGGER IF EXISTS progress_folders_v2_policy_insert;
        DROP TRIGGER IF EXISTS progress_folders_v2_policy_update;
        DROP TRIGGER IF EXISTS version_graph_edges_validate_insert;
        DROP TRIGGER IF EXISTS version_graph_edges_validate_update;
        DROP TRIGGER IF EXISTS progress_folders_graph_endpoint_update;

        CREATE TRIGGER progress_folders_v2_shape_insert
        BEFORE INSERT ON progress_folders WHEN
          NEW.node_role NOT IN ('original','progress','selection')
          OR (NEW.relation_kind IS NOT NULL AND NEW.relation_kind NOT IN ('main','auxiliary'))
          OR (NEW.parent_progress_id IS NULL) != (NEW.relation_kind IS NULL)
          OR (NEW.node_role='original' AND NEW.parent_progress_id IS NOT NULL)
          OR (NEW.node_role='selection' AND NEW.relation_kind!='auxiliary')
          OR (NEW.node_role='progress' AND NEW.parent_progress_id IS NOT NULL AND NEW.relation_kind!='main')
          OR (NEW.relation_kind='auxiliary' AND NEW.node_role!='selection')
        BEGIN SELECT RAISE(ABORT,'invalid V2 progress node shape'); END;

        CREATE TRIGGER progress_folders_v2_shape_update
        BEFORE UPDATE OF node_role,relation_kind,parent_progress_id ON progress_folders WHEN
          NEW.node_role NOT IN ('original','progress','selection')
          OR (NEW.relation_kind IS NOT NULL AND NEW.relation_kind NOT IN ('main','auxiliary'))
          OR (NEW.parent_progress_id IS NULL) != (NEW.relation_kind IS NULL)
          OR (NEW.node_role='original' AND NEW.parent_progress_id IS NOT NULL)
          OR (NEW.node_role='selection' AND NEW.relation_kind!='auxiliary')
          OR (NEW.node_role='progress' AND NEW.parent_progress_id IS NOT NULL AND NEW.relation_kind!='main')
          OR (NEW.relation_kind='auxiliary' AND NEW.node_role!='selection')
        BEGIN SELECT RAISE(ABORT,'invalid V2 progress node shape'); END;

        CREATE TRIGGER progress_folders_v2_parent_insert
        BEFORE INSERT ON progress_folders WHEN NEW.parent_progress_id IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM progress_folders parent WHERE parent.id=NEW.parent_progress_id
            AND parent.project_id=NEW.project_id AND parent.media_kind=NEW.media_kind
            AND parent.node_role IN ('original','progress')
        ) BEGIN SELECT RAISE(ABORT,'invalid V2 progress parent'); END;

        CREATE TRIGGER progress_folders_v2_parent_update
        BEFORE UPDATE OF parent_progress_id,project_id,media_kind ON progress_folders
        WHEN NEW.parent_progress_id IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM progress_folders parent WHERE parent.id=NEW.parent_progress_id
            AND parent.project_id=NEW.project_id AND parent.media_kind=NEW.media_kind
            AND parent.node_role IN ('original','progress')
        ) BEGIN SELECT RAISE(ABORT,'invalid V2 progress parent'); END;

        CREATE TRIGGER progress_folders_v2_cycle_insert
        BEFORE INSERT ON progress_folders WHEN NEW.parent_progress_id IS NOT NULL AND EXISTS(
          WITH RECURSIVE ancestors(id) AS (
            SELECT NEW.parent_progress_id UNION
            SELECT parent.parent_progress_id FROM progress_folders parent JOIN ancestors ON parent.id=ancestors.id
            WHERE parent.parent_progress_id IS NOT NULL
          ) SELECT 1 FROM ancestors WHERE id=NEW.id
        ) BEGIN SELECT RAISE(ABORT,'progress relation cycle'); END;

        CREATE TRIGGER progress_folders_v2_cycle_update
        BEFORE UPDATE OF parent_progress_id ON progress_folders WHEN NEW.parent_progress_id IS NOT NULL AND EXISTS(
          WITH RECURSIVE ancestors(id) AS (
            SELECT NEW.parent_progress_id UNION
            SELECT parent.parent_progress_id FROM progress_folders parent JOIN ancestors ON parent.id=ancestors.id
            WHERE parent.parent_progress_id IS NOT NULL
          ) SELECT 1 FROM ancestors WHERE id=NEW.id
        ) BEGIN SELECT RAISE(ABORT,'progress relation cycle'); END;

        CREATE TRIGGER progress_folders_v2_policy_insert
        BEFORE INSERT ON progress_folders WHEN
          NEW.tracking_state NOT IN ('disabled','pending_compare','pending_confirm','committing','ready','stale','needs_repair')
          OR NEW.tracking_enabled NOT IN (0,1) OR NEW.rename_from_parent NOT IN (0,1)
          OR NEW.copy_missing_from_parent NOT IN (0,1)
          OR ((NEW.node_role='original' OR NEW.relation_kind='auxiliary') AND (
            NEW.tracking_enabled!=0 OR NEW.rename_from_parent!=0 OR NEW.copy_missing_from_parent!=0 OR NEW.tracking_state!='disabled'))
          OR (NEW.tracking_enabled=0 AND (NEW.rename_from_parent!=0 OR NEW.copy_missing_from_parent!=0))
        BEGIN SELECT RAISE(ABORT,'invalid V2 tracking policy'); END;

        CREATE TRIGGER progress_folders_v2_policy_update
        BEFORE UPDATE OF node_role,relation_kind,tracking_enabled,rename_from_parent,copy_missing_from_parent,tracking_state
        ON progress_folders WHEN
          NEW.tracking_state NOT IN ('disabled','pending_compare','pending_confirm','committing','ready','stale','needs_repair')
          OR NEW.tracking_enabled NOT IN (0,1) OR NEW.rename_from_parent NOT IN (0,1)
          OR NEW.copy_missing_from_parent NOT IN (0,1)
          OR ((NEW.node_role='original' OR NEW.relation_kind='auxiliary') AND (
            NEW.tracking_enabled!=0 OR NEW.rename_from_parent!=0 OR NEW.copy_missing_from_parent!=0 OR NEW.tracking_state!='disabled'))
          OR (NEW.tracking_enabled=0 AND (NEW.rename_from_parent!=0 OR NEW.copy_missing_from_parent!=0))
        BEGIN SELECT RAISE(ABORT,'invalid V2 tracking policy'); END;
        """
    )


def _migration_19(db):
    """Persist V2 compare/refresh sessions and explicit confirmation decisions."""
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS tracking_sessions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          progress_id TEXT NOT NULL REFERENCES progress_folders(id) ON DELETE CASCADE,
          parent_progress_id TEXT NOT NULL REFERENCES progress_folders(id),
          mode TEXT NOT NULL CHECK(mode IN ('compare','refresh')),
          status TEXT NOT NULL CHECK(status IN ('comparing','pending_confirm','committing','committed','failed','cancelled')),
          previous_tracking_state TEXT NOT NULL,
          rename_from_parent INTEGER NOT NULL DEFAULT 0 CHECK(rename_from_parent IN (0,1)),
          copy_missing_from_parent INTEGER NOT NULL DEFAULT 0 CHECK(copy_missing_from_parent IN (0,1)),
          committed_batch_id TEXT REFERENCES version_batches(id) ON DELETE SET NULL,
          error TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS tracking_sessions_progress
          ON tracking_sessions(progress_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS tracking_session_items (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES tracking_sessions(id) ON DELETE CASCADE,
          item_kind TEXT NOT NULL CHECK(item_kind IN ('recognized','new','copy_missing','missing')),
          source_name TEXT,
          reference_name TEXT,
          target_name TEXT,
          status TEXT NOT NULL CHECK(status IN ('recognized','pending_confirmation','accepted','missing_reference','rejected')),
          distance REAL,
          confidence TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(session_id,item_kind,source_name,reference_name)
        );
        CREATE INDEX IF NOT EXISTS tracking_session_items_session
          ON tracking_session_items(session_id, created_at, id);
        """
    )


def _migration_20(db):
    """Repair cycles missed by older V2 builds and install terminating guards."""
    _repair_progress_relation_cycles(db)
    db.executescript(
        """
        DROP TRIGGER IF EXISTS progress_folders_v2_cycle_insert;
        DROP TRIGGER IF EXISTS progress_folders_v2_cycle_update;

        CREATE TRIGGER progress_folders_v2_cycle_insert
        BEFORE INSERT ON progress_folders WHEN NEW.parent_progress_id IS NOT NULL AND EXISTS(
          WITH RECURSIVE ancestors(id) AS (
            SELECT NEW.parent_progress_id UNION
            SELECT parent.parent_progress_id FROM progress_folders parent JOIN ancestors ON parent.id=ancestors.id
            WHERE parent.parent_progress_id IS NOT NULL
          ) SELECT 1 FROM ancestors WHERE id=NEW.id
        ) BEGIN SELECT RAISE(ABORT,'progress relation cycle'); END;

        CREATE TRIGGER progress_folders_v2_cycle_update
        BEFORE UPDATE OF parent_progress_id ON progress_folders WHEN NEW.parent_progress_id IS NOT NULL AND EXISTS(
          WITH RECURSIVE ancestors(id) AS (
            SELECT NEW.parent_progress_id UNION
            SELECT parent.parent_progress_id FROM progress_folders parent JOIN ancestors ON parent.id=ancestors.id
            WHERE parent.parent_progress_id IS NOT NULL
          ) SELECT 1 FROM ancestors WHERE id=NEW.id
        ) BEGIN SELECT RAISE(ABORT,'progress relation cycle'); END;
        """
    )


def _migration_21(db):
    """Keep at most one resumable tracking session for each progress node."""
    db.executescript(
        """
        DELETE FROM tracking_sessions
        WHERE status IN ('comparing','pending_confirm','committing','failed')
          AND EXISTS (
            SELECT 1 FROM tracking_sessions newer
            WHERE newer.progress_id=tracking_sessions.progress_id
              AND newer.status IN ('comparing','pending_confirm','committing','failed')
              AND (
                newer.updated_at > tracking_sessions.updated_at
                OR (newer.updated_at = tracking_sessions.updated_at AND newer.id > tracking_sessions.id)
              )
          );
        CREATE UNIQUE INDEX IF NOT EXISTS tracking_sessions_one_active_progress
          ON tracking_sessions(progress_id)
          WHERE status IN ('comparing','pending_confirm','committing','failed');
        """
    )


def _migration_22(db):
    """Persist legacy selection nodes whose source cannot be repaired safely."""
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS legacy_selection_relation_repairs (
          progress_id TEXT PRIMARY KEY REFERENCES progress_folders(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          legacy_name TEXT NOT NULL,
          expected_source_name TEXT NOT NULL,
          reason TEXT NOT NULL,
          candidate_ids_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS legacy_selection_relation_repairs_project
          ON legacy_selection_relation_repairs(project_id, created_at, progress_id);
        """
    )


def _migration_23(db):
    """Persist free-canvas version-tree positions by stable project node ID."""
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS version_tree_layouts (
          project_id TEXT NOT NULL,
          scope_key TEXT NOT NULL DEFAULT '',
          revision INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(project_id, scope_key),
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS version_tree_node_positions (
          project_id TEXT NOT NULL,
          scope_key TEXT NOT NULL DEFAULT '',
          node_key TEXT NOT NULL,
          x REAL NOT NULL,
          y REAL NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(project_id, scope_key, node_key),
          FOREIGN KEY(project_id, scope_key)
            REFERENCES version_tree_layouts(project_id, scope_key) ON DELETE CASCADE
        );
        """
    )


def _migration_24(db):
    """Add non-structural version-graph edges and explicit artifact/workflow nodes."""
    columns = _table_columns(db, "progress_folders")
    if "artifact_kind" not in columns:
        db.execute("ALTER TABLE progress_folders ADD COLUMN artifact_kind TEXT")
    if "source_metadata_json" not in columns:
        db.execute("ALTER TABLE progress_folders ADD COLUMN source_metadata_json TEXT NOT NULL DEFAULT '{}'")
    db.execute(
        """UPDATE progress_folders SET tracking_enabled=0,rename_from_parent=0,
           copy_missing_from_parent=0,tracking_state='disabled'
           WHERE node_role IN ('artifact','workflow')"""
    )
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS version_graph_edges (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          source_progress_id TEXT NOT NULL REFERENCES progress_folders(id) ON DELETE CASCADE,
          target_progress_id TEXT NOT NULL REFERENCES progress_folders(id) ON DELETE CASCADE,
          edge_kind TEXT NOT NULL CHECK(edge_kind IN ('media_companion','derived_preview','derived_transcode','workflow_input')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(project_id, source_progress_id, target_progress_id, edge_kind)
        );
        CREATE INDEX IF NOT EXISTS version_graph_edges_source
          ON version_graph_edges(project_id, source_progress_id, edge_kind);
        CREATE INDEX IF NOT EXISTS version_graph_edges_target
          ON version_graph_edges(project_id, target_progress_id, edge_kind);
        CREATE TABLE IF NOT EXISTS media_import_graph_sessions (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          import_session_id TEXT NOT NULL,
          manifest_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','committed','failed')),
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(project_id, import_session_id)
        );

        DROP TRIGGER IF EXISTS progress_folders_v2_shape_insert;
        DROP TRIGGER IF EXISTS progress_folders_v2_shape_update;
        DROP TRIGGER IF EXISTS progress_folders_parent_validate_insert;
        DROP TRIGGER IF EXISTS progress_folders_parent_validate_update;
        DROP TRIGGER IF EXISTS progress_folders_structural_parent_update;
        DROP TRIGGER IF EXISTS progress_folders_v2_parent_insert;
        DROP TRIGGER IF EXISTS progress_folders_v2_parent_update;
        DROP TRIGGER IF EXISTS progress_folders_v2_cycle_insert;
        DROP TRIGGER IF EXISTS progress_folders_v2_cycle_update;
        DROP TRIGGER IF EXISTS progress_folders_v2_policy_insert;
        DROP TRIGGER IF EXISTS progress_folders_v2_policy_update;
        DROP TRIGGER IF EXISTS version_graph_edges_validate_insert;
        DROP TRIGGER IF EXISTS version_graph_edges_validate_update;
        DROP TRIGGER IF EXISTS progress_folders_graph_endpoint_update;

        CREATE TRIGGER progress_folders_v2_shape_insert
        BEFORE INSERT ON progress_folders WHEN
          NEW.node_role NOT IN ('original','progress','selection','artifact','workflow','broll')
          OR (NEW.relation_kind IS NOT NULL AND NEW.relation_kind NOT IN ('main','auxiliary'))
          OR (NEW.artifact_kind IS NOT NULL AND (length(NEW.artifact_kind)>128 OR NEW.artifact_kind='' OR NEW.artifact_kind GLOB '*[^A-Za-z0-9._:-]*'))
          OR (NEW.parent_progress_id IS NULL) != (NEW.relation_kind IS NULL)
          OR (NEW.node_role='original' AND (NEW.parent_progress_id IS NOT NULL OR NEW.artifact_kind NOT IN ('companion')))
          OR (NEW.node_role='selection' AND (NEW.relation_kind!='auxiliary' OR NEW.artifact_kind IS NOT NULL))
          OR (NEW.node_role='progress' AND ((NEW.parent_progress_id IS NOT NULL AND NEW.relation_kind!='main') OR NEW.artifact_kind IS NOT NULL))
          OR (NEW.node_role='progress' AND NEW.parent_progress_id IS NULL)
          OR (NEW.node_role='progress' AND NEW.media_kind NOT IN ('image','video'))
          OR (NEW.node_role='artifact' AND (NEW.parent_progress_id IS NOT NULL OR NEW.relation_kind IS NOT NULL OR NEW.artifact_kind NOT IN ('companion','preview','transcode')))
          OR (NEW.node_role='workflow' AND (NEW.parent_progress_id IS NOT NULL OR NEW.relation_kind IS NOT NULL OR NEW.artifact_kind IS NULL))
          OR (NEW.node_role='broll' AND (NEW.media_kind!='mixed' OR NEW.parent_progress_id IS NOT NULL OR NEW.relation_kind IS NOT NULL OR NEW.artifact_kind IS NOT NULL))
          OR (NEW.relation_kind='auxiliary' AND NEW.node_role!='selection')
        BEGIN SELECT RAISE(ABORT,'invalid V3 progress node shape'); END;

        CREATE TRIGGER progress_folders_parent_validate_insert
        BEFORE INSERT ON progress_folders WHEN NEW.parent_progress_id IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM progress_folders parent WHERE parent.id=NEW.parent_progress_id
            AND parent.project_id=NEW.project_id AND parent.media_kind=NEW.media_kind
            AND parent.missing_since IS NULL AND (
              (parent.node_role='original' AND parent.artifact_kind IS NULL)
              OR (parent.node_role='progress' AND parent.parent_progress_id IS NOT NULL AND parent.relation_kind='main')
            )
        ) BEGIN SELECT RAISE(ABORT,'invalid progress parent'); END;

        CREATE TRIGGER progress_folders_parent_validate_update
        BEFORE UPDATE OF project_id,media_kind,parent_progress_id ON progress_folders
        WHEN NEW.parent_progress_id IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM progress_folders parent WHERE parent.id=NEW.parent_progress_id
            AND parent.project_id=NEW.project_id AND parent.media_kind=NEW.media_kind
            AND parent.missing_since IS NULL AND (
              (parent.node_role='original' AND parent.artifact_kind IS NULL)
              OR (parent.node_role='progress' AND parent.parent_progress_id IS NOT NULL AND parent.relation_kind='main')
            )
        ) BEGIN SELECT RAISE(ABORT,'invalid progress parent'); END;

        CREATE TRIGGER progress_folders_structural_parent_update
        BEFORE UPDATE OF project_id,media_kind,node_role,artifact_kind,parent_progress_id,relation_kind
        ON progress_folders WHEN EXISTS(
          SELECT 1 FROM progress_folders child WHERE child.parent_progress_id=OLD.id AND NOT(
            NEW.project_id=child.project_id AND NEW.media_kind=child.media_kind AND (
              (NEW.node_role='original' AND NEW.artifact_kind IS NULL)
              OR (NEW.node_role='progress' AND NEW.parent_progress_id IS NOT NULL AND NEW.relation_kind='main')
            )
          )
        ) BEGIN SELECT RAISE(ABORT,'structural parent role conversion forbidden'); END;

        CREATE TRIGGER progress_folders_v2_shape_update
        BEFORE UPDATE OF media_kind,node_role,artifact_kind,relation_kind,parent_progress_id ON progress_folders WHEN
          NEW.node_role NOT IN ('original','progress','selection','artifact','workflow','broll')
          OR (NEW.relation_kind IS NOT NULL AND NEW.relation_kind NOT IN ('main','auxiliary'))
          OR (NEW.artifact_kind IS NOT NULL AND (length(NEW.artifact_kind)>128 OR NEW.artifact_kind='' OR NEW.artifact_kind GLOB '*[^A-Za-z0-9._:-]*'))
          OR (NEW.parent_progress_id IS NULL) != (NEW.relation_kind IS NULL)
          OR (NEW.node_role='original' AND (NEW.parent_progress_id IS NOT NULL OR NEW.artifact_kind NOT IN ('companion')))
          OR (NEW.node_role='selection' AND (NEW.relation_kind!='auxiliary' OR NEW.artifact_kind IS NOT NULL))
          OR (NEW.node_role='progress' AND ((NEW.parent_progress_id IS NOT NULL AND NEW.relation_kind!='main') OR NEW.artifact_kind IS NOT NULL))
          OR (NEW.node_role='progress' AND NEW.parent_progress_id IS NULL)
          OR (NEW.node_role='progress' AND NEW.media_kind NOT IN ('image','video'))
          OR (NEW.node_role='artifact' AND (NEW.parent_progress_id IS NOT NULL OR NEW.relation_kind IS NOT NULL OR NEW.artifact_kind NOT IN ('companion','preview','transcode')))
          OR (NEW.node_role='workflow' AND (NEW.parent_progress_id IS NOT NULL OR NEW.relation_kind IS NOT NULL OR NEW.artifact_kind IS NULL))
          OR (NEW.node_role='broll' AND (NEW.media_kind!='mixed' OR NEW.parent_progress_id IS NOT NULL OR NEW.relation_kind IS NOT NULL OR NEW.artifact_kind IS NOT NULL))
          OR (NEW.relation_kind='auxiliary' AND NEW.node_role!='selection')
        BEGIN SELECT RAISE(ABORT,'invalid V3 progress node shape'); END;

        CREATE TRIGGER progress_folders_v2_policy_insert
        BEFORE INSERT ON progress_folders WHEN
          NEW.tracking_state NOT IN ('disabled','pending_compare','pending_confirm','committing','ready','stale','needs_repair')
          OR NEW.tracking_enabled NOT IN (0,1) OR NEW.rename_from_parent NOT IN (0,1)
          OR NEW.copy_missing_from_parent NOT IN (0,1)
          OR ((NEW.node_role IN ('original','artifact','workflow','broll') OR NEW.relation_kind='auxiliary' OR NEW.node_role='progress' AND (NEW.parent_progress_id IS NULL OR NEW.relation_kind!='main')) AND (
            NEW.tracking_enabled!=0 OR NEW.rename_from_parent!=0 OR NEW.copy_missing_from_parent!=0 OR NEW.tracking_state!='disabled'))
          OR (NEW.tracking_enabled=0 AND (NEW.rename_from_parent!=0 OR NEW.copy_missing_from_parent!=0))
        BEGIN SELECT RAISE(ABORT,'invalid V3 tracking policy'); END;

        CREATE TRIGGER progress_folders_v2_policy_update
        BEFORE UPDATE OF node_role,relation_kind,tracking_enabled,rename_from_parent,copy_missing_from_parent,tracking_state
        ON progress_folders WHEN
          NEW.tracking_state NOT IN ('disabled','pending_compare','pending_confirm','committing','ready','stale','needs_repair')
          OR NEW.tracking_enabled NOT IN (0,1) OR NEW.rename_from_parent NOT IN (0,1)
          OR NEW.copy_missing_from_parent NOT IN (0,1)
          OR ((NEW.node_role IN ('original','artifact','workflow','broll') OR NEW.relation_kind='auxiliary' OR NEW.node_role='progress' AND (NEW.parent_progress_id IS NULL OR NEW.relation_kind!='main')) AND (
            NEW.tracking_enabled!=0 OR NEW.rename_from_parent!=0 OR NEW.copy_missing_from_parent!=0 OR NEW.tracking_state!='disabled'))
          OR (NEW.tracking_enabled=0 AND (NEW.rename_from_parent!=0 OR NEW.copy_missing_from_parent!=0))
        BEGIN SELECT RAISE(ABORT,'invalid V3 tracking policy'); END;

        CREATE TRIGGER progress_folders_v2_cycle_insert
        BEFORE INSERT ON progress_folders WHEN NEW.parent_progress_id IS NOT NULL AND EXISTS(
          WITH RECURSIVE descendants(id) AS (
            SELECT NEW.id
            UNION
            SELECT child.id FROM progress_folders child JOIN descendants ON child.parent_progress_id=descendants.id
            UNION
            SELECT edge.target_progress_id FROM version_graph_edges edge JOIN descendants ON edge.source_progress_id=descendants.id
          ) SELECT 1 FROM descendants WHERE id=NEW.parent_progress_id
        ) BEGIN SELECT RAISE(ABORT,'version graph cycle'); END;

        CREATE TRIGGER progress_folders_v2_cycle_update
        BEFORE UPDATE OF parent_progress_id ON progress_folders WHEN NEW.parent_progress_id IS NOT NULL AND EXISTS(
          WITH RECURSIVE descendants(id) AS (
            SELECT NEW.id
            UNION
            SELECT child.id FROM progress_folders child JOIN descendants ON child.parent_progress_id=descendants.id
            UNION
            SELECT edge.target_progress_id FROM version_graph_edges edge JOIN descendants ON edge.source_progress_id=descendants.id
          ) SELECT 1 FROM descendants WHERE id=NEW.parent_progress_id
        ) BEGIN SELECT RAISE(ABORT,'version graph cycle'); END;

        CREATE TRIGGER version_graph_edges_validate_insert
        BEFORE INSERT ON version_graph_edges WHEN
          NEW.source_progress_id=NEW.target_progress_id
          OR NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id)
          OR NOT EXISTS(
            SELECT 1 FROM progress_folders source JOIN progress_folders target
              ON target.id=NEW.target_progress_id
            WHERE source.id=NEW.source_progress_id
              AND source.project_id=NEW.project_id AND target.project_id=NEW.project_id
              AND source.media_kind=target.media_kind
              AND (
                (NEW.edge_kind='media_companion' AND source.node_role='original' AND source.artifact_kind IS NULL AND target.node_role='original' AND target.artifact_kind='companion')
                OR (NEW.edge_kind='derived_preview' AND (source.node_role='original' AND source.artifact_kind IS NULL OR source.node_role='progress' AND source.parent_progress_id IS NOT NULL AND source.relation_kind='main') AND target.node_role='artifact' AND target.artifact_kind='preview')
                OR (NEW.edge_kind='derived_transcode' AND (source.node_role='original' AND source.artifact_kind IS NULL OR source.node_role='progress' AND source.parent_progress_id IS NOT NULL AND source.relation_kind='main') AND target.node_role='artifact' AND target.artifact_kind='transcode')
                OR (NEW.edge_kind='workflow_input' AND ((source.node_role IN ('selection','workflow') AND target.node_role='progress' AND target.parent_progress_id IS NOT NULL AND target.relation_kind='main') OR (source.node_role='progress' AND source.parent_progress_id IS NOT NULL AND source.relation_kind='main' AND target.node_role='workflow' AND json_extract(target.source_metadata_json,'$.parentCapability')='workflow-input')))
              )
          )
          OR EXISTS(
            WITH RECURSIVE descendants(id) AS (
              SELECT NEW.target_progress_id
              UNION
              SELECT child.id FROM progress_folders child JOIN descendants ON child.parent_progress_id=descendants.id
              UNION
              SELECT edge.target_progress_id FROM version_graph_edges edge JOIN descendants ON edge.source_progress_id=descendants.id
            ) SELECT 1 FROM descendants WHERE id=NEW.source_progress_id
          )
        BEGIN SELECT RAISE(ABORT,'invalid version graph edge'); END;

        CREATE TRIGGER version_graph_edges_validate_update
        BEFORE UPDATE OF project_id,source_progress_id,target_progress_id,edge_kind ON version_graph_edges WHEN
          NEW.source_progress_id=NEW.target_progress_id
          OR NOT EXISTS(
            SELECT 1 FROM progress_folders source JOIN progress_folders target
              ON target.id=NEW.target_progress_id
            WHERE source.id=NEW.source_progress_id
              AND source.project_id=NEW.project_id AND target.project_id=NEW.project_id
              AND source.media_kind=target.media_kind
              AND (
                (NEW.edge_kind='media_companion' AND source.node_role='original' AND source.artifact_kind IS NULL AND target.node_role='original' AND target.artifact_kind='companion')
                OR (NEW.edge_kind='derived_preview' AND (source.node_role='original' AND source.artifact_kind IS NULL OR source.node_role='progress' AND source.parent_progress_id IS NOT NULL AND source.relation_kind='main') AND target.node_role='artifact' AND target.artifact_kind='preview')
                OR (NEW.edge_kind='derived_transcode' AND (source.node_role='original' AND source.artifact_kind IS NULL OR source.node_role='progress' AND source.parent_progress_id IS NOT NULL AND source.relation_kind='main') AND target.node_role='artifact' AND target.artifact_kind='transcode')
                OR (NEW.edge_kind='workflow_input' AND ((source.node_role IN ('selection','workflow') AND target.node_role='progress' AND target.parent_progress_id IS NOT NULL AND target.relation_kind='main') OR (source.node_role='progress' AND source.parent_progress_id IS NOT NULL AND source.relation_kind='main' AND target.node_role='workflow' AND json_extract(target.source_metadata_json,'$.parentCapability')='workflow-input')))
              )
          )
          OR EXISTS(
            WITH RECURSIVE descendants(id) AS (
              SELECT NEW.target_progress_id
              UNION
              SELECT child.id FROM progress_folders child JOIN descendants ON child.parent_progress_id=descendants.id
              UNION
              SELECT edge.target_progress_id FROM version_graph_edges edge JOIN descendants ON edge.source_progress_id=descendants.id
              WHERE edge.id!=OLD.id
            ) SELECT 1 FROM descendants WHERE id=NEW.source_progress_id
        )
        BEGIN SELECT RAISE(ABORT,'invalid version graph edge'); END;

        CREATE TRIGGER progress_folders_graph_endpoint_update
        BEFORE UPDATE OF project_id,media_kind,node_role,artifact_kind,parent_progress_id,relation_kind ON progress_folders WHEN
          EXISTS(
            SELECT 1 FROM version_graph_edges edge JOIN progress_folders target ON target.id=edge.target_progress_id
            WHERE edge.source_progress_id=OLD.id AND NOT(
              NEW.project_id=edge.project_id AND target.project_id=edge.project_id
              AND NEW.media_kind=target.media_kind AND (
                (edge.edge_kind='media_companion' AND NEW.node_role='original' AND NEW.artifact_kind IS NULL AND target.node_role='original' AND target.artifact_kind='companion')
                OR (edge.edge_kind='derived_preview' AND (NEW.node_role='original' AND NEW.artifact_kind IS NULL OR NEW.node_role='progress' AND NEW.parent_progress_id IS NOT NULL AND NEW.relation_kind='main') AND target.node_role='artifact' AND target.artifact_kind='preview')
                OR (edge.edge_kind='derived_transcode' AND (NEW.node_role='original' AND NEW.artifact_kind IS NULL OR NEW.node_role='progress' AND NEW.parent_progress_id IS NOT NULL AND NEW.relation_kind='main') AND target.node_role='artifact' AND target.artifact_kind='transcode')
                OR (edge.edge_kind='workflow_input' AND ((NEW.node_role IN ('selection','workflow') AND target.node_role='progress' AND target.parent_progress_id IS NOT NULL AND target.relation_kind='main') OR (NEW.node_role='progress' AND NEW.parent_progress_id IS NOT NULL AND NEW.relation_kind='main' AND target.node_role='workflow' AND json_extract(target.source_metadata_json,'$.parentCapability')='workflow-input')))
              )
            )
          )
          OR EXISTS(
            SELECT 1 FROM version_graph_edges edge JOIN progress_folders source ON source.id=edge.source_progress_id
            WHERE edge.target_progress_id=OLD.id AND NOT(
              NEW.project_id=edge.project_id AND source.project_id=edge.project_id
              AND source.media_kind=NEW.media_kind AND (
                (edge.edge_kind='media_companion' AND source.node_role='original' AND source.artifact_kind IS NULL AND NEW.node_role='original' AND NEW.artifact_kind='companion')
                OR (edge.edge_kind='derived_preview' AND (source.node_role='original' AND source.artifact_kind IS NULL OR source.node_role='progress' AND source.parent_progress_id IS NOT NULL AND source.relation_kind='main') AND NEW.node_role='artifact' AND NEW.artifact_kind='preview')
                OR (edge.edge_kind='derived_transcode' AND (source.node_role='original' AND source.artifact_kind IS NULL OR source.node_role='progress' AND source.parent_progress_id IS NOT NULL AND source.relation_kind='main') AND NEW.node_role='artifact' AND NEW.artifact_kind='transcode')
                OR (edge.edge_kind='workflow_input' AND ((source.node_role IN ('selection','workflow') AND NEW.node_role='progress' AND NEW.parent_progress_id IS NOT NULL AND NEW.relation_kind='main') OR (source.node_role='progress' AND source.parent_progress_id IS NOT NULL AND source.relation_kind='main' AND NEW.node_role='workflow' AND json_extract(NEW.source_metadata_json,'$.parentCapability')='workflow-input')))
              )
            )
          )
        BEGIN SELECT RAISE(ABORT,'invalid version graph endpoint update'); END;
        """
    )


def _install_progress_purpose_constraints(db):
    """Install role/policy guards in whichever database owns versioning data."""
    installed = False
    for schema in [row[1] for row in db.execute("PRAGMA database_list").fetchall()]:
        if not db.execute(
            f'SELECT 1 FROM "{schema}".sqlite_master WHERE type=\'table\' AND name=\'progress_folders\''
        ).fetchone():
            continue
        if not db.execute(
            f'SELECT 1 FROM "{schema}".sqlite_master WHERE type=\'table\' AND name=\'version_graph_edges\''
        ).fetchone():
            continue
        quoted_schema = schema.replace('"', '""')
        db.executescript(
            f"""
            DROP TRIGGER IF EXISTS "{quoted_schema}".progress_folders_v2_shape_insert;
            DROP TRIGGER IF EXISTS "{quoted_schema}".progress_folders_v2_shape_update;
            DROP TRIGGER IF EXISTS "{quoted_schema}".progress_folders_v2_policy_insert;
            DROP TRIGGER IF EXISTS "{quoted_schema}".progress_folders_v2_policy_update;
            DROP TRIGGER IF EXISTS "{quoted_schema}".progress_folders_parent_validate_insert;
            DROP TRIGGER IF EXISTS "{quoted_schema}".progress_folders_parent_validate_update;
            DROP TRIGGER IF EXISTS "{quoted_schema}".progress_folders_structural_parent_update;
            DROP TRIGGER IF EXISTS "{quoted_schema}".progress_folders_v2_cycle_insert;
            DROP TRIGGER IF EXISTS "{quoted_schema}".progress_folders_v2_cycle_update;
            DROP TRIGGER IF EXISTS "{quoted_schema}".version_graph_edges_validate_insert;
            DROP TRIGGER IF EXISTS "{quoted_schema}".version_graph_edges_validate_update;
            DROP TRIGGER IF EXISTS "{quoted_schema}".progress_folders_graph_endpoint_update;
            CREATE TRIGGER "{quoted_schema}".progress_folders_v2_shape_insert
            BEFORE INSERT ON progress_folders WHEN
              NEW.node_role NOT IN ('original','progress','selection','artifact','workflow','broll')
              OR (NEW.relation_kind IS NOT NULL AND NEW.relation_kind NOT IN ('main','auxiliary'))
              OR (NEW.artifact_kind IS NOT NULL AND (length(NEW.artifact_kind)>128 OR NEW.artifact_kind='' OR NEW.artifact_kind GLOB '*[^A-Za-z0-9._:-]*'))
              OR (NEW.parent_progress_id IS NULL) != (NEW.relation_kind IS NULL)
              OR (NEW.node_role='original' AND (NEW.parent_progress_id IS NOT NULL OR NEW.artifact_kind NOT IN ('companion')))
              OR (NEW.node_role='selection' AND (NEW.relation_kind!='auxiliary' OR NEW.artifact_kind IS NOT NULL))
              OR (NEW.node_role='progress' AND ((NEW.parent_progress_id IS NOT NULL AND NEW.relation_kind!='main') OR NEW.artifact_kind IS NOT NULL))
              OR (NEW.node_role='progress' AND NEW.parent_progress_id IS NULL)
              OR (NEW.node_role='progress' AND NEW.media_kind NOT IN ('image','video'))
              OR (NEW.node_role='artifact' AND (NEW.parent_progress_id IS NOT NULL OR NEW.relation_kind IS NOT NULL OR NEW.artifact_kind NOT IN ('companion','preview','transcode')))
              OR (NEW.node_role='workflow' AND (NEW.parent_progress_id IS NOT NULL OR NEW.relation_kind IS NOT NULL OR NEW.artifact_kind IS NULL))
              OR (NEW.node_role='broll' AND (NEW.media_kind!='mixed' OR NEW.parent_progress_id IS NOT NULL OR NEW.relation_kind IS NOT NULL OR NEW.artifact_kind IS NOT NULL))
              OR (NEW.relation_kind='auxiliary' AND NEW.node_role!='selection')
            BEGIN SELECT RAISE(ABORT,'invalid V3 progress node shape'); END;
            CREATE TRIGGER "{quoted_schema}".progress_folders_v2_shape_update
            BEFORE UPDATE OF media_kind,node_role,artifact_kind,relation_kind,parent_progress_id ON progress_folders WHEN
              NEW.node_role NOT IN ('original','progress','selection','artifact','workflow','broll')
              OR (NEW.relation_kind IS NOT NULL AND NEW.relation_kind NOT IN ('main','auxiliary'))
              OR (NEW.artifact_kind IS NOT NULL AND (length(NEW.artifact_kind)>128 OR NEW.artifact_kind='' OR NEW.artifact_kind GLOB '*[^A-Za-z0-9._:-]*'))
              OR (NEW.parent_progress_id IS NULL) != (NEW.relation_kind IS NULL)
              OR (NEW.node_role='original' AND (NEW.parent_progress_id IS NOT NULL OR NEW.artifact_kind NOT IN ('companion')))
              OR (NEW.node_role='selection' AND (NEW.relation_kind!='auxiliary' OR NEW.artifact_kind IS NOT NULL))
              OR (NEW.node_role='progress' AND ((NEW.parent_progress_id IS NOT NULL AND NEW.relation_kind!='main') OR NEW.artifact_kind IS NOT NULL))
              OR (NEW.node_role='progress' AND NEW.parent_progress_id IS NULL)
              OR (NEW.node_role='progress' AND NEW.media_kind NOT IN ('image','video'))
              OR (NEW.node_role='artifact' AND (NEW.parent_progress_id IS NOT NULL OR NEW.relation_kind IS NOT NULL OR NEW.artifact_kind NOT IN ('companion','preview','transcode')))
              OR (NEW.node_role='workflow' AND (NEW.parent_progress_id IS NOT NULL OR NEW.relation_kind IS NOT NULL OR NEW.artifact_kind IS NULL))
              OR (NEW.node_role='broll' AND (NEW.media_kind!='mixed' OR NEW.parent_progress_id IS NOT NULL OR NEW.relation_kind IS NOT NULL OR NEW.artifact_kind IS NOT NULL))
              OR (NEW.relation_kind='auxiliary' AND NEW.node_role!='selection')
            BEGIN SELECT RAISE(ABORT,'invalid V3 progress node shape'); END;
            CREATE TRIGGER "{quoted_schema}".progress_folders_v2_policy_insert
            BEFORE INSERT ON progress_folders WHEN
              NEW.tracking_state NOT IN ('disabled','pending_compare','pending_confirm','committing','ready','stale','needs_repair')
              OR NEW.tracking_enabled NOT IN (0,1) OR NEW.rename_from_parent NOT IN (0,1)
              OR NEW.copy_missing_from_parent NOT IN (0,1)
              OR ((NEW.node_role IN ('original','artifact','workflow','broll') OR NEW.relation_kind='auxiliary' OR NEW.node_role='progress' AND (NEW.parent_progress_id IS NULL OR NEW.relation_kind!='main')) AND (
                NEW.tracking_enabled!=0 OR NEW.rename_from_parent!=0 OR NEW.copy_missing_from_parent!=0 OR NEW.tracking_state!='disabled'))
              OR (NEW.tracking_enabled=0 AND (NEW.rename_from_parent!=0 OR NEW.copy_missing_from_parent!=0))
            BEGIN SELECT RAISE(ABORT,'invalid V3 tracking policy'); END;
            CREATE TRIGGER "{quoted_schema}".progress_folders_v2_policy_update
            BEFORE UPDATE OF node_role,relation_kind,tracking_enabled,rename_from_parent,copy_missing_from_parent,tracking_state
            ON progress_folders WHEN
              NEW.tracking_state NOT IN ('disabled','pending_compare','pending_confirm','committing','ready','stale','needs_repair')
              OR NEW.tracking_enabled NOT IN (0,1) OR NEW.rename_from_parent NOT IN (0,1)
              OR NEW.copy_missing_from_parent NOT IN (0,1)
              OR ((NEW.node_role IN ('original','artifact','workflow','broll') OR NEW.relation_kind='auxiliary' OR NEW.node_role='progress' AND (NEW.parent_progress_id IS NULL OR NEW.relation_kind!='main')) AND (
                NEW.tracking_enabled!=0 OR NEW.rename_from_parent!=0 OR NEW.copy_missing_from_parent!=0 OR NEW.tracking_state!='disabled'))
              OR (NEW.tracking_enabled=0 AND (NEW.rename_from_parent!=0 OR NEW.copy_missing_from_parent!=0))
            BEGIN SELECT RAISE(ABORT,'invalid V3 tracking policy'); END;

            CREATE TRIGGER "{quoted_schema}".progress_folders_parent_validate_insert
            BEFORE INSERT ON progress_folders WHEN NEW.parent_progress_id IS NOT NULL AND NOT EXISTS(
              SELECT 1 FROM progress_folders parent WHERE parent.id=NEW.parent_progress_id
                AND parent.project_id=NEW.project_id AND parent.media_kind=NEW.media_kind
                AND parent.missing_since IS NULL AND ((parent.node_role='original' AND parent.artifact_kind IS NULL)
                  OR (parent.node_role='progress' AND parent.parent_progress_id IS NOT NULL AND parent.relation_kind='main'))
            ) BEGIN SELECT RAISE(ABORT,'invalid progress parent'); END;
            CREATE TRIGGER "{quoted_schema}".progress_folders_parent_validate_update
            BEFORE UPDATE OF project_id,media_kind,parent_progress_id ON progress_folders
            WHEN NEW.parent_progress_id IS NOT NULL AND NOT EXISTS(
              SELECT 1 FROM progress_folders parent WHERE parent.id=NEW.parent_progress_id
                AND parent.project_id=NEW.project_id AND parent.media_kind=NEW.media_kind
                AND parent.missing_since IS NULL AND ((parent.node_role='original' AND parent.artifact_kind IS NULL)
                  OR (parent.node_role='progress' AND parent.parent_progress_id IS NOT NULL AND parent.relation_kind='main'))
            ) BEGIN SELECT RAISE(ABORT,'invalid progress parent'); END;
            CREATE TRIGGER "{quoted_schema}".progress_folders_structural_parent_update
            BEFORE UPDATE OF project_id,media_kind,node_role,artifact_kind,parent_progress_id,relation_kind
            ON progress_folders WHEN EXISTS(
              SELECT 1 FROM progress_folders child WHERE child.parent_progress_id=OLD.id AND NOT(
                NEW.project_id=child.project_id AND NEW.media_kind=child.media_kind AND (
                  (NEW.node_role='original' AND NEW.artifact_kind IS NULL)
                  OR (NEW.node_role='progress' AND NEW.parent_progress_id IS NOT NULL AND NEW.relation_kind='main')
                )
              )
            ) BEGIN SELECT RAISE(ABORT,'structural parent role conversion forbidden'); END;

            CREATE TRIGGER "{quoted_schema}".progress_folders_v2_cycle_insert
            BEFORE INSERT ON progress_folders WHEN NEW.parent_progress_id IS NOT NULL AND EXISTS(
              WITH RECURSIVE descendants(id) AS (
                SELECT NEW.id UNION
                SELECT child.id FROM progress_folders child JOIN descendants ON child.parent_progress_id=descendants.id UNION
                SELECT edge.target_progress_id FROM version_graph_edges edge JOIN descendants ON edge.source_progress_id=descendants.id
              ) SELECT 1 FROM descendants WHERE id=NEW.parent_progress_id
            ) BEGIN SELECT RAISE(ABORT,'version graph cycle'); END;
            CREATE TRIGGER "{quoted_schema}".progress_folders_v2_cycle_update
            BEFORE UPDATE OF parent_progress_id ON progress_folders WHEN NEW.parent_progress_id IS NOT NULL AND EXISTS(
              WITH RECURSIVE descendants(id) AS (
                SELECT NEW.id UNION
                SELECT child.id FROM progress_folders child JOIN descendants ON child.parent_progress_id=descendants.id UNION
                SELECT edge.target_progress_id FROM version_graph_edges edge JOIN descendants ON edge.source_progress_id=descendants.id
              ) SELECT 1 FROM descendants WHERE id=NEW.parent_progress_id
            ) BEGIN SELECT RAISE(ABORT,'version graph cycle'); END;

            CREATE TRIGGER "{quoted_schema}".version_graph_edges_validate_insert
            BEFORE INSERT ON version_graph_edges WHEN NEW.source_progress_id=NEW.target_progress_id OR NOT EXISTS(
              SELECT 1 FROM progress_folders source JOIN progress_folders target ON target.id=NEW.target_progress_id
              WHERE source.id=NEW.source_progress_id AND source.project_id=NEW.project_id AND target.project_id=NEW.project_id
                AND source.media_kind=target.media_kind AND (
                  (NEW.edge_kind='media_companion' AND source.node_role='original' AND source.artifact_kind IS NULL AND target.node_role='original' AND target.artifact_kind='companion')
                  OR (NEW.edge_kind='derived_preview' AND (source.node_role='original' AND source.artifact_kind IS NULL OR source.node_role='progress' AND source.parent_progress_id IS NOT NULL AND source.relation_kind='main') AND target.node_role='artifact' AND target.artifact_kind='preview')
                  OR (NEW.edge_kind='derived_transcode' AND (source.node_role='original' AND source.artifact_kind IS NULL OR source.node_role='progress' AND source.parent_progress_id IS NOT NULL AND source.relation_kind='main') AND target.node_role='artifact' AND target.artifact_kind='transcode')
                  OR (NEW.edge_kind='workflow_input' AND ((source.node_role IN ('selection','workflow') AND target.node_role='progress' AND target.parent_progress_id IS NOT NULL AND target.relation_kind='main') OR (source.node_role='progress' AND source.parent_progress_id IS NOT NULL AND source.relation_kind='main' AND target.node_role='workflow' AND json_extract(target.source_metadata_json,'$.parentCapability')='workflow-input')))
                )
            ) OR EXISTS(
              WITH RECURSIVE descendants(id) AS (
                SELECT NEW.target_progress_id UNION
                SELECT child.id FROM progress_folders child JOIN descendants ON child.parent_progress_id=descendants.id UNION
                SELECT edge.target_progress_id FROM version_graph_edges edge JOIN descendants ON edge.source_progress_id=descendants.id
              ) SELECT 1 FROM descendants WHERE id=NEW.source_progress_id
            ) BEGIN SELECT RAISE(ABORT,'invalid version graph edge'); END;
            CREATE TRIGGER "{quoted_schema}".version_graph_edges_validate_update
            BEFORE UPDATE OF project_id,source_progress_id,target_progress_id,edge_kind ON version_graph_edges
            WHEN NEW.source_progress_id=NEW.target_progress_id OR NOT EXISTS(
              SELECT 1 FROM progress_folders source JOIN progress_folders target ON target.id=NEW.target_progress_id
              WHERE source.id=NEW.source_progress_id AND source.project_id=NEW.project_id AND target.project_id=NEW.project_id
                AND source.media_kind=target.media_kind AND (
                  (NEW.edge_kind='media_companion' AND source.node_role='original' AND source.artifact_kind IS NULL AND target.node_role='original' AND target.artifact_kind='companion')
                  OR (NEW.edge_kind='derived_preview' AND (source.node_role='original' AND source.artifact_kind IS NULL OR source.node_role='progress' AND source.parent_progress_id IS NOT NULL AND source.relation_kind='main') AND target.node_role='artifact' AND target.artifact_kind='preview')
                  OR (NEW.edge_kind='derived_transcode' AND (source.node_role='original' AND source.artifact_kind IS NULL OR source.node_role='progress' AND source.parent_progress_id IS NOT NULL AND source.relation_kind='main') AND target.node_role='artifact' AND target.artifact_kind='transcode')
                  OR (NEW.edge_kind='workflow_input' AND ((source.node_role IN ('selection','workflow') AND target.node_role='progress' AND target.parent_progress_id IS NOT NULL AND target.relation_kind='main') OR (source.node_role='progress' AND source.parent_progress_id IS NOT NULL AND source.relation_kind='main' AND target.node_role='workflow' AND json_extract(target.source_metadata_json,'$.parentCapability')='workflow-input')))
                )
            ) OR EXISTS(
              WITH RECURSIVE descendants(id) AS (
                SELECT NEW.target_progress_id UNION
                SELECT child.id FROM progress_folders child JOIN descendants ON child.parent_progress_id=descendants.id UNION
                SELECT edge.target_progress_id FROM version_graph_edges edge JOIN descendants ON edge.source_progress_id=descendants.id WHERE edge.id!=OLD.id
              ) SELECT 1 FROM descendants WHERE id=NEW.source_progress_id
            ) BEGIN SELECT RAISE(ABORT,'invalid version graph edge'); END;

            CREATE TRIGGER "{quoted_schema}".progress_folders_graph_endpoint_update
            BEFORE UPDATE OF project_id,media_kind,node_role,artifact_kind,parent_progress_id,relation_kind ON progress_folders WHEN
              EXISTS(
                SELECT 1 FROM version_graph_edges edge JOIN progress_folders target ON target.id=edge.target_progress_id
                WHERE edge.source_progress_id=OLD.id AND NOT(
                  NEW.project_id=edge.project_id AND target.project_id=edge.project_id AND NEW.media_kind=target.media_kind AND (
                    (edge.edge_kind='media_companion' AND NEW.node_role='original' AND NEW.artifact_kind IS NULL AND target.node_role='original' AND target.artifact_kind='companion')
                    OR (edge.edge_kind='derived_preview' AND (NEW.node_role='original' AND NEW.artifact_kind IS NULL OR NEW.node_role='progress' AND NEW.parent_progress_id IS NOT NULL AND NEW.relation_kind='main') AND target.node_role='artifact' AND target.artifact_kind='preview')
                    OR (edge.edge_kind='derived_transcode' AND (NEW.node_role='original' AND NEW.artifact_kind IS NULL OR NEW.node_role='progress' AND NEW.parent_progress_id IS NOT NULL AND NEW.relation_kind='main') AND target.node_role='artifact' AND target.artifact_kind='transcode')
                    OR (edge.edge_kind='workflow_input' AND ((NEW.node_role IN ('selection','workflow') AND target.node_role='progress' AND target.parent_progress_id IS NOT NULL AND target.relation_kind='main') OR (NEW.node_role='progress' AND NEW.parent_progress_id IS NOT NULL AND NEW.relation_kind='main' AND target.node_role='workflow' AND json_extract(target.source_metadata_json,'$.parentCapability')='workflow-input')))
                  )
                )
              ) OR EXISTS(
                SELECT 1 FROM version_graph_edges edge JOIN progress_folders source ON source.id=edge.source_progress_id
                WHERE edge.target_progress_id=OLD.id AND NOT(
                  NEW.project_id=edge.project_id AND source.project_id=edge.project_id AND source.media_kind=NEW.media_kind AND (
                    (edge.edge_kind='media_companion' AND source.node_role='original' AND source.artifact_kind IS NULL AND NEW.node_role='original' AND NEW.artifact_kind='companion')
                    OR (edge.edge_kind='derived_preview' AND (source.node_role='original' AND source.artifact_kind IS NULL OR source.node_role='progress' AND source.parent_progress_id IS NOT NULL AND source.relation_kind='main') AND NEW.node_role='artifact' AND NEW.artifact_kind='preview')
                    OR (edge.edge_kind='derived_transcode' AND (source.node_role='original' AND source.artifact_kind IS NULL OR source.node_role='progress' AND source.parent_progress_id IS NOT NULL AND source.relation_kind='main') AND NEW.node_role='artifact' AND NEW.artifact_kind='transcode')
                    OR (edge.edge_kind='workflow_input' AND ((source.node_role IN ('selection','workflow') AND NEW.node_role='progress' AND NEW.parent_progress_id IS NOT NULL AND NEW.relation_kind='main') OR (source.node_role='progress' AND source.parent_progress_id IS NOT NULL AND source.relation_kind='main' AND NEW.node_role='workflow' AND json_extract(NEW.source_metadata_json,'$.parentCapability')='workflow-input')))
                  )
                )
              )
            BEGIN SELECT RAISE(ABORT,'invalid version graph endpoint update'); END;
            """
        )
        installed = True
    return installed


def _repair_legacy_progress_structural_roots(db):
    """Normalize legacy parentless progress nodes that own structural children.

    The oldest node is the deterministic baseline: preserve its identity,
    folder, and children, promote it to ``original``, and disable tracking.
    Parentless progress leaves remain in place but cannot continue tracking.
    """
    trigger_names = (
        "progress_folders_v2_shape_insert", "progress_folders_v2_shape_update",
        "progress_folders_v2_policy_insert", "progress_folders_v2_policy_update",
        "progress_folders_parent_validate_insert", "progress_folders_parent_validate_update",
        "progress_folders_structural_parent_update",
        "progress_folders_v2_parent_insert", "progress_folders_v2_parent_update",
        "progress_folders_v2_cycle_insert", "progress_folders_v2_cycle_update",
        "version_graph_edges_validate_insert", "version_graph_edges_validate_update",
        "progress_folders_graph_endpoint_update",
    )
    found_owner = False
    repaired = []
    timestamp = int(time.time() * 1000)
    for schema in [row[1] for row in db.execute("PRAGMA database_list").fetchall()]:
        quoted_schema = schema.replace('"', '""')
        tables = {
            row[0] for row in db.execute(
                f'SELECT name FROM "{quoted_schema}".sqlite_master WHERE type=\'table\''
            ).fetchall()
        }
        if "progress_folders" not in tables:
            continue
        found_owner = True
        roots = db.execute(
            f"""SELECT root.id,root.tracking_enabled,root.tracking_state,
                       root.rename_from_parent,root.copy_missing_from_parent,
                       EXISTS(SELECT 1 FROM "{quoted_schema}".progress_folders child
                              WHERE child.parent_progress_id=root.id) AS has_children,
                       (SELECT child.id FROM "{quoted_schema}".progress_folders child
                        WHERE child.parent_progress_id=root.id AND child.node_role='progress'
                          AND child.relation_kind='main'
                        ORDER BY child.created_at,child.id LIMIT 1) AS canonical_child_id
                FROM "{quoted_schema}".progress_folders root
                WHERE root.node_role='progress' AND root.parent_progress_id IS NULL
                ORDER BY root.created_at,root.id"""
        ).fetchall()
        candidates = [
            row for row in roots
            if row["has_children"] or row["tracking_enabled"] != 0
            or row["tracking_state"] != "disabled" or row["rename_from_parent"] != 0
            or row["copy_missing_from_parent"] != 0
        ]
        if not candidates:
            continue
        for name in trigger_names:
            db.execute(f'DROP TRIGGER IF EXISTS "{quoted_schema}"."{name}"')
        schema_repairs = []
        for row in candidates:
            node_id = str(row["id"])
            if row["has_children"]:
                db.execute(
                    f"""UPDATE "{quoted_schema}".progress_folders
                        SET node_role='original',artifact_kind=NULL,relation_kind=NULL,
                            tracking_enabled=0,tracking_state='disabled',
                            rename_from_parent=0,copy_missing_from_parent=0,updated_at=?
                        WHERE id=?""",
                    (timestamp, node_id),
                )
                canonical_child_id = row["canonical_child_id"]
                if canonical_child_id and "version_graph_edges" in tables:
                    edges = db.execute(
                        f"""SELECT id,source_progress_id,target_progress_id
                            FROM "{quoted_schema}".version_graph_edges
                            WHERE edge_kind='workflow_input'
                              AND (source_progress_id=? OR target_progress_id=?)
                            ORDER BY created_at,id""",
                        (node_id, node_id),
                    ).fetchall()
                    for edge in edges:
                        source_id = str(edge["source_progress_id"])
                        target_id = str(edge["target_progress_id"])
                        replacement_source = str(canonical_child_id) if source_id == node_id else source_id
                        replacement_target = str(canonical_child_id) if target_id == node_id else target_id
                        try:
                            db.execute(
                                f"""UPDATE "{quoted_schema}".version_graph_edges
                                    SET source_progress_id=?,target_progress_id=?,updated_at=? WHERE id=?""",
                                (replacement_source, replacement_target, timestamp, edge["id"]),
                            )
                            creates_cycle = db.execute(
                                f"""WITH RECURSIVE descendants(id) AS (
                                      SELECT ? UNION
                                      SELECT child.id FROM "{quoted_schema}".progress_folders child
                                      JOIN descendants ON child.parent_progress_id=descendants.id UNION
                                      SELECT graph.target_progress_id
                                      FROM "{quoted_schema}".version_graph_edges graph
                                      JOIN descendants ON graph.source_progress_id=descendants.id
                                      WHERE graph.id!=?
                                    ) SELECT 1 FROM descendants WHERE id=?""",
                                (replacement_target, edge["id"], replacement_source),
                            ).fetchone()
                            if creates_cycle:
                                db.execute(
                                    f'DELETE FROM "{quoted_schema}".version_graph_edges WHERE id=?',
                                    (edge["id"],),
                                )
                        except sqlite3.IntegrityError:
                            db.execute(
                                f'DELETE FROM "{quoted_schema}".version_graph_edges WHERE id=?',
                                (edge["id"],),
                            )
                if "tracking_sessions" in tables:
                    db.execute(
                        f"""UPDATE "{quoted_schema}".tracking_sessions
                            SET status='cancelled',error=CASE WHEN error='' THEN
                              'legacy structural root normalized to original' ELSE error END,updated_at=?
                            WHERE progress_id=? AND status IN ('comparing','pending_confirm','committing')""",
                        (timestamp, node_id),
                    )
                schema_repairs.append({"id": node_id, "kind": "structural_root_to_original"})
            else:
                db.execute(
                    f"""UPDATE "{quoted_schema}".progress_folders
                        SET tracking_enabled=0,tracking_state='disabled',rename_from_parent=0,
                            copy_missing_from_parent=0,updated_at=? WHERE id=?""",
                    (timestamp, node_id),
                )
                schema_repairs.append({"id": node_id, "kind": "legacy_leaf_tracking_disabled"})

        converted_ids = [item["id"] for item in schema_repairs if item["kind"] == "structural_root_to_original"]
        if converted_ids and "version_graph_edges" in tables:
            placeholders = ",".join("?" for _ in converted_ids)
            db.execute(
                f"""DELETE FROM "{quoted_schema}".version_graph_edges AS edge
                    WHERE (edge.source_progress_id IN ({placeholders})
                           OR edge.target_progress_id IN ({placeholders}))
                      AND NOT EXISTS(
                        SELECT 1 FROM "{quoted_schema}".progress_folders source
                        JOIN "{quoted_schema}".progress_folders target ON target.id=edge.target_progress_id
                        WHERE source.id=edge.source_progress_id
                          AND source.project_id=edge.project_id AND target.project_id=edge.project_id
                          AND source.media_kind=target.media_kind AND (
                            (edge.edge_kind='media_companion' AND source.node_role='original'
                              AND source.artifact_kind IS NULL AND target.node_role='original'
                              AND target.artifact_kind='companion')
                            OR (edge.edge_kind='derived_preview' AND
                              (source.node_role='original' AND source.artifact_kind IS NULL
                               OR source.node_role='progress' AND source.parent_progress_id IS NOT NULL
                                  AND source.relation_kind='main')
                              AND target.node_role='artifact' AND target.artifact_kind='preview')
                            OR (edge.edge_kind='derived_transcode' AND
                              (source.node_role='original' AND source.artifact_kind IS NULL
                               OR source.node_role='progress' AND source.parent_progress_id IS NOT NULL
                                  AND source.relation_kind='main')
                              AND target.node_role='artifact' AND target.artifact_kind='transcode')
                            OR (edge.edge_kind='workflow_input' AND
                              ((source.node_role IN ('selection','workflow') AND target.node_role='progress'
                                AND target.parent_progress_id IS NOT NULL AND target.relation_kind='main')
                               OR (source.node_role='progress' AND source.parent_progress_id IS NOT NULL
                                AND source.relation_kind='main' AND target.node_role='workflow'
                               )))))""",
                (*converted_ids, *converted_ids),
            )
        if converted_ids and "media_import_artifact_slots" in tables:
            placeholders = ",".join("?" for _ in converted_ids)
            db.execute(
                f"""DELETE FROM "{quoted_schema}".media_import_artifact_slots AS slot
                    WHERE slot.progress_id IN ({placeholders}) AND NOT EXISTS(
                      SELECT 1 FROM "{quoted_schema}".progress_folders progress
                      WHERE progress.id=slot.progress_id AND
                        (slot.import_slot='raw' AND progress.media_kind='image'
                         OR slot.import_slot='mov' AND progress.media_kind='video'))""",
                tuple(converted_ids),
            )
        repaired.extend(schema_repairs)
    if repaired:
        _set_meta(
            db, "last_legacy_progress_parent_repair",
            json.dumps(repaired, ensure_ascii=False, separators=(",", ":")),
        )
    return found_owner, repaired


def _progress_purpose_constraints_current(db):
    expected = {
        "progress_folders_v2_shape_insert", "progress_folders_v2_shape_update",
        "progress_folders_v2_policy_insert", "progress_folders_v2_policy_update",
        "progress_folders_parent_validate_insert", "progress_folders_parent_validate_update",
        "progress_folders_structural_parent_update",
        "progress_folders_v2_cycle_insert", "progress_folders_v2_cycle_update",
        "version_graph_edges_validate_insert", "version_graph_edges_validate_update",
        "progress_folders_graph_endpoint_update",
    }
    found_progress_table = False
    for schema in [row[1] for row in db.execute("PRAGMA database_list").fetchall()]:
        if not db.execute(
            f'SELECT 1 FROM "{schema}".sqlite_master WHERE type=\'table\' AND name=\'progress_folders\''
        ).fetchone():
            continue
        found_progress_table = True
        rows = db.execute(
            f'SELECT name,sql FROM "{schema}".sqlite_master WHERE type=\'trigger\' '
            f"AND name IN ({','.join('?' for _ in expected)})",
            tuple(sorted(expected)),
        ).fetchall()
        sql_by_name = {row["name"]: str(row["sql"] or "") for row in rows}
        if set(sql_by_name) != expected or any("broll" not in sql_by_name[name] for name in (
            "progress_folders_v2_shape_insert", "progress_folders_v2_shape_update",
            "progress_folders_v2_policy_insert", "progress_folders_v2_policy_update",
        )):
            return False
    return found_progress_table


def _migration_25(db):
    """Persist importer-provided artifact semantics independently from node display metadata."""
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS media_import_artifact_slots (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          progress_id TEXT NOT NULL REFERENCES progress_folders(id) ON DELETE CASCADE,
          import_slot TEXT NOT NULL CHECK(import_slot IN ('raw','camera_jpg','generated_jpg','mov','video_transcode')),
          relative_path_key TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(project_id, progress_id),
          UNIQUE(project_id, relative_path_key)
        );
        CREATE INDEX IF NOT EXISTS media_import_artifact_slots_kind
          ON media_import_artifact_slots(project_id, import_slot, updated_at, progress_id);

        DROP TRIGGER IF EXISTS media_import_artifact_slots_validate_insert;
        DROP TRIGGER IF EXISTS media_import_artifact_slots_validate_update;
        CREATE TRIGGER media_import_artifact_slots_validate_insert
        BEFORE INSERT ON media_import_artifact_slots WHEN NOT EXISTS (
          SELECT 1 FROM progress_folders progress
          WHERE progress.id=NEW.progress_id AND progress.project_id=NEW.project_id
        )
        BEGIN SELECT RAISE(ABORT,'import artifact slot project mismatch'); END;
        CREATE TRIGGER media_import_artifact_slots_validate_update
        BEFORE UPDATE OF project_id,progress_id ON media_import_artifact_slots WHEN NOT EXISTS (
          SELECT 1 FROM progress_folders progress
          WHERE progress.id=NEW.progress_id AND progress.project_id=NEW.project_id
        )
        BEGIN SELECT RAISE(ABORT,'import artifact slot project mismatch'); END;
        """
    )
    workspace_root = _meta_value(db, "workspace_root")
    if not workspace_root or not _table_exists(db, "media_import_graph_sessions"):
        return
    projects = {row["id"]: row for row in db.execute("SELECT id,relative_path FROM projects").fetchall()}
    for session in db.execute("SELECT project_id,manifest_json,updated_at FROM media_import_graph_sessions").fetchall():
        project = projects.get(session["project_id"])
        if project is None:
            continue
        try:
            manifest = json.loads(session["manifest_json"] or "{}")
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        artifacts = manifest.get("artifacts")
        if not isinstance(artifacts, list):
            continue
        slots_by_path = {}
        for item in artifacts:
            if isinstance(item, dict) and item.get("importSlot") in IMPORT_ARTIFACT_SLOTS:
                try:
                    slots_by_path[_import_relative_path(item.get("relativePath")).casefold()] = item["importSlot"]
                except ValueError:
                    pass
        # Legacy schema-24 manifests can only be backfilled when their explicit
        # relation endpoints or media kind make the slot unambiguous.
        for relation in manifest.get("relations") if isinstance(manifest.get("relations"), list) else []:
            if not isinstance(relation, dict):
                continue
            try:
                source_key = _import_relative_path(relation.get("sourceRelativePath")).casefold()
                target_key = _import_relative_path(relation.get("targetRelativePath")).casefold()
            except ValueError:
                continue
            if relation.get("edgeKind") == "media_companion":
                slots_by_path[source_key] = "raw"
                slots_by_path[target_key] = "camera_jpg"
            elif relation.get("edgeKind") in ("derived_preview", "derived_transcode"):
                target_artifact = next((item for item in artifacts if isinstance(item, dict)
                                        and str(item.get("relativePath") or "").replace("\\", "/").strip("/").casefold() == target_key), None)
                if target_artifact and target_artifact.get("mediaKind") == "video":
                    slots_by_path[source_key] = "mov"
                    slots_by_path[target_key] = "video_transcode"
                elif target_artifact and target_artifact.get("mediaKind") == "image":
                    slots_by_path[source_key] = "raw"
                    slots_by_path[target_key] = "generated_jpg"
        for item in artifacts:
            if not isinstance(item, dict):
                continue
            try:
                relative_path = _import_relative_path(item.get("relativePath"))
            except ValueError:
                continue
            path_key = relative_path.casefold()
            slot = slots_by_path.get(path_key)
            if slot is None and item.get("mediaKind") == "video" and item.get("nodeRole") == "original":
                slot = "mov"
            if slot is None:
                continue
            folder_path = canonical_path(os.path.join(workspace_root, project["relative_path"], *relative_path.split("/")))
            progress = db.execute(
                "SELECT * FROM progress_folders WHERE project_id=? AND folder_path_key=?",
                (project["id"], folder_path.casefold()),
            ).fetchone()
            if progress is None:
                continue
            expected = IMPORT_ARTIFACT_SLOT_SHAPES[slot]
            if (progress["media_kind"], progress["node_role"], progress["artifact_kind"]) != expected:
                continue
            existing = db.execute(
                "SELECT * FROM media_import_artifact_slots WHERE project_id=? AND relative_path_key=?",
                (project["id"], path_key),
            ).fetchone()
            timestamp = int(session["updated_at"] or 0)
            if existing is None:
                db.execute(
                    """INSERT INTO media_import_artifact_slots(
                         project_id,progress_id,import_slot,relative_path_key,created_at,updated_at)
                       VALUES(?,?,?,?,?,?)""",
                    (project["id"], progress["id"], slot, path_key, timestamp, timestamp),
                )
            elif existing["progress_id"] == progress["id"] and existing["import_slot"] == "generated_jpg" and slot == "camera_jpg":
                db.execute(
                    "UPDATE media_import_artifact_slots SET import_slot='camera_jpg',updated_at=? WHERE project_id=? AND progress_id=?",
                    (timestamp, project["id"], progress["id"]),
                )


def _migration_26(db):
    migration_26(db, _table_columns)


def _migration_27(db):
    migration_27(db, _table_columns)


def _migration_28(db):
    return migration_28(db, _table_columns)


def _migration_29(db):
    return migration_29(db)


def _migration_30(db):
    return migration_30(db)


def _migration_31(db):
    return migration_31(db)


def _migration_32(db):
    return migration_32(db, run_compatibility_hooks, _install_progress_purpose_constraints)


def _migration_33(db):
    return migration_33(db)


def _migration_34(db):
    return migration_34(db)


def _ensure_transcode_graph_schema(db):
    """Upgrade graph CHECK constraints without preserving retired video-preview slots."""
    changed = False
    for schema in (row[1] for row in db.execute("PRAGMA database_list").fetchall()):
        quoted_schema = schema.replace('"', '""')
        edge_row = db.execute(
            f'SELECT sql FROM "{quoted_schema}".sqlite_master WHERE type=\'table\' AND name=\'version_graph_edges\''
        ).fetchone()
        if edge_row is not None and "derived_transcode" not in str(edge_row["sql"] or ""):
            references = schema == "main"
            graph_trigger_names = [row[0] for row in db.execute(
                f'''SELECT name FROM "{quoted_schema}".sqlite_master
                    WHERE type='trigger' AND lower(sql) LIKE '%version_graph_edges%' AND sql IS NOT NULL'''
            ).fetchall()]
            for trigger_name in graph_trigger_names:
                quoted_trigger = trigger_name.replace('"', '""')
                db.execute(f'DROP TRIGGER IF EXISTS "{quoted_schema}"."{quoted_trigger}"')
            db.execute(f'DROP TABLE IF EXISTS "{quoted_schema}"."version_graph_edges_transcode_next"')
            db.execute(
                f'''CREATE TABLE "{quoted_schema}"."version_graph_edges_transcode_next"(
                  id TEXT PRIMARY KEY,
                  project_id TEXT NOT NULL {"REFERENCES projects(id) ON DELETE CASCADE" if references else ""},
                  source_progress_id TEXT NOT NULL {"REFERENCES progress_folders(id) ON DELETE CASCADE" if references else ""},
                  target_progress_id TEXT NOT NULL {"REFERENCES progress_folders(id) ON DELETE CASCADE" if references else ""},
                  edge_kind TEXT NOT NULL CHECK(edge_kind IN ('media_companion','derived_preview','derived_transcode','workflow_input')),
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL,
                  UNIQUE(project_id,source_progress_id,target_progress_id,edge_kind)
                )'''
            )
            db.execute(
                f'''INSERT INTO "{quoted_schema}"."version_graph_edges_transcode_next"(
                     id,project_id,source_progress_id,target_progress_id,edge_kind,created_at,updated_at)
                   SELECT id,project_id,source_progress_id,target_progress_id,edge_kind,created_at,updated_at
                   FROM "{quoted_schema}"."version_graph_edges"'''
            )
            db.execute(f'DROP TABLE "{quoted_schema}"."version_graph_edges"')
            db.execute(f'ALTER TABLE "{quoted_schema}"."version_graph_edges_transcode_next" RENAME TO "version_graph_edges"')
            db.execute(f'CREATE INDEX IF NOT EXISTS "{quoted_schema}"."version_graph_edges_source" ON "version_graph_edges"(project_id,source_progress_id,edge_kind)')
            db.execute(f'CREATE INDEX IF NOT EXISTS "{quoted_schema}"."version_graph_edges_target" ON "version_graph_edges"(project_id,target_progress_id,edge_kind)')
            changed = True

        slot_row = db.execute(
            f'SELECT sql FROM "{quoted_schema}".sqlite_master WHERE type=\'table\' AND name=\'media_import_artifact_slots\''
        ).fetchone()
        if slot_row is not None and "video_transcode" not in str(slot_row["sql"] or ""):
            references = schema == "main"
            db.execute(f'DROP TABLE IF EXISTS "{quoted_schema}"."media_import_artifact_slots_transcode_next"')
            db.execute(
                f'''CREATE TABLE "{quoted_schema}"."media_import_artifact_slots_transcode_next"(
                  project_id TEXT NOT NULL {"REFERENCES projects(id) ON DELETE CASCADE" if references else ""},
                  progress_id TEXT NOT NULL {"REFERENCES progress_folders(id) ON DELETE CASCADE" if references else ""},
                  import_slot TEXT NOT NULL CHECK(import_slot IN ('raw','camera_jpg','generated_jpg','mov','video_transcode')),
                  relative_path_key TEXT NOT NULL,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL,
                  PRIMARY KEY(project_id,progress_id),
                  UNIQUE(project_id,relative_path_key)
                )'''
            )
            db.execute(
                f'''INSERT INTO "{quoted_schema}"."media_import_artifact_slots_transcode_next"(
                     project_id,progress_id,import_slot,relative_path_key,created_at,updated_at)
                   SELECT project_id,progress_id,import_slot,relative_path_key,created_at,updated_at
                   FROM "{quoted_schema}"."media_import_artifact_slots"
                   WHERE import_slot IN ('raw','camera_jpg','generated_jpg','mov')'''
            )
            db.execute(f'DROP TABLE "{quoted_schema}"."media_import_artifact_slots"')
            db.execute(f'ALTER TABLE "{quoted_schema}"."media_import_artifact_slots_transcode_next" RENAME TO "media_import_artifact_slots"')
            db.execute(f'CREATE INDEX IF NOT EXISTS "{quoted_schema}"."media_import_artifact_slots_kind" ON "media_import_artifact_slots"(project_id,import_slot,updated_at,progress_id)')
            db.execute(f'DROP TRIGGER IF EXISTS "{quoted_schema}"."media_import_artifact_slots_validate_insert"')
            db.execute(f'DROP TRIGGER IF EXISTS "{quoted_schema}"."media_import_artifact_slots_validate_update"')
            db.execute(
                f'''CREATE TRIGGER "{quoted_schema}"."media_import_artifact_slots_validate_insert"
                    BEFORE INSERT ON "media_import_artifact_slots" WHEN NOT EXISTS(
                      SELECT 1 FROM progress_folders progress
                      WHERE progress.id=NEW.progress_id AND progress.project_id=NEW.project_id
                    ) BEGIN SELECT RAISE(ABORT,'import artifact slot project mismatch'); END'''
            )
            db.execute(
                f'''CREATE TRIGGER "{quoted_schema}"."media_import_artifact_slots_validate_update"
                    BEFORE UPDATE OF project_id,progress_id ON "media_import_artifact_slots" WHEN NOT EXISTS(
                      SELECT 1 FROM progress_folders progress
                      WHERE progress.id=NEW.progress_id AND progress.project_id=NEW.project_id
                    ) BEGIN SELECT RAISE(ABORT,'import artifact slot project mismatch'); END'''
            )
            changed = True
    if changed:
        _install_progress_purpose_constraints(db)
    return changed


def _can_run_full_integrity_check(db) -> bool:
    """Return whether every table referenced by the cross-domain checks is mounted."""
    if not _meta_value(db, "domain_storage_revision"):
        return True
    attached = {row[1] for row in db.execute("PRAGMA database_list").fetchall()}
    return set(DOMAIN_TABLES).issubset(attached)


MIGRATIONS = {
    11: _migration_11,
    12: _migration_12,
    13: _migration_13,
    14: _migration_14,
    15: _migration_15,
    16: _migration_16,
    17: _migration_17,
    18: _migration_18,
    19: _migration_19,
    20: _migration_20,
    21: _migration_21,
    22: _migration_22,
    23: _migration_23,
    24: _migration_24,
    25: _migration_25,
    26: _migration_26,
    27: _migration_27,
    28: _migration_28,
    29: _migration_29,
    30: _migration_30,
    31: _migration_31,
    32: _migration_32,
    33: _migration_33,
    34: _migration_34,
}


def _check_integrity(db, force: bool = False):
    now = int(time.time() * 1000)
    last_check = int(_meta_value(db, "last_integrity_check_at") or 0)
    if not force and now - last_check < INTEGRITY_CHECK_INTERVAL_MS:
        return
    quick_check = [row[0] for row in db.execute("PRAGMA quick_check").fetchall()]
    foreign_key_errors = [*db.execute("PRAGMA foreign_key_check").fetchall()]
    compatibility_integrity = run_compatibility_hooks("integrity", db)
    for report in compatibility_integrity:
        foreign_key_errors.extend(report.get("foreignKeyErrors") or [])
    business_checks = {
        "photos.current_version": """SELECT COUNT(*) FROM photos WHERE current_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM versions WHERE versions.id=photos.current_version_id AND versions.photo_id=photos.id AND versions.is_deleted=0)""",
        "versions.parent": """SELECT COUNT(*) FROM versions child WHERE parent_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM versions parent WHERE parent.id=child.parent_version_id AND parent.photo_id=child.photo_id)""",
        "version_batches.parent": """SELECT COUNT(*) FROM version_batches child WHERE parent_batch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM version_batches parent WHERE parent.id=child.parent_batch_id AND parent.project_id=child.project_id)""",
        "progress_folders.parent": """SELECT COUNT(*) FROM progress_folders child WHERE parent_progress_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM progress_folders parent WHERE parent.id=child.parent_progress_id AND parent.project_id=child.project_id AND parent.media_kind=child.media_kind)""",
        "progress_folders.v2_shape": """SELECT COUNT(*) FROM progress_folders WHERE
          node_role NOT IN ('original','progress','selection','artifact','workflow','broll')
          OR (relation_kind IS NOT NULL AND relation_kind NOT IN ('main','auxiliary'))
          OR (artifact_kind IS NOT NULL AND (length(artifact_kind)>128 OR artifact_kind='' OR artifact_kind GLOB '*[^A-Za-z0-9._:-]*'))
          OR (parent_progress_id IS NULL) != (relation_kind IS NULL)
          OR (node_role='original' AND (parent_progress_id IS NOT NULL OR artifact_kind NOT IN ('companion')))
          OR (node_role='selection' AND (relation_kind!='auxiliary' OR artifact_kind IS NOT NULL))
          OR (node_role='progress' AND ((parent_progress_id IS NOT NULL AND relation_kind!='main') OR artifact_kind IS NOT NULL))
          OR (node_role='progress' AND media_kind NOT IN ('image','video'))
          OR (node_role='artifact' AND (parent_progress_id IS NOT NULL OR relation_kind IS NOT NULL OR artifact_kind NOT IN ('companion','preview','transcode')))
          OR (node_role='workflow' AND (parent_progress_id IS NOT NULL OR relation_kind IS NOT NULL OR artifact_kind IS NULL))
          OR (node_role='broll' AND (media_kind!='mixed' OR parent_progress_id IS NOT NULL OR relation_kind IS NOT NULL OR artifact_kind IS NOT NULL))""",
        "progress_folders.v2_policy": """SELECT COUNT(*) FROM progress_folders WHERE
          tracking_state NOT IN ('disabled','pending_compare','pending_confirm','committing','ready','stale','needs_repair')
          OR tracking_enabled NOT IN (0,1) OR rename_from_parent NOT IN (0,1) OR copy_missing_from_parent NOT IN (0,1)
          OR ((node_role IN ('original','artifact','workflow','broll') OR relation_kind='auxiliary') AND
              (tracking_enabled!=0 OR rename_from_parent!=0 OR copy_missing_from_parent!=0 OR tracking_state!='disabled'))
          OR (tracking_enabled=0 AND (rename_from_parent!=0 OR copy_missing_from_parent!=0))""",
        "progress_folders.v2_parent_role": """SELECT COUNT(*) FROM progress_folders child
          WHERE child.parent_progress_id IS NOT NULL AND NOT EXISTS(
            SELECT 1 FROM progress_folders parent WHERE parent.id=child.parent_progress_id
              AND parent.project_id=child.project_id AND parent.media_kind=child.media_kind
              AND ((parent.node_role='original' AND parent.artifact_kind IS NULL)
                OR (parent.node_role='progress' AND parent.parent_progress_id IS NOT NULL AND parent.relation_kind='main')))""",
        "version_graph_edges.owner_kind": """SELECT COUNT(*) FROM version_graph_edges edge
          WHERE edge.edge_kind NOT IN ('media_companion','derived_preview','derived_transcode','workflow_input') OR NOT EXISTS(
            SELECT 1 FROM progress_folders source JOIN progress_folders target ON target.id=edge.target_progress_id
            WHERE source.id=edge.source_progress_id AND source.project_id=edge.project_id
              AND target.project_id=edge.project_id AND source.media_kind=target.media_kind
              AND ((edge.edge_kind='media_companion' AND source.node_role='original' AND source.artifact_kind IS NULL AND target.node_role='original' AND target.artifact_kind='companion')
                OR (edge.edge_kind='derived_preview' AND (source.node_role='original' AND source.artifact_kind IS NULL OR source.node_role='progress' AND source.parent_progress_id IS NOT NULL AND source.relation_kind='main') AND target.node_role='artifact' AND target.artifact_kind='preview')
                OR (edge.edge_kind='derived_transcode' AND (source.node_role='original' AND source.artifact_kind IS NULL OR source.node_role='progress' AND source.parent_progress_id IS NOT NULL AND source.relation_kind='main') AND target.node_role='artifact' AND target.artifact_kind='transcode')
                OR (edge.edge_kind='workflow_input' AND ((source.node_role IN ('selection','workflow') AND target.node_role='progress' AND target.parent_progress_id IS NOT NULL AND target.relation_kind='main') OR (source.node_role='progress' AND source.parent_progress_id IS NOT NULL AND source.relation_kind='main' AND target.node_role='workflow' AND json_extract(target.source_metadata_json,'$.parentCapability')='workflow-input'))))
          )""",
        "media_import_artifact_slots.owner_kind": """SELECT COUNT(*) FROM media_import_artifact_slots slot
          WHERE NOT EXISTS(SELECT 1 FROM progress_folders progress WHERE progress.id=slot.progress_id
            AND progress.project_id=slot.project_id AND (
              (slot.import_slot='raw' AND progress.media_kind='image' AND progress.node_role='original' AND progress.artifact_kind IS NULL)
              OR (slot.import_slot='camera_jpg' AND progress.media_kind='image' AND progress.node_role='original' AND progress.artifact_kind='companion')
              OR (slot.import_slot='generated_jpg' AND progress.media_kind='image' AND progress.node_role='artifact' AND progress.artifact_kind='preview')
              OR (slot.import_slot='mov' AND progress.media_kind='video' AND progress.node_role='original' AND progress.artifact_kind IS NULL)
              OR (slot.import_slot='video_transcode' AND progress.media_kind='video' AND progress.node_role='artifact' AND progress.artifact_kind='transcode')
            ))""",
        "batch_items.owner": """SELECT COUNT(*) FROM batch_items item WHERE NOT EXISTS(SELECT 1 FROM version_batches batch JOIN photos ON photos.project_id=batch.project_id JOIN versions ON versions.photo_id=photos.id WHERE batch.id=item.batch_id AND photos.id=item.photo_id AND versions.id=item.version_id)""",
    }
    for report in compatibility_integrity:
        business_checks.update(report.get("businessChecks") or {})
    business_errors = {name: db.execute(query).fetchone()[0] for name, query in business_checks.items()}
    progress_cycles = _progress_relation_cycles(db)
    if progress_cycles:
        business_errors["progress_folders.v2_cycle"] = len(progress_cycles)
    version_graph_cycle_nodes = _version_graph_cycle_nodes(db)
    if version_graph_cycle_nodes:
        business_errors["version_graph_edges.cycle"] = len(version_graph_cycle_nodes)
    business_errors = {name: count for name, count in business_errors.items() if count}
    compatibility_errors = [report.get("quickCheck") for report in compatibility_integrity if report.get("quickCheck") != ["ok"]]
    if quick_check != ["ok"] or compatibility_errors or foreign_key_errors or business_errors:
        raise RuntimeError(
            f"数据库完整性检查失败：quick_check={quick_check[:3]}，compatibility_errors={compatibility_errors[:3]}，foreign_key_errors={len(foreign_key_errors)}，business_errors={business_errors}"
        )
    _set_meta(db, "last_integrity_check_at", now)
    _set_meta(db, "last_integrity_check_result", "ok")
    db.commit()


def _connect_impl(root: str, database: str, include_domains=None, include_compatibility: bool = False, _staging_init: bool = False):
    root = os.path.abspath(root)
    database = os.path.abspath(database)
    os.makedirs(os.path.dirname(database), exist_ok=True)
    _recover_interrupted_migration(database)
    _resume_media_operation_files(database)
    if not _staging_init and _database_needs_initialization(database):
        _initialize_database_staged(root, database)
        return connect(root, database, include_domains=include_domains, include_compatibility=include_compatibility, _staging_init=True)
    db = sqlite3.connect(database, timeout=SQLITE_BUSY_TIMEOUT_MS / 1000)
    for attempt in _CONNECT_ATTEMPTS:
        attempt.append(db)
    db.row_factory = sqlite3.Row
    # The catalog and media workers intentionally share this database. Give a
    # short-lived writer time to finish instead of surfacing SQLITE_BUSY to the
    # UI, and avoid requesting the WAL transition again after initialization:
    # changing journal mode itself needs an exclusive database lock.
    db.execute(f"PRAGMA busy_timeout={SQLITE_BUSY_TIMEOUT_MS}")
    journal_mode = db.execute("PRAGMA journal_mode").fetchone()[0]
    if str(journal_mode).casefold() != "wal":
        db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    existing_tables = {
        row[0] for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    }
    # Normal commands used to run the complete CREATE TABLE / CREATE INDEX
    # script below on every connection. Even though those statements are
    # idempotent, SQLite still needs the schema writer lock, so merely opening
    # the version tree could collide with a background media scan. A database
    # whose schema and one-time graph revisions are current can be used
    # immediately without performing any write.
    schema_value = _meta_value(db, "schema_version") if "meta" in existing_tables else None
    schema_version = int(schema_value or 0)
    is_fresh = not (existing_tables - {"meta"})
    if schema_version > TARGET_SCHEMA_VERSION:
        db.close()
        raise RuntimeError(f"数据库版本 {schema_version} 高于当前软件支持的 {TARGET_SCHEMA_VERSION}")
    schema_is_current = (
        not is_fresh
        and schema_version == TARGET_SCHEMA_VERSION
        and _meta_value(db, "schema_24_graph_revision") == "3"
        and _meta_value(db, "progress_purpose_constraint_revision") == PROGRESS_PURPOSE_CONSTRAINT_REVISION
        and _meta_value(db, "selection_mainline_repair_revision") == SELECTION_MAINLINE_REPAIR_REVISION
        and _meta_value(db, "version_tree_default_layout_revision") == VERSION_TREE_DEFAULT_LAYOUT_REVISION
        and _meta_value(db, "transcode_graph_schema_revision") == TRANSCODE_GRAPH_SCHEMA_REVISION
        and _meta_value(db, "workspace_root") == root
    )
    if include_compatibility or include_domains is True:
        requested_domains = tuple(DOMAIN_TABLES)
    elif isinstance(include_domains, (tuple, list, set, frozenset)):
        requested_domains = tuple(dict.fromkeys(include_domains))
    elif include_domains is None and "meta" in existing_tables and _meta_value(db, "domain_storage_revision"):
        requested_domains = tuple(DOMAIN_TABLES)
    else:
        requested_domains = ()
    pending_purge = "meta" in existing_tables and bool(_meta_value(db, "purge_journal_v1"))
    if pending_purge:
        requested_domains = tuple(DOMAIN_TABLES)
        include_compatibility = True
    if schema_is_current:
        domain_migrated = False
        purpose_constraints_migrated = False
        transcode_graph_migrated = False
        legacy_parent_revision_recorded = False
        relocation_migrated = False
        try:
            _migration_34(db)
            run_compatibility_hooks("prepare_connection", db, database, False)
            if requested_domains:
                attach_workspace_domain_storage(db, database, requested_domains)
                domain_migrated = _migration_28(db)
                _migration_30(db)
                _migration_32(db)
                relocation_migrated = _migration_33(db)
            if include_compatibility:
                run_compatibility_hooks("prepare_connection", db, database, True)
            # The catalog connection can record the global revision before the
            # detached versioning database is attached. Always inspect the
            # actual mounted graph tables so that marker ordering cannot leave
            # their CHECK constraints on the retired edge/import-slot values.
            transcode_graph_migrated = _ensure_transcode_graph_schema(db)
            if _meta_value(db, "legacy_progress_parent_repair_revision") != LEGACY_PROGRESS_PARENT_REPAIR_REVISION:
                found_versioning, _repairs = _repair_legacy_progress_structural_roots(db)
                if found_versioning:
                    _set_meta(db, "legacy_progress_parent_repair_revision", LEGACY_PROGRESS_PARENT_REPAIR_REVISION)
                    legacy_parent_revision_recorded = True
            if not _progress_purpose_constraints_current(db):
                purpose_constraints_migrated = _install_progress_purpose_constraints(db)
                if purpose_constraints_migrated:
                    _set_meta(db, "progress_purpose_constraint_revision", PROGRESS_PURPOSE_CONSTRAINT_REVISION)
        except Exception:
            db.close()
            raise
        if domain_migrated or purpose_constraints_migrated or transcode_graph_migrated or legacy_parent_revision_recorded or relocation_migrated:
            db.commit()
            if _can_run_full_integrity_check(db):
                _check_integrity(db, force=True)
        if pending_purge:
            _resume_purge_journal(db)
        return db
    backup_path = None
    if not is_fresh:
        backup_path = _backup_before_migration(db, database, schema_version)
    db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    db.commit()
    # Migrations that reconcile trusted relative paths must use the workspace
    # root from this connection, including after the workspace has moved.
    _set_meta(db, "workspace_root", root)
    db.executescript("""
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL COLLATE NOCASE UNIQUE,
            status TEXT NOT NULL,
            relative_path TEXT NOT NULL UNIQUE,
            filesystem_id TEXT,
            is_deleted INTEGER NOT NULL DEFAULT 0,
            availability TEXT NOT NULL DEFAULT 'available' CHECK(availability IN ('available','missing')),
            missing_since INTEGER,
            missing_checks INTEGER NOT NULL DEFAULT 0 CHECK(missing_checks>=0),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            extra_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS project_properties (
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            key TEXT NOT NULL,
            value_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (project_id, key)
        );
        CREATE TABLE IF NOT EXISTS project_tags (
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            tag TEXT NOT NULL,
            value_json TEXT NOT NULL DEFAULT 'true',
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (project_id, tag)
        );
        CREATE TABLE IF NOT EXISTS photos (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            media_type TEXT NOT NULL,
            original_name TEXT NOT NULL,
            display_name TEXT NOT NULL,
            current_version_id TEXT,
            original_file_path TEXT NOT NULL,
            original_file_id TEXT,
            original_fingerprint TEXT,
            capture_time INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            is_deleted INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS photos_project ON photos(project_id, is_deleted);
        CREATE TABLE IF NOT EXISTS versions (
            id TEXT PRIMARY KEY,
            photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
            parent_version_id TEXT REFERENCES versions(id),
            version_number INTEGER NOT NULL,
            version_name TEXT NOT NULL,
            version_type TEXT NOT NULL DEFAULT 'custom',
            file_path TEXT NOT NULL,
            file_path_key TEXT NOT NULL,
            file_id TEXT,
            file_fingerprint TEXT,
            file_size INTEGER NOT NULL DEFAULT 0,
            file_modified_at INTEGER,
            thumbnail_path TEXT,
            author TEXT,
            note TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'draft',
            is_current INTEGER NOT NULL DEFAULT 0,
            is_final INTEGER NOT NULL DEFAULT 0,
            file_missing INTEGER NOT NULL DEFAULT 0,
            content_changed INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            is_deleted INTEGER NOT NULL DEFAULT 0,
            UNIQUE(photo_id, version_number)
        );
        CREATE INDEX IF NOT EXISTS versions_photo ON versions(photo_id, version_number);
        CREATE INDEX IF NOT EXISTS versions_parent ON versions(parent_version_id);
        CREATE INDEX IF NOT EXISTS versions_file_identity ON versions(file_id);
        CREATE INDEX IF NOT EXISTS versions_file_path_key ON versions(file_path_key);
        CREATE INDEX IF NOT EXISTS versions_fingerprint ON versions(file_fingerprint);
        CREATE TABLE IF NOT EXISTS version_batches (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL,
            display_name TEXT NOT NULL,
            source_folder_path TEXT NOT NULL,
            source_folder_path_key TEXT NOT NULL,
            source_folder_id TEXT,
            parent_batch_id TEXT REFERENCES version_batches(id),
            import_key TEXT UNIQUE,
            status TEXT NOT NULL DEFAULT 'ready',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(project_id, sequence)
        );
        CREATE INDEX IF NOT EXISTS version_batches_project ON version_batches(project_id, sequence);
        CREATE INDEX IF NOT EXISTS version_batches_parent ON version_batches(parent_batch_id);
        CREATE INDEX IF NOT EXISTS version_batches_folder ON version_batches(project_id, source_folder_path_key);
        CREATE INDEX IF NOT EXISTS version_batches_folder_id ON version_batches(project_id, source_folder_id);
        CREATE TABLE IF NOT EXISTS progress_folders (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            media_kind TEXT NOT NULL,
            version_key TEXT NOT NULL,
            parent_progress_id TEXT REFERENCES progress_folders(id),
            display_name TEXT NOT NULL,
            folder_path TEXT NOT NULL,
            folder_path_key TEXT NOT NULL,
            folder_id TEXT,
            external_link_relative_path TEXT,
            node_role TEXT NOT NULL DEFAULT 'progress',
            artifact_kind TEXT,
            source_metadata_json TEXT NOT NULL DEFAULT '{}',
            relation_kind TEXT,
            tracking_enabled INTEGER NOT NULL DEFAULT 0,
            tracking_state TEXT NOT NULL DEFAULT 'disabled',
            rename_from_parent INTEGER NOT NULL DEFAULT 0,
            copy_missing_from_parent INTEGER NOT NULL DEFAULT 0,
            last_tracked_at INTEGER,
            tracking_snapshot_json TEXT NOT NULL DEFAULT '{}',
            folder_signature TEXT,
            missing_since INTEGER,
            tombstone_json TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(project_id, media_kind, version_key)
        );
        CREATE INDEX IF NOT EXISTS progress_folders_project ON progress_folders(project_id, media_kind, version_key);
        CREATE INDEX IF NOT EXISTS progress_folders_parent ON progress_folders(parent_progress_id);
        CREATE INDEX IF NOT EXISTS progress_folders_identity ON progress_folders(project_id, folder_id);
        CREATE TABLE IF NOT EXISTS batch_file_operations (
            id TEXT PRIMARY KEY,
            batch_id TEXT NOT NULL REFERENCES version_batches(id) ON DELETE CASCADE,
            operation_type TEXT NOT NULL CHECK(operation_type IN ('rename','copy')),
            source_path TEXT NOT NULL,
            target_path TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','succeeded','failed','skipped')),
            attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
            error TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(batch_id, operation_type, source_path, target_path)
        );
        CREATE INDEX IF NOT EXISTS batch_file_operations_batch
          ON batch_file_operations(batch_id, status, created_at);
        CREATE TABLE IF NOT EXISTS batch_items (
            id TEXT PRIMARY KEY,
            batch_id TEXT NOT NULL REFERENCES version_batches(id) ON DELETE CASCADE,
            photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
            version_id TEXT NOT NULL REFERENCES versions(id),
            source_name TEXT NOT NULL,
            source_path TEXT NOT NULL,
            source_path_key TEXT NOT NULL,
            source_file_id TEXT,
            source_fingerprint TEXT,
            match_method TEXT NOT NULL DEFAULT 'new',
            match_distance REAL,
            confidence TEXT NOT NULL DEFAULT '',
            review_status TEXT NOT NULL DEFAULT 'confirmed',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(batch_id, version_id),
            UNIQUE(batch_id, source_path_key)
        );
        CREATE INDEX IF NOT EXISTS batch_items_photo ON batch_items(photo_id, batch_id);
        CREATE INDEX IF NOT EXISTS batch_items_batch ON batch_items(batch_id);
        CREATE INDEX IF NOT EXISTS batch_items_version ON batch_items(version_id);
        CREATE INDEX IF NOT EXISTS batch_items_source_file ON batch_items(source_file_id);
        CREATE TABLE IF NOT EXISTS file_records (
            id TEXT PRIMARY KEY,
            owner_type TEXT NOT NULL CHECK(owner_type='version'),
            owner_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
            current_path TEXT NOT NULL,
            file_name TEXT NOT NULL,
            extension TEXT NOT NULL,
            windows_file_id TEXT,
            volume_id TEXT,
            file_size INTEGER NOT NULL CHECK(file_size>=0),
            modified_at INTEGER,
            quick_hash TEXT,
            full_hash TEXT,
            missing INTEGER NOT NULL DEFAULT 0 CHECK(missing IN (0,1)),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(owner_type, owner_id)
        );
        CREATE TABLE IF NOT EXISTS version_compare_history (
            id TEXT PRIMARY KEY,
            photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
            left_version_id TEXT NOT NULL REFERENCES versions(id),
            right_version_id TEXT NOT NULL REFERENCES versions(id),
            compare_mode TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS version_compare_history_photo ON version_compare_history(photo_id);
        CREATE INDEX IF NOT EXISTS version_compare_history_left ON version_compare_history(left_version_id);
        CREATE INDEX IF NOT EXISTS version_compare_history_right ON version_compare_history(right_version_id);
        CREATE TABLE IF NOT EXISTS undo_records (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'ready',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS undo_records_ready ON undo_records(state, created_at DESC);
    """)
    if is_fresh:
        try:
            with db:
                _migration_13(db)
                _migration_18(db)
                _migration_19(db)
                _migration_20(db)
                _migration_21(db)
                _migration_22(db)
                _migration_23(db)
                _migration_24(db)
                _migration_25(db)
                _migration_26(db)
                _migration_27(db)
                _migration_28(db)
                _migration_29(db)
                _migration_30(db)
                _migration_32(db)
                _migration_33(db)
                _migration_34(db)
                _set_meta(db, "schema_version", TARGET_SCHEMA_VERSION)
        except Exception:
            db.close()
            raise
    else:
        try:
            for next_version in range(schema_version + 1, TARGET_SCHEMA_VERSION + 1):
                migration = MIGRATIONS.get(next_version)
                if migration is None:
                    raise RuntimeError(f"缺少数据库迁移：{next_version}")
                with db:
                    migration(db)
                    _set_meta(db, "schema_version", next_version)
        except Exception:
            db.close()
            raise
    # Schema 24 was still under active development when import graph sessions
    # and original/companion nodes were added. Apply this idempotent revision
    # once so databases opened by an earlier schema-24 build are upgraded too.
    if _meta_value(db, "schema_24_graph_revision") != "3":
        with db:
            _migration_24(db)
            _set_meta(db, "schema_24_graph_revision", "3")
    # Early V2 builds stored the first ordinary progress structurally below a
    # selection. The V2 graph model requires the ordinary progress to remain on
    # the original's main chain and represents selection participation with a
    # supplemental workflow_input edge. Repair that invalid shape before an
    # integrity check can reject the database.
    if _meta_value(db, "selection_mainline_repair_revision") != SELECTION_MAINLINE_REPAIR_REVISION:
        with db:
            project_ids = [row[0] for row in db.execute("SELECT id FROM projects WHERE is_deleted=0").fetchall()]
            for project_id in project_ids:
                repair_selection_workflow_mainlines(db, project_id)
            _set_meta(db, "selection_mainline_repair_revision", SELECTION_MAINLINE_REPAIR_REVISION)
    # Layout revision 2 changes the canonical tree from stacked legacy lanes to
    # left-to-right media mainlines. Persisted coordinates have no auto/manual
    # provenance, so invalidate them once and let the revision-safe layout API
    # reject saves from pages that still hold an older layout revision.
    if _meta_value(db, "version_tree_default_layout_revision") != VERSION_TREE_DEFAULT_LAYOUT_REVISION:
        with db:
            db.execute("DELETE FROM version_tree_layouts")
            _set_meta(db, "version_tree_default_layout_revision", VERSION_TREE_DEFAULT_LAYOUT_REVISION)
    try:
        if requested_domains:
            attach_workspace_domain_storage(db, database, requested_domains)
            _migration_28(db)
            _migration_30(db)
            _migration_32(db)
            _migration_33(db)
            _migration_34(db)
        if include_compatibility:
            run_compatibility_hooks("prepare_connection", db, database, True)
    except Exception:
        db.close()
        raise
    with db:
        _ensure_transcode_graph_schema(db)
        _set_meta(db, "transcode_graph_schema_revision", TRANSCODE_GRAPH_SCHEMA_REVISION)
        if _meta_value(db, "legacy_progress_parent_repair_revision") != LEGACY_PROGRESS_PARENT_REPAIR_REVISION:
            found_versioning, _repairs = _repair_legacy_progress_structural_roots(db)
            if found_versioning:
                _set_meta(db, "legacy_progress_parent_repair_revision", LEGACY_PROGRESS_PARENT_REPAIR_REVISION)
        purpose_constraints_ready = _progress_purpose_constraints_current(db)
        if not purpose_constraints_ready:
            purpose_constraints_ready = _install_progress_purpose_constraints(db)
        if purpose_constraints_ready:
            _set_meta(db, "progress_purpose_constraint_revision", PROGRESS_PURPOSE_CONSTRAINT_REVISION)
    _set_meta(db, "workspace_root", root)
    if backup_path:
        _set_meta(db, "last_migration_backup", backup_path)
    db.commit()
    run_compatibility_hooks("prepare_connection", db, database, False)
    # A fresh database and a migration must be verified before it is exposed.
    # Routine daily maintenance is dispatched by Electron on a separate worker
    # so opening the project list never waits for a full integrity scan/backup.
    if backup_path or is_fresh:
        if _can_run_full_integrity_check(db):
            _check_integrity(db, force=True)
        elif db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise RuntimeError("目录数据库完整性检查失败")
    if backup_path:
        _complete_migration_journal(database)
    if pending_purge:
        _resume_purge_journal(db)
    return db


def connect(root: str, database: str, include_domains=None, include_compatibility: bool = False, _staging_init: bool = False):
    attempt = []
    _CONNECT_ATTEMPTS.append(attempt)
    try:
        return _connect_impl(root, database, include_domains, include_compatibility, _staging_init)
    except Exception:
        for connection in reversed(attempt):
            try: connection.close()
            except sqlite3.Error: pass
        raise
    finally:
        _CONNECT_ATTEMPTS.pop()


def connect_read_only(database: str, domains=()):
    """Open the catalog without schema writes so WAL readers never need the writer slot."""
    database = os.path.abspath(database)
    if os.path.isfile(_migration_journal_path(database)) or not os.path.isfile(database):
        raise DatabaseWriteRequired("目录数据库需要迁移恢复或初始化")
    uri = f"{Path(database).resolve().as_uri()}?mode=ro"
    db = sqlite3.connect(uri, uri=True, timeout=SQLITE_BUSY_TIMEOUT_MS / 1000)
    try:
        db.row_factory = sqlite3.Row
        db.execute(f"PRAGMA busy_timeout={SQLITE_BUSY_TIMEOUT_MS}")
        core_tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        if not {"meta", "projects"} <= core_tables:
            raise DatabaseWriteRequired("目录数据库 schema 尚未初始化")
        schema = db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        if not schema or int(schema[0]) != TARGET_SCHEMA_VERSION:
            raise DatabaseWriteRequired("目录数据库 schema 需要迁移")
        if _meta_value(db, "purge_journal_v1") or _meta_value(db, "media_operation_journal_v1"):
            raise DatabaseWriteRequired("目录数据库存在待重放 operation journal")
        for domain in tuple(dict.fromkeys(domains or ())):
            domain_path = database_path_for_workspace_database(database, domain)
            if not os.path.isfile(domain_path):
                raise DatabaseWriteRequired(f"只读业务域尚未初始化：{domain}")
            domain_uri = f"{Path(domain_path).resolve().as_uri()}?mode=ro"
            db.execute(f'ATTACH DATABASE ? AS "{domain}"', (domain_uri,))
            tables = {row[0] for row in db.execute(f'SELECT name FROM "{domain}".sqlite_master WHERE type=\'table\'').fetchall()}
            required = {"meta", *(DOMAIN_TABLES.get(domain) or ())}
            if not required <= tables:
                raise DatabaseWriteRequired(f"只读业务域 schema 不完整：{domain}")
            domain_schema = db.execute(f'SELECT value FROM "{domain}".meta WHERE key=\'schema_version\'').fetchone()
            identity = db.execute(f'SELECT value FROM "{domain}".meta WHERE key=\'domain_identity\'').fetchone()
            if not domain_schema or int(domain_schema[0]) != 1 or not identity or identity[0] != domain:
                raise DatabaseWriteRequired(f"只读业务域需要迁移：{domain}")
        db.execute("PRAGMA query_only=ON")
        return db
    except Exception:
        db.close()
        raise


def database_needs_initialization(database: str) -> bool:
    if not os.path.isfile(database):
        return True
    try:
        db = connect_read_only(database)
        try:
            row = db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
            return row is None or int(row["value"] or 0) != TARGET_SCHEMA_VERSION
        finally:
            db.close()
    except (sqlite3.Error, ValueError):
        return True


# Direct Python callers retain this helper, but it now has the same transaction
# boundaries as Electron's split protocol.


def serialize_batch(row):
    return {
        "id": row["id"], "projectId": row["project_id"], "sequence": row["sequence"],
        "displayName": row["display_name"], "sourceFolderPath": row["source_folder_path"],
        "parentBatchId": row["parent_batch_id"], "parentSequence": row["parent_sequence"],
        "status": row["status"], "itemCount": row["item_count"],
        "matchedCount": row["matched_count"], "newCount": row["new_count"],
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }


def normalize_source_metadata(value) -> str:
    if value is None:
        return "{}"
    if not isinstance(value, dict) or set(value) - {"category", "role", "displayName", "componentId", "parentCapability"}:
        raise ValueError("无效的来源元数据")
    normalized = {}
    for key, item in value.items():
        if not isinstance(item, str) or not item.strip() or len(item) > 128 or any(ord(character) < 32 for character in item):
            raise ValueError("无效的来源元数据")
        normalized[key] = item.strip()
    if normalized and "category" not in normalized:
        raise ValueError("来源元数据必须指定类别")
    if normalized.get("parentCapability") not in (None, "structural", "workflow-input", "none"):
        raise ValueError("无效的来源父级能力")
    return json.dumps(normalized, ensure_ascii=False, separators=(",", ":"))


def serialize_progress(row):
    tracking_state = row["tracking_state"] if "tracking_state" in row.keys() else ("ready" if row["tracking_enabled"] else "disabled")
    folder_missing = row["missing_since"] is not None if "missing_since" in row.keys() else not os.path.isdir(row["folder_path"])
    missing_since = row["missing_since"] if "missing_since" in row.keys() else None
    return {
        "id": row["id"], "projectId": row["project_id"], "mediaKind": row["media_kind"],
        "versionKey": row["version_key"], "parentProgressId": row["parent_progress_id"],
        "parentVersionKey": row["parent_version_key"], "displayName": row["display_name"],
        "folderPath": row["folder_path"], "folderId": row["folder_id"] if "folder_id" in row.keys() else None, "folderMissing": folder_missing,
        "missingSince": missing_since if folder_missing else None,
        "nodeRole": row["node_role"] if "node_role" in row.keys() else "progress",
        "artifactKind": row["artifact_kind"] if "artifact_kind" in row.keys() else None,
        "sourceMetadata": (json.loads(row["source_metadata_json"] or "{}") or None) if "source_metadata_json" in row.keys() else None,
        "relationKind": row["relation_kind"] if "relation_kind" in row.keys() else ("main" if row["parent_progress_id"] else None),
        "trackingEnabled": bool(row["tracking_enabled"]),
        "renameFromParent": bool(row["rename_from_parent"]) if "rename_from_parent" in row.keys() else False,
        "copyMissingFromParent": bool(row["copy_missing_from_parent"]) if "copy_missing_from_parent" in row.keys() else False,
        "trackingState": tracking_state,
        "lastTrackedAt": row["last_tracked_at"] if "last_tracked_at" in row.keys() else None,
        "trackingSnapshot": json.loads(row["tracking_snapshot_json"] or "{}") if "tracking_snapshot_json" in row.keys() else {},
        "folderSignature": row["folder_signature"] if "folder_signature" in row.keys() else None,
        "tombstone": json.loads(row["tombstone_json"] or "{}") if "tombstone_json" in row.keys() else {},
        "repairBatchId": row["repair_batch_id"] if "repair_batch_id" in row.keys() else None,
        "pendingOperationCount": int(row["pending_operation_count"] or 0) if "pending_operation_count" in row.keys() else 0,
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }


def progress_rows(db, project_id: str, include_missing: bool = True):
    missing_filter = "" if include_missing else " AND progress.missing_since IS NULL"
    return db.execute(
        f"""SELECT progress.*, parent.version_key AS parent_version_key,
           (SELECT batches.id FROM version_batches batches
              WHERE batches.project_id=progress.project_id
                AND batches.source_folder_path_key=progress.folder_path_key
                AND batches.status='needs_repair'
              ORDER BY batches.sequence DESC LIMIT 1) AS repair_batch_id,
           (SELECT COUNT(*) FROM batch_file_operations operations
              JOIN version_batches batches ON batches.id=operations.batch_id
              WHERE batches.project_id=progress.project_id
                AND batches.source_folder_path_key=progress.folder_path_key
                AND batches.status='needs_repair'
                AND operations.status IN ('pending','failed')) AS pending_operation_count
           FROM progress_folders AS progress
           LEFT JOIN progress_folders AS parent ON parent.id=progress.parent_progress_id
           WHERE progress.project_id=?{missing_filter}
           ORDER BY progress.media_kind, progress.created_at, progress.version_key""",
        (project_id,),
    ).fetchall()


def sync_progress_folder_locations(root: str, db, project, commit: bool = True):
    project_path = canonical_path(os.path.join(os.path.abspath(root), project["relative_path"]))
    existing = progress_rows(db, project["id"])
    local_existing = existing
    by_identity = {row["folder_id"]: row for row in local_existing if row["folder_id"]}
    by_path = {row["folder_path_key"]: row for row in local_existing}
    timestamp = int(time.time() * 1000)
    if not os.path.isdir(project_path):
        return
    # Follow root nodes plus same-parent renames of explicitly registered
    # nested nodes. This remains bounded by the number of graph nodes and never
    # turns progress refresh into a recursive project-wide scan.
    scan_directories = {project_path}
    for row in local_existing:
        parent_directory = canonical_path(os.path.dirname(row["folder_path"]))
        if is_project_descendant(parent_directory, project_path) and os.path.isdir(parent_directory):
            scan_directories.add(parent_directory)
    project_entries_by_path = {}
    for directory in sorted(scan_directories):
        for entry in os.scandir(directory):
            if entry.is_dir():
                project_entries_by_path[canonical_path(entry.path).casefold()] = entry
    project_entries = list(project_entries_by_path.values())
    entry_locations = [
        (entry, canonical_path(entry.path), directory_identity(entry.path))
        for entry in project_entries
    ]
    present_identities = {identity for _entry, _folder_path, identity in entry_locations if identity}
    # Folder identity survives a rename, so only follow the physical path.
    # The user-facing progress name is independent and must remain unchanged.
    for _entry, folder_path, identity in entry_locations:
        tracked = by_identity.get(identity) if identity else None
        if tracked is None:
            path_match = by_path.get(folder_path.casefold())
            # A directory recreated at the original path gets a new filesystem
            # identity. Rebind it only when the old identity is no longer
            # present elsewhere, otherwise this is a rename plus path reuse.
            if path_match is not None and path_match["folder_id"] not in present_identities:
                tracked = path_match
        if tracked is not None and (tracked["folder_path_key"] != folder_path.casefold()
                                    or tracked["folder_id"] != identity
                                    or tracked["missing_since"] is not None):
            db.execute(
                """UPDATE progress_folders SET folder_path=?,folder_path_key=?,folder_id=?,missing_since=NULL,
                   tombstone_json='{}',updated_at=?
                   WHERE id=?""",
                (folder_path, folder_path.casefold(), identity, timestamp, tracked["id"]),
            )
            # Import graph slots are keyed by a project-relative path. Folder
            # identity is the authority after an external rename, so keep the
            # slot path in the same transaction as the progress-folder move.
            relative_path_key = os.path.relpath(folder_path, project_path).replace("\\", "/").casefold()
            db.execute(
                """UPDATE media_import_artifact_slots SET relative_path_key=?,updated_at=?
                   WHERE project_id=? AND progress_id=?""",
                (relative_path_key, timestamp, project["id"], tracked["id"]),
            )
    for row in progress_rows(db, project["id"]):
        folder_available = os.path.isdir(row["folder_path"])
        if folder_available:
            if row["missing_since"] is not None:
                db.execute(
                    "UPDATE progress_folders SET missing_since=NULL,tombstone_json='{}',updated_at=? WHERE id=?",
                    (timestamp, row["id"]),
                )
        elif row["missing_since"] is None:
            missing_path = row["folder_path"]
            missing_reason = "folder_missing"
            db.execute(
                "UPDATE progress_folders SET missing_since=?,tombstone_json=?,updated_at=? WHERE id=?",
                (timestamp, json.dumps({"reason": missing_reason, "path": missing_path}, ensure_ascii=False), timestamp, row["id"]),
            )
    if commit:
        db.commit()


def sync_legacy_progress_folders(root: str, db, project):
    project_path = canonical_path(os.path.join(os.path.abspath(root), project["relative_path"]))
    timestamp = int(time.time() * 1000)
    discovered = []
    prefixes = (("图片后期_", "image"), ("视频后期_", "video"))
    if not os.path.isdir(project_path):
        return
    project_entries = [entry for entry in os.scandir(project_path) if entry.is_dir()]
    sync_progress_folder_locations(root, db, project)
    existing = progress_rows(db, project["id"])
    by_identity = {row["folder_id"]: row for row in existing if row["folder_id"]}
    by_path = {row["folder_path_key"]: row for row in existing}
    for entry in project_entries:
        for prefix, media_kind in prefixes:
            if not entry.name.startswith(prefix):
                continue
            version_key = entry.name[len(prefix):]
            if not version_key or any(not part.isdigit() for part in version_key.split("_")):
                continue
            discovered.append((len(version_key.split("_")), tuple(int(part) for part in version_key.split("_")), entry, media_kind, version_key))
            break
    discovered.sort(key=lambda item: (item[0], item[1]))
    by_key = {(row["media_kind"], row["version_key"]): row for row in existing}
    for _depth, _parts, entry, media_kind, version_key in discovered:
        folder_path = canonical_path(entry.path)
        identity = directory_identity(folder_path)
        row = by_identity.get(identity) if identity else None
        if row is None:
            row = by_path.get(folder_path.casefold()) or by_key.get((media_kind, version_key))
        parent_key = "_".join(version_key.split("_")[:-1]) or None
        parent = by_key.get((media_kind, parent_key)) if parent_key else None
        if row is not None:
            if row["parent_progress_id"] is None and parent is None:
                # Keep legacy orphan metadata untouched until the user chooses
                # a valid parent or explicitly unregisters the node.
                continue
            db.execute(
                """UPDATE progress_folders SET folder_path=?,folder_path_key=?,folder_id=?,
                   parent_progress_id=COALESCE(parent_progress_id,?),
                   relation_kind=CASE WHEN COALESCE(parent_progress_id,?) IS NULL THEN NULL ELSE 'main' END,
                   missing_since=NULL,updated_at=? WHERE id=?""",
                (folder_path, folder_path.casefold(), identity, parent["id"] if parent else None,
                 parent["id"] if parent else None, timestamp, row["id"]),
            )
        else:
            # A filename is not enough authority to create a structural root.
            # Leave root-level legacy folders ordinary so the user can choose
            # original/progress/broll explicitly in the marking panel.
            if parent is None:
                continue
            progress_id = str(uuid.uuid4())
            db.execute(
                """INSERT INTO progress_folders(id,project_id,media_kind,version_key,parent_progress_id,
                   display_name,folder_path,folder_path_key,folder_id,node_role,relation_kind,
                   tracking_enabled,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?,?,?,'progress',?,0,?,?)""",
                (progress_id, project["id"], media_kind, version_key, parent["id"] if parent else None,
                 entry.name, folder_path, folder_path.casefold(), identity,
                 "main" if parent else None, timestamp, timestamp),
            )
            row = db.execute("SELECT * FROM progress_folders WHERE id=?", (progress_id,)).fetchone()
        by_key[(media_kind, version_key)] = row
        by_path[folder_path.casefold()] = row
        if identity:
            by_identity[identity] = row
    db.commit()


def migrate_legacy_progress_folders_once(root: str, db, project):
    if json.loads(project["extra_json"] or "{}").get("ordinaryFiles"):
        return
    migrated = db.execute(
        "SELECT 1 FROM project_properties WHERE project_id=? AND key=?",
        (project["id"], LEGACY_PROGRESS_MIGRATION_KEY),
    ).fetchone()
    if migrated is not None:
        return
    sync_legacy_progress_folders(root, db, project)
    db.execute(
        "INSERT OR REPLACE INTO project_properties(project_id,key,value_json,updated_at) VALUES(?,?,?,?)",
        (project["id"], LEGACY_PROGRESS_MIGRATION_KEY, "true", int(time.time() * 1000)),
    )
    db.commit()


def register_original_baselines(root: str, db, project):
    if json.loads(project["extra_json"] or "{}").get("ordinaryFiles"):
        return
    """Register conventional baseline folders as explicit original nodes."""
    project_path = canonical_path(os.path.join(os.path.abspath(root), project["relative_path"]))
    if not os.path.isdir(project_path):
        return
    timestamp = int(time.time() * 1000)
    changed = False
    for entry in os.scandir(project_path):
        baseline = entry.name.casefold()
        if not entry.is_dir() or baseline not in {"raw", "jpg", "mov"}:
            continue
        media_kind = "video" if baseline == "mov" else "image"
        folder_path = canonical_path(entry.path)
        identity = directory_identity(folder_path)
        existing = db.execute(
            """SELECT id FROM progress_folders WHERE project_id=? AND (
                 (folder_id IS NOT NULL AND folder_id=?) OR folder_path_key=?)""",
            (project["id"], identity, folder_path.casefold()),
        ).fetchone()
        if existing is not None:
            continue
        db.execute(
            """INSERT INTO progress_folders(
                 id,project_id,media_kind,version_key,parent_progress_id,display_name,folder_path,
                 folder_path_key,folder_id,node_role,relation_kind,tracking_enabled,tracking_state,
                 rename_from_parent,copy_missing_from_parent,created_at,updated_at)
               VALUES(?,?,?,?,NULL,?,?,?,?, 'original',NULL,0,'disabled',0,0,?,?)""",
            (str(uuid.uuid4()), project["id"], media_kind, f"original-{baseline}", entry.name,
             folder_path, folder_path.casefold(), identity, timestamp, timestamp),
        )
        changed = True
    if changed:
        db.commit()


def migrate_legacy_media_workflow_graph_once(root: str, db, project):
    if json.loads(project["extra_json"] or "{}").get("ordinaryFiles"):
        return
    """Reconcile canonical import and producer artifacts into explicit graph records.

    Despite the historical function name this is intentionally repeatable:
    projects can be opened before RAW/JPG/MOV folders are created. It never
    infers main-version relationships and remains bounded to root-level exact
    canonical destinations plus persisted team sources.
    """
    project_path = canonical_path(os.path.join(os.path.abspath(root), project["relative_path"]))
    if not os.path.isdir(project_path):
        return
    timestamp = int(time.time() * 1000)
    directories = {
        entry.name.casefold(): canonical_path(entry.path)
        for entry in os.scandir(project_path)
        if entry.is_dir()
    }

    def node_for_path(folder_path):
        if not folder_path:
            return None
        return db.execute(
            "SELECT * FROM progress_folders WHERE project_id=? AND folder_path_key=?",
            (project["id"], folder_path.casefold()),
        ).fetchone()

    def insert_artifact(folder_path, display_name, media_kind, version_key, node_role, artifact_kind):
        existing = node_for_path(folder_path)
        if existing is not None:
            return existing
        progress_id = str(uuid.uuid4())
        db.execute(
            """INSERT INTO progress_folders(
                 id,project_id,media_kind,version_key,parent_progress_id,display_name,folder_path,
                 folder_path_key,folder_id,node_role,artifact_kind,relation_kind,tracking_enabled,
                 tracking_state,rename_from_parent,copy_missing_from_parent,created_at,updated_at)
               VALUES(?,?,?,?,NULL,?,?,?,?,?,?,NULL,0,'disabled',0,0,?,?)""",
            (progress_id, project["id"], media_kind, version_key, display_name, folder_path,
             folder_path.casefold(), directory_identity(folder_path), node_role, artifact_kind,
             timestamp, timestamp),
        )
        return db.execute("SELECT * FROM progress_folders WHERE id=?", (progress_id,)).fetchone()

    def add_edge(source, target, edge_kind):
        if source is None or target is None:
            return
        existing = db.execute(
            """SELECT 1 FROM version_graph_edges WHERE project_id=? AND source_progress_id=?
               AND target_progress_id=? AND edge_kind=?""",
            (project["id"], source["id"], target["id"], edge_kind),
        ).fetchone()
        if existing is None:
            db.execute(
                """INSERT INTO version_graph_edges(
                     id,project_id,source_progress_id,target_progress_id,edge_kind,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?)""",
                (str(uuid.uuid4()), project["id"], source["id"], target["id"], edge_kind, timestamp, timestamp),
            )

    db.execute("SAVEPOINT legacy_media_workflow_graph")
    try:
        raw = node_for_path(directories.get("raw"))
        jpg = node_for_path(directories.get("jpg"))
        if raw is not None and jpg is not None and raw["node_role"] == "original" and jpg["node_role"] == "original" \
                and jpg["artifact_kind"] in (None, "companion"):
            if jpg["artifact_kind"] is None:
                db.execute("UPDATE progress_folders SET artifact_kind='companion',updated_at=? WHERE id=?", (timestamp, jpg["id"]))
                jpg = db.execute("SELECT * FROM progress_folders WHERE id=?", (jpg["id"],)).fetchone()
            add_edge(raw, jpg, "media_companion")

        mov = node_for_path(directories.get("mov"))
        transcode_path = directories.get("mov_转码")
        if mov is not None and mov["node_role"] == "original" and transcode_path:
            transcode = insert_artifact(
                transcode_path, os.path.basename(transcode_path), "video",
                "transcode-mov", "artifact", "transcode",
            )
            if transcode["node_role"] == "artifact" and transcode["artifact_kind"] == "transcode":
                add_edge(mov, transcode, "derived_transcode")

        run_compatibility_hooks("migrate_workflow_graph", db, project, directories, timestamp, node_for_path, insert_artifact, add_edge)
        db.execute(
            "INSERT OR IGNORE INTO project_properties(project_id,key,value_json,updated_at) VALUES(?,?,?,?)",
            (project["id"], LEGACY_MEDIA_WORKFLOW_MIGRATION_KEY, "true", timestamp),
        )
        db.execute("RELEASE SAVEPOINT legacy_media_workflow_graph")
        db.commit()
    except Exception:
        db.execute("ROLLBACK TO SAVEPOINT legacy_media_workflow_graph")
        db.execute("RELEASE SAVEPOINT legacy_media_workflow_graph")
        raise


def repair_legacy_selection_nodes(root: str, db, project):
    if json.loads(project["extra_json"] or "{}").get("ordinaryFiles"):
        return
    """Repair only deterministic legacy selections, recording every ambiguous conflict."""
    project_path = canonical_path(os.path.join(os.path.abspath(root), project["relative_path"]))
    if not os.path.isdir(project_path):
        return
    root_directories = {
        entry.name.casefold(): canonical_path(entry.path)
        for entry in os.scandir(project_path)
        if entry.is_dir()
    }
    definitions = {
        "图片选片": {
            "media_kind": "image", "source_name": "RAW",
            "display_names": {"图片选片", "图片选片（原图）"},
        },
        "视频选片": {
            "media_kind": "video", "source_name": "MOV",
            "display_names": {"视频选片", "视频选片（原片）"},
        },
    }
    timestamp = int(time.time() * 1000)

    def record_repair(legacy_node, legacy_name, source_name, reason, candidate_ids):
        db.execute(
            """INSERT INTO legacy_selection_relation_repairs(
                 progress_id,project_id,legacy_name,expected_source_name,reason,
                 candidate_ids_json,created_at) VALUES(?,?,?,?,?,?,?)
               ON CONFLICT(progress_id) DO UPDATE SET
                 legacy_name=excluded.legacy_name,
                 expected_source_name=excluded.expected_source_name,
                 reason=excluded.reason,
                 candidate_ids_json=excluded.candidate_ids_json""",
            (legacy_node["id"], project["id"], legacy_name, source_name, reason,
             json.dumps(candidate_ids, ensure_ascii=False), timestamp),
        )

    # sqlite's connection context is the transaction boundary: unexpected
    # errors roll back every repair for this project before propagating.
    with db:
        for legacy_name, definition in definitions.items():
            legacy_path = root_directories.get(legacy_name.casefold())
            if legacy_path is None:
                continue
            legacy_nodes = db.execute(
                """SELECT * FROM progress_folders
                   WHERE project_id=? AND media_kind=? AND parent_progress_id IS NULL
                     AND version_key='0' AND node_role IN ('original','progress')
                     AND folder_path_key=?""",
                (project["id"], definition["media_kind"], legacy_path.casefold()),
            ).fetchall()
            legacy_nodes = [
                node for node in legacy_nodes
                if os.path.basename(canonical_path(node["folder_path"])) == legacy_name
                and node["display_name"] in definition["display_names"]
            ]
            if not legacy_nodes:
                continue
            source_path = root_directories.get(definition["source_name"].casefold())
            candidates = [] if source_path is None else db.execute(
                """SELECT id FROM progress_folders
                   WHERE project_id=? AND media_kind=? AND node_role='original'
                     AND parent_progress_id IS NULL AND folder_path_key=? AND missing_since IS NULL
                   ORDER BY id""",
                (project["id"], definition["media_kind"], source_path.casefold()),
            ).fetchall()
            source_ids = [row["id"] for row in candidates]
            for legacy_node in legacy_nodes:
                independent_key = f"{LEGACY_SELECTION_INDEPENDENT_KEY_PREFIX}{legacy_node['id']}"
                kept_independent = db.execute(
                    "SELECT 1 FROM project_properties WHERE project_id=? AND key=?",
                    (project["id"], independent_key),
                ).fetchone()
                if kept_independent is not None:
                    db.execute(
                        "DELETE FROM legacy_selection_relation_repairs WHERE progress_id=?",
                        (legacy_node["id"],),
                    )
                    continue
                if len(source_ids) != 1:
                    record_repair(
                        legacy_node, legacy_name, definition["source_name"],
                        "source_missing" if not source_ids else "source_ambiguous", source_ids,
                    )
                    continue
                source_id = source_ids[0]
                existing_selections = db.execute(
                    """SELECT id FROM progress_folders
                       WHERE project_id=? AND media_kind=? AND node_role='selection'
                         AND relation_kind='auxiliary' AND parent_progress_id=?
                         AND id<>? AND missing_since IS NULL ORDER BY id""",
                    (project["id"], definition["media_kind"], source_id, legacy_node["id"]),
                ).fetchall()
                existing_selection_ids = [row["id"] for row in existing_selections]
                if existing_selection_ids:
                    record_repair(
                        legacy_node, legacy_name, definition["source_name"],
                        "selection_already_exists", existing_selection_ids,
                    )
                    continue
                target_version_key = f"selection-{source_id}"
                key_owner = db.execute(
                    """SELECT id FROM progress_folders
                       WHERE project_id=? AND media_kind=? AND version_key=? AND id<>?""",
                    (project["id"], definition["media_kind"], target_version_key, legacy_node["id"]),
                ).fetchone()
                if key_owner is not None:
                    record_repair(
                        legacy_node, legacy_name, definition["source_name"],
                        "selection_already_exists", [key_owner["id"]],
                    )
                    continue
                structural_children = [row["id"] for row in db.execute(
                    "SELECT id FROM progress_folders WHERE parent_progress_id=? ORDER BY id", (legacy_node["id"],),
                ).fetchall()]
                if structural_children:
                    record_repair(legacy_node, legacy_name, definition["source_name"], "selection_already_exists", structural_children)
                    continue
                try:
                    db.execute(
                        """UPDATE progress_folders SET node_role='selection',relation_kind='auxiliary',
                           parent_progress_id=?,tracking_enabled=0,tracking_state='disabled',
                           rename_from_parent=0,copy_missing_from_parent=0,version_key=?,updated_at=?
                           WHERE id=?""",
                        (source_id, target_version_key, timestamp, legacy_node["id"]),
                    )
                except sqlite3.IntegrityError:
                    # A concurrent/key conflict is a repair decision, not a
                    # reason for progress_list to fail and hide the whole tree.
                    record_repair(
                        legacy_node, legacy_name, definition["source_name"],
                        "selection_already_exists", [],
                    )
                    continue
                db.execute(
                    "DELETE FROM legacy_selection_relation_repairs WHERE progress_id=?",
                    (legacy_node["id"],),
                )


def repair_selection_workflow_mainlines(db, project_id: str):
    """Move legacy selection-owned progress nodes back onto their original mainline.

    The old shape was original -> selection -> progress. The explicit V2 shape
    is original -> progress (main) plus selection -> progress (workflow_input).
    This is intentionally role-driven and never infers a relation from folder
    names or version strings.
    """
    timestamp = int(time.time() * 1000)
    rows = db.execute(
        """SELECT child.id AS child_id, child.updated_at AS child_updated_at,
                  selection.id AS selection_id, original.id AS original_id
           FROM progress_folders child
           JOIN progress_folders selection ON selection.id=child.parent_progress_id
           JOIN progress_folders original ON original.id=selection.parent_progress_id
           WHERE child.project_id=? AND child.node_role='progress' AND child.relation_kind='main'
             AND selection.project_id=child.project_id AND selection.media_kind=child.media_kind
             AND selection.node_role='selection' AND selection.relation_kind='auxiliary'
             AND original.project_id=child.project_id AND original.media_kind=child.media_kind
             AND original.node_role='original' AND original.missing_since IS NULL""",
        (project_id,),
    ).fetchall()
    changed = 0
    for row in rows:
        updated_at = max(timestamp, int(row["child_updated_at"] or 0) + 1)
        db.execute(
            "UPDATE progress_folders SET parent_progress_id=?,relation_kind='main',updated_at=? WHERE id=?",
            (row["original_id"], updated_at, row["child_id"]),
        )
        db.execute(
            """INSERT INTO version_graph_edges(
                 id,project_id,source_progress_id,target_progress_id,edge_kind,created_at,updated_at)
               SELECT ?,?,?,?,?,?,?
               WHERE NOT EXISTS(
                 SELECT 1 FROM version_graph_edges WHERE project_id=? AND source_progress_id=?
                   AND target_progress_id=? AND edge_kind='workflow_input'
               )""",
            (str(uuid.uuid4()), project_id, row["selection_id"], row["child_id"], "workflow_input",
             timestamp, timestamp, project_id, row["selection_id"], row["child_id"]),
        )
        changed += 1
    if changed:
        # A stored coordinate set describes the old topology. Deleting the
        # layout row also deletes positions and makes stale renderer saves fail
        # their expectedRevision check instead of restoring the broken layout.
        db.execute("DELETE FROM version_tree_layouts WHERE project_id=?", (project_id,))
    return changed


def ensure_selection_workflow_inputs(db, project_id: str):
    """Keep the derived selection input paired with every original -> progress edge."""
    timestamp = int(time.time() * 1000)
    before = db.total_changes
    db.execute(
        """INSERT INTO version_graph_edges(
             id,project_id,source_progress_id,target_progress_id,edge_kind,created_at,updated_at)
           SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||
                  substr(lower(hex(randomblob(2))),2)||'-'||
                  substr('89ab',abs(random()) % 4 + 1,1)||substr(lower(hex(randomblob(2))),2)||'-'||
                  lower(hex(randomblob(6))),
                  child.project_id,selection.id,child.id,'workflow_input',?,?
           FROM progress_folders child
           JOIN progress_folders original ON original.id=child.parent_progress_id
           JOIN progress_folders selection ON selection.parent_progress_id=original.id
             AND selection.project_id=child.project_id AND selection.media_kind=child.media_kind
           WHERE child.project_id=? AND child.node_role='progress' AND child.relation_kind='main'
             AND child.missing_since IS NULL AND original.node_role='original'
             AND original.missing_since IS NULL AND selection.node_role='selection'
             AND selection.relation_kind='auxiliary' AND selection.missing_since IS NULL
             AND NOT EXISTS(
               SELECT 1 FROM version_graph_edges edge WHERE edge.project_id=child.project_id
                 AND edge.source_progress_id=selection.id AND edge.target_progress_id=child.id
                 AND edge.edge_kind='workflow_input'
             )""",
        (timestamp, timestamp, project_id),
    )
    return db.total_changes - before


def progress_list(root: str, db, payload: dict):
    project = project_row(db, payload["projectName"])
    recover_stale_version_batches(db, project["id"])
    migrate_legacy_progress_folders_once(root, db, project)
    register_original_baselines(root, db, project)
    migrate_legacy_media_workflow_graph_once(root, db, project)
    repair_legacy_selection_nodes(root, db, project)
    with db:
        repair_selection_workflow_mainlines(db, project["id"])
        ensure_selection_workflow_inputs(db, project["id"])
    sync_progress_folder_locations(root, db, project)
    return progress_snapshot(db, payload, project)


def progress_snapshot(db, payload: dict, project=None):
    project = project or project_row(db, payload["projectName"])
    include_missing = bool(payload.get("includeMissing"))
    repair_rows = db.execute(
        """SELECT progress_id,project_id,legacy_name,expected_source_name,reason,
                  candidate_ids_json FROM legacy_selection_relation_repairs
           WHERE project_id=? ORDER BY created_at,progress_id""",
        (project["id"],),
    ).fetchall()
    return {
        "success": True,
        "progressFolders": [serialize_progress(row) for row in progress_rows(db, project["id"], include_missing)],
        "graphEdges": [
            serialize_version_graph_edge(row) for row in db.execute(
                "SELECT * FROM version_graph_edges WHERE project_id=? ORDER BY created_at,id",
                (project["id"],),
            ).fetchall()
        ],
        "legacySelectionRelationRepairs": [
            {
                "progressId": row["progress_id"],
                "projectId": row["project_id"],
                "legacyName": row["legacy_name"],
                "expectedSourceName": row["expected_source_name"],
                "reason": row["reason"],
                "candidateIds": json.loads(row["candidate_ids_json"] or "[]"),
            }
            for row in repair_rows
        ],
    }


def progress_legacy_selection_repair(db, payload: dict):
    progress_id = str(payload.get("progressId") or "").strip()
    source_progress_id = str(payload.get("sourceProgressId") or "").strip()
    action = str(payload.get("action") or "connect").strip()
    if not progress_id or action not in ("connect", "keep-independent") or action == "connect" and not source_progress_id:
        raise ValueError("legacy_selection_repair_payload_invalid: 修复节点 ID 无效")
    with db:
        repair = db.execute(
            "SELECT * FROM legacy_selection_relation_repairs WHERE progress_id=?",
            (progress_id,),
        ).fetchone()
        legacy = db.execute("SELECT * FROM progress_folders WHERE id=?", (progress_id,)).fetchone()
        if repair is None or legacy is None:
            raise ValueError("legacy_selection_repair_not_found: 遗留选片修复记录不存在")
        if legacy["project_id"] != repair["project_id"]:
            raise ValueError("legacy_selection_repair_project_mismatch: 节点不属于当前项目")
        if legacy["parent_progress_id"] is not None or legacy["version_key"] != "0" or legacy["node_role"] not in ("original", "progress"):
            raise ValueError("legacy_selection_repair_state_changed: 遗留节点状态已经变化，请刷新后重试")
        if action == "keep-independent":
            timestamp = max(int(time.time() * 1000), int(legacy["updated_at"]) + 1)
            db.execute(
                """INSERT INTO project_properties(project_id,key,value_json,updated_at) VALUES(?,?,?,?)
                   ON CONFLICT(project_id,key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at""",
                (legacy["project_id"], f"{LEGACY_SELECTION_INDEPENDENT_KEY_PREFIX}{progress_id}", "true", timestamp),
            )
            db.execute("DELETE FROM legacy_selection_relation_repairs WHERE progress_id=?", (progress_id,))
            updated = next(row for row in progress_rows(db, legacy["project_id"], True) if row["id"] == progress_id)
            return {"success": True, "progressFolder": serialize_progress(updated), "keptIndependent": True}
        source = db.execute("SELECT * FROM progress_folders WHERE id=?", (source_progress_id,)).fetchone()
        if source is None or source["project_id"] != repair["project_id"]:
            raise ValueError("legacy_selection_repair_project_mismatch: 节点不属于当前项目")
        if source["media_kind"] != legacy["media_kind"]:
            raise ValueError("legacy_selection_repair_media_mismatch: 来源媒体类型不一致")
        if source["node_role"] != "original" or source["parent_progress_id"] is not None or source["missing_since"] is not None:
            raise ValueError("legacy_selection_repair_source_invalid: 来源必须是有效的原始素材节点")
        preferred_key = f"selection-{source_progress_id}"
        key_owner = db.execute(
            """SELECT id FROM progress_folders
               WHERE project_id=? AND media_kind=? AND version_key=? AND id<>?""",
            (legacy["project_id"], legacy["media_kind"], preferred_key, progress_id),
        ).fetchone()
        version_key = f"legacy-selection-{progress_id}" if key_owner is not None else preferred_key
        fallback_owner = db.execute(
            """SELECT id FROM progress_folders
               WHERE project_id=? AND media_kind=? AND version_key=? AND id<>?""",
            (legacy["project_id"], legacy["media_kind"], version_key, progress_id),
        ).fetchone()
        if fallback_owner is not None:
            raise ValueError("legacy_selection_repair_key_conflict: 遗留选片内部标识冲突")
        timestamp = max(int(time.time() * 1000), int(legacy["updated_at"]) + 1)
        _assert_no_structural_children(db, progress_id, "legacy_selection_repair_children")
        db.execute(
            """UPDATE progress_folders SET node_role='selection',relation_kind='auxiliary',
               parent_progress_id=?,version_key=?,tracking_enabled=0,tracking_state='disabled',
               rename_from_parent=0,copy_missing_from_parent=0,last_tracked_at=NULL,
               tracking_snapshot_json='{}',folder_signature=NULL,updated_at=? WHERE id=?""",
            (source_progress_id, version_key, timestamp, progress_id),
        )
        db.execute("DELETE FROM legacy_selection_relation_repairs WHERE progress_id=?", (progress_id,))
    updated = next(row for row in progress_rows(db, legacy["project_id"], True) if row["id"] == progress_id)
    return {"success": True, "progressFolder": serialize_progress(updated)}


VERSION_TREE_MAX_COORDINATE = 1_000_000.0
VERSION_TREE_MAX_POSITIONS = 1000


def normalize_version_tree_scope(value) -> str:
    raw = str(value or "").strip().replace("\\", "/")
    if len(raw) > 1024 or raw.startswith("/") or (len(raw) >= 2 and raw[1] == ":"):
        raise ValueError("version_tree_scope_invalid: scopeKey 必须是项目内相对路径")
    parts = [part for part in raw.split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        raise ValueError("version_tree_scope_invalid: scopeKey 不能包含 ..")
    return "/".join(parts)


def version_tree_project_node_keys(db, project_id: str) -> set[str]:
    keys = {f"progress:{row['id']}" for row in db.execute(
        "SELECT id FROM progress_folders WHERE project_id=?",
        (project_id,),
    ).fetchall()}
    return keys


def version_tree_entry_node_belongs_to_scope(node_key: str, scope_key: str) -> bool:
    if not node_key.startswith("entry:"):
        return False
    relative_path = node_key[len("entry:"):]
    if not relative_path or len(relative_path) > 1024 or "\\" in relative_path:
        return False
    try:
        normalized_path = normalize_version_tree_scope(relative_path)
    except ValueError:
        return False
    if normalized_path != relative_path:
        return False
    parent_scope = "/".join(normalized_path.split("/")[:-1])
    return parent_scope.casefold() == scope_key.casefold()


def version_tree_layout_get(db, payload: dict):
    project = project_row(db, payload["projectName"])
    scope_key = normalize_version_tree_scope(payload.get("scopeKey"))
    valid_keys = version_tree_project_node_keys(db, project["id"])
    layout = db.execute(
        "SELECT revision,updated_at FROM version_tree_layouts WHERE project_id=? AND scope_key=?",
        (project["id"], scope_key),
    ).fetchone()
    rows = db.execute(
        """SELECT node_key,x,y,updated_at FROM version_tree_node_positions
           WHERE project_id=? AND scope_key=? ORDER BY node_key""",
        (project["id"], scope_key),
    ).fetchall()
    return {
        "success": True,
        "scopeKey": scope_key,
        "revision": int(layout["revision"]) if layout else 0,
        "updatedAt": int(layout["updated_at"]) if layout else 0,
        "positions": [
            {"nodeKey": row["node_key"], "x": float(row["x"]), "y": float(row["y"]), "updatedAt": int(row["updated_at"])}
            for row in rows if row["node_key"] in valid_keys or version_tree_entry_node_belongs_to_scope(row["node_key"], scope_key)
        ],
    }


def version_tree_layout_save(db, payload: dict):
    project = project_row(db, payload["projectName"])
    scope_key = normalize_version_tree_scope(payload.get("scopeKey"))
    mode = str(payload.get("mode") or "")
    if mode not in ("patch", "replace"):
        raise ValueError("version_tree_layout_mode_invalid: mode 必须是 patch 或 replace")
    expected_revision = payload.get("expectedRevision")
    if isinstance(expected_revision, bool) or not isinstance(expected_revision, int) or expected_revision < 0:
        raise ValueError("version_tree_layout_revision_invalid: expectedRevision 无效")
    positions = payload.get("positions")
    if not isinstance(positions, list) or len(positions) > VERSION_TREE_MAX_POSITIONS:
        raise ValueError("version_tree_layout_positions_invalid: 单次保存节点数量无效")
    valid_keys = version_tree_project_node_keys(db, project["id"])
    normalized = []
    seen = set()
    for position in positions:
        if not isinstance(position, dict):
            raise ValueError("version_tree_layout_position_invalid: 坐标记录无效")
        node_key = str(position.get("nodeKey") or "")
        x = position.get("x")
        y = position.get("y")
        if (node_key not in valid_keys and not version_tree_entry_node_belongs_to_scope(node_key, scope_key)) or node_key in seen:
            raise ValueError("version_tree_layout_node_invalid: 节点不属于当前项目")
        if isinstance(x, bool) or isinstance(y, bool) or not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            raise ValueError("version_tree_layout_coordinate_invalid: 坐标必须是有限数字")
        x_value, y_value = float(x), float(y)
        if not math.isfinite(x_value) or not math.isfinite(y_value) or abs(x_value) > VERSION_TREE_MAX_COORDINATE or abs(y_value) > VERSION_TREE_MAX_COORDINATE:
            raise ValueError("version_tree_layout_coordinate_invalid: 坐标超出允许范围")
        seen.add(node_key)
        normalized.append((node_key, x_value, y_value))
    timestamp = int(time.time() * 1000)
    with db:
        current = db.execute(
            "SELECT revision FROM version_tree_layouts WHERE project_id=? AND scope_key=?",
            (project["id"], scope_key),
        ).fetchone()
        current_revision = int(current["revision"]) if current else 0
        if current_revision != expected_revision:
            raise ValueError(f"stale_layout: 布局已更新（当前 revision={current_revision}）")
        next_revision = current_revision + 1
        db.execute(
            """INSERT INTO version_tree_layouts(project_id,scope_key,revision,updated_at) VALUES(?,?,?,?)
               ON CONFLICT(project_id,scope_key) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at""",
            (project["id"], scope_key, next_revision, timestamp),
        )
        if mode == "replace":
            db.execute(
                "DELETE FROM version_tree_node_positions WHERE project_id=? AND scope_key=?",
                (project["id"], scope_key),
            )
        db.executemany(
            """INSERT INTO version_tree_node_positions(project_id,scope_key,node_key,x,y,updated_at)
               VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,scope_key,node_key) DO UPDATE SET
               x=excluded.x,y=excluded.y,updated_at=excluded.updated_at""",
            [(project["id"], scope_key, node_key, x, y, timestamp) for node_key, x, y in normalized],
        )
    return {"success": True, "scopeKey": scope_key, "revision": next_revision, "updatedAt": timestamp}


def recover_stale_version_batches(db, project_id: str):
    """Expose interrupted worker state as a recoverable tracking state."""
    cutoff = int(time.time() * 1000) - 10 * 60 * 1000
    stale = db.execute(
        """SELECT * FROM version_batches WHERE project_id=? AND status IN ('importing','applying')
           AND updated_at<?""",
        (project_id, cutoff),
    ).fetchall()
    if not stale:
        return
    timestamp = int(time.time() * 1000)
    for batch in stale:
        pending_operations = db.execute(
            "SELECT COUNT(*) FROM batch_file_operations WHERE batch_id=? AND status!='succeeded'",
            (batch["id"],),
        ).fetchone()[0]
        if pending_operations:
            db.execute(
                """UPDATE batch_file_operations SET status='failed',error=CASE WHEN error='' THEN '上次文件操作意外中断' ELSE error END,
                   updated_at=? WHERE batch_id=? AND status IN ('pending','running')""",
                (timestamp, batch["id"]),
            )
            db.execute("UPDATE version_batches SET status='needs_repair',updated_at=? WHERE id=?", (timestamp, batch["id"]))
            db.execute(
                """UPDATE progress_folders SET tracking_state='needs_repair',updated_at=?
                   WHERE project_id=? AND folder_path_key=?""",
                (timestamp, project_id, batch["source_folder_path_key"]),
            )
        else:
            db.execute("UPDATE version_batches SET status='failed',updated_at=? WHERE id=?", (timestamp, batch["id"]))
            db.execute(
                """UPDATE progress_folders SET tracking_state='pending_compare',updated_at=?
                   WHERE project_id=? AND folder_path_key=?""",
                (timestamp, project_id, batch["source_folder_path_key"]),
            )
    db.commit()


def _is_valid_structural_parent(row) -> bool:
    return bool(row) and (
        row["node_role"] == "original" and row["artifact_kind"] is None
        or row["node_role"] == "progress" and row["parent_progress_id"] is not None and row["relation_kind"] == "main"
    )


def _assert_no_structural_children(db, progress_id: str, error_code: str = "role_conversion_children_forbidden"):
    if db.execute("SELECT 1 FROM progress_folders WHERE parent_progress_id=? LIMIT 1", (progress_id,)).fetchone():
        raise ValueError(f"{error_code}: 节点仍有结构子节点，不能转换用途或媒体类型")


def progress_register(root: str, db, payload: dict, commit: bool = True, sync_locations: bool = True, allow_role_conversion: bool = False):
    project = project_row(db, payload["projectName"])
    if sync_locations:
        sync_progress_folder_locations(root, db, project, commit=commit)
    media_kind = str(payload.get("mediaKind") or "")
    if media_kind not in ("image", "video", "mixed"):
        raise ValueError("无效的进度类型")
    version_key = str(payload.get("versionKey") or f"node-{uuid.uuid4().hex}").strip()
    if not version_key or len(version_key) > 128 or any(ord(character) < 32 for character in version_key):
        raise ValueError("无效的版本编号")
    project_path = canonical_path(os.path.join(os.path.abspath(root), project["relative_path"]))
    folder_path = canonical_path(payload["folderPath"])
    external_link_relative_path = None
    if (not is_project_descendant(folder_path, project_path)) or not os.path.isdir(folder_path):
        raise ValueError("版本进度必须是项目内的文件夹")
    node_role = str(payload.get("nodeRole") or "progress")
    if node_role not in PROGRESS_NODE_ROLES:
        raise ValueError("无效的文件夹节点角色")
    artifact_kind = str(payload.get("artifactKind") or "") or None
    if artifact_kind is not None and OPAQUE_ARTIFACT_KIND.fullmatch(artifact_kind) is None:
        raise ValueError("无效的产物节点类型")
    parent_id = payload.get("parentProgressId") or None
    relation_kind = payload.get("relationKind") or None
    if parent_id and relation_kind is None:
        relation_kind = "auxiliary" if node_role == "selection" else "main"
    if not parent_id:
        relation_kind = None
    if relation_kind is not None:
        relation_kind = str(relation_kind)
    if relation_kind not in (*PROGRESS_RELATION_KINDS, None):
        raise ValueError("无效的父子关系类型")
    if node_role == "original" and parent_id:
        raise ValueError("原始素材节点不能指定父节点")
    if node_role == "selection" and (not parent_id or relation_kind != "auxiliary"):
        raise ValueError("选片节点必须通过 auxiliary 关系连接来源节点")
    if node_role == "progress" and parent_id and relation_kind != "main":
        raise ValueError("进度节点必须通过 main 关系连接父节点")
    if node_role == "progress" and not parent_id:
        raise ValueError("progress_parent_required: 版本进度必须选择有效父节点")
    if node_role == "progress" and media_kind not in ("image", "video"):
        raise ValueError("进度节点只支持图片或视频媒体类型")
    if node_role == "artifact" and (parent_id or relation_kind or artifact_kind not in ("companion", "preview", "transcode")):
        raise ValueError("产物节点不能使用结构父关系，且必须指定 companion、preview 或 transcode 类型")
    if node_role == "workflow" and (parent_id or relation_kind or artifact_kind is None):
        raise ValueError("工作流节点不能使用结构父关系，且必须指定合法的产物类型")
    if node_role == "broll" and (media_kind != "mixed" or parent_id or relation_kind or artifact_kind is not None):
        raise ValueError("花絮节点必须是 mixed 类型，且不能使用父关系或产物类型")
    if node_role == "original" and artifact_kind not in (None, "companion"):
        raise ValueError("original nodes may only use the companion artifact kind")
    if node_role in ("progress", "selection", "broll") and artifact_kind is not None:
        raise ValueError("普通版本节点不能指定产物类型")
    if parent_id:
        parent = db.execute(
            "SELECT * FROM progress_folders WHERE id=? AND project_id=? AND media_kind=? AND missing_since IS NULL",
            (parent_id, project["id"], media_kind),
        ).fetchone()
        if not _is_valid_structural_parent(parent):
            raise ValueError("父版本进度不存在")
    timestamp = int(time.time() * 1000)
    progress_id = str(payload.get("progressId") or payload.get("takeoverProgressId") or "")
    display_name = str(payload.get("displayName") or os.path.basename(folder_path))
    existing = None
    if progress_id:
        existing = db.execute(
            "SELECT * FROM progress_folders WHERE id=? AND project_id=?",
            (progress_id, project["id"]),
        ).fetchone()
        if existing is None:
            raise ValueError("要修改的进度不存在")
    else:
        existing = db.execute(
            "SELECT * FROM progress_folders WHERE project_id=? AND media_kind=? AND version_key=?",
            (project["id"], media_kind, version_key),
        ).fetchone()
        if existing is not None and os.path.isdir(existing["folder_path"]) and existing["folder_path_key"] != folder_path.casefold():
            raise ValueError(f"版本 _{version_key} 已存在")
        if existing is None:
            folder_identity = directory_identity(folder_path)
            existing = db.execute(
                """SELECT * FROM progress_folders WHERE project_id=? AND missing_since IS NOT NULL AND (
                     (folder_id IS NOT NULL AND folder_id=?) OR folder_path_key=?)
                   AND media_kind=? AND node_role=?
                   ORDER BY missing_since LIMIT 1""",
                (project["id"], folder_identity, folder_path.casefold(), media_kind, node_role),
            ).fetchone()
    if existing is not None and existing["missing_since"] is not None and existing["node_role"] != node_role:
        raise ValueError("tombstone 节点角色与接管文件夹不兼容")
    if existing is not None and (existing["media_kind"] != media_kind or existing["node_role"] != node_role or existing["artifact_kind"] != artifact_kind):
        _assert_no_structural_children(db, existing["id"])
    if existing is not None and existing["node_role"] != node_role and not allow_role_conversion:
        raise ValueError("progress_role_change_forbidden: 节点角色只能由受限用途命令转换")
    existing_id = existing["id"] if existing is not None else progress_id
    duplicate_name = db.execute(
        """SELECT id FROM progress_folders WHERE project_id=? AND display_name=? COLLATE NOCASE
           AND id<>? AND missing_since IS NULL""",
        (project["id"], display_name, existing_id),
    ).fetchone()
    if duplicate_name is not None:
        raise ValueError(f"进度名称已存在：{display_name}")
    if progress_id:
        conflict = db.execute(
            "SELECT id FROM progress_folders WHERE project_id=? AND media_kind=? AND version_key=? AND id<>?",
            (project["id"], media_kind, version_key, progress_id),
        ).fetchone()
        if conflict is not None:
            raise ValueError(f"版本 _{version_key} 已存在")
    requested_tracking_state = payload.get("trackingState")
    tracking_enabled = bool(payload.get("trackingEnabled"))
    if requested_tracking_state is None:
        requested_tracking_state = "ready" if tracking_enabled else "disabled"
    tracking_state = str(requested_tracking_state)
    if tracking_state not in PROGRESS_TRACKING_STATES:
        raise ValueError("无效的版本跟踪状态")
    if "trackingEnabled" not in payload:
        tracking_enabled = tracking_state != "disabled"
    rename_from_parent = bool(payload.get("renameFromParent"))
    copy_missing_from_parent = bool(payload.get("copyMissingFromParent"))
    if node_role in ("original", "artifact", "workflow", "broll") or relation_kind == "auxiliary":
        if tracking_enabled or rename_from_parent or copy_missing_from_parent or tracking_state != "disabled":
            raise ValueError("original/selection/artifact/workflow/broll 节点禁止开启版本跟踪")
        tracking_enabled = rename_from_parent = copy_missing_from_parent = False
        tracking_state = "disabled"
    if not tracking_enabled and (rename_from_parent or copy_missing_from_parent):
        raise ValueError("未开启跟踪时不能保存沿用文件名或补齐策略")
    tracking_context_changed = bool(existing) and (
        existing["folder_path_key"] != folder_path.casefold()
        or (existing["external_link_relative_path"] or None) != external_link_relative_path
        or (existing["parent_progress_id"] or None) != parent_id
        or existing["media_kind"] != media_kind
        or existing["node_role"] != node_role
        or (existing["relation_kind"] or None) != relation_kind
        or bool(existing["tracking_enabled"]) != tracking_enabled
        or bool(existing["rename_from_parent"]) != rename_from_parent
        or bool(existing["copy_missing_from_parent"]) != copy_missing_from_parent
    )
    parent_context_changed = bool(existing) and (
        existing["folder_path_key"] != folder_path.casefold()
        or (existing["external_link_relative_path"] or None) != external_link_relative_path
        or existing["media_kind"] != media_kind
        or existing["node_role"] != node_role
    )
    if existing and (tracking_context_changed or parent_context_changed):
        predicates = []
        parameters = []
        if tracking_context_changed:
            predicates.append("progress_id=?")
            parameters.append(existing["id"])
        if parent_context_changed:
            predicates.append("parent_progress_id=?")
            parameters.append(existing["id"])
        active_session = db.execute(
            f"""SELECT id,status FROM tracking_sessions WHERE ({' OR '.join(predicates)})
                 AND status IN ('comparing','pending_confirm','committing','failed') LIMIT 1""",
            parameters,
        ).fetchone()
        if active_session is not None:
            raise ValueError("node_busy: 节点正在比较、确认或提交，暂时不能修改来源、目录或跟踪策略")
    if existing and tracking_context_changed and tracking_enabled:
        tracking_state = "stale"
    if existing and "trackingSnapshot" not in payload and not tracking_context_changed and tracking_enabled:
        snapshot_json = existing["tracking_snapshot_json"] or "{}"
    else:
        snapshot = payload.get("trackingSnapshot") or {}
        if not isinstance(snapshot, (dict, list)):
            raise ValueError("无效的跟踪快照")
        snapshot_json = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
    if not tracking_enabled or tracking_context_changed:
        folder_signature = None
        last_tracked_at = None
    else:
        folder_signature = (str(payload.get("folderSignature") or "") or None) if "folderSignature" in payload else (existing["folder_signature"] if existing else None)
        if "lastTrackedAt" in payload:
            last_tracked_at = int(payload.get("lastTrackedAt") or 0) or None
        elif existing:
            last_tracked_at = existing["last_tracked_at"]
        else:
            last_tracked_at = timestamp if tracking_state == "ready" else None
    source_metadata_json = normalize_source_metadata(payload.get("sourceMetadata")) if "sourceMetadata" in payload else (
        existing["source_metadata_json"] if existing is not None and "source_metadata_json" in existing.keys() else "{}"
    )
    values = (
        parent_id, display_name, folder_path, folder_path.casefold(), directory_identity(folder_path),
        external_link_relative_path, node_role, artifact_kind, source_metadata_json, relation_kind, int(tracking_enabled), tracking_state, int(rename_from_parent),
        int(copy_missing_from_parent), last_tracked_at, snapshot_json, folder_signature, timestamp,
    )
    if existing:
        db.execute(
            """UPDATE progress_folders SET media_kind=?,version_key=?,parent_progress_id=?,display_name=?,folder_path=?,folder_path_key=?,
               folder_id=?,external_link_relative_path=?,node_role=?,artifact_kind=?,source_metadata_json=?,relation_kind=?,tracking_enabled=?,tracking_state=?,rename_from_parent=?,
               copy_missing_from_parent=?,last_tracked_at=?,tracking_snapshot_json=?,folder_signature=?,
               missing_since=NULL,tombstone_json='{}',updated_at=? WHERE id=?""",
            (media_kind, version_key, *values, existing["id"]),
        )
        progress_id = existing["id"]
    else:
        progress_id = str(uuid.uuid4())
        db.execute(
            """INSERT INTO progress_folders(id,project_id,media_kind,version_key,parent_progress_id,
               display_name,folder_path,folder_path_key,folder_id,external_link_relative_path,node_role,artifact_kind,source_metadata_json,relation_kind,tracking_enabled,
               tracking_state,rename_from_parent,copy_missing_from_parent,last_tracked_at,tracking_snapshot_json,
               folder_signature,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (progress_id, project["id"], media_kind, version_key, *values[:-1], timestamp, timestamp),
        )
    if commit:
        db.commit()
    row = next(row for row in progress_rows(db, project["id"]) if row["id"] == progress_id)
    return {"success": True, "progressFolder": serialize_progress(row)}


def progress_register_with_graph(root: str, db, payload: dict):
    """Atomically register/update one main progress and synchronize workflow inputs."""
    if not isinstance(payload, dict) or set(payload) - {"projectName", "progress", "workflowInputProgressIds"}:
        raise ValueError("progress_graph_payload_invalid: only projectName, progress and workflow inputs are accepted")
    project_name = str(payload.get("projectName") or "").strip()
    progress_payload = payload.get("progress")
    input_ids = payload.get("workflowInputProgressIds")
    if not project_name or not isinstance(progress_payload, dict) or not isinstance(input_ids, list):
        raise ValueError("progress_graph_payload_invalid: project, progress or workflow inputs are invalid")
    allowed_progress_fields = {
        "progressId", "mediaKind", "versionKey", "parentProgressId", "displayName", "folderPath",
        "sourceMetadata", "relationKind", "trackingEnabled", "trackingState", "renameFromParent", "copyMissingFromParent",
    }
    if set(progress_payload) - allowed_progress_fields or "nodeRole" in progress_payload or "edgeKind" in progress_payload:
        raise ValueError("progress_graph_payload_invalid: renderer cannot assign node roles, paths or edge kinds")
    normalized_inputs = []
    for value in input_ids:
        input_id = str(value or "").strip()
        if not input_id or input_id in normalized_inputs:
            raise ValueError("progress_graph_input_invalid: workflow input IDs must be unique and non-empty")
        normalized_inputs.append(input_id)

    project = project_row(db, project_name)
    progress_id = str(progress_payload.get("progressId") or "").strip()
    updates_progress = bool(set(progress_payload) - {"progressId"})
    existing_target = None
    if progress_id:
        existing_target = db.execute(
            "SELECT * FROM progress_folders WHERE id=? AND project_id=?",
            (progress_id, project["id"]),
        ).fetchone()
        if existing_target is None or existing_target["missing_since"] is not None:
            raise ValueError("progress_graph_target_invalid: target progress does not exist")
    required = ("mediaKind", "versionKey", "displayName", "folderPath")
    if (not progress_id or updates_progress) and any(not progress_payload.get(field) for field in required):
        raise ValueError("progress_graph_payload_invalid: new or updated progress fields are incomplete")
    if updates_progress or not progress_id:
        if existing_target is not None and existing_target["node_role"] != "progress":
            raise ValueError("progress_graph_target_invalid: only progress nodes can be updated")
        media_kind = str(progress_payload.get("mediaKind") or "")
        parent_id = str(progress_payload.get("parentProgressId") or "").strip()
        if media_kind not in ("image", "video") or not parent_id:
            raise ValueError("progress_parent_required: 版本进度必须选择同媒体类型的原始素材或进度父节点")
        if progress_payload.get("relationKind") not in (None, "main"):
            raise ValueError("progress_graph_payload_invalid: progress relation must be main")
        parent = db.execute(
            """SELECT * FROM progress_folders WHERE id=? AND project_id=? AND media_kind=?
                 AND missing_since IS NULL""",
            (parent_id, project["id"], media_kind),
        ).fetchone()
        if not _is_valid_structural_parent(parent):
            raise ValueError("progress_parent_invalid: 父节点必须是同项目、同媒体类型的原始素材或进度")

    try:
        with db:
            if updates_progress or not progress_id:
                register_payload = {
                    "projectName": project_name,
                    "progressId": progress_id or None,
                    "mediaKind": progress_payload["mediaKind"],
                    "versionKey": progress_payload["versionKey"],
                    "parentProgressId": progress_payload.get("parentProgressId"),
                    "displayName": progress_payload["displayName"],
                    "folderPath": progress_payload["folderPath"],
                    "nodeRole": "progress",
                    "relationKind": "main",
                    "trackingEnabled": bool(progress_payload.get("trackingEnabled")),
                    "trackingState": progress_payload.get("trackingState"),
                    "renameFromParent": bool(progress_payload.get("renameFromParent")),
                    "copyMissingFromParent": bool(progress_payload.get("copyMissingFromParent")),
                }
                registered = progress_register(root, db, register_payload, commit=False, sync_locations=False)
                progress_id = registered["progressFolder"]["id"]
            else:
                existing = existing_target

            target = db.execute("SELECT * FROM progress_folders WHERE id=?", (progress_id,)).fetchone()
            if target["node_role"] == "progress" and not target["tracking_enabled"]:
                db.execute("DELETE FROM tracking_sessions WHERE progress_id=?", (progress_id,))
            sources = {}
            for source_id in normalized_inputs:
                source = db.execute("SELECT * FROM progress_folders WHERE id=?", (source_id,)).fetchone()
                if source is None or source["missing_since"] is not None:
                    raise ValueError("progress_graph_input_invalid: an input progress does not exist")
                sources[source_id] = source
            if target["node_role"] == "workflow":
                if any(source["node_role"] != "progress" for source in sources.values()):
                    raise ValueError("progress_graph_input_invalid: workflow inputs must be main progress nodes")
            elif target["node_role"] == "progress":
                if any(source["node_role"] not in ("selection", "workflow") for source in sources.values()):
                    raise ValueError("progress_graph_input_invalid: progress inputs must be selection or workflow nodes")
            else:
                raise ValueError("progress_graph_target_invalid: target must be a workflow or main progress")

            for source_id in normalized_inputs:
                _validated_version_graph_edge(db, {
                    "projectId": project["id"], "sourceProgressId": source_id,
                    "targetProgressId": progress_id, "edgeKind": "workflow_input",
                }) if db.execute(
                    """SELECT 1 FROM version_graph_edges WHERE project_id=? AND source_progress_id=?
                       AND target_progress_id=? AND edge_kind='workflow_input'""",
                    (project["id"], source_id, progress_id),
                ).fetchone() is None else None

            if target["node_role"] == "workflow":
                db.execute(
                    """DELETE FROM version_graph_edges WHERE project_id=? AND target_progress_id=?
                       AND edge_kind='workflow_input' AND source_progress_id NOT IN
                       (SELECT value FROM json_each(?))""",
                    (project["id"], progress_id, json.dumps(normalized_inputs)),
                )
            elif target["node_role"] == "progress":
                db.execute(
                    """DELETE FROM version_graph_edges WHERE project_id=? AND target_progress_id=?
                       AND edge_kind='workflow_input' AND source_progress_id NOT IN
                       (SELECT value FROM json_each(?))""",
                    (project["id"], progress_id, json.dumps(normalized_inputs)),
                )
                workflow_inputs = [source_id for source_id, source in sources.items() if source["node_role"] == "workflow"]
                for workflow_id in workflow_inputs:
                    db.execute(
                        """DELETE FROM version_graph_edges WHERE project_id=? AND source_progress_id=?
                           AND edge_kind='workflow_input' AND target_progress_id<>?""",
                        (project["id"], workflow_id, progress_id),
                    )
            timestamp = int(time.time() * 1000)
            for source_id in normalized_inputs:
                db.execute(
                    """INSERT OR IGNORE INTO version_graph_edges(
                         id,project_id,source_progress_id,target_progress_id,edge_kind,created_at,updated_at)
                       VALUES(?,?,?,?,?,?,?)""",
                    (str(uuid.uuid4()), project["id"], source_id, progress_id, "workflow_input", timestamp, timestamp),
                )
    except Exception:
        db.rollback()
        raise

    row = next(row for row in progress_rows(db, project["id"], True) if row["id"] == progress_id)
    edges = db.execute(
        "SELECT * FROM version_graph_edges WHERE project_id=? AND (source_progress_id=? OR target_progress_id=?) ORDER BY created_at,id",
        (project["id"], progress_id, progress_id),
    ).fetchall()
    return {"success": True, "progressFolder": serialize_progress(row), "edges": [serialize_version_graph_edge(edge) for edge in edges]}


def progress_relation_update(db, payload: dict):
    child_id = str(payload.get("childProgressId") or "").strip()
    parent_value = payload.get("parentProgressId")
    parent_id = str(parent_value).strip() if parent_value is not None else None
    if not child_id or parent_id == "":
        raise ValueError("relation_payload_invalid: 节点 ID 无效")
    expected_updated_at = payload.get("expectedUpdatedAt")
    with db:
        child = db.execute("SELECT * FROM progress_folders WHERE id=?", (child_id,)).fetchone()
        if child is None:
            raise ValueError("child_not_found: 子节点不存在")
        if expected_updated_at is not None and int(expected_updated_at) != int(child["updated_at"]):
            raise ValueError("stale_update: 版本关系已被其他操作修改，请刷新后重试")
        if child["node_role"] == "original":
            raise ValueError("original_parent_forbidden: 原始素材不能拥有父节点")
        if child["node_role"] not in ("progress", "selection"):
            raise ValueError("child_role_invalid: 子节点角色无效")
        detaching_progress = child["node_role"] == "progress" and parent_id is None
        if detaching_progress:
            raise ValueError("progress_detach_requires_unregister: 断开进度必须显式取消版本登记")
        if not detaching_progress and child["tracking_state"] in ("pending_compare", "pending_confirm", "committing"):
            raise ValueError("node_busy: 节点正在比较或提交，暂时不能修改关系")
        active_session = db.execute(
            "SELECT 1 FROM tracking_sessions WHERE progress_id=? AND status IN ('comparing','pending_confirm','committing') LIMIT 1",
            (child_id,),
        ).fetchone()
        if active_session is not None and not detaching_progress:
            raise ValueError("node_busy: 节点正在比较或提交，暂时不能修改关系")
        if child["node_role"] == "selection" and parent_id is None:
            raise ValueError("selection_parent_required: 选片节点必须保留有效来源")
        if parent_id is not None:
            parent = db.execute("SELECT * FROM progress_folders WHERE id=?", (parent_id,)).fetchone()
            if parent is None or parent["project_id"] != child["project_id"]:
                raise ValueError("relation_project_mismatch: 父子节点不属于同一项目")
            if parent["media_kind"] != child["media_kind"]:
                raise ValueError("media_kind_mismatch: 父子节点媒体类型不一致")
            if not _is_valid_structural_parent(parent):
                raise ValueError("invalid_parent_role: 不能挂到选片或附属分支下")
            if parent["missing_since"] is not None:
                raise ValueError("parent_missing: 父节点已经失效")
            if _version_graph_reaches(db, str(child["project_id"]), child_id, parent_id):
                raise ValueError("cycle_detected: 结构关系和补充关系不能形成有向环")
        relation_kind = "auxiliary" if child["node_role"] == "selection" else ("main" if parent_id else None)
        tracking_enabled = 0 if detaching_progress else int(child["tracking_enabled"])
        rename_from_parent = 0 if detaching_progress else int(child["rename_from_parent"])
        copy_missing_from_parent = 0 if detaching_progress else int(child["copy_missing_from_parent"])
        tracking_state = "stale" if child["node_role"] == "progress" and tracking_enabled else "disabled"
        timestamp = max(int(time.time() * 1000), int(child["updated_at"]) + 1)
        version_key = f"selection-{parent_id}" if child["node_role"] == "selection" else child["version_key"]
        if detaching_progress:
            db.execute("DELETE FROM tracking_sessions WHERE progress_id=?", (child_id,))
        db.execute(
            """UPDATE progress_folders SET parent_progress_id=?,relation_kind=?,version_key=?,
               tracking_enabled=?,tracking_state=?,rename_from_parent=?,copy_missing_from_parent=?,
               last_tracked_at=NULL,tracking_snapshot_json='{}',folder_signature=NULL,
               updated_at=? WHERE id=?""",
            (parent_id, relation_kind, version_key, tracking_enabled, tracking_state,
             rename_from_parent, copy_missing_from_parent, timestamp, child_id),
        )
    row = next(row for row in progress_rows(db, child["project_id"]) if row["id"] == child_id)
    return {"success": True, "progressFolder": serialize_progress(row)}


def serialize_version_graph_edge(row):
    return {
        "id": row["id"],
        "projectId": row["project_id"],
        "sourceProgressId": row["source_progress_id"],
        "targetProgressId": row["target_progress_id"],
        "edgeKind": row["edge_kind"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _strict_version_graph_payload(payload: dict, allowed: set[str]):
    if not isinstance(payload, dict) or set(payload) - allowed:
        raise ValueError("version_graph_edge_payload_invalid: 只能提交项目 ID、节点 ID 和关系类型")


def _validated_version_graph_edge(db, payload: dict, exclude_edge_id: str | None = None):
    _strict_version_graph_payload(payload, {"projectId", "sourceProgressId", "targetProgressId", "edgeKind"})
    project_id = str(payload.get("projectId") or "").strip()
    source_id = str(payload.get("sourceProgressId") or "").strip()
    target_id = str(payload.get("targetProgressId") or "").strip()
    edge_kind = str(payload.get("edgeKind") or "").strip()
    if not project_id or not source_id or not target_id or edge_kind not in VERSION_GRAPH_EDGE_KINDS:
        raise ValueError("version_graph_edge_payload_invalid: 项目、节点或关系类型无效")
    if source_id == target_id:
        raise ValueError("version_graph_edge_cycle: 节点不能连接到自己")
    nodes = db.execute(
        "SELECT * FROM progress_folders WHERE id IN (?,?)",
        (source_id, target_id),
    ).fetchall()
    by_id = {str(row["id"]): row for row in nodes}
    source = by_id.get(source_id)
    target = by_id.get(target_id)
    if source is None or target is None:
        raise ValueError("version_graph_edge_node_missing: 补充关系节点不存在")
    if source["project_id"] != project_id or target["project_id"] != project_id:
        raise ValueError("version_graph_edge_project_mismatch: 所有节点必须属于指定项目")
    if source["media_kind"] != target["media_kind"]:
        raise ValueError("version_graph_edge_media_mismatch: 图片和视频节点不能互相连接")
    source_is_main_progress = source["node_role"] == "progress" \
        and source["parent_progress_id"] is not None and source["relation_kind"] == "main"
    target_is_main_progress = target["node_role"] == "progress" \
        and target["parent_progress_id"] is not None and target["relation_kind"] == "main"
    target_source_metadata = json.loads(target["source_metadata_json"] or "{}") if "source_metadata_json" in target.keys() else {}
    valid_roles = (
        edge_kind == "media_companion" and source["node_role"] == "original" and source["artifact_kind"] is None and target["node_role"] == "original"
        and target["artifact_kind"] == "companion"
        or edge_kind == "derived_preview" and (source["node_role"] == "original" or source_is_main_progress)
        and target["node_role"] == "artifact" and target["artifact_kind"] == "preview"
        or edge_kind == "derived_transcode" and (source["node_role"] == "original" or source_is_main_progress)
        and target["node_role"] == "artifact" and target["artifact_kind"] == "transcode"
        or edge_kind == "workflow_input" and (
            source["node_role"] in ("selection", "workflow") and target_is_main_progress
            or source_is_main_progress and target["node_role"] == "workflow"
            and target_source_metadata.get("parentCapability") == "workflow-input"
        )
    )
    if not valid_roles:
        raise ValueError("version_graph_edge_role_invalid: 节点角色不符合补充关系类型")
    duplicate = db.execute(
        """SELECT 1 FROM version_graph_edges WHERE project_id=? AND source_progress_id=?
           AND target_progress_id=? AND edge_kind=? AND (? IS NULL OR id<>?)""",
        (project_id, source_id, target_id, edge_kind, exclude_edge_id, exclude_edge_id),
    ).fetchone()
    if duplicate is not None:
        raise ValueError("version_graph_edge_duplicate: 同一补充关系不能重复")
    if _version_graph_reaches(db, project_id, target_id, source_id, exclude_edge_id):
        raise ValueError("version_graph_edge_cycle: 结构关系和补充关系不能形成有向环")
    return project_id, source_id, target_id, edge_kind


def version_graph_edge_create(db, payload: dict):
    project_id, source_id, target_id, edge_kind = _validated_version_graph_edge(db, payload)
    timestamp = int(time.time() * 1000)
    edge_id = str(uuid.uuid4())
    with db:
        db.execute(
            """INSERT INTO version_graph_edges(
                 id,project_id,source_progress_id,target_progress_id,edge_kind,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?)""",
            (edge_id, project_id, source_id, target_id, edge_kind, timestamp, timestamp),
        )
    row = db.execute("SELECT * FROM version_graph_edges WHERE id=?", (edge_id,)).fetchone()
    return {"success": True, "edge": serialize_version_graph_edge(row)}


def version_graph_edge_list(db, payload: dict):
    _strict_version_graph_payload(payload, {"projectId"})
    project_id = str(payload.get("projectId") or "").strip()
    if not project_id:
        raise ValueError("version_graph_edge_payload_invalid: 项目 ID 无效")
    rows = db.execute(
        "SELECT * FROM version_graph_edges WHERE project_id=? ORDER BY created_at,id",
        (project_id,),
    ).fetchall()
    return {"success": True, "edges": [serialize_version_graph_edge(row) for row in rows]}


def version_graph_edge_delete(db, payload: dict):
    _strict_version_graph_payload(payload, {"projectId", "sourceProgressId", "targetProgressId", "edgeKind"})
    project_id = str(payload.get("projectId") or "").strip()
    source_id = str(payload.get("sourceProgressId") or "").strip()
    target_id = str(payload.get("targetProgressId") or "").strip()
    edge_kind = str(payload.get("edgeKind") or "").strip()
    if not project_id or not source_id or not target_id or edge_kind not in VERSION_GRAPH_EDGE_KINDS:
        raise ValueError("version_graph_edge_payload_invalid: 项目、节点或关系类型无效")
    with db:
        db.execute(
            """DELETE FROM version_graph_edges WHERE project_id=? AND source_progress_id=?
               AND target_progress_id=? AND edge_kind=?""",
            (project_id, source_id, target_id, edge_kind),
        )
    # Deleting a relation is intentionally idempotent. The renderer can briefly
    # hold an edge that has already been removed by cascade cleanup or another
    # graph refresh; the desired state is already satisfied in that case.
    return {"success": True}


def version_graph_edge_replace_source(db, payload: dict):
    _strict_version_graph_payload(
        payload,
        {"projectId", "sourceProgressId", "targetProgressId", "edgeKind", "newSourceProgressId"},
    )
    project_id = str(payload.get("projectId") or "").strip()
    source_id = str(payload.get("sourceProgressId") or "").strip()
    target_id = str(payload.get("targetProgressId") or "").strip()
    edge_kind = str(payload.get("edgeKind") or "").strip()
    new_source_id = str(payload.get("newSourceProgressId") or "").strip()
    if not project_id or not source_id or not target_id or not new_source_id or edge_kind not in VERSION_GRAPH_EDGE_KINDS:
        raise ValueError("version_graph_edge_payload_invalid: 项目、节点或关系类型无效")
    existing = db.execute(
        """SELECT * FROM version_graph_edges WHERE project_id=? AND source_progress_id=?
           AND target_progress_id=? AND edge_kind=?""",
        (project_id, source_id, target_id, edge_kind),
    ).fetchone()
    if existing is None:
        raise ValueError("version_graph_edge_not_found: 补充关系不存在")
    if new_source_id == source_id:
        return {"success": True, "edge": serialize_version_graph_edge(existing)}
    edge_id = str(existing["id"])
    timestamp = int(time.time() * 1000)
    with db:
        project_id, new_source_id, target_id, edge_kind = _validated_version_graph_edge(
            db,
            {
                "projectId": project_id,
                "sourceProgressId": new_source_id,
                "targetProgressId": target_id,
                "edgeKind": edge_kind,
            },
            edge_id,
        )
        db.execute(
            """UPDATE version_graph_edges SET source_progress_id=?,updated_at=? WHERE id=?""",
            (new_source_id, timestamp, edge_id),
        )
    row = db.execute("SELECT * FROM version_graph_edges WHERE id=?", (edge_id,)).fetchone()
    return {"success": True, "edge": serialize_version_graph_edge(row)}


def _import_relative_path(value) -> str:
    normalized = str(value or "").replace("\\", "/").strip("/")
    parts = normalized.split("/") if normalized else []
    if not parts or any(part in ("", ".", "..") for part in parts) or os.path.isabs(str(value or "")):
        raise ValueError("import_graph_relative_path_invalid: import graph paths must be project-relative")
    return "/".join(parts)


def media_workflow_import_commit(root: str, db, payload: dict):
    """Commit an importer-authored V2 artifact manifest without inferring graph semantics from names."""
    allowed = {"schemaVersion", "projectName", "importSessionId", "artifacts"}
    if not isinstance(payload, dict) or set(payload) - allowed or payload.get("schemaVersion") != 2:
        raise ValueError("import_graph_payload_invalid: schemaVersion 2 and supported fields are required")
    project_name = str(payload.get("projectName") or "").strip()
    session_id = str(payload.get("importSessionId") or "").strip()
    if not project_name or not session_id or len(session_id) > 128 or any(ord(char) < 32 for char in session_id):
        raise ValueError("import_graph_payload_invalid: project name and import session are required")
    artifacts = payload.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        raise ValueError("import_graph_payload_invalid: artifacts must be a non-empty array")

    slot_shapes = IMPORT_ARTIFACT_SLOT_SHAPES
    normalized_artifacts = []
    artifact_paths = set()
    artifact_allowed = {"relativePath", "mediaKind", "importSlot", "displayName"}
    for item in artifacts:
        if not isinstance(item, dict) or set(item) - artifact_allowed:
            raise ValueError("import_graph_artifact_invalid: unsupported artifact field")
        relative_path = _import_relative_path(item.get("relativePath"))
        relative_path_key = relative_path.casefold()
        if relative_path_key in artifact_paths:
            raise ValueError("import_graph_artifact_duplicate: artifact path is duplicated")
        artifact_paths.add(relative_path_key)
        import_slot = str(item.get("importSlot") or "")
        media_kind = str(item.get("mediaKind") or "")
        shape = slot_shapes.get(import_slot)
        if shape is None or media_kind != shape[0]:
            raise ValueError("import_graph_artifact_invalid: media kind does not match import slot")
        display_name = str(item.get("displayName") or os.path.basename(relative_path)).strip()
        if not display_name:
            raise ValueError("import_graph_artifact_invalid: display name is required")
        normalized_artifacts.append({
            "relativePath": relative_path,
            "relativePathKey": relative_path_key,
            "mediaKind": media_kind,
            "importSlot": import_slot,
            "displayName": display_name,
        })
    normalized_artifacts.sort(key=lambda item: (item["relativePathKey"], item["importSlot"]))

    canonical_manifest = json.dumps({
        "schemaVersion": 2,
        "projectName": project_name,
        "importSessionId": session_id,
        "artifacts": [
            {key: item[key] for key in ("relativePath", "mediaKind", "importSlot", "displayName")}
            for item in normalized_artifacts
        ],
    }, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    project = project_row(db, project_name)
    project_path = canonical_path(os.path.join(os.path.abspath(root), project["relative_path"]))
    timestamp = int(time.time() * 1000)
    session = db.execute(
        "SELECT * FROM media_import_graph_sessions WHERE project_id=? AND import_session_id=?",
        (project["id"], session_id),
    ).fetchone()
    if session is not None and session["manifest_json"] != canonical_manifest:
        raise ValueError("import_graph_session_conflict: the import session has a different manifest")
    if session is None:
        db.execute(
            """INSERT INTO media_import_graph_sessions(project_id,import_session_id,manifest_json,status,error,created_at,updated_at)
               VALUES(?,?,?,'pending',NULL,?,?)""",
            (project["id"], session_id, canonical_manifest, timestamp, timestamp),
        )
    elif session["status"] != "committed":
        db.execute(
            "UPDATE media_import_graph_sessions SET status='pending',error=NULL,updated_at=? WHERE project_id=? AND import_session_id=?",
            (timestamp, project["id"], session_id),
        )
    db.commit()

    try:
        db.execute("BEGIN IMMEDIATE")
        nodes_by_path = {}
        for item in normalized_artifacts:
            folder_path = canonical_path(os.path.join(project_path, *item["relativePath"].split("/")))
            if not is_project_descendant(folder_path, project_path) or not os.path.isdir(folder_path):
                raise ValueError(f"import_graph_folder_missing: {item['relativePath']}")
            existing = db.execute(
                "SELECT * FROM progress_folders WHERE project_id=? AND folder_path_key=?",
                (project["id"], folder_path.casefold()),
            ).fetchone()
            mapping = db.execute(
                "SELECT * FROM media_import_artifact_slots WHERE project_id=? AND relative_path_key=?",
                (project["id"], item["relativePathKey"]),
            ).fetchone()
            expected_media, expected_role, expected_artifact = slot_shapes[item["importSlot"]]
            if existing is not None:
                if mapping is not None and mapping["progress_id"] != existing["id"]:
                    raise ValueError(f"import_graph_role_conflict: {item['relativePath']} mapping does not match its node")
                current_slot = str(mapping["import_slot"]) if mapping is not None else ""
                if mapping is None:
                    # A bounded project-root scan or watcher may register the
                    # directory before the importer commits its receipt. Adopt
                    # only an untracked, structurally compatible material node;
                    # ordinary progress/selection/workflow nodes remain denied.
                    has_relations = db.execute(
                        """SELECT 1 FROM version_graph_edges WHERE project_id=?
                           AND (source_progress_id=? OR target_progress_id=?) LIMIT 1""",
                        (project["id"], existing["id"], existing["id"]),
                    ).fetchone() is not None
                    compatible_slot = item["importSlot"]
                    compatible = False
                    if existing["media_kind"] == expected_media and not existing["tracking_enabled"] \
                            and existing["tracking_state"] == "disabled" and existing["parent_progress_id"] is None:
                        if item["importSlot"] in ("raw", "mov"):
                            compatible = existing["node_role"] == "original" and existing["artifact_kind"] is None and not has_relations
                        elif item["importSlot"] == "camera_jpg":
                            compatible = existing["node_role"] == "original" and existing["artifact_kind"] in (None, "companion")
                        elif item["importSlot"] == "generated_jpg" and existing["node_role"] == "original" \
                                and existing["artifact_kind"] == "companion":
                            # Canonical reconciliation has stronger evidence
                            # that this is a camera companion; never silently
                            # downgrade it into a generated preview.
                            compatible = True
                            compatible_slot = "camera_jpg"
                        elif item["importSlot"] == "generated_jpg":
                            compatible = existing["node_role"] == "artifact" and existing["artifact_kind"] == "preview"
                        elif item["importSlot"] == "video_transcode":
                            compatible = existing["node_role"] == "artifact" and existing["artifact_kind"] == "transcode"
                    if not compatible:
                        raise ValueError(f"import_graph_role_conflict: {item['relativePath']} is not safely adoptable")
                    adopted_shape = slot_shapes[compatible_slot]
                    if (existing["media_kind"], existing["node_role"], existing["artifact_kind"]) != adopted_shape:
                        _assert_no_structural_children(db, existing["id"], "import_graph_role_conflict")
                    db.execute(
                        """UPDATE progress_folders SET node_role=?,artifact_kind=?,missing_since=NULL,
                           tombstone_json='{}',updated_at=? WHERE id=?""",
                        (adopted_shape[1], adopted_shape[2], timestamp, existing["id"]),
                    )
                    db.execute(
                        """INSERT INTO media_import_artifact_slots(
                             project_id,progress_id,import_slot,relative_path_key,created_at,updated_at)
                           VALUES(?,?,?,?,?,?)""",
                        (project["id"], existing["id"], compatible_slot, item["relativePathKey"], timestamp, timestamp),
                    )
                    current_slot = compatible_slot
                    mapping = db.execute(
                        "SELECT * FROM media_import_artifact_slots WHERE project_id=? AND progress_id=?",
                        (project["id"], existing["id"]),
                    ).fetchone()
                    existing = db.execute("SELECT * FROM progress_folders WHERE id=?", (existing["id"],)).fetchone()
                current_shape = slot_shapes[current_slot]
                if existing["media_kind"] != current_shape[0] or existing["node_role"] != current_shape[1] or existing["artifact_kind"] != current_shape[2]:
                    raise ValueError(f"import_graph_role_conflict: {item['relativePath']} import metadata is inconsistent")
                if current_slot == "generated_jpg" and item["importSlot"] == "camera_jpg":
                    _assert_no_structural_children(db, existing["id"], "import_graph_role_conflict")
                    db.execute(
                        "DELETE FROM version_graph_edges WHERE project_id=? AND target_progress_id=? AND edge_kind='derived_preview'",
                        (project["id"], existing["id"]),
                    )
                    db.execute(
                        """UPDATE progress_folders SET node_role='original',artifact_kind='companion',missing_since=NULL,
                           tombstone_json='{}',updated_at=? WHERE id=?""",
                        (timestamp, existing["id"]),
                    )
                    db.execute(
                        "UPDATE media_import_artifact_slots SET import_slot='camera_jpg',updated_at=? WHERE project_id=? AND progress_id=?",
                        (timestamp, project["id"], existing["id"]),
                    )
                elif current_slot == "camera_jpg" and item["importSlot"] == "generated_jpg":
                    pass
                elif current_slot != item["importSlot"]:
                    raise ValueError(f"import_graph_role_conflict: {item['relativePath']} import slot cannot be changed")
                else:
                    db.execute(
                        "UPDATE progress_folders SET missing_since=NULL,tombstone_json='{}' WHERE id=?",
                        (existing["id"],),
                    )
                registered_row = next(row for row in progress_rows(db, project["id"]) if row["id"] == existing["id"])
                registered = serialize_progress(registered_row)
            else:
                if mapping is not None:
                    raise ValueError(f"import_graph_role_conflict: {item['relativePath']} mapping does not match its node")
                registered = progress_register(root, db, {
                    "projectName": project_name,
                    "mediaKind": expected_media,
                    "versionKey": "import-" + hashlib.sha256(item["relativePathKey"].encode("utf-8")).hexdigest()[:24],
                    "displayName": item["displayName"],
                    "folderPath": folder_path,
                    "nodeRole": expected_role,
                    "artifactKind": expected_artifact,
                    "trackingEnabled": False,
                    "renameFromParent": False,
                    "copyMissingFromParent": False,
                    "trackingState": "disabled",
                }, commit=False, sync_locations=False)["progressFolder"]
                db.execute(
                    """INSERT INTO media_import_artifact_slots(
                         project_id,progress_id,import_slot,relative_path_key,created_at,updated_at)
                       VALUES(?,?,?,?,?,?)""",
                    (project["id"], registered["id"], item["importSlot"], item["relativePathKey"], timestamp, timestamp),
                )
            nodes_by_path[item["relativePath"].casefold()] = registered

        slot_rows = db.execute(
            """SELECT slot.*,progress.* FROM media_import_artifact_slots slot
               JOIN progress_folders progress ON progress.id=slot.progress_id AND progress.project_id=slot.project_id
               WHERE slot.project_id=? AND progress.missing_since IS NULL ORDER BY slot.updated_at DESC,slot.progress_id""",
            (project["id"],),
        ).fetchall()
        nodes_by_group_and_slot = {}
        for row in slot_rows:
            relative_key = str(row["relative_path_key"] or "").replace("\\", "/")
            group_key = relative_key.rsplit("/", 1)[0] if "/" in relative_key else ""
            nodes_by_group_and_slot.setdefault((group_key, row["import_slot"]), []).append(row)
        for (group_key, slot), rows in nodes_by_group_and_slot.items():
            if len(rows) > 1:
                raise ValueError(f"import_graph_slot_ambiguous: multiple {slot} nodes are registered in {group_key or 'project root'}")

        desired_relations = []
        group_keys = sorted({group_key for group_key, _slot in nodes_by_group_and_slot})
        def add_slot_relation(group_key, source_slot, target_slot, edge_kind):
            source_rows = nodes_by_group_and_slot.get((group_key, source_slot), [])
            target_rows = nodes_by_group_and_slot.get((group_key, target_slot), [])
            if source_rows and target_rows:
                desired_relations.append((source_rows[0], target_rows[0], edge_kind))

        for group_key in group_keys:
            add_slot_relation(group_key, "raw", "camera_jpg", "media_companion")
            add_slot_relation(group_key, "raw", "generated_jpg", "derived_preview")
            add_slot_relation(group_key, "mov", "video_transcode", "derived_transcode")
        committed_edges = []
        for source, target, edge_kind in desired_relations:
            edge_payload = {
                "projectId": project["id"],
                "sourceProgressId": source["id"],
                "targetProgressId": target["id"],
                "edgeKind": edge_kind,
            }
            existing = db.execute(
                """SELECT * FROM version_graph_edges WHERE project_id=? AND source_progress_id=?
                   AND target_progress_id=? AND edge_kind=?""",
                (project["id"], source["id"], target["id"], edge_kind),
            ).fetchone()
            if existing is None:
                project_id, source_id, target_id, edge_kind = _validated_version_graph_edge(db, edge_payload)
                edge_id = str(uuid.uuid4())
                db.execute(
                    """INSERT INTO version_graph_edges(id,project_id,source_progress_id,target_progress_id,edge_kind,created_at,updated_at)
                       VALUES(?,?,?,?,?,?,?)""",
                    (edge_id, project_id, source_id, target_id, edge_kind, timestamp, timestamp),
                )
                existing = db.execute("SELECT * FROM version_graph_edges WHERE id=?", (edge_id,)).fetchone()
            committed_edges.append(serialize_version_graph_edge(existing))
        db.execute(
            "UPDATE media_import_graph_sessions SET status='committed',error=NULL,updated_at=? WHERE project_id=? AND import_session_id=?",
            (timestamp, project["id"], session_id),
        )
        db.commit()
        return {"success": True, "importSessionId": session_id, "nodes": list(nodes_by_path.values()), "edges": committed_edges}
    except Exception as error:
        db.rollback()
        db.execute(
            "UPDATE media_import_graph_sessions SET status='failed',error=?,updated_at=? WHERE project_id=? AND import_session_id=?",
            (str(error), int(time.time() * 1000), project["id"], session_id),
        )
        db.commit()
        raise


def progress_adopt_media(root: str, db, payload: dict):
    """Atomically adopt a user-created folder into the explicit media graph.

    The renderer never supplies a node role, edge kind or arbitrary source
    path. Electron resolves the project-relative path and this function derives
    the only legal role/edge shape from ``mode``.
    """
    allowed = {"projectName", "folderPath", "mode", "mediaKind", "sourceProgressId"}
    if not isinstance(payload, dict) or set(payload) - allowed:
        raise ValueError("media_adopt_payload_invalid: 请求字段无效")
    project_name = str(payload.get("projectName") or "").strip()
    mode = str(payload.get("mode") or "").strip()
    media_kind = str(payload.get("mediaKind") or "").strip()
    source_id = str(payload.get("sourceProgressId") or "").strip()
    if not project_name or mode not in ("original", "companion", "preview", "transcode", "broll"):
        raise ValueError("media_adopt_payload_invalid: 素材类型或接管方式无效")
    if mode == "broll":
        if media_kind != "mixed":
            raise ValueError("media_adopt_payload_invalid: 花絮必须使用 mixed 媒体类型")
    elif media_kind not in ("image", "video"):
        raise ValueError("media_adopt_payload_invalid: 素材类型或接管方式无效")
    if mode == "companion" and media_kind != "image":
        raise ValueError("media_adopt_payload_invalid: 配套素材只适用于图片")
    if mode == "transcode" and media_kind != "video":
        raise ValueError("media_adopt_payload_invalid: 转码产物只适用于视频")
    source_required = mode in ("companion", "preview", "transcode")
    if (source_required and not source_id) or (not source_required and source_id):
        raise ValueError("media_adopt_payload_invalid: 来源节点无效")
    project = project_row(db, project_name)
    project_path = canonical_path(os.path.join(os.path.abspath(root), project["relative_path"]))
    folder_path = canonical_path(payload.get("folderPath") or "")
    external_link_relative_path = None
    if (not is_project_descendant(folder_path, project_path)) or not os.path.isdir(folder_path):
        raise ValueError("media_adopt_folder_invalid: 只能接管项目内现有文件夹")
    existing = db.execute(
        "SELECT * FROM progress_folders WHERE project_id=? AND folder_path_key=?",
        (project["id"], folder_path.casefold()),
    ).fetchone()
    source = None
    if source_id:
        source = db.execute(
            "SELECT * FROM progress_folders WHERE id=? AND project_id=? AND missing_since IS NULL",
            (source_id, project["id"]),
        ).fetchone()
        if source is None or source["media_kind"] != media_kind or source["node_role"] not in ("original", "progress") \
                or source["node_role"] == "progress" and (source["parent_progress_id"] is None or source["relation_kind"] != "main"):
            raise ValueError("media_adopt_source_invalid: 来源必须是同项目、同媒体类型的原始素材或主进度")
        if mode == "companion" and source["node_role"] != "original":
            raise ValueError("media_adopt_source_invalid: 配套素材来源必须是原始素材")
        if source["folder_path_key"] == folder_path.casefold():
            raise ValueError("media_adopt_source_invalid: 来源和目标不能相同")

    target_role = "broll" if mode == "broll" else "original" if mode in ("original", "companion") else "artifact"
    artifact_kind = "companion" if mode == "companion" else "preview" if mode == "preview" else "transcode" if mode == "transcode" else None
    edge_kind = "media_companion" if mode == "companion" else "derived_preview" if mode == "preview" else "derived_transcode" if mode == "transcode" else None
    if existing is not None and external_link_relative_path:
        same_external_adoption = mode in ("original", "broll") \
            and existing["node_role"] == target_role \
            and existing["media_kind"] == media_kind \
            and existing["artifact_kind"] is None \
            and existing["parent_progress_id"] is None \
            and existing["external_link_relative_path"] == external_link_relative_path
        if not same_external_adoption:
            raise ValueError("media_adopt_external_conflict: 该外部文件夹已经通过其他路径纳入版本管理，请使用重新定位")
        row = next(row for row in progress_rows(db, project["id"]) if row["id"] == existing["id"])
        return {"success": True, "progressFolder": serialize_progress(row), "edge": None, "created": False}
    timestamp = int(time.time() * 1000)
    with db:
        if existing is not None:
            mapping = db.execute(
                "SELECT * FROM media_import_artifact_slots WHERE project_id=? AND progress_id=?",
                (project["id"], existing["id"]),
            ).fetchone()
            exact_shape = existing["media_kind"] == media_kind and existing["node_role"] == target_role \
                and existing["artifact_kind"] == artifact_kind and existing["parent_progress_id"] is None
            if mapping is not None and not exact_shape:
                raise ValueError("media_adopt_import_managed: 导入器管理的素材不能改变角色")
            relation_rows = db.execute(
                """SELECT * FROM version_graph_edges WHERE project_id=?
                   AND (source_progress_id=? OR target_progress_id=?)""",
                (project["id"], existing["id"], existing["id"]),
            ).fetchall()
            has_structural_children = db.execute(
                "SELECT 1 FROM progress_folders WHERE project_id=? AND parent_progress_id=? LIMIT 1",
                (project["id"], existing["id"]),
            ).fetchone() is not None
            expected_relation = edge_kind and any(
                row["source_progress_id"] == source_id and row["target_progress_id"] == existing["id"]
                and row["edge_kind"] == edge_kind for row in relation_rows
            )
            unexpected_relations = [row for row in relation_rows if not expected_relation or not (
                row["source_progress_id"] == source_id and row["target_progress_id"] == existing["id"]
                and row["edge_kind"] == edge_kind
            )]
            safely_convertible = existing["parent_progress_id"] is None and not existing["tracking_enabled"] \
                and existing["tracking_state"] == "disabled" and existing["node_role"] in ("original", "artifact", "broll") \
                and not unexpected_relations and not has_structural_children
            if exact_shape and edge_kind and unexpected_relations:
                raise ValueError("media_adopt_role_conflict: 产物已经连接到其他来源")
            if not exact_shape and not safely_convertible:
                raise ValueError("media_adopt_role_conflict: 文件夹已有版本或工作流关系，不能接管")
        registered = progress_register(root, db, {
            "projectName": project_name,
            "progressId": existing["id"] if existing is not None else None,
            "mediaKind": media_kind,
            "versionKey": existing["version_key"] if existing is not None else "adopt-" + hashlib.sha256(
                (external_link_relative_path or os.path.relpath(folder_path, project_path).replace("\\", "/")).casefold().encode("utf-8")
            ).hexdigest()[:24],
            "displayName": existing["display_name"] if existing is not None else os.path.basename(folder_path),
            "folderPath": folder_path,
            "externalLinkRelativePath": external_link_relative_path,
            "nodeRole": target_role,
            "artifactKind": artifact_kind,
            "trackingEnabled": False,
            "trackingState": "disabled",
            "renameFromParent": False,
            "copyMissingFromParent": False,
        }, commit=False, sync_locations=False, allow_role_conversion=True)
        target_id = registered["progressFolder"]["id"]
        edge = None
        if edge_kind:
            edge = db.execute(
                """SELECT * FROM version_graph_edges WHERE project_id=? AND source_progress_id=?
                   AND target_progress_id=? AND edge_kind=?""",
                (project["id"], source_id, target_id, edge_kind),
            ).fetchone()
            if edge is None:
                _validated_version_graph_edge(db, {
                    "projectId": project["id"], "sourceProgressId": source_id,
                    "targetProgressId": target_id, "edgeKind": edge_kind,
                })
                edge_id = str(uuid.uuid4())
                db.execute(
                    """INSERT INTO version_graph_edges(
                         id,project_id,source_progress_id,target_progress_id,edge_kind,created_at,updated_at)
                       VALUES(?,?,?,?,?,?,?)""",
                    (edge_id, project["id"], source_id, target_id, edge_kind, timestamp, timestamp),
                )
                edge = db.execute("SELECT * FROM version_graph_edges WHERE id=?", (edge_id,)).fetchone()
    row = next(row for row in progress_rows(db, project["id"]) if row["id"] == target_id)
    return {
        "success": True,
        "progressFolder": serialize_progress(row),
        "edge": serialize_version_graph_edge(edge) if edge is not None else None,
        "created": existing is None,
    }


def _progress_tree_mutation_key(project_id: str) -> str:
    return f"progress_tree_mutation:{project_id}"


PROGRESS_RELOCATION_CORE_RESERVED_NAMES = frozenset({
    "raw", "jpg", "mov", "mov_转码", "图片选片", "视频选片", "策划",
})
WINDOWS_DEVICE_NAME = re.compile(r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$", re.IGNORECASE)
PROGRESS_RELOCATION_ACTIVE_STATES = ("pending_compare", "pending_confirm", "committing", "needs_repair")


def _progress_relocation_reserved_names(values) -> frozenset[str]:
    if values is None:
        values = []
    if not isinstance(values, list) or len(values) > 32:
        raise ValueError("progress_folder_policy_invalid: 保留目录策略无效")
    names = set(PROGRESS_RELOCATION_CORE_RESERVED_NAMES)
    for value in values:
        if not isinstance(value, str) or value != value.strip() or not value or len(value) > 160:
            raise ValueError("progress_folder_policy_invalid: 保留目录策略无效")
        if value in (".", "..") or any(ord(character) < 32 for character in value) or any(character in '<>:"/\\|?*' for character in value):
            raise ValueError("progress_folder_policy_invalid: 保留目录策略无效")
        names.add(value.casefold())
    return frozenset(names)


def _validate_progress_folder_name(value, reserved_names=None) -> str:
    name = str(value or "")
    if name != name.strip() or not name or len(name) > 255 or name in (".", ".."):
        raise ValueError("progress_folder_name_invalid: 目录名称无效")
    if any(ord(character) < 32 for character in name) or any(character in '<>:"/\\|?*' for character in name):
        raise ValueError("progress_folder_name_invalid: 目录名称包含 Windows 非法字符")
    if name.endswith((".", " ")) or WINDOWS_DEVICE_NAME.fullmatch(name):
        raise ValueError("progress_folder_name_invalid: 目录名称在 Windows 上不可用")
    folded = name.casefold()
    if folded.startswith(".photoflow-") or folded in _progress_relocation_reserved_names(reserved_names):
        raise ValueError("progress_folder_name_reserved: 该名称保留给固定工作流使用")
    return name


def _replace_path_prefix(value, old_path: str, new_path: str):
    if value is None:
        return None
    text = str(value)
    old = canonical_path(old_path)
    new = canonical_path(new_path)
    text_key = canonical_path(text).casefold()
    old_key = old.casefold()
    if text_key == old_key:
        return new
    for separator in (os.sep, "/", "\\"):
        prefix = old_key.rstrip("/\\") + separator
        normalized_text = text.replace("/", os.sep).replace("\\", os.sep)
        normalized_prefix = old.rstrip("/\\") + os.sep
        if normalized_text.casefold().startswith(normalized_prefix.casefold()):
            suffix = normalized_text[len(normalized_prefix):]
            return os.path.join(new, suffix)
        if text.casefold().startswith(prefix):
            return new.rstrip("/\\") + text[len(old):]
    return text


def _replace_relative_prefix(value, old_relative: str, new_relative: str):
    text = str(value or "").replace("\\", "/")
    old = old_relative.replace("\\", "/").strip("/")
    new = new_relative.replace("\\", "/").strip("/")
    if text.casefold() == old.casefold():
        return new
    prefix = old.rstrip("/") + "/"
    if text.casefold().startswith(prefix.casefold()):
        return new.rstrip("/") + "/" + text[len(prefix):]
    return text


def _path_is_at_or_below(value, root_path: str) -> bool:
    candidate = canonical_path(value)
    root = canonical_path(root_path)
    return candidate.casefold() == root.casefold() or candidate.casefold().startswith(root.rstrip("/\\").casefold() + os.sep.casefold())


def _relocate_progress_database_paths(db, operation):
    old_path = operation["old_path"]
    new_path = operation["new_path"]
    old_relative = operation["old_relative_path"]
    new_relative = operation["new_relative_path"]
    project_id = operation["project_id"]
    progress_id = operation["progress_id"]
    timestamp = int(time.time() * 1000)

    progress_rows_to_update = db.execute(
        "SELECT id,folder_path FROM progress_folders WHERE project_id=?", (project_id,),
    ).fetchall()
    for row in progress_rows_to_update:
        relocated = _replace_path_prefix(row["folder_path"], old_path, new_path)
        if relocated == row["folder_path"] and not _path_is_at_or_below(row["folder_path"], new_path):
            continue
        db.execute(
            """UPDATE progress_folders SET folder_path=?,folder_path_key=?,folder_id=?,
               display_name=CASE WHEN id=? THEN ? ELSE display_name END,updated_at=? WHERE id=?""",
            (relocated, relocated.casefold(), directory_identity(relocated), progress_id,
             os.path.basename(new_path), timestamp, row["id"]),
        )

    for slot in db.execute(
        "SELECT progress_id,relative_path_key FROM media_import_artifact_slots WHERE project_id=?", (project_id,),
    ).fetchall():
        relocated = _replace_relative_prefix(slot["relative_path_key"], old_relative, new_relative).casefold()
        if relocated != slot["relative_path_key"]:
            db.execute(
                "UPDATE media_import_artifact_slots SET relative_path_key=?,updated_at=? WHERE project_id=? AND progress_id=?",
                (relocated, timestamp, project_id, slot["progress_id"]),
            )

    batches = db.execute(
        "SELECT id,source_folder_path,display_name FROM version_batches WHERE project_id=?", (project_id,),
    ).fetchall()
    affected_batch_ids = []
    for batch in batches:
        relocated = _replace_path_prefix(batch["source_folder_path"], old_path, new_path)
        if relocated != batch["source_folder_path"] or _path_is_at_or_below(batch["source_folder_path"], new_path):
            affected_batch_ids.append(batch["id"])
        else:
            continue
        db.execute(
            """UPDATE version_batches SET source_folder_path=?,source_folder_path_key=?,source_folder_id=?,
               display_name=CASE WHEN ? THEN ? ELSE display_name END,updated_at=? WHERE id=?""",
            (relocated, relocated.casefold(), directory_identity(relocated), int(relocated.casefold() == new_path.casefold()),
             os.path.basename(new_path), timestamp, batch["id"]),
        )

    if affected_batch_ids:
        placeholders = ",".join("?" for _ in affected_batch_ids)
        for item in db.execute(
            f"SELECT id,source_path FROM batch_items WHERE batch_id IN ({placeholders})", tuple(affected_batch_ids),
        ).fetchall():
            relocated = _replace_path_prefix(item["source_path"], old_path, new_path)
            if relocated != item["source_path"]:
                db.execute(
                    "UPDATE batch_items SET source_path=?,source_path_key=?,updated_at=? WHERE id=?",
                    (relocated, relocated.casefold(), timestamp, item["id"]),
                )
        for operation_row in db.execute(
            f"SELECT id,source_path,target_path FROM batch_file_operations WHERE batch_id IN ({placeholders})",
            tuple(affected_batch_ids),
        ).fetchall():
            source = _replace_path_prefix(operation_row["source_path"], old_path, new_path)
            target = _replace_path_prefix(operation_row["target_path"], old_path, new_path)
            if source != operation_row["source_path"] or target != operation_row["target_path"]:
                db.execute(
                    "UPDATE batch_file_operations SET source_path=?,target_path=?,updated_at=? WHERE id=?",
                    (source, target, timestamp, operation_row["id"]),
                )

    photos = db.execute("SELECT id,original_file_path FROM photos WHERE project_id=?", (project_id,)).fetchall()
    photo_ids = [row["id"] for row in photos]
    for photo in photos:
        relocated = _replace_path_prefix(photo["original_file_path"], old_path, new_path)
        if relocated != photo["original_file_path"]:
            db.execute("UPDATE photos SET original_file_path=?,updated_at=? WHERE id=?", (relocated, timestamp, photo["id"]))
    if photo_ids:
        placeholders = ",".join("?" for _ in photo_ids)
        versions = db.execute(
            f"SELECT id,file_path FROM versions WHERE photo_id IN ({placeholders})", tuple(photo_ids),
        ).fetchall()
        version_ids = [version["id"] for version in versions]
        for version in versions:
            relocated = _replace_path_prefix(version["file_path"], old_path, new_path)
            if relocated == version["file_path"]:
                continue
            db.execute(
                "UPDATE versions SET file_path=?,file_path_key=?,updated_at=? WHERE id=?",
                (relocated, relocated.casefold(), timestamp, version["id"]),
            )
        if version_ids:
            placeholders = ",".join("?" for _ in version_ids)
            for record in db.execute(
                f"SELECT id,current_path FROM file_records WHERE owner_id IN ({placeholders})", tuple(version_ids),
            ).fetchall():
                relocated = _replace_path_prefix(record["current_path"], old_path, new_path)
                if relocated != record["current_path"]:
                    db.execute(
                        "UPDATE file_records SET current_path=?,file_name=?,updated_at=? WHERE id=?",
                        (relocated, os.path.basename(relocated), timestamp, record["id"]),
                    )

    # Incremental manifests are immutable and may embed paths in result JSON.
    # Invalidate the project's snapshots atomically instead of partially rewriting them.
    snapshot_ids = [row[0] for row in db.execute(
        "SELECT snapshot_id FROM media_incremental_snapshots WHERE project_id=?", (project_id,),
    ).fetchall()]
    if snapshot_ids:
        placeholders = ",".join("?" for _ in snapshot_ids)
        parameters = tuple(snapshot_ids)
        for table in (
            "media_incremental_snapshot_files", "media_incremental_snapshot_scopes",
            "media_incremental_snapshot_baseline", "media_incremental_snapshot_batches",
        ):
            db.execute(f"DELETE FROM {table} WHERE snapshot_id IN ({placeholders})", parameters)
        db.execute(f"DELETE FROM media_incremental_snapshots WHERE snapshot_id IN ({placeholders})", parameters)


def _progress_relocation_path_identity(path_value: str, expected_folder_id: str) -> bool:
    return os.path.isdir(path_value) and directory_identity(path_value) == expected_folder_id


def _advance_progress_folder_relocation(db, operation, fault_after=None):
    relocation_id = operation["id"]
    expected_id = operation["folder_id"]
    old_path = operation["old_path"]
    new_path = operation["new_path"]
    temporary_path = operation["temporary_path"]
    state = operation["state"]

    def inject(stage):
        if fault_after == stage:
            raise RuntimeError(f"test_fault_after_{stage}")

    if state == "prepared":
        old_matches = _progress_relocation_path_identity(old_path, expected_id)
        temporary_matches = _progress_relocation_path_identity(temporary_path, expected_id)
        new_matches = _progress_relocation_path_identity(new_path, expected_id)
        if new_matches and not old_matches and not temporary_matches:
            pass
        elif temporary_matches and not old_matches and not os.path.exists(new_path):
            os.rename(temporary_path, new_path)
        elif old_matches and not temporary_matches:
            if os.path.exists(new_path) and canonical_path(new_path).casefold() != canonical_path(old_path).casefold():
                raise ValueError("progress_folder_target_conflict: 目标目录已存在，恢复不会覆盖")
            os.rename(old_path, temporary_path)
            inject("temporary_moved")
            if os.path.exists(new_path):
                raise ValueError("progress_folder_target_conflict: 目标目录已存在，恢复不会覆盖")
            os.rename(temporary_path, new_path)
        else:
            raise ValueError("progress_folder_identity_mismatch: 无法验证待恢复目录的 folderId")
        if not _progress_relocation_path_identity(new_path, expected_id):
            raise ValueError("progress_folder_identity_mismatch: 文件系统移动后 folderId 不匹配")
        db.execute(
            "UPDATE progress_folder_relocations SET state='filesystem_moved',error='',updated_at=? WHERE id=?",
            (int(time.time() * 1000), relocation_id),
        )
        db.commit()
        state = "filesystem_moved"
        inject("filesystem_moved")

    if state == "filesystem_moved":
        if not _progress_relocation_path_identity(new_path, expected_id):
            raise ValueError("progress_folder_identity_mismatch: 数据库重定位前 folderId 不匹配")
        try:
            _relocate_progress_database_paths(db, operation)
            db.execute(
                "UPDATE progress_folder_relocations SET state='database_relocated',error='',updated_at=? WHERE id=?",
                (int(time.time() * 1000), relocation_id),
            )
            db.commit()
        except Exception:
            db.rollback()
            raise
        state = "database_relocated"
        inject("database_relocated")

    if state == "database_relocated":
        # Attached media/versioning stores can be in WAL mode, where a process
        # crash may expose a partially published cross-database commit. Reapply
        # the prefix rewrite idempotently before declaring the journal complete.
        try:
            _relocate_progress_database_paths(db, operation)
            db.commit()
        except Exception:
            db.rollback()
            raise
        row = db.execute("SELECT folder_path,folder_id FROM progress_folders WHERE id=?", (operation["progress_id"],)).fetchone()
        if row is None or row["folder_path"].casefold() != new_path.casefold() or row["folder_id"] != expected_id:
            raise ValueError("progress_folder_database_relocation_invalid: 数据库路径尚未正确重定位")
        timestamp = int(time.time() * 1000)
        db.execute(
            """UPDATE progress_folder_relocations SET state='completed',error='',updated_at=?,completed_at=?
               WHERE id=?""",
            (timestamp, timestamp, relocation_id),
        )
        lease = _progress_tree_mutation_lease(db, operation["project_id"])
        if lease is not None and int(lease.get("createdAt") or 0) <= int(operation["created_at"]):
            db.execute("DELETE FROM meta WHERE key=?", (_progress_tree_mutation_key(operation["project_id"]),))
        db.commit()
        inject("completed")
    return db.execute("SELECT * FROM progress_folder_relocations WHERE id=?", (relocation_id,)).fetchone()


def recover_progress_folder_relocations(root: str, db, fault_after=None):
    del root
    try:
        pending = db.execute(
            "SELECT * FROM progress_folder_relocations WHERE state!='completed' ORDER BY created_at,id"
        ).fetchall()
    except sqlite3.OperationalError:
        return {"success": True, "recovered": 0, "pending": 0}
    recovered = 0
    for operation in pending:
        try:
            completed = _advance_progress_folder_relocation(db, operation, fault_after=fault_after)
            recovered += int(completed["state"] == "completed")
        except Exception as error:
            db.execute(
                "UPDATE progress_folder_relocations SET error=?,updated_at=? WHERE id=?",
                (str(error)[:2000], int(time.time() * 1000), operation["id"]),
            )
            db.commit()
            raise
    remaining = db.execute("SELECT COUNT(*) FROM progress_folder_relocations WHERE state!='completed'").fetchone()[0]
    return {"success": True, "recovered": recovered, "pending": remaining}


def progress_locations_snapshot(root: str, db, payload: dict):
    """Refresh registered locations without running discovery or migrations."""
    project = project_row(db, payload["projectName"])
    sync_progress_folder_locations(root, db, project)
    with db:
        ensure_selection_workflow_inputs(db, project["id"])
    return progress_snapshot(db, payload, project)


def progress_folder_rename(root: str, db, payload: dict, fault_after=None):
    recover_progress_folder_relocations(root, db)
    project = project_row(db, payload["projectName"])
    mutation_token = str(payload.get("mutationToken") or "")
    lease = _progress_tree_mutation_lease(db, project["id"])
    if not mutation_token or lease is None or lease.get("token") != mutation_token:
        raise ValueError("progress_tree_mutation_expired: 版本树变更令牌已失效")
    progress_id = str(payload.get("progressId") or "")
    progress = db.execute(
        "SELECT * FROM progress_folders WHERE id=? AND project_id=?", (progress_id, project["id"]),
    ).fetchone()
    if progress is None or progress["node_role"] != "progress":
        raise ValueError("progress_folder_rename_role_invalid: 只能重命名已登记的 progress 目录")
    if progress["external_link_relative_path"]:
        raise ValueError("external_progress_rename_unsupported: 第一版不支持重命名外链版本")
    if progress["missing_since"] is not None or progress["tracking_state"] in PROGRESS_RELOCATION_ACTIVE_STATES:
        raise ValueError("progress_folder_busy: 进度正在活动或待修复，不能重命名")
    active = db.execute(
        """SELECT 1 FROM tracking_sessions WHERE (progress_id=? OR parent_progress_id=?)
           AND status IN ('comparing','pending_confirm','committing','failed') LIMIT 1""",
        (progress_id, progress_id),
    ).fetchone()
    if active is not None:
        raise ValueError("progress_folder_busy: 进度存在活动或待修复的跟踪会话")
    expected_folder_id = str(payload.get("expectedFolderId") or "")
    expected_relative = str(payload.get("expectedRelativePath") or "").replace("\\", "/").strip("/")
    if not expected_folder_id or progress["folder_id"] != expected_folder_id:
        raise ValueError("progress_folder_identity_mismatch: folderId 已变化，请刷新后重试")
    project_path = canonical_path(os.path.join(os.path.abspath(root), project["relative_path"]))
    old_path = canonical_path(progress["folder_path"])
    old_relative = os.path.relpath(old_path, project_path).replace("\\", "/")
    if expected_relative != old_relative or not is_project_descendant(old_path, project_path):
        raise ValueError("progress_folder_path_mismatch: 当前目录路径已变化，请刷新后重试")
    if not _progress_relocation_path_identity(old_path, expected_folder_id):
        raise ValueError("progress_folder_identity_mismatch: 当前目录 folderId 与数据库不一致")
    new_name = _validate_progress_folder_name(payload.get("newName"), payload.get("reservedProjectFolderNames"))
    new_path = canonical_path(os.path.join(os.path.dirname(old_path), new_name))
    if os.path.dirname(new_path).casefold() != os.path.dirname(old_path).casefold() or not is_project_descendant(new_path, project_path):
        raise ValueError("progress_folder_name_invalid: 目标目录无效")
    new_relative = os.path.relpath(new_path, project_path).replace("\\", "/")
    if new_path == old_path:
        db.execute("DELETE FROM meta WHERE key=?", (_progress_tree_mutation_key(project["id"]),))
        db.commit()
        return {"success": True, "progressId": progress_id, "oldRelativePath": old_relative,
                "newRelativePath": new_relative, "unchanged": True}
    if new_path.casefold() != old_path.casefold() and os.path.exists(new_path):
        raise ValueError("progress_folder_target_conflict: 目标目录已存在")
    registered = db.execute(
        "SELECT id FROM progress_folders WHERE project_id=? AND folder_path_key=? AND id<>?",
        (project["id"], new_path.casefold(), progress_id),
    ).fetchone()
    if registered is not None:
        raise ValueError("progress_folder_target_conflict: 目标路径已被其他版本节点登记")
    operation_id = str(uuid.uuid4())
    temporary_path = os.path.join(os.path.dirname(old_path), f".photoflow-progress-relocate-{operation_id}")
    timestamp = int(time.time() * 1000)
    db.execute(
        """INSERT INTO progress_folder_relocations(
             id,project_id,progress_id,folder_id,old_path,old_path_key,new_path,new_path_key,
             temporary_path,old_relative_path,new_relative_path,state,error,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (operation_id, project["id"], progress_id, expected_folder_id, old_path, old_path.casefold(),
         new_path, new_path.casefold(), temporary_path, old_relative, new_relative, "prepared", "", timestamp, timestamp),
    )
    db.commit()
    operation = db.execute("SELECT * FROM progress_folder_relocations WHERE id=?", (operation_id,)).fetchone()
    completed = _advance_progress_folder_relocation(db, operation, fault_after=fault_after)
    db.execute("DELETE FROM meta WHERE key=?", (_progress_tree_mutation_key(project["id"]),))
    db.commit()
    return {
        "success": True, "operationId": operation_id, "state": completed["state"],
        "progressId": progress_id, "oldRelativePath": old_relative, "newRelativePath": new_relative,
        "progressFolder": serialize_progress(_progress_row_by_id(db, progress_id)),
    }


def _progress_tree_mutation_lease(db, project_id: str):
    raw = _meta_value(db, _progress_tree_mutation_key(project_id))
    if not raw:
        return None
    try:
        lease = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    return lease if isinstance(lease, dict) else None


def progress_update_tree_begin(db, payload: dict):
    project = project_row(db, payload["projectName"])
    token = str(payload.get("mutationToken") or uuid.uuid4())
    if len(token) > 128:
        raise ValueError("progress_tree_mutation_token_invalid: 变更令牌无效")
    timestamp = int(time.time() * 1000)
    stale_before = timestamp - 60 * 60 * 1000
    with db:
        lease = _progress_tree_mutation_lease(db, project["id"])
        if lease is not None and int(lease.get("createdAt") or 0) < stale_before:
            db.execute("DELETE FROM meta WHERE key=?", (_progress_tree_mutation_key(project["id"]),))
            lease = None
        active = db.execute(
            """SELECT 1 FROM tracking_sessions WHERE project_id=?
               AND status IN ('comparing','pending_confirm','committing','failed') LIMIT 1""",
            (project["id"],),
        ).fetchone()
        if active is not None:
            raise ValueError("node_busy: 项目中存在正在比较、确认或提交的版本，暂时不能修改版本树")
        if lease is not None and lease.get("token") != token:
            raise ValueError("node_busy: 版本树正在由另一个操作修改")
        _set_meta(
            db, _progress_tree_mutation_key(project["id"]),
            json.dumps({"token": token, "createdAt": timestamp}, separators=(",", ":")),
        )
    return {"success": True, "mutationToken": token}


def progress_update_tree_finish(db, payload: dict):
    project = project_row(db, payload["projectName"])
    token = str(payload.get("mutationToken") or "")
    lease = _progress_tree_mutation_lease(db, project["id"])
    if token and lease is not None and lease.get("token") == token:
        db.execute(
            "DELETE FROM meta WHERE key=?",
            (_progress_tree_mutation_key(project["id"]),),
        )
        db.commit()
    return {"success": True}


def _progress_update_tree_legacy(root: str, db, payload: dict):
    project = project_row(db, payload["projectName"])
    updates = payload.get("updates")
    primary_id = str(payload.get("primaryProgressId") or "")
    replacement_id = str(payload.get("replacementProgressId") or "")
    mutation_token = str(payload.get("mutationToken") or "")
    if not primary_id or not isinstance(updates, list) or not updates:
        raise ValueError("没有可更新的进度关系")
    lease = _progress_tree_mutation_lease(db, project["id"])
    if lease is not None and lease.get("token") != mutation_token:
        raise ValueError("node_busy: 版本树正在由另一个操作修改")
    if mutation_token and (lease is None or lease.get("token") != mutation_token):
        raise ValueError("progress_tree_mutation_expired: 版本树变更令牌已失效")
    active_session = db.execute(
        """SELECT 1 FROM tracking_sessions WHERE project_id=?
           AND status IN ('comparing','pending_confirm','committing','failed') LIMIT 1""",
        (project["id"],),
    ).fetchone()
    if active_session is not None:
        raise ValueError("node_busy: 项目中存在正在比较、确认或提交的版本，暂时不能修改版本树")
    rows = {row["id"]: row for row in progress_rows(db, project["id"])}
    update_ids = {str(update.get("id") or "") for update in updates}
    if "" in update_ids or len(update_ids) != len(updates) or primary_id not in update_ids:
        raise ValueError("进度更新列表无效")
    if any(progress_id not in rows for progress_id in update_ids):
        raise ValueError("要修改的进度不存在")
    children_by_parent = {}
    for row in rows.values():
        if row["parent_progress_id"] and row["relation_kind"] == "main" and row["node_role"] == "progress":
            children_by_parent.setdefault(row["parent_progress_id"], []).append(row["id"])
    expected_ids = set()

    def collect_subtree(progress_id):
        if progress_id in expected_ids:
            raise ValueError("progress_cycle: 版本树存在循环")
        expected_ids.add(progress_id)
        for child_id in children_by_parent.get(progress_id, []):
            collect_subtree(child_id)

    collect_subtree(replacement_id or primary_id)
    if replacement_id:
        replacement = rows.get(replacement_id)
        target = rows.get(primary_id)
        if replacement is None or target is None or replacement_id == primary_id:
            raise ValueError("失效进度替换目标无效")
        if replacement["media_kind"] != target["media_kind"]:
            raise ValueError("失效进度替换时不能改变图片或视频类型")
        if os.path.isdir(replacement["folder_path"]):
            raise ValueError("被替换进度的原文件夹仍然存在")
        expected_ids.discard(replacement_id)
        expected_ids.add(primary_id)
    if update_ids != expected_ids:
        raise ValueError("必须一次性更新当前进度及其全部后代")
    normalized = []
    target_versions = set()
    target_names = set()
    target_paths = set()
    project_path = canonical_path(os.path.join(os.path.abspath(root), project["relative_path"]))
    for update in updates:
        progress_id = str(update["id"])
        row = rows[progress_id]
        if row["node_role"] != "progress":
            raise ValueError("修改版本树只接受 progress 节点")
        media_kind = str(update.get("mediaKind") or row["media_kind"])
        if media_kind != row["media_kind"]:
            raise ValueError("修改进度时不能改变图片或视频类型")
        version_key = str(update.get("versionKey") or "")
        if not version_key or len(version_key) > 128 or any(ord(character) < 32 for character in version_key):
            raise ValueError("无效的版本编号")
        display_name = str(update.get("displayName") or "").strip()
        if not display_name:
            raise ValueError("进度名称不能为空")
        folder_path = canonical_path(update.get("folderPath") or "")
        external_route = row["external_link_relative_path"]
        unchanged_external = bool(external_route) and folder_path.casefold() == row["folder_path_key"]
        if external_route and not unchanged_external:
            raise ValueError("external_progress_path_immutable: 外链版本只能通过“移动外链到项目内”改变物理位置")
        if (not unchanged_external and not is_project_descendant(folder_path, project_path)) or not os.path.isdir(folder_path):
            raise ValueError("版本进度必须是项目内的文件夹")
        parent_id = update.get("parentProgressId") or None
        parent = rows.get(parent_id)
        if not parent_id:
            raise ValueError("progress_parent_required: 版本进度必须保留有效父节点")
        if parent is None or parent["missing_since"] is not None or parent["media_kind"] != media_kind or not _is_valid_structural_parent(parent):
            raise ValueError("父版本进度不存在")
        version_identity = (media_kind, version_key.casefold())
        name_identity = display_name.casefold()
        path_identity = folder_path.casefold()
        if version_identity in target_versions or name_identity in target_names or path_identity in target_paths:
            raise ValueError("进度树更新包含重复版本、名称或文件夹")
        target_versions.add(version_identity); target_names.add(name_identity); target_paths.add(path_identity)
        tracking_enabled = int(bool(update.get("trackingEnabled", row["tracking_enabled"])))
        tracking_state = str(update.get("trackingState") or ("ready" if tracking_enabled else "disabled"))
        if tracking_state not in PROGRESS_TRACKING_STATES:
            raise ValueError("无效的版本跟踪状态")
        if not tracking_enabled:
            tracking_state = "disabled"
        normalized.append((progress_id, media_kind, version_key, parent_id, display_name, folder_path,
                           external_route, tracking_enabled, tracking_state))
    for row in rows.values():
        if row["id"] in update_ids or replacement_id and row["id"] == replacement_id:
            continue
        if ((row["media_kind"], row["version_key"].casefold()) in target_versions
                or row["display_name"].casefold() in target_names or row["folder_path_key"] in target_paths):
            raise ValueError("目标版本、名称或文件夹已被其他进度占用")
    timestamp = int(time.time() * 1000)
    try:
        for index, item in enumerate(normalized):
            db.execute("UPDATE progress_folders SET version_key=?,updated_at=? WHERE id=?",
                       (f"__progress_update_{index}_{uuid.uuid4().hex}", timestamp, item[0]))
        for progress_id, media_kind, version_key, parent_id, display_name, folder_path, external_route, tracking_enabled, tracking_state in normalized:
            db.execute(
                """UPDATE progress_folders SET media_kind=?,version_key=?,parent_progress_id=?,relation_kind='main',
                   display_name=?,folder_path=?,folder_path_key=?,folder_id=?,external_link_relative_path=?,
                   tracking_enabled=?,tracking_state=?,missing_since=NULL,updated_at=? WHERE id=?""",
                (media_kind, version_key, parent_id, display_name, folder_path, folder_path.casefold(),
                 directory_identity(folder_path), external_route, tracking_enabled, tracking_state, timestamp, progress_id),
            )
        if replacement_id:
            db.execute(
                """UPDATE progress_folders SET folder_id=NULL,missing_since=COALESCE(missing_since,?),updated_at=?
                   WHERE id=?""", (timestamp, timestamp, replacement_id),
            )
        if mutation_token:
            db.execute("DELETE FROM meta WHERE key=?", (_progress_tree_mutation_key(project["id"]),))
        db.commit()
    except Exception:
        db.rollback()
        raise
    refreshed = progress_rows(db, project["id"])
    return {"success": True, "progressFolder": serialize_progress(next(row for row in refreshed if row["id"] == primary_id)),
            "progressFolders": [serialize_progress(row) for row in refreshed]}


def _progress_update_tree_single(root: str, db, payload: dict):
    del root
    project = project_row(db, payload["projectName"])
    updates = payload.get("updates")
    primary_id = str(payload.get("primaryProgressId") or "")
    mutation_token = str(payload.get("mutationToken") or "")
    if not primary_id or not isinstance(updates, list) or len(updates) != 1:
        raise ValueError("没有可更新的进度关系")

    lease = _progress_tree_mutation_lease(db, project["id"])
    if lease is not None and lease.get("token") != mutation_token:
        raise ValueError("node_busy: 版本树正在由另一个操作修改")
    if mutation_token and (lease is None or lease.get("token") != mutation_token):
        raise ValueError("progress_tree_mutation_expired: 版本树变更令牌已失效")
    active_session = db.execute(
        """SELECT 1 FROM tracking_sessions WHERE project_id=?
           AND status IN ('comparing','pending_confirm','committing','failed') LIMIT 1""",
        (project["id"],),
    ).fetchone()
    if active_session is not None:
        raise ValueError("node_busy: 项目中存在正在比较、确认或提交的版本，暂时不能修改版本树")

    rows = {row["id"]: row for row in progress_rows(db, project["id"])}
    update = updates[0]
    progress_id = str(update.get("id") or "")
    if not progress_id or progress_id != primary_id:
        raise ValueError("进度更新列表无效")
    row = rows.get(progress_id)
    if row is None or row["node_role"] != "progress":
        raise ValueError("要修改的进度不存在")
    media_kind = str(update.get("mediaKind") or row["media_kind"])
    if media_kind != row["media_kind"]:
        raise ValueError("修改进度时不能改变图片或视频类型")
    version_key = str(update.get("versionKey") or "").strip()
    if not re.fullmatch(r"\d+(?:_\d+)*", version_key) or len(version_key) > 128:
        raise ValueError("无效的版本编号")
    duplicate = db.execute(
        "SELECT 1 FROM progress_folders WHERE project_id=? AND media_kind=? AND version_key=? COLLATE NOCASE AND id<>?",
        (project["id"], media_kind, version_key, progress_id),
    ).fetchone()
    if duplicate is not None:
        raise ValueError(f"版本 _{version_key} 已存在")
    parent_id = str(update.get("parentProgressId") or "")
    parent = rows.get(parent_id)
    if not parent_id:
        raise ValueError("progress_parent_required: 版本进度必须保留有效父节点")
    if parent is None or parent["missing_since"] is not None or parent["media_kind"] != media_kind or not _is_valid_structural_parent(parent):
        raise ValueError("父版本进度不存在")
    cursor = parent
    visited = set()
    while cursor is not None:
        if cursor["id"] == progress_id:
            raise ValueError("progress_cycle: 进度不能移动到自己的后代版本下")
        if cursor["id"] in visited:
            raise ValueError("progress_cycle: 版本树存在循环")
        visited.add(cursor["id"])
        cursor = rows.get(cursor["parent_progress_id"]) if cursor["parent_progress_id"] else None
    tracking_enabled = int(bool(update.get("trackingEnabled", row["tracking_enabled"])))
    rename_from_parent = int(bool(update.get("renameFromParent", row["rename_from_parent"])))
    copy_missing_from_parent = int(bool(update.get("copyMissingFromParent", row["copy_missing_from_parent"])))
    tracking_state = str(update.get("trackingState") or row["tracking_state"] or ("ready" if tracking_enabled else "disabled"))
    if tracking_state not in PROGRESS_TRACKING_STATES:
        raise ValueError("无效的版本跟踪状态")
    if not tracking_enabled:
        tracking_state = "disabled"
        if rename_from_parent or copy_missing_from_parent:
            raise ValueError("未开启跟踪时不能保存沿用文件名或补齐策略")

    timestamp = int(time.time() * 1000)
    try:
        db.execute(
            """UPDATE progress_folders SET version_key=?,parent_progress_id=?,relation_kind='main',
               tracking_enabled=?,tracking_state=?,rename_from_parent=?,copy_missing_from_parent=?,updated_at=?
               WHERE id=?""",
            (version_key, parent_id, tracking_enabled, tracking_state, rename_from_parent,
             copy_missing_from_parent, timestamp, progress_id),
        )
        if mutation_token:
            db.execute(
                "DELETE FROM meta WHERE key=?",
                (_progress_tree_mutation_key(project["id"]),),
            )
        db.commit()
    except Exception:
        db.rollback()
        raise

    refreshed = progress_rows(db, project["id"])
    primary = next(row for row in refreshed if row["id"] == primary_id)
    return {
        "success": True,
        "progressFolder": serialize_progress(primary),
        "progressFolders": [serialize_progress(row) for row in refreshed],
    }


def progress_update_tree(root: str, db, payload: dict):
    updates = payload.get("updates")
    if payload.get("replacementProgressId") or isinstance(updates, list) and len(updates) != 1:
        return _progress_update_tree_legacy(root, db, payload)
    return _progress_update_tree_single(root, db, payload)


def _progress_row_by_id(db, progress_id: str):
    row = db.execute("SELECT project_id FROM progress_folders WHERE id=?", (progress_id,)).fetchone()
    if row is None:
        raise ValueError("版本节点不存在")
    return next(item for item in progress_rows(db, row["project_id"]) if item["id"] == progress_id)


def progress_policy_save(db, payload: dict):
    progress_id = str(payload.get("progressId") or "")
    row = _progress_row_by_id(db, progress_id)
    tracking_enabled = bool(payload.get("trackingEnabled", row["tracking_enabled"]))
    rename_from_parent = bool(payload.get("renameFromParent", row["rename_from_parent"]))
    copy_missing_from_parent = bool(payload.get("copyMissingFromParent", row["copy_missing_from_parent"]))
    restricted_policy = row["node_role"] in ("original", "artifact", "workflow", "broll") \
        or row["relation_kind"] == "auxiliary" or row["node_role"] == "progress" \
        and (row["parent_progress_id"] is None or row["relation_kind"] != "main")
    if restricted_policy:
        if tracking_enabled or rename_from_parent or copy_missing_from_parent:
            raise ValueError("original/selection/artifact/workflow/broll 节点禁止开启版本跟踪")
    if not tracking_enabled and (rename_from_parent or copy_missing_from_parent):
        raise ValueError("未开启跟踪时不能保存沿用文件名或补齐策略")
    tracking_state = str(payload.get("trackingState") or row["tracking_state"])
    if tracking_state not in PROGRESS_TRACKING_STATES:
        raise ValueError("无效的版本跟踪状态")
    if not tracking_enabled or restricted_policy:
        tracking_state = "disabled"
    timestamp = int(time.time() * 1000)
    db.execute(
        """UPDATE progress_folders SET tracking_enabled=?,rename_from_parent=?,copy_missing_from_parent=?,
           tracking_state=?,updated_at=? WHERE id=?""",
        (int(tracking_enabled), int(rename_from_parent), int(copy_missing_from_parent),
         tracking_state, timestamp, progress_id),
    )
    db.commit()
    return {"success": True, "progressFolder": serialize_progress(_progress_row_by_id(db, progress_id))}


def progress_mark_stale(db, payload: dict):
    progress_id = str(payload.get("progressId") or "")
    timestamp = int(time.time() * 1000)
    changed = db.execute(
        """UPDATE progress_folders SET tracking_state='stale',updated_at=?
           WHERE id=? AND node_role='progress' AND relation_kind='main' AND parent_progress_id IS NOT NULL
             AND tracking_enabled=1 AND tracking_state='ready' AND missing_since IS NULL""",
        (timestamp, progress_id),
    ).rowcount
    db.commit()
    return {"success": True, "changed": bool(changed), "progressFolder": serialize_progress(_progress_row_by_id(db, progress_id))}


def progress_mark_ready(db, payload: dict):
    progress_id = str(payload.get("progressId") or "")
    row = _progress_row_by_id(db, progress_id)
    if (row["node_role"] != "progress" or row["relation_kind"] != "main"
            or not row["parent_progress_id"] or not row["tracking_enabled"]):
        raise ValueError("只有已开启跟踪的 main progress 可以恢复 ready")
    snapshot = payload.get("trackingSnapshot") or {}
    if not isinstance(snapshot, (dict, list)):
        raise ValueError("无效的跟踪快照")
    timestamp = int(payload.get("trackedAt") or int(time.time() * 1000))
    signature = str(payload.get("folderSignature") or "") or None
    db.execute(
        """UPDATE progress_folders SET tracking_state='ready',last_tracked_at=?,tracking_snapshot_json=?,
           folder_signature=?,updated_at=? WHERE id=?""",
        (timestamp, json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")), signature, timestamp, progress_id),
    )
    db.commit()
    return {"success": True, "progressFolder": serialize_progress(_progress_row_by_id(db, progress_id))}


def progress_copy_missing_children(db, payload: dict):
    progress_id = str(payload.get("progressId") or "")
    parent = _progress_row_by_id(db, progress_id)
    rows = db.execute(
        """SELECT id FROM progress_folders WHERE project_id=? AND media_kind=? AND parent_progress_id=?
           AND relation_kind='main' AND node_role='progress' AND tracking_enabled=1
           AND copy_missing_from_parent=1 AND tracking_state='ready' AND missing_since IS NULL
           ORDER BY created_at,id""",
        (parent["project_id"], parent["media_kind"], progress_id),
    ).fetchall()
    return {"success": True, "progressIds": [row["id"] for row in rows]}


def progress_main_branch(db, payload: dict):
    progress_id = str(payload.get("progressId") or "")
    start = _progress_row_by_id(db, progress_id)
    if start["node_role"] == "selection" or start["relation_kind"] == "auxiliary":
        return {"success": True, "progressFolders": []}
    include_missing = bool(payload.get("includeMissing"))
    rows = progress_rows(db, start["project_id"])
    by_id = {row["id"]: row for row in rows}
    selected = {progress_id}
    cursor = start
    while cursor["parent_progress_id"] and cursor["relation_kind"] == "main":
        cursor = by_id.get(cursor["parent_progress_id"])
        if cursor is None or cursor["node_role"] == "selection":
            break
        selected.add(cursor["id"])
    queue = list(selected)
    while queue:
        parent_id = queue.pop(0)
        for row in rows:
            if row["parent_progress_id"] == parent_id and row["relation_kind"] == "main" and row["node_role"] != "selection" and row["id"] not in selected:
                selected.add(row["id"])
                queue.append(row["id"])
    visible = [row for row in rows if row["id"] in selected and (include_missing or row["missing_since"] is None)]
    return {"success": True, "progressFolders": [serialize_progress(row) for row in visible]}


def progress_visible_relations(db, payload: dict):
    progress_id = str(payload.get("progressId") or "")
    start = _progress_row_by_id(db, progress_id)
    rows = progress_rows(db, start["project_id"])
    by_id = {row["id"]: row for row in rows}
    ancestors = []
    cursor = start
    visited = set()
    while cursor["parent_progress_id"]:
        if cursor["id"] in visited:
            raise ValueError("版本关系形成循环")
        visited.add(cursor["id"])
        cursor = by_id.get(cursor["parent_progress_id"])
        if cursor is None:
            break
        if cursor["missing_since"] is None:
            ancestors.append(cursor["id"])
    descendants = []
    visible_parent_by_id = {}
    queue = [(progress_id, progress_id)]
    while queue:
        parent_id, nearest_visible = queue.pop(0)
        for child in (row for row in rows if row["parent_progress_id"] == parent_id):
            if child["missing_since"] is None:
                descendants.append(child["id"])
                visible_parent_by_id[child["id"]] = nearest_visible
                queue.append((child["id"], child["id"]))
            else:
                queue.append((child["id"], nearest_visible))
    return {
        "success": True,
        "visibleAncestorIds": ancestors,
        "visibleDescendantIds": descendants,
        "visibleParentById": visible_parent_by_id,
    }


def cleanup_progress_tombstones(root: str, db, cutoff: int | None = None):
    cutoff = int(cutoff if cutoff is not None else int(time.time() * 1000) - PROGRESS_TOMBSTONE_RETENTION_MS)
    candidates = db.execute(
        """SELECT * FROM progress_folders WHERE missing_since IS NOT NULL AND missing_since<=?
           ORDER BY project_id,media_kind,missing_since""",
        (cutoff,),
    ).fetchall()
    removed = []
    removed_selection_metadata = []
    reparented = 0
    skipped = []
    timestamp = int(time.time() * 1000)
    for candidate in candidates:
        if db.execute(
            "SELECT 1 FROM tracking_sessions WHERE progress_id=? OR parent_progress_id=? LIMIT 1",
            (candidate["id"], candidate["id"]),
        ).fetchone() is not None:
            skipped.append(candidate["id"])
            continue
        if os.path.isdir(candidate["folder_path"]):
            skipped.append(candidate["id"])
            continue
        parent_id = candidate["parent_progress_id"]
        while parent_id:
            parent = db.execute("SELECT * FROM progress_folders WHERE id=?", (parent_id,)).fetchone()
            if parent is None:
                parent_id = None
                break
            if parent["missing_since"] is None:
                break
            parent_id = parent["parent_progress_id"]
        if parent_id:
            replacement_parent = db.execute("SELECT * FROM progress_folders WHERE id=?", (parent_id,)).fetchone()
            if replacement_parent is None or not _is_valid_structural_parent(replacement_parent):
                parent_id = None
        children = db.execute("SELECT * FROM progress_folders WHERE parent_progress_id=?", (candidate["id"],)).fetchall()
        if children and parent_id is None:
            # Removing this tombstone would silently turn every structural
            # child into an illegal root. Keep the metadata for an explicit
            # repair instead of deleting or rewriting user relationships.
            skipped.append(candidate["id"])
            continue
        orphaned_selections = [child for child in children if parent_id is None and child["node_role"] == "selection"]
        if orphaned_selections:
            blocked_selection_ids = [child["id"] for child in orphaned_selections if db.execute(
                """SELECT 1 WHERE EXISTS(SELECT 1 FROM tracking_sessions WHERE progress_id=? OR parent_progress_id=?)
                   OR EXISTS(SELECT 1 FROM progress_folders WHERE parent_progress_id=?)""",
                (child["id"], child["id"], child["id"]),
            ).fetchone() is not None]
            if blocked_selection_ids:
                skipped.append(candidate["id"])
                continue
            # A selection node cannot legally become a root. Remove only its
            # relationship metadata; its existing folder and media stay on disk
            # and therefore become an ordinary project folder.
            for child in orphaned_selections:
                db.execute("DELETE FROM version_graph_edges WHERE source_progress_id=? OR target_progress_id=?", (child["id"], child["id"]))
                db.execute("DELETE FROM progress_folders WHERE id=?", (child["id"],))
                removed.append(child["id"])
                removed_selection_metadata.append(child["id"])
            children = [child for child in children if child["id"] not in removed_selection_metadata]
        for child in children:
            relation_kind = None if parent_id is None else ("auxiliary" if child["node_role"] == "selection" else "main")
            db.execute(
                """UPDATE progress_folders SET parent_progress_id=?,relation_kind=?,updated_at=? WHERE id=?""",
                (parent_id, relation_kind, timestamp, child["id"]),
            )
            reparented += 1
        db.execute("DELETE FROM version_graph_edges WHERE source_progress_id=? OR target_progress_id=?", (candidate["id"], candidate["id"]))
        db.execute("DELETE FROM progress_folders WHERE id=?", (candidate["id"],))
        removed.append(candidate["id"])
    return {
        "removedProgressIds": removed,
        "removedSelectionMetadataIds": removed_selection_metadata,
        "reparentedProgressCount": reparented,
        "skippedProgressIds": skipped,
    }


def progress_unregister(root: str, db, payload: dict):
    """Remove version semantics from an existing folder without touching its files."""
    project = project_row(db, payload["projectName"])
    if payload.get("skipLocationSync") is not True:
        sync_progress_folder_locations(root, db, project)
    progress_id = str(payload.get("progressId") or "")
    progress = db.execute(
        "SELECT * FROM progress_folders WHERE id=? AND project_id=?",
        (progress_id, project["id"]),
    ).fetchone()
    if progress is None:
        if payload.get("allowMissing") is True:
            return {"success": True, "progressId": progress_id, "alreadyRemoved": True}
        raise ValueError("要取消登记的版本进度不存在")
    if payload.get("expectedUpdatedAt") is not None and int(payload["expectedUpdatedAt"]) != int(progress["updated_at"]):
        raise ValueError("progress_unregister_stale")
    if progress["node_role"] != "progress":
        raise ValueError("只有普通版本进度可以取消登记")
    if not os.path.isdir(progress["folder_path"]):
        raise ValueError("版本文件夹已经不存在，请使用失效版本清理")

    replacement_parent_id = progress["parent_progress_id"]
    children = db.execute(
        "SELECT id,node_role FROM progress_folders WHERE project_id=? AND parent_progress_id=?",
        (project["id"], progress_id),
    ).fetchall()
    if children:
        replacement_parent = db.execute(
            "SELECT * FROM progress_folders WHERE id=? AND project_id=?",
            (replacement_parent_id, project["id"]),
        ).fetchone() if replacement_parent_id else None
        if replacement_parent is None or replacement_parent["missing_since"] is not None or not _is_valid_structural_parent(replacement_parent):
            raise ValueError("该版本仍有下游节点，请先为下游节点选择有效父版本")

    project_path = os.path.join(os.path.abspath(root), project["relative_path"])
    relative_path = progress["external_link_relative_path"] or os.path.relpath(progress["folder_path"], project_path).replace("\\", "/")
    old_layout_key = f"progress:{progress_id}"
    ordinary_layout_key = f"entry:{relative_path}"
    timestamp = int(time.time() * 1000)
    with db:
        component_scope_key = payload.get("componentScopeKey")
        if component_scope_key:
            scope_prefix = str(component_scope_key) + os.sep.casefold() + "%"
            scoped = db.execute(
                """SELECT 1 FROM progress_folders WHERE id=? AND project_id=?
                   AND external_link_relative_path IS NULL AND (folder_path_key=? OR folder_path_key LIKE ?)""",
                (progress_id, project["id"], str(component_scope_key), scope_prefix),
            ).fetchone()
            if scoped is None:
                raise ValueError("progress_component_scope_invalid")
        db.execute(
            "DELETE FROM tracking_sessions WHERE progress_id=? OR parent_progress_id=?",
            (progress_id, progress_id),
        )
        reparented_progress_count = db.execute(
            """UPDATE progress_folders SET parent_progress_id=?,
               relation_kind=CASE WHEN node_role='selection' THEN 'auxiliary' ELSE 'main' END,
               tracking_state=CASE WHEN node_role='progress' AND tracking_enabled=1 THEN 'stale' ELSE tracking_state END,
               tracking_snapshot_json=CASE WHEN node_role='progress' THEN '{}' ELSE tracking_snapshot_json END,
               last_tracked_at=CASE WHEN node_role='progress' THEN NULL ELSE last_tracked_at END,
               updated_at=? WHERE project_id=? AND parent_progress_id=?""",
            (replacement_parent_id, timestamp, project["id"], progress_id),
        ).rowcount
        db.execute(
            "DELETE FROM version_graph_edges WHERE source_progress_id=? OR target_progress_id=?",
            (progress_id, progress_id),
        )
        db.execute("DELETE FROM progress_folders WHERE id=?", (progress_id,))
        ensure_selection_workflow_inputs(db, project["id"])
        affected_scopes = [row["scope_key"] for row in db.execute(
            "SELECT scope_key FROM version_tree_node_positions WHERE project_id=? AND node_key=?",
            (project["id"], old_layout_key),
        ).fetchall()]
        db.execute(
            """UPDATE version_tree_node_positions SET node_key=?,updated_at=?
               WHERE project_id=? AND node_key=?""",
            (ordinary_layout_key, timestamp, project["id"], old_layout_key),
        )
        if affected_scopes:
            placeholders = ",".join("?" for _ in affected_scopes)
            db.execute(
                f"""UPDATE version_tree_layouts SET revision=revision+1,updated_at=?
                    WHERE project_id=? AND scope_key IN ({placeholders})""",
                (timestamp, project["id"], *affected_scopes),
            )
    return {
        "success": True,
        "progressId": progress_id,
        "versionKey": progress["version_key"],
        "relativePath": relative_path,
        "reparentedProgressCount": reparented_progress_count,
    }


def _component_scope_paths(payload: dict):
    project_path = canonical_path(str(payload.get("projectPath") or ""))
    scope_path = canonical_path(str(payload.get("scopePath") or ""))
    project_key = project_path.casefold()
    scope_key = scope_path.casefold()
    if not payload.get("projectPath") or not payload.get("scopePath") or not (scope_key == project_key or scope_key.startswith(project_key + os.sep.casefold())):
        raise ValueError("component_scope_invalid")
    return project_path, scope_path, scope_key


def _component_progress_in_scope(row, scope_key: str) -> bool:
    if row is None or row["external_link_relative_path"]:
        return False
    folder_key = canonical_path(str(row["folder_path"] or "")).casefold()
    return folder_key == scope_key or folder_key.startswith(scope_key + os.sep.casefold())


def progress_component_manage(root: str, db, payload: dict):
    allowed = {"action", "projectName", "projectId", "projectPath", "scopePath", "progressId", "expectedUpdatedAt", "displayName", "trackingEnabled", "sourceProgressId", "targetProgressId", "newSourceProgressId", "edgeKind"}
    if not isinstance(payload, dict) or set(payload) - allowed:
        raise ValueError("progress_component_payload_invalid")
    action = str(payload.get("action") or "")
    project = project_row(db, str(payload.get("projectName") or ""))
    if str(project["id"]) != str(payload.get("projectId") or ""):
        raise ValueError("progress_component_project_invalid")
    project_path, _scope_path, scope_key = _component_scope_paths(payload)
    expected_project_path = canonical_path(os.path.join(canonical_path(root), project["relative_path"]))
    if project_path.casefold() != expected_project_path.casefold():
        raise ValueError("progress_component_project_scope_invalid")
    def scoped_node(node_id: str):
        row = db.execute("SELECT * FROM progress_folders WHERE id=? AND project_id=?", (str(node_id or ""), project["id"])).fetchone()
        if not _component_progress_in_scope(row, scope_key):
            raise ValueError("progress_component_scope_invalid")
        return row
    if action == "update":
        row = scoped_node(payload.get("progressId"))
        if int(row["updated_at"]) != int(payload.get("expectedUpdatedAt") or -1): raise ValueError("progress_component_stale")
        changes = [field for field in ("displayName", "trackingEnabled") if field in payload]
        if not changes or row["node_role"] not in ("progress", "selection", "workflow"): raise ValueError("progress_component_update_invalid")
        fields, values = [], []
        if "displayName" in payload:
            display_name = str(payload["displayName"]).strip()
            if not display_name or len(display_name) > 160: raise ValueError("progress_component_name_invalid")
            fields.append("display_name=?"); values.append(display_name)
        if "trackingEnabled" in payload:
            if not isinstance(payload["trackingEnabled"], bool) or row["node_role"] != "progress": raise ValueError("progress_component_tracking_invalid")
            fields.extend(("tracking_enabled=?", "tracking_state=?")); values.extend((int(payload["trackingEnabled"]), "stale" if payload["trackingEnabled"] else "disabled"))
        timestamp = max(int(time.time() * 1000), int(row["updated_at"]) + 1); fields.append("updated_at=?"); values.append(timestamp); values.extend((row["id"], row["updated_at"], scope_key, scope_key + os.sep.casefold() + "%"))
        with db:
            if db.execute(f"""UPDATE progress_folders SET {', '.join(fields)} WHERE id=? AND updated_at=?
                               AND external_link_relative_path IS NULL AND (folder_path_key=? OR folder_path_key LIKE ?)""", values).rowcount != 1:
                current = scoped_node(row["id"])
                if int(current["updated_at"]) != int(row["updated_at"]): raise ValueError("progress_component_stale")
                raise ValueError("progress_component_scope_invalid")
        result = next(item for item in progress_rows(db, project["id"], True) if item["id"] == row["id"])
        return {"success": True, "progressFolder": serialize_progress(result)}
    if action == "unregister":
        scoped_node(payload.get("progressId"))
        return progress_unregister(root, db, {"projectName": project["name"], "progressId": payload.get("progressId"), "expectedUpdatedAt": payload.get("expectedUpdatedAt"), "skipLocationSync": True, "componentScopeKey": scope_key})
    source_id = str(payload.get("sourceProgressId") or ""); target_id = str(payload.get("targetProgressId") or ""); edge_kind = str(payload.get("edgeKind") or "")
    scoped_node(source_id); scoped_node(target_id)
    if action == "edgeCreate":
        target = db.execute("SELECT updated_at FROM progress_folders WHERE id=? AND project_id=?", (target_id, project["id"])).fetchone()
        if target is None or int(target["updated_at"]) != int(payload.get("expectedUpdatedAt") or -1): raise ValueError("progress_component_stale")
        project_id, source_id, target_id, edge_kind = _validated_version_graph_edge(db, {"projectId": project["id"], "sourceProgressId": source_id, "targetProgressId": target_id, "edgeKind": edge_kind})
        timestamp = int(time.time() * 1000); edge_id = str(uuid.uuid4())
        with db:
            scoped_node(source_id); scoped_node(target_id)
            project_id, source_id, target_id, edge_kind = _validated_version_graph_edge(db, {"projectId": project["id"], "sourceProgressId": source_id, "targetProgressId": target_id, "edgeKind": edge_kind})
            db.execute("INSERT INTO version_graph_edges(id,project_id,source_progress_id,target_progress_id,edge_kind,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", (edge_id, project_id, source_id, target_id, edge_kind, timestamp, timestamp))
        return {"success": True, "edge": serialize_version_graph_edge(db.execute("SELECT * FROM version_graph_edges WHERE id=?", (edge_id,)).fetchone())}
    existing = db.execute("SELECT * FROM version_graph_edges WHERE project_id=? AND source_progress_id=? AND target_progress_id=? AND edge_kind=?", (project["id"], source_id, target_id, edge_kind)).fetchone()
    if existing is None: raise ValueError("progress_component_edge_not_found")
    if int(existing["updated_at"]) != int(payload.get("expectedUpdatedAt") or -1): raise ValueError("progress_component_stale")
    if action == "edgeDelete":
        with db:
            scoped_node(source_id); scoped_node(target_id)
            db.execute("DELETE FROM version_graph_edges WHERE id=? AND updated_at=?", (existing["id"], existing["updated_at"]))
        return {"success": True, "edgeId": existing["id"]}
    if action == "edgeReplaceSource":
        new_source = str(payload.get("newSourceProgressId") or "")
        scoped_node(new_source)
        _validated_version_graph_edge(db, {"projectId": project["id"], "sourceProgressId": new_source, "targetProgressId": target_id, "edgeKind": edge_kind}, existing["id"])
        timestamp = max(int(time.time() * 1000), int(existing["updated_at"]) + 1)
        with db:
            scoped_node(source_id); scoped_node(target_id); scoped_node(new_source)
            _validated_version_graph_edge(db, {"projectId": project["id"], "sourceProgressId": new_source, "targetProgressId": target_id, "edgeKind": edge_kind}, existing["id"])
            if db.execute("UPDATE version_graph_edges SET source_progress_id=?,updated_at=? WHERE id=? AND updated_at=?", (new_source, timestamp, existing["id"], existing["updated_at"])).rowcount != 1: raise ValueError("progress_component_stale")
        return {"success": True, "edge": serialize_version_graph_edge(db.execute("SELECT * FROM version_graph_edges WHERE id=?", (existing["id"],)).fetchone())}
    raise ValueError("progress_component_action_invalid")


def progress_delete_missing(root: str, db, payload: dict):
    project = project_row(db, payload["projectName"])
    sync_progress_folder_locations(root, db, project)
    progress_id = str(payload.get("progressId") or "")
    progress = db.execute(
        "SELECT * FROM progress_folders WHERE id=? AND project_id=?",
        (progress_id, project["id"]),
    ).fetchone()
    if progress is None:
        raise ValueError("失效版本记录不存在")
    if progress["node_role"] == "original" or progress["version_key"] == "0":
        raise ValueError("原始版本 V0 受保护，不能移除")
    if os.path.isdir(progress["folder_path"]):
        raise ValueError("版本文件夹仍然存在，不能按失效记录移除")
    batches = db.execute(
        """SELECT * FROM version_batches
           WHERE project_id=? AND (source_folder_path_key=? OR (source_folder_id IS NOT NULL AND source_folder_id=?))
           ORDER BY sequence""",
        (project["id"], progress["folder_path_key"], progress["folder_id"]),
    ).fetchall()
    batch_ids = [row["id"] for row in batches]
    version_rows = []
    if batch_ids:
        placeholders = ",".join("?" for _ in batch_ids)
        version_rows = db.execute(
            f"""SELECT DISTINCT versions.* FROM versions
                JOIN batch_items ON batch_items.version_id=versions.id
                WHERE batch_items.batch_id IN ({placeholders}) AND versions.is_deleted=0""",
            batch_ids,
        ).fetchall()
    # The filesystem is authoritative here. A stale file_missing flag must never
    # allow a still-existing media file to be detached from version history.
    available_count = sum(os.path.isfile(row["file_path"]) for row in version_rows)
    if available_count:
        raise ValueError(f"该节点仍关联 {available_count} 个可用文件，请在版本管理中逐个处理")
    structural_children = db.execute(
        "SELECT 1 FROM progress_folders WHERE project_id=? AND parent_progress_id=? LIMIT 1",
        (project["id"], progress_id),
    ).fetchone()
    if structural_children is not None:
        replacement_parent = db.execute(
            "SELECT * FROM progress_folders WHERE id=? AND project_id=?",
            (progress["parent_progress_id"], project["id"]),
        ).fetchone() if progress["parent_progress_id"] else None
        if replacement_parent is None or replacement_parent["missing_since"] is not None or not _is_valid_structural_parent(replacement_parent):
            raise ValueError("该失效版本仍有下游节点，请先为下游节点选择有效父版本")

    timestamp = int(time.time() * 1000)
    layout_key = f"progress:{progress_id}"
    affected_scopes = [row["scope_key"] for row in db.execute(
        "SELECT scope_key FROM version_tree_node_positions WHERE project_id=? AND node_key=?",
        (project["id"], layout_key),
    ).fetchall()]
    with db:
        cleanup = delete_version_rows(db, version_rows)
        deleted_batch_ids = set(batch_ids)
        parent_by_batch = {row["id"]: row["parent_batch_id"] for row in batches}
        for batch in db.execute(
            "SELECT id,parent_batch_id FROM version_batches WHERE project_id=? AND parent_batch_id IS NOT NULL",
            (project["id"],),
        ).fetchall():
            parent_id = batch["parent_batch_id"]
            visited = set()
            while parent_id in deleted_batch_ids and parent_id not in visited:
                visited.add(parent_id)
                parent_id = parent_by_batch.get(parent_id)
            if parent_id != batch["parent_batch_id"]:
                db.execute("UPDATE version_batches SET parent_batch_id=? WHERE id=?", (parent_id, batch["id"]))

        session_parameters = [progress_id, progress_id]
        session_predicate = "progress_id=? OR parent_progress_id=?"
        if batch_ids:
            placeholders = ",".join("?" for _ in batch_ids)
            session_predicate += f" OR committed_batch_id IN ({placeholders})"
            session_parameters.extend(batch_ids)
        session_ids = [row["id"] for row in db.execute(
            f"SELECT id FROM tracking_sessions WHERE {session_predicate}", session_parameters,
        ).fetchall()]
        if session_ids:
            session_placeholders = ",".join("?" for _ in session_ids)
            db.execute(f"DELETE FROM tracking_session_items WHERE session_id IN ({session_placeholders})", session_ids)
            db.execute(f"DELETE FROM tracking_sessions WHERE id IN ({session_placeholders})", session_ids)

        if batch_ids:
            placeholders = ",".join("?" for _ in batch_ids)
            db.execute(f"DELETE FROM batch_items WHERE batch_id IN ({placeholders})", batch_ids)
            db.execute(f"DELETE FROM batch_file_operations WHERE batch_id IN ({placeholders})", batch_ids)
            db.execute(f"DELETE FROM version_batches WHERE id IN ({placeholders})", batch_ids)
        db.execute("DELETE FROM version_graph_edges WHERE source_progress_id=? OR target_progress_id=?", (progress_id, progress_id))
        db.execute("DELETE FROM media_import_artifact_slots WHERE progress_id=?", (progress_id,))
        db.execute("DELETE FROM legacy_selection_relation_repairs WHERE progress_id=?", (progress_id,))
        db.execute("DELETE FROM version_tree_node_positions WHERE project_id=? AND node_key=?", (project["id"], layout_key))
        if affected_scopes:
            scope_placeholders = ",".join("?" for _ in affected_scopes)
            db.execute(
                f"UPDATE version_tree_layouts SET revision=revision+1,updated_at=? WHERE project_id=? AND scope_key IN ({scope_placeholders})",
                (timestamp, project["id"], *affected_scopes),
            )
        reparented_progress_count = db.execute(
            """UPDATE progress_folders SET parent_progress_id=?,
               relation_kind=CASE WHEN ? IS NULL THEN NULL WHEN node_role='selection' THEN 'auxiliary' ELSE 'main' END,
               updated_at=? WHERE parent_progress_id=?""",
            (progress["parent_progress_id"], progress["parent_progress_id"], timestamp, progress_id),
        ).rowcount
        db.execute("DELETE FROM progress_folders WHERE id=?", (progress_id,))
    return {
        "success": True,
        "progressId": progress_id,
        "versionKey": progress["version_key"],
        "deletedVersionCount": len(version_rows),
        "deletedBatchCount": len(batch_ids),
        "reparentedProgressCount": reparented_progress_count,
        **cleanup,
    }


def batch_summary(db, batch_id: str):
    row = db.execute(
        """SELECT batches.*, parent.sequence AS parent_sequence,
           COUNT(items.id) AS item_count,
           COALESCE(SUM(CASE WHEN items.match_method='visual-hash' THEN 1 ELSE 0 END), 0) AS matched_count,
           COALESCE(SUM(CASE WHEN items.match_method='new' THEN 1 ELSE 0 END), 0) AS new_count
           FROM version_batches AS batches
           LEFT JOIN version_batches AS parent ON parent.id=batches.parent_batch_id
           LEFT JOIN batch_items AS items ON items.batch_id=batches.id
           WHERE batches.id=? GROUP BY batches.id""",
        (batch_id,),
    ).fetchone()
    return serialize_batch(row) if row else None


def batch_list(root: str, db, payload: dict):
    project = project_row(db, payload["projectName"])
    rows = db.execute(
        """SELECT batches.*, parent.sequence AS parent_sequence,
           COUNT(items.id) AS item_count,
           COALESCE(SUM(CASE WHEN items.match_method='visual-hash' THEN 1 ELSE 0 END), 0) AS matched_count,
           COALESCE(SUM(CASE WHEN items.match_method='new' THEN 1 ELSE 0 END), 0) AS new_count
           FROM version_batches AS batches
           LEFT JOIN version_batches AS parent ON parent.id=batches.parent_batch_id
           LEFT JOIN batch_items AS items ON items.batch_id=batches.id
           WHERE batches.project_id=? GROUP BY batches.id ORDER BY batches.sequence""",
        (project["id"],),
    ).fetchall()
    return {"success": True, "batches": [serialize_batch(row) for row in rows]}


def folder_media_files(folder_path: str):
    return [
        entry.path for entry in sorted(os.scandir(folder_path), key=lambda item: item.name.casefold())
        if entry.is_file() and media_type(entry.path)
    ]


def folder_media_snapshot(folder_path: str):
    snapshot = {}
    for file_path in folder_media_files(folder_path):
        stat = os.stat(file_path)
        snapshot[os.path.basename(file_path)] = {
            "size": stat.st_size,
            "modifiedAt": int(stat.st_mtime_ns / 1_000_000),
            "signature": quick_fingerprint(file_path, stat),
        }
    return snapshot


def _tracking_snapshot_parts(row):
    try:
        stored = json.loads(row["tracking_snapshot_json"] or "{}")
    except (TypeError, ValueError, json.JSONDecodeError):
        stored = {}
    if not isinstance(stored, dict):
        return {}, {}
    files = stored.get("files") if isinstance(stored.get("files"), dict) else {}
    parent = stored.get("parent") if isinstance(stored.get("parent"), dict) else {}
    return files, parent


def _tracking_pending_historical_renames(db, parent, progress, current_files: dict) -> list[dict]:
    """Return confirmed relationships whose current file still needs its parent name."""
    if not progress["rename_from_parent"] or not current_files:
        return []
    batch = db.execute(
        """SELECT batches.id FROM version_batches AS batches
           JOIN version_batches AS parent_batches ON parent_batches.id=batches.parent_batch_id
           WHERE batches.project_id=? AND batches.status='ready' AND (
             (? IS NOT NULL AND batches.source_folder_id IS NOT NULL
              AND batches.source_folder_id=?)
             OR ((? IS NULL OR batches.source_folder_id IS NULL)
                 AND batches.source_folder_path_key=?)
           ) AND (
             (? IS NOT NULL AND parent_batches.source_folder_id IS NOT NULL
              AND parent_batches.source_folder_id=?)
             OR ((? IS NULL OR parent_batches.source_folder_id IS NULL)
                 AND parent_batches.source_folder_path_key=?)
           )
           ORDER BY batches.sequence DESC LIMIT 1""",
        (progress["project_id"], progress["folder_id"], progress["folder_id"],
         progress["folder_id"], progress["folder_path_key"], parent["folder_id"],
         parent["folder_id"], parent["folder_id"], parent["folder_path_key"]),
    ).fetchone()
    if batch is None:
        return []
    rows = db.execute(
        """SELECT items.source_name,parent_versions.file_path AS parent_file_path
           FROM batch_items AS items
           JOIN versions AS child_versions ON child_versions.id=items.version_id
           JOIN versions AS parent_versions ON parent_versions.id=child_versions.parent_version_id
           WHERE items.batch_id=? AND items.match_method='visual-hash'
             AND items.review_status='confirmed' AND child_versions.is_deleted=0
             AND parent_versions.is_deleted=0""",
        (batch["id"],),
    ).fetchall()
    pending = {}
    for row in rows:
        source_name = row["source_name"]
        if not source_name or source_name not in current_files:
            continue
        reference_name = os.path.basename(str(row["parent_file_path"] or ""))
        if not reference_name:
            continue
        target_name = _rename_target_preserving_source_extension(source_name, reference_name)
        if target_name != source_name:
            pending[source_name] = {
                "sourceName": source_name,
                "referenceName": reference_name,
                "targetName": target_name,
            }
    return [pending[name] for name in sorted(pending, key=str.casefold)]


def _validated_tracking_nodes(root: str, db, project_name: str, progress_id: str):
    project = project_row(db, project_name)
    progress = db.execute(
        "SELECT * FROM progress_folders WHERE id=? AND project_id=?",
        (progress_id, project["id"]),
    ).fetchone()
    if progress is None:
        raise ValueError("主分支进度不存在")
    if progress["node_role"] != "progress" or progress["relation_kind"] != "main":
        raise ValueError("auxiliary/original 节点禁止版本比较、刷新或提交")
    if not progress["tracking_enabled"]:
        raise ValueError("该主分支进度未开启跟踪")
    if not progress["parent_progress_id"]:
        raise ValueError("主分支进度必须指定 parentProgressId")
    parent = db.execute(
        "SELECT * FROM progress_folders WHERE id=? AND project_id=? AND media_kind=?",
        (progress["parent_progress_id"], project["id"], progress["media_kind"]),
    ).fetchone()
    if not _is_valid_structural_parent(parent):
        raise ValueError("父节点不存在、媒体类型不兼容或不是主分支节点")

    visited = {progress["id"]}
    cursor = parent
    while cursor is not None:
        if cursor["id"] in visited:
            raise ValueError("主分支关系形成循环")
        visited.add(cursor["id"])
        if not cursor["parent_progress_id"]:
            break
        cursor = db.execute(
            "SELECT * FROM progress_folders WHERE id=? AND project_id=? AND media_kind=?",
            (cursor["parent_progress_id"], project["id"], progress["media_kind"]),
        ).fetchone()
        if cursor is None:
            raise ValueError("主分支父节点关系不完整")

    project_path = canonical_path(os.path.join(os.path.abspath(root), project["relative_path"]))
    project_real = canonical_path(os.path.realpath(project_path))
    if not os.path.isdir(project_real):
        raise ValueError("项目文件夹不存在")

    def validated_folder(node):
        folder_path = canonical_path(node["folder_path"])
        real_path = canonical_path(os.path.realpath(folder_path))
        if not os.path.isdir(folder_path) or not os.path.isdir(real_path) or node["missing_since"] is not None:
            raise ValueError(f"版本节点文件夹不存在：{node['display_name']}")
        external_route = normalize_external_link_relative_path(node["external_link_relative_path"])
        if not external_route:
            try:
                inside = os.path.commonpath((project_real, real_path)).casefold() == project_real.casefold()
            except ValueError:
                inside = False
            if not inside or real_path.casefold() == project_real.casefold():
                raise ValueError("版本节点目录越出项目范围")
        return real_path

    return project, parent, progress, validated_folder(parent), validated_folder(progress)


def tracking_session_create(root: str, db, payload: dict):
    progress_id = str(payload.get("progressId") or "")
    mode = str(payload.get("mode") or "compare")
    if mode not in ("compare", "refresh"):
        raise ValueError("无效的跟踪模式")
    project, parent, progress, parent_path, progress_path = _validated_tracking_nodes(
        root, db, str(payload.get("projectName") or ""), progress_id,
    )
    stale_before = int(time.time() * 1000) - 60 * 60 * 1000
    mutation = _progress_tree_mutation_lease(db, project["id"])
    if mutation is not None and int(mutation.get("createdAt") or 0) < stale_before:
        db.execute("DELETE FROM meta WHERE key=?", (_progress_tree_mutation_key(project["id"]),))
        db.commit()
        mutation = None
    if mutation is not None:
        db.commit()
        raise ValueError("node_busy: 版本树正在修改，暂时不能开始版本比较")
    active = db.execute(
        """SELECT * FROM tracking_sessions WHERE progress_id=?
           AND status IN ('comparing','pending_confirm','committing','failed') LIMIT 1""",
        (progress["id"],),
    ).fetchone()
    if active is not None:
        failed_item_count = db.execute(
            "SELECT COUNT(*) FROM tracking_session_items WHERE session_id=?", (active["id"],)
        ).fetchone()[0] if active["status"] == "failed" else 0
        if active["status"] == "failed" and not active["committed_batch_id"] and not failed_item_count:
            # A failed compare is terminal. Keeping it behind the one-active-session
            # index makes every later refresh fail forever, so discard it before
            # creating the retry session. The progress node remains stale/repairable.
            tracking_session_release(db, {"sessionId": active["id"]})
        else:
            return {
                "success": True, "sessionId": active["id"], "progressId": progress["id"],
                "parentProgressId": active["parent_progress_id"], "mode": active["mode"],
                "sessionStatus": active["status"], "reused": True,
                "parentFolderPath": parent_path, "progressFolderPath": progress_path,
            }
    timestamp = int(time.time() * 1000)
    session_id = str(payload.get("sessionId") or uuid.uuid4())
    db.execute(
        """INSERT INTO tracking_sessions(
             id,project_id,progress_id,parent_progress_id,mode,status,previous_tracking_state,
             rename_from_parent,copy_missing_from_parent,created_at,updated_at)
           VALUES(?,?,?,?,?,'comparing',?,?,?,?,?)""",
        (session_id, project["id"], progress["id"], parent["id"], mode, progress["tracking_state"],
         progress["rename_from_parent"], progress["copy_missing_from_parent"], timestamp, timestamp),
    )
    db.execute(
        "UPDATE progress_folders SET tracking_state='pending_compare',updated_at=? WHERE id=?",
        (timestamp, progress["id"]),
    )
    db.commit()
    return {
        "success": True, "sessionId": session_id, "progressId": progress["id"],
        "parentProgressId": parent["id"], "mode": mode,
        "sessionStatus": "comparing", "reused": False,
        "parentFolderPath": parent_path, "progressFolderPath": progress_path,
    }


def tracking_prepare(root: str, db, payload: dict):
    progress_id = str(payload.get("progressId") or "")
    mode = str(payload.get("mode") or "compare")
    if mode not in ("compare", "refresh"):
        raise ValueError("无效的跟踪模式")
    project, parent, progress, parent_path, progress_path = _validated_tracking_nodes(
        root, db, str(payload.get("projectName") or ""), progress_id,
    )
    previous_files, previous_parent = _tracking_snapshot_parts(progress)
    current_files = folder_media_snapshot(progress_path)
    # The parent snapshot is also the optimistic-concurrency token for the
    # confirmation window. It must be captured even when copy-missing is off;
    # otherwise a changed parent can silently invalidate accepted matches.
    current_parent = folder_media_snapshot(parent_path)
    historical_matches = []
    if mode == "refresh" and previous_files:
        changed_source_names = set(
            name for name, signature in current_files.items()
            if previous_files.get(name) != signature
        )
        historical_matches = [
            match for match in _tracking_pending_historical_renames(db, parent, progress, current_files)
            if match["sourceName"] not in changed_source_names
        ]
        source_names = sorted(changed_source_names, key=str.casefold)
        removed_names = sorted(name for name in previous_files if name not in current_files)
    else:
        source_names = sorted(current_files)
        removed_names = []
    copy_candidate_names = []
    if progress["copy_missing_from_parent"]:
        copy_candidate_names = sorted(
            name for name, signature in current_parent.items()
            if previous_parent.get(name) != signature and name not in current_files
        )
    session_id = str(payload.get("sessionId") or "")
    if session_id:
        session = db.execute(
            "SELECT * FROM tracking_sessions WHERE id=? AND project_id=? AND progress_id=?",
            (session_id, project["id"], progress["id"]),
        ).fetchone()
        if session is None or session["status"] != "comparing" or session["mode"] != mode:
            raise ValueError("跟踪会话不存在或状态无效")
    else:
        session_id = tracking_session_create(root, db, payload)["sessionId"]
    db.execute(
        """UPDATE tracking_sessions SET prepared_files_snapshot_json=?,
           prepared_parent_snapshot_json=?,updated_at=? WHERE id=?""",
        (json.dumps(current_files, ensure_ascii=False, separators=(",", ":")),
         json.dumps(current_parent, ensure_ascii=False, separators=(",", ":")),
         int(time.time() * 1000), session_id),
    )
    db.commit()
    return {
        "success": True,
        "sessionId": session_id,
        "progressId": progress["id"],
        "parentProgressId": parent["id"],
        "mode": mode,
        "parentFolderPath": parent_path,
        "progressFolderPath": progress_path,
        "sourceNames": source_names,
        "historicalMatches": historical_matches,
        "removedNames": removed_names,
        "copyCandidateNames": copy_candidate_names,
        "renameFromParent": bool(progress["rename_from_parent"]),
        "copyMissingFromParent": bool(progress["copy_missing_from_parent"]),
    }


def _valid_tracking_file_name(value) -> str:
    value = str(value or "")
    if not value or os.path.basename(value) != value or len(value) > 255:
        raise ValueError("跟踪结果包含无效文件名")
    return value


def tracking_store_preview(db, payload: dict):
    session_id = str(payload.get("sessionId") or "")
    session = db.execute("SELECT * FROM tracking_sessions WHERE id=?", (session_id,)).fetchone()
    if session is None or session["status"] != "comparing":
        raise ValueError("跟踪会话不存在或状态无效")
    raw_items = payload.get("items") or []
    if not isinstance(raw_items, list) or len(raw_items) > 50_000:
        raise ValueError("跟踪确认结果数量无效")
    timestamp = int(time.time() * 1000)
    db.execute("DELETE FROM tracking_session_items WHERE session_id=?", (session_id,))
    for item in raw_items:
        kind = str(item.get("kind") or "")
        if kind not in ("recognized", "new", "copy_missing", "missing"):
            raise ValueError("无效的跟踪确认项目类型")
        source_name = _valid_tracking_file_name(item.get("sourceName")) if item.get("sourceName") else None
        reference_name = _valid_tracking_file_name(item.get("referenceName")) if item.get("referenceName") else None
        target_name = _valid_tracking_file_name(item.get("targetName")) if item.get("targetName") else source_name
        status = str(item.get("status") or "")
        expected_status = {
            "recognized": "recognized", "new": "pending_confirmation",
            "copy_missing": "pending_confirmation", "missing": "missing_reference",
        }[kind]
        if status != expected_status:
            raise ValueError("比较结果不能跳过用户确认")
        db.execute(
            """INSERT INTO tracking_session_items(
                 id,session_id,item_kind,source_name,reference_name,target_name,status,distance,
                 confidence,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (str(uuid.uuid4()), session_id, kind, source_name, reference_name, target_name, status,
             float(item["distance"]) if item.get("distance") is not None else None,
             str(item.get("confidence") or "")[:40], timestamp, timestamp),
        )
    db.execute(
        "UPDATE tracking_sessions SET status='pending_confirm',error='',updated_at=? WHERE id=?",
        (timestamp, session_id),
    )
    db.execute(
        "UPDATE progress_folders SET tracking_state='pending_confirm',updated_at=? WHERE id=?",
        (timestamp, session["progress_id"]),
    )
    db.commit()
    return tracking_session_get(db, {"sessionId": session_id, "cursor": 0, "limit": 200})


def serialize_tracking_item(row):
    return {
        "id": row["id"], "kind": row["item_kind"], "sourceName": row["source_name"],
        "referenceName": row["reference_name"], "targetName": row["target_name"],
        "status": row["status"], "distance": row["distance"], "confidence": row["confidence"],
    }


def tracking_session_get(db, payload: dict):
    session_id = str(payload.get("sessionId") or "")
    session = db.execute("SELECT * FROM tracking_sessions WHERE id=?", (session_id,)).fetchone()
    if session is None:
        raise ValueError("跟踪会话不存在")
    cursor = max(0, int(payload.get("cursor") or 0))
    limit = max(1, min(500, int(payload.get("limit") or 100)))
    total = db.execute("SELECT COUNT(*) FROM tracking_session_items WHERE session_id=?", (session_id,)).fetchone()[0]
    items = db.execute(
        """SELECT * FROM tracking_session_items WHERE session_id=? ORDER BY created_at,id
           LIMIT ? OFFSET ?""",
        (session_id, limit, cursor),
    ).fetchall()
    unresolved = db.execute(
        """SELECT COUNT(*) FROM tracking_session_items WHERE session_id=?
           AND status IN ('pending_confirmation','missing_reference')""",
        (session_id,),
    ).fetchone()[0]
    return {
        "success": True,
        "session": {
            "id": session["id"], "progressId": session["progress_id"],
            "parentProgressId": session["parent_progress_id"], "mode": session["mode"],
            "status": session["status"], "renameFromParent": bool(session["rename_from_parent"]),
            "copyMissingFromParent": bool(session["copy_missing_from_parent"]),
            "committedBatchId": session["committed_batch_id"], "error": session["error"],
            "total": total, "unresolvedCount": unresolved,
        },
        "items": [serialize_tracking_item(row) for row in items],
        "nextCursor": cursor + len(items) if cursor + len(items) < total else None,
    }


def tracking_session_release(db, payload: dict):
    session_id = str(payload.get("sessionId") or "")
    session = db.execute("SELECT * FROM tracking_sessions WHERE id=?", (session_id,)).fetchone()
    if session is None:
        return {"success": True, "released": False, "sessionId": session_id}
    if session["status"] != "committed":
        restore_state = session["previous_tracking_state"]
        if restore_state not in PROGRESS_TRACKING_STATES or restore_state in ("pending_compare", "pending_confirm", "committing"):
            restore_state = "stale" if session["mode"] == "refresh" else "needs_repair"
        db.execute(
            """UPDATE progress_folders SET tracking_state=?,updated_at=?
               WHERE id=? AND tracking_state IN ('pending_compare','pending_confirm','committing')""",
            (restore_state, int(time.time() * 1000), session["progress_id"]),
        )
    db.execute("DELETE FROM tracking_sessions WHERE id=?", (session_id,))
    db.commit()
    return {"success": True, "released": True, "sessionId": session_id}


def cleanup_tracking_sessions(db, cutoff: int | None = None):
    cutoff = int(cutoff if cutoff is not None else int(time.time() * 1000) - TRACKING_SESSION_RETENTION_MS)
    rows = db.execute(
        "SELECT id FROM tracking_sessions WHERE updated_at<=? ORDER BY updated_at,id",
        (cutoff,),
    ).fetchall()
    released = []
    for row in rows:
        if tracking_session_release(db, {"sessionId": row["id"]})["released"]:
            released.append(row["id"])
    return {"releasedSessionIds": released, "releasedCount": len(released)}


def _progress_stale_revision(rows) -> str:
    state = [
        [row["id"], int(row["updated_at"]), row["tracking_state"], row["tracking_snapshot_json"],
         row["folder_path_key"], row["missing_since"], row["parent_progress_id"]]
        for row in sorted(rows, key=lambda value: value["id"])
    ]
    return hashlib.sha256(json.dumps(state, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def progress_stale_prepare(root: str, db, payload: dict):
    """Compare filesystem snapshots without taking a writer lease."""
    project = project_row(db, payload["projectName"])
    if payload.get("eligibilityOnly") is True:
        return {"success": True, "eligible": any(
            row["node_role"] == "progress" and row["relation_kind"] == "main"
            and row["tracking_enabled"] and row["tracking_state"] == "ready"
            and row["missing_since"] is None
            for row in progress_rows(db, project["id"])
        )}
    project_path = canonical_path(os.path.join(os.path.abspath(root), project["relative_path"]))
    raw_changed_paths = payload.get("changedPaths") or []
    if not isinstance(raw_changed_paths, list) or len(raw_changed_paths) > 10_000:
        raise ValueError("变化路径列表无效")
    changed_paths = []
    for value in raw_changed_paths:
        candidate = canonical_path(value)
        if candidate.casefold() != project_path.casefold() and not is_project_descendant(candidate, project_path):
            raise ValueError("变化路径超出项目范围")
        changed_paths.append(candidate)
    full_scan = not changed_paths
    rows = progress_rows(db, project["id"])
    by_id = {row["id"]: row for row in rows}
    snapshot_cache = {}

    def path_touched(node):
        if full_scan:
            return True
        folder_keys = {canonical_path(node["folder_path"]).casefold()}
        external_route = normalize_external_link_relative_path(node["external_link_relative_path"])
        if external_route:
            folder_keys.add(canonical_path(os.path.join(project_path, external_route)).casefold())
        for changed_path in changed_paths:
            changed_key = changed_path.casefold()
            for folder_key in folder_keys:
                if changed_key == folder_key or changed_key.startswith(folder_key + os.sep) or folder_key.startswith(changed_key + os.sep):
                    return True
        return False

    def current_snapshot(node):
        if node["id"] not in snapshot_cache:
            snapshot_cache[node["id"]] = folder_media_snapshot(node["folder_path"]) if os.path.isdir(node["folder_path"]) else None
        return snapshot_cache[node["id"]]

    stale_ids = set()
    propagated_ids = set()
    scanned_ids = set()
    for node in rows:
        if (node["node_role"] != "progress" or node["relation_kind"] != "main"
                or not node["tracking_enabled"] or node["tracking_state"] != "ready"
                or node["missing_since"] is not None or not path_touched(node)):
            continue
        previous_files, _previous_parent = _tracking_snapshot_parts(node)
        current_files = current_snapshot(node)
        scanned_ids.add(node["id"])
        if current_files is None or current_files != previous_files:
            stale_ids.add(node["id"])

    for child in rows:
        if (child["node_role"] != "progress" or child["relation_kind"] != "main"
                or not child["tracking_enabled"] or not child["copy_missing_from_parent"]
                or child["tracking_state"] != "ready" or not child["parent_progress_id"]):
            continue
        parent = by_id.get(child["parent_progress_id"])
        if (parent is None or parent["node_role"] == "selection" or parent["relation_kind"] == "auxiliary"
                or parent["missing_since"] is not None or not path_touched(parent)):
            continue
        _previous_files, previous_parent = _tracking_snapshot_parts(child)
        current_parent = current_snapshot(parent)
        scanned_ids.add(parent["id"])
        if current_parent is not None and any(name not in previous_parent for name in current_parent):
            stale_ids.add(child["id"])
            propagated_ids.add(child["id"])
    return {
        "success": True,
        "projectName": project["name"],
        "snapshotId": str(uuid.uuid4()),
        "revision": _progress_stale_revision(rows),
        "candidates": [
            {"id": row["id"], "expectedUpdatedAt": int(row["updated_at"]), "expectedState": row["tracking_state"]}
            for row in rows if row["id"] in stale_ids
        ],
        "scannedProgressIds": sorted(scanned_ids),
        "staleProgressIds": sorted(stale_ids),
        "propagatedProgressIds": sorted(propagated_ids),
    }


def progress_stale_apply(root: str, db, payload: dict):
    project = project_row(db, payload["projectName"])
    snapshot_id = str(payload.get("snapshotId") or "")
    marker = _media_sync_marker(snapshot_id, "progress-stale")
    cached = _meta_value(db, marker)
    if cached:
        return json.loads(cached)
    current_rows = progress_rows(db, project["id"])
    if str(payload.get("revision") or "") != _progress_stale_revision(current_rows):
        return {"success": True, "snapshotId": snapshot_id, "revisionExpired": True}
    candidates = payload.get("candidates") or []
    if not isinstance(candidates, list) or len(candidates) > 10_000:
        raise ValueError("progress_stale_candidates_invalid: 陈旧状态候选无效")
    normalized = []
    for candidate in candidates:
        progress_id = str((candidate or {}).get("id") or "")
        expected_updated_at = int((candidate or {}).get("expectedUpdatedAt") or 0)
        expected_state = str((candidate or {}).get("expectedState") or "")
        row = db.execute(
            "SELECT updated_at,tracking_state FROM progress_folders WHERE id=? AND project_id=?",
            (progress_id, project["id"]),
        ).fetchone()
        if row is None or int(row["updated_at"]) != expected_updated_at or row["tracking_state"] != expected_state:
            return {"success": True, "snapshotId": snapshot_id, "revisionExpired": True}
        normalized.append((progress_id, expected_updated_at))
    timestamp = int(time.time() * 1000)
    for progress_id, expected_updated_at in normalized:
        updated = db.execute(
            """UPDATE progress_folders SET tracking_state='stale',updated_at=?
               WHERE id=? AND project_id=? AND tracking_state='ready' AND updated_at=?""",
            (timestamp, progress_id, project["id"], expected_updated_at),
        ).rowcount
        if updated != 1:
            db.rollback()
            return {"success": True, "snapshotId": snapshot_id, "revisionExpired": True}
    result = {
        "success": True,
        "projectName": project["name"],
        "snapshotId": snapshot_id,
        "revisionExpired": False,
        "scannedProgressIds": sorted({str(value) for value in payload.get("scannedProgressIds") or []}),
        "staleProgressIds": sorted(progress_id for progress_id, _revision in normalized),
        "propagatedProgressIds": sorted({str(value) for value in payload.get("propagatedProgressIds") or []}),
    }
    _set_meta(db, marker, json.dumps(result, ensure_ascii=False))
    db.commit()
    return result


def progress_detect_stale(root: str, db, payload: dict):
    """Compatibility helper for direct Python callers; the server uses split actions."""
    prepared = progress_stale_prepare(root, db, payload)
    if not prepared["candidates"]:
        return prepared
    return progress_stale_apply(root, db, {
        "projectName": payload["projectName"],
        "snapshotId": prepared["snapshotId"],
        "revision": prepared["revision"],
        "candidates": prepared["candidates"],
        "scannedProgressIds": prepared["scannedProgressIds"],
        "propagatedProgressIds": prepared["propagatedProgressIds"],
    })


def tracking_session_decide(root: str, db, payload: dict):
    session_id = str(payload.get("sessionId") or "")
    item_id = str(payload.get("itemId") or "")
    decision = str(payload.get("status") or "")
    if decision not in ("accepted", "rejected"):
        raise ValueError("确认结果只能是 accepted 或 rejected")
    session = db.execute("SELECT * FROM tracking_sessions WHERE id=?", (session_id,)).fetchone()
    item = db.execute(
        "SELECT * FROM tracking_session_items WHERE id=? AND session_id=?",
        (item_id, session_id),
    ).fetchone()
    if session is None or item is None or session["status"] not in ("pending_confirm", "failed"):
        raise ValueError("跟踪确认项目不存在或会话状态无效")
    if item["item_kind"] == "missing" and decision == "accepted":
        raise ValueError("当前版本中已缺失的媒体只能确认缺失，不能匹配为现有文件")
    reference_name = item["reference_name"]
    if payload.get("referenceName"):
        reference_name = _valid_tracking_file_name(payload["referenceName"])
        _project, _parent, _progress, parent_path, _progress_path = _validated_tracking_nodes(
            root, db, db.execute("SELECT name FROM projects WHERE id=?", (session["project_id"],)).fetchone()[0],
            session["progress_id"],
        )
        safe_folder_file(parent_path, reference_name)
    if decision == "accepted" and item["item_kind"] in ("recognized", "copy_missing") and not reference_name:
        raise ValueError("该确认项目缺少上一版本引用")
    timestamp = int(time.time() * 1000)
    db.execute(
        "UPDATE tracking_session_items SET status=?,reference_name=?,updated_at=? WHERE id=?",
        (decision, reference_name, timestamp, item_id),
    )
    db.execute("UPDATE tracking_sessions SET status='pending_confirm',error='',updated_at=? WHERE id=?", (timestamp, session_id))
    db.commit()
    return {"success": True, "item": serialize_tracking_item(db.execute("SELECT * FROM tracking_session_items WHERE id=?", (item_id,)).fetchone())}


def _rename_target_preserving_source_extension(source_name: str, reference_name: str) -> str:
    """Reuse only the parent's filename stem; the current media keeps its format."""
    source_name = _valid_tracking_file_name(source_name)
    reference_name = _valid_tracking_file_name(reference_name)
    reference_stem = os.path.splitext(reference_name)[0]
    source_extension = os.path.splitext(source_name)[1]
    return _valid_tracking_file_name(f"{reference_stem}{source_extension}")


def _prepared_tracking_base_snapshot(session):
    raw_files = session["prepared_files_snapshot_json"]
    raw_parent = session["prepared_parent_snapshot_json"]
    if raw_files is None or raw_parent is None:
        return None
    try:
        files = json.loads(raw_files)
        parent = json.loads(raw_parent)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(files, dict) or not isinstance(parent, dict):
        return None
    return {"files": files, "parent": parent}


def _tracking_copy_operations(session):
    try:
        operations = json.loads(session["copy_operations_json"] or "[]")
    except (TypeError, ValueError, json.JSONDecodeError):
        operations = []
    return operations if isinstance(operations, list) else []


def _tracking_file_matches_snapshot(file_path: str, expected) -> bool:
    if not isinstance(expected, dict) or not os.path.isfile(file_path):
        return False
    stat = os.stat(file_path)
    return (
        int(expected.get("size", -1)) == stat.st_size
        and str(expected.get("signature") or "") == quick_fingerprint(file_path, stat)
    )


def _tracking_target_file(folder_path: str, file_name: str) -> str:
    file_name = _valid_tracking_file_name(file_name)
    file_path = canonical_path(os.path.join(folder_path, file_name))
    if os.path.dirname(file_path).casefold() != canonical_path(folder_path).casefold():
        raise ValueError("补齐目标超出版本目录")
    return file_path


def _save_tracking_copy_operations(db, session_id: str, operations):
    db.execute(
        "UPDATE tracking_sessions SET copy_operations_json=?,updated_at=? WHERE id=?",
        (json.dumps(operations, ensure_ascii=False, separators=(",", ":")), int(time.time() * 1000), session_id),
    )


def _reconcile_tracking_copy_operations(db, session, parent_path: str, progress_path: str, prepared):
    operations = _tracking_copy_operations(session)
    changed = False
    for operation in operations:
        reference_name = _valid_tracking_file_name(operation.get("referenceName"))
        expected = operation.get("expected")
        if expected != prepared["parent"].get(reference_name):
            raise ValueError("tracking_copy_plan_invalid: 补齐操作与比较快照不一致")
        source_path = safe_folder_file(parent_path, reference_name)
        target_path = _tracking_target_file(progress_path, reference_name)
        if os.path.isfile(target_path):
            if not _tracking_file_matches_snapshot(target_path, expected):
                raise ValueError(f"tracking_copy_conflict: 补齐目标已存在且内容不同：{reference_name}")
            if operation.get("status") != "succeeded":
                operation["status"] = "succeeded"
                operation["error"] = ""
                changed = True
        elif operation.get("status") == "succeeded":
            operation["status"] = "failed"
            operation["error"] = "已完成的补齐文件后来丢失"
            changed = True
        if not os.path.isfile(source_path):
            raise ValueError(f"tracking_snapshot_stale: 父版本补齐源已不存在：{reference_name}")
    if changed:
        _save_tracking_copy_operations(db, session["id"], operations)
        db.commit()
    return operations


def _mark_tracking_snapshot_stale(db, session, message: str):
    timestamp = int(time.time() * 1000)
    db.execute(
        "UPDATE tracking_sessions SET status='failed',error=?,updated_at=? WHERE id=?",
        (message[:2000], timestamp, session["id"]),
    )
    db.execute(
        "UPDATE progress_folders SET tracking_state='stale',updated_at=? WHERE id=?",
        (timestamp, session["progress_id"]),
    )
    db.commit()
    return {
        "success": False, "sessionId": session["id"], "staleSnapshot": True,
        "retryable": False, "error": message,
    }


def tracking_commit_resources(root: str, db, payload: dict):
    session_id = str(payload.get("sessionId") or "")
    session = db.execute("SELECT * FROM tracking_sessions WHERE id=?", (session_id,)).fetchone()
    if session is None:
        raise ValueError("跟踪会话不存在")
    project_name = db.execute("SELECT name FROM projects WHERE id=?", (session["project_id"],)).fetchone()[0]
    _project, _parent, _progress, parent_path, progress_path = _validated_tracking_nodes(
        root, db, project_name, session["progress_id"],
    )
    return {
        "success": True, "sessionId": session_id,
        "parentFolderPath": parent_path, "progressFolderPath": progress_path,
    }


def tracking_commit_plan(root: str, db, payload: dict):
    session_id = str(payload.get("sessionId") or "")
    session = db.execute("SELECT * FROM tracking_sessions WHERE id=?", (session_id,)).fetchone()
    if session is None:
        raise ValueError("跟踪会话不存在")
    if session["status"] == "committed":
        return {"success": True, "alreadyCommitted": True, "sessionId": session_id, "batchId": session["committed_batch_id"]}
    if session["status"] not in ("pending_confirm", "failed", "committing"):
        raise ValueError("跟踪会话当前不能提交")
    if session["status"] == "failed" and not session["committed_batch_id"]:
        item_count = db.execute(
            "SELECT COUNT(*) FROM tracking_session_items WHERE session_id=?", (session_id,)
        ).fetchone()[0]
        if not item_count:
            raise ValueError("版本比较尚未产生可提交结果，请释放会话后重新比较")
    unresolved = db.execute(
        """SELECT COUNT(*) FROM tracking_session_items WHERE session_id=?
           AND status IN ('pending_confirmation','missing_reference')""",
        (session_id,),
    ).fetchone()[0]
    if unresolved:
        raise ValueError(f"仍有 {unresolved} 个跟踪项目需要用户明确处理")
    project_name = db.execute("SELECT name FROM projects WHERE id=?", (session["project_id"],)).fetchone()[0]
    _project, parent, progress, parent_path, progress_path = _validated_tracking_nodes(
        root, db, project_name, session["progress_id"],
    )
    if session["committed_batch_id"]:
        timestamp = int(time.time() * 1000)
        db.execute("UPDATE tracking_sessions SET status='committing',error='',updated_at=? WHERE id=?", (timestamp, session_id))
        db.execute("UPDATE progress_folders SET tracking_state='committing',updated_at=? WHERE id=?", (timestamp, progress["id"]))
        db.commit()
        return {
            "success": True, "alreadyCommitted": False, "sessionId": session_id,
            "mode": session["mode"], "repairBatchId": session["committed_batch_id"],
            "projectName": project_name, "progressId": progress["id"], "parentProgressId": parent["id"],
            "parentFolderPath": parent_path, "progressFolderPath": progress_path,
            "displayName": progress["display_name"], "renameFromParent": bool(session["rename_from_parent"]),
            "copyMissingFromParent": bool(session["copy_missing_from_parent"]),
            "matches": [], "incrementalSources": [], "copyReferences": [],
        }
    prepared = _prepared_tracking_base_snapshot(session)
    if prepared is not None:
        try:
            copy_operations = _reconcile_tracking_copy_operations(
                db, session, parent_path, progress_path, prepared,
            )
        except ValueError as error:
            return _mark_tracking_snapshot_stale(db, session, str(error))
        expected_files = dict(prepared["files"])
        for operation in copy_operations:
            if operation.get("status") == "succeeded":
                expected_files[_valid_tracking_file_name(operation.get("referenceName"))] = operation.get("expected")
        current_files = folder_media_snapshot(progress_path)
        current_parent = folder_media_snapshot(parent_path)
        if current_files != expected_files or current_parent != prepared["parent"]:
            return _mark_tracking_snapshot_stale(
                db, session, "tracking_snapshot_stale: 确认期间父版本或当前版本文件已发生变化，请重新比较",
            )
    rows = db.execute(
        "SELECT * FROM tracking_session_items WHERE session_id=? AND status IN ('recognized','accepted') ORDER BY created_at,id",
        (session_id,),
    ).fetchall()
    matches = []
    incremental = []
    copies = []
    for item in rows:
        if item["item_kind"] == "missing":
            # Older builds allowed a removed current file to be accepted. There
            # is no source file to import, so treat that legacy decision as an
            # acknowledgement of the deletion instead of creating an invalid
            # batch source.
            continue
        if item["item_kind"] == "copy_missing":
            copies.append(item["reference_name"])
        elif item["reference_name"] and item["source_name"]:
            matches.append({
                "reference": item["reference_name"], "source": item["source_name"],
                "target": (_rename_target_preserving_source_extension(item["source_name"], item["reference_name"])
                           if session["rename_from_parent"] else (item["target_name"] or item["source_name"])),
                "distance": item["distance"] if item["distance"] is not None else 0,
                "confidence": item["confidence"],
            })
            incremental.append(item["source_name"])
        elif item["source_name"]:
            incremental.append(item["source_name"])
    existing_copy_operations = _tracking_copy_operations(session)
    if copies and not existing_copy_operations:
        if prepared is None:
            raise ValueError("tracking_copy_plan_invalid: 旧跟踪会话缺少可验证的父版本快照")
        existing_copy_operations = [{
            "referenceName": reference_name,
            "expected": prepared["parent"].get(reference_name),
            "status": "pending", "attemptCount": 0, "error": "",
        } for reference_name in sorted(set(copies))]
        if any(not isinstance(operation["expected"], dict) for operation in existing_copy_operations):
            raise ValueError("tracking_snapshot_stale: 补齐源不在已确认的父版本快照中")
        _save_tracking_copy_operations(db, session_id, existing_copy_operations)
    timestamp = int(time.time() * 1000)
    db.execute("UPDATE tracking_sessions SET status='committing',error='',updated_at=? WHERE id=?", (timestamp, session_id))
    db.execute("UPDATE progress_folders SET tracking_state='committing',updated_at=? WHERE id=?", (timestamp, progress["id"]))
    db.commit()
    return {
        "success": True, "alreadyCommitted": False, "sessionId": session_id,
        "mode": session["mode"], "repairBatchId": session["committed_batch_id"],
        "projectName": project_name, "progressId": progress["id"], "parentProgressId": parent["id"],
        "parentFolderPath": parent_path, "progressFolderPath": progress_path,
        "displayName": progress["display_name"], "renameFromParent": bool(session["rename_from_parent"]),
        "copyMissingFromParent": bool(session["copy_missing_from_parent"]),
        "matches": matches, "incrementalSources": sorted(set(incremental)), "copyReferences": sorted(set(copies)),
    }


def _copy_tracking_file_atomic(source_path: str, target_path: str):
    temporary_path = os.path.join(
        os.path.dirname(target_path),
        f".{os.path.basename(target_path)}.{uuid.uuid4().hex}.photoflow-copy",
    )
    try:
        shutil.copy2(source_path, temporary_path)
        with open(temporary_path, "rb") as copied:
            os.fsync(copied.fileno())
        os.replace(temporary_path, target_path)
    finally:
        try:
            if os.path.exists(temporary_path):
                os.remove(temporary_path)
        except OSError:
            pass


def tracking_apply_copies(root: str, db, payload: dict):
    session_id = str(payload.get("sessionId") or "")
    session = db.execute("SELECT * FROM tracking_sessions WHERE id=?", (session_id,)).fetchone()
    if session is None or session["status"] not in ("committing", "failed"):
        raise ValueError("跟踪会话当前不能执行补齐操作")
    project_name = db.execute("SELECT name FROM projects WHERE id=?", (session["project_id"],)).fetchone()[0]
    _project, _parent, _progress, parent_path, progress_path = _validated_tracking_nodes(
        root, db, project_name, session["progress_id"],
    )
    prepared = _prepared_tracking_base_snapshot(session)
    if prepared is None:
        raise ValueError("tracking_copy_plan_invalid: 跟踪会话缺少可验证快照")
    operations = _tracking_copy_operations(session)
    errors = []
    for operation in operations:
        reference_name = _valid_tracking_file_name(operation.get("referenceName"))
        source_path = safe_folder_file(parent_path, reference_name)
        target_path = _tracking_target_file(progress_path, reference_name)
        expected = operation.get("expected")
        operation["attemptCount"] = int(operation.get("attemptCount") or 0) + 1
        operation["status"] = "running"
        operation["error"] = ""
        _save_tracking_copy_operations(db, session_id, operations)
        db.commit()
        try:
            if not _tracking_file_matches_snapshot(source_path, expected):
                raise ValueError(f"父版本补齐源已发生变化：{reference_name}")
            if os.path.exists(target_path):
                if not _tracking_file_matches_snapshot(target_path, expected):
                    raise FileExistsError(f"补齐目标已存在且内容不同：{reference_name}")
            else:
                _copy_tracking_file_atomic(source_path, target_path)
                if not _tracking_file_matches_snapshot(target_path, expected):
                    raise ValueError(f"补齐文件复制后校验失败：{reference_name}")
            operation["status"] = "succeeded"
            operation["error"] = ""
        except Exception as error:
            operation["status"] = "failed"
            operation["error"] = str(error)[:2000]
            errors.append({"referenceName": reference_name, "error": str(error)})
        _save_tracking_copy_operations(db, session_id, operations)
        db.commit()
    succeeded_names = [
        _valid_tracking_file_name(operation.get("referenceName"))
        for operation in operations if operation.get("status") == "succeeded"
    ]
    return {
        "success": not errors,
        "sessionId": session_id,
        "copiedNames": succeeded_names,
        "repairRequired": bool(errors),
        "copyErrors": errors,
    }


def _prepared_tracking_commit_snapshot(db, session):
    prepared = _prepared_tracking_base_snapshot(session)
    if prepared is None:
        return None
    files = dict(prepared["files"])
    parent = prepared["parent"]
    rows = db.execute(
        """SELECT item_kind,source_name,reference_name,target_name,status
           FROM tracking_session_items WHERE session_id=?
             AND status IN ('recognized','accepted') ORDER BY created_at,id""",
        (session["id"],),
    ).fetchall()
    for item in rows:
        if item["item_kind"] == "copy_missing":
            name = item["reference_name"]
            if not name or name not in parent:
                return None
            files[name] = parent[name]
            continue
        if not session["rename_from_parent"] or not item["reference_name"] or not item["source_name"]:
            continue
        source_name = item["source_name"]
        target_name = _rename_target_preserving_source_extension(source_name, item["reference_name"])
        if source_name == target_name:
            continue
        if source_name not in files:
            return None
        files[target_name] = files.pop(source_name)
    return {"files": files, "parent": parent}


def tracking_commit_complete(root: str, db, payload: dict):
    session_id = str(payload.get("sessionId") or "")
    session = db.execute("SELECT * FROM tracking_sessions WHERE id=?", (session_id,)).fetchone()
    if session is not None and session["status"] == "committed":
        return tracking_session_get(db, {"sessionId": session_id, "cursor": 0, "limit": 200})
    if session is None:
        raise ValueError("跟踪会话不存在")
    project_name = db.execute("SELECT name FROM projects WHERE id=?", (session["project_id"],)).fetchone()[0]
    _project, _parent, progress, parent_path, progress_path = _validated_tracking_nodes(root, db, project_name, session["progress_id"])
    expected_snapshot = _prepared_tracking_commit_snapshot(db, session)
    actual_snapshot = {"files": folder_media_snapshot(progress_path), "parent": folder_media_snapshot(parent_path)}
    if expected_snapshot is not None and actual_snapshot != expected_snapshot:
        return _mark_tracking_snapshot_stale(
            db, session, "tracking_snapshot_stale: 提交期间父版本或当前版本文件已发生变化，请重新比较",
        )
    snapshot = actual_snapshot
    timestamp = int(time.time() * 1000)
    db.execute(
        """UPDATE tracking_sessions SET status='committed',committed_batch_id=?,error='',
           prepared_files_snapshot_json=NULL,prepared_parent_snapshot_json=NULL,
           copy_operations_json='[]',updated_at=? WHERE id=?""",
        (payload.get("batchId") or session["committed_batch_id"], timestamp, session_id),
    )
    db.execute(
        """UPDATE progress_folders SET tracking_state='ready',last_tracked_at=?,tracking_snapshot_json=?,
           folder_signature=?,updated_at=? WHERE id=?""",
        (timestamp, json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")),
         hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode("utf-8")).hexdigest(), timestamp, progress["id"]),
    )
    ensure_selection_workflow_inputs(db, str(session["project_id"]))
    db.commit()
    return tracking_session_get(db, {"sessionId": session_id, "cursor": 0, "limit": 200})


def tracking_commit_failed(db, payload: dict):
    session_id = str(payload.get("sessionId") or "")
    session = db.execute("SELECT * FROM tracking_sessions WHERE id=?", (session_id,)).fetchone()
    if session is None:
        raise ValueError("跟踪会话不存在")
    if session["status"] == "committed":
        return {"success": True, "sessionId": session_id, "retryable": False, "alreadyCommitted": True}
    timestamp = int(time.time() * 1000)
    error = str(payload.get("error") or "提交失败")[:2000]
    failed_while_comparing = session["status"] == "comparing"
    db.execute(
        """UPDATE tracking_sessions SET status='failed',error=?,
           committed_batch_id=COALESCE(?,committed_batch_id),updated_at=? WHERE id=?""",
        (error, payload.get("batchId") or None, timestamp, session_id),
    )
    if failed_while_comparing:
        restore_state = "stale" if session["mode"] == "refresh" else "needs_repair"
        db.execute(
            "UPDATE progress_folders SET tracking_state=?,updated_at=? WHERE id=?",
            (restore_state, timestamp, session["progress_id"]),
        )
    else:
        db.execute(
            """UPDATE progress_folders SET tracking_state=CASE WHEN tracking_state='needs_repair'
                 THEN 'needs_repair' ELSE 'pending_confirm' END,updated_at=? WHERE id=?""",
            (timestamp, session["progress_id"]),
        )
    db.commit()
    return {"success": True, "sessionId": session_id, "retryable": True}


def progress_main_branch_media(db, payload: dict):
    progress_id = str(payload.get("progressId") or "")
    photo_id = str(payload.get("photoId") or "") or None
    if not progress_id and photo_id:
        resolved = db.execute(
            """SELECT progress.id FROM versions
               JOIN batch_items items ON items.version_id=versions.id
               JOIN version_batches batches ON batches.id=items.batch_id
               JOIN progress_folders progress
                 ON progress.project_id=batches.project_id
                AND (
                  (progress.folder_id IS NOT NULL AND batches.source_folder_id IS NOT NULL
                   AND progress.folder_id=batches.source_folder_id)
                  OR ((progress.folder_id IS NULL OR batches.source_folder_id IS NULL)
                      AND progress.folder_path_key=batches.source_folder_path_key)
                )
               WHERE versions.photo_id=? AND versions.is_deleted=0
                 AND ((progress.node_role='original' AND progress.artifact_kind IS NULL)
                   OR (progress.node_role='progress' AND progress.parent_progress_id IS NOT NULL AND progress.relation_kind='main'))
               ORDER BY batches.sequence DESC,items.created_at DESC LIMIT 1""",
            (photo_id,),
        ).fetchone()
        if resolved is None:
            raise ValueError("找不到该媒体所属的主分支进度")
        progress_id = resolved["id"]
    if not progress_id:
        raise ValueError("必须提供 progressId 或 photoId")
    start = _progress_row_by_id(db, progress_id)
    if not _is_valid_structural_parent(start):
        raise ValueError("main_branch_progress_invalid: 仅原始素材或已连接父节点的 main progress 属于主分支")
    rows = progress_rows(db, start["project_id"])
    by_id = {row["id"]: row for row in rows}
    root_node = start
    visited = set()
    while root_node["parent_progress_id"] and root_node["relation_kind"] == "main":
        if root_node["id"] in visited:
            raise ValueError("主分支关系形成循环")
        visited.add(root_node["id"])
        parent = by_id.get(root_node["parent_progress_id"])
        if parent is None or not _is_valid_structural_parent(parent):
            break
        root_node = parent
    children = {}
    for row in rows:
        if row["node_role"] != "progress" or row["relation_kind"] != "main" or not row["parent_progress_id"]:
            continue
        children.setdefault(row["parent_progress_id"], []).append(row)
    for values in children.values():
        values.sort(key=lambda row: (row["created_at"], row["id"]))
    ordered_nodes = []

    def visit(node):
        ordered_nodes.append(node)
        for child in children.get(node["id"], []):
            visit(child)

    visit(root_node)
    entries = []
    seen_versions = set()
    for branch_index, node in enumerate(ordered_nodes):
        # A progress folder may be renamed after its batch was committed. The
        # filesystem folder identity survives that rename, while the historical
        # batch intentionally retains the path that was current at commit time.
        # Prefer the stable identity and use the path only for legacy rows that
        # do not have an identity on one side.
        parameters = [node["project_id"], node["folder_id"], node["folder_path_key"]]
        photo_filter = ""
        if photo_id:
            photo_filter = " AND versions.photo_id=?"
            parameters.append(photo_id)
        versions = db.execute(
            f"""SELECT versions.*,photos.original_name,items.created_at AS item_created_at
                FROM version_batches batches
                JOIN batch_items items ON items.batch_id=batches.id
                JOIN versions ON versions.id=items.version_id
                JOIN photos ON photos.id=versions.photo_id
                WHERE batches.project_id=? AND (
                  (? IS NOT NULL AND batches.source_folder_id IS NOT NULL
                   AND batches.source_folder_id=?)
                  OR ((? IS NULL OR batches.source_folder_id IS NULL)
                      AND batches.source_folder_path_key=?)
                )
                  AND versions.is_deleted=0{photo_filter}
                ORDER BY batches.sequence,items.created_at,items.id""",
            [parameters[0], parameters[1], parameters[1], parameters[1], parameters[2], *parameters[3:]],
        ).fetchall()
        for version in versions:
            if version["id"] in seen_versions:
                continue
            seen_versions.add(version["id"])
            serialized = serialize_version(version)
            if node["node_role"] == "progress":
                serialized["displayVersionKey"] = node["version_key"]
            serialized["fileMissing"] = serialized["fileMissing"] or not os.path.isfile(version["file_path"])
            entries.append({
                "branchIndex": branch_index,
                "progressId": node["id"],
                "parentProgressId": node["parent_progress_id"],
                "nodeRole": node["node_role"],
                "relationKind": node["relation_kind"],
                "photoId": version["photo_id"],
                "originalName": version["original_name"],
                "version": serialized,
            })
    return {
        "success": True,
        "progressId": progress_id,
        "branchProgressIds": [node["id"] for node in ordered_nodes],
        "entries": entries,
    }


def safe_folder_file(folder_path: str, file_name: str):
    file_name = str(file_name or "")
    if not file_name or os.path.basename(file_name) != file_name:
        raise ValueError("批次匹配包含无效文件名")
    file_path = canonical_path(os.path.join(folder_path, file_name))
    if os.path.dirname(file_path).casefold() != canonical_path(folder_path).casefold():
        raise ValueError("批次匹配文件超出所选文件夹")
    if not os.path.isfile(file_path) or not media_type(file_path):
        raise ValueError(f"批次图片不存在或格式不受支持：{file_name}")
    return file_path


def source_version_row(db, project_id: str, file_path: str):
    file_path = canonical_path(file_path)
    path_key = file_path.casefold()
    identity = file_identity(file_path)
    linked = db.execute(
        """SELECT versions.* FROM batch_items
           JOIN version_batches ON version_batches.id=batch_items.batch_id
           JOIN versions ON versions.id=batch_items.version_id
           WHERE version_batches.project_id=? AND versions.is_deleted=0
             AND (batch_items.source_path_key=? OR (? IS NOT NULL AND batch_items.source_file_id=?))
           ORDER BY version_batches.sequence DESC LIMIT 1""",
        (project_id, path_key, identity, identity),
    ).fetchone()
    if linked is not None:
        return linked
    return db.execute(
        """SELECT versions.* FROM versions JOIN photos ON photos.id=versions.photo_id
           WHERE photos.project_id=? AND versions.is_deleted=0
             AND (versions.file_path_key=? OR (? IS NOT NULL AND versions.file_id=?))
           ORDER BY versions.updated_at DESC LIMIT 1""",
        (project_id, path_key, identity, identity),
    ).fetchone()


def ensure_source_version(db, project, file_path: str, pending_hashes=None):
    row = source_version_row(db, project["id"], file_path)
    if row is not None:
        record = db.execute(
            "SELECT full_hash FROM file_records WHERE owner_type='version' AND owner_id=?",
            (row["id"],),
        ).fetchone()
        if record is None or not record["full_hash"]:
            queue_full_fingerprint(pending_hashes, row["id"], file_path, os.stat(file_path))
        return row
    photo_id = sync_media_file(db, project, file_path, pending_hashes)
    if not photo_id:
        raise ValueError(f"无法登记批次图片：{os.path.basename(file_path)}")
    row = source_version_row(db, project["id"], file_path)
    if row is None:
        row = db.execute(
            "SELECT * FROM versions WHERE photo_id=? AND is_deleted=0 ORDER BY version_number DESC LIMIT 1",
            (photo_id,),
        ).fetchone()
    if row is None:
        raise ValueError(f"无法读取批次版本：{os.path.basename(file_path)}")
    return row


def create_batch_row(db, project_id: str, folder_path: str, display_name: str, parent_batch_id=None, import_key=None):
    timestamp = int(time.time() * 1000)
    sequence = db.execute(
        "SELECT COALESCE(MAX(sequence), 0)+1 FROM version_batches WHERE project_id=?", (project_id,)
    ).fetchone()[0]
    batch_id = str(uuid.uuid4())
    folder_path = canonical_path(folder_path)
    db.execute(
        """INSERT INTO version_batches(id,project_id,sequence,display_name,source_folder_path,
           source_folder_path_key,source_folder_id,parent_batch_id,import_key,status,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,'importing',?,?)""",
        (batch_id, project_id, sequence, display_name or os.path.basename(folder_path), folder_path,
         folder_path.casefold(), directory_identity(folder_path), parent_batch_id, import_key, timestamp, timestamp),
    )
    return db.execute("SELECT * FROM version_batches WHERE id=?", (batch_id,)).fetchone()


def register_batch_item(db, batch_id: str, version, source_path: str, match_method: str,
                        match_distance=None, confidence="", review_status="confirmed"):
    source_path = canonical_path(source_path)
    stat = os.stat(source_path)
    identity = file_identity(source_path)
    fingerprint = version["file_fingerprint"] if version["file_path_key"] == source_path.casefold() else quick_fingerprint(source_path, stat)
    timestamp = int(time.time() * 1000)
    existing = db.execute(
        "SELECT id FROM batch_items WHERE batch_id=? AND (version_id=? OR source_path_key=?) LIMIT 1",
        (batch_id, version["id"], source_path.casefold()),
    ).fetchone()
    values = (
        version["photo_id"], version["id"], os.path.basename(source_path), source_path, source_path.casefold(),
        identity, fingerprint, match_method, match_distance, confidence, review_status, timestamp,
    )
    if existing:
        db.execute(
            """UPDATE batch_items SET photo_id=?,version_id=?,source_name=?,source_path=?,source_path_key=?,
               source_file_id=?,source_fingerprint=?,match_method=?,match_distance=?,confidence=?,
               review_status=?,updated_at=? WHERE id=?""",
            values + (existing["id"],),
        )
        return existing["id"]
    item_id = str(uuid.uuid4())
    db.execute(
        """INSERT INTO batch_items(id,batch_id,photo_id,version_id,source_name,source_path,source_path_key,
           source_file_id,source_fingerprint,match_method,match_distance,confidence,review_status,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (item_id, batch_id, *values[:-1], timestamp, timestamp),
    )
    return item_id


def ensure_reference_batch(root: str, db, project, folder_path: str):
    folder_path = canonical_path(folder_path)
    identity = directory_identity(folder_path)
    batch = db.execute(
        """SELECT * FROM version_batches WHERE project_id=?
           AND (source_folder_path_key=? OR (? IS NOT NULL AND source_folder_id=?))
           ORDER BY CASE WHEN status='ready' THEN 0 ELSE 1 END, sequence DESC LIMIT 1""",
        (project["id"], folder_path.casefold(), identity, identity),
    ).fetchone()
    if batch is not None:
        if batch["source_folder_path_key"] != folder_path.casefold():
            db.execute(
                """UPDATE version_batches SET source_folder_path=?,source_folder_path_key=?,source_folder_id=?,
                   updated_at=? WHERE id=?""",
                (folder_path, folder_path.casefold(), identity, int(time.time() * 1000), batch["id"]),
            )
            db.commit()
            batch = db.execute("SELECT * FROM version_batches WHERE id=?", (batch["id"],)).fetchone()
        db.execute(
            "UPDATE version_batches SET status='importing',updated_at=? WHERE id=?",
            (int(time.time() * 1000), batch["id"]),
        )
    else:
        batch = create_batch_row(
            db, project["id"], folder_path, os.path.basename(folder_path), import_key=f"baseline-{uuid.uuid4()}"
        )
    db.commit()
    try:
        current_source_keys = set()
        for file_path in folder_media_files(folder_path):
            current_source_keys.add(canonical_path(file_path).casefold())
            pending_hashes = []
            version = ensure_source_version(db, project, file_path, pending_hashes)
            register_batch_item(db, batch["id"], version, file_path, "baseline")
            db.commit()
            # Baseline registration only needs stable IDs and quick
            # fingerprints. Full hashes are maintenance metadata and are filled
            # by the isolated media scan after the interactive operation.
        stale_items = db.execute(
            "SELECT id,source_path_key FROM batch_items WHERE batch_id=?",
            (batch["id"],),
        ).fetchall()
        for item in stale_items:
            if item["source_path_key"] not in current_source_keys:
                db.execute("DELETE FROM batch_items WHERE id=?", (item["id"],))
        db.execute(
            "UPDATE version_batches SET status='ready',updated_at=? WHERE id=?",
            (int(time.time() * 1000), batch["id"]),
        )
        db.commit()
    except Exception:
        db.rollback()
        db.execute(
            "UPDATE version_batches SET status='failed',updated_at=? WHERE id=?",
            (int(time.time() * 1000), batch["id"]),
        )
        db.commit()
        raise
    return db.execute("SELECT * FROM version_batches WHERE id=?", (batch["id"],)).fetchone()


def batch_register_baseline(root: str, db, payload: dict):
    project = project_row(db, payload["projectName"])
    folder_path = canonical_path(payload["folderPath"])
    try:
        batch = ensure_reference_batch(root, db, project, folder_path)
    except Exception:
        set_progress_tracking_state_for_folder(db, project["id"], folder_path, "pending_compare")
        db.commit()
        raise
    version_name = str(payload.get("versionName") or "").strip()
    if version_name:
        db.execute(
            """UPDATE versions SET version_name=?,updated_at=?
                 WHERE version_number=0 AND id IN (
                   SELECT version_id FROM batch_items WHERE batch_id=?
                 )""",
            (version_name, int(time.time() * 1000), batch["id"]),
        )
        db.commit()
    set_progress_tracking_state_for_folder(db, project["id"], folder_path, "ready")
    db.commit()
    return {"success": True, "batch": batch_summary(db, batch["id"])}


def merge_source_photo_history(db, project, source_path: str, target_photo_id: str, parent_version_id: str, version_name: str):
    """Attach an already-registered returned image to an earlier photo history.

    A returned image can be consumed by an external producer before its V0 relationship is
    registered. Preserve that V1 version ID and move every dependent row to the
    V0 photo instead of deleting and recreating the version.
    """
    source_path = canonical_path(source_path)
    identity = file_identity(source_path)
    row = db.execute(
        """SELECT versions.* FROM versions JOIN photos ON photos.id=versions.photo_id
           WHERE photos.project_id=? AND versions.is_deleted=0
             AND (versions.file_path_key=? OR (? IS NOT NULL AND versions.file_id=?))
           ORDER BY versions.updated_at DESC LIMIT 1""",
        (project["id"], source_path.casefold(), identity, identity),
    ).fetchone()
    if row is None:
        return None
    if row["photo_id"] == target_photo_id:
        return row

    source_photo_id = row["photo_id"]
    versions = db.execute(
        "SELECT * FROM versions WHERE photo_id=? ORDER BY version_number,created_at,id",
        (source_photo_id,),
    ).fetchall()
    if not versions:
        raise ValueError(f"{os.path.basename(source_path)} 的已有版本历史为空")
    source_version_ids = {version["id"] for version in versions}
    if parent_version_id in source_version_ids:
        raise ValueError(f"{os.path.basename(source_path)} 的版本关系形成循环")
    if db.execute(
        "SELECT id FROM versions WHERE id=? AND photo_id=? AND is_deleted=0",
        (parent_version_id, target_photo_id),
    ).fetchone() is None:
        raise ValueError("要补入的 V0 不属于目标版本历史")

    timestamp = int(time.time() * 1000)
    source_final_ids = [version["id"] for version in versions if version["is_final"] and not version["is_deleted"]]
    db.execute("UPDATE photos SET current_version_id=NULL,updated_at=? WHERE id=?", (timestamp, source_photo_id))
    db.execute("UPDATE versions SET is_current=0,is_final=0,updated_at=? WHERE photo_id=?", (timestamp, source_photo_id))
    if source_final_ids:
        db.execute("UPDATE versions SET is_final=0,updated_at=? WHERE photo_id=?", (timestamp, target_photo_id))

    next_number = db.execute(
        "SELECT COALESCE(MAX(version_number),-1)+1 FROM versions WHERE photo_id=?",
        (target_photo_id,),
    ).fetchone()[0]
    pending = {version["id"]: version for version in versions}
    moved = set()
    while pending:
        ready = [
            version for version in pending.values()
            if version["parent_version_id"] is None or version["parent_version_id"] not in source_version_ids or version["parent_version_id"] in moved
        ]
        if not ready:
            raise ValueError(f"{os.path.basename(source_path)} 的已有版本历史包含循环")
        for version in ready:
            previous_parent_id = version["parent_version_id"]
            next_parent_id = previous_parent_id if previous_parent_id in source_version_ids else parent_version_id
            db.execute(
                """UPDATE versions SET photo_id=?,parent_version_id=?,version_number=?,updated_at=?
                   WHERE id=?""",
                (target_photo_id, next_parent_id, next_number, timestamp, version["id"]),
            )
            next_number += 1
            moved.add(version["id"])
            pending.pop(version["id"])

    # Move every owner reference before deleting the now-empty source photo.
    db.execute("UPDATE batch_items SET photo_id=?,updated_at=? WHERE photo_id=?", (target_photo_id, timestamp, source_photo_id))
    db.execute("UPDATE version_compare_history SET photo_id=? WHERE photo_id=?", (target_photo_id, source_photo_id))
    run_compatibility_hooks("merge_photo_history", db, project, source_photo_id, target_photo_id, timestamp)

    selected_version_id = row["id"]
    db.execute("UPDATE versions SET is_current=0,updated_at=? WHERE photo_id=?", (timestamp, target_photo_id))
    db.execute(
        """UPDATE versions SET version_name=?,version_type='batch',status='draft',is_current=1,
           author=?,note=?,updated_at=? WHERE id=?""",
        (version_name, os.environ.get("USERNAME") or "本机用户",
         f"补入早期版本后由进度“{version_name}”接入", timestamp, selected_version_id),
    )
    if source_final_ids:
        db.execute("UPDATE versions SET is_final=1,updated_at=? WHERE id=?", (timestamp, source_final_ids[-1]))
    db.execute(
        "UPDATE photos SET current_version_id=?,updated_at=? WHERE id=?",
        (selected_version_id, timestamp, target_photo_id),
    )
    db.execute("DELETE FROM photos WHERE id=?", (source_photo_id,))
    return db.execute("SELECT * FROM versions WHERE id=?", (selected_version_id,)).fetchone()


def create_linked_batch_version(db, project, batch, parent, source_path: str, pending_hashes=None):
    existing_item = db.execute(
        """SELECT versions.* FROM batch_items JOIN versions ON versions.id=batch_items.version_id
           WHERE batch_items.batch_id=? AND batch_items.source_path_key=? AND versions.is_deleted=0 LIMIT 1""",
        (batch["id"], canonical_path(source_path).casefold()),
    ).fetchone()
    if existing_item is not None:
        if existing_item["photo_id"] != parent["photo_id"]:
            merged = merge_source_photo_history(
                db, project, source_path, parent["photo_id"], parent["id"], batch["display_name"],
            )
            if merged is None:
                raise ValueError(f"无法合并已有版本：{os.path.basename(source_path)}")
            return merged, None
        return existing_item, None

    merged = merge_source_photo_history(
        db, project, source_path, parent["photo_id"], parent["id"], batch["display_name"],
    )
    if merged is not None:
        return merged, None
    next_number = db.execute(
        "SELECT COALESCE(MAX(version_number), -1)+1 FROM versions WHERE photo_id=?", (parent["photo_id"],)
    ).fetchone()[0]
    source_path = canonical_path(source_path)
    stat = os.stat(source_path)
    identity = file_identity(source_path)
    fingerprint = quick_fingerprint(source_path, stat)
    cached_record = db.execute(
        """SELECT full_hash FROM file_records
           WHERE current_path=? AND file_size=? AND modified_at=? AND quick_hash=? AND missing=0
             AND full_hash IS NOT NULL ORDER BY updated_at DESC LIMIT 1""",
        (source_path, stat.st_size, int(stat.st_mtime_ns / 1_000_000), fingerprint),
    ).fetchone()
    cached_hash = cached_record["full_hash"] if cached_record is not None else None
    timestamp = int(time.time() * 1000)
    version_id = str(uuid.uuid4())
    db.execute(
        """INSERT INTO versions(id,photo_id,parent_version_id,version_number,version_name,version_type,file_path,
           file_path_key,file_id,file_fingerprint,file_size,file_modified_at,author,note,status,is_current,is_final,
           created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (version_id, parent["photo_id"], parent["id"], next_number,
         batch["display_name"], "batch", source_path, source_path.casefold(),
         identity, fingerprint, stat.st_size, int(stat.st_mtime_ns / 1_000_000),
         os.environ.get("USERNAME") or "本机用户", f"由进度“{batch['display_name']}”自动建立",
         "draft", 0, 0, timestamp, timestamp),
    )
    upsert_file_record(db, version_id, source_path, stat, identity, fingerprint, cached_hash)
    if not cached_hash:
        queue_full_fingerprint(pending_hashes, version_id, source_path, stat)
    return db.execute("SELECT * FROM versions WHERE id=?", (version_id,)).fetchone(), None


def serialize_batch_operation(row):
    return {
        "id": row["id"], "batchId": row["batch_id"], "operationType": row["operation_type"],
        "sourcePath": row["source_path"], "targetPath": row["target_path"], "status": row["status"],
        "attemptCount": row["attempt_count"], "error": row["error"],
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }


def set_progress_tracking_state_for_folder(db, project_id: str, folder_path: str, state: str):
    if state not in PROGRESS_TRACKING_STATES:
        raise ValueError("无效的版本跟踪状态")
    timestamp = int(time.time() * 1000)
    db.execute(
        """UPDATE progress_folders SET tracking_state=?,
           last_tracked_at=CASE WHEN ?='ready' THEN ? ELSE last_tracked_at END,updated_at=?
           WHERE project_id=? AND folder_path_key=? AND node_role='progress'
             AND relation_kind='main' AND tracking_enabled=1""",
        (state, state, timestamp, timestamp, project_id, canonical_path(folder_path).casefold()),
    )


def plan_confirmed_batch_renames(db, batch_id: str, folder_path: str, matches: list):
    folder_path = canonical_path(folder_path)
    timestamp = int(time.time() * 1000)
    for match in matches:
        source_name = str(match.get("source") or "")
        target_name = str(match.get("target") or "")
        if target_name:
            target_name = _rename_target_preserving_source_extension(source_name, target_name)
        if not target_name or target_name == source_name:
            continue
        source_path = safe_folder_file(folder_path, source_name)
        if os.path.basename(target_name) != target_name:
            raise ValueError("目标文件名无效")
        target_path = canonical_path(os.path.join(folder_path, target_name))
        if os.path.dirname(target_path).casefold() != folder_path.casefold():
            raise ValueError("目标文件超出所选文件夹")
        planning_error = ""
        if os.path.exists(target_path):
            planning_error = f"目标文件已存在：{target_name}"
        if db.execute(
            "SELECT id FROM batch_items WHERE batch_id=? AND source_path_key=? LIMIT 1",
            (batch_id, source_path.casefold()),
        ).fetchone() is None:
            planning_error = f"没有找到对应的批次记录：{source_name}"
        db.execute(
            """INSERT INTO batch_file_operations(id,batch_id,operation_type,source_path,target_path,
               status,attempt_count,error,created_at,updated_at)
               VALUES(?,?,'rename',?,?,?,0,?,?,?)
               ON CONFLICT(batch_id,operation_type,source_path,target_path) DO NOTHING""",
            (str(uuid.uuid4()), batch_id, source_path, target_path,
             "failed" if planning_error else "pending", planning_error, timestamp, timestamp),
        )


def apply_pending_batch_operations(db, batch_id: str, fault_after=None):
    batch = db.execute("SELECT * FROM version_batches WHERE id=?", (batch_id,)).fetchone()
    if batch is None:
        raise ValueError("版本批次不存在")
    operations = db.execute(
        """SELECT * FROM batch_file_operations WHERE batch_id=? AND status IN ('pending','failed','running')
           ORDER BY created_at,id""", (batch_id,),
    ).fetchall()
    succeeded = 0
    errors = []
    for operation in operations:
        timestamp = int(time.time() * 1000)
        db.execute(
            "UPDATE batch_file_operations SET status='running',attempt_count=attempt_count+1,error='',updated_at=? WHERE id=?",
            (timestamp, operation["id"]),
        )
        db.commit()
        try:
            source_path = canonical_path(operation["source_path"])
            target_path = canonical_path(operation["target_path"])
            item = db.execute(
                "SELECT * FROM batch_items WHERE batch_id=? AND source_path_key=? LIMIT 1",
                (batch_id, source_path.casefold()),
            ).fetchone()
            if item is None:
                item = db.execute(
                    "SELECT * FROM batch_items WHERE batch_id=? AND source_path_key=? LIMIT 1",
                    (batch_id, target_path.casefold()),
                ).fetchone()
            if item is None:
                raise ValueError("没有找到对应的批次记录")
            if os.path.exists(source_path):
                if os.path.exists(target_path):
                    raise FileExistsError(f"目标文件已存在：{os.path.basename(target_path)}")
                os.rename(source_path, target_path)
                if fault_after:
                    fault_after("filesystem_renamed", operation)
            elif not os.path.isfile(target_path):
                raise FileNotFoundError(f"源文件和目标文件都不存在：{os.path.basename(source_path)}")
            stat = os.stat(target_path)
            identity = file_identity(target_path)
            fingerprint = quick_fingerprint(target_path, stat)
            if item["source_fingerprint"] and item["source_fingerprint"] != fingerprint:
                raise ValueError("目标文件内容与待重命名素材不一致")
            existing_record = db.execute(
                "SELECT full_hash FROM file_records WHERE owner_type='version' AND owner_id=?",
                (item["version_id"],),
            ).fetchone()
            # Renaming inside the tracked folder preserves the file identity;
            # a full-file hash is unnecessary for this operation and is filled
            # lazily if a future cross-volume recovery actually needs it.
            authoritative_hash = existing_record["full_hash"] if existing_record is not None else None
            timestamp = int(time.time() * 1000)
            db.execute(
                """UPDATE batch_items SET source_name=?,source_path=?,source_path_key=?,source_file_id=?,updated_at=?
                   WHERE id=?""",
                (os.path.basename(target_path), target_path, target_path.casefold(), identity, timestamp, item["id"]),
            )
            db.execute(
                """UPDATE versions SET file_path=?,file_path_key=?,file_id=?,file_fingerprint=?,file_size=?,
                   file_modified_at=?,file_missing=0,content_changed=0,updated_at=? WHERE id=?""",
                (target_path, target_path.casefold(), identity, fingerprint, stat.st_size,
                 int(stat.st_mtime_ns / 1_000_000), timestamp, item["version_id"]),
            )
            upsert_file_record(db, item["version_id"], target_path, stat, identity, fingerprint, authoritative_hash)
            db.execute(
                "UPDATE batch_file_operations SET status='succeeded',error='',updated_at=? WHERE id=?",
                (timestamp, operation["id"]),
            )
            db.commit()
            succeeded += 1
        except Exception as error:
            db.rollback()
            timestamp = int(time.time() * 1000)
            db.execute(
                "UPDATE batch_file_operations SET status='failed',error=?,updated_at=? WHERE id=?",
                (str(error), timestamp, operation["id"]),
            )
            db.commit()
            errors.append({
                "operationId": operation["id"], "source": os.path.basename(operation["source_path"]),
                "target": os.path.basename(operation["target_path"]), "error": str(error),
            })
    remaining = db.execute(
        "SELECT COUNT(*) FROM batch_file_operations WHERE batch_id=? AND status!='succeeded'",
        (batch_id,),
    ).fetchone()[0]
    final_status = "needs_repair" if remaining else "ready"
    timestamp = int(time.time() * 1000)
    db.execute("UPDATE version_batches SET status=?,updated_at=? WHERE id=?", (final_status, timestamp, batch_id))
    set_progress_tracking_state_for_folder(db, batch["project_id"], batch["source_folder_path"], final_status)
    db.commit()
    return {
        "renamedCount": succeeded,
        "renameErrors": errors,
        "repairRequired": bool(remaining),
        "operationCount": len(operations),
    }


def rename_confirmed_batch_sources(db, batch_id: str, folder_path: str, matches: list):
    plan_confirmed_batch_renames(db, batch_id, folder_path, matches)
    db.execute("UPDATE version_batches SET status='applying',updated_at=? WHERE id=?", (int(time.time() * 1000), batch_id))
    db.commit()
    return apply_pending_batch_operations(db, batch_id)


def batch_operation_list(db, payload: dict):
    batch_id = str(payload.get("batchId") or "")
    rows = db.execute(
        "SELECT * FROM batch_file_operations WHERE batch_id=? ORDER BY created_at,id", (batch_id,),
    ).fetchall()
    batch = db.execute("SELECT * FROM version_batches WHERE id=?", (batch_id,)).fetchone()
    if batch is None:
        raise ValueError("版本批次不存在")
    return {"success": True, "batch": batch_summary(db, batch_id), "operations": [serialize_batch_operation(row) for row in rows]}


def batch_retry_operations(db, payload: dict):
    batch_id = str(payload.get("batchId") or "")
    if payload.get("_executionMode") == "staged" and not payload.get("_deferBatchFilesystem"):
        raise RuntimeError("batch filesystem effects are forbidden in staged execution")
    if payload.get("_deferBatchFilesystem"):
        pending = db.execute(
            "SELECT COUNT(*) FROM batch_file_operations WHERE batch_id=? AND status!='succeeded'", (batch_id,),
        ).fetchone()[0]
        return {"success": True, "deferredFilesystem": True, "batch": batch_summary(db, batch_id),
                "renamedCount": 0, "renameErrors": [], "repairRequired": bool(pending), "operationCount": pending}
    result = apply_pending_batch_operations(db, batch_id)
    return {"success": not result["repairRequired"], "batch": batch_summary(db, batch_id), **result}


def batch_commit_compare(root: str, db, payload: dict):
    if payload.get("_executionMode") == "staged" and payload.get("renameSources") and not payload.get("_deferBatchFilesystem"):
        raise RuntimeError("batch filesystem effects are forbidden in staged execution")
    project = project_row(db, payload["projectName"])
    folder_a = canonical_path(payload["folderA"])
    folder_b = canonical_path(payload["folderB"])
    if not os.path.isdir(folder_a) or not os.path.isdir(folder_b):
        raise ValueError("批次文件夹不存在")
    if folder_a.casefold() == folder_b.casefold():
        raise ValueError("对照批次的来源和目标不能是同一个文件夹")
    set_progress_tracking_state_for_folder(db, project["id"], folder_b, "committing")
    db.commit()

    reference_batch = ensure_reference_batch(root, db, project, folder_a)
    pending_hashes = []
    # Relationship commits use stable file IDs plus quick fingerprints. Full
    # SHA-256 fingerprints are intentionally lazy: synchronously reading every
    # large JPG/video here does not affect the already-confirmed relationship
    # and used to dominate the confirmation wait time.
    import_key = str(payload.get("importKey") or uuid.uuid4())
    batch = db.execute("SELECT * FROM version_batches WHERE import_key=?", (import_key,)).fetchone()
    if batch is None and payload.get("reconcileExisting"):
        folder_identity = directory_identity(folder_b)
        batch = db.execute(
            """SELECT * FROM version_batches WHERE project_id=? AND parent_batch_id=? AND status='ready'
               AND (source_folder_path_key=? OR (? IS NOT NULL AND source_folder_id=?))
               ORDER BY sequence DESC LIMIT 1""",
            (project["id"], reference_batch["id"], folder_b.casefold(), folder_identity, folder_identity),
        ).fetchone()
    if batch is not None and batch["project_id"] != project["id"]:
        raise ValueError("批次提交标识已被其他项目使用")
    if batch is not None and batch["status"] == "ready" and not payload.get("reconcileExisting"):
        set_progress_tracking_state_for_folder(db, project["id"], folder_b, "ready")
        db.commit()
        return {
            "success": True, "alreadyCommitted": True,
            "referenceBatch": batch_summary(db, reference_batch["id"]),
            "batch": batch_summary(db, batch["id"]),
        }
    if batch is not None and batch["status"] == "ready":
        created_paths = []
        try:
            incremental_sources = [
                safe_folder_file(folder_b, source_name)
                for source_name in (payload.get("incrementalSources") or [])
            ]
            matches = sorted(
                payload.get("matches") or [],
                key=lambda match: float(match.get("distance") if match.get("distance") is not None else 1_000_000),
            )
            best_versions = {}
            matched_source_keys = set()
            for match in matches:
                reference_path = safe_folder_file(folder_a, match.get("reference"))
                source_path = safe_folder_file(folder_b, match.get("source"))
                source_key = source_path.casefold()
                if source_key in matched_source_keys:
                    continue
                matched_source_keys.add(source_key)
                parent = ensure_source_version(db, project, reference_path, pending_hashes)
                register_batch_item(db, reference_batch["id"], parent, reference_path, "baseline")
                version, created_path = create_linked_batch_version(db, project, batch, parent, source_path, pending_hashes)
                register_batch_item(
                    db, batch["id"], version, source_path, "visual-hash",
                    float(match.get("distance") or 0), str(match.get("confidence") or ""), "confirmed",
                )
                if created_path:
                    created_paths.append(created_path)
                best_versions.setdefault(version["photo_id"], version["id"])

            current_source_keys = set()
            for source_path in incremental_sources or folder_media_files(folder_b):
                source_key = source_path.casefold()
                current_source_keys.add(source_key)
                if source_key in matched_source_keys:
                    continue
                version = ensure_source_version(db, project, source_path, pending_hashes)
                register_batch_item(db, batch["id"], version, source_path, "new", review_status="new")
            if not incremental_sources:
                stale_items = db.execute(
                    "SELECT id,source_path_key FROM batch_items WHERE batch_id=?",
                    (batch["id"],),
                ).fetchall()
                for item in stale_items:
                    if item["source_path_key"] not in current_source_keys:
                        db.execute("DELETE FROM batch_items WHERE id=?", (item["id"],))

            timestamp = int(time.time() * 1000)
            for photo_id, version_id in best_versions.items():
                db.execute("UPDATE versions SET is_current=0,updated_at=? WHERE photo_id=?", (timestamp, photo_id))
                db.execute("UPDATE versions SET is_current=1,updated_at=? WHERE id=?", (timestamp, version_id))
                db.execute("UPDATE photos SET current_version_id=?,updated_at=? WHERE id=?", (version_id, timestamp, photo_id))
            if payload.get("renameSources"):
                plan_confirmed_batch_renames(db, batch["id"], folder_b, matches)
            db.execute(
                "UPDATE version_batches SET status=?,updated_at=? WHERE id=?",
                ("applying" if payload.get("renameSources") else "ready", timestamp, batch["id"]),
            )
            if not payload.get("renameSources"):
                set_progress_tracking_state_for_folder(db, project["id"], folder_b, "ready")
            db.commit()
            rename_result = (
                {"renamedCount": 0, "renameErrors": [], "repairRequired": True,
                 "operationCount": db.execute("SELECT COUNT(*) FROM batch_file_operations WHERE batch_id=? AND status!='succeeded'", (batch["id"],)).fetchone()[0],
                 "deferredFilesystem": True}
                if payload.get("renameSources") and payload.get("_deferBatchFilesystem")
                else apply_pending_batch_operations(db, batch["id"]) if payload.get("renameSources")
                else {"renamedCount": 0, "renameErrors": [], "repairRequired": False, "operationCount": 0}
            )
            return {
                "success": True,
                "reconciled": True,
                "referenceBatch": batch_summary(db, reference_batch["id"]),
                "batch": batch_summary(db, batch["id"]),
                **rename_result,
            }
        except Exception:
            db.rollback()
            db.execute(
                "UPDATE version_batches SET status='failed',updated_at=? WHERE id=?",
                (int(time.time() * 1000), batch["id"]),
            )
            set_progress_tracking_state_for_folder(db, project["id"], folder_b, "pending_compare")
            db.commit()
            for created_path in created_paths:
                try:
                    os.unlink(created_path)
                except OSError:
                    pass
            raise
    if batch is None:
        batch = create_batch_row(
            db, project["id"], folder_b, payload.get("displayName") or os.path.basename(folder_b),
            parent_batch_id=reference_batch["id"], import_key=import_key,
        )
        db.commit()
    else:
        db.execute(
            "UPDATE version_batches SET status='importing',updated_at=? WHERE id=?",
            (int(time.time() * 1000), batch["id"]),
        )
        db.commit()

    matched_source_keys = set()
    created_paths = []
    try:
        matches = sorted(
            payload.get("matches") or [],
            key=lambda match: float(match.get("distance") if match.get("distance") is not None else 1_000_000),
        )
        for match in matches:
            reference_path = safe_folder_file(folder_a, match.get("reference"))
            source_path = safe_folder_file(folder_b, match.get("source"))
            source_key = source_path.casefold()
            if source_key in matched_source_keys:
                continue
            matched_source_keys.add(source_key)
            parent = ensure_source_version(db, project, reference_path, pending_hashes)
            register_batch_item(db, reference_batch["id"], parent, reference_path, "baseline")
            version, created_path = create_linked_batch_version(db, project, batch, parent, source_path, pending_hashes)
            register_batch_item(
                db, batch["id"], version, source_path, "visual-hash",
                float(match.get("distance") or 0), str(match.get("confidence") or ""), "confirmed",
            )
            if created_path:
                created_paths.append(created_path)

        for source_path in folder_media_files(folder_b):
            if source_path.casefold() in matched_source_keys:
                continue
            version = ensure_source_version(db, project, source_path, pending_hashes)
            register_batch_item(db, batch["id"], version, source_path, "new", review_status="new")

        best_versions = {}
        rows = db.execute(
            """SELECT photo_id,version_id,match_distance FROM batch_items
               WHERE batch_id=? AND match_method='visual-hash'
               ORDER BY COALESCE(match_distance, 1000000), created_at""",
            (batch["id"],),
        ).fetchall()
        for row in rows:
            best_versions.setdefault(row["photo_id"], row["version_id"])
        timestamp = int(time.time() * 1000)
        for photo_id, version_id in best_versions.items():
            db.execute("UPDATE versions SET is_current=0,updated_at=? WHERE photo_id=?", (timestamp, photo_id))
            db.execute("UPDATE versions SET is_current=1,updated_at=? WHERE id=?", (timestamp, version_id))
            db.execute("UPDATE photos SET current_version_id=?,updated_at=? WHERE id=?", (version_id, timestamp, photo_id))
        if payload.get("renameSources"):
            plan_confirmed_batch_renames(db, batch["id"], folder_b, matches)
        db.execute(
            "UPDATE version_batches SET status=?,updated_at=? WHERE id=?",
            ("applying" if payload.get("renameSources") else "ready", timestamp, batch["id"]),
        )
        if not payload.get("renameSources"):
            set_progress_tracking_state_for_folder(db, project["id"], folder_b, "ready")
        db.commit()
        rename_result = (
            {"renamedCount": 0, "renameErrors": [], "repairRequired": True,
             "operationCount": db.execute("SELECT COUNT(*) FROM batch_file_operations WHERE batch_id=? AND status!='succeeded'", (batch["id"],)).fetchone()[0],
             "deferredFilesystem": True}
            if payload.get("renameSources") and payload.get("_deferBatchFilesystem")
            else apply_pending_batch_operations(db, batch["id"]) if payload.get("renameSources")
            else {"renamedCount": 0, "renameErrors": [], "repairRequired": False, "operationCount": 0}
        )
        return {
            "success": True,
            "referenceBatch": batch_summary(db, reference_batch["id"]),
            "batch": batch_summary(db, batch["id"]),
            **rename_result,
        }
    except Exception:
        db.rollback()
        db.execute(
            "UPDATE version_batches SET status='failed',updated_at=? WHERE id=?",
            (int(time.time() * 1000), batch["id"]),
        )
        set_progress_tracking_state_for_folder(db, project["id"], folder_b, "pending_compare")
        db.commit()
        raise


def sync_directories(root: str, db):
    """Reconcile direct child folders with the catalog without moving files."""
    now = int(time.time() * 1000)
    rows = db.execute("SELECT * FROM projects").fetchall()
    internal_rows = [row for row in rows if is_internal_workspace_directory(row["relative_path"])]
    for row in internal_rows:
        db.execute("DELETE FROM projects WHERE id=?", (row["id"],))
    internal_ids = {row["id"] for row in internal_rows}
    rows = [row for row in rows if row["id"] not in internal_ids]
    external_rows = [row for row in rows if json.loads(row["extra_json"] or "{}").get("importMode") == "reference"]
    for row in external_rows:
        if row["is_deleted"]:
            continue
        available = os.path.isdir(row["relative_path"])
        state = "available" if available else "missing"
        if row["availability"] != state:
            db.execute("UPDATE projects SET availability=?,missing_since=?,missing_checks=?,updated_at=? WHERE id=?",
                       (state, None if available else now, 0 if available else 1, now, row["id"]))
    external_ids = {row["id"] for row in external_rows}
    rows = [row for row in rows if row["id"] not in external_ids]
    by_path = {row["relative_path"].casefold(): row for row in rows}
    by_identity = {row["filesystem_id"]: row for row in rows if row["filesystem_id"]}
    seen_ids = set()

    for entry in os.scandir(root):
        if not entry.is_dir() or is_internal_workspace_directory(entry.name):
            continue
        if any(canonical_path(entry.path).casefold() == canonical_path(row["relative_path"]).casefold() for row in external_rows):
            continue
        relative_path = entry.name
        identity = directory_identity(entry.path)
        row = by_path.get(relative_path.casefold())
        if row is not None:
            if row["is_deleted"]:
                db.execute(
                    """UPDATE projects SET is_deleted=0,filesystem_id=?,availability='available',
                       missing_since=NULL,missing_checks=0,updated_at=? WHERE id=?""",
                    (identity, now, row["id"]),
                )
            seen_ids.add(row["id"])
            if identity != row["filesystem_id"] or row["availability"] != "available" or row["missing_checks"]:
                db.execute(
                    """UPDATE projects SET filesystem_id=?,availability='available',missing_since=NULL,
                       missing_checks=0,updated_at=? WHERE id=?""",
                    (identity, now, row["id"]),
                )
            continue
        renamed_row = by_identity.get(identity) if identity else None
        if renamed_row is not None and renamed_row["id"] not in seen_ids:
            db.execute(
                """UPDATE projects SET name=?,relative_path=?,is_deleted=0,availability='available',
                   missing_since=NULL,missing_checks=0,updated_at=? WHERE id=?""",
                (entry.name, relative_path, now, renamed_row["id"]),
            )
            seen_ids.add(renamed_row["id"])
            continue
        project_id = str(uuid.uuid4())
        db.execute(
            "INSERT INTO projects(id,name,status,relative_path,filesystem_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
            (project_id, entry.name, "未分类", relative_path, identity, now, now),
        )
        seen_ids.add(project_id)

    for row in rows:
        if (not row["is_deleted"] and row["id"] not in seen_ids
                and row["availability"] != "missing"
                and not os.path.isdir(os.path.join(root, row["relative_path"]))):
            db.execute(
                """UPDATE projects SET availability='missing',missing_since=?,
                   missing_checks=1,updated_at=? WHERE id=?""",
                (now, now, row["id"]),
            )
    db.commit()


def catalog_snapshot(db, database: str):
    rows = [dict(row) for row in db.execute("SELECT * FROM projects WHERE is_deleted=0 ORDER BY name COLLATE NOCASE").fetchall() if not is_internal_workspace_directory(row["relative_path"])]
    return {"success": True, "projects": rows, "database": os.path.abspath(database)}


def load(root: str, database: str):
    # Schema creation/migration happens only when required. Normal project-list
    # refreshes use a query-only connection and never compete for SQLite's
    # single WAL writer slot.
    requires_initialization = database_needs_initialization(database)
    requires_wal = False
    if not requires_initialization:
        try:
            probe = connect_read_only(database)
            try:
                requires_wal = str(probe.execute("PRAGMA journal_mode").fetchone()[0]).lower() != "wal"
            finally:
                probe.close()
        except DatabaseWriteRequired:
            requires_initialization = True
    if requires_initialization or requires_wal:
        initialized = connect(root, database, include_domains=False)
        try:
            # Preserve eager creation/migration for a healthy installation, but
            # never make catalog startup depend on an optional compatibility domain.
            try:
                run_compatibility_hooks("prepare_connection", initialized, database, True)
            except (OSError, sqlite3.Error, RuntimeError, ValueError):
                pass
        finally:
            initialized.close()
    db = connect_read_only(database)
    try:
        return catalog_snapshot(db, database)
    finally:
        db.close()


def _operation_undo_records(db, payload=None):
    external = (payload or {}).get("undoRecords")
    if external is None:
        return [dict(record) for record in db.execute(
            "SELECT * FROM undo_records WHERE state <> 'retired' AND kind IN ('trash','project-cleanup') ORDER BY created_at DESC"
        ).fetchall()]
    records = []
    for value in external if isinstance(external, list) else []:
        if not isinstance(value, dict):
            continue
        record = dict(value)
        if str(record.get("state") or "ready") == "retired":
            continue
        if "payload_json" not in record:
            record["payload_json"] = json.dumps(record.get("payload") or {}, ensure_ascii=False)
        records.append(record)
    return sorted(records, key=lambda record: int(record.get("created_at") or 0), reverse=True)


def _undo_claim_token(row) -> str:
    fields = [row[key] for key in ("id", "kind", "payload_json", "state", "created_at", "updated_at")]
    encoded = json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _undo_record_response(row):
    if row is None:
        return None
    record = dict(row)
    record["claimToken"] = _undo_claim_token(row)
    record["payload"] = json.loads(record.pop("payload_json"))
    return record


def deleted_projects_list(db, payload=None):
    records_by_name = {}
    for record in _operation_undo_records(db, payload):
        try:
            payload = json.loads(record["payload_json"] or "{}")
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        catalog = payload.get("projectCatalog") or {}
        name = str(catalog.get("name") or "").casefold()
        if not name or name in records_by_name:
            continue
        item = (payload.get("items") or [{}])[0] or {}
        records_by_name[name] = {
            "undoRecordId": record["id"],
            "undoRecordState": record["state"],
            "originalPath": str(item.get("original") or ""),
            "recyclePidl": str(item.get("recyclePidl") or ""),
            "preciseRestore": bool(item.get("preciseRestore", True)),
            "permanent": bool(item.get("permanent", False)),
        }

    rows = db.execute(
        """SELECT projects.*,
                  (SELECT COUNT(*) FROM photos WHERE photos.project_id=projects.id) AS photo_count,
                  (SELECT COUNT(*) FROM versions JOIN photos ON photos.id=versions.photo_id
                    WHERE photos.project_id=projects.id) AS version_count
           FROM projects WHERE projects.is_deleted=1 ORDER BY projects.updated_at DESC"""
    ).fetchall()
    projects = []
    for row in rows:
        record = records_by_name.get(str(row["name"]).casefold(), {})
        projects.append({
            "id": row["id"],
            "name": row["name"],
            "status": row["status"],
            "relativePath": row["relative_path"],
            "deletedAt": row["updated_at"],
            "photoCount": row["photo_count"],
            "versionCount": row["version_count"],
            **record,
        })
    return {"success": True, "projects": projects}


def project_cleanup_plan(db, project, payload=None):
    project_id = project["id"]
    photo_rows = db.execute("SELECT id,original_file_path FROM photos WHERE project_id=?", (project_id,)).fetchall()
    photo_ids = [row["id"] for row in photo_rows]
    version_rows = db.execute(
        """SELECT versions.id,versions.file_path,versions.thumbnail_path FROM versions
           JOIN photos ON photos.id=versions.photo_id WHERE photos.project_id=?""",
        (project_id,),
    ).fetchall()
    version_ids = [row["id"] for row in version_rows]
    source_paths = [row["original_file_path"] for row in photo_rows if row["original_file_path"]]
    source_paths.extend(row["file_path"] for row in version_rows if row["file_path"])
    artifact_paths = [row["thumbnail_path"] for row in version_rows if row["thumbnail_path"]]
    removed_undo_ids = []
    for record in _operation_undo_records(db, payload):
        try:
            record_payload = json.loads(record["payload_json"] or "{}")
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        catalog = record_payload.get("projectCatalog") or {}
        if str(catalog.get("name") or "").casefold() == str(project["name"]).casefold():
            removed_undo_ids.append(record["id"])

    compatibility_cleanup = {}
    for report in run_compatibility_hooks("project_cleanup_plan", db, project_id, photo_ids):
        compatibility_cleanup.update(report or {})
    return {
        "success": True,
        "name": project["name"],
        "photoIds": photo_ids,
        "sourcePaths": list(dict.fromkeys(source_paths)),
        "artifactPaths": list(dict.fromkeys(artifact_paths)),
        "removedUndoIds": removed_undo_ids,
        **compatibility_cleanup,
    }


def deleted_project_cleanup_plan(db, payload: dict):
    project_id = str(payload.get("projectId") or "")
    project = db.execute("SELECT * FROM projects WHERE id=? AND is_deleted=1", (project_id,)).fetchone()
    if project is None:
        raise ValueError("已删除项目记录不存在")
    return project_cleanup_plan(db, project, payload)


def _delete_where_ids(db, table: str, column: str, values, schema: str | None = None) -> None:
    values = list(dict.fromkeys(str(value) for value in values if value is not None))
    qualified = f'"{schema}"."{table}"' if schema else f'"{table}"'
    for offset in range(0, len(values), 400):
        chunk = values[offset:offset + 400]
        placeholders = ",".join("?" for _ in chunk)
        db.execute(f'DELETE FROM {qualified} WHERE "{column}" IN ({placeholders})', chunk)


def _select_ids_by_ids(db, qualified_table: str, select_column: str, where_column: str, values) -> list:
    values = list(dict.fromkeys(str(value) for value in values if value is not None))
    result = []
    for offset in range(0, len(values), 400):
        chunk = values[offset:offset + 400]
        placeholders = ",".join("?" for _ in chunk)
        result.extend(row[0] for row in db.execute(
            f'SELECT "{select_column}" FROM {qualified_table} WHERE "{where_column}" IN ({placeholders})', chunk
        ).fetchall())
    return result


def _read_purge_journal(db):
    raw = _meta_value(db, "purge_journal_v1")
    if not raw:
        return None
    try:
        journal = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise RuntimeError("purge journal is malformed") from error
    if int(journal.get("version") or 0) != 1 or not journal.get("projectId"):
        raise RuntimeError("purge journal is incompatible")
    return journal


def _save_purge_stage(db, journal, stage: str):
    updated = {**journal, "stage": stage, "updatedAt": int(time.time() * 1000)}
    db.execute("PRAGMA main.synchronous=FULL")
    db.execute("BEGIN IMMEDIATE")
    try:
        _set_meta(db, "purge_journal_v1", json.dumps(updated, ensure_ascii=False, sort_keys=True))
        db.commit()
    except Exception:
        db.rollback(); raise
    return updated


def _prepare_durable_purge(db, project, result, payload, deleted: bool):
    if db.in_transaction: db.commit()
    db.execute("PRAGMA main.synchronous=FULL")
    existing = _read_purge_journal(db)
    project_id = str(project["id"])
    if existing:
        if str(existing["projectId"]) != project_id:
            raise RuntimeError("另一个项目清理 journal 尚未完成")
        return existing
    media = _table_schema(db, "photos", "media")
    versioning = _table_schema(db, "versions", "versioning")
    if not media or not versioning:
        raise RuntimeError("purge requires attached media and versioning stores")
    photo_ids = [row[0] for row in db.execute(f'SELECT id FROM "{media}"."photos" WHERE project_id=?', (project_id,))]
    versions_table = f'"{versioning}"."versions"'
    journal = {
        "version": 1, "projectId": project_id, "projectName": str(project["name"]), "deleted": bool(deleted),
        "stage": "prepared", "photoIds": photo_ids,
        "versionIds": _select_ids_by_ids(db, versions_table, "id", "photo_id", photo_ids),
        "batchIds": [row[0] for row in db.execute(f'SELECT id FROM "{versioning}"."version_batches" WHERE project_id=?', (project_id,))],
        "sessionIds": [row[0] for row in db.execute(f'SELECT id FROM "{versioning}"."tracking_sessions" WHERE project_id=?', (project_id,))],
        "snapshotIds": [row[0] for row in db.execute(f'SELECT snapshot_id FROM "{media}"."media_incremental_snapshots" WHERE project_id=?', (project_id,))],
        "removedUndoIds": list(dict.fromkeys(str(value) for value in result.get("removedUndoIds") or [])),
        "externalUndo": "undoRecords" in payload, "result": result,
        "createdAt": int(time.time() * 1000), "updatedAt": int(time.time() * 1000),
    }
    expected = "is_deleted=1" if deleted else "is_deleted=0 AND availability='missing'"
    db.execute("BEGIN IMMEDIATE")
    try:
        if db.execute(f"SELECT 1 FROM projects WHERE id=? AND {expected}", (project_id,)).fetchone() is None:
            raise RuntimeError("项目目录记录在 purge journal 创建前发生变化")
        _set_meta(db, "purge_journal_v1", json.dumps(journal, ensure_ascii=False, sort_keys=True))
        db.commit()
    except Exception:
        db.rollback(); raise
    return journal


def _resume_purge_journal(db):
    journal = _read_purge_journal(db)
    if not journal: return None
    project_id = str(journal["projectId"])
    media = _table_schema(db, "photos", "media")
    versioning = _table_schema(db, "versions", "versioning")
    if not media or not versioning: raise RuntimeError("purge replay requires attached domain stores")
    db.execute(f'PRAGMA "{media}".synchronous=FULL')
    db.execute(f'PRAGMA "{versioning}".synchronous=FULL')
    stage = str(journal.get("stage") or "prepared")
    if stage == "prepared":
        db.execute("BEGIN IMMEDIATE")
        try:
            for table in ("media_incremental_snapshot_files", "media_incremental_snapshot_scopes", "media_incremental_snapshot_baseline", "media_incremental_snapshot_batches"):
                _delete_where_ids(db, table, "snapshot_id", journal.get("snapshotIds") or [], media)
            db.execute(f'DELETE FROM "{media}"."media_incremental_snapshots" WHERE project_id=?', (project_id,))
            _delete_where_ids(db, "file_records", "owner_id", journal.get("versionIds") or [], media)
            _delete_where_ids(db, "photos", "id", journal.get("photoIds") or [], media)
            violations = db.execute(f'PRAGMA "{media}".foreign_key_check').fetchall()
            if violations: raise RuntimeError(f"media purge foreign key check failed: {violations[:10]}")
            db.commit()
        except Exception:
            db.rollback(); raise
        journal = _save_purge_stage(db, journal, "media"); stage = "media"
    if stage == "media":
        db.execute("BEGIN IMMEDIATE")
        try:
            _delete_where_ids(db, "tracking_session_items", "session_id", journal.get("sessionIds") or [], versioning)
            db.execute(f'DELETE FROM "{versioning}"."tracking_sessions" WHERE project_id=?', (project_id,))
            for table in ("batch_file_operations", "batch_items"):
                _delete_where_ids(db, table, "batch_id", journal.get("batchIds") or [], versioning)
            _delete_where_ids(db, "version_compare_history", "photo_id", journal.get("photoIds") or [], versioning)
            _delete_where_ids(db, "versions", "photo_id", journal.get("photoIds") or [], versioning)
            for table in ("progress_folder_relocations", "progress_external_link_renames", "media_import_artifact_slots", "version_graph_edges", "legacy_selection_relation_repairs", "version_tree_node_positions", "version_tree_layouts", "media_import_graph_sessions"):
                db.execute(f'DELETE FROM "{versioning}"."{table}" WHERE project_id=?', (project_id,))
            db.execute(f'DELETE FROM "{versioning}"."progress_folders" WHERE project_id=?', (project_id,))
            db.execute(f'DELETE FROM "{versioning}"."version_batches" WHERE project_id=?', (project_id,))
            violations = db.execute(f'PRAGMA "{versioning}".foreign_key_check').fetchall()
            if violations: raise RuntimeError(f"versioning purge foreign key check failed: {violations[:10]}")
            db.commit()
        except Exception:
            db.rollback(); raise
        journal = _save_purge_stage(db, journal, "versioning"); stage = "versioning"
    if stage == "versioning":
        db.execute("BEGIN IMMEDIATE")
        try:
            run_compatibility_hooks("purge_project_rows", db, project_id); db.commit()
        except Exception:
            db.rollback(); raise
        journal = _save_purge_stage(db, journal, "compatibility"); stage = "compatibility"
    if stage != "compatibility": raise RuntimeError(f"unknown purge stage: {stage}")
    db.execute("BEGIN IMMEDIATE")
    try:
        db.execute("DELETE FROM project_properties WHERE project_id=?", (project_id,))
        db.execute("DELETE FROM project_tags WHERE project_id=?", (project_id,))
        undo_ids = journal.get("removedUndoIds") or []
        if undo_ids and journal.get("externalUndo"):
            raw = _meta_value(db, "operations_outbox_v1")
            pending = [] if not raw else [str(value) for value in json.loads(raw).get("removeUndoIds") or []]
            _set_meta(db, "operations_outbox_v1", json.dumps({"removeUndoIds": list(dict.fromkeys((*pending, *undo_ids))), "updatedAt": int(time.time() * 1000)}, sort_keys=True))
        elif undo_ids:
            for offset in range(0, len(undo_ids), 400):
                chunk = undo_ids[offset:offset + 400]
                placeholders = ",".join("?" for _ in chunk)
                db.execute(f"DELETE FROM undo_records WHERE id IN ({placeholders}) AND state <> 'retired'", chunk)
        expected = "is_deleted=1" if journal.get("deleted") else "is_deleted=0 AND availability='missing'"
        if db.execute(f"DELETE FROM projects WHERE id=? AND {expected}", (project_id,)).rowcount != 1:
            raise RuntimeError("项目目录记录在 purge finalization 期间发生变化")
        completed_at = int(time.time() * 1000)
        _set_meta(db, f"purge_receipt:{project_id}", json.dumps({"result": journal.get("result") or {}, "completedAt": completed_at}, ensure_ascii=False, sort_keys=True))
        _prune_purge_receipts(db, completed_at)
        db.execute("DELETE FROM meta WHERE key='purge_journal_v1'")
        db.commit()
        return journal.get("result") or {}
    except Exception:
        db.rollback(); raise


def purge_deleted_project(db, payload: dict):
    project_id = str(payload.get("projectId") or "")
    project = db.execute("SELECT * FROM projects WHERE id=? AND is_deleted=1", (project_id,)).fetchone()
    if project is None:
        receipt = _meta_value(db, f"purge_receipt:{project_id}")
        if receipt:
            return json.loads(receipt).get("result") or {"success": True}
        raise ValueError("已删除项目记录不存在")
    result = project_cleanup_plan(db, project, payload)
    journal = _prepare_durable_purge(db, project, result, payload, deleted=True)
    return _resume_purge_journal(db) or journal.get("result") or result


def purge_missing_project(root: str, db, payload: dict):
    name = str(payload.get("name") or "").strip()
    project = db.execute(
        "SELECT * FROM projects WHERE name=? COLLATE NOCASE AND is_deleted=0 AND availability='missing'",
        (name,),
    ).fetchone()
    if project is None:
        for row in db.execute("SELECT value FROM meta WHERE key LIKE 'purge_receipt:%'").fetchall():
            receipt = json.loads(row[0])
            result = receipt.get("result") or {}
            if str(result.get("name") or "").casefold() == name.casefold():
                return result
        raise ValueError("离线项目记录不存在或项目已经恢复")
    project_path = os.path.abspath(os.path.join(root, project["relative_path"]))
    if os.path.exists(project_path):
        raise ValueError("项目文件夹仍然存在，不能只移除软件记录")
    result = project_cleanup_plan(db, project, payload)
    journal = _prepare_durable_purge(db, project, result, payload, deleted=False)
    return _resume_purge_journal(db) or journal.get("result") or result


def missing_projects_list(db, payload: dict):
    cutoff = int(payload.get("missingBefore") or 0)
    rows = db.execute(
        """SELECT id,name,relative_path,missing_since,extra_json FROM projects
           WHERE is_deleted=0 AND availability='missing' AND missing_since IS NOT NULL AND missing_since<=?
           ORDER BY missing_since""",
        (cutoff,),
    ).fetchall()
    projects = []
    for row in rows:
        try:
            archive = (json.loads(row["extra_json"] or "{}").get("archive") or {})
        except (TypeError, ValueError, json.JSONDecodeError):
            archive = {}
        if archive.get("path"):
            continue
        projects.append({"id": row["id"], "name": row["name"], "relativePath": row["relative_path"], "missingSince": row["missing_since"]})
    return {"success": True, "projects": projects}


def cleanup_media_workflow_graph(root: str, db, session_cutoff: int | None = None):
    """Remove stale retry metadata and graph records that no longer satisfy endpoint rules."""
    now = int(time.time() * 1000)
    cutoff = int(session_cutoff if session_cutoff is not None else now - 30 * 24 * 60 * 60 * 1000)
    for project in db.execute("SELECT * FROM projects WHERE is_deleted=0").fetchall():
        sync_progress_folder_locations(root, db, project, commit=False)
    removed_slot_mappings = db.execute(
        """DELETE FROM media_import_artifact_slots AS slot WHERE NOT EXISTS(
             SELECT 1 FROM progress_folders progress WHERE progress.id=slot.progress_id
               AND progress.project_id=slot.project_id AND (
                 (slot.import_slot='raw' AND progress.media_kind='image' AND progress.node_role='original' AND progress.artifact_kind IS NULL)
                 OR (slot.import_slot='camera_jpg' AND progress.media_kind='image' AND progress.node_role='original' AND progress.artifact_kind='companion')
                 OR (slot.import_slot='generated_jpg' AND progress.media_kind='image' AND progress.node_role='artifact' AND progress.artifact_kind='preview')
                 OR (slot.import_slot='mov' AND progress.media_kind='video' AND progress.node_role='original' AND progress.artifact_kind IS NULL)
                 OR (slot.import_slot='video_transcode' AND progress.media_kind='video' AND progress.node_role='artifact' AND progress.artifact_kind='transcode')
               )
           )"""
    ).rowcount
    removed_edges = []
    rows = db.execute(
        """SELECT edge.*,source.media_kind AS source_media_kind,source.node_role AS source_role,
                  source.artifact_kind AS source_artifact_kind,source.parent_progress_id AS source_parent_id,
                  source.relation_kind AS source_relation_kind,target.media_kind AS target_media_kind,
                  target.node_role AS target_role,target.artifact_kind AS target_artifact_kind,
                  target.parent_progress_id AS target_parent_id,target.relation_kind AS target_relation_kind,
                  target.source_metadata_json AS target_source_metadata_json
           FROM version_graph_edges edge
           LEFT JOIN progress_folders source ON source.id=edge.source_progress_id
           LEFT JOIN progress_folders target ON target.id=edge.target_progress_id"""
    ).fetchall()
    for row in rows:
        target_source_metadata = json.loads(row["target_source_metadata_json"] or "{}")
        valid = row["source_role"] is not None and row["target_role"] is not None and row["source_media_kind"] == row["target_media_kind"] and (
            row["edge_kind"] == "media_companion" and row["source_role"] == "original" and row["source_artifact_kind"] is None
            and row["target_role"] == "original" and row["target_artifact_kind"] == "companion"
            or row["edge_kind"] == "derived_preview" and (row["source_role"] == "original" and row["source_artifact_kind"] is None
                or row["source_role"] == "progress" and row["source_parent_id"] is not None and row["source_relation_kind"] == "main")
            and row["target_role"] == "artifact" and row["target_artifact_kind"] == "preview"
            or row["edge_kind"] == "derived_transcode" and (row["source_role"] == "original" and row["source_artifact_kind"] is None
                or row["source_role"] == "progress" and row["source_parent_id"] is not None and row["source_relation_kind"] == "main")
            and row["target_role"] == "artifact" and row["target_artifact_kind"] == "transcode"
            or row["edge_kind"] == "workflow_input" and (
                row["source_role"] in ("selection", "workflow") and row["target_role"] == "progress"
                and row["target_parent_id"] is not None and row["target_relation_kind"] == "main"
                or row["source_role"] == "progress" and row["source_parent_id"] is not None and row["source_relation_kind"] == "main" and row["target_role"] == "workflow"
                and target_source_metadata.get("parentCapability") == "workflow-input"
            )
        )
        if not valid:
            db.execute("DELETE FROM version_graph_edges WHERE id=?", (row["id"],))
            removed_edges.append(row["id"])
    removed_sessions = db.execute(
        "DELETE FROM media_import_graph_sessions WHERE updated_at<=?",
        (cutoff,),
    ).rowcount
    db.commit()
    return {"removedEdgeIds": removed_edges, "removedImportSessionCount": removed_sessions,
            "removedImportSlotMappingCount": removed_slot_mappings}


def reconcile_cross_domain_references(db) -> dict:
    """Remove projections whose stable-ID owners vanished from detached stores.

    Semantic-invalid graph edges and import slots belong to
    cleanup_media_workflow_graph. This repair is intentionally limited to
    absent owners so recoverable rows are not discarded during reconciliation.
    """
    db.execute("SAVEPOINT reconcile_cross_domain_references")
    try:
        removed_file_records = db.execute(
            """DELETE FROM file_records WHERE owner_type='version' AND NOT EXISTS(
                 SELECT 1 FROM versions WHERE versions.id=file_records.owner_id
               )"""
        ).rowcount
        removed_batch_items = db.execute(
            """DELETE FROM batch_items WHERE NOT EXISTS(
                 SELECT 1 FROM version_batches WHERE version_batches.id=batch_items.batch_id
               ) OR NOT EXISTS(
                 SELECT 1 FROM versions WHERE versions.id=batch_items.version_id
               ) OR NOT EXISTS(
                 SELECT 1 FROM photos WHERE photos.id=batch_items.photo_id
               )"""
        ).rowcount
        removed_batch_operations = db.execute(
            """DELETE FROM batch_file_operations WHERE NOT EXISTS(
                 SELECT 1 FROM version_batches WHERE version_batches.id=batch_file_operations.batch_id
               )"""
        ).rowcount

        # First remove items whose session is already gone. Then remove items
        # owned by sessions that are themselves irrecoverably detached before
        # deleting those sessions (detached stores have no FK cascade).
        removed_tracking_session_items = db.execute(
            """DELETE FROM tracking_session_items WHERE NOT EXISTS(
                 SELECT 1 FROM tracking_sessions WHERE tracking_sessions.id=tracking_session_items.session_id
               )"""
        ).rowcount
        invalid_tracking_session_ids = [
            row["id"] for row in db.execute(
                """SELECT tracking_sessions.id FROM tracking_sessions
                   WHERE NOT EXISTS(
                     SELECT 1 FROM progress_folders
                     WHERE progress_folders.id=tracking_sessions.progress_id
                   ) OR NOT EXISTS(
                     SELECT 1 FROM progress_folders
                     WHERE progress_folders.id=tracking_sessions.parent_progress_id
                   ) OR (tracking_sessions.committed_batch_id IS NOT NULL AND NOT EXISTS(
                     SELECT 1 FROM version_batches
                     WHERE version_batches.id=tracking_sessions.committed_batch_id
                   ))"""
            ).fetchall()
        ]
        removed_tracking_sessions = 0
        if invalid_tracking_session_ids:
            placeholders = ",".join("?" for _ in invalid_tracking_session_ids)
            removed_tracking_session_items += db.execute(
                f"DELETE FROM tracking_session_items WHERE session_id IN ({placeholders})",
                invalid_tracking_session_ids,
            ).rowcount
            removed_tracking_sessions = db.execute(
                f"DELETE FROM tracking_sessions WHERE id IN ({placeholders})",
                invalid_tracking_session_ids,
            ).rowcount

        removed_version_graph_edges = db.execute(
            """DELETE FROM version_graph_edges WHERE NOT EXISTS(
                 SELECT 1 FROM progress_folders
                 WHERE progress_folders.id=version_graph_edges.source_progress_id
               ) OR NOT EXISTS(
                 SELECT 1 FROM progress_folders
                 WHERE progress_folders.id=version_graph_edges.target_progress_id
               )"""
        ).rowcount
        removed_import_slot_mappings = db.execute(
            """DELETE FROM media_import_artifact_slots WHERE NOT EXISTS(
                 SELECT 1 FROM progress_folders
                 WHERE progress_folders.id=media_import_artifact_slots.progress_id
               )"""
        ).rowcount
        removed_legacy_selection_repairs = db.execute(
            """DELETE FROM legacy_selection_relation_repairs WHERE NOT EXISTS(
                 SELECT 1 FROM progress_folders
                 WHERE progress_folders.id=legacy_selection_relation_repairs.progress_id
               )"""
        ).rowcount

        stale_position_scopes = db.execute(
            """SELECT DISTINCT project_id, scope_key FROM version_tree_node_positions
               WHERE NOT EXISTS(
                 SELECT 1 FROM version_tree_layouts layout
                 WHERE layout.project_id=version_tree_node_positions.project_id
                   AND layout.scope_key=version_tree_node_positions.scope_key
               ) OR (node_key LIKE 'progress:%' AND NOT EXISTS(
                 SELECT 1 FROM progress_folders
                 WHERE progress_folders.id=substr(version_tree_node_positions.node_key, 10)
               ))"""
        ).fetchall()
        removed_version_tree_positions = db.execute(
            """DELETE FROM version_tree_node_positions
               WHERE NOT EXISTS(
                 SELECT 1 FROM version_tree_layouts layout
                 WHERE layout.project_id=version_tree_node_positions.project_id
                   AND layout.scope_key=version_tree_node_positions.scope_key
               ) OR (node_key LIKE 'progress:%' AND NOT EXISTS(
                 SELECT 1 FROM progress_folders
                 WHERE progress_folders.id=substr(version_tree_node_positions.node_key, 10)
               ))"""
        ).rowcount
        for scope_row in stale_position_scopes:
            db.execute(
                """UPDATE version_tree_layouts SET revision=revision+1, updated_at=?
                   WHERE project_id=? AND scope_key=?""",
                (int(time.time() * 1000), scope_row["project_id"], scope_row["scope_key"]),
            )

        removed_compare_history = db.execute(
            """DELETE FROM version_compare_history WHERE NOT EXISTS(
                 SELECT 1 FROM photos WHERE photos.id=version_compare_history.photo_id
               ) OR NOT EXISTS(
                 SELECT 1 FROM versions WHERE versions.id=version_compare_history.left_version_id
               ) OR NOT EXISTS(
                 SELECT 1 FROM versions WHERE versions.id=version_compare_history.right_version_id
               )"""
        ).rowcount
        db.execute("RELEASE SAVEPOINT reconcile_cross_domain_references")
    except BaseException:
        db.execute("ROLLBACK TO SAVEPOINT reconcile_cross_domain_references")
        db.execute("RELEASE SAVEPOINT reconcile_cross_domain_references")
        raise
    return {
        "removedFileRecords": removed_file_records,
        "removedBatchItems": removed_batch_items,
        "removedBatchOperations": removed_batch_operations,
        "removedTrackingSessionItems": removed_tracking_session_items,
        "removedTrackingSessions": removed_tracking_sessions,
        "removedVersionGraphEdges": removed_version_graph_edges,
        "removedImportSlotMappings": removed_import_slot_mappings,
        "removedLegacySelectionRepairs": removed_legacy_selection_repairs,
        "removedVersionTreePositions": removed_version_tree_positions,
        "removedCompareHistory": removed_compare_history,
    }


MEDIA_DURABLE_ACTIONS = frozenset((
    "media_sync_apply_batch", "media_sync_finalize",
    "media_sync_paths_apply_batch", "media_sync_paths_finalize",
    "media_create_version", "media_update_version", "media_component_update_version",
    "media_component_delete_version", "media_refresh_metadata_fingerprint",
    "media_set_thumbnail", "media_relocate_version", "media_delete_version",
    "media_delete_project_missing_version", "media_record_compare",
))
BATCH_CROSS_DOMAIN_DURABLE_ACTIONS = frozenset((
    "batch_register_baseline", "batch_commit_compare", "batch_retry_operations",
))
BATCH_FILESYSTEM_DURABLE_ACTIONS = frozenset(("batch_commit_compare", "batch_retry_operations"))
MEDIA_RECEIPT_SOFT_LIMIT = 512
PURGE_RECEIPT_SOFT_LIMIT = 256


def _prune_purge_receipts(db, now: int | None = None) -> int:
    now = int(now or time.time() * 1000)
    rows = []
    for row in db.execute("SELECT key,value FROM meta WHERE key LIKE 'purge_receipt:%'").fetchall():
        try:
            completed_at = int(json.loads(row[1]).get("completedAt") or 0)
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        rows.append((str(row[0]), completed_at))
    rows.sort(key=lambda item: (item[1], item[0]), reverse=True)
    removed = 0
    for index, (key, completed_at) in enumerate(rows):
        expired = completed_at > 0 and now - completed_at > MEDIA_RECEIPT_RETENTION_MS
        beyond_limit = index >= PURGE_RECEIPT_SOFT_LIMIT and completed_at > 0 and now - completed_at > MEDIA_RECEIPT_RECENT_MS
        if expired or beyond_limit:
            removed += db.execute("DELETE FROM meta WHERE key=?", (key,)).rowcount
    return removed


def _sqlite_backup_schema(source, schema: str, destination: str) -> None:
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    target = sqlite3.connect(destination, timeout=30)
    try:
        target.execute("PRAGMA synchronous=FULL")
        source.backup(target, name=schema)
        target.commit()
        if target.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise RuntimeError(f"media operation staging backup failed: {schema}")
    finally:
        target.close()


def _publish_sqlite_stage(source_path: str, destination: str) -> None:
    if not os.path.isfile(source_path):
        raise RuntimeError(f"media operation staging database is missing: {source_path}")
    source = sqlite3.connect(f"{Path(source_path).resolve().as_uri()}?mode=ro", uri=True, timeout=30)
    target = sqlite3.connect(destination, timeout=30)
    try:
        target.execute("PRAGMA busy_timeout=30000")
        target.execute("PRAGMA synchronous=FULL")
        if source.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise RuntimeError("media operation staging database is corrupt")
        source.backup(target)
        target.commit()
        if target.execute("PRAGMA quick_check").fetchone()[0] != "ok" or target.execute("PRAGMA foreign_key_check").fetchall():
            raise RuntimeError("media operation publication verification failed")
    finally:
        target.close()
        source.close()


def _read_media_operation_journal(database: str):
    if not os.path.isfile(database): return None
    db = sqlite3.connect(database, timeout=30)
    try:
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").fetchone() is None:
            return None
        row = db.execute("SELECT value FROM meta WHERE key='media_operation_journal_v1'").fetchone()
        if row is None: return None
        journal = json.loads(row[0])
        if int(journal.get("version") or 0) != 1 or not journal.get("operationId") or not journal.get("stageRoot"):
            raise RuntimeError("media operation journal is incompatible")
        stage_root = os.path.abspath(str(journal["stageRoot"]))
        expected_prefix = os.path.abspath(database) + ".media-operation-"
        expected_core = os.path.join(stage_root, "workspace.sqlite3")
        if not stage_root.startswith(expected_prefix) or os.path.abspath(str(journal.get("stageCore") or "")) != expected_core \
                or os.path.abspath(str(journal.get("stageMedia") or "")) != database_path_for_workspace_database(expected_core, "media") \
                or os.path.abspath(str(journal.get("stageVersioning") or "")) != database_path_for_workspace_database(expected_core, "versioning"):
            raise RuntimeError("media operation journal contains unsafe staging paths")
        return journal
    finally:
        db.close()


def _set_media_operation_stage(database: str, journal: dict, state: str):
    updated = {**journal, "state": state, "updatedAt": int(time.time() * 1000)}
    db = sqlite3.connect(database, timeout=30)
    try:
        db.execute("PRAGMA synchronous=FULL")
        db.execute("BEGIN IMMEDIATE")
        db.execute(
            "INSERT OR REPLACE INTO meta(key,value) VALUES('media_operation_journal_v1',?)",
            (json.dumps(updated, ensure_ascii=False, sort_keys=True),),
        )
        db.commit()
    except Exception:
        db.rollback(); raise
    finally:
        db.close()
    return updated


def _deterministic_media_stage_root(database: str, operation_id: str) -> str:
    token = hashlib.sha256(operation_id.encode("utf-8")).hexdigest()[:32]
    return f"{os.path.abspath(database)}.media-operation-{token}"


def _cleanup_committed_media_stage(database: str, operation_id: str, stage_root: str) -> bool:
    expected = _deterministic_media_stage_root(database, operation_id)
    if os.path.abspath(stage_root) != expected:
        raise RuntimeError("refusing unsafe committed media stage cleanup")
    warning_key = f"media_operation_cleanup:{operation_id}"
    try:
        if os.path.exists(expected):
            shutil.rmtree(expected, ignore_errors=False)
    except OSError as error:
        db = sqlite3.connect(database, timeout=30)
        try:
            db.execute(
                "INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)",
                (warning_key, json.dumps({"stageRoot": expected, "error": str(error), "updatedAt": int(time.time() * 1000)}, ensure_ascii=False, sort_keys=True)),
            )
            db.commit()
        finally:
            db.close()
        return False
    db = sqlite3.connect(database, timeout=30)
    try:
        db.execute("DELETE FROM meta WHERE key=?", (warning_key,))
        db.commit()
    finally:
        db.close()
    return True


def _prune_media_operation_receipts(db, now: int | None = None) -> int:
    now = int(now or time.time() * 1000)
    rows = []
    for row in db.execute("SELECT key,value FROM meta WHERE key LIKE 'media_operation_receipt:%'").fetchall():
        try:
            value = json.loads(row[1])
            completed_at = int(value.get("completedAt") or value.get("updatedAt") or 0)
        except (TypeError, ValueError, json.JSONDecodeError):
            # A malformed receipt must fail closed rather than silently losing
            # operationId/digest mismatch protection.
            continue
        if completed_at <= 0:
            completed_at = now
            value = {**value, "completedAt": now, "updatedAt": now}
            db.execute("UPDATE meta SET value=? WHERE key=?", (json.dumps(value, ensure_ascii=False, sort_keys=True), row[0]))
        rows.append((str(row[0]), completed_at))
    rows.sort(key=lambda item: (item[1], item[0]), reverse=True)
    removed = 0
    for index, (key, completed_at) in enumerate(rows):
        expired = completed_at <= 0 or now - completed_at > MEDIA_RECEIPT_RETENTION_MS
        beyond_limit_and_not_recent = index >= MEDIA_RECEIPT_SOFT_LIMIT and now - completed_at > MEDIA_RECEIPT_RECENT_MS
        if expired or beyond_limit_and_not_recent:
            removed += db.execute("DELETE FROM meta WHERE key=?", (key,)).rowcount
    return removed


def _cleanup_snapshot_apply_receipts(db, snapshot_id: str) -> int:
    if not snapshot_id:
        return 0
    legacy_completed_raw = _meta_value(db, _media_sync_marker(snapshot_id, "completed-batches"))
    legacy_completed = json.loads(legacy_completed_raw) if legacy_completed_raw else {}
    removed = 0
    for row in db.execute("SELECT key,value FROM meta WHERE key LIKE 'media_operation_receipt:%'").fetchall():
        try:
            receipt = json.loads(row[1])
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        if str(receipt.get("snapshotId") or "") != snapshot_id:
            continue
        action = str(receipt.get("action") or "")
        if action == "media_sync_apply_batch":
            batch_index = str((receipt.get("result") or {}).get("batchIndex"))
            if batch_index not in legacy_completed:
                continue
        elif action != "media_sync_paths_apply_batch":
            continue
        removed += db.execute("DELETE FROM meta WHERE key=?", (row[0],)).rowcount
    return removed


def _clear_preparing_media_operation(database: str, journal: dict) -> None:
    gc.collect()
    cleanup_error = None
    for attempt in range(5):
        try:
            shutil.rmtree(str(journal["stageRoot"]), ignore_errors=False)
            cleanup_error = None
            break
        except PermissionError as error:
            cleanup_error = error
            if attempt < 4:
                time.sleep(0.05 * (attempt + 1))
    if cleanup_error:
        raise cleanup_error
    db = sqlite3.connect(database, timeout=30)
    try:
        db.execute("PRAGMA synchronous=FULL")
        db.execute("DELETE FROM meta WHERE key='media_operation_journal_v1'")
        db.commit()
    finally:
        db.close()


def _replay_batch_filesystem_journal(database: str, journal: dict) -> dict:
    completed = set(str(value) for value in journal.get("completedBatchOperationIds") or [])
    for operation in journal.get("batchOperations") or []:
        operation_id = str(operation["id"])
        if operation_id in completed:
            continue
        source = canonical_path(operation["sourcePath"])
        target = canonical_path(operation["targetPath"])
        source_exists, target_exists = os.path.exists(source), os.path.exists(target)
        if source_exists and target_exists:
            raise FileExistsError(f"批次改名源和目标同时存在：{source} -> {target}")
        candidate = source if source_exists else target if target_exists else ""
        if candidate:
            stat = os.stat(candidate)
            if int(stat.st_size) != int(operation["sourceSize"]) or full_fingerprint(candidate) != operation["sourceDigest"]:
                raise RuntimeError(f"批次改名文件证据不匹配，拒绝认领：{candidate}")
        if source_exists:
            os.rename(source, target)
        elif not target_exists:
            raise FileNotFoundError(f"批次改名源和目标都不存在：{source} -> {target}")
        completed.add(operation_id)
        journal = _set_media_operation_stage(
            database, {**journal, "completedBatchOperationIds": sorted(completed)}, "filesystem",
        )
    return journal


def _open_published_workspace_database(database: str):
    db = sqlite3.connect(database, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=30000")
    db.execute("ATTACH DATABASE ? AS media", (database_path_for_workspace_database(database, "media"),))
    db.execute("ATTACH DATABASE ? AS versioning", (database_path_for_workspace_database(database, "versioning"),))
    return db


def _finalize_staged_batch_operation(journal: dict) -> dict:
    stage_core = str(journal["stageCore"])
    db = _open_published_workspace_database(stage_core)
    receipt_key = f"media_operation_receipt:{journal['operationId']}"
    row = db.execute("SELECT value FROM main.meta WHERE key=?", (receipt_key,)).fetchone()
    if row is None:
        db.close()
        raise RuntimeError("staged batch durable receipt is missing")
    receipt = json.loads(row[0])
    finalize = receipt.get("batchFinalize")
    if not finalize:
        db.close()
        return {**journal, "result": receipt.get("result") or {"success": True}}
    batch_id = str(finalize.get("batchId") or "")
    if not batch_id:
        db.close()
        raise RuntimeError("batch durable receipt is missing batchId")
    try:
        rename_result = apply_pending_batch_operations(db, batch_id)
        result = {**(receipt.get("result") or {}), **rename_result, "success": not rename_result["repairRequired"]}
        result["batch"] = batch_summary(db, batch_id)
        reference_id = str(finalize.get("referenceBatchId") or "")
        if reference_id:
            result["referenceBatch"] = batch_summary(db, reference_id)
        updated = {**receipt, "result": result, "batchFinalize": None, "updatedAt": int(time.time() * 1000)}
        db.execute(
            "INSERT OR REPLACE INTO main.meta(key,value) VALUES(?,?)",
            (receipt_key, json.dumps(updated, ensure_ascii=False, sort_keys=True)),
        )
        db.commit()
        return {**journal, "result": result, "batchFinalize": None}
    finally:
        db.close()


def _resume_media_operation_files(database: str):
    journal = _read_media_operation_journal(database)
    if not journal: return None
    state = str(journal.get("state") or "preparing")
    if state == "preparing":
        _clear_preparing_media_operation(database, journal)
        return None
    if state not in ("filesystem", "stage_finalize", "ready", "media", "versioning"):
        raise RuntimeError(f"unknown media operation state: {state}")
    stage_core = str(journal["stageCore"])
    stage_media = str(journal["stageMedia"])
    stage_versioning = str(journal["stageVersioning"])
    if state == "filesystem":
        journal = _replay_batch_filesystem_journal(database, journal)
        journal = _set_media_operation_stage(database, journal, "stage_finalize"); state = "stage_finalize"
    if state == "stage_finalize":
        journal = _finalize_staged_batch_operation(journal)
        journal = _set_media_operation_stage(database, journal, "ready"); state = "ready"
    if state == "ready":
        _publish_sqlite_stage(stage_media, database_path_for_workspace_database(database, "media"))
        journal = _set_media_operation_stage(database, journal, "media"); state = "media"
    if state == "media":
        _publish_sqlite_stage(stage_versioning, database_path_for_workspace_database(database, "versioning"))
        journal = _set_media_operation_stage(database, journal, "versioning"); state = "versioning"
    if state == "versioning":
        _publish_sqlite_stage(stage_core, database)
        result = journal.get("result")
        _cleanup_committed_media_stage(database, str(journal["operationId"]), str(journal["stageRoot"]))
        return result
    return None


def _run_durable_media_operation(root: str, database: str, action: str, payload: dict, operation_id: str | None):
    database = os.path.abspath(database)
    digest = _media_operation_digest(action, payload)
    # Server callers supply a stable request operationId so transport retries
    # can claim the same receipt. A direct/CLI invocation is a new business
    # request each time; deriving its ID only from the payload would make two
    # legitimate refreshes with identical arguments return a stale receipt.
    operation_id = str(operation_id or uuid.uuid4())
    if not operation_id or len(operation_id) > 160:
        raise ValueError("media operationId is invalid")
    live = connect(root, database, include_domains=True)
    try:
        receipt_key = f"media_operation_receipt:{operation_id}"
        receipt = _meta_value(live, receipt_key)
        if receipt:
            decoded = json.loads(receipt)
            if decoded.get("payloadDigest") != digest:
                raise ValueError("media operationId payload digest mismatch")
            _cleanup_committed_media_stage(
                database, operation_id, _deterministic_media_stage_root(database, operation_id),
            )
            if decoded.get("error"):
                replay_error = RuntimeError(str(decoded["error"]))
                if decoded.get("errorCode"): replay_error.code = decoded["errorCode"]
                raise replay_error
            return decoded.get("result") or {"success": True}
        stage_root = _deterministic_media_stage_root(database, operation_id)
        stage_core = os.path.join(stage_root, "workspace.sqlite3")
        stage_media = database_path_for_workspace_database(stage_core, "media")
        stage_versioning = database_path_for_workspace_database(stage_core, "versioning")
        if os.path.exists(stage_root):
            shutil.rmtree(stage_root)
        os.makedirs(stage_root, exist_ok=False)
        journal = {
            "version": 1, "operationId": operation_id, "action": action, "payloadDigest": digest,
            "state": "preparing", "stageRoot": stage_root, "stageCore": stage_core,
            "stageMedia": stage_media, "stageVersioning": stage_versioning,
            "createdAt": int(time.time() * 1000), "updatedAt": int(time.time() * 1000), "completedAt": None,
        }
        live.execute("PRAGMA main.synchronous=FULL")
        _set_meta(live, "media_operation_journal_v1", json.dumps(journal, ensure_ascii=False, sort_keys=True))
        live.commit()
        _sqlite_backup_schema(live, "main", stage_core)
        _sqlite_backup_schema(live, "media", stage_media)
        _sqlite_backup_schema(live, "versioning", stage_versioning)
    finally:
        live.close()
    staged_owner = sqlite3.connect(stage_core, timeout=30)
    try:
        staged_owner.row_factory = sqlite3.Row
        staged_owner.execute("DELETE FROM meta WHERE key='media_operation_journal_v1'")
        staged_owner.commit()
    finally:
        staged_owner.close()
    staged_payload = ({**payload, "_executionMode": "staged", "_deferBatchFilesystem": True}
                      if action in BATCH_FILESYSTEM_DURABLE_ACTIONS else payload)
    operation_error = None
    try:
        result = _mutate_impl(root, stage_core, action, staged_payload)
    except Exception as error:
        if action != "batch_commit_compare":
            raise
        # batch_commit_compare deliberately persists a failed batch marker so
        # the retry can reconcile the same importKey. Publish that failure
        # state durably, then surface the original error to this caller.
        operation_error = error
        result = {"success": False, "error": str(error), "code": getattr(error, "code", "")}
    completed_at = int(time.time() * 1000)
    batch_finalize = None
    batch_operations = []
    if action in BATCH_FILESYSTEM_DURABLE_ACTIONS:
        batch_id = str(payload.get("batchId") or (result.get("batch") or {}).get("id") or "")
        reference_batch_id = str((result.get("referenceBatch") or {}).get("id") or "")
        if batch_id and (action == "batch_retry_operations" or payload.get("renameSources")):
            batch_finalize = {"batchId": batch_id, "referenceBatchId": reference_batch_id}
            staged_versioning_db = sqlite3.connect(stage_versioning, timeout=30)
            staged_versioning_db.row_factory = sqlite3.Row
            try:
                batch_operations = []
                for row in staged_versioning_db.execute(
                    """SELECT id,source_path,target_path FROM batch_file_operations
                       WHERE batch_id=? AND status!='succeeded' ORDER BY created_at,id""", (batch_id,),
                ).fetchall():
                    source_path, target_path = str(row["source_path"]), str(row["target_path"])
                    source_exists, target_exists = os.path.isfile(source_path), os.path.isfile(target_path)
                    # Preserve apply_pending_batch_operations' per-item repair
                    # semantics for conflicts/missing files/already-moved
                    # targets. The live FS phase owns only an unambiguous
                    # source-present/target-absent rename.
                    if not source_exists or target_exists:
                        continue
                    evidence_path = source_path
                    evidence_stat = os.stat(evidence_path)
                    batch_operations.append({
                        "id": row["id"], "sourcePath": source_path, "targetPath": target_path,
                        "sourceSize": int(evidence_stat.st_size), "sourceDigest": full_fingerprint(evidence_path),
                    })
            finally:
                staged_versioning_db.close()
    staged_owner = sqlite3.connect(stage_core, timeout=30)
    try:
        staged_owner.row_factory = sqlite3.Row
        staged_owner.execute("PRAGMA synchronous=FULL")
        staged_owner.execute(
            "INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)",
            (f"media_operation_receipt:{operation_id}", json.dumps({
                "operationId": operation_id,
                "action": action, "snapshotId": str(payload.get("snapshotId") or ""),
                "payloadDigest": digest, "result": result, "completedAt": completed_at, "updatedAt": completed_at,
                "batchFinalize": batch_finalize,
                "error": str(operation_error) if operation_error else "",
                "errorCode": getattr(operation_error, "code", "") if operation_error else "",
            }, ensure_ascii=False, sort_keys=True)),
        )
        staged_owner.execute("DELETE FROM meta WHERE key='media_operation_journal_v1'")
        if action in ("media_sync_finalize", "media_sync_paths_finalize"):
            _cleanup_snapshot_apply_receipts(staged_owner, str(payload.get("snapshotId") or ""))
        _prune_media_operation_receipts(staged_owner, completed_at)
        staged_owner.commit()
    finally:
        staged_owner.close()
    journal = {**journal, "result": result, "completedAt": completed_at,
               "batchFinalize": batch_finalize, "batchOperations": batch_operations,
               "completedBatchOperationIds": []}
    initial_state = "filesystem" if batch_operations else "stage_finalize" if batch_finalize else "ready"
    _set_media_operation_stage(database, journal, initial_state)
    published_result = _resume_media_operation_files(database) or result
    if operation_error:
        raise operation_error
    return published_result


def _media_get_fast_path(root: str, database: str, payload: dict):
    db = connect(root, database, include_domains=True)
    try:
        project = project_row(db, payload["projectName"])
        file_path = canonical_path(payload["filePath"])
        version = source_version_row(db, project["id"], file_path)
        if version is None:
            return None
        return {"success": True, **media_bundle(db, version["photo_id"])}
    finally:
        db.close()


def _mutate_impl(root: str, database: str, action: str, payload: dict):
    # Interactive version-tree and confirmation reads must never compete for
    # SQLite's writer slot with media scans or tracking commits.
    run_compatibility_hooks("bind_core", globals())
    domain_actions = set(MEDIA_ACTIONS) | set(PROGRESS_ACTIONS) | set(TRACKING_ACTIONS) | {
        "maintenance_run", "deleted_projects_list", "deleted_project_cleanup_plan",
        "purge_deleted_project", "purge_missing_project",
    }
    needs_compatibility = action in compatibility_action_names() or action in integrated_action_names() or action in {
        "maintenance_run", "purge_deleted_project", "purge_missing_project",
    }
    needs_domains = ("versioning",) if action in VERSIONING_ONLY_ACTIONS else needs_compatibility or action in domain_actions
    db = None
    paged_full_prepare = action == "media_sync_prepare" and payload.get("paged") is True
    if action in READ_ONLY_ACTIONS and not needs_compatibility and not paged_full_prepare:
        read_domains = ("versioning",) if action not in {"media_versions_snapshot", "media_sync_prepare", "media_version_delete_scope"} else ("media", "versioning")
        try:
            candidate = connect_read_only(database, read_domains)
            if _meta_value(candidate, "purge_journal_v1"):
                candidate.close()
                if action in COORDINATED_READ_ONLY_ACTIONS and payload.get("_coordinatorWriteFallback") is not True:
                    raise DatabaseWriteRequired("数据库存在待恢复的清理事务")
            else:
                db = candidate
        except DatabaseWriteRequired:
            if action in COORDINATED_READ_ONLY_ACTIONS and payload.get("_coordinatorWriteFallback") is not True:
                raise
            db = None
    if db is None:
        db = connect(root, database, include_domains=needs_domains, include_compatibility=needs_compatibility)
    def call_and_close(function, *arguments):
        try:
            return function(*arguments)
        finally:
            db.close()
    now = int(time.time() * 1000)
    if action == "catalog_sync":
        try:
            sync_directories(os.path.abspath(root), db)
            return catalog_snapshot(db, database)
        finally:
            db.close()
    if action == "maintenance_run":
        try:
            graph_cleanup = cleanup_media_workflow_graph(root, db, payload.get("importSessionCutoff"))
            cross_domain_cleanup = reconcile_cross_domain_references(db)
            db.commit()
            _check_integrity(db)
            _automatic_backup_if_due(db, database)
            progress_cleanup = cleanup_progress_tombstones(root, db, payload.get("progressTombstoneCutoff"))
            # Cross-store foreign keys are deliberately not used. Reconcile
            # graph edges after tombstone deletion instead of relying on an
            # SQLite cascade that would couple the stores again.
            graph_cleanup_after_progress = cleanup_media_workflow_graph(root, db, payload.get("importSessionCutoff"))
            graph_cleanup["removedEdgeIds"] = list(dict.fromkeys([
                *(graph_cleanup.get("removedEdgeIds") or []),
                *(graph_cleanup_after_progress.get("removedEdgeIds") or []),
            ]))
            graph_cleanup["removedImportSessionCount"] = int(graph_cleanup.get("removedImportSessionCount") or 0) + int(graph_cleanup_after_progress.get("removedImportSessionCount") or 0)
            graph_cleanup["removedImportSlotMappingCount"] = int(graph_cleanup.get("removedImportSlotMappingCount") or 0) + int(graph_cleanup_after_progress.get("removedImportSlotMappingCount") or 0)
            tracking_cleanup = cleanup_tracking_sessions(db, payload.get("trackingSessionCutoff"))
            _check_integrity(db, force=True)
            return {"success": True, "progressTombstones": progress_cleanup, "trackingSessions": tracking_cleanup, "mediaWorkflowGraph": graph_cleanup, "crossDomainReferences": cross_domain_cleanup}
        finally:
            db.close()
    if action == "add":
        if not valid_project_status(payload["status"]):
            raise ValueError("无效的项目状态")
        project_path = os.path.join(os.path.abspath(root), payload["relativePath"])
        retired = db.execute("SELECT id FROM projects WHERE is_deleted=1 AND name=? COLLATE NOCASE", (payload["name"],)).fetchone()
        if retired is not None:
            # Most project creation only needs the catalog. Reusing a retired
            # name also removes detached domain ownership, so reopen with
            # those stores attached only for this conflict path.
            db.close()
            db = connect(root, database, include_compatibility=True)
            retired = db.execute("SELECT id FROM projects WHERE is_deleted=1 AND name=? COLLATE NOCASE", (payload["name"],)).fetchone()
            if retired is not None:
                run_compatibility_hooks("purge_project_rows", db, retired["id"])
                db.execute("DELETE FROM projects WHERE is_deleted=1 AND name=? COLLATE NOCASE", (payload["name"],))
        db.execute(
            "INSERT INTO projects(id,name,status,relative_path,filesystem_id,created_at,updated_at,extra_json) VALUES(?,?,?,?,?,?,?,?)",
            (str(uuid.uuid4()), payload["name"], payload["status"], payload["relativePath"], directory_identity(project_path), now, now, json.dumps(payload.get("extra") or {}, ensure_ascii=False)),
        )
    elif action == "status":
        if not valid_project_status(payload["status"]):
            raise ValueError("无效的项目状态")
        db.execute("UPDATE projects SET status=?, updated_at=? WHERE is_deleted=0 AND name=? COLLATE NOCASE", (payload["status"], now, payload["name"]))
    elif action == "archive_project":
        row = db.execute("SELECT extra_json FROM projects WHERE is_deleted=0 AND name=? COLLATE NOCASE", (payload["name"],)).fetchone()
        if row is None:
            raise ValueError("项目不存在")
        try:
            extra = json.loads(row["extra_json"] or "{}")
        except (TypeError, ValueError, json.JSONDecodeError):
            extra = {}
        extra["archive"] = {
            "path": os.path.abspath(payload["archivePath"]),
            "verifiedAt": int(payload.get("verifiedAt") or now),
            "fileCount": int(payload.get("fileCount") or 0),
            "bytes": int(payload.get("bytes") or 0),
        }
        db.execute(
            "UPDATE projects SET status='已归档',availability='available',missing_since=NULL,missing_checks=0,extra_json=?,updated_at=? WHERE is_deleted=0 AND name=? COLLATE NOCASE",
            (json.dumps(extra, ensure_ascii=False), now, payload["name"]),
        )
    elif action == "unarchive_project":
        status = payload.get("status") or "后期中"
        if not valid_project_status(status) or status in ("未分类", "已归档"):
            raise ValueError("无效的移回状态")
        row = db.execute("SELECT extra_json FROM projects WHERE is_deleted=0 AND name=? COLLATE NOCASE", (payload["name"],)).fetchone()
        if row is None:
            raise ValueError("项目不存在")
        try:
            extra = json.loads(row["extra_json"] or "{}")
        except (TypeError, ValueError, json.JSONDecodeError):
            extra = {}
        extra.pop("archive", None)
        db.execute(
            "UPDATE projects SET status=?,availability='available',missing_since=NULL,missing_checks=0,extra_json=?,updated_at=? WHERE is_deleted=0 AND name=? COLLATE NOCASE",
            (status, json.dumps(extra, ensure_ascii=False), now, payload["name"]),
        )
    elif action == "rename":
        extra_json = None
        if "projectDate" in payload:
            row = db.execute("SELECT extra_json FROM projects WHERE is_deleted=0 AND name=? COLLATE NOCASE", (payload["name"],)).fetchone()
            try:
                extra = json.loads((row["extra_json"] if row else "") or "{}")
            except (TypeError, ValueError, json.JSONDecodeError):
                extra = {}
            if payload.get("projectDate"):
                extra["projectDate"] = payload["projectDate"]
            else:
                extra.pop("projectDate", None)
            extra_json = json.dumps(extra, ensure_ascii=False)
        if extra_json is None:
            db.execute("UPDATE projects SET name=?, relative_path=?, updated_at=? WHERE is_deleted=0 AND name=? COLLATE NOCASE", (payload["nextName"], payload["relativePath"], now, payload["name"]))
        else:
            db.execute("UPDATE projects SET name=?, relative_path=?, extra_json=?, updated_at=? WHERE is_deleted=0 AND name=? COLLATE NOCASE", (payload["nextName"], payload["relativePath"], extra_json, now, payload["name"]))
    elif action == "delete":
        db.execute("UPDATE projects SET is_deleted=1, updated_at=? WHERE name=? COLLATE NOCASE", (now, payload["name"]))
    elif action == "restore_project":
        next_name = payload.get("nextName") or payload["name"]
        relative_path = payload.get("relativePath") or next_name
        filesystem_id = directory_identity(os.path.join(os.path.abspath(root), relative_path))
        db.execute(
            """UPDATE projects SET is_deleted=0,name=?,status=?,relative_path=?,filesystem_id=?,updated_at=?
               WHERE name=? COLLATE NOCASE""",
            (next_name, payload.get("status") or "未分类", relative_path, filesystem_id, now, payload["name"]),
        )
    elif action == "deleted_projects_list":
        result = deleted_projects_list(db, payload)
        db.close()
        return result
    elif action == "deleted_project_cleanup_plan":
        result = deleted_project_cleanup_plan(db, payload)
        db.close()
        return result
    elif action == "purge_deleted_project":
        result = purge_deleted_project(db, payload)
        db.close()
        return result
    elif action == "purge_missing_project":
        result = purge_missing_project(root, db, payload)
        db.close()
        return result
    elif action == "missing_projects_list":
        result = missing_projects_list(db, payload)
        db.close()
        return result
    elif action in MEDIA_DOMAIN_ACTIONS:
        if action in MEDIA_CLOSE_ON_ERROR_ACTIONS:
            return call_and_close(dispatch_media_action, action, root, db, payload)
        result = dispatch_media_action(action, root, db, payload)
        db.close()
        return result
    elif action == "batch_list":
        result = batch_list(root, db, payload)
        db.close()
        return result
    elif action == "progress_list":
        recover_progress_folder_relocations(root, db)
        result = progress_list(root, db, payload)
        db.close()
        return result
    elif action == "progress_snapshot":
        result = progress_snapshot(db, payload)
        db.close()
        return result
    elif action == "progress_locations_snapshot":
        result = progress_locations_snapshot(root, db, payload)
        db.close()
        return result
    elif action == "progress_register":
        result = progress_register(root, db, payload)
        db.close()
        return result
    elif action == "progress_register_with_graph":
        result = progress_register_with_graph(root, db, payload)
        db.close()
        return result
    elif action == "progress_update_tree_begin":
        result = progress_update_tree_begin(db, payload)
        db.close()
        return result
    elif action == "progress_update_tree":
        result = progress_update_tree(root, db, payload)
        db.close()
        return result
    elif action == "progress_update_tree_finish":
        result = progress_update_tree_finish(db, payload)
        db.close()
        return result
    elif action == "progress_folder_rename":
        result = progress_folder_rename(root, db, payload)
        db.close()
        return result
    elif action == "progress_relation_update":
        result = progress_relation_update(db, payload)
        db.close()
        return result
    elif action == "progress_legacy_selection_repair":
        result = progress_legacy_selection_repair(db, payload)
        db.close()
        return result
    elif action == "version_graph_edge_create":
        result = version_graph_edge_create(db, payload)
        db.close()
        return result
    elif action == "version_graph_edge_list":
        result = version_graph_edge_list(db, payload)
        db.close()
        return result
    elif action == "version_graph_edge_delete":
        result = version_graph_edge_delete(db, payload)
        db.close()
        return result
    elif action == "version_graph_edge_replace_source":
        result = version_graph_edge_replace_source(db, payload)
        db.close()
        return result
    elif action == "media_workflow_import_commit":
        result = media_workflow_import_commit(root, db, payload)
        db.close()
        return result
    elif action == "progress_adopt_media":
        result = progress_adopt_media(root, db, payload)
        db.close()
        return result
    elif action == "version_tree_layout_get":
        result = version_tree_layout_get(db, payload)
        db.close()
        return result
    elif action == "version_tree_layout_save":
        result = version_tree_layout_save(db, payload)
        db.close()
        return result
    elif action == "progress_policy_save":
        result = progress_policy_save(db, payload)
        db.close()
        return result
    elif action == "progress_mark_stale":
        result = progress_mark_stale(db, payload)
        db.close()
        return result
    elif action == "progress_mark_ready":
        result = progress_mark_ready(db, payload)
        db.close()
        return result
    elif action == "progress_main_branch":
        result = progress_main_branch(db, payload)
        db.close()
        return result
    elif action == "progress_visible_relations":
        result = progress_visible_relations(db, payload)
        db.close()
        return result
    elif action == "progress_copy_missing_children":
        result = progress_copy_missing_children(db, payload)
        db.close()
        return result
    elif action == "progress_stale_prepare":
        result = progress_stale_prepare(root, db, payload)
        db.close()
        return result
    elif action == "progress_stale_apply":
        result = progress_stale_apply(root, db, payload)
        db.close()
        return result
    elif action == "tracking_session_create":
        result = tracking_session_create(root, db, payload)
        db.close()
        return result
    elif action == "tracking_prepare":
        result = tracking_prepare(root, db, payload)
        db.close()
        return result
    elif action == "tracking_store_preview":
        result = tracking_store_preview(db, payload)
        db.close()
        return result
    elif action == "tracking_session_get":
        result = tracking_session_get(db, payload)
        db.close()
        return result
    elif action == "tracking_session_release":
        result = tracking_session_release(db, payload)
        db.close()
        return result
    elif action == "tracking_session_decide":
        result = tracking_session_decide(root, db, payload)
        db.close()
        return result
    elif action == "tracking_commit_plan":
        result = tracking_commit_plan(root, db, payload)
        db.close()
        return result
    elif action == "tracking_commit_resources":
        result = tracking_commit_resources(root, db, payload)
        db.close()
        return result
    elif action == "tracking_apply_copies":
        result = tracking_apply_copies(root, db, payload)
        db.close()
        return result
    elif action == "tracking_commit_complete":
        result = tracking_commit_complete(root, db, payload)
        db.close()
        return result
    elif action == "tracking_commit_failed":
        result = tracking_commit_failed(db, payload)
        db.close()
        return result
    elif action == "progress_main_branch_media":
        result = progress_main_branch_media(db, payload)
        db.close()
        return result
    elif action == "progress_unregister":
        result = progress_unregister(root, db, payload)
        db.close()
        return result
    elif action == "progress_delete_missing":
        result = progress_delete_missing(root, db, payload)
        db.close()
        return result
    elif action == "batch_register_baseline":
        return call_and_close(batch_register_baseline, root, db, payload)
    elif action == "batch_commit_compare":
        return call_and_close(batch_commit_compare, root, db, payload)
    elif action == "batch_operation_list":
        result = batch_operation_list(db, payload)
        db.close()
        return result
    elif action == "batch_retry_operations":
        return call_and_close(batch_retry_operations, db, payload)
    elif action == "progress_component_manage":
        result = progress_component_manage(root, db, payload)
        db.close()
        return result
    elif action in compatibility_action_names():
        result = dispatch_compatibility_action(action, root, db, payload)
        db.close()
        return result
    elif action == "undo_record_add":
        record_id = str(payload.get("id") or uuid.uuid4())
        cursor = db.execute(
            """INSERT INTO undo_records(id,kind,payload_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET
                 kind=excluded.kind,payload_json=excluded.payload_json,state='ready',
                 created_at=excluded.created_at,updated_at=excluded.updated_at
               WHERE undo_records.state <> 'retired'""",
            (record_id, str(payload.get("kind") or "trash"), json.dumps(payload.get("payload") or {}, ensure_ascii=False), "ready", now, now),
        )
        if cursor.rowcount != 1:
            db.rollback()
            db.close()
            raise UndoRecordRetiredError(f"undo record {record_id} is permanently retired")
        db.commit()
        db.close()
        return {"success": True, "id": record_id}
    elif action == "undo_record_retire_claim":
        record_id = str(payload.get("id") or "")
        if not record_id:
            db.close()
            raise ValueError("undo record id is required")
        try:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                """INSERT INTO undo_records(id,kind,payload_json,state,created_at,updated_at)
                   VALUES(?, 'claim-retired', '{}', 'retired', ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                     kind='claim-retired',payload_json='{}',state='retired',updated_at=excluded.updated_at
                   WHERE undo_records.state IN ('unavailable','retired')""",
                (record_id, now, now),
            )
            row = db.execute("SELECT state FROM undo_records WHERE id=?", (record_id,)).fetchone()
            retired = row is not None and row["state"] == "retired"
            db.commit()
            return {"success": True, "retired": retired}
        except Exception:
            if db.in_transaction: db.rollback()
            raise
        finally:
            db.close()
    elif action == "undo_record_claim_execute":
        record_id = str(payload.get("id") or "")
        claim_token = str(payload.get("claimToken") or "")
        if not record_id:
            db.close()
            raise ValueError("undo record id is required")
        try:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT id,kind,payload_json,state,created_at,updated_at FROM undo_records WHERE id=?", (record_id,)).fetchone()
            claimed = bool(row is not None and row["state"] == "ready" and row["kind"] == "trash"
                           and claim_token and _undo_claim_token(row) == claim_token)
            if claimed:
                db.execute(
                    "UPDATE undo_records SET kind='claim-retired',payload_json='{}',state='retired',updated_at=? WHERE id=?",
                    (now, record_id),
                )
            db.commit()
            return {"success": True, "claimed": claimed}
        except Exception:
            if db.in_transaction: db.rollback()
            raise
        finally:
            db.close()
    elif action == "undo_record_shadow_retire":
        record_id = str(payload.get("id") or "")
        if not record_id:
            db.close()
            raise ValueError("undo record id is required")
        try:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                """INSERT INTO undo_records(id,kind,payload_json,state,created_at,updated_at)
                   VALUES(?, 'claim-retired', '{}', 'retired', ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                     kind='claim-retired',payload_json='{}',state='retired',updated_at=excluded.updated_at""",
                (record_id, now, now),
            )
            db.commit()
            return {"success": True, "retired": True}
        except Exception:
            if db.in_transaction: db.rollback()
            raise
        finally:
            db.close()
    elif action == "undo_record_latest":
        row = db.execute(
            "SELECT * FROM undo_records WHERE state='ready' AND kind='trash' ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
        db.close()
        return {"success": True, "record": _undo_record_response(row)}
    elif action == "undo_record_list":
        kinds = [str(value) for value in payload.get("kinds") or [] if str(value)]
        if kinds:
            placeholders = ",".join("?" for _ in kinds)
            rows = db.execute(
                f"SELECT * FROM undo_records WHERE state <> 'retired' AND kind IN ({placeholders}) ORDER BY created_at DESC",
                kinds,
            ).fetchall()
        else:
            rows = db.execute("SELECT * FROM undo_records WHERE state <> 'retired' ORDER BY created_at DESC").fetchall()
        db.close()
        return {"success": True, "records": [_undo_record_response(row) for row in rows]}
    elif action == "undo_record_remove":
        db.execute("DELETE FROM undo_records WHERE id=? AND state <> 'retired'", (str(payload.get("id") or ""),))
    elif action == "undo_record_remove_many":
        ids = list(dict.fromkeys(str(value) for value in payload.get("ids") or [] if str(value)))
        for offset in range(0, len(ids), 400):
            chunk = ids[offset:offset + 400]
            placeholders = ",".join("?" for _ in chunk)
            db.execute(f"DELETE FROM undo_records WHERE id IN ({placeholders}) AND state <> 'retired'", chunk)
    elif action == "undo_record_mark_unavailable":
        db.execute("UPDATE undo_records SET state='unavailable', updated_at=? WHERE id=? AND state <> 'retired'", (now, str(payload.get("id") or "")))
    else:
        raise ValueError(f"不支持的数据库操作：{action}")
    db.commit()
    if action == "rename":
        try:
            return catalog_snapshot(db, database)
        finally:
            db.close()
    db.close()
    return {"success": True}


def mutate(root: str, database: str, action: str, payload: dict, operation_id: str | None = None):
    if action == "media_get":
        if operation_id and os.path.isfile(database):
            receipt_db = sqlite3.connect(database, timeout=30)
            try:
                receipt = receipt_db.execute("SELECT 1 FROM meta WHERE key=?", (f"media_operation_receipt:{operation_id}",)).fetchone()
            finally:
                receipt_db.close()
            if receipt:
                return _run_durable_media_operation(root, database, action, payload, operation_id)
        existing = _media_get_fast_path(root, database, payload)
        if existing is not None:
            return existing
        return _run_durable_media_operation(root, database, action, payload, operation_id)
    if action in MEDIA_DURABLE_ACTIONS or action in BATCH_CROSS_DOMAIN_DURABLE_ACTIONS:
        return _run_durable_media_operation(root, database, action, payload, operation_id)
    return _mutate_impl(root, database, action, payload)


def run(args_list=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("action", nargs="?", choices=ALL_ACTIONS)
    parser.add_argument("--root")
    parser.add_argument("--database")
    parser.add_argument("--payload", default="{}")
    parser.add_argument("--server", action="store_true")
    args = parser.parse_args(args_list)
    if args.server:
        run_server()
        return
    if not args.action or not args.root or not args.database:
        parser.error("action, --root and --database are required outside server mode")
    result = load(args.root, args.database) if args.action == "init" else mutate(args.root, args.database, args.action, json.loads(args.payload))
    print(json.dumps(result, ensure_ascii=False), flush=True)


def run_server():
    for line in sys.stdin:
        if not line.strip():
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            action = request["action"]
            root = request["root"]
            database = request["database"]
            payload = request.get("payload") or {}
            result = load(root, database) if action == "init" else mutate(root, database, action, payload, request.get("operationId"))
            response = {"id": request_id, "success": True, "result": result}
        except Exception as error:
            response = error_response(request_id, error)
        _emit_server_response(response)


def _emit_server_response(response: dict) -> None:
    encoded = json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    chunk_size = 128 * 1024
    if len(encoded) <= chunk_size:
        print(encoded.decode("utf-8"), flush=True)
        return
    total = math.ceil(len(encoded) / chunk_size)
    for index in range(total):
        chunk = encoded[index * chunk_size:(index + 1) * chunk_size]
        frame = {
            "id": response.get("id"), "protocol": "json-chunk-v1", "index": index,
            "total": total, "data": base64.b64encode(chunk).decode("ascii"),
        }
        print(json.dumps(frame, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    run(sys.argv[1:])
