/** Provision selected Cloud organizations together before measuring their independent scenarios. */
import {
  Clock,
  Console,
  Effect,
  FileSystem,
  Layer,
  Ref,
  Result,
  Schedule,
  Schema,
  Scope,
  Semaphore,
} from "effect";
import { HttpClient, HttpClientError } from "effect/http";
import { randomBytes } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { RequestFailed, SessionClients } from "../support/api.ts";
import { errorCode, keptCauseParts } from "../support/failure-text.ts";
import { Target } from "../support/platform.ts";
import { PreparedScenarios } from "./contracts.ts";
import { startScenario } from "./scenario.ts";
import { awaitCompiler } from "./compiler-readiness.ts";
import { FixtureFailed, fixtureRequest, type FixtureControl } from "./fixtures.ts";

class DomainNotReady extends Schema.TaggedError<DomainNotReady>()("DomainNotReady", {
  reason: Schema.Literals(["http", "transport", "timeout"]),
  status: Schema.optional(Schema.Number),
  code: Schema.optional(Schema.String),
}) {}
/**
 * What preparation records about an organization that was not ready: the failing request's method,
 * path, status, reason, response shape and the masked text of each level of its cause (its name,
 * code and message; see support/failure-text.ts), or the fixture operation. Never a body, cookie or
 * credential. Node puts a transport failure's kind only in the innermost causes' messages
 * ("connect ECONNREFUSED …", "other side closed"), so every level keeps its message.
 */
export const preparationFailure = (error: unknown) =>
  Schema.is(RequestFailed)(error)
    ? {
        method: error.method,
        path: error.path,
        status: error.status,
        reason: error.reason,
        response: error.response,
        failure: error.failure,
        causes: keptCauseParts(error),
      }
    : Schema.is(FixtureFailed)(error)
      ? { operation: error.operation, status: error.status, reason: error.reason }
      : undefined;
/** An organization preparation could not make ready, as preparation.json lists it. */
export interface UnavailableOrganization {
  readonly title: string;
  readonly id: string;
  readonly failure: string;
  readonly detail: ReturnType<typeof preparationFailure>;
}
/** The run log's line for each organization preparation could not make ready. */
export const reportUnavailable = (unavailable: ReadonlyArray<UnavailableOrganization>) =>
  Effect.forEach(
    unavailable,
    ({ title, failure, detail }) =>
      Console.log(
        `Cloud organization not ready for "${title}": ${failure}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`,
      ),
    { discard: true },
  );
/** Write preparation.json: what preparation made ready, and each organization it could not. */
export const writePreparation = (
  directory: string,
  record: { readonly unavailableOrganizations: ReadonlyArray<UnavailableOrganization> } & Readonly<
    Record<string, unknown>
  >,
) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.writeFileString(`${directory}/preparation.json`, JSON.stringify(record, null, 2)),
  );
interface DomainObservation {
  readonly attempts: number;
  /** The origin answered HTTPS and the product reports the team's address ready. */
  readonly ready: boolean;
  readonly elapsedMs: number;
  /** When the origin first answered HTTPS, from the start of the wait. */
  readonly httpsMs?: number;
  /** The product's last reported status for the team's address, once HTTPS answered. */
  readonly reported?: DomainReport["status"];
  readonly lastFailure?: {
    readonly reason: DomainNotReady["reason"];
    readonly status?: number | undefined;
    readonly code?: string | undefined;
  };
}
const DomainReport = Schema.Struct({
  status: Schema.Literals(["absent", "pending", "ready", "failed"]),
});
type DomainReport = typeof DomainReport.Type;
class DomainNotReported extends Schema.TaggedError<DomainNotReported>()("DomainNotReported", {
  status: Schema.optional(DomainReport.fields.status),
}) {}

/**
 * A real HTTPS response proves DNS and the edge certificate are usable. No TLS checks are disabled.
 * The product then has to report the address ready: its location read uses the row the domain
 * pass writes after it observes the certificate, which can lag the certificate by a pass. Both are
 * infrastructure readiness, so both are waited for here, under the infrastructure deadline, and a
 * scenario starts with an address its location read already reports ready.
 */
const waitForDomain = (
  baseUrl: string,
  organizationSlug: string,
  scenario: string,
  fixtures: typeof FixtureControl.Type,
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
                code: errorCode(error.reason.cause),
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
    );
    const httpsMs = (yield* Clock.currentTimeMillis) - started;
    yield* fixtureRequest(fixtures, "/domain", { id: scenario }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(DomainReport)),
      Effect.mapError(() => new DomainNotReported({})),
      Effect.flatMap((report) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            observe({
              attempts,
              ready: report.status === "ready",
              elapsedMs: now - started,
              httpsMs,
              reported: report.status,
            }),
          ),
          Effect.andThen(
            report.status === "ready"
              ? Effect.void
              : Effect.fail(new DomainNotReported({ status: report.status })),
          ),
        ),
      ),
      Effect.retry({ schedule: Schedule.spaced("2 seconds") }),
    );
  });

