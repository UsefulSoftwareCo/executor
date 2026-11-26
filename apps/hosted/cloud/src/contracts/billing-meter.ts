import { Context, Effect } from "effect";
import type { OrganizationId } from "@executor-js/hosted-server";
import { BillingUnavailable } from "./billing.ts";

export class BillingMeter extends Context.Service<
  BillingMeter,
  {
    readonly memberLimit: (
      organization: OrganizationId,
    ) => Effect.Effect<number, BillingUnavailable>;
    readonly syncSeats: (organization: OrganizationId) => Effect.Effect<void, BillingUnavailable>;
    readonly reconcileSeats: Effect.Effect<void, BillingUnavailable>;
  }
>()("cloud/BillingMeter") {}
