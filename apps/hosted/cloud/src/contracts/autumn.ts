/** The Autumn wire contract used by cloud billing, independent of its JavaScript SDK. */
import { Context, Schema, type Effect, type Redacted } from "effect";

/** Match the API version used by autumn-js 1.2.28. */
export const autumnApiVersion = "2.3.0";
/** Bound a complete request, including response decoding. Billing writes are never retried. */
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
  price: Schema.NullOr(
    Schema.Struct({ amount: Schema.optionalKey(Schema.Number), interval: Schema.String }),
  ),
}).pipe(Schema.encodeKeys({ featureId: "feature_id" }));

/** Only the inputs used by the product, encoded with Autumn's wire field names. */
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
  attach: Schema.Struct({ ...customer, planId: Schema.String, successUrl: Schema.String }).pipe(
    Schema.encodeKeys({ ...customerKeys, planId: "plan_id", successUrl: "success_url" }),
  ),
  openCustomerPortal: Schema.Struct({ ...customer, returnUrl: Schema.String }).pipe(
    Schema.encodeKeys({ ...customerKeys, returnUrl: "return_url" }),
  ),
  // Autumn identifies a subscription by (customer, plan), so cancelling is an
  // update carrying a cancel action rather than its own operation.
  cancelSubscription: Schema.Struct({
    ...customer,
    planId: Schema.String,
    cancelAction: Schema.Literal("cancel_immediately"),
  }).pipe(Schema.encodeKeys({ ...customerKeys, planId: "plan_id", cancelAction: "cancel_action" })),
};

/** Decode provider responses into the fields billing reads; unrelated provider fields are ignored. */
export const AutumnResponses = {
  getOrCreateCustomer: Schema.Struct({
    balances: Schema.Record(Schema.String, balance),
    subscriptions: Schema.Array(
      Schema.Struct({ planId: Schema.String, status: Schema.String }).pipe(
        Schema.encodeKeys({ planId: "plan_id" }),
      ),
    ),
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
      }),
    ),
  }),
  updateBalance: Schema.Struct({ success: Schema.Literal(true) }),
  attach: Schema.Struct({ paymentUrl: Schema.NullOr(Schema.String) }).pipe(
    Schema.encodeKeys({ paymentUrl: "payment_url" }),
  ),
  openCustomerPortal: Schema.Struct({ url: Schema.String }),
  // Only the outcome matters here; the invoice and proration detail is Autumn's.
  cancelSubscription: Schema.Struct({}),
};

/** Safe diagnostics for transport, provider and contract failures. Cancellation remains interruption. */
export class AutumnRequestFailed extends Schema.TaggedError<AutumnRequestFailed>()(
  "AutumnRequestFailed",
  {
    operation: Schema.Literals([
      "getOrCreateCustomer",
      "listPlans",
      "updateBalance",
      "attach",
      "openCustomerPortal",
      "cancelSubscription",
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

/** Seven typed HTTP operations. Product policy and customer identity belong to Billing/BillingMeter. */
export class AutumnClient extends Context.Service<
  AutumnClient,
  {
    readonly [K in keyof typeof AutumnRequests]: (
      input: (typeof AutumnRequests)[K]["Type"],
    ) => Effect.Effect<(typeof AutumnResponses)[K]["Type"], AutumnRequestFailed>;
  }
>()("cloud/AutumnClient") {}
