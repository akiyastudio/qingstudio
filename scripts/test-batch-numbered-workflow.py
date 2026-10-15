"""Exercise numbered return files through durable batch and tracking commits."""
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
import workspace_db as w


def fixture(root):
    workspace = root / "workspace"
    references, returns = workspace / "Project" / "Original", workspace / "Project" / "Returns"
    references.mkdir(parents=True); returns.mkdir()
    (references / "base.jpg").write_bytes(b"original base")
    (references / "other.jpg").write_bytes(b"original other")
    (returns / "a.jpg").write_bytes(b"first return")
    (returns / "b.jpg").write_bytes(b"second return")
    database = root / "catalog.sqlite3"
    db = w.connect(str(workspace), str(database), include_domains=True)
    now = int(time.time() * 1000)
    db.execute("INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES('project','Project','active','Project',?,?)", (now, now))
    db.commit()
    original = w.progress_register(str(workspace), db, {
        "projectName": "Project", "folderPath": str(references), "mediaKind": "image", "versionKey": "original",
        "displayName": "Original", "nodeRole": "original", "trackingEnabled": False, "trackingState": "disabled",
    })["progressFolder"]
    progress = w.progress_register(str(workspace), db, {
        "projectName": "Project", "folderPath": str(returns), "mediaKind": "image", "versionKey": "retouch",
        "displayName": "Returns", "nodeRole": "progress", "parentProgressId": original["id"], "relationKind": "main",
        "trackingEnabled": True, "trackingState": "ready", "renameFromParent": True, "copyMissingFromParent": False,
    })["progressFolder"]
    project = w.project_row(db, "Project")
    w.ensure_reference_batch(str(workspace), db, project, str(references)); db.commit()
    return workspace, references, returns, database, db, progress


def assert_links(db, reference, returns, names):
    original = db.execute("SELECT id,photo_id FROM versions WHERE file_path_key=?", (str(reference).casefold(),)).fetchone()
    for name in names:
        row = db.execute("SELECT photo_id,parent_version_id FROM versions WHERE file_path_key=? AND is_deleted=0", (str(returns / name).casefold(),)).fetchone()
        assert row is not None and row["photo_id"] == original["photo_id"] and row["parent_version_id"] == original["id"]


def test_durable_resume(root):
    workspace, references, returns, database, db, _progress = fixture(root)
    db.close()
    request = {"projectName": "Project", "folderA": str(references), "folderB": str(returns),
               "importKey": "numbered-fixture", "renameSources": True, "matches": [
        {"source": name, "reference": "base.jpg", "target": "base.jpg", "distance": index, "confidence": "high"}
        for index, name in enumerate(("a.jpg", "b.jpg"))]}
    set_stage = w._set_media_operation_stage
    def crash_after_first_move(database, journal, state):
        updated = set_stage(database, journal, state)
        if state == "filesystem" and len(updated.get("completedBatchOperationIds", [])) == 1:
            raise RuntimeError("synthetic interruption after first rename")
        return updated
    with patch.object(w, "_set_media_operation_stage", side_effect=crash_after_first_move):
        try:
            w.mutate(str(workspace), str(database), "batch_commit_compare", request, "numbered-operation")
        except RuntimeError as error:
            assert "synthetic interruption" in str(error)
        else:
            raise AssertionError("expected an interrupted durable operation")
    journal = w._read_media_operation_journal(str(database))
    assert len(journal["completedBatchOperationIds"]) == 1
    assert len({item["targetPath"].casefold() for item in journal["batchOperations"]}) == 2
    result = w._resume_media_operation_files(str(database))
    assert result["success"] and not result["repairRequired"]
    assert w._read_media_operation_journal(str(database)) is None
    assert (returns / "base_1.jpg").read_bytes() == b"first return"
    assert (returns / "base_2.jpg").read_bytes() == b"second return"
    again = w.mutate(str(workspace), str(database), "batch_commit_compare", request, "numbered-operation")
    assert again == result, "transport retry must reuse its durable receipt"
    db = w.connect(str(workspace), str(database), include_domains=True)
    assert_links(db, references / "base.jpg", returns, ["base_1.jpg", "base_2.jpg"])
    assert db.execute("SELECT COUNT(*) FROM batch_file_operations WHERE status!='succeeded'").fetchone()[0] == 0
    w._check_integrity(db, force=True); db.close()


