/**
 * Cloud keeps database work beside the database. Cron Triggers run wherever Cloudflare starts
 * them, so each one only asks the API Worker's own placed fetch handler to run its job; that is
 * also the only way anything unplaced may wake the schedule coordinator. Durable Objects serve
 * many calls, so an MCP session holds its connections across calls and operations, replaces one
 * the server drops, makes a stalled connection attempt once more, and closes them once the
 * session has been idle. The statements one request or tool call issues at the same time share one
 * of the session's connections, which carries nothing else meanwhile; each call still gets its own
 * rows, beside transactions that reserve a connection. A statement a caller gives up on while it
 * waits on a lock is cancelled in the database and delays no other call.
 */
import { expect, layer } from "@effect/vitest";
import { Duration, Effect, Fiber, Schedule, Schema } from "effect";
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
      // Motel answers a span whose parent has not arrived with a placeholder root in its place.
      return chain.at(-1)?.parentSpanId === null &&
        !chain.some((span) => span.operationName.startsWith("[missing parent"))
        ? Effect.succeed({ trace: trace.data, chain })
        : Effect.fail(new Error("The span or its ancestors have not all reached Motel"));
    }),
    Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
  );

const echoAppSource = `import { defineApp, query, object, string, router } from "apps";
export default defineApp({}, async () => ({ tools: router({
  echo: query({ input: object({ text: string() }), description: "Echo text" },
    async (_ctx, { text }) => ({ text })),
}) }));`;

/** A query that answers after the given number of milliseconds. */
const timerAppSource = `import { defineApp, query, object, number, router } from "apps";
export default defineApp({}, async () => ({ tools: router({
  wait: query({ input: object({ ms: number() }) },
    async (_ctx, { ms }) => { await new Promise((resolve) => setTimeout(resolve, ms)); return { ms }; }),
}) }));`;

/** An echo query and an echo mutation that always needs approval. */
const reviewedAppSource = `import { defineApp, query, mutation, object, string, router } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({}, async () => ({ tools: router({
  echo: query({ input: object({ text: string() }) }, async (_ctx, { text }) => ({ text })),
  review: mutation({ input: object({ text: string() }), approval: always() },
    async (_ctx, { text }) => ({ text })),
}) }));`;

const Pending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
});

/** The session object's connection limit (`objectConnectionLimit` in object-database.ts). */
const objectConnectionLimit = 4;

const scheduledAppSource = `import { defineApp, mutation, userInterval, object, router } from "apps";
const tick = mutation({ input: object({}) }, async () => ({ done: true }));
export default defineApp({}, async () => ({ tools: router({ tick }), schedules: { tick: userInterval({ minutes: 60 }, tick, {}) } }));`;

const Runs = Schema.Array(
  Schema.Struct({ id: Schema.String, name: Schema.String, status: Schema.String }),
);

const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
});

/**
 * Count or terminate one MCP session object's connections in the local database. A stall makes
 * the next connection the object opens wait that many seconds in PostgreSQL's login. A statement
 * stall makes the object's token update after `stallTokenUpdateAfter` more wait on the lock
 * `holdLock` holds for that many seconds. `largeAppRow` makes reads of that app's row wait on the
 * lock `holdLargeAppRows` holds, while reads of other apps' rows go on (see
 * database-connections-fixture.ts).
 */
const objectDatabase = (
  owner: string,
  options: {
    readonly terminate?: boolean;
    readonly stallNextConnect?: number;
    readonly releaseStalls?: boolean;
    readonly holdLock?: number;
    readonly stallTokenUpdateAfter?: number;
    readonly largeAppRow?: string;
    readonly holdLargeAppRows?: number;
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
          ...(options.holdLock === undefined ? [] : ["--hold-lock", String(options.holdLock)]),
          ...(options.stallTokenUpdateAfter === undefined
            ? []
            : ["--stall-token-update-after", String(options.stallTokenUpdateAfter)]),
          ...(options.largeAppRow === undefined ? [] : ["--large-app-row", options.largeAppRow]),
          ...(options.holdLargeAppRows === undefined
            ? []
            : ["--hold-large-app-rows", String(options.holdLargeAppRows)]),
        ],
        {
          env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
          extendEnv: false,
        },
      ),
    );
    return yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          connections: Schema.Number,
          waiting: Schema.Number,
          holding: Schema.Number,
        }),
      ),
    )(output);
  });

