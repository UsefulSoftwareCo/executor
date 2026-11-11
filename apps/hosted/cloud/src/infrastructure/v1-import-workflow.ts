/**
 * The v1 move's durable runner (`notes/v1-import.md`, "Where it runs"): the `V1Import` Workflow,
 * hosted by the API Worker beside `OrganizationRemoval`, one instance per v1 organization and run.
 * Deployed Cloud runs it on Cloudflare Workflows; `alchemy dev` runs the same class locally.
 *
 * Only an operator starts runs, through `/api/internal/v1-import/*` with the deployment's
 * `V1_IMPORT_OPERATOR_TOKEN`. Without the token, or without the importer, every such request
 * answers 404, as for any unknown path. No user session reaches these routes.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { HostedExecutor, McpAuthentication, OrganizationId } from "@executor-js/hosted-server";
import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Cause, Clock, Context, Effect, Layer, Option, Predicate, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { V1ImportDatabase, V1ImportUnavailable, V1OrganizationId } from "../contracts/v1-import.ts";
import {
  V1ImportAggregate,
  type V1ImportAggregatePage,
  V1ImportInFlight,
  V1ImportParams,
  V1ImportStart,
  V1OrgReport,
  V1RunMarker,
  v1ImportAggregateKey,
  v1ImportAggregatingKey,
  v1ImportInFlightKey,
  v1ImportInFlightPrefix,
  v1ImportInstance,
  v1ImportReportKey,
  v1ImportRunPrefix,
  V1ImportStarted,
} from "../contracts/v1-import-run.ts";
import { addReports, emptyAggregate } from "../implementation/v1-import/aggregate.ts";
import { cloudSentry } from "../implementation/error-reporting.ts";
import {
  V1ImportEnvironment,
  V1ImportStepFailed,
  runV1Import,
  type V1ImportReports,
  type V1ImportStep,
} from "../implementation/v1-import/run.ts";
import { repairCopiedAccounts } from "../implementation/v1-import/copied-accounts.ts";
import { AppRestore, repairOrganization, restoreApp } from "../implementation/v1-import/repair.ts";
import { makeV1Source } from "../implementation/v1-import/source.ts";
import { V1MovedState } from "../implementation/v1-import/moved-flag.ts";
import { existingOrganization } from "../implementation/v1-import/identity.ts";
import { removeImported } from "../implementation/v1-import/rollback.ts";
import { makeImportStore } from "../implementation/v1-import/store.ts";
import { importRefusal, movedFlag, writesRefused } from "../implementation/v1-import/writes.ts";
import { AppBuilds } from "./blobs.ts";
import { AutumnClient } from "../contracts/autumn.ts";
import { BillingMeter } from "../contracts/billing-meter.ts";
import { autumnLive, autumnReads } from "../implementation/autumn-client.ts";
import {
  returnBilling,
  v1TeamPlan,
  type V1ImportBilling,
} from "../implementation/v1-import/billing.ts";
import type { V1ImportSettings } from "./onboarding.ts";
import {
  encryptedWorkflowParams,
  workflowEncryptionEnabled,
  encryptedWorkflowResult,
  encryptedWorkflowTask,
  type WorkflowResults,
  workflowEncryptionKey,
  workflowResults,
  workflowResultInput,
} from "./workflow-results.ts";

/** The importer this deployment runs, with where it keeps reports; none where v1 is unreachable. */
export class V1ImportConfiguration extends Context.Service<
  V1ImportConfiguration,
  Option.Option<{ readonly settings: V1ImportSettings; readonly reports: V1ImportReports }>
>()("cloud/V1ImportConfiguration") {}

const HoldStates = Schema.Array(
  Schema.Struct({ state: Schema.Literals(["held", "carried", "returned"]) }),
);

/** Reports in the private `AppBuilds` bucket. Bind during Worker initialization. */
export const cloudV1ImportReports = Effect.gen(function* () {
  const bucket = yield* Cloudflare.R2.ReadWriteBucket(AppBuilds);
  const failed = () => new V1ImportUnavailable();
  const reports: V1ImportReports = {
    put: (key, value) =>
      bucket
        .put(key, JSON.stringify(value))
        .pipe(Effect.asVoid, Effect.provide(RuntimeContext.phantom), Effect.mapError(failed)),
    get: (key) =>
      Effect.gen(function* () {
        const object = yield* bucket.get(key);
        if (object === null) return Option.none();
        const text = yield* object.text();
        return Option.some(
          yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text),
        );
      }).pipe(Effect.provide(RuntimeContext.phantom), Effect.mapError(failed)),
    remove: (key) =>
      bucket
        .delete(key)
        .pipe(Effect.asVoid, Effect.provide(RuntimeContext.phantom), Effect.mapError(failed)),
    list: (prefix, cursor, limit) =>
      bucket.list({ prefix, limit, ...(cursor === undefined ? {} : { cursor }) }).pipe(
        Effect.map((page) => ({
          keys: page.objects.map((object) => object.key),
          cursor: page.truncated ? page.cursor : undefined,
        })),
        Effect.provide(RuntimeContext.phantom),
        Effect.mapError(failed),
      ),
  };
  return reports;
}).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding));