def test_tracking_names(root, targets, expected):
    workspace, references, returns, _database, db, progress = fixture(root)
    try:
        (returns / "base_1.jpg").write_bytes(b"existing file must survive")
        prepared = w.tracking_prepare(str(workspace), db, {"projectName": "Project", "progressId": progress["id"], "mode": "compare"})
        w.tracking_store_preview(db, {"sessionId": prepared["sessionId"], "items": [
            {"kind": "recognized", "status": "recognized", "sourceName": source, "referenceName": "base.jpg",
             "targetName": target, "distance": index, "confidence": "high"}
            for index, (source, target) in enumerate(zip(("a.jpg", "b.jpg"), targets))]})
        plan = w.tracking_commit_plan(str(workspace), db, {"sessionId": prepared["sessionId"]})
        assert {item["source"]: item["target"] for item in plan["matches"]} == dict(zip(("a.jpg", "b.jpg"), expected))
        result = w.batch_commit_compare(str(workspace), db, {
            "projectName": "Project", "folderA": str(references), "folderB": str(returns), "renameSources": True,
            "importKey": "tracking:" + prepared["sessionId"], "matches": plan["matches"],
        })
        assert result["success"] and not result["repairRequired"]
        completed = w.tracking_commit_complete(str(workspace), db, {"sessionId": prepared["sessionId"], "batchId": result["batch"]["id"]})
        assert completed["success"], completed
        assert (returns / "base_1.jpg").read_bytes() == b"existing file must survive"
        assert (returns / expected[0]).read_bytes() == b"first return"
        assert (returns / expected[1]).read_bytes() == b"second return"
        assert_links(db, references / "base.jpg", returns, expected)
        refreshed = w.tracking_prepare(str(workspace), db, {"projectName": "Project", "progressId": progress["id"], "mode": "refresh"})
        assert refreshed["sourceNames"] == [] and refreshed["historicalMatches"] == [], "numbered names must remain stable on refresh"
        w._check_integrity(db, force=True)
    finally:
        db.close()


def test_known_ownership_conflict(root):
    workspace, references, returns, _database, db, progress = fixture(root)
    try:
        project = w.project_row(db, "Project")
        original = w.ensure_source_version(db, project, str(references / "base.jpg"))
        batch = w.create_batch_row(db, project["id"], str(returns), "Known linked return", import_key="known")
        linked, _ = w.create_linked_batch_version(db, project, batch, original, str(returns / "a.jpg"))
        db.commit()
        prepared = w.tracking_prepare(str(workspace), db, {"projectName": "Project", "progressId": progress["id"], "mode": "compare"})
        preview = w.tracking_store_preview(db, {"sessionId": prepared["sessionId"], "items": [
            {"kind": "recognized", "status": "recognized", "sourceName": "a.jpg", "referenceName": "other.jpg", "targetName": "other_2.jpg", "confidence": "high"},
        ]})
        item = preview["items"][0]
        assert item["status"] == "pending_confirmation" and preview["session"]["unresolvedCount"] == 1
        try:
            w.tracking_commit_plan(str(workspace), db, {"sessionId": prepared["sessionId"]})
        except ValueError as error:
            assert "明确处理" in str(error)
        else:
            raise AssertionError("known ownership conflict was silently accepted")
        assert db.execute("SELECT photo_id FROM versions WHERE id=?", (linked["id"],)).fetchone()[0] == original["photo_id"]
        decision = w.tracking_session_decide(str(workspace), db, {"sessionId": prepared["sessionId"], "itemId": item["id"], "status": "accepted", "referenceName": "base.jpg"})
        assert decision["item"]["targetName"] == "base.jpg", "correcting reference must discard its old target name"
        plan = w.tracking_commit_plan(str(workspace), db, {"sessionId": prepared["sessionId"]})
        assert plan["matches"][0]["reference"] == "base.jpg" and plan["matches"][0]["target"] == "base.jpg"
    finally:
        db.close()


