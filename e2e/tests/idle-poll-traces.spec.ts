/**
 * An idle server's frequent polls export nothing; a job a poll finds is still traced, and so is a
 * poll that fails, with the statement that failed.
 */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, FileSystem, Layer, Schedule, Schema } from "effect";
import { HttpClient } from "effect/http";
import { Api, SessionClients } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { SpanQuery } from "../support/contracts.ts";
import { startControlledSelfHost, startFreshSelfHost } from "../support/managed-server.ts";
import { serveOtlpCollector } from "../support/otlp-collector.ts";
import { Target } from "../support/platform.ts";
import { Evidence } from "../support/evidence.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

/** The scheduler and provisioning poll every second and event delivery every two. */
const idleWindow = "10 seconds";
/** The product exports spans every second. */
const exportDelay = "3 seconds";
/** Tables only these polls read while nobody calls the server. */
const polled = [
  "executor_scheduled_runs",
  "executor_schedules",
  "hosted_provisioning",
  "executor_event_deliveries",
  "executor_event_subscriptions",
];
/** Spans only the event delivery pass starts. */
const passes = new Set(["events.dispatch", "sdk.events.deliver"]);

/** Spans in `collector` that started in [from, to), newest first; Motel answers at most 500 a search. */
const exported = (collector: string, from: number, to: number, operation?: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const url = new URL("/api/spans/search", collector);
        if (operation !== undefined) url.searchParams.set("operation", operation);
        url.searchParams.set("lookback", "1h");
        url.searchParams.set("limit", "10000");
        const response = yield* http.get(url.href);
        return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(SpanQuery)));
      }),
    ).pipe(
      Effect.map(({ data }) =>
        data.filter(({ span }) => {
          const at = Date.parse(span.startTime);
          return at >= from && at < to;
        }),
      ),
    );
  });

/** What a root records beside its failure: the statement that failed. */
const detail = (tags: Readonly<Record<string, string>>) =>
  Object.fromEntries(Object.entries(tags).filter(([key]) => key.startsWith("executor.storage.")));
/** Each failing poll's own trace: a root span, failed, with the failure it recorded. */
const failedRoots = (spans: typeof SpanQuery.Type.data) =>
  spans
    .filter(({ span }) => span.parentSpanId === null && span.status === "error")
    .map(({ span }) => ({
      operation: span.operationName,
      exception: span.events.find(({ name }) => name === "exception")?.attributes ?? {},
      detail: detail(span.tags),
    }));
/** The failure type each failing poll's root recorded, by its operation. */
const failureTypes = (roots: ReturnType<typeof failedRoots>) =>
  Object.fromEntries(
    roots.map(({ operation, exception }) => [operation, exception["exception.type"]]),
  );
/** The roots `operation` exported, oldest first. */
const of = <A extends { readonly operation: string }>(roots: ReadonlyArray<A>, operation: string) =>
  roots.filter((root) => root.operation === operation).reverse();

