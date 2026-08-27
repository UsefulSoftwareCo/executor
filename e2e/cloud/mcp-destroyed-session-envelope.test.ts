// Cloud: a terminated MCP session id must keep answering in the protocol's own
// vocabulary for its whole death sequence — not just in the first instant.
//
// `DELETE /mcp` condemns the session DO with a durable marker and defers the
// real teardown to an alarm ~1s later; that alarm's `destroy()` wipes storage
// and then `ctx.abort("destroyed")`s the isolate. e2e/cloud/mcp-protocol.test.ts
// already covers the FIRST millisecond of that window (the marker is read and a
// 404 reconnect comes back). This scenario covers the rest of it: a client that
// keeps talking to the dead id across the alarm and the abort — exactly what a
// retrying MCP client does — must always get a well-formed JSON-RPC envelope,
// either 404 (the id is dead, reconnect) or a retryable 503, and never a bare
// unhandled 500 from a Durable Object platform error escaping the handler.
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

scenario(
  "MCP protocol · a terminated session id stays a protocol error while its Durable Object is torn down",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));

    // Several sessions, because the fatal window is the isolate abort that
    // follows the deferred destroy alarm and one session only crosses it once.
    const sessions = 3;
    // The destroy alarm is deferred ~1s; keep probing well past it so the
    // probes straddle the alarm, the storage wipe and the abort that follows.
    const probeWindowMs = 2_500;
    const probeIntervalMs = 25;
    const probeFanOut = 4;

    const probes: Probe[] = [];

    for (let attempt = 0; attempt < sessions; attempt += 1) {
      const sessionId = yield* Effect.promise(() => openSession(target.mcpUrl, bearer));
      const terminate = yield* Effect.promise(() =>
        fetch(target.mcpUrl, {
          method: "DELETE",
          headers: { authorization: `Bearer ${bearer}`, "mcp-session-id": sessionId },
        }),
      );
      expect(terminate.status, "the client can terminate its session").toBe(200);
      yield* Effect.promise(() => terminate.text());

      const startedAt = Date.now();
      const probe = async (): Promise<void> => {
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
      // Concurrent, not sequential: the fatal moment is `ctx.abort("destroyed")`
      // itself, which kills whatever is in flight. A one-at-a-time poll almost
      // always misses it, so keep a fan of requests open across the whole
      // teardown.
      yield* Effect.promise(async () => {
        const inFlight: Promise<void>[] = [];
        while (Date.now() - startedAt < probeWindowMs) {
          for (let i = 0; i < probeFanOut; i += 1) inFlight.push(probe());
          await new Promise((resolve) => setTimeout(resolve, probeIntervalMs));
        }
        await Promise.all(inFlight);
      });
    }

    // What the dead id actually answered, so a reviewer can see the shape of
    // the teardown window and not just the verdict.
    const bucket = new Map<string, number>();
    for (const probe of probes) {
      const key = `${probe.status} ${jsonRpcError(probe.body)?.message ?? probe.body.slice(0, 80)}`;
      bucket.set(key, (bucket.get(key) ?? 0) + 1);
    }
    console.info(
      `[destroyed-session-envelope] ${probes.length} probes: ${[...bucket]
        .map(([key, count]) => `${count}× ${key}`)
        .join(" | ")}`,
    );

    const unhandled = probes.filter((probe) => probe.status >= 500 && probe.status !== 503);
    expect(
      unhandled.map((probe) => `+${probe.atMs}ms ${probe.status} ${probe.body.slice(0, 200)}`),
      "no probe on a dead session id produces an unhandled server error",
    ).toEqual([]);

    const malformed = probes.filter((probe) => jsonRpcError(probe.body) === null);
    expect(
      malformed.map((probe) => `+${probe.atMs}ms ${probe.status} ${probe.body.slice(0, 200)}`),
      "every rejection is a JSON-RPC error envelope",
    ).toEqual([]);

    for (const probe of probes) {
      expect([404, 503], `+${probe.atMs}ms is a reconnect or a retry verdict`).toContain(
        probe.status,
      );
    }

    // A 503 in this window means "the platform is mid-reset, come back" — it is
    // only actionable if the client is told how long to wait, so the retryable
    // envelope must carry Retry-After.
    const retryableWithoutBackoff = probes.filter(
      (probe) => probe.status === 503 && probe.retryAfter === null,
    );
    expect(
      retryableWithoutBackoff.map((probe) => `+${probe.atMs}ms`),
      "every retryable rejection tells the client how long to back off",
    ).toEqual([]);
  }),
);
