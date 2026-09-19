"""File-operations journal database with one-time legacy undo import."""

import argparse
import base64
import errno
import hashlib
import json
import os
import sqlite3
import sys
import time
import uuid
from pathlib import Path

try:
    from database_error_codes import error_response
except ModuleNotFoundError:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from database_error_codes import error_response


SCHEMA_VERSION = 2
UNDO_ACTIONS = (
    "undo_record_add",
    "undo_record_retire_claim",
    "undo_record_claim_execute",
    "undo_record_latest",
    "undo_record_list",
    "undo_record_remove",
    "undo_record_remove_many",
    "undo_record_mark_unavailable",
)
ALL_ACTIONS = ("init", *UNDO_ACTIONS)
_READY_CACHE = {}


class UndoRecordRetiredError(RuntimeError):
    code = "UNDO_RECORD_RETIRED"


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


def _file_identity(path: str):
    try:
        stat = os.stat(path)
        return (int(stat.st_dev), int(stat.st_ino))
    except OSError:
        return None


def _migration_0_to_1(db):
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    if {"photos", "versions", "projects"} & tables:
        raise RuntimeError("cannot migrate a non-operations database")
    if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        raise RuntimeError("operations schema-0 database failed integrity validation")
    db.execute(
        """CREATE TABLE IF NOT EXISTS undo_records (
             id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload_json TEXT NOT NULL,
             state TEXT NOT NULL DEFAULT 'ready',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
           )"""
    )
    db.execute("CREATE INDEX IF NOT EXISTS undo_records_ready ON undo_records(state,created_at DESC)")
    db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('domain_identity','operations')")


def _migration_1_to_2(db):
    """Fence the permanent retired-ID and version-bound execution semantics."""
    columns = {row[1] for row in db.execute("PRAGMA table_info(undo_records)").fetchall()}
    if not {"id", "kind", "payload_json", "state", "created_at", "updated_at"} <= columns:
        raise RuntimeError("operations schema-1 undo_records contract is incomplete")


MIGRATIONS = {0: _migration_0_to_1, 1: _migration_1_to_2}


def _connect(database: str) -> sqlite3.Connection:
    absolute = os.path.abspath(database)
    os.makedirs(os.path.dirname(absolute), exist_ok=True)
    db = sqlite3.connect(absolute, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=30000")
    if str(db.execute("PRAGMA journal_mode").fetchone()[0]).casefold() != "wal":
        db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=FULL")
    try:
        identity_before = _file_identity(absolute)
        if identity_before is not None and _READY_CACHE.get(absolute) == identity_before:
            cached_schema = db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
            cached_domain = db.execute("SELECT value FROM meta WHERE key='domain_identity'").fetchone()
            if cached_schema and int(cached_schema[0]) == SCHEMA_VERSION and cached_domain and cached_domain[0] == "operations":
                return db
            _READY_CACHE.pop(absolute, None)
        db.execute("BEGIN IMMEDIATE")
        db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)")
        schema = db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        schema_version = int(schema[0]) if schema else 0
        if schema_version > SCHEMA_VERSION:
            raise RuntimeError(
                f"operations database schema {schema_version} is newer than supported {SCHEMA_VERSION}"
            )
        identity = db.execute("SELECT value FROM meta WHERE key='domain_identity'").fetchone()
        if identity is not None and identity[0] != "operations":
            raise RuntimeError(f"operations database identity mismatch: {identity[0]}")
        while schema_version < SCHEMA_VERSION:
            migration = MIGRATIONS.get(schema_version)
            if migration is None:
                raise RuntimeError(f"missing operations migration {schema_version}->{schema_version + 1}")
            migration(db)
            schema_version += 1
            db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)", (str(schema_version),))
        if identity is None and schema_version == SCHEMA_VERSION:
            db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('domain_identity','operations')")
        required = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        if not {"meta", "undo_records"} <= required:
            raise RuntimeError("operations migration did not create required tables")
        db.commit()
        _READY_CACHE[absolute] = _file_identity(absolute)
        return db
    except Exception:
        db.rollback()
        db.close()
        raise


