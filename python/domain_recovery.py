"""Verify, snapshot and restore an independently owned SQLite domain store."""

from __future__ import annotations

import argparse
import errno
import json
import os
import shutil
import sqlite3
import sys
import time
import tempfile
import uuid
from pathlib import Path

from workspace_storage_ownership import DOMAIN_TABLES, STORAGE_OWNERSHIP
from compatibility.registry import run_hooks as run_compatibility_hooks


PATH_COLUMNS = {
    "media": {"photos": ("original_file_path",), "file_records": ("current_path",)},
    "versioning": {
        "versions": ("file_path", "file_path_key", "thumbnail_path"),
        "version_batches": ("source_folder_path", "source_folder_path_key"),
        "progress_folders": ("folder_path", "folder_path_key"),
        "batch_file_operations": ("source_path", "target_path"),
        "batch_items": ("source_path", "source_path_key"),
    },
    "operations": {},
}
PATH_KEY_PAIRS = {
    "media": {},
    "versioning": {
        "versions": {"file_path": "file_path_key"},
        "version_batches": {"source_folder_path": "source_folder_path_key"},
        "progress_folders": {"folder_path": "folder_path_key"},
        "batch_items": {"source_path": "source_path_key"},
    },
    "operations": {},
}
REQUIRED_TABLES = {
    "media": {"meta", "photos"},
    "versioning": {"meta", "versions"},
    "operations": {"meta", "undo_records"},
}
REQUIRED_COLUMNS = {
    "media": {
        "meta": {"key", "value"}, "photos": {"id", "original_file_path"},
        "file_records": {"id", "owner_type", "owner_id", "current_path"},
        "media_incremental_snapshots": {"snapshot_id", "project_id", "state"},
        "media_incremental_snapshot_files": {"snapshot_id", "file_path_key"},
        "media_incremental_snapshot_scopes": {"snapshot_id"},
        "media_incremental_snapshot_baseline": {"snapshot_id", "version_id"},
        "media_incremental_snapshot_batches": {"snapshot_id", "batch_index"},
    },
    "versioning": {
        "meta": {"key", "value"}, "versions": {"id", "photo_id", "file_path", "file_path_key"},
        "version_batches": {"id", "project_id"}, "progress_folders": {"id", "project_id", "folder_path"},
        "batch_file_operations": {"id", "batch_id"}, "batch_items": {"id", "batch_id", "photo_id", "version_id"},
        "version_compare_history": {"id", "photo_id", "left_version_id", "right_version_id"},
        "tracking_sessions": {"id", "project_id"}, "tracking_session_items": {"id", "session_id"},
        "legacy_selection_relation_repairs": {"progress_id", "project_id"},
        "version_tree_layouts": {"project_id", "scope_key"},
        "version_tree_node_positions": {"project_id", "scope_key", "node_key"},
        "version_graph_edges": {"id", "project_id", "source_progress_id", "target_progress_id"},
        "media_import_graph_sessions": {"project_id", "import_session_id"},
        "media_import_artifact_slots": {"project_id", "progress_id", "import_slot"},
        "progress_folder_relocations": {"id", "project_id", "progress_id"},
        "progress_external_link_renames": {"id", "project_id", "progress_id"},
    },
    "operations": {"meta": {"key", "value"}, "undo_records": {"id", "kind", "payload_json", "state"}},
}
LEGACY_REQUIRED_COLUMNS = {
    "media": {
        "meta": {"key", "value"},
        "photos": {"id", "project_id", "media_type", "original_name", "display_name",
                   "original_file_path", "created_at", "updated_at"},
    },
    "versioning": {
        "meta": {"key", "value"},
        "versions": {"id", "photo_id", "version_number", "version_name", "file_path",
                     "file_path_key", "created_at", "updated_at"},
    },
}
SUPPORTED_SCHEMA_VERSIONS = {
    domain: int(STORAGE_OWNERSHIP[domain]["schemaVersion"])
    for domain in ("media", "versioning", "operations")
}
for extension in run_compatibility_hooks("recovery_declaration"):
    PATH_COLUMNS.update(extension.get("pathColumns") or {})


