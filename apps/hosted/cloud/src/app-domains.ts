/**
 * Private entry point for the app domain controller. A coordinator that wakes in a fresh isolate
 * loads and initializes only this Worker, not the API with its routes, auth and executor.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import { Credentials, apiTokenCredentials } from "@distilled.cloud/cloudflare/Credentials";
import { PgClient } from "@effect/sql-pg";
import { Cause, Clock, DateTime, Effect, Layer, Redacted, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import { cloudAppUiBase } from "./contracts/app-ui.ts";
import { AppDomainZoneSettings } from "./contracts/app-domains.ts";
import {
  appDomainCertificates,
  type HostCertificates,
} from "./implementation/app-domain-inventory.ts";
import { writeAppDomainRecords } from "./implementation/app-domain-records.ts";
import { appDomainHttpClient } from "./implementation/app-domain-http.ts";
import { appDomainJournal, appDomainState } from "./implementation/app-domain-state.ts";
import {
  appDomainShard,
  reconcileAppDomainStack,
  teamDomainShard,
} from "./implementation/app-domain-stack.ts";
import { AppDomainController } from "./infrastructure/app-domain-controller-worker.ts";
import { AppDomainCoordinator, AppDomainDrainFailed, Team } from "./infrastructure/app-domains.ts";
import { appDomainControllerToken, sharedAppDomainZone } from "./infrastructure/app-domain-zone.ts";
import { cloudDatabaseConnection } from "./infrastructure/database.ts";
import { previewLifetime } from "./infrastructure/test-stage-expiry.ts";
import {
  cloudObservability,
  cloudTelemetry,
  telemetryBindings,
} from "./infrastructure/telemetry.ts";

const observeDomainFailure = (phase: string, cause: Cause.Cause<unknown>) =>
  Effect.logError("App domain operation failed", {
    phase,
    errors: Cause.prettyErrors(cause).map((error) => ({
      type: /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(error.name) ? error.name : "Error",
      summary: error.message
        .split("\n", 1)[0]
        ?.replace(/"[^"\n]*"|'[^'\n]*'/g, "<value>")
        .replace(/[A-Za-z0-9._~+/=-]{16,}/g, "<value>")
        .slice(0, 180),
      service: /^Service not found: ([A-Za-z0-9_/:. -]+)/.exec(error.message)?.[1],
      frames: (error.stack ?? "")
        .split("\n")
        .slice(1)
        .filter((line) => /^\s+at [A-Za-z0-9_.$<>]+ \([^\s?]+\.js:\d+:\d+\)$/.test(line))
        .slice(0, 4),
    })),
  });

/** Teams per plan. One stack of about 5,000 teams exhausted the coordinator's isolate memory. */
const teamsPerPass = 500;

/**
 * A provider can wait five minutes after HTTP 429. Bound every step that holds the lock, so a
 * deployment can stop this controller and drain its durable journal.
 */
const stepTimeout = "60 seconds";

/**
 * The certificate inventory runs without the lock and reads up to 6,000 packs in about the time of
 * one page. The bound ends a stalled read, so the pass fails and is retried.
 */
const inventoryTimeout = "5 minutes";

