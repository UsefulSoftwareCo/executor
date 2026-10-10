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
import { billingSettings } from "./billing.ts";
import { cloudDatabaseConnection, v1DatabaseConnection } from "./database.ts";
import {
  CheckSince,
  missingV1MembershipCheckSince,
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