layer(TestLive, { excludeTestServices: true })("Idle poll traces", (it) => {
  it.effect(scenarios.idlePollTraces.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          fs = yield* FileSystem.FileSystem,
          evidence = yield* Evidence;
        // The server's only collector, so every span in it is the server's.
        const directory = yield* fs.makeTempDirectory({
          directory: target.directory,
          prefix: "collector",
        });
        const collector = yield* serveOtlpCollector(directory);
        const origin = yield* startFreshSelfHost(target, {
          OTEL_EXPORTER_OTLP_ENDPOINT: collector,
        });
        const spans = (from: number, to: number, operation?: string) =>
          exported(collector, from, to, operation);

        // Startup's one-off steps finish first; then nothing is due and no one calls.
        yield* Effect.sleep("5 seconds");
        const idleFrom = yield* Clock.currentTimeMillis;
        yield* Effect.sleep(idleWindow);
        const idleTo = yield* Clock.currentTimeMillis;
        yield* Effect.sleep(exportDelay);
        const idle = yield* spans(idleFrom, idleTo);
        const polls = idle.filter(
          ({ span }) =>
            passes.has(span.operationName) ||
            polled.some((table) => (span.tags["db.query.text"] ?? "").includes(table)),
        );
        yield* evidence.json(
          "idle-poll-spans.json",
          polls.map(({ traceId, span }) => ({
            traceId,
            operation: span.operationName,
            query: span.tags["db.query.text"],
          })),
        );
        expect(
          new Set(polls.map(({ traceId }) => traceId)).size,
          "Idle polls for due runs, queued jobs and event deliveries export no traces",
        ).toBe(0);

        // First-admin setup queues the owner's member setup. The poll that finds the job records
        // nothing of its own, so the job's trace is a root.
        const api = yield* Api.pipe(
          Effect.provide(Layer.fresh(Api.layer)),
          Effect.provide(Layer.fresh(SessionClients.layer)),
          Effect.provideService(Target, { ...target, metadata: { ...target.metadata, origin } }),
        );
        const owner = yield* api.session();
        const setupFrom = yield* Clock.currentTimeMillis;
        expect(
          (yield* api.request(owner, "POST", "/api/auth/self-host/setup", {
            name: "Idle Owner",
            email: "idle-owner@example.test",
            password: "Synthetic-idle-password-123!",
            organizationName: "Idle lab",
          })).status,
        ).toBe(200);
        const jobs = yield* spans(setupFrom, Number.MAX_SAFE_INTEGER, "hosted.provision").pipe(
          Effect.map((found) => found.filter(({ span }) => span.parentSpanId === null)),
          Effect.filterOrFail(
            (found) => found.length > 0,
            () => new Error("No provisioning job the poll found has been exported yet"),
          ),
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 20 }),
        );
        yield* evidence.json(
          "polled-jobs.json",
          jobs.map(({ traceId, span }) => ({ traceId, tags: span.tags })),
        );
      }),
    ),
  );

  it.effect(scenarios.failedPollTraces.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          fs = yield* FileSystem.FileSystem,
          evidence = yield* Evidence;
        const directory = yield* fs.makeTempDirectory({
          directory: target.directory,
          prefix: "collector",
        });
        const collector = yield* serveOtlpCollector(directory);
        const instance = yield* startControlledSelfHost(target, {
          OTEL_EXPORTER_OTLP_ENDPOINT: collector,
        });
        /** Restart the stopped instance over `statements` and return the failed roots it exports. */
        const failingAfter = (
          statements: Parameters<typeof legacyStorage>[0],
          expected: Readonly<Record<string, string>>,
        ) =>
          Effect.gen(function* () {
            yield* legacyStorage(statements);
            const from = yield* Clock.currentTimeMillis;
            yield* serverControl("start");
            // Each poll runs every one or two seconds and the product exports every second.
            return yield* exported(collector, from, Number.MAX_SAFE_INTEGER).pipe(
              Effect.map(failedRoots),
              Effect.repeat({
                schedule: Schedule.spaced("1 second"),
                until: (found) =>
                  Object.keys(expected).every((name) => name in failureTypes(found)),
                times: 20,
              }),
            );
          }).pipe(Effect.provideService(Target, instance));

        // Each poll reads a column that is no longer there.
        const polls = {
          "events.dispatch": "StorageError",
          "schedule.dispatch": "StorageError",
          "hosted.provisioning.poll": "SqlError",
        };
        const broken = yield* failingAfter(
          [
            {
              sql: "ALTER TABLE executor_event_subscriptions RENAME COLUMN expires_at TO broken_expires_at",
            },
            { sql: "ALTER TABLE executor_schedules RENAME COLUMN next_at TO broken_next_at" },
            {
              sql: "ALTER TABLE hosted_provisioning RENAME COLUMN available_at TO broken_available_at",
            },
          ],
          polls,
        );
        expect(
          failureTypes(broken),
          "Each failing poll exports its failure as a root span",
        ).toMatchObject(polls);
        yield* evidence.json("failed-polls.json", broken);
        // The root says which statement failed and how, though the poll only sees a StorageError.
        const subscriptions = of(broken, "events.dispatch")[0]?.detail;
        expect(subscriptions, "The event poll names its failed statement").toMatchObject({
          "executor.storage.operation": "findMany",
          "executor.storage.table": "eventSubscriptions",
          "executor.storage.reason": "SqlSyntaxError",
        });
        expect(of(broken, "schedule.dispatch")[0]?.detail).toMatchObject({
          "executor.storage.operation": "findMany",
          "executor.storage.table": "schedules",
          "executor.storage.reason": "SqlSyntaxError",
        });

        // A different statement of the same poll fails: its root says which.
        const deliveries = yield* failingAfter(
          [
            {
              sql: "ALTER TABLE executor_event_subscriptions RENAME COLUMN broken_expires_at TO expires_at",
            },
            {
              sql: "ALTER TABLE executor_event_deliveries RENAME COLUMN next_at TO broken_next_at",
            },
          ],
          { "events.dispatch": "StorageError" },
        );
        const due = of(deliveries, "events.dispatch")[0]?.detail;
        yield* evidence.json("failed-statements.json", { subscriptions, due });
        expect(due, "The event poll names the other failed statement").toMatchObject({
          "executor.storage.operation": "findMany",
          "executor.storage.table": "eventDeliveries",
          "executor.storage.reason": "SqlSyntaxError",
        });
        expect(due).not.toEqual(subscriptions);

        // Event delivery reads again, but claiming a due delivery and retention both fail. Both
        // are caught inside a pass that otherwise succeeds.
        const steps = {
          "sdk.events.claim": "StorageError",
          "sdk.events.retention": "StorageError",
        };
        const caught = yield* failingAfter(
          [
            {
              sql: "ALTER TABLE executor_event_deliveries RENAME COLUMN broken_next_at TO next_at",
            },
            {
              sql: `INSERT INTO executor_event_deliveries
                (id, subscription, event, status, attempts, next_at, lease, lease_until, created_at)
                VALUES ('due-delivery', 'synthetic-subscription', 'synthetic-event', 'pending', 0, now(), NULL, '1970-01-01', now())`,
            },
            {
              sql: `CREATE FUNCTION refuse_claim() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN IF NEW.lease IS NOT NULL THEN RAISE EXCEPTION 'synthetic claim failure'; END IF; RETURN NEW; END $$`,
            },
            {
              sql: "CREATE TRIGGER refuse_claim BEFORE UPDATE ON executor_event_deliveries FOR EACH ROW EXECUTE FUNCTION refuse_claim()",
            },
            {
              sql: `CREATE FUNCTION refuse_retention() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN RAISE EXCEPTION 'synthetic retention failure'; END $$`,
            },
            {
              sql: "CREATE TRIGGER refuse_retention BEFORE DELETE ON executor_events FOR EACH STATEMENT EXECUTE FUNCTION refuse_retention()",
            },
          ],
          steps,
        );
        expect(
          failureTypes(caught),
          "A failing claim and retention each export a root span",
        ).toMatchObject(steps);
        yield* evidence.json("failed-steps.json", caught);
        expect(of(caught, "sdk.events.claim")[0]?.detail).toMatchObject({
          "executor.storage.operation": "updateMany",
          "executor.storage.table": "eventDeliveries",
          "executor.storage.reason": "UnknownError",
        });
        expect(of(caught, "sdk.events.retention")[0]?.detail).toMatchObject({
          "executor.storage.operation": "deleteMany",
          "executor.storage.table": "events",
          "executor.storage.reason": "UnknownError",
        });
      }),
    ),
  );
});
