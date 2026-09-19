"""Owned migration steps shared by the workspace database worker.

The catalog worker keeps the ordered migration driver. Domain-local schema
changes live here so their ownership can be checked without parsing the worker.
"""


CANONICAL_STORAGE_DOMAINS = frozenset(("workspace", "media", "versioning", "operations"))

MIGRATION_OWNERS = {
    11: ("workspace",),
    12: ("workspace", "media", "versioning"),
    13: ("workspace", "media", "versioning"),
    14: ("versioning",),
    15: ("workspace",),
    16: ("versioning",),
    17: ("workspace",),
    18: ("workspace", "versioning"),
    19: ("versioning",),
    20: ("workspace", "versioning"),
    21: ("versioning",),
    22: ("versioning",),
    23: ("versioning",),
    24: ("versioning",),
    25: ("versioning",),
    26: ("versioning",),
    27: ("versioning",),
    28: ("versioning",),
    29: ("media",),
    30: ("media",),
    31: ("versioning",),
    32: ("versioning",),
    33: ("versioning",),
    34: ("workspace", "operations"),
}

# Physical history and rollback details are descriptive metadata, not owners.
# Versions 11-25 ran before domain extraction while all three stores shared the
# workspace database. Versions 11, 15, 17 and 32 invoke compatibility hooks;
# 15 and 17 are hook-only reservations in the core migration driver.
MIGRATION_METADATA = {
    **{
        version: {"historicalPhysicalLayout": "shared-workspace-database"}
        for version in range(11, 26)
    },
    **{
        version: {
            "historicalPhysicalLayout": "shared-workspace-database",
            "compatibilityHook": True,
        }
        for version in (11, 15, 17)
    },
    15: {
        "historicalPhysicalLayout": "shared-workspace-database",
        "compatibilityHook": True,
        "compatibilityHookReservation": True,
    },
    17: {
        "historicalPhysicalLayout": "shared-workspace-database",
        "compatibilityHook": True,
        "compatibilityHookReservation": True,
    },
    32: {"compatibilityHook": True},
    34: {
        "retainedRollbackShadow": "workspace.undo_records",
        "runtimeOwner": "operations",
    },
}


def migration_26(db, table_columns):
    """Cache prepared tracking snapshots so commit finalization never rescans whole folders."""
    columns = table_columns(db, "tracking_sessions")
    if "prepared_files_snapshot_json" not in columns:
        db.execute("ALTER TABLE tracking_sessions ADD COLUMN prepared_files_snapshot_json TEXT")
    if "prepared_parent_snapshot_json" not in columns:
        db.execute("ALTER TABLE tracking_sessions ADD COLUMN prepared_parent_snapshot_json TEXT")


def migration_27(db, table_columns):
    """Persist the trusted project-relative route for externally linked version folders."""
    columns = table_columns(db, "progress_folders")
    if "external_link_relative_path" not in columns:
        db.execute("ALTER TABLE progress_folders ADD COLUMN external_link_relative_path TEXT")
    db.execute(
        "CREATE INDEX IF NOT EXISTS progress_folders_external_link "
        "ON progress_folders(project_id, external_link_relative_path)"
    )


def migration_28(db, table_columns):
    """Journal tracking copies and serialize progress-tree filesystem mutations."""
    del table_columns
    # Catalog-only startup deliberately leaves the optional versioning store
    # detached. Inspect every attached schema so the migration can be rerun
    # safely when that domain is opened by its first caller.
    migrated = False
    for schema in [row[1] for row in db.execute("PRAGMA database_list").fetchall()]:
        columns = {row[1] for row in db.execute(f'PRAGMA "{schema}".table_info("tracking_sessions")').fetchall()}
        if columns and "copy_operations_json" not in columns:
            db.execute(
                f'ALTER TABLE "{schema}"."tracking_sessions" ADD COLUMN copy_operations_json '
                "TEXT NOT NULL DEFAULT '[]'"
            )
            migrated = True
    return migrated


