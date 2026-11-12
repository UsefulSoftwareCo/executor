/**
 * A paid v1 organization's subscription, carried over to its v2 organization's billing
 * (`notes/v1-import.md`, "Billing"; decision 5). v1 and v2 bill in the same Autumn account and
 * Stripe account. The carry-over renames v1's Autumn customer to the v2 organization's customer
 * id, then attaches v2's Team plan to the same Stripe subscription in place of v1's Team plan: no
 * new subscription, charge, proration, trial or renewal date. `returnBilling` reverses it.
 *
 * Every write is preceded by a read of where Autumn already is, so a step that runs again after
 * a lost response continues from there instead of writing twice.
 */
import type { OrganizationId } from "@executor-js/hosted-server";
import { Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { AutumnClient, AutumnRequestFailed, AutumnResponses } from "../../contracts/autumn.ts";
import type { BillingUnavailable } from "../../contracts/billing.ts";
import {
  billingCustomerId,
  teamMemberPrice,
  type BillingCatalog,
} from "../../contracts/billing-catalog.ts";
import { V1ImportUnavailable } from "../../contracts/v1-import.ts";
import { freePlans } from "../v1-membership.ts";

/**
 * What a v1 Team subscription on a flat price (USD 49 or 150 a month, with executions metered
 * on top) becomes. `keep` keeps its price on v2's Team plan, with unlimited members; `per_member`
 * moves it to v2's own price of USD 15 per member. Executions are never billed on v2, so their
 * metering ends either way. This is the one place the choice is made.
 */
export const flatTeamPricing: "keep" | "per_member" = "keep";

/** v1's Team plan in the Autumn account v1 and v2 share; each version is a pricing of it. */
export const v1TeamPlan = "team";

/**
 * How a v1 Team version charges: per member of `feature`, whose usage v1 sets to its seat count,
 * or a flat monthly price.
 */
export const V1TeamPricing = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("per_member"), feature: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("flat"),
    amount: Schema.Number,
    interval: Schema.String,
  }),
]);
export type V1TeamPricing = typeof V1TeamPricing.Type;

/**
 * The v1 subscription a carry-over keeps, as the assessment read it. Times are milliseconds
 * since the epoch. `trialEndsAt` is set only while the trial runs, and `expiresAt` only when the
 * subscription is cancelled at the end of its period. `seats` is the per-member usage v1 had
 * set, which giving the billing back restores.
 */
export const V1Subscription = Schema.Struct({
  planId: Schema.String,
  version: Schema.Number,
  pricing: V1TeamPricing,
  seats: Schema.NullOr(Schema.Number),
  periodEnd: Schema.Number,
  trialEndsAt: Schema.NullOr(Schema.Number),
  expiresAt: Schema.NullOr(Schema.Number),
});
export type V1Subscription = typeof V1Subscription.Type;

/** The v2 pricing a v1 subscription moves to, under `flatTeamPricing`. */
export const v2Pricing = (subscription: V1Subscription): "per_member" | "flat" =>
  subscription.pricing.kind === "flat" && flatTeamPricing === "keep" ? "flat" : "per_member";

/** What the carry-over needs of v2's billing. */
export interface V1ImportBilling {
  readonly autumn: AutumnClient["Service"];
  readonly catalog: BillingCatalog;
  /** v1's Team plan in the same Autumn account. */
  readonly v1TeamPlan: string;
  /** v2's own seat sync, which runs once the organization's billing is carried over. */
  readonly syncSeats: (organization: OrganizationId) => Effect.Effect<void, BillingUnavailable>;
}

type CustomerPlans = NonNullable<(typeof AutumnResponses.getCustomerPlans)["Type"]>;
type Verified = (typeof AutumnResponses.verifyBilling)["Type"];
type Preview = (typeof AutumnResponses.previewAttach)["Type"];

/** Why the organization's billing cannot carry over, or did not. Another attempt would not help. */
export class CarryOverRefused extends Schema.TaggedError<CarryOverRefused>()("CarryOverRefused", {
  reason: Schema.String,
}) {}

const refuse = (reason: string) => Effect.fail(new CarryOverRefused({ reason }));