const makeAppDomainCoordinator = Effect.gen(function* () {
  const base = yield* cloudAppUiBase.pipe(Effect.orDie);
  if (base === undefined || new URL(base).protocol !== "https:") {
    return Effect.succeed({
      wake: () => Effect.void,
      heartbeat: () => Effect.void,
      alarm: () => Effect.void,
      drain: () => Effect.void,
      resume: () => Effect.void,
    });
  }
  const suffix = new URL(base).hostname;
  const zone = yield* sharedAppDomainZone;
  // Mapped-output defaults include function source, which changes under minification.
  const zoneBinding = yield* Output.named(
    zone.pipe(Output.map((value) => value.zone)),
    "AppDomainZoneSettings",
  );
  const configuration = zoneBinding.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AppDomainZoneSettings)),
  );
  const tokenBinding = yield* Output.named(
    yield* appDomainControllerToken,
    "AppDomainControllerToken",
  );
  const secret = tokenBinding.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Redacted(Schema.NonEmptyString))),
  );
  const connection = yield* cloudDatabaseConnection;
  // Read during initialization, so deployment binds the preview's deadline and policy here too.
  const lifetime = yield* previewLifetime;
  /** One short-lived connection per use; the coordinator holds none between passes. */
  const withDatabase = <A, E, R>(use: Effect.Effect<A, E, R | SqlClient.SqlClient>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* PgClient.layer({
          url: yield* connection.connectionString,
          maxConnections: 1,
          prepare: false,
        }).pipe(Layer.build);
        return yield* use.pipe(Effect.provideContext(db));
      }),
    ).pipe(Effect.tapCause((cause) => observeDomainFailure("database", cause)));
  return Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const lock = yield* Semaphore.make(1);
    const arm = (milliseconds: number) =>
      Effect.gen(function* () {
        if ((yield* lifetime.isBackgroundStopped) || (yield* state.storage.get<boolean>("stopped")))
          return;
        const now = yield* Clock.currentTimeMillis;
        const due = now + milliseconds;
        const existing = yield* state.storage.getAlarm();
        // An alarm whose retries ran out can stay in the past without ever firing again.
        if (existing === null || existing > due || existing < now - 60_000)
          yield* state.storage.setAlarm(due);
      });
    /**
     * One plan and apply per group of teams. A plan holds every resource in its stack in memory,
     * so a single stack for every team ran out of isolate memory. Run the returned passes in order
     * while holding the lock: they share the journal read here.
     */
    const dnsPasses = (teams: ReadonlyArray<typeof Team.Type>) =>
      Effect.gen(function* () {
        const zone = yield* configuration;
        const apiToken = yield* secret;
        const journal = yield* appDomainJournal(state.raw.storage);
        const count = Math.max(1, Math.ceil(Math.max(teams.length, journal.size) / teamsPerPass));
        return Array.from({ length: count }, (_, shard) => {
          const shardTeams = teams.filter((team) => teamDomainShard(team, count) === shard);
          return reconcileAppDomainStack({
            stage: suffix,
            accountId: zone.accountId,
            zoneId: zone.id,
            zoneName: zone.domain,
            suffix,
            credentials: apiTokenCredentials({ apiToken: Redacted.value(apiToken) }),
            teams: shardTeams,
            state: appDomainState(
              state.raw.storage,
              journal,
              (fqn) => appDomainShard(fqn, count) === shard,
              "executor-team-domains",
              suffix,
            ),
          }).pipe(
            Effect.withSpan("app_domains.dns", {
              attributes: {
                "app_domains.teams": shardTeams.length,
                "app_domains.shard": shard,
                "app_domains.shards": count,
              },
            }),
            Effect.tapCause((cause) => observeDomainFailure("dns", cause)),
          );
        });
      }).pipe(Effect.tapCause((cause) => observeDomainFailure("dns", cause)));
    const addressable = (team: typeof Team.Type) => `*.${team.slug}.${suffix}`.length <= 64;
    /**
     * Read the desired teams and apply their DNS records. Holds the lock, because the passes read
     * and write the journal; returns nothing once a drain has stopped this object.
     */
    const provision = lock.withPermits(1)(
      Effect.gen(function* () {
        if (yield* state.storage.get<boolean>("stopped")) return undefined;
        const zone = yield* configuration;
        if (suffix !== zone.domain && !suffix.endsWith(`.${zone.domain}`))
          return yield* Effect.die(new Error("App domain suffix is outside the managed zone"));
        const teams = yield* withDatabase(
          Effect.flatMap(SqlClient.SqlClient, (sql) =>
            sql`select id, slug from organization`.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Team))),
            ),
          ),
        ).pipe(Effect.timeout(stepTimeout));
        for (const pass of yield* dnsPasses(teams.filter(addressable))) {
          // A drain marks the object stopped, then waits for the lock this pass holds.
          if (yield* state.storage.get<boolean>("stopped")) return undefined;
          yield* pass.pipe(Effect.timeout(stepTimeout));
        }
        return teams;
      }),
    );
    const reconcile = Effect.scoped(
      Effect.gen(function* () {
        const teams = yield* provision;
        if (teams === undefined || (yield* state.storage.get<boolean>("stopped"))) return undefined;
        yield* Effect.annotateCurrentSpan("app_domains.teams", teams.length);
        // Certificates and records are observations outside the journal, so they run without the
        // lock: a drain or resume waits only for DNS work, and the inventory, which grows with the
        // zone, is not held to the bound of a step under the lock.
        const zone = yield* configuration;
        const apiToken = yield* secret;
        const certificates = !teams.some(addressable)
          ? new Map<string, HostCertificates>()
          : yield* appDomainCertificates(zone.id).pipe(
              Effect.provideService(
                Credentials,
                Effect.succeed(apiTokenCredentials({ apiToken: Redacted.value(apiToken) })),
              ),
              Effect.provide(appDomainHttpClient),
              Effect.withSpan("app_domains.certificates"),
              Effect.tapCause((cause) => observeDomainFailure("certificates", cause)),
              Effect.timeout(inventoryTimeout),
            );
        yield* Effect.annotateCurrentSpan("app_domains.certificate_hosts", certificates.size);
        const records = teams.map((team) => {
          const hostname = `*.${team.slug}.${suffix}`;
          const observed = certificates.get(hostname);
          const status = observed?.ready
            ? ("ready" as const)
            : !addressable(team) || observed?.failed
              ? ("failed" as const)
              : ("pending" as const);
          return { organization: team.id, slug: team.slug, status };
        });
        // A drain that started during the inventory is tearing the stage down; write nothing more.
        if (yield* state.storage.get<boolean>("stopped")) return undefined;
        const now = yield* Clock.currentTimeMillis;
        yield* withDatabase(writeAppDomainRecords(records, DateTime.makeUnsafe(now))).pipe(
          Effect.timeout(stepTimeout),
        );
        // Observations moved to the database; remove the copies this object used to keep.
        // Remove this cleanup in a later release, once every stage has completed a pass.
        yield* state.storage.delete("reconcileError");
        const legacy = Array.from((yield* state.storage.list({ prefix: "team:" })).keys());
        if (legacy.length > 0) yield* state.storage.delete(legacy);
        return records.some((record) => record.status === "pending") ? 15_000 : 300_000;
      }),
    ).pipe(
      Effect.withSpan("app_domains.reconcile"),
      Effect.catchCause((cause) =>
        observeDomainFailure("reconcile", cause).pipe(Effect.as(30_000)),
      ),
    );
    return {
      wake: () => arm(1_000),
      heartbeat: () => arm(300_000),
      drain: () =>
        Effect.gen(function* () {
          // Stop new work before waiting for an in-flight reconciliation.
          // Queued alarms must not win the lock and start provisioning again.
          yield* state.storage.put("stopped", true);
          yield* state.storage.deleteAlarm();
          yield* lock.withPermits(1)(
            Effect.flatMap(dnsPasses([]), (passes) => Effect.forEach(passes, (pass) => pass)),
          );
        }).pipe(Effect.mapError(() => new AppDomainDrainFailed())),
      resume: () =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            yield* state.storage.put("stopped", false);
            yield* arm(1);
          }),
        ),
      alarm: () =>
        Effect.gen(function* () {
          if (yield* lifetime.isBackgroundStopped) {
            yield* state.storage.deleteAlarm();
            return;
          }
          // Retries an interrupted pass. A completed pass replaces it with its own schedule,
          // unless a caller asked for an earlier pass meanwhile.
          const retry = (yield* Clock.currentTimeMillis) + 60_000;
          yield* state.storage.setAlarm(retry);
          const next = yield* reconcile;
          if ((yield* state.storage.getAlarm()) === retry) yield* state.storage.deleteAlarm();
          if (next !== undefined) yield* arm(next);
        }),
    };
  });
}).pipe(Effect.orDie);

const AppDomainCoordinatorLive = AppDomainCoordinator.make(makeAppDomainCoordinator);

export default AppDomainController.make(
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url };
    return {
      main: import.meta.url,
      ...(yield* cloudObservability),
      workersDev: false,
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat", "no_brotli_content_encoding"] },
      env: yield* telemetryBindings,
    };
  }),
  Effect.succeed({}).pipe(Effect.provide(Layer.mergeAll(AppDomainCoordinatorLive, cloudTelemetry))),
);