def _connect(path: str, readonly: bool = False) -> sqlite3.Connection:
    absolute = os.path.abspath(path)
    if readonly:
        db = sqlite3.connect(f"{Path(absolute).as_uri()}?mode=ro", uri=True, timeout=30)
    else:
        os.makedirs(os.path.dirname(absolute), exist_ok=True)
        db = sqlite3.connect(absolute, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=30000")
    return db


def _same_file(left: str, right: str) -> bool:
    left_path, right_path = os.path.abspath(left), os.path.abspath(right)
    if os.path.normcase(left_path) == os.path.normcase(right_path):
        return True
    try:
        return os.path.samefile(left_path, right_path)
    except (FileNotFoundError, OSError):
        return False


def _fsync_parent_directory(path: str) -> None:
    parent = os.path.dirname(os.path.abspath(path))
    try:
        descriptor = os.open(parent, os.O_RDONLY)
    except OSError as error:
        if os.name == "nt" and (getattr(error, "winerror", None) in (5, 6, 87)
                                or error.errno in (errno.EACCES, errno.EINVAL, errno.EBADF)):
            return
        raise
    try:
        os.fsync(descriptor)
    except OSError as error:
        if not (os.name == "nt" and (getattr(error, "winerror", None) in (5, 6, 87)
                                     or error.errno in (errno.EACCES, errno.EINVAL, errno.EBADF))):
            raise
    finally:
        os.close(descriptor)


def _durable_replace(source: str, destination: str) -> None:
    descriptor = os.open(source, os.O_RDWR)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(source, destination)
    _fsync_parent_directory(destination)


def verify(path: str, domain: str | None = None) -> dict:
    absolute = os.path.abspath(path)
    if not os.path.isfile(absolute):
        return {"success": False, "state": "missing", "path": absolute}
    try:
        db = _connect(absolute, readonly=True)
        try:
            quick = [row[0] for row in db.execute("PRAGMA quick_check").fetchall()]
            tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()]
            schema = db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone() if "meta" in tables else None
            identity = db.execute("SELECT value FROM meta WHERE key='domain_identity'").fetchone() if "meta" in tables else None
            foreign_keys = db.execute("PRAGMA foreign_key_check").fetchall()
            schema_version = int(schema[0]) if schema else 0
            errors = []
            legacy_compatible = False
            if domain:
                # Identity-bearing schema-1 stores use the complete extracted
                # domain contract. Identity-less stores are accepted as legacy
                # snapshots, but still need their historic anchor tables and
                # key columns so a random SQLite file cannot be restored.
                anchor_tables = set(REQUIRED_TABLES.get(domain, {"meta"}))
                current_tables = anchor_tables | set(DOMAIN_TABLES.get(domain, ()))
                actual_tables = set(tables)
                legacy_columns_valid = True
                for table, required_columns in LEGACY_REQUIRED_COLUMNS.get(domain, {}).items():
                    available = ({row[1] for row in db.execute(f'PRAGMA table_info("{table}")').fetchall()}
                                 if table in actual_tables else set())
                    legacy_columns_valid = legacy_columns_valid and required_columns <= available
                legacy_compatible = bool(
                    domain in DOMAIN_TABLES and identity is None
                    and schema_version == SUPPORTED_SCHEMA_VERSIONS.get(domain)
                    and anchor_tables <= actual_tables and actual_tables <= current_tables
                    and not current_tables <= actual_tables and legacy_columns_valid
                )
                required_tables = anchor_tables if legacy_compatible else current_tables
                missing = required_tables - set(tables)
                if missing:
                    errors.append(f"missing required tables: {sorted(missing)}")
                if identity is not None and identity[0] != domain:
                    errors.append(f"domain identity mismatch: {identity[0]}")
                inferred_conflicts = {
                    "media": {"versions", "undo_records"},
                    "versioning": {"photos", "undo_records"},
                    "operations": {"photos", "versions", "projects"},
                }.get(domain, set()) & set(tables)
                if identity is None and inferred_conflicts:
                    errors.append(f"cannot infer domain identity: {sorted(inferred_conflicts)}")
                if schema_version < 0:
                    errors.append("invalid schema version")
                if schema_version > SUPPORTED_SCHEMA_VERSIONS.get(domain, schema_version):
                    errors.append(f"future schema version: {schema_version}")
                column_contract = LEGACY_REQUIRED_COLUMNS.get(domain, {}) if legacy_compatible else REQUIRED_COLUMNS.get(domain, {})
                for table, required_columns in column_contract.items():
                    if table not in tables or table not in required_tables:
                        continue
                    available = {row[1] for row in db.execute(f'PRAGMA table_info("{table}")').fetchall()}
                    missing_columns = required_columns - available
                    if missing_columns:
                        errors.append(f"missing required columns in {table}: {sorted(missing_columns)}")
            if foreign_keys:
                errors.append(f"foreign key violations: {len(foreign_keys)}")
            success = quick == ["ok"] and not errors
            return {
                "success": success, "state": "legacy-compatible" if success and legacy_compatible else "healthy" if success else "incompatible" if errors else "corrupt",
                "path": absolute, "quickCheck": quick[:10], "schemaVersion": schema_version,
                "domainIdentity": identity[0] if identity else "", "tables": tables, "errors": errors,
                "foreignKeyErrors": len(foreign_keys),
            }
        finally:
            db.close()
    except (OSError, sqlite3.Error, ValueError) as error:
        return {"success": False, "state": "unavailable", "path": absolute, "error": str(error)}


def snapshot(source: str, destination: str, domain: str | None = None) -> dict:
    source_path = os.path.abspath(source)
    destination_path = os.path.abspath(destination)
    if _same_file(source_path, destination_path):
        raise ValueError("domain snapshot source and destination must differ")
    status = verify(source_path, domain)
    if not status["success"]:
        raise RuntimeError(f"domain store is not healthy: {status}")
    source_db = _connect(source_path, readonly=True)
    os.makedirs(os.path.dirname(destination_path), exist_ok=True)
    staged = f"{destination_path}.snapshot-{uuid.uuid4().hex}.tmp"
    target_db = _connect(staged)
    try:
        source_db.backup(target_db)
        target_db.commit()
        target_db.close()
        target_db = None
        result = verify(staged, domain)
        if not result["success"]:
            raise RuntimeError(f"domain snapshot verification failed: {result}")
        _durable_replace(staged, destination_path)
    finally:
        if target_db is not None:
            target_db.close()
        source_db.close()
        for suffix in ("", "-wal", "-shm"):
            try: os.remove(staged + suffix)
            except FileNotFoundError: pass
    return verify(destination_path, domain)


