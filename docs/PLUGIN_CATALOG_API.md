# Cloud plugin catalog

English | [简体中文](PLUGIN_CATALOG_API.zh-CN.md)

The public source build keeps its API base URL empty and does not contact the commercial service. This generic contract is retained for hosts explicitly configured with an approved HTTPS endpoint. This repository ships no backend or credentials.

GET /v1/plugins returns {plugins:[...]}. Public fields are id, name, homepage, latestVersion, capabilities, formats and previewPromptEnabled. Only published records are returned; homepages must pass the host HTTPS/domain policy. Preview prompts require an exact suffix match, the preview capability and strict boolean true. Existing enabled decoders suppress prompts; shortcuts do not trigger them.

Successful lists are cached for one minute. Failed refreshes clear prompts, do not block local preview and retry no sooner than fifteen seconds. Catalog requests are independent of telemetry and send no installation identity, filename or local path. Administration and deployment remain outside the public host scope.
