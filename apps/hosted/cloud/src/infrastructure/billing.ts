import { Random } from "alchemy";
import * as Output from "alchemy/Output";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import { Stage } from "alchemy/Stage";
import {
  BillingCatalog,
  billingCatalogDeclaration,
  type BillingEnvironment,
} from "../contracts/billing-catalog.ts";
import { AutumnServerUrl } from "../contracts/autumn.ts";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { productionStage, testStage } from "./stage.ts";
import { cloudEmulators, testStageEmulatorHost } from "./emulators.ts";
import { seedBillingCatalog } from "./billing-catalog-seed.ts";

export const autumnServer = "https://api.useautumn.com";

export interface BillingSettings {
  readonly catalog: Effect.Effect<BillingCatalog>;
  readonly serverUrl: Effect.Effect<Redacted.Redacted<string>>;
  readonly secretKey: Effect.Effect<Redacted.Redacted<string>>;
}

const decodeServerUrl = (value: Redacted.Redacted<string>) =>
  Schema.decodeUnknownEffect(AutumnServerUrl)(Redacted.value(value)).pipe(
    Effect.mapError(() => new Error("AUTUMN_SERVER_URL is not an allowed HTTPS Autumn endpoint")),
    Effect.orDie,
    Effect.as(value),
  );

const assertCredentialEndpoint = (key: Redacted.Redacted<string>, serverUrl: string) =>
  Redacted.value(key).startsWith("am_sk_live_") && serverUrl !== autumnServer
    ? Effect.die("A live Autumn key may only be sent to api.useautumn.com")
    : Effect.void;

export const keyEnvironment = (key: Redacted.Redacted<string>) => {
  const value = Redacted.value(key);
  if (value.startsWith("am_sk_live_")) return Effect.succeed<BillingEnvironment>("live");
  if (value.startsWith("am_sk_test_")) return Effect.succeed<BillingEnvironment>("sandbox");
  return Effect.die("AUTUMN_SECRET_KEY must be an am_sk_test_ or am_sk_live_ Autumn key");
};

export const assertKeyEnvironment = (
  key: Redacted.Redacted<string>,
  environment: BillingEnvironment,
) =>
  keyEnvironment(key).pipe(
    Effect.flatMap((actual) =>
      actual === environment
        ? Effect.void
        : Effect.die(`A ${actual} Autumn key cannot serve the ${environment} billing catalog`),
    ),
  );

const instanceKey = (value: Redacted.Redacted<string>) =>
  Redacted.make(`am_sk_test_${Redacted.value(value)}`);

const configuredServerUrl = Config.NonEmptyString("AUTUMN_SERVER_URL").pipe(
  Config.option,
  Effect.flatMap((value) =>
    decodeServerUrl(Redacted.make(Option.getOrElse(value, () => autumnServer))),
  ),
);

const instanceUrl = (host: string, slug: string, instance: Redacted.Redacted<string>) =>
  Redacted.make(`${host}/autumn/executor-next-${slug}-${Redacted.value(instance)}`);

const billingEndpoint = Effect.gen(function* () {
  const context = yield* CurrentRuntimeContext;
  if (context === undefined)
    return yield* Effect.die("Billing requires an Alchemy runtime context");
  const catalog = Effect.gen(function* () {
    const value = yield* context.get<unknown>("EXECUTOR_BILLING_CATALOG");
    return yield* (
      typeof value === "string"
        ? Schema.decodeUnknownEffect(Schema.fromJsonString(BillingCatalog))(value)
        : Schema.decodeUnknownEffect(BillingCatalog)(value)
    ).pipe(Effect.orDie);
  });
  const emulators = yield* cloudEmulators;
  if (Option.isSome(emulators)) {
    const { billing } = Redacted.value(emulators.value);
    return {
      catalog,
      serverUrl: Effect.succeed(yield* decodeServerUrl(Redacted.make(billing.baseUrl))),
      secretKey: Effect.succeed(Redacted.make(billing.token)),
    } satisfies BillingSettings;
  }
  const stage = yield* testStage;
  if (Option.isSome(stage)) {
    const host = yield* testStageEmulatorHost;
    const { slug } = stage.value;
    const instance = yield* Random("BillingInstance", { bytes: 12 });
    const secret = yield* Random("BillingSecret");
    return {
      catalog,
      serverUrl: (yield* instance.text).pipe(
        Effect.flatMap((value) => decodeServerUrl(instanceUrl(host, slug, value))),
      ),
      secretKey: (yield* secret.text).pipe(Effect.map(instanceKey)),
    } satisfies BillingSettings;
  }
  const serverUrl = yield* configuredServerUrl;
  const secretKey = yield* Config.Redacted("AUTUMN_SECRET_KEY");
  yield* keyEnvironment(secretKey);
  yield* assertCredentialEndpoint(secretKey, Redacted.value(serverUrl));
  return {
    catalog,
    serverUrl: Effect.succeed(serverUrl),
    secretKey: Effect.succeed(secretKey),
  } satisfies BillingSettings;
});

