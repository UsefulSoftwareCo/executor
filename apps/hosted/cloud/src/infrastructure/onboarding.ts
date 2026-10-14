import { BlobStore } from "@executor-js/sdk/core";
import { cloudBlobs } from "./blobs.ts";
import { cloudOrigin, productionStage, stageName } from "./stage.ts";
import { PgClient } from "@effect/sql-pg";
import { RuntimeContext } from "alchemy";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Config, Effect, Layer, Option, Redacted, Schema } from "effect";
import { cloudEmulators } from "./emulators.ts";
import type { EmulatedServices } from "../contracts/emulators.ts";
import { FetchHttpClient } from "effect/http";
import { Onboarding, OnboardingUnavailable, TeamIconNotFound } from "../contracts/onboarding.ts";
import { companyLookupLive } from "../implementation/company-profile.ts";
import { makeOnboarding } from "../implementation/onboarding.ts";
import {
  v1MembershipDisabled,
  v1MembershipLive,
  type V1MembershipSettings,
} from "../implementation/v1-membership.ts";
import { LocalDatabaseUrl } from "../contracts/database.ts";
import { V1Import, V1ImportUnavailable } from "../contracts/v1-import.ts";
import { makeV1Import, v1ImportDisabled } from "../implementation/v1-import/service.ts";
import type { V1SourceSettings } from "../implementation/v1-import/source.ts";
import { v1R2Blobs } from "./v1-blobs.ts";
import {
  v1DashboardOrigin,
  v1ImportOnlyProduction,
  v1ImportSetting,
} from "./v1-import-settings.ts";
import { billingSettings } from "./billing.ts";
import { cloudDatabaseConnection, v1DatabaseConnection } from "./database.ts";
import {
  CheckSince,
  missingV1MembershipCheckSince,
  missingV1PlanetscaleDatabase,
  missingV1WorkosKey,
} from "./v1-membership-settings.ts";

const configured = (value: string) => value !== "";

/**
 * v1's Postgres, as an accessor for the connection string. Production reads it through its
 * read-only PlanetScale role (`v1DatabaseConnection`). Emulated Cloud may instead name a
 * loopback database in `V1_DATABASE_URL`. Other deployed stages have none.
 */
const cloudV1Database = (production: boolean, emulated: boolean) =>
  Effect.gen(function* () {
    if (production) return Option.some(yield* v1DatabaseConnection);
    if (!emulated) return Option.none();
    const local = (yield* Config.Redacted("V1_DATABASE_URL").pipe(Config.option)).pipe(
      Option.filter((value) => configured(Redacted.value(value))),
    );
    if (Option.isNone(local)) return Option.none();
    const url = yield* Schema.decodeUnknownEffect(LocalDatabaseUrl)(local.value).pipe(
      Effect.mapError(() => new Error("V1_DATABASE_URL must be a loopback Postgres URL")),
      Effect.orDie,
    );
    return Option.some(Effect.succeed(url));
  });

/**
 * GitHub Actions passes an unset secret or variable as an empty string, so empty means unset.
 * Production (`v2`) requires v1's WorkOS key, `V1_MEMBERSHIP_CHECK_SINCE` and the name of v1's
 * PlanetScale database, and refuses to deploy without them. Only production reaches v1's
 * database, so other deployed stages refuse v1's real key. Emulated Cloud checks the WorkOS emulator only where it also has a v1 database
 * (`V1_DATABASE_URL`, managed local Cloud), and then requires the cutoff: without it, accounts
 * that already used v2 could be stopped. Anywhere else the check is off. Self-host never
 * composes this module. Returns the settings to read inside each invocation.
 */