/**
 * One failed attempt, with its error's tag. The engine retries only typed failures it can
 * serialize, and returns the last one's fields once the retries run out.
 */
class V1ImportAttemptFailed extends Schema.TaggedError<V1ImportAttemptFailed>()(
  "V1ImportAttemptFailed",
  { failure: Schema.String },
) {}

/** A failure's tag, which names its kind without its message or data. */
const failureTag = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause);
  return Predicate.hasProperty(failure, "_tag") ? String(failure._tag) : "unknown";
};

/**
 * One durable step in its own scope. A typed failure is retried with backoff; once the retries run
 * out the run decides what the failure means. A defect stops the instance, which stays errored for
 * a person to inspect and restart.
 */
const runner =
  (
    params: V1ImportParams,
    retries: V1ImportSettings["stepRetries"],
    results?: WorkflowResults,
  ): V1ImportStep<Cloudflare.Workflows.WorkflowStep> =>
  (name, work) => {
    const stepWork = work.pipe(
      Effect.scoped,
      Effect.withSpan("v1_import.step", {
        attributes: {
          "executor.v1_import.organization": params.v1OrgId,
          "executor.v1_import.mode": params.mode,
          "executor.v1_import.step": name.split(" ")[0] ?? name,
        },
      }),
    );
    const logRetryableFailure = (cause: Cause.Cause<unknown>) =>
      Effect.logWarning("v1 import step attempt failed", {
        step: name,
        error: failureTag(cause),
      }).pipe(
        Effect.andThen(Effect.fail(new V1ImportAttemptFailed({ failure: failureTag(cause) }))),
      );
    const legacyAttempt = stepWork.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Cause.hasFails(cause)
            ? logRetryableFailure(cause)
            : Effect.failCause(cause),
      ),
    );
    const retryableCause = (cause: Cause.Cause<unknown>) =>
      cause.reasons.length > 0 &&
      cause.reasons.every(
        (reason) =>
          Cause.isFailReason(reason) &&
          (!Predicate.hasProperty(reason.error, "retryable") || reason.error.retryable !== false),
      );
    const encryptedAttempt = stepWork.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : retryableCause(cause)
            ? logRetryableFailure(cause)
            : Effect.failCause(cause),
      ),
    );
    const options = {
      retries: {
        limit: retries.limit,
        delay: `${retries.delaySeconds} seconds`,
        backoff: "exponential" as const,
      },
      timeout: "15 minutes",
    };
    const step =
      results === undefined
        ? Cloudflare.Workflows.task(name, legacyAttempt, options)
        : encryptedWorkflowTask({
            results,
            name,
            options,
            work: () => encryptedAttempt,
            encodeFailure: (error) =>
              Predicate.hasProperty(error, "failure") && typeof error.failure === "string"
                ? error.failure
                : error instanceof Error
                  ? error.message
                  : "V1 import step failed",
            isRetryable: (error) =>
              !Predicate.hasProperty(error, "retryable") || error.retryable !== false,
            restoreFailure: (failure) =>
              new V1ImportAttemptFailed({ failure: failure.failure ?? "unknown" }),
          });
    return step.pipe(
      Effect.mapError(
        (error) =>
          new V1ImportStepFailed({
            step: name,
            // A replayed failure keeps its fields but not its class.
            failure:
              Predicate.hasProperty(error, "failure") && typeof error.failure === "string"
                ? error.failure
                : "unknown",
          }),
      ),
    );
  };

/**
 * v2's billing for a carry-over: its Autumn, with the v1 import's patient reads, its catalog, and
 * its seat sync. None where the settings have none.
 */
const importBilling = (settings: V1ImportSettings, meter: BillingMeter["Service"]) =>
  Option.map(settings.billing, (billing) =>
    Effect.gen(function* () {
      const { options, catalog } = yield* billing;
      const autumn = yield* AutumnClient.pipe(
        Effect.provide(
          autumnLive(options, autumnReads.patient).pipe(Layer.provide(FetchHttpClient.layer)),
        ),
      );
      return {
        autumn,
        catalog,
        v1TeamPlan,
        syncSeats: meter.syncSeats,
      } satisfies V1ImportBilling;
    }),
  );

/** The importer's environment for a run or a repair, from the deployment's settings. */
const importEnvironment = (
  settings: V1ImportSettings,
  reports: V1ImportReports,
  connections: McpAuthentication["Service"]["connections"],
  meter: BillingMeter["Service"],
) =>
  V1ImportEnvironment.of({
    source: settings.source.pipe(
      Effect.flatMap(makeV1Source),
      Effect.provide(FetchHttpClient.layer),
      Effect.mapError(() => new V1ImportUnavailable()),
    ),
    connections,
    reports,
    writes: settings.writes,
    freezeSettleSeconds: settings.freezeSettleSeconds,
    v1FirstPartyClients: settings.v1FirstPartyClients,
    slugKey: settings.slugKey,
    billing: importBilling(settings, meter),
  });

