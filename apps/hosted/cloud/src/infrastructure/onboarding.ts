import { BlobStore } from "@executor-js/sdk/core";
import { firstPartyOAuthClients } from "@executor-js/hosted-server";
import { cloudBlobs } from "./blobs.ts";
import { cloudSecrets, v1McpForwardSecret } from "./secrets.ts";
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
import type { V1SourceSettings } from "../implementation/v1-import/source.ts";
import { V1ImportWrites } from "../implementation/v1-import/writes.ts";
import { v1MovedFlagPostgres } from "../implementation/v1-import/moved-flag.ts";
import { v1ApiBlobs, v1R2Blobs } from "./v1-blobs.ts";
import {
  missingV1FirstPartyClient,
  missingV1ImportOperatorToken,
  missingV1LiveSetting,
  v1FirstPartyClientsSetting,
  v1ImportAccess,
  missingV1ImportWriter,
  missingV1McpForwardSecret,
  v1ImportOperatorTokenMinLength,
  v1ImportWriterName,
  v1LiveSettings,
} from "./v1-import-settings.ts";
import { autumnServer, billingSettings } from "./billing.ts";
import type { AutumnOptions } from "../contracts/autumn.ts";
import type { BillingCatalog } from "../contracts/billing-catalog.ts";
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
      setup: (userId, organization) =>
        service.pipe(
          Effect.flatMap((onboarding) => onboarding.setup(userId, organization)),
          Effect.provide(RuntimeContext.phantom),
          Effect.mapError(() => new OnboardingUnavailable()),
        ),
      gate: (userId, organization, progress) =>
        service.pipe(
          Effect.flatMap((onboarding) => onboarding.gate(userId, organization, progress)),
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
      } satisfies V1SourceSettings;
    }),
  );
});

/**
 * v1's production data for a dry run from local Cloud dev (`CLOUD_V1_IMPORT_SOURCE=live`), read-only:
 * its WorkOS, its database in read-only transactions on a session that defaults to them, its blob
 * bucket through Cloudflare's API with GET only, and its customers in Autumn's live account, read
 * with `customers.get`. Every credential is named apart from production's (`v1LiveSettings`).
 */
const cloudV1LiveSource = Effect.gen(function* () {
  const required = (name: string) =>
    Config.Redacted(name).pipe(
      Config.option,
      Effect.map(Option.filter((value) => configured(Redacted.value(value)))),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.die(new Error(missingV1LiveSetting(name))),
          onSome: Effect.succeed,
        }),
      ),
    );
  const workosKey = yield* required(v1LiveSettings.workosKey);
  const configuredDatabase = yield* required(v1LiveSettings.database);
  const autumnKey = yield* required(v1LiveSettings.autumnKey);
  const account = yield* required(v1LiveSettings.blobsAccount);
  const blobsToken = yield* required(v1LiveSettings.blobsToken);
  const database = yield* Effect.try(() => new URL(Redacted.value(configuredDatabase))).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (database === undefined || !/^postgres(?:ql)?:$/u.test(database.protocol))
    return yield* Effect.die(new Error(`${v1LiveSettings.database} must be a Postgres URL`));
  // Every transaction on the session is read-only unless one asks otherwise, and none does: each
  // read opens its own `set transaction read only` transaction as well.
  database.searchParams.set("options", "-c default_transaction_read_only=on");
  database.searchParams.set("sslmode", "verify-full");
  const settings: V1SourceSettings = {
    workosUrl: "https://api.workos.com",
    workosKey,
    database: Redacted.make(database.toString()),
    billing: { serverUrl: Redacted.make(autumnServer), secretKey: autumnKey },
    blobs: v1ApiBlobs(Redacted.value(account), blobsToken),
  };
  return Option.some<Effect.Effect<V1SourceSettings>>(Effect.succeed(settings));
});

/**
 * The URL of v1's `v1_import_writer` role (`V1_IMPORT_WRITER_DATABASE_URL`), which writes the
 * moved flag and nothing else (`moved-flag.ts`). Production requires it once imports write, and
 * stops without it; emulated Cloud takes a loopback URL and refuses imports without one.
 */
