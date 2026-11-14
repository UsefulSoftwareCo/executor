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
import { cloudLocks } from "../support/cloud-locks.ts";

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
 * the collector. A parent ends after its children, so it leaves in the same export or a later one, and a
 * refused export is sent again after later ones.
 */
const deliveredAncestry = (traceId: string, select: (span: Spans[number]["span"]) => boolean) =>
  Telemetry.pipe(
    Effect.flatMap((telemetry) => telemetry.query(traceId)),
    Effect.flatMap((trace) => {
      const found = trace.data.find(({ span }) => select(span));
      const chain = found === undefined ? [] : ancestry(trace.data, found.span.spanId);
      // The collector answers a span whose parent has not arrived with a placeholder root in its place.
      return chain.at(-1)?.parentSpanId === null &&
        !chain.some((span) => span.operationName.startsWith("[missing parent"))
        ? Effect.succeed({ trace: trace.data, chain })
        : Effect.fail(new Error("The span or its ancestors have not all reached the collector"));
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

const Connections = Schema.Array(Schema.Struct({ connections: Schema.Number }));

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
              span.tags["fumadb.operation"] === "findFirst" && !names.includes("sdk.tools.call"),
            runtime: names.some((name) => name.startsWith("runtime.")),
          };
        })
        .filter(({ runtime }) => !runtime);
      return found.some(({ text }) => text.includes("from apikey where key"))
        ? Effect.succeed(found)
        : Effect.fail(new Error("The tool call's statements have not reached the collector"));
    }),
    Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
  );
});

const objectConnections = (owner: string, options: Parameters<typeof objectDatabase>[1] = {}) =>
  Effect.map(objectDatabase(owner, options), ({ connections }) => connections);

/** The session object behind the last MCP request, once its spans have reached the collector. */
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
        ? Effect.fail(new Error("The session object's spans have not reached the collector"))
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

/** One case of the probe of the pool's repeat after a dropped connection (connection-repeat-fixture.ts). */
const repeatCase = (name: string) =>
  Effect.gen(function* () {
    const target = yield* Target;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const output = yield* processes.string(
      ChildProcess.make(
        "node",
        [
          "apps/hosted/testing/connection-repeat-fixture.ts",
          "--configuration",
          `${target.directory}/sso-database.json`,
          "--case",
          name,
        ],
        { env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, extendEnv: false },
      ),
    );
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RepeatCase))(
      output.trim().split("\n").at(-1) ?? "",
    );
  });

