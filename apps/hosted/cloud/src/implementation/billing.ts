import { BillingMeter } from "../contracts/billing-meter.ts";
import { billingMembers } from "../infrastructure/billing-members.ts";
import {
  BearerAuthentication,
  SessionAuthentication,
  currentOrganizationSlug,
  organizationOwner,
  requireOrganizationAdmin,
  type OrganizationId,
} from "@executor-js/hosted-server";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Cause, Effect, Fiber, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { SqlClient } from "effect/sql";
import { AutumnClient, type AutumnRequestFailed } from "../contracts/autumn.ts";
import { autumnLive, autumnReads } from "./autumn-client.ts";
import {
  recordSeatPlan,
  recordSeats,
  seatCounts,
  seatReconcileCandidates,
} from "./billing-seats.ts";
import { reportCloudFailure } from "./error-reporting.ts";
import { HttpApiBuilder } from "effect/http-api";
import {
  Billing,
  BillingOverview,
  BillingPlanUnavailable,
  BillingUnavailable,
} from "../contracts/billing.ts";
import { billingCustomerId, freeMembers } from "../contracts/billing-catalog.ts";
import { ExecutorCloudApi } from "../contracts/api.ts";
import { billingSettings } from "../infrastructure/billing.ts";

class OrganizationBillingOrphaned extends Schema.TaggedError<OrganizationBillingOrphaned>()(
  "OrganizationBillingOrphaned",
  { organization: Schema.String, customerId: Schema.String },
) {
  override get message() {
    return `Organization ${this.organization} was removed with billing customer ${this.customerId} left live`;
  }
}

const HoldStates = Schema.Array(Schema.Struct({ state: Schema.String }));

