import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type {
  BillingCatalogDeclaration,
  BillingPlanDeclaration,
} from "../contracts/billing-catalog.ts";

export class BillingCatalogSeedFailed extends Schema.TaggedError<BillingCatalogSeedFailed>()(
  "BillingCatalogSeedFailed",
  { status: Schema.optionalKey(Schema.Int) },
) {
  get message() {
    return "Could not provision the billing catalog on the configured Autumn endpoint";
  }
}

const seedPlan = (plan: BillingPlanDeclaration) => ({
  id: plan.planId,
  name: plan.name,
  group: plan.group,
  auto_enable: false,
  add_on: false,
  price: null,
  free_trial: plan.freeTrial
    ? {
        duration_length: plan.freeTrial.durationLength,
        duration_type: plan.freeTrial.durationType,
        card_required: plan.freeTrial.cardRequired,
      }
    : null,
  items: plan.items.map((item) => ({
    feature_id: item.featureId,
    included: item.included,
    unlimited: item.unlimited,
    ...(item.reset ? { reset: item.reset } : {}),
    ...(item.price
      ? {
          price: {
            amount: item.price.amount,
            interval: item.price.interval,
            billing_units: item.price.billingUnits,
            billing_method: item.price.billingMethod,
          },
        }
      : {}),
  })),
});

export const billingCatalogSeed = (declaration: BillingCatalogDeclaration) => ({
  features: Object.values(declaration.features).map((feature) => ({
    id: feature.featureId,
    name: feature.name,
    consumable: feature.consumable,
    type: feature.type,
  })),
  plans: Object.values(declaration.plans).map(seedPlan),
});

export const seedBillingCatalog = (
  serverUrl: Redacted.Redacted<string>,
  secretKey: Redacted.Redacted<string>,
  declaration: BillingCatalogDeclaration,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const request = yield* HttpClientRequest.post(
        `${Redacted.value(serverUrl).replace(/\/+$/, "")}/_emulate/seed`,
      ).pipe(
        HttpClientRequest.bearerToken(secretKey),
        HttpClientRequest.setHeader("accept", "application/json"),
        HttpClientRequest.bodyJson(billingCatalogSeed(declaration)),
        Effect.mapError(() => new BillingCatalogSeedFailed()),
      );
      const response = yield* HttpClient.withScope(http)
        .execute(request)
        .pipe(Effect.mapError(() => new BillingCatalogSeedFailed()));
      if (response.status < 200 || response.status >= 300)
        return yield* new BillingCatalogSeedFailed({ status: response.status });
    }),
  ).pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError(() => new BillingCatalogSeedFailed()),
    Effect.provide(FetchHttpClient.layer),
    Effect.withSpan("billing.provisionCatalog"),
  );
