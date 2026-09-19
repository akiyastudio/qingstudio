"""Consistent PhotoFlow database snapshots and restore helpers."""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import uuid
from pathlib import Path

from compatibility.registry import run_hooks as run_compatibility_hooks


PATH_COLUMNS = {
    "photos": ("original_file_path",),
    "versions": ("file_path", "file_path_key", "thumbnail_path"),
    "version_batches": ("source_folder_path", "source_folder_path_key"),
    "progress_folders": ("folder_path", "folder_path_key"),
    "batch_file_operations": ("source_path", "target_path"),
    "batch_items": ("source_path", "source_path_key"),
    "file_records": ("current_path",),
}
PATH_KEY_PAIRS = {
    "versions": {"file_path": "file_path_key"},
    "version_batches": {"source_folder_path": "source_folder_path_key"},
    "progress_folders": {"folder_path": "folder_path_key"},
    "batch_items": {"source_path": "source_path_key"},
}

PROJECT_TABLE_ORDER = (
    "projects",
    "project_properties",
    "project_tags",
    "photos",
    "versions",
    "version_batches",
    "progress_folders",
    "batch_file_operations",
    "batch_items",
    "file_records",
    "version_compare_history",
)
for extension in run_compatibility_hooks("backup_declaration"):
    PATH_COLUMNS.update(extension.get("pathColumns") or {})
    PROJECT_TABLE_ORDER += tuple(extension.get("projectTables") or ())


