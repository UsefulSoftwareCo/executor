/**
 * A tool call's Executor time is recorded apart from what it spent outside Executor: upstream
 * waits, a person's answers and the app's own code. Each instant belongs to the innermost boundary
 * in progress, so Executor's work inside an upstream session or the app's code stays Executor's, and
 * the app's code inside Executor's services stays the app's. Each isolate measures its part on its
 * own clock, so the parts must add up exactly, and a clock that disagrees with its caller's is
 * flagged.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schedule, Schema } from "effect";
import { randomBytes, randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, type SpanQuery } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { mcpOutcomeFixture, slowUpstreamMs } from "../support/mcp-outcome-fixture.ts";
import { mcpInCallFixture } from "../support/mcp-in-call-fixture.ts";
import { withApps, mcpSdkVersion } from "../support/apps-release.ts";

type Span = (typeof SpanQuery.Type)["data"][number]["span"];
type Tags = Readonly<Record<string, string>>;

/** How long the test's MCP client takes to answer each question the call asks. */
const answerMs = 500;
/** How long each piece of the app's own code waits in the authored-code scenario. */
const authoredStepMs = 150;
/** How long the app's cache loader waits on its own, after its upstream request. */
const loaderMs = 500;
/** How long the app's own cache `read` waits before reading Executor's cache. */
const authoredReadMs = 500;
/** How long a slowed step of Executor's own work takes in the ownership scenarios. */
const slowedMs = 300;
/** Loop iterations that hold an app isolate's thread for a few hundred milliseconds. */
const spinIterations = 20_000_000;
/** Float rounding between a span's exported duration and a recorded millisecond value. */
const roundingMs = 0.005;

const milliseconds = (tags: Tags, key: string) => {
  const value = Number(tags[key]);
  if (tags[key] === undefined || !Number.isFinite(value))
    throw new Error(`${key} was not recorded`);
  return value;
};

const runtimeCall = /^runtime\.[a-z]+\.call$/;

/** Spans named `name` below `root` in its trace. */
const below = (spans: readonly Span[], root: Span, name: string | RegExp) => {
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const descends = (span: Span): boolean => {
    for (let parent = span.parentSpanId; parent !== null;) {
      if (parent === root.spanId) return true;
      parent = byId.get(parent)?.parentSpanId ?? null;
    }
    return false;
  };
  return spans.filter(
    (span) =>
      (typeof name === "string" ? span.operationName === name : name.test(span.operationName)) &&
      descends(span),
  );
};

/** Millisecond resolution of a delivered span's ISO start time, at each end of a window. */
const startResolutionMs = 2;

/** Milliseconds below `root` that a span owned by `owner` covers, read from the spans' windows. */
const covered = (spans: readonly Span[], root: Span, owner: string) => {
  const windows = below(spans, root, /./)
    .filter(({ tags }) => tags["executor.owner"] === owner)
    .map(({ startTime, durationMs }) => {
      const start = Date.parse(startTime);
      return [start, start + durationMs] as const;
    })
    .sort(([a], [b]) => a - b);
  let total = 0;
  let reached = -Infinity;
  for (const [start, end] of windows) {
    if (end > reached) total += end - Math.max(start, reached);
    reached = Math.max(reached, end);
  }
  return total;
};

const one = <A>(found: readonly A[], what: string) => {
  if (found.length !== 1) throw new Error(`Expected one ${what}, found ${found.length}`);
  return found[0]!;
};

const fixture = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    evidence = yield* Evidence,
    telemetry = yield* Telemetry,
    mcp = yield* McpClient;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const deploy = (
    index: string,
    dependencies: Readonly<Record<string, string>> = {},
    files: ReadonlyArray<{ readonly path: string; readonly content: string }> = [],
  ) =>
    Effect.gen(function* () {
      const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
        name: `Overhead ${randomUUID().slice(0, 8)}`,
        files: [
          {
            path: "package.json",
            content: JSON.stringify({ dependencies: withApps(dependencies) }),
          },
          { path: "index.ts", content: index },
          ...files,
        ],
      });
      expect(deployed.status).toBe(200);
      const app = yield* body(App, deployed);
      yield* Effect.addFinalizer(() =>
        api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
      );
      return app;
    });
  const key = yield* body(
    Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String }),
    yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
      name: "Overhead fixture",
    }),
  );
  yield* Effect.addFinalizer(() =>
    api
      .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
      .pipe(Effect.orDie),
  );
  // Native mode delivers approvals and elicitations to this client, which answers each after
  // `answerMs`, like a person would.
  const client = yield* mcp.connect(Redacted.make(Redacted.value(key.key)), "overhead", {
    organization: actors.organization.id,
    mode: "native",
    whileApproving: Effect.sleep(`${answerMs} millis`),
  });
  const execute = (label: string, code: string) =>
    client.use(label, (client, signal) =>
      client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
    );
  /**
   * The trace of `app`'s tool call span named `name` whose tool matches `tool`, once that span
   * and, when `timed`, the runtime and app spans below it have arrived with their timing.
   */
  const traced = (
    app: typeof App.Type,
    file: string,
    options: { readonly name?: string; readonly tool?: string; readonly timed?: boolean } = {},
  ) => {
    const name = options.name ?? "mcp.tool.call";
    return telemetry.search(name, { "executor.app.id": app.id }).pipe(
      Effect.flatMap((found) => {
        const match = found.data.find(
          ({ span }) =>
            span.tags["executor.runtime.calls"] !== undefined &&
            (options.tool === undefined || span.tags["executor.tool.name"]?.endsWith(options.tool)),
        );
        return match === undefined
          ? Effect.fail(new Error(`No ${name} span has arrived`))
          : telemetry.query(match.traceId).pipe(
              Effect.map((trace) => ({
                spans: trace.data.map(({ span }) => span),
                tool: trace.data.find(({ span }) => span.spanId === match.span.spanId)!.span,
              })),
            );
      }),
      Effect.flatMap((trace) =>
        options.timed === false ||
        (below(trace.spans, trace.tool, runtimeCall).length > 0 &&
          below(trace.spans, trace.tool, "app.call").some(
            ({ tags }) => tags["executor.overhead_ms"] !== undefined,
          ))
          ? Effect.succeed(trace)
          : Effect.fail(new Error("The tool call's timing has not been delivered")),
      ),
      // App and host spans arrive in separate export batches.
      Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 80 }),
      Effect.tap((trace) => evidence.json(file, trace.spans)),
    );
  };
  /** The tags of `app`'s tool call spans for `tool`, once `count` of them have their timing. */
  const toolCalls = (app: typeof App.Type, tool: string, count: number) =>
    telemetry.spans("mcp.tool.call", { "executor.app.id": app.id }).pipe(
      Effect.map((found) =>
        found.filter(
          (tags) =>
            tags["executor.tool.name"]?.endsWith(tool) === true &&
            tags["executor.runtime.started"] !== undefined,
        ),
      ),
      Effect.flatMap((found) =>
        found.length >= count
          ? Effect.succeed(found)
          : Effect.fail(new Error(`${found.length} of ${count} ${tool} calls have arrived`)),
      ),
      Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 80 }),
    );
  return { deploy, execute, traced, toolCalls };
});

/**
 * Check that a tool call's parts add up exactly and return them. The app's parts cover its span's
 * own window, and the tool call's Executor time is the sum of each isolate's own part.
 */