/** Poll an object's database state until `done` holds. */
const untilObject = (
  owner: string,
  label: string,
  done: (state: Effect.Success<ReturnType<typeof objectDatabase>>) => boolean,
) =>
  objectDatabase(owner).pipe(
    Effect.flatMap((current) =>
      done(current) ? Effect.succeed(current) : Effect.fail(new Error(label)),
    ),
    Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
  );

/**
 * The SQL statements of the last MCP request's tool call, outside the app's runtime: their text,
 * when each ended, and whether it is one of the access check's reads made beside the recheck.
 */
const toolCallStatements = Effect.gen(function* () {
  const evidence = yield* Evidence,
    telemetry = yield* Telemetry;
  const request = (yield* evidence.requests).filter((request) => request.path === "/mcp").at(-1);
  if (request === undefined) return yield* Effect.die("MCP request evidence missing");
  return yield* telemetry.query(request.traceId).pipe(
    Effect.flatMap((trace) => {
      const calls = below(trace.data, (span) => span.operationName === "mcp.tool.call");
      const found = calls
        .filter(({ span }) => span.operationName === "sql.execute")
        .map(({ span }) => {
          const names = ancestry(trace.data, span.spanId).map((parent) => parent.operationName);
          return {
            text: String(span.tags["db.query.text"] ?? "").replace(/\s+/g, " "),
            end: Date.parse(span.startTime) + span.durationMs,
            readAhead:
              names.includes("FumaDB.SqlQuery.findFirst") && !names.includes("sdk.tools.call"),
            runtime: names.some((name) => name.startsWith("runtime.")),
          };
        })
        .filter(({ runtime }) => !runtime);
      return found.some(({ text }) => text.includes("from apikey where key"))
        ? Effect.succeed(found)
        : Effect.fail(new Error("The tool call's statements have not reached Motel"));
    }),
    Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
  );
});

const objectConnections = (owner: string, options: Parameters<typeof objectDatabase>[1] = {}) =>
  Effect.map(objectDatabase(owner, options), ({ connections }) => connections);

/** The session object behind the last MCP request, once its spans have reached Motel. */
const lastSessionObject = Effect.gen(function* () {
  const evidence = yield* Evidence,
    telemetry = yield* Telemetry;
  const request = (yield* evidence.requests).filter((request) => request.path === "/mcp").at(-1);
  if (request === undefined) return yield* Effect.die("MCP request evidence missing");
  return yield* telemetry.query(request.traceId).pipe(
    Effect.flatMap((trace) => {
      const id = trace.data
        .map(({ span }) => span.tags["executor.mcp.object_id"])
        .find((id) => id !== undefined);
      return id === undefined
        ? Effect.fail(new Error("The session object's spans have not reached Motel"))
        : Effect.succeed(`mcp ${String(id)}`);
    }),
    Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
  );
});

/**
 * One case of the probe of the session objects' database pool against the local database (see
 * database-pool-fixture.ts): the pool Cloud's session objects use, with the cases a tool call's
 * statements cannot reach on their own.
 */