const cloudV1Membership = (
  emulators: Option.Option<Redacted.Redacted<typeof EmulatedServices.Type>>,
) =>
  Effect.gen(function* () {
    const production = Option.getOrUndefined(yield* stageName) === productionStage;
    const configuredKey = (yield* Config.Redacted("V1_WORKOS_API_KEY").pipe(Config.option)).pipe(
      Option.filter((value) => configured(Redacted.value(value))),
    );
    const since = (yield* Config.String("V1_MEMBERSHIP_CHECK_SINCE").pipe(Config.option)).pipe(
      Option.filter(configured),
    );
    if (production && Option.isNone(configuredKey))
      return yield* Effect.die(new Error(missingV1WorkosKey));
    if (production && Option.isNone(since))
      return yield* Effect.die(new Error(missingV1MembershipCheckSince));
    const database = yield* cloudV1Database(production, Option.isSome(emulators));
    const key = Option.isSome(emulators)
      ? Option.some({
          baseUrl: Redacted.value(emulators.value).workos.baseUrl,
          key: Redacted.make(Redacted.value(emulators.value).workos.token),
        })
      : Option.map(configuredKey, (value) => ({ baseUrl: "https://api.workos.com", key: value }));
    if (Option.isNone(key)) return Option.none();
    if (Option.isNone(database)) {
      if (Option.isSome(emulators)) return Option.none();
      return yield* Effect.die(
        new Error("Only production reaches v1's database; unset V1_WORKOS_API_KEY on this stage"),
      );
    }
    if (Option.isNone(since))
      return yield* Effect.die(
        new Error("Set V1_MEMBERSHIP_CHECK_SINCE with v1's WorkOS key to enable the v1 check"),
      );
    const cutoff = yield* Schema.decodeUnknownEffect(CheckSince)(since.value).pipe(
      Effect.catch(() =>
        Effect.die(
          new Error(
            production
              ? missingV1MembershipCheckSince
              : "V1_MEMBERSHIP_CHECK_SINCE must be an ISO 8601 UTC timestamp",
          ),
        ),
      ),
    );
    // v1 billed each WorkOS organization in the same Autumn account v2 bills from.
    const billing = yield* billingSettings;
    return Option.some(
      Effect.gen(function* () {
        return {
          ...key.value,
          since: cutoff,
          database: yield* database.value,
          billing: { serverUrl: yield* billing.serverUrl, secretKey: yield* billing.secretKey },
        } satisfies V1MembershipSettings;
      }),
    );
  });

/** Resolve the secret at composition; each request owns its SQL client and company request. */
export const cloudOnboarding = Effect.gen(function* () {
  const blobs = yield* cloudBlobs;
  const origin = yield* cloudOrigin;
  const emulators = yield* cloudEmulators;
  const lookup = Option.isSome(emulators)
    ? companyLookupLive(
        Redacted.make(Redacted.value(emulators.value).company.token),
        `${Redacted.value(emulators.value).company.baseUrl}/v1/brand/retrieve`,
      )
    : companyLookupLive(yield* Config.Redacted("CONTEXT_DEV_API_KEY"));
  const v1Settings = yield* cloudV1Membership(emulators);
  const connection = yield* cloudDatabaseConnection;
  const service = yield* makeExecutionMemo(
    Effect.gen(function* () {
      const url = yield* connection.connectionString;
      const services = yield* Layer.build(
        PgClient.layer({ url, maxConnections: 1, prepare: false }),
      );
      const v1 = Option.isSome(v1Settings)
        ? v1MembershipLive(yield* v1Settings.value)
        : v1MembershipDisabled;
      return yield* makeOnboarding({ origin }).pipe(
        Effect.provideService(BlobStore, blobs),
        Effect.provideContext(services),
        Effect.provide(Layer.mergeAll(lookup, v1).pipe(Layer.provide(FetchHttpClient.layer))),
      );
    }),
  );
  return Layer.succeed(
    Onboarding,
    Onboarding.of({
      icon: (userId, owner, key) =>
        service.pipe(
          Effect.flatMap((onboarding) => onboarding.icon(userId, owner, key)),
          Effect.provide(RuntimeContext.phantom),
          Effect.mapError((error) =>
            Schema.is(TeamIconNotFound)(error) ? error : new OnboardingUnavailable(),
          ),
        ),
      prepare: (userId) =>
        service.pipe(
          Effect.flatMap((onboarding) => onboarding.prepare(userId)),
          Effect.provide(RuntimeContext.phantom),
          Effect.mapError(() => new OnboardingUnavailable()),
        ),
      allowsOrganization: (userId) =>
        service.pipe(
          Effect.flatMap((onboarding) => onboarding.allowsOrganization(userId)),
          Effect.provide(RuntimeContext.phantom),
          Effect.mapError(() => new OnboardingUnavailable()),
        ),
      create: (userId, details) =>
        service.pipe(
          Effect.flatMap((onboarding) => onboarding.create(userId, details)),
          Effect.provide(RuntimeContext.phantom),
          Effect.mapError(() => new OnboardingUnavailable()),
        ),
    }),
  );
});

