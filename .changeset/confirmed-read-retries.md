---
"@executor-js/sdk": patch
---

A failed call to a tool that only its MCP server labels read-only (`readOnlyHint`) is no
longer offered as a retry. Executor keeps a read's retry advice, and repeats a refused call
with renewed credentials, only for a query the app confirms: a declared operation, a `kinds`
entry, an OpenAPI read method or a GraphQL query (`kindConfirmed`). Other queries fail like
mutations, with `mayHaveWritten` and `retryable: false`. The confirmation comes only from a
listing already kept for the app, so a failed call never evaluates the app again; a query whose
app's tools nobody listed is unconfirmed. Apps built before `kindConfirmed` existed get this for
every query until they are rebuilt.
