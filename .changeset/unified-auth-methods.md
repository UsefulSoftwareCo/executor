---
"executor": minor
"@executor-js/http-auth": minor
"@executor-js/react": minor
---

**One auth model across OpenAPI, GraphQL, and MCP**

- Every protocol plugin now stores the same placements-based auth methods (the new `@executor-js/http-auth` vocabulary): an API-key method carries any mix of header and query placements, each rendered from its own credential input — so one source can declare OAuth, a bearer-header-plus-team-id-query method, a plain bearer, and a query token side by side, and one connection can carry several values (e.g. both Datadog keys).
- MCP and GraphQL gain what only OpenAPI could do before: multi-placement methods, query-parameter credentials (servers like ui.sh's `?token=`), and multi-input connections. Rendering, catalog projection, slug normalization, and the React method editor/codec are shared instead of triplicated; the connect modal collects one value per input.
- Invoking with an unresolvable credential input now fails with `connection_value_missing` (naming the missing inputs) instead of silently dialing unauthenticated.
- Stored integration configs are rewritten to the canonical shape by a one-off migration: local and self-host run it automatically at startup; cloud operators run `bun run db:migrate-auth:prod` before deploying. Connection bindings and stored credential values are preserved exactly.
- Breaking (wire): the add/configure payloads for the three plugins accept only the canonical method shape (`kind: "apikey"` with `placements`); the retired `headerName`/`in`/`variable()`-template inputs are rejected. The `mcp.addServer` singular `auth` shorthand still works.
