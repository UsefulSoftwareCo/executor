// ---------------------------------------------------------------------------
// Per-org execution rate limit — a free-tier abuse backstop.
//
// The balance gate (execution-gate.ts) depends on Autumn and fails open, so a
// billing outage plus runaway automation could still run unbounded executions.
// This limiter counts `execute` calls per organization in a fixed hourly
// window, backed by a minimal counter Durable Object (cross-session state:
// each MCP session lives in its own DO instance, so an in-memory counter
// would be per-session and trivially bypassed by opening more sessions).
//
// Paid organizations are EXEMPT. The cap was sized for free-tier abuse but
// applied to everyone, and on 2026-08-18 it blocked a paying customer
// mid-workload — their agent gave up on Executor and routed around it. Paid
// usage is what the balance gate and metered overage are for; this backstop
// has no business capping it.
//
// The exemption is resolved ONLY once the counter reports an org over the cap,
// so the common path (under the cap) costs the counter increment and nothing
// else. `isExempt` is an opaque predicate: this module still names no billing
// concept, and the Autumn coupling lives in `execution-stack-metered.ts`,
// which already owns that dependency.
//
// FAIL OPEN applies to the COUNTER: an unreachable counter DO, a missing
// binding, or a slow call allows the execution (warn + Sentry). The backstop
// must never take executions down with it. An unresolved EXEMPTION is the one
// thing that does not fail open — see `resolveExemption`.
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
// The cap for organizations WITHOUT a paid subscription.
//
// The original calibration ("the heaviest legitimate org runs ~1.1k executions
// per MONTH, so 1000 per HOUR is far above any human-driven usage") went stale
// inside six weeks: by 2026-08-18 a paying org was sustaining ~5.3k executions
// per DAY and crossed this cap in a single hour. Sizing a shared number
// against the largest customer is a losing game, so the number no longer tries
// to describe them — paid orgs are exempt below, and this now has only
// free-tier abuse to cover, which is what it was picked for.
export const EXECUTIONS_PER_ORG_PER_HOUR = 1000;
// Counter DO slower than this => fail open rather than stall executions.
const RATE_LIMIT_CHECK_TIMEOUT_MS = 2_000;
// Exemption lookup slower than this => treat as unresolved.
const EXEMPTION_CHECK_TIMEOUT_MS = 2_000;
// An org over the cap is checked at most once per TTL rather than once per
// execution, so a paid org running far past it doesn't hammer the lookup.
const EXEMPTION_CACHE_TTL_MS = 60_000;
// Sweep guard, mirroring the balance gate's cache: one long-lived isolate can
// serve many orgs.
const EXEMPTION_CACHE_MAX_ENTRIES = 10_000;
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

/** Internal sentinel for an exemption lookup that exceeded its time budget. */
class ExemptionCheckTimeoutError extends Data.TaggedError("ExemptionCheckTimeoutError")<{
  readonly timeoutMs: number;
}> {}

/**
 * Whether an organization is exempt from the cap. Production passes a paid-
 * subscription check; keeping it an opaque predicate is what lets this module
 * stay free of any billing import.
 */
