# Built-in compressed files

English | [简体中文](COMPRESSED_FILES.zh-CN.md)

Windows x64 builds use the original, verified 7-Zip 26.04 engine. Run `npm run prepare:compression` before development or engine tests. The build wrapper prepares it before packaging. The pinned URL and SHA-256 are in `electron/services/compressed-files/runtime.lock.json`. Development resources use `electron/bin/archive`; installed resources use `resources/archive`, including License.txt. No engine binaries are tracked here.

## Browse and use archives

- Open supported archives from a project or inspiration folder using the configured single/double click. Members appear in the existing file browser with navigation, breadcrumbs, search, sorting, list/grid view, and preview. Listing does not extract the entire archive into the project.
- Individual previews are extracted on demand into private storage. Images, RAW, and video use the host media pipeline; text up to 1 MiB uses the existing preview. Other files open with the default application. Passwords remain in the active session. Changes to extracted temporary copies do not modify the archive.
- Archive directories are read-only. Import, rename, deletion, paste, drag/drop, and writing tools are unavailable. Closing or evicting a session revokes media tokens and cleans temporary members.
- Right-click ordinary files/folders to add them to an archive; right-click an archive to extract it. The Office menu also opens extraction. Both tools use the host tool panel and task progress.
- Compression defaults to ZIP/7z and a name based on the common folder or project. Advanced settings include level, password, volumes, size limit, and comments; 7z comments are unsupported. Format preference is remembered.
- Extraction creates a same-name folder next to the archive; conflicts receive a numbered name. Compression conflicts also receive a new name. Existing files remain intact. Compound and split names such as `photos.tar.gz` and `photos.7z.001` are recognized.

## Boundaries and migration

The native `compressed-files` IPC accepts application windows only and resolves the bound project/inspiration context again. Renderers cannot select engine paths, temporary paths, or absolute output paths. Operations reuse scoped input tokens, private storage, tasks, and output transactions; they do not run a plugin service.

The engine rejects unsafe paths, links, alternate streams, case collisions, and unsupported Windows names before extraction. It allows at most 2,000 entries. Extraction/browsing defaults to a 16 GiB limit; compression advanced settings allow 1–64 GiB. Output is staged, validated, then published. A failed publication retains the stage and idempotency key for retry.

The retired `archive-tools` plugin cannot contribute menus or be re-enabled. Full application startup removes its installed runtime through the existing uninstall transaction while retaining component data, including pending output. Historical delivery ZIPs are retained. Fully restart Electron after updating the main process; refreshing the development page is insufficient.

The generic selection/context-menu filters, output stage capacity, file handlers, and component icons remain public plugin contracts. See [plugin development](PLUGIN_DEVELOPMENT.md).

## Verification and licenses

`npm run test:compressed-files` exercises the real engine, encryption/volumes, directory naming, member reads, passwords, cancellation, recovery, and generic plugin declarations. UI and complete Electron integration need separate verification.

[7-Zip 26.04 source](https://github.com/ip7z/7zip/tree/26.04) · [LGPL 2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html). RAR extraction includes unRAR restrictions and cannot be used to develop RAR compression algorithms. Binary distributors must retain engine notices and meet applicable corresponding-source and replacement obligations.
