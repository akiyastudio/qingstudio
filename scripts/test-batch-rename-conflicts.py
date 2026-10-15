"""Regression tests for batch rename collisions; fixtures contain no customer data."""
import hashlib
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
import workspace_db as w
from workspace_media_actions import canonical_path, is_project_descendant


def rejected(callback, message):
    try:
        callback()
    except (ValueError, FileExistsError) as error:
        assert message in str(error), str(error)
    else:
        raise AssertionError("conflicting operation was accepted")


def planner_db(folder):
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript("""
        CREATE TABLE batch_items(id TEXT,batch_id TEXT,source_path_key TEXT);
        CREATE TABLE batch_file_operations(id TEXT,batch_id TEXT,operation_type TEXT,
          source_path TEXT,target_path TEXT,status TEXT,attempt_count INTEGER,error TEXT,
          created_at INTEGER,updated_at INTEGER,
          UNIQUE(batch_id,operation_type,source_path,target_path));
    """)
    for name in ("a.tif", "b.tif", "c.jpg"):
        (folder / name).write_bytes(name.encode())
        db.execute("INSERT INTO batch_items VALUES(?,?,?)", (name, "batch", canonical_path(str(folder / name)).casefold()))
    return db


def test_planner(folder):
    db = planner_db(folder)
    matches = [{"source": "b.tif", "target": "SAME.TIF"}, {"source": "a.tif", "target": "same.tif"},
               {"source": "c.jpg", "target": "same.tif"}]
    w.plan_confirmed_batch_renames(db, "batch", str(folder), matches)
    first = [(row[0], row[1]) for row in db.execute("SELECT source_path,target_path FROM batch_file_operations ORDER BY source_path")]
    assert {Path(target).name.casefold() for _source, target in first} == {"same_1.tif", "same_2.tif", "same.jpg"}
    assert len({target.casefold() for _source, target in first}) == 3
    # A retry, including reversed input order, reuses each reserved destination.
    w.plan_confirmed_batch_renames(db, "batch", str(folder), list(reversed(matches)))
    assert [(row[0], row[1]) for row in db.execute("SELECT source_path,target_path FROM batch_file_operations ORDER BY source_path")] == first
    rejected(lambda: w.plan_confirmed_batch_renames(db, "batch", str(folder), [
        {"source": "a.tif", "target": "different.tif"},
    ]), "不同改名目标")
    assert db.execute("SELECT COUNT(*) FROM batch_file_operations").fetchone()[0] == 3
    (folder / "a.tif").rename(folder / "already-renamed.tif")
    retry = [{"source": "a.tif", "target": "same.tif"}]
    assert len(w._batch_rename_candidates(str(folder), retry, require_exists=False)) == 1
    rejected(lambda: w._batch_rename_candidates(str(folder), retry), "不存在")
    db.close()


def test_occupied_targets(folder):
    db = planner_db(folder)
    (folder / "same.tif").write_bytes(b"unrelated")
    (folder / "SAME_1.TIF").write_bytes(b"also unrelated")
    (folder / "same_2.tif").mkdir()
    w.plan_confirmed_batch_renames(db, "batch", str(folder), [
        {"source": "a.tif", "target": "same.tif"}, {"source": "b.tif", "target": "same.tif"},
    ])
    assert {Path(row[0]).name for row in db.execute("SELECT target_path FROM batch_file_operations")} == {"same_3.tif", "same_4.tif"}
    assert (folder / "same.tif").read_bytes() == b"unrelated"
    assert (folder / "SAME_1.TIF").read_bytes() == b"also unrelated"
    db.close()
    # Generated suffixes cannot steal a distinct preview target.
    (folder / "d.tif").write_bytes(b"fourth return")
    result = w._allocate_batch_rename_targets(str(folder), [
        {"source": "a.tif", "target": "other.tif"}, {"source": "b.tif", "target": "other.tif"},
        {"source": "d.tif", "target": "other_1.tif"},
    ])
    assert len({target.casefold() for _source, target in result}) == 3
    assert {Path(target).name for _source, target in result} == {"other_1.tif", "other_2.tif", "other_3.tif"}
    own = w._allocate_batch_rename_targets(str(folder), [
        {"source": "same.tif", "target": "same.tif"}, {"source": "a.tif", "target": "same.tif"},
    ])
    assert dict(own)[str(folder / "same.tif")] == str(folder / "same.tif")
    assert dict(own)[str(folder / "a.tif")] == str(folder / "same_3.tif")


