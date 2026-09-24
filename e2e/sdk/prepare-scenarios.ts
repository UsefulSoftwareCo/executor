/** Provision selected Cloud organizations together before measuring their independent scenarios. */
import {
  Clock,
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
  Ref,
  Schedule,
  Schema,
  Scope,
  Semaphore,
} from "effect";
import { HttpClient, HttpClientError } from "effect/unstable/http";
import { randomBytes } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { SessionClients } from "../support/api.ts";
import { Target } from "../support/platform.ts";
import { PreparedScenarios } from "./contracts.ts";
import { startScenario } from "./scenario.ts";

class DomainNotReady extends Schema.TaggedError<DomainNotReady>()("DomainNotReady", {
  reason: Schema.Literals(["http", "transport", "timeout"]),
  status: Schema.optional(Schema.Number),
  code: Schema.optional(Schema.String),
}) {}
const TransportDiagnostic = Schema.Struct({
  code: Schema.optional(
    Schema.Literals([
      "ENOTFOUND",
      "EAI_AGAIN",
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "CERT_HAS_EXPIRED",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
      "ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE",
      "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR",
    ]),
  ),
  cause: Schema.optional(Schema.Unknown),
});
const transportCode = (cause: unknown, depth = 0): string | undefined => {
  if (depth > 3) return undefined;
  const parsed = Schema.decodeUnknownOption(TransportDiagnostic)(cause);
  return Option.isNone(parsed)
    ? undefined
    : (parsed.value.code ?? transportCode(parsed.value.cause, depth + 1));
};
interface DomainObservation {
  readonly attempts: number;
  readonly ready: boolean;
  readonly elapsedMs: number;
  readonly lastFailure?: {
    readonly reason: DomainNotReady["reason"];
    readonly status?: number | undefined;
    readonly code?: string | undefined;
  };
}

/** A real HTTPS response proves DNS and the edge certificate are usable. No TLS checks are disabled. */
const waitForDomain = (
  baseUrl: string,
  organizationSlug: string,
  observe: (value: DomainObservation) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const started = yield* Clock.currentTimeMillis;
    let attempts = 0;
    const origin = new URL(baseUrl);
    origin.hostname = `infrastructure-check.${organizationSlug}.${origin.hostname}`;
    yield* Effect.scoped(
      Effect.sync(() => {
        attempts++;
      })
        .pipe(Effect.andThen(http.get(origin.origin)))
        .pipe(
          Effect.flatMap((response) =>
            response.text.pipe(
              Effect.flatMap(() =>
                response.status < 500
                  ? Effect.void
                  : Effect.fail(new DomainNotReady({ reason: "http", status: response.status })),
              ),
            ),
          ),
        ),
    ).pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError((error) =>
        Schema.is(DomainNotReady)(error)
          ? error
          : HttpClientError.isHttpClientError(error)
            ? new DomainNotReady({
                reason: "transport",
                code: transportCode(error.reason.cause),
              })
            : new DomainNotReady({ reason: "timeout" }),
      ),
      Effect.tapError((error) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            observe({
              attempts,
              ready: false,
              elapsedMs: now - started,
              lastFailure: { reason: error.reason, status: error.status, code: error.code },
            }),
          ),
        ),
      ),
      Effect.retry({ schedule: Schedule.spaced("2 seconds") }),
      Effect.andThen(
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            observe({
              attempts,
              ready: true,
              elapsedMs: now - started,
            }),
          ),
        ),
      ),
    );
  });

