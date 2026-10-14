/**
 * A program loads only the apps it uses: CodeMode's global `search()` ranks in the backend, and
 * dynamic access to `tools` loads an app when the program first reaches it.
 */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { lazyStallTimeoutMs, scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { App } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { appsManifest } from "../support/apps-release.ts";

/** Catalog apps and their tools: enough that loading every listing would show in the trace. */
const catalogApps = 6;
const toolsPerApp = 120;

/** Every tool names its app and itself in a marker, so a search can single one out. */
const catalogAppSource = (
  index: number,
) => `import { defineApp, query, jsonSchema, router } from "apps";
export default defineApp({}, async () => {
  const tools = {};
  for (let t = 0; t < ${toolsPerApp}; t++)
    tools["op" + t] = query(
      {
        description: "Operation " + t + " of lazy catalog app ${index} (marker zq${index}x" + t + "q).",
        input: jsonSchema({ type: "object", properties: { id: { type: "string", description: "Record identifier for operation " + t } }, required: ["id"] }),
      },
      async (_ctx, input) => ({ app: ${index}, tool: t, id: input.id }),
    );
  return { tools: router(tools) };
});`;

const echoAppSource = (
  name: string,
) => `import { defineApp, query, object, string, router } from "apps";
export default defineApp({}, async () => ({ tools: router({
  echo: query({ input: object({ text: string() }), description: "Echo text from the ${name} fixture" },
    async (_ctx, { text }) => ({ app: ${JSON.stringify(name)}, text })),
}) }));`;

// Discovery of this app always fails, so `unavailableApps` shows whether an execution touched it.
const brokenAppSource = `import { defineApp } from "apps";
export default defineApp({}, async () => {
  throw new Error("Synthetic evaluation failure");
});`;

// This app's listing never finishes within a scenario, so a program that reaches it waits on it.
const stalledAppSource = `import { defineApp, query, object, router } from "apps";
export default defineApp({}, async () => {
  await new Promise((resolve) => setTimeout(resolve, 120_000));
  return { tools: router({ echo: query({ input: object({}), description: "Never listed" }, async () => "late") }) };
});`;

const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Struct({ kind: Schema.String, message: Schema.String })),
  }),
  unavailableApps: Schema.Array(Schema.Struct({ app: Schema.String, reason: Schema.String })),
});
const SearchPage = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ path: Schema.String, description: Schema.String, signature: Schema.String }),
  ),
  remaining: Schema.Number,
  next: Schema.NullOr(Schema.Struct({ offset: Schema.Number })),
});

/**
 * An organization's apps and an MCP client that runs programs. Each run returns the result and the
 * request's spans, by operation name, once the execute span is delivered.
 */
const setup = (label: string, apps: ReadonlyArray<{ name: string; source: string }>) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      mcp = yield* McpClient,
      evidence = yield* Evidence,
      telemetry = yield* Telemetry;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const key = yield* body(
      Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
      yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", { name: label }),
    );
    yield* Effect.addFinalizer(() =>
      api
        .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
        .pipe(Effect.orDie),
    );
    const run = randomUUID().slice(0, 8);
    const deployed = yield* Effect.forEach(
      apps,
      ({ name, source }) =>
        Effect.gen(function* () {
          const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `${name} ${run}`,
            files: [{ path: "index.ts", content: source }, appsManifest],
          });
          expect(response.status).toBe(200);
          return yield* body(App, response);
        }),
      { concurrency: 4 },
    );
    const client = yield* mcp.connect(key.key, label, { organization: actors.organization.id });
    const execute = (step: string, code: string) =>
      Effect.gen(function* () {
        const result = yield* client.use(step, (client, signal) =>
          client.callTool({ name: "execute", arguments: { code } }, undefined, {
            signal,
            timeout: 55_000,
          }),
        );
        yield* evidence.json(
          `${step.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}.json`,
          result.structuredContent,
        );
        const completed = yield* Schema.decodeUnknownEffect(Completed)(result.structuredContent);
        const request = (yield* evidence.requests).filter((entry) => entry.path === "/mcp").at(-1);
        if (request === undefined) return yield* Effect.fail(new Error("Missing MCP request"));
        const spans = yield* telemetry.query(request.traceId).pipe(
          Effect.flatMap((trace) =>
            trace.data.some(({ span }) => span.operationName === "mcp.execute")
              ? Effect.succeed((name: string) =>
                  trace.data
                    .filter(({ span }) => span.operationName === name)
                    .map(({ span }) => span.tags),
                )
              : Effect.fail(new Error(`Missing execute span for ${step}`)),
          ),
          Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 80 }),
        );
        return { ...completed, spans };
      });
    return { apps: deployed, execute };
  });