const v1BillingHold = (organization: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`
      select state from private_v1_import_billing where organization_id = ${organization}
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(HoldStates)));
    const state = rows[0]?.state;
    return state === "held" || state === "returned" ? state : null;
  });

type Subscriptions = {
  readonly subscriptions: ReadonlyArray<{ readonly planId: string; readonly status: string }>;
};
const active = (customer: Subscriptions, plans: ReadonlyArray<string>) =>
  customer.subscriptions.some(
    (subscription) =>
      plans.includes(subscription.planId) && ["active", "trialing"].includes(subscription.status),
  );

export const billingLive = Effect.gen(function* () {
  const settings = yield* billingSettings.pipe(Effect.orDie);
  const members = yield* billingMembers;
  const client = yield* makeExecutionMemo(
    Effect.gen(function* () {
      const secret = yield* settings.secretKey;
      const server = yield* settings.serverUrl;
      const catalog = yield* settings.catalog;
      const autumn = yield* AutumnClient.pipe(
        Effect.provide(autumnLive({ secretKey: secret, serverUrl: server }, autumnReads.once)),
      );
      return { autumn, catalog };
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
  const use = <A>(call: Effect.Effect<A, AutumnRequestFailed>) =>
    call.pipe(Effect.mapError(() => new BillingUnavailable()));
  const hold = (organization: OrganizationId) => members.use(v1BillingHold(organization));
  const unlessHeld = (organization: OrganizationId) =>
    Effect.flatMap(hold(organization), (state) =>
      state === null ? Effect.void : Effect.fail(new BillingUnavailable()),
    );
  const overview: typeof Billing.Service.overview = (organization) =>
    Effect.gen(function* () {
      yield* unlessHeld(organization);
      const { autumn, catalog } = yield* client;
      const customerId = billingCustomerId(catalog, organization);
      const customer = yield* use(
        autumn.getOrCreateCustomer({ customerId, autoEnablePlanId: catalog.free }),
      );
      const listing = yield* Effect.forkChild(use(autumn.listPlans({ customerId })));
      yield* members.use(
        recordSeatPlan(organization, active(customer, [catalog.team, catalog.enterprise])),
      );
      const plans = yield* Fiber.join(listing);
      const offered = [catalog.free, catalog.team, catalog.enterprise];
      return yield* Schema.decodeUnknownEffect(BillingOverview)({
        enterprise: active(customer, [catalog.enterprise]),
        plans: plans.list
          .filter((plan) => !plan.archived && offered.includes(plan.id))
          .toSorted((a, b) => offered.indexOf(a.id) - offered.indexOf(b.id))
          .map((plan) => {
            const memberItem = plan.items.find((item) => item.featureId === catalog.members);
            const seats = memberItem?.price;
            const price = plan.price ?? seats;
            return {
              id: plan.id,
              name:
                plan.id === catalog.free
                  ? "Free"
                  : plan.id === catalog.team
                    ? "Team"
                    : "Enterprise",
              purchase: plan.id === catalog.enterprise ? "contact" : "checkout",
              price: price
                ? { amount: price.amount, interval: price.interval, unit: seats ? "member" : null }
                : null,
              members:
                memberItem === undefined || memberItem.unlimited || seats
                  ? null
                  : memberItem.included,
              domainVerification: plan.items.some(
                (item) => item.featureId === catalog.domainVerification,
              ),
              trial:
                plan.freeTrial?.durationType === "day"
                  ? {
                      days: plan.freeTrial.durationLength,
                      cardRequired: plan.freeTrial.cardRequired,
                    }
                  : null,
            };
          }),
        subscriptions: customer.subscriptions
          .filter((subscription) => offered.includes(subscription.planId))
          .map((subscription) => ({
            planId: subscription.planId,
            status: subscription.status,
          })),
      }).pipe(Effect.mapError(() => new BillingUnavailable()));
    });
  const customer = (organization: OrganizationId) =>
    Effect.gen(function* () {
      yield* unlessHeld(organization);
      const { autumn, catalog } = yield* client;
      const customerId = billingCustomerId(catalog, organization);
      const value = yield* use(
        autumn.getOrCreateCustomer({ customerId, autoEnablePlanId: catalog.free }),
      );
      return { autumn, catalog, customerId, value };
    });
  const syncSeats = (organization: OrganizationId, mode: "changed" | "verify") =>
    Effect.gen(function* () {
      if ((yield* hold(organization)) !== null) return;
      let current: { readonly count: number; readonly synced: number | null } | undefined =
        yield* members.use(seatCounts(organization));
      if (current === undefined) return yield* new BillingUnavailable();
      if (mode === "changed" && current.synced === current.count) return;
      for (let pass = 0; pass < 3; pass++) {
        const count: number = current.count;
        const { autumn, catalog, customerId, value } = yield* customer(organization);
        const balance = value.balances[catalog.members];
        if (balance === undefined) return yield* new BillingUnavailable();
        if (balance.usage !== count)
          yield* use(
            autumn.updateBalance({ customerId, featureId: catalog.members, usage: count }),
          );
        const live: number | undefined = yield* members.use(
          recordSeats(organization, count, active(value, [catalog.team, catalog.enterprise])),
        );
        if (live === undefined || live === count) return;
        current = { count: live, synced: count };
      }
      return yield* new BillingUnavailable();
    }).pipe(Effect.withSpan("billing.syncSeats", { attributes: { mode } }));
  const cancel: typeof Billing.Service.cancel = (organization) =>
    Effect.gen(function* () {
      const { autumn, catalog } = yield* client;
      const customerId = catalog
        ? billingCustomerId(catalog, organization)
        : organizationOwner(organization);
      if ((yield* hold(organization)) === "returned")
        return { customerId, cancelled: [] as string[] };
      return yield* Effect.gen(function* () {
        const { value } = yield* customer(organization);
        const live = value.subscriptions.filter(
          (subscription) =>
            subscription.status !== "expired" &&
            (catalog === null || subscription.planId !== catalog.free),
        );
        yield* Effect.forEach(
          live,
          (subscription) =>
            use(
              autumn.updateSubscription({
                customerId,
                planId: subscription.planId,
                cancelAction: "cancel_immediately",
              }),
            ),
          { discard: true },
        );
        return { customerId, cancelled: live.map((subscription) => subscription.planId) };
      }).pipe(
        Effect.tapError(() =>
          Effect.logError("Organization removed with a billing subscription left live").pipe(
            Effect.annotateLogs({ organization, billingCustomer: customerId }),
            Effect.andThen(
              reportCloudFailure(
                Cause.fail(new OrganizationBillingOrphaned({ organization, customerId })),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.withSpan("billing.cancel"));
  const meter = BillingMeter.of({
    memberLimit: (organization) =>
      Effect.gen(function* () {
        const { catalog, value } = yield* customer(organization);
        return active(value, [catalog.team, catalog.enterprise])
          ? Number.POSITIVE_INFINITY
          : freeMembers;
      }),
    syncSeats: (organization) => syncSeats(organization, "changed"),
    reconcileSeats: Effect.gen(function* () {
      const rows = yield* members.use(seatReconcileCandidates);
      const failed = yield* Effect.forEach(
        rows,
        (row) =>
          syncSeats(row.organization, "verify").pipe(
            Effect.as(false),
            Effect.catch(() => Effect.succeed(true)),
          ),
        { concurrency: 4 },
      );
      if (failed.includes(true)) return yield* new BillingUnavailable();
    }).pipe(Effect.withSpan("billing.reconcileSeats")),
  });
  return Layer.mergeAll(
    Layer.succeed(BillingMeter, meter),
    Layer.succeed(
      Billing,
      Billing.of({
        overview,
        checkout: (organization, plan, returnUrl) =>
          Effect.gen(function* () {
            yield* syncSeats(organization, "verify");
            const current = yield* overview(organization);
            if (
              !current.plans.some(
                (candidate) => candidate.id === plan && candidate.purchase === "checkout",
              )
            )
              return yield* new BillingPlanUnavailable();
            if (
              current.subscriptions.some(
                (subscription) =>
                  subscription.planId === plan &&
                  ["active", "trialing"].includes(subscription.status),
              )
            )
              return { url: null };
            const success = new URL(returnUrl);
            success.searchParams.set("organization", organization);
            success.searchParams.set("plan", plan);
            const { autumn, catalog } = yield* client;
            const result = yield* use(
              autumn.attach({
                customerId: billingCustomerId(catalog, organization),
                planId: plan,
                successUrl: success.href,
              }),
            );
            return { url: result.paymentUrl };
          }),
        portal: (organization, returnUrl) =>
          Effect.gen(function* () {
            yield* overview(organization);
            const { autumn, catalog } = yield* client;
            const result = yield* use(
              autumn.openCustomerPortal({
                customerId: billingCustomerId(catalog, organization),
                returnUrl: returnUrl.href,
              }),
            );
            return { url: result.url };
          }),
        cancel,
      }),
    ),
  );
});

export const billingHandlers = HttpApiBuilder.group(ExecutorCloudApi, "billing", (handlers) =>
  Effect.gen(function* () {
    const billing = yield* Billing;
    const meter = yield* BillingMeter;
    const auth = yield* SessionAuthentication;
    const api = yield* BearerAuthentication;
    const destination = currentOrganizationSlug(auth, api).pipe(
      Effect.map((slug) => new URL(`/org/${encodeURIComponent(slug)}/billing`, auth.origin)),
    );
    return handlers
      .handle("overview", () =>
        Effect.gen(function* () {
          return yield* billing.overview((yield* requireOrganizationAdmin).organization);
        }),
      )
      .handle("memberLimit", () =>
        Effect.gen(function* () {
          const limit = yield* meter.memberLimit((yield* requireOrganizationAdmin).organization);
          return { limit: Number.isFinite(limit) ? limit : null };
        }),
      )
      .handle("checkout", ({ payload }) =>
        Effect.gen(function* () {
          const { organization } = yield* requireOrganizationAdmin;
          return yield* billing.checkout(organization, payload.plan, yield* destination);
        }),
      )
      .handle("portal", () =>
        Effect.gen(function* () {
          const { organization } = yield* requireOrganizationAdmin;
          return yield* billing.portal(organization, yield* destination);
        }),
      );
  }),
);