def test_copy_reserves_preview_name(root):
    workspace, references, returns, _database, db, progress = fixture(root)
    try:
        (references / "base_2.jpg").write_bytes(b"separate original to copy")
        w.progress_policy_save(db, {"progressId": progress["id"], "trackingEnabled": True,
            "trackingState": "ready", "renameFromParent": True, "copyMissingFromParent": True})
        prepared = w.tracking_prepare(str(workspace), db, {"projectName": "Project", "progressId": progress["id"], "mode": "compare"})
        preview = w.tracking_store_preview(db, {"sessionId": prepared["sessionId"], "items": [
            {"kind": "recognized", "status": "recognized", "sourceName": "a.jpg", "referenceName": "base.jpg", "targetName": "base_2.jpg"},
            {"kind": "recognized", "status": "recognized", "sourceName": "b.jpg", "referenceName": "base.jpg", "targetName": "base_3.jpg"},
            {"kind": "copy_missing", "status": "pending_confirmation", "referenceName": "base_2.jpg", "targetName": "base_2.jpg"},
        ]})
        copied_item = next(item for item in preview["items"] if item["kind"] == "copy_missing")
        w.tracking_session_decide(str(workspace), db, {"sessionId": prepared["sessionId"], "itemId": copied_item["id"], "status": "accepted"})
        plan = w.tracking_commit_plan(str(workspace), db, {"sessionId": prepared["sessionId"]})
        assert plan["copyReferences"] == ["base_2.jpg"]
        copies = w.tracking_apply_copies(str(workspace), db, {"sessionId": prepared["sessionId"]})
        assert copies["success"]
        result = w.batch_commit_compare(str(workspace), db, {
            "projectName": "Project", "folderA": str(references), "folderB": str(returns), "renameSources": True,
            "importKey": "tracking:" + prepared["sessionId"], "matches": plan["matches"] + [
                {"source": "base_2.jpg", "reference": "base_2.jpg", "target": "base_2.jpg", "confidence": "复制补齐"}],
        })
        assert result["success"] and not result["repairRequired"]
        assert (returns / "base_1.jpg").read_bytes() == b"first return"
        assert (returns / "base_2.jpg").read_bytes() == b"separate original to copy"
        assert (returns / "base_3.jpg").read_bytes() == b"second return"
        completed = w.tracking_commit_complete(str(workspace), db, {"sessionId": prepared["sessionId"], "batchId": result["batch"]["id"]})
        assert completed["success"], "completion must use actual allocated names after copy reserves a preview name"
        assert_links(db, references / "base.jpg", returns, ["base_1.jpg", "base_3.jpg"])
        w._check_integrity(db, force=True)
    finally:
        db.close()


with tempfile.TemporaryDirectory(prefix="photoflow-numbered-workflow-") as temporary:
    root = Path(temporary)
    for name, callback in [
        ("durable", test_durable_resume),
        ("preview", lambda folder: test_tracking_names(folder, ["base_2.jpg", "base_3.jpg"], ["base_2.jpg", "base_3.jpg"])),
        ("duplicates", lambda folder: test_tracking_names(folder, ["base.jpg", "base.jpg"], ["base_2.jpg", "base_3.jpg"])),
        ("occupied-preview", lambda folder: test_tracking_names(folder, ["base_1.jpg", "base_2.jpg"], ["base_3.jpg", "base_2.jpg"])),
        ("ownership", test_known_ownership_conflict),
        ("copy-reservation", test_copy_reserves_preview_name),
    ]:
        folder = root / name; folder.mkdir(); callback(folder)
print("numbered return workflow, durable resume, refresh stability and known ownership confirmation tests passed")
