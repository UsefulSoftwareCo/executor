# Toolkit span arguments

Effect 4.0.1 annotates the current span with every tool call's raw input:
`Toolkit.handle` (`effect/ai`) records `tool` and `parameters`. `McpServer.toolkit` calls it inside the RPC server's
`McpServer.@effect/mcp/<revision>/tools/call` span, so every MCP tool call
exported its full arguments. For Executor those are code-mode programs, resume
answers and skill selections: caller content, up to tens of kilobytes per span.

`effect@4.0.1.patch` removes `parameters` from that annotation in source and
distributed JavaScript. The span keeps `tool` and its status. A refused call's
exception would still quote the caller: Effect's `ProtocolError` names an unknown
tool, and on 2025-06-18 and older an invalid argument's path, which can be a key
the caller chose. Executor's tracer records a fixed sentence for that error
instead; see [telemetry](../notes/telemetry.md#diagnostic-content).

`mcp-telemetry-privacy.spec.ts` checks the delivered `tools/call` spans: each
names its tool, has no `parameters` attribute, and no synthetic program, result,
answer, slug, tool name or argument key appears anywhere in the delivered trace.
Bun skips this patch without an error when its selector no longer names the
installed Effect, and applies hunks that still fit after an upgrade, so CI runs
that scenario whenever Effect's version or this patch differs from main
(`patchGuards` in `e2e/ci-selection.ts`).

The patch has not been submitted upstream. Remove it when an Effect release
stops recording tool arguments on spans or makes it opt-in.
