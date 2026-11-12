/** The Autumn wire contract used by cloud billing, independent of its JavaScript SDK. */
import { Context, Schema, type Effect, type Redacted } from "effect";

/** Match the API version used by autumn-js 1.2.28. */
export const autumnApiVersion = "2.3.0";
/**
 * Bound a complete write, including response decoding. Writes are never retried; each consumer
 * chooses how its reads are bounded (`autumnReads` in `implementation/autumn-client.ts`).
 */
export const autumnTimeout = "10 seconds";

/**
 * The provider endpoint is a capability: it receives the Autumn bearer secret on every call.
 * Constrain the shape of the URL so the secret cannot ride along in userinfo, a query string or
 * a fragment. Which endpoint an operator may point it at is a key-safety question, answered
 * where the key is read.
 */
export const AutumnServerUrl = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      const url = URL.parse(value);
      return (
        url !== null &&
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    },
    { message: "Use an HTTPS Autumn endpoint with no credentials, query or fragment" },
  ),
);

const customer = { customerId: Schema.String };
const customerKeys = { customerId: "customer_id" } as const;
const featureKeys = { ...customerKeys, featureId: "feature_id" } as const;
const balance = Schema.Struct({
  featureId: Schema.String,
  usage: Schema.Number,
  remaining: Schema.Number,
  unlimited: Schema.Boolean,
}).pipe(Schema.encodeKeys({ featureId: "feature_id" }));
const price = Schema.Struct({ amount: Schema.Number, interval: Schema.String });
const item = Schema.Struct({
  featureId: Schema.String,
  included: Schema.Number,
  unlimited: Schema.Boolean,
  price: Schema.NullOr(
    Schema.Struct({ amount: Schema.optionalKey(Schema.Number), interval: Schema.String }),
  ),
}).pipe(Schema.encodeKeys({ featureId: "feature_id" }));
const trial = Schema.Struct({
  durationLength: Schema.Number,
  durationType: Schema.String,
  cardRequired: Schema.Boolean,
}).pipe(
  Schema.encodeKeys({
    durationLength: "duration_length",
    durationType: "duration_type",
    cardRequired: "card_required",
  }),
);

/**
 * The version of a plan a subscription bills, as `customers.get` expands it: its base price and
 * its items' prices, which say how the plan charges.
 */
const subscribedPlan = Schema.Struct({
  id: Schema.String,
  version: Schema.Number,
  price: Schema.NullOr(price),
  items: Schema.Array(
    Schema.Struct({
      featureId: Schema.String,
      unlimited: Schema.Boolean,
      price: Schema.NullOr(
        Schema.Struct({
          amount: Schema.optionalKey(Schema.Number),
          interval: Schema.String,
          billingUnits: Schema.optionalKey(Schema.Number),
          billingMethod: Schema.optionalKey(Schema.String),
        }).pipe(
          Schema.encodeKeys({ billingUnits: "billing_units", billingMethod: "billing_method" }),
        ),
      ),
    }).pipe(Schema.encodeKeys({ featureId: "feature_id" })),
  ),
});

/** A subscription with its dates, all in milliseconds since the epoch. */
const datedSubscription = Schema.Struct({
  planId: Schema.String,
  status: Schema.String,
  canceledAt: Schema.NullOr(Schema.Number),
  expiresAt: Schema.NullOr(Schema.Number),
  trialEndsAt: Schema.NullOr(Schema.Number),
  currentPeriodEnd: Schema.NullOr(Schema.Number),
  /** Absent when Autumn cannot expand it, such as for a plan no longer in its catalog. */
  plan: Schema.optionalKey(subscribedPlan),
}).pipe(
  Schema.encodeKeys({
    planId: "plan_id",
    canceledAt: "canceled_at",
    expiresAt: "expires_at",
    trialEndsAt: "trial_ends_at",
    currentPeriodEnd: "current_period_end",
  }),
);

/**
 * The plan overrides a carried-over subscription uses: a flat base price in place of the plan's,
 * the plan's items replaced, and the plan's trial removed (`null`).
 */
const customize = Schema.Struct({
  price: Schema.optionalKey(price),
  items: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        featureId: Schema.String,
        unlimited: Schema.optionalKey(Schema.Boolean),
      }).pipe(Schema.encodeKeys({ featureId: "feature_id" })),
    ),
  ),
  freeTrial: Schema.optionalKey(Schema.Null),
}).pipe(Schema.encodeKeys({ freeTrial: "free_trial" }));

