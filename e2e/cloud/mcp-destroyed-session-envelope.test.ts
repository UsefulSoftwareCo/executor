// Cloud: a session id must keep answering in the MCP protocol's own vocabulary
// for the whole time its Durable Object is being torn down — not just in the
// first instant.
//
// `DELETE /mcp` condemns the session object with a durable marker and defers
// the real teardown to an immediate alarm; that alarm wipes the object's
// storage and then aborts the isolate. e2e/cloud/mcp-protocol.test.ts covers
// the calm case (terminate, then ask again, get a 404 reconnect). This scenario
// covers the violent middle of it: a client whose requests are ALREADY IN
// FLIGHT when the termination lands, which is what a real client with an open
// tool loop looks like when a session ends underneath it.
//
// Every one of those in-flight requests must come back as a well-formed
// JSON-RPC error — 404 (this id is dead, reconnect) or 503 (the object is
// restarting, retry the same id, here is how long to wait) — and never as a
// bare unhandled 500 from a platform failure escaping the request handler.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Mcp, Target } from "../src/services";
import type { Identity } from "../src/target";

const JSON_AND_SSE = "application/json, text/event-stream";
const PROTOCOL_VERSION = "2025-03-26";

const INITIALIZE_REQUEST = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "executor-e2e-destroyed-session-envelope", version: "0.0.1" },
  },
};

const INITIALIZED_NOTIFICATION = {
  jsonrpc: "2.0" as const,
  method: "notifications/initialized",
};

const TOOLS_LIST_REQUEST = {
  jsonrpc: "2.0" as const,
  id: 2,
  method: "tools/list",
  params: {},
};

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;

const mcpPost = (
  url: string | URL,
  init: { readonly bearer: string; readonly sessionId?: string; readonly body: unknown },
): Promise<Response> =>
  fetch(url, {
    method: "POST",
    headers: {
      accept: JSON_AND_SSE,
      "content-type": "application/json",
      authorization: `Bearer ${init.bearer}`,
      ...(init.sessionId ? { "mcp-session-id": init.sessionId } : {}),
    },
    body: JSON.stringify(init.body),
  });

const openSession = async (mcpUrl: string, bearer: string): Promise<string> => {
  const initialize = await mcpPost(mcpUrl, { bearer, body: INITIALIZE_REQUEST });
  const sessionId = initialize.headers.get("mcp-session-id");
  await initialize.text();
  if (initialize.status !== 200 || !sessionId) {
    throw new Error(`openSession: initialize failed (${initialize.status})`);
  }
  const initialized = await mcpPost(mcpUrl, { bearer, sessionId, body: INITIALIZED_NOTIFICATION });
  await initialized.text();
  if (initialized.status !== 202) {
    throw new Error(`openSession: notifications/initialized failed (${initialized.status})`);
  }
  return sessionId;
};

type Probe = {
  readonly atMs: number;
  readonly status: number;
  readonly body: string;
  readonly retryAfter: string | null;
};

/** One JSON-RPC error shape, or null when the body is not the protocol envelope. */
const jsonRpcError = (body: string): { readonly code: number; readonly message: string } | null => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- test helper: a non-JSON body is itself the signal we assert on
  try {
    const parsed = JSON.parse(body) as {
      readonly jsonrpc?: string;
      readonly error?: { readonly code?: number; readonly message?: string };
    };
    if (parsed.jsonrpc !== "2.0" || typeof parsed.error?.code !== "number") return null;
    return { code: parsed.error.code, message: parsed.error.message ?? "" };
  } catch {
    return null;
  }
};

const describeProbe = (probe: Probe): string =>
  `+${probe.atMs}ms ${probe.status} ${probe.body.slice(0, 200)}`;

