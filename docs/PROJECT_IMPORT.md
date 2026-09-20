# Import existing projects

English | [简体中文](PROJECT_IMPORT.zh-CN.md)

**Add project → Import project** accepts any ordinary folder; an existing PhotoFlow project structure is not required.

- **Copy:** copy into the workspace and retain the source files.
- **Move:** copy and verify the files, register the project, then safely clean up the source. Changed files or cleanup failures leave the source intact and show a notice.
- **Reference the original location:** register the original folder as the project's physical root without shortcuts or media copies. File edits and deletion affect that folder directly; changing the project display name does not rename it.

All three modes preserve folder structure. Import does not identify or require confirmation of media/version directories; names such as RAW, JPG, and MOV are ordinary folders. Users may enable version management afterward.

Referenced projects remain registered while their disk is offline and become accessible again after reconnection. Duplicate references and directories overlapping registered projects are rejected.

Media import only copies or moves files. Creation, relocation, adoption, registries, and specialized recovery for external file/folder links inside projects have been removed, with no legacy external-link migration. Importing an external project registers an entire project; it does not mount outside media directories inside another project.

Plugin access is bounded by the imported project's registered physical root and uses normal project-relative paths. A root outside the workspace is valid; reaching another external directory from that project is still rejected. See [project media](PLUGIN_HOST_API.md#project-media).

The upstream project-import suite is not exposed as an npm command in this public checkout. Windows native move tests require access to inspect identities of temporary-directory ancestors. No local environment validation was run for this source update.
