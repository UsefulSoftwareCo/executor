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

/**
 * The verdict a request gets once the destroy alarm has wiped the session's
 * storage — i.e. the teardown this scenario is timing itself against is over.
 * Matched on the protocol answer, not on any server internal.
 */
const isWipedVerdict = (probe: Probe): boolean =>
  probe.status === 404 && jsonRpcError(probe.body)?.message === "Session not found";

const describeProbe = (probe: Probe): string =>
  `+${probe.atMs}ms ${probe.status} ${probe.body.slice(0, 200)}`;

scenario(
  "MCP protocol · in-flight requests survive their session's teardown as protocol errors",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;

    // The fatal instant is the isolate abort at the end of the teardown, and a
    // session only crosses it once — so cross it many times. A single crossing
    // leaks the unhandled 500 only when a `validateMcpSessionOwner` RPC is
    // inside the object at exactly that instant, so the scenario has to make
    // that likely rather than hope for it: `sessions` crossings, each blanketed
    // by `concurrency` requests. At 6 × 8 the pre-fix bug reproduced in only
    // about half of runs; the numbers below are the measured point where it
    // reproduces every run without pushing the shared auth path into 403s.
    const sessions = 12;
    // Requests are kept continuously in flight rather than polled on a timer:
    // the point is to have work ALREADY inside the session object when the
    // termination lands, not to sample the window from outside it.
    const concurrency = 24;
    // Ceiling, not the plan: the stream normally stops as soon as the teardown
    // is OBSERVED to have completed (below). This only bounds a teardown whose
    // alarm never lands, so a hung platform fails the scenario instead of
    // hanging it.
    const streamAfterDeleteMs = 3_000;
    // Once the storage wipe is visible the abort has already happened, so the
    // window this scenario exists to cover is behind us. Keep going briefly —
    // the abort and the wipe are not the same instant — then stop, because
    // every further request is pure load on the shared auth path.
    const graceAfterWipeMs = 150;
    // Enough in-flight requests to be mid-teardown, without racing the DELETE
    // itself before the session is fully established.
    const warmupMs = 250;

    const probes: Probe[] = [];
    // Per teardown, so the scenario can PROVE each crossing was straddled
    // rather than assume it.
    const perSession: Probe[][] = [];

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

      const thisSession: Probe[] = [];
      perSession.push(thisSession);

      yield* Effect.promise(async () => {
        const startedAt = Date.now();
        let hardStopAt = Number.POSITIVE_INFINITY;
        // Set the first time the wiped-storage verdict is seen, which is the
        // observable end of the teardown — the stream stops on this, not a
        // timer.
        let stopAfterWipeAt = Number.POSITIVE_INFINITY;

        const probeOnce = async (): Promise<void> => {
          const at = Date.now() - startedAt;
          const response = await mcpPost(target.mcpUrl, {
            bearer,
            sessionId,
            body: TOOLS_LIST_REQUEST,
          });
          const probe: Probe = {
            atMs: at,
            status: response.status,
            body: await response.text(),
            retryAfter: response.headers.get("retry-after"),
          };
          probes.push(probe);
          thisSession.push(probe);
          // "Session not found" is the post-wipe verdict: the destroy alarm has
          // run, storage is gone, and the object has been aborted. Anything
          // after this point is a request against an already-dead id.
          if (isWipedVerdict(probe) && stopAfterWipeAt === Number.POSITIVE_INFINITY) {
            stopAfterWipeAt = Date.now() + graceAfterWipeMs;
          }
        };

        // One worker replenishes its request the moment the previous one
        // settles, so the session object is never idle and the DELETE has to
        // land on top of real traffic.
        const worker = async (): Promise<void> => {
          while (Date.now() < hardStopAt && Date.now() < stopAfterWipeAt) await probeOnce();
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

        hardStopAt = Date.now() + streamAfterDeleteMs;
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

    // Coverage precondition, checked per teardown rather than in aggregate: a
    // run in which some session's stream finished before its object was torn
    // down never entered the window this scenario exists to cover, and its
    // green is worth nothing. Requiring EVERY crossing to have been observed is
    // what stops the assertions above from passing vacuously.
    const notStraddled = perSession
      .map((session, index) => ({ index, wiped: session.some(isWipedVerdict) }))
      .filter((entry) => !entry.wiped)
      .map((entry) => `teardown #${entry.index + 1}`);
    expect(
      notStraddled,
      "every teardown was still under load when its session object was destroyed",
    ).toEqual([]);

    // The disposition half of the contract, on the one failure this scenario
    // can actually produce. Every platform failure reachable here is the
    // session's own `ctx.abort` after a DELETE the client itself sent, and that
    // id is dead for good — so the answer has to be "reconnect", never
    // "restarting, retry". A retryable verdict for a deliberately terminated
    // session is worse than the 500 this PR removed: the client is told to keep
    // asking, and the loop never ends.
    const deadIdCalledRetryable = probes.filter((probe) => probe.status === 503);
    expect(
      deadIdCalledRetryable.map(describeProbe),
      "a session the client terminated is never advertised as retryable",
    ).toEqual([]);

    // A 503 here means "the platform is mid-reset, come back". It is only
    // actionable if the client is told how long to wait, so it must carry
    // Retry-After AND a positive delay — a `retry-after: 0`, or a header the
    // renderer dropped, is the same dead end as no answer at all.
    const badBackoff = probes.filter((probe) => {
      if (probe.status !== 503) return false;
      const seconds = probe.retryAfter === null ? null : Number(probe.retryAfter);
      return seconds === null || !Number.isFinite(seconds) || seconds <= 0;
    });
    expect(
      badBackoff.map(describeProbe),
      "every retryable rejection tells the client how long to back off",
    ).toEqual([]);

    // The other half of the classifier's contract, and the half a teardown
    // cannot demonstrate: a DEFINITIVE refusal must stay definitive. If the
    // platform-failure path ever widens far enough to swallow ordinary
    // rejections, these are the two answers that would silently turn into "the
    // session is restarting, retry" and send a client into a loop it can never
    // exit.
    const liveIdentity = yield* target.newIdentity();
    const liveBearer = yield* mcp.mintBearer(emailOf(liveIdentity));
    const liveSessionId = yield* Effect.promise(() => openSession(target.mcpUrl, liveBearer));

    const strangerIdentity = yield* target.newIdentity();
    const strangerBearer = yield* mcp.mintBearer(emailOf(strangerIdentity));

    yield* Effect.gen(function* () {
      const hijack = yield* Effect.promise(() =>
        mcpPost(target.mcpUrl, {
          bearer: strangerBearer,
          sessionId: liveSessionId,
          body: TOOLS_LIST_REQUEST,
        }),
      );
      const hijackBody = yield* Effect.promise(() => hijack.text());
      expect(
        hijack.status,
        "another account's session id is refused outright, not advertised as retryable",
      ).toBe(403);
      expect(hijack.headers.get("retry-after"), "a refusal carries no backoff advice").toBeNull();
      expect(jsonRpcError(hijackBody)?.code, "the refusal is the session-ownership error").toBe(
        -32003,
      );

      const unauthenticated = yield* Effect.promise(() =>
        fetch(target.mcpUrl, {
          method: "POST",
          headers: { accept: JSON_AND_SSE, "content-type": "application/json" },
          body: JSON.stringify(TOOLS_LIST_REQUEST),
        }),
      );
      yield* Effect.promise(() => unauthenticated.text());
      expect(
        unauthenticated.status,
        "a missing credential is refused outright, not advertised as retryable",
      ).toBe(401);
      expect(
        unauthenticated.headers.get("retry-after"),
        "a refusal carries no backoff advice",
      ).toBeNull();
    }).pipe(
      // Runs even when an assertion above fails, so the extra session never
      // outlives the scenario. `tryPromise` so a refused cleanup is a failure
      // `ignore` can actually swallow — cleanup must not mask the real verdict.
      Effect.ensuring(
        Effect.tryPromise(async () => {
          const closed = await fetch(target.mcpUrl, {
            method: "DELETE",
            headers: {
              authorization: `Bearer ${liveBearer}`,
              "mcp-session-id": liveSessionId,
            },
          });
          await closed.text();
        }).pipe(Effect.ignore),
      ),
    );
  }),
);
