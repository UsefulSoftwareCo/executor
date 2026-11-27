# Tools and resources a server reads per request

Effect 4.1.4's `McpServer` lists the tools registered with `McpServer.toolkit`
and the resources registered with `McpServer.resource`, the same for every
caller. Executor proxies MCP Apps (SEP-1865) from the MCP servers a caller
imported as apps ([public issue 2584](https://github.com/UsefulSoftwareCo/executor/issues/2584)).
Their tools and `ui://` resources depend on the caller's apps and accounts, so
they can only be read on a request, as that caller.

`effect@4.1.4.patch` adds `McpServer.toolCatalog({ list, call })` and
`McpServer.resourceCatalog({ read })`, with their `ToolCatalog` and
`ResourceCatalog` types, in source, distributed JavaScript and `McpServer.d.ts`.
It changes `ai/internal/mcpCore` and `ai/McpServer` only:

- `list` runs on `tools/list` and adds its tools after the registered ones. A
  registered tool shadows a catalog tool of the same name.
- `call(name, args)` runs on a `tools/call` that no registered tool answers. It
  returns the result, or `undefined` for a name the caller is not served, which
  is `ToolNotFound`. Failures belong in an `isError` result.
- `read(uri)` runs on a `resources/read` that no registered resource, resource
  template or skill catalog answers. It returns the result, or `undefined`,
  which is `ResourceNotFound`. Catalog resources are not listed by
  `resources/list`.
- Each runs with the request's `McpRequestContext`, `McpServerClient` and the
  services of the layer that registers it, as `McpServer.skillCatalog` does.
  MCP middleware, visibility and the 2026-07-28 parameter header checks do not
  run for them: the server reads the caller itself.
- With a tool catalog the server declares `tools`; with a resource catalog,
  `resources`. A server has one of each; registering another replaces it.

Every protocol revision's adapter already calls the core's `tools.list`,
`tools.call` and `resources.read`, so the same lines serve all of them.

Remove this part when an Effect release serves tools and resources per request.
