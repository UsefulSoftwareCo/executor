import {
  OrganizationForbidden,
  OrganizationId,
  OrganizationReference,
  RequireOrganization,
} from "@executor-js/hosted-server/organization";
import { ApiError } from "@executor-js/utils/api-error";
import { Context, Effect, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { RequireUser } from "@executor-js/hosted-server";

/** The cloud projection of Autumn's catalog. Prices come from the selected provider catalog. */
export const BillingPlan = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.String,
  purchase: Schema.Literals(["checkout", "contact"]),
  price: Schema.NullOr(
    Schema.Struct({
      amount: Schema.Number,
      interval: Schema.String,
      unit: Schema.NullOr(Schema.Literal("member")),
    }),
  ),
  /** Members the plan allows: a fixed number, or any number (unlimited or billed per member). */
  members: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  /** Whether the plan includes verified domains, which let people join by email domain. */
  domainVerification: Schema.Boolean,
  /** A free trial new subscribers start with, if the plan offers one. */
  trial: Schema.NullOr(Schema.Struct({ days: Schema.Int, cardRequired: Schema.Boolean })),
});
/** Current subscription state, never inferred from a checkout redirect. */
export const BillingOverview = Schema.Struct({
  enterprise: Schema.Boolean,
  plans: Schema.Array(BillingPlan),
  subscriptions: Schema.Array(Schema.Struct({ planId: Schema.String, status: Schema.String })),
});
/**
 * The member limit invitations are checked against. Null means the plan has no
 * limit. Accepted members count toward it; pending invitations do not.
 */
export const MemberLimit = Schema.Struct({
  limit: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
});
/** Autumn could not complete the request. No provider secrets or raw errors are exposed. */
export const BillingUnavailable = ApiError.define({
  tag: "BillingUnavailable",
  status: 503,
  message: "Executor could not reach its billing service. Try again.",
});
export type BillingUnavailable = typeof BillingUnavailable.Type;
/** The requested plan is not in the available catalog. */
export const BillingPlanUnavailable = ApiError.define({
  tag: "BillingPlanUnavailable",
  status: 400,
  message: "The requested plan is not available.",
});
export type BillingPlanUnavailable = typeof BillingPlanUnavailable.Type;
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
    HttpApiEndpoint.get("memberLimit", "/api/organizations/:organization/billing/member-limit", {
      params: { organization: OrganizationReference },
      success: MemberLimit,
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
