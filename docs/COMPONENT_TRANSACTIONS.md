# Component installation transactions

The component platform protects ordinary application crashes, conflicting host
operations, and accidental deletion outside owned paths. It does not attempt to
make its private JSON files tamper-proof against another process running as the
same user. Package validation and the Host API permission boundaries remain in
place.

## Ownership and admission

The lifecycle coordinator stops new work, drains existing Host calls and waits
for component processes and views to stop before a destructive operation. A
failed process-tree shutdown still prevents uninstall and normal application
exit. The transaction service also serializes operations and recovery by
component. Global recovery waits for all active operations.

Each admitted operation has two files:

```text
components/.transactions/<component-id>/
  receipt.json   Immutable operation, paths, original identities and user choices
  state.json     Current phase, cleanup progress and last error
```

Both files are prepared in a private `.admit-<component-id>-<operation-id>`
directory before that directory is published. No runtime rename or transaction
cleanup precedes admission. The caller transfers preparation-file ownership
only after admission succeeds.

The receipt contains the large file inventories once. The state binds to the
receipt with its operation ID and one content digest. State writes use a synced
temporary file in the same directory and replace the current file without
unlinking it first. There are no historical state files or hash chains. These
guarantees cover process crashes; directory fsync is unavailable through the
Node Windows API, so this is not a promise of recovery from every power failure.

This format is schema version 3. There is no old-format migration or reader.
Unrecognized or malformed active records are retained and block their component.

## Recovery decisions

| Installation phase | Recovery |
| --- | --- |
| `prepared` | Restore the previous runtime using its identity and actual location |
| `published` | Remove the new runtime and restore the previous runtime |
| `host-committing` | Repeat the idempotent Host commit and continue forward |
| `cleanup-pending` | Keep the new runtime and finish cleanup |
| `done` | Reclaim metadata only; never replay enabled state or settings |

The forward-only decision is written before Host settings adoption. Normal
installation and startup recovery use the same Host commit function. Enabled
state is finalized before writing `done`.

Uninstall uses `prepared`, `quarantined`, `cleanup-pending`, and `done`. A
completed quarantine rename is recognized even if the following state write
was interrupted. After quarantine, recovery completes the uninstall; it never
pretends partially cleared user data can be rolled back. Explicit data-cleanup
steps record `executing` before the action and `applied` afterward. Their handlers
must be idempotent. Errors preserve the recovery phase in `lastError`.

## File cleanup

Runtime and transaction-owned preparation cleanup compare against the original
receipt. The first attempt checks the entire tree, persists `executing`, and then
deletes it. A retry accepts only a matching subset of that tree; absent entries
are already deleted. New files, changed contents, identity mismatches, junctions,
links, and paths outside the allowed root stop cleanup. Files are removed
individually and directories only when empty. No intent, proof, or verified
sidecars are created.

Before transaction admission, failed extraction and copy stages are disposable
scratch directories. The existing background-task service stores compact root
identity receipts for these paths, avoiding oversized task history. This path
accepts only the exact package-stage, package-snapshot and install-stage naming
patterns under the configured temporary/install roots. It never accepts an
installed runtime, component user data, or an arbitrary directory. Traversal
still rejects links and verifies node identities before deletion. Background
task admission must be flushed before cleanup starts.

## Completed metadata

After `done`, the entire journal directory moves to
`.retired-<component-id>-<operation-id>` and its known JSON/temp files are deleted.
Failure leaves a warning in the application log, not a failed installation or
uninstall. Global recovery retries this housekeeping. It never follows business
paths contained in retired receipts. Unknown files are preserved. There is no
GC marker or separate GC transaction. Filtered recovery never sweeps another
component's admission directory.

## Verification

`npm run test:component-transactions` covers interrupted publication, interrupted
rollback, real child-process exits, Host commit failure, partial deletion,
user-data cleanup retry, invalid ownership, state replacement failure, metadata
cleanup failure, large receipts and concurrent operations/recovery.

The component release gate includes these tests. The unchanged lifecycle, quit,
Host API and Windows Job Object suites cover the surrounding safety boundaries.
