/**
 * Cloud keeps database work beside the database. Cron Triggers run wherever Cloudflare starts
 * them, so each one only asks the API Worker's own placed fetch handler to run its job; that is
 * also the only way anything unplaced may wake the schedule coordinator. Durable Objects serve
 * many calls, so an MCP session holds its connections across calls and operations, replaces one
 * the server drops, makes a stalled connection attempt once more, and closes them once the
 * session has been idle.
 */
import { expect, layer } from "@effect/vitest";
import { Duration, Effect, Schedule, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, type SpanQuery } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Target } from "../support/platform.ts";
import { appsManifest } from "../support/apps-release.ts";

type Spans = (typeof SpanQuery.Type)["data"];

/** Every span of the trace below the first span that satisfies `from`, inclusive. */
const below = (spans: Spans, from: (span: Spans[number]["span"]) => boolean) => {
  const byId = new Map(spans.map(({ span }) => [span.spanId, span]));
  const roots = new Set(spans.filter(({ span }) => from(span)).map(({ span }) => span.spanId));
  return spans.filter(({ span }) => {
    const visited = new Set<string>();
    let current: string | null = span.spanId;
    while (current !== null && !visited.has(current)) {
      if (roots.has(current)) return true;
      visited.add(current);
      current = byId.get(current)?.parentSpanId ?? null;
    }
    return false;
  });
};

/** The chain of span names from a span up to its trace's root. */
const ancestry = (spans: Spans, spanId: string) => {
  const byId = new Map(spans.map(({ span }) => [span.spanId, span]));
  const chain: Array<Spans[number]["span"]> = [];
  let current = byId.get(spanId);
  while (current !== undefined && !chain.includes(current)) {
    chain.push(current);
    current = current.parentSpanId === null ? undefined : byId.get(current.parentSpanId);
  }
  return chain;
};

/**
 * A trace, once the span `select` finds and its whole ancestry up to the trace's root have reached
 * Motel. A parent ends after its children, so it leaves in the same export or a later one, and a
 * refused export is sent again after later ones.
 */
const deliveredAncestry = (traceId: string, select: (span: Spans[number]["span"]) => boolean) =>
  Telemetry.pipe(
    Effect.flatMap((telemetry) => telemetry.query(traceId)),
    Effect.flatMap((trace) => {
      const found = trace.data.find(({ span }) => select(span));
      const chain = found === undefined ? [] : ancestry(trace.data, found.span.spanId);
      return chain.at(-1)?.parentSpanId === null
        ? Effect.succeed({ trace: trace.data, chain })
        : Effect.fail(new Error("The span or its ancestors have not all reached Motel"));
    }),
    Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
  );

const echoAppSource = `import { defineApp, query, object, string, router } from "apps";
export default defineApp({ accounts: {} }, async () => ({ tools: router({
  echo: query({ input: object({ text: string() }), description: "Echo text" },
    async (_ctx, { text }) => ({ text })),
}) }));`;

const scheduledAppSource = `import { defineApp, mutation, interval, object, router } from "apps";
const tick = mutation({ input: object({}) }, async () => ({ done: true }));
export default defineApp({ accounts: {} }, async () => ({ tools: router({ tick }), schedules: { tick: interval({ minutes: 60 }, tick, {}) } }));`;

const Runs = Schema.Array(
  Schema.Struct({ id: Schema.String, name: Schema.String, status: Schema.String }),
);

const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
});

/**
 * Count or terminate one MCP session object's connections in the local database. A stall makes
 * the next connection the object opens wait that many seconds in PostgreSQL's login.
 */
const objectConnections = (
  owner: string,
  options: {
    readonly terminate?: boolean;
    readonly stallNextConnect?: number;
    readonly releaseStalls?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const target = yield* Target;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const output = yield* processes.string(
      ChildProcess.make(
        "node",
        [
          "apps/hosted/testing/database-connections-fixture.ts",
          "--configuration",
          `${target.directory}/sso-database.json`,
          "--owner",
          owner,
          ...(options.terminate === true ? ["--terminate"] : []),
          ...(options.stallNextConnect === undefined
            ? []
            : ["--stall-next-connect", String(options.stallNextConnect)]),
          ...(options.releaseStalls === true ? ["--release-stalls"] : []),
        ],
        { env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, extendEnv: false },
      ),
    );
    return (yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Struct({ connections: Schema.Number })),
    )(output)).connections;
  });