const accounted = (trace: { readonly spans: readonly Span[]; readonly tool: Span }) => {
  const { spans, tool } = trace;
  const runtime = one(below(spans, tool, runtimeCall), "runtime call");
  const call = one(below(spans, tool, "app.call"), "app call");
  const app = {
    upstream: milliseconds(call.tags, "executor.upstream.wait_ms"),
    elicitation: milliseconds(call.tags, "executor.elicitation.wait_ms"),
    authored: milliseconds(call.tags, "executor.authored_ms"),
    lease: milliseconds(call.tags, "executor.lease.wait_ms"),
    background: milliseconds(call.tags, "executor.background_ms"),
    overhead: milliseconds(call.tags, "executor.overhead_ms"),
  };
  // The app measured its own span, from its start to its end, and divided all of it. Background
  // work ran beside it and is not part of the division.
  expect(app.overhead + app.upstream + app.elicitation + app.authored + app.lease).toBeCloseTo(
    call.durationMs,
    2,
  );
  expect(app.background).toBeLessThanOrEqual(call.durationMs + roundingMs);
  expect(app.overhead).toBeGreaterThanOrEqual(0);
  // Its isolate's whole dispatch covers the framework's work around that span, and the rest of the
  // dispatch is Executor's.
  const dispatch = milliseconds(runtime.tags, "executor.app.elapsed_ms");
  expect(dispatch).toBeGreaterThanOrEqual(
    one(below(spans, tool, "app.dispatch"), "app dispatch").durationMs - roundingMs,
  );
  expect(dispatch).toBeGreaterThanOrEqual(call.durationMs - roundingMs);
  const appOwn = milliseconds(runtime.tags, "executor.app.own_ms");
  expect(appOwn).toBeCloseTo(
    dispatch - app.upstream - app.elicitation - app.authored - app.lease,
    3,
  );
  expect(appOwn).toBeGreaterThanOrEqual(app.overhead - roundingMs);
  const attribute = {
    upstream: "executor.upstream.wait_ms",
    elicitation: "executor.elicitation.wait_ms",
    authored: "executor.authored_ms",
    lease: "executor.lease.wait_ms",
    background: "executor.background_ms",
  } as const;
  for (const part of Object.keys(attribute) as (keyof typeof attribute)[]) {
    expect(app[part]).toBeGreaterThanOrEqual(0);
    expect(milliseconds(runtime.tags, attribute[part])).toBe(app[part]);
    expect(milliseconds(tool.tags, attribute[part])).toBe(app[part]);
  }
  const supervisor = runtime.tags["executor.supervisor.own_ms"];
  const own = {
    caller: milliseconds(tool.tags, "executor.caller.own_ms"),
    runner: milliseconds(runtime.tags, "executor.runner.own_ms"),
    supervisor:
      supervisor === undefined ? 0 : milliseconds(runtime.tags, "executor.supervisor.own_ms"),
    app: appOwn,
    // Start-up of an isolate that started for this call, before its own clock began.
    start: milliseconds(runtime.tags, "executor.start_ms"),
  };
  for (const part of Object.values(own)) expect(part).toBeGreaterThanOrEqual(0);
  // Only a cold hop's gap counts, and never more than the hops' gaps.
  const gaps = ["runner", "supervisor", "app"].map((hop) =>
    runtime.tags[`executor.${hop}.gap_ms`] === undefined
      ? 0
      : milliseconds(runtime.tags, `executor.${hop}.gap_ms`),
  );
  expect(own.start).toBeLessThanOrEqual(gaps.reduce((total, gap) => total + gap, 0) + roundingMs);
  // The rest of the gaps is time no clock attributes, reported apart from Executor's time.
  expect(milliseconds(runtime.tags, "executor.unclocked_ms")).toBeCloseTo(
    gaps.reduce((total, gap) => total + gap, 0) - own.start,
    3,
  );
  expect(milliseconds(tool.tags, "executor.unclocked_ms")).toBe(
    milliseconds(runtime.tags, "executor.unclocked_ms"),
  );
  expect(tool.tags["executor.runtime.cold"]).toBe(runtime.tags["executor.runtime.cold"]);
  // What started for the call, from a bounded vocabulary, in a fixed order.
  // Current runners and supervisors always say, so the call is known to be cold or warm.
  const started = runtime.tags["executor.runtime.started"];
  if (started === undefined) throw new Error("executor.runtime.started was not recorded");
  expect(tool.tags["executor.runtime.started"]).toBe(started);
  expect(started).toMatch(
    /^(runner)?,?(app)?,?(supervisor)?,?(supervisor-isolate)?,?(facet)?,?(facet-worker)?$/,
  );
  // Start-up is exactly the gap of each hop whose child started inside its parent's wait: the
  // runner's isolate, the supervisor's object, and the facet. Every other gap is unclocked. A
  // runner inside the supervisor (Cloud database calls) is reached in the supervisor's object, so
  // the caller's hop to it holds the supervisor's start.
  const parts = new Set(started.split(","));
  const runnerHost = runtime.tags["executor.runner.host"];
  expect(runnerHost === undefined || runnerHost === "supervisor").toBe(true);
  const runnerHopStarted =
    runnerHost === "supervisor" ? parts.has("supervisor") : parts.has("runner");
  // Only the supervisor's runner can report no runner start on a call whose supervisor started.
  if (runnerHost === "supervisor") expect(parts.has("runner")).toBe(false);
  expect(own.start).toBeCloseTo(
    (runnerHopStarted ? gaps[0]! : 0) +
      (parts.has("supervisor") ? gaps[1]! : 0) +
      (parts.has("facet") ? gaps[2]! : 0),
    3,
  );
  expect(milliseconds(tool.tags, "executor.start_ms")).toBe(own.start);
  const overhead = milliseconds(tool.tags, "executor.overhead_ms");
  // No isolate's duration is subtracted from another's: each part is on one clock, apart from a
  // cold hop's start-up, which no clock inside the started isolate can see.
  expect(overhead).toBeCloseTo(own.caller + own.runner + own.supervisor + own.app + own.start, 3);
  expect(tool.tags["executor.runtime.calls"]).toBe("1");
  return { spans, tool, runtime, call, app, own, overhead };
};

/** With consistent clocks, Executor's time fits in what the call did not spend elsewhere. */
const fits = ({ tool, app, overhead }: ReturnType<typeof accounted>) => {
  expect(tool.tags["executor.clock.stale"]).toBeUndefined();
  expect(overhead).toBeLessThanOrEqual(
    tool.durationMs - app.upstream - app.elicitation - app.authored - app.lease,
  );
};

const slowTool = (
  upstream: string,
  body: string,
) => `import { defineApp, query, object, string, router } from "apps";
const slow = ${JSON.stringify(`${upstream}/slow`)};
export default defineApp({}, { tools: router({
  slow: query({ input: object({}), output: string() }, ${body}),
}) });`;

/**
 * App source that makes `crypto.subtle.digest` wait `slowedMs` on a real timer whenever `slowed`
 * returns true for the bytes it hashes. Executor's cache hashes every key, so this stands in for
 * slow Executor work at a point only Executor reaches.
 */