const v1ImportWriter = (production: boolean) =>
  Effect.gen(function* () {
    const value = (yield* Config.Redacted(v1ImportWriterName).pipe(Config.option)).pipe(
      Option.filter((url) => configured(Redacted.value(url))),
    );
    if (production) {
      if (Option.isNone(value)) return yield* Effect.die(new Error(missingV1ImportWriter));
      const database = yield* Effect.try(() => new URL(Redacted.value(value.value))).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (database === undefined || !/^postgres(?:ql)?:$/u.test(database.protocol))
        return yield* Effect.die(new Error(`${v1ImportWriterName} must be a Postgres URL`));
      // v1's PlanetScale database accepts only TLS; the live reads above set the same mode.
      database.searchParams.set("sslmode", "verify-full");
      return Option.some(Redacted.make(database.toString()));
    }
    if (Option.isNone(value)) return Option.none<Redacted.Redacted<string>>();
    return Option.some(
      yield* Schema.decodeUnknownEffect(LocalDatabaseUrl)(value.value).pipe(
        Effect.mapError(() => new Error(`${v1ImportWriterName} must be a loopback Postgres URL`)),
        Effect.orDie,
      ),
    );
  });

/** Where the v1 import runs on this deployment: what it reads, and who may start what. */
export interface V1ImportSettings {
  readonly source: Effect.Effect<V1SourceSettings>;
  /**
   * Which organizations an operator may import, writing v2: none without
   * `CLOUD_V1_IMPORT_WRITES`, and otherwise only those with a row in `private_v1_import_allowed`.
   */
  readonly writes: V1ImportWrites;
  /** Whether the source is v1's real data: production's, or the live source of a local dry run. */
  readonly realV1: boolean;
  /** The bearer token of the operator routes; without one nobody can start a run. */
  readonly operatorToken: Option.Option<Redacted.Redacted<string>>;
  /** v1's first-party OAuth client IDs, by v2 client name (`V1_FIRST_PARTY_CLIENT_IDS`). */
  readonly v1FirstPartyClients: Readonly<Record<string, string>>;
  /**
   * The key the suffixes of moved organizations' slugs are derived with: the deployment's signing
   * secret, so the suffixes cannot be predicted from the public code.
   */
  readonly slugKey: Effect.Effect<Redacted.Redacted<string>>;
  /**
   * How a step retries a failure before the run records it. Production waits out v1 and v2
   * outages for minutes; emulated Cloud's v1 has none to wait out, so it retries briefly.
   */
  readonly stepRetries: { readonly limit: number; readonly delaySeconds: number };
  /**
   * How long an import waits after freezing its organization in v1 before copying it. A minute on
   * v1's real data, longer than v1 takes to finish a token refresh it started before the flag;
   * emulated v1 runs no such requests.
   */
  readonly freezeSettleSeconds: number;
  /**
   * v2's Autumn and catalog, where a paid organization's v1 subscription carries over: the account
   * v1 billed in. None for the live source, whose v1 bills in another account than this Cloud.
   */
  readonly billing: Option.Option<
    Effect.Effect<{ readonly options: AutumnOptions; readonly catalog: BillingCatalog }>
  >;
}

/**
 * The v1 import (`notes/v1-import.md`): the `V1Import` Workflow and its operator routes.
 *
 * - Emulated Cloud with a v1 database (managed local Cloud) reads the emulated v1 WorkOS and its
 *   Vault, the v1 database (blobs from its `blob` table, as v1 keeps them without R2) and Autumn,
 *   and allows imports that write, of the organizations with a row in `private_v1_import_allowed`.
 * - Production runs it only when `CLOUD_V1_IMPORT=on` (`v1-import-settings.ts`, off by default).
 *   It then reads v1's WorkOS (`V1_WORKOS_API_KEY`, also the sign-in check's), v1's database
 *   through the read-only role (`V1_DATABASE_URL`), the Autumn account v2 bills from (v1 billed
 *   there too), and v1's blob bucket through the `V1_BLOBS` binding. It starts only dry runs
 *   unless `CLOUD_V1_IMPORT_WRITES=on` too, and then imports only the organizations with a row
 *   in `private_v1_import_allowed`, which only direct SQL writes (`writes.ts`).
 * - Local Cloud dev with `CLOUD_V1_IMPORT_SOURCE=live` reads v1's production data read-only
 *   (`cloudV1LiveSource`) and runs only dry runs. Any other stage or origin refuses the setting.
 * - Everywhere else, and on production while the switch is off, there is no importer. Another
 *   deployed stage refuses either switch: only production reaches v1.
 */