export class V1ImportWorkflow extends Cloudflare.Workflow<V1ImportWorkflow>()(
  "V1Import",
  // An organization's integrations, toolkits and artifacts each take a step.
  { limits: { steps: 10_000 } },
  Effect.gen(function* () {
    const reportErrors = yield* cloudSentry;
    const encryptionKey = yield* workflowEncryptionKey;
    // Only these services: the Worker's context also holds its own scope, which a run must not take.
    const services = yield* Effect.context<
      HostedExecutor | V1ImportDatabase | McpAuthentication | V1ImportConfiguration | BillingMeter
    >().pipe(
      Effect.map(
        Context.pick(
          HostedExecutor,
          V1ImportDatabase,
          McpAuthentication,
          V1ImportConfiguration,
          BillingMeter,
        ),
      ),
    );
    const configuration = Context.get(services, V1ImportConfiguration);
    const connections = Context.get(services, McpAuthentication).connections;
    const meter = Context.get(services, BillingMeter);
    return (input: unknown) =>
      Effect.gen(function* () {
        const request = yield* workflowResultInput(input);
        const params = yield* Schema.decodeUnknownEffect(V1ImportParams)(request.params);
        if (Option.isNone(configuration))
          return yield* Effect.die(new Error("This deployment has no v1 importer."));
        const { settings, reports } = configuration.value;
        const instance = v1ImportInstance(params);
        const results =
          request.mode === "encrypted"
            ? yield* workflowResults(`v1-import:${instance}`, encryptionKey)
            : undefined;
        const environment = importEnvironment(settings, reports, connections, meter);
        const work = runV1Import(
          params,
          runner(params, settings.stepRetries, results),
          (name, seconds) =>
            results === undefined
              ? Cloudflare.Workflows.sleep(name, seconds * 1000)
              : results.storedStepName(name).pipe(
                  Effect.flatMap((storedName) =>
                    Cloudflare.Workflows.sleep(storedName, seconds * 1000),
                  ),
                  Effect.orDie,
                ),
        ).pipe(
          Effect.provideService(V1ImportEnvironment, environment),
          Effect.provide(services),
          Effect.withSpan("v1_import.run", {
            root: true,
            attributes: {
              "executor.v1_import.organization": params.v1OrgId,
              "executor.v1_import.mode": params.mode,
            },
          }),
        );
        if (results === undefined) return yield* work;
        return yield* encryptedWorkflowResult({
          results,
          work,
          encodeFailure: (error) =>
            error instanceof Error ? error.message : "V1 import workflow failed",
          isRetryable: () => false,
        });
      }).pipe(reportErrors, Effect.orDie);
  }),
) {}

type Workflow = Effect.Success<typeof V1ImportWorkflow>;

/** A repair request: whether to apply it, or only plan it (the default). */
const RepairRequest = Schema.Struct({ apply: Schema.optional(Schema.Boolean) });

/** How long one Workflows call may take before it counts as refused (see organization removal). */
const callDeadline = "3 seconds";

const json = (status: number, body: unknown) =>
  HttpServerResponse.json(body, { status }).pipe(
    Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 500 }))),
  );
const notFound = Effect.succeed(HttpServerResponse.empty({ status: 404 }));

/** Instance states that will not write a report without a person restarting them. */
const stopped = new Set(["errored", "terminated"]);

/**
 * How long after its start an instance whose state cannot be read still counts as running. Past
 * it the instance counts as lost: listed as errored for a person, and no longer holding a place.
 */
const lostAfterMs = 30 * 60 * 1000;

/**
 * The most run markers an aggregation reads per request, and the default: two R2 reads and at
 * most one status call each. `?limit=` asks for fewer.
 */
const aggregatePage = 200;

/** An aggregation's id in its cursor, which also names its partial result in R2. */
const aggregationId = /^[0-9a-f]{32}$/u;

