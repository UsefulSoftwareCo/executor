/**
 * Autumn is configured by URL. The product never distinguishes the real provider from a private
 * drop-in instance: both answer the same API, and every stage runs the same admission, seat and
 * member-limit rules against whichever endpoint it was given.
 */
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

/** Autumn's own API. Every other allowed endpoint is a private instance of it. */
export const autumnServer = "https://api.useautumn.com";

export interface BillingSettings {
  /** Catalog identities for this stage. Billing has no meaning without them. */
  readonly catalog: Effect.Effect<BillingCatalog>;
  /** Autumn base URL. A private instance URL is a capability, like a credential. */
  readonly serverUrl: Effect.Effect<Redacted.Redacted<string>>;
  /** Autumn bearer key. */
  readonly secretKey: Effect.Effect<Redacted.Redacted<string>>;
}

/** The endpoint receives the Autumn bearer key on every call, so it is validated like one. */
const decodeServerUrl = (value: Redacted.Redacted<string>) =>
  Schema.decodeUnknownEffect(AutumnServerUrl)(Redacted.value(value)).pipe(
    Effect.mapError(() => new Error("AUTUMN_SERVER_URL is not an allowed HTTPS Autumn endpoint")),
    Effect.orDie,
    Effect.as(value),
  );

/** A production credential is only ever sent to Autumn itself. */
const assertCredentialEndpoint = (key: Redacted.Redacted<string>, serverUrl: string) =>
  Redacted.value(key).startsWith("am_sk_live_") && serverUrl !== autumnServer
    ? Effect.die("A live Autumn key may only be sent to api.useautumn.com")
    : Effect.void;

/**
 * An Autumn key names its environment in its prefix. A private instance is keyed like Autumn's
 * sandbox, so every endpoint is held to the same rule and any other credential shape is refused.
 */
export const keyEnvironment = (key: Redacted.Redacted<string>) => {
  const value = Redacted.value(key);
  if (value.startsWith("am_sk_live_")) return Effect.succeed<BillingEnvironment>("live");
  if (value.startsWith("am_sk_test_")) return Effect.succeed<BillingEnvironment>("sandbox");
  return Effect.die("AUTUMN_SECRET_KEY must be an am_sk_test_ or am_sk_live_ Autumn key");
};

/**
 * A sandbox key against a live catalog, or the reverse, would bill real customers against an
 * environment where their subscriptions do not exist. The catalog's environment is authoritative.
 */
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

/** A private instance accepts any bearer; its generated key carries the sandbox prefix. */
const instanceKey = (value: Redacted.Redacted<string>) =>
  Redacted.make(`am_sk_test_${Redacted.value(value)}`);

/** An unset or blank setting means Autumn itself, so an empty deployment variable is not a URL. */
const configuredServerUrl = Config.NonEmptyString("AUTUMN_SERVER_URL").pipe(
  Config.option,
  Effect.flatMap((value) =>
    decodeServerUrl(Redacted.make(Option.getOrElse(value, () => autumnServer))),
  ),
);

/** Each test stage addresses its own private instance path; nothing needs provisioning first. */
const instanceUrl = (host: string, slug: string, instance: Redacted.Redacted<string>) =>
  Redacted.make(`${host}/autumn/executor-next-${slug}-${Redacted.value(instance)}`);

const billingEndpoint = Effect.gen(function* () {
  // Resolve during initialization so Alchemy binds every value into the Worker environment.
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
    // Test-stage settings resolve at runtime, so the URL is assembled inside the accessor.
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

/** The catalog is only ever read together with the key that will serve it. */
export const billingSettings = billingEndpoint.pipe(
  Effect.map((settings): BillingSettings => ({
    ...settings,
    catalog: Effect.all([settings.catalog, settings.secretKey]).pipe(
      Effect.tap(([catalog, key]) => assertKeyEnvironment(key, catalog.environment)),
      Effect.map(([catalog]) => catalog),
    ),
  })),
);

/**
 * Provision the catalog this stage will read back at runtime.
 *
 * Autumn holds a retained catalog managed by the `executor-next-billing` stack, and the live
 * account keeps its own stage so sandbox subscriptions stay intact. Any other endpoint is a
 * private instance with no management API, so the deployment seeds the same declaration into it.
 */
export const billingBindings = Effect.gen(function* () {
  const stage = yield* Stage;
  const provision = (
    serverUrl: Output.Output<Redacted.Redacted<string>>,
    secretKey: Output.Output<Redacted.Redacted<string>>,
  ) => {
    // A throwaway instance uses the same seat limits and prices in a sandbox catalog.
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
  // Production bills real customers. Stop before anything is written rather than bind a sandbox.
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
