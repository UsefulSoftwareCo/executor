import {
  OrganizationForbidden,
  OrganizationId,
  OrganizationReference,
  RequireOrganization,
} from "@executor-js/hosted-server/organization";
import { ApiError } from "@executor-js/utils/api-error";
import { Context, Effect, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

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
  members: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  domainVerification: Schema.Boolean,
  trial: Schema.NullOr(Schema.Struct({ days: Schema.Int, cardRequired: Schema.Boolean })),
});
export const BillingOverview = Schema.Struct({
  enterprise: Schema.Boolean,
  plans: Schema.Array(BillingPlan),
  subscriptions: Schema.Array(Schema.Struct({ planId: Schema.String, status: Schema.String })),
});
export const MemberLimit = Schema.Struct({
  limit: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
});
export const BillingUnavailable = ApiError.define({
  tag: "BillingUnavailable",
  status: 503,
  message: "Executor could not reach its billing service. Try again.",
});
export type BillingUnavailable = typeof BillingUnavailable.Type;
export const BillingPlanUnavailable = ApiError.define({
  tag: "BillingPlanUnavailable",
  status: 400,
  message: "The requested plan is not available.",
});
export type BillingPlanUnavailable = typeof BillingPlanUnavailable.Type;
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
    readonly cancel: (
      organization: OrganizationId,
    ) => Effect.Effect<
      { readonly customerId: string; readonly cancelled: ReadonlyArray<string> },
      BillingUnavailable
    >;
  }
>()("cloud/Billing") {}

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
  .middleware(RequireOrganization);
