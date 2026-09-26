"""Durability classification for workspace database actions.

Every workspace database action has exactly one durability class, and that class
decides whether the action has to pay for the staged database-publication round
trip implemented by ``_run_durable_media_operation``.

``transaction``
    The action only writes database rows, and those rows live in one SQLite write
    transaction. WAL plus ``synchronous=FULL`` already makes that transaction
    crash-safe, and the action's own rows carry the idempotency markers a retry
    needs. Staging a full copy of the core/media/versioning databases before such
    an action costs hundreds of megabytes per call and protects nothing the
    transaction does not already protect.

    A transaction-class action may still *read* the filesystem to build a
    manifest or record metadata (``media_sync_paths_prepare`` walks changed
    directories, ``media_set_thumbnail`` records a cache path). Reading a file is
    not a filesystem effect: there is nothing to roll back.

``publication``
    The action moves, renames, or creates media files, carries a deferred
    filesystem phase, or has no per-row idempotency marker of its own. These
    actions keep the durable staging journal, the live filesystem phase, and the
    ordered media/versioning/core publication.

Three sets are exported because the two runtimes need different projections of
the same decision:

``PUBLICATION_ACTIONS``
    Staged by Python. Electron mirrors this union in
    ``electron/repositories/workspace-database-operation-policy.cjs``.

``TRANSACTION_ACTIONS``
    In-place writers. This is the list that was moved off staging.

``EXCLUSIVE_LEASE_ACTIONS``
    Actions that must still exclude other database readers for correctness rather
    than for replay. They belong to both of the two concerns above: they write in
    place, but they must not run while another worker holds the database open,
    because an in-place ``BEGIN IMMEDIATE`` contends with every reader that still
    has the file mapped.

The classification is exhaustive by construction: ``DURABILITY_CLASS`` is
assembled from the sets and asserted below, so an action cannot silently land in
two classes.

The replay contract is unchanged for databases written by older builds. A
database that still carries a ``media_operation_journal_v1`` row is replayed by
``connect()`` exactly as before; new builds simply never create one for a
transaction-class action.
"""

from __future__ import annotations

DURABILITY_TRANSACTION = "transaction"
DURABILITY_PUBLICATION = "publication"

# Actions whose only durable effect is an in-place SQLite write transaction.
TRANSACTION_ACTIONS = frozenset((
    # Incremental media index. Every batch persists its own payload digest and
    # result in `media_incremental_snapshot_batches`, so a retry is a no-op and a
    # half-applied snapshot is resumable from its own manifest.
    "media_sync_paths_prepare",
    "media_sync_paths_apply_batch",
    "media_sync_paths_finalize",
    "media_sync_abort",
    # Version metadata. The media files already exist on disk; these actions
    # record where they are and what they are, they never move them.
    "media_create_version",
    "media_update_version",
    "media_component_update_version",
    "media_component_delete_version",
    "media_refresh_metadata_fingerprint",
    "media_set_thumbnail",
    "media_relocate_version",
    "media_delete_version",
    "media_delete_project_missing_version",
    "media_record_compare",
))

# Actions that keep the staged publication journal.
PUBLICATION_ACTIONS = frozenset((
    # A full folder walk that registers media in bulk. It has no per-row
    # idempotency marker of its own, so an interrupted run has to be recoverable
    # as a whole instead of resumed from row state.
    "media_sync_apply_batch",
    "media_sync_finalize",
    "batch_register_baseline",
    # These own the deferred filesystem phase (`batch_file_operations`), where a
    # crash between two renames has to be replayed from the journal.
    "batch_commit_compare",
    "batch_retry_operations",
    # This copies reference files into the progress folder.
    "tracking_apply_copies",
))

# Transaction-class actions that must still hold the exclusive database lease.
# They write in place, which cannot proceed while another worker keeps the
# database open, and the work they protect (staging a scan manifest, coordinating
# a version import) is long enough that interleaving readers would starve it.
#
# `media_sync_prepare` is deliberately absent even though it is the long pole of
# a full scan: it only reads the filesystem and updates schema metadata, so it
# keeps the ordinary writer lease and lets readers overlap. It becomes a staged
# publication (and therefore exclusive) only when it runs through
# `media_sync_apply_batch` / `media_sync_finalize`.
EXCLUSIVE_LEASE_ACTIONS = frozenset((
    "media_sync_paths_prepare",
    "media_sync_paths_apply_batch",
    "media_sync_paths_finalize",
    "media_create_version",
    "media_update_version",
    "media_set_thumbnail",
))

# Electron's `DURABLE_PUBLICATION_ACTIONS` must equal exactly this union.
ELECTRON_EXCLUSIVE_ACTIONS = PUBLICATION_ACTIONS | EXCLUSIVE_LEASE_ACTIONS

# `media_sync_project` is a legacy composite: it drives `media_sync_prepare`,
# `media_sync_apply_batch` and `media_sync_finalize` through `mutate()`, so each
# stage already gets its own staging, recovery and idempotency markers. Wrapping
# the composite as well would stage the whole database set around work that is
# itself already staged, so it is deliberately unclassified.

# The batch actions that carry a deferred filesystem phase. This is not a
# durability class: it decides whether a staged run may perform renames itself or
# has to hand them to the live filesystem phase.
BATCH_FILESYSTEM_EFFECT_ACTIONS = frozenset(("batch_commit_compare", "batch_retry_operations"))

DURABILITY_CLASS = {
    **{action: DURABILITY_TRANSACTION for action in TRANSACTION_ACTIONS},
    **{action: DURABILITY_PUBLICATION for action in PUBLICATION_ACTIONS},
}

_OUTSIDE_TRANSACTION = EXCLUSIVE_LEASE_ACTIONS - TRANSACTION_ACTIONS
if _OUTSIDE_TRANSACTION:
    raise RuntimeError(
        "an exclusive-lease action must also be an in-place transaction: "
        f"{sorted(_OUTSIDE_TRANSACTION)}"
    )

if not DURABILITY_CLASS or len(DURABILITY_CLASS) != len(TRANSACTION_ACTIONS) + len(PUBLICATION_ACTIONS):
    raise RuntimeError("durability classification is inconsistent")


def durability_class(action: str) -> str:
    """Return the durability class, defaulting to the in-place transaction path.

    Unclassified actions are the ordinary catalog writes (`add`, `rename`,
    `progress_*`, `tracking_*`, `undo_record_*`, ...). They never staged, so
    their class is the in-place transaction path.
    """
    return DURABILITY_CLASS.get(str(action), DURABILITY_TRANSACTION)


def requires_publication(action: str) -> bool:
    return durability_class(action) == DURABILITY_PUBLICATION


def requires_exclusive_lease(action: str) -> bool:
    return str(action) in ELECTRON_EXCLUSIVE_ACTIONS


def durability_manifest() -> dict:
    """Machine-readable classification for cross-runtime contract tests."""
    return {
        "transaction": sorted(TRANSACTION_ACTIONS),
        "publication": sorted(PUBLICATION_ACTIONS),
        # The actions Electron has to give the exclusive database lease.
        "exclusiveLease": sorted(ELECTRON_EXCLUSIVE_ACTIONS),
        # Of those, the ones that hold it while writing in place rather than while
        # publishing a staged copy.
        "exclusiveInPlace": sorted(EXCLUSIVE_LEASE_ACTIONS),
        "batchFilesystemEffects": sorted(BATCH_FILESYSTEM_EFFECT_ACTIONS),
    }
