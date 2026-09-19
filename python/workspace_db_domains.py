"""Stable workspace database action catalog grouped by application domain."""

from compatibility.registry import action_names as compatibility_action_names

CATALOG_ACTIONS = (
    "catalog_sync", "maintenance_run", "add", "status", "archive_project", "unarchive_project",
    "rename", "delete", "restore_project", "deleted_projects_list", "deleted_project_cleanup_plan",
    "purge_deleted_project", "missing_projects_list", "purge_missing_project",
)
MEDIA_ACTIONS = (
    "media_sync_prepare", "media_sync_apply_batch", "media_sync_finalize",
    "media_sync_paths_prepare", "media_sync_paths_apply_batch", "media_sync_paths_finalize",
    "media_sync_abort",
    "media_get", "media_get_photo", "media_versions_snapshot", "media_create_version", "media_update_version", "media_component_update_version", "media_component_delete_version",
    "media_refresh_metadata_fingerprint", "final_version_list", "media_set_thumbnail", "media_relocate_version",
    "media_delete_version", "media_version_delete_scope", "media_delete_project_missing_version", "media_record_compare",
    "media_workflow_import_commit",
)
PROGRESS_ACTIONS = (
    "batch_list", "progress_list", "progress_snapshot", "progress_locations_snapshot", "progress_register", "progress_register_with_graph", "progress_component_manage",
    "progress_adopt_media", "progress_update_tree_begin", "progress_update_tree", "progress_update_tree_finish", "progress_folder_rename", "progress_relation_update", "progress_legacy_selection_repair",
    "version_graph_edge_create", "version_graph_edge_list", "version_graph_edge_delete", "version_graph_edge_replace_source",
    "version_tree_layout_get", "version_tree_layout_save", "progress_policy_save", "progress_mark_stale",
    "progress_mark_ready", "progress_main_branch", "progress_visible_relations", "progress_copy_missing_children",
    "progress_stale_prepare", "progress_stale_apply", "progress_main_branch_media", "progress_unregister", "progress_delete_missing", "batch_register_baseline",
    "batch_commit_compare", "batch_operation_list", "batch_retry_operations",
)
TRACKING_ACTIONS = (
    "tracking_session_create", "tracking_prepare", "tracking_store_preview", "tracking_session_get",
    "tracking_session_release", "tracking_session_decide", "tracking_commit_plan", "tracking_commit_complete",
    "tracking_commit_failed", "tracking_apply_copies", "tracking_commit_resources",
)
# These commands only need the workspace catalog plus versioning.sqlite3. Keep
# the list deliberately small: an action belongs here only after its SQL has
# been reviewed for media-table access. This lets version layouts and progress
# snapshots remain usable while the rebuildable media index is unavailable.
VERSIONING_ONLY_ACTIONS = frozenset((
    "batch_list", "progress_snapshot", "progress_locations_snapshot", "version_graph_edge_list",
    "version_tree_layout_get", "version_tree_layout_save",
))
UNDO_ACTIONS = ("undo_record_add", "undo_record_latest", "undo_record_list", "undo_record_remove", "undo_record_remove_many", "undo_record_mark_unavailable", "undo_record_retire_claim", "undo_record_claim_execute", "undo_record_shadow_retire")

ALL_ACTIONS = ("init", *CATALOG_ACTIONS, *MEDIA_ACTIONS, *PROGRESS_ACTIONS, *TRACKING_ACTIONS, *compatibility_action_names(), *UNDO_ACTIONS)
READ_ONLY_ACTIONS = frozenset((
    "progress_snapshot", "media_versions_snapshot", "tracking_session_get", "tracking_commit_resources", "version_tree_layout_get",
    "media_sync_prepare", "progress_stale_prepare", "media_version_delete_scope",
))

if len(ALL_ACTIONS) != len(set(ALL_ACTIONS)):
    raise RuntimeError("workspace database action catalog contains duplicates")
