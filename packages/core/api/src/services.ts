import { Context, type Effect } from "effect";
import type * as Cause from "effect/Cause";
import type { Executor } from "@executor-js/sdk";
import type { ExecutionEngine } from "@executor-js/execution";

export class ExecutorService extends Context.Service<ExecutorService, Executor>()(
  "ExecutorService",
) {}

/** A user-meaningful artifact operation on the HTTP plane — the console UI's
 *  data layer. `viewed` is the detail read (`get`), not `list`; `updated`
 *  covers both save-overwrite and rename; `setPreview` is a render side
 *  effect, not a user action, and deliberately absent. */
export type ArtifactUsageAction = "created" | "viewed" | "updated" | "deleted";

/**
 * Optional observer for artifact operations served by the artifacts HTTP
 * handlers. A `Context.Reference` (default null) rather than a required
 * service: hosts that record product analytics provide one at boot; every
 * other host — and every test — composes unchanged. Observers are best-effort:
 * the handlers swallow their failures.
 */
export const ArtifactUsageObserver = Context.Reference<
  ((action: ArtifactUsageAction) => Effect.Effect<void>) | null
>("@executor-js/api/ArtifactUsageObserver", { defaultValue: () => null });

// Error channel widened to `Cause.YieldableError` so callers that plug
// in a runtime-specific tagged error (e.g.
// `ExecutionEngine<DynamicWorkerExecutionError>`) assign structurally.
// Handlers yield directly; defects flow through `Effect.catchAllCause`
// at the edge.
export class ExecutionEngineService extends Context.Service<
  ExecutionEngineService,
  ExecutionEngine<Cause.YieldableError>
>()("ExecutionEngineService") {}