const slowDigest = (slowed: string) => `const digest = crypto.subtle.digest.bind(crypto.subtle);
const slowed = ${slowed};
Object.defineProperty(crypto.subtle, "digest", { configurable: true, value: async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
  if (slowed(new Uint8Array(ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data)))
    await new Promise((resolve) => setTimeout(resolve, ${slowedMs}));
  return digest(algorithm, data);
} });`;

/** A migration that gives an app a database, so its calls run in its data facet. */
const notesMigration = {
  path: "migrations/0001_notes.sql",
  content: "CREATE TABLE notes (body TEXT NOT NULL);\n",
};

/** Spans below `root` named `name` that carry `key: value`. */
const tagged = (spans: readonly Span[], root: Span, name: string, key: string, value: string) =>
  below(spans, root, name).filter(({ tags }) => tags[key] === value);

layer(HostedLive, { excludeTestServices: true })("Tool-call overhead", (it) => {
  it.effect(scenarios.toolCallOverhead.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, execute, traced } = yield* fixture;
        const upstream = yield* mcpOutcomeFixture;
        const app = yield* deploy(
          slowTool(upstream, `async ({ fetch }) => (await fetch(slow)).text()`),
        );
        const result = yield* execute(
          "Call a tool that waits on its provider",
          `return await tools[${JSON.stringify(app.slug)}].slow({})`,
        );
        expect(result.structuredContent).toMatchObject({
          status: "completed",
          execution: { ok: true },
        });
        const timing = accounted(yield* traced(app, "tool-call-trace.json"));
        fits(timing);
        // The app measured the provider's wait on its own clock, and nothing else as upstream.
        expect(timing.app.upstream).toBeGreaterThanOrEqual(slowUpstreamMs);
        expect(timing.app.elicitation).toBe(0);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolCallOverheadParallel.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, execute, traced } = yield* fixture;
        const upstream = yield* mcpOutcomeFixture;
        const app = yield* deploy(
          slowTool(
            upstream,
            `async ({ fetch }) => (await Promise.all([fetch(slow), fetch(slow)].map(async (response) => (await response).text()))).join("")`,
          ),
        );
        yield* execute(
          "Call a tool that waits on two requests at once",
          `return await tools[${JSON.stringify(app.slug)}].slow({})`,
        );
        const trace = yield* traced(app, "parallel-trace.json");
        const timing = accounted(trace);
        fits(timing);
        expect(timing.app.upstream).toBeGreaterThanOrEqual(slowUpstreamMs);
        // Two overlapping waits count once: the upstream time is no more than the time the
        // provider's spans cover, which is less than their durations added up. How long the
        // fixture takes to answer on a busy machine changes neither side.
        const requests = below(trace.spans, timing.call, "provider.http.request");
        expect(requests).toHaveLength(2);
        const upstreamCovered = covered(trace.spans, timing.call, "upstream");
        expect(upstreamCovered).toBeLessThan(requests[0]!.durationMs + requests[1]!.durationMs);
        expect(timing.app.upstream).toBeLessThanOrEqual(upstreamCovered + startResolutionMs);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolCallOverheadAuthored.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, execute, traced } = yield* fixture;
        const app = yield* deploy(`import { defineApp, query, object, string, router } from "apps";
const pause = () => new Promise((resolve) => setTimeout(resolve, ${authoredStepMs}));
export default defineApp({}, async () => {
  await pause();
  return { tools: router({
    paced: query({ input: object({}), output: string(), approval: async () => { await pause(); return "approved" as const; } },
      async () => { await pause(); return "done"; }),
  }) };
});`);
        yield* execute(
          "Call a tool whose factory, policy and handler each take time",
          `return await tools[${JSON.stringify(app.slug)}].paced({})`,
        );
        const timing = accounted(yield* traced(app, "authored-trace.json"));
        fits(timing);
        // The factory, the approval policy and the handler are the app's own time.
        expect(timing.app.authored).toBeGreaterThanOrEqual(3 * authoredStepMs);
        expect(timing.overhead).toBeLessThan(timing.tool.durationMs - 3 * authoredStepMs);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolCallOverheadElicitation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, execute, traced } = yield* fixture;
        // The app asks through its Promise API.
        const asking =
          yield* deploy(`import { defineApp, query, object, string, router } from "apps";
export default defineApp({}, { tools: router({
  ask: query({ input: object({}), output: string() }, async ({ elicit }) =>
    (await elicit({ mode: "form", message: "Continue?", requestedSchema: { type: "object", properties: {} } })).action),
}) });`);
        yield* execute(
          "Call a tool that asks the person a question",
          `return await tools[${JSON.stringify(asking.slug)}].ask({})`,
        );
        const asked = accounted(yield* traced(asking, "app-elicitation-trace.json"));
        fits(asked);
        expect(asked.app.elicitation).toBeGreaterThanOrEqual(answerMs);

        // The app's MCP server asks inside its own call, so the provider's span contains the wait.
        const server = yield* mcpInCallFixture;
        const relaying = yield* deploy(
          `import { defineApp } from "apps";
import { mcpRouter } from "apps/mcp";
export default defineApp({}, async () => ({ tools: await mcpRouter({ url: ${JSON.stringify(server)} }) }));`,
          { "@modelcontextprotocol/sdk": mcpSdkVersion },
        );
        yield* execute(
          "Call a tool whose MCP server asks the person a question",
          `return await tools[${JSON.stringify(relaying.slug)}].confirm({})`,
        );
        const relay = yield* traced(relaying, "provider-elicitation-trace.json");
        const relayed = accounted(relay);
        fits(relayed);
        expect(relayed.app.elicitation).toBeGreaterThanOrEqual(answerMs);
        expect(below(relay.spans, relayed.call, "provider.mcp.elicitation").length).toBe(1);
        // The answer is counted once, as the person's, even though the provider's span holds it.
        expect(relayed.app.upstream + relayed.app.elicitation).toBeLessThanOrEqual(
          relayed.call.durationMs,
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolCallOverheadStale.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, execute, traced } = yield* fixture;
        // The app's tool moves its isolate's clock ten seconds ahead while it runs, so that clock
        // reads more time than the isolate that waited on it: what a stalled caller's clock shows.
        const ahead = (database: boolean) =>
          deploy(
            `import { defineApp, query, object, string, router } from "apps";
let skewMs = 0;
const now = Date.now.bind(Date);
Date.now = () => now() + skewMs;
const precise = performance.now.bind(performance);
Object.defineProperty(performance, "now", { configurable: true, value: () => precise() + skewMs });
const hrtime = (globalThis as { process?: { hrtime?: { bigint?: () => bigint } } }).process?.hrtime;
const exact = hrtime?.bigint?.bind(hrtime);
if (hrtime !== undefined && exact !== undefined) hrtime.bigint = () => exact() + BigInt(skewMs) * 1000000n;
export default defineApp({}, { tools: router({
  ahead: query({ input: object({}), output: string() }, async ({ sql }) => {
    skewMs += 10000;
    return ${database ? '`ahead of ${String(sql.exec("SELECT count(*) AS notes FROM notes").one()["notes"])} notes`' : '"ahead"'};
  }),
}) });`,
            {},
            database ? [notesMigration] : [],
          );
        for (const [database, pair] of [
          [false, "runner/app"],
          [true, "supervisor/app"],
        ] as const) {
          const app = yield* ahead(database);
          yield* execute(
            `Call a tool whose clock runs ahead${database ? " in its database isolate" : ""}`,
            `return await tools[${JSON.stringify(app.slug)}].ahead({})`,
          );
          const timing = accounted(yield* traced(app, `stale-${pair.replace("/", "-")}.json`));
          expect(timing.tool.tags["executor.clock.stale"]).toBe("true");
          expect(timing.tool.tags["executor.clock.stale_between"]).toBe(pair);
          expect(timing.runtime.tags["executor.clock.stale_between"]).toBe(pair);
          expect(timing.runtime.tags["executor.supervisor.own_ms"] !== undefined).toBe(database);
        }
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolCallOverheadFailure.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, execute, traced } = yield* fixture;
        const upstream = yield* mcpOutcomeFixture;
        const app = yield* deploy(
          slowTool(
            upstream,
            `async ({ fetch }) => { await (await fetch(slow)).text(); throw new Error("Synthetic failure after the provider answered"); }`,
          ),
        );
        const result = yield* execute(
          "Call a tool that fails after its provider answers",
          `return await tools[${JSON.stringify(app.slug)}].slow({})`,
        );
        expect(result.structuredContent).toMatchObject({ execution: { ok: false } });
        const timing = accounted(yield* traced(app, "failed-trace.json"));
        fits(timing);
        expect(timing.call.status).toBe("error");
        expect(timing.app.upstream).toBeGreaterThanOrEqual(slowUpstreamMs);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolCallOverheadCancelled.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, execute, traced } = yield* fixture;
        const upstream = yield* mcpOutcomeFixture;
        // `stall` says it is running, then waits until its invocation is cancelled, holding no
        // connection open. `quick` answers only once `stall` runs, so the program cannot finish
        // and cancel `stall` before its app call starts, however long the host takes to start it.
        const app = yield* deploy(`import { defineApp, query, object, string, router } from "apps";
export default defineApp({}, { tools: router({
  stall: query({ input: object({}), output: string() }, async ({ fetch, signal }) => {
    await (await fetch(${JSON.stringify(`${upstream}/arrived`)})).text();
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("late"), 60_000);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve("cancelled"); }, { once: true });
    });
  }),
  quick: query({ input: object({}), output: string() }, async ({ fetch }) =>
    (await fetch(${JSON.stringify(`${upstream}/after-arrival`)})).text()),
}) });`);
        // The program finishes while `stall` still waits, and finishing cancels it.
        const result = yield* execute(
          "Return before a waiting tool call finishes",
          `const slug = ${JSON.stringify(app.slug)};
return await Promise.race([tools[slug].stall({}), tools[slug].quick({})])`,
        );
        expect(result.structuredContent).toMatchObject({
          status: "completed",
          execution: { ok: true },
        });
        const { tool } = yield* traced(app, "cancelled-trace.json", {
          tool: "stall",
          timed: false,
        });
        // The app's part never came back, so its Executor time is unknown and none is recorded.
        expect(tool.tags["executor.runtime.calls"]).toBe("1");
        expect(tool.tags["executor.overhead_ms"]).toBeUndefined();
        expect(tool.tags["executor.caller.own_ms"]).toBeUndefined();
        expect(tool.tags["executor.clock.stale"]).toBeUndefined();
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolCallOverheadApproved.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, execute, traced } = yield* fixture;
        const upstream = yield* mcpOutcomeFixture;
        const app =
          yield* deploy(`import { defineApp, mutation, object, string, router } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({}, { tools: router({
  approved: mutation({ input: object({}), output: string(), approval: always() }, async ({ fetch }) =>
    (await fetch(${JSON.stringify(`${upstream}/slow`)})).text()),
}) });`);
        const result = yield* execute(
          "Call a tool the person approves",
          `return await tools[${JSON.stringify(app.slug)}].approved({})`,
        );
        expect(result.structuredContent).toMatchObject({
          status: "completed",
          execution: { ok: true },
        });
        // The approved call runs when the answer arrives, and its span carries its timing.
        const timing = accounted(
          yield* traced(app, "approved-trace.json", { name: "mcp.tool.resume" }),
        );
        fits(timing);
        expect(timing.app.upstream).toBeGreaterThanOrEqual(slowUpstreamMs);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.toolCallOverheadServiceInUpstream.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, execute, traced } = yield* fixture;
        const server = yield* mcpInCallFixture;
        // Only Executor's cache hashes the catalog's current key: when it reads the catalog before
        // the call, and when it invalidates the catalog inside the call's session because the server
        // announced a changed tool list.
        const app = yield* deploy(
          `import { defineApp } from "apps";
import { mcpRouter } from "apps/mcp";
${slowDigest(`(bytes: Uint8Array) => new TextDecoder().decode(bytes).includes('"current"')`)}
export default defineApp({}, async ({ cache }) => ({ tools: await mcpRouter({ url: ${JSON.stringify(server)}, cache }) }));`,
          { "@modelcontextprotocol/sdk": mcpSdkVersion },
        );
        yield* execute(
          "Call a tool whose MCP server announces a changed tool list",
          `return await tools[${JSON.stringify(app.slug)}].refresh({})`,
        );
        const trace = yield* traced(app, "service-in-upstream-trace.json");
        const timing = accounted(trace);
        fits(timing);
        const session = one(
          tagged(trace.spans, timing.call, "provider.mcp.session", "mcp.operation", "call"),
          "call session",
        );
        expect(session.tags["executor.owner"]).toBe("upstream");
        const invalidation = one(
          tagged(trace.spans, session, "app.cache.call", "cache.method", "invalidate"),
          "invalidation inside the call's session",
        );
        expect(invalidation.tags["executor.owner"]).toBe("executor");
        expect(invalidation.durationMs).toBeGreaterThanOrEqual(slowedMs);
        // The upstream session holds the invalidation, but the invalidation is Executor's work: the
        // upstream time is no more than the time upstream spans cover less the invalidation inside
        // them. A fixed bound failed whenever the fixture took longer to connect on a busy machine.
        expect(timing.app.upstream).toBeLessThanOrEqual(
          covered(trace.spans, timing.call, "upstream") -
            invalidation.durationMs +
            startResolutionMs,
        );
        expect(timing.app.overhead).toBeGreaterThanOrEqual(invalidation.durationMs);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolCallOverheadOneCacheTrip.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, execute, traced } = yield* fixture;
        const server = yield* mcpInCallFixture;
        // `refresh` stores the server's current catalog without resolving a tool through it.
        const app = yield* deploy(
          `import { defineApp, object, query, router } from "apps";
import { mcpRouter } from "apps/mcp";
export default defineApp({}, async ({ cache }) => {
  const options = { url: ${JSON.stringify(server)}, cache };
  return { tools: router({
    upstream: await mcpRouter(options),
    refresh: query({ input: object({}) }, async () => { await mcpRouter({ ...options, revalidate: true }); return true; }),
  }) };
});`,
          { "@modelcontextprotocol/sdk": "1.30.0" },
        );
        const tools = `tools[${JSON.stringify(app.slug)}]`;
        // The first call loads and stores the server's catalog; the second finds it fresh.
        yield* execute(
          "Call an MCP tool twice in one Worker",
          `await ${tools}.upstream.answer({});
return await ${tools}.upstream.answer({})`,
        );
        // Each call's app spans arrive in their own batch; wait until the warm call's have. On
        // Cloud, the first invocation of the new build (the tool listing) is cold, so it wakes the
        // app's supervisor; the wake finishes in the background, after that invocation's reply.
        const { spans, warm, cloud } = yield* traced(app, "one-cache-trip-trace.json", {
          tool: "answer",
        }).pipe(
          Effect.flatMap(({ spans }) => {
            const calls = spans
              .filter((span) => span.operationName === "mcp.tool.call")
              .sort((left, right) => Date.parse(left.startTime) - Date.parse(right.startTime));
            const warm = calls[1];
            const cloud = spans.some(({ operationName }) => operationName === "runtime.cloud.call");
            return calls.length === 2 &&
              warm !== undefined &&
              below(spans, warm, "app.cache.get").length > 0 &&
              (!cloud || spans.some(({ operationName }) => operationName === "runtime.cloud.wake"))
              ? Effect.succeed({ spans, warm, cloud })
              : Effect.fail(new Error("The warm call's spans have not arrived"));
          }),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
        );
        // A cold invocation wakes its supervisor once, ahead of its Worker's start-up and first
        // cache command, so the two starts overlap; an invocation that starts warm sends none.
        // Self-host's supervisors run in the runner's own process, so it sends no wake at all.
        const invocations = spans.filter(
          ({ operationName }) => operationName === "runtime.app.invoke",
        );
        const woken = invocations.flatMap((invocation) => {
          const wakes = below(spans, invocation, "runtime.cloud.wake");
          // The build is read in the serving span around the invocation, the Worker's cold start
          // inside it.
          const serving = spans.find(({ spanId }) => spanId === invocation.parentSpanId);
          const cold =
            below(spans, serving ?? invocation, "runtime.app.build.load").length > 0 ||
            below(spans, invocation, "runtime.app.cold_start.load").length > 0;
          if (!cold) expect(wakes).toEqual([]);
          return wakes.length === 0 ? [] : [{ invocation, wake: one(wakes, "supervisor wake") }];
        });
        expect(woken.length > 0).toBe(cloud);
        for (const { invocation, wake } of woken) {
          expect(["build", "app"]).toContain(wake.tags["executor.wake.reason"]);
          // Nobody waits on it, so it is the background's time, not the call's.
          expect(wake.tags["executor.owner"]).toBe("background");
          const wokeAt = Date.parse(wake.startTime);
          // It starts before the Worker's start-up ends and before the first cache command.
          const startup = one(below(spans, invocation, "runtime.app.rpc.start"), "Worker start");
          expect(wokeAt).toBeLessThanOrEqual(
            Date.parse(startup.startTime) + startup.durationMs + startResolutionMs,
          );
          const commands = below(spans, invocation, "runtime.cloud.cache").sort(
            (left, right) => Date.parse(left.startTime) - Date.parse(right.startTime),
          );
          const first = commands[0];
          if (first === undefined) throw new Error("The cold invocation sent no cache command");
          expect(wokeAt).toBeLessThanOrEqual(Date.parse(first.startTime) + startResolutionMs);
          // The wake reports how it found the supervisor. The listing's read usually reaches it
          // first; the wake-start scenario covers a wake that starts it.
          expect(["true", "false"]).toContain(wake.tags["executor.supervisor.cold"]);
          expect(["true", "false"]).toContain(wake.tags["executor.supervisor.isolate_cold"]);
          if (wake.tags["executor.supervisor.cold"] === "true")
            expect(first.tags["cache.supervisor.woke_by"]).toBe("wake");
          else expect(first.tags["cache.supervisor.woke_by"]).not.toBe("wake");
        }
        // The warm call reads the catalog's manifest and the called tool's part in one command.
        const commands = below(spans, warm, "app.cache.command");
        expect(commands.map((span) => span.tags["cache.operation"])).toEqual(["acquire"]);
        expect(
          one(tagged(spans, warm, "app.cache.get", "cache.result", "fresh"), "fresh catalog read"),
        ).toBeDefined();
        // Cloud also records the command where it reaches the app's supervisor.
        if (below(spans, warm, "runtime.cloud.call").length > 0) {
          const hop = one(below(spans, warm, "runtime.cloud.cache"), "supervisor command");
          expect(hop.tags["executor.app.id"]).toBe(app.id);
          expect(hop.tags["cache.operation"]).toBe("acquire");
          expect(hop.tags["cache.reads"]).toBe("1");
          expect(hop.tags["cache.command.index"]).toBe("1");
          // An earlier call of the same request woke the supervisor if anything did.
          expect(["true", "false"]).toContain(hop.tags["cache.supervisor.woke"]);
          // Only the invocation that sent a wake reports the start it made.
          expect(hop.tags["cache.supervisor.woke_by"]).toBe(
            hop.tags["cache.supervisor.woke"] === "true" ? "earlier" : undefined,
          );
          expect(hop.tags["cache.supervisor.colo"]).toMatch(/^([A-Z]+|unknown|pending)$/);
          expect(hop.tags["cache.caller.colo"]).toMatch(/^([A-Z]+|unknown|pending)$/);
          expect(Number(hop.tags["cache.supervisor.instance_ms"])).toBeGreaterThanOrEqual(0);
        }
        // A part read with the manifest is used only when the manifest names the revision it was
        // read under. Here the Worker last saw the catalog that lists `answer`; the refresh stores
        // one without it and leaves the Worker's hint behind, so the warm call reads the old
        // revision's part beside the new manifest. It must find no `answer` tool.
        const retired = yield* execute(
          "Call an MCP tool after its catalog dropped it",
          `await ${tools}.upstream.answer({});
await ${tools}.upstream.retire({});
await ${tools}.refresh({});
try { await ${tools}.upstream.answer({}); return "called"; } catch { return "missing"; }`,
        );
        expect(retired.structuredContent).toMatchObject({
          execution: { ok: true, value: "missing" },
        });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolCallOverheadWakeStart.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy } = yield* fixture;
        const api = yield* Api,
          actors = yield* Actors,
          telemetry = yield* Telemetry,
          evidence = yield* Evidence;
        // An API call that names its tool's kind skips the tool listing an MCP call reads first,
        // so nothing reaches the new app's supervisor before the cold invocation's wake. The
        // tool then reads the app's cache.
        const app = yield* deploy(`import { defineApp, object, query, router, string } from "apps";
export default defineApp({}, {
  tools: router({
    probe: query({ input: object({}) }, async ({ cache }) => (await cache.read("probe", string())) ?? "missing"),
  }),
});`);
        // Two calls in one trace, as one client operation of several requests: the first loads
        // the build and the Worker, the second finds both loaded.
        const traceparent = `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
        const traceId = traceparent.split("-")[1]!;
        for (let call = 0; call < 2; call++) {
          const answered = yield* api.request(
            actors.owner,
            "POST",
            `/api/organizations/${actors.organization.id}/apps/${app.id}/tools/call`,
            { tool: "probe", kind: "query", input: {} },
            { traceparent },
          );
          expect(answered.status, JSON.stringify(answered.body)).toBe(200);
          expect(answered.body).toBe("missing");
        }
        /** The host's span of the call that ran `invocation`, which reports what started for it. */
        const callOf = (spans: readonly Span[], invocation: Span) => {
          const byId = new Map(spans.map((span) => [span.spanId, span]));
          for (let parent = invocation.parentSpanId; parent !== null;) {
            const span = byId.get(parent);
            if (span === undefined) return undefined;
            if (/^runtime\.cloud\.[a-zA-Z]+$/.test(span.operationName))
              return span.tags["executor.runtime.started"] === undefined ? undefined : span;
            parent = span.parentSpanId;
          }
          return undefined;
        };
        const { spans, invocations } = yield* telemetry.query(traceId).pipe(
          Effect.flatMap((trace) => {
            const spans = trace.data.map(({ span }) => span);
            const invocations = spans
              .filter(({ operationName }) => operationName === "runtime.app.invoke")
              .sort((left, right) => Date.parse(left.startTime) - Date.parse(right.startTime));
            return invocations.length === 2 &&
              spans.some(({ operationName }) => operationName === "runtime.cloud.wake") &&
              invocations.every(
                (invocation) =>
                  below(spans, invocation, "runtime.cloud.cache").length > 0 &&
                  callOf(spans, invocation) !== undefined,
              )
              ? Effect.succeed({ spans, invocations })
              : Effect.fail(new Error("The calls' spans have not arrived"));
          }),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
          Effect.tap(({ spans }) => evidence.json("wake-start-trace.json", spans)),
        );
        const startedFor = (invocation: Span) =>
          callOf(spans, invocation)!.tags["executor.runtime.started"]!.split(",");
        const [cold, ...warm] = invocations;
        // The cold start's wake is the supervisor's first call, so the wake started it.
        const wake = one(below(spans, cold!, "runtime.cloud.wake"), "supervisor wake");
        expect(wake.tags["executor.supervisor.cold"]).toBe("true");
        const wokeIsolate = wake.tags["executor.supervisor.isolate_cold"] === "true";
        // Every command of that invocation reports the start its wake made, and so does its call.
        for (const command of below(spans, cold!, "runtime.cloud.cache")) {
          expect(command.tags["executor.app.id"]).toBe(app.id);
          expect(command.tags["cache.supervisor.woke"]).toBe("true");
          expect(command.tags["cache.supervisor.woke_by"]).toBe("wake");
        }
        const coldStarted = startedFor(cold!);
        expect(coldStarted).toContain("supervisor");
        expect(coldStarted.includes("supervisor-isolate")).toBe(wokeIsolate);
        // A later invocation of the same trace did not pay for that start: its commands report an
        // earlier wake, and its call reports no supervisor start. It finds the build and the Worker
        // loaded and sends no wake, unless it reached another runner isolate, whose wake then
        // finds the supervisor running.
        for (const invocation of warm) {
          for (const wake of below(spans, invocation, "runtime.cloud.wake"))
            expect(wake.tags["executor.supervisor.cold"]).toBe("false");
          for (const command of below(spans, invocation, "runtime.cloud.cache")) {
            expect(command.tags["executor.app.id"]).toBe(app.id);
            expect(command.tags["cache.supervisor.woke"]).toBe("true");
            expect(command.tags["cache.supervisor.woke_by"]).toBe("earlier");
          }
          const started = startedFor(invocation);
          expect(started).not.toContain("supervisor");
          expect(started).not.toContain("supervisor-isolate");
        }
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolCallOverheadLoader.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, execute, traced } = yield* fixture;
        const upstream = yield* mcpOutcomeFixture;
        const app = yield* deploy(`import { defineApp, query, object, string, router } from "apps";
