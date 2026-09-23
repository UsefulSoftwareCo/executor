/** Alchemy owns the V2 catalog; Autumn owns its Stripe products and prices. */
import { isDeepStrictEqual } from "node:util";
import {
  Autumn,
  AutumnError,
  type CreateFeatureParams,
  type GetFeatureResponse,
  type GetPlanResponse,
} from "autumn-js";
import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Config, Effect, Layer, Redacted, Schema } from "effect";
import type { BillingFeatureDeclaration } from "../contracts/billing-catalog.ts";

/** Credential-bearing provider errors remain redacted in deployment diagnostics. */
export class AutumnProvisioningFailed extends Schema.TaggedError<AutumnProvisioningFailed>()(
  "AutumnProvisioningFailed",
  { operation: Schema.String, status: Schema.Number, detail: Schema.Redacted(Schema.Unknown) },
) {}

/** Management credentials are resolved outside resource props and never saved in outputs. */
const client = Effect.gen(function* () {
  const environment = yield* Config.Literals(["sandbox", "live"], "AUTUMN_ENVIRONMENT");
  const key = yield* Config.Redacted("AUTUMN_SECRET_KEY");
  if (!Redacted.value(key).startsWith(environment === "sandbox" ? "am_sk_test_" : "am_sk_live_"))
    return yield* Effect.die("Autumn credential does not match AUTUMN_ENVIRONMENT");
  const api = new Autumn({
    secretKey: Redacted.value(key),
    failOpen: false,
    timeoutMs: 15_000,
    retryConfig: { strategy: "none" },
  });
  const response = yield* use("read account", async (signal) => {
    const response = await fetch("https://api.useautumn.com/v1/organization/me", {
      headers: { Authorization: `Bearer ${Redacted.value(key)}` },
      signal,
    });
    if (!response.ok) throw new Error("Autumn account lookup failed");
    return response.json();
  });
  const account = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ id: Schema.String, env: Schema.Literals(["sandbox", "live"]) }),
  )(response);
  if (account.env !== environment)
    return yield* Effect.die("Autumn returned a different environment");
  return { api, account: `${account.id}:${account.env}` };
}).pipe(Effect.orDie);
const use = <A>(operation: string, call: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: (cause) =>
      new AutumnProvisioningFailed({
        operation,
        status: cause instanceof AutumnError ? cause.statusCode : 0,
        detail: Redacted.make(cause),
      }),
  });
const optional = <A>(effect: Effect.Effect<A, AutumnProvisioningFailed>) =>
  effect.pipe(
    Effect.catchTag("AutumnProvisioningFailed", (error) =>
      error.status === 404 ? Effect.succeed(undefined) : Effect.fail(error),
    ),
  );
const reserved = (id: string) => {
  if (!/^executor-next-[a-z0-9-]+$/.test(id))
    throw new Error("Managed Autumn IDs must use the executor-next- prefix");
};

/** An immutable feature identity. Changing its meaning requires a new ID. */
export type AutumnFeatureProps = BillingFeatureDeclaration;
/** Only catalog metadata is stored in Alchemy state. */
export type AutumnFeatureAttributes = AutumnFeatureProps & {
  readonly archived: boolean;
  readonly account: string;
};
/** Declare a metered usage, seat, or boolean feature. */
export type AutumnFeature = Resource<
  "Executor.AutumnFeature",
  AutumnFeatureProps,
  AutumnFeatureAttributes
>;
/** Feature lifetime is retained by the catalog stack. */
export const AutumnFeature = Resource<AutumnFeature>("Executor.AutumnFeature");
const featureIdentity = {
  account: Schema.String,
  featureId: Schema.String,
  name: Schema.String,
  archived: Schema.Boolean,
};
const FeatureAttributes = Schema.Union([
  Schema.Struct({
    ...featureIdentity,
    type: Schema.Literal("metered"),
    consumable: Schema.Boolean,
  }),
  Schema.Struct({
    ...featureIdentity,
    type: Schema.Literal("boolean"),
    consumable: Schema.Literal(false),
  }),
]);
const featureProjection = (value: GetFeatureResponse, account: string) =>
  Schema.decodeUnknownEffect(FeatureAttributes)({
    account,
    featureId: value.id,
    name: value.name,
    type: value.type,
    consumable: value.consumable,
    archived: value.archived,
  }).pipe(Effect.orDie);

