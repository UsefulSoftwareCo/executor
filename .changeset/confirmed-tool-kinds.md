---
"apps": patch
---

Tool listings mark a kind that the app's code or the tool's protocol decides
with `kindConfirmed`: declared operations, `kinds` entries, OpenAPI HTTP methods
and GraphQL operation types. A kind that comes only from an MCP server's
`readOnlyHint` is not marked, so Executor does not offer a failed call to such a
tool as a read's retry. A `dynamicRouter` can set `kindConfirmed` on the tools
it lists.
