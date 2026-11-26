import { Context, Effect, Schema } from "effect";
import { ApiError } from "@executor-js/utils/api-error";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { StorageError, AppWorkflowsActive, AccountWorkflowsActive } from "@executor-js/sdk/core";
import { AuthenticationUnavailable, BrowserSessionOnly, Forbidden } from "./auth.ts";
import {
  OrganizationForbidden,
  OrganizationId,
  OrganizationReference,
  RequireOrganization,
} from "./organization.ts";

export const OrganizationRemoved = Schema.Struct({
  organization: OrganizationId,
  apps: Schema.Int,
  accounts: Schema.Int,
});
export type OrganizationRemoved = typeof OrganizationRemoved.Type;

export const OrganizationRemovalUnavailable = ApiError.define({
  tag: "OrganizationRemovalUnavailable",
  status: 503,
  message: "Executor could not start or read the organization's removal. Try again.",
});
export type OrganizationRemovalUnavailable = typeof OrganizationRemovalUnavailable.Type;

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

export class OrganizationRemovalFailed extends Schema.TaggedError<OrganizationRemovalFailed>()(
  "OrganizationRemovalFailed",
  { organization: Schema.String, step: OrganizationRemovalStepName },
) {
  override get message() {
    return `Organization ${this.organization} removal failed at step ${this.step}`;
  }
}

export interface OrganizationRemovalRetries {
  readonly limit: number;
  readonly delay: string;
  readonly backoff: "constant" | "linear" | "exponential";
}

export interface OrganizationRemovalStepRunner<R = never> {
  <A>(
    name: OrganizationRemovalStepName,
    retries: OrganizationRemovalRetries,
    work: Effect.Effect<A, unknown>,
  ): Effect.Effect<A, OrganizationRemovalFailed, R>;
}

export const OrganizationRemovalRecord = Schema.Struct({
  organization: OrganizationId,
  instance: Schema.NonEmptyString,
  status: Schema.Literals(["running", "done"]),
  logo: Schema.NullOr(Schema.String),
});
export type OrganizationRemovalRecord = typeof OrganizationRemovalRecord.Type;

export class OrganizationTombstones extends Context.Service<
  OrganizationTombstones,
  (organization: OrganizationId) => Effect.Effect<boolean, OrganizationRemovalUnavailable>
>()("hosted/OrganizationTombstones") {}

export class OrganizationRemovals extends Context.Service<
  OrganizationRemovals,
  {
    readonly begin: (
      organization: OrganizationId,
      instance: string,
    ) => Effect.Effect<OrganizationRemovalRecord, OrganizationRemovalUnavailable>;
    readonly read: (
      organization: OrganizationId,
    ) => Effect.Effect<OrganizationRemovalRecord | null, OrganizationRemovalUnavailable>;
    readonly recordLogo: (
      organization: OrganizationId,
      logo: string | null,
    ) => Effect.Effect<void, OrganizationRemovalUnavailable>;
    readonly finish: (
      organization: OrganizationId,
    ) => Effect.Effect<void, OrganizationRemovalUnavailable>;
  }
>()("hosted/OrganizationRemovals") {}

export const OrganizationBilling = Context.Reference<{
  readonly cancel: (organization: OrganizationId) => Effect.Effect<void, unknown>;
}>("hosted/OrganizationBilling", { defaultValue: () => ({ cancel: () => Effect.void }) });

export const HostedOrganizationRemoval = HttpApiGroup.make("organizationRemoval")
  .add(
    HttpApiEndpoint.get("preview", "/api/organizations/:organization/removal", {
      params: { organization: OrganizationReference },
      success: OrganizationRemoved,
      error: [OrganizationForbidden, AuthenticationUnavailable, StorageError],
    }).annotate(
      OpenApi.Description,
      "Count everything organization removal will delete, including private resources. Requires the owner role. Returns counts without exposing resource names or credentials.",
    ),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/api/organizations/:organization", {
      params: { organization: OrganizationReference },
      success: OrganizationRemoved,
      error: [
        OrganizationForbidden,
        Forbidden,
        AuthenticationUnavailable,
        OrganizationRemovalUnavailable,
        StorageError,
        AppWorkflowsActive,
        AccountWorkflowsActive,
      ],
    })
      .annotate(BrowserSessionOnly, true)
      .annotate(
        OpenApi.Description,
        "Delete an organization with every app, account, credential, version and MCP grant it owns. Requires the owner role and a browser session; API keys and OAuth tokens are refused. The request refuses while a workflow or a pinned account is still in flight; otherwise the organization becomes unreachable immediately and a durable workflow completes the erasure.",
      ),
  )
  .middleware(RequireOrganization);
