import { expect, layer } from "@effect/vitest";
import { Clock, Console, Effect, Fiber, Schedule, Schema } from "effect";
import { createServer, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { agedRowsRenewSeconds, scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { App, Resource } from "../support/contracts.ts";
import { saveAndDeploy } from "../support/app-authoring.ts";
import {
  Evidence,
  Telemetry,
  type DeliveredSpan,
  type TelemetryUnavailable,
  type TraceUnsettled,
} from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { machineWork, referenceMachineWorkMs } from "../support/machine-speed.ts";
import { McpClient } from "../support/mcp-client.ts";
import { expireEvaluated, writeRows } from "../support/cloud-rows.ts";
import {
  connectionsPath,
  linkAccount,
  linkAccountResponse,
  linkedAccountIds,
} from "../support/app-accounts.ts";
import { appsManifest, withApps, mcpSdkVersion } from "../support/apps-release.ts";

const appCount = 28;
const toolsPerApp = 175;
const largeApp = appCount;
const largeAppTools = 2_100;
const stalledApps = 8;

const scaleAppSource = (
  index: number,
  tools: number,
) => `import { defineApp, query, jsonSchema, router } from "apps";
const app = ${index};
const verbs = ["List", "Get", "Create", "Update", "Delete", "Search", "Export", "Archive"];
const resources = ["accounts", "invoices", "orders", "customers", "shipments", "tickets", "reports", "projects", "members", "webhooks", "payouts", "subscriptions"];
const text = (subject, n) => subject + " for the synthetic " + resources[n % resources.length] + " collection. Accepts the identifier or slug returned by an earlier list call, is case-sensitive, and must not exceed " + (64 + (n % 7) * 32) + " characters. Values that do not match an existing record are ignored rather than rejected.";
const schema = (t) => {
  const body = {};
  for (let p = 0; p < 11; p++) {
    const description = text("Field " + p + " of request " + t, app + t + p);
    body["field_" + p] =
      p % 4 === 0 ? { type: "array", description, items: { type: "object", properties: { key: { type: "string", description: text("Entry key", p) }, value: { type: "string", description: text("Entry value", p + 1) } }, required: ["key"] } }
      : p % 4 === 1 ? { type: "string", description, enum: ["draft", "open", "pending", "active", "paused", "closed", "archived", "deleted"] }
      : p % 4 === 2 ? { type: "integer", description, minimum: 0, maximum: 10000 }
      : { type: "string", description };
  }
  return { type: "object", properties: {
    path: { type: "object", properties: { id: { type: "string", description: text("Record identifier", t) } }, required: ["id"] },
    query: { type: "object", properties: { cursor: { type: "string", description: text("Pagination cursor", t) }, limit: { type: "integer", minimum: 1, maximum: 100, description: text("Page size", t) } } },
    body: { type: "object", properties: body },
  }, required: ["path"] };
};
export default defineApp({}, async () => {
  const tools = {};
  for (let t = 0; t < ${tools}; t++)
    tools["op" + t] = query(
      { description: verbs[t % verbs.length] + " " + resources[t % resources.length] + " in synthetic scale app " + app + " (marker zq" + app + "x" + t + "q).", input: jsonSchema(schema(t)) },
      async (_ctx, input) => ({ app, tool: t, id: input.path.id }),
    );
  return { tools: router(tools) };
});`;

const stalledAppSource = (origin: string) => `import { defineApp } from "apps";
import { mcpRouter } from "apps/mcp";
export default defineApp({}, async () => ({ tools: await mcpRouter({ url: ${JSON.stringify(`${origin}/mcp`)} }) }));`;

const stalledServer = Effect.acquireRelease(
  Effect.callback<{ server: ReturnType<typeof createServer>; sockets: Set<Socket> }>((resume) => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ server, sockets })));
  }),
  ({ server, sockets }) =>
    Effect.callback<void>((resume) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.flatMap(({ server }) => {
    const address = server.address();
    return address !== null && typeof address === "object"
      ? Effect.succeed(`http://127.0.0.1:${address.port}`)
      : Effect.die(new Error("Stalled server requires a TCP listener"));
  }),
);

const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Struct({ kind: Schema.String, message: Schema.String })),
  }),
  unavailableApps: Schema.Array(Schema.Struct({ app: Schema.String, reason: Schema.String })),
});
const expectNoneUnavailable = (
  step: string,
  completed: typeof Completed.Type,
  apps: ReadonlyArray<{ readonly id: string; readonly slug: string }>,
) => {
  const reported = completed.unavailableApps;
  const named = reported.map(
    (entry) => `${apps.find((app) => app.id === entry.app)?.slug ?? entry.app} (${entry.reason})`,
  );
  expect(
    reported,
    `${step}: the product reported ${reported.length} apps unavailable: ${named.join("; ")}`,
  ).toEqual([]);
};
const SearchValue = Schema.Struct({
  items: Schema.Array(Schema.Struct({ path: Schema.String, input: Schema.String })),
});

const noAppStatements = 3;
const oneAppStatements = 24;
const catalogSearchBoundMs = 15_000;
const catalogSearchPerCall = 40;
const statementsPerApp = 6;
const statementsPerSearch = 9;
const statementMargin = 10;
const repeatedSearchBoundMs = 3_000;
const searchWork = (spans: ReadonlyArray<DeliveredSpan>) => {
  const named = (operation: string) => spans.filter((span) => span.operationName === operation);
  const rows = named("sdk.tools.searchable").filter(
    (span) => span.tags["executor.search.rows"] !== undefined,
  );
  const catalog = named("mcp.catalog")[0]?.tags;
  return {
    apps: Number(catalog?.["executor.discovery.apps"]),
    reachable: Number(catalog?.["executor.discovery.reachable"]),
    tools: Number(catalog?.["executor.discovery.tools"]),
    rows: new Map(
      rows.map((span) => [span.tags["executor.app.id"], span.tags["executor.search.rows"]]),
    ),
    listed: new Map(
      named("sdk.tools.listing").map((span) => [
        span.tags["executor.app.id"],
        span.tags["executor.declarations.cache"],
      ]),
    ),
    evaluated:
      named("sdk.tools.listing.evaluate").length + named("sdk.tools.searchable.cold-fill").length,
    evaluations: named("sdk.tools.listing.evaluate").length,
    stopped: spans.some((span) => span.tags["executor.discovery.stopped"] !== undefined),
    statements: named("sql.execute").length,
  };
};
const discoveryWaitMs = 10_000;
const searchBoundMs = discoveryWaitMs + catalogSearchBoundMs;

const slowListingMs = 20_000;
const reportedBoundMs = discoveryWaitMs / 4;
const listingLoadMs = 45_000;

