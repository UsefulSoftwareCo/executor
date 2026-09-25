import { previewLifetime } from "./test-stage-expiry.ts";
/** Alchemy owns the controller, its zone-scoped token, and every runtime team DNS resource. */
import * as Cloudflare from "alchemy/Cloudflare";
import { RuntimeContext } from "alchemy";
import * as Output from "alchemy/Output";
import { Credentials, apiTokenCredentials } from "@distilled.cloud/cloudflare/Credentials";
import { appDomainCertificates } from "../implementation/app-domain-inventory.ts";
import { appDomainHttpClient } from "../implementation/app-domain-http.ts";
import { PgClient } from "@effect/sql-pg";
import { AppUiAddressInvalid } from "@executor-js/hosted-server/app-ui/contracts";
import { OrganizationId, OrganizationSlug } from "@executor-js/hosted-server";
import { UiFailed } from "apps/ui/contracts";
import { Cause, Clock, Effect, Layer, Redacted, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { timingSafeEqual } from "node:crypto";
import { cloudAppUiBase } from "../contracts/app-ui.ts";
import { appDomainState } from "../implementation/app-domain-state.ts";
import { reconcileAppDomainStack } from "../implementation/app-domain-stack.ts";
import { appDomainControllerToken, sharedAppDomainZone } from "./app-domain-zone.ts";
import { cloudDatabaseConnection } from "./database.ts";
import { appDomainControlSecret } from "./app-domain-control.ts";
import { AppDomainZoneSettings } from "../contracts/app-domains.ts";

const Team = Schema.Struct({ id: OrganizationId, slug: OrganizationSlug });
const DomainObservation = Schema.Struct({
  slug: OrganizationSlug,
  status: Schema.Literals(["pending", "ready", "failed"]),
  checkedAt: Schema.Number,
});

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

const makeAppDomainCoordinator = Effect.gen(function* () {
  const base = yield* cloudAppUiBase.pipe(Effect.orDie);
  if (base === undefined || new URL(base).protocol !== "https:") {
    return Effect.succeed({
      status: (_team: typeof Team.Type) => Effect.succeed("ready" as const),
      wake: () => Effect.void,
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
  return Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const lifetime = yield* previewLifetime;
    const lock = yield* Semaphore.make(1);
    const arm = (milliseconds: number) =>
      Effect.gen(function* () {
        if ((yield* lifetime.isBackgroundStopped) || (yield* state.storage.get<boolean>("stopped")))
          return;
        const due = (yield* Clock.currentTimeMillis) + milliseconds;
        const existing = yield* state.storage.getAlarm();
        if (existing === null || existing > due) yield* state.storage.setAlarm(due);
      });
    const applyTeams = (teams: ReadonlyArray<typeof Team.Type>) =>
      Effect.gen(function* () {
        const zone = yield* configuration;
        const apiToken = yield* secret;
        yield* reconcileAppDomainStack({
          stage: suffix,
          accountId: zone.accountId,
          zoneId: zone.id,
          zoneName: zone.domain,
          suffix,
          credentials: apiTokenCredentials({ apiToken: Redacted.value(apiToken) }),
          teams,
          state: appDomainState(state.raw.storage, "executor-team-domains", suffix),
        });
      }).pipe(
        Effect.withSpan("app_domains.dns", { attributes: { "app_domains.teams": teams.length } }),
        Effect.tapCause((cause) => observeDomainFailure("dns", cause)),
      );
    const reconcile = lock.withPermits(1)(
      Effect.scoped(
        Effect.gen(function* () {
          if (yield* state.storage.get<boolean>("stopped")) return;
          const zone = yield* configuration;
          if (suffix !== zone.domain && !suffix.endsWith(`.${zone.domain}`))
            return yield* Effect.die(new Error("App domain suffix is outside the managed zone"));
          const teams = yield* Effect.scoped(
            Effect.gen(function* () {
              const db = yield* PgClient.layer({
                url: yield* connection.connectionString,
                maxConnections: 1,
                prepare: false,
              }).pipe(Layer.build);
              const sql = yield* SqlClient.SqlClient.pipe(Effect.provideContext(db));
              return yield* sql`select id, slug from organization`.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Team))),
              );
            }),
          ).pipe(Effect.tapCause((cause) => observeDomainFailure("database", cause)));
          const valid = teams.filter((team) => `*.${team.slug}.${suffix}`.length <= 64);
          yield* Effect.annotateCurrentSpan("app_domains.teams", teams.length);
          const apiToken = yield* secret;
          yield* applyTeams(valid);
          const certificates =
            valid.length === 0
              ? []
              : yield* appDomainCertificates(zone.id).pipe(
                  Effect.provideService(
                    Credentials,
                    Effect.succeed(apiTokenCredentials({ apiToken: Redacted.value(apiToken) })),
                  ),
                  Effect.provide(appDomainHttpClient),
                  Effect.withSpan("app_domains.certificates"),
                  Effect.tapCause((cause) => observeDomainFailure("certificates", cause)),
                );
          const now = yield* Clock.currentTimeMillis;
          yield* Effect.annotateCurrentSpan("app_domains.certificates", certificates.length);
          let pending = false;
          for (const team of teams) {
            const hostname = `*.${team.slug}.${suffix}`;
            const matching = Array.from(certificates).filter((certificate) =>
              certificate.hosts?.includes(hostname),
            );
            const ready = matching.some(
              (pack) =>
                pack.status === "active" &&
                pack.certificates.some(
                  (certificate) =>
                    certificate.status === "active" &&
                    certificate.hosts.includes(hostname) &&
                    certificate.expiresOn !== undefined &&
                    certificate.expiresOn !== null &&
                    Date.parse(certificate.expiresOn) > now,
                ),
            );
            const failed =
              hostname.length > 64 ||
              matching.some((certificate) => certificate.status === "validation_timed_out");
            const status = ready
              ? ("ready" as const)
              : failed
                ? ("failed" as const)
                : ("pending" as const);
            pending ||= status === "pending";
            yield* state.storage.put(`team:${team.id}`, {
              slug: team.slug,
              status,
              checkedAt: now,
            });
          }
          yield* state.storage.delete("reconcileError");
          const ids = new Set(teams.map((team) => `team:${team.id}`));
          for (const key of (yield* state.storage.list({ prefix: "team:" })).keys()) {
            if (!ids.has(key)) yield* state.storage.delete(key);
          }
          yield* arm(pending ? 15_000 : 300_000);
        }),
      ).pipe(
        // A provider can wait five minutes after HTTP 429. Release the lock so
        // a deployment can stop this controller and drain its durable journal.
        Effect.timeout("60 seconds"),
        Effect.withSpan("app_domains.reconcile"),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* observeDomainFailure("reconcile", cause);
            yield* state.storage.put("reconcileError", true);
            yield* arm(30_000);
          }),
        ),
      ),
    );
    return {
      status: (input: typeof Team.Type) =>
        Effect.gen(function* () {
          const team = yield* Schema.decodeUnknownEffect(Team)(input);
          if (yield* state.storage.get<boolean>("stopped")) return "failed" as const;
          if (`*.${team.slug}.${suffix}`.length > 64) return "too_long" as const;
          const saved = yield* state.storage.get(`team:${team.id}`);
          const observation =
            saved === undefined
              ? undefined
              : yield* Schema.decodeUnknownEffect(DomainObservation)(saved);
          if (
            observation === undefined ||
            observation.slug !== team.slug ||
            observation.checkedAt + 300_000 < (yield* Clock.currentTimeMillis)
          ) {
            // Coalesce concurrent first visits before reading and applying the desired set.
            yield* arm(1_000);
            if (yield* state.storage.get<boolean>("reconcileError")) return "failed" as const;
            return "pending" as const;
          }
          if (observation.status !== "ready") yield* arm(15_000);
          return observation.status;
        }),
      wake: () => arm(1_000),
      drain: () =>
        Effect.gen(function* () {
          // Stop new work before waiting for an in-flight reconciliation.
          // Queued alarms must not win the lock and start provisioning again.
          yield* state.storage.put("stopped", true);
          yield* state.storage.deleteAlarm();
          yield* lock.withPermits(1)(applyTeams([]));
        }),
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
          yield* state.storage.setAlarm((yield* Clock.currentTimeMillis) + 60_000);
          yield* reconcile;
        }),
    };
  });
}).pipe(Effect.orDie);

