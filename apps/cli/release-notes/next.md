## Highlights

### More reliable connected tools

- OpenAPI, GraphQL, and MCP tools now return structured authentication failures with recovery guidance instead of opaque internal errors.
- OAuth popups now complete more reliably in Chrome by preserving the callback channel through the same-origin completion page.
- OAuth Dynamic Client Registration data is reused across retries and reconnects, including scopes, so providers are not asked to register duplicate clients.
- MCP tool output schemas now match the actual invocation result envelope, including `content`, `structuredContent`, `_meta`, and `isError`.

### Self-hosted Docker image

- Self-hosted Executor now publishes a multi-architecture GHCR image at `ghcr.io/rhyssullivan/executor-selfhost`, with stable releases tagged as `latest` and prereleases tagged as `beta`.

## UI

- No UI-only changes in this patch.

## Fixes

- Auth failures from secret-backed and OAuth-backed tools now include model-visible next steps for missing credentials, missing secrets, expired OAuth connections, upstream 401/403 responses, and MCP per-user isolation cases.
- Retrying OAuth sign-in no longer starts an avoidable second Dynamic Client Registration request.
- Reconnecting an OAuth source keeps the previously registered DCR scope list intact.
- MCP sources now describe output types as Executor's full successful `CallToolResult` data shape instead of only the upstream `structuredContent` schema.
- Published `@executor-js/*` libraries now use the consumer's `effect` dependency instead of installing their own copy, avoiding duplicated Effect service identity. Thanks @aryasaatvik (#876)

## Breaking changes

### Published package consumers

Published `@executor-js/*` libraries now declare `effect` as a peer dependency. If you install these libraries directly, make sure your app has `effect` installed as a direct dependency.