const heldCatalog = Effect.acquireRelease(
  Effect.callback<{
    server: ReturnType<typeof createHttpServer>;
    requests: { count: number };
    recover: () => void;
    stall: () => void;
  }>((resume) => {
    const requests = { count: 0 };
    let healthy = false;
    const held = new Set<import("node:http").ServerResponse>();
    const answer = (response: import("node:http").ServerResponse) => {
      if (response.writableEnded || response.destroyed) return;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(["alpha", "beta", "gamma"]));
    };
    const server = createHttpServer((request, response) => {
      requests.count += 1;
      if (healthy) return answer(response);
      held.add(response);
      request.on("close", () => held.delete(response));
    });
    const recover = () => {
      healthy = true;
      for (const response of held) answer(response);
      held.clear();
    };
    const stall = () => {
      healthy = false;
    };
    server.listen(0, "127.0.0.1", () =>
      resume(Effect.succeed({ server, requests, recover, stall })),
    );
  }),
  ({ server }) =>
    Effect.callback<void>((resume) => {
      server.closeAllConnections();
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.flatMap(({ server, requests, recover, stall }) => {
    const address = server.address();
    return address !== null && typeof address === "object"
      ? Effect.succeed({
          url: `http://127.0.0.1:${address.port}/catalog`,
          requests,
          recover,
          stall,
        })
      : Effect.die(new Error("Held catalog requires a TCP listener"));
  }),
);

const slowCatalog = Effect.acquireRelease(
  Effect.callback<{ server: ReturnType<typeof createHttpServer>; requests: { count: number } }>(
    (resume) => {
      const requests = { count: 0 };
      const server = createHttpServer((request, response) => {
        requests.count += 1;
        const timer = setTimeout(() => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(["alpha", "beta", "gamma"]));
        }, slowListingMs);
        request.on("close", () => clearTimeout(timer));
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ server, requests })));
    },
  ),
  ({ server }) =>
    Effect.callback<void>((resume) => {
      server.closeAllConnections();
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.flatMap(({ server, requests }) => {
    const address = server.address();
    return address !== null && typeof address === "object"
      ? Effect.succeed({ url: `http://127.0.0.1:${address.port}/catalog`, requests })
      : Effect.die(new Error("Slow catalog requires a TCP listener"));
  }),
);

const slowAppSource = (
  url: string,
  marker = "zqslowq",
) => `import { defineApp, query, object, router } from "apps";
export default defineApp({}, async (ctx) => {
  const response = await ctx.fetch(${JSON.stringify(url)}, { signal: ctx.signal });
  const names = await response.json();
  return { tools: router(Object.fromEntries(names.map((name) => [name, query(
    { description: "Slow catalog tool " + name + " (marker ${marker}).", input: object({}) },
    async () => name,
  )]))) };
});`;

const switchedCatalog = Effect.acquireRelease(
  Effect.callback<{
    server: ReturnType<typeof createHttpServer>;
    requests: { count: number };
    health: { healthy: boolean };
  }>((resume) => {
    const requests = { count: 0 };
    const health = { healthy: true };
    const server = createHttpServer((_request, response) => {
      requests.count += 1;
      response.writeHead(health.healthy ? 200 : 503, { "content-type": "application/json" });
      response.end(JSON.stringify(health.healthy ? ["alpha", "beta", "gamma"] : { error: "down" }));
    });
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ server, requests, health })));
  }),
  ({ server }) =>
    Effect.callback<void>((resume) => {
      server.closeAllConnections();
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.flatMap(({ server, requests, health }) => {
    const address = server.address();
    return address !== null && typeof address === "object"
      ? Effect.succeed({
          url: `http://127.0.0.1:${address.port}/catalog`,
          requests,
          fail: () => {
            health.healthy = false;
          },
          recover: () => {
            health.healthy = true;
          },
        })
      : Effect.die(new Error("Switched catalog requires a TCP listener"));
  }),
);

const switchedAppSource = (url: string) => `import { defineApp, query, object, router } from "apps";
export default defineApp({}, async (ctx) => {
  const response = await ctx.fetch(${JSON.stringify(url)}, { signal: ctx.signal });
  if (!response.ok) throw new Error("Catalog upstream answered " + response.status);
  const names = await response.json();
  return { tools: router(Object.fromEntries(names.map((name) => [name, query(
    { description: "Switched catalog tool " + name + " (marker zqrenewq).", input: object({}) },
    async () => name,
  )]))) };
});`;

const sleepingAppSource = (
  sleepMs: number,
  marker: string,
) => `import { defineApp, query, object, router } from "apps";
export default defineApp({}, async () => {
  const evaluation = crypto.randomUUID();
  await new Promise((resolve) => setTimeout(resolve, ${sleepMs}));
  return { tools: router(Object.fromEntries(["alpha", "beta", "gamma"].map((name) => [name, query(
    { description: "Sleeping tool " + name + " from evaluation " + evaluation + " (marker ${marker}).", input: object({}) },
    async () => name,
  )]))) };
});`;
const agedListingMs = 12_000;
const listingRenewMs = 86_400_000;
const cloudBackgroundMs = 20_000;
const cloudReportedBoundMs = discoveryWaitMs / 2;
const rememberedTimeout = "a later listing finishes";
const stuckListingMs = 120_000;

const probeAppSource = (
  version: string,
) => `import { defineApp, defineProvider, secrets, query, object, string, router } from "apps";
const service = defineProvider({ name: "Listing fixture", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { service } } }, async (ctx) => {
  const evaluation = crypto.randomUUID();
  return { tools: router({ probe: query(
    { description: "Listing probe ${version} token " + ctx.user.accounts.service.fields.token + " evaluation " + evaluation + ".", input: object({}) },
    async () => evaluation,
  ) }) };
});`;

const SearchDescriptions = Schema.Struct({
  items: Schema.Array(Schema.Struct({ path: Schema.String, description: Schema.String })),
});

const connectActor = (actor: Session, label: string, organization: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const mcp = yield* McpClient;
    const key = yield* body(
      Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
      yield* api.request(actor, "POST", "/api/auth/api-key/create", { name: label }),
    );
    yield* Effect.addFinalizer(() =>
      api.request(actor, "POST", "/api/auth/api-key/delete", { keyId: key.id }).pipe(Effect.orDie),
    );
    const client = yield* mcp.connect(key.key, label, { organization });
    return (step: string, code: string) =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const result = yield* client.use(step, (client, signal) =>
          client.callTool({ name: "execute", arguments: { code } }, undefined, {
            signal,
            timeout: 55_000,
          }),
        );
        const elapsed = (yield* Clock.currentTimeMillis) - started;
        yield* Console.log(JSON.stringify({ step, elapsed }));
        return {
          elapsed,
          completed: yield* Schema.decodeUnknownEffect(Completed)(result.structuredContent),
        };
      });
  });