def _normalize_replacements(replacements):
    by_old = {}
    for old_root, new_root in replacements or ():
        if not old_root and not new_root:
            continue
        if not old_root or not new_root:
            raise ValueError("path replacement roots must be provided as a pair")
        if not os.path.isabs(old_root) or not os.path.isabs(new_root):
            raise ValueError("path replacement roots must be absolute")
        pair = (os.path.normpath(old_root), os.path.normpath(new_root))
        old_key = os.path.normcase(pair[0])
        previous = by_old.get(old_key)
        if previous is not None and os.path.normcase(previous[1]) != os.path.normcase(pair[1]):
            raise ValueError(f"conflicting path replacement for {old_root}")
        by_old[old_key] = pair
    normalized = list(by_old.values())
    normalized.sort(key=lambda pair: len(os.path.normcase(pair[0])), reverse=True)
    return normalized


def _replace_path(value, replacements):
    if not value:
        return value
    normalized = os.path.normcase(os.path.normpath(str(value)))
    for old_root, new_root in replacements:
        old = os.path.normcase(os.path.normpath(old_root))
        if normalized == old or normalized.startswith(old + os.sep):
            relative = os.path.relpath(os.path.normpath(str(value)), os.path.normpath(old_root))
            return os.path.normpath(new_root if relative == "." else os.path.join(new_root, relative))
    return value


def _rebase(db: sqlite3.Connection, domain: str, replacements, *, project_id: str | None = None,
            photo_ids=(), version_ids=()) -> None:
    replacements = _normalize_replacements(replacements)
    existing = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    batch_ids = _ids(db, "SELECT id FROM version_batches WHERE project_id=?", (project_id,)) if project_id and "version_batches" in existing else []

    def scope(table, available):
        if not project_id:
            return "", ()
        if "project_id" in available:
            return " WHERE project_id=?", (project_id,)
        mapping = {
            "versions": ("photo_id", list(photo_ids)),
            "batch_items": ("photo_id", list(photo_ids)),
            "file_records": ("owner_id", list(version_ids)),
            "batch_file_operations": ("batch_id", batch_ids),
        }
        column, values = mapping.get(table, ("", []))
        if column and column in available and values:
            return f' WHERE "{column}" IN ({_placeholders(values)})', tuple(values)
        return " WHERE 0", ()

    for table, columns in PATH_COLUMNS.get(domain, {}).items():
        if table not in existing:
            continue
        table_info = db.execute(f'PRAGMA table_info("{table}")').fetchall()
        available = {row[1] for row in table_info}
        key_columns = [row[1] for row in table_info if row[5]]
        if not key_columns:
            continue
        clause, scope_values = scope(table, available)
        rows = db.execute(f'SELECT * FROM "{table}"{clause}', scope_values).fetchall()
        for row in rows:
            pairs = PATH_KEY_PAIRS.get(domain, {}).get(table, {})
            display_columns = [column for column in columns if column not in set(pairs.values())]
            updates = {column: _replace_path(row[column], replacements) for column in display_columns if column in row.keys()}
            for display_column, key_column in pairs.items():
                if display_column in row.keys() and key_column in row.keys():
                    updates[key_column] = str(updates.get(display_column, row[display_column]) or "").casefold()
            updates = {column: value for column, value in updates.items() if value != row[column]}
            if not updates:
                continue
            where = " AND ".join(f'"{column}"=?' for column in key_columns)
            db.execute(
                f'UPDATE "{table}" SET {", ".join(f"\"{column}\"=?" for column in updates)} WHERE {where}',
                (*updates.values(), *(row[column] for column in key_columns)),
            )
    if domain == "media":
        if "photos" in existing and "original_file_id" in _columns(db, "main", "photos"):
            clause, values = scope("photos", set(_columns(db, "main", "photos")))
            db.execute(f"UPDATE photos SET original_file_id=NULL{clause}", values)
        if "file_records" in existing:
            available = set(_columns(db, "main", "file_records"))
            resets = [column for column in ("windows_file_id", "volume_id") if column in available]
            if resets:
                clause, values = scope("file_records", available)
                db.execute(f"UPDATE file_records SET {','.join(f'{column}=NULL' for column in resets)}{clause}", values)
    elif domain == "versioning":
        for table, identity_column in (("versions", "file_id"), ("version_batches", "source_folder_id"),
                                       ("progress_folders", "folder_id"), ("batch_items", "source_file_id")):
            if table in existing and identity_column in _columns(db, "main", table):
                available = set(_columns(db, "main", table))
                clause, values = scope(table, available)
                db.execute(f'UPDATE "{table}" SET "{identity_column}"=NULL{clause}', values)
        for journal in ("progress_folder_relocations", "progress_external_link_renames"):
            if journal in existing:
                clause, values = scope(journal, set(_columns(db, "main", journal)))
                db.execute(f'DELETE FROM "{journal}"{clause}', values)