/**
 * Certificate issuance, the domain pass that reports it and a cold compiler Worker share this
 * deadline, outside every scenario's.
 */
const infrastructureDeadline = "5 minutes";

/** The suite owns provisioned actors until individual cleanup or environment teardown, including failed preparation. */
export const prepareCloudScenarios = (input: {
  readonly target: typeof Target.Service;
  readonly scenarios: readonly { readonly title: string; readonly appOrigin?: true }[];
  readonly appUiBaseUrl: string;
  /** The attached stage's fixture control, which reads the product's report of each address. */
  readonly fixtures: typeof FixtureControl.Type;
  readonly workers: number;
}) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const cleanupScope = yield* Scope.fork(yield* Scope.Scope, "parallel");
    const cleanup = yield* Semaphore.make(input.workers);
    yield* Console.log(`Preparing ${input.scenarios.length} isolated Cloud organizations.`);
    // Every scenario that deploys an app needs the compiler. It is proven once, beside
    // organization provisioning, and its failure fails the whole preparation.
    const [compiler, provisioned] = yield* Effect.all(
      [
        awaitCompiler(input.target, infrastructureDeadline),
        Effect.forEach(
          input.scenarios,
          ({ title, appOrigin }) => {
            const id = randomBytes(16).toString("hex");
            return Effect.gen(function* () {
              // Organizations are independent. Bound their release fan-out while
              // retaining reverse-order finalization inside each actor layer.
              const scope = yield* Effect.acquireRelease(Scope.make(), (owned, exit) =>
                Scope.close(owned, exit).pipe(cleanup.withPermits(1)),
              ).pipe(Scope.provide(cleanupScope));
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
            }).pipe(
              Effect.timeout("60 seconds"),
              // One organization that is not ready within its deadline is a native setup failure
              // for its own scenario; the others still run. The suite scope still releases whatever
              // it created.
              Effect.mapError((error): UnavailableOrganization => ({
                title,
                id,
                failure: error._tag,
                detail: preparationFailure(error),
              })),
              Effect.result,
            );
          },
          { concurrency: input.workers },
        ),
      ],
      { concurrency: 2 },
    );
    const prepared = provisioned.filter(Result.isSuccess).map((result) => result.success);
    const unavailable = provisioned.filter(Result.isFailure).map((result) => result.failure);
    const actorsReadyAt = yield* Clock.currentTimeMillis;
    yield* reportUnavailable(unavailable);
    // All domain requests must begin before waiting on the certificate authority.
    // Waiting inside the provisioning loop would serialize issuance in worker-sized batches.
    const domains = prepared.filter((scenario) => scenario.appOrigin);
    const ready = yield* Ref.make<ReadonlySet<string>>(new Set());
    const observations = yield* Ref.make<ReadonlyMap<string, DomainObservation>>(new Map());
    yield* Console.log(
      `Cloud actors ready: ${Math.round((actorsReadyAt - started) / 1000)}s (${prepared.length}/${input.scenarios.length} organizations); waiting for ${domains.length} HTTPS domains to answer and be reported ready.`,
    );
    yield* Effect.forEach(
      domains,
      ({ slug, id }) =>
        waitForDomain(input.appUiBaseUrl, slug, id, input.fixtures, (observation) =>
          Ref.update(observations, (values) => new Map([...values, [id, observation]])),
        ).pipe(Effect.tap(() => Ref.update(ready, (ids) => new Set([...ids, id])))),
      // Readiness probes do not occupy scenario workers. Start every origin now;
      // a slow certificate must not consume the next origin's preparation budget.
      { concurrency: "unbounded", discard: true },
    ).pipe(
      Effect.timeout(infrastructureDeadline),
      Effect.ensuring(
        Effect.gen(function* () {
          const finished = yield* Clock.currentTimeMillis;
          const readyDomains = (yield* Ref.get(ready)).size;
          const domainObservations = yield* Ref.get(observations);
          yield* writePreparation(input.target.directory, {
            organizations: prepared.length,
            unavailableOrganizations: unavailable,
            domains: domains.length,
            readyDomains,
            origins: domains.map(({ id, title, slug }) => ({
              id,
              title,
              slug,
              ...domainObservations.get(id),
            })),
            compilerAttempts: compiler.attempts,
            compilerMs: compiler.elapsedMs,
            actorsMs: actorsReadyAt - started,
            httpsMs: finished - actorsReadyAt,
            totalMs: finished - started,
          });
          yield* Console.log(
            `HTTPS domains ready and reported ready: ${readyDomains}/${domains.length}.`,
          );
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
      Object.fromEntries([
        ...prepared.map(({ title, id, appOrigin }) => [
          title,
          { id, status: !appOrigin || readyIds.has(id) ? "ready" : "domain_unavailable" },
        ]),
        ...unavailable.map(({ title, id }) => [title, { id, status: "organization_unavailable" }]),
      ]),
    );
  });
