# Codemode renders signatures only when they are read

`@opencode-ai%2Fcodemode@0.0.0-dev-19272.patch` also makes `CodeMode.make` lazy. The published
`ToolRuntime.prepare` renders every tool's TypeScript signature twice when a runtime is made:
once for `catalog()` and once for the search index behind the program's global `search()`.
For each tool that is a compact and a pretty render of the input, a pretty render of the output,
and for Effect schemas (the `search` and `search.describe` tools, and `Schema.Json` outputs) a
JSON Schema document first.

`execute` makes a runtime over the reachable catalog on every call and reads neither. It never
calls the runtime's `catalog()`, and a program reaches the global `search()` only when it uses it.
`tools.search` ranks with Executor's own projections. A Node CPU profile of `executeProgram` over
1,000 kept tools put 69% of the call in `prepare`. Session objects run these calls (F-020 in
executor-perf-watch).

The patch derives each list on first use, from the tools as they were when the runtime was made,
and keeps it for later reads. Tools are immutable objects, so a later read renders exactly what
`make` rendered before. `searchIndex(tools)` still builds the tool tree when it is called, so a
bad tool path fails at the same point. `ToolRuntime.make` and `executeWithLimits` take the index
as a function. `ToolRuntime` is internal: the package root does not export it.

The runtime also counts the signatures it renders, `signaturesRendered()`. `execute` records the
count on `mcp.execute` as `executor.codemode.signatures_rendered`, and the `mcp-catalog` scenario
"MCP execute renders tool signatures only for a program that searches with CodeMode's search()"
requires 0 for a tool call and for `tools.search`. A patch that applies but renders eagerly again
fails it; one that does not apply fails `bun run patches:check` and the typecheck.

Remove the hunks when a codemode release renders lazily, and record its own count instead.