def _upgrade_identityless_legacy_domain(path: str, domain: str) -> None:
    """Rebuild a validated legacy subset into the current complete schema."""
    if domain not in DOMAIN_TABLES:
        raise RuntimeError(f"no legacy domain migration registry for {domain}")
    source_path = os.path.abspath(path)
    rebuilt = f"{source_path}.legacy-upgrade-{uuid.uuid4().hex}.tmp"
    try:
        import workspace_db
        from workspace_domain_storage import attach_and_migrate, database_path_for_workspace_database
        with tempfile.TemporaryDirectory(prefix="photoflow-domain-legacy-schema-") as temporary:
            root = os.path.join(temporary, "workspace")
            os.makedirs(root, exist_ok=True)
            core = os.path.join(temporary, "workspace-data", "template.sqlite3")
            template = workspace_db.connect(root, core, include_domains=False)
            try:
                attach_and_migrate(template, core)
            finally:
                template.close()
            generated = database_path_for_workspace_database(core, domain)
            snapshot(generated, rebuilt, domain)

        target = _connect(rebuilt)
        try:
            target.execute("PRAGMA foreign_keys=OFF")
            target.execute("ATTACH DATABASE ? AS legacy_domain", (source_path,))
            source_tables = {row[0] for row in target.execute(
                "SELECT name FROM legacy_domain.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()}
            target.execute("BEGIN IMMEDIATE")
            for table in DOMAIN_TABLES[domain]:
                if table not in source_tables:
                    continue
                source_columns = _columns(target, "legacy_domain", table)
                target_columns = _columns(target, "main", table)
                columns = [column for column in source_columns if column in target_columns]
                if not columns:
                    continue
                projection = ",".join(f'"{column}"' for column in columns)
                target.execute(
                    f'INSERT INTO main."{table}"({projection}) SELECT {projection} FROM legacy_domain."{table}"'
                )
            if "meta" in source_tables:
                target.execute(
                    """INSERT OR REPLACE INTO main.meta(key,value)
                       SELECT key,value FROM legacy_domain.meta
                       WHERE key NOT IN ('schema_version','domain_identity')"""
                )
            target.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)", (str(SUPPORTED_SCHEMA_VERSIONS[domain]),))
            target.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('domain_identity',?)", (domain,))
            target.commit()
            target.execute("DETACH DATABASE legacy_domain")
        except Exception:
            if target.in_transaction: target.rollback()
            raise
        finally:
            target.close()
        upgraded = verify(rebuilt, domain)
        if not upgraded["success"] or upgraded["state"] != "healthy":
            raise RuntimeError(f"legacy {domain} migration did not produce a current store: {upgraded}")
        _durable_replace(rebuilt, source_path)
    finally:
        for suffix in ("", "-wal", "-shm"):
            try: os.remove(rebuilt + suffix)
            except FileNotFoundError: pass


def _prepare_staged_domain(path: str, domain: str) -> dict:
    initial = verify(path, domain)
    if initial.get("state") == "legacy-compatible":
        _upgrade_identityless_legacy_domain(path, domain)
        initial = verify(path, domain)
    if initial.get("schemaVersion", 0) < SUPPORTED_SCHEMA_VERSIONS.get(domain, 0):
        if domain == "operations":
            from operations_db import _connect as migrate_operations
            migrated = migrate_operations(path)
        elif domain in DOMAIN_TABLES:
            from workspace_domain_storage import _connect_domain as migrate_domain
            migrated = migrate_domain(path, domain)
        else:
            raise RuntimeError(f"no migration registry for domain {domain}")
        migrated.close()
    db = _connect(path)
    try:
        db.execute("BEGIN IMMEDIATE")
        existing = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        complete_contract = domain == "operations" or (domain in DOMAIN_TABLES and set(DOMAIN_TABLES[domain]) <= existing)
        if complete_contract:
            db.execute("INSERT OR IGNORE INTO meta(key,value) VALUES('domain_identity',?)", (domain,))
        schema = int(db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0])
        supported = SUPPORTED_SCHEMA_VERSIONS.get(domain, schema)
        if schema > supported:
            raise RuntimeError(f"future {domain} schema version {schema}")
        if schema < supported:
            raise RuntimeError(f"{domain} migration registry did not reach schema {supported}")
        foreign_keys = db.execute("PRAGMA foreign_key_check").fetchall()
        if foreign_keys:
            raise RuntimeError(f"{domain} foreign key check failed: {foreign_keys[:10]}")
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
    status = verify(path, domain)
    if not status["success"]:
        raise RuntimeError(f"staged {domain} database is incompatible: {status}")
    return status


def _checkpoint_live_for_publish(path: str) -> None:
    db = _connect(path)
    try:
        checkpoint = db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        if checkpoint and checkpoint[0]:
            raise RuntimeError(f"unable to checkpoint live database: {tuple(checkpoint)}")
        mode = str(db.execute("PRAGMA journal_mode=DELETE").fetchone()[0]).casefold()
        if mode != "delete":
            raise RuntimeError(f"unable to leave WAL mode before publication: {mode}")
    finally:
        db.close()
    remaining = [suffix for suffix in ("-wal", "-shm") if os.path.exists(path + suffix)]
    if remaining:
        raise RuntimeError(f"live database sidecars remain after checkpoint: {remaining}")