/** What the statements after a drop did. */
const RepeatSeen = Schema.Struct({
  dropped: Schema.Number,
  outcome: Schema.String,
  millis: Schema.Number,
  connects: Schema.Number,
  peak: Schema.Number,
  healthyClosed: Schema.Number,
  repeats: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  rows: Schema.optionalKey(Schema.Number),
});
const RepeatCase = Schema.Union([
  RepeatSeen,
  Schema.Struct({ event: RepeatSeen, object: RepeatSeen }),
  Schema.Struct({ runs: Schema.Array(RepeatSeen) }),
  Schema.Struct({
    mismatches: Schema.Array(Schema.Struct({ sql: Schema.String, expected: Schema.String })),
    statements: Schema.Number,
  }),
]);

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
        // Cron ticks belong to the whole Cloud, not to any one scenario.
        const dispatched = telemetry
          .searchWholeEnvironment("job.dispatch", { "executor.job": "provisioning" })
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
              ? Effect.fail(new Error("No dispatched provisioning job has reached the collector"))
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
          // The session object's own spans, once each one a check reads has reached the collector. A
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
                      // How the object reached the database for each connection it opened.
                      routes: [
                        ...new Set(
                          spans
                            .filter(({ span }) => span.operationName === "sql.connect")
                            .map(({ span }) => String(span.tags["db.connect.route"])),
                        ),
                      ],
                    })
                  : Effect.fail(
                      new Error(
                        `The session's spans have not reached the collector: ${JSON.stringify(counts)}`,
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
          // One object per grant: each connected directly, every active session would hold
          // PgBouncer clients of its own, and enough active sessions exhaust PgBouncer's client
          // limit. Through Hyperdrive they share its bounded pool.
          expect(first.routes, "Session objects connect through Hyperdrive").toEqual([
            "hyperdrive",
          ]);
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

          // A pause between an agent's tool calls keeps the window and its connections: the
          // object still holds every connection it held before the pause, and the next call opens
          // no window. The pool opens connections on demand, up to its limit, and the drop above
          // left it fewer than its first calls opened, so a call that runs more statements at
          // once than the connections held may still open one; that is the pool growing, not
          // the pause closing one, so the call's own connects are not the measure.
          const held = yield* objectConnections(owner);
          expect(held).toBeGreaterThan(0);
          yield* Effect.sleep(Duration.seconds(45));
          expect(yield* objectConnections(owner), "A 45 s pause keeps the connections").toBe(held);
          const paused = yield* sessionSpans(
            yield* execute("Tool calls after a pause"),
            (counts) => counts.operations >= 6 && counts.databases >= 6,
          );
          yield* evidence.json("after-pause.json", { ...paused, held });
          expect(paused.windows, "A 45 s pause keeps the window").toBe(0);

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
        // The session object's own spans for some requests, once `ready` finds them in the collector.
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
                : Effect.fail(new Error("The session's spans have not reached the collector")),
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
            ) &&
            spans.some(
              (span) =>
                span.operationName === "sql.connect" &&
                span.tags["db.connect.failure"] !== undefined,
            ),
        )).filter((span) => span.operationName === "sql.connect");
        yield* evidence.json(
          "object-connects.json",
          connects.map((span) => ({
            attempt: span.tags["db.connect.attempt"],
            retryReason: span.tags["db.connect.retry_reason"],
            failure: span.tags["db.connect.failure"],
            durationMs: span.durationMs,
            status: span.status,
          })),
        );
        // The stalled attempt fails its span and says it timed out, recording only the driver's
        // fixed sentence; the attempt made after it succeeds and records no failure.
        expect(
          connects
            .filter((span) => span.tags["db.connect.failure"] !== undefined)
            .map((span) => ({
              attempt: span.tags["db.connect.attempt"],
              failure: span.tags["db.connect.failure"],
              status: span.status,
              exceptions: span.events
                .filter((event) => event.name === "exception")
                .map((event) => event.attributes["exception.message"]),
            })),
        ).toEqual([
          {
            attempt: "1",
            failure: "timeout",
            status: "error",
            exceptions: [
              "The database failed (ConnectionError): PgConnection: Connection timed out",
            ],
          },
        ]);
        const retried = connects.filter((span) => span.tags["db.connect.attempt"] === "2");
        expect(
          retried.map((span) => ({
            retryReason: span.tags["db.connect.retry_reason"],
            failure: span.tags["db.connect.failure"],
            status: span.status,
          })),
        ).toEqual([{ retryReason: "PgConnection: Connection timed out", status: "ok" }]);
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
          // Cron ticks belong to the whole Cloud, not to any one scenario.
          const dispatched = telemetry
            .searchWholeEnvironment("job.dispatch", { "executor.job": "schedule-wake" })
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
                ? Effect.fail(
                    new Error("No cron wake of the coordinator has reached the collector"),
                  )
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

          // The collector matches operation names by the start of their words, so `schedule.retire` would also find
          // `schedule.retired`.
          const exactly = (operation: string, found: typeof SpanQuery.Type) =>
            found.data.filter(({ span }) => span.operationName === operation);
          // One schedule coordinator serves the whole Cloud, so its spans are the Cloud's, from
          // every scenario sharing it, not only this one's. The exact counts below hold only on a
          // Cloud where nothing else hands the coordinator over.
          const coordinatorSpans = (operation: string, attributes: Record<string, string> = {}) =>
            telemetry
              .searchWholeEnvironment(operation, attributes)
              .pipe(Effect.map((found) => exactly(operation, found)));
          const coordinator = yield* Effect.gen(function* () {
            const handovers = yield* coordinatorSpans("schedule.handover");
            const retirements = yield* coordinatorSpans("schedule.retire");
            const runs = exactly(
              "schedule.run",
              yield* telemetry.search("schedule.run", { app: app.id }),
            );
            // The dispatches of this app's runs, which leave in other exports than the runs. Until
            // a run has arrived there is no trace to read them in.
            const dispatches =
              runs.length === 0
                ? []
                : exactly(
                    "schedule.dispatch",
                    yield* telemetry.search(
                      "schedule.dispatch",
                      { traces: runs.map(({ traceId }) => traceId) },
                      { "executor.schedule.runner": "cloud" },
                    ),
                  );
            return { handovers, retirements, runs, dispatches };
          }).pipe(
            Effect.flatMap((found) =>
              found.handovers.length === 0 ||
              found.retirements.length === 0 ||
              found.runs.length < 3 ||
              found.dispatches.length === 0
                ? Effect.fail(new Error("The coordinator's spans have not reached the collector"))
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
          const runDispatches = coordinator.dispatches;
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
          const heartbeats = coordinatorSpans("schedule.retired", {
            "executor.schedule.wake": "alarm",
          }).pipe(
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
                ? Effect.fail(
                    new Error(`${found.length} of 2 heartbeats have reached the collector`),
                  )
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
            ...(yield* coordinatorSpans("schedule.retire")),
            ...(yield* coordinatorSpans("schedule.retired", { "executor.schedule.wake": "wake" })),
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
    scenarios.cloudScheduleConnectionsClose.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            evidence = yield* Evidence,
            locks = yield* cloudLocks;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Coordinator connections ${randomUUID().slice(0, 8)}`,
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

          // The coordinator claims and records the run on its own connections.
          expect((yield* api.request(actors.owner, "POST", `${schedule}/run`)).status).toBe(200);
          yield* api.request(actors.owner, "GET", `${prefix}/scheduled-runs?app=${app.id}`).pipe(
            Effect.flatMap((response) => body(Runs, response)),
            Effect.flatMap((runs) =>
              runs.some((run) => run.name === "tick" && run.status === "succeeded")
                ? Effect.void
                : Effect.fail(new Error("The scheduled run has not succeeded")),
            ),
            Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 120 }),
          );

          // An open connection keeps a Durable Object from hibernating, and the coordinator wakes
          // at least once a minute. Connections held for the MCP sessions' 120-second window
          // after each pass kept it in memory, billing duration, around the clock. Other
          // scenarios' writes wake it meanwhile, so the count is read until a moment between
          // passes, well before that window would end.
          const counts: Array<number> = [];
          yield* locks
            .run({
              sql: "select count(*)::int as connections from pg_stat_activity where application_name = $1",
              params: ["executor schedules"],
            })
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Connections)),
              Effect.orDie,
              Effect.flatMap((rows) => {
                const connections = rows[0]?.connections ?? 0;
                counts.push(connections);
                return connections === 0
                  ? Effect.void
                  : Effect.fail(new Error("The coordinator still holds connections"));
              }),
              Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
              Effect.ensuring(
                Effect.suspend(() => evidence.json("schedule-connections.json", counts)),
              ),
            );
        }),
      ),
    { timeout: 120_000 },
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

          // A leaf that reads again once its first statement answers, as a bearer recheck whose key
          // was contended does, writes nothing while its batch's `COMMIT` is unanswered: through
          // Hyperdrive such a statement is never answered, and the call waits until its deadline.
          // The read goes out, and answers, once the `COMMIT` has.
          const later = yield* step(
            "A batch leaf's later statement waits for its batch's COMMIT to answer before it is written",
            "commit-unanswered",
          );
          expect(later).toEqual({
            leaves: ["ok", "ok", "ok"],
            behindCommit: 0,
            laterAfterCommit: true,
          });

          // A connect attempt that reaches its timeout, and one whose caller gives up while it
          // waits, close their sockets: a server that accepts and never answers sees each closed.
          const abandoned = yield* step(
            "Connect attempts that time out or are given up close their sockets",
            "connect-abandoned",
          );
          expect(abandoned).toEqual({
            timedOut: "timed out",
            afterTimeout: { attempts: 2, open: 0 },
            interrupted: "failed",
            afterInterrupt: { attempts: 1, open: 0 },
          });
        }),
      ),
    { timeout: 180_000 },
  );

  it.effect(
    scenarios.cloudDatabaseConnectionRepeat.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const evidence = yield* Evidence;
          const step = (title: string, name: string) =>
            evidence.step(
              title,
              repeatCase(name).pipe(
                Effect.tap((seen) => evidence.json(`repeat-${name}.json`, seen)),
              ),
            );
          const one = (value: typeof RepeatCase.Type) => {
            if (!("outcome" in value)) throw new Error("Expected one result");
            return value;
          };
          const both = (value: typeof RepeatCase.Type) => {
            if (!("event" in value))
              throw new Error("Expected the event and object pools' results");
            return value;
          };

          // A proxy between the pool and the database ends each idle connection's server side
          // while the client's socket stays open, as Hyperdrive and PlanetScale's routing can; the
          // pool learns only when it writes its next statement.
          const read = both(yield* step("A read on a dropped connection runs once more", "read"));
          for (const shape of ["event", "object"] as const) {
            const result = read[shape];
            expect(result.dropped, `The ${shape} pool's idle connection was dropped`).toBe(1);
            expect(result.outcome, `The ${shape} pool's read succeeds`).toBe("ok");
            expect(result.connects, "On one fresh connection of the pool").toBe(1);
            expect(result.repeats).toHaveLength(1);
            expect(result.repeats[0]).toMatchObject({
              "db.connection.repeat": "connection-lost",
              "db.connection.repeat_reason": "PgConnection: Connection closed",
              "db.connection.repeat_outcome": "succeeded",
            });
            expect(typeof result.repeats[0]?.["db.connection.lost_idle_ms"]).toBe("number");
            expect(typeof result.repeats[0]?.["db.connection.lost_age_ms"]).toBe("number");
          }

          // A write may have reached the server before the client learnt the connection was
          // gone; whether it applied cannot be known, so it is never sent again. The session
          // object's write goes out on the multiplexed path, in a statement group.
          const write = both(yield* step("A write is not repeated", "write"));
          for (const shape of ["event", "object"] as const) {
            expect(write[shape].outcome, `The ${shape} pool's write`).toBe(
              "effect/sql/SqlError: PgConnection: Connection closed",
            );
            expect(write[shape].repeats, `The ${shape} pool's write is not repeated`).toEqual([]);
            expect(write[shape].rows, "No row was written, once or twice").toBe(0);
          }

          // The connection is lost after BEGIN and one statement; the transaction's next read
          // fails, and nothing of it runs again outside the transaction.
          const transaction = one(
            yield* step("A statement in a transaction is not repeated", "transaction"),
          );
          expect(transaction.dropped).toBe(1);
          expect(transaction.outcome).toBe("effect/sql/SqlError: PgConnection: Connection closed");
          expect(transaction.repeats).toEqual([]);

          // No new connection can be made: the repeat's one attempt and the retry every attempt
          // gets both fail, promptly, and the caller gets the first error, saying so.
          const down = one(
            yield* step("With the database unreachable the repeat fails once", "down"),
          );
          expect(down.outcome).toBe(
            "effect/sql/SqlError: PgConnection: Connection closed (one repeat on a fresh connection also failed)",
          );
          expect(down.connects, "One attempt and its retry, no loop").toBe(2);
          expect(down.millis).toBeLessThan(10_000);
          expect(down.repeats).toHaveLength(1);
          expect(down.repeats[0]?.["db.connection.repeat_outcome"]).toBe("failed");

          // More concurrent reads than the pool holds, after every connection is dropped: the
          // repeats take the pool's own connections, so no more than its cap are ever open.
          const cap = both(yield* step("Repeats stay within the pool's cap", "cap"));
          for (const [shape, limit] of [
            ["event", 2],
            ["object", 4],
          ] as const) {
            expect(cap[shape].dropped).toBe(limit);
            expect(cap[shape].outcome, `The ${shape} pool's 8 reads`).toBe("ok");
            expect(cap[shape].peak, `Open at once in the ${shape} pool`).toBeLessThanOrEqual(limit);
            expect(cap[shape].repeats.length).toBeGreaterThan(0);
          }

          // A burst kills every idle connection of a full session-object pool, then one read: its
          // repeat skips the dead connections one at a time, each closed before the next is taken,
          // so no more sockets than the pool's cap are open at once.
          const burst = one(yield* step("A repeat after a burst stays within the cap", "burst"));
          expect(burst.dropped).toBe(4);
          expect(burst.outcome, "The read after the burst").toBe("ok");
          expect(burst.repeats).toHaveLength(1);
          expect(burst.peak, "Sockets open at once in a pool capped at 4").toBeLessThanOrEqual(4);

          // One of four idle connections dropped, one read, several times over: when the read
          // lands on the dropped one, its repeat closes the older idle connections, dead or not,
          // and still never has more than the cap open.
          const dropOne = yield* step("A repeat after one drop stays within the cap", "drop-one");
          if (!("runs" in dropOne)) return yield* Effect.die("Expected the drop-one runs");
          for (const run of dropOne.runs) {
            expect(run.outcome).toBe("ok");
            expect(run.peak, "Sockets open at once in a pool capped at 4").toBeLessThanOrEqual(4);
          }
          expect(
            dropOne.runs.filter((run) => run.repeats.length > 0).length,
            "Runs in which the read met the dropped connection",
          ).toBeGreaterThan(0);

          // A tool call's reads run in a held, read-only snapshot batch. A leaf that reads, loses
          // the connection and reads again fails: repeated on another connection, the second read
          // would leave the hold and its snapshot.
          const held = one(yield* step("A read inside a held batch is not repeated", "held"));
          expect(held.dropped).toBe(1);
          expect(held.outcome).toBe("effect/sql/SqlError: PgConnection: Connection closed");
          expect(held.repeats).toEqual([]);

          // What the repeat counts as a read, from the statement's text.
          const classify = yield* step("Statements are classified as reads or writes", "classify");
          if (!("mismatches" in classify)) return yield* Effect.die("Expected the classification");
          expect(classify.mismatches).toEqual([]);
          expect(classify.statements).toBeGreaterThan(30);
        }),
      ),
    { timeout: 120_000 },
  );
});