export const cloudV1ImportSettings = Effect.gen(function* () {
  const emulators = yield* cloudEmulators;
  const access = yield* v1ImportAccess(Option.isSome(emulators));
  const production = access.source === "production";
  const operatorToken = (yield* Config.Redacted("V1_IMPORT_OPERATOR_TOKEN").pipe(
    Config.option,
  )).pipe(Option.filter((value) => configured(Redacted.value(value))));
  if (
    production &&
    (Option.isNone(operatorToken) ||
      Redacted.value(operatorToken.value).length < v1ImportOperatorTokenMinLength)
  )
    return yield* Effect.die(new Error(missingV1ImportOperatorToken));
  const source =
    access.source === "production"
      ? yield* cloudV1ProductionSource
      : access.source === "live"
        ? yield* cloudV1LiveSource
        : access.source === "emulated"
          ? yield* cloudV1EmulatedSource(emulators)
          : Option.none<Effect.Effect<V1SourceSettings>>();
  const realV1 = access.realV1;
  // Read only where the importer runs, so a value elsewhere cannot stop the Worker.
  if (Option.isNone(source)) return Option.none<V1ImportSettings>();
  const v1FirstPartyClients = yield* v1FirstPartyClientsSetting;
  // The deploy stack checks this too (`alchemy.github.ts`); the Worker repeats it with the clients
  // it actually offers, so a deploy that skipped the stack cannot report every grant a mismatch.
  if (realV1) {
    const offered = yield* firstPartyOAuthClients({ testDefinitions: false }).pipe(Effect.orDie);
    const missing = offered.find((client) => !Object.hasOwn(v1FirstPartyClients, client.id));
    if (missing !== undefined)
      return yield* Effect.die(new Error(missingV1FirstPartyClient(missing.id)));
  }
  const writer = access.writes ? yield* v1ImportWriter(production) : Option.none();
  // An import cuts its organization over, after which v1 forwards its MCP requests here.
  if (production && access.writes && Option.isNone(yield* v1McpForwardSecret))
    return yield* Effect.die(new Error(missingV1McpForwardSecret));
  const writes = !access.writes
    ? V1ImportWrites.Refused({
        reason:
          access.source === "live"
            ? "The live v1 source runs only dry runs."
            : "This deployment does not allow v1 imports that write (CLOUD_V1_IMPORT_WRITES).",
      })
    : Option.isNone(writer)
      ? V1ImportWrites.Refused({ reason: missingV1ImportWriter })
      : access.source === "production" || access.source === "emulated"
        ? V1ImportWrites.Listed({ flag: v1MovedFlagPostgres(writer.value) })
        : V1ImportWrites.Refused({ reason: "This deployment has no v1 source that writes." });
  const secrets = yield* cloudSecrets.pipe(Effect.orDie);
  const billing = yield* billingSettings;
  return Option.some<V1ImportSettings>({
    source: source.value,
    writes,
    realV1,
    operatorToken,
    v1FirstPartyClients,
    slugKey: secrets.authSecret,
    stepRetries: realV1 ? { limit: 5, delaySeconds: 10 } : { limit: 2, delaySeconds: 1 },
    freezeSettleSeconds: realV1 ? 60 : 1,
    billing:
      access.source === "live"
        ? Option.none()
        : Option.some(
            Effect.all({
              options: Effect.all({ serverUrl: billing.serverUrl, secretKey: billing.secretKey }),
              catalog: billing.catalog,
            }),
          ),
  });
});