/**
 * Autumn's answer to a request it refused is final; no answer, a server error or a rate limit
 * retries the step, which reads back first.
 */
const call = <A>(effect: Effect.Effect<A, AutumnRequestFailed>) =>
  effect.pipe(
    Effect.mapError((error) =>
      error.reason === "status" &&
      error.status !== undefined &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 429
        ? new CarryOverRefused({
            reason: `Autumn refused ${error.operation} (${error.status}).`,
          })
        : new V1ImportUnavailable(),
    ),
  );

const plansOf = (billing: V1ImportBilling, customerId: string) =>
  call(billing.autumn.getCustomerPlans({ customerId, expand: ["subscriptions.plan"] }));

/**
 * A plan that bills now. Autumn reports a running trial as `active` with its end; v2's billing
 * accepts `trialing` as well (`billing.ts`), and so does this.
 */
const isLive = (subscription: { readonly status: string }) =>
  subscription.status === "active" || subscription.status === "trialing";

const live = (customer: CustomerPlans) => customer.subscriptions.filter(isLive);

/**
 * Whether a v2 organization's own customer pays for a plan: anything live but v2's Free plan. A
 * copy the opt-in import made has a customer of its own, on Free unless its users bought Team.
 */
export const paysInV2 = (catalog: BillingCatalog, customer: CustomerPlans | null) =>
  customer !== null && live(customer).some((plan) => plan.planId !== catalog.free);

/**
 * Decide whether v1's subscription can carry over: exactly one live plan, v1's Team plan, on a
 * pricing this module maps, and nothing pending but the free plan v1 schedules after a
 * cancellation. `now` decides whether a trial still runs.
 */
export const decideCarryOver = (
  customer: CustomerPlans | null,
  v1TeamPlan: string,
  now: number,
):
  | { readonly ok: true; readonly subscription: V1Subscription }
  | { readonly ok: false; readonly reason: string } => {
  if (customer === null) return { ok: false, reason: "Autumn has no customer for it." };
  const plans = live(customer);
  const [current] = plans;
  if (current === undefined || plans.length !== 1)
    return { ok: false, reason: `Autumn bills it on ${plans.length} plans; one carries over.` };
  if (current.planId !== v1TeamPlan)
    return {
      ok: false,
      reason: `Only v1 Team subscriptions carry over; its ${current.planId} plan waits for a decision.`,
    };
  const expiresAt = current.canceledAt === null ? null : current.expiresAt;
  if (current.canceledAt !== null && expiresAt === null)
    return { ok: false, reason: "Its subscription is cancelled with no end." };
  const pending = customer.subscriptions.filter(
    (subscription) =>
      !isLive(subscription) && !(expiresAt !== null && freePlans.includes(subscription.planId)),
  );
  if (pending.length > 0) return { ok: false, reason: "Autumn has a plan change pending for it." };
  if (current.currentPeriodEnd === null)
    return { ok: false, reason: "Its subscription has no billing period." };
  if (current.plan === undefined)
    return { ok: false, reason: "Autumn did not say which Team version it bills." };
  const plan = current.plan;
  const priced = plan.items.flatMap((item) =>
    item.price === null ? [] : [{ feature: item.featureId, ...item.price }],
  );
  const [seat] = priced;
  const pricing: V1TeamPricing | undefined =
    plan.price === null
      ? seat !== undefined &&
        priced.length === 1 &&
        seat.billingMethod === "usage_based" &&
        seat.amount === teamMemberPrice &&
        seat.interval === "month" &&
        (seat.billingUnits ?? 1) === 1
        ? { kind: "per_member", feature: seat.feature }
        : undefined
      : // A flat version meters executions on top, which v2 never bills.
        priced.every((price) => price.billingMethod === "usage_based")
        ? { kind: "flat", amount: plan.price.amount, interval: plan.price.interval }
        : undefined;
  if (pricing === undefined)
    return {
      ok: false,
      reason: `Its Team version ${plan.version} prices in a way that does not map.`,
    };
  return {
    ok: true,
    subscription: {
      planId: current.planId,
      version: plan.version,
      pricing,
      seats:
        pricing.kind === "per_member" ? (customer.balances[pricing.feature]?.usage ?? 0) : null,
      periodEnd: current.currentPeriodEnd,
      trialEndsAt:
        current.trialEndsAt !== null && current.trialEndsAt > now ? current.trialEndsAt : null,
      expiresAt,
    },
  };
};