const slow = ${JSON.stringify(`${upstream}/slow`)};
export default defineApp({}, { tools: router({
  cached: query({ input: object({}), output: string() }, async ({ cache }) =>
    cache.get({ key: "upstream", schema: string(), freshFor: "1 minute", load: async ({ fetch }) => {
      const text = await (await fetch(slow)).text();
      await new Promise((resolve) => setTimeout(resolve, ${loaderMs}));
      return text;
    } })),
}) });`);
        yield* execute(
          "Call a tool whose cache loader waits on its provider and on itself",
          `return await tools[${JSON.stringify(app.slug)}].cached({})`,
        );
        const trace = yield* traced(app, "loader-trace.json");
        const timing = accounted(trace);
        fits(timing);
        const get = one(
          tagged(trace.spans, timing.call, "app.cache.call", "cache.method", "get"),
          "cache read",
        );
        expect(get.tags["executor.owner"]).toBe("executor");
        const loader = one(
          tagged(trace.spans, get, "app.code", "executor.app.code", "loader"),
          "loader inside the cache read",
        );
        expect(loader.tags["executor.owner"]).toBe("app");
        expect(below(trace.spans, get, "provider.http.request").length).toBe(1);
        // The loader's own wait is the app's, and its request is the provider's, though both run
        // inside Executor's cache.
        expect(timing.app.authored).toBeGreaterThanOrEqual(loaderMs);
        expect(timing.app.upstream).toBeGreaterThanOrEqual(slowUpstreamMs);
        expect(timing.app.overhead).toBeLessThan(loaderMs);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolCallOverheadBackground.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, execute, traced } = yield* fixture;
        const upstream = yield* mcpOutcomeFixture;
        // The loader's cache write hashes a key only it uses, which makes Executor's cache work
        // in the refresh take `slowedMs`. `seed` stores the entry; `stale` finds it stale, hands
        // its refresh to the background and waits on its own provider meanwhile.
        const app = yield* deploy(`import { defineApp, query, object, string, router } from "apps";
