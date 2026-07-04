// Cloud: regression test for a session-DO startup race.
//
//   1. Open an MCP session (real SDK client init, capture mcp-session-id),
//      make a call, close the client.
//   2. Idle past the session timeout so the DO's alarm runs disposeIdleRuntime
//      (runtime torn down, `initialized = false`, transport cleared).
//   3. Fire an SSE GET (listen stream) and a POST (tools/list) concurrently on
//      the same session id.
//   4. The session must survive: the concurrent pair and follow-up calls
//      should succeed.
//
// Mechanism guarded against: a request carrying a session id runs
// validateMcpSessionOwner, which restores via onStart when the runtime is
// disposed. The SDK's serve() streaming handler separately wakes the DO
// through agent.fetch, and the Agent base also drives onStart. Without
// serialization across both entry paths, two onStart calls interleave and the
// second server.connect throws "Already connected to a transport", after
// which every request on the session fails the same way. The concurrent pair
// itself can answer 200/200 (one restore wins the race), so the assertions
// cover the follow-up calls, which is where the failure persists.
//
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { scenario } from "../src/scenario";
import { Mcp, RunDir, Target } from "../src/services";
import type { Identity } from "../src/target";
import { configuredMcpSessionTimeoutMs } from "../setup/mcp-session-timeouts";

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;

// Give the DO's idle alarm room to fire disposeIdleRuntime after the timeout.
const IDLE_DISPOSE_BUFFER_MS = 2_000;
const IDLE_DISPOSE_GAP_MS = configuredMcpSessionTimeoutMs() + IDLE_DISPOSE_BUFFER_MS;
const SCENARIO_TIMEOUT_MS = IDLE_DISPOSE_GAP_MS + 120_000;

interface Connected {
  readonly client: Client;
  readonly transport: StreamableHTTPClientTransport;
}

const connectClient = async (mcpUrl: string, bearer: string): Promise<Connected> => {
  const client = new Client({ name: "executor-e2e-brick", version: "0.0.1" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  await client.connect(transport);
  return { client, transport };
};

interface RawResult {
  readonly status: number;
  readonly body: string;
}

/** A raw POST of a JSON-RPC request onto an existing session id. */
const rawPost = async (
  mcpUrl: string,
  bearer: string,
  sessionId: string,
  message: unknown,
): Promise<RawResult> => {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      // The streamable-http transport requires the client accept both.
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify(message),
  });
  const body = await res.text().catch(() => "");
  return { status: res.status, body };
};

/** A raw SSE GET (the "listen" stream) on an existing session id. We only need
 *  the response head — status + start of body — to see whether it 500s. */
const rawSseGet = async (mcpUrl: string, bearer: string, sessionId: string): Promise<RawResult> => {
  const res = await fetch(mcpUrl, {
    method: "GET",
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: "text/event-stream",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-06-18",
    },
  });
  // A 200 opens a long-lived stream; don't hang reading it. A 500 has a short
  // (usually empty) body we can read fully.
  let body = "";
  if (res.status !== 200) {
    body = await res.text().catch(() => "");
  } else {
    // Cancel the stream immediately; we only wanted the status.
    await res.body?.cancel().catch(() => undefined);
  }
  return { status: res.status, body };
};

const toolsListMessage = { jsonrpc: "2.0" as const, id: "brick-tools-list", method: "tools/list" };

const isBrick = (r: RawResult): boolean =>
  r.status >= 500 || /"code"\s*:\s*-32603/.test(r.body) || /Already connected/i.test(r.body);

