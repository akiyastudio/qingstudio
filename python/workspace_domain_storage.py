"""Physical storage extraction for media and versioning bounded contexts.

Catalog-only connections never open these files, so a corrupt or locked media
or versioning store cannot prevent the workspace catalog from opening.
"""

from __future__ import annotations

import os
import re
import sqlite3
import time
import uuid

from workspace_storage_ownership import DOMAIN_TABLES

SCHEMA_VERSION = 1
_DOMAIN_READY_CACHE = {}


def _domain_file_identity(path: str):
    try:
        stat = os.stat(path)
        return (int(stat.st_dev), int(stat.st_ino))
    except OSError:
        return None


def _migrate_domain_0_to_1(db, domain: str, existing_tables: set[str]) -> None:
    conflicting = set().union(*(set(tables) for name, tables in DOMAIN_TABLES.items() if name != domain)) & existing_tables
    if conflicting:
        raise RuntimeError(f"cannot infer {domain} identity; conflicting tables: {sorted(conflicting)}")
    if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        raise RuntimeError(f"{domain} schema-0 database failed integrity validation")
    db.execute("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
    db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('domain_identity',?)", (domain,))


DOMAIN_MIGRATIONS = {0: _migrate_domain_0_to_1}


def database_path_for_workspace_database(workspace_database: str, domain: str) -> str:
    if domain not in DOMAIN_TABLES:
        raise ValueError(f"unknown workspace storage domain: {domain}")
    absolute = os.path.abspath(workspace_database)
    workspace_key = os.path.splitext(os.path.basename(absolute))[0]
    return os.path.join(os.path.dirname(absolute), workspace_key, "databases", f"{domain}.sqlite3")


def _connect_domain(path: str, domain: str) -> sqlite3.Connection:
    absolute = os.path.abspath(path)
    os.makedirs(os.path.dirname(absolute), exist_ok=True)
    cached_identity = _domain_file_identity(absolute)
    db = sqlite3.connect(absolute, timeout=30)
    try:
        db.execute("PRAGMA busy_timeout=30000")
        if cached_identity is not None and _DOMAIN_READY_CACHE.get(absolute) == cached_identity:
            cached_schema = db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
            cached_domain = db.execute("SELECT value FROM meta WHERE key='domain_identity'").fetchone()
            if cached_schema and int(cached_schema[0]) == SCHEMA_VERSION and cached_domain and cached_domain[0] == domain:
                return db
            _DOMAIN_READY_CACHE.pop(absolute, None)
        if str(db.execute("PRAGMA journal_mode").fetchone()[0]).casefold() != "wal":
            db.execute("PRAGMA journal_mode=WAL")
        db.execute("BEGIN IMMEDIATE")
        existing_tables = {
            row[0] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        }
        if "meta" not in existing_tables:
            schema = None
        else:
            schema = db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        schema_version = int(schema[0]) if schema else 0
        if schema_version > SCHEMA_VERSION:
            raise RuntimeError(
                f"{domain} database schema {schema_version} is newer than supported {SCHEMA_VERSION}"
            )
        identity = db.execute("SELECT value FROM meta WHERE key='domain_identity'").fetchone() if "meta" in existing_tables else None
        if identity is not None and identity[0] != domain:
            raise RuntimeError(f"domain identity mismatch: expected {domain}, found {identity[0]}")
        if identity is None and schema_version == SCHEMA_VERSION:
            conflicting = set().union(*(set(tables) for name, tables in DOMAIN_TABLES.items() if name != domain)) & existing_tables
            if conflicting:
                raise RuntimeError(f"cannot infer {domain} identity; conflicting tables: {sorted(conflicting)}")
            db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('domain_identity',?)", (domain,))
        while schema_version < SCHEMA_VERSION:
            migration = DOMAIN_MIGRATIONS.get(schema_version)
            if migration is None:
                raise RuntimeError(f"missing {domain} domain migration {schema_version}->{schema_version + 1}")
            migration(db, domain, existing_tables)
            schema_version += 1
            db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)", (str(schema_version),))
        db.commit()
        _DOMAIN_READY_CACHE[absolute] = _domain_file_identity(absolute)
        return db
    except Exception:
        db.rollback()
        db.close()
        raise


