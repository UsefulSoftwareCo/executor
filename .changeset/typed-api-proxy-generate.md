---
"@executor-js/sdk": minor
"executor": minor
---

Add `executor generate`: export the tool catalog as an OpenAPI document or a typed TypeScript client, backed by direct REST tool invocation.

`executor generate` writes an OpenAPI 3.1 document (default
`executor.openapi.json`) describing every visible tool as a REST operation,
so any OpenAPI client generator (openapi-typescript, openapi-generator,
Kiota, ...) produces a fully typed client for your catalog. `--format
typescript` emits a ready-made self-contained TypeScript client instead (or
`both`). The document's operations are real: new `POST
/tools/invoke/{path}` invokes one tool directly over HTTP (404 for unknown
tools, `execution_paused` with resume coordinates for approval-gated calls),
`GET /tools/export/openapi` serves the live document, and `GET /tools/export`
plus `executor.tools.export()` return the whole schema-bearing catalog in one
read. Generation compiles schemas in chunks and stays fast past 10,000 tools
across many integrations.
