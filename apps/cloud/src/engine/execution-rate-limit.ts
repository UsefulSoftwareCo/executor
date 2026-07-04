// ---------------------------------------------------------------------------
// Per-org execution rate limit — an abuse backstop independent of billing.
//
// The balance gate (execution-gate.ts) depends on Autumn and fails open, so a
// billing outage plus runaway automation could still run unbounded executions.
// This limiter counts `execute` calls per organization in a fixed hourly
// window, backed by a minimal counter Durable Object (cross-session state:
// each MCP session lives in its own DO instance, so an in-memory counter
// would be per-session and trivially bypassed by opening more sessions).
//
// Like the balance gate it FAILS OPEN: an unreachable counter DO, a missing
// binding, or a slow call allows the execution (warn + Sentry). The backstop
// must never take executions down with it.
// ---------------------------------------------------------------------------

import { DurableObject, env } from "cloudflare:workers";
import { Data, Effect } from "effect";
import type * as Cause from "effect/Cause";

import type { ExecutionEngine } from "@executor-js/execution";

import { captureCauseEffect } from "../observability";
import { withPreExecutionGate, type GateDecision } from "./execution-gate";
import { RATE_LIMIT_BLOCKED_MESSAGE } from "./execution-limit-messages";

// Fixed window: all executions in the same clock hour share one counter.
export const RATE_LIMIT_WINDOW_MS = 3_600_000;
// Calibration: the heaviest legitimate org runs ~1.1k executions per MONTH,
// so 1000 per HOUR is far above any human-driven usage and only trips on
// runaway automation (the incident this backstops: ~18k in 30 days would
// still pass, which is fine — that class of overrun is the balance gate's
// job; this catches tight loops).
export const EXECUTIONS_PER_ORG_PER_HOUR = 1000;
// Counter DO slower than this => fail open rather than stall executions.
const RATE_LIMIT_CHECK_TIMEOUT_MS = 2_000;
// The DO purges its storage this long after the last increment, so idle orgs
// cost nothing. Two windows: long enough that an active window never purges.
const COUNTER_PURGE_AFTER_MS = 2 * RATE_LIMIT_WINDOW_MS;

export { RATE_LIMIT_BLOCKED_MESSAGE };

export class ExecutionRateLimitExceededError extends Data.TaggedError(
  "ExecutionRateLimitExceededError",
)<{
  readonly organizationId: string;
  readonly message: string;
}> {}

/** Internal sentinel for a counter call that exceeded its time budget. */
class RateLimitCheckTimeoutError extends Data.TaggedError("RateLimitCheckTimeoutError")<{
  readonly timeoutMs: number;
}> {}

// ---------------------------------------------------------------------------
// Counter Durable Object — one instance per organization (idFromName(orgId)).
// Stores a single { windowId, count } record: an increment in a new window
// resets the count, so old windows never accumulate. An alarm purges storage
// after inactivity.
// ---------------------------------------------------------------------------

const WINDOW_RECORD_KEY = "window";

type WindowRecord = {
  readonly windowId: number;
  readonly count: number;
};

export class ExecutionRateLimiterDO extends DurableObject {
  private readonly counterStorage: DurableObjectState["storage"];

  constructor(ctx: DurableObjectState, doEnv: Env) {
    super(ctx, doEnv);
    // Kept on an own field (not just inherited `this.ctx`) so tests can run
    // the class against a fake storage under the `cloudflare:workers` stub.
    this.counterStorage = ctx.storage;
  }

  /** Add one execution to `windowId`'s counter and return the new count. */
  async increment(windowId: number): Promise<number> {
    const stored = await this.counterStorage.get<WindowRecord>(WINDOW_RECORD_KEY);
    const count = stored && stored.windowId === windowId ? stored.count + 1 : 1;
    await this.counterStorage.put(WINDOW_RECORD_KEY, { windowId, count });
    await this.counterStorage.setAlarm(Date.now() + COUNTER_PURGE_AFTER_MS);
    return count;
  }

