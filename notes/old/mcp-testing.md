# Testing the Cloud MCP Server

Three suites cover the cloud MCP surface. Each has a specific reason to exist;
deleting one silently drops coverage that the others can't replace.

## Suites at a glance

| file                                            | pool                          | drives                                              | what it proves                                                                                |
| ----------------------------------------------- | ----------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `apps/cloud/src/mcp-session.e2e.node.test.ts`   | node                          | `InMemoryTransport` + SDK `Client`                  | engine + plugin wiring; schema drift; elicitation semantics                                   |
| `apps/cloud/src/mcp-flow.test.ts`               | workerd (vitest-pool-workers) | `SELF.fetch` + hand-rolled JSON-RPC                 | edge HTTP pipeline that does not require a live multi-request DO session                      |
| `apps/cloud/src/mcp-miniflare.e2e.node.test.ts` | node + miniflare-on-real-port | SDK `Client` + real `StreamableHTTPClientTransport` | the long-lived-socket DO runtime actually works end-to-end; elicitation round-trips real HTTP |

## The workerd cross-request I/O wall

**Symptom.** In `vitest-pool-workers`, the second request to a `McpSessionDO`
instance crashes with `Cannot perform I/O on behalf of a different request
(I/O type: RefcountedFulfiller)`.

**Cause.** `postgres.js`'s Cloudflare Workers adapter creates socket callbacks
bound to the request context that opened the socket. The MCP session DO holds a
long-lived postgres connection across its lifetime. That's fine in prod (the
DO's own context outlives any single fetch handler) and fine under Miniflare on
a real port, but `vitest-pool-workers` enforces a strict cross-request I/O
check that prod doesn't.

**Decision.** Do not carry a request-scoped runtime branch in production code
just to satisfy the workerd-pool limitation. The workerd-pool suite only covers
edge behavior that does not require a live multi-request MCP session (CORS,
auth failures, metadata, stale-session handling). The real-port Miniflare suite
owns multi-request MCP session coverage because it exercises the same
long-lived-postgres DO runtime path that ships to Cloudflare.

## Miniflare harness gotchas

**Use `unstable_dev`, not `unstable_startWorker`.** `unstable_startWorker`'s
esbuild pipeline errors on transitive deps (`cross-spawn`, `mime-types`,
`isexe`, `which`) with `Could not resolve "path" / "fs" / "child_process"`
even when `nodejs_compat` is enabled. `unstable_dev` handles them. Both boot
the worker on a real port via Miniflare internally; the bundling path differs.

**Pin IPv4.** node `fetch` resolves `localhost` to `::1` first on macOS;
miniflare binds only to IPv4. Set `ip: "127.0.0.1"` on `unstable_dev` and
construct the base URL from `worker.address` / `worker.port`.

**Per-test timeout.** `@effect/vitest`'s `layer(env, { timeout })` covers the
layer build but not individual `it.effect` cases. Pass `30_000` as the third
arg to each `it.effect` — real-HTTP tests through the DO take ~10s each
(postgres connect + isolate startup + SDK handshake).

**Don't import test-worker.ts from node tests.** `test-worker.ts` imports
`./mcp` which imports `cloudflare:workers`. That bubbles up through the node
ESM loader before vitest's alias fires. Keep shared test utilities
(bearer format, etc.) in a zero-dep module — see `apps/cloud/src/test-bearer.ts`.

## MCP elicitation in this codebase

**Execute-tool bridge.** `packages/hosts/mcp/src/server.ts` — `executeCode`
checks `supportsManagedElicitation(server)` (requires the client to advertise
`capabilities.elicitation.form`). When true it passes
`{ onElicitation: makeMcpElicitationHandler(server) }` into `engine.execute`.
Handler body: `server.server.elicitInput(params)` over the MCP transport.

**What triggers it.** Two distinct paths, both hit the same handler:

1. **Executor-level approval.** `executor.ts` → `enforceApproval` runs before
   `invokeTool` when `annotations.requiresApproval` is set. Fires a form
   elicit with the tool's `approvalDescription`.
2. **Plugin-level elicit.** Static plugin tools get an `elicit` arg in their
   handler (see `elicitingTestPlugin` in `mcp-session.e2e.node.test.ts`).

**openApiPlugin elicits for non-GET ops.** `invoke.ts` → `annotationsForOperation`
marks POST/PUT/PATCH/DELETE with `requiresApproval: true`. When user code
invokes such an op, the executor's `enforceApproval` fires. (This is subtle
because `invoke.ts` itself doesn't call `elicit()` directly — the executor
wrapper does.)

## Driving elicitation from an e2e test

Pattern used in `mcp-miniflare.e2e.node.test.ts`:

1. Stand up a tiny `HttpApi` with `HttpApiGroup` + `HttpApiEndpoint.post` via
   `@effect/platform`. Implement the handler with `HttpApiBuilder.group`.
2. Serve it via `HttpApiBuilder.serve()` +
   `NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })`.
3. Read the bound port from `HttpServer.HttpServer.address` (TcpAddress tag)
   inside a `Layer.effect` that produces the test service.
4. Generate the spec with `OpenApi.fromApi(api)` and inject
   `servers: [{ url: `http://127.0.0.1:${port}` }]`before`JSON.stringify`.
5. SDK Client advertises `capabilities: { elicitation: { form: {} } }` and
   registers `client.setRequestHandler(ElicitRequestSchema, ...)` that returns
   `{ action: "accept", content: {} }`.
6. Call `execute` with code that (a) calls `tools.executor.openapi.addSource({ spec,
namespace })`, (b) invokes the POST operation.

**Tool id format inside the `execute` sandbox.**
`tools.<sourceId>.<group>.<operation>` for openapi. The Effect
`HttpApiGroup.make("approve")` name becomes part of the path, so an endpoint
`approveThing` under group `approve` under source `approveapi` is
`tools.approveapi.approve.approveThing({})`. The executor's tool row id is
literally `<sourceId>.<group>.<operation>`.

**Why the invoke must run in the same `execute` call as `addSource`.** Both
tests it: the write commits immediately, and a second `execute` call in the
same session sees the new tool. Keeping them together is just convenient.

## Things that looked like bugs but weren't

- "The openapi plugin doesn't elicit." It does, indirectly, through the
  executor's `enforceApproval` wrapper. `invoke.ts` doesn't have an `elicit()`
  call — easy to miss on a shallow grep.
- "Tools added via `addSource` aren't visible." The tools proxy in the dynamic
  worker module (`__makeToolsProxy`) is a recursive `Proxy` — every
  `.x.y(args)` access turns into a `__dispatcher.call("x.y", ...)`. There's no
  pre-computed allow-list, so newly-added tools are immediately callable. If
  `ToolNotFoundError` fires with a plausible-looking id, the id format is
  probably wrong (see group-name note above), not a visibility bug.
