import { Context, Effect } from "effect";
import type { OrganizationId } from "@executor-js/hosted-server";
import { BillingUnavailable } from "./billing.ts";

/** Cloud billing policy, for subscriptions and member counts. */
export class BillingMeter extends Context.Service<
  BillingMeter,
  {
    readonly memberLimit: (
      organization: OrganizationId,
    ) => Effect.Effect<number, BillingUnavailable>;
    /** Run by the durable membership job; calls Autumn only when the count changed. */
    readonly syncSeats: (organization: OrganizationId) => Effect.Effect<void, BillingUnavailable>;
    /** Daily repair: seat plans, unconfirmed organizations and changed counts, checked in Autumn. */
    readonly reconcileSeats: Effect.Effect<void, BillingUnavailable>;
  }
>()("cloud/BillingMeter") {}
