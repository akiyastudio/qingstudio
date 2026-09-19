"""Machine-readable ownership contract for workspace SQLite stores."""

from workspace_db_migrations import MIGRATION_OWNERS
from workspace_db_domains import MEDIA_ACTIONS


DOMAIN_TABLES = {
    "media": (
        "photos", "file_records", "media_incremental_snapshots",
        "media_incremental_snapshot_files", "media_incremental_snapshot_scopes",
        "media_incremental_snapshot_baseline", "media_incremental_snapshot_batches",
    ),
    "versioning": (
        "versions", "version_batches", "progress_folders", "batch_file_operations",
        "batch_items", "version_compare_history", "tracking_sessions",
        "tracking_session_items", "legacy_selection_relation_repairs",
        "version_tree_layouts", "version_tree_node_positions", "version_graph_edges",
        "media_import_graph_sessions", "media_import_artifact_slots", "progress_folder_relocations",
        "progress_external_link_renames",
    ),
}

WORKSPACE_TABLES = (
    "meta", "projects", "project_properties", "project_tags",
    "progress_relation_repair_log", "undo_records",
)

STORAGE_OWNERSHIP = {
    "workspace": {
        "filename": "<workspace-id>.sqlite3",
        "tables": WORKSPACE_TABLES,
        "schemaVersion": 34,
        "migrationVersions": tuple(
            version for version, owners in MIGRATION_OWNERS.items() if "workspace" in owners
        ),
        "workspaceMigrationVersions": tuple(
            version for version, owners in MIGRATION_OWNERS.items() if "workspace" in owners
        ),
        "recoveryActions": ("snapshot", "restore-workspace", "restore-project"),
        "retainedLegacyTables": ("undo_records", "progress_relation_repair_log"),
    },
    "media": {
        "filename": "media.sqlite3",
        "tables": ("meta", *DOMAIN_TABLES["media"]),
        "schemaVersion": 1,
        "migrationVersions": tuple(
            version for version, owners in MIGRATION_OWNERS.items() if "media" in owners
        ),
        "workspaceMigrationVersions": tuple(
            version for version, owners in MIGRATION_OWNERS.items() if "media" in owners
        ),
        "recoveryActions": ("verify", "snapshot", "restore-workspace", "restore-project", "reset"),
        "rebuildable": True,
    },
    "versioning": {
        "filename": "versioning.sqlite3",
        "tables": ("meta", *DOMAIN_TABLES["versioning"]),
        "schemaVersion": 1,
        "migrationVersions": tuple(
            version for version, owners in MIGRATION_OWNERS.items() if "versioning" in owners
        ),
        "workspaceMigrationVersions": tuple(
            version for version, owners in MIGRATION_OWNERS.items() if "versioning" in owners
        ),
        "recoveryActions": ("verify", "snapshot", "restore-workspace", "restore-project", "reset"),
        "rebuildable": False,
    },
    "operations": {
        "filename": "operations.sqlite3",
        "tables": ("meta", "undo_records"),
        "schemaVersion": 2,
        "migrationVersions": (0, 1),
        "workspaceMigrationVersions": tuple(
            version for version, owners in MIGRATION_OWNERS.items() if "operations" in owners
        ),
        "recoveryActions": ("verify", "snapshot", "restore-workspace", "reset", "sync-retired-shadow"),
        "rebuildable": False,
    },
}

# Runtime implementation ownership is intentionally separate from physical
# table ownership: media_workflow_import_commit coordinates progress graph
# writes and therefore remains in the workspace composition root.
ACTION_IMPLEMENTATION_OWNERS = {
    "workspace_media_actions": tuple(
        action for action in MEDIA_ACTIONS if action != "media_workflow_import_commit"
    ),
}