/** Emulated Cloud's v1: the WorkOS emulator, a loopback v1 database and its `blob` table. */
const cloudV1EmulatedSource = (
  emulators: Option.Option<Redacted.Redacted<typeof EmulatedServices.Type>>,
) =>
  Effect.gen(function* () {
    const database = yield* cloudV1Database(false, Option.isSome(emulators));
    if (Option.isNone(emulators) || Option.isNone(database))
      return Option.none<Effect.Effect<V1SourceSettings>>();
    const workos = Redacted.value(emulators.value).workos;
    const billing = yield* billingSettings;
    const connection = database.value;
    return Option.some<Effect.Effect<V1SourceSettings>>(
      Effect.gen(function* () {
        return {
          workosUrl: workos.baseUrl,
          workosKey: Redacted.make(workos.token),
          database: yield* connection,
          billing: { serverUrl: yield* billing.serverUrl, secretKey: yield* billing.secretKey },
          blobs: "postgres",
          dashboardOrigin: v1DashboardOrigin,
        } satisfies V1SourceSettings;
      }),
    );
  });

/** Production's v1, read-only: its WorkOS, its database role, Autumn and its blob bucket. */
const cloudV1ProductionSource = Effect.gen(function* () {
  const key = (yield* Config.Redacted("V1_WORKOS_API_KEY").pipe(Config.option)).pipe(
    Option.filter((value) => configured(Redacted.value(value))),
  );
  if (Option.isNone(key)) return yield* Effect.die(new Error(missingV1WorkosKey));
  const database = yield* cloudV1Database(true, false);
  if (Option.isNone(database)) return yield* Effect.die(new Error(missingV1PlanetscaleDatabase));
  const connection = database.value;
  const billing = yield* billingSettings;
  const blobs = yield* v1R2Blobs;
  return Option.some<Effect.Effect<V1SourceSettings>>(
    Effect.gen(function* () {
      return {
        workosUrl: "https://api.workos.com",
        workosKey: key.value,
        database: yield* connection,
        billing: { serverUrl: yield* billing.serverUrl, secretKey: yield* billing.secretKey },
        blobs,
        dashboardOrigin: v1DashboardOrigin,
      } satisfies V1SourceSettings;
    }),
  );
});

/**
 * The v1 import (`notes/v1-import.md`). It copies the workspace: v1 keeps working, and the v1
 * moved flag is not used.
 *
 * - Emulated Cloud with a v1 database (managed local Cloud) reads the emulated v1 WorkOS and its
 *   Vault, the v1 database (blobs from its `blob` table, as v1 keeps them without R2) and Autumn.
 * - Production runs it only when `CLOUD_V1_IMPORT=on` (`v1-import-settings.ts`, off by default).
 *   It then reads v1's WorkOS (`V1_WORKOS_API_KEY`, also the sign-in check's), v1's database
 *   through the read-only role (`V1_DATABASE_URL`), the Autumn account v2 bills from (v1 billed
 *   there too), and v1's blob bucket through the `V1_BLOBS` binding.
 * - Everywhere else, and on production while the switch is off, every request answers
 *   `V1ImportUnavailable`. Another deployed stage refuses `on`: only production reaches v1.
 */
export const cloudV1Import = Effect.gen(function* () {
  const emulators = yield* cloudEmulators;
  const production = Option.getOrUndefined(yield* stageName) === productionStage;
  const enabled = (yield* v1ImportSetting) === "on";
  if (enabled && !production && Option.isNone(emulators))
    return yield* Effect.die(new Error(v1ImportOnlyProduction));
  const source = production
    ? enabled
      ? yield* cloudV1ProductionSource
      : Option.none<Effect.Effect<V1SourceSettings>>()
    : yield* cloudV1EmulatedSource(emulators);
  if (Option.isNone(source)) return Layer.succeed(V1Import, v1ImportDisabled);
  const settings = source.value;
  const service = yield* makeExecutionMemo(
    Effect.gen(function* () {
      return yield* makeV1Import(yield* settings).pipe(Effect.provide(FetchHttpClient.layer));
    }),
  );
  const run =
    <A, E>(operation: (importer: typeof V1Import.Service) => Effect.Effect<A, E>) =>
    () =>
      service.pipe(
        Effect.mapError(() => new V1ImportUnavailable()),
        Effect.flatMap(operation),
        Effect.provide(RuntimeContext.phantom),
      );
  return Layer.succeed(
    V1Import,
    V1Import.of({
      choices: (request) => run((importer) => importer.choices(request))(),
      preview: (request, organization) =>
        run((importer) => importer.preview(request, organization))(),
      start: (request, organization, input) =>
        run((importer) => importer.start(request, organization, input))(),
      item: (request, organization, item) =>
        run((importer) => importer.item(request, organization, item))(),
      finish: (request, organization) =>
        run((importer) => importer.finish(request, organization))(),
    }),
  );
});
