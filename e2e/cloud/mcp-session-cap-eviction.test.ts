// Cloud: crossing the isolate's resident-runtime soft cap evicts an idle
// session's runtime through a REAL cross-Durable-Object request, not a
// same-context call.
//
// The defect this pins: the original design ran the evicted (candidate)
// session's teardown — closing its postgres.js socket, storage writes, span
// flush — directly inside the EVICTING session's own request/IoContext. In
// production workerd, I/O objects are bound to the IoContext that created
// them, so a cross-context call like that throws "Cannot perform I/O on
// behalf of a different request" or silently soft-fails. That failure mode
// cannot reproduce against an in-process unit-test double (same JS object,
// same context either way) — it only shows up against a real Durable Object
// stub. The fix routes eviction through the candidate's OWN stub
// (`requestCapEviction`, an RPC method mirroring `forwardModelResumeToOwner`),
// so the candidate's teardown runs in the candidate's own context, and this
// scenario is what actually exercises that stub in workerd.
//
// e2e/setup/resident-runtime-cap.ts lowers MCP_RESIDENT_RUNTIME_SOFT_CAP for
// the whole boot (see that file for the value and its headroom story), so
// this test can cross it with a bounded number of real sessions instead of
// registering the production default of 32.
import { expect } from "@effect/vitest";
import { Effect, Schedule } from "effect";

import { scenario } from "../src/scenario";
import { Mcp, Target, Telemetry } from "../src/services";
import type { Identity } from "../src/target";
import { E2E_MCP_RESIDENT_RUNTIME_SOFT_CAP } from "../setup/resident-runtime-cap";

const PROTOCOL_VERSION = "2025-03-26";
const JSON_AND_SSE = "application/json, text/event-stream";

// Comfortably past the cap: even if a handful of other scenarios' sessions
// are still incidentally resident when this file runs, enough of THESE
// sessions cross it that at least one eviction targets a session opened here.
const SESSIONS_TO_OPEN = E2E_MCP_RESIDENT_RUNTIME_SOFT_CAP + 10;

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

/**
 * Opens one fresh MCP session under an already-minted bearer. `initialize`
 * without an existing `mcp-session-id` always mints a new session, the same
 * way separate browser tabs sharing one login would — so many of these under
 * one identity is a cheap way to grow the isolate's resident-runtime count
 * without a full OAuth round trip per session.
 *
 * `recordSession` is called the moment the session id is known — before the
 * `notifications/initialized` round trip below, not after this function
 * returns. A session is live on the server as soon as `initialize` responds
 * with an `mcp-session-id`, regardless of whether the handshake ever
 * completes; recording it only on a full return left a failed notification
 * (or an interrupt landing between the two requests) with no cleanup entry,
 * orphaning a real session on the target isolate.
 */
