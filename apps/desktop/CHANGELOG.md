# @executor-js/desktop

## 1.5.3

## 1.5.2

## 1.5.1

## 1.5.0

### Minor Changes

- [`c7bb2a4`](https://github.com/RhysSullivan/executor/commit/c7bb2a4da99aac4199b424d6d52e6ea843250e3a) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Integrations and connections rework.

  **Highlights**
  - Sources are now split into integrations (the API surface) and connections (the credential). One integration can hold many connections — workspace-shared or personal — and each connection gets its own tool catalog.
  - Tool addresses carry the connection, so agents can target a specific account: `tools.vercel_api.org.workspace.deploy` vs `tools.vercel_api.user.personal.deploy`.
  - Existing data migrates automatically on first launch: sources become integrations, secrets and credential bindings become connections, OAuth apps and tool policies carry over, and the previous database is kept as a backup next to the new one.
  - Public no-auth servers (MCP, GraphQL) connect without entering a credential.
  - Connections display the signed-in identity, so you can tell accounts apart at a glance.
  - The CLI, local web app, and desktop app can connect to a shared Executor server instead of each running their own; the desktop app persists server profiles across restarts.
  - Self-hosted Executor now publishes a multi-architecture GHCR image at `ghcr.io/rhyssullivan/executor-selfhost` (stable releases tagged `latest`, prereleases tagged `beta`).

  **Reliability**
  - OpenAPI, GraphQL, and MCP tools return structured authentication failures with recovery guidance instead of opaque internal errors — covering missing credentials, expired OAuth connections, upstream 401/403 responses, and MCP per-user isolation.
  - OAuth popups complete more reliably in Chrome by preserving the callback channel through the same-origin completion page.
  - OAuth Dynamic Client Registration data is reused across retries and reconnects, including scopes, so providers are not asked to register duplicate clients.
  - Creating a connection with invalid input (no credential for a credentialed method, mixed input origins) returns a clear error with the reason instead of an opaque internal error.
  - The v1 → v2 migration creates connections for no-auth sources, derives OAuth authorize endpoints when v1 only stored a bare issuer origin, keys inline header values per source, and skips malformed credential bindings with a warning instead of silently dropping them. An unreachable OAuth metadata endpoint no longer blocks the migration on launch.
  - Google sources use a bundled OpenAPI flow with valid schemas.
  - MCP tool output schemas match the actual invocation result envelope, including `content`, `structuredContent`, `_meta`, and `isError`.
  - Integration icons survive migration, connected presets show their icons, and credentials show a loading badge while resolving.

  **Breaking changes**
  - Tool addresses gained two segments for the connection's owner and name: `tools.vercel_api.deploy` is now `tools.vercel_api.org.workspace.deploy`. Saved tool policies are rewritten automatically during migration; agent code that hard-codes v1.4 addresses needs the new shape (`tools.search()` returns ready-to-call paths).
  - The Google Discovery plugin was removed. Google integrations now go through the bundled Google flow; existing Google sources migrate automatically.