/**
 * One attach, as a checkout or as a carried-over subscription. A checkout names the plan and where
 * Stripe returns. A carry-over replaces the plans it removes on their existing Stripe subscription
 * (`removePlanIds`), creates no charge for the change (`prorationBehavior: "none"`) and never
 * sends the customer to a checkout (`redirectMode: "never"`).
 */
const attachRequest = Schema.Struct({
  ...customer,
  planId: Schema.String,
  version: Schema.optionalKey(Schema.Number),
  successUrl: Schema.optionalKey(Schema.String),
  removePlanIds: Schema.optionalKey(Schema.Array(Schema.String)),
  prorationBehavior: Schema.optionalKey(Schema.Literal("none")),
  redirectMode: Schema.optionalKey(Schema.Literal("never")),
  customize: Schema.optionalKey(customize),
}).pipe(
  Schema.encodeKeys({
    ...customerKeys,
    planId: "plan_id",
    successUrl: "success_url",
    removePlanIds: "remove_plan_ids",
    prorationBehavior: "proration_behavior",
    redirectMode: "redirect_mode",
  }),
);

/** Only the inputs used by the product, encoded with Autumn's wire field names. */
export const AutumnRequests = {
  getOrCreateCustomer: Schema.Struct({
    ...customer,
    autoEnablePlanId: Schema.optionalKey(Schema.String),
  }).pipe(Schema.encodeKeys({ ...customerKeys, autoEnablePlanId: "auto_enable_plan_id" })),
  /** Read only: unlike `getOrCreateCustomer`, an unknown customer is not created. */
  getCustomer: Schema.Struct(customer).pipe(Schema.encodeKeys(customerKeys)),
  /** Read only, like `getCustomer`, with each subscription's dates and the plan version it bills. */
  getCustomerPlans: Schema.Struct({
    ...customer,
    expand: Schema.Tuple([Schema.Literal("subscriptions.plan")]),
  }).pipe(Schema.encodeKeys(customerKeys)),
  listPlans: Schema.Struct(customer).pipe(Schema.encodeKeys(customerKeys)),
  updateBalance: Schema.Struct({
    ...customer,
    featureId: Schema.String,
    usage: Schema.Number,
  }).pipe(Schema.encodeKeys(featureKeys)),
  attach: attachRequest,
  /** What `attach` would bill and change, changing nothing. */
  previewAttach: attachRequest,
  openCustomerPortal: Schema.Struct({ ...customer, returnUrl: Schema.String }).pipe(
    Schema.encodeKeys({ ...customerKeys, returnUrl: "return_url" }),
  ),
  // Autumn identifies a subscription by (customer, plan), so cancelling is an
  // update carrying a cancel action rather than its own operation.
  updateSubscription: Schema.Struct({
    ...customer,
    planId: Schema.String,
    cancelAction: Schema.Literals(["cancel_immediately", "cancel_end_of_cycle", "uncancel"]),
  }).pipe(Schema.encodeKeys({ ...customerKeys, planId: "plan_id", cancelAction: "cancel_action" })),
  /** Give a customer a new id. Its Stripe customer, subscriptions and plans stay as they are. */
  renameCustomer: Schema.Struct({ ...customer, newCustomerId: Schema.String }).pipe(
    Schema.encodeKeys({ ...customerKeys, newCustomerId: "new_customer_id" }),
  ),
  deleteCustomer: Schema.Struct(customer).pipe(Schema.encodeKeys(customerKeys)),
  /** Compare the customer's Stripe subscriptions with its plans. Read only. */
  verifyBilling: Schema.Struct(customer).pipe(Schema.encodeKeys(customerKeys)),
};

const subscriptions = Schema.Array(
  Schema.Struct({ planId: Schema.String, status: Schema.String }).pipe(
    Schema.encodeKeys({ planId: "plan_id" }),
  ),
);
const planIds = Schema.Array(
  Schema.Struct({ planId: Schema.String }).pipe(Schema.encodeKeys({ planId: "plan_id" })),
);
/** How serious a drift `verifyBilling` found; a warning, such as a Stripe-only subscription, can be deliberate. */
const mismatch = Schema.Struct({ severity: Schema.optionalKey(Schema.String) });

