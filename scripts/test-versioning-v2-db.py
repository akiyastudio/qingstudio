import importlib.util
import json
import os
import shutil
import sqlite3
import tempfile
import time
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = REPOSITORY_ROOT / "python" / "workspace_db.py"
SPEC = importlib.util.spec_from_file_location("workspace_db_v2", MODULE_PATH)
workspace_db = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(workspace_db)


def create_schema_17_database(database: Path, workspace: Path) -> None:
    database.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(database)
    db.executescript(
        """
        PRAGMA foreign_keys=ON;
        CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE projects(
          id TEXT PRIMARY KEY,name TEXT NOT NULL COLLATE NOCASE UNIQUE,status TEXT NOT NULL,
          relative_path TEXT NOT NULL UNIQUE,filesystem_id TEXT,is_deleted INTEGER NOT NULL DEFAULT 0,
          availability TEXT NOT NULL DEFAULT 'available',missing_since INTEGER,missing_checks INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,extra_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE progress_folders(
          id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          media_kind TEXT NOT NULL,version_key TEXT NOT NULL,parent_progress_id TEXT REFERENCES progress_folders(id),
          display_name TEXT NOT NULL,folder_path TEXT NOT NULL,folder_path_key TEXT NOT NULL,folder_id TEXT,
          tracking_enabled INTEGER NOT NULL DEFAULT 0,tracking_state TEXT NOT NULL DEFAULT 'disabled',
          missing_since INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
          UNIQUE(project_id,media_kind,version_key)
        );
        INSERT INTO meta VALUES('schema_version','17');
        """
    )
    project = workspace / "Legacy"
    raw = project / "RAW"
    main = project / "调色_1"
    underscored = project / "调色_1_1"
    for folder in (raw, main, underscored):
        folder.mkdir(parents=True, exist_ok=True)
    now = int(time.time() * 1000)
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES('legacy-project','Legacy','后期中','Legacy',?,?)",
        (now, now),
    )
    rows = (
        ("legacy-raw", "image", "0", None, "RAW", raw, 0, "disabled"),
        ("legacy-main", "image", "1", "legacy-raw", "调色_1", main, 1, "ready"),
        ("legacy-underscore", "image", "1_1", "legacy-main", "调色_1_1", underscored, 0, "pending_compare"),
    )
    for node_id, media_kind, version_key, parent_id, display_name, folder, enabled, state in rows:
        db.execute(
            """INSERT INTO progress_folders(
                 id,project_id,media_kind,version_key,parent_progress_id,display_name,folder_path,
                 folder_path_key,tracking_enabled,tracking_state,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
            (node_id, "legacy-project", media_kind, version_key, parent_id, display_name,
             str(folder.resolve()), str(folder.resolve()).casefold(), enabled, state, now, now),
        )
    db.commit()
    db.close()


def test_schema_17_upgrade(root: Path) -> None:
    workspace = root / "legacy-workspace"
    database = root / "legacy.sqlite3"
    create_schema_17_database(database, workspace)
    db = workspace_db.connect(str(workspace), str(database))
    try:
        assert db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == str(workspace_db.TARGET_SCHEMA_VERSION)
        columns = {row[1] for row in db.execute("PRAGMA table_info(progress_folders)")}
        assert {"node_role", "relation_kind", "rename_from_parent", "copy_missing_from_parent",
                "last_tracked_at", "tracking_snapshot_json", "folder_signature", "tombstone_json"} <= columns
        session_columns = {row[1] for row in db.execute("PRAGMA table_info(tracking_sessions)")}
        item_columns = {row[1] for row in db.execute("PRAGMA table_info(tracking_session_items)")}
        assert {"progress_id", "parent_progress_id", "mode", "status", "rename_from_parent",
                "copy_missing_from_parent", "committed_batch_id", "copy_operations_json"} <= session_columns
        assert {"session_id", "item_kind", "source_name", "reference_name", "target_name", "status"} <= item_columns
        rows = {row["id"]: row for row in db.execute("SELECT * FROM progress_folders")}
        assert rows["legacy-raw"]["node_role"] == "original"
        assert rows["legacy-raw"]["relation_kind"] is None
        assert rows["legacy-main"]["node_role"] == "progress" and rows["legacy-main"]["relation_kind"] == "main"
        assert rows["legacy-main"]["parent_progress_id"] == "legacy-raw"
        assert rows["legacy-main"]["tracking_enabled"] == 1 and rows["legacy-main"]["tracking_state"] == "ready"
        # An underscore is legacy numbering only. It remains a main edge and
        # keeps its parent rather than being guessed into an auxiliary branch.
        assert rows["legacy-underscore"]["node_role"] == "progress"
        assert rows["legacy-underscore"]["relation_kind"] == "main"
        assert rows["legacy-underscore"]["parent_progress_id"] == "legacy-main"
        assert rows["legacy-underscore"]["tracking_enabled"] == 1
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
        assert db.execute("SELECT COUNT(*) FROM progress_relation_repair_log").fetchone()[0] == 0
        backup_path = db.execute("SELECT value FROM meta WHERE key='last_migration_backup'").fetchone()[0]
        assert Path(backup_path).is_file()
        backup = sqlite3.connect(backup_path)
        try:
            assert backup.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == "17"
        finally:
            backup.close()
        workspace_db._check_integrity(db, force=True)
    finally:
        db.close()
    reopened = workspace_db.connect(str(workspace), str(database))
    try:
        assert reopened.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == str(workspace_db.TARGET_SCHEMA_VERSION)
        assert reopened.execute("SELECT COUNT(*) FROM progress_folders").fetchone()[0] == 3
        assert reopened.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        reopened.close()


def test_schema_17_cycle_repairs(root: Path) -> None:
    cases = {
        "self": {
            "updates": [("legacy-raw", "legacy-raw")],
            "cycle": ["legacy-raw"],
        },
        "two": {
            "updates": [("legacy-main", "legacy-underscore"), ("legacy-underscore", "legacy-main")],
            "cycle": ["legacy-main", "legacy-underscore"],
        },
    }
    for case_name, case in cases.items():
        workspace = root / f"cycle-{case_name}-workspace"
        database = root / f"cycle-{case_name}.sqlite3"
        create_schema_17_database(database, workspace)
        legacy = sqlite3.connect(database)
        try:
            for node_id, parent_id in case["updates"]:
                legacy.execute("UPDATE progress_folders SET parent_progress_id=? WHERE id=?", (parent_id, node_id))
            legacy.commit()
        finally:
            legacy.close()

        db = workspace_db.connect(str(workspace), str(database))
        try:
            assert db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == str(workspace_db.TARGET_SCHEMA_VERSION)
            assert workspace_db._progress_relation_cycles(db) == []
            expected_cycle = sorted(case["cycle"])
            repaired_id = min(expected_cycle)
            repaired = db.execute(
                "SELECT parent_progress_id,relation_kind,node_role FROM progress_folders WHERE id=?",
                (repaired_id,),
            ).fetchone()
            assert repaired["parent_progress_id"] is None and repaired["relation_kind"] is None
            assert repaired["node_role"] == "original", "cycle repair must leave a legal structural root instead of an orphan progress parent"
            repair_log = db.execute("SELECT * FROM progress_relation_repair_log").fetchall()
            assert len(repair_log) == 1
            assert repair_log[0]["repaired_progress_id"] == repaired_id
            assert json.loads(repair_log[0]["cycle_node_ids_json"]) == expected_cycle
            assert repair_log[0]["repair_kind"] == "legacy_cycle_rooted"
            trigger_sql = "\n".join(row[0] for row in db.execute(
                "SELECT sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'progress_folders_v2_cycle_%' ORDER BY name"
            ).fetchall())
            assert "UNION ALL" not in trigger_sql.upper() and " UNION\n" in trigger_sql.upper()
            workspace_db._check_integrity(db, force=True)
            backup_path = Path(db.execute("SELECT value FROM meta WHERE key='last_migration_backup'").fetchone()[0])
            assert backup_path.is_file()
            backup = sqlite3.connect(backup_path)
            try:
                assert backup.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == "17"
                assert backup.execute("SELECT parent_progress_id FROM progress_folders WHERE id=?", (repaired_id,)).fetchone()[0] is not None
            finally:
                backup.close()
        finally:
            db.close()


def test_schema_19_cycle_repair(root: Path) -> None:
    """Databases already marked V2 must also receive the repair migration."""
    workspace = root / "schema-19-cycle-workspace"
    database = root / "schema-19-cycle.sqlite3"
    create_schema_17_database(database, workspace)
    upgraded = workspace_db.connect(str(workspace), str(database))
    upgraded.close()

    legacy_v2 = sqlite3.connect(database)
    try:
        legacy_v2.executescript(
            """DROP TRIGGER IF EXISTS progress_folders_v2_cycle_insert;
               DROP TRIGGER IF EXISTS progress_folders_v2_cycle_update;"""
        )
        legacy_v2.execute("UPDATE progress_folders SET parent_progress_id='legacy-underscore',relation_kind='main' WHERE id='legacy-main'")
        legacy_v2.execute("UPDATE progress_folders SET parent_progress_id='legacy-main',relation_kind='main' WHERE id='legacy-underscore'")
        legacy_v2.execute("UPDATE meta SET value='19' WHERE key='schema_version'")
        legacy_v2.commit()
    finally:
        legacy_v2.close()

    repaired = workspace_db.connect(str(workspace), str(database))
    try:
        assert repaired.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == str(workspace_db.TARGET_SCHEMA_VERSION)
        assert workspace_db._progress_relation_cycles(repaired) == []
        latest_log = repaired.execute("SELECT * FROM progress_relation_repair_log ORDER BY id DESC LIMIT 1").fetchone()
        assert latest_log["repaired_progress_id"] == "legacy-main"
        assert json.loads(latest_log["cycle_node_ids_json"]) == ["legacy-main", "legacy-underscore"]
        backup_path = Path(repaired.execute("SELECT value FROM meta WHERE key='last_migration_backup'").fetchone()[0])
        backup = sqlite3.connect(backup_path)
        try:
            assert backup.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == "19"
        finally:
            backup.close()
    finally:
        repaired.close()


def register(db, workspace: Path, **payload):
    return workspace_db.progress_register(str(workspace), db, {"projectName": "Project", **payload})["progressFolder"]


def test_v2_node_operations(root: Path) -> None:
    workspace = root / "workspace"
    project = workspace / "Project"
    raw_folder = project / "RAW"
    raw_folder.mkdir(parents=True)
    database = root / "v2.sqlite3"
    db = workspace_db.connect(str(workspace), str(database))
    now = int(time.time() * 1000)
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES('project','Project','后期中','Project',?,?)",
        (now, now),
    )
    db.commit()
    try:
        initial = workspace_db.progress_list(str(workspace), db, {"projectName": "Project"})["progressFolders"]
        original = next(item for item in initial if item["nodeRole"] == "original" and item["displayName"] == "RAW")

        parent_folder = project / "调色一版"
        child_folder = project / "调色二版"
        selection_folder = project / "RAW_选片"
        stale_child_folder = project / "精修版"
        for folder in (parent_folder, child_folder, selection_folder, stale_child_folder):
            folder.mkdir()
        parent = register(
            db, workspace, mediaKind="image", versionKey="v1", displayName="调色一版",
            folderPath=str(parent_folder), nodeRole="progress", relationKind="main",
            parentProgressId=original["id"], trackingEnabled=True, renameFromParent=True,
            copyMissingFromParent=False, trackingState="ready", trackingSnapshot={"count": 10},
            folderSignature="sig-v1",
        )
        child = register(
            db, workspace, mediaKind="image", versionKey="v2", displayName="调色二版",
            folderPath=str(child_folder), nodeRole="progress", relationKind="main",
            parentProgressId=parent["id"], trackingEnabled=True, trackingState="ready",
        )
        selection = register(
            db, workspace, mediaKind="image", versionKey="selection-raw", displayName="RAW_选片",
            folderPath=str(selection_folder), nodeRole="selection", relationKind="auxiliary",
            parentProgressId=original["id"], trackingEnabled=False, trackingState="disabled",
        )
        assert parent["parentProgressId"] == original["id"] and parent["relationKind"] == "main"
        assert selection["parentProgressId"] == original["id"] and selection["relationKind"] == "auxiliary"
        assert not selection["trackingEnabled"] and not selection["renameFromParent"] and not selection["copyMissingFromParent"]

        # Version metadata updates are node-local and never rename the selected
        # directory or rewrite descendants as an implicit subtree operation.
        remapped = workspace_db.progress_update_tree(str(workspace), db, {
            "projectName": "Project", "primaryProgressId": parent["id"],
            "updates": [{"id": parent["id"], "mediaKind": "image", "versionKey": "3",
                         "displayName": "ignored", "folderPath": str(project / "ignored"),
                         "parentProgressId": original["id"], "trackingEnabled": True, "trackingState": "ready"}],
        })
        remapped_by_id = {item["id"]: item for item in remapped["progressFolders"]}
        assert remapped_by_id[parent["id"]]["versionKey"] == "3"
        assert remapped_by_id[child["id"]]["versionKey"] == "v2"
        assert remapped_by_id[child["id"]]["parentProgressId"] == parent["id"]
        assert remapped_by_id[parent["id"]]["folderPath"] == str(parent_folder)

        blocked_folder = project / "非法选片"
        blocked_folder.mkdir()
        try:
            register(
                db, workspace, mediaKind="image", versionKey="blocked-selection", displayName="非法选片",
                folderPath=str(blocked_folder), nodeRole="selection", relationKind="auxiliary",
                parentProgressId=original["id"], trackingEnabled=True, trackingState="ready",
            )
            raise AssertionError("auxiliary tracking must be rejected")
        except ValueError as error:
            assert "禁止开启" in str(error)

        # Same-project, same-kind cycles are rejected by SQLite itself.
        try:
            db.execute(
                "UPDATE progress_folders SET parent_progress_id=?,relation_kind='main' WHERE id=?",
                (child["id"], parent["id"]),
            )
            raise AssertionError("cycle must be rejected")
        except sqlite3.IntegrityError as error:
            assert "cycle" in str(error)
            db.rollback()

        # Missing nodes disappear from the normal tree but remain queryable for takeover.
        selection_folder.rmdir()
        visible_ids = {item["id"] for item in workspace_db.progress_list(str(workspace), db, {"projectName": "Project"})["progressFolders"]}
        assert selection["id"] not in visible_ids
        missing_rows = workspace_db.progress_list(
            str(workspace), db, {"projectName": "Project", "includeMissing": True}
        )["progressFolders"]
        missing_selection = next(item for item in missing_rows if item["id"] == selection["id"])
        assert missing_selection["folderMissing"] and missing_selection["missingSince"]
        replacement_folder = project / "重新生成的选片"
        replacement_folder.mkdir()
        replacement = register(
            db, workspace, mediaKind="image", versionKey="selection-raw", displayName="RAW_选片",
            folderPath=str(replacement_folder), nodeRole="selection", relationKind="auxiliary",
            parentProgressId=original["id"], trackingEnabled=False, trackingState="disabled",
        )
        assert replacement["id"] == selection["id"] and not replacement["folderMissing"]

        stale_child = register(
            db, workspace, mediaKind="image", versionKey="v3", displayName="精修版",
            folderPath=str(stale_child_folder), nodeRole="progress", relationKind="main",
            parentProgressId=child["id"], trackingEnabled=True, renameFromParent=True,
            copyMissingFromParent=True, trackingState="ready",
        )
        saved_policy = workspace_db.progress_policy_save(db, {
            "progressId": stale_child["id"], "trackingEnabled": True,
            "renameFromParent": True, "copyMissingFromParent": True,
        })["progressFolder"]
        assert saved_policy["renameFromParent"] and saved_policy["copyMissingFromParent"]
        stale_candidates = workspace_db.progress_copy_missing_children(db, {"progressId": child["id"]})
        assert stale_candidates["progressIds"] == [stale_child["id"]]
        assert workspace_db.progress_mark_stale(db, {"progressId": stale_child["id"]})["progressFolder"]["trackingState"] == "stale"
        ready = workspace_db.progress_mark_ready(db, {
            "progressId": stale_child["id"], "trackingSnapshot": {"files": 42},
            "folderSignature": "sig-v3", "trackedAt": now + 100,
        })["progressFolder"]
        assert ready["trackingState"] == "ready" and ready["trackingSnapshot"] == {"files": 42}

        # Tombstone cleanup reconnects the surviving child and never touches media.
        media_file = child_folder / "keep.jpg"
        media_file.write_bytes(b"user-media")
        parent_folder.rmdir()
        workspace_db.progress_list(str(workspace), db, {"projectName": "Project"})
        db.execute("UPDATE progress_folders SET missing_since=1 WHERE id=?", (parent["id"],))
        db.commit()
        relations = workspace_db.progress_visible_relations(db, {"progressId": child["id"]})
        assert original["id"] in relations["visibleAncestorIds"] and parent["id"] not in relations["visibleAncestorIds"]
        db.close()
        maintenance = workspace_db.mutate(
            str(workspace), str(database), "maintenance_run", {"progressTombstoneCutoff": 1}
        )
        cleanup = maintenance["progressTombstones"]
        db = workspace_db.connect(str(workspace), str(database))
        assert cleanup["removedProgressIds"] == [parent["id"]] and cleanup["reparentedProgressCount"] == 1
        assert media_file.read_bytes() == b"user-media"
        reparented = db.execute("SELECT parent_progress_id,relation_kind FROM progress_folders WHERE id=?", (child["id"],)).fetchone()
        assert reparented[:] == (original["id"], "main")

        branch_ids = {item["id"] for item in workspace_db.progress_main_branch(db, {"progressId": child["id"]})["progressFolders"]}
        assert {original["id"], child["id"], stale_child["id"]} <= branch_ids
        assert selection["id"] not in branch_ids
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []

        # If a deleted original has a surviving child but no replacement parent,
        # maintenance preserves both relationship records for explicit repair
        # and never touches the real selection folder or its user media.
        orphan_source_folder = project / "孤立来源"
        orphan_selection_folder = project / "孤立来源_选片"
        orphan_source_folder.mkdir()
        orphan_selection_folder.mkdir()
        selected_media = orphan_selection_folder / "selected.jpg"
        selected_media.write_bytes(b"selected-user-media")
        orphan_source = register(
            db, workspace, mediaKind="image", versionKey="orphan-source", displayName="孤立来源",
            folderPath=str(orphan_source_folder), nodeRole="original", relationKind=None,
            parentProgressId=None, trackingEnabled=False, trackingState="disabled",
        )
        orphan_selection = register(
            db, workspace, mediaKind="image", versionKey="orphan-selection", displayName="孤立来源_选片",
            folderPath=str(orphan_selection_folder), nodeRole="selection", relationKind="auxiliary",
            parentProgressId=orphan_source["id"], trackingEnabled=False, trackingState="disabled",
        )
        orphan_source_folder.rmdir()
        workspace_db.progress_list(str(workspace), db, {"projectName": "Project"})
        db.execute("UPDATE progress_folders SET missing_since=1 WHERE id=?", (orphan_source["id"],))
        db.commit()
        db.close()
        orphan_maintenance = workspace_db.mutate(
            str(workspace), str(database), "maintenance_run", {"progressTombstoneCutoff": 1}
        )["progressTombstones"]
        db = workspace_db.connect(str(workspace), str(database))
        assert orphan_maintenance["removedProgressIds"] == []
        assert orphan_maintenance["removedSelectionMetadataIds"] == []
        assert orphan_source["id"] in orphan_maintenance["skippedProgressIds"]
        assert db.execute(
            "SELECT COUNT(*) FROM progress_folders WHERE id IN (?,?)",
            (orphan_source["id"], orphan_selection["id"]),
        ).fetchone()[0] == 2
        assert orphan_selection_folder.is_dir() and selected_media.read_bytes() == b"selected-user-media"
        listed_paths = {Path(item["folderPath"]) for item in workspace_db.progress_list(
            str(workspace), db, {"projectName": "Project", "includeMissing": True}
        )["progressFolders"]}
        assert orphan_selection_folder.resolve() in listed_paths
    finally:
        db.close()

    # Policies, snapshot, and last tracked state survive a real database reopen.
    reopened = workspace_db.connect(str(workspace), str(database))
    try:
        stored = workspace_db._progress_row_by_id(reopened, stale_child["id"])
        serialized = workspace_db.serialize_progress(stored)
        assert serialized["trackingEnabled"] and serialized["renameFromParent"] and serialized["copyMissingFromParent"]
        assert serialized["trackingState"] == "ready" and serialized["trackingSnapshot"] == {"files": 42}
        assert serialized["folderSignature"] == "sig-v3" and serialized["lastTrackedAt"] == now + 100
    finally:
        reopened.close()


def test_relation_update_transactions(root: Path) -> None:
    workspace = root / "relation-workspace"
    project = workspace / "Project"
    for name in ("RAW", "JPG", "MOV", "Source2", "P1", "P2", "P3", "Selection", "VideoProgress"):
        (project / name).mkdir(parents=True, exist_ok=True)
    database = root / "relations.sqlite3"
    db = workspace_db.connect(str(workspace), str(database))
    now = int(time.time() * 1000)
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES('relations-project','Project','后期中','Project',?,?)",
        (now, now),
    )
    db.commit()
    try:
        originals = workspace_db.progress_list(str(workspace), db, {"projectName": "Project"})["progressFolders"]
        raw = next(item for item in originals if item["displayName"] == "RAW")
        jpg = next(item for item in originals if item["displayName"] == "JPG")
        mov = next(item for item in originals if item["displayName"] == "MOV")
        source_two = workspace_db.progress_adopt_media(str(workspace), db, {
            "projectName": "Project", "folderPath": str(project / "Source2"), "mode": "original", "mediaKind": "image",
        })["progressFolder"]
        p1 = register(
            db, workspace, mediaKind="image", versionKey="p1", displayName="P1", folderPath=str(project / "P1"),
            nodeRole="progress", relationKind="main", parentProgressId=raw["id"], trackingEnabled=True,
            renameFromParent=True, copyMissingFromParent=True, trackingState="ready", trackingSnapshot={"old": True},
        )
        p2 = register(
            db, workspace, mediaKind="image", versionKey="p2", displayName="P2", folderPath=str(project / "P2"),
            nodeRole="progress", relationKind="main", parentProgressId=p1["id"], trackingEnabled=False, trackingState="disabled",
        )
        selection = register(
            db, workspace, mediaKind="image", versionKey="selection-raw", displayName="Selection", folderPath=str(project / "Selection"),
            nodeRole="selection", relationKind="auxiliary", parentProgressId=raw["id"], trackingEnabled=False, trackingState="disabled",
        )
        video_progress = register(
            db, workspace, mediaKind="video", versionKey="video-p1", displayName="VideoProgress", folderPath=str(project / "VideoProgress"),
            nodeRole="progress", relationKind="main", parentProgressId=mov["id"], trackingEnabled=False, trackingState="disabled",
        )

        moved = workspace_db.progress_relation_update(db, {
            "childProgressId": p1["id"], "parentProgressId": source_two["id"], "expectedUpdatedAt": p1["updatedAt"],
        })["progressFolder"]
        assert moved["parentProgressId"] == source_two["id"] and moved["relationKind"] == "main"
        assert moved["trackingState"] == "stale" and moved["trackingSnapshot"] == {}
        assert moved["renameFromParent"] and moved["copyMissingFromParent"]
        try:
            workspace_db.progress_relation_update(db, {
                "childProgressId": p2["id"], "parentProgressId": None, "expectedUpdatedAt": p2["updatedAt"],
            })
            raise AssertionError("progress detach must use explicit unregister")
        except ValueError as error:
            assert "progress_detach_requires_unregister" in str(error)
        unchanged_p2 = workspace_db.serialize_progress(workspace_db._progress_row_by_id(db, p2["id"]))
        assert unchanged_p2["parentProgressId"] == p1["id"] and unchanged_p2["relationKind"] == "main"
        moved_selection = workspace_db.progress_relation_update(db, {
            "childProgressId": selection["id"], "parentProgressId": source_two["id"], "expectedUpdatedAt": selection["updatedAt"],
        })["progressFolder"]
        assert moved_selection["parentProgressId"] == source_two["id"] and moved_selection["relationKind"] == "auxiliary"
        assert moved_selection["versionKey"] == f"selection-{source_two['id']}"

        def rejected(payload, code):
            before = tuple(db.execute(
                "SELECT parent_progress_id,relation_kind,version_key,tracking_state,updated_at FROM progress_folders WHERE id=?",
                (payload["childProgressId"],),
            ).fetchone())
            try:
                workspace_db.progress_relation_update(db, payload)
                raise AssertionError(f"expected {code}")
            except ValueError as error:
                assert code in str(error)
            after = tuple(db.execute(
                "SELECT parent_progress_id,relation_kind,version_key,tracking_state,updated_at FROM progress_folders WHERE id=?",
                (payload["childProgressId"],),
            ).fetchone())
            assert after == before, "failed relation transactions must not leave partial updates"

        rejected({"childProgressId": selection["id"], "parentProgressId": None}, "selection_parent_required")
        tracking = workspace_db.tracking_session_create(str(workspace), db, {
            "projectName": "Project", "progressId": p1["id"], "mode": "refresh",
        })
        rejected({"childProgressId": p1["id"], "parentProgressId": None}, "progress_detach_requires_unregister")
        unchanged_tracked = workspace_db.serialize_progress(workspace_db._progress_row_by_id(db, p1["id"]))
        assert unchanged_tracked["parentProgressId"] == source_two["id"] and unchanged_tracked["trackingEnabled"]
        assert db.execute("SELECT 1 FROM tracking_sessions WHERE id=?", (tracking["sessionId"],)).fetchone() is not None
        workspace_db.tracking_session_release(db, {"sessionId": tracking["sessionId"]})
        rejected({"childProgressId": raw["id"], "parentProgressId": jpg["id"]}, "original_parent_forbidden")
        rejected({"childProgressId": p2["id"], "parentProgressId": jpg["id"]}, "invalid_parent_role")
        rejected({"childProgressId": p2["id"], "parentProgressId": selection["id"]}, "invalid_parent_role")
        rejected({"childProgressId": p2["id"], "parentProgressId": video_progress["id"]}, "media_kind_mismatch")
        current_p1 = workspace_db.serialize_progress(workspace_db._progress_row_by_id(db, p1["id"]))
        current_p2 = workspace_db.serialize_progress(workspace_db._progress_row_by_id(db, p2["id"]))
        workspace_db.progress_relation_update(db, {"childProgressId": p2["id"], "parentProgressId": p1["id"], "expectedUpdatedAt": current_p2["updatedAt"]})
        rejected({"childProgressId": p1["id"], "parentProgressId": p2["id"]}, "cycle_detected")
        rejected({"childProgressId": p1["id"], "parentProgressId": raw["id"], "expectedUpdatedAt": p1["updatedAt"]}, "stale_update")
        p3 = register(
            db, workspace, mediaKind="image", versionKey="p3", displayName="P3", folderPath=str(project / "P3"),
            nodeRole="progress", relationKind="main", parentProgressId=p2["id"], trackingEnabled=False, trackingState="disabled",
        )
        saved_layout = workspace_db.version_tree_layout_save(db, {
            "projectName": "Project", "scopeKey": "", "expectedRevision": 0, "mode": "patch",
            "positions": [{"nodeKey": f"progress:{p2['id']}", "x": 120, "y": 240}],
        })
        assert saved_layout["revision"] == 1
        unregistered = workspace_db.progress_unregister(str(workspace), db, {
            "projectName": "Project", "progressId": p2["id"],
        })
        assert unregistered["success"] and unregistered["reparentedProgressCount"] == 1
        assert db.execute("SELECT 1 FROM progress_folders WHERE id=?", (p2["id"],)).fetchone() is None
        assert db.execute("SELECT parent_progress_id FROM progress_folders WHERE id=?", (p3["id"],)).fetchone()[0] == p1["id"]
        assert (project / "P2").is_dir(), "unregistering a version must never delete its physical folder"
        migrated_layout = workspace_db.version_tree_layout_get(db, {"projectName": "Project", "scopeKey": ""})
        assert migrated_layout["revision"] == 2, "unregister must advance layout revision instead of resetting it to zero"
        assert len(migrated_layout["positions"]) == 1
        assert migrated_layout["positions"][0]["nodeKey"] == "entry:P2"
        assert migrated_layout["positions"][0]["x"] == 120.0 and migrated_layout["positions"][0]["y"] == 240.0
    finally:
        db.close()


def test_schema_24_supplemental_graph_edges(root: Path) -> None:
    workspace = root / "schema-24-graph-workspace"
    project = workspace / "Project"
    other_project = workspace / "Other"
    for name in ("RAW", "Camera JPG", "MOV", "MOV Transcode", "Selection", "Workflow", "Progress", "Video Progress"):
        (project / name).mkdir(parents=True, exist_ok=True)
    (other_project / "Foreign RAW").mkdir(parents=True, exist_ok=True)
    db = workspace_db.connect(str(workspace), str(root / "schema-24-graph.sqlite3"))
    now = int(time.time() * 1000)
    db.executemany(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        [
            ("graph-project", "Project", "后期中", "Project", now, now),
            ("foreign-project", "Other", "后期中", "Other", now, now),
        ],
    )
    db.commit()

    def register(project_name: str, folder: Path, media_kind: str, version_key: str, node_role: str, **extra):
        return workspace_db.progress_register(str(workspace), db, {
            "projectName": project_name,
            "mediaKind": media_kind,
            "versionKey": version_key,
            "displayName": folder.name,
            "folderPath": str(folder),
            "nodeRole": node_role,
            "trackingEnabled": False,
            "trackingState": "disabled",
            **extra,
        })["progressFolder"]

    def rejected(callable_value, fragment: str):
        try:
            callable_value()
            raise AssertionError(f"expected rejection containing {fragment}")
        except (ValueError, sqlite3.IntegrityError) as error:
            assert fragment in str(error), str(error)

    try:
        raw = register("Project", project / "RAW", "image", "raw", "original")
        camera_jpg = register("Project", project / "Camera JPG", "image", "camera-jpg", "original", artifactKind="companion")
        mov = register("Project", project / "MOV", "video", "mov", "original")
        mov_transcode = register("Project", project / "MOV Transcode", "video", "mov-transcode", "artifact", artifactKind="transcode")
        progress = register("Project", project / "Progress", "image", "1", "progress", parentProgressId=raw["id"], relationKind="main")
        selection = register("Project", project / "Selection", "image", "selection", "selection", parentProgressId=raw["id"], relationKind="auxiliary")
        workflow = register("Project", project / "Workflow", "image", "workflow", "workflow", artifactKind="component_workspace")
        video_progress = register("Project", project / "Video Progress", "video", "video-1", "progress", parentProgressId=mov["id"], relationKind="main")
        foreign_raw = register("Other", other_project / "Foreign RAW", "image", "foreign-raw", "original")

        assert mov_transcode["artifactKind"] == "transcode" and mov_transcode["parentProgressId"] is None
        assert workflow["artifactKind"] == "component_workspace" and workflow["parentProgressId"] is None
        for node in (mov_transcode, workflow, selection):
            assert not node["trackingEnabled"] and not node["renameFromParent"] and not node["copyMissingFromParent"]

        companion = workspace_db.version_graph_edge_create(db, {
            "projectId": "graph-project", "sourceProgressId": raw["id"],
            "targetProgressId": camera_jpg["id"], "edgeKind": "media_companion",
        })["edge"]
        transcode_edge = workspace_db.version_graph_edge_create(db, {
            "projectId": "graph-project", "sourceProgressId": mov["id"],
            "targetProgressId": mov_transcode["id"], "edgeKind": "derived_transcode",
        })["edge"]
        workflow_edge = workspace_db.version_graph_edge_create(db, {
            "projectId": "graph-project", "sourceProgressId": selection["id"],
            "targetProgressId": progress["id"], "edgeKind": "workflow_input",
        })["edge"]
        assert {item["id"] for item in workspace_db.version_graph_edge_list(db, {"projectId": "graph-project"})["edges"]} == {
            companion["id"], transcode_edge["id"], workflow_edge["id"],
        }
        assert db.execute("SELECT COUNT(*) FROM version_graph_edges WHERE edge_kind IN ('main','auxiliary')").fetchone()[0] == 0
        assert db.execute("SELECT parent_progress_id FROM progress_folders WHERE id=?", (progress["id"],)).fetchone()[0] == raw["id"]
        main_branch_ids = {item["id"] for item in workspace_db.progress_main_branch(db, {"progressId": raw["id"]})["progressFolders"]}
        assert camera_jpg["id"] not in main_branch_ids, "media companions must not enter the tracking chain"

        rejected(lambda: workspace_db.version_graph_edge_create(db, {
            "projectId": "graph-project", "sourceProgressId": raw["id"],
            "targetProgressId": camera_jpg["id"], "edgeKind": "media_companion",
        }), "duplicate")
        rejected(lambda: workspace_db.version_graph_edge_create(db, {
            "projectId": "graph-project", "sourceProgressId": raw["id"],
            "targetProgressId": camera_jpg["id"], "edgeKind": "media_companion", "folderPath": "C:/forbidden",
        }), "只能提交项目 ID")
        rejected(lambda: workspace_db.version_graph_edge_create(db, {
            "projectId": "graph-project", "sourceProgressId": raw["id"],
            "targetProgressId": foreign_raw["id"], "edgeKind": "media_companion",
        }), "project_mismatch")
        rejected(lambda: workspace_db.version_graph_edge_create(db, {
            "projectId": "graph-project", "sourceProgressId": raw["id"],
            "targetProgressId": mov_transcode["id"], "edgeKind": "derived_transcode",
        }), "media_mismatch")
        rejected(lambda: workspace_db.version_graph_edge_create(db, {
            "projectId": "graph-project", "sourceProgressId": raw["id"],
            "targetProgressId": progress["id"], "edgeKind": "derived_preview",
        }), "role_invalid")
        rejected(lambda: workspace_db.version_graph_edge_create(db, {
            "projectId": "graph-project", "sourceProgressId": workflow["id"],
            "targetProgressId": raw["id"], "edgeKind": "workflow_input",
        }), "role_invalid")
        rejected(lambda: workspace_db.progress_relation_update(db, {
            "childProgressId": selection["id"], "parentProgressId": progress["id"],
            "expectedUpdatedAt": selection["updatedAt"],
        }), "cycle_detected")
        rejected(lambda: db.execute(
            "UPDATE progress_folders SET parent_progress_id=?,relation_kind='auxiliary' WHERE id=?",
            (progress["id"], selection["id"]),
        ), "version graph cycle")
        rejected(lambda: db.execute(
            """INSERT INTO version_graph_edges(
                 id,project_id,source_progress_id,target_progress_id,edge_kind,created_at,updated_at)
               VALUES('invalid-cross-project','graph-project',?,?,'media_companion',?,?)""",
            (raw["id"], foreign_raw["id"], now, now),
        ), "invalid version graph edge")
        rejected(lambda: db.execute(
            "UPDATE progress_folders SET tracking_enabled=1,tracking_state='ready' WHERE id=?",
            (mov_transcode["id"],),
        ), "invalid V3 tracking policy")
        rejected(lambda: db.execute(
            "UPDATE progress_folders SET node_role='progress',artifact_kind=NULL WHERE id=?",
            (mov_transcode["id"],),
        ), "invalid version graph endpoint update")
        rejected(lambda: workspace_db.progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "bad-artifact",
            "displayName": "bad artifact", "folderPath": str(project / "RAW"),
            "nodeRole": "artifact", "artifactKind": "preview", "trackingEnabled": True,
        }), "禁止开启版本跟踪")

        db.execute(
            """INSERT INTO media_import_artifact_slots(
                 project_id,progress_id,import_slot,relative_path_key,created_at,updated_at)
               VALUES(?,?,?,?,?,?)""",
            ("graph-project", mov_transcode["id"], "video_transcode", "explicit-transcode-slot", now, now),
        )
        rejected(lambda: db.execute(
            """INSERT INTO media_import_artifact_slots(
                 project_id,progress_id,import_slot,relative_path_key,created_at,updated_at)
               VALUES(?,?,?,?,?,?)""",
            ("foreign-project", raw["id"], "raw", "foreign-slot", now, now),
        ), "project mismatch")

        tracked_progress = workspace_db.progress_register_with_graph(str(workspace), db, {
            "projectName": "Project",
            "progress": {
                "progressId": progress["id"], "mediaKind": "image", "versionKey": "1",
                "displayName": "Progress", "folderPath": str(project / "Progress"),
                "parentProgressId": raw["id"], "relationKind": "main",
                "trackingEnabled": True, "trackingState": "ready",
                "renameFromParent": True, "copyMissingFromParent": True,
            },
            "workflowInputProgressIds": [selection["id"]],
        })["progressFolder"]
        assert db.execute(
            """SELECT 1 FROM version_graph_edges WHERE source_progress_id=?
               AND target_progress_id=? AND edge_kind='workflow_input'""",
            (selection["id"], tracked_progress["id"]),
        ).fetchone() is not None, "connecting original material to V1 must create the matching selection input"
        tracking = workspace_db.tracking_session_create(str(workspace), db, {
            "projectName": "Project", "progressId": tracked_progress["id"], "mode": "refresh",
        })
        rejected(lambda: workspace_db.progress_register_with_graph(str(workspace), db, {
            "projectName": "Project",
            "progress": {
                "progressId": progress["id"], "mediaKind": "image", "versionKey": "1",
                "displayName": "Progress", "folderPath": str(project / "Progress"),
                "parentProgressId": raw["id"], "relationKind": "main",
                "trackingEnabled": False, "trackingState": "disabled",
                "renameFromParent": False, "copyMissingFromParent": False,
            },
            "workflowInputProgressIds": [],
        }), "node_busy")
        workspace_db.tracking_session_release(db, {"sessionId": tracking["sessionId"]})
        rejected(lambda: workspace_db.progress_register_with_graph(str(workspace), db, {
            "projectName": "Project",
            "progress": {
                "progressId": progress["id"], "mediaKind": "image", "versionKey": "1",
                "displayName": "Progress", "folderPath": str(project / "Progress"),
                "trackingEnabled": False, "trackingState": "disabled",
                "renameFromParent": False, "copyMissingFromParent": False,
            },
            "workflowInputProgressIds": [],
        }), "progress_detach_requires_unregister")
        still_attached = workspace_db.serialize_progress(workspace_db._progress_row_by_id(db, progress["id"]))
        assert still_attached["parentProgressId"] == raw["id"], "a rejected update must preserve the valid structural parent"
        workspace_db.progress_unregister(str(workspace), db, {"projectName": "Project", "progressId": progress["id"]})
        assert (project / "Progress").is_dir(), "explicit unregister must preserve the physical folder"
        assert db.execute("SELECT 1 FROM progress_folders WHERE id=?", (progress["id"],)).fetchone() is None
        assert db.execute(
            """SELECT 1 FROM version_graph_edges WHERE source_progress_id=?
               AND target_progress_id=? AND edge_kind='workflow_input'""",
            (selection["id"], progress["id"]),
        ).fetchone() is None, "explicit unregister must remove derived selection inputs"
        assert db.execute("SELECT 1 FROM tracking_sessions WHERE id=?", (tracking["sessionId"],)).fetchone() is None

        db.execute("DELETE FROM progress_folders WHERE id=?", (mov_transcode["id"],))
        db.commit()
        assert db.execute("SELECT 1 FROM version_graph_edges WHERE id=?", (transcode_edge["id"],)).fetchone() is None
        assert db.execute("SELECT 1 FROM media_import_artifact_slots WHERE progress_id=?", (mov_transcode["id"],)).fetchone() is None
        workspace_db.version_graph_edge_delete(db, {
            "projectId": "graph-project", "sourceProgressId": raw["id"],
            "targetProgressId": camera_jpg["id"], "edgeKind": "media_companion",
        })
        assert db.execute("SELECT 1 FROM version_graph_edges WHERE id=?", (companion["id"],)).fetchone() is None
        repeated_delete = workspace_db.version_graph_edge_delete(db, {
            "projectId": "graph-project", "sourceProgressId": raw["id"],
            "targetProgressId": camera_jpg["id"], "edgeKind": "media_companion",
        })
        assert repeated_delete["success"], "deleting an already absent supplemental edge must be idempotent"
    finally:
        db.close()


def test_legacy_selection_relation_repair(root: Path) -> None:
    workspace = root / "legacy-selection-repair-workspace"
    project = workspace / "Project"
    for name in ("RAW", "图片选片", "RAW_选片", "第二图片选片"):
        (project / name).mkdir(parents=True, exist_ok=True)
    database = root / "legacy-selection-repair.sqlite3"
    db = workspace_db.connect(str(workspace), str(database))
    now = int(time.time() * 1000)
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES('legacy-repair-project','Project','后期中','Project',?,?)",
        (now, now),
    )
    db.commit()
    try:
        raw = next(item for item in workspace_db.progress_list(str(workspace), db, {"projectName": "Project"})["progressFolders"] if item["displayName"] == "RAW")
        legacy = register(
            db, workspace, mediaKind="image", versionKey="0", displayName="图片选片", folderPath=str(project / "图片选片"),
            nodeRole="original", trackingEnabled=False, trackingState="disabled",
        )
        modern = register(
            db, workspace, mediaKind="image", versionKey=f"selection-{raw['id']}", displayName="RAW_选片", folderPath=str(project / "RAW_选片"),
            nodeRole="selection", relationKind="auxiliary", parentProgressId=raw["id"], trackingEnabled=False, trackingState="disabled",
        )
        db.execute(
            """INSERT INTO legacy_selection_relation_repairs(
                 progress_id,project_id,legacy_name,expected_source_name,reason,candidate_ids_json,created_at)
               VALUES(?,?,?,?,?,?,?)""",
            (legacy["id"], raw["projectId"], "图片选片", "RAW", "selection_already_exists", json.dumps([modern["id"]]), now),
        )
        db.commit()
        listed = workspace_db.progress_list(str(workspace), db, {"projectName": "Project"})
        assert listed["legacySelectionRelationRepairs"] == [{
            "progressId": legacy["id"], "projectId": raw["projectId"], "legacyName": "图片选片",
            "expectedSourceName": "RAW", "reason": "selection_already_exists", "candidateIds": [modern["id"]],
        }]
        repaired = workspace_db.progress_legacy_selection_repair(db, {
            "progressId": legacy["id"], "sourceProgressId": raw["id"],
        })["progressFolder"]
        assert repaired["id"] == legacy["id"] and repaired["displayName"] == "图片选片"
        assert repaired["nodeRole"] == "selection" and repaired["relationKind"] == "auxiliary"
        assert repaired["parentProgressId"] == raw["id"] and repaired["versionKey"] == f"legacy-selection-{legacy['id']}"
        assert not repaired["trackingEnabled"] and not repaired["renameFromParent"] and not repaired["copyMissingFromParent"]
        assert (project / "图片选片").is_dir() and (project / "RAW_选片").is_dir()
        assert workspace_db.progress_list(str(workspace), db, {"projectName": "Project"})["legacySelectionRelationRepairs"] == []

        second = register(
            db, workspace, mediaKind="image", versionKey="0", displayName="第二图片选片", folderPath=str(project / "第二图片选片"),
            nodeRole="original", trackingEnabled=False, trackingState="disabled",
        )
        db.execute(
            """INSERT INTO legacy_selection_relation_repairs(
                 progress_id,project_id,legacy_name,expected_source_name,reason,candidate_ids_json,created_at)
               VALUES(?,?,?,?,?,'[]',?)""",
            (second["id"], raw["projectId"], "图片选片", "RAW", "source_missing", now + 1),
        )
        db.commit()
        before = tuple(db.execute("SELECT node_role,parent_progress_id,relation_kind,version_key FROM progress_folders WHERE id=?", (second["id"],)).fetchone())
        try:
            workspace_db.progress_legacy_selection_repair(db, {"progressId": second["id"], "sourceProgressId": modern["id"]})
            raise AssertionError("selection source must be rejected")
        except ValueError as error:
            assert "legacy_selection_repair_source_invalid" in str(error)
        after = tuple(db.execute("SELECT node_role,parent_progress_id,relation_kind,version_key FROM progress_folders WHERE id=?", (second["id"],)).fetchone())
        assert after == before, "failed legacy repair must not leave a partial relationship update"
        assert db.execute("SELECT 1 FROM legacy_selection_relation_repairs WHERE progress_id=?", (second["id"],)).fetchone()
        assert (project / "第二图片选片").is_dir(), "failed repair must not delete the physical folder"
        kept = workspace_db.progress_legacy_selection_repair(db, {
            "progressId": second["id"], "action": "keep-independent",
        })
        assert kept["keptIndependent"] is True
        kept_after = tuple(db.execute("SELECT node_role,parent_progress_id,relation_kind,version_key FROM progress_folders WHERE id=?", (second["id"],)).fetchone())
        assert kept_after == before, "keeping an independent node must not rewrite its role or relationship"
        assert db.execute("SELECT 1 FROM legacy_selection_relation_repairs WHERE progress_id=?", (second["id"],)).fetchone() is None
        assert db.execute("SELECT 1 FROM project_properties WHERE project_id=? AND key=?", (raw["projectId"], f"legacy_selection_independent:{second['id']}")).fetchone()
        assert workspace_db.progress_list(str(workspace), db, {"projectName": "Project"})["legacySelectionRelationRepairs"] == []
        assert (project / "第二图片选片").is_dir(), "keeping an independent node must preserve the physical folder"
    finally:
        db.close()


def test_version_tree_layout_persistence(root: Path) -> None:
    workspace = root / "layout-workspace"
    project = workspace / "Project"
    for name in ("RAW", "P1", "P2", "Other"):
        (project / name).mkdir(parents=True, exist_ok=True)
    database = root / "layout.sqlite3"
    db = workspace_db.connect(str(workspace), str(database))
    now = int(time.time() * 1000)
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES('layout-project','Project','后期中','Project',?,?)",
        (now, now),
    )
    db.commit()
    try:
        raw = next(item for item in workspace_db.progress_list(str(workspace), db, {"projectName": "Project"})["progressFolders"] if item["displayName"] == "RAW")
        p1 = register(
            db, workspace, mediaKind="image", versionKey="p1", displayName="P1", folderPath=str(project / "P1"),
            nodeRole="progress", relationKind="main", parentProgressId=raw["id"], trackingEnabled=False, trackingState="disabled",
        )
        p2 = register(
            db, workspace, mediaKind="image", versionKey="1_1", displayName="P2", folderPath=str(project / "P2"),
            nodeRole="progress", relationKind="main", parentProgressId=p1["id"], trackingEnabled=False, trackingState="disabled",
        )
        saved = workspace_db.version_tree_layout_save(db, {
            "projectName": "Project", "scopeKey": "", "expectedRevision": 0, "mode": "patch",
            "positions": [
                {"nodeKey": f"progress:{raw['id']}", "x": 10.5, "y": 20.25},
                {"nodeKey": f"progress:{p1['id']}", "x": 250, "y": 30},
                {"nodeKey": f"progress:{p2['id']}", "x": 500, "y": 100},
                {"nodeKey": "entry:other", "x": 20, "y": 400},
            ],
        })
        assert saved["revision"] == 1
        loaded = workspace_db.version_tree_layout_get(db, {"projectName": "Project", "scopeKey": ""})
        assert loaded["revision"] == 1
        assert {(item["nodeKey"], item["x"], item["y"]) for item in loaded["positions"]} == {
            (f"progress:{raw['id']}", 10.5, 20.25), (f"progress:{p1['id']}", 250.0, 30.0),
            (f"progress:{p2['id']}", 500.0, 100.0),
            ("entry:other", 20.0, 400.0),
        }
        patched = workspace_db.version_tree_layout_save(db, {
            "projectName": "Project", "scopeKey": "", "expectedRevision": 1, "mode": "patch",
            "positions": [{"nodeKey": f"progress:{p1['id']}", "x": 275, "y": 45}],
        })
        assert patched["revision"] == 2
        assert len(workspace_db.version_tree_layout_get(db, {"projectName": "Project", "scopeKey": ""})["positions"]) == 4
        replaced = workspace_db.version_tree_layout_save(db, {
            "projectName": "Project", "scopeKey": "", "expectedRevision": 2, "mode": "replace",
            "positions": [{"nodeKey": f"progress:{raw['id']}", "x": 0, "y": 0}],
        })
        assert replaced["revision"] == 3
        before = [tuple(row) for row in db.execute(
            "SELECT node_key,x,y FROM version_tree_node_positions WHERE project_id='layout-project' ORDER BY node_key"
        ).fetchall()]

        def rejected(payload, code):
            try:
                workspace_db.version_tree_layout_save(db, payload)
                raise AssertionError(f"expected {code}")
            except ValueError as error:
                assert code in str(error)
            after = [tuple(row) for row in db.execute(
                "SELECT node_key,x,y FROM version_tree_node_positions WHERE project_id='layout-project' ORDER BY node_key"
            ).fetchall()]
            assert after == before, "failed layout save must not leave partial positions"

        rejected({"projectName": "Project", "scopeKey": "", "expectedRevision": 2, "mode": "replace", "positions": []}, "stale_layout")
        rejected({"projectName": "Project", "scopeKey": "../outside", "expectedRevision": 3, "mode": "patch", "positions": []}, "version_tree_scope_invalid")
        rejected({"projectName": "Project", "scopeKey": "C:/outside", "expectedRevision": 3, "mode": "patch", "positions": []}, "version_tree_scope_invalid")
        rejected({"projectName": "Project", "scopeKey": "", "expectedRevision": 3, "mode": "patch", "positions": [{"nodeKey": f"progress:{raw['id']}", "x": float("nan"), "y": 0}]}, "version_tree_layout_coordinate_invalid")
        rejected({"projectName": "Project", "scopeKey": "", "expectedRevision": 3, "mode": "patch", "positions": [{"nodeKey": "progress:foreign", "x": 0, "y": 0}]}, "version_tree_layout_node_invalid")
        rejected({"projectName": "Project", "scopeKey": "", "expectedRevision": 3, "mode": "patch", "positions": [{"nodeKey": "entry:folder/other", "x": 0, "y": 0}]}, "version_tree_layout_node_invalid")
        rejected({"projectName": "Project", "scopeKey": "folder", "expectedRevision": 0, "mode": "patch", "positions": [{"nodeKey": "entry:../outside", "x": 0, "y": 0}]}, "version_tree_layout_node_invalid")
        rejected({"projectName": "Project", "scopeKey": "", "expectedRevision": 3, "mode": "patch", "positions": [{"nodeKey": f"progress:{raw['id']}", "x": 0, "y": 0}] * 1001}, "version_tree_layout_positions_invalid")

        db.execute(
            "INSERT INTO version_tree_node_positions(project_id,scope_key,node_key,x,y,updated_at) VALUES('layout-project','','progress:gone',1,2,?)",
            (now,),
        )
        db.commit()
        cleaned = workspace_db.version_tree_layout_get(db, {"projectName": "Project", "scopeKey": ""})
        assert all(item["nodeKey"] != "progress:gone" for item in cleaned["positions"])
        assert db.execute("SELECT 1 FROM version_tree_node_positions WHERE node_key='progress:gone'").fetchone() is not None, \
            "layout reads must filter stale positions without taking a SQLite writer lock"

        db.execute("DELETE FROM projects WHERE id='layout-project'")
        db.commit()
        assert db.execute("SELECT 1 FROM version_tree_layouts WHERE project_id='layout-project'").fetchone() is None
        assert db.execute("SELECT 1 FROM version_tree_node_positions WHERE project_id='layout-project'").fetchone() is None
    finally:
        db.close()


def test_legacy_selection_keep_independent_is_durable(root: Path) -> None:
    workspace = root / "legacy-selection-independent-workspace"
    project = workspace / "Project"
    legacy_folder = project / "图片选片"
    legacy_folder.mkdir(parents=True)
    database = root / "legacy-selection-independent.sqlite3"
    db = workspace_db.connect(str(workspace), str(database))
    now = int(time.time() * 1000)
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES('legacy-independent-project','Project','后期中','Project',?,?)",
        (now, now),
    )
    db.commit()
    try:
        legacy = workspace_db.progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "0",
            "displayName": "图片选片（原图）", "folderPath": str(legacy_folder),
            "nodeRole": "original", "trackingEnabled": False, "trackingState": "disabled",
        })["progressFolder"]
        listed = workspace_db.progress_list(str(workspace), db, {"projectName": "Project"})
        assert listed["legacySelectionRelationRepairs"][0]["reason"] == "source_missing"
        kept = workspace_db.progress_legacy_selection_repair(db, {
            "progressId": legacy["id"], "action": "keep-independent",
        })
        assert kept["keptIndependent"] is True
        reloaded = workspace_db.progress_list(str(workspace), db, {"projectName": "Project"})
        assert reloaded["legacySelectionRelationRepairs"] == [], "dismissed legacy repair must not be recreated on reload"
        unchanged = next(folder for folder in reloaded["progressFolders"] if folder["id"] == legacy["id"])
        assert unchanged["nodeRole"] == "original" and unchanged["parentProgressId"] is None and unchanged["versionKey"] == "0"
        assert legacy_folder.is_dir(), "independent resolution must never move or delete the legacy folder"
    finally:
        db.close()


def test_external_link_payload_cannot_authorize_outside_folder(root: Path) -> None:
    workspace = root / "external-rejected-workspace"
    project = workspace / "Project"
    project.mkdir(parents=True)
    outside = root / "outside-rejected"
    outside.mkdir()
    db = workspace_db.connect(str(workspace), str(root / "external-rejected.sqlite3"))
    now = int(time.time() * 1000)
    db.execute("INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES('rejected-project','Project','后期中','Project',?,?)", (now, now))
    db.commit()
    try:
        for payload in (
            {"projectName": "Project", "folderPath": str(outside), "mode": "original", "mediaKind": "image"},
            {"projectName": "Project", "folderPath": str(outside), "externalLinkRelativePath": "Outside.lnk", "mode": "original", "mediaKind": "image"},
        ):
            try:
                workspace_db.progress_adopt_media(str(workspace), db, payload)
                raise AssertionError("outside folders must not be adopted through old link payloads")
            except ValueError:
                pass
        assert db.execute("SELECT COUNT(*) FROM progress_folders").fetchone()[0] == 0
    finally:
        db.close()


def test_folder_purposes_and_legacy_orphan_survive_reload(root: Path) -> None:
    workspace = root / "folder-purpose-workspace"
    project = workspace / "Project"
    original_folder = project / "Original"
    progress_folder = project / "Progress"
    selection_folder = project / "Selection"
    broll_folder = project / "Behind the scenes"
    companion_folder = project / "Companion"
    artifact_folder = project / "Artifact"
    workflow_folder = project / "Workflow"
    orphan_folder = project / "Legacy orphan"
    for folder in (original_folder, progress_folder, selection_folder, broll_folder, companion_folder, artifact_folder, workflow_folder, orphan_folder):
        folder.mkdir(parents=True)
    (broll_folder / "still.jpg").write_bytes(b"still")
    (broll_folder / "clip.mp4").write_bytes(b"clip")
    database = root / "folder-purpose.sqlite3"
    db = workspace_db.connect(str(workspace), str(database))
    now = int(time.time() * 1000)
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES('folder-purpose-project','Project','后期中','Project',?,?)",
        (now, now),
    )
    db.commit()
    try:
        original = workspace_db.progress_adopt_media(str(workspace), db, {
            "projectName": "Project", "folderPath": str(original_folder),
            "mode": "original", "mediaKind": "image",
        })["progressFolder"]
        selection = workspace_db.progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": f"selection-{original['id']}",
            "displayName": "Selection", "folderPath": str(selection_folder), "nodeRole": "selection",
            "parentProgressId": original["id"], "relationKind": "auxiliary", "trackingEnabled": False,
        })["progressFolder"]
        try:
            workspace_db.progress_register(str(workspace), db, {
                "projectName": "Project", "progressId": selection["id"], "mediaKind": "image", "versionKey": selection["versionKey"],
                "displayName": "Selection", "folderPath": str(selection_folder),
                "parentProgressId": original["id"], "relationKind": "main", "trackingEnabled": False,
            })
            raise AssertionError("generic progress registration must not convert a selection role")
        except ValueError as error:
            assert "progress_role_change_forbidden" in str(error)
        assert workspace_db._progress_row_by_id(db, selection["id"])["node_role"] == "selection"
        broll_result = workspace_db.progress_adopt_media(str(workspace), db, {
            "projectName": "Project", "folderPath": str(broll_folder),
            "mode": "broll", "mediaKind": "mixed",
        })
        broll = broll_result["progressFolder"]
        assert broll["nodeRole"] == "broll" and broll["mediaKind"] == "mixed"
        assert broll.get("parentProgressId") is None and broll.get("relationKind") is None and broll.get("artifactKind") is None
        assert not broll["trackingEnabled"] and broll["trackingState"] == "disabled"
        try:
            workspace_db.progress_policy_save(db, {
                "progressId": broll["id"], "trackingEnabled": True,
            })
            raise AssertionError("broll tracking must be rejected")
        except ValueError as error:
            assert "broll" in str(error)
        repeated = workspace_db.progress_adopt_media(str(workspace), db, {
            "projectName": "Project", "folderPath": str(broll_folder),
            "mode": "broll", "mediaKind": "mixed",
        })
        assert repeated["created"] is False and repeated["progressFolder"]["id"] == broll["id"]
        companion = workspace_db.progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "companion",
            "displayName": "Companion", "folderPath": str(companion_folder), "nodeRole": "original",
            "artifactKind": "companion", "trackingEnabled": False,
        })["progressFolder"]
        artifact = workspace_db.progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "artifact",
            "displayName": "Artifact", "folderPath": str(artifact_folder), "nodeRole": "artifact",
            "artifactKind": "preview", "trackingEnabled": False,
        })["progressFolder"]
        workflow = workspace_db.progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "workflow",
            "displayName": "Workflow", "folderPath": str(workflow_folder), "nodeRole": "workflow",
            "artifactKind": "component_workspace", "trackingEnabled": False,
        })["progressFolder"]
        progress = workspace_db.progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "1",
            "displayName": "Progress", "folderPath": str(progress_folder), "nodeRole": "progress",
            "parentProgressId": original["id"], "relationKind": "main", "trackingEnabled": False,
        })["progressFolder"]
        root_progress = workspace_db.progress_register_with_graph(str(workspace), db, {
            "projectName": "Project",
            "progress": {
                "mediaKind": "image", "versionKey": "2", "displayName": "Legacy orphan",
                "folderPath": str(orphan_folder), "trackingEnabled": True,
                "trackingState": "pending_compare",
            },
            "workflowInputProgressIds": [],
        })["progressFolder"]
        assert root_progress["parentProgressId"] is None and root_progress["relationKind"] is None
        try:
            workspace_db.progress_policy_save(db, {"progressId": root_progress["id"], "renameFromParent": True})
            raise AssertionError("root progress must reject parent-only policies")
        except ValueError as error:
            assert "根版本" in str(error)
        workspace_db.batch_register_baseline(str(workspace), db, {
            "projectName": "Project", "folderPath": str(orphan_folder),
        })
        assert workspace_db._progress_row_by_id(db, root_progress["id"])["tracking_state"] == "ready"
        assert root_progress["id"] not in workspace_db.progress_stale_prepare(str(workspace), db, {"projectName": "Project"})["staleProgressIds"]
        (orphan_folder / "new.jpg").write_bytes(b"new-media")
        stale = workspace_db.progress_stale_prepare(str(workspace), db, {"projectName": "Project"})
        assert root_progress["id"] in stale["staleProgressIds"]
        workspace_db.progress_stale_apply(str(workspace), db, stale)
        assert workspace_db._progress_row_by_id(db, root_progress["id"])["tracking_state"] == "stale"
        workspace_db.batch_register_baseline(str(workspace), db, {
            "projectName": "Project", "folderPath": str(orphan_folder),
        })
        assert workspace_db._progress_row_by_id(db, root_progress["id"])["tracking_state"] == "ready"
        assert root_progress["id"] not in workspace_db.progress_stale_prepare(str(workspace), db, {"projectName": "Project"})["staleProgressIds"]
        child_folder = project / "Root child"
        child_folder.mkdir()
        child = workspace_db.progress_register_with_graph(str(workspace), db, {
            "projectName": "Project",
            "progress": {
                "mediaKind": "image", "versionKey": "3", "displayName": "Root child",
                "folderPath": str(child_folder), "parentProgressId": root_progress["id"],
                "trackingEnabled": True, "trackingState": "pending_compare",
            },
            "workflowInputProgressIds": [],
        })["progressFolder"]
        session = workspace_db.tracking_session_create(str(workspace), db, {
            "projectName": "Project", "progressId": child["id"], "mode": "compare",
        })
        prepared = workspace_db.tracking_prepare(str(workspace), db, {
            "projectName": "Project", "progressId": child["id"],
            "mode": "compare", "sessionId": session["sessionId"],
        })
        assert prepared["parentProgressId"] == root_progress["id"]
        workspace_db.tracking_session_release(db, {"sessionId": session["sessionId"]})
        root_preview_edge = workspace_db.version_graph_edge_create(db, {
            "projectId": "folder-purpose-project", "sourceProgressId": root_progress["id"],
            "targetProgressId": artifact["id"], "edgeKind": "derived_preview",
        })["edge"]
        workspace_db._check_integrity(db, force=True)
        cleanup = workspace_db.cleanup_media_workflow_graph(str(workspace), db, session_cutoff=0)
        assert root_preview_edge["id"] not in cleanup["removedEdgeIds"]
        for invalid in (broll, selection, companion, artifact, workflow):
            try:
                workspace_db.progress_main_branch_media(db, {"progressId": invalid["id"]})
                raise AssertionError(f"invalid main-branch progress was accepted: {invalid['id']}")
            except ValueError as error:
                assert "main_branch_progress_invalid" in str(error)
        assert workspace_db.progress_main_branch_media(db, {"progressId": original["id"]})["progressId"] == original["id"]
        assert workspace_db.progress_main_branch_media(db, {"progressId": progress["id"]})["progressId"] == progress["id"]
        assert workspace_db.progress_main_branch_media(db, {"progressId": root_progress["id"]})["progressId"] == root_progress["id"]
        first = workspace_db.progress_list(str(workspace), db, {"projectName": "Project"})["progressFolders"]
        second = workspace_db.progress_list(str(workspace), db, {"projectName": "Project"})["progressFolders"]
        assert {item["id"] for item in first} == {item["id"] for item in second}
        assert any(item["id"] == root_progress["id"] and item.get("parentProgressId") is None for item in second)
        assert any(item["id"] == progress["id"] and item["parentProgressId"] == original["id"] for item in second)
        assert not db.execute(
            "SELECT 1 FROM version_graph_edges WHERE source_progress_id=? OR target_progress_id=?",
            (broll["id"], broll["id"]),
        ).fetchone()
    finally:
        db.close()

    reopened = workspace_db.connect(str(workspace), str(database))
    try:
        reloaded = workspace_db.progress_list(str(workspace), reopened, {"projectName": "Project"})["progressFolders"]
        by_id = {item["id"]: item for item in reloaded}
        assert by_id[broll["id"]]["nodeRole"] == "broll" and by_id[broll["id"]]["mediaKind"] == "mixed"
        assert by_id[root_progress["id"]]["nodeRole"] == "progress" and by_id[root_progress["id"]].get("parentProgressId") is None, "ordinary reload must retain root progress"
        assert by_id[child["id"]]["parentProgressId"] == root_progress["id"], "ordinary reload must retain the child's root connection"
        assert broll_folder.is_dir() and (broll_folder / "still.jpg").is_file() and (broll_folder / "clip.mp4").is_file()
        assert orphan_folder.is_dir(), "repair handling must not delete user folders"
    finally:
        reopened.close()


def test_camera_jpg_selection_source(root: Path) -> None:
    for detached in (False, True):
        workspace = root / f"jpg-selection-{detached}"
        project = workspace / "Project"
        for name in ("RAW", "jpg", "jpg_选片", "Version"):
            (project / name).mkdir(parents=True)
        database = root / f"jpg-selection-{detached}.sqlite3"
        connection_options = {"include_domains": True if detached else ()}
        db = workspace_db.connect(str(workspace), str(database), **connection_options)
        now = int(time.time() * 1000)
        db.execute(
            "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES('jpg-project','Project','后期中','Project',?,?)",
            (now, now),
        )
        db.commit()
        try:
            nodes = workspace_db.progress_list(str(workspace), db, {"projectName": "Project"})["progressFolders"]
            raw = next(node for node in nodes if node["displayName"].lower() == "raw")
            jpg = next(node for node in nodes if node["displayName"].lower() == "jpg")
            assert jpg["nodeRole"] == "original" and jpg["artifactKind"] == "companion"
            # Reopen a database with the old parent guard to exercise upgrades
            # in both the core and the detached versioning database.
            owner = "versioning" if detached else "main"
            trigger_name = "progress_folders_parent_validate_insert"
            trigger_sql = db.execute(
                f'SELECT sql FROM "{owner}".sqlite_master WHERE name=?', (trigger_name,),
            ).fetchone()[0]
            old_trigger_sql = trigger_sql.replace(
                "parent.artifact_kind='companion' AND NEW.node_role='selection'", "0 AND NEW.node_role='selection'",
            )
            db.execute(f'DROP TRIGGER "{owner}".{trigger_name}')
            db.execute(old_trigger_sql.replace("CREATE TRIGGER ", f'CREATE TRIGGER "{owner}".', 1))
            workspace_db._set_meta(db, "progress_purpose_constraint_revision", "2")
            db.commit()
            assert not workspace_db._progress_purpose_constraints_current(db)
            db.close()
            db = workspace_db.connect(str(workspace), str(database), **connection_options)
            assert workspace_db._progress_purpose_constraints_current(db)
            assert workspace_db._meta_value(db, "progress_purpose_constraint_revision") == workspace_db.PROGRESS_PURPOSE_CONSTRAINT_REVISION
            selection_payload = {
                "projectName": "Project", "mediaKind": "image", "versionKey": f"selection-{jpg['id']}",
                "displayName": "jpg_选片", "folderPath": str(project / "jpg_选片"),
                "nodeRole": "selection", "relationKind": "auxiliary", "parentProgressId": jpg["id"],
                "trackingEnabled": False,
            }
            selection = workspace_db.progress_register(str(workspace), db, selection_payload)["progressFolder"]
            repeated = workspace_db.progress_register(str(workspace), db, {
                **selection_payload, "progressId": selection["id"],
            })["progressFolder"]
            assert repeated["id"] == selection["id"] and repeated["parentProgressId"] == jpg["id"]
            assert not repeated["trackingEnabled"] and repeated["trackingState"] == "disabled"
            try:
                db.execute("UPDATE progress_folders SET node_role='progress',relation_kind='main',version_key='1' WHERE id=?", (selection["id"],))
                raise AssertionError("SQL role updates must not turn a companion selection into a main version")
            except sqlite3.IntegrityError as error:
                assert "invalid progress parent" in str(error)
            for parent_id in (raw["id"], jpg["id"]):
                changed = workspace_db.progress_relation_update(db, {
                    "childProgressId": selection["id"], "parentProgressId": parent_id,
                })["progressFolder"]
                assert changed["parentProgressId"] == parent_id and changed["relationKind"] == "auxiliary"
            try:
                workspace_db.progress_register(str(workspace), db, {
                    "projectName": "Project", "mediaKind": "image", "versionKey": "1",
                    "displayName": "Version", "folderPath": str(project / "Version"),
                    "nodeRole": "progress", "relationKind": "main", "parentProgressId": jpg["id"],
                })
                raise AssertionError("camera JPG must not become a main version parent")
            except ValueError as error:
                assert "父版本进度不存在" in str(error)
            workspace_db._check_integrity(db, force=True)
        finally:
            db.close()
        reopened = workspace_db.connect(str(workspace), str(database), **connection_options)
        try:
            nodes = workspace_db.progress_list(str(workspace), reopened, {"projectName": "Project"})["progressFolders"]
            by_id = {node["id"]: node for node in nodes}
            assert by_id[selection["id"]]["parentProgressId"] == jpg["id"]
            assert by_id[jpg["id"]]["artifactKind"] == "companion"
            workspace_db._check_integrity(reopened, force=True)
        finally:
            reopened.close()


def test_detached_missing_progress_cleanup_is_atomic(root: Path) -> None:
    workspace = root / "detached-cleanup-workspace"
    project = workspace / "Project"
    original_folder = project / "Original"
    progress_folder = project / "Progress"
    preview_folder = project / "Preview"
    companion_folder = project / "Companion"
    original_folder.mkdir(parents=True)
    progress_folder.mkdir()
    preview_folder.mkdir()
    companion_folder.mkdir()
    (original_folder / "base.jpg").write_bytes(b"base")
    (progress_folder / "edit.jpg").write_bytes(b"edit")
    database = root / "detached-cleanup.sqlite3"
    db = workspace_db.connect(str(workspace), str(database), include_domains=True)
    now = int(time.time() * 1000)
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES('detached-project','Project','后期中','Project',?,?)",
        (now, now),
    )
    db.commit()
    try:
        assert "versioning" in {row[1] for row in db.execute("PRAGMA database_list").fetchall()}
        assert db.execute("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='progress_folders'").fetchone() is None
        original = workspace_db.progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "source",
            "displayName": "Original", "folderPath": str(original_folder), "nodeRole": "original", "trackingEnabled": False,
        })["progressFolder"]
        progress = workspace_db.progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "1",
            "displayName": "Progress", "folderPath": str(progress_folder), "nodeRole": "progress",
            "parentProgressId": original["id"], "relationKind": "main", "trackingEnabled": True, "trackingState": "ready",
        })["progressFolder"]
        try:
            db.execute("UPDATE progress_folders SET artifact_kind='companion' WHERE id=?", (original["id"],))
            raise AssertionError("detached parent trigger allowed original with structural child to become companion")
        except sqlite3.IntegrityError as error:
            assert "structural parent role conversion forbidden" in str(error)
        db.execute("DROP TRIGGER versioning.progress_folders_structural_parent_update")
        db.execute("UPDATE progress_folders SET artifact_kind='companion' WHERE id=?", (original["id"],))
        try:
            workspace_db._check_integrity(db, force=True)
            raise AssertionError("integrity missed companion original acting as a structural parent")
        except RuntimeError as error:
            assert "progress_folders.v2_parent_role" in str(error)
        db.execute("UPDATE progress_folders SET artifact_kind=NULL WHERE id=?", (original["id"],))
        workspace_db._install_progress_purpose_constraints(db)
        db.execute("UPDATE progress_folders SET missing_since=? WHERE id=?", (now, original["id"]))
        db.execute("UPDATE progress_folders SET missing_since=NULL WHERE id=?", (original["id"],))
        preview = workspace_db.progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "preview",
            "displayName": "Preview", "folderPath": str(preview_folder), "nodeRole": "artifact",
            "artifactKind": "preview", "trackingEnabled": False,
        })["progressFolder"]
        companion = workspace_db.progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "companion",
            "displayName": "Companion", "folderPath": str(companion_folder), "nodeRole": "original",
            "artifactKind": "companion", "trackingEnabled": False,
        })["progressFolder"]
        db.execute("DROP TRIGGER versioning.version_graph_edges_validate_insert")
        db.execute(
            """INSERT INTO version_graph_edges(id,project_id,source_progress_id,target_progress_id,edge_kind,created_at,updated_at)
               VALUES('invalid-detached-edge','detached-project',?,?,'derived_preview',?,?)""",
            (companion["id"], preview["id"], now, now),
        )
        try:
            workspace_db._check_integrity(db, force=True)
            raise AssertionError("integrity missed companion source for a derived preview edge")
        except RuntimeError as error:
            assert "version_graph_edges.owner_kind" in str(error)
        db.execute("DELETE FROM version_graph_edges WHERE id='invalid-detached-edge'")
        workspace_db._install_progress_purpose_constraints(db)
        edge = workspace_db.version_graph_edge_create(db, {
            "projectId": "detached-project", "sourceProgressId": progress["id"],
            "targetProgressId": preview["id"], "edgeKind": "derived_preview",
        })["edge"]
        workspace_db.batch_register_baseline(str(workspace), db, {"projectName": "Project", "folderPath": str(original_folder)})
        committed = workspace_db.batch_commit_compare(str(workspace), db, {
            "projectName": "Project", "folderA": str(original_folder), "folderB": str(progress_folder),
            "importKey": "detached-cleanup-batch", "displayName": "Progress",
            "matches": [{"reference": "base.jpg", "source": "edit.jpg", "target": "edit.jpg", "distance": 0, "confidence": "high"}],
        })
        batch_id = committed["batch"]["id"]
        db.execute(
            """INSERT INTO batch_file_operations(
                 id,batch_id,operation_type,source_path,target_path,status,attempt_count,error,created_at,updated_at)
               VALUES('detached-operation',?,'rename','old.jpg','new.jpg','pending',0,'',?,?)""",
            (batch_id, now, now),
        )
        session = workspace_db.tracking_session_create(str(workspace), db, {
            "projectName": "Project", "progressId": progress["id"], "mode": "compare",
        })
        workspace_db.tracking_store_preview(db, {
            "sessionId": session["sessionId"],
            "items": [{"kind": "recognized", "sourceName": "edit.jpg", "referenceName": "base.jpg", "targetName": "edit.jpg", "status": "recognized"}],
        })
        db.execute(
            """INSERT INTO media_import_artifact_slots(
                 project_id,progress_id,import_slot,relative_path_key,created_at,updated_at)
               VALUES('detached-project',?,'raw','detached-progress-slot',?,?)""",
            (progress["id"], now, now),
        )
        workspace_db.version_tree_layout_save(db, {
            "projectName": "Project", "scopeKey": "", "expectedRevision": 0, "mode": "patch",
            "positions": [{"nodeKey": f"progress:{progress['id']}", "x": 10, "y": 20}],
        })
        db.commit()

        (progress_folder / "edit.jpg").unlink()
        progress_folder.rmdir()
        workspace_db.progress_list(str(workspace), db, {"projectName": "Project", "includeMissing": True})
        db.execute(
            f"""CREATE TRIGGER versioning.fail_detached_progress_delete BEFORE DELETE ON progress_folders
                  WHEN OLD.id='{progress['id']}' BEGIN SELECT RAISE(ABORT,'forced detached cleanup failure'); END"""
        )
        try:
            workspace_db.progress_delete_missing(str(workspace), db, {"projectName": "Project", "progressId": progress["id"]})
            raise AssertionError("forced detached cleanup failure was ignored")
        except sqlite3.IntegrityError as error:
            assert "forced detached cleanup failure" in str(error)
        assert db.execute("SELECT COUNT(*) FROM batch_items WHERE batch_id=?", (batch_id,)).fetchone()[0] > 0
        assert db.execute("SELECT COUNT(*) FROM tracking_sessions WHERE id=?", (session["sessionId"],)).fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM version_graph_edges WHERE id=?", (edge["id"],)).fetchone()[0] == 1
        db.execute("DROP TRIGGER versioning.fail_detached_progress_delete")
        removed = workspace_db.progress_delete_missing(str(workspace), db, {"projectName": "Project", "progressId": progress["id"]})
        assert removed["success"] and removed["deletedBatchCount"] == 1
        assert db.execute("SELECT COUNT(*) FROM batch_items WHERE batch_id=?", (batch_id,)).fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM batch_file_operations WHERE batch_id=?", (batch_id,)).fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM tracking_session_items WHERE session_id=?", (session["sessionId"],)).fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM tracking_sessions WHERE id=?", (session["sessionId"],)).fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM media_import_artifact_slots WHERE progress_id=?", (progress["id"],)).fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM version_graph_edges WHERE id=?", (edge["id"],)).fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM version_tree_node_positions WHERE node_key=?", (f"progress:{progress['id']}",)).fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM version_batches WHERE id=?", (batch_id,)).fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM progress_folders WHERE id=?", (progress["id"],)).fetchone()[0] == 0
        workspace_db._check_integrity(db, force=True)
    finally:
        db.close()


def test_detached_reconcile_repairs_legacy_dangling_projections(root: Path) -> None:
    workspace = root / "detached-reconcile-workspace"
    project = workspace / "Project"
    folders = {
        name: project / name
        for name in ("Original", "Progress", "DisposableProgress", "DisposableOriginal", "Preview")
    }
    for folder in folders.values():
        folder.mkdir(parents=True, exist_ok=True)
    (folders["Original"] / "base.jpg").write_bytes(b"base")
    (folders["Progress"] / "edit.jpg").write_bytes(b"edit")
    (folders["DisposableProgress"] / "discard.jpg").write_bytes(b"discard")
    database = root / "detached-reconcile.sqlite3"
    db = workspace_db.connect(str(workspace), str(database), include_domains=True)
    now = int(time.time() * 1000)
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES('reconcile-project','Project','后期中','Project',?,?)",
        (now, now),
    )
    db.commit()

    def clone_row(table: str, source_id: str, replacement: dict, connection=None) -> None:
        target = connection or db
        source = target.execute(f"SELECT * FROM {table} WHERE id=?", (source_id,)).fetchone()
        assert source is not None
        values = dict(source)
        values.update(replacement)
        columns = list(values)
        target.execute(
            f"INSERT INTO {table}({','.join(columns)}) VALUES({','.join('?' for _ in columns)})",
            tuple(values[column] for column in columns),
        )

    try:
        assert "versioning" in {row[1] for row in db.execute("PRAGMA database_list").fetchall()}
        original = workspace_db.progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "source",
            "displayName": "Original", "folderPath": str(folders["Original"]),
            "nodeRole": "original", "trackingEnabled": False,
        })["progressFolder"]
        progress = workspace_db.progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "1",
            "displayName": "Progress", "folderPath": str(folders["Progress"]),
            "nodeRole": "progress", "parentProgressId": original["id"],
            "relationKind": "main", "trackingEnabled": True, "trackingState": "ready",
        })["progressFolder"]
        disposable_progress = workspace_db.progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "2",
            "displayName": "DisposableProgress", "folderPath": str(folders["DisposableProgress"]),
            "nodeRole": "progress", "parentProgressId": progress["id"],
            "relationKind": "main", "trackingEnabled": True, "trackingState": "ready",
        })["progressFolder"]
        disposable_original = workspace_db.progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "disposable-source",
            "displayName": "DisposableOriginal", "folderPath": str(folders["DisposableOriginal"]),
            "nodeRole": "original", "trackingEnabled": False,
        })["progressFolder"]
        preview = workspace_db.progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "preview",
            "displayName": "Preview", "folderPath": str(folders["Preview"]),
            "nodeRole": "artifact", "artifactKind": "preview", "trackingEnabled": False,
        })["progressFolder"]

        baseline = workspace_db.batch_register_baseline(
            str(workspace), db, {"projectName": "Project", "folderPath": str(folders["Original"])}
        )
        committed = workspace_db.batch_commit_compare(str(workspace), db, {
            "projectName": "Project", "folderA": str(folders["Original"]),
            "folderB": str(folders["Progress"]), "importKey": "legacy-dirty-batch",
            "displayName": "Progress", "matches": [{
                "reference": "base.jpg", "source": "edit.jpg", "target": "edit.jpg",
                "distance": 0, "confidence": "high",
            }],
        })
        valid_batch_id = baseline["batch"]["id"]
        missing_batch_id = committed["batch"]["id"]
        db.execute(
            """INSERT INTO batch_file_operations(
                 id,batch_id,operation_type,source_path,target_path,status,attempt_count,error,created_at,updated_at)
               VALUES('valid-operation',?,'rename','valid-old.jpg','valid-new.jpg','pending',0,'',?,?)""",
            (valid_batch_id, now, now),
        )
        db.execute(
            """INSERT INTO batch_file_operations(
                 id,batch_id,operation_type,source_path,target_path,status,attempt_count,error,created_at,updated_at)
               VALUES('orphan-operation',?,'rename','orphan-old.jpg','orphan-new.jpg','pending',0,'',?,?)""",
            (missing_batch_id, now, now),
        )

        valid_session = workspace_db.tracking_session_create(str(workspace), db, {
            "projectName": "Project", "progressId": progress["id"], "mode": "compare",
        })
        workspace_db.tracking_store_preview(db, {
            "sessionId": valid_session["sessionId"], "items": [{
                "kind": "recognized", "sourceName": "edit.jpg", "referenceName": "base.jpg",
                "targetName": "edit.jpg", "status": "recognized",
            }],
        })
        disposable_session = workspace_db.tracking_session_create(str(workspace), db, {
            "projectName": "Project", "progressId": disposable_progress["id"], "mode": "compare",
        })
        workspace_db.tracking_store_preview(db, {
            "sessionId": disposable_session["sessionId"], "items": [{
                "kind": "recognized", "sourceName": "discard.jpg", "referenceName": "edit.jpg",
                "targetName": "discard.jpg", "status": "recognized",
            }],
        })
        clone_row("tracking_sessions", valid_session["sessionId"], {
            "id": "missing-committed-batch-session", "status": "committed",
            "committed_batch_id": missing_batch_id,
        })
        valid_item_id = db.execute(
            "SELECT id FROM tracking_session_items WHERE session_id=?",
            (valid_session["sessionId"],),
        ).fetchone()[0]
        clone_row("tracking_session_items", valid_item_id, {
            "id": "missing-committed-batch-item", "session_id": "missing-committed-batch-session",
        })
        db.commit()
        # Historical detached versioning stores could contain an item whose
        # owning session was already absent.  Build that legacy-only state via
        # its physical database instead of weakening FK enforcement on the
        # active workspace connection.
        versioning_database = Path(workspace_db.database_path_for_workspace_database(str(database), "versioning"))
        legacy = sqlite3.connect(versioning_database)
        legacy.row_factory = sqlite3.Row
        try:
            legacy.execute("PRAGMA foreign_keys=OFF")
            assert legacy.execute("PRAGMA foreign_keys").fetchone()[0] == 0
            clone_row("tracking_session_items", valid_item_id, {
                "id": "missing-session-item", "session_id": "missing-session",
            }, legacy)
            legacy.commit()
            assert legacy.execute(
                """SELECT COUNT(*) FROM tracking_session_items item
                   LEFT JOIN tracking_sessions session ON session.id=item.session_id
                   WHERE item.id='missing-session-item' AND session.id IS NULL"""
            ).fetchone()[0] == 1, "legacy fixture must contain the intended orphan tracking item"
        finally:
            legacy.close()

        valid_edge = workspace_db.version_graph_edge_create(db, {
            "projectId": "reconcile-project", "sourceProgressId": progress["id"],
            "targetProgressId": preview["id"], "edgeKind": "derived_preview",
        })["edge"]
        orphan_edge = workspace_db.version_graph_edge_create(db, {
            "projectId": "reconcile-project", "sourceProgressId": disposable_progress["id"],
            "targetProgressId": preview["id"], "edgeKind": "derived_preview",
        })["edge"]
        for progress_id, key in ((original["id"], "valid-raw"), (disposable_original["id"], "orphan-raw")):
            db.execute(
                """INSERT INTO media_import_artifact_slots(
                     project_id,progress_id,import_slot,relative_path_key,created_at,updated_at)
                   VALUES('reconcile-project',?,'raw',?,?,?)""",
                (progress_id, key, now, now),
            )
        workspace_db.version_tree_layout_save(db, {
            "projectName": "Project", "scopeKey": "", "expectedRevision": 0, "mode": "patch",
            "positions": [
                {"nodeKey": f"progress:{progress['id']}", "x": 10, "y": 20},
                {"nodeKey": f"progress:{disposable_progress['id']}", "x": 30, "y": 40},
            ],
        })
        db.execute(
            """INSERT INTO legacy_selection_relation_repairs(
                 progress_id,project_id,legacy_name,expected_source_name,reason,candidate_ids_json,created_at)
               VALUES(?,'reconcile-project','Legacy','Source','missing_source','[]',?)""",
            (disposable_progress["id"], now),
        )
        db.commit()

        missing_batch_item_count = db.execute(
            "SELECT COUNT(*) FROM batch_items WHERE batch_id=?", (missing_batch_id,)
        ).fetchone()[0]
        assert missing_batch_item_count > 0
        db.commit()
        legacy = sqlite3.connect(versioning_database)
        try:
            legacy.execute("PRAGMA foreign_keys=OFF")
            assert legacy.execute("PRAGMA foreign_keys").fetchone()[0] == 0
            legacy.execute("DELETE FROM version_batches WHERE id=?", (missing_batch_id,))
            legacy.execute("DELETE FROM progress_folders WHERE id=?", (disposable_progress["id"],))
            legacy.execute("DELETE FROM progress_folders WHERE id=?", (disposable_original["id"],))
            legacy.commit()
            assert legacy.execute(
                """SELECT COUNT(*) FROM batch_items item
                   LEFT JOIN version_batches batch ON batch.id=item.batch_id
                   WHERE item.batch_id=? AND batch.id IS NULL""",
                (missing_batch_id,),
            ).fetchone()[0] == missing_batch_item_count, "legacy fixture must retain detached batch items"
        finally:
            legacy.close()
        try:
            workspace_db._check_integrity(db, force=True)
            raise AssertionError("integrity accepted historical detached-store dangling projections")
        except RuntimeError as error:
            assert "batch_items.owner" in str(error)

        repaired = workspace_db.reconcile_cross_domain_references(db)
        assert repaired["removedBatchItems"] == missing_batch_item_count
        assert repaired["removedBatchOperations"] == 1
        assert repaired["removedTrackingSessions"] == 2
        assert repaired["removedTrackingSessionItems"] == 3
        assert repaired["removedVersionGraphEdges"] == 1
        assert repaired["removedImportSlotMappings"] == 1
        assert repaired["removedLegacySelectionRepairs"] == 1
        assert repaired["removedVersionTreePositions"] == 1

        assert db.execute("SELECT 1 FROM version_batches WHERE id=?", (valid_batch_id,)).fetchone()
        assert db.execute("SELECT 1 FROM batch_items WHERE batch_id=?", (valid_batch_id,)).fetchone()
        assert db.execute("SELECT 1 FROM batch_file_operations WHERE id='valid-operation'").fetchone()
        assert db.execute("SELECT 1 FROM tracking_sessions WHERE id=?", (valid_session["sessionId"],)).fetchone()
        assert db.execute("SELECT 1 FROM tracking_session_items WHERE id=?", (valid_item_id,)).fetchone()
        assert db.execute("SELECT 1 FROM version_graph_edges WHERE id=?", (valid_edge["id"],)).fetchone()
        assert not db.execute("SELECT 1 FROM version_graph_edges WHERE id=?", (orphan_edge["id"],)).fetchone()
        assert db.execute("SELECT 1 FROM media_import_artifact_slots WHERE progress_id=?", (original["id"],)).fetchone()
        assert db.execute(
            "SELECT 1 FROM version_tree_node_positions WHERE node_key=?", (f"progress:{progress['id']}",)
        ).fetchone()
        workspace_db._check_integrity(db, force=True)
    finally:
        db.close()


def test_component_host_v6_cas_mutations(root: Path) -> None:
    workspace = root / "component-v6-workspace"
    project = workspace / "Project"
    raw = project / "RAW"
    progress_path = project / "P1"
    raw.mkdir(parents=True)
    progress_path.mkdir()
    original_file = raw / "photo.jpg"
    edited_file = progress_path / "photo.jpg"
    original_file.write_bytes(b"original")
    edited_file.write_bytes(b"edited")
    database = root / "component-v6.sqlite3"
    db = workspace_db.connect(str(workspace), str(database))
    now = int(time.time() * 1000)
    db.execute("INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES('component-v6-project','Project','active','Project',?,?)", (now, now))
    db.commit()
    try:
        workspace_db.media_sync_project(str(workspace), db, {"projectName": "Project", "externalRoots": []})
        original = db.execute("SELECT * FROM versions WHERE file_path_key=?", (str(original_file.resolve()).casefold(),)).fetchone()
        created = workspace_db.media_create_version(db, {"photoId": original["photo_id"], "parentVersionId": original["id"], "filePath": str(edited_file), "versionName": "Edit"})
        version = next(item for item in created["versions"] if item["versionNumber"] == 1)
        updated = workspace_db.media_component_update_version(db, {"projectId": "component-v6-project", "projectPath": str(project), "scopePath": str(project), "versionId": version["id"], "expectedUpdatedAt": version["updatedAt"], "versionName": "Updated"})
        assert updated["version"]["versionName"] == "Updated"
        try:
            workspace_db.media_component_update_version(db, {"projectId": "component-v6-project", "projectPath": str(project), "scopePath": str(project), "versionId": version["id"], "expectedUpdatedAt": version["updatedAt"], "note": "stale"})
            raise AssertionError("stale component version update was accepted")
        except ValueError as error:
            assert "component_version_stale" in str(error)
        deleted = workspace_db.media_component_delete_version(db, {"projectId": "component-v6-project", "projectPath": str(project), "scopePath": str(project), "versionId": version["id"], "expectedUpdatedAt": updated["version"]["updatedAt"]})
        assert deleted["versionId"] == version["id"]

        original_progress = next(item for item in workspace_db.progress_list(str(workspace), db, {"projectName": "Project"})["progressFolders"] if item["displayName"] == "RAW")
        progress = workspace_db.progress_register(str(workspace), db, {"projectName": "Project", "folderPath": str(progress_path), "mediaKind": "image", "versionKey": "1", "parentProgressId": original_progress["id"], "displayName": "P1", "trackingEnabled": False})["progressFolder"]
        managed = workspace_db.progress_component_manage(str(workspace), db, {"action": "update", "projectName": "Project", "projectId": "component-v6-project", "projectPath": str(project), "scopePath": str(project), "progressId": progress["id"], "expectedUpdatedAt": progress["updatedAt"], "displayName": "P1 Updated"})
        assert managed["progressFolder"]["displayName"] == "P1 Updated"
        try:
            workspace_db.progress_component_manage(str(workspace), db, {"action": "unregister", "projectName": "Project", "projectId": "component-v6-project", "projectPath": str(project), "scopePath": str(project), "progressId": progress["id"], "expectedUpdatedAt": progress["updatedAt"]})
            raise AssertionError("stale component progress mutation was accepted")
        except ValueError as error:
            assert "progress_unregister_stale" in str(error)
    finally:
        db.close()


def main() -> None:
    temp_root = Path(tempfile.mkdtemp(prefix="photoflow-versioning-v2-db-"))
    try:
        test_schema_17_upgrade(temp_root)
        test_schema_17_cycle_repairs(temp_root)
        test_schema_19_cycle_repair(temp_root)
        test_v2_node_operations(temp_root)
        test_relation_update_transactions(temp_root)
        test_schema_24_supplemental_graph_edges(temp_root)
        test_legacy_selection_relation_repair(temp_root)
        test_legacy_selection_keep_independent_is_durable(temp_root)
        test_version_tree_layout_persistence(temp_root)
        test_external_link_payload_cannot_authorize_outside_folder(temp_root)
        test_folder_purposes_and_legacy_orphan_survive_reload(temp_root)
        test_camera_jpg_selection_source(temp_root)
        test_detached_missing_progress_cleanup_is_atomic(temp_root)
        test_detached_reconcile_repairs_legacy_dangling_projections(temp_root)
        test_component_host_v6_cas_mutations(temp_root)
        print("versioning V2 database tests passed")
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    main()
