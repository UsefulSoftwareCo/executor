// ---------------------------------------------------------------------------
// Pre-execution balance gate — blocks new executions once an organization has
// used up its plan's included executions.
//
// Usage is tracked to Autumn after every execution (execution-usage.ts), but
// nothing ever CHECKED the balance before running, so a free-tier org could run
// unbounded executions past its quota. This gate consults
// `AutumnService.checkExecutionBalance` before `execute` / `executeWithPause`.
// `resume` is never gated: a paused execution already consumed its quota slot
// when it started, and blocking resume would strand approved work forever.
//
// FAIL OPEN is a hard requirement: any Autumn error, timeout, or missing
// customer/feature allows the execution (logged + Sentry, mirroring
// `trackExecution`'s reporting). Autumn being down must never block
// executions or add meaningful latency, so the check is bounded by a short
// timeout and its outcome is cached per organization.
//
// Error surfacing: the gate fails internally with the typed
// `ExecutionLimitReachedError`, and the engine seam folds it into the
// descriptive `ExecuteResult.error` channel. That is the codebase's mechanism
// for getting a domain failure's message to the MCP client verbatim — engine
// error-channel failures are deliberately rendered opaque by the MCP host
// ("Internal tool error [correlation id]"), exactly like the runtimes fold
// `CodeCompilationError` / `SandboxRuntimeError` into `ExecuteResult.error`.
// ---------------------------------------------------------------------------

import { Data, Effect } from "effect";
import type * as Cause from "effect/Cause";

import type { ExecutionEngine, ExecutionResult } from "@executor-js/execution";

import { captureCauseEffect } from "../observability";
import { EXECUTION_LIMIT_BLOCKED_MESSAGE } from "./execution-limit-messages";

// The engine's completed-result payload (`ExecuteResult` in codemode-core),
// derived from the public execution types so this app package doesn't need a
// direct dependency on the kernel package that declares it.
type EngineExecuteResult = Extract<ExecutionResult, { status: "completed" }>["result"];

// One check per org per minute is fresh enough for a monthly quota; both
// allowed AND blocked outcomes are cached (errors never are).
const BALANCE_CACHE_TTL_MS = 60_000;
// Autumn slower than this => fail open rather than stall a user-facing
// execution behind the billing provider.
const BALANCE_CHECK_TIMEOUT_MS = 2_000;
// Sweep guard so a long-lived worker isolate serving many orgs can't grow the
// cache map unbounded.
const BALANCE_CACHE_MAX_ENTRIES = 10_000;

export { EXECUTION_LIMIT_BLOCKED_MESSAGE };

export class ExecutionLimitReachedError extends Data.TaggedError("ExecutionLimitReachedError")<{
  readonly organizationId: string;
  readonly message: string;
}> {}

/** Internal sentinel for a balance check that exceeded its time budget. */
class GateCheckTimeoutError extends Data.TaggedError("GateCheckTimeoutError")<{
  readonly timeoutMs: number;
}> {}

// ---------------------------------------------------------------------------
// Shared gate seam — used by this gate and the rate-limit backstop.
// ---------------------------------------------------------------------------

export type GateDecision =
  | { readonly blocked: false }
  | { readonly blocked: true; readonly error: { readonly message: string } };

/**
 * Wrap an engine so `decide` runs before `execute` / `executeWithPause`. A
 * blocked decision short-circuits to a descriptive `ExecuteResult.error`
 * (which `formatExecuteResult` renders as a clean `isError` MCP tool result)
 * WITHOUT invoking the inner engine — so a blocked execution is neither run
 * nor usage-tracked. `resume` and all read-only members pass through
 * untouched: paused executions must always be able to complete.
 */