  async alarm(): Promise<void> {
    await this.counterStorage.deleteAll();
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Count one execution for (organizationId, windowId); returns the new count. */
export type RateLimitIncrement = (
  organizationId: string,
  windowId: number,
) => Effect.Effect<number, unknown>;

export type ExecutionRateLimiter = {
  readonly decorate: <E extends Cause.YieldableError>(
    organizationId: string,
    engine: ExecutionEngine<E>,
  ) => ExecutionEngine<E>;
};

/**
 * Build a rate limiter around an increment function (in production: the
 * counter DO). `options.limit` is the per-org hourly cap (production sets it
 * from the env override in `makeCloudExecutionRateLimiter`); the rest tune the
 * window and time budget.
 */
export const makeExecutionRateLimiter = (
  increment: RateLimitIncrement,
  options?: {
    readonly limit?: number;
    readonly windowMs?: number;
    readonly timeoutMs?: number;
    readonly now?: () => number;
  },
): ExecutionRateLimiter => {
  const limit = options?.limit ?? EXECUTIONS_PER_ORG_PER_HOUR;
  const windowMs = options?.windowMs ?? RATE_LIMIT_WINDOW_MS;
  const timeoutMs = options?.timeoutMs ?? RATE_LIMIT_CHECK_TIMEOUT_MS;
  const now = options?.now ?? Date.now;

  const decide = (organizationId: string): Effect.Effect<GateDecision> =>
    Effect.suspend(() => {
      const windowId = Math.floor(now() / windowMs);
      return increment(organizationId, windowId).pipe(
        Effect.timeoutOrElse({
          duration: `${timeoutMs} millis`,
          orElse: () => Effect.fail(new RateLimitCheckTimeoutError({ timeoutMs })),
        }),
        Effect.map(
          (count): GateDecision =>
            count > limit
              ? {
                  blocked: true,
                  error: new ExecutionRateLimitExceededError({
                    organizationId,
                    message: RATE_LIMIT_BLOCKED_MESSAGE,
                  }),
                }
              : { blocked: false },
        ),
        // FAIL OPEN: the backstop must never block executions because its
        // counter is unreachable or slow.
        Effect.catch((error: unknown) =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              console.warn("[rate-limit] execution rate limit check failed open:", error);
            });
            yield* captureCauseEffect(error);
            return { blocked: false } as const satisfies GateDecision;
          }),
        ),
      );
    });

  return {
    decorate: (organizationId, engine) => withPreExecutionGate(engine, decide(organizationId)),
  };
};

// ---------------------------------------------------------------------------
// Cloud wiring — reads the EXECUTION_RATE_LIMITER binding from the worker env.
// ---------------------------------------------------------------------------

// The DO stub's RPC surface. The binding is declared untyped in
// env-augment.d.ts (matching the BLOBS precedent), so the call site narrows it
// to the one method the class exposes.
type ExecutionRateLimiterStub = {
  readonly increment: (windowId: number) => Promise<number>;
};

type RateLimiterNamespace = {
  readonly idFromName: (name: string) => DurableObjectId;
  readonly get: (id: DurableObjectId) => unknown;
};

/**
 * Production rate limiter backed by the `EXECUTION_RATE_LIMITER` counter DO.
 * When the binding is absent (unit-test workers, older local setups) the
 * limiter is disabled: every check passes, logged once at construction.
 */
export const makeCloudExecutionRateLimiter = (): ExecutionRateLimiter => {
  const limit = resolveRateLimit();
  const namespace = (env as { EXECUTION_RATE_LIMITER?: RateLimiterNamespace })
    .EXECUTION_RATE_LIMITER;
  if (!namespace) {
    console.warn(
      "[rate-limit] EXECUTION_RATE_LIMITER binding missing; execution rate limiting disabled",
    );
    return makeExecutionRateLimiter(() => Effect.succeed(0));
  }
  return makeExecutionRateLimiter(
    (organizationId, windowId) =>
      Effect.tryPromise(() => {
        const stub = namespace.get(
          namespace.idFromName(organizationId),
        ) as ExecutionRateLimiterStub;
        return stub.increment(windowId);
      }),
    { limit },
  );
};

/**
 * The per-org hourly cap: the `EXECUTION_RATE_LIMIT_PER_HOUR` env override
 * (parsed as a positive integer) or `EXECUTIONS_PER_ORG_PER_HOUR` when it's
 * unset or unparseable. The override exists so e2e can drive the backstop with
 * a small number of real executions; production leaves the var unset.
 */
const resolveRateLimit = (): number => {
  const raw = (env as { EXECUTION_RATE_LIMIT_PER_HOUR?: string }).EXECUTION_RATE_LIMIT_PER_HOUR;
  if (raw === undefined) return EXECUTIONS_PER_ORG_PER_HOUR;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : EXECUTIONS_PER_ORG_PER_HOUR;
};