def migration_29(db):
    """Persist immutable incremental-media manifests and idempotency markers."""
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS media_incremental_snapshots(
          snapshot_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, state TEXT NOT NULL,
          manifest_hash TEXT NOT NULL, result_json TEXT, created_at INTEGER NOT NULL,
          finalized_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS media_incremental_snapshots_cleanup
          ON media_incremental_snapshots(state, finalized_at);
        CREATE TABLE IF NOT EXISTS media_incremental_snapshot_files(
          snapshot_id TEXT NOT NULL, ordinal INTEGER NOT NULL, file_path TEXT NOT NULL,
          file_path_key TEXT NOT NULL, file_size INTEGER NOT NULL, modified_at INTEGER NOT NULL,
          PRIMARY KEY(snapshot_id, ordinal)
        );
        CREATE INDEX IF NOT EXISTS media_incremental_snapshot_files_path
          ON media_incremental_snapshot_files(snapshot_id, file_path_key);
        CREATE TABLE IF NOT EXISTS media_incremental_snapshot_scopes(
          snapshot_id TEXT NOT NULL, ordinal INTEGER NOT NULL, path_key TEXT NOT NULL,
          scope_kind TEXT NOT NULL, like_prefix TEXT, PRIMARY KEY(snapshot_id, ordinal)
        );
        CREATE TABLE IF NOT EXISTS media_incremental_snapshot_baseline(
          snapshot_id TEXT NOT NULL, version_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY(snapshot_id, version_id)
        );
        CREATE TABLE IF NOT EXISTS media_incremental_snapshot_batches(
          snapshot_id TEXT NOT NULL, batch_index INTEGER NOT NULL, payload_hash TEXT NOT NULL,
          result_json TEXT NOT NULL, PRIMARY KEY(snapshot_id, batch_index)
        );
        """
    )


def migration_30(db):
    """Index immutable incremental scopes in the mounted media store."""
    for schema in [row[1] for row in db.execute("PRAGMA database_list").fetchall()]:
        if not db.execute(
            f"SELECT 1 FROM \"{schema}\".sqlite_master WHERE type='table' AND name='media_incremental_snapshot_scopes'"
        ).fetchone():
            continue
        db.execute(
            f'''CREATE INDEX IF NOT EXISTS "{schema}".media_incremental_snapshot_scopes_path
                ON media_incremental_snapshot_scopes(snapshot_id,path_key,scope_kind)'''
        )
    return False


def migration_31(db):
    """Reserve the catalog version for the persistent broll node semantic."""
    del db
    return False


def migration_32(db, run_compatibility_hooks, install_progress_purpose_constraints):
    """Persist generic producer metadata for opaque workflow nodes."""
    found_progress = False
    for schema in (row[1] for row in db.execute("PRAGMA database_list").fetchall()):
        tables = {row[0] for row in db.execute(f"SELECT name FROM {schema}.sqlite_master WHERE type='table'").fetchall()}
        if "progress_folders" not in tables:
            continue
        found_progress = True
        columns = {row[1] for row in db.execute(f"PRAGMA {schema}.table_info(progress_folders)").fetchall()}
        if "source_metadata_json" not in columns:
            db.execute(f"ALTER TABLE {schema}.progress_folders ADD COLUMN source_metadata_json TEXT NOT NULL DEFAULT '{{}}'")
    run_compatibility_hooks("migrate", db, 32)
    if found_progress:
        install_progress_purpose_constraints(db)
    return False


def migration_33(db):
    """Journal crash-recoverable local and external progress relocations."""
    migrated = False
    for schema in (row[1] for row in db.execute("PRAGMA database_list").fetchall()):
        tables = {row[0] for row in db.execute(f"SELECT name FROM {schema}.sqlite_master WHERE type='table'").fetchall()}
        if "progress_folders" not in tables:
            continue
        indexes = {row[0] for row in db.execute(f"SELECT name FROM {schema}.sqlite_master WHERE type='index'").fetchall()}
        external_columns_before = ({row[1] for row in db.execute(f"PRAGMA {schema}.table_info(progress_external_link_renames)").fetchall()}
                                   if "progress_external_link_renames" in tables else set())
        migrated = migrated or "progress_folder_relocations" not in tables or "progress_external_link_renames" not in tables or not {
            "progress_folder_relocations_pending", "progress_folder_relocations_progress_pending",
            "progress_external_link_renames_pending", "progress_external_link_renames_progress_pending",
        }.issubset(indexes) or not {"mutation_token", "lease_created_at"}.issubset(external_columns_before)
        db.executescript(
            f"""
            CREATE TABLE IF NOT EXISTS {schema}.progress_folder_relocations(
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL, progress_id TEXT NOT NULL,
              folder_id TEXT NOT NULL, old_path TEXT NOT NULL, old_path_key TEXT NOT NULL,
              new_path TEXT NOT NULL, new_path_key TEXT NOT NULL, temporary_path TEXT NOT NULL,
              old_relative_path TEXT NOT NULL, new_relative_path TEXT NOT NULL,
              state TEXT NOT NULL CHECK(state IN ('prepared','filesystem_moved','database_relocated','completed')),
              error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
              completed_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS {schema}.progress_folder_relocations_pending
              ON progress_folder_relocations(state,updated_at);
            CREATE UNIQUE INDEX IF NOT EXISTS {schema}.progress_folder_relocations_progress_pending
              ON progress_folder_relocations(progress_id) WHERE state!='completed';
            CREATE TABLE IF NOT EXISTS {schema}.progress_external_link_renames(
              id TEXT PRIMARY KEY, operation_key TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL,
              progress_id TEXT NOT NULL, old_relative_path TEXT NOT NULL, new_relative_path TEXT NOT NULL,
              old_path TEXT NOT NULL, new_path TEXT NOT NULL, temporary_path TEXT NOT NULL,
              link_sha256 TEXT NOT NULL, mutation_token TEXT NOT NULL DEFAULT '',
              lease_created_at INTEGER NOT NULL DEFAULT 0,
              state TEXT NOT NULL CHECK(state IN ('prepared','filesystem_moved','database_relocated','completed')),
              error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
              completed_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS {schema}.progress_external_link_renames_pending
              ON progress_external_link_renames(state,updated_at);
            CREATE UNIQUE INDEX IF NOT EXISTS {schema}.progress_external_link_renames_progress_pending
              ON progress_external_link_renames(progress_id) WHERE state!='completed';
            """
        )
        external_columns = {row[1] for row in db.execute(f"PRAGMA {schema}.table_info(progress_external_link_renames)").fetchall()}
        if "mutation_token" not in external_columns:
            db.execute(f"ALTER TABLE {schema}.progress_external_link_renames ADD COLUMN mutation_token TEXT NOT NULL DEFAULT ''")
        if "lease_created_at" not in external_columns:
            db.execute(f"ALTER TABLE {schema}.progress_external_link_renames ADD COLUMN lease_created_at INTEGER NOT NULL DEFAULT 0")
    return migrated


def migration_34(db):
    """Fence permanent retired-ID and version-bound undo execution semantics."""
    columns = {row[1] for row in db.execute("PRAGMA table_info(undo_records)").fetchall()}
    if not {"id", "kind", "payload_json", "state", "created_at", "updated_at"} <= columns:
        raise RuntimeError("workspace undo_records contract is incomplete")
    return False
