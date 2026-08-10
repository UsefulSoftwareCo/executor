// ---------------------------------------------------------------------------
// AuthorizationProvider — optional universal authorization seam.
//
// When absent, execute keeps exact current behavior (coarse tool_policy block /
// require_approval + annotations). When present, core consults the provider
// after hard-block resolution and before credential resolution / plugin invoke.
// Nested `ctx.execute` re-enters the same path.
//
// Identity is the executor's bound (tenant, subject) — never caller-supplied
// args. Domain policy semantics and persistence live outside this contract.
// ---------------------------------------------------------------------------

import type { Effect } from "effect";

import type { Subject, Tenant, ToolAddress } from "./ids";
import type { EffectivePolicy } from "./policies";

/** The only operation this seam authorizes today. */
export type AuthorizationOperation = "tool.execute";

/** Trusted executor identity. Built by core from the bound owner, not from args. */
export interface AuthorizationIdentity {
  readonly tenant: Tenant;
  readonly subject: Subject | null;
}

/**
 * Tool address plus routing metadata the provider needs without re-parsing.
 * Static tools still surface owner/connection as the executor projects them.
 */
export interface AuthorizationToolRef {
  readonly address: ToolAddress;
  readonly integration: string;
  readonly owner: string;
  readonly connection: string;
  readonly plugin: string;
  readonly name: string;
}

export interface AuthorizationRequest {
  readonly identity: AuthorizationIdentity;
  readonly operation: AuthorizationOperation;
  readonly tool: AuthorizationToolRef;
  /** Raw invoke args. Caller-controlled; never a source of identity. */
  readonly args: unknown;
  /** Coarse EffectivePolicy already resolved by core for this call. */
  readonly policy: EffectivePolicy;
}

export type AuthorizationOutcome = "allow" | "deny" | "require_approval";

export interface AuthorizationDecision {
  readonly outcome: AuthorizationOutcome;
  readonly decisionId: string;
  readonly policyRevision: string;
  readonly reason: string;
  /** Opaque host/provider metadata; core does not interpret obligations. */
  readonly obligations?: Readonly<Record<string, unknown>>;
}

/**
 * Host- or product-supplied authorizer. Failures (Effect failure channel) are
 * fail-closed by core as `AuthorizationProviderError`.
 */
export interface AuthorizationProvider {
  readonly authorize: (
    request: AuthorizationRequest,
  ) => Effect.Effect<AuthorizationDecision, unknown>;
}