def _publish_staged(staged: str, destination: str, domain: str, backup_prefix: str) -> str:
    destination_path = os.path.abspath(destination)
    backup = ""
    if os.path.isfile(destination_path):
        backup = f"{destination_path}.{backup_prefix}.{uuid.uuid4().hex}.bak"
        current = verify(destination_path, domain)
        if current["success"]:
            snapshot(destination_path, backup, domain)
            _checkpoint_live_for_publish(destination_path)
        else:
            shutil.copy2(destination_path, backup)
            sidecars = [suffix for suffix in ("-wal", "-shm") if os.path.exists(destination_path + suffix)]
            if sidecars:
                raise RuntimeError(f"cannot safely publish over unavailable database with sidecars: {sidecars}")
    _durable_replace(staged, destination_path)
    result = verify(destination_path, domain)
    if not result["success"]:
        if backup and verify(backup, domain)["success"]:
            rescue = f"{destination_path}.rollback-{uuid.uuid4().hex}.tmp"
            snapshot(backup, rescue, domain)
            _durable_replace(rescue, destination_path)
        raise RuntimeError(f"published domain store is not healthy: {result}")
    return backup


def _live_retired_records(path: str):
    if not os.path.isfile(path):
        return []
    status = verify(path, "operations")
    if (not status["success"] or not (1 <= int(status.get("schemaVersion") or 0) <= SUPPORTED_SCHEMA_VERSIONS["operations"])
            or status.get("domainIdentity") != "operations"):
        raise RuntimeError(f"live operations retired source failed its schema fence: {status}")
    live = _connect(path, readonly=True)
    try:
        return [tuple(row) for row in live.execute(
            "SELECT id,created_at,updated_at FROM undo_records WHERE state='retired'"
        ).fetchall()]
    finally:
        live.close()


def _core_shadow_retired_records(path: str):
    import workspace_db
    core = _connect(path, readonly=True)
    try:
        if core.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise RuntimeError("core retired shadow failed integrity validation")
        schema = core.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        if schema is None or int(schema[0]) != workspace_db.TARGET_SCHEMA_VERSION:
            raise RuntimeError("core retired shadow schema fence is unavailable")
        columns = {row[1] for row in core.execute("PRAGMA table_info(undo_records)").fetchall()}
        if not {"id", "state", "created_at", "updated_at"} <= columns:
            raise RuntimeError("core retired shadow table is unavailable")
        return [tuple(row) for row in core.execute(
            "SELECT id,created_at,updated_at FROM undo_records WHERE state='retired'"
        ).fetchall()]
    finally:
        core.close()


def _collect_retired_records(destination: str, retired_source: str = ""):
    records = {}
    errors = []
    sources = []
    if os.path.isfile(destination): sources.append(("live operations", destination, _live_retired_records))
    if retired_source and os.path.isfile(retired_source): sources.append(("core shadow", retired_source, _core_shadow_retired_records))
    for label, source, reader in sources:
        try:
            for record_id, created_at, updated_at in reader(source):
                previous = records.get(record_id)
                records[record_id] = (record_id, created_at if previous is None else min(int(previous[1] or created_at or 0), int(created_at or previous[1] or 0)), updated_at if previous is None else max(int(previous[2] or 0), int(updated_at or 0)))
        except Exception as error:
            errors.append(f"{label}: {error}")
    if sources and len(errors) == len(sources):
        raise RuntimeError(f"cannot verify any retired-ID source: {'; '.join(errors)}")
    return list(records.values())


def _merge_retired_records(db: sqlite3.Connection, records) -> None:
    now = int(time.time() * 1000)
    for record_id, created_at, updated_at in records:
        db.execute(
            """INSERT INTO undo_records(id,kind,payload_json,state,created_at,updated_at)
               VALUES(?, 'claim-retired', '{}', 'retired', ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 kind='claim-retired',payload_json='{}',state='retired',updated_at=excluded.updated_at""",
            (record_id, created_at or now, max(int(updated_at or 0), now)),
        )


def restore_workspace(source: str, destination: str, domain: str, replacements, retired_source: str = "") -> dict:
    if domain not in REQUIRED_TABLES:
        raise ValueError(f"unknown domain: {domain}")
    if _same_file(source, destination):
        raise ValueError("domain restore source and destination must differ")
    status = verify(source, domain)
    if not status["success"]:
        raise RuntimeError(f"domain snapshot is not healthy: {status}")
    destination_path = os.path.abspath(destination)
    os.makedirs(os.path.dirname(destination_path), exist_ok=True)
    staged = f"{destination_path}.restore-{uuid.uuid4().hex}.tmp"
    backup = ""
    retired_records = _collect_retired_records(destination_path, retired_source) if domain == "operations" else []
    try:
        snapshot(source, staged, domain)
        db = _connect(staged)
        try:
            db.execute("BEGIN IMMEDIATE")
            _rebase(db, domain, replacements)
            if domain == "operations":
                _merge_retired_records(db, retired_records)
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()
        staged_status = _prepare_staged_domain(staged, domain)
        backup = _publish_staged(staged, destination_path, domain, "before-domain-restore")
    finally:
        for suffix in ("", "-wal", "-shm"):
            try:
                os.remove(staged + suffix)
            except FileNotFoundError:
                pass
    result = verify(destination_path, domain)
    if not result["success"]:
        raise RuntimeError(f"restored domain store is not healthy: {result}")
    return {**result, "backup": backup}