scenario(
  "MCP protocol · in-flight requests survive their session's teardown as protocol errors",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;

    // The fatal instant is the isolate abort at the end of the teardown, and a
    // session only crosses it once — so cross it several times. Before the fix
    // roughly one teardown in four leaked an unhandled 500.
    const sessions = 6;
    // Requests are kept continuously in flight rather than polled on a timer:
    // the point is to have work ALREADY inside the session object when the
    // termination lands, not to sample the window from outside it.
    const concurrency = 8;
    // Covers the deferred destroy alarm, the storage wipe and the abort that
    // follows, and then stops. Kept tight on purpose: the traffic only has to
    // straddle the teardown, and a longer stream just piles avoidable load onto
    // the shared auth path for no extra coverage.
    const streamAfterDeleteMs = 1_600;
    // Enough in-flight requests to be mid-teardown, without racing the DELETE
    // itself before the session is fully established.
    const warmupMs = 250;

    const probes: Probe[] = [];

    // One identity per teardown, all minted BEFORE any load starts. Two
    // reasons, both about keeping this scenario's traffic off the shared auth
    // path: a single identity carrying every teardown's requests degrades the
    // org-membership lookup into a 403, and signing new users in while the
    // probe stream is running fails the sign-in itself. Neither has anything to
    // do with what is being tested here.
    const bearers: string[] = [];
    for (let index = 0; index < sessions; index += 1) {
      const identity = yield* target.newIdentity();
      bearers.push(yield* mcp.mintBearer(emailOf(identity)));
    }

    for (const bearer of bearers) {
      const sessionId = yield* Effect.promise(() => openSession(target.mcpUrl, bearer));

      yield* Effect.promise(async () => {
        const startedAt = Date.now();
        let stopAt = Number.POSITIVE_INFINITY;

        const probeOnce = async (): Promise<void> => {
          const at = Date.now() - startedAt;
          const response = await mcpPost(target.mcpUrl, {
            bearer,
            sessionId,
            body: TOOLS_LIST_REQUEST,
          });
          probes.push({
            atMs: at,
            status: response.status,
            body: await response.text(),
            retryAfter: response.headers.get("retry-after"),
          });
        };

        // One worker replenishes its request the moment the previous one
        // settles, so the session object is never idle and the DELETE has to
        // land on top of real traffic.
        const worker = async (): Promise<void> => {
          while (Date.now() < stopAt) await probeOnce();
        };
        const workers = Array.from({ length: concurrency }, () => worker());

        await new Promise((resolve) => setTimeout(resolve, warmupMs));
        // Terminate WITHOUT draining the stream: this is the whole scenario.
        const terminate = await fetch(target.mcpUrl, {
          method: "DELETE",
          headers: { authorization: `Bearer ${bearer}`, "mcp-session-id": sessionId },
        });
        await terminate.text();
        expect(terminate.status, "the client can terminate its session").toBe(200);

        stopAt = Date.now() + streamAfterDeleteMs;
        await Promise.all(workers);
      });
    }

    // What the dying session actually answered, so a reviewer can see the shape
    // of the teardown window and not just the verdict.
    const bucket = new Map<string, number>();
    for (const probe of probes) {
      const key = `${probe.status} ${jsonRpcError(probe.body)?.message ?? probe.body.slice(0, 80)}`;
      bucket.set(key, (bucket.get(key) ?? 0) + 1);
    }
    console.info(
      `[destroyed-session-envelope] ${probes.length} probes across ${sessions} teardowns: ${[
        ...bucket,
      ]
        .map(([key, count]) => `${count}× ${key}`)
        .join(" | ")}`,
    );

    expect(probes.length, "the stream actually exercised the teardown").toBeGreaterThan(sessions);

    const unhandled = probes.filter((probe) => probe.status >= 500 && probe.status !== 503);
    expect(
      unhandled.map(describeProbe),
      "no request on a terminating session produces an unhandled server error",
    ).toEqual([]);

    // Only rejections are asserted on: a request the session still served
    // answers 200 over SSE, which is not a JSON-RPC error body and not what
    // this scenario is about.
    const malformed = probes.filter(
      (probe) => probe.status !== 200 && jsonRpcError(probe.body) === null,
    );
    expect(
      malformed.map(describeProbe),
      "every rejection is a JSON-RPC error envelope the client can parse",
    ).toEqual([]);

    // Proves the traffic actually straddled the teardown rather than finishing
    // before it: the dead id has to have been reported dead at least once.
    const reconnectVerdicts = probes.filter((probe) => probe.status === 404);
    expect(
      reconnectVerdicts.length,
      "the stream reached the terminated session and was told to reconnect",
    ).toBeGreaterThan(0);

    // A 503 here means "the platform is mid-reset, come back" — only actionable
    // if the client is told how long to wait, so it must carry Retry-After.
    const retryableWithoutBackoff = probes.filter(
      (probe) => probe.status === 503 && probe.retryAfter === null,
    );
    expect(
      retryableWithoutBackoff.map(describeProbe),
      "every retryable rejection tells the client how long to back off",
    ).toEqual([]);
  }),
);
