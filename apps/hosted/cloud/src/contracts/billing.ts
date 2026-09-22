import {
  OrganizationForbidden,
  OrganizationId,
  OrganizationReference,
  RequireOrganization,
} from "@executor-js/hosted-server/organization";
import { Context, Effect, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { RequireUser } from "@executor-js/hosted-server";

/** The cloud projection of Autumn's catalog. Prices come from the selected provider catalog. */
export const BillingPlan = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.String,
  price: Schema.NullOr(
    Schema.Struct({
      amount: Schema.Number,
      interval: Schema.String,
      unit: Schema.NullOr(Schema.Literal("member")),
    }),
  ),
});
/** Current subscription state, never inferred from a checkout redirect. */
export const BillingOverview = Schema.Struct({
  usage: Schema.NullOr(
    Schema.Struct({ used: Schema.Number, remaining: Schema.Number, unlimited: Schema.Boolean }),
  ),
  plans: Schema.Array(BillingPlan),
  subscriptions: Schema.Array(Schema.Struct({ planId: Schema.String, status: Schema.String })),
});
/** Autumn could not complete the request. No provider secrets or raw errors are exposed. */
export class BillingUnavailable extends Schema.TaggedError<BillingUnavailable>()(
  "BillingUnavailable",
  {},
  { httpApiStatus: 503 },
) {}
/** The requested plan is not in the available catalog. */
export class BillingPlanUnavailable extends Schema.TaggedError<BillingPlanUnavailable>()(
  "BillingPlanUnavailable",
  {},
  { httpApiStatus: 400 },
) {}
/** Cloud-only billing operations, with the authorized organization as customer identity. */
export class Billing extends Context.Service<
  Billing,
  {
    readonly overview: (
      organization: OrganizationId,
    ) => Effect.Effect<typeof BillingOverview.Type, BillingUnavailable>;
    readonly checkout: (
      organization: OrganizationId,
      plan: string,
      returnUrl: URL,
    ) => Effect.Effect<
      { readonly url: string | null },
      BillingUnavailable | BillingPlanUnavailable
    >;
    readonly portal: (
      organization: OrganizationId,
      returnUrl: URL,
    ) => Effect.Effect<{ readonly url: string }, BillingUnavailable>;
    /**
     * Cancel every paid subscription this organization still holds, for use when
     * the organization itself is being removed. Deletion also destroys the
     * customer portal's own authorization, so nobody can cancel afterwards.
     * Reports the customer identity so a caller can record an orphan it failed
     * to cancel.
     */
    readonly cancel: (
      organization: OrganizationId,
    ) => Effect.Effect<
      { readonly customerId: string; readonly cancelled: ReadonlyArray<string> },
      BillingUnavailable
    >;
  }
>()("cloud/Billing") {}

/** Billing is deliberately absent from the shared and self-hosted API. */
export const billingGroup = HttpApiGroup.make("billing")
  .add(
    HttpApiEndpoint.get("overview", "/api/organizations/:organization/billing", {
      params: { organization: OrganizationReference },
      success: BillingOverview,
      error: [BillingUnavailable, OrganizationForbidden],
    }),
  )
  .add(
    HttpApiEndpoint.post("checkout", "/api/organizations/:organization/billing/checkout", {
      params: { organization: OrganizationReference },
      payload: Schema.Struct({ plan: Schema.NonEmptyString }),
      success: Schema.Struct({ url: Schema.NullOr(Schema.String) }),
      error: [BillingUnavailable, BillingPlanUnavailable, OrganizationForbidden],
    }),
  )
  .add(
    HttpApiEndpoint.post("portal", "/api/organizations/:organization/billing/portal", {
      params: { organization: OrganizationReference },
      success: Schema.Struct({ url: Schema.String }),
      error: [BillingUnavailable, OrganizationForbidden],
    }),
  )
  .middleware(RequireOrganization)
  .middleware(RequireUser);