def _columns(db: sqlite3.Connection, schema: str, table: str) -> list[str]:
    return [row[1] for row in db.execute(f'PRAGMA {schema}.table_info("{table}")').fetchall()]


def _copy_filtered(db: sqlite3.Connection, table: str, where: str, values) -> int:
    source_columns = _columns(db, "source_domain", table)
    target_columns = _columns(db, "main", table)
    columns = [column for column in source_columns if column in target_columns]
    if not columns:
        return 0
    projection = ",".join(f'"{column}"' for column in columns)
    return db.execute(
        f'INSERT OR REPLACE INTO main."{table}"({projection}) SELECT {projection} FROM source_domain."{table}" WHERE {where}', values
    ).rowcount


def _ids(db, query: str, values=()) -> list[str]:
    return [str(row[0]) for row in db.execute(query, values).fetchall()]


def _placeholders(values) -> str:
    return ",".join("?" for _ in values) or "NULL"


def _sibling_store(path: str, domain: str) -> str:
    return os.path.join(os.path.dirname(os.path.abspath(path)), f"{domain}.sqlite3")


def _restore_project_in_place(source: str, destination: str, domain: str, project_id: str, peer_source: str = "", replacements=()) -> dict:
    compatibility_supported = any(run_compatibility_hooks("recovery_supports", domain))
    if domain not in ("media", "versioning") and not compatibility_supported:
        raise ValueError("project restore is not supported for this domain")
    db = _connect(destination)
    db.execute("ATTACH DATABASE ? AS source_domain", (os.path.abspath(source),))
    if peer_source:
        db.execute("ATTACH DATABASE ? AS peer_domain", (os.path.abspath(peer_source),))
    sibling_domain = "versioning" if domain == "media" else "media"
    target_peer = _sibling_store(destination, sibling_domain)
    if os.path.isfile(target_peer):
        db.execute("ATTACH DATABASE ? AS target_peer", (target_peer,))
    restored = 0
    try:
        db.execute("BEGIN IMMEDIATE")
        if domain == "media":
            source_photo_ids = _ids(db, "SELECT id FROM source_domain.photos WHERE project_id=?", (project_id,))
            target_photo_ids = _ids(db, "SELECT id FROM photos WHERE project_id=?", (project_id,))
            photo_ids = list(dict.fromkeys((*target_photo_ids, *source_photo_ids)))
            version_ids = []
            if photo_ids and "peer_domain" in {row[1] for row in db.execute("PRAGMA database_list")}:
                version_ids.extend(_ids(db, f"SELECT id FROM peer_domain.versions WHERE photo_id IN ({_placeholders(photo_ids)})", photo_ids))
            if photo_ids and "target_peer" in {row[1] for row in db.execute("PRAGMA database_list")}:
                version_ids.extend(_ids(db, f"SELECT id FROM target_peer.versions WHERE photo_id IN ({_placeholders(photo_ids)})", photo_ids))
            version_ids = list(dict.fromkeys(version_ids))
            source_snapshot_ids = _ids(db, "SELECT snapshot_id FROM source_domain.media_incremental_snapshots WHERE project_id=?", (project_id,)) if _columns(db, "source_domain", "media_incremental_snapshots") else []
            target_snapshot_ids = _ids(db, "SELECT snapshot_id FROM media_incremental_snapshots WHERE project_id=?", (project_id,)) if _columns(db, "main", "media_incremental_snapshots") else []
            snapshot_ids = list(dict.fromkeys((*target_snapshot_ids, *source_snapshot_ids)))
            if snapshot_ids:
                for table in ("media_incremental_snapshot_files", "media_incremental_snapshot_scopes",
                              "media_incremental_snapshot_baseline", "media_incremental_snapshot_batches"):
                    if _columns(db, "main", table):
                        db.execute(f'DELETE FROM "{table}" WHERE snapshot_id IN ({_placeholders(snapshot_ids)})', snapshot_ids)
            db.execute("DELETE FROM photos WHERE project_id=?", (project_id,))
            restored += _copy_filtered(db, "photos", "project_id=?", (project_id,))
            direct_tables = [table for table in DOMAIN_TABLES["media"] if table not in ("photos", "file_records") and "project_id" in _columns(db, "source_domain", table)]
            for table in direct_tables:
                db.execute(f'DELETE FROM "{table}" WHERE project_id=?', (project_id,))
                restored += _copy_filtered(db, table, "project_id=?", (project_id,))
            if source_snapshot_ids:
                for table in ("media_incremental_snapshot_files", "media_incremental_snapshot_scopes",
                              "media_incremental_snapshot_baseline", "media_incremental_snapshot_batches"):
                    if _columns(db, "source_domain", table) and _columns(db, "main", table):
                        restored += _copy_filtered(db, table, f"snapshot_id IN ({_placeholders(source_snapshot_ids)})", source_snapshot_ids)
            if version_ids:
                version_placeholders = _placeholders(version_ids)
                db.execute(f"DELETE FROM file_records WHERE owner_id IN ({version_placeholders})", version_ids)
                restored += _copy_filtered(db, "file_records", f"owner_id IN ({version_placeholders})", version_ids)
            db.execute(
                "INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)",
                (f"project_restore_ids:{project_id}", json.dumps({"photoIds": photo_ids, "versionIds": version_ids}, sort_keys=True)),
            )
        elif domain == "versioning":
            if not peer_source:
                raise ValueError("versioning project restore requires the media snapshot")
            source_photo_ids = _ids(db, "SELECT id FROM peer_domain.photos WHERE project_id=?", (project_id,))
            journal_photo_ids = []
            journal_version_ids = []
            target_peer_photo_ids = []
            if "target_peer" in {row[1] for row in db.execute("PRAGMA database_list")}:
                target_peer_photo_ids = _ids(db, "SELECT id FROM target_peer.photos WHERE project_id=?", (project_id,))
                journal = db.execute("SELECT value FROM target_peer.meta WHERE key=?", (f"project_restore_ids:{project_id}",)).fetchone()
                if journal:
                    payload = json.loads(journal[0])
                    journal_photo_ids = [str(value) for value in payload.get("photoIds") or []]
                    journal_version_ids = [str(value) for value in payload.get("versionIds") or []]
            photo_ids = list(dict.fromkeys((*journal_photo_ids, *target_peer_photo_ids, *source_photo_ids)))
            placeholders = _placeholders(photo_ids)
            target_version_ids = _ids(db, f"SELECT id FROM versions WHERE photo_id IN ({placeholders})", photo_ids) if photo_ids else []
            source_version_ids = _ids(db, f"SELECT id FROM source_domain.versions WHERE photo_id IN ({placeholders})", photo_ids) if photo_ids else []
            version_ids = list(dict.fromkeys((*journal_version_ids, *target_version_ids, *source_version_ids)))
            direct_tables = [table for table in DOMAIN_TABLES["versioning"] if "project_id" in _columns(db, "source_domain", table)]
            target_batch_ids = _ids(db, "SELECT id FROM version_batches WHERE project_id=?", (project_id,))
            source_batch_ids = _ids(db, "SELECT id FROM source_domain.version_batches WHERE project_id=?", (project_id,))
            batch_ids = list(dict.fromkeys((*target_batch_ids, *source_batch_ids)))
            if batch_ids:
                for table in ("batch_file_operations", "batch_items"):
                    db.execute(f'DELETE FROM "{table}" WHERE batch_id IN ({_placeholders(batch_ids)})', batch_ids)
            target_session_ids = _ids(db, "SELECT id FROM tracking_sessions WHERE project_id=?", (project_id,)) if "tracking_sessions" in direct_tables else []
            source_session_ids = _ids(db, "SELECT id FROM source_domain.tracking_sessions WHERE project_id=?", (project_id,)) if "tracking_sessions" in direct_tables else []
            session_ids = list(dict.fromkeys((*target_session_ids, *source_session_ids)))
            if session_ids and "tracking_session_items" in DOMAIN_TABLES["versioning"]:
                db.execute(f"DELETE FROM tracking_session_items WHERE session_id IN ({_placeholders(session_ids)})", session_ids)
            for table in reversed(direct_tables):
                db.execute(f'DELETE FROM "{table}" WHERE project_id=?', (project_id,))
            if photo_ids:
                db.execute(f"DELETE FROM versions WHERE photo_id IN ({placeholders})", photo_ids)
                db.execute(f"DELETE FROM version_compare_history WHERE photo_id IN ({placeholders})", photo_ids)
            for table in direct_tables:
                restored += _copy_filtered(db, table, "project_id=?", (project_id,))
            if photo_ids:
                restored += _copy_filtered(db, "versions", f"photo_id IN ({placeholders})", photo_ids)
                restored += _copy_filtered(db, "version_compare_history", f"photo_id IN ({placeholders})", photo_ids)
            if source_batch_ids:
                for table in ("batch_file_operations", "batch_items"):
                    restored += _copy_filtered(db, table, f"batch_id IN ({_placeholders(source_batch_ids)})", source_batch_ids)
            if source_session_ids:
                restored += _copy_filtered(db, "tracking_session_items", f"session_id IN ({_placeholders(source_session_ids)})", source_session_ids)
        else:
            restored += sum(run_compatibility_hooks("recovery_restore_project", domain, db, project_id, _copy_filtered))
        _rebase(db, domain, replacements, project_id=project_id,
                photo_ids=photo_ids if domain in ("media", "versioning") else (),
                version_ids=version_ids if domain in ("media", "versioning") else ())
        foreign_keys = db.execute("PRAGMA foreign_key_check").fetchall()
        if foreign_keys:
            raise RuntimeError(f"project restore foreign key check failed: {foreign_keys[:10]}")
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
    return {"success": True, "projectId": project_id, "restoredRows": restored}


