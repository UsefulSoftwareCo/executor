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
import { expect, it } from "@effect/vitest";
import { Effect, Option, Schedule, Schema } from "effect";

import { MAX_CONCURRENT_BUILDS } from "../../apps/cloud/src/mcp/session-build-semaphore";
import { scenario } from "../src/scenario";
import { Mcp, Target, Telemetry } from "../src/services";
import type { Identity } from "../src/target";
import { configuredMcpSessionTimeoutMs } from "../setup/mcp-session-timeouts";
import { E2E_MCP_RESIDENT_RUNTIME_SOFT_CAP } from "../setup/resident-runtime-cap";

const PROTOCOL_VERSION = "2025-03-26";
const JSON_AND_SSE = "application/json, text/event-stream";

// Comfortably past the cap: even if a handful of other scenarios' sessions
// are still incidentally resident when this file runs, enough of THESE
// sessions cross it that at least one eviction targets a session opened here.
const SESSIONS_TO_OPEN = E2E_MCP_RESIDENT_RUNTIME_SOFT_CAP + 10;

// Every request below that can start a cold runtime build is held to the
// isolate's own build width, so none of them ever waits in the FIFO queue at
// apps/cloud/src/mcp/session-build-semaphore.ts. That is an `initialize`, a
// keep-alive touch of a session the cap has evicted (the owner check
// restores it before the request is forwarded), and a cleanup DELETE of a
// session whose runtime was disposed (same restore, then the destroy).
//
// A build that does wait there is handed its slot from the releasing
// session's request context, and in the CI runs that first failed this
// scenario no build resumed that way finished: every queued init sat out the
// queue's full 10s timeout, and the ones granted a slot were reset at the
// 30s `blockConcurrencyWhile` limit. That is observed, most likely the
// semaphore hand-off itself, and tracked separately in
// https://github.com/UsefulSoftwareCo/executor/issues/2063. It is not what
// this scenario pins, so the scenario stays out of the queue entirely: opens
// and touches never overlap, the batch alternates a wave of one with a wave
// of the other, and each wave is at most this wide.
const COLD_BUILD_CONCURRENCY = MAX_CONCURRENT_BUILDS;

// The cap only trips if the sessions opened here are still RESIDENT when the
// next one is admitted. A session that reaches the target's idle timeout
// first (MCP_SESSION_TIMEOUT_MS, squeezed to a few seconds for e2e) gives its
// runtime back and leaves the count, and a batch that idles out as fast as it
// is opened never reaches the cap at all — no eviction, nothing to assert on.
// Open throughput is not something to rely on for that (34 opens took 3.5s
// on a loaded CI runner, against a 3s window), so the batch keeps them
// resident itself: after every wave of opens, every session opened so far is
// touched with a `ping`, which marks it active and re-arms its idle alarm
// through the owner check every request with a session id goes through. A
// touch is a full authenticated request, so the touch wave is the slow half
// of a tick, and one tick is the most any session goes untouched; the
// scenario measures the longest one and prints it next to the window.
//
// Touching stops once this many sessions are open, which is before the cap
// can evict any of THESE. Once an isolate is at the cap, every admission
// evicts its least-recently-active resident. With M sessions left over from
// earlier scenarios (older than these, so evicted first) the cap is reached
// at admission cap − M + 1, admissions up to cap evict the M leftovers, and
// admission cap + 1 is the first that can pick one of these — and it is the
// very next open, landing while every session from the last touch wave is
// fresh. Touching past that point would only trade one eviction for
// another: a touch of a session the cap has just evicted restores it, and
// that admission evicts the next candidate. A leftover that is NOT evictable
// (a paused execution keeps its runtime resident) moves the first pick of
// one of these earlier, into the touched phase; the next touch wave then
// restores it, which is a cold build like any other, and is why touch waves
// are held to the same width as open waves.
const KEEP_RESIDENT_WHILE_OPENING = E2E_MCP_RESIDENT_RUNTIME_SOFT_CAP;

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

const decodeRestartEnvelope = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      jsonrpc: Schema.Literal("2.0"),
      id: Schema.Null,
      error: Schema.Struct({
        code: Schema.Literal(-32001),
        message: Schema.Literal("MCP session is restarting, please retry"),
      }),
    }),
  ),
);

const isRestartResponse = (status: number, body: string): boolean =>
  status === 503 && Option.isSome(decodeRestartEnvelope(body));

it.each([
  [
    503,
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "MCP session is restarting, please retry" },
    },
    true,
  ],
  [
    404,
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "MCP session is restarting, please retry" },
    },
    false,
  ],
  [
    503,
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "MCP session is restarting, please retry" },
    },
    false,
  ],
  [
    503,
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "MCP session is restarting unexpectedly" },
    },
    false,
  ],
  [503, { error: "MCP session is restarting, please retry" }, false],
] as const)("only retries the documented restart envelope (%s, %j)", (status, body, retry) => {
  expect(isRestartResponse(status, JSON.stringify(body))).toBe(retry);
});