export type ExecutionRateLimitExemption = (
  organizationId: string,
) => Effect.Effect<boolean, unknown>;

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
    readonly isExempt?: ExecutionRateLimitExemption;
    readonly exemptionTtlMs?: number;
  },
): ExecutionRateLimiter => {
  const limit = options?.limit ?? EXECUTIONS_PER_ORG_PER_HOUR;
  const windowMs = options?.windowMs ?? RATE_LIMIT_WINDOW_MS;
  const timeoutMs = options?.timeoutMs ?? RATE_LIMIT_CHECK_TIMEOUT_MS;
  const now = options?.now ?? Date.now;
  const isExempt = options?.isExempt;
  const exemptionTtlMs = options?.exemptionTtlMs ?? EXEMPTION_CACHE_TTL_MS;

  const exemptionCache = new Map<
    string,
    { readonly exempt: boolean; readonly expiresAtMs: number }
  >([]);

  const writeExemptionCache = (organizationId: string, exempt: boolean, nowMs: number): void => {
    if (exemptionCache.size >= EXEMPTION_CACHE_MAX_ENTRIES) {
      for (const [key, entry] of exemptionCache) {
        if (entry.expiresAtMs <= nowMs) exemptionCache.delete(key);
      }
      // Still saturated after dropping expired entries: reset rather than grow.
      if (exemptionCache.size >= EXEMPTION_CACHE_MAX_ENTRIES) exemptionCache.clear();
    }
    exemptionCache.set(organizationId, { exempt, expiresAtMs: nowMs + exemptionTtlMs });
  };

  /**
   * Resolved only for orgs already over the cap, so the lookup never touches
   * the common path.
   *
   * This is the one place that does NOT fail open. The balance gate already
   * allows executions when Autumn is unreachable; if the exemption did too,
   * an Autumn outage would switch this backstop off entirely — precisely the
   * "billing outage plus runaway automation" case it exists to cover. A stale
   * positive is honoured ahead of that fallback, so a blip can't flip a
   * known-paid org into a block mid-workload.
   */
  const resolveExemption = (organizationId: string): Effect.Effect<boolean> =>
    Effect.suspend(() => {
      if (!isExempt) return Effect.succeed(false);
      const nowMs = now();
      const cached = exemptionCache.get(organizationId);
      if (cached && cached.expiresAtMs > nowMs) return Effect.succeed(cached.exempt);
      return isExempt(organizationId).pipe(
        Effect.timeoutOrElse({
          duration: `${EXEMPTION_CHECK_TIMEOUT_MS} millis`,
          orElse: () =>
            Effect.fail(new ExemptionCheckTimeoutError({ timeoutMs: EXEMPTION_CHECK_TIMEOUT_MS })),
        }),
        Effect.map((exempt) => {
          writeExemptionCache(organizationId, exempt, nowMs);
          return exempt;
        }),
        Effect.catch((error: unknown) =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              console.warn(
                `[rate-limit] exemption lookup failed for ${organizationId}; treating as ${
                  cached ? "last known" : "not exempt"
                }:`,
                error,
              );
            });
            yield* captureCauseEffect(error);
            return cached?.exempt ?? false;
          }),
        ),
      );
    });

  const decide = (organizationId: string): Effect.Effect<GateDecision> =>
    Effect.suspend(() => {
      const windowId = Math.floor(now() / windowMs);
      return increment(organizationId, windowId).pipe(
        Effect.timeoutOrElse({
          duration: `${timeoutMs} millis`,
          orElse: () => Effect.fail(new RateLimitCheckTimeoutError({ timeoutMs })),
        }),
        Effect.flatMap((count): Effect.Effect<GateDecision> => {
          // Under the cap: no exemption lookup, no extra I/O.
          if (count <= limit) return Effect.succeed({ blocked: false });
          return Effect.gen(function* () {
            if (yield* resolveExemption(organizationId)) {
              return { blocked: false } as const satisfies GateDecision;
            }
            // The only record that the backstop fired. A blocked execution is
            // never usage-tracked (the gate short-circuits before the tracker)
            // and deliberately not sent to Sentry — a backstop stopping
            // runaway automation is expected, not exceptional — so without
            // this line a blocked org is invisible outside a bug report, which
            // is how the 2026-08-18 block went unnoticed until a customer
            // sent a screenshot.
            yield* Effect.sync(() => {
              console.warn(
                `[rate-limit] blocked execution for ${organizationId}: ${count} > ${limit} in window ${windowId}`,
              );
            });
            return {
              blocked: true,
              error: new ExecutionRateLimitExceededError({
                organizationId,
                message: RATE_LIMIT_BLOCKED_MESSAGE,
              }),
            } as const satisfies GateDecision;
          });
        }),
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
 *
 * `isExempt` decides which orgs the cap skips; production passes a paid-
 * subscription check from `execution-stack-metered.ts`.
 */
export const makeCloudExecutionRateLimiter = (
  isExempt: ExecutionRateLimitExemption,
): ExecutionRateLimiter => {
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
    { limit, isExempt },
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