def connect(path: str, *, readonly: bool = False) -> sqlite3.Connection:
    absolute = os.path.abspath(path)
    if readonly:
        uri = f"{Path(absolute).as_uri()}?mode=ro"
        db = sqlite3.connect(uri, uri=True, timeout=30)
    else:
        os.makedirs(os.path.dirname(absolute), exist_ok=True)
        db = sqlite3.connect(absolute, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=30000")
    db.execute("PRAGMA foreign_keys=ON")
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


def verify_database(path: str, *, maximum_schema_version: int | None = None, allow_foreign_key_errors: bool = False) -> dict:
    absolute = os.path.abspath(path)
    if not os.path.isfile(absolute):
        return {"success": False, "path": absolute, "state": "missing"}
    try:
        db = connect(absolute, readonly=True)
        try:
            quick = [row[0] for row in db.execute("PRAGMA quick_check").fetchall()]
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
            schema = db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone() if "meta" in tables else None
            schema_version = int(schema[0]) if schema else 0
            foreign_keys = db.execute("PRAGMA foreign_key_check").fetchall()
            errors = []
            missing = {"meta", "projects"} - tables
            if missing: errors.append(f"missing required tables: {sorted(missing)}")
            if schema_version <= 0: errors.append("missing schema version")
            if maximum_schema_version is not None and schema_version > maximum_schema_version:
                errors.append(f"future schema version: {schema_version}")
            if foreign_keys and not allow_foreign_key_errors: errors.append(f"foreign key violations: {len(foreign_keys)}")
            required_columns = {
                "meta": {"key", "value"},
                "projects": {"id", "name", "status", "relative_path", "is_deleted", "created_at", "updated_at"},
            }
            if maximum_schema_version is not None and schema_version == maximum_schema_version:
                for required_table in ("project_properties", "project_tags"):
                    if required_table not in tables:
                        errors.append(f"missing required table for current schema: {required_table}")
                required_columns["projects"].update({"availability", "missing_since", "extra_json"})
            for table, columns in required_columns.items():
                if table not in tables:
                    continue
                available = {row[1] for row in db.execute(f'PRAGMA table_info("{table}")').fetchall()}
                absent = columns - available
                if absent:
                    errors.append(f"missing required columns in {table}: {sorted(absent)}")
            success = quick == ["ok"] and not errors
            return {"success": success, "path": absolute, "state": "healthy" if success else "incompatible",
                    "schemaVersion": schema_version, "quickCheck": quick[:10], "errors": errors,
                    "foreignKeyErrors": len(foreign_keys), "tables": sorted(tables)}
        finally:
            db.close()
    except (OSError, sqlite3.Error, ValueError) as error:
        return {"success": False, "path": absolute, "state": "unavailable", "error": str(error)}


def _consistent_copy(source: str, destination: str) -> dict:
    source_path = os.path.abspath(source)
    destination_path = os.path.abspath(destination)
    if _same_file(source_path, destination_path):
        raise ValueError("database copy source and destination must differ")
    status = verify_database(source_path)
    if not status["success"]:
        raise RuntimeError(f"database copy source is incompatible: {status}")
    os.makedirs(os.path.dirname(destination_path), exist_ok=True)
    staged = f"{destination_path}.copy-{uuid.uuid4().hex}.tmp"
    source_db = connect(source_path, readonly=True)
    target_db = connect(staged)
    try:
        source_db.backup(target_db)
        target_db.commit()
        target_db.close(); target_db = None
        copied = verify_database(staged)
        if not copied["success"]:
            raise RuntimeError(f"database copy verification failed: {copied}")
        _durable_replace(staged, destination_path)
        return copied
    finally:
        if target_db is not None: target_db.close()
        source_db.close()
        for suffix in ("", "-wal", "-shm"):
            try: os.remove(staged + suffix)
            except FileNotFoundError: pass


def snapshot(source: str, destination: str, media: str = "") -> dict:
    source_path = os.path.abspath(source)
    destination = os.path.abspath(destination)
    if _same_file(source_path, destination):
        raise ValueError("snapshot source and destination must differ")
    source_status = verify_database(source_path)
    if not source_status["success"]:
        raise RuntimeError(f"数据库源快照不兼容：{source_status}")
    source_db = connect(source_path, readonly=True)
    if media and os.path.isfile(media) and "photos" not in {
        row[0] for row in source_db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    }:
        source_db.execute("ATTACH DATABASE ? AS media", (os.path.abspath(media),))
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    staged = f"{destination}.snapshot-{uuid.uuid4().hex}.tmp"
    target_db = connect(staged)
    try:
        source_db.backup(target_db)
        check = target_db.execute("PRAGMA quick_check").fetchone()[0]
        if check != "ok":
            raise RuntimeError(f"数据库快照完整性检查失败：{check}")
        projects = []
        for row in source_db.execute(
            "SELECT id,name,status,relative_path,extra_json FROM projects WHERE is_deleted=0 ORDER BY name"
        ):
            photo_ids = [item[0] for item in source_db.execute(
                "SELECT id FROM photos WHERE project_id=? AND is_deleted=0", (row["id"],)
            )]
            name_hash = hashlib.sha256(row["name"].encode("utf-8")).hexdigest()
            workflow_hash = hashlib.sha256(f'{row["status"]}\0{row["name"]}'.encode("utf-8")).hexdigest()
            project = {
                "id": row["id"],
                "name": row["name"],
                "status": row["status"],
                "relativePath": row["relative_path"],
                "extra": json.loads(row["extra_json"] or "{}"),
            }
            for extension in run_compatibility_hooks("backup_project_metadata", source_db, row, photo_ids, name_hash, workflow_hash):
                project.update(extension or {})
            projects.append(project)
        schema = target_db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        result = {"success": True, "schemaVersion": int(schema[0] if schema else 0), "projects": projects}
        target_db.close()
        target_db = None
        staged_status = verify_database(staged)
        if not staged_status["success"]:
            raise RuntimeError(f"数据库快照验证失败：{staged_status}")
        _durable_replace(staged, destination)
        return result
    finally:
        if target_db is not None:
            target_db.close()
        source_db.close()
        for suffix in ("", "-wal", "-shm"):
            try: os.remove(staged + suffix)
            except FileNotFoundError: pass


def normalize_replacements(replacements):
    by_old = {}
    for old_root, new_root in replacements or ():
        if not old_root and not new_root:
            continue
        if not old_root or not new_root:
            raise ValueError("路径重定位 old/new root 必须成对提供")
        if not os.path.isabs(old_root) or not os.path.isabs(new_root):
            raise ValueError("路径重定位 root 必须是绝对路径")
        pair = (os.path.normpath(old_root), os.path.normpath(new_root))
        old_key = os.path.normcase(pair[0])
        previous = by_old.get(old_key)
        if previous is not None and os.path.normcase(previous[1]) != os.path.normcase(pair[1]):
            raise ValueError(f"同一路径存在冲突的重定位目标：{old_root}")
        by_old[old_key] = pair
    normalized = list(by_old.values())
    normalized.sort(key=lambda pair: len(os.path.normcase(pair[0])), reverse=True)
    return normalized


def path_replacement(value, replacements):
    if not value:
        return value
    original = str(value)
    normalized = os.path.normcase(os.path.normpath(original))
    for old_root, new_root in replacements:
        old_normalized = os.path.normcase(os.path.normpath(old_root))
        if normalized == old_normalized:
            return os.path.normpath(new_root)
        prefix = old_normalized + os.sep
        if normalized.startswith(prefix):
            relative = os.path.relpath(os.path.normpath(original), os.path.normpath(old_root))
            return os.path.normpath(os.path.join(new_root, relative))
    return original


def rebase_database(db: sqlite3.Connection, replacements):
    replacements = normalize_replacements(replacements)
    existing_tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for table, columns in PATH_COLUMNS.items():
        if table not in existing_tables:
            continue
        available = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
        pairs = PATH_KEY_PAIRS.get(table, {})
        usable = [column for column in columns if column in available and column not in set(pairs.values())]
        if not usable:
            continue
        rows = db.execute(f"SELECT rowid,{','.join(usable)} FROM {table}").fetchall()
        for row in rows:
            updates = {}
            for column in usable:
                if table == "versions" and column == "thumbnail_path":
                    updates[column] = None
                else:
                    updates[column] = path_replacement(row[column], replacements)
            for display_column, key_column in pairs.items():
                if display_column in updates and key_column in available:
                    updates[key_column] = str(updates[display_column] or "").casefold()
            assignments = ",".join(f"{column}=?" for column in updates)
            db.execute(
                f"UPDATE {table} SET {assignments} WHERE rowid=?",
                (*updates.values(), row["rowid"]),
            )
    if "file_records" in existing_tables:
        columns = {row[1] for row in db.execute("PRAGMA table_info(file_records)")}
        reset = [column for column in ("windows_file_id", "volume_id") if column in columns]
        if reset:
            db.execute(f"UPDATE file_records SET {','.join(f'{column}=NULL' for column in reset)}")
    if "versions" in existing_tables:
        db.execute("UPDATE versions SET file_id=NULL")
    if "photos" in existing_tables:
        db.execute("UPDATE photos SET original_file_id=NULL")
    if "version_batches" in existing_tables:
        db.execute("UPDATE version_batches SET source_folder_id=NULL")
    if "progress_folders" in existing_tables:
        db.execute("UPDATE progress_folders SET folder_id=NULL")
    if "batch_items" in existing_tables:
        db.execute("UPDATE batch_items SET source_file_id=NULL")
    for journal in ("progress_folder_relocations", "progress_external_link_renames"):
        if journal in existing_tables:
            db.execute(f"DELETE FROM {journal}")


def clear_materialized_archives(db: sqlite3.Connection, project_ids):
    for project_id in project_ids:
        row = db.execute("SELECT extra_json FROM projects WHERE id=?", (str(project_id),)).fetchone()
        if row is None:
            continue
        try:
            extra = json.loads(row["extra_json"] or "{}")
        except (TypeError, ValueError, json.JSONDecodeError):
            extra = {}
        extra.pop("archive", None)
        db.execute("UPDATE projects SET extra_json=?,availability='available',missing_since=NULL,missing_checks=0 WHERE id=?", (json.dumps(extra, ensure_ascii=False), str(project_id)))


def _upgrade_and_verify_staged(path: str, workspace_root: str) -> dict:
    import workspace_db
    status = verify_database(path, maximum_schema_version=workspace_db.TARGET_SCHEMA_VERSION, allow_foreign_key_errors=True)
    if not status["success"]:
        raise RuntimeError(f"恢复源数据库不兼容：{status}")
    if status["schemaVersion"] < workspace_db.TARGET_SCHEMA_VERSION:
        migrated = workspace_db.connect(workspace_root, path, include_domains=False)
        migrated.close()
    result = verify_database(path, maximum_schema_version=workspace_db.TARGET_SCHEMA_VERSION)
    if not result["success"]:
        raise RuntimeError(f"恢复后的数据库验证失败：{result}")
    return result


def _verify_restore_source(path: str) -> dict:
    import workspace_db
    status = verify_database(path, maximum_schema_version=workspace_db.TARGET_SCHEMA_VERSION, allow_foreign_key_errors=True)
    if not status["success"]:
        raise RuntimeError(f"恢复源数据库不兼容：{status}")
    if status["foreignKeyErrors"] and status["schemaVersion"] >= workspace_db.TARGET_SCHEMA_VERSION:
        raise RuntimeError(f"当前版本恢复源包含外键错误：{status}")
    return status


def _checkpoint_live(path: str) -> None:
    db = connect(path)
    try:
        checkpoint = db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        if checkpoint and checkpoint[0]:
            raise RuntimeError(f"live database checkpoint failed: {tuple(checkpoint)}")
        mode = str(db.execute("PRAGMA journal_mode=DELETE").fetchone()[0]).casefold()
        if mode != "delete":
            raise RuntimeError(f"unable to leave WAL mode before publication: {mode}")
    finally:
        db.close()
    remaining = [suffix for suffix in ("-wal", "-shm") if os.path.exists(path + suffix)]
    if remaining:
        raise RuntimeError(f"live database sidecars remain after checkpoint: {remaining}")


def _publish_staged(staged: str, destination: str, workspace_root: str, backup_prefix: str) -> str:
    backup = ""
    if os.path.isfile(destination):
        import workspace_db
        current = verify_database(destination, maximum_schema_version=workspace_db.TARGET_SCHEMA_VERSION)
        if not current["success"]:
            raise RuntimeError(f"拒绝覆盖不可验证的 live 数据库：{current}")
        backup = f"{destination}.{backup_prefix}.{uuid.uuid4().hex}.bak"
        _consistent_copy(destination, backup)
        _checkpoint_live(destination)
    _durable_replace(staged, destination)
    try:
        _upgrade_and_verify_staged(destination, workspace_root)
    except Exception:
        if backup:
            rescue = f"{destination}.rollback-{uuid.uuid4().hex}.tmp"
            _consistent_copy(backup, rescue)
            _durable_replace(rescue, destination)
        raise
    return backup


def restore_workspace(source: str, destination: str, old_root: str, new_root: str,
                      old_data_root: str = "", new_data_root: str = "", materialized_archive_project_ids=None) -> dict:
    source_path = os.path.abspath(source)
    destination = os.path.abspath(destination)
    if _same_file(source_path, destination):
        raise ValueError("restore source and destination must differ")
    source_status = _verify_restore_source(source_path)
    source_db = connect(source_path, readonly=True)
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    if os.path.exists(destination):
        raise RuntimeError("目标工作区数据库已存在")
    staged = f"{destination}.restore-{uuid.uuid4().hex}.tmp"
    target_db = connect(staged)
    try:
        source_db.backup(target_db)
        target_db.commit()
        target_db.close()
        target_db = None
        _upgrade_and_verify_staged(staged, os.path.abspath(new_root))
        target_db = connect(staged)
        replacements = [(old_root, new_root)]
        if old_data_root and new_data_root:
            replacements.insert(0, (old_data_root, new_data_root))
        rebase_database(target_db, replacements)
        clear_materialized_archives(target_db, materialized_archive_project_ids or [])
        target_db.execute(
            "INSERT INTO meta(key,value) VALUES('workspace_root',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (os.path.abspath(new_root),),
        )
        target_db.commit()
        target_db.close()
        target_db = None
        backup = _publish_staged(staged, destination, os.path.abspath(new_root), "before-workspace-restore")
        return {"success": True, "backup": backup}
    finally:
        if target_db is not None:
            target_db.close()
        source_db.close()
        for suffix in ("", "-wal", "-shm"):
            try:
                os.remove(staged + suffix)
            except FileNotFoundError:
                pass


def table_columns(db: sqlite3.Connection, table: str):
    if "." in table:
        schema, name = table.split(".", 1)
        return [row[1] for row in db.execute(f"PRAGMA {schema}.table_info({name})")]
    return [row[1] for row in db.execute(f"PRAGMA table_info({table})")]


def restore_project(source: str, destination: str, project_id: str, old_root: str, new_root: str,
                    target_relative_path: str, old_data_root: str = "", new_data_root: str = "", materialized_archive_project_ids=None) -> dict:
    source_path = os.path.abspath(source)
    destination = os.path.abspath(destination)
    if _same_file(source_path, destination):
        raise ValueError("project restore source and destination must differ")
    _verify_restore_source(source_path)
    import workspace_db
    destination_status = verify_database(destination, maximum_schema_version=workspace_db.TARGET_SCHEMA_VERSION)
    if not destination_status["success"]:
        raise RuntimeError(f"项目恢复目标数据库不兼容：{destination_status}")
    staged_target = f"{destination}.restore-project-{uuid.uuid4().hex}.tmp"
    try:
        _consistent_copy(destination, staged_target)
        _upgrade_and_verify_staged(staged_target, os.path.abspath(new_root))
    except Exception:
        for suffix in ("", "-wal", "-shm"):
            try: os.remove(staged_target + suffix)
            except FileNotFoundError: pass
        raise
    target_db = connect(staged_target)
    source_db = connect(source_path, readonly=True)
    temporary = f"{destination}.project-import-{uuid.uuid4().hex}.sqlite3"
    temporary_db = None
    try:
        project = source_db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if project is None:
            raise RuntimeError("备份中找不到项目记录")
        name_conflict = target_db.execute(
            "SELECT id FROM projects WHERE name=? COLLATE NOCASE AND id<>?", (project["name"], project_id)
        ).fetchone()
        if name_conflict:
            raise RuntimeError("当前工作区已有同名项目")
        temporary_db = connect(temporary)
        source_db.backup(temporary_db)
        temporary_db.commit()
        temporary_db.close()
        temporary_db = None
        _upgrade_and_verify_staged(temporary, os.path.abspath(new_root))
        temporary_db = connect(temporary)
        replacements = [(old_root, new_root)]
        if old_data_root and new_data_root:
            replacements.insert(0, (old_data_root, new_data_root))
        rebase_database(temporary_db, replacements)
        clear_materialized_archives(temporary_db, materialized_archive_project_ids or [])
        temporary_db.execute(
            "UPDATE projects SET relative_path=?,availability='available',missing_since=NULL,missing_checks=0,is_deleted=0 WHERE id=?",
            (target_relative_path, project_id),
        )
        temporary_db.commit()
        temporary_tables = {row[0] for row in temporary_db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        source_photo_ids = [row[0] for row in temporary_db.execute("SELECT id FROM photos WHERE project_id=?", (project_id,)).fetchall()] if "photos" in temporary_tables else []
        source_version_ids = [row[0] for row in temporary_db.execute(
            f"SELECT id FROM versions WHERE photo_id IN ({','.join('?' for _ in source_photo_ids) or 'NULL'})", source_photo_ids
        ).fetchall()] if "versions" in temporary_tables else []
        source_batch_ids = [row[0] for row in temporary_db.execute("SELECT id FROM version_batches WHERE project_id=?", (project_id,)).fetchall()] if "version_batches" in temporary_tables else []
        temporary_db.close()
        temporary_db = None

        target_db.execute("BEGIN IMMEDIATE")
        target_tables = {row[0] for row in target_db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        target_photo_ids = [row[0] for row in target_db.execute("SELECT id FROM photos WHERE project_id=?", (project_id,)).fetchall()] if "photos" in target_tables else []
        photo_ids = list(dict.fromkeys((*target_photo_ids, *source_photo_ids)))
        if table_columns(target_db, "version_batches"):
            target_batch_ids = [row[0] for row in target_db.execute("SELECT id FROM version_batches WHERE project_id=?", (project_id,)).fetchall()]
            batch_ids = list(dict.fromkeys((*target_batch_ids, *source_batch_ids)))
            if batch_ids:
                batch_placeholders = ",".join("?" for _ in batch_ids)
                for table in ("batch_file_operations", "batch_items"):
                    if table_columns(target_db, table):
                        target_db.execute(f"DELETE FROM {table} WHERE batch_id IN ({batch_placeholders})", batch_ids)
            target_db.execute("DELETE FROM version_batches WHERE project_id=?", (project_id,))
        if photo_ids and table_columns(target_db, "versions"):
            placeholders = ",".join("?" for _ in photo_ids)
            target_version_ids = [row[0] for row in target_db.execute(f"SELECT id FROM versions WHERE photo_id IN ({placeholders})", photo_ids).fetchall()]
            version_ids = list(dict.fromkeys((*target_version_ids, *source_version_ids)))
            if version_ids and table_columns(target_db, "file_records"):
                version_placeholders = ",".join("?" for _ in version_ids)
                target_db.execute(f"DELETE FROM file_records WHERE owner_id IN ({version_placeholders})", version_ids)
            if table_columns(target_db, "version_compare_history"):
                target_db.execute(f"DELETE FROM version_compare_history WHERE photo_id IN ({placeholders})", photo_ids)
            target_db.execute(f"DELETE FROM versions WHERE photo_id IN ({placeholders})", photo_ids)
            target_db.execute(f"DELETE FROM photos WHERE id IN ({placeholders})", photo_ids)
        target_db.execute("DELETE FROM projects WHERE id=?", (project_id,))
        target_db.execute("ATTACH DATABASE ? AS portable", (temporary,))
        try:
            for table in PROJECT_TABLE_ORDER:
                target_columns = table_columns(target_db, table)
                portable_columns = table_columns(target_db, f"portable.{table}")
                columns = [column for column in target_columns if column in portable_columns]
                if not columns:
                    continue
                column_list = ",".join(columns)
                if table == "projects":
                    target_db.execute(
                        f"INSERT INTO {table}({column_list}) SELECT {column_list} FROM portable.{table} WHERE id=?",
                        (project_id,),
                    )
                elif "project_id" in columns:
                    target_db.execute(
                        f"INSERT INTO {table}({column_list}) SELECT {column_list} FROM portable.{table} WHERE project_id=?",
                        (project_id,),
                    )
                elif table == "versions":
                    target_db.execute(
                        f"INSERT INTO versions({column_list}) SELECT {column_list} FROM portable.versions WHERE photo_id IN (SELECT id FROM portable.photos WHERE project_id=?)",
                        (project_id,),
                    )
                elif table in ("batch_file_operations", "batch_items"):
                    target_db.execute(
                        f"INSERT INTO {table}({column_list}) SELECT {column_list} FROM portable.{table} WHERE batch_id IN (SELECT id FROM portable.version_batches WHERE project_id=?)",
                        (project_id,),
                    )
                elif table == "file_records":
                    target_db.execute(
                        f"INSERT INTO file_records({column_list}) SELECT {column_list} FROM portable.file_records WHERE owner_id IN (SELECT v.id FROM portable.versions v JOIN portable.photos p ON p.id=v.photo_id WHERE p.project_id=?)",
                        (project_id,),
                    )
                elif table == "version_compare_history":
                    target_db.execute(
                        f"INSERT INTO version_compare_history({column_list}) SELECT {column_list} FROM portable.version_compare_history WHERE photo_id IN (SELECT id FROM portable.photos WHERE project_id=?)",
                        (project_id,),
                    )
                elif any(run_compatibility_hooks("backup_restore_project_table", target_db, table, column_list, project_id)):
                    pass
            target_db.commit()
            target_db.execute("DETACH DATABASE portable")
        except Exception:
            target_db.rollback()
            raise
        target_db.close()
        target_db = None
        _upgrade_and_verify_staged(staged_target, os.path.abspath(new_root))
        backup = _publish_staged(staged_target, destination, os.path.abspath(new_root), "before-project-restore")
        return {"success": True, "projectId": project_id, "name": project["name"], "backup": backup}
    finally:
        if target_db is not None:
            target_db.close()
        if temporary_db is not None:
            temporary_db.close()
        source_db.close()
        try:
            os.remove(temporary)
        except FileNotFoundError:
            pass
        for suffix in ("", "-wal", "-shm"):
            try:
                os.remove(staged_target + suffix)
            except FileNotFoundError:
                pass


def main(argv=None):
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    snapshot_parser = subparsers.add_parser("snapshot")
    snapshot_parser.add_argument("--source", required=True)
    snapshot_parser.add_argument("--destination", required=True)
    snapshot_parser.add_argument("--media", default="")
    workspace_parser = subparsers.add_parser("restore-workspace")
    workspace_parser.add_argument("--source", required=True)
    workspace_parser.add_argument("--destination", required=True)
    workspace_parser.add_argument("--old-root", required=True)
    workspace_parser.add_argument("--new-root", required=True)
    workspace_parser.add_argument("--old-data-root", default="")
    workspace_parser.add_argument("--new-data-root", default="")
    workspace_parser.add_argument("--materialized-archive-project-ids", default="[]")
    project_parser = subparsers.add_parser("restore-project")
    project_parser.add_argument("--source", required=True)
    project_parser.add_argument("--destination", required=True)
    project_parser.add_argument("--project-id", required=True)
    project_parser.add_argument("--old-root", required=True)
    project_parser.add_argument("--new-root", required=True)
    project_parser.add_argument("--target-relative-path", required=True)
    project_parser.add_argument("--old-data-root", default="")
    project_parser.add_argument("--new-data-root", default="")
    project_parser.add_argument("--materialized-archive-project-ids", default="[]")
    args = parser.parse_args(argv)
    if args.command == "snapshot":
        result = snapshot(args.source, args.destination, args.media)
    elif args.command == "restore-workspace":
        result = restore_workspace(args.source, args.destination, args.old_root, args.new_root, args.old_data_root, args.new_data_root, json.loads(args.materialized_archive_project_ids))
    else:
        result = restore_project(args.source, args.destination, args.project_id, args.old_root, args.new_root, args.target_relative_path, args.old_data_root, args.new_data_root, json.loads(args.materialized_archive_project_ids))
    print(json.dumps(result, ensure_ascii=False))


def run(argv=None):
    main(argv)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    main()
