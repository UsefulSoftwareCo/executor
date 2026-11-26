import { Context, Schema, type Effect, type Redacted } from "effect";

export const autumnApiVersion = "2.3.0";
export const autumnTimeout = "10 seconds";

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

const attachRequest = Schema.Struct({
  ...customer,
  planId: Schema.String,
  successUrl: Schema.optionalKey(Schema.String),
}).pipe(
  Schema.encodeKeys({
    ...customerKeys,
    planId: "plan_id",
    successUrl: "success_url",
  }),
);

export const AutumnRequests = {
  getOrCreateCustomer: Schema.Struct({
    ...customer,
    autoEnablePlanId: Schema.optionalKey(Schema.String),
  }).pipe(Schema.encodeKeys({ ...customerKeys, autoEnablePlanId: "auto_enable_plan_id" })),
  listPlans: Schema.Struct(customer).pipe(Schema.encodeKeys(customerKeys)),
  updateBalance: Schema.Struct({
    ...customer,
    featureId: Schema.String,
    usage: Schema.Number,
  }).pipe(Schema.encodeKeys(featureKeys)),
  attach: attachRequest,
  openCustomerPortal: Schema.Struct({ ...customer, returnUrl: Schema.String }).pipe(
    Schema.encodeKeys({ ...customerKeys, returnUrl: "return_url" }),
  ),
  updateSubscription: Schema.Struct({
    ...customer,
    planId: Schema.String,
    cancelAction: Schema.Literals(["cancel_immediately", "cancel_end_of_cycle", "uncancel"]),
  }).pipe(Schema.encodeKeys({ ...customerKeys, planId: "plan_id", cancelAction: "cancel_action" })),
};

const subscriptions = Schema.Array(
  Schema.Struct({ planId: Schema.String, status: Schema.String }).pipe(
    Schema.encodeKeys({ planId: "plan_id" }),
  ),
);

export const AutumnResponses = {
  getOrCreateCustomer: Schema.Struct({
    balances: Schema.Record(Schema.String, balance),
    subscriptions,
  }),
  listPlans: Schema.Struct({
    list: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        group: Schema.NullOr(Schema.String),
        archived: Schema.Boolean,
        price: Schema.NullOr(price),
        items: Schema.Array(item),
        freeTrial: Schema.optionalKey(trial),
      }).pipe(Schema.encodeKeys({ freeTrial: "free_trial" })),
    ),
  }),
  updateBalance: Schema.Struct({ success: Schema.Literal(true) }),
  attach: Schema.Struct({
    paymentUrl: Schema.NullOr(Schema.String),
    invoice: Schema.optionalKey(Schema.NullOr(Schema.Struct({ total: Schema.Number }))),
  }).pipe(Schema.encodeKeys({ paymentUrl: "payment_url" })),
  openCustomerPortal: Schema.Struct({ url: Schema.String }),
  updateSubscription: Schema.Struct({}),
};

export class AutumnRequestFailed extends Schema.TaggedError<AutumnRequestFailed>()(
  "AutumnRequestFailed",
  {
    operation: Schema.Literals([
      "getOrCreateCustomer",
      "listPlans",
      "updateBalance",
      "attach",
      "openCustomerPortal",
      "updateSubscription",
    ]),
    reason: Schema.Literals(["request", "transport", "status", "response", "timeout"]),
    status: Schema.optionalKey(Schema.Int),
    cause: Schema.optionalKey(Schema.Redacted(Schema.Unknown)),
  },
) {}

export interface AutumnOptions {
  readonly secretKey: Redacted.Redacted<string>;
  readonly serverUrl: Redacted.Redacted<string>;
}

export class AutumnClient extends Context.Service<
  AutumnClient,
  {
    readonly [K in keyof typeof AutumnRequests]: (
      input: (typeof AutumnRequests)[K]["Type"],
    ) => Effect.Effect<(typeof AutumnResponses)[K]["Type"], AutumnRequestFailed>;
  }
>()("cloud/AutumnClient") {}