const catalogCase = (indexes: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      mcp = yield* McpClient,
      evidence = yield* Evidence;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const key = yield* body(
      Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
      yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
        name: "Catalog scale",
      }),
    );
    yield* Effect.addFinalizer(() =>
      api
        .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
        .pipe(Effect.orDie),
    );
    const deploy = (name: string, files: ReadonlyArray<{ path: string; content: string }>) =>
      Effect.gen(function* () {
        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name,
          files: files.some((file) => file.path === "package.json")
            ? files
            : [...files, appsManifest],
        });
        expect(response.status).toBe(200);
        return yield* body(App, response);
      });
    const run = randomUUID().slice(0, 8);
    const deployStarted = yield* Clock.currentTimeMillis;
    const apps = yield* Effect.forEach(
      indexes,
      (index) =>
        deploy(`Scale ${String(index).padStart(2, "0")} ${run}`, [
          {
            path: "index.ts",
            content: scaleAppSource(index, index === largeApp ? largeAppTools : toolsPerApp),
          },
        ]),
      { concurrency: 4 },
    );
    const deployMs = (yield* Clock.currentTimeMillis) - deployStarted;
    const client = yield* mcp.connect(key.key, "catalog-scale", {
      organization: actors.organization.id,
    });
    const telemetry = yield* Telemetry;
    const samples: Array<{ label: string; elapsed: number }> = [];
    const searches: Array<{ label: string; apps: number; statements: number }> = [];
    const execute = (label: string, code: string) =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const result = yield* client.use(label, (client, signal) =>
          client.callTool({ name: "execute", arguments: { code } }, undefined, {
            signal,
            timeout: 55_000,
          }),
        );
        const elapsed = (yield* Clock.currentTimeMillis) - started;
        samples.push({ label, elapsed });
        yield* evidence.json("catalog-scale.json", { deployMs, samples, searches });
        yield* Console.log(JSON.stringify({ label, elapsed }));
        const request = (yield* evidence.requests).filter((entry) => entry.path === "/mcp").at(-1);
        if (request === undefined) return yield* Effect.die(new Error("Missing MCP request"));
        return {
          elapsed,
          traceId: request.traceId,
          completed: yield* Schema.decodeUnknownEffect(Completed)(result.structuredContent),
        };
      });
    const workOf = (label: string, traceId: string) =>
      telemetry
        .settled(traceId, (spans) => {
          const work = searchWork(spans);
          return (
            work.apps > 0 &&
            work.rows.size === work.apps &&
            spans.some((span) => span.operationName === "mcp.execute")
          );
        })
        .pipe(
          Effect.map(searchWork),
          Effect.tap((work) =>
            Effect.gen(function* () {
              const counted = { label, apps: work.apps, statements: work.statements };
              searches.push(counted);
              yield* evidence.json("catalog-scale.json", { deployMs, samples, searches });
              yield* Console.log(JSON.stringify(counted));
            }),
          ),
        );
    const loadsOnly = (
      label: string,
      traceId: string,
      reached: ReadonlyArray<{ readonly id: string }>,
      statements: number,
    ) =>
      Effect.gen(function* () {
        const work = searchWork(
          yield* telemetry.settled(traceId, (spans) =>
            spans.some((span) => span.operationName === "mcp.execute"),
          ),
        );
        const counted = {
          label,
          apps: work.apps,
          reachable: work.reachable,
          tools: work.tools,
          listed: work.listed.size,
          evaluated: work.evaluated,
          statements: work.statements,
        };
        searches.push(counted);
        yield* evidence.json("catalog-scale.json", { deployMs, samples, searches });
        yield* Console.log(JSON.stringify(counted));
        expect(work.apps, `${label}: apps in the catalog`).toBeGreaterThan(apps.length);
        expect(work.reachable, `${label}: apps discovery reached`).toBe(reached.length);
        expect(work.tools, `${label}: tools discovery loaded`).toBe(reached.length * toolsPerApp);
        expect([...work.listed.keys()], `${label}: apps listed`).toEqual(
          reached.map((app) => app.id),
        );
        expect(work.evaluated, `${label}: listings evaluated`).toBeLessThanOrEqual(reached.length);
        expect(work.statements, `${label}: SQL statements`).toBeLessThanOrEqual(
          statements + statementMargin,
        );
      });
    const checks: Array<Fiber.Fiber<void, TraceUnsettled | TelemetryUnavailable>> = [];
    const check = (effect: Effect.Effect<void, TraceUnsettled | TelemetryUnavailable>) =>
      Effect.forkChild(effect).pipe(Effect.map((fiber) => void checks.push(fiber)));
    const joinChecks = Effect.gen(function* () {
      for (const fiber of checks.splice(0)) yield* Fiber.join(fiber);
    });
    const at = (index: number) => apps[indexes.indexOf(index)]!;
    const target = at(17);
    const call = `return await tools[${JSON.stringify(target.slug)}].op123({ path: { id: "rec_1" } });`;
    const large = at(largeApp);
    const needle = `const small = await tools.search({ query: "zq17x123q" });
const large = await tools.search({ query: "zq${largeApp}x999q" });
return { items: [...small.items, ...large.items] };`;
    const found = [
      `tools[${JSON.stringify(target.slug)}].op123`,
      `tools[${JSON.stringify(large.slug)}].op999`,
    ];
    return {
      apps,
      target,
      call,
      needle,
      found,
      run,
      deploy,
      execute,
      workOf,
      loadsOnly,
      check,
      joinChecks,
    };
  });