/**
 * Whether two times are the same to the second. Stripe keeps a subscription's dates in seconds,
 * while Autumn can record the moment it saw them to the millisecond: a trial v1 started reads
 * `…502964`, and the same trial on the same Stripe subscription reads `…502000` once v2's plan
 * holds it.
 */
const sameSecond = (a: number | null, b: number | null) =>
  a === null || b === null ? a === b : Math.floor(a / 1000) === Math.floor(b / 1000);

const sameSubscription = (a: V1Subscription, b: V1Subscription) =>
  a.planId === b.planId &&
  a.version === b.version &&
  JSON.stringify(a.pricing) === JSON.stringify(b.pricing) &&
  sameSecond(a.periodEnd, b.periodEnd) &&
  sameSecond(a.trialEndsAt, b.trialEndsAt) &&
  sameSecond(a.expiresAt, b.expiresAt);

/**
 * Attaching v2's Team plan in place of v1's: on the same Stripe subscription, with no charge and
 * no checkout. A running trial keeps its end, so its trial is left as it is (Autumn refuses to
 * remove a running trial without proration); otherwise v2 Team's own trial is removed.
 */
export const carriedAttach = (
  billing: V1ImportBilling,
  subscription: V1Subscription,
  customerId: string,
) => {
  const pricing = subscription.pricing;
  const trial = subscription.trialEndsAt === null ? { freeTrial: null } : {};
  const customize =
    pricing.kind === "flat" && v2Pricing(subscription) === "flat"
      ? {
          price: { amount: pricing.amount, interval: pricing.interval },
          items: [
            { featureId: billing.catalog.members, unlimited: true },
            { featureId: billing.catalog.domainVerification },
          ],
          ...trial,
        }
      : subscription.trialEndsAt === null
        ? trial
        : undefined;
  return {
    customerId,
    planId: billing.catalog.team,
    removePlanIds: [subscription.planId],
    prorationBehavior: "none" as const,
    redirectMode: "never" as const,
    ...(customize === undefined ? {} : { customize }),
  };
};

/** Attaching v1's own Team version back in place of v2's Team plan, the same way. */
const returnedAttach = (
  billing: V1ImportBilling,
  subscription: V1Subscription,
  customerId: string,
) => ({
  customerId,
  planId: subscription.planId,
  version: subscription.version,
  removePlanIds: [billing.catalog.team],
  prorationBehavior: "none" as const,
  redirectMode: "never" as const,
  ...(subscription.trialEndsAt === null ? { customize: { freeTrial: null } } : {}),
});

/**
 * What would make an attach unsafe: any charge now, a checkout, another plan changing, or a
 * renewal date other than the subscription's.
 */
export const previewProblem = (
  preview: Preview,
  change: { readonly add: string; readonly remove: string; readonly renews: number },
) => {
  const ids = (plans: Preview["incoming"]) => plans.map((plan) => plan.planId).join(",");
  if (preview.total !== 0) return `Autumn would charge ${preview.total} now.`;
  if (preview.redirectToCheckout) return "Autumn would send the customer to a checkout.";
  if (ids(preview.incoming) !== change.add || ids(preview.outgoing) !== change.remove)
    return "Autumn would change other plans.";
  if (!sameSecond(preview.nextCycle?.startsAt ?? null, change.renews))
    return "Autumn would move the renewal date.";
  return undefined;
};

/** Exactly one Stripe subscription, `expected` when given, billing what Autumn's plans say. */
export const stripeProblem = (verified: Verified, expected: string | null) => {
  const [only] = verified.subscriptions;
  if (only === undefined || verified.subscriptions.length !== 1)
    return `Stripe has ${verified.subscriptions.length} subscriptions for it; one was expected.`;
  if (expected !== null && only.stripeSubscriptionId !== expected)
    return "Its Stripe subscription is not the one v1 billed it on.";
  // A mismatch Autumn does not mark as a warning means Stripe bills differently from the plan.
  if (
    [...only.mismatches, ...verified.customerMismatches].some(
      (mismatch) => mismatch.severity !== "warning",
    )
  )
    return "Stripe bills it differently from its plan in Autumn.";
  return undefined;
};

