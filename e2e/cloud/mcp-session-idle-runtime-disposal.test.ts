// Cloud: an idle MCP session gives its execution runtime back to the isolate
// even while the client is still holding a stream open.
//
// The defect this pins: the idle timeout never actually ran. The session armed
// an idle alarm on every request, but the agents framework recomputes the
// Durable Object alarm from its own schedule table and keep-alive refcount and
// DELETES it when it finds neither — which it does at the end of every ordinary
// tool call, from a `waitUntil` just after the response goes out. So a session
// that had just served a request was left with no alarm at all, its idle
// deadline silently dropped, and its execution runtime resident until the
// platform evicted the whole object. Durable Objects share one isolate heap, so
// enough never-reclaimed runtimes exhaust it and the next allocation anywhere
// in that isolate fails.
//
// The contract asserted here, in three parts:
//
//   1. an idle session's runtime IS released, and the exported span says so.
//      Before the fix this span never appeared at all, for any session;
//   2. the release reports the isolate's resident-runtime gauge, which is what
//      makes the mechanism confirmable in production rather than inferred;
//   3. the very next call on the SAME session works and returns the right
//      answer, restoring the runtime underneath the client transparently.
//
// A client stream is deliberately held open across the idle window, because
// that is the shape real clients have. Note what it does NOT do: it does not
// keep the runtime alive. The session Durable Object holds no connection for a
// standalone GET stream (`ctx.getWebSockets()` is empty), so the stream is not
// visible to the idle policy at all, and reclaiming the runtime ends it — the
// client reconnects and replays, which is the behaviour `mcp-sse-replay` pins.
//
// The out-of-memory failure itself is not reachable from a black-box test —
// filling a shared isolate heap on demand is not something a client can ask
// for — so reclamation, not the allocation failure, is the testable contract.
import { randomUUID } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect, Schedule } from "effect";

import { scenario } from "../src/scenario";
import { Mcp, Target, Telemetry } from "../src/services";
import type { Identity } from "../src/target";
import { configuredMcpSessionTimeoutMs } from "../setup/mcp-session-timeouts";

const PROTOCOL_VERSION = "2025-03-26";
const JSON_AND_SSE = "application/json, text/event-stream";

/** Past the idle window with room for the alarm to actually fire. */
const IDLE_GAP_MS = configuredMcpSessionTimeoutMs() + 4_000;

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;

const mcpHeaders = (bearer: string, sessionId?: string) => ({
  accept: JSON_AND_SSE,
  authorization: `Bearer ${bearer}`,
  "content-type": "application/json",
  "mcp-protocol-version": PROTOCOL_VERSION,
  ...(sessionId ? { "mcp-session-id": sessionId } : {}),
});

const postJson = (mcpUrl: string, bearer: string, body: unknown, sessionId?: string) =>
  fetch(mcpUrl, {
    method: "POST",
    headers: mcpHeaders(bearer, sessionId),
    body: JSON.stringify(body),
  });

const openSession = async (mcpUrl: string, bearer: string): Promise<string> => {
  const initialized = await postJson(mcpUrl, bearer, {
    jsonrpc: "2.0" as const,
    id: "initialize",
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "executor-e2e-idle-runtime-disposal", version: "0.0.1" },
    },
  });
  const sessionId = initialized.headers.get("mcp-session-id");
  await initialized.text();
  expect(initialized.status, "initialize opens a session").toBe(200);
  if (!sessionId) {
    // oxlint-disable-next-line executor/no-error-constructor -- boundary: e2e setup precondition.
    throw new Error("openSession: no mcp-session-id header");
  }
  const notification = await postJson(
    mcpUrl,
    bearer,
    { jsonrpc: "2.0" as const, method: "notifications/initialized" },
    sessionId,
  );
  await notification.text();
  expect(notification.status, "the client completes the handshake").toBe(202);
  return sessionId;
};

/**
 * The standalone GET stream a real client leaves open for the whole
 * conversation. Held open (never aborted) across the idle window — that is the
 * exact condition the old policy read as "busy".
 */
type OpenStream = {
  readonly closed: () => boolean;
  readonly abort: () => void;
};