layer(HostedLive, { excludeTestServices: true })("MCP catalog scale", (it) => {
  it.effect(scenarios.mcpCatalogScale.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const catalog = yield* catalogCase(
          Array.from({ length: appCount + 1 }, (_, index) => index),
        );
        const { apps, target, call, needle, found, execute, workOf, loadsOnly, check } = catalog;

        for (const attempt of [1, 2, 3]) {
          const trivial = yield* execute(`return 1 (${attempt})`, "return 1;");
          expect(trivial.completed.execution).toMatchObject({ ok: true, value: 1 });
          yield* check(loadsOnly(`return 1 (${attempt})`, trivial.traceId, [], noAppStatements));
        }
        const called = yield* execute("Call one tool", call);
        expect(called.completed.execution).toMatchObject({
          ok: true,
          value: { app: 17, tool: 123, id: "rec_1" },
        });
        yield* check(loadsOnly("Call one tool", called.traceId, [target], oneAppStatements));
        yield* catalog.joinChecks;
        const machineBefore = yield* machineWork;
        const searchedAll = yield* execute("Search the whole catalog", needle);
        const machineAfter = yield* machineWork;
        expect(searchedAll.completed.execution.ok).toBe(true);
        expectNoneUnavailable("Search the whole catalog", searchedAll.completed, apps);
        expect(
          (yield* Schema.decodeUnknownEffect(SearchValue)(searchedAll.completed.execution.value))
            .items,
        ).toMatchObject(found.map((path) => ({ path })));
        yield* check(
          Effect.gen(function* () {
            const cold = yield* workOf("Search the whole catalog", searchedAll.traceId);
            for (const app of apps)
              expect(cold.listed.has(app.id), app.slug).toBe(app.id !== target.id);
            expect(cold.evaluations, "listings evaluated").toBe(cold.listed.size);
          }),
        );
        const evidence = yield* Evidence;
        const machine = Math.max(machineBefore, machineAfter);
        const allowed = catalogSearchBoundMs * Math.max(1, machine / referenceMachineWorkMs);
        yield* evidence.measure("Search the whole catalog", searchedAll.elapsed);
        yield* evidence.measure("Call one tool", called.elapsed);
        yield* evidence.measure("Machine work before the search", machineBefore);
        yield* evidence.measure("Machine work after the search", machineAfter);
        yield* Console.log(
          JSON.stringify({
            label: "Search the whole catalog, calibrated",
            elapsed: searchedAll.elapsed,
            machine,
            reference: referenceMachineWorkMs,
            calibrated: Math.round((searchedAll.elapsed * referenceMachineWorkMs) / machine),
            allowed: Math.round(allowed),
          }),
        );
        expect(
          searchedAll.elapsed,
          `Search the whole catalog took ${searchedAll.elapsed} ms; the machine work took ${machine} ms against the reference's ${referenceMachineWorkMs} ms, so it was allowed ${Math.round(allowed)} ms`,
        ).toBeLessThan(allowed);
        expect(
          searchedAll.elapsed / called.elapsed,
          `Search the whole catalog took ${searchedAll.elapsed} ms, Call one tool ${called.elapsed} ms`,
        ).toBeLessThan(catalogSearchPerCall);
        const warm = yield* Effect.forEach([1, 2, 3], (attempt) =>
          Effect.gen(function* () {
            const label = `Search the whole catalog again (${attempt})`;
            const searched = yield* execute(label, needle);
            expect(searched.completed.execution.ok).toBe(true);
            expectNoneUnavailable(label, searched.completed, apps);
            expect(
              (yield* Schema.decodeUnknownEffect(SearchValue)(searched.completed.execution.value))
                .items,
            ).toMatchObject(found.map((path) => ({ path })));
            expect(searched.elapsed).toBeLessThan(repeatedSearchBoundMs);
            return { label, traceId: searched.traceId };
          }),
        );
        yield* Effect.forEach(
          warm,
          ({ label, traceId }) =>
            Effect.gen(function* () {
              const work = yield* workOf(label, traceId);
              for (const app of apps) expect(work.rows.get(app.id), app.slug).toBe("kept");
              expect([...work.rows.values()].filter((rows) => rows !== "kept")).toEqual([]);
              expect(work.listed.size).toBe(0);
              expect(work.evaluated).toBe(0);
              expect(work.statements).toBeLessThanOrEqual(
                statementsPerApp * work.apps + statementsPerSearch + statementMargin,
              );
            }),
          { concurrency: "unbounded", discard: true },
        );
        yield* catalog.joinChecks;
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.mcpCatalogStalledApps.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const catalog = yield* catalogCase([17, largeApp]);
        const { apps, target, call, needle, found, execute, workOf, loadsOnly, check } = catalog;
        const first = yield* execute("Search the catalog", needle);
        expect(first.completed.execution.ok).toBe(true);
        expect(first.completed.unavailableApps).toEqual([]);

        const origin = yield* stalledServer;
        const stalled = yield* Effect.forEach(
          Array.from({ length: stalledApps }, (_, index) => index),
          (index) =>
            Effect.gen(function* () {
              const app = yield* catalog.deploy(`Offline MCP ${index} ${catalog.run}`, [
                {
                  path: "package.json",
                  content: JSON.stringify({
                    dependencies: withApps({ "@modelcontextprotocol/sdk": mcpSdkVersion }),
                  }),
                },
                { path: "index.ts", content: stalledAppSource(origin) },
              ]);
              return app.id;
            }),
          { concurrency: 4 },
        );

        const unaffected = yield* execute("return 1 beside stalled apps", "return 1;");
        expect(unaffected.completed.execution).toMatchObject({ ok: true, value: 1 });
        yield* check(
          loadsOnly("return 1 beside stalled apps", unaffected.traceId, [], noAppStatements),
        );
        const calledAgain = yield* execute("Call one tool beside stalled apps", call);
        expect(calledAgain.completed.execution).toMatchObject({ ok: true });
        yield* check(
          loadsOnly(
            "Call one tool beside stalled apps",
            calledAgain.traceId,
            [target],
            oneAppStatements,
          ),
        );
        yield* catalog.joinChecks;

        const searched = yield* execute("Search the whole catalog beside stalled apps", needle);
        expect(searched.completed.execution.ok).toBe(true);
        const items = (yield* Schema.decodeUnknownEffect(SearchValue)(
          searched.completed.execution.value,
        )).items;
        expect(items.map((item) => item.path)).toEqual(found);
        expect(items[0]!.input).toContain("field_10");
        const unavailable = searched.completed.unavailableApps;
        expect(new Set(unavailable.map((entry) => entry.app))).toEqual(new Set(stalled));
        for (const entry of unavailable) expect(entry.reason).toContain("timed out");
        expect(searched.elapsed).toBeGreaterThanOrEqual(discoveryWaitMs - 1_000);
        expect(searched.elapsed).toBeLessThan(searchBoundMs);

        const again = yield* Effect.forEach([1, 2], (attempt) =>
          Effect.gen(function* () {
            const label = `Search the whole catalog beside stalled apps again (${attempt})`;
            const result = yield* execute(label, needle);
            expect(result.completed.execution.ok).toBe(true);
            expect(
              (yield* Schema.decodeUnknownEffect(SearchValue)(
                result.completed.execution.value,
              )).items.map((item) => item.path),
            ).toEqual(found);
            const reported = result.completed.unavailableApps;
            expect(new Set(reported.map((entry) => entry.app))).toEqual(new Set(stalled));
            for (const entry of reported) expect(entry.reason).toContain("timed out");
            expect(result.elapsed).toBeLessThan(repeatedSearchBoundMs);
            return { label, traceId: result.traceId };
          }),
        );
        yield* Effect.forEach(
          again,
          ({ label, traceId }) =>
            Effect.gen(function* () {
              const work = yield* workOf(label, traceId);
              for (const app of apps) expect(work.rows.get(app.id), app.slug).toBe("kept");
              expect(Object.fromEntries(work.listed)).toEqual(
                Object.fromEntries(stalled.map((app) => [app, "running"])),
              );
              expect(work.stopped).toBe(false);
              expect(work.evaluated).toBe(0);
              expect(work.statements).toBeLessThanOrEqual(
                statementsPerApp * work.apps +
                  work.listed.size +
                  statementsPerSearch +
                  statementMargin,
              );
            }),
          { concurrency: "unbounded", discard: true },
        );
        yield* catalog.joinChecks;
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.mcpSlowListing.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const upstream = yield* slowCatalog;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Slow catalog ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: slowAppSource(upstream.url) }, appsManifest],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const execute = yield* connectActor(actors.owner, "Slow listing", actors.organization.id);
        const search = `return await tools.search({ query: "zqslowq" });`;
        const paths = (value: unknown) =>
          Schema.decodeUnknownEffect(SearchValue)(value).pipe(
            Effect.map(({ items }) => items.map((item) => item.path).sort()),
          );
        const tools = ["alpha", "beta", "gamma"].map(
          (name) => `tools[${JSON.stringify(app.slug)}].${name}`,
        );

        const first = yield* execute("Search beside a slow app", search);
        expect(first.completed.execution.ok).toBe(true);
        expect(first.completed.unavailableApps.map((entry) => entry.app)).toEqual([app.id]);
        expect(first.completed.unavailableApps[0]!.reason).toContain("timed out");
        expect(first.elapsed).toBeGreaterThanOrEqual(discoveryWaitMs - 1_000);
        expect(upstream.requests.count).toBe(1);

        const loaded = yield* Effect.gen(function* () {
          const polled = yield* execute("Search while the slow listing runs", search);
          expect(polled.completed.execution.ok).toBe(true);
          expect(polled.elapsed).toBeLessThan(reportedBoundMs);
          if (polled.completed.unavailableApps.length === 0) return polled;
          expect(polled.completed.unavailableApps.map((entry) => entry.app)).toEqual([app.id]);
          expect(polled.completed.unavailableApps[0]!.reason).toContain("timed out");
          return yield* Effect.fail("still loading" as const);
        }).pipe(
          Effect.retry({
            schedule: Schedule.spaced("500 millis"),
            while: (error) => error === "still loading",
            times: 60,
          }),
        );
        expect(yield* paths(loaded.completed.execution.value)).toEqual(tools);
        expect(upstream.requests.count).toBe(1);

        for (const attempt of [1, 2]) {
          const again = yield* execute(`Search the slow app again (${attempt})`, search);
          expect(again.completed.unavailableApps).toEqual([]);
          expect(yield* paths(again.completed.execution.value)).toEqual(tools);
          expect(again.elapsed).toBeLessThan(reportedBoundMs);
        }
        expect(upstream.requests.count).toBe(1);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(
    scenarios.mcpAgedSearchRows.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Aged catalog ${randomUUID().slice(0, 8)}`,
            files: [
              { path: "index.ts", content: sleepingAppSource(agedListingMs, "zqagedq") },
              appsManifest,
            ],
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const app = yield* body(App, deployed);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
          );
          const execute = yield* connectActor(actors.owner, "Aged rows", actors.organization.id);
          const search = `return await tools.search({ query: "zqagedq" });`;
          const tools = ["alpha", "beta", "gamma"].map(
            (name) => `tools[${JSON.stringify(app.slug)}].${name}`,
          );
          const listed = (value: unknown) =>
            Schema.decodeUnknownEffect(SearchDescriptions)(value).pipe(
              Effect.map(({ items }) => ({
                paths: items.map((item) => item.path).sort(),
                evaluations: [
                  ...new Set(
                    items.map((item) => /evaluation ([0-9a-f-]{36})/.exec(item.description)?.[1]),
                  ),
                ],
              })),
            );
          const found = (step: string) =>
            Effect.gen(function* () {
              const result = yield* execute(step, search);
              expect(result.completed.execution.ok, step).toBe(true);
              expect(result.completed.unavailableApps, step).toEqual([]);
              expect(result.elapsed, step).toBeLessThan(reportedBoundMs);
              const read = yield* listed(result.completed.execution.value);
              expect(read.paths, step).toEqual(tools);
              expect(read.evaluations, step).toHaveLength(1);
              return read.evaluations[0]!;
            });

          const began = yield* Clock.currentTimeMillis;
          const first = yield* execute("Search an app with no rows", search);
          expect(first.completed.unavailableApps.map((entry) => entry.app)).toEqual([app.id]);
          expect(first.completed.unavailableApps[0]!.reason).toContain("AppDiscoveryTimedOut");
          const kept = yield* Effect.gen(function* () {
            const polled = yield* execute("Search while the first listing runs", search);
            expect(polled.elapsed).toBeLessThan(reportedBoundMs);
            if (polled.completed.unavailableApps.length > 0)
              return yield* Effect.fail("still loading" as const);
            return yield* found("Search once the first listing finishes");
          }).pipe(
            Effect.retry({
              schedule: Schedule.spaced("1 second"),
              while: (error) => error === "still loading",
              times: 30,
            }),
          );

          const aged = began + agedRowsRenewSeconds * 1_000 + 2_000;
          yield* Effect.sleep(Math.max(0, aged - (yield* Clock.currentTimeMillis)));

          expect(yield* found("Search aged rows")).toBe(kept);
          const renewed = yield* Effect.gen(function* () {
            const read = yield* found("Search while the aged rows are renewed");
            if (read !== kept) return read;
            return yield* Effect.fail("still aged" as const);
          }).pipe(
            Effect.retry({
              schedule: Schedule.spaced("1 second"),
              while: (error) => error === "still aged",
              times: 30,
            }),
          );
          for (const attempt of [1, 2])
            expect(yield* found(`Search the renewed rows (${attempt})`)).toBe(renewed);
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 150_000 },
  );

  it.effect(
    scenarios.mcpAgedRowsFailedRenewal.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors;
          const catalog = yield* switchedCatalog;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Unrenewed catalog ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: switchedAppSource(catalog.url) }, appsManifest],
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const app = yield* body(App, deployed);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
          );
          const execute = yield* connectActor(
            actors.owner,
            "Unrenewed rows",
            actors.organization.id,
          );
          const search = `return await tools.search({ query: "zqrenewq" });`;
          const tools = ["alpha", "beta", "gamma"].map(
            (name) => `tools[${JSON.stringify(app.slug)}].${name}`,
          );
          const paths = (value: unknown) =>
            Schema.decodeUnknownEffect(SearchDescriptions)(value).pipe(
              Effect.map(({ items }) => items.map((item) => item.path).sort()),
            );
          const found = (step: string) =>
            Effect.gen(function* () {
              const result = yield* execute(step, search);
              expect(result.completed.execution.ok, step).toBe(true);
              expect(result.completed.unavailableApps, step).toEqual([]);
              expect(yield* paths(result.completed.execution.value), step).toEqual(tools);
            });
          const stale = (step: string) =>
            Effect.gen(function* () {
              const result = yield* execute(step, search);
              expect(result.completed.execution.ok, step).toBe(true);
              expect(result.elapsed, step).toBeLessThan(reportedBoundMs);
              expect(yield* paths(result.completed.execution.value), step).toEqual(tools);
              expect(
                result.completed.unavailableApps.map((entry) => entry.app),
                step,
              ).toEqual([app.id]);
              const reason = result.completed.unavailableApps[0]!.reason;
              expect(reason, step).toContain("ToolSearchStale");
              expect(reason, step).toContain("Catalog upstream answered 503");
            });

          yield* Effect.gen(function* () {
            const result = yield* execute("Search an app with no rows", search);
            if (result.completed.unavailableApps.length > 0)
              return yield* Effect.fail("still loading" as const);
            return yield* found("Search once the first listing finishes");
          }).pipe(
            Effect.retry({
              schedule: Schedule.spaced("1 second"),
              while: (error) => error === "still loading",
              times: 30,
            }),
          );

          catalog.fail();
          yield* Effect.sleep(agedRowsRenewSeconds * 1_000 + 2_000);

          const before = catalog.requests.count;
          yield* found("Search aged rows");
          yield* Effect.gen(function* () {
            const result = yield* execute("Search after the renewal of aged rows", search);
            if (result.completed.unavailableApps.length === 0)
              return yield* Effect.fail("not yet reported" as const);
          }).pipe(
            Effect.retry({
              schedule: Schedule.spaced("1 second"),
              while: (error) => error === "not yet reported",
              times: 10,
            }),
          );
          expect(catalog.requests.count).toBe(before + 1);
          for (const attempt of [1, 2])
            yield* stale(`Search while the upstream fails (${attempt})`);
          expect(catalog.requests.count).toBe(before + 1);

          catalog.recover();
          yield* Effect.gen(function* () {
            const result = yield* execute("Search after the upstream recovers", search);
            expect(yield* paths(result.completed.execution.value)).toEqual(tools);
            if (result.completed.unavailableApps.length > 0)
              return yield* Effect.fail("still stale" as const);
          }).pipe(
            Effect.retry({
              schedule: Schedule.spaced("2 seconds"),
              while: (error) => error === "still stale",
              times: 30,
            }),
          );
          for (const attempt of [1, 2]) yield* found(`Search the renewed rows (${attempt})`);
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 180_000 },
  );

  it.effect(
    scenarios.mcpBackgroundListingCloud.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Sleeping catalog ${randomUUID().slice(0, 8)}`,
            files: [
              { path: "index.ts", content: sleepingAppSource(slowListingMs, "zqsleepq") },
              appsManifest,
            ],
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const app = yield* body(App, deployed);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
          );
          const execute = yield* connectActor(
            actors.owner,
            "Background listing",
            actors.organization.id,
          );
          const search = `return await tools.search({ query: "zqsleepq" });`;
          const tools = ["alpha", "beta", "gamma"].map(
            (name) => `tools[${JSON.stringify(app.slug)}].${name}`,
          );
          const listed = (value: unknown) =>
            Schema.decodeUnknownEffect(SearchDescriptions)(value).pipe(
              Effect.map(({ items }) => ({
                paths: items.map((item) => item.path).sort(),
                evaluations: [
                  ...new Set(
                    items.map((item) => /evaluation ([0-9a-f-]{36})/.exec(item.description)?.[1]),
                  ),
                ],
              })),
            );

          const first = yield* execute("Search beside a slow evaluation", search);
          const returned = yield* Clock.currentTimeMillis;
          expect(first.completed.execution.ok).toBe(true);
          expect(first.completed.unavailableApps.map((entry) => entry.app)).toEqual([app.id]);
          expect(first.completed.unavailableApps[0]!.reason).toContain("AppDiscoveryTimedOut");
          expect(first.elapsed).toBeGreaterThanOrEqual(discoveryWaitMs - 1_000);

          const loaded = yield* Effect.gen(function* () {
            const polled = yield* execute("Search while the background listing runs", search);
            expect(polled.completed.execution.ok).toBe(true);
            expect(polled.elapsed).toBeLessThan(cloudReportedBoundMs);
            if (polled.completed.unavailableApps.length === 0) return polled;
            expect(polled.completed.unavailableApps.map((entry) => entry.app)).toEqual([app.id]);
            expect(
              (yield* Clock.currentTimeMillis) - returned,
              "the listing should finish while Cloud keeps the first search's background work",
            ).toBeLessThan(cloudBackgroundMs);
            return yield* Effect.fail("still loading" as const);
          }).pipe(
            Effect.retry({
              schedule: Schedule.spaced("1 second"),
              while: (error) => error === "still loading",
            }),
          );
          const found = yield* listed(loaded.completed.execution.value);
          expect(found.paths).toEqual(tools);
          expect(found.evaluations).toHaveLength(1);

          for (const attempt of [1, 2]) {
            const again = yield* execute(`Search the slow app again (${attempt})`, search);
            expect(again.completed.unavailableApps).toEqual([]);
            expect(yield* listed(again.completed.execution.value)).toEqual(found);
            expect(again.elapsed).toBeLessThan(cloudReportedBoundMs);
          }
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 150_000 },
  );

  it.effect(
    scenarios.mcpStoppedListingCloud.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Stuck catalog ${randomUUID().slice(0, 8)}`,
            files: [
              { path: "index.ts", content: sleepingAppSource(stuckListingMs, "zqstuckq") },
              appsManifest,
            ],
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const app = yield* body(App, deployed);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
          );
          const execute = yield* connectActor(
            actors.owner,
            "Stopped background listing",
            actors.organization.id,
          );
          const search = `return await tools.search({ query: "zqstuckq" });`;
          const reported = (step: string) =>
            Effect.gen(function* () {
              const result = yield* execute(step, search);
              expect(result.completed.execution.ok).toBe(true);
              expect(result.elapsed).toBeLessThan(cloudReportedBoundMs);
              expect(result.completed.unavailableApps.map((entry) => entry.app)).toEqual([app.id]);
              return result.completed.unavailableApps[0]!.reason;
            });

          const began = yield* Clock.currentTimeMillis;
          const first = yield* execute("Search beside a stuck evaluation", search);
          const returned = yield* Clock.currentTimeMillis;
          expect(first.completed.execution.ok).toBe(true);
          expect(first.completed.unavailableApps.map((entry) => entry.app)).toEqual([app.id]);
          expect(first.completed.unavailableApps[0]!.reason).toContain("AppDiscoveryTimedOut");
          expect(first.elapsed).toBeGreaterThanOrEqual(discoveryWaitMs - 1_000);

          yield* Effect.gen(function* () {
            const reason = yield* reported("Search while the stuck listing runs");
            if (reason.includes(rememberedTimeout)) return;
            expect(reason).toContain("has been running for");
            return yield* Effect.fail("still running" as const);
          }).pipe(
            Effect.retry({
              schedule: Schedule.spaced("1 second"),
              while: (error) => error === "still running",
              times: 40,
            }),
          );
          const stopped = yield* Clock.currentTimeMillis;
          expect(stopped - returned).toBeGreaterThanOrEqual(cloudBackgroundMs - 1_000);
          expect(stopped - began).toBeLessThan(listingLoadMs);

          for (const attempt of [1, 2, 3])
            expect(yield* reported(`Search beside the remembered timeout (${attempt})`)).toContain(
              rememberedTimeout,
            );
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 150_000 },
  );

  it.effect(
    scenarios.mcpStoppedRenewalCloud.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const upstream = yield* heldCatalog;
          upstream.recover();
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Stopped renewal ${randomUUID().slice(0, 8)}`,
            files: [
              { path: "index.ts", content: slowAppSource(upstream.url, "zqstoprenewq") },
              appsManifest,
            ],
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const app = yield* body(App, deployed);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
          );
          const execute = yield* connectActor(
            actors.owner,
            "Stopped renewal",
            actors.organization.id,
          );
          const search = `return await tools.search({ query: "zqstoprenewq" });`;
          const tools = ["alpha", "beta", "gamma"].map(
            (name) => `tools[${JSON.stringify(app.slug)}].${name}`,
          );
          const searched = (step: string) =>
            Effect.gen(function* () {
              const result = yield* execute(step, search);
              expect(result.completed.execution.ok, step).toBe(true);
              expect(result.elapsed, step).toBeLessThan(cloudReportedBoundMs);
              const { items } = yield* Schema.decodeUnknownEffect(SearchValue)(
                result.completed.execution.value,
              );
              return {
                paths: items.map((item) => item.path).sort(),
                unavailable: result.completed.unavailableApps,
              };
            });
          const found = (step: string) =>
            Effect.gen(function* () {
              const read = yield* searched(step);
              expect(read.unavailable, step).toEqual([]);
              expect(read.paths, step).toEqual(tools);
            });
          const asked = (count: number) =>
            Effect.gen(function* () {
              if (upstream.requests.count < count) return yield* Effect.fail("not asked" as const);
            }).pipe(
              Effect.retry({
                schedule: Schedule.spaced("100 millis"),
                while: (error) => error === "not asked",
                times: 100,
              }),
            );

          yield* Effect.gen(function* () {
            const result = yield* execute("Search an app with no rows", search);
            if (result.completed.unavailableApps.length > 0)
              return yield* Effect.fail("still loading" as const);
            return yield* found("Search once the first listing finishes");
          }).pipe(
            Effect.retry({
              schedule: Schedule.spaced("1 second"),
              while: (error) => error === "still loading",
              times: 30,
            }),
          );

          const rows = yield* writeRows("sso-database.json", [
            {
              sql: `update executor_tool_search_listings set at = at - ${listingRenewMs + 60_000}
                where app = $1 returning listing`,
              params: [app.id],
            },
          ]).pipe(
            Effect.flatMap((results) =>
              Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ listing: Schema.String })))(
                results[0],
              ),
            ),
          );
          expect(rows).toHaveLength(1);
          expect(yield* expireEvaluated(rows[0]!.listing)).toBeGreaterThan(0);

          upstream.stall();
          const before = upstream.requests.count;
          const renewing = yield* Clock.currentTimeMillis;
          yield* found("Search aged rows");
          yield* asked(before + 1);

          while ((yield* Clock.currentTimeMillis) - renewing < cloudBackgroundMs + 5_000) {
            yield* found("Search while the aged rows are renewed or after Cloud stops it");
            yield* Effect.sleep("2 seconds");
          }
          for (const attempt of [1, 2, 3])
            yield* found(`Search after the stopped renewal (${attempt})`);
          expect(upstream.requests.count).toBe(before + 1);
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 150_000 },
  );

  it.effect(
    scenarios.mcpRememberedListingFailure.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const upstream = yield* heldCatalog;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Stalled catalog ${randomUUID().slice(0, 8)}`,
            files: [
              { path: "index.ts", content: slowAppSource(upstream.url, "zqheldq") },
              appsManifest,
            ],
          });
          expect(deployed.status).toBe(200);
          const app = yield* body(App, deployed);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
          );
          const execute = yield* connectActor(
            actors.owner,
            "Remembered listing failure",
            actors.organization.id,
          );
          const search = `return await tools.search({ query: "zqheldq" });`;
          const reported = (step: string) =>
            Effect.gen(function* () {
              const result = yield* execute(step, search);
              expect(result.completed.execution.ok).toBe(true);
              expect(result.elapsed).toBeLessThan(reportedBoundMs);
              expect(result.completed.unavailableApps.map((entry) => entry.app)).toEqual([app.id]);
              const reason = result.completed.unavailableApps[0]!.reason;
              expect(reason).toContain("timed out");
              return reason;
            });
          const began = yield* Clock.currentTimeMillis;
          const first = yield* execute("Search beside a stalled app", search);
          expect(first.completed.unavailableApps.map((entry) => entry.app)).toEqual([app.id]);
          expect(first.elapsed).toBeGreaterThanOrEqual(discoveryWaitMs - 1_000);
          expect(upstream.requests.count).toBe(1);

          yield* Effect.gen(function* () {
            const reason = yield* reported("Search while the stalled listing runs");
            if (reason.includes(rememberedTimeout)) return;
            expect(upstream.requests.count).toBe(1);
            return yield* Effect.fail("still running" as const);
          }).pipe(
            Effect.retry({
              schedule: Schedule.spaced("1 second"),
              while: (error) => error === "still running",
              times: 90,
            }),
          );
          expect((yield* Clock.currentTimeMillis) - began).toBeGreaterThanOrEqual(
            listingLoadMs - 1_000,
          );

          yield* Effect.gen(function* () {
            if (upstream.requests.count < 2) return yield* Effect.fail("not retried" as const);
          }).pipe(
            Effect.retry({
              schedule: Schedule.spaced("100 millis"),
              while: (error) => error === "not retried",
              times: 50,
            }),
          );
          for (const attempt of [1, 2, 3])
            expect(yield* reported(`Search beside the remembered failure (${attempt})`)).toContain(
              rememberedTimeout,
            );
          expect(upstream.requests.count).toBe(2);

          upstream.recover();
          const found = yield* Effect.gen(function* () {
            const result = yield* execute("Search after the upstream recovers", search);
            expect(result.completed.execution.ok).toBe(true);
            if (result.completed.unavailableApps.length > 0)
              return yield* Effect.fail("not recovered" as const);
            return result;
          }).pipe(
            Effect.retry({
              schedule: Schedule.spaced("200 millis"),
              while: (error) => error === "not recovered",
              times: 25,
            }),
          );
          expect(
            (yield* Schema.decodeUnknownEffect(SearchValue)(found.completed.execution.value)).items
              .map((item) => item.path)
              .sort(),
          ).toEqual(
            ["alpha", "beta", "gamma"].map((name) => `tools[${JSON.stringify(app.slug)}].${name}`),
          );
          expect(upstream.requests.count).toBe(2);
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 150_000 },
  );

  it.effect(scenarios.mcpListingInputs.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Listing inputs ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: probeAppSource("first") }, appsManifest],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/apps/${app.id}`;
        const accounts: Array<{ actor: Session; id: string }> = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", path);
            for (const item of accounts)
              yield* api.request(item.actor, "DELETE", `${prefix}/accounts/${item.id}`);
          }).pipe(Effect.orDie),
        );
        const Access = Schema.Struct({ revision: Schema.String });
        const access = yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${path}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        const submit = (actor: Session, connection: string, token: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(
              actor,
              "POST",
              `${prefix}/connections/${connection}/submit`,
              { method: "key", label: `Account ${token}`, fields: { token } },
            );
            expect(response.status).toBe(200);
            return (yield* body(Resource, response)).id;
          });
        const connect = (actor: Session, token: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(
              actor,
              "POST",
              connectionsPath(path, "user", "service"),
              {},
            );
            expect(response.status).toBe(200);
            const account = yield* submit(actor, (yield* body(Resource, response)).id, token);
            accounts.push({ actor, id: account });
            return account;
          });
        const reconnect = (actor: Session, account: string, token: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(
              actor,
              "POST",
              connectionsPath(path, "user", "service"),
              {
                account,
              },
            );
            expect(response.status).toBe(200);
            expect(yield* submit(actor, (yield* body(Resource, response)).id, token)).toBe(account);
          });
        const owner = yield* connectActor(actors.owner, "Owner listings", actors.organization.id);
        const member = yield* connectActor(
          actors.member,
          "Member listings",
          actors.organization.id,
        );
        const probe = (execute: typeof owner, step: string) =>
          Effect.gen(function* () {
            const result = yield* execute(
              step,
              `return await tools.search({ query: "probe", namespace: ${JSON.stringify(app.slug)} });`,
            );
            expect(result.completed.execution.ok).toBe(true);
            expect(result.completed.unavailableApps).toEqual([]);
            const { items } = yield* Schema.decodeUnknownEffect(SearchDescriptions)(
              result.completed.execution.value,
            );
            expect(items).toHaveLength(1);
            const match = / probe (\w+) token (\w+) evaluation ([0-9a-f-]+)\./.exec(
              items[0]!.description,
            );
            expect(match).not.toBeNull();
            const [, version = "", token = "", evaluation = ""] = match ?? [];
            return { version, token, evaluation };
          });
        const evaluated = (
          execute: typeof owner,
          step: string,
          expected: { version: string; token: string },
          previous: ReadonlyArray<string>,
        ) =>
          Effect.gen(function* () {
            const listed = yield* probe(execute, step);
            expect(listed).toMatchObject(expected);
            expect(previous).not.toContain(listed.evaluation);
            expect(yield* probe(execute, `${step}, again`)).toEqual(listed);
            return listed.evaluation;
          });

        const alpha = yield* connect(actors.owner, "alpha");
        const seen: string[] = [];
        seen.push(
          yield* evaluated(owner, "First listing", { version: "first", token: "alpha" }, seen),
        );

        yield* connect(actors.member, "delta");
        const memberEvaluation = yield* evaluated(
          member,
          "Another member's listing",
          { version: "first", token: "delta" },
          seen,
        );
        expect(yield* probe(owner, "The owner's listing is unchanged")).toEqual({
          version: "first",
          token: "alpha",
          evaluation: seen[0],
        });
        seen.push(memberEvaluation);

        const gamma = yield* connect(actors.owner, "gamma");
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([gamma]);
        seen.push(
          yield* evaluated(owner, "Changed links", { version: "first", token: "gamma" }, seen),
        );

        yield* reconnect(actors.owner, gamma, "rotated");
        seen.push(
          yield* evaluated(
            owner,
            "Rotated credential",
            { version: "first", token: "rotated" },
            seen,
          ),
        );

        const redeployed = yield* saveAndDeploy(actors.owner, path, {
          files: [{ path: "index.ts", content: probeAppSource("second") }, appsManifest],
        });
        expect(redeployed.status).toBe(200);
        seen.push(
          yield* evaluated(owner, "New version", { version: "second", token: "rotated" }, seen),
        );
        const memberLatest = yield* evaluated(
          member,
          "New version for the member",
          { version: "second", token: "delta" },
          seen,
        );
        seen.push(memberLatest);

        const Listing = Schema.Struct({
          items: Schema.Array(Schema.Struct({ description: Schema.String })),
        });
        const listing = (actor: Session) => api.request(actor, "GET", `${path}/tools`);
        const listed = (actor: Session) =>
          Effect.gen(function* () {
            const response = yield* listing(actor);
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const { items } = yield* body(Listing, response);
            expect(items).toHaveLength(1);
            const [, version = "", token = "", evaluation = ""] =
              / probe (\w+) token (\w+) evaluation ([0-9a-f-]+)\./.exec(items[0]!.description) ??
              [];
            return { version, token, evaluation };
          });
        const ownerLatest = seen.at(-2)!;
        expect(yield* listed(actors.owner)).toEqual({
          version: "second",
          token: "rotated",
          evaluation: ownerLatest,
        });
        yield* linkAccount(actors.owner, path, "service", alpha);
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([alpha]);
        const relinked = yield* listed(actors.owner);
        expect(relinked).toMatchObject({ version: "second", token: "alpha" });
        expect(seen).not.toContain(relinked.evaluation);
        expect(yield* listed(actors.owner)).toEqual(relinked);
        yield* linkAccount(actors.owner, path, "service", gamma);
        expect((yield* listed(actors.owner)).evaluation).toBe(ownerLatest);

        expect((yield* listed(actors.member)).evaluation).toBe(memberLatest);
        const foreign = yield* linkAccountResponse(actors.member, path, "service", alpha);
        expect(foreign.status, JSON.stringify(foreign.body)).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(foreign.body)).not.toContain(relinked.evaluation);
        expect((yield* listed(actors.member)).evaluation).toBe(memberLatest);

        const revision = (yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${path}/access`),
        )).revision;
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision,
            audience: { kind: "private" },
          })).status,
        ).toBe(200);
        const refused = yield* listing(actors.member);
        expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(refused.body)).not.toContain(memberLatest);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