const poolCase = (name: string) =>
  Effect.gen(function* () {
    const target = yield* Target;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const output = yield* processes.string(
      ChildProcess.make(
        "node",
        [
          "apps/hosted/testing/database-pool-fixture.ts",
          "--configuration",
          `${target.directory}/sso-database.json`,
          "--case",
          name,
        ],
        { env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, extendEnv: false },
      ),
    );
    return yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
    )(output.trim().split("\n").at(-1) ?? "");
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
          let client = yield* mcp.connect(key.key, "object-connections", {
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

          // A pause between an agent's tool calls keeps the window and its connections: the next
          // call opens neither a window nor a connection.
          yield* Effect.sleep(Duration.seconds(45));
          expect(yield* objectConnections(owner)).toBeGreaterThan(0);
          const paused = yield* sessionSpans(
            yield* execute("Tool calls after a pause"),
            (counts) => counts.operations >= 6 && counts.databases >= 6,
          );
          yield* evidence.json("after-pause.json", paused);
          expect(paused.windows, "A 45 s pause keeps the window").toBe(0);
          expect(paused.connects, "A 45 s pause keeps the connections").toBe(0);

          // Once the session has been idle for the whole window (120 s), it holds no connection;
          // the next call opens a window.
          yield* Effect.sleep(Duration.seconds(122));
          expect(yield* objectConnections(owner)).toBe(0);
          // Without the window's socket and timer, the idle object may be evicted with its MCP
          // sessions, so the client starts a new session, as clients do on "session not found".
          // The new session's own requests may open the window, so they are counted with the calls.
          const idled = (yield* evidence.requests).length;
          client = yield* mcp.connect(key.key, "object-connections-after-idle", {
            organization: actors.organization.id,
          });
          yield* execute("Tool calls after idling");
          const reopened = yield* sessionSpans(
            (yield* evidence.requests).slice(idled).map((request) => request.traceId),
            (counts) => counts.operations >= 6 && counts.windows >= 1 && counts.connects >= 1,
          );
          yield* evidence.json("after-idle.json", reopened);
          expect(reopened.windows).toBe(1);
          expect(reopened.connects).toBeGreaterThan(0);
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 300_000 },
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
  it.effect(
    scenarios.cloudMcpParallelCalls.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            mcp = yield* McpClient,
            evidence = yield* Evidence;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const key = yield* body(
            Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
            yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
              name: "Parallel calls",
            }),
          );
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
              .pipe(Effect.orDie),
          );
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Parallel calls ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: reviewedAppSource }, appsManifest],
          });
          expect(deployed.status).toBe(200);
          const app = yield* body(App, deployed);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
          );
          const client = yield* mcp.connect(key.key, "parallel-calls", {
            organization: actors.organization.id,
          });
          const tool = (name: string) => `tools[${JSON.stringify(app.slug)}].${name}`;
          const call = (label: string, name: string, args: Record<string, unknown>) =>
            client.use(label, (client, signal) =>
              client.callTool({ name, arguments: args }, undefined, { signal }),
            );

          const once = yield* call("Call once", "execute", {
            code: `return (await ${tool("echo")}({ text: "once" })).text`,
          }).pipe(
            Effect.flatMap((result) =>
              Schema.decodeUnknownEffect(Completed)(result.structuredContent),
            ),
          );
          expect(once.execution.value).toBe("once");
          const object = yield* lastSessionObject;

          // A call's token recheck and the reads sent with it share one connection: while the
          // recheck waits on a lock, the reads queued behind it on that connection wait too.
          // Without grouping each read would take a connection of its own and finish at once.
          const holder = yield* Effect.forkScoped(objectDatabase(object, { holdLock: 170 }));
          yield* untilObject(object, "The lock is held", ({ holding }) => holding === 1);
          // The request's own authentication updates the token first; its tool call's recheck next.
          yield* objectDatabase(object, { stallTokenUpdateAfter: 1 });
          const held = yield* Effect.forkChild(
            call("Call while the recheck waits", "execute", {
              code: `return (await ${tool("echo")}({ text: "held" })).text`,
            }),
          );
          yield* untilObject(
            object,
            "The recheck is waiting on the lock",
            ({ waiting }) => waiting === 1,
          );
          yield* Effect.sleep("1 second");
          yield* Fiber.interrupt(holder);
          const released = yield* Fiber.join(held).pipe(
            Effect.flatMap((result) =>
              Schema.decodeUnknownEffect(Completed)(result.structuredContent),
            ),
          );
          expect(released.execution.value).toBe("held");
          const statements = yield* toolCallStatements;
          yield* evidence.json("shared-connection-statements.json", statements);
          const recheck = statements.find(({ text }) => text.includes("from apikey where key"));
          const reads = statements.filter(({ readAhead }) => readAhead);
          expect(recheck, "The call's token recheck").toBeDefined();
          expect(reads.length, "The reads sent with the recheck").toBeGreaterThan(0);
          for (const read of reads)
            expect(
              read.end,
              "A read sent with the recheck waited behind it on the recheck's connection",
            ).toBeGreaterThanOrEqual((recheck?.end ?? Infinity) - 5);

          // Approvals waiting to be resumed: each resume claims its approval in a transaction.
          const pending = yield* Effect.forEach([0, 1, 2], (i) =>
            call("Ask for an approval", "execute", {
              code: `return await ${tool("review")}({ text: "review ${i}" })`,
            }).pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(Pending)(result.structuredContent),
              ),
            ),
          );
          const texts = Array.from({ length: 24 }, (_, i) => `call ${i}`);
          const [parallel, ...resumed] = yield* evidence.step(
            "Twenty-four parallel calls and three resumed approvals run at once in one session",
            Effect.all(
              [
                call("Run calls in parallel", "execute", {
                  code: `return (await Promise.all(${JSON.stringify(texts)}.map((text) => ${tool("echo")}({ text })))).map((result) => result.text)`,
                }),
                ...pending.map(({ requestId }) =>
                  call("Resume an approval", "resume", {
                    requestId,
                    response: { action: "accept" },
                  }),
                ),
              ],
              { concurrency: "unbounded" },
            ),
          );
          const ran = yield* Schema.decodeUnknownEffect(Completed)(parallel?.structuredContent);
          expect(ran.execution.value, "Each parallel call returns its own input").toEqual(texts);
          for (const [i, result] of resumed.entries()) {
            const completed = yield* Schema.decodeUnknownEffect(Completed)(
              result.structuredContent,
            );
            expect(completed.execution.value, "Each resume runs its own approval").toEqual({
              text: `review ${i}`,
            });
          }

          // The object's connections, while its idle window keeps them open.
          const connections = yield* objectConnections(object);
          yield* evidence.json("parallel-connections.json", { connections });
          expect(connections, "The object held connections for the calls").toBeGreaterThan(0);
          expect(connections, "The object stays within its connection limit").toBeLessThanOrEqual(
            objectConnectionLimit,
          );
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 120_000 },
  );
  it.effect(
    scenarios.cloudMcpAbandonedStatement.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            mcp = yield* McpClient,
            evidence = yield* Evidence;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const key = yield* body(
            Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
            yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
              name: "Abandoned statement",
            }),
          );
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
              .pipe(Effect.orDie),
          );
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Abandoned statement ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: echoAppSource }, appsManifest],
          });
          expect(deployed.status).toBe(200);
          const app = yield* body(App, deployed);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
          );
          const client = yield* mcp.connect(key.key, "abandoned-statement", {
            organization: actors.organization.id,
          });
          const echo = (label: string, text: string) =>
            client
              .use(label, (client, signal) =>
                client.callTool(
                  {
                    name: "execute",
                    arguments: {
                      code: `return (await tools[${JSON.stringify(app.slug)}].echo({ text: ${JSON.stringify(text)} })).text`,
                    },
                  },
                  undefined,
                  { signal },
                ),
              )
              .pipe(
                Effect.flatMap((result) =>
                  Schema.decodeUnknownEffect(Completed)(result.structuredContent),
                ),
                Effect.map(({ execution }) => execution.value),
              );
          expect(yield* echo("Warm the session", "warm")).toBe("warm");
          const object = yield* lastSessionObject;
          const state = objectDatabase(object);
          const until = (label: string, done: Parameters<typeof untilObject>[2]) =>
            untilObject(object, label, done);

          // A lock the session's next per-call token recheck waits on, held for the rest of the scenario.
          yield* Effect.forkScoped(objectDatabase(object, { holdLock: 170 }));
          yield* until("The lock is held", ({ holding }) => holding === 1);
          // The request's own authentication updates the token first; its tool call's recheck next.
          yield* objectDatabase(object, { stallTokenUpdateAfter: 1 });
          const abandoned = yield* Effect.forkChild(
            Effect.exit(echo("Call while the lock is held", "abandoned")),
          );
          yield* evidence.step(
            "The call's token recheck waits on the lock",
            until("The recheck is waiting on the lock", ({ waiting }) => waiting === 1),
          );
          // The client gives up on the call (as at its request timeout): MCP cancels it, which the
          // session processes within a few hundred milliseconds.
          yield* Fiber.interrupt(abandoned);
          yield* Effect.sleep("2 seconds");

          // Another call in the same session, while the lock is still held, is not delayed by it.
          const started = Date.now();
          const value = yield* echo("Call again while the lock is held", "after").pipe(
            Effect.timeout("20 seconds"),
          );
          const elapsed = Date.now() - started;
          yield* evidence.json("abandoned-statement.json", { elapsed });
          expect(value).toBe("after");
          expect(elapsed, "A call after the abandoned statement waits for nothing").toBeLessThan(
            5_000,
          );
          expect((yield* state).holding, "The lock was still held meanwhile").toBe(1);
          yield* evidence.step(
            "The statement its caller gave up on is cancelled in the database",
            until(
              "The abandoned statement still waits on the lock",
              ({ waiting }) => waiting === 0,
            ),
          );
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 240_000 },
  );

  it.effect(
    scenarios.cloudMcpDiscoveryListings.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            mcp = yield* McpClient,
            evidence = yield* Evidence;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const key = yield* body(
            Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
            yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
              name: "Discovery listings",
            }),
          );
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
              .pipe(Effect.orDie),
          );
          const deploy = (name: string, source = echoAppSource) =>
            Effect.gen(function* () {
              const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
                name: `${name} ${randomUUID().slice(0, 8)}`,
                files: [{ path: "index.ts", content: source }, appsManifest],
              });
              expect(deployed.status).toBe(200);
              const app = yield* body(App, deployed);
              yield* Effect.addFinalizer(() =>
                api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
              );
              return app;
            });
          const slow = yield* deploy("Slow listing");
          const others = [yield* deploy("Listing B"), yield* deploy("Listing C")];
          const timer = yield* deploy("Timer", timerAppSource);
          const client = yield* mcp.connect(key.key, "discovery-listings", {
            organization: actors.organization.id,
          });
          const run = (label: string, code: string) =>
            client
              .use(label, (client, signal) =>
                client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
              )
              .pipe(
                Effect.flatMap((result) =>
                  Schema.decodeUnknownEffect(Completed)(result.structuredContent),
                ),
              );
          const warm = yield* run("Warm the session", "return 1");
          expect(warm.execution.value).toBe(1);
          const object = yield* lastSessionObject;
          yield* objectDatabase(object, { largeAppRow: slow.id });

          // The program reaches only the timer app, so discovery lists the slow app and the others
          // only by name up front (reading the slow app's row before the lock). After the timer,
          // the searches list the three apps at once, each its own listing: the slow app's reads
          // its row while the lock is held.
          const namespaces = [slow, ...others].map((app) => app.slug);
          const code = `await tools[${JSON.stringify(timer.slug)}].wait({ ms: 3000 });
const started = Date.now();
const listed = {};
await Promise.all(${JSON.stringify(namespaces)}.map(async (namespace) => {
  const found = await tools.search({ query: "Echo text", namespace });
  listed[namespace] = { ms: Date.now() - started, paths: found.items.map((item) => item.path) };
}));
return listed;`;
          const execute = yield* Effect.forkChild(run("Discover three apps", code));
          yield* Effect.sleep("1500 millis");
          yield* Effect.forkScoped(objectDatabase(object, { holdLargeAppRows: 8 }));
          yield* untilObject(object, "The lock is held", ({ holding }) => holding === 1);
          yield* evidence.step(
            "The slow app's listing waits on the lock",
            untilObject(
              object,
              "A listing read is waiting on the lock",
              ({ waiting }) => waiting > 0,
            ),
          );
          const listed = yield* Fiber.join(execute);
          const Listed = Schema.Record(
            Schema.String,
            Schema.Struct({ ms: Schema.Number, paths: Schema.Array(Schema.String) }),
          );
          const byApp = yield* Schema.decodeUnknownEffect(Listed)(listed.execution.value);
          yield* evidence.json("discovery-listings.json", byApp);
          expect(
            byApp[slow.slug]?.ms,
            "The slow app's listing waited for the lock",
          ).toBeGreaterThanOrEqual(3_000);
          for (const app of others) {
            const found = byApp[app.slug];
            expect(found?.paths.length, `${app.slug} was discovered`).toBeGreaterThan(0);
            expect(
              found?.ms,
              `${app.slug} was discovered without waiting behind the slow app's listing`,
            ).toBeLessThan(2_000);
          }
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 240_000 },
  );
  it.effect(
    scenarios.cloudMcpObjectPool.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const evidence = yield* Evidence;
          const step = (title: string, name: string) =>
            evidence.step(
              title,
              poolCase(name).pipe(Effect.tap((seen) => evidence.json(`pool-${name}.json`, seen))),
            );

          // A callback's second statement is refused after a sibling on its connection gave up;
          // the callback's insert was sent, so the callback is not run again.
          const once = yield* step("A callback that sent a statement runs once", "use-once");
          expect(once.siblingGaveUp, "The sibling gave up on its lock wait").toBe(true);
          expect(once.twoStatements, "The refused read fails the callback").toBe("refused");
          expect(once.rows, "The callback's insert ran once").toBe(1);
          expect(once.otherSiblingGaveUp, "The second sibling gave up on its lock wait").toBe(true);
          expect(once.firstRead, "A callback refused before sending runs again").toBe("ok");

          const nested = yield* step("A hold inside a hold uses its connection", "held-nested");
          expect(nested.split, "Rounds whose inner hold took another connection").toBe(0);

          const shared = yield* step("Only an exclusive pool holds", "held-shared");
          expect(shared).toEqual({ exclusive: true, shared: false, plain: false });

          // 6 s, longer than the 5 s cancellation bound, under the 30 s bound on what nobody awaits:
          // a statement nobody abandoned is waited for.
          const unawaited = yield* step(
            "A hold keeps its connection for a statement nobody awaits until it finishes",
            "held-unawaited",
          );
          expect(unawaited.heldReturned, "The hold returned without waiting").toBeLessThan(1_000);
          expect(unawaited.sleeper, "The unawaited statement finished").toBe("ok");
          expect(unawaited.sleeperFinished).toBeGreaterThanOrEqual(5_900);
          expect(
            unawaited.next,
            "The next statement waited for the connection",
          ).toBeGreaterThanOrEqual(5_900);
          expect(unawaited.sameConnection, "The connection was kept").toBe(true);

          // A 45 s statement nobody awaits: past the 30 s bound it is cancelled and its connection
          // closed, so a hung `COMMIT` cannot keep one of the object's connections indefinitely.
          const hung = yield* step(
            "A statement nobody awaits gives its connection up 30 s after its hold returned",
            "held-hung",
          );
          expect(hung.heldReturned, "The hold returned without waiting").toBeLessThan(1_000);
          // Cancelled first (`57014`), or, on a socket that went silent, failed by the close.
          expect(hung.sleeper, "The unawaited statement was cut off").toBe("failed");
          expect(hung.sleeperEnded, "It ran up to the bound").toBeGreaterThanOrEqual(29_900);
          expect(hung.sleeperEnded, "It did not run to its end").toBeLessThan(40_000);
          expect(hung.next, "The next statement waited for the bound").toBeGreaterThanOrEqual(
            29_900,
          );
          expect(hung.next).toBeLessThan(40_000);
          expect(hung.sameConnection, "The broken connection was replaced").toBe(false);
          expect(hung.oldBackendRunning, "The old backend's statement was cancelled").toBe(0);

          const drain = yield* step(
            "An abandoned statement whose cancel never lands closes its connection after 5 s",
            "drain",
          );
          const Arm = Schema.Struct({
            gaveUp: Schema.Literal(true),
            callerReturned: Schema.Number,
            next: Schema.Number,
            sameConnection: Schema.Boolean,
            cancelRequests: Schema.Number,
          });
          const dropped = yield* Schema.decodeUnknownEffect(Arm)(drain.dropped);
          const delivered = yield* Schema.decodeUnknownEffect(Arm)(drain.delivered);
          expect(dropped.callerReturned, "The caller did not wait for the drain").toBeLessThan(
            1_000,
          );
          expect(dropped.cancelRequests, "The cancel was sent").toBe(1);
          expect(dropped.next, "The connection was given up at the bound").toBeGreaterThanOrEqual(
            4_900,
          );
          expect(dropped.next).toBeLessThan(8_000);
          expect(dropped.sameConnection, "The broken connection was replaced").toBe(false);
          expect(delivered.next, "A delivered cancel drains at once").toBeLessThan(1_000);
          expect(delivered.sameConnection, "A drained connection is kept").toBe(true);

          const sibling = yield* step(
            "A statement that finished does not wait for its group's drain",
            "sibling",
          );
          expect(sibling.gaveUp, "The sibling gave up on its lock wait").toBe(true);
          expect(sibling.awaited).toBe("ok");
          expect(sibling.awaitedReturned, "The finished statement returned").toBeLessThan(1_000);

          // A tool call's `BEGIN … COMMIT` batch (`PgConnection.pipelined`) runs inside a hold:
          // there it uses one connection and one snapshot, and outside one it writes nothing. A
          // batch that cannot connect (the first attempt and its retry both closed) returns each
          // leaf's failure, so a tool call's recheck decides it as on main.
          const batch = yield* step(
            "A batch writes BEGIN only on a held connection, and returns its leaves' failures when it cannot connect",
            "batch",
          );
          expect(batch).toEqual({
            held: { ok: 4, backends: 1, snapshots: 1 },
            outside: { refused: true },
            unreachable: {
              attempts: 2,
              batch: "returned",
              leaves: ["could not connect", "could not connect", "could not connect"],
            },
          });
        }),
      ),
    { timeout: 180_000 },
  );
});