/** Read drift, recover interrupted creates, and archive only on explicit destruction. */
export const autumnFeatureProvider = () =>
  Provider.effect(
    AutumnFeature,
    Effect.gen(function* () {
      const { api, account } = yield* client;
      const featureAttributes = (value: GetFeatureResponse) => featureProjection(value, account);
      const get = (id: string) =>
        optional(use("read feature", (signal) => api.features.get({ featureId: id }, { signal })));
      return {
        stables: ["featureId"],
        diff: Effect.fn(function* ({ news, output }) {
          if (output && output.account !== account)
            return yield* Effect.die(
              "Use a new billing stage for a different Autumn account or environment",
            );
          if (!isResolved(news) || !output) return undefined;
          // Compare provider metadata, including types absent from older Alchemy state.
          const current = yield* get(output.featureId);
          if (
            current === undefined ||
            news.featureId !== output.featureId ||
            news.type !== current.type ||
            news.consumable !== current.consumable
          )
            return { action: "replace" as const };
          if (news.name !== current.name || current.archived) return { action: "update" as const };
          return undefined;
        }),
        read: Effect.fn(function* ({ output, olds }) {
          if (output && output.account !== account)
            return yield* Effect.die(
              "Use a new billing stage for a different Autumn account or environment",
            );
          const id = output?.featureId ?? olds?.featureId;
          if (id === undefined) return undefined;
          const value = yield* get(id);
          return value === undefined ? undefined : yield* featureAttributes(value);
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          reserved(news.featureId);
          const current = yield* get(news.featureId);
          const props = { ...news } satisfies CreateFeatureParams;
          if (current && (current.type !== news.type || current.consumable !== news.consumable))
            return yield* Effect.die(
              "An existing Autumn feature has a different meaning; use a new ID",
            );
          if (current && !output && current.name !== news.name)
            return yield* Effect.die("Refusing to adopt an unrelated Autumn feature");
          if (!current)
            yield* use("create feature", (signal) => api.features.create(props, { signal }));
          else if (current.name !== news.name || current.archived)
            yield* use("update feature", (signal) =>
              api.features.update({ ...props, archived: false }, { signal }),
            );
          return yield* featureAttributes(
            yield* use("read feature", (signal) =>
              api.features.get({ featureId: news.featureId }, { signal }),
            ),
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* use("archive feature", (signal) =>
            api.features.update({ featureId: output.featureId, archived: true }, { signal }),
          );
        }),
      };
    }),
  );

const PlanItem = Schema.Struct({
  featureId: Schema.String,
  included: Schema.Number,
  unlimited: Schema.Boolean,
  reset: Schema.optionalKey(Schema.Struct({ interval: Schema.Literal("month") })),
  price: Schema.optionalKey(
    Schema.Struct({
      amount: Schema.Number,
      billingUnits: Schema.Number,
      billingMethod: Schema.Literal("usage_based"),
      interval: Schema.Literal("month"),
    }),
  ),
});
const Trial = Schema.Struct({
  durationLength: Schema.Number,
  durationType: Schema.Literal("day"),
  cardRequired: Schema.Boolean,
});
const PlanProps = Schema.Struct({
  planId: Schema.String,
  group: Schema.String,
  name: Schema.String,
  items: Schema.Array(PlanItem),
  freeTrial: Schema.NullOr(Trial),
});
/** The catalog owns only these plan fields, never customer subscriptions or migrations. */
export type AutumnPlanProps = typeof PlanProps.Type;
const PlanAttributes = Schema.Struct({
  ...PlanProps.fields,
  version: Schema.Number,
  archived: Schema.Boolean,
  autoEnable: Schema.Boolean,
  addOn: Schema.Boolean,
  hasBasePrice: Schema.Boolean,
  account: Schema.String,
});
/** Current provider version and the owned projection used to detect drift. */
export type AutumnPlanAttributes = typeof PlanAttributes.Type;
/** Declare a mutually exclusive V2 plan without making it a global default. */
export type AutumnPlan = Resource<"Executor.AutumnPlan", AutumnPlanProps, AutumnPlanAttributes>;
/** Plan lifetime is retained by the catalog stack. */
export const AutumnPlan = Resource<AutumnPlan>("Executor.AutumnPlan");
const planProjection = (value: GetPlanResponse, account: string) =>
  Schema.decodeUnknownEffect(PlanAttributes)({
    account,
    planId: value.id,
    group: value.group ?? "",
    name: value.name,
    version: value.version,
    archived: value.archived,
    autoEnable: value.autoEnable,
    addOn: value.addOn,
    hasBasePrice: value.price !== null,
    freeTrial: value.freeTrial
      ? {
          durationLength: value.freeTrial.durationLength,
          durationType: value.freeTrial.durationType,
          cardRequired: value.freeTrial.cardRequired,
        }
      : null,
    items: value.items.map((item) => ({
      featureId: item.featureId,
      included: item.included,
      unlimited: item.unlimited,
      ...(item.reset ? { reset: { interval: item.reset.interval } } : {}),
      ...(item.price
        ? {
            price: {
              amount: item.price.amount,
              billingUnits: item.price.billingUnits,
              billingMethod: item.price.billingMethod,
              interval: item.price.interval,
            },
          }
        : {}),
    })),
  }).pipe(Effect.orDie);
const samePlan = (props: AutumnPlanProps, current: AutumnPlanAttributes) =>
  props.name === current.name &&
  props.group === current.group &&
  isDeepStrictEqual(
    [...props.items].sort((a, b) => a.featureId.localeCompare(b.featureId)),
    [...current.items].sort((a, b) => a.featureId.localeCompare(b.featureId)),
  ) &&
  isDeepStrictEqual(props.freeTrial, current.freeTrial) &&
  !current.archived &&
  !current.autoEnable &&
  !current.addOn &&
  !current.hasBasePrice;

/** Updates create a new catalog version; existing customers are never migrated. */
export const autumnPlanProvider = () =>
  Provider.effect(
    AutumnPlan,
    Effect.gen(function* () {
      const { api, account } = yield* client;
      const planAttributes = (value: GetPlanResponse) => planProjection(value, account);
      const get = (id: string) =>
        optional(use("read plan", (signal) => api.plans.get({ planId: id }, { signal })));
      return {
        stables: ["planId"],
        diff: ({ news, output }) =>
          Effect.sync(() => {
            if (output && output.account !== account)
              throw new Error(
                "Use a new billing stage for a different Autumn account or environment",
              );
            if (!isResolved(news) || !output) return undefined;
            if (news.planId !== output.planId || news.group !== output.group)
              return { action: "replace" as const };
            return samePlan(news, output) ? undefined : { action: "update" as const };
          }),
        read: Effect.fn(function* ({ output, olds }) {
          if (output && output.account !== account)
            return yield* Effect.die(
              "Use a new billing stage for a different Autumn account or environment",
            );
          const id = output?.planId ?? olds?.planId;
          if (id === undefined) return undefined;
          const value = yield* get(id);
          return value === undefined ? undefined : yield* planAttributes(value);
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          reserved(news.planId);
          reserved(news.group);
          const current = yield* get(news.planId);
          if (current && !output && !samePlan(news, yield* planAttributes(current)))
            return yield* Effect.die("Refusing to adopt an unrelated Autumn plan");
          const props = { ...news, items: [...news.items], autoEnable: false, addOn: false };
          if (!current)
            yield* use("create plan", (signal) =>
              api.plans.create(
                {
                  ...props,
                  ...(news.freeTrial === null
                    ? { freeTrial: undefined }
                    : { freeTrial: news.freeTrial }),
                },
                { signal },
              ),
            );
          else if (!samePlan(news, yield* planAttributes(current)))
            yield* use("update plan", (signal) =>
              api.plans.update({ ...props, price: null }, { signal }),
            );
          return yield* planAttributes(
            yield* use("read plan", (signal) => api.plans.get({ planId: news.planId }, { signal })),
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* use("archive plan", (signal) =>
            api.plans.update({ planId: output.planId, archived: true }, { signal }),
          );
        }),
      };
    }),
  );

/** Both providers resolve the same explicitly selected Autumn environment. */
export const autumnProviders = () => Layer.mergeAll(autumnFeatureProvider(), autumnPlanProvider());