def _strip_cross_store_references(sql: str, domain: str) -> str:
    owned = set(DOMAIN_TABLES[domain])
    table_constraint = re.compile(
        r",?\s*FOREIGN\s+KEY\s*\([^)]*\)\s+REFERENCES\s+([`\"\[]?)([A-Za-z_][A-Za-z0-9_]*)[`\"\]]?\s*\([^)]*\)"
        r"(?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION))*",
        re.IGNORECASE,
    )
    inline = re.compile(
        r"\s+REFERENCES\s+([`\"\[]?)([A-Za-z_][A-Za-z0-9_]*)[`\"\]]?\s*\([^)]*\)"
        r"(?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION))*",
        re.IGNORECASE,
    )
    sql = table_constraint.sub(lambda match: match.group(0) if match.group(2) in owned else "", sql)
    return inline.sub(lambda match: match.group(0) if match.group(2) in owned else "", sql)


def _domain_create_table_sql(sql: str, alias: str, table: str, domain: str) -> str:
    rewritten = re.sub(
        r"^\s*CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:[`\"\[]?[A-Za-z_][A-Za-z0-9_]*[`\"\]]?)",
        f'CREATE TABLE IF NOT EXISTS {alias}."{table}"',
        _strip_cross_store_references(sql, domain),
        count=1,
        flags=re.IGNORECASE,
    )
    if rewritten == sql:
        raise RuntimeError(f"unable to rewrite schema for {table}")
    return rewritten


def _domain_create_index_sql(sql: str, alias: str) -> str:
    return re.sub(
        r"^\s*CREATE\s+(UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:[`\"\[]?([A-Za-z_][A-Za-z0-9_]*)[`\"\]]?)",
        lambda match: f'CREATE {match.group(1) or ""}INDEX IF NOT EXISTS {alias}."{match.group(2)}"',
        sql,
        count=1,
        flags=re.IGNORECASE,
    )


