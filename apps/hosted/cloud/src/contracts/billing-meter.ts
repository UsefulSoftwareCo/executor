import { Context, Effect } from "effect";
import {
  ExecutionAdmissionUnavailable,
  ExecutionLimitReached,
  type OrganizationId,
} from "@executor-js/hosted-server";
import { BillingUnavailable } from "./billing.ts";

/** Cloud billing policy, shared by the API, auth hooks and MCP admission boundary. */
export class BillingMeter extends Context.Service<
  BillingMeter,
  {
    readonly consume: (
      organization: OrganizationId,
    ) => Effect.Effect<void, ExecutionLimitReached | ExecutionAdmissionUnavailable>;
    readonly memberLimit: (
      organization: OrganizationId,
    ) => Effect.Effect<number, BillingUnavailable>;
    readonly syncSeats: (organization: OrganizationId) => Effect.Effect<void, BillingUnavailable>;
    readonly reconcileSeats: Effect.Effect<void, BillingUnavailable>;
  }
>()("cloud/BillingMeter") {}