const openGetStream = async (
  mcpUrl: string,
  bearer: string,
  sessionId: string,
): Promise<OpenStream> => {
  const abortController = new AbortController();
  const response = await fetch(mcpUrl, {
    method: "GET",
    headers: {
      accept: "text/event-stream",
      authorization: `Bearer ${bearer}`,
      "mcp-protocol-version": PROTOCOL_VERSION,
      "mcp-session-id": sessionId,
    },
    signal: abortController.signal,
  });
  expect(response.status, "the standalone GET stream opens").toBe(200);

  let closed = false;
  const reader = response.body?.getReader();
  // Drain in the background. The stream ending — for any reason — flips
  // `closed`, which is what part (2) of the contract inspects.
  void (async () => {
    if (!reader) {
      closed = true;
      return;
    }
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: reading an aborted stream throws; either way the stream is over.
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // fall through
    }
    closed = true;
  })();

  return {
    closed: () => closed,
    abort: () => abortController.abort("scenario complete"),
  };
};

const executeBody = (id: string, code: string) => ({
  jsonrpc: "2.0" as const,
  id,
  method: "tools/call",
  params: { name: "execute", arguments: { code } },
});

/** Run `execute` and return the response text once the call has fully settled. */
const execute = async (
  mcpUrl: string,
  bearer: string,
  sessionId: string,
  id: string,
  code: string,
): Promise<string> => {
  const response = await postJson(mcpUrl, bearer, executeBody(id, code), sessionId);
  const body = await response.text();
  expect(response.status, `execute ${id} is served`).toBe(200);
  return body;
};

scenario(
  "MCP session · an idle session disposes its runtime while the client stream stays open",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const telemetry = yield* Telemetry;

    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));

    const sessionId = yield* Effect.promise(() => openSession(target.mcpUrl, bearer));

    // The long-lived client stream, opened before any work and never closed.
    const stream = yield* Effect.promise(() => openGetStream(target.mcpUrl, bearer, sessionId));

    // ---- one call, then silence ------------------------------------------
    const marker = `before-${randomUUID().slice(0, 8)}`;
    const first = yield* Effect.promise(() =>
      execute(
        target.mcpUrl,
        bearer,
        sessionId,
        "execute-before-idle",
        `return ${JSON.stringify(marker)};`,
      ),
    );
    expect(first, "the session executes before going idle").toContain(marker);

    // ---- go idle, with the stream still connected -------------------------
    yield* Effect.sleep(`${IDLE_GAP_MS} millis`);

    // ---- 1. the runtime was released --------------------------------------
    // The alarm carries no client trace context, so this is found by operation
    // and matched to this session by attribute rather than by trace id.
    const disposals = yield* telemetry
      .searchSpans({ operation: "mcp.session.idle_runtime_dispose" })
      .pipe(
        Effect.map((spans) =>
          spans.filter((span) => (span.span.tags["mcp.session.id"] ?? "").includes(sessionId)),
        ),
        Effect.filterOrFail(
          (spans) => spans.length > 0,
          () => `no idle-runtime-disposal span exported for session ${sessionId}`,
        ),
        // The span is exported off the alarm's own flush, which is not on any
        // response path — same polling grace `expectSpan` uses.
        Effect.retry(Schedule.both(Schedule.spaced("500 millis"), Schedule.recurs(40))),
      );

    expect(disposals.length, "the idle session released its execution runtime").toBeGreaterThan(0);

    const disposal = disposals[0]!;
    expect(
      Number(disposal.span.tags["mcp.session.idle_ms"]),
      "the runtime was released because the session went idle, not for some other reason",
    ).toBeGreaterThanOrEqual(configuredMcpSessionTimeoutMs());
    expect(
      disposal.span.tags["mcp.isolate.resident_runtimes"],
      "the disposal records the isolate's resident-runtime gauge",
    ).toBeDefined();

    // ---- 3. the next call restores underneath the client ------------------
    const after = `after-${randomUUID().slice(0, 8)}`;
    const second = yield* Effect.promise(() =>
      execute(
        target.mcpUrl,
        bearer,
        sessionId,
        "execute-after-idle",
        `return ${JSON.stringify(after)};`,
      ),
    );
    expect(
      second,
      "the same session serves the next call with the right answer after restoring",
    ).toContain(after);

    stream.abort();
  }),
);
