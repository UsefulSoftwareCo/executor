import { expect, layer } from "@effect/vitest";
import { Clock, Effect, FileSystem, Layer, Schedule } from "effect";
import { Api, SessionClients } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import type { SpanQuery } from "../support/contracts.ts";
import { startControlledSelfHost, startFreshSelfHost } from "../support/managed-server.ts";
import { ownCollectorSpans, serveOtlpCollector } from "../support/otlp-collector.ts";
import { Target } from "../support/platform.ts";
import { Evidence } from "../support/evidence.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const idleWindow = "10 seconds";
const exportDelay = "3 seconds";
const polled = [
  "executor_scheduled_runs",
  "executor_schedules",
  "hosted_provisioning",
  "executor_event_deliveries",
  "executor_event_subscriptions",
];
const passes = new Set(["events.dispatch", "sdk.events.deliver"]);

const exported = (collector: string, from: number, to: number, operation?: string) =>
  ownCollectorSpans(collector, { from, to, operation });

const detail = (tags: Readonly<Record<string, string>>) =>
  Object.fromEntries(Object.entries(tags).filter(([key]) => key.startsWith("executor.storage.")));
const failedRoots = (spans: typeof SpanQuery.Type.data) =>
  spans
    .filter(({ span }) => span.parentSpanId === null && span.status === "error")
    .map(({ span }) => ({
      operation: span.operationName,
      exception: span.events.find(({ name }) => name === "exception")?.attributes ?? {},
      detail: detail(span.tags),
    }));
const failureTypes = (roots: ReturnType<typeof failedRoots>) =>
  Object.fromEntries(
    roots.map(({ operation, exception }) => [operation, exception["exception.type"]]),
  );
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
        const failingAfter = (
          statements: Parameters<typeof legacyStorage>[0],
          expected: Readonly<Record<string, string>>,
        ) =>
          Effect.gen(function* () {
            yield* legacyStorage(statements);
            const from = yield* Clock.currentTimeMillis;
            yield* serverControl("start");
            return yield* Effect.forEach(Object.keys(expected), (operation) =>
              exported(collector, from, Number.MAX_SAFE_INTEGER, operation),
            ).pipe(
              Effect.map((found) => failedRoots(found.flat())),
              Effect.repeat({
                schedule: Schedule.spaced("1 second"),
                until: (found) =>
                  Object.keys(expected).every((name) => name in failureTypes(found)),
                times: 20,
              }),
            );
          }).pipe(Effect.provideService(Target, instance));

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