def _import_legacy(db: sqlite3.Connection, legacy_database: str) -> int:
    completed = db.execute(
        "SELECT value FROM meta WHERE key='legacy_undo_import_completed'"
    ).fetchone()
    if completed is not None:
        return 0
    legacy = os.path.abspath(str(legacy_database or "")) if legacy_database else ""
    if not legacy or legacy == os.path.abspath(db.execute("PRAGMA database_list").fetchone()[2]) or not os.path.isfile(legacy):
        return 0
    source = sqlite3.connect(f"{Path(legacy).as_uri()}?mode=ro", uri=True, timeout=30)
    source.row_factory = sqlite3.Row
    try:
        table = source.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='undo_records'"
        ).fetchone()
        if table is None:
            return 0
        rows = source.execute(
            "SELECT id,kind,payload_json,state,created_at,updated_at FROM undo_records"
        ).fetchall()
        db.execute("BEGIN IMMEDIATE")
        try:
            imported = 0
            for row in rows:
                current = db.execute(
                    "SELECT id,kind,payload_json,state,created_at,updated_at FROM undo_records WHERE id=?",
                    (row["id"],),
                ).fetchone()
                if current is not None:
                    if current["state"] == "retired":
                        continue
                    if tuple(current) != tuple(row):
                        raise RuntimeError(f"legacy undo import conflicts for record {row['id']}")
                    continue
                db.execute(
                    "INSERT INTO undo_records(id,kind,payload_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                    tuple(row),
                )
                imported += 1
            db.execute(
                "INSERT INTO meta(key,value) VALUES('legacy_undo_import_completed',?)",
                (str(int(time.time() * 1000)),),
            )
            db.commit()
            return imported
        except Exception:
            db.rollback()
            raise
    finally:
        source.close()


def _drain_legacy_outbox(db: sqlite3.Connection, legacy_database: str) -> int:
    legacy = os.path.abspath(str(legacy_database or "")) if legacy_database else ""
    if not legacy or not os.path.isfile(legacy):
        return 0
    source = sqlite3.connect(legacy, timeout=30)
    source.row_factory = sqlite3.Row
    source.execute("PRAGMA busy_timeout=30000")
    try:
        if source.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").fetchone() is None:
            return 0
        row = source.execute("SELECT value FROM meta WHERE key='operations_outbox_v1'").fetchone()
        if row is None:
            return 0
        try:
            payload = json.loads(row[0])
            ids = list(dict.fromkeys(str(value) for value in payload.get("removeUndoIds") or [] if str(value)))
        except (TypeError, ValueError, json.JSONDecodeError) as error:
            raise RuntimeError("operations outbox is malformed") from error
        db.execute("BEGIN IMMEDIATE")
        try:
            if ids:
                for offset in range(0, len(ids), 400):
                    chunk = ids[offset:offset + 400]
                    placeholders = ",".join("?" for _ in chunk)
                    db.execute(f"DELETE FROM undo_records WHERE id IN ({placeholders}) AND state <> 'retired'", chunk)
            db.commit()
        except Exception:
            db.rollback()
            raise
        source.execute("BEGIN IMMEDIATE")
        try:
            source.execute("DELETE FROM meta WHERE key='operations_outbox_v1'")
            source.commit()
        except Exception:
            source.rollback()
            raise
        return len(ids)
    finally:
        source.close()


def _record(row):
    if row is None:
        return None
    result = dict(row)
    result["claimToken"] = _claim_token(row)
    try:
        result["payload"] = json.loads(result.pop("payload_json"))
    except (TypeError, ValueError, json.JSONDecodeError):
        result["payload"] = {}
        result.pop("payload_json", None)
    return result


