# MCP request spans

Since Effect 4.1, `McpServer` opens a server span for each request, named after the
JSON-RPC method with the tool or prompt a caller asked for appended, such as
`tools/call get_weather`. It records that name as `gen_ai.tool.name` or
`gen_ai.prompt.name`, and a resource's URI as `mcp.resource.uri`, when the span
starts: before the server knows whether the tool, prompt or resource exists. A
caller that asks for one that does not exist puts its own text in the span's name
and attributes.

`effect@4.1.4.patch` changes `requestSpanOptions` in `ai/McpServer`, in source and
distributed JavaScript:

- The span is named after the method alone: `tools/call`, `tools/list`,
  `initialize`.
- It records no name or URI from the request. `Toolkit.handle` still records
  `gen_ai.tool.name` once it runs a registered tool, so a call to `execute`,
  `resume` or `skills` names its tool and a call to an unknown tool names none.

The span keeps `mcp.method.name`, `mcp.protocol.version`, `jsonrpc.request.id`,
`mcp.session.id`, `network.transport` and, for `tools/call`,
`gen_ai.operation.name`. Tool arguments are recorded only when
`Toolkit.RecordToolArguments` is set, which Executor never sets; before 4.1 the
toolkit recorded them always and a patch removed them.

A request the caller got wrong (parse error, invalid request, method not found,
invalid params, resource not found) no longer fails its span. The span records
the JSON-RPC code as `rpc.status_code`, such as `-32602` for an unknown tool. Other failures record the code as `error.type` too and fail the span.

Effect 4.0.1 named these spans `McpServer.@effect/mcp/<revision>/<method>` and
recorded the tool as `tool`. Queries over either name need both forms for data
that spans the upgrade.

`mcp-telemetry-privacy.spec.ts` checks the delivered `tools/call` spans: each
names its tool, has no arguments, and no synthetic program, result, answer, slug,
tool name or argument key appears anywhere in the delivered trace. Bun skips this
patch without an error when its selector no longer names the installed Effect, so
CI runs that scenario whenever Effect's version or this patch differs from main
(`patchGuards` in `e2e/ci-selection.ts`).

The patch has not been submitted upstream. Remove it when an Effect release
records a requested name only after resolving it, or makes that configurable.