export const withPreExecutionGate = <E extends Cause.YieldableError>(
  engine: ExecutionEngine<E>,
  decide: Effect.Effect<GateDecision>,
): ExecutionEngine<E> => ({
  execute: (code, options) =>
    Effect.flatMap(
      decide,
      (decision): Effect.Effect<EngineExecuteResult, E> =>
        decision.blocked
          ? Effect.succeed({ result: null, error: decision.error.message })
          : engine.execute(code, options),
    ),
  executeWithPause: (code, options) =>
    Effect.flatMap(
      decide,
      (decision): Effect.Effect<ExecutionResult, E> =>
        decision.blocked
          ? Effect.succeed({
              status: "completed",
              result: { result: null, error: decision.error.message },
            })
          : engine.executeWithPause(code, options),
    ),
  // resume is never gated: paused executions must be able to complete.
  resume: (executionId, response) => engine.resume(executionId, response),
  getPausedExecution: (executionId) => engine.getPausedExecution(executionId),
  pausedExecutionCount: () => engine.pausedExecutionCount(),
  hasPausedExecutions: () => engine.hasPausedExecutions(),
  getDescription: engine.getDescription,
});

// ---------------------------------------------------------------------------
// Balance gate factory
// ---------------------------------------------------------------------------

export type ExecutionBalanceCheck = (
  organizationId: string,
) => Effect.Effect<{ readonly allowed: boolean }, unknown>;

/**
 * Build a balance gate around `checkBalance` (in production:
 * `AutumnService.checkExecutionBalance`). One gate instance holds one
 * per-organization outcome cache; the metered decorator layer creates a single
 * instance so all engines it decorates share it.
 */
export const makeExecutionLimitGate = (checkBalance: ExecutionBalanceCheck) => {
  const timeoutMs = BALANCE_CHECK_TIMEOUT_MS;
  const cache = new Map<string, { readonly allowed: boolean; readonly expiresAtMs: number }>();

  const writeCache = (organizationId: string, allowed: boolean, nowMs: number): void => {
    if (cache.size >= BALANCE_CACHE_MAX_ENTRIES) {
      for (const [key, entry] of cache) {
        if (entry.expiresAtMs <= nowMs) cache.delete(key);
      }
      // Still saturated after dropping expired entries: reset rather than grow.
      if (cache.size >= BALANCE_CACHE_MAX_ENTRIES) cache.clear();
    }
    cache.set(organizationId, { allowed, expiresAtMs: nowMs + BALANCE_CACHE_TTL_MS });
  };

  const toDecision = (organizationId: string, allowed: boolean): GateDecision =>
    allowed
      ? { blocked: false }
      : {
          blocked: true,
          error: new ExecutionLimitReachedError({
            organizationId,
            message: EXECUTION_LIMIT_BLOCKED_MESSAGE,
          }),
        };

  const decide = (organizationId: string): Effect.Effect<GateDecision> =>
    Effect.suspend(() => {
      const nowMs = Date.now();
      const cached = cache.get(organizationId);
      if (cached && cached.expiresAtMs > nowMs) {
        return Effect.succeed(toDecision(organizationId, cached.allowed));
      }
      return checkBalance(organizationId).pipe(
        Effect.timeoutOrElse({
          duration: `${timeoutMs} millis`,
          orElse: () => Effect.fail(new GateCheckTimeoutError({ timeoutMs })),
        }),
        Effect.map(({ allowed }) => {
          writeCache(organizationId, allowed, nowMs);
          return toDecision(organizationId, allowed);
        }),
        // FAIL OPEN: Autumn errors, timeouts, and missing customers/features
        // must never block executions. Reported like `trackExecution` so a
        // billing outage still pages; the error outcome is never cached.
        Effect.catch((error: unknown) =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              console.warn("[billing] execution balance check failed open:", error);
            });
            yield* captureCauseEffect(error);
            return { blocked: false } as const satisfies GateDecision;
          }),
        ),
      );
    });

  return {
    /** Wrap an engine so the balance gate runs before each new execution. */
    decorate: <E extends Cause.YieldableError>(
      organizationId: string,
      engine: ExecutionEngine<E>,
    ): ExecutionEngine<E> => withPreExecutionGate(engine, decide(organizationId)),
  };
};