/** The suite owns provisioned actors until individual cleanup or environment teardown, including failed preparation. */
export const prepareCloudScenarios = (input: {
  readonly target: typeof Target.Service;
  readonly scenarios: readonly { readonly title: string; readonly appOrigin?: true }[];
  readonly appUiBaseUrl: string;
  readonly workers: number;
}) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const cleanupScope = yield* Scope.fork(yield* Scope.Scope, "parallel");
    const cleanup = yield* Semaphore.make(input.workers);
    yield* Console.log(`Preparing ${input.scenarios.length} isolated Cloud organizations.`);
    const prepared = yield* Effect.forEach(
      input.scenarios,
      ({ title, appOrigin }) =>
        Effect.gen(function* () {
          // Organizations are independent. Bound their release fan-out while
          // retaining reverse-order finalization inside each actor layer.
          const scope = yield* Effect.acquireRelease(Scope.make(), (owned, exit) =>
            Scope.close(owned, exit).pipe(cleanup.withPermits(1)),
          ).pipe(Scope.provide(cleanupScope));
          const id = randomBytes(16).toString("hex");
          const target = yield* startScenario(input.target, title, id);
          const context = yield* Layer.buildWithScope(
            Actors.layer.pipe(
              Layer.provide(SessionClients.layer),
              Layer.provide(Layer.succeed(Target, target)),
            ),
            scope,
          );
          const actors = yield* Actors.pipe(Effect.provideContext(context));
          return { title, id, slug: actors.organization.slug, appOrigin };
        }).pipe(Effect.timeout("60 seconds")),
      { concurrency: input.workers },
    );
    const actorsReadyAt = yield* Clock.currentTimeMillis;
    // All domain requests must begin before waiting on the certificate authority.
    // Waiting inside the provisioning loop would serialize issuance in worker-sized batches.
    const domains = prepared.filter((scenario) => scenario.appOrigin);
    const ready = yield* Ref.make<ReadonlySet<string>>(new Set());
    const observations = yield* Ref.make<ReadonlyMap<string, DomainObservation>>(new Map());
    const fs = yield* FileSystem.FileSystem;
    yield* Console.log(
      `Cloud actors ready: ${Math.round((actorsReadyAt - started) / 1000)}s; waiting for ${domains.length} HTTPS domains.`,
    );
    yield* Effect.forEach(
      domains,
      ({ slug, id }) =>
        waitForDomain(input.appUiBaseUrl, slug, (observation) =>
          Ref.update(observations, (values) => new Map([...values, [id, observation]])),
        ).pipe(Effect.tap(() => Ref.update(ready, (ids) => new Set([...ids, id])))),
      // Readiness probes do not occupy scenario workers. Start every origin now;
      // a slow certificate must not consume the next origin's preparation budget.
      { concurrency: "unbounded", discard: true },
    ).pipe(
      Effect.timeout("5 minutes"),
      Effect.ensuring(
        Effect.gen(function* () {
          const finished = yield* Clock.currentTimeMillis;
          const readyDomains = (yield* Ref.get(ready)).size;
          const domainObservations = yield* Ref.get(observations);
          yield* fs.writeFileString(
            `${input.target.directory}/preparation.json`,
            JSON.stringify(
              {
                organizations: prepared.length,
                domains: domains.length,
                readyDomains,
                origins: domains.map(({ id, title, slug }) => ({
                  id,
                  title,
                  slug,
                  ...domainObservations.get(id),
                })),
                actorsMs: actorsReadyAt - started,
                httpsMs: finished - actorsReadyAt,
                totalMs: finished - started,
              },
              null,
              2,
            ),
          );
          yield* Console.log(`HTTPS domains ready: ${readyDomains}/${domains.length}.`);
        }).pipe(Effect.orDie),
      ),
      // Keep independent cases runnable. Each unavailable origin is a native
      // setup failure; it never becomes a skip or a passing scenario.
      Effect.catchTag("TimeoutError", () => Effect.void),
    );
    const finished = yield* Clock.currentTimeMillis;
    yield* Console.log(
      `Scenario infrastructure: ${Math.round((finished - started) / 1000)}s (${prepared.length} organizations, ${(yield* Ref.get(ready)).size}/${domains.length} HTTPS domains verified).`,
    );
    const readyIds = yield* Ref.get(ready);
    return PreparedScenarios.make(
      Object.fromEntries(
        prepared.map(({ title, id, appOrigin }) => [
          title,
          { id, status: !appOrigin || readyIds.has(id) ? "ready" : "domain_unavailable" },
        ]),
      ),
    );
  });