/**
 * Where a carried-over customer must end: v2's Team plan alone, renewing, ending a trial and
 * cancelled as v1's subscription was, on v1's Stripe subscription.
 */
export const carriedProblem = (
  billing: V1ImportBilling,
  customer: CustomerPlans,
  verified: Verified,
  subscription: V1Subscription,
  stripeSubscription: string,
) => {
  const plans = live(customer);
  const [team] = plans;
  if (team === undefined || plans.length !== 1 || team.planId !== billing.catalog.team)
    return "Autumn does not bill it on v2's Team plan alone.";
  if (!sameSecond(team.currentPeriodEnd, subscription.periodEnd)) return "Its renewal date moved.";
  if (subscription.trialEndsAt !== null && !sameSecond(team.trialEndsAt, subscription.trialEndsAt))
    return "Its trial end moved.";
  if (
    (subscription.expiresAt === null) !== (team.canceledAt === null) ||
    (subscription.expiresAt !== null && !sameSecond(team.expiresAt, subscription.expiresAt))
  )
    return "Its cancellation did not carry over.";
  return stripeProblem(verified, stripeSubscription);
};

// ---------------------------------------------------------------------------------------------
// The billing hold (`private_v1_import_billing`).

export type V1BillingState = "held" | "carried" | "returned";

const HoldRow = Schema.Struct({
  state: Schema.Literals(["held", "carried", "returned"]),
  v1_org_id: Schema.String,
  subscription: Schema.fromJsonString(V1Subscription),
  stripe_subscription_id: Schema.NullOr(Schema.String),
});

/** The organization's carry-over record, if the import made one. */
export const billingHoldRow = (sql: SqlClient.SqlClient, organization: string) =>
  sql`
    select state, v1_org_id, subscription::text as subscription, stripe_subscription_id
    from private_v1_import_billing where organization_id = ${organization}
  `.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(HoldRow))),
    Effect.map((rows) => rows[0]),
    Effect.mapError(() => new V1ImportUnavailable()),
  );

const States = Schema.Array(Schema.Struct({ state: Schema.String }));

/**
 * Whether v2's billing must leave the organization alone: `held` while v1's subscription is
 * carried over, `returned` once v1 bills it again. Null for every other organization.
 */