/** Decode provider responses into the fields billing reads; unrelated provider fields are ignored. */
export const AutumnResponses = {
  getOrCreateCustomer: Schema.Struct({
    balances: Schema.Record(Schema.String, balance),
    subscriptions,
  }),
  /** Null when Autumn has no customer with this id. */
  getCustomer: Schema.NullOr(Schema.Struct({ subscriptions })),
  /** Null when Autumn has no customer with this id. */
  getCustomerPlans: Schema.NullOr(
    Schema.Struct({
      subscriptions: Schema.Array(datedSubscription),
      balances: Schema.Record(Schema.String, Schema.Struct({ usage: Schema.Number })),
    }),
  ),
  listPlans: Schema.Struct({
    list: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        group: Schema.NullOr(Schema.String),
        archived: Schema.Boolean,
        price: Schema.NullOr(price),
        items: Schema.Array(item),
        // Autumn omits the key for a plan without a trial.
        freeTrial: Schema.optionalKey(trial),
      }).pipe(Schema.encodeKeys({ freeTrial: "free_trial" })),
    ),
  }),
  updateBalance: Schema.Struct({ success: Schema.Literal(true) }),
  /** `invoice` is present only when the attach charged something. */
  attach: Schema.Struct({
    paymentUrl: Schema.NullOr(Schema.String),
    invoice: Schema.optionalKey(Schema.NullOr(Schema.Struct({ total: Schema.Number }))),
  }).pipe(Schema.encodeKeys({ paymentUrl: "payment_url" })),
  /**
   * The charge now (`total`, in the currency's major unit), the next cycle when there is one, and
   * the plans the attach would add and end.
   */
  previewAttach: Schema.Struct({
    total: Schema.Number,
    nextCycle: Schema.optionalKey(
      Schema.NullOr(
        Schema.Struct({ startsAt: Schema.Number, total: Schema.Number }).pipe(
          Schema.encodeKeys({ startsAt: "starts_at" }),
        ),
      ),
    ),
    incoming: planIds,
    outgoing: planIds,
    redirectToCheckout: Schema.Boolean,
  }).pipe(
    Schema.encodeKeys({ nextCycle: "next_cycle", redirectToCheckout: "redirect_to_checkout" }),
  ),
  openCustomerPortal: Schema.Struct({ url: Schema.String }),
  // Only the outcome matters here; the invoice and proration detail is Autumn's.
  updateSubscription: Schema.Struct({}),
  renameCustomer: Schema.Struct({ id: Schema.String }),
  deleteCustomer: Schema.Struct({ success: Schema.Literal(true) }),
  verifyBilling: Schema.Struct({
    subscriptions: Schema.Array(
      Schema.Struct({
        stripeSubscriptionId: Schema.String,
        status: Schema.String,
        mismatches: Schema.Array(mismatch),
      }).pipe(Schema.encodeKeys({ stripeSubscriptionId: "stripe_subscription_id" })),
    ),
    customerMismatches: Schema.Array(mismatch),
  }).pipe(Schema.encodeKeys({ customerMismatches: "customer_mismatches" })),
};

/** Safe diagnostics for transport, provider and contract failures. Cancellation remains interruption. */
export class AutumnRequestFailed extends Schema.TaggedError<AutumnRequestFailed>()(
  "AutumnRequestFailed",
  {
    operation: Schema.Literals([
      "getOrCreateCustomer",
      "getCustomer",
      "getCustomerPlans",
      "listPlans",
      "updateBalance",
      "attach",
      "previewAttach",
      "openCustomerPortal",
      "updateSubscription",
      "renameCustomer",
      "deleteCustomer",
      "verifyBilling",
    ]),
    reason: Schema.Literals(["request", "transport", "status", "response", "timeout"]),
    status: Schema.optionalKey(Schema.Int),
    cause: Schema.optionalKey(Schema.Redacted(Schema.Unknown)),
  },
) {}

/** A private instance URL is a capability, so both settings remain redacted. */
export interface AutumnOptions {
  readonly secretKey: Redacted.Redacted<string>;
  readonly serverUrl: Redacted.Redacted<string>;
}

/**
 * Typed Autumn HTTP operations. Product policy and customer identity belong to Billing/BillingMeter
 * and, for v1's carried-over subscriptions, the v1 import.
 */
export class AutumnClient extends Context.Service<
  AutumnClient,
  {
    readonly [K in keyof typeof AutumnRequests]: (
      input: (typeof AutumnRequests)[K]["Type"],
    ) => Effect.Effect<(typeof AutumnResponses)[K]["Type"], AutumnRequestFailed>;
  }
>()("cloud/AutumnClient") {}