const openSession = async (
  mcpUrl: string,
  bearer: string,
  label: string,
  recordSession: (sessionId: string) => void,
): Promise<string> => {
  const initialized = await postJson(mcpUrl, bearer, {
    jsonrpc: "2.0" as const,
    id: "initialize",
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: `executor-e2e-cap-eviction-${label}`, version: "0.0.1" },
    },
  });
  const sessionId = initialized.headers.get("mcp-session-id");
  if (!sessionId) {
    // oxlint-disable-next-line executor/no-error-constructor -- boundary: e2e setup precondition.
    throw new Error(`openSession (${label}): no mcp-session-id header`);
  }
  // Recorded the moment the id exists — BEFORE the body read and status
  // assertion below, either of which can throw with the session already live
  // on the server. The cleanup finalizer needs the id on every one of those
  // paths, not just a fully successful return.
  recordSession(sessionId);
  await initialized.text();
  expect(initialized.status, `initialize (${label}) opens a session`).toBe(200);
  const notification = await postJson(
    mcpUrl,
    bearer,
    { jsonrpc: "2.0" as const, method: "notifications/initialized" },
    sessionId,
  );
  await notification.text();
  expect(notification.status, `(${label}) completes the handshake`).toBe(202);
  return sessionId;
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
  "MCP session · crossing the resident-runtime cap evicts a session through a real cross-DO request",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const telemetry = yield* Telemetry;

    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));

    // Opened sessions are recorded here as each one succeeds, so the cleanup
    // below can close exactly what was actually opened even if the scenario
    // fails partway through. Cap eviction already tears most of these down as
    // a side effect of the scenario itself, but termination is idempotent
    // (see mcp-destroyed-session-envelope.test.ts) — closing an already-torn-
    // -down session is a harmless no-op, not a double-free.
    const openedSessionIds: string[] = [];

    const scenarioBody = Effect.gen(function* () {
      // Open more sessions than the cap allows, at limited concurrency. None
      // of them run any work, so every one is immediately eviction-eligible —
      // crossing the cap must pick at least one and tear it down through its
      // own stub.
      const sessionIds = yield* Effect.forEach(
        Array.from({ length: SESSIONS_TO_OPEN }, (_, index) => index),
        (index) =>
          Effect.promise(() =>
            openSession(target.mcpUrl, bearer, `session-${index}`, (sessionId) => {
              openedSessionIds.push(sessionId);
            }),
          ),
        { concurrency: 8 },
      );

      expect(sessionIds.length, "every session opened").toBe(SESSIONS_TO_OPEN);
      expect(new Set(sessionIds).size, "every session got a distinct id").toBe(SESSIONS_TO_OPEN);

      // ---- a real cap eviction fired, against a session opened here -------
      // Same span the idle path emits (`mcp.session.idle_runtime_dispose`);
      // `mcp.session.dispose_reason` is what disambiguates the trigger.
      const capDisposals = yield* telemetry
        .searchSpans({ operation: "mcp.session.idle_runtime_dispose" })
        .pipe(
          Effect.map((spans) =>
            spans.filter(
              (span) =>
                span.span.tags["mcp.session.dispose_reason"] === "cap" &&
                sessionIds.some((id) => (span.span.tags["mcp.session.id"] ?? "").includes(id)),
            ),
          ),
          Effect.filterOrFail(
            (spans) => spans.length > 0,
            () => "no cap-triggered idle_runtime_dispose span exported for any session opened here",
          ),
          // The eviction request is fire-and-forget (`ctx.waitUntil`) from the
          // evictor's `init`, and its own span flush is off that same
          // background path — same polling grace the idle-disposal scenario
          // uses for its alarm-driven flush.
          Effect.retry(Schedule.both(Schedule.spaced("500 millis"), Schedule.recurs(40))),
        );

      expect(
        capDisposals.length,
        "crossing the resident-runtime cap evicted at least one session opened here",
      ).toBeGreaterThan(0);

      const disposal = capDisposals[0]!;
      expect(
        disposal.span.tags["mcp.isolate.resident_runtimes"],
        "the cap disposal records the isolate's resident-runtime gauge, same as the idle path",
      ).toBeDefined();

      // ---- the evicted session still works — restore is transparent -------
      const evictedSessionId = sessionIds.find((id) =>
        (disposal.span.tags["mcp.session.id"] ?? "").includes(id),
      );
      expect(
        evictedSessionId,
        "the disposed span's session id matches a session opened here",
      ).toBeDefined();

      const marker = `after-cap-evict-${evictedSessionId}`;
      const restored = yield* Effect.promise(() =>
        execute(
          target.mcpUrl,
          bearer,
          evictedSessionId!,
          "execute-after-cap-eviction",
          `return ${JSON.stringify(marker)};`,
        ),
      );
      expect(
        restored,
        "the evicted session serves the next call correctly after restoring underneath the client",
      ).toContain(marker);
    });

    yield* scenarioBody.pipe(
      // `Effect.ensuring`, not a trailing statement: a failure partway through
      // (an assertion above, a timed-out span search) must not leak the
      // sessions already opened. Read `openedSessionIds` at cleanup time, not
      // capture time — `Effect.suspend` so the array is read when the
      // finalizer actually runs, after the scenario body has finished pushing
      // to it, rather than snapshotted empty at construction.
      Effect.ensuring(
        Effect.suspend(() =>
          Effect.forEach(
            openedSessionIds,
            (sessionId) =>
              Effect.tryPromise(async () => {
                const closed = await fetch(target.mcpUrl, {
                  method: "DELETE",
                  headers: {
                    authorization: `Bearer ${bearer}`,
                    "mcp-session-id": sessionId,
                  },
                });
                await closed.text();
              }).pipe(Effect.ignore),
            { concurrency: 8, discard: true },
          ),
        ),
      ),
    );
  }),
);