/**
 * The operator routes. Each compares the bearer token in constant time and answers 404 without a
 * match, so the routes look absent to anyone else.
 *
 * - `POST /api/internal/v1-import/start` starts one batch: the listed organizations, or the next
 *   page of every live v1 organization after `after`. A dry run's instances are its own per run;
 *   an import's instance is the organization's id, so starting it again finds the first. At most
 *   `maxInFlight` organizations run at once across every run of the deployment, which bounds the
 *   reads of v1's database and WorkOS and the builds: a start takes only as many as there is room
 *   for, defers the rest, and reports how many are running and which of the run's stopped without
 *   a report. An id that is not a v1 organization id, or one the run already has running, is
 *   skipped. An import needs the deployment's write switch, must list its organizations, and
 *   each needs a row in `private_v1_import_allowed`, which only direct SQL writes (`writes.ts`).
 *   The token alone allows no organization.
 * - `GET /api/internal/v1-import/runs/:run/orgs/:organization` returns one organization's report
 *   and its instance's status.
 * - `POST /api/internal/v1-import/orgs/:organization/return-billing` gives a paid organization's
 *   subscription back to v1 before its v2 organization is deleted (see `giveBillingBack`).
 * - `POST /api/internal/v1-import/orgs/:organization/rollback` gives an organization back to v1
 *   after its v2 organization was deleted (see `rollback`).
 * - `POST /api/internal/v1-import/orgs/:organization/repair` deploys a moved organization's MCP
 *   apps with v1's approval stamps as rules, or with `{"apply": false}` plans it (see `repair`).
 * - `POST /api/internal/v1-import/orgs/:organization/restore` runs an earlier version of one of its
 *   imported apps again, while the app still runs the version named (see `restore`).
 * - `POST /api/internal/v1-import/orgs/:organization/accounts` brings the accounts of an
 *   organization the opt-in import copied before it moved up to date with v1's final tokens and
 *   their apps' providers (see `accounts`).
 * - `POST /api/internal/v1-import/runs/:run/aggregate[?cursor=…][&limit=…]` combines a page of a
 *   run's reports (at most 200, or `limit`) into the aggregate so far and returns the cursor of the next page; the last page
 *   writes `v1-import/runs/<run>/aggregate.json` and returns it. `complete` is false while any
 *   organization has no report yet, and organizations whose instance stopped without one are
 *   listed apart.
 */
