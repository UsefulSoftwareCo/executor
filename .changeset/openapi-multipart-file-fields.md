---
"@executor-js/plugin-openapi": patch
---

Multipart file fields in an OpenAPI spec now accept and send real files. A `multipart/form-data` property typed as a binary or byte string is rewritten into the SDK's tool-file schema when the tool is extracted, so an agent supplies a file the same way it does everywhere else. On invocation those values are decoded back into `File`/`Blob` parts — as bare properties and inside arrays — instead of being JSON-stringified into the form body, which is what upstreams were previously rejecting.