def restore_project(source: str, destination: str, domain: str, project_id: str, peer_source: str = "", replacements=()) -> dict:
    destination_path = os.path.abspath(destination)
    if _same_file(source, destination_path):
        raise ValueError("project restore source and destination must differ")
    for candidate, candidate_domain in ((source, domain), (destination_path, domain)):
        status = verify(candidate, candidate_domain)
        if not status["success"]:
            raise RuntimeError(f"project restore database is incompatible: {status}")
    if peer_source:
        peer_domain = "versioning" if domain == "media" else "media"
        peer_status = verify(peer_source, peer_domain)
        if not peer_status["success"]:
            raise RuntimeError(f"project restore peer database is incompatible: {peer_status}")
    staged = f"{destination_path}.restore-project-{uuid.uuid4().hex}.tmp"
    try:
        snapshot(destination_path, staged, domain)
        result = _restore_project_in_place(source, staged, domain, project_id, peer_source, replacements)
        staged_status = _prepare_staged_domain(staged, domain)
        backup = _publish_staged(staged, destination_path, domain, "before-project-restore")
        return {**result, "quickCheck": staged_status.get("quickCheck", "ok"), "backup": backup}
    finally:
        for suffix in ("", "-wal", "-shm"):
            try:
                os.remove(staged + suffix)
            except FileNotFoundError:
                pass


