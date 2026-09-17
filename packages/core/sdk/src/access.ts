import { Context, Effect, Ref } from "effect";

import type { ToolPolicyRow } from "./core-schema";
import type { StorageFailure } from "./fuma-runtime";
import type { Owner } from "./ids";
import type { ToolPolicyProvider } from "./plugin";
import type { EffectivePolicy } from "./policies";

// ---------------------------------------------------------------------------
// Product access — the defined interface through which the PRODUCT hands the
// executor its personal/organization access decisions.
//
// Core deliberately owns no product rule here: it does not know what a role
// is, which member is an admin, or why a deployment has no role model at all.
// Core defines the decision vocabulary (this module), consults the supplied
// decisions at its enforcement sinks, and keeps enforcing the security
// invariants that are NOT product-configurable: tenant isolation and the
// storage owner policy (owner-policy.ts), which clamp whatever the product
// supplies. `ExecutorConfig.access` is required — there is no default posture
// in core, so every composition root states its product's rules explicitly.
// ---------------------------------------------------------------------------

/** Workspace-settings authorization bound to the currently executing request. */
export type OrgWriteAccess = "allowed" | "denied";

/** A single product authorization answer core enforces verbatim. */
export type AccessDecision = "allowed" | "denied";

/**
 * The target of a user-intent settings mutation, as core describes it to the
 * product's {@link ExecutorAccess.settingsWrite} rule:
 *
 * - `{ kind: "owner", owner }` — an owner-scoped settings row (a connection,
 *   tool policy, OAuth client, …) filed under that partition.
 * - `{ kind: "workspace" }` — a tenant-shared surface (the integration
 *   catalog and other whole-workspace settings).
 */
export type SettingsWriteTarget =
  | { readonly kind: "owner"; readonly owner: Owner }
  | { readonly kind: "workspace" };

/**
 * Structural view capabilities the product grants a binding. Core maps each
 * to a non-overridable mechanism:
 *
 * - `adminReads` — expose `executor.admin`, the ONLY surface whose reads are
 *   tenant-wide. The widened context is read-only by construction
 *   (owner-policy reach mechanics), regardless of what the product says.
 * - `storageWrites` — `"denied"` makes the WHOLE executor read-only at the
 *   storage boundary (every create/update/delete on every guarded table is
 *   refused, and catalog re-sync is skipped). The platform observer posture
 *   combines both.
 */
export interface ExecutorAccessCapabilities {
  readonly adminReads: boolean;
  readonly storageWrites: AccessDecision;
}

/** One effective-policy question, as core asks the product's evaluator. */
export interface ToolPolicyEvaluationInput {
  /** Normalized policy id: a static tool's address, or the 4-segment
   *  `<integration>.<owner>.<connection>.<tool>` form. */
  readonly toolId: string;
  /** The tool's own `requiresApproval` annotation — the fallback material a
   *  product resolution may lift when no authored rule matches. */
  readonly defaultRequiresApproval?: boolean | undefined;
}

/**
 * A per-operation effective-policy evaluator returned by
 * {@link ExecutorAccess.toolPolicy}. Built once per surface operation (one
 * tools list / schema read / invocation / post-approval recheck) so a product
 * implementation can batch its underlying reads; `resolve` is then asked once
 * per tool. Core ENFORCES whatever comes back — `block` refuses the call,
 * `require_approval` gates it behind an elicitation — but never decides it.
 */
export interface ToolPolicyEvaluator {
  readonly resolve: (
    input: ToolPolicyEvaluationInput,
  ) => Effect.Effect<EffectivePolicy, StorageFailure>;
}

/**
 * The rule material core hands the product's {@link ExecutorAccess.toolPolicy}
 * hook for one operation. Both members are the product's to consult or
 * ignore; core pre-selects nothing.
 */
export interface ToolPolicySources {
  /**
   * The stored, owner-scoped `tool_policy` rows visible to this binding —
   * a LAZY effect, fetched only if the product's resolution reads it.
   */
  readonly policyRows: Effect.Effect<readonly ToolPolicyRow[], StorageFailure>;
  /**
   * The plugin-registered policy provider, when a plugin opted this executor
   * instance into a session rule source (a toolkit's capability set), else
   * null. Toolkit sessions also hide catalog entries that grant no tools;
   * that presentation follows the provider's presence (part of the
   * `ToolPolicyProvider` plugin contract), while HOW its rules resolve —
   * including the empty-match default — is decided here, by the product.
   */
  readonly provider: ToolPolicyProvider | null;
}

