---
"apps": patch
"@executor-js/app-templates": patch
---

Add `mcpHealth` to `apps/mcp`, a provider `health` check that connects to an MCP
server with the account's headers, initializes, and reads the first page of tools,
then repeats that without credentials. Call it with the check context and the
server: `health: (check) => mcpHealth(check, { url, headers: headers(check.account) })`.
It reads the account, `signal` and `deadline` from the context; the options carry
only `url`, `headers` and an optional `timeoutMs`. The account is healthy only when
the server refuses the attempt without credentials. A server that answers it, or
fails it for another reason, throws `McpCredentialsUnverified`, and the check
reports it could not verify the account. A refused account reports the usual
provider failure; an unreachable server explains why the check could not verify
the account. Quick-add OAuth MCP apps, including curated catalog entries, now
declare this check. Provider checks receive the account check's `deadline`; both
`mcpHealth` attempts share one budget that ends early enough before it to report a
server that did not answer in time, and `timeoutMs` can only shorten it. An
`McpError` keeps only a redirect or failure HTTP status; a response that is not
MCP is `invalid_response`.