def test_replay(folder):
    a, b = folder / "a.tif", folder / "b.tif"
    a.write_bytes(b"a"); b.write_bytes(b"b")
    def item(index, source, target):
        return {"id": str(index), "sourcePath": str(source), "targetPath": str(target),
                "sourceSize": source.stat().st_size, "sourceDigest": hashlib.sha256(source.read_bytes()).hexdigest()}
    database = folder / "catalog.sqlite3"
    db = sqlite3.connect(database); db.execute("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)"); db.close()
    journal = {"operationId": "fixture", "batchOperations": [item(1, a, folder / "same.tif"), item(2, b, folder / "same.tif")]}
    rejected(lambda: w._replay_batch_filesystem_journal(str(database), journal), "同一个改名目标")
    assert a.exists() and b.exists() and not (folder / "same.tif").exists()
    journal["batchOperations"][1]["targetPath"] = str(folder / "occupied.tif")
    (folder / "occupied.tif").write_bytes(b"unrelated")
    rejected(lambda: w._replay_batch_filesystem_journal(str(database), journal), "同时存在")
    assert a.exists() and not (folder / "same.tif").exists(), "preflight must reject before the first move"
    journal["batchOperations"][1]["targetPath"] = str(folder / "second.tif")
    result = w._replay_batch_filesystem_journal(str(database), journal)
    assert result["completedBatchOperationIds"] == ["1", "2"]
    assert (folder / "same.tif").read_bytes() == b"a" and (folder / "second.tif").read_bytes() == b"b"
    assert w._replay_batch_filesystem_journal(str(database), result)["completedBatchOperationIds"] == ["1", "2"]


def test_commit_rejects_before_linking(folder):
    source, target = folder / "reference", folder / "sources"
    source.mkdir(); target.mkdir()
    (target / "a.tif").write_bytes(b"a")
    (target / "b.tif").write_bytes(b"b")
    db = sqlite3.connect(":memory:"); db.row_factory = sqlite3.Row
    db.execute("CREATE TABLE projects(id TEXT,name TEXT,relative_path TEXT,status TEXT,is_deleted INTEGER)")
    db.execute("INSERT INTO projects VALUES('project','Fixture','Fixture','active',0)"); db.commit()
    rejected(lambda: w.batch_commit_compare(str(folder), db, {"projectName": "Fixture", "folderA": str(source),
        "folderB": str(target), "renameSources": True, "matches": [
            {"source": "a.tif", "target": "same.tif"}, {"source": "a.tif", "target": "other.tif"},
        ]}), "不同改名目标")
    rejected(lambda: w.batch_commit_compare(str(folder), db, {"projectName": "Fixture", "folderA": str(source),
        "folderB": str(target), "renameSources": False, "matches": [
            {"source": "a.tif", "reference": "first.jpg", "target": "same.tif"},
            {"source": "a.tif", "reference": "second.jpg", "target": "same.tif"},
        ]}), "不同原图")
    assert not db.in_transaction
    db.close()


def test_windows_scope(folder):
    if os.name != "nt":
        return
    normal = str(folder.resolve())
    extended = "\\\\?\\" + normal
    assert canonical_path(extended) == canonical_path(normal)
    assert is_project_descendant(extended + "\\child", normal)
    assert not is_project_descendant("\\\\?\\" + str(folder.parent / "outside"), normal)
    assert canonical_path(r"\\?\UNC\server\share\child") == canonical_path(r"\\server\share\child")
    assert canonical_path(r"\\?\Volume{fixture}\child").startswith("\\\\?\\")


with tempfile.TemporaryDirectory(prefix="photoflow-rename-conflicts-", ignore_cleanup_errors=True) as temp:
    root = Path(temp)
    for name, callback in (("planner", test_planner), ("occupied", test_occupied_targets), ("replay", test_replay), ("commit", test_commit_rejects_before_linking), ("paths", test_windows_scope)):
        folder = root / name; folder.mkdir(); callback(folder)
print("numbered batch targets, collision avoidance, idempotent replay and Windows path scope tests passed")