it("does not retry malformed restart responses", () => {
  expect(isRestartResponse(503, "MCP session is restarting, please retry")).toBe(false);
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
  // The platform can reset a session Durable Object while its initialize
  // is in flight, and the server answers that with the documented restart
  // envelope (503, -32001, "MCP session is restarting, please retry") — the
  // same contract a streamable-http client follows: same request, after the
  // advertised delay. Treat it as transient here instead of failing the
  // scenario on a retryable platform blip.
  const RESTART_ATTEMPTS = 8;
  const RESTART_DELAY_MS = 2_000; // The host advertises Retry-After: 2.
  let minted: { readonly response: Response; readonly sessionId: string } | undefined;
  for (let attempt = 0; attempt < RESTART_ATTEMPTS; attempt += 1) {
    const response = await postJson(mcpUrl, bearer, {
      jsonrpc: "2.0" as const,
      id: "initialize",
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: `executor-e2e-cap-eviction-${label}`, version: "0.0.1" },
      },
    });
    const candidate = response.headers.get("mcp-session-id");
    if (candidate !== null && candidate.length > 0) {
      minted = { response, sessionId: candidate };
      break;
    }
    const body = await response.text();
    const isRestart = isRestartResponse(response.status, body);
    if (!isRestart) break;
    if (attempt === RESTART_ATTEMPTS - 1) break;
    await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
  }
  if (!minted) {
    // oxlint-disable-next-line executor/no-error-constructor -- boundary: e2e setup precondition.
    throw new Error(`openSession (${label}): no mcp-session-id header`);
  }
  const { response: initialized, sessionId } = minted;
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

/**
 * The cheapest request that keeps a session resident: a JSON-RPC `ping`,
 * answered by the MCP server's protocol layer without touching a tool. The
 * idle alarm is re-armed by the owner check the router runs before any
 * request with a session id is forwarded, so a served ping is all that is
 * needed. The documented restart envelope is tolerated too — the platform
 * reset the session's object underneath the batch, and it restores itself
 * on its next request — the same transient `openSession` tolerates.
 * Anything else is a real failure: it stops the keep-alive, which fails the
 * scenario with it.
 */
const touchSession = async (
  mcpUrl: string,
  bearer: string,
  sessionId: string,
  id: number,
): Promise<void> => {
  const response = await postJson(
    mcpUrl,
    bearer,
    { jsonrpc: "2.0" as const, id: `keep-alive-${id}`, method: "ping" },
    sessionId,
  );
  const body = await response.text();
  if (response.status === 200 || isRestartResponse(response.status, body)) return;
  // oxlint-disable-next-line executor/no-error-constructor -- boundary: e2e keep-alive precondition.
  throw new Error(
    `keep-alive ping of ${sessionId} was not served: ${response.status} ${body.slice(0, 200)}`,
  );
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
      const openWave = (wave: ReadonlyArray<number>) =>
        Effect.forEach(
          wave,
          (index) =>
            Effect.promise(() =>
              openSession(target.mcpUrl, bearer, `session-${index}`, (sessionId) => {
                openedSessionIds.push(sessionId);
              }),
            ),
          { concurrency: COLD_BUILD_CONCURRENCY },
        );
      let touches = 0;
      // `suspend`: the sessions to touch are whichever are open when the
      // wave runs, not when this is built.
      const touchEveryOpenSession = Effect.suspend(() =>
        Effect.forEach(
          [...openedSessionIds],
          (sessionId) =>
            Effect.promise(() => {
              touches += 1;
              return touchSession(target.mcpUrl, bearer, sessionId, touches);
            }),
          { concurrency: COLD_BUILD_CONCURRENCY, discard: true },
        ),
      );

      // Open more sessions than the cap allows. None of the sessions run any
      // work, so every one is immediately eviction-eligible — crossing the cap
      // must pick at least one and tear it down through its own stub.
      const indices = Array.from({ length: SESSIONS_TO_OPEN }, (_, index) => index);
      const sessionIds: string[] = [];

      // Kept resident (see KEEP_RESIDENT_WHILE_OPENING): a wave of opens,
      // then a wave of touches over everything open so far, and again.
      let ticks = 0;
      let longestTickMs = 0;
      const keptStartedAt = Date.now();
      for (let from = 0; from < KEEP_RESIDENT_WHILE_OPENING; from += COLD_BUILD_CONCURRENCY) {
        const tickStartedAt = Date.now();
        const to = Math.min(from + COLD_BUILD_CONCURRENCY, KEEP_RESIDENT_WHILE_OPENING);
        sessionIds.push(...(yield* openWave(indices.slice(from, to))));
        yield* touchEveryOpenSession;
        ticks += 1;
        longestTickMs = Math.max(longestTickMs, Date.now() - tickStartedAt);
      }
      const keptTookMs = Date.now() - keptStartedAt;

      // Crossing the cap: the rest, untouched. The first of these admissions
      // is the one that must evict a session opened above.
      const crossingStartedAt = Date.now();
      sessionIds.push(...(yield* openWave(indices.slice(KEEP_RESIDENT_WHILE_OPENING))));
      const crossingTookMs = Date.now() - crossingStartedAt;

      // Diagnostic only: the scenario no longer depends on the batch beating
      // the idle window, but the figures show how much room the keep-alive had.
      console.info(
        `[cap-eviction] kept ${KEEP_RESIDENT_WHILE_OPENING} sessions resident through ${ticks} open+touch ticks in ${keptTookMs}ms (longest tick ${longestTickMs}ms against a ${configuredMcpSessionTimeoutMs()}ms idle window, ${touches} touches); the ${SESSIONS_TO_OPEN - KEEP_RESIDENT_WHILE_OPENING} opens that cross the cap took ${crossingTookMs}ms`,
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
            // A DELETE of a session whose runtime was disposed in the meantime
            // restores it before the destroy (the owner check runs first), so
            // this is a wave of cold builds too — held to the same width as
            // every other wave above (see COLD_BUILD_CONCURRENCY).
            { concurrency: COLD_BUILD_CONCURRENCY, discard: true },
          ),
        ),
      ),
    );
  }),
);