export const v1BillingHold = (organization: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`
      select state from private_v1_import_billing where organization_id = ${organization}
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(States)));
    const state = rows[0]?.state;
    return state === "held" || state === "returned" ? state : null;
  });

const setState = (sql: SqlClient.SqlClient, organization: string, state: V1BillingState) =>
  sql`
    update private_v1_import_billing set state = ${state}, updated_at = now()
    where organization_id = ${organization}
  `.pipe(
    Effect.asVoid,
    Effect.mapError(() => new V1ImportUnavailable()),
  );

// ---------------------------------------------------------------------------------------------
// Carry over, and give back.

interface CarryOverInput {
  readonly billing: V1ImportBilling;
  readonly sql: SqlClient.SqlClient;
  readonly v1Organization: string;
  readonly organization: OrganizationId;
  readonly subscription: V1Subscription;
}

/**
 * Move v1's subscription to the v2 organization, from wherever an earlier attempt left it:
 *
 * 1. Read v1's customer again and check it still bills what the assessment read, on exactly one
 *    Stripe subscription, which is recorded. Preview the attach on it; any problem stops here,
 *    with nothing written.
 * 2. Rename v1's customer to the v2 organization's customer id.
 * 3. Preview again and attach v2's Team plan (`carriedAttach`), requiring no charge.
 * 4. Cancel it at the end of its period when v1's was, since the attach does not keep that.
 * 5. Read back (`carriedProblem`) and record the organization `carried`, which ends the hold.
 */
export const carryOver = (input: CarryOverInput) =>
  Effect.gen(function* () {
    const { billing, sql, organization, subscription } = input;
    const hold = yield* billingHoldRow(sql, organization);
    if (hold === undefined)
      return yield* refuse("Its v2 organization was created without a billing hold.");
    if (hold.state === "carried") return;
    if (hold.state === "returned") return yield* refuse("Its billing was given back to v1.");
    const target = billingCustomerId(billing.catalog, organization);
    const change = {
      add: billing.catalog.team,
      remove: subscription.planId,
      renews: subscription.periodEnd,
    };
    let stripeSubscription = hold.stripe_subscription_id;
    let carried = yield* plansOf(billing, target);
    // A copy the opt-in import made before this has a customer of its own, on v2's Free plan. It
    // bills nothing, so it goes and v1's customer takes its id. One that pays is never replaced.
    if (carried !== null && stripeSubscription === null) {
      const billsNothing =
        !paysInV2(billing.catalog, carried) &&
        carried.subscriptions.every((plan) => plan.planId === billing.catalog.free) &&
        (yield* call(billing.autumn.verifyBilling({ customerId: target }))).subscriptions.length ===
          0;
      if (!billsNothing)
        return yield* refuse("Its v2 organization already pays for its own subscription.");
      yield* call(billing.autumn.deleteCustomer({ customerId: target }));
      carried = null;
    }
    if (carried === null) {
      const decided = decideCarryOver(
        yield* plansOf(billing, input.v1Organization),
        billing.v1TeamPlan,
        yield* Clock.currentTimeMillis,
      );
      if (!decided.ok) return yield* refuse(decided.reason);
      if (!sameSubscription(decided.subscription, subscription))
        return yield* refuse("Its v1 subscription changed after the import assessed it.");
      const verified = yield* call(
        billing.autumn.verifyBilling({ customerId: input.v1Organization }),
      );
      const stripe = stripeProblem(verified, stripeSubscription);
      if (stripe !== undefined) return yield* refuse(stripe);
      stripeSubscription = verified.subscriptions[0]?.stripeSubscriptionId ?? null;
      yield* sql`
        update private_v1_import_billing
        set stripe_subscription_id = ${stripeSubscription}, updated_at = now()
        where organization_id = ${organization}
      `.pipe(Effect.mapError(() => new V1ImportUnavailable()));
      const before = previewProblem(
        yield* call(
          billing.autumn.previewAttach(carriedAttach(billing, subscription, input.v1Organization)),
        ),
        change,
      );
      if (before !== undefined) return yield* refuse(before);
      yield* call(
        billing.autumn.renameCustomer({ customerId: input.v1Organization, newCustomerId: target }),
      );
      carried = yield* plansOf(billing, target);
      if (carried === null) return yield* new V1ImportUnavailable();
    }
    if (stripeSubscription === null)
      return yield* refuse("No Stripe subscription was recorded for it before the change.");
    if (live(carried).some((plan) => plan.planId === subscription.planId)) {
      const attach = carriedAttach(billing, subscription, target);
      const problem = previewProblem(yield* call(billing.autumn.previewAttach(attach)), change);
      if (problem !== undefined) return yield* refuse(problem);
      const attached = yield* call(billing.autumn.attach(attach));
      if (attached.paymentUrl !== null || (attached.invoice?.total ?? 0) !== 0)
        return yield* refuse("Autumn charged it or asked for a payment when the plan changed.");
      carried = yield* plansOf(billing, target);
      if (carried === null) return yield* new V1ImportUnavailable();
    }
    const team = live(carried).find((plan) => plan.planId === billing.catalog.team);
    if (subscription.expiresAt !== null && team !== undefined && team.canceledAt === null) {
      yield* call(
        billing.autumn.updateSubscription({
          customerId: target,
          planId: billing.catalog.team,
          cancelAction: "cancel_end_of_cycle",
        }),
      );
      carried = yield* plansOf(billing, target);
      if (carried === null) return yield* new V1ImportUnavailable();
    }
    const problem = carriedProblem(
      billing,
      carried,
      yield* call(billing.autumn.verifyBilling({ customerId: target })),
      subscription,
      stripeSubscription,
    );
    if (problem !== undefined) return yield* refuse(problem);
    yield* setState(sql, organization, "carried");
  });

/**
 * Give the organization's billing back to v1, from wherever the carry-over got: attach v1's Team
 * version back in place of v2's (`returnedAttach`, requiring no charge), cancel it at the end of
 * its period when v1's was, and rename the customer back to v1's id. A customer v1 made under that
 * id meanwhile, which it does when it meters an execution for a customer it cannot find, is
 * deleted first when it bills nothing: free plans only and no Stripe subscription. Records the
 * organization `returned`, after which v2's billing leaves it alone, so deleting the v2
 * organization cancels nothing.
 */
export const returnBilling = (input: {
  readonly billing: V1ImportBilling;
  readonly sql: SqlClient.SqlClient;
  readonly organization: OrganizationId;
}) =>
  Effect.gen(function* () {
    const { billing, sql, organization } = input;
    const hold = yield* billingHoldRow(sql, organization);
    if (hold === undefined)
      return yield* refuse("The import recorded no billing carry-over for this organization.");
    if (hold.state === "returned") return;
    const subscription = hold.subscription;
    const v1Organization = hold.v1_org_id;
    const target = billingCustomerId(billing.catalog, organization);
    let moved = yield* plansOf(billing, target);
    if (moved !== null) {
      const team = live(moved).find((plan) => plan.planId === billing.catalog.team);
      if (team !== undefined) {
        if (team.currentPeriodEnd === null)
          return yield* refuse("Its v2 plan has no billing period.");
        const attach = returnedAttach(billing, subscription, target);
        const problem = previewProblem(yield* call(billing.autumn.previewAttach(attach)), {
          add: subscription.planId,
          remove: billing.catalog.team,
          renews: team.currentPeriodEnd,
        });
        if (problem !== undefined) return yield* refuse(problem);
        const attached = yield* call(billing.autumn.attach(attach));
        if (attached.paymentUrl !== null || (attached.invoice?.total ?? 0) !== 0)
          return yield* refuse("Autumn charged it or asked for a payment when the plan changed.");
        moved = yield* plansOf(billing, target);
        if (moved === null) return yield* new V1ImportUnavailable();
      }
      const v1Plan = live(moved).find((plan) => plan.planId === subscription.planId);
      if (v1Plan === undefined || live(moved).length !== 1)
        return yield* refuse("Autumn does not bill it on v1's Team plan alone.");
      if (subscription.expiresAt !== null && v1Plan.canceledAt === null)
        yield* call(
          billing.autumn.updateSubscription({
            customerId: target,
            planId: subscription.planId,
            cancelAction: "cancel_end_of_cycle",
          }),
        );
      const occupant = yield* plansOf(billing, v1Organization);
      if (occupant !== null) {
        const billsNothing =
          occupant.subscriptions.every((plan) => freePlans.includes(plan.planId)) &&
          (yield* call(billing.autumn.verifyBilling({ customerId: v1Organization }))).subscriptions
            .length === 0;
        if (!billsNothing)
          return yield* refuse(
            "Autumn has another paying customer under the v1 organization's id.",
          );
        yield* call(billing.autumn.deleteCustomer({ customerId: v1Organization }));
      }
      yield* call(
        billing.autumn.renameCustomer({ customerId: target, newCustomerId: v1Organization }),
      );
    }
    // v1's plan starts again with no seats; v1 bills the seats it had set.
    if (subscription.pricing.kind === "per_member" && subscription.seats !== null)
      yield* call(
        billing.autumn.updateBalance({
          customerId: v1Organization,
          featureId: subscription.pricing.feature,
          usage: subscription.seats,
        }),
      );
    const back = yield* plansOf(billing, v1Organization);
    if (back === null || !live(back).some((plan) => plan.planId === subscription.planId))
      return yield* refuse("v1's customer does not bill it on v1's Team plan.");
    const stripe = stripeProblem(
      yield* call(billing.autumn.verifyBilling({ customerId: v1Organization })),
      hold.stripe_subscription_id,
    );
    if (stripe !== undefined) return yield* refuse(stripe);
    yield* setState(sql, organization, "returned");
  });
