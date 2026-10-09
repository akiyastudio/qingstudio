from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import workspace_db as workspace_db_module  # noqa: E402
from thumbnail_db import ThumbnailDatabase  # noqa: E402
from workspace_db import (  # noqa: E402
    batch_commit_compare,
    batch_register_baseline,
    cleanup_media_workflow_graph,
    cleanup_progress_tombstones,
    connect,
    media_create_version,
    media_delete_version,
    media_delete_project_missing_version,
    media_get,
    media_get_photo,
    media_set_thumbnail,
    media_version_delete_scope,
    media_workflow_import_commit,
    progress_list,
    progress_delete_missing,
    progress_register,
    progress_relation_update,
    progress_update_tree,
    version_graph_edge_create,
)


def write_media(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(value)


def complete_thumbnail_migration(database: ThumbnailDatabase, cursor=None) -> list[dict]:
    state = cursor or {}
    results = []
    for _ in range(10000):
        result = database.run_thumbnail_cache_migration("thumbnail-cache-migration-v2", state, 512)
        results.append(result)
        state = result["cursor"]
        if result["done"]:
            return results
    raise AssertionError("thumbnail migration did not complete")


def test_thumbnail_missing_prune(root: Path) -> None:
    project = root / "thumbnail-project"
    source = project / "source.jpg"
    cached = root / "cache" / "source.jpg"
    write_media(source, b"source")
    write_media(cached, b"cached")
    database = ThumbnailDatabase(str(root / "thumbnail.sqlite3"))
    database.sync_directory(str(project), str(project))
    database.mark_ready(str(source), source.stat().st_mtime_ns / 1_000_000, None, [{
        "sizeLabel": "small", "pixelSize": 320, "path": str(cached),
        "fileSize": cached.stat().st_size,
    }])
    source.unlink()
    database.sync_directory(str(project), str(project))
    result = database.prune_missing_sources()
    assert result["sourceCount"] == 1
    assert str(cached.resolve()).casefold() in {str(Path(item).resolve()).casefold() for item in result["thumbnailPaths"]}
    assert database.get_file(str(source)) is None
    database.close()


def test_thumbnail_cleanup_uses_access_index(root: Path) -> None:
    project = root / "thumbnail-cleanup-project"
    source = project / "source.jpg"
    stale_cache = root / "cache" / "stale.jpg"
    recent_cache = root / "cache" / "recent.jpg"
    write_media(source, b"source")
    write_media(stale_cache, b"stale")
    write_media(recent_cache, b"recent")
    database = ThumbnailDatabase(str(root / "thumbnail-cleanup.sqlite3"))
    try:
        database.sync_directory(str(project), str(project))
        source_mtime = source.stat().st_mtime_ns / 1_000_000
        database.mark_ready(str(source), source_mtime, None, [
            {"sizeLabel": "small", "pixelSize": 320, "path": str(stale_cache), "fileSize": stale_cache.stat().st_size},
            {"sizeLabel": "medium", "pixelSize": 640, "path": str(recent_cache), "fileSize": recent_cache.stat().st_size},
        ])
        database.connection.execute(
            "UPDATE thumbnails SET last_accessed_at=? WHERE size_label='small'",
            (100,),
        )
        database.connection.execute(
            "UPDATE thumbnails SET last_accessed_at=? WHERE size_label='medium'",
            (300,),
        )
        database.connection.commit()
        candidates = database.list_cache_cleanup(200)
        assert {str(Path(item).resolve()).casefold() for item in candidates["thumbnailPaths"]} == {str(stale_cache.resolve()).casefold()}
        database.invalidate_cache(before_ms=200)
        remaining = database.connection.execute("SELECT thumbnail_path FROM thumbnails").fetchall()
        assert {str(Path(row["thumbnail_path"]).resolve()).casefold() for row in remaining} == {str(recent_cache.resolve()).casefold()}
        database.invalidate_cache(deleted_paths=[])
        assert database.connection.execute("SELECT COUNT(*) FROM thumbnails").fetchone()[0] == 1

        orphan_cache = root / "cache" / ("a" * 64 + ".jpg")
        unrelated_file = root / "cache" / "keep-user-file.jpg"
        write_media(orphan_cache, b"orphan")
        write_media(unrelated_file, b"unrelated")
        os.utime(orphan_cache, (0, 0))
        os.utime(unrelated_file, (0, 0))
        orphan_result = database.recover_cache_publications(str(root / "cache"), 200)
        orphan_paths = {str(Path(item).resolve()).casefold() for item in orphan_result["orphanPaths"]}
        assert str(orphan_cache.resolve()).casefold() in orphan_paths
        assert str(unrelated_file.resolve()).casefold() not in orphan_paths
        assert orphan_cache.exists(), "SQLite recovery must return orphan paths without deleting files"
        orphan_cache.unlink()
        assert unrelated_file.exists()
        assert database.check_integrity()["result"] == "ok"
        marker_key = "thumbnail-cache-recovery-test"
        assert database.maintenance_state_get(marker_key)["completed"] is False
        migrations = complete_thumbnail_migration(database)
        assert migrations[-1]["success"] is True and migrations[-1]["integrity"] == "ok"
        database.maintenance_state_complete(marker_key)
        assert database.maintenance_state_get(marker_key)["completed"] is True
    finally:
        database.close()


def test_thumbnail_epoch_publish_contract(root: Path) -> None:
    project = root / "thumbnail-epoch-project"
    source = project / "source.jpg"
    final = root / "epoch-cache" / "final.jpg"
    write_media(source, b"source-v1")
    write_media(final, b"published-thumbnail")
    database = ThumbnailDatabase(str(root / "thumbnail-epoch.sqlite3"))
    try:
        complete_thumbnail_migration(database)
        capture = database.capture_thumbnail_publish(str(source), "image", str(project))
        committed = database.commit_thumbnail_publish(
            "publish-success", str(source), capture["cacheEpoch"], capture["sourceVersion"],
            capture["sourceSize"], capture["sourceMtimeMs"], [{
                "sizeLabel": "small", "pixelSize": 320, "path": str(final),
                "fileSize": final.stat().st_size,
            }],
        )
        assert committed["state"] == "READY"
        repeated = database.commit_thumbnail_publish(
            "publish-success", str(source), -1, -1, -1, -1, [],
        )
        assert repeated == committed, "the same publish ID must return its original committed result"
        queried = database.resolve_thumbnail_publish("publish-success")
        assert queried["committed"] is True and queried["result"] == committed
        row = database.connection.execute(
            "SELECT cache_epoch,cache_root FROM thumbnails WHERE size_label='small'",
        ).fetchone()
        assert row["cache_epoch"] == capture["cacheEpoch"]
        assert Path(row["cache_root"]).resolve() == final.parent.resolve()

        changes_before_maintenance = database.connection.total_changes
        maintenance_epoch = database.begin_cache_maintenance()["cacheEpoch"]
        assert database.connection.total_changes - changes_before_maintenance == 1, \
            "maintenance must update only the singleton cache_control fence"
        retained = database.connection.execute(
            "SELECT cache_epoch FROM thumbnails WHERE size_label='small'"
        ).fetchone()
        assert maintenance_epoch > capture["cacheEpoch"]
        assert retained["cache_epoch"] == capture["cacheEpoch"], \
            "maintenance must not rewrite epochs on committed thumbnail rows"
        durable = database.get_thumbnail_publish(
            str(source), "small", source.stat().st_size, source.stat().st_mtime_ns / 1_000_000,
        )
        assert durable is not None, "committed rows from an older epoch must remain readable"

        stale_epoch = database.capture_thumbnail_publish(str(source), "image", str(project))
        database.begin_cache_maintenance()
        try:
            database.commit_thumbnail_publish(
                "publish-stale-epoch", str(source), stale_epoch["cacheEpoch"], stale_epoch["sourceVersion"],
                stale_epoch["sourceSize"], stale_epoch["sourceMtimeMs"], [{
                    "sizeLabel": "medium", "pixelSize": 640, "path": str(final),
                    "fileSize": final.stat().st_size,
                }],
            )
            raise AssertionError("old epoch publish must fail")
        except Exception as error:
            assert getattr(error, "code", None) == "EPOCH_STALE"

        stale_source = database.capture_thumbnail_publish(str(source), "image", str(project))
        write_media(source, b"source-v2-with-different-size")
        try:
            database.commit_thumbnail_publish(
                "publish-stale-source", str(source), stale_source["cacheEpoch"], stale_source["sourceVersion"],
                stale_source["sourceSize"], stale_source["sourceMtimeMs"], [{
                    "sizeLabel": "large", "pixelSize": 1600, "path": str(final),
                    "fileSize": final.stat().st_size,
                }],
            )
            raise AssertionError("changed source publish must fail")
        except Exception as error:
            assert getattr(error, "code", None) == "SOURCE_STALE"

        indexes = {row["name"] for row in database.connection.execute("PRAGMA index_list(thumbnails)")}
        file_indexes = {row["name"] for row in database.connection.execute("PRAGMA index_list(files)")}
        assert {"thumbnails_path", "thumbnails_cache_access"} <= indexes
        assert "files_missing" in file_indexes
    finally:
        database.close()


def test_thumbnail_epoch_fence_at_scale(root: Path) -> None:
    """Prove cache maintenance is O(1) at the acceptance-test row count."""
    project = root / "thumbnail-epoch-scale-project"
    source = project / "source.jpg"
    cache = root / "thumbnail-epoch-scale-cache"
    final = cache / "committed.jpg"
    write_media(source, b"source")
    write_media(final, b"committed-thumbnail")
    database_path = root / "thumbnail-epoch-scale.sqlite3"
    database = ThumbnailDatabase(str(database_path))
    statements: list[str] = []
    try:
        database.sync_directory(str(project), str(project))
        source_path = database.connection.execute("SELECT path FROM files").fetchone()[0]
        cache_root = os.path.normcase(os.path.abspath(cache))
        source_mtime = source.stat().st_mtime_ns / 1_000_000
        rows = (
            (source_path, f"scale-{index}", 320, str((cache / f"{index:064x}.jpg").resolve()),
             10, 1, source_mtime, None, 1, cache_root, 100, 100)
            for index in range(85_000)
        )
        database.connection.executemany(
            """INSERT INTO thumbnails(file_path,size_label,pixel_size,thumbnail_path,thumbnail_size,
               thumbnail_version,source_mtime_ms,source_hash,cache_epoch,cache_root,generated_at,last_accessed_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
            rows,
        )
        database.connection.execute("UPDATE thumbnails SET thumbnail_path=? WHERE size_label='scale-0'", (str(final.resolve()),))
        database.connection.execute("UPDATE files SET thumbnail_state='READY' WHERE path=?", (source_path,))
        database.connection.commit()
        capture = database.capture_thumbnail_publish(str(source), "image", str(project))
        epoch_before = database.get_cache_epoch()["cacheEpoch"]
        changes_before = database.connection.total_changes
        database.connection.set_trace_callback(statements.append)
        started = time.perf_counter()
        epoch_after = database.begin_cache_maintenance()["cacheEpoch"]
        elapsed_ms = (time.perf_counter() - started) * 1000
        database.connection.set_trace_callback(None)
        assert database.connection.total_changes - changes_before == 1
        assert epoch_after == epoch_before + 1
        assert not any("UPDATE THUMBNAILS SET CACHE_EPOCH" in statement.upper() for statement in statements)
        assert database.connection.execute("SELECT COUNT(*) FROM thumbnails").fetchone()[0] == 85_000
        assert database.get_thumbnail_publish(str(source), "scale-0", source.stat().st_size, source_mtime) is not None
        try:
            database.commit_thumbnail_publish(
                "scale-stale-publish", str(source), capture["cacheEpoch"], capture["sourceVersion"],
                capture["sourceSize"], capture["sourceMtimeMs"], [{
                    "sizeLabel": "post-maintenance", "pixelSize": 640, "path": str(final),
                    "fileSize": final.stat().st_size,
                }],
            )
            raise AssertionError("a publish captured before maintenance must be rejected")
        except Exception as error:
            assert getattr(error, "code", None) == "EPOCH_STALE"
        assert database.check_integrity()["result"] == "ok"
        wal_path = Path(f"{database_path}-wal")
        print(
            "85,000 epoch evidence:",
            f"elapsed_ms={elapsed_ms:.3f}",
            f"database_bytes={database_path.stat().st_size}",
            f"wal_bytes={wal_path.stat().st_size if wal_path.exists() else 0}",
            "total_changes_delta=1",
        )
    finally:
        database.close()


def test_thumbnail_cleanup_commits_in_batches(root: Path) -> None:
    project = root / "thumbnail-batch-project"
    source = project / "source.jpg"
    write_media(source, b"source")
    database = ThumbnailDatabase(str(root / "thumbnail-batch.sqlite3"))
    try:
        database.sync_directory(str(project), str(project))
        source_path = database.connection.execute("SELECT path FROM files").fetchone()[0]
        database.connection.executemany(
            """INSERT INTO thumbnails(file_path,size_label,pixel_size,thumbnail_path,thumbnail_size,
               thumbnail_version,source_mtime_ms,source_hash,generated_at,last_accessed_at)
               VALUES(?,?,?,?,?,?,?,?,?,?)""",
            [
                (source_path, f"batch-{index}", 320, str((root / "cache" / f"batch-{index}.jpg").resolve()),
                 10, 1, source.stat().st_mtime_ns / 1_000_000, None, 100, 100)
                for index in range(520)
            ],
        )
        database.connection.execute("UPDATE files SET thumbnail_state='READY' WHERE path=?", (source_path,))
        database.connection.commit()
        result = database.invalidate_cache(before_ms=200)
        assert result["deletedCount"] == 520
        assert result["staleCount"] == 1
        assert database.connection.execute("SELECT COUNT(*) FROM thumbnails").fetchone()[0] == 0
        assert database.connection.execute("SELECT thumbnail_state FROM files WHERE path=?", (source_path,)).fetchone()[0] == "STALE"

        database.connection.executemany(
            """INSERT INTO thumbnails(file_path,size_label,pixel_size,thumbnail_path,thumbnail_size,
               thumbnail_version,source_mtime_ms,source_hash,generated_at,last_accessed_at)
               VALUES(?,?,?,?,?,?,?,?,?,?)""",
            [
                (source_path, f"missing-{index}", 320, str((root / "cache" / f"missing-{index}.jpg").resolve()),
                 10, 1, source.stat().st_mtime_ns / 1_000_000, None, 100, 100)
                for index in range(520)
            ],
        )
        database.connection.execute(
            "UPDATE files SET thumbnail_state='MISSING',exists_on_disk=0 WHERE path=?", (source_path,)
        )
        database.connection.commit()
        first_prune = database.prune_missing_batch()
        second_prune = database.prune_missing_batch()
        assert first_prune["detachedCount"] == 512 and first_prune["done"] is False
        assert second_prune["detachedCount"] == 8 and second_prune["sourceCount"] == 1 and second_prune["done"] is True
        assert database.connection.execute("SELECT COUNT(*) FROM files WHERE path=?", (source_path,)).fetchone()[0] == 0

        missing_without_thumbnails = [str((project / f"zero-thumbnail-{index}.jpg").resolve()) for index in range(1537)]
        database.connection.executemany(
            """INSERT INTO files(path,project_root,relative_path,kind,size,mtime_ms,source_hash,version,
               thumbnail_state,last_error,exists_on_disk,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            [
                (file_path, str(project.resolve()), f"zero-thumbnail-{index}.jpg", "image", 10, 100.0,
                 None, 1, "MISSING", None, 0, 100, 100)
                for index, file_path in enumerate(missing_without_thumbnails)
            ],
        )
        database.connection.commit()
        zero_thumbnail_batches = []
        while True:
            batch = database.prune_missing_batch()
            zero_thumbnail_batches.append(batch["sourceCount"])
            assert batch["detachedCount"] == 0
            if batch["done"]:
                break
        assert zero_thumbnail_batches == [512, 512, 512, 1]
        assert database.connection.execute(
            "SELECT COUNT(*) FROM files WHERE thumbnail_state='MISSING' AND NOT EXISTS(SELECT 1 FROM thumbnails WHERE thumbnails.file_path=files.path)"
        ).fetchone()[0] == 0
    finally:
        database.close()


def test_thumbnail_recovery_cursor_pages(root: Path) -> None:
    project = root / "thumbnail-recovery-project"
    source = project / "source.jpg"
    cache = root / "thumbnail-recovery-cache"
    write_media(source, b"source")
    cache.mkdir()
    database = ThumbnailDatabase(str(root / "thumbnail-recovery-cursor.sqlite3"))
    try:
        database.sync_directory(str(project), str(project))
        source_path = database.connection.execute("SELECT path FROM files").fetchone()[0]
        cache_root = os.path.normcase(os.path.abspath(cache))
        database.connection.executemany(
            """INSERT INTO thumbnails(file_path,size_label,pixel_size,thumbnail_path,thumbnail_size,
               thumbnail_version,source_mtime_ms,source_hash,cache_epoch,cache_root,generated_at,last_accessed_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
            [
                (source_path, f"cursor-{index}", 320, str((cache / f"{index:064x}.jpg").resolve()),
                 10, 1, source.stat().st_mtime_ns / 1_000_000, None, 1, cache_root, 100, 100)
                for index in range(3000)
            ],
        )
        database.connection.execute("UPDATE files SET thumbnail_state='READY' WHERE path=?", (source_path,))
        database.connection.commit()
        cursor = {"generation": "cursor-generation", "generationMaxRowId": 0, "afterRowId": 0, "lastCompletedAt": 0, "directory": {}}
        repaired = 0
        row_cursors = []
        isfile_counts = {}
        original_isfile = os.path.isfile
        def counted_isfile(value):
            normalized = os.path.normcase(os.path.abspath(value))
            isfile_counts[normalized] = isfile_counts.get(normalized, 0) + 1
            return original_isfile(value)
        os.path.isfile = counted_isfile
        try:
            for _ in range(10):
                page = database.recover_cache_publications(
                    cache_root, scan_root_orphans=False,
                    generation=cursor["generation"], generation_max_row_id=cursor["generationMaxRowId"],
                    after_row_id=cursor["afterRowId"], directory_cursor=cursor["directory"],
                    inspect_limit=2048, delete_limit=512,
                )
                repaired += page["repairedMissingCount"]
                cursor = page["cursor"]
                row_cursors.append(cursor["afterRowId"])
                database.maintenance_state_save("cursor-test", cursor)
                assert database.maintenance_state_get("cursor-test")["cursor"] == cursor
                if page["done"]:
                    break
        finally:
            os.path.isfile = original_isfile
        assert repaired == 3000
        assert row_cursors == sorted(row_cursors) and len(row_cursors) == 6
        assert max(isfile_counts.values()) == 1, "each indexed thumbnail row must be statted at most once per generation"
        assert database.connection.execute("SELECT COUNT(*) FROM thumbnails").fetchone()[0] == 0

        empty_generation = database.recover_cache_publications(
            cache_root, scan_root_orphans=False, generation="empty-generation",
            generation_max_row_id=0, after_row_id=0, directory_cursor={"rootIndex": 1, "offset": 0},
        )
        assert empty_generation["generationMaxRowId"] == -1

        database.connection.execute(
            """INSERT INTO thumbnails(file_path,size_label,pixel_size,thumbnail_path,thumbnail_size,
               thumbnail_version,source_mtime_ms,source_hash,cache_epoch,cache_root,generated_at,last_accessed_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
            (source_path, "later-missing", 320, str((cache / f"{9999:064x}.jpg").resolve()),
             10, 1, source.stat().st_mtime_ns / 1_000_000, None, 1, cache_root, 100, 100),
        )
        database.connection.commit()
        same_empty_generation = database.recover_cache_publications(
            cache_root, scan_root_orphans=False, generation="empty-generation",
            generation_max_row_id=empty_generation["generationMaxRowId"], after_row_id=empty_generation["afterRowId"],
            directory_cursor={"rootIndex": 1, "offset": 0},
        )
        assert same_empty_generation["repairedMissingCount"] == 0, "an active generation must keep its original empty maxRowId boundary"
        next_generation = database.recover_cache_publications(
            cache_root, scan_root_orphans=False, generation="next-generation",
            generation_max_row_id=0, after_row_id=0, directory_cursor={"rootIndex": 1, "offset": 0},
            inspect_limit=2048, delete_limit=512,
        )
        assert next_generation["repairedMissingCount"] == 1, "a new generation must revisit rows created after the previous completion"

        staging = cache / ".staging"
        staging.mkdir()
        for index in range(520):
            write_media(staging / f"00000000-0000-4000-8000-{index:012d}.jpg", b"orphan")
        scandir_calls = 0
        original_scandir = os.scandir
        def counted_scandir(value):
            nonlocal scandir_calls
            scandir_calls += 1
            return original_scandir(value)
        os.scandir = counted_scandir
        try:
            first = database.recover_cache_publications(
                cache_root, scan_root_orphans=False, generation="orphan-generation", generation_max_row_id=0, after_row_id=0,
                directory_cursor={"rootIndex": 0, "offset": 0}, inspect_limit=2048, delete_limit=512,
            )
            assert len(first["orphanPaths"]) == 512 and first["done"] is False
            for candidate in first["orphanPaths"]:
                Path(candidate).unlink()
            database.clear_orphan_delete_retries(first["orphanPaths"])
            second = database.recover_cache_publications(
                cache_root, scan_root_orphans=False, generation="orphan-generation",
                generation_max_row_id=first["generationMaxRowId"], after_row_id=first["afterRowId"],
                directory_cursor=first["directoryCursor"], inspect_limit=2048, delete_limit=512,
            )
        finally:
            os.scandir = original_scandir
        assert len(second["orphanPaths"]) == 8 and second["orphanDone"] is True
        assert scandir_calls == 1, "orphan directory enumeration must run only once per generation"

        persistent_retry = cache / ("f" * 64 + ".jpg")
        write_media(persistent_retry, b"retry orphan")
        database.record_orphan_delete_failures(cache_root, [{"path": str(persistent_retry), "error": "volume busy"}])
        retry_page = database.recover_cache_publications(
            cache_root, scan_root_orphans=False, generation="retry-generation",
            generation_max_row_id=0, after_row_id=0,
            directory_cursor={"rootIndex": 1, "offset": 0}, inspect_limit=32, delete_limit=32,
        )
        assert os.path.normcase(str(persistent_retry.resolve())) in retry_page["orphanPaths"], \
            "persistent delete failures must be retried without relying on the directory cursor or recent excludes"
        database.clear_orphan_delete_retries([str(persistent_retry)])
        cleared_page = database.recover_cache_publications(
            cache_root, scan_root_orphans=False, generation="retry-generation",
            generation_max_row_id=retry_page["generationMaxRowId"], after_row_id=retry_page["afterRowId"],
            directory_cursor={"rootIndex": 1, "offset": 0}, inspect_limit=32, delete_limit=32,
        )
        assert os.path.normcase(str(persistent_retry.resolve())) not in cleared_page["orphanPaths"]
    finally:
        database.close()


def test_thumbnail_resumable_schema_migration(root: Path) -> None:
    project = root / "thumbnail-migration-project"
    source = project / "source.jpg"
    cache = root / "thumbnail-migration-cache"
    write_media(source, b"source")
    cache.mkdir()
    database_path = root / "thumbnail-migration.sqlite3"
    migration_key = "thumbnail-cache-migration-v2"
    database = ThumbnailDatabase(str(database_path))
    try:
        database.sync_directory(str(project), str(project))
        source_path = database.connection.execute("SELECT path FROM files").fetchone()[0]
        database.connection.executemany(
            """INSERT INTO thumbnails(file_path,size_label,pixel_size,thumbnail_path,thumbnail_size,
               thumbnail_version,source_mtime_ms,source_hash,cache_epoch,cache_root,generated_at,last_accessed_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
            [
                (source_path, f"migration-{index}", 320, str((cache / f"{index:064x}.jpg").resolve()),
                 10, 1, source.stat().st_mtime_ns / 1_000_000, None, 1, "", 100, 100)
                for index in range(1537)
            ],
        )
        database.connection.commit()
        first = database.run_thumbnail_cache_migration(migration_key, {}, 512)
        assert first["processed"] == 512 and first["done"] is False
        database.maintenance_state_save(migration_key, first["cursor"])
    finally:
        database.close()

    database = ThumbnailDatabase(str(database_path))
    try:
        cursor = database.maintenance_state_get(migration_key)["cursor"]
        results = complete_thumbnail_migration(database, cursor)
        processed = [first["processed"], *[result.get("processed", 0) for result in results]]
        assert [value for value in processed if value] == [512, 512, 512, 1]
        assert int(database.connection.execute("PRAGMA user_version").fetchone()[0]) == 2
        assert database.connection.execute("SELECT COUNT(*) FROM thumbnails WHERE cache_root=''").fetchone()[0] == 0
        indexes = {row["name"] for row in database.connection.execute("PRAGMA index_list(thumbnails)")}
        assert {"thumbnails_path", "thumbnails_cache_access"} <= indexes
        assert [result.get("createdIndex") for result in results if result.get("createdIndex")] == [
            "files_project_relative", "files_state", "files_missing", "thumbnails_accessed",
            "thumbnails_path", "thumbnails_cache_access",
            "thumbnail_publish_receipts_file", "thumbnail_orphan_delete_retries_root",
            "thumbnail_orphan_scan_entries_page", "thumbnail_orphan_scan_entries_cleanup",
            "thumbnail_orphan_scan_state_cleanup",
        ]
    finally:
        database.close()


def test_thumbnail_startup_recovery_contract(root: Path) -> None:
    corrupt_database = root / "thumbnail-corrupt.sqlite3"
    corrupt_database.write_bytes(b"not-a-sqlite-database")
    corrupt_before = corrupt_database.read_bytes()
    try:
        ThumbnailDatabase(str(corrupt_database))
        raise AssertionError("corrupt thumbnail database must fail before recovery writes")
    except RuntimeError as error:
        assert "thumbnail database bootstrap failed" in str(error)
    assert corrupt_database.read_bytes() == corrupt_before

    project = root / "thumbnail-recovery-project"
    source = project / "source.jpg"
    cache = root / "thumbnail-recovery-cache"
    missing_cache = cache / ("1" * 64 + ".jpg")
    managed_orphan = cache / ("2" * 64 + ".jpg")
    user_jpeg = cache / "holiday.jpg"
    old_staging = cache / ".staging" / "11111111-1111-4111-8111-111111111111.jpg"
    fresh_staging = cache / ".staging" / "22222222-2222-4222-8222-222222222222.jpg"
    write_media(source, b"source")
    write_media(managed_orphan, b"orphan")
    write_media(user_jpeg, b"user")
    write_media(old_staging, b"old staging")
    write_media(fresh_staging, b"fresh staging")
    os.utime(managed_orphan, (0, 0))
    os.utime(user_jpeg, (0, 0))
    os.utime(old_staging, (0, 0))
    database = ThumbnailDatabase(str(root / "thumbnail-recovery.sqlite3"))
    try:
        database.sync_directory(str(project), str(project))
        database.mark_ready(str(source), source.stat().st_mtime_ns / 1_000_000, None, [{
            "sizeLabel": "small", "pixelSize": 320, "path": str(missing_cache), "fileSize": 128,
        }])
        assert database.get_file(str(source))["thumbnail_state"] == "READY"
        result = database.recover_cache_publications(str(cache), 200, scan_root_orphans=False)
        orphan_paths = {str(Path(item).resolve()).casefold() for item in result["orphanPaths"]}
        assert result["repairedMissingCount"] == 1
        assert database.get_file(str(source))["thumbnail_state"] == "STALE"
        assert str(old_staging.resolve()).casefold() in orphan_paths
        assert str(fresh_staging.resolve()).casefold() not in orphan_paths
        assert str(managed_orphan.resolve()).casefold() not in orphan_paths, "custom/shared root recovery must not scan root JPEGs"
        root_scan = database.recover_cache_publications(str(cache), 200, scan_root_orphans=True)
        root_orphans = {str(Path(item).resolve()).casefold() for item in root_scan["orphanPaths"]}
        assert str(managed_orphan.resolve()).casefold() in root_orphans
        assert str(user_jpeg.resolve()).casefold() not in root_orphans
    finally:
        database.close()


def test_media_workflow_graph_cleanup(root: Path) -> None:
    workspace = root / "workflow-cleanup-workspace"
    project = workspace / "Project"
    original_path = project / "Original"
    progress_path = project / "图片后期_1"
    component_path = project / "组件工作区"
    import_path = project / "explicit-import-slot"
    original_path.mkdir(parents=True)
    progress_path.mkdir()
    component_path.mkdir()
    import_path.mkdir()
    db = connect(str(workspace), str(root / "workflow-cleanup.sqlite3"))
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        ("workflow-cleanup-project", "Project", "后期中", "Project", 1, 1),
    )
    db.commit()
    original = progress_register(str(workspace), db, {
        "projectName": "Project", "mediaKind": "image", "versionKey": "source",
        "displayName": "Original", "folderPath": str(original_path),
        "nodeRole": "original", "trackingEnabled": False,
    })["progressFolder"]
    progress = progress_register(str(workspace), db, {
        "projectName": "Project", "mediaKind": "image", "versionKey": "1",
        "displayName": "图片后期_1", "folderPath": str(progress_path),
        "nodeRole": "progress", "parentProgressId": original["id"], "relationKind": "main", "trackingEnabled": False,
    })["progressFolder"]
    workflow = progress_register(str(workspace), db, {
        "projectName": "Project", "mediaKind": "image", "versionKey": "plugin-workflow",
        "displayName": "组件工作区", "folderPath": str(component_path),
        "nodeRole": "workflow", "artifactKind": "component_workspace",
        "sourceMetadata": {
            "category": "workflow", "componentId": "test-plugin",
            "parentCapability": "workflow-input",
        },
        "trackingEnabled": False,
    })["progressFolder"]
    imported = media_workflow_import_commit(str(workspace), db, {
        "schemaVersion": 2,
        "projectName": "Project",
        "importSessionId": "maintenance-slot",
        "artifacts": [{
            "relativePath": "explicit-import-slot", "mediaKind": "image",
            "importSlot": "raw", "displayName": "Imported source",
        }],
    })["nodes"][0]
    version_graph_edge_create(db, {
        "projectId": "workflow-cleanup-project", "sourceProgressId": progress["id"],
        "targetProgressId": workflow["id"], "edgeKind": "workflow_input",
    })
    db.execute("UPDATE progress_folders SET artifact_kind='companion' WHERE id=?", (imported["id"],))
    db.execute("DROP TRIGGER version_graph_edges_validate_insert")
    db.execute(
        """INSERT INTO version_graph_edges(id,project_id,source_progress_id,target_progress_id,edge_kind,created_at,updated_at)
           VALUES('invalid-companion-source','workflow-cleanup-project',?,?,'workflow_input',1,1)""",
        (imported["id"], workflow["id"]),
    )
    workspace_db_module._install_progress_purpose_constraints(db)
    db.commit()
    preserved = cleanup_media_workflow_graph(str(workspace), db, session_cutoff=0)
    assert preserved["removedEdgeIds"] == ["invalid-companion-source"]
    assert preserved["removedImportSlotMappingCount"] == 1
    assert db.execute("SELECT COUNT(*) FROM version_graph_edges").fetchone()[0] == 1
    db.execute(
        """INSERT INTO media_import_graph_sessions(project_id,import_session_id,manifest_json,status,error,created_at,updated_at)
           VALUES(?,?,?,'committed',NULL,1,1)""",
        ("workflow-cleanup-project", "stale-session", "{}"),
    )
    db.commit()
    component_path.rmdir()
    import_path.rmdir()
    cleaned = cleanup_media_workflow_graph(str(workspace), db, session_cutoff=2)
    assert cleaned["removedImportSessionCount"] == 1
    missing = db.execute("SELECT missing_since FROM progress_folders WHERE id=?", (workflow["id"],)).fetchone()
    assert missing and missing[0]
    cleanup_progress_tombstones(str(workspace), db, cutoff=missing[0] + 1)
    assert db.execute("SELECT 1 FROM progress_folders WHERE id=?", (workflow["id"],)).fetchone() is None
    assert db.execute("SELECT COUNT(*) FROM version_graph_edges").fetchone()[0] == 0
    assert db.execute("SELECT 1 FROM progress_folders WHERE id=?", (imported["id"],)).fetchone() is None
    assert db.execute("SELECT COUNT(*) FROM media_import_artifact_slots").fetchone()[0] == 0
    db.close()


def test_thumbnail_studio_staging(root: Path) -> None:
    project = root / "studio-staging-project"
    staging_name = ".studio-20b8af8944d24a2ca6f5b8bf61105901"
    video = project / (staging_name + ".mp4")
    frame = project / staging_name.upper() / "frame-00000001.png"
    ordinary = project / ".studio-family.mp4"
    for candidate in (video, frame, ordinary):
        write_media(candidate, b"synthetic media")
    database = ThumbnailDatabase(str(root / "studio-staging.sqlite3"))
    try:
        assert database.sync_paths(str(project), [str(video), str(frame)])["records"] == []
        assert database.sync_directory(str(project), str(frame.parent))["records"] == []
        records = database.sync_directory(str(project), str(project))["records"]
        assert [Path(record["path"]).name for record in records] == [ordinary.name]
        assert database.sync_project(str(project))["fileCount"] == 1
        assert database.get_file(str(video)) is None
        assert database.get_file(str(frame)) is None
        published = project / "studio-export.mp4"
        video.rename(published)
        records = database.sync_paths(str(project), [str(published)])["records"]
        assert len(records) == 1 and records[0]["kind"] == "video"
        assert database.sync_project(str(project))["fileCount"] == 2
    finally:
        database.close()


def test_thumbnail_tool_sources_limit_convertible_images_to_direct_children(root: Path) -> None:
    project = root / "tool-source-project"
    mixed_folder = project / "mixed"
    direct_png = mixed_folder / "direct.png"
    direct_webp = mixed_folder / "direct.webp"
    nested_png = mixed_folder / "nested" / "nested.png"
    nested_heic = mixed_folder / "nested" / "nested.heic"
    nested_only_folder = project / "nested-only"
    deeply_nested_png = nested_only_folder / "child" / "deep.png"
    for file_path in (direct_png, direct_webp, nested_png, nested_heic, deeply_nested_png):
        write_media(file_path, b"png")

    database = ThumbnailDatabase(str(root / "tool-sources.sqlite3"))
    try:
        database.sync_project(str(project))

        recursive = database.inspect_tool_sources(str(project), [str(nested_only_folder)])
        assert recursive["hasConvertibleImage"], "regular tool availability should detect convertible images recursively"

        recursive_list = database.inspect_tool_sources(
            str(project), [str(mixed_folder)], collect_recursive_convertible_images=True
        )
        assert [value.casefold() for value in recursive_list["convertibleImagePaths"]] == sorted(
            [str(direct_png.resolve()).casefold(), str(direct_webp.resolve()).casefold(),
             str(nested_png.resolve()).casefold(), str(nested_heic.resolve()).casefold()]
        )

        direct_only = database.inspect_tool_sources(
            str(project), [str(mixed_folder)], collect_direct_convertible_images=True
        )
        assert direct_only["hasConvertibleImage"]
        assert [value.casefold() for value in direct_only["convertibleImagePaths"]] == sorted(
            [str(direct_png.resolve()).casefold(), str(direct_webp.resolve()).casefold()]
        )

        nested_only = database.inspect_tool_sources(
            str(project), [str(nested_only_folder)], collect_direct_convertible_images=True
        )
        assert not nested_only["hasConvertibleImage"]
        assert nested_only["convertibleImagePaths"] == []

        direct_file = database.inspect_tool_sources(
            str(project), [str(nested_heic)], collect_direct_convertible_images=True
        )
        assert [value.casefold() for value in direct_file["convertibleImagePaths"]] == [str(nested_heic.resolve()).casefold()]
    finally:
        database.close()


def test_missing_progress_replacement(root: Path) -> None:
    workspace = root / "progress-workspace"
    project = workspace / "Project"
    source = project / "Original"
    original = project / "图片后期_1"
    source.mkdir(parents=True)
    original.mkdir()
    db = connect(str(workspace), str(root / "progress-workspace.sqlite3"))
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        ("progress-project", "Project", "后期中", "Project", 1, 1),
    )
    db.commit()
    try:
        source_node = progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "source",
            "displayName": "Original", "folderPath": str(source), "nodeRole": "original", "trackingEnabled": False,
        })["progressFolder"]
        registered = progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "1",
            "parentProgressId": source_node["id"], "relationKind": "main",
            "displayName": "图片后期_1", "folderPath": str(original), "trackingEnabled": True,
        })["progressFolder"]
        original.rmdir()
        missing = next(item for item in progress_list(str(workspace), db, {"projectName": "Project", "includeMissing": True})["progressFolders"] if item["id"] == registered["id"])
        assert missing["id"] == registered["id"] and missing["folderMissing"] and missing["missingSince"]

        # Recreating the original path produces a new filesystem identity. It
        # must revive the tombstone and keep following subsequent renames.
        original.mkdir()
        revived = next(item for item in progress_list(str(workspace), db, {"projectName": "Project"})["progressFolders"] if item["id"] == registered["id"])
        assert revived["id"] == registered["id"] and not revived["folderMissing"] and revived["missingSince"] is None
        relocated = project / "图片后期_1_已恢复"
        original.rename(relocated)
        followed = next(item for item in progress_list(str(workspace), db, {"projectName": "Project"})["progressFolders"] if item["id"] == registered["id"])
        assert Path(followed["folderPath"]).resolve() == relocated.resolve()
        relocated.rmdir()
        missing_again = next(item for item in progress_list(str(workspace), db, {"projectName": "Project", "includeMissing": True})["progressFolders"] if item["id"] == registered["id"])
        assert missing_again["folderMissing"] and missing_again["missingSince"]

        replacement = project / "图片后期_1_替换"
        replacement.mkdir()
        replaced = progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "1",
            "parentProgressId": source_node["id"], "relationKind": "main",
            "displayName": "图片后期_1_替换", "folderPath": str(replacement), "trackingEnabled": True,
        })["progressFolder"]
        assert replaced["id"] == registered["id"]
        assert not replaced["folderMissing"] and replaced["missingSince"] is None
        assert Path(replaced["folderPath"]).resolve() == replacement.resolve()
    finally:
        db.close()


def test_incremental_progress_append_preserves_existing_items(root: Path) -> None:
    workspace = root / "append-workspace"
    project = workspace / "Project"
    baseline_folder = project / "图片后期_1"
    target_folder = project / "图片后期_2"
    for name in ("one.jpg", "two.jpg"):
        write_media(baseline_folder / name, f"baseline-{name}".encode())
        write_media(target_folder / name, f"target-{name}".encode())
    db = connect(str(workspace), str(root / "append-workspace.sqlite3"))
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        ("append-project", "Project", "后期中", "Project", 1, 1),
    )
    db.commit()
    try:
        original_full_fingerprint = workspace_db_module.full_fingerprint
        workspace_db_module.full_fingerprint = lambda _path: (_ for _ in ()).throw(
            AssertionError("interactive batch commit must not calculate full-file hashes")
        )
        batch_register_baseline(str(workspace), db, {
            "projectName": "Project", "folderPath": str(baseline_folder),
        })
        first = batch_commit_compare(str(workspace), db, {
            "projectName": "Project", "folderA": str(baseline_folder), "folderB": str(target_folder),
            "importKey": "initial-v2", "displayName": "图片后期_2", "matches": [
                {"reference": "one.jpg", "source": "one.jpg", "distance": 0, "confidence": "高"},
                {"reference": "two.jpg", "source": "two.jpg", "distance": 0, "confidence": "高"},
            ],
        })
        batch_id = first["batch"]["id"]
        (target_folder / "two.jpg").unlink()
        write_media(baseline_folder / "three.jpg", b"baseline-three")
        write_media(target_folder / "three.jpg", b"target-three")
        appended = batch_commit_compare(str(workspace), db, {
            "projectName": "Project", "folderA": str(baseline_folder), "folderB": str(target_folder),
            "importKey": "append-v2", "displayName": "图片后期_2", "reconcileExisting": True,
            "incrementalSources": ["three.jpg"],
            "matches": [{"reference": "three.jpg", "source": "three.jpg", "distance": 0, "confidence": "高"}],
        })
        assert appended["batch"]["id"] == batch_id
        item_names = {row["source_name"] for row in db.execute("SELECT source_name FROM batch_items WHERE batch_id=?", (batch_id,))}
        assert item_names == {"one.jpg", "two.jpg", "three.jpg"}
    finally:
        workspace_db_module.full_fingerprint = original_full_fingerprint
        db.close()


def test_modify_progress_replaces_missing_version(root: Path) -> None:
    workspace = root / "replace-progress-workspace"
    project = workspace / "Project"
    missing_path = project / "图片后期_1"
    active_path = project / "图片后期_2"
    child_path = project / "图片后期_2_1"
    original_path = project / "Original"
    for folder in (original_path, missing_path, active_path, child_path):
        folder.mkdir(parents=True, exist_ok=True)
    db = connect(str(workspace), str(root / "replace-progress-workspace.sqlite3"))
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        ("replace-progress-project", "Project", "后期中", "Project", 1, 1),
    )
    db.commit()
    try:
        original = progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "source",
            "displayName": "Original", "folderPath": str(original_path), "nodeRole": "original", "trackingEnabled": False,
        })["progressFolder"]
        missing = progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "1",
            "parentProgressId": original["id"], "relationKind": "main",
            "displayName": "图片后期_1", "folderPath": str(missing_path), "trackingEnabled": True,
        })["progressFolder"]
        active = progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "2",
            "parentProgressId": original["id"], "relationKind": "main",
            "displayName": "图片后期_2", "folderPath": str(active_path), "trackingEnabled": True,
        })["progressFolder"]
        child = progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "2_1",
            "parentProgressId": active["id"], "displayName": "图片后期_2_1",
            "folderPath": str(child_path), "trackingEnabled": True,
        })["progressFolder"]
        missing_path.rmdir()
        active_path.rename(missing_path)
        remapped_child_path = project / "图片后期_1_1"
        child_path.rename(remapped_child_path)
        updated = progress_update_tree(str(workspace), db, {
            "projectName": "Project", "primaryProgressId": missing["id"],
            "replacementProgressId": active["id"],
            "updates": [
                {"id": missing["id"], "mediaKind": "image", "versionKey": "1", "parentProgressId": original["id"], "displayName": "图片后期_1", "folderPath": str(missing_path), "trackingEnabled": True},
                {"id": child["id"], "mediaKind": "image", "versionKey": "1_1", "parentProgressId": missing["id"], "displayName": "图片后期_1_1", "folderPath": str(remapped_child_path), "trackingEnabled": True},
            ],
        })
        assert updated["progressFolder"]["id"] == missing["id"]
        rows = {item["id"]: item for item in progress_list(
            str(workspace), db, {"projectName": "Project", "includeMissing": True}
        )["progressFolders"]}
        assert not rows[missing["id"]]["folderMissing"] and rows[missing["id"]]["versionKey"] == "1"
        assert rows[active["id"]]["folderMissing"] and rows[active["id"]]["versionKey"] == "2"
        assert rows[child["id"]]["parentProgressId"] == missing["id"] and rows[child["id"]]["versionKey"] == "1_1"
    finally:
        db.close()


def test_missing_progress_removal_is_safe(root: Path) -> None:
    workspace = root / "remove-progress-workspace"
    project = workspace / "Project"
    baseline_folder = project / "selection"
    missing_folder = project / "progress-v1"
    child_folder = project / "progress-v1-child"
    preview_folder = project / "progress-v1-preview"
    write_media(baseline_folder / "one.jpg", b"baseline")
    write_media(missing_folder / "one.jpg", b"version-one")
    child_folder.mkdir(parents=True)
    preview_folder.mkdir(parents=True)
    db = connect(str(workspace), str(root / "remove-progress.sqlite3"))
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        ("remove-progress-project", "Project", "后期中", "Project", 1, 1),
    )
    db.commit()
    try:
        baseline_progress = progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "0",
            "displayName": "selection", "folderPath": str(baseline_folder), "nodeRole": "original", "trackingEnabled": False,
        })["progressFolder"]
        parent_progress = progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "1",
            "parentProgressId": baseline_progress["id"], "displayName": "progress-v1",
            "folderPath": str(missing_folder), "trackingEnabled": True,
        })["progressFolder"]
        child_progress = progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "1_1",
            "parentProgressId": parent_progress["id"], "displayName": "progress-v1-child",
            "folderPath": str(child_folder), "trackingEnabled": True,
        })["progressFolder"]
        preview_progress = progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "preview-v1",
            "displayName": "progress-v1-preview", "folderPath": str(preview_folder),
            "nodeRole": "artifact", "artifactKind": "preview", "trackingEnabled": False,
            "trackingState": "disabled",
        })["progressFolder"]
        preview_edge = version_graph_edge_create(db, {
            "projectId": "remove-progress-project", "sourceProgressId": parent_progress["id"],
            "targetProgressId": preview_progress["id"], "edgeKind": "derived_preview",
        })["edge"]
        batch_register_baseline(str(workspace), db, {
            "projectName": "Project", "folderPath": str(baseline_folder),
        })
        committed = batch_commit_compare(str(workspace), db, {
            "projectName": "Project", "folderA": str(baseline_folder), "folderB": str(missing_folder),
            "importKey": "remove-v1", "displayName": "progress-v1", "matches": [{
                "reference": "one.jpg", "source": "one.jpg", "distance": 0, "confidence": "high",
            }],
        })

        # V0 is protected even if its directory is externally removed.
        (baseline_folder / "one.jpg").unlink()
        baseline_folder.rmdir()
        try:
            progress_delete_missing(str(workspace), db, {
                "projectName": "Project", "progressId": baseline_progress["id"],
            })
            raise AssertionError("missing V0 progress must not be removable")
        except ValueError as error:
            assert "V0" in str(error)

        # A stale database flag must not permit detaching a media file that is
        # still physically available at a relocated path.
        recovered_file = project / "recovered-one.jpg"
        (missing_folder / "one.jpg").rename(recovered_file)
        missing_folder.rmdir()
        version_id = db.execute(
            "SELECT version_id FROM batch_items WHERE batch_id=?",
            (committed["batch"]["id"],),
        ).fetchone()[0]
        db.execute(
            "UPDATE versions SET file_path=?,file_path_key=?,file_missing=1 WHERE id=?",
            (str(recovered_file.resolve()), str(recovered_file.resolve()).casefold(), version_id),
        )
        db.commit()
        try:
            progress_delete_missing(str(workspace), db, {
                "projectName": "Project", "progressId": parent_progress["id"],
            })
            raise AssertionError("progress with an available media file must not be removable")
        except ValueError as error:
            assert "可用文件" in str(error)

        recovered_file.unlink()
        try:
            progress_delete_missing(str(workspace), db, {
                "projectName": "Project", "progressId": parent_progress["id"],
            })
            raise AssertionError("missing progress must not strand a child under a missing original")
        except ValueError as error:
            assert "下游节点" in str(error)
        repair_source_folder = project / "repair-source"
        repair_source_folder.mkdir()
        repair_source = progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "repair-source",
            "displayName": "repair-source", "folderPath": str(repair_source_folder),
            "nodeRole": "original", "trackingEnabled": False,
        })["progressFolder"]
        progress_relation_update(db, {
            "childProgressId": child_progress["id"], "parentProgressId": repair_source["id"],
        })
        removed = progress_delete_missing(str(workspace), db, {
            "projectName": "Project", "progressId": parent_progress["id"],
        })
        assert removed["success"] and removed["deletedVersionCount"] == 1
        assert removed["deletedBatchCount"] == 1 and removed["reparentedProgressCount"] == 0
        remaining = {item["id"]: item for item in progress_list(str(workspace), db, {"projectName": "Project"})["progressFolders"]}
        assert parent_progress["id"] not in remaining
        assert remaining[child_progress["id"]]["parentProgressId"] == repair_source["id"]
        assert preview_progress["id"] in remaining
        assert db.execute("SELECT 1 FROM version_graph_edges WHERE id=?", (preview_edge["id"],)).fetchone() is None
        assert db.execute("SELECT is_deleted FROM versions WHERE id=?", (version_id,)).fetchone()[0] == 1
    finally:
        db.close()


def test_version_cleanup(root: Path) -> None:
    workspace = root / "workspace"
    project = workspace / "Project"
    originals = [project / "one.jpg", project / "two.jpg"]
    for index, original in enumerate(originals):
        write_media(original, f"original-{index}".encode())
    db = connect(str(workspace), str(root / "workspace.sqlite3"))
    now = 1
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        ("project", "Project", "未分类", "Project", now, now),
    )
    db.commit()

    created = []
    for index, original in enumerate(originals):
        baseline = media_get(str(workspace), db, {"projectName": "Project", "filePath": str(original)})
        photo = baseline["photo"]
        base = baseline["versions"][0]
        version_file = project / f"version-{index}.jpg"
        write_media(version_file, f"version-{index}".encode())
        version_bundle = media_create_version(db, {
            "photoId": photo["id"], "parentVersionId": base["id"], "filePath": str(version_file),
            "versionName": "丢失版本",
        })
        version = version_bundle["versions"][-1]
        thumbnail = root / "workspace-data" / "thumbnails" / photo["id"] / f"{version['id']}.jpg"
        write_media(thumbnail, b"preview")
        media_set_thumbnail(db, {"versionId": version["id"], "thumbnailPath": str(thumbnail)})
        version_file.unlink()
        media_get(str(workspace), db, {"projectName": "Project", "filePath": str(original)})
        created.append((photo, base, version, thumbnail))

    scope = media_version_delete_scope(db, {"versionId": created[0][2]["id"]})
    assert scope["versionCount"] == 2 and scope["allMissing"] and scope["childCount"] == 0
    deleted = media_delete_project_missing_version(db, {"versionId": created[0][2]["id"]})
    assert deleted["deletedCount"] == 2
    assert len(deleted["deletedVersions"]) == 2
    next_versions = []
    for photo, base, _version, _thumbnail in created:
        remaining = media_get_photo(db, {"photoId": photo["id"]})
        assert [item["versionNumber"] for item in remaining["versions"]] == [0]
        next_file = project / f"next-{photo['id']}.jpg"
        write_media(next_file, b"next")
        next_bundle = media_create_version(db, {
            "photoId": photo["id"], "parentVersionId": base["id"], "filePath": str(next_file),
            "versionName": "新版本",
        })
        assert next_bundle["versions"][-1]["versionNumber"] == 2
        next_versions.append(next_bundle["versions"][-1])

    child_file = project / "child-version.jpg"
    write_media(child_file, b"child")
    child_bundle = media_create_version(db, {
        "photoId": created[0][0]["id"], "parentVersionId": next_versions[0]["id"],
        "filePath": str(child_file), "versionName": "后续版本",
    })
    child_version = child_bundle["versions"][-1]
    single_scope = media_version_delete_scope(db, {"versionId": next_versions[0]["id"]})
    assert single_scope["versionCount"] == 2 and not single_scope["allMissing"]
    assert single_scope["selectedChildCount"] == 1 and single_scope["childCount"] == 1
    single_deleted = media_delete_version(db, {"versionId": next_versions[0]["id"]})
    assert single_deleted["reparentedCount"] == 1
    first_remaining = media_get_photo(db, {"photoId": created[0][0]["id"]})["versions"]
    assert [item["id"] for item in first_remaining] == [created[0][1]["id"], child_version["id"]]
    assert first_remaining[-1]["parentVersionId"] == created[0][1]["id"]
    assert any(item["id"] == next_versions[1]["id"] for item in media_get_photo(db, {"photoId": created[1][0]["id"]})["versions"])

    db.close()


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="photoflow-maintenance-") as directory:
        root = Path(directory)
        test_thumbnail_studio_staging(root)
        test_thumbnail_missing_prune(root)
        test_thumbnail_cleanup_uses_access_index(root)
        test_thumbnail_epoch_publish_contract(root)
        test_thumbnail_epoch_fence_at_scale(root)
        test_thumbnail_cleanup_commits_in_batches(root)
        test_thumbnail_recovery_cursor_pages(root)
        test_thumbnail_resumable_schema_migration(root)
        test_thumbnail_startup_recovery_contract(root)
        test_media_workflow_graph_cleanup(root)
        test_thumbnail_tool_sources_limit_convertible_images_to_direct_children(root)
        test_missing_progress_replacement(root)
        test_incremental_progress_append_preserves_existing_items(root)
        test_modify_progress_replaces_missing_version(root)
        test_missing_progress_removal_is_safe(root)
        test_version_cleanup(root)
    print("Data maintenance tests passed.")


if __name__ == "__main__":
    main()
