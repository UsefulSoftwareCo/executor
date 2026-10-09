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
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, type SpanQuery } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { mcpOutcomeFixture, slowUpstreamMs } from "../support/mcp-outcome-fixture.ts";
import { mcpInCallFixture } from "../support/mcp-in-call-fixture.ts";
import { withApps } from "../support/apps-release.ts";

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
  return { deploy, execute, traced };
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
    overhead: milliseconds(call.tags, "executor.overhead_ms"),
  };
  // The app measured its own span, from its start to its end, and divided all of it.
  expect(app.overhead + app.upstream + app.elicitation + app.authored).toBeCloseTo(
    call.durationMs,
    2,
  );
  expect(app.overhead).toBeGreaterThanOrEqual(0);
  // Its isolate's whole dispatch covers the framework's work around that span, and the rest of the
  // dispatch is Executor's.
  const dispatch = milliseconds(runtime.tags, "executor.app.elapsed_ms");
  expect(dispatch).toBeGreaterThanOrEqual(
    one(below(spans, tool, "app.dispatch"), "app dispatch").durationMs - roundingMs,
  );
  expect(dispatch).toBeGreaterThanOrEqual(call.durationMs - roundingMs);
  const appOwn = milliseconds(runtime.tags, "executor.app.own_ms");
  expect(appOwn).toBeCloseTo(dispatch - app.upstream - app.elicitation - app.authored, 3);
  expect(appOwn).toBeGreaterThanOrEqual(app.overhead - roundingMs);
  for (const part of ["upstream", "elicitation", "authored"] as const) {
    expect(app[part]).toBeGreaterThanOrEqual(0);
    expect(
      milliseconds(
        runtime.tags,
        `executor.${part === "authored" ? "authored_ms" : `${part}.wait_ms`}`,
      ),
    ).toBe(app[part]);
  }
  const supervisor = runtime.tags["executor.supervisor.own_ms"];
  const own = {
    caller: milliseconds(tool.tags, "executor.caller.own_ms"),
    runner: milliseconds(runtime.tags, "executor.runner.own_ms"),
    supervisor:
      supervisor === undefined ? 0 : milliseconds(runtime.tags, "executor.supervisor.own_ms"),
    app: appOwn,
  };
  for (const part of Object.values(own)) expect(part).toBeGreaterThanOrEqual(0);
  const overhead = milliseconds(tool.tags, "executor.overhead_ms");
  // No isolate's duration is subtracted from another's: each part is on one clock.
  expect(overhead).toBeCloseTo(own.caller + own.runner + own.supervisor + own.app, 3);
  expect(tool.tags["executor.runtime.calls"]).toBe("1");
  expect(milliseconds(tool.tags, "executor.upstream.wait_ms")).toBe(app.upstream);
  expect(milliseconds(tool.tags, "executor.elicitation.wait_ms")).toBe(app.elicitation);
  expect(milliseconds(tool.tags, "executor.authored_ms")).toBe(app.authored);
  return { spans, tool, runtime, call, app, own, overhead };
};

/** With consistent clocks, Executor's time fits in what the call did not spend elsewhere. */
const fits = ({ tool, app, overhead }: ReturnType<typeof accounted>) => {
  expect(tool.tags["executor.clock.stale"]).toBeUndefined();
  expect(overhead).toBeLessThanOrEqual(
    tool.durationMs - app.upstream - app.elicitation - app.authored,
  );
};

const slowTool = (
  upstream: string,
  body: string,
) => `import { defineApp, query, object, string, router } from "apps";
const slow = ${JSON.stringify(`${upstream}/slow`)};
export default defineApp({ accounts: {} }, { tools: router({
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
        const timing = accounted(yield* traced(app, "parallel-trace.json"));
        fits(timing);
        // Two overlapping waits count once.
        expect(timing.app.upstream).toBeGreaterThanOrEqual(slowUpstreamMs);
        expect(timing.app.upstream).toBeLessThan(2 * slowUpstreamMs);
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
export default defineApp({ accounts: {} }, async () => {
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
export default defineApp({ accounts: {} }, { tools: router({
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
export default defineApp({ accounts: {} }, async () => ({ tools: await mcpRouter({ url: ${JSON.stringify(server)} }) }));`,
          { "@modelcontextprotocol/client": "2.0.0", "@modelcontextprotocol/core": "2.0.0" },
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
export default defineApp({ accounts: {} }, { tools: router({
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
        // `stall` waits until its invocation is cancelled, holding no connection open.
        const app = yield* deploy(`import { defineApp, query, object, string, router } from "apps";
export default defineApp({ accounts: {} }, { tools: router({
  stall: query({ input: object({}), output: string() }, ({ signal }) => new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve("late"), 60_000);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve("cancelled"); }, { once: true });
  })),
  quick: query({ input: object({}), output: string() }, async () => "quick"),
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
export default defineApp({ accounts: {} }, { tools: router({
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
export default defineApp({ accounts: {} }, async ({ cache }) => ({ tools: await mcpRouter({ url: ${JSON.stringify(server)}, cache }) }));`,
          { "@modelcontextprotocol/client": "2.0.0", "@modelcontextprotocol/core": "2.0.0" },
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
        // The upstream session holds the invalidation, but the invalidation is Executor's work.
        expect(timing.app.upstream).toBeLessThan(slowedMs);
        expect(timing.app.overhead).toBeGreaterThanOrEqual(invalidation.durationMs);
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
export default defineApp({ accounts: {} }, { tools: router({
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
export default defineApp({ accounts: {} }, async ({ cache }) => ({ tools: await mcpRouter({ url: ${JSON.stringify(server)}, cache: {
  ...cache,
  read: async (key, schema) => {
    await new Promise((resolve) => setTimeout(resolve, ${authoredReadMs}));
    return cache.read(key, schema);
  },
} }) }));`,
          { "@modelcontextprotocol/client": "2.0.0", "@modelcontextprotocol/core": "2.0.0" },
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
export default defineApp({ accounts: {} }, async ({ cache }) => ({ tools: await mcpRouter({ url: ${JSON.stringify(server)}, cache: new AppCache(cache), revalidate: true }) }));`,
          { "@modelcontextprotocol/client": "2.0.0", "@modelcontextprotocol/core": "2.0.0" },
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
export default defineApp({ accounts: {} }, { tools: router({
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
        const timing = accounted(yield* traced(app, "database-trace.json"));
        fits(timing);
        expect(timing.runtime.tags["executor.supervisor.own_ms"]).toBeDefined();
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
export default defineApp({ accounts: {} }, { tools: router({
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
export default defineApp({ accounts: {} }, { tools: router({
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
