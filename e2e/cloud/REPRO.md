# Repro: MCP session permanently bricked by concurrent SSE-GET + POST after idle-dispose

Local, deterministic reproduction of the CONFIRMED production failure observed
3/3 against `executor.sh` prod on 2026-07-04 (06:15-06:28 UTC).

Test: `e2e/cloud/repro-transport-brick.test.ts`
Run: `cd e2e && bun run test:cloud -- cloud/repro-transport-brick.test.ts`

It is a **repro, not a regression gate**: the assertions PASS when the brick
occurs. Flip them (assert the follow-up calls SUCCEED) once the collision is
fixed.

## The recipe

1. Open an MCP session with the real `@modelcontextprotocol/sdk` client
   (Streamable HTTP init → `mcp-session-id`), make a call, close the client.
2. Idle PAST the session timeout so the DO alarm runs `disposeIdleRuntime`
   (runtime torn down, `initialized = false`, `_transport` cleared). The e2e
   cloud stack sets `MCP_SESSION_TIMEOUT_MS=3000`, so the idle wait is ~5s, not
   prod's 5min.
3. Fire a raw SSE `GET` (listen stream) and a raw `POST` (`tools/list`)
   CONCURRENTLY on the same session id (raw `fetch`, so both start before either
   resolves — the SDK client's request queue would serialize them away).
4. The concurrent restores collide. The session is **permanently bricked**:
   every later request 500s forever with "Already connected to a transport".

## What reproduces, exactly

Local timing (idle 5s, `MCP_SESSION_TIMEOUT_MS=3000`): the concurrent pair
itself usually returns **200/200** — one of the two restores wins the race,
answers `tools/list` and opens the SSE stream — but the race leaves the DO's
`McpServer` in the "already connected" state, so the **very next request 500s,
and every request after that** (`repro_variant.concurrentBricked` is typically
`false`, `permanentlyBricked` is always `true`). This is the same permanent
grave as prod; prod reported both concurrent responses as 500 because on prod
timing neither restore had completed when both requests were serviced. The
load-bearing, always-true signal is the PERMANENCE: the session never recovers.

Consistency: 3/3 consecutive runs brick the session permanently (outputs below).

## Server-side error (the prod fingerprint)

Captured from the cloud stack boot log (`E2E_VERBOSE=1`):

```
Error on server: Error: Already connected to a transport. Call close() before connecting to a new transport, or use a separate Protocol instance per connection.
    at Server.connect      (helpers-*.js:4921)            [@modelcontextprotocol/sdk Protocol.connect]
    at McpServer.connect   (mcp-*.js:918)                 [@modelcontextprotocol/sdk McpServer.connect]
    at McpSessionDOSqlite.onStart (agents_mcp.js:12332)   [agents SDK McpAgent.onStart -> server.connect(this._transport)]
    ...
    at getServerByName     (agents_mcp.js:922)
    at agent-handler.ts:185  (target.fetch(forwarded, env, ctx))
    at server.ts:119
```

This is the "Already connected to a transport" Sentry fingerprint from the
earlier waves. `Protocol.connect` throws because `_transport` is already set.

## The two colliding code paths (file:line, source)

Both paths end in `McpAgent.onStart -> server.connect(this._transport)`
(agents `dist/mcp/index.js:1662-1669`), racing on the SAME DO instance:

- **Path A — our POST-driven restore (this branch):**
  `apps/cloud/src/mcp/agent-handler.ts:158`
  `validateMcpSessionOwner({...})`
  → `packages/hosts/cloudflare/src/mcp/agent-session-durable-object.ts:555`
  `restoreTransportRuntime()`
  → `:459` `restoreTransportRuntimeOnce` → `self.onStart()`
  → agents `dist/mcp/index.js:1669` `await server.connect(this._transport)`.

  This is the single-flight restore added on `fix/session-do-transport-reconnect`.
  It is single-flight only against ITSELF (`restoreTransportRuntimePromise`).

- **Path B — the agents SDK stream/serve path (NOT gated by our single-flight):**
  `apps/cloud/src/mcp/agent-handler.ts:185` `target.fetch(...)`
  → agents `serve` streaming handler does its OWN `agent.fetch(Upgrade:websocket)`
  for the GET (`dist/mcp/index.js:339`) and the POST (`:202`)
  → wakes the DO; the Agent base drives `onStart`
  (`dist/mcp/index.js:1662`) → a SECOND `server.connect(this._transport)`.

The interleave: `validateMcpSessionOwner` runs `restoreTransportRuntime` for
BOTH the GET and the POST before either `target.fetch`. Path A closes the old
runtime and connects a fresh transport; Path B (or the other request's Path A)
then calls `onStart` again on a server whose `_transport` is already set →
`Protocol.connect` throws "Already connected to a transport". Because
`restoreTransportRuntimeOnce` starts with `closeRuntime()` (which clears
`_transport`) but the two requests aren't serialized against each other's
`onStart`, one request's `server.connect` lands on a transport another request
already attached. The DO is left with a live `_transport` but a half-connected
server, and no later request can reconnect: permanent brick.

## What was ruled out / control observations

- Single-flight `restoreTransportRuntime` (`:467`) prevents concurrent POST-only
  restores from colliding on the POST path, but does NOT cover the SSE-GET path
  (Path B) — that is the residual hole this repro exercises.
- Sequential-only post-idle POST survives (the existing
  `mcp-client-sessions.test.ts` idle-restore scenario, PR #1302, is green): the
  brick requires the CONCURRENT GET + POST, not idle alone.

## 3-run outputs (2026-07-04, consecutive, local workerd stack)

All three runs: test PASSED (brick reproduced). Full per-run JSON is written to
`e2e/runs/cloud/repro-concurrent-sse-get-post-after-idle-dispose-bricks-the-session-permanently/repro-diagnostics.json`
on each run. Condensed:

```
RUN 1  exit=0  Tests 1 passed
  session aff88e7a…  concurrent: GET 200, POST 200 (tools/list answered)
  followUp  500  "Already connected to a transport. Call close() before connecting..."
  followUp2 500  same error
  repro_variant: { concurrentBricked: false, permanentlyBricked: true }

RUN 2  exit=0  Tests 1 passed
  session 8508c9c2…  concurrent: GET 200, POST 200
  followUp  500  "Already connected to a transport..."
  followUp2 500  same error
  repro_variant: { concurrentBricked: false, permanentlyBricked: true }

RUN 3  exit=0  Tests 1 passed
  session 7dff8b07…  concurrent: GET 200, POST 200
  followUp  500  "Already connected to a transport..."
  followUp2 500  same error
  repro_variant: { concurrentBricked: false, permanentlyBricked: true }
```

An earlier exploratory 3x loop of the same test (pre-diagnostics version, same
recipe and assertions) also passed 3/3, so the brick reproduced 6/6 consecutive
runs overall.