export const v1ImportRoutes = (workflow: Workflow) =>
  Effect.gen(function* () {
    const configuration = yield* V1ImportConfiguration;
    const encrypted = yield* workflowEncryptionEnabled;
    const authorized = Effect.gen(function* () {
      if (Option.isNone(configuration)) return Option.none();
      const token = configuration.value.settings.operatorToken;
      if (Option.isNone(token)) return Option.none();
      const request = yield* HttpServerRequest.HttpServerRequest;
      const expected = Buffer.from(`Bearer ${Redacted.value(token.value)}`);
      const supplied = Buffer.from(request.headers.authorization ?? "");
      return supplied.length === expected.length && timingSafeEqual(supplied, expected)
        ? Option.some(configuration.value)
        : Option.none();
    });

    const status = (instance: string) =>
      workflow.get(instance).pipe(
        Effect.flatMap((run) => run.status()),
        Effect.map((state): string => state.status),
        Effect.timeout(callDeadline),
        Effect.catchCause(() => Effect.succeed("unknown")),
      );

    const create = (params: V1ImportParams) => {
      const instance = v1ImportInstance(params);
      return workflow
        .create({
          id: instance,
          params: encryptedWorkflowParams(params, encrypted),
        })
        .pipe(
          Effect.timeout(callDeadline),
          Effect.asVoid,
          // A refused create may have taken, or an earlier start made the instance: the status decides.
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : status(instance).pipe(
                  Effect.flatMap((state) =>
                    state === "unknown" ? Effect.fail(new V1ImportUnavailable()) : Effect.void,
                  ),
                ),
          ),
          Effect.as({ organization: params.v1OrgId, instance }),
        );
    };

    const keys = (reports: V1ImportReports, prefix: string) =>
      Effect.gen(function* () {
        const found: string[] = [];
        let cursor: string | undefined;
        do {
          const page = yield* reports.list(prefix, cursor, 1000);
          found.push(...page.keys);
          cursor = page.cursor;
        } while (cursor !== undefined);
        return found;
      });

    const marker = (reports: V1ImportReports, run: string, organization: string) =>
      reports
        .get(`${v1ImportRunPrefix(run)}${organization}`)
        .pipe(Effect.map(Option.flatMap(Schema.decodeUnknownOption(V1RunMarker))));

    /**
     * Every run's organizations whose report is not written yet, by whether their instance is
     * still running. The run marker decides first: an entry whose organization already has its
     * outcome, which a report step could not remove, is removed here. An instance whose state
     * cannot be read counts as running, so a slow Workflows answer never lets a start exceed its
     * bound, until `lostAfterMs` after its start, when it is listed as errored instead.
     */
    const inFlight = (reports: V1ImportReports) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const entries = yield* Effect.forEach(
          yield* keys(reports, v1ImportInFlightPrefix),
          (key) =>
            Effect.gen(function* () {
              const [run, organization] = key.slice(v1ImportInFlightPrefix.length).split("/");
              if (run === undefined || organization === undefined) return [];
              const started = yield* marker(reports, run, organization);
              if (Option.isNone(started) || started.value.status !== "started") {
                yield* reports.remove(key);
                return [];
              }
              const instance = v1ImportInstance({
                v1OrgId: organization,
                mode: started.value.mode,
                runId: run,
              });
              const state = yield* status(instance);
              const entry = Option.flatMap(
                yield* reports.get(key),
                Schema.decodeUnknownOption(V1ImportInFlight),
              );
              const lost =
                state === "unknown" &&
                Option.isSome(entry) &&
                now - entry.value.startedAt > lostAfterMs;
              return [{ run, organization, instance, status: state, lost }];
            }),
          { concurrency: 8 },
        ).pipe(Effect.map((found) => found.flat()));
        return {
          running: entries.filter(
            (entry) => !entry.lost && !stopped.has(entry.status) && entry.status !== "complete",
          ),
          errored: entries.filter((entry) => entry.lost || stopped.has(entry.status)),
        };
      });

    const start = Effect.gen(function* () {
      const found = yield* authorized;
      if (Option.isNone(found)) return yield* notFound;
      const { settings, reports } = found.value;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* request.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(V1ImportStart)),
        Effect.option,
      );
      if (Option.isNone(body)) return yield* json(400, { error: "invalid request" });
      const input = body.value;
      // A start that pages through v1 names no organizations, which no import may do.
      const refusal =
        input.mode === "import"
          ? yield* importRefusal(
              settings.writes,
              input.after === undefined && input.limit === undefined
                ? input.organizations
                : undefined,
            )
          : undefined;
      if (refusal !== undefined) return yield* json(409, { error: refusal });
      const flight = yield* inFlight(reports);
      const room = Math.max(0, input.maxInFlight - flight.running.length);
      // An organization of this run that is still running is not started or counted again.
      const running = new Set(
        flight.running
          .filter((entry) => entry.run === input.runId)
          .map((entry) => entry.organization),
      );
      const listed = input.organizations;
      const limit = Math.min(input.limit ?? 50, room);
      const page =
        listed !== undefined || limit === 0
          ? []
          : yield* settings.source.pipe(
              Effect.flatMap(makeV1Source),
              Effect.provide(FetchHttpClient.layer),
              Effect.flatMap((source) => source.organizations(input.after ?? "", limit)),
              Effect.scoped,
            );
      const skipped: Array<(typeof V1ImportStarted.Type)["skipped"][number]> = [];
      const fresh: V1OrganizationId[] = [];
      for (const organization of listed ?? page) {
        const decoded = Schema.decodeUnknownOption(V1OrganizationId)(organization);
        if (Option.isNone(decoded)) skipped.push({ organization, reason: "invalid_id" });
        else if (running.has(decoded.value)) skipped.push({ organization, reason: "running" });
        else fresh.push(decoded.value);
      }
      const organizations = fresh.slice(0, room);
      const startedAt = yield* Clock.currentTimeMillis;
      const started = yield* Effect.forEach(
        organizations,
        (organization) =>
          Effect.gen(function* () {
            const params = { v1OrgId: organization, mode: input.mode, runId: input.runId };
            // The marker comes first, so an aggregate counts an instance whose report is pending.
            // An organization this run already reported is not running again.
            const existing = yield* marker(reports, input.runId, organization);
            if (Option.isSome(existing) && existing.value.status !== "started")
              return { ...(yield* create(params)), running: false };
            if (Option.isNone(existing))
              yield* reports.put(`${v1ImportRunPrefix(input.runId)}${organization}`, {
                status: "started",
                mode: input.mode,
              });
            const entry = v1ImportInFlightKey(input.runId, organization);
            yield* reports.put(entry, { startedAt } satisfies typeof V1ImportInFlight.Type);
            const created = yield* create(params).pipe(
              Effect.tapError(() => Effect.ignore(reports.remove(entry))),
            );
            return { ...created, running: true };
          }),
        { concurrency: 4 },
      );
      // A full page moves the walk past every id it read, the skipped ones included.
      const next =
        listed !== undefined
          ? null
          : limit === 0
            ? (input.after ?? "")
            : page.length === limit
              ? (page.at(-1) ?? null)
              : null;
      return yield* json(200, {
        started: started.map(({ organization, instance }) => ({ organization, instance })),
        deferred: fresh.slice(room),
        skipped,
        next,
        inFlight: flight.running.length + started.filter((entry) => entry.running).length,
        errored: flight.errored
          .filter((entry) => entry.run === input.runId)
          .map((entry) => ({
            organization: entry.organization,
            instance: entry.instance,
            status: entry.status,
          })),
      } satisfies typeof V1ImportStarted.Type);
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logError("v1 import start failed", cause).pipe(
              Effect.andThen(json(503, { error: "unavailable" })),
            ),
      ),
    );

    const report = Effect.gen(function* () {
      const found = yield* authorized;
      if (Option.isNone(found)) return yield* notFound;
      const params = yield* HttpRouter.params;
      const run = params.run ?? "";
      const organization = params.organization ?? "";
      const stored = yield* found.value.reports.get(v1ImportReportKey(organization, run));
      const instance = yield* Effect.all([
        status(v1ImportInstance({ v1OrgId: organization, mode: "dry-run", runId: run })),
        status(v1ImportInstance({ v1OrgId: organization, mode: "import", runId: run })),
      ]);
      return yield* json(200, {
        report: Option.getOrNull(stored),
        instances: { dryRun: instance[0], import: instance[1] },
      });
    }).pipe(Effect.catch(() => json(503, { error: "unavailable" })));

    /** One run marker's organization: its report, or whether its instance is pending or stopped. */
    const outcome = (reports: V1ImportReports, run: string, organization: string) =>
      Effect.gen(function* () {
        const decoded = yield* marker(reports, run, organization);
        if (Option.isNone(decoded)) return { organization, kind: "pending" as const };
        if (decoded.value.status === "started") {
          const instance = v1ImportInstance({
            v1OrgId: organization,
            mode: decoded.value.mode,
            runId: run,
          });
          const state = yield* status(instance);
          return stopped.has(state)
            ? { organization, kind: "errored" as const, instance, status: state }
            : { organization, kind: "pending" as const };
        }
        const stored = Option.flatMap(
          yield* reports.get(v1ImportReportKey(organization, run)),
          Schema.decodeUnknownOption(V1OrgReport),
        );
        return Option.isSome(stored)
          ? { organization, kind: "report" as const, report: stored.value }
          : { organization, kind: "pending" as const };
      });

    const aggregate = Effect.gen(function* () {
      const found = yield* authorized;
      if (Option.isNone(found)) return yield* notFound;
      const { reports } = found.value;
      const run = (yield* HttpRouter.params).run ?? "";
      const request = yield* HttpServerRequest.HttpServerRequest;
      const query = new URL(request.url, "http://internal").searchParams;
      const given = query.get("cursor");
      const asked = query.get("limit");
      const limit = asked === null ? aggregatePage : Number(asked);
      if (!Number.isInteger(limit) || limit < 1 || limit > aggregatePage)
        return yield* json(400, { error: "invalid limit" });
      // The first page starts an aggregation; each later page continues the one its cursor names.
      const dot = given?.indexOf(".") ?? -1;
      const aggregation = given === null ? randomUUID().replaceAll("-", "") : given.slice(0, dot);
      if (given !== null && (dot < 0 || !aggregationId.test(aggregation)))
        return yield* json(400, { error: "invalid cursor" });
      const partialKey = v1ImportAggregatingKey(run, aggregation);
      const partial =
        given === null
          ? Option.some(emptyAggregate(run))
          : Option.flatMap(
              yield* reports.get(partialKey),
              Schema.decodeUnknownOption(V1ImportAggregate),
            );
      if (Option.isNone(partial)) return yield* json(400, { error: "invalid cursor" });
      const prefix = v1ImportRunPrefix(run);
      const page = yield* reports.list(
        prefix,
        given === null ? undefined : given.slice(dot + 1),
        limit,
      );
      const outcomes = yield* Effect.forEach(
        page.keys,
        (key) => outcome(reports, run, key.slice(prefix.length)),
        { concurrency: 16 },
      );
      const combined = addReports(
        partial.value,
        outcomes.flatMap((entry) => (entry.kind === "report" ? [entry.report] : [])),
        outcomes.flatMap((entry) => (entry.kind === "pending" ? [entry.organization] : [])),
        outcomes.flatMap((entry) =>
          entry.kind === "errored"
            ? [{ organization: entry.organization, instance: entry.instance, status: entry.status }]
            : [],
        ),
      );
      if (page.cursor !== undefined) {
        yield* reports.put(partialKey, combined);
        return yield* json(200, {
          cursor: `${aggregation}.${page.cursor}`,
          organizations: combined.organizations,
        } satisfies V1ImportAggregatePage);
      }
      yield* reports.put(v1ImportAggregateKey(run), combined);
      if (given !== null) yield* Effect.ignore(reports.remove(partialKey));
      return yield* json(200, {
        cursor: null,
        aggregate: combined,
      } satisfies V1ImportAggregatePage);
    }).pipe(Effect.catch(() => json(503, { error: "unavailable" })));

    /**
     * Give a frozen or moved organization back to v1: its moved flag becomes `rolled_back`, so v1
     * serves it as before, its state row `rolled_back`, and its import map rows go, except users,
     * which stay mapped for their other organizations. Refused while its import instance runs, and
     * while a v2 organization the import created still exists: its imported grants would renew
     * beside v1's, and a refresh token must be used by only one of them. Delete the v2 organization
     * first. One moved into an existing v2 organization (decision 32) keeps it: the rollback removes
     * only what the import added to it (`removeImported`), once a carried-over subscription went
     * back to v1 (`return-billing`).
     */
    /** The state of the billing hold a v1 organization's import put on a v2 organization, if any. */
    const billingHoldOf = (target: string, organization: string) =>
      Effect.gen(function* () {
        const sql = yield* Effect.flatten(V1ImportDatabase);
        const rows = yield* sql`
          select state from private_v1_import_billing
          where organization_id = ${target} and v1_org_id = ${organization}
        `.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(HoldStates)),
          Effect.mapError(() => new V1ImportUnavailable()),
        );
        return rows[0]?.state;
      });

    const rollback = Effect.gen(function* () {
      const found = yield* authorized;
      if (Option.isNone(found)) return yield* notFound;
      const flag = movedFlag(found.value.settings.writes);
      if (flag === undefined)
        return yield* json(409, {
          error: writesRefused(found.value.settings.writes) ?? "unavailable",
        });
      const decoded = Schema.decodeUnknownOption(V1OrganizationId)(
        (yield* HttpRouter.params).organization,
      );
      if (Option.isNone(decoded)) return yield* json(400, { error: "invalid organization" });
      const organization = decoded.value;
      const state = yield* status(organization);
      if (state === "unknown" || !(stopped.has(state) || state === "complete"))
        return yield* json(409, {
          error: `Its import instance is ${state}; roll it back once it has stopped.`,
        });
      const sql = yield* Effect.flatten(V1ImportDatabase);
      const store = makeImportStore(sql);
      const recorded = yield* store.find("organization", organization);
      let into: { readonly organization: string; readonly removed: unknown } | undefined;
      if (recorded?.v2_kind === existingOrganization && recorded.v2_id !== null) {
        const hold = yield* billingHoldOf(recorded.v2_id, organization);
        if (hold === "carried")
          return yield* json(409, {
            error:
              "Its v1 subscription carried over to its v2 organization. Give it back first (return-billing).",
          });
        if (hold === "held")
          return yield* json(409, {
            error:
              "Its v2 organization's billing is held for a carry-over that did not finish. Give it back first (return-billing), or delete its private_v1_import_billing row once Autumn shows nothing carried over.",
          });
        const removal = yield* removeImported(
          organization,
          OrganizationId.make(recorded.v2_id),
          (yield* McpAuthentication).connections,
        );
        if ("refused" in removal) return yield* json(409, { error: removal.refused });
        into = { organization: recorded.v2_id, removed: removal.removed };
      } else if (recorded?.status === "imported" && recorded.v2_id !== null) {
        const target = yield* store.target(recorded.v2_id);
        if (target !== undefined)
          return yield* json(409, {
            error: `Its v2 organization ${target.slug} still exists. Delete it in v2 first, so its imported grants never renew beside v1's. A paid organization's billing goes back first (return-billing), or deleting it cancels the subscription.`,
          });
      }
      yield* flag.set(organization, V1MovedState.RolledBack());
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              delete from private_v1_import_map
              where v1_org_id = ${organization} and v1_kind <> 'user'
            `;
            yield* sql`
              update private_v1_import_org set state = 'rolled_back', updated_at = now()
              where v1_org_id = ${organization}
            `;
            // A subscription given back is v1's again; the existing organization bills as before.
            if (into !== undefined)
              yield* sql`
                delete from private_v1_import_billing
                where organization_id = ${into.organization} and v1_org_id = ${organization}
                  and state = 'returned'
              `;
          }),
        )
        .pipe(Effect.mapError(() => new V1ImportUnavailable()));
      return yield* json(200, {
        organization,
        state: "rolled_back",
        ...(into === undefined ? {} : { removed: into.removed }),
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logError("v1 import rollback failed", cause).pipe(
              Effect.andThen(json(503, { error: "unavailable" })),
            ),
      ),
    );

    /**
     * Give a paid organization's subscription back to v1 (`returnBilling`): v1's Team plan in
     * place of v2's on the same Stripe subscription, and v1's customer id again. Run it before
     * the v2 organization is deleted: deleting an organization whose billing carried over cancels
     * its subscription, while one whose billing was returned cancels nothing. Needs the write
     * switch, and is refused while the organization's import instance runs. Running it again
     * after it finished changes nothing.
     */
    const giveBillingBack = Effect.gen(function* () {
      const found = yield* authorized;
      if (Option.isNone(found)) return yield* notFound;
      const { settings } = found.value;
      const refused = writesRefused(settings.writes);
      if (refused !== undefined) return yield* json(409, { error: refused });
      if (Option.isNone(settings.billing))
        return yield* json(409, { error: "This deployment cannot change v1's billing." });
      const decoded = Schema.decodeUnknownOption(V1OrganizationId)(
        (yield* HttpRouter.params).organization,
      );
      if (Option.isNone(decoded)) return yield* json(400, { error: "invalid organization" });
      const organization = decoded.value;
      const state = yield* status(organization);
      if (state === "unknown" || !(stopped.has(state) || state === "complete"))
        return yield* json(409, {
          error: `Its import instance is ${state}; return its billing once it has stopped.`,
        });
      const sql = yield* Effect.flatten(V1ImportDatabase);
      const recorded = yield* makeImportStore(sql).find("organization", organization);
      if (recorded?.status !== "imported" || recorded.v2_id === null)
        return yield* json(409, { error: "The import recorded no v2 organization for it." });
      // An existing organization's billing carried over only from a copy of this organization.
      if (
        recorded.v2_kind === existingOrganization &&
        (yield* billingHoldOf(recorded.v2_id, organization)) === undefined
      )
        return yield* json(409, {
          error: "It moved into an existing v2 organization, and no billing carried over.",
        });
      const billing = importBilling(settings, yield* BillingMeter);
      if (Option.isNone(billing))
        return yield* json(409, { error: "This deployment cannot change v1's billing." });
      const outcome = yield* returnBilling({
        billing: yield* billing.value,
        sql,
        organization: OrganizationId.make(recorded.v2_id),
      }).pipe(
        Effect.as({ returned: true as const }),
        Effect.catchTag("CarryOverRefused", (error) =>
          Effect.succeed({ returned: false as const, reason: error.reason }),
        ),
      );
      return yield* outcome.returned
        ? json(200, { organization, billing: "returned" })
        : json(409, { error: outcome.reason });
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logError("v1 import billing return failed", cause).pipe(
              Effect.andThen(json(503, { error: "unavailable" })),
            ),
      ),
    );

    /**
     * Repair one moved organization as `repairOrganization` says: deploy its MCP apps with v1's
     * approval stamps as their own rules.
     * The body's `apply` defaults to false, which plans the repair and writes nothing. Applying
     * needs the deployment's write switch, and is refused while the organization's import
     * instance runs. The answer lists every change, made or planned, and what it left alone.
     */
    const repair = Effect.gen(function* () {
      const found = yield* authorized;
      if (Option.isNone(found)) return yield* notFound;
      const { settings, reports } = found.value;
      const decoded = Schema.decodeUnknownOption(V1OrganizationId)(
        (yield* HttpRouter.params).organization,
      );
      if (Option.isNone(decoded)) return yield* json(400, { error: "invalid organization" });
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* request.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(RepairRequest)),
        Effect.option,
      );
      if (Option.isNone(body)) return yield* json(400, { error: "invalid body" });
      const apply = body.value.apply === true;
      if (apply) {
        const refused = writesRefused(settings.writes);
        if (refused !== undefined) return yield* json(409, { error: refused });
        const state = yield* status(decoded.value);
        if (state === "unknown" || !(stopped.has(state) || state === "complete"))
          return yield* json(409, {
            error: `Its import instance is ${state}; repair it once it has stopped.`,
          });
      }
      const connections = (yield* McpAuthentication).connections;
      const result = yield* repairOrganization(decoded.value, apply).pipe(
        Effect.scoped,
        Effect.provideService(
          V1ImportEnvironment,
          importEnvironment(settings, reports, connections, yield* BillingMeter),
        ),
      );
      return yield* json(200, result);
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logError("v1 import repair failed", cause).pipe(
              Effect.andThen(json(503, { error: "unavailable" })),
            ),
      ),
    );

    /**
     * Run an earlier version of one of the organization's imported apps again as `restoreApp`
     * says, while the app still runs `expected`. It needs the deployment's write switch. The answer
     * says whether it did, or why not.
     */
    const restore = Effect.gen(function* () {
      const found = yield* authorized;
      if (Option.isNone(found)) return yield* notFound;
      const decoded = Schema.decodeUnknownOption(V1OrganizationId)(
        (yield* HttpRouter.params).organization,
      );
      if (Option.isNone(decoded)) return yield* json(400, { error: "invalid organization" });
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* request.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(AppRestore)),
        Effect.option,
      );
      if (Option.isNone(body)) return yield* json(400, { error: "invalid body" });
      const refused = writesRefused(found.value.settings.writes);
      if (refused !== undefined) return yield* json(409, { error: refused });
      const result = yield* restoreApp(decoded.value, body.value);
      return yield* json(result.status === "restored" ? 200 : 409, result);
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logError("v1 import restore failed", cause).pipe(
              Effect.andThen(json(503, { error: "unavailable" })),
            ),
      ),
    );

    /**
     * Repair the copied accounts of one organization that cut over as `repairCopiedAccounts` says.
     * It needs the deployment's write switch, and is refused while the organization's import
     * instance runs. The answer lists each copied account and what changed.
     */
    const accounts = Effect.gen(function* () {
      const found = yield* authorized;
      if (Option.isNone(found)) return yield* notFound;
      const { settings, reports } = found.value;
      const decoded = Schema.decodeUnknownOption(V1OrganizationId)(
        (yield* HttpRouter.params).organization,
      );
      if (Option.isNone(decoded)) return yield* json(400, { error: "invalid organization" });
      const refused = writesRefused(settings.writes);
      if (refused !== undefined) return yield* json(409, { error: refused });
      const state = yield* status(decoded.value);
      if (state === "unknown" || !(stopped.has(state) || state === "complete"))
        return yield* json(409, {
          error: `Its import instance is ${state}; repair it once it has stopped.`,
        });
      const connections = (yield* McpAuthentication).connections;
      const result = yield* repairCopiedAccounts(decoded.value).pipe(
        Effect.scoped,
        Effect.provideService(
          V1ImportEnvironment,
          importEnvironment(settings, reports, connections, yield* BillingMeter),
        ),
      );
      return yield* json(200, result);
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logError("v1 import account repair failed", cause).pipe(
              Effect.andThen(json(503, { error: "unavailable" })),
            ),
      ),
    );

    return { start, report, aggregate, rollback, repair, restore, accounts, giveBillingBack };
  });