def _copy_legacy_table(workspace_db: sqlite3.Connection, alias: str, table: str) -> None:
    schema = workspace_db.execute(
        "SELECT sql FROM main.sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    if schema is None or not schema[0]:
        return
    create_sql = _domain_create_table_sql(schema[0], alias, table, alias)
    try:
        workspace_db.execute(create_sql)
    except sqlite3.Error as error:
        raise RuntimeError(f"unable to create {alias}.{table}: {error}; sql={create_sql}") from error
    source_columns = [row[1] for row in workspace_db.execute(f'PRAGMA main.table_info("{table}")').fetchall()]
    target_columns = [row[1] for row in workspace_db.execute(f'PRAGMA {alias}.table_info("{table}")').fetchall()]
    columns = [column for column in source_columns if column in target_columns]
    if columns:
        projection = ",".join(f'"{column}"' for column in columns)
        primary_key = [row[1] for row in sorted(
            workspace_db.execute(f'PRAGMA main.table_info("{table}")').fetchall(), key=lambda row: row[5]
        ) if row[5]]
        target_count = workspace_db.execute(f'SELECT COUNT(*) FROM {alias}."{table}"').fetchone()[0]
        if target_count and not primary_key:
            raise RuntimeError(f"{alias}.{table} cannot merge existing rows without a primary key")
        if primary_key:
            identity = " AND ".join(f't."{column}" IS s."{column}"' for column in primary_key)
            equality = " AND ".join(f't."{column}" IS s."{column}"' for column in columns)
            conflicts = workspace_db.execute(
                f'SELECT COUNT(*) FROM main."{table}" s JOIN {alias}."{table}" t ON {identity} WHERE NOT ({equality})'
            ).fetchone()[0]
            if conflicts:
                raise RuntimeError(f"{alias}.{table} extraction has {conflicts} conflicting primary keys")
            workspace_db.execute(
                f'INSERT INTO {alias}."{table}"({projection}) SELECT {projection} FROM main."{table}" s '
                f'WHERE NOT EXISTS(SELECT 1 FROM {alias}."{table}" t WHERE {identity})'
            )
        else:
            workspace_db.execute(f'INSERT INTO {alias}."{table}"({projection}) SELECT {projection} FROM main."{table}"')
        missing = workspace_db.execute(
            f'SELECT COUNT(*) FROM main."{table}" s WHERE NOT EXISTS('
            f'SELECT 1 FROM {alias}."{table}" t WHERE {" AND ".join(f"t.\"{column}\" IS s.\"{column}\"" for column in columns)})'
        ).fetchone()[0]
        if missing:
            raise RuntimeError(f"{alias}.{table} extraction lost {missing} rows")
    indexes = workspace_db.execute(
        "SELECT sql FROM main.sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL", (table,)
    ).fetchall()
    for index in indexes:
        workspace_db.execute(_domain_create_index_sql(index[0], alias))


def _backup_before_extraction(workspace_database: str) -> str:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    destination = f"{workspace_database}.before-domain-extraction.{stamp}.{uuid.uuid4().hex}.bak"
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    try:
        source = sqlite3.connect(f"file:{workspace_database}?mode=ro", uri=True, timeout=30)
        target = sqlite3.connect(destination, timeout=30)
        try:
            source.backup(target)
            target.commit()
            if target.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise RuntimeError("pre-extraction backup integrity check failed")
        finally:
            target.close()
            source.close()
        sync_descriptor = os.open(destination, os.O_RDWR)
        try: os.fsync(sync_descriptor)
        finally: os.close(sync_descriptor)
        try:
            directory = os.open(os.path.dirname(destination), os.O_RDONLY)
            try: os.fsync(directory)
            finally: os.close(directory)
        except OSError as error:
            if getattr(error, "winerror", None) not in (5, 50) and error.errno not in (13, 22):
                raise
    except Exception:
        try: os.remove(destination)
        except FileNotFoundError: pass
        raise
    return destination


def attach_and_migrate(
    workspace_db: sqlite3.Connection,
    workspace_database: str,
    domains=None,
) -> dict[str, str]:
    requested = tuple(DOMAIN_TABLES) if domains is None else tuple(dict.fromkeys(domains))
    unknown = set(requested) - set(DOMAIN_TABLES)
    if unknown:
        raise ValueError(f"unknown workspace storage domains: {sorted(unknown)}")

    legacy_tables = {
        row[0] for row in workspace_db.execute(
            "SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    }
    owned_legacy = [
        (domain, table) for domain, tables in DOMAIN_TABLES.items()
        for table in tables if table in legacy_tables
    ]
    # The one-time extraction must move the complete ownership graph before it
    # drops any legacy table. Once extraction is complete, normal requests open
    # only their declared domain stores.
    prepared = tuple(DOMAIN_TABLES) if owned_legacy else requested
    paths = {domain: database_path_for_workspace_database(workspace_database, domain) for domain in prepared}
    for domain, domain_path in paths.items():
        cached = _DOMAIN_READY_CACHE.get(os.path.abspath(domain_path)) == _domain_file_identity(domain_path)
        probe = _connect_domain(domain_path, domain)
        try:
            if not cached:
                check = probe.execute("PRAGMA quick_check").fetchone()[0]
                if check != "ok":
                    raise RuntimeError(f"{domain} database integrity check failed: {check}")
        finally:
            probe.close()
    attached = {row[1] for row in workspace_db.execute("PRAGMA database_list").fetchall()}
    for domain, domain_path in paths.items():
        if domain not in attached:
            workspace_db.execute(f"ATTACH DATABASE ? AS {domain}", (domain_path,))
            workspace_db.execute(f"PRAGMA {domain}.busy_timeout=30000")

    if owned_legacy:
        backup_path = _backup_before_extraction(os.path.abspath(workspace_database))
        workspace_db.commit()
        workspace_db.execute("PRAGMA foreign_keys=OFF")
        workspace_db.execute("BEGIN IMMEDIATE")
        try:
            for domain, table in owned_legacy:
                _copy_legacy_table(workspace_db, domain, table)
            for _domain, table in reversed(owned_legacy):
                workspace_db.execute(f'DROP TABLE IF EXISTS main."{table}"')
            workspace_db.execute(
                "INSERT OR REPLACE INTO main.meta(key,value) VALUES('domain_storage_revision',?)",
                (str(SCHEMA_VERSION),),
            )
            workspace_db.execute(
                "INSERT OR REPLACE INTO main.meta(key,value) VALUES('domain_storage_backup',?)",
                (backup_path,),
            )
            workspace_db.commit()
        except Exception:
            workspace_db.rollback()
            raise
        finally:
            workspace_db.execute("PRAGMA foreign_keys=ON")
    return paths


def verify_database(path: str) -> dict:
    absolute = os.path.abspath(path)
    if not os.path.isfile(absolute):
        return {"success": False, "state": "missing", "path": absolute}
    try:
        db = sqlite3.connect(f"file:{absolute}?mode=ro", uri=True, timeout=10)
        try:
            result = [row[0] for row in db.execute("PRAGMA quick_check").fetchall()]
            schema = db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
            return {
                "success": result == ["ok"], "state": "healthy" if result == ["ok"] else "corrupt",
                "path": absolute, "schemaVersion": int(schema[0]) if schema else 0,
                "quickCheck": result[:10],
            }
        finally:
            db.close()
    except sqlite3.Error as error:
        return {"success": False, "state": "unavailable", "path": absolute, "error": str(error)}