/**
 * Product-owned access decisions for one executor binding. Supplied by the
 * host's composition root (see `@executor-js/product-access` for the product
 * rule implementations); enforced — never decided — by core.
 *
 * Shape invariants, validated at `createExecutor` (violations fail the boot):
 * - `owners` is a non-empty, duplicate-free subset of `["user", "org"]`;
 * - `"user"` may appear only when the executor binds a subject.
 *
 * Core's non-overridable clamps apply to every decision: the tenant clause
 * is never relaxed, user rows only ever resolve to the bound subject,
 * tenant-reach contexts are read-only (or delete-only, for the internal
 * removal cascade), and a mid-run tool is never interrupted by a policy
 * change — `block` means "don't start new runs".
 *
 * PAUSED EXECUTIONS: a pause/resume boundary re-evaluates the
 * request-bound `settingsWrite` decision as the RESUMING principal (via
 * {@link CurrentOrgWriteAccess}), and the post-approval recheck re-resolves
 * the tool policy and re-reads rows — but storage reads and credential
 * resolution still run under the STARTER's binding, whose executor instance
 * owns the paused fiber.
 */
export interface ExecutorAccess {
  /**
   * ROW VISIBILITY AND WRITE AUTHORIZATION: the owner partitions this
   * binding sees and may write, in precedence order (the first entry shadows
   * later ones on plugin-storage reads, ranks first in policy listings, and
   * is the partition static tools present under). Carried onto every storage
   * context: reads, updates and deletes are FILTERED to these partitions and
   * creates outside them are refused — an org-only or personal-only product
   * view really is one, across storage CRUD and the tool surfaces built on
   * it. Core contributes no partition of its own.
   */
  readonly owners: readonly Owner[];
  /**
   * USER-INTENT SETTINGS AUTHORIZATION, including the owner-target rule.
   * Consulted live at every guarded sink (never cached by core, so a
   * request-bound implementation is re-read after pauses and on resume);
   * `"denied"` surfaces as `OrgWriteDeniedError`. Operational writes a
   * denied member's usage implies (token refresh, catalog re-sync) do not
   * pass through this gate — they are bounded by `owners` and the storage
   * clamps instead.
   */
  readonly settingsWrite: (target: SettingsWriteTarget) => Effect.Effect<AccessDecision>;
  /** View capabilities — see {@link ExecutorAccessCapabilities}. */
  readonly capabilities: ExecutorAccessCapabilities;
  /**
   * EFFECTIVE TOOL-POLICY EVALUATION. Called once per surface operation with
   * this binding's rule material; the returned evaluator answers every
   * per-tool question in that operation. Owner ranking, cross-owner merging,
   * plugin-default fallback and the capability-allowlist default all live in
   * the product implementation.
   */
  readonly toolPolicy: (
    sources: ToolPolicySources,
  ) => Effect.Effect<ToolPolicyEvaluator, StorageFailure>;
}

/**
 * Validate an {@link ExecutorAccess} against the executor's `{ tenant,
 * subject }` binding. Returns null when well-formed; a violation is a
 * programmer error at a composition root and fails fast via the returned
 * message so `createExecutor` can surface it as a startup failure.
 */
export const executorAccessViolation = (
  access: ExecutorAccess,
  subject: string | null,
): string | null => {
  const owners = access.owners;
  if (owners.length === 0) return "ExecutorAccess.owners must not be empty.";
  if (new Set(owners).size !== owners.length) {
    return "ExecutorAccess.owners must not repeat an owner.";
  }
  if (owners.includes("user") && subject == null) {
    return 'ExecutorAccess.owners includes "user" but the executor has no subject.';
  }
  return null;
};

/**
 * Fiber-local workspace-settings authorization for request-bound executors.
 *
 * This is the decision CARRIER, not a decision rule: a session host stamps it
 * from each freshly authenticated request, the execution engine snapshots the
 * state onto a paused execution and re-stamps `current` from the resuming (or
 * joining) principal's fiber, and a request-bound `ExecutorAccess`
 * implementation reads it at every guarded sink. The denied default makes a
 * missing request binding fail closed. Executors whose product supplies a
 * static decision never consult this reference.
 */
export interface OrgWriteAccessState {
  /** Mutable value inherited by a detached execution and refreshed on resume. */
  readonly current: Ref.Ref<OrgWriteAccess>;
}

/** Create an isolated request/execution authorization state. */
export const makeOrgWriteAccessState = (access: OrgWriteAccess): OrgWriteAccessState => ({
  current: Ref.makeUnsafe(access),
});

/** Request-local workspace-write authorization inherited by child fibers. */
export const CurrentOrgWriteAccess = Context.Reference<OrgWriteAccessState>(
  "@executor-js/sdk/CurrentOrgWriteAccess",
  { defaultValue: () => makeOrgWriteAccessState("denied") },
);

/** Read the effective authorization at a workspace-write sink. */
export const currentOrgWriteAccess: Effect.Effect<OrgWriteAccess> = Effect.gen(function* () {
  const state = yield* CurrentOrgWriteAccess;
  return yield* Ref.get(state.current);
});
