"""Project references persist and reconnect without classifying ordinary folders."""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
import workspace_db

with tempfile.TemporaryDirectory(prefix='photoflow-external-project-') as temporary:
    base = Path(temporary)
    root = base / 'workspace'
    source = base / 'external'
    root.mkdir()
    source.mkdir()
    for name in ('RAW', 'JPG', 'MOV', 'v1', 'JPEG_导出'):
        (source / name).mkdir()
    database = str(base / 'data' / 'workspace.sqlite3')
    result = workspace_db.mutate(str(root), database, 'add', {
        'name': 'External', 'status': '策划中', 'relativePath': str(source),
        'extra': {'importMode': 'reference', 'ordinaryFiles': True},
    })
    def catalog():
        workspace_db.mutate(str(root), database, 'catalog_sync', {})
        return workspace_db.load(str(root), database)['projects']
    rows = catalog()
    assert len(rows) == 1 and rows[0]['relative_path'] == str(source)
    assert rows[0]['availability'] == 'available'
    identity = rows[0]['id']
    db = workspace_db.connect(str(root), database)
    try:
        result = workspace_db.progress_list(str(root), db, {'projectName': 'External'})
        assert result['progressFolders'] == [], result
    finally:
        db.close()
    disconnected = base / 'offline'
    source.rename(disconnected)
    assert catalog()[0]['availability'] == 'missing'
    disconnected.rename(source)
    restored = catalog()[0]
    assert restored['availability'] == 'available' and restored['id'] == identity
    workspace_db.mutate(str(root), database, 'rename', {
        'name': 'External', 'nextName': 'Display name', 'relativePath': str(source),
    })
    assert catalog()[0]['name'] == 'Display name'
    assert source.is_dir() and not (root / 'Display name').exists()
    assert json.loads(catalog()[0]['extra_json'])['ordinaryFiles'] is True
    # Copies/moves have the same ordinary-file semantics, with a local root.
    copied = root / 'Copied'
    copied.mkdir()
    (copied / 'RAW').mkdir()
    workspace_db.mutate(str(root), database, 'add', {
        'name': 'Copied', 'status': '策划中', 'relativePath': 'Copied',
        'extra': {'importMode': 'copy', 'ordinaryFiles': True},
    })
    db = workspace_db.connect(str(root), database)
    try:
        assert workspace_db.progress_list(str(root), db, {'projectName': 'Copied'})['progressFolders'] == []
    finally:
        db.close()
    # Removing a reference is catalog-only, including while its target is
    # online. Stale identities/statuses and ordinary copied projects cannot
    # use this path.
    external_row = next(row for row in catalog() if row['name'] == 'Display name')
    copied_row = next(row for row in catalog() if row['name'] == 'Copied')
    def remove_reference(row, **overrides):
        return workspace_db.mutate(str(root), database, 'delete', {
            'name': row['name'], 'status': row['status'], 'projectId': row['id'],
            'referenceOnly': True, **overrides,
        })
    for row, overrides in (
        (external_row, {'projectId': 'stale-project-id'}),
        (external_row, {'status': '后期中'}),
        (copied_row, {}),
    ):
        try:
            remove_reference(row, **overrides)
        except ValueError:
            pass
        else:
            raise AssertionError('invalid reference removal must be rejected')
    sentinel = source / 'preserved.txt'
    sentinel.write_text('synthetic fixture', encoding='utf-8')
    assert remove_reference(external_row)['success']
    assert sentinel.read_text(encoding='utf-8') == 'synthetic fixture'
    assert not any(row['name'] == 'Display name' for row in catalog())
    assert copied.is_dir()
    # Re-adding a removed reference gets a new registration identity. An old
    # context menu must not remove that replacement.
    workspace_db.mutate(str(root), database, 'add', {
        'name': 'Display name', 'status': '策划中', 'relativePath': str(source),
        'extra': {'importMode': 'reference', 'ordinaryFiles': True},
    })
    readded = next(row for row in catalog() if row['name'] == 'Display name')
    assert readded['id'] != external_row['id']
    try:
        remove_reference(external_row)
    except ValueError:
        pass
    else:
        raise AssertionError('stale identity cannot remove a re-added reference')
    source.rename(disconnected)
    offline_row = next(row for row in catalog() if row['name'] == 'Display name')
    assert offline_row['availability'] == 'missing'
    assert remove_reference(offline_row)['success']
    disconnected.rename(source)
    assert not any(row['name'] == 'Display name' for row in catalog()), 'reconnecting must not restore an explicitly removed reference'
    assert sentinel.read_text(encoding='utf-8') == 'synthetic fixture'
    deleted_source = base / 'externally-deleted'
    deleted_source.mkdir()
    workspace_db.mutate(str(root), database, 'add', {
        'name': 'Deleted reference', 'status': '策划中', 'relativePath': str(deleted_source),
        'extra': {'importMode': 'reference', 'ordinaryFiles': True},
    })
    deleted_row = next(row for row in catalog() if row['name'] == 'Deleted reference')
    deleted_source.rmdir()
    assert remove_reference(deleted_row)['success'], 'removal works immediately after external deletion, before the availability cache updates'
    assert not any(row['name'] == 'Deleted reference' for row in catalog())
print('external project catalog: passed')