layer(HostedLive, { excludeTestServices: true })("Cloud database placement", (it) => {
  it.effect(scenarios.cloudCronJobsPlaced.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          telemetry = yield* Telemetry,
          evidence = yield* Evidence,
          http = yield* HttpClient.HttpClient;

        yield* evidence.step(
          "The job route refuses callers without the Worker's own key",
          Effect.gen(function* () {
            const anonymous = yield* api.session();
            for (const headers of [{}, { authorization: "Bearer synthetic-wrong-key" }])
              expect(
                (yield* api.request(
                  anonymous,
                  "POST",
                  "/api/internal/jobs/provisioning",
                  undefined,
                  headers,
                )).status,
              ).toBe(404);
          }),
        );

        // The local Worker also fires its minute cron on its own; either tick proves the path.
        const dispatched = telemetry
          .search("job.dispatch", { "executor.job": "provisioning" })
          .pipe(Effect.map((found) => new Set(found.data.map((entry) => entry.traceId))));
        const before = yield* dispatched;
        yield* Effect.scoped(
          http
            .get(
              `${target.metadata.origin}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("* * * * *")}`,
            )
            .pipe(Effect.flatMap((response) => response.text)),
        );
        const job = yield* dispatched.pipe(
          Effect.map((after) => [...after].filter((trace) => !before.has(trace))),
          Effect.flatMap((fresh) =>
            Effect.forEach(fresh, (trace) => telemetry.query(trace)).pipe(
              Effect.map((traces) =>
                traces
                  .flatMap((trace) => trace.data)
                  .filter(({ span }) => span.operationName === "job.provisioning.dispatch"),
              ),
            ),
          ),
          Effect.flatMap((found) =>
            found[0] === undefined
              ? Effect.fail(new Error("No dispatched provisioning job has reached Motel"))
              : Effect.succeed(found[0]),
          ),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
        );
        const { trace, chain } = yield* deliveredAncestry(
          job.traceId,
          (span) => span.spanId === job.span.spanId,
        );
        yield* evidence.json(
          "provisioning-job-ancestry.json",
          chain.map((span) => ({ name: span.operationName, tags: span.tags })),
        );
        const server = chain.findIndex(
          (span) =>
            span.operationName.startsWith("http.server") &&
            span.tags["url.path"] === "/api/internal/jobs/provisioning",
        );
        const trigger = chain.findIndex((span) => span.operationName === "job.dispatch");
        expect(server, "The job must run in the API Worker's fetch handler").toBeGreaterThan(0);
        expect(trigger, "The fetch handler must be started by the cron's dispatch").toBeGreaterThan(
          server,
        );
        // The cron invocation itself opens no database connection.
        const triggerSpan = chain[trigger];
        if (triggerSpan === undefined) return yield* Effect.die("Missing dispatch span");
        const outside = below(trace, (span) => span.spanId === triggerSpan.spanId).filter(
          ({ span }) =>
            span.operationName === "sql.connect" &&
            !ancestry(trace, span.spanId).some(
              (parent) => parent.tags["url.path"] === "/api/internal/jobs/provisioning",
            ),
        );
        expect(outside).toEqual([]);
      }),
    ),
  );

  it.effect(
    scenarios.cloudMcpObjectConnections.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            mcp = yield* McpClient,
            evidence = yield* Evidence,
            telemetry = yield* Telemetry;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const key = yield* body(
            Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
            yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
              name: "Object connections",
            }),
          );
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
              .pipe(Effect.orDie),
          );
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Object connections ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: echoAppSource }, appsManifest],
          });
          expect(deployed.status).toBe(200);
          const app = yield* body(App, deployed);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
          );
          // The session's first requests, from initialization on, are part of its first window.
          const opened = (yield* evidence.requests).length;
          const client = yield* mcp.connect(key.key, "object-connections", {
            organization: actors.organization.id,
          });
          // Six sequential tool calls: each is its own MCP operation inside the session object.
          const execute = (label: string) =>
            Effect.gen(function* () {
              const seen = (yield* evidence.requests).length;
              const result = yield* client.use(label, (client, signal) =>
                client.callTool(
                  {
                    name: "execute",
                    arguments: {
                      code: `const out = [];
for (let i = 0; i < 6; i++) out.push((await tools[${JSON.stringify(app.slug)}].echo({ text: String(i) })).text);
return out;`,
                    },
                  },
                  undefined,
                  { signal },
                ),
              );
              const completed = yield* Schema.decodeUnknownEffect(Completed)(
                result.structuredContent,
              );
              expect(completed.execution.value).toEqual(["0", "1", "2", "3", "4", "5"]);
              return (yield* evidence.requests).slice(seen).map((request) => request.traceId);
            });
          // The session object's own spans, once each one a check reads has reached Motel. A
          // request's spans leave the object in several exports, one each second while it runs and
          // one when it ends, and a refused export is sent again later, so they arrive in any order.
          type Counts = Record<"operations" | "databases" | "connects" | "windows", number>;
          const sessionSpans = (
            traces: ReadonlyArray<string>,
            ready: (counts: Counts) => boolean,
          ) =>
            Effect.forEach(traces, (trace) => telemetry.query(trace)).pipe(
              Effect.map((results) =>
                results.flatMap((result) =>
                  below(result.data, (span) => span.operationName === "mcp.session.request"),
                ),
              ),
              Effect.flatMap((spans) => {
                const count = (name: string) =>
                  spans.filter(({ span }) => span.operationName === name).length;
                const counts = {
                  operations: count("mcp.backend.dispatch"),
                  databases: count("runtime.cloud.database.initialize"),
                  connects: count("sql.connect"),
                  windows: count("database.object.open"),
                };
                return ready(counts)
                  ? Effect.succeed({
                      ...counts,
                      object: spans
                        .map(({ span }) => span.tags["executor.mcp.object_id"])
                        .find((id) => id !== undefined),
                    })
                  : Effect.fail(
                      new Error(
                        `The session's spans have not reached Motel: ${JSON.stringify(counts)}`,
                      ),
                    );
              }),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
            );

          yield* execute("Six tool calls");
          yield* execute("Six more tool calls");
          const first = yield* sessionSpans(
            (yield* evidence.requests).slice(opened).map((request) => request.traceId),
            (counts) => counts.operations >= 12 && counts.databases >= 12 && counts.windows >= 1,
          );
          yield* evidence.json("first-window.json", first);
          expect(first.databases, "Each operation resolves its database").toBeGreaterThanOrEqual(
            12,
          );
          expect(first.connects, "Operations reuse the object's connections").toBeLessThanOrEqual(
            3,
          );
          expect(first.windows, "The session's calls share one activity window").toBe(1);
          const object = first.object;
          if (object === undefined) return yield* Effect.die("Missing the session object's ID");
          const owner = `mcp ${object}`;

          // A connection the server drops is replaced on the next use, inside the same window.
          expect(yield* objectConnections(owner, { terminate: true })).toBeGreaterThan(0);
          const dropped = yield* sessionSpans(
            yield* execute("Tool calls after a dropped connection"),
            (counts) => counts.operations >= 6 && counts.connects >= 1,
          );
          yield* evidence.json("after-drop.json", dropped);
          expect(dropped.windows).toBe(0);
          expect(dropped.connects).toBeGreaterThan(0);

          // Once the session has been idle, it holds no connection; the next call opens a window.
          yield* Effect.sleep(Duration.seconds(32));
          expect(yield* objectConnections(owner)).toBe(0);
          const reopened = yield* sessionSpans(
            yield* execute("Tool calls after idling"),
            (counts) => counts.operations >= 6 && counts.windows >= 1 && counts.connects >= 1,
          );
          yield* evidence.json("after-idle.json", reopened);
          expect(reopened.windows).toBe(1);
          expect(reopened.connects).toBeGreaterThan(0);
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 120_000 },
  );

  it.effect(scenarios.cloudMcpObjectConnectRetry.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry;
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Object connect retry",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        // The session object's own spans for some requests, once `ready` finds them in Motel.
        const objectSpans = (
          traces: ReadonlyArray<string>,
          ready: (spans: ReadonlyArray<Spans[number]["span"]>) => boolean,
        ) =>
          Effect.forEach(traces, (trace) => telemetry.query(trace)).pipe(
            Effect.map((results) =>
              results
                .flatMap((result) =>
                  below(result.data, (span) => span.operationName === "mcp.session.request"),
                )
                .map(({ span }) => span),
            ),
            Effect.flatMap((spans) =>
              ready(spans)
                ? Effect.succeed(spans)
                : Effect.fail(new Error("The session's spans have not reached Motel")),
            ),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
          );

        const opened = (yield* evidence.requests).length;
        const client = yield* mcp.connect(key.key, "object-connect-retry", {
          organization: actors.organization.id,
        });
        const object = (yield* objectSpans(
          (yield* evidence.requests).slice(opened).map((request) => request.traceId),
          (spans) => spans.some((span) => span.tags["executor.mcp.object_id"] !== undefined),
        ))
          .map((span) => span.tags["executor.mcp.object_id"])
          .find((id) => id !== undefined);
        if (object === undefined) return yield* Effect.die("Missing the session object's ID");
        const owner = `mcp ${object}`;

        // Drop the object's connections and hold the next one it opens in PostgreSQL's login for
        // longer than an attempt may take. Nothing has been sent on it, so the pool tries again.
        expect(
          yield* objectConnections(owner, { stallNextConnect: 8, terminate: true }),
        ).toBeGreaterThan(0);
        yield* Effect.addFinalizer(() =>
          objectConnections(owner, { releaseStalls: true }).pipe(Effect.orDie),
        );
        const seen = (yield* evidence.requests).length;
        const listed = yield* client.use("List tools while a connection stalls", (client, signal) =>
          client.listTools(undefined, { signal }),
        );
        expect(listed.tools.length).toBeGreaterThan(0);
        const connects = (yield* objectSpans(
          (yield* evidence.requests).slice(seen).map((request) => request.traceId),
          (spans) =>
            spans.some(
              (span) =>
                span.operationName === "sql.connect" && span.tags["db.connect.attempt"] === "2",
            ),
        )).filter((span) => span.operationName === "sql.connect");
        yield* evidence.json(
          "object-connects.json",
          connects.map((span) => ({
            attempt: span.tags["db.connect.attempt"],
            retryReason: span.tags["db.connect.retry_reason"],
            durationMs: span.durationMs,
            status: span.status,
          })),
        );
        const retried = connects.filter((span) => span.tags["db.connect.attempt"] === "2");
        expect(retried.map((span) => span.tags["db.connect.retry_reason"])).toEqual([
          "PgConnection: Connection timed out",
        ]);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(
    scenarios.cloudScheduleCoordinatorPlaced.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            target = yield* Target,
            telemetry = yield* Telemetry,
            evidence = yield* Evidence,
            http = yield* HttpClient.HttpClient;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Coordinator ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: scheduledAppSource }, appsManifest],
          });
          expect(deployed.status).toBe(200);
          const app = yield* body(App, deployed);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
          );
          const schedule = `${prefix}/apps/${app.id}/schedules/tick`;
          expect(
            (yield* api.request(actors.owner, "PATCH", schedule, {
              enabled: true,
              approvalMode: "automatic",
            })).status,
          ).toBe(200);

          // A Cron Trigger's wake reaches the coordinator only through the placed fetch handler,
          // so the coordinator can never be created where the trigger happens to run.
          const dispatched = telemetry
            .search("job.dispatch", { "executor.job": "schedule-wake" })
            .pipe(Effect.map((found) => new Set(found.data.map((entry) => entry.traceId))));
          const before = yield* dispatched;
          yield* Effect.scoped(
            http
              .get(
                `${target.metadata.origin}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("* * * * *")}`,
              )
              .pipe(Effect.flatMap((response) => response.text)),
          );
          const wake = yield* dispatched.pipe(
            Effect.map((after) => [...after].filter((trace) => !before.has(trace))),
            Effect.flatMap((fresh) => Effect.forEach(fresh, (trace) => telemetry.query(trace))),
            Effect.map((traces) =>
              traces
                .flatMap((trace) => trace.data)
                .filter(
                  ({ span }) =>
                    span.operationName === "schedule.wake" &&
                    span.tags["executor.schedule.wake"] === "job",
                ),
            ),
            Effect.flatMap((found) =>
              found[0] === undefined
                ? Effect.fail(new Error("No cron wake of the coordinator has reached Motel"))
                : Effect.succeed(found[0]),
            ),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
          );
          const { chain } = yield* deliveredAncestry(
            wake.traceId,
            (span) => span.spanId === wake.span.spanId,
          );
          yield* evidence.json(
            "schedule-wake-ancestry.json",
            chain.map((span) => ({ name: span.operationName, tags: span.tags })),
          );
          const server = chain.findIndex(
            (span) =>
              span.operationName.startsWith("http.server") &&
              span.tags["url.path"] === "/api/internal/jobs/schedule-wake",
          );
          expect(server, "The wake must run in the API Worker's fetch handler").toBeGreaterThan(0);
          expect(
            chain.findIndex((span) => span.operationName === "job.dispatch"),
            "The fetch handler must be started by the cron's dispatch",
          ).toBeGreaterThan(server);

          // Runs keep going through the coordinator: every accepted Run Now gets exactly one run.
          // Each waits for the previous run, so no request can share a run with another.
          const listRuns = api
            .request(actors.owner, "GET", `${prefix}/scheduled-runs?app=${app.id}`)
            .pipe(Effect.flatMap((response) => body(Runs, response)));
          for (let round = 1; round <= 3; round++) {
            expect((yield* api.request(actors.owner, "POST", `${schedule}/run`)).status).toBe(200);
            yield* listRuns.pipe(
              Effect.flatMap((runs) =>
                runs.filter((run) => run.name === "tick" && run.status === "succeeded").length >=
                round
                  ? Effect.void
                  : Effect.fail(new Error(`Scheduled run ${round} has not succeeded`)),
              ),
              Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 120 }),
            );
          }
          const runs = (yield* listRuns).filter((run) => run.name === "tick");
          yield* evidence.json("scheduled-runs.json", runs);
          expect(runs.map((run) => run.status)).toEqual(["succeeded", "succeeded", "succeeded"]);

          // Motel matches operation names by prefix, so `schedule.retire` would also find
          // `schedule.retired`.
          const spans = (operation: string, attributes: Record<string, string> = {}) =>
            telemetry
              .search(operation, attributes)
              .pipe(
                Effect.map((found) =>
                  found.data.filter(({ span }) => span.operationName === operation),
                ),
              );
          // The dispatches of this app's runs, which leave in other exports than the runs.
          const dispatching = (found: { readonly runs: Spans; readonly dispatches: Spans }) => {
            const runTraces = new Set(found.runs.map((entry) => entry.traceId));
            return found.dispatches.filter((entry) => runTraces.has(entry.traceId));
          };
          const coordinator = yield* Effect.all({
            handovers: spans("schedule.handover"),
            retirements: spans("schedule.retire"),
            runs: spans("schedule.run", { "executor.app.id": app.id }),
            dispatches: spans("schedule.dispatch", { "executor.schedule.runner": "cloud" }),
          }).pipe(
            Effect.flatMap((found) =>
              found.handovers.length === 0 ||
              found.retirements.length === 0 ||
              found.runs.length < 3 ||
              dispatching(found).length === 0
                ? Effect.fail(new Error("The coordinator's spans have not reached Motel"))
                : Effect.succeed(found),
            ),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
          );
          yield* evidence.json(
            "coordinator-spans.json",
            Object.fromEntries(
              Object.entries(coordinator).map(([name, found]) => [
                name,
                found.map(({ span }) => ({ name: span.operationName, tags: span.tags })),
              ]),
            ),
          );
          // The first coordinator is retired once, before the new one dispatches anything. Every
          // coordinator instance calls `retire()` too, before its first wake arms it, to re-arm the
          // heartbeat.
          expect(coordinator.handovers).toHaveLength(1);
          expect(coordinator.retirements.length).toBeGreaterThanOrEqual(1);
          // The coordinator dispatches as `cloud`, as the first one did, and records where it runs.
          const runDispatches = dispatching(coordinator);
          expect(runDispatches.length).toBeGreaterThan(0);
          for (const { span } of runDispatches)
            expect(span.tags["cloudflare.colo"]).toMatch(/^(?:[A-Z]+|unknown)$/);

          // The retired coordinator keeps its alarm as a minute heartbeat, so a revert finds it armed.
          // Nothing here starts a cron after the first one: each heartbeat re-arms itself and wakes
          // the coordinator through the placed handler. Its spans record the clock it read and the
          // alarm it found and left, so these checks do not depend on when an alarm is delivered.
          const heartbeat = (entry: {
            readonly span: { readonly tags: Record<string, string> };
          }) => {
            const read = (name: string) => {
              const value = entry.span.tags[`executor.schedule.heartbeat.${name}`];
              return value === undefined ? undefined : Number(value);
            };
            const at = read("at");
            const armed = read("armed");
            expect(at, "The span must record the time it read").toBeDefined();
            expect(armed, "The span must record the alarm it left").toBeDefined();
            return { at: at ?? NaN, armed: armed ?? NaN, pending: read("pending") };
          };
          const heartbeats = spans("schedule.retired", { "executor.schedule.wake": "alarm" }).pipe(
            Effect.map((found) =>
              found
                .map((entry) => ({ trace: entry.traceId, ...heartbeat(entry) }))
                .sort((left, right) => left.at - right.at),
            ),
          );
          const known = new Set((yield* heartbeats).map((beat) => beat.trace));
          const fresh = yield* heartbeats.pipe(
            Effect.map((found) => found.filter((beat) => !known.has(beat.trace))),
            Effect.flatMap((found) =>
              found.length < 2
                ? Effect.fail(new Error(`${found.length} of 2 heartbeats have reached Motel`))
                : Effect.succeed(found),
            ),
            Effect.retry({ schedule: Schedule.spaced("1 second"), times: 150 }),
          );
          // Each heartbeat arms the next a minute after it fires, and each later one is the alarm
          // the one before armed, never an earlier one. Delayed telemetry can reveal more than two.
          for (const beat of fresh) expect(beat.armed - beat.at).toBe(60_000);
          for (const [index, beat] of fresh.slice(1).entries())
            expect(beat.at, "A heartbeat must arm only the next one").toBeGreaterThanOrEqual(
              fresh[index]!.armed,
            );
          // `retire()` and forwarded wakes keep an earlier alarm and bring a later or missing one in
          // to a minute away, so no wake can postpone the heartbeat or leave it further off.
          const kept = [
            ...(yield* spans("schedule.retire")),
            ...(yield* spans("schedule.retired", { "executor.schedule.wake": "wake" })),
          ].map(heartbeat);
          yield* evidence.json("heartbeat-deadlines.json", { heartbeats: fresh, kept });
          expect(kept.length).toBeGreaterThan(0);
          for (const { at, armed, pending } of kept)
            expect(armed).toBe(Math.min(pending ?? Infinity, at + 60_000));
          const forwarded = yield* Effect.forEach(fresh, ({ trace }) =>
            deliveredAncestry(
              trace,
              (span) =>
                span.operationName === "schedule.wake" &&
                span.tags["executor.schedule.wake"] === "job",
            ).pipe(
              Effect.map(({ trace, chain }) => ({
                cron: trace.some(({ span }) => span.operationName === "faas.cron"),
                path: chain.map((span) => ({ name: span.operationName, status: span.status })),
              })),
            ),
          );
          yield* evidence.json("heartbeats.json", forwarded);
          for (const { cron, path } of forwarded) {
            expect(cron).toBe(false);
            expect(path.map((span) => span.name)).toEqual(
              expect.arrayContaining(["schedule.wake", "job.dispatch", "schedule.retired"]),
            );
            expect(path.filter((span) => span.status === "error")).toEqual([]);
          }
        }),
      ),
    { timeout: 240_000 },
  );
});