layer(HostedLive, { excludeTestServices: true })("MCP execute lazy catalog", (it) => {
  it.effect(scenarios.mcpGlobalSearchLoadsNoListings.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { apps, execute } = yield* setup(
          "Global search",
          Array.from({ length: catalogApps }, (_, index) => ({
            name: `Lazy catalog ${index}`,
            source: catalogAppSource(index),
          })),
        );
        const slugs = apps.map((app) => app.slug);
        const target = apps[3]!;
        const path = `tools[${JSON.stringify(target.slug)}].op7`;

        // CodeMode's search() ranks in the backend and returns CodeMode's own item shape. It loads
        // no app's tool listing and renders only the signatures on its page.
        const searched = yield* execute(
          "Global search",
          `return await search({ query: "zq3x7q" });`,
        );
        expect(searched.execution.ok).toBe(true);
        const page = yield* Schema.decodeUnknownEffect(SearchPage)(searched.execution.value);
        expect(page.items[0]?.path).toBe(path);
        expect(page.items[0]?.description).toContain("zq3x7q");
        expect(page.items[0]?.signature).toMatch(
          new RegExp(
            `^${path.replaceAll(/[[\]"().]/g, "\\$&")}\\(input: .*\\bid: string.*\\): Promise<`,
            "s",
          ),
        );
        expect(searched.spans("mcp.discovery.tools")).toEqual([]);
        expect(searched.spans("mcp.discovery.namespace")).toEqual([]);
        const coldFills = searched.spans("sdk.tools.searchable.cold-fill");
        expect(coldFills.length).toBeGreaterThanOrEqual(catalogApps);
        expect(new Set(coldFills.map((tags) => tags["executor.search.fill.limit"]))).toEqual(
          new Set(["2"]),
        );
        expect(searched.spans("mcp.catalog")[0]).toMatchObject({
          "executor.discovery.reach_reason": "search",
          "executor.discovery.tools": "0",
        });
        expect(
          Number(searched.spans("mcp.execute")[0]?.["executor.codemode.signatures_rendered"]),
        ).toBe(page.items.length);

        // A page of one continues at the next offset, as CodeMode's search() documents.
        const paged = yield* execute(
          "Global search page",
          `return await search({ query: "lazy catalog app", limit: 1 });`,
        );
        const first = yield* Schema.decodeUnknownEffect(SearchPage)(paged.execution.value);
        expect(first.items).toHaveLength(1);
        expect(first.remaining).toBeGreaterThan(0);
        expect(first.next).toEqual({ offset: 1 });

        // Calling a result through the path it returns loads the result's app and no other.
        const called = yield* execute(
          "Call a search result",
          `const { items } = await search({ query: "zq3x7q", limit: 1 });
const slug = ${JSON.stringify(slugs)}.find((slug) => items[0].path.startsWith("tools[" + JSON.stringify(slug) + "]"));
const name = items[0].path.split(".").at(-1);
return await tools[slug][name]({ id: "rec_1" });`,
        );
        expect(called.execution).toMatchObject({
          ok: true,
          value: { app: 3, tool: 7, id: "rec_1" },
        });
        expect(called.spans("mcp.catalog")[0]).toMatchObject({
          "executor.discovery.reach_reason": "dynamic",
          "executor.discovery.tools": "0",
        });
        expect(called.spans("mcp.discovery.namespace")).toHaveLength(1);
        expect(called.spans("mcp.discovery.namespace")[0]).toMatchObject({
          "executor.discovery.tools": String(toolsPerApp),
        });
        expect(called.spans("mcp.discovery.tools")).toHaveLength(1);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.mcpDynamicToolsLoadOneApp.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { apps, execute } = yield* setup("Dynamic tools", [
          { name: "Lazy alpha", source: echoAppSource("alpha") },
          { name: "Lazy beta", source: echoAppSource("beta") },
          { name: "Lazy broken", source: brokenAppSource },
        ]);
        const [alpha, beta, broken] = apps as [typeof App.Type, typeof App.Type, typeof App.Type];
        const touched = (result: { unavailableApps: ReadonlyArray<{ app: string }> }) =>
          result.unavailableApps.some((entry) => entry.app === broken.id);
        const a = JSON.stringify(alpha.slug);

        // A computed member loads that app when the program calls into it, and no other.
        const computed = yield* execute(
          "Computed member access",
          `const name = [${a}][0];
return await tools[name].echo({ text: "computed" });`,
        );
        expect(computed.execution).toMatchObject({
          ok: true,
          value: { app: "alpha", text: "computed" },
        });
        expect(touched(computed)).toBe(false);
        expect(computed.spans("mcp.catalog")[0]).toMatchObject({
          "executor.discovery.reach_reason": "dynamic",
          "executor.discovery.reachable": "0",
        });
        expect(computed.spans("mcp.discovery.namespace")).toHaveLength(1);
        expect(computed.spans("mcp.discovery.tools")).toHaveLength(1);

        // Listing the keys of `tools` lists apps and loads none of them.
        const listed = yield* execute("Enumerate tools", `return Object.keys(tools);`);
        expect(listed.execution.ok).toBe(true);
        expect(listed.execution.value).toEqual(
          expect.arrayContaining([alpha.slug, beta.slug, broken.slug, "search"]),
        );
        expect(touched(listed)).toBe(false);
        expect(listed.spans("mcp.discovery.namespace")).toEqual([]);
        expect(listed.spans("mcp.discovery.tools")).toEqual([]);

        // Listing the keys of one app loads that app.
        const keys = yield* execute(
          "Enumerate one app",
          `const name = [${a}][0];
const found = [];
for (const key in tools[name]) found.push(key);
return { keys: Object.keys(tools[name]), found };`,
        );
        expect(keys.execution).toMatchObject({
          ok: true,
          value: { keys: ["echo"], found: ["echo"] },
        });
        expect(touched(keys)).toBe(false);
        expect(keys.spans("mcp.discovery.namespace")).toHaveLength(1);

        // An unknown tool of a loaded app stays unknown.
        const unknown = yield* execute(
          "Unknown tool of a reached app",
          `const name = [${a}][0];
return await tools[name].missing({});`,
        );
        expect(unknown.execution).toMatchObject({ ok: false, error: { kind: "UnknownTool" } });
        expect(touched(unknown)).toBe(false);

        // An app that fails to load is reported as before, as a static call would report it.
        const staticBroken = yield* execute(
          "Static call into a broken app",
          `return await tools[${JSON.stringify(broken.slug)}].echo({ text: "x" });`,
        );
        const dynamicBroken = yield* execute(
          "Computed call into a broken app",
          `const name = [${JSON.stringify(broken.slug)}][0];
return await tools[name].echo({ text: "x" });`,
        );
        expect(staticBroken.execution).toMatchObject({ ok: false, error: { kind: "ToolFailure" } });
        expect(dynamicBroken.execution).toEqual(staticBroken.execution);
        expect(touched(dynamicBroken)).toBe(true);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(
    scenarios.mcpDynamicToolsStallTimesOut.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const { apps, execute } = yield* setup("Dynamic stall", [
            { name: "Lazy stalled", source: stalledAppSource },
          ]);
          const stalled = apps[0]!;

          // A program that only waits ends at the execution's budget.
          const waited = yield* execute("Program that outlives its budget", `while (true) {}`);
          expect(waited.execution).toMatchObject({ ok: false, error: { kind: "TimeoutExceeded" } });

          // The program reaches the app only once it runs, so discovery waits for nothing and the
          // load runs until the execution's own deadline, past discovery's 10 s wait.
          const began = yield* Clock.currentTimeMillis;
          const reached = yield* execute(
            "Computed call into a stalled app",
            `const name = [${JSON.stringify(stalled.slug)}][0];
return await tools[name].echo({});`,
          );
          expect((yield* Clock.currentTimeMillis) - began).toBeGreaterThanOrEqual(
            lazyStallTimeoutMs - 1_000,
          );
          expect(reached.execution).toMatchObject({
            ok: false,
            error: {
              kind: "TimeoutExceeded",
              message: `Execution timed out after ${lazyStallTimeoutMs}ms; earlier tool calls may have completed.`,
            },
          });
          expect(reached.spans("mcp.catalog")[0]).toMatchObject({
            "executor.discovery.reach_reason": "dynamic",
          });
          expect(reached.spans("mcp.execute")[0]).toMatchObject({
            "executor.timeout.phase": "program",
          });
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 120_000 },
  );
});
