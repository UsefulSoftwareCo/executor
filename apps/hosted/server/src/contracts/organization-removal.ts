/** Removing an organization is a separate capability; a host composes it only where it applies. */
import { Context, Effect, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { StorageError, AppWorkflowsActive, AccountWorkflowsActive } from "@executor-js/sdk/core";
import { AuthenticationUnavailable } from "./auth.ts";
import {
  OrganizationForbidden,
  OrganizationId,
  OrganizationReference,
  RequireOrganization,
} from "./organization.ts";

/** What the organization held when removal started, so the browser can report a real result. */
export const OrganizationRemoved = Schema.Struct({
  organization: OrganizationId,
  apps: Schema.Int,
  accounts: Schema.Int,
});
export type OrganizationRemoved = typeof OrganizationRemoved.Type;

/** The tombstone store is unreachable, so removal can neither start nor be hidden safely. */
export class OrganizationRemovalUnavailable extends Schema.TaggedError<OrganizationRemovalUnavailable>()(
  "OrganizationRemovalUnavailable",
  {},
  { httpApiStatus: 503 },
) {}

/**
 * The ordered durable steps. Each name is the step identity in the engine's
 * journal, so renaming one abandons the recorded progress of every run in
 * flight. Names are also what failure reports carry.
 */
export const OrganizationRemovalStepName = Schema.Literals([
  "unregister-webhooks",
  "purge-owner-store",
  "delete-auth-records",
  "resweep-owner-store",
  "cancel-billing",
  "release-icon",
  "finish",
]);
export type OrganizationRemovalStepName = typeof OrganizationRemovalStepName.Type;

/**
 * A step that exhausted its retries. The organization and step name are the
 * two facts an operator needs to finish the removal by hand, so both travel
 * with the failure rather than only appearing in a log line.
 */
export class OrganizationRemovalFailed extends Schema.TaggedError<OrganizationRemovalFailed>()(
  "OrganizationRemovalFailed",
  { organization: Schema.String, step: OrganizationRemovalStepName },
) {
  override get message() {
    return `Organization ${this.organization} removal failed at step ${this.step}`;
  }
}

/** Retry policy for one durable step, in the shape both engines accept. */
export interface OrganizationRemovalRetries {
  readonly limit: number;
  readonly delay: string;
  readonly backoff: "constant" | "linear" | "exponential";
}

/**
 * One durable step. The runner owns journaling and retries; the body must be
 * idempotent, because at-least-once delivery replays a step whose result was
 * never recorded. A test substitutes a recorder for the engine here.
 */
export interface OrganizationRemovalStepRunner<R = never> {
  <A>(
    name: OrganizationRemovalStepName,
    retries: OrganizationRemovalRetries,
    work: Effect.Effect<A, unknown>,
  ): Effect.Effect<A, OrganizationRemovalFailed, R>;
}

/** A removal in flight, or one that has finished and is retained as its record. */
export const OrganizationRemovalRecord = Schema.Struct({
  organization: OrganizationId,
  instance: Schema.NonEmptyString,
  status: Schema.Literals(["running", "done"]),
  logo: Schema.NullOr(Schema.String),
});
export type OrganizationRemovalRecord = typeof OrganizationRemovalRecord.Type;

/**
 * The tombstone read consulted by organization middleware. A host with no
 * removal capability inherits the default, which reports every organization
 * as live; that is a fact about self-host, not a branch on its environment.
 */
export const OrganizationTombstones = Context.Reference<
  (organization: OrganizationId) => Effect.Effect<boolean, OrganizationRemovalUnavailable>
>("hosted/OrganizationTombstones", { defaultValue: () => () => Effect.succeed(false) });

/** The write side, provided only by a host that composes organization removal. */
export class OrganizationRemovals extends Context.Service<
  OrganizationRemovals,
  {
    /** Record the tombstone and claim the instance id. Repeating returns the existing record. */
    readonly begin: (
      organization: OrganizationId,
      instance: string,
    ) => Effect.Effect<OrganizationRemovalRecord, OrganizationRemovalUnavailable>;
    readonly read: (
      organization: OrganizationId,
    ) => Effect.Effect<OrganizationRemovalRecord | null, OrganizationRemovalUnavailable>;
    /** Retain the removed organization's saved icon so a replayed step can still release it. */
    readonly recordLogo: (
      organization: OrganizationId,
      logo: string | null,
    ) => Effect.Effect<void, OrganizationRemovalUnavailable>;
    readonly finish: (
      organization: OrganizationId,
    ) => Effect.Effect<void, OrganizationRemovalUnavailable>;
  }
>()("hosted/OrganizationRemovals") {}

/**
 * Cancelling paid subscriptions for an organization that is going away. The
 * default does nothing, which is correct for a host with no billing service;
 * cloud provides one backed by its billing provider.
 */
export const OrganizationBilling = Context.Reference<{
  readonly cancel: (organization: OrganizationId) => Effect.Effect<void, unknown>;
}>("hosted/OrganizationBilling", { defaultValue: () => ({ cancel: () => Effect.void }) });

/** Owner-only and irreversible: the request refuses or commits, then a workflow finishes it. */
export const HostedOrganizationRemoval = HttpApiGroup.make("organizationRemoval")
  .add(
    HttpApiEndpoint.delete("remove", "/api/organizations/:organization", {
      params: { organization: OrganizationReference },
      success: OrganizationRemoved,
      error: [
        OrganizationForbidden,
        AuthenticationUnavailable,
        OrganizationRemovalUnavailable,
        StorageError,
        AppWorkflowsActive,
        AccountWorkflowsActive,
      ],
    }).annotate(
      OpenApi.Description,
      "Delete an organization with every app, account, credential, deployment and MCP grant it owns. Requires the owner role. The request refuses while a workflow or a pinned account is still in flight; otherwise the organization becomes unreachable immediately and a durable workflow completes the erasure.",
    ),
  )
  .middleware(RequireOrganization);