${slowDigest(`(bytes: Uint8Array) => new TextDecoder().decode(bytes).includes('"refreshed"')`)}
const slow = ${JSON.stringify(`${upstream}/slow`)};
const read = (cache: { get: Function }) => cache.get({ key: "current", schema: string(), freshFor: 0, staleFor: "1 hour",
  load: async ({ cache }: { cache: { write: Function } }) => {
    await cache.write([{ key: "refreshed", value: "yes" }], "1 hour");
    return "kept";
  } });
export default defineApp({}, { tools: router({
  seed: query({ input: object({}), output: string() }, async ({ cache }) => read(cache)),
  stale: query({ input: object({}), output: string() }, async ({ cache, fetch }) =>
    \`\${await read(cache)} \${await (await fetch(slow)).text()}\`),
}) });`);
        const tools = `tools[${JSON.stringify(app.slug)}]`;
        const seeded = yield* execute("Store a cache entry", `return await ${tools}.seed({})`);
        expect(seeded.structuredContent, JSON.stringify(seeded.structuredContent)).toMatchObject({
          execution: { ok: true, value: "kept" },
        });
        const served = yield* execute(
          "Serve a stale cache entry while its refresh runs beside the provider wait",
          `return await ${tools}.stale({})`,
        );
        expect(served.structuredContent, JSON.stringify(served.structuredContent)).toMatchObject({
          execution: { ok: true },
        });
        const trace = yield* traced(app, "background-trace.json", { tool: "stale" }).pipe(
          Effect.filterOrFail(
            ({ spans, tool }) =>
              below(spans, tool, "app.cache.refresh").some(
                (refresh) =>
                  below(spans, refresh, "app.cache.call").length > 0 &&
                  below(spans, tool, "provider.http.request").length > 0,
              ),
            () => new Error("The background refresh's spans have not arrived"),
          ),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
        );
        const timing = accounted(trace);
        fits(timing);
        const refresh = one(below(trace.spans, timing.call, "app.cache.refresh"), "refresh");
        expect(refresh.tags["executor.owner"]).toBe("background");
        const write = one(
          tagged(trace.spans, refresh, "app.cache.call", "cache.method", "write"),
          "write inside the refresh",
        );
        expect(write.durationMs).toBeGreaterThanOrEqual(slowedMs);
        // The refresh's cache work ran while the tool waited on its provider. No caller waited on
        // it, so it is neither Executor's time nor the provider's.
        expect(timing.app.upstream).toBeGreaterThanOrEqual(slowUpstreamMs);
        expect(timing.app.overhead).toBeLessThan(slowedMs);
        expect(timing.app.background).toBeGreaterThanOrEqual(slowedMs);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolCallOverheadLease.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, execute, traced } = yield* fixture;
        const upstream = yield* mcpOutcomeFixture;
        const app = yield* deploy(`import { defineApp, query, object, string, router } from "apps";
const slow = ${JSON.stringify(`${upstream}/slow`)};
export default defineApp({}, { tools: router({
  shared: query({ input: object({}), output: string() }, async ({ cache }) =>
    cache.get({ key: "shared", schema: string(), freshFor: "1 hour", load: async ({ fetch }) => (await fetch(slow)).text() })),
}) });`);
        // Both calls need the same missing entry: one loads it, the other waits for that load.
        const tools = `tools[${JSON.stringify(app.slug)}]`;
        yield* execute(
          "Call two tools that need the same missing cache entry",
          `return await Promise.all([${tools}.shared({}), ${tools}.shared({})])`,
        );
        const { spans, waiter } = yield* traced(app, "lease-trace.json").pipe(
          Effect.flatMap(({ spans }) => {
            const waiter = spans.find(
              (span) =>
                span.operationName === "mcp.tool.call" &&
                below(spans, span, "app.cache.lease.wait").length > 0 &&
                below(spans, span, "app.call").some(
                  ({ tags }) => tags["executor.overhead_ms"] !== undefined,
                ),
            );
            return waiter === undefined
              ? Effect.fail(new Error("The waiting call's spans have not arrived"))
              : Effect.succeed({ spans, waiter });
          }),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
        );
        const timing = accounted({ spans, tool: waiter });
        fits(timing);
        const wait = one(below(spans, timing.call, "app.cache.lease.wait"), "lease wait");
        expect(wait.tags["executor.owner"]).toBe("lease");
        // The polls inside the wait are part of it, not Executor's work.
        expect(below(spans, wait, "app.cache.command").length).toBeGreaterThan(0);
        expect(timing.app.lease).toBeCloseTo(wait.durationMs, 0);
        expect(timing.app.overhead).toBeLessThan(timing.app.lease);
        expect(timing.app.upstream).toBe(0);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolCallOverheadAuthoredCache.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, execute, traced } = yield* fixture;
        const server = yield* mcpInCallFixture;
        // The app hands its MCP catalog a cache of its own, whose `read` waits before reading
        // Executor's cache. Calling a tool reads that tool from the catalog through it.
        const app = yield* deploy(
          `import { defineApp } from "apps";
import { mcpRouter } from "apps/mcp";
export default defineApp({}, async ({ cache }) => ({ tools: await mcpRouter({ url: ${JSON.stringify(server)}, cache: {
  ...cache,
  read: async (key, schema) => {
    await new Promise((resolve) => setTimeout(resolve, ${authoredReadMs}));
    return cache.read(key, schema);
  },
} }) }));`,
          { "@modelcontextprotocol/sdk": mcpSdkVersion },
        );
        yield* execute(
          "Call a tool whose catalog reads it through the app's own cache",
          `return await tools[${JSON.stringify(app.slug)}].refresh({})`,
        );
        const trace = yield* traced(app, "authored-cache-trace.json");
        const timing = accounted(trace);
        fits(timing);
        const read = one(
          tagged(trace.spans, timing.call, "app.code", "executor.app.code", "cache"),
          "app's cache read",
        );
        expect(read.tags["executor.owner"]).toBe("app");
        expect(read.durationMs).toBeGreaterThanOrEqual(authoredReadMs);
        // The catalog calls the app's method, so its wait is the app's, not Executor's.
        expect(timing.app.authored).toBeGreaterThanOrEqual(authoredReadMs);
        expect(timing.app.overhead).toBeLessThan(authoredReadMs);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolCallOverheadAuthoredCacheReceiver.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, execute } = yield* fixture;
        const server = yield* mcpInCallFixture;
        // The app's cache is a class: every method reaches the app's cache through `this`, and
        // `revalidate` calls `this.get`. Its loads run with this cache, so the catalog's writes
        // go through it too.
        const app = yield* deploy(
          `import { defineApp } from "apps";
import { mcpRouter } from "apps/mcp";
class AppCache {
  constructor(inner) { this.inner = inner; }
  get(options) { return this.inner.get({ ...options, load: (context) => options.load({ ...context, cache: this }) }); }
  revalidate(options) { return this.get(options); }
  read(key, schema) { return this.inner.read(key, schema); }
  readMany(keys, schema) { return this.inner.readMany(keys, schema); }
  write(entries, retention) { return this.inner.write(entries, retention); }
  invalidate(key) { return this.inner.invalidate(key); }
  forAccount(account) { return new AppCache(this.inner.forAccount(account)); }
}
export default defineApp({}, async ({ cache }) => ({ tools: await mcpRouter({ url: ${JSON.stringify(server)}, cache: new AppCache(cache), revalidate: true }) }));`,
          { "@modelcontextprotocol/sdk": mcpSdkVersion },
        );
        const result = yield* execute(
          "Call a tool whose catalog the app keeps in a cache class",
          `return await tools[${JSON.stringify(app.slug)}].refresh({})`,
        );
        expect(result.structuredContent, JSON.stringify(result.structuredContent)).toMatchObject({
          status: "completed",
          execution: { ok: true },
        });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolCallOverheadDatabase.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, execute, traced } = yield* fixture;
        const app = yield* deploy(
          `import { defineApp, mutation, object, string, router } from "apps";
export default defineApp({}, { tools: router({
  note: mutation({ input: object({}), output: string() }, async ({ sql }) => {
    sql.exec("INSERT INTO notes (body) VALUES (?)", "note");
    return \`\${String(sql.exec("SELECT count(*) AS notes FROM notes").one()["notes"])} notes\`;
  }),
}) });`,
          {},
          [notesMigration],
        );
        const result = yield* execute(
          "Call a tool that writes and reads its SQL database",
          `return await tools[${JSON.stringify(app.slug)}].note({})`,
        );
        expect(JSON.stringify(result.structuredContent)).toContain("1 notes");
        // The call runs in the app's data facet, so its supervisor reports its own part too. Its SQL
        // is synchronous: it runs on the handler's own stack, where the isolate's clock does not
        // move, so it leaves no wait for any owner.
        const trace = yield* traced(app, "database-trace.json");
        const timing = accounted(trace);
        fits(timing);
        expect(timing.runtime.tags["executor.supervisor.own_ms"]).toBeDefined();
        // Whether the facet started for this call depends on what ran before it (the app's
        // migrations may have started it); either way the call says so, and a facet that started
        // inside the supervisor's wait counts that wait's gap as start-up.
        const facetStarted = (timing.runtime.tags["executor.runtime.started"] ?? "")
          .split(",")
          .includes("facet");
        expect(
          milliseconds(timing.runtime.tags, "executor.supervisor.wait_ms"),
        ).toBeGreaterThanOrEqual(milliseconds(timing.runtime.tags, "executor.app.gap_ms"));
        // Cloud's supervisor joins the trace with its own span for the call.
        if (below(trace.spans, timing.tool, "runtime.cloud.call").length > 0) {
          // Cloud sends a database call to the app's supervisor, which runs its runner itself.
          expect(timing.runtime.tags["executor.runner.host"]).toBe("supervisor");
          // Only an AppData version older than `run` sends the call to the shared runner instead.
          expect(
            trace.spans.filter(({ tags }) => tags["executor.runner.fallback"] !== undefined),
          ).toEqual([]);
          const supervisor = yield* traced(app, "database-supervisor-trace.json").pipe(
            Effect.flatMap(({ spans }) => {
              const span = spans.find(
                ({ operationName }) => operationName === "runtime.app.data.invoke",
              );
              return span === undefined
                ? Effect.fail(new Error("The supervisor's span has not arrived"))
                : Effect.succeed({ spans, span });
            }),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
          );
          expect(supervisor.span.tags["executor.facet.cold"]).toBe(String(facetStarted));
          expect(supervisor.span.tags["executor.data.write"]).toBe("true");
          expect(below(supervisor.spans, supervisor.span, "runtime.app.data.facet").length).toBe(1);
        }
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolCallOverheadDatabaseFacets.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, execute, toolCalls } = yield* fixture;
        const upstream = yield* mcpOutcomeFixture;
        // `hold` keeps running until a note exists, and `note` waits on the upstream before it
        // writes one, so whichever of the two reaches the facet first is still running when the
        // other arrives.
        const app = yield* deploy(
          `import { defineApp, mutation, query, object, number, string, router } from "apps";
const slow = ${JSON.stringify(`${upstream}/slow`)};
export default defineApp({}, { tools: router({
  count: query({ input: object({}), output: number() }, async ({ sql }) =>
    Number(sql.exec("SELECT count(*) AS notes FROM notes").one()["notes"])),
  hold: query({ input: object({}), output: number() }, async ({ sql }) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      await (await fetch(slow)).text();
      const notes = Number(sql.exec("SELECT count(*) AS notes FROM notes").one()["notes"]);
      if (notes > 0) return notes;
    }
    throw new Error("No note was written while this call ran");
  }),
  note: mutation({ input: object({}), output: string() }, async ({ sql }) => {
    await (await fetch(slow)).text();
    sql.exec("INSERT INTO notes (body) VALUES (?)", "note");
    return "noted";
  }),
}) });`,
          {},
          [notesMigration],
        );
        const startedFacet = (tags: Tags) =>
          (tags["executor.runtime.started"] ?? "").split(",").includes("facet");
        // Cloudflare counts a facet's subrequests over its whole life, so each call that finds
        // the facet idle runs in a fresh one: none inherits what earlier calls sent.
        for (let call = 1; call <= 3; call++) {
          const result = yield* execute(
            `Database call ${call} of 3`,
            `return await tools[${JSON.stringify(app.slug)}].count({})`,
          );
          expect(result.structuredContent, JSON.stringify(result.structuredContent)).toMatchObject({
            status: "completed",
            execution: { ok: true, value: 0 },
          });
        }
        const sequential = yield* toolCalls(app, "count", 3);
        expect(sequential.map(startedFacet)).toEqual([true, true, true]);
        // A call that arrives while another runs joins the running facet: a running call may be
        // waiting on it, so it is never held back for a fresh one.
        const overlapping = yield* execute(
          "Two database calls that overlap",
          `const app = tools[${JSON.stringify(app.slug)}];
const held = app.hold({});
const noted = app.note({});
return [await held, await noted];`,
        );
        expect(
          overlapping.structuredContent,
          JSON.stringify(overlapping.structuredContent),
        ).toMatchObject({ status: "completed", execution: { ok: true, value: [1, "noted"] } });
        const [hold] = yield* toolCalls(app, "hold", 1);
        const [note] = yield* toolCalls(app, "note", 1);
        expect([hold!, note!].filter(startedFacet).length).toBe(1);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolCallOverheadStart.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, execute, traced } = yield* fixture;
        const upstream = yield* mcpOutcomeFixture;
        // The app answers its dispatched request's body from the request it was built with, so its
        // handler runs in the same turn the call is dispatched in. The handler starts its request,
        // then holds the isolate's thread, which delays everything that turn would send, and its
        // clock reads the hold only once the request completes. Were the app dispatched while the
        // runner still waited for the call to start, the runner would count that time as its own.
        const app = yield* deploy(`import { defineApp, query, object, string, router } from "apps";
const slow = ${JSON.stringify(`${upstream}/slow`)};
const bodies = new WeakMap<Request, string>();
const NativeRequest = Request;
globalThis.Request = class extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init);
    if (String(input) === "https://app.internal/dispatch" && typeof init?.body === "string") bodies.set(this, init.body);
  }
};
const json = NativeRequest.prototype.json;
NativeRequest.prototype.json = function (this: Request) {
  const body = bodies.get(this);
  return body === undefined ? json.call(this) : Promise.resolve(JSON.parse(body));
};
export default defineApp({}, { tools: router({
  busy: query({ input: object({}), output: string() }, async ({ fetch }) => {
    const answer = fetch(slow);
    let spun = 0;
    for (let index = 0; index < ${spinIterations}; index++) spun = (Math.imul(spun, 31) + index) | 0;
    return \`\${await (await answer).text()} after \${spun}\`;
  }),
}) });`);
        yield* execute(
          "Call a tool that holds its isolate in the turn it is dispatched in",
          `return await tools[${JSON.stringify(app.slug)}].busy({})`,
        );
        const timing = accounted(yield* traced(app, "start-trace.json"));
        fits(timing);
        expect(timing.app.upstream).toBeGreaterThanOrEqual(slowUpstreamMs);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolCallOverheadDispatch.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, execute, traced } = yield* fixture;
        // The framework reads the app's response after the call span ends. The app makes that read
        // wait once, standing in for framework work outside every span.
        const app = yield* deploy(`import { defineApp, query, object, string, router } from "apps";
let armed = false;
const json = Response.prototype.json;
Response.prototype.json = async function () {
  if (armed) {
    armed = false;
    await new Promise((resolve) => setTimeout(resolve, ${slowedMs}));
  }
  return json.call(this);
};
export default defineApp({}, { tools: router({
  framed: query({ input: object({}), output: string() }, async () => { armed = true; return "done"; }),
}) });`);
        yield* execute(
          "Call a tool whose response the framework reads slowly",
          `return await tools[${JSON.stringify(app.slug)}].framed({})`,
        );
        const trace = yield* traced(app, "dispatch-trace.json");
        const timing = accounted(trace);
        fits(timing);
        const dispatch = one(below(trace.spans, timing.tool, "app.dispatch"), "app dispatch");
        expect(milliseconds(timing.runtime.tags, "executor.app.elapsed_ms")).toBeGreaterThanOrEqual(
          dispatch.durationMs + slowedMs,
        );
        // The wait is outside the app's spans, so only the isolate's whole dispatch sees it.
        expect(timing.app.overhead).toBeLessThan(slowedMs);
        expect(timing.own.app).toBeGreaterThanOrEqual(slowedMs);
        expect(timing.overhead).toBeGreaterThanOrEqual(slowedMs);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
