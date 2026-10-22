import { Context, type Effect } from "effect";
import type * as Cause from "effect/Cause";
import type { DelegationBinding, Executor } from "@executor-js/sdk";
import type { ExecutionEngine, ExecutionResult } from "@executor-js/execution";

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

/**
 * Host seam for the durable approval fallback. A request that contains the
 * human approver's session has an ordinary execution engine, so it cannot
 * safely re-run a recorded delegated call itself. Hosts that support durable
 * delegated approvals provide this optional callback; it resolves the exact
 * binding against durable state, rebuilds the original scoped executor and
 * engine, and records the approver independently from the machine actor.
 *
 * The reference is optional to preserve existing hosts. If it is absent, a
 * delegated pending approval fails closed instead of falling back to the
 * approver's unrestricted engine.
 */
export interface DelegatedExecutionApprover {
  readonly kind: "member" | "delegated";
  readonly accountId: string | null;
  readonly organizationId: string;
  /** The live role set from the authenticated request. Hosts must re-check
   * membership; this is an input to the host resumer, never grant evidence. */
  readonly roles?: readonly string[];
  /** Human account id is the approver identity; machine actor is retained on
   * the binding and must never be replaced by this field. */
  readonly actorSubject?: string;
}

export interface DelegatedExecutionResumer {
  /** Check the target/admin human and resolve the exact binding before the
   * one-shot pending record is consumed. */
  readonly authorize: (input: {
    readonly binding: DelegationBinding;
    readonly executionId: string;
    readonly approver: DelegatedExecutionApprover;
  }) => Effect.Effect<boolean, Cause.YieldableError>;
  readonly resume: (input: {
    readonly code: string;
    readonly binding: DelegationBinding;
    readonly executionId: string;
    readonly approver: DelegatedExecutionApprover;
  }) => Effect.Effect<ExecutionResult | null, Cause.YieldableError>;
}

export const DelegatedExecutionResumer = Context.Reference<DelegatedExecutionResumer | null>(
  "@executor-js/api/DelegatedExecutionResumer",
  { defaultValue: () => null },
);