/** A single durable object serializes desired-state reconciliation for this deployed stage. */
export class AppDomainCoordinator extends Cloudflare.DurableObject<
  AppDomainCoordinator,
  Effect.Success<Effect.Success<typeof makeAppDomainCoordinator>>
>()("AppDomainCoordinator") {}

/** The API owns this object and its Alchemy resource journal. */
export const AppDomainCoordinatorLive = AppDomainCoordinator.make(makeAppDomainCoordinator);

/** Requests wake provisioning immediately; cron also discovers teams created without opening an app. */
export const cloudAppDomains = Effect.gen(function* () {
  const coordinator = yield* AppDomainCoordinator;
  const controlSecret = yield* (yield* appDomainControlSecret).text;
  const wake = Effect.suspend(() => coordinator.getByName("domains").wake()).pipe(
    Effect.provide(RuntimeContext.phantom),
  );
  yield* Cloudflare.Workers.cron("* * * * *", () =>
    wake.pipe(Effect.catchCause(() => Effect.logError("App domain heartbeat failed"))),
  );
  const status = (team: typeof Team.Type) =>
    Effect.suspend(() => coordinator.getByName("domains").status(team)).pipe(
      Effect.provide(RuntimeContext.phantom),
      Effect.mapError(() => new UiFailed({ reason: "unavailable" })),
      // Expected domain outcomes must survive the Durable Object's RPC serialization.
      Effect.flatMap((status) =>
        status === "too_long"
          ? Effect.fail(new AppUiAddressInvalid({ reason: "too_long" }))
          : Effect.succeed(status),
      ),
    );
  const control = (operation: "resume" | "drain") =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const expected = Buffer.from(`Bearer ${Redacted.value(yield* controlSecret)}`);
      const supplied = Buffer.from(request.headers.authorization ?? "");
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        return HttpServerResponse.empty({ status: 404 });
      yield* coordinator.getByName("domains")[operation]();
      return HttpServerResponse.empty({ status: 204 });
    }).pipe(Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty({ status: 503 }))));
  return { status, control };
});