export const billingSettings = billingEndpoint.pipe(
  Effect.map((settings): BillingSettings => ({
    ...settings,
    catalog: Effect.all([settings.catalog, settings.secretKey]).pipe(
      Effect.tap(([catalog, key]) => assertKeyEnvironment(key, catalog.environment)),
      Effect.map(([catalog]) => catalog),
    ),
  })),
);

export const billingBindings = Effect.gen(function* () {
  const stage = yield* Stage;
  const provision = (
    serverUrl: Output.Output<Redacted.Redacted<string>>,
    secretKey: Output.Output<Redacted.Redacted<string>>,
  ) => {
    const declaration = billingCatalogDeclaration(stage, "sandbox");
    return {
      EXECUTOR_BILLING_CATALOG: Output.all(serverUrl, secretKey).pipe(
        Output.mapEffect(([url, key]) =>
          seedBillingCatalog(url, key, declaration).pipe(
            Effect.orDie,
            Effect.as(JSON.stringify(declaration.catalog)),
          ),
        ),
      ),
    };
  };
  const emulators = yield* cloudEmulators.pipe(Effect.orDie);
  if (Option.isSome(emulators)) {
    const { billing } = Redacted.value(emulators.value);
    return provision(
      Output.asOutput(yield* decodeServerUrl(Redacted.make(billing.baseUrl))),
      Output.asOutput(Redacted.make(billing.token)),
    );
  }
  const test = yield* testStage.pipe(Effect.orDie);
  if (Option.isSome(test)) {
    const host = yield* testStageEmulatorHost;
    const { slug } = test.value;
    const instance = yield* Random("BillingInstance", { bytes: 12 });
    const secret = yield* Random("BillingSecret");
    return provision(
      instance.text.pipe(Output.map((value) => instanceUrl(host, slug, value))),
      secret.text.pipe(Output.map(instanceKey)),
    );
  }
  const serverUrl = yield* configuredServerUrl;
  const secretKey = yield* Config.Redacted("AUTUMN_SECRET_KEY");
  const environment = yield* keyEnvironment(secretKey);
  if (stage === productionStage && environment !== "live")
    return yield* Effect.die(`The ${productionStage} stage requires a live Autumn key`);
  yield* assertCredentialEndpoint(secretKey, Redacted.value(serverUrl));
  if (Redacted.value(serverUrl) !== autumnServer)
    return provision(Output.asOutput(serverUrl), Output.asOutput(secretKey));
  const catalog = yield* Output.stackRef<BillingCatalog>("executor-next-billing", {
    stage: environment === "live" ? `${stage}-live` : stage,
  });
  return {
    EXECUTOR_BILLING_CATALOG: catalog.pipe(
      Output.map((value) => {
        if (value.environment !== environment)
          throw new Error("Deploy the billing catalog for the selected Autumn account first");
        return JSON.stringify({
          environment: value.environment,
          namespace: value.namespace,
          members: value.members,
          domainVerification: value.domainVerification,
          free: value.free,
          team: value.team,
          enterprise: value.enterprise,
        } satisfies BillingCatalog);
      }),
    ),
  };
});