def _claim_token(row) -> str:
    fields = [row[key] for key in ("id", "kind", "payload_json", "state", "created_at", "updated_at")]
    encoded = json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def execute(database: str, action: str, payload: dict):
    db = _connect(database)
    try:
        imported = _import_legacy(db, payload.get("legacyDatabase"))
        recovered = _drain_legacy_outbox(db, payload.get("legacyDatabase"))
        now = int(time.time() * 1000)
        if action == "init":
            check = db.execute("PRAGMA quick_check").fetchone()[0]
            if check != "ok":
                raise RuntimeError(f"operations 数据库完整性检查失败：{check}")
            count = db.execute("SELECT COUNT(*) FROM undo_records").fetchone()[0]
            return {"success": True, "database": os.path.abspath(database), "schemaVersion": SCHEMA_VERSION, "records": count, "imported": imported, "recovered": recovered}
        if action == "undo_record_add":
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
                raise UndoRecordRetiredError(f"undo record {record_id} is permanently retired")
            db.commit()
            return {"success": True, "id": record_id}
        if action == "undo_record_retire_claim":
            record_id = str(payload.get("id") or "")
            if not record_id:
                raise ValueError("undo record id is required")
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
        if action == "undo_record_claim_execute":
            record_id = str(payload.get("id") or "")
            claim_token = str(payload.get("claimToken") or "")
            if not record_id:
                raise ValueError("undo record id is required")
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT id,kind,payload_json,state,created_at,updated_at FROM undo_records WHERE id=?", (record_id,)).fetchone()
            claimed = bool(row is not None and row["state"] == "ready" and row["kind"] == "trash"
                           and claim_token and _claim_token(row) == claim_token)
            if claimed:
                db.execute(
                    "UPDATE undo_records SET kind='claim-retired',payload_json='{}',state='retired',updated_at=? WHERE id=?",
                    (now, record_id),
                )
            db.commit()
            return {"success": True, "claimed": claimed}
        if action == "undo_record_latest":
            row = db.execute(
                "SELECT * FROM undo_records WHERE state='ready' AND kind='trash' ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
            return {"success": True, "record": _record(row)}
        if action == "undo_record_list":
            kinds = [str(value) for value in payload.get("kinds") or [] if str(value)]
            if not kinds:
                rows = db.execute("SELECT * FROM undo_records WHERE state <> 'retired' ORDER BY created_at DESC").fetchall()
            else:
                placeholders = ",".join("?" for _ in kinds)
                rows = db.execute(
                    f"SELECT * FROM undo_records WHERE state <> 'retired' AND kind IN ({placeholders}) ORDER BY created_at DESC", kinds
                ).fetchall()
            return {"success": True, "records": [_record(row) for row in rows]}
        if action == "undo_record_remove":
            ids = [str(payload.get("id") or "")]
        elif action == "undo_record_remove_many":
            ids = list(dict.fromkeys(str(value) for value in payload.get("ids") or [] if str(value)))
        elif action == "undo_record_mark_unavailable":
            db.execute(
                "UPDATE undo_records SET state='unavailable',updated_at=? WHERE id=? AND state <> 'retired'",
                (now, str(payload.get("id") or "")),
            )
            db.commit()
            return {"success": True}
        else:
            raise ValueError(f"不支持的 operations 数据库操作：{action}")
        if ids:
            for offset in range(0, len(ids), 400):
                chunk = ids[offset:offset + 400]
                placeholders = ",".join("?" for _ in chunk)
                db.execute(f"DELETE FROM undo_records WHERE id IN ({placeholders}) AND state <> 'retired'", chunk)
        db.commit()
        return {"success": True}
    finally:
        db.close()


def snapshot(source: str, destination: str):
    source_path = os.path.abspath(source)
    destination_path = os.path.abspath(destination)
    same_path = os.path.normcase(source_path) == os.path.normcase(destination_path)
    try:
        same_path = same_path or os.path.samefile(source_path, destination_path)
    except (FileNotFoundError, OSError):
        pass
    if same_path:
        raise ValueError("operations snapshot source and destination must differ")
    os.makedirs(os.path.dirname(destination_path), exist_ok=True)
    staged = f"{destination_path}.snapshot-{uuid.uuid4().hex}.tmp"
    source_db = sqlite3.connect(f"{Path(source_path).as_uri()}?mode=ro", uri=True, timeout=30)
    source_tables = {row[0] for row in source_db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    if not {"meta", "undo_records"} <= source_tables:
        source_db.close()
        raise RuntimeError("operations snapshot source is missing required tables")
    source_schema = source_db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    source_identity = source_db.execute("SELECT value FROM meta WHERE key='domain_identity'").fetchone()
    source_version = int(source_schema[0]) if source_schema else 0
    source_check = source_db.execute("PRAGMA quick_check").fetchone()[0]
    if source_check != "ok":
        source_db.close()
        raise RuntimeError(f"operations snapshot source integrity check failed: {source_check}")
    if source_version <= 0 or source_version > SCHEMA_VERSION:
        source_db.close()
        raise RuntimeError(f"unsupported operations snapshot schema: {source_version}")
    if source_identity is not None and source_identity[0] != "operations":
        source_db.close()
        raise RuntimeError(f"operations snapshot identity mismatch: {source_identity[0]}")
    foreign_keys = source_db.execute("PRAGMA foreign_key_check").fetchall()
    if foreign_keys:
        source_db.close()
        raise RuntimeError(f"operations snapshot foreign key check failed: {foreign_keys[:10]}")
    target_db = sqlite3.connect(staged, timeout=30)
    try:
        source_db.backup(target_db)
        check = target_db.execute("PRAGMA quick_check").fetchone()[0]
        if check != "ok":
            raise RuntimeError(f"operations 数据库快照完整性检查失败：{check}")
        schema = target_db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        result = {"success": True, "schemaVersion": int(schema[0] if schema else 0)}
        target_db.close()
        target_db = None
        _durable_replace(staged, destination_path)
        return result
    finally:
        if target_db is not None:
            target_db.close()
        source_db.close()
        for suffix in ("", "-wal", "-shm"):
            try:
                os.remove(staged + suffix)
            except FileNotFoundError:
                pass


def run_server():
    for line in sys.stdin:
        if not line.strip():
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            result = execute(request["database"], request["action"], request.get("payload") or {})
            response = {"id": request_id, "success": True, "result": result}
        except Exception as error:
            response = error_response(request_id, error)
        encoded = json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        chunk_size = 128 * 1024
        if len(encoded) <= chunk_size:
            print(encoded.decode("utf-8"), flush=True)
            continue
        total = (len(encoded) + chunk_size - 1) // chunk_size
        for index in range(total):
            chunk = encoded[index * chunk_size:(index + 1) * chunk_size]
            print(json.dumps({
                "id": request_id, "protocol": "json-chunk-v1", "index": index,
                "total": total, "data": base64.b64encode(chunk).decode("ascii"),
            }, separators=(",", ":")), flush=True)


def run(args_list=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("action", nargs="?", choices=(*ALL_ACTIONS, "snapshot"))
    parser.add_argument("--database")
    parser.add_argument("--payload", default="{}")
    parser.add_argument("--source")
    parser.add_argument("--destination")
    parser.add_argument("--server", action="store_true")
    args = parser.parse_args(args_list)
    if args.server:
        run_server()
        return
    if args.action == "snapshot":
        if not args.source or not args.destination:
            parser.error("--source and --destination are required for snapshot")
        result = snapshot(args.source, args.destination)
    else:
        if not args.action or not args.database:
            parser.error("action and --database are required outside server mode")
        result = execute(args.database, args.action, json.loads(args.payload))
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    run()