scenario(
  "REGRESSION · concurrent SSE GET + POST after idle-dispose keeps the session alive",
  { timeout: SCENARIO_TIMEOUT_MS },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const runDir = yield* RunDir;
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));
    const diagnostics: unknown[] = [];
    const record = (entry: Record<string, unknown>): void => {
      diagnostics.push(entry);
      console.log(JSON.stringify(entry));
      // Vitest swallows worker stdout on passing runs; the artifact dir is the
      // durable copy of what each attempt observed.
      writeFileSync(join(runDir, "repro-diagnostics.json"), JSON.stringify(diagnostics, null, 2));
    };

    // 1. Open a real session (SDK init handshake persists the session in the
    //    DO), do a call, close the client.
    const first = yield* Effect.promise(() => connectClient(target.mcpUrl, bearer));
    const sessionId = first.transport.sessionId;
    expect(sessionId, "the client got a session id").toEqual(expect.any(String));
    if (sessionId === undefined) return yield* Effect.die("missing session id");

    yield* Effect.promise(() =>
      first.client.callTool({ name: "execute", arguments: { code: "return 1;" } }),
    );
    yield* Effect.promise(() => first.client.close().catch(() => undefined));

    // 2. Idle past the timeout so the DO's alarm runs disposeIdleRuntime.
    yield* Effect.sleep(IDLE_DISPOSE_GAP_MS);

    // 3. Fire the SSE GET and the POST CONCURRENTLY on the same session id.
    //    Raw fetch gives precise concurrency control (both start before either
    //    resolves) that the SDK client's request queue would serialize away.
    const [getResult, postResult] = yield* Effect.promise(() =>
      Promise.all([
        rawSseGet(target.mcpUrl, bearer, sessionId),
        rawPost(target.mcpUrl, bearer, sessionId, toolsListMessage),
      ]),
    );

    record({
      event: "repro_concurrent_pair",
      sessionId,
      get: getResult,
      post: postResult,
    });

    const concurrentBricked = isBrick(getResult) || isBrick(postResult);

    // 4. Prove the session survives: subsequent SEQUENTIAL POSTs also succeed.
    //    This is the same control path as the idle-restore scenario from #1302.
    //
    //    Observed locally: the concurrent pair frequently returns 200/200 (one
    //    of the two restores wins the race and answers), but the race leaves
    //    the DO's McpServer in the "Already connected to a transport" state, so
    //    the very NEXT request 500s — and every request after that. The
    //    regression gate checks the same two follow-up calls now stay healthy.
    const followUp = yield* Effect.promise(() =>
      rawPost(target.mcpUrl, bearer, sessionId, {
        ...toolsListMessage,
        id: "brick-follow-up",
      }),
    );
    const followUp2 = yield* Effect.promise(() =>
      rawPost(target.mcpUrl, bearer, sessionId, {
        ...toolsListMessage,
        id: "brick-follow-up-2",
      }),
    );
    record({ event: "repro_follow_up", sessionId, followUp, followUp2 });

    const permanentlyBricked = isBrick(followUp) && isBrick(followUp2);

    expect(getResult.status, "the concurrent SSE GET opens successfully").toBe(200);
    expect(postResult.status, "the concurrent POST answers successfully").toBe(200);
    expect(isBrick(getResult), "the concurrent SSE GET does not expose the transport brick").toBe(
      false,
    );
    expect(isBrick(postResult), "the concurrent POST does not expose the transport brick").toBe(
      false,
    );
    expect(followUp.status, "the first follow-up POST answers successfully").toBe(200);
    expect(followUp2.status, "the second follow-up POST answers successfully").toBe(200);
    expect(isBrick(followUp), "the first follow-up POST does not expose the transport brick").toBe(
      false,
    );
    expect(
      isBrick(followUp2),
      "the second follow-up POST does not expose the transport brick",
    ).toBe(false);
    expect(
      permanentlyBricked,
      "after the concurrent SSE-GET + POST post-idle, the session remains usable",
    ).toBe(false);
    // Diagnostic (not a gate): whether the collision surfaced on the concurrent
    // pair itself vs. only on the follow-up depends on which restore won the
    // race. Record it so the artifact shows the timing that occurred this run.
    record({ event: "repro_variant", concurrentBricked, permanentlyBricked });
  }),
);