def reset_store(destination: str, domain: str, retired_source: str = "") -> dict:
    """Quarantine one store and recreate only its empty owned schema."""
    destination_path = os.path.abspath(destination)
    os.makedirs(os.path.dirname(destination_path), exist_ok=True)
    staged = f"{destination_path}.reset-{uuid.uuid4().hex}.tmp"
    quarantine = ""
    retired_records = _collect_retired_records(destination_path, retired_source) if domain == "operations" else []
    try:
        if domain == "operations":
            from operations_db import _connect as connect_operations
            db = connect_operations(staged)
            try:
                try:
                    db.execute("BEGIN IMMEDIATE")
                    _merge_retired_records(db, retired_records)
                    db.commit()
                except Exception:
                    db.rollback()
                    raise
            finally:
                db.close()
        elif any(run_compatibility_hooks("recovery_reset_store", domain, staged)):
            pass
        elif domain in DOMAIN_TABLES:
            import workspace_db
            from workspace_domain_storage import attach_and_migrate, database_path_for_workspace_database
            with tempfile.TemporaryDirectory(prefix="photoflow-domain-schema-") as temporary:
                root = os.path.join(temporary, "workspace")
                os.makedirs(root, exist_ok=True)
                core = os.path.join(temporary, "workspace-data", "template.sqlite3")
                template = workspace_db.connect(root, core, include_domains=False)
                try:
                    attach_and_migrate(template, core)
                finally:
                    template.close()
                generated = database_path_for_workspace_database(core, domain)
                snapshot(generated, staged, domain)
        else:
            raise ValueError("domain reset is not supported")

        _prepare_staged_domain(staged, domain)
        quarantine = _publish_staged(staged, destination_path, domain, "quarantine")
    finally:
        for suffix in ("", "-wal", "-shm"):
            try:
                os.remove(staged + suffix)
            except FileNotFoundError:
                pass
    result = verify(destination_path, domain)
    if not result["success"]:
        raise RuntimeError(f"replacement domain store is not healthy: {result}")
    return {**result, "quarantine": quarantine, "requiresReindex": domain == "media"}


def sync_retired_shadow(source: str, destination: str) -> dict:
    """Union the final operations retired set into the schema-fenced core shadow."""
    source_path, destination_path = os.path.abspath(source), os.path.abspath(destination)
    source_status = verify(source_path, "operations")
    if (not source_status["success"] or source_status.get("schemaVersion") != SUPPORTED_SCHEMA_VERSIONS["operations"]
            or source_status.get("domainIdentity") != "operations"):
        raise RuntimeError(f"operations retired source is not healthy: {source_status}")
    # This validates the core schema fence and undo table before any write.
    _core_shadow_retired_records(destination_path)
    records = _live_retired_records(source_path)
    core = _connect(destination_path)
    try:
        core.execute("BEGIN IMMEDIATE")
        _merge_retired_records(core, records)
        core.commit()
    except Exception:
        core.rollback()
        raise
    finally:
        core.close()
    return {"success": True, "retired": len(records), "source": source_path, "destination": destination_path}


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("verify", "snapshot", "restore-workspace", "restore-project", "reset", "sync-retired-shadow"))
    parser.add_argument("--domain", required=True, choices=tuple(PATH_COLUMNS))
    parser.add_argument("--source")
    parser.add_argument("--destination", required=True)
    parser.add_argument("--retired-source", default="")
    parser.add_argument("--project-id")
    parser.add_argument("--peer-source", default="")
    parser.add_argument("--old-root", default="")
    parser.add_argument("--new-root", default="")
    parser.add_argument("--old-data-root", default="")
    parser.add_argument("--new-data-root", default="")
    args = parser.parse_args(argv)
    replacements = [(args.old_root, args.new_root), (args.old_data_root, args.new_data_root)]
    if args.action == "verify":
        result = verify(args.destination, args.domain)
    elif args.action == "snapshot":
        result = snapshot(args.source, args.destination, args.domain)
    elif args.action == "restore-workspace":
        result = restore_workspace(args.source, args.destination, args.domain, replacements, args.retired_source)
    elif args.action == "restore-project":
        result = restore_project(args.source, args.destination, args.domain, args.project_id, args.peer_source, replacements)
    elif args.action == "sync-retired-shadow":
        if args.domain != "operations" or not args.source:
            raise ValueError("sync-retired-shadow requires --domain operations and --source")
        result = sync_retired_shadow(args.source, args.destination)
    else:
        result = reset_store(args.destination, args.domain, args.retired_source)
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    main()
