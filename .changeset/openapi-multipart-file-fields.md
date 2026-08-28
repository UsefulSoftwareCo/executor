---
"@executor-js/plugin-openapi": patch
---

Multipart file fields in an OpenAPI spec now accept and send real files. A `multipart/form-data` property typed as a binary or byte string is rewritten into the SDK's tool-file schema when the tool is extracted, so an agent supplies a file the same way it does everywhere else. On invocation those values are decoded back into `File`/`Blob` parts — as bare properties and inside arrays, with a per-property `encoding.contentType` applied to each file part — instead of being JSON-stringified into the form body, which is what upstreams were previously rejecting. A file whose base64 payload does not decode now fails the invocation and names the field, rather than sending the file envelope as JSON.

The rewrite advertises only the shapes the request encoder can deliver. Two are deliberately left alone:

- A binary field nested inside an object property. Only top-level multipart properties and direct items of a top-level array property become form parts.
- A multipart body schema, or one of its properties, behind a `$ref`. Component schemas are carried through unresolved by design — the streaming compile path never materializes `components.schemas` — so a `$ref`'d file field keeps its declared binary string type.

The rewrite reads the request schema's own `properties` map rather than walking every object key, so a `default`, `example`, or vendor extension that happens to look like a binary string schema is untouched. Descriptions, titles, and nullability on the replaced field are carried onto the file schema.
