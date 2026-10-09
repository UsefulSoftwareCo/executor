/** MCP catalog caching through real app deployment, storage and upstream HTTP boundaries. */
import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Config, Effect, Layer, Option, Schedule, Schema } from "effect";
import {
  HttpRouter,
  HttpClient,
  HttpClientRequest,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { withApps, mcpDependencies } from "../support/apps-release.ts";

const Counters = Schema.Struct({
  initialize: Schema.Number,
  list: Schema.Number,
  call: Schema.Number,
});
const Stats = Schema.Struct({ counters: Counters });
const Wire = Schema.Struct({
  id: Schema.optionalKey(Schema.Json),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});

const fixture = () =>
  Effect.gen(function* () {
    let config = {
      version: 1,
      count: 3000,
      delayMs: 3000,
      fail: false,
      notify: false,
      numeric: false,
    };
    let counters = { initialize: 0, list: 0, call: 0 };
    const routes = Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/_emulate",
        Effect.suspend(() => HttpServerResponse.json({ ...config, counters })),
      ),
      HttpRouter.add(
        "POST",
        "/_emulate",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const input = yield* request.json.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({
                  version: Schema.optionalKey(Schema.Number),
                  count: Schema.optionalKey(Schema.Number),
                  delayMs: Schema.optionalKey(Schema.Number),
                  fail: Schema.optionalKey(Schema.Boolean),
                  notify: Schema.optionalKey(Schema.Boolean),
                  numeric: Schema.optionalKey(Schema.Boolean),
                  resetCounters: Schema.optionalKey(Schema.Boolean),
                }),
              ),
            ),
          );
          config = { ...config, ...input };
          if (input.resetCounters) counters = { initialize: 0, list: 0, call: 0 };
          return yield* HttpServerResponse.json({ ...config, counters });
        }),
      ),
      HttpRouter.add("GET", "/mcp", HttpServerResponse.empty({ status: 405 })),
      HttpRouter.add(
        "POST",
        "/mcp",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const message = yield* request.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Wire)),
          );
          if (message.id === undefined) return HttpServerResponse.empty({ status: 202 });
          const result = (value: Schema.Json) =>
            HttpServerResponse.json({ jsonrpc: "2.0", id: message.id ?? null, result: value });
          if (message.method === "initialize") {
            counters.initialize++;
            return yield* result({
              protocolVersion: "2025-06-18",
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: "Cache fixture", version: "1" },
            });
          }
          // The outbound network must swap a credential handle for the account's real token.
          if (request.headers.authorization?.includes("exsec_"))
            return HttpServerResponse.empty({ status: 401 });
          const variant = request.headers["x-fixture-variant"];
          const prefix = variant ? `${variant}_` : "";
          if (message.method === "tools/list") {
            counters.list++;
            if (config.fail) return HttpServerResponse.empty({ status: 503 });
            yield* Effect.sleep(config.delayMs);
            return yield* result({
              tools: Array.from({ length: config.count }, (_, index) => ({
                name:
                  prefix +
                  (index === config.count - 1
                    ? `revision_${config.version}`
                    : `fixture_${String(index).padStart(4, "0")}`),
                description: `Synthetic tool ${index}, revision ${config.version}`,
                inputSchema: {
                  type: "object",
                  properties: { message: { type: config.numeric ? "number" : "string" } },
                  additionalProperties: false,
                },
                annotations: { readOnlyHint: true },
              })),
            });
          }
          if (message.method === "tools/call") {
            counters.call++;
            const value = {
              tool: message.params?.name ?? null,
              version: config.version,
              variant: variant ?? "default",
            };
            const response = {
              content: [{ type: "text", text: JSON.stringify(value) }],
              structuredContent: value,
              isError: false,
            };
            if (config.notify) {
              config.notify = false;
              return HttpServerResponse.text(
                `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: response })}\n\n`,
                { contentType: "text/event-stream" },
              );
            }
            return yield* result(response);
          }
          return yield* result({});
        }),
      ),
    );
    const services = yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      ),
    );
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address)) return yield* Effect.die("Expected TCP fixture");
    return `http://127.0.0.1:${server.address.port}`;
  });

const control = (origin: string, data?: Schema.Json) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request =
      data === undefined
        ? HttpClientRequest.get(`${origin}/_emulate`)
        : yield* HttpClientRequest.bodyJson(HttpClientRequest.post(`${origin}/_emulate`), data);
    const response = yield* client.execute(request);
    expect(response.status).toBe(200);
    return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Stats)));
  });

const source = (url: string, cached: boolean, accounts: boolean, unbound = false) => [
  {
    path: "package.json",
    content: JSON.stringify({
      dependencies: withApps(mcpDependencies),
    }),
  },
  {
    path: "index.ts",
    content: `
import { defineApp, defineProvider, accountRouter, secrets, object, plain, string, query, router } from "apps";
import { mcpRouter } from "apps/mcp";
// Declared hosts give app code a fresh token handle on every call; the account's catalog must still hit.
const provider = defineProvider({ name: "Cache fixture", hosts: ${JSON.stringify([new URL(url).host])}, auth: { key: secrets({ label: "Variant", fields: object({ variant: plain(string()), token: string() }) }) } });
export default defineApp({ accounts: ${accounts ? "{ service: provider.many() }" : "{}"} }, async ctx => {
  const options = account => ({ url: ${JSON.stringify(url)}, signal: ctx.signal,
    ${cached ? "cache: ctx.cache," : ""}
    ${unbound ? 'headers: { Authorization: "Bearer unbound" },' : ""}
    ...(account ? { account, headers: { "X-Fixture-Variant": account.fields.variant, Authorization: "Bearer " + account.fields.token } } : {}),
  });
  const tools = ${accounts ? "await accountRouter(ctx.accounts.service, account => mcpRouter(options(account)), { signal: ctx.signal })" : "await mcpRouter(options(undefined))"};
  return { tools: router({
    upstream: tools,
    refresh: query({ input: object({ id: string() }) }, async (_, { id }) => {
      const account = ${accounts ? "ctx.accounts.service.find(account => account.id === id)" : "undefined"};
      ${accounts ? 'if (!account) throw new Error("Missing account");' : ""}
      await mcpRouter({ ...options(account), revalidate: true }); return true;
    }),
  }) };
});`,
  },
];

const deploy = (url: string, cached: boolean, accounts = false, unbound = false) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const actors = yield* Actors;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: `MCP cache ${randomUUID().slice(0, 8)}`,
      files: source(url, cached, accounts, unbound),
    });
    expect(response.status).toBe(200);
    const id = (yield* body(App, response)).id;
    const path = `${prefix}/apps/${id}`;
    yield* Effect.addFinalizer(() => api.request(actors.owner, "DELETE", path).pipe(Effect.orDie));
    const profile = yield* createProfile(actors.owner, path);
    // The server's tools are mounted under "upstream" beside the app's own refresh query.
    // Every fixture tool is read-only.
    const call = (name: string, input: Schema.Json = {}, profileId = profile.id) =>
      api.request(actors.owner, "POST", `${path}/tools/call`, {
        profile: profileId,
        tool: name === "refresh" ? name : `upstream.${name}`,
        kind: "query",
        input,
      });
    return { api, actors, id, path, prefix, profile, call };
  });

layer(HostedLive, { excludeTestServices: true })("MCP cache", (it) => {
  it.effect(scenarios.mcpCatalogCache.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const remote = yield* Config.option(Config.String("MCP_CACHE_FIXTURE_ORIGIN"));
        const origin = Option.isSome(remote) ? `${remote.value}/${randomUUID()}` : yield* fixture();
        yield* control(origin, { count: 3000, delayMs: 3000, resetCounters: true });
        const app = yield* deploy(`${origin}/mcp`, true, true);
        yield* selectProfileAccounts(app.actors.owner, app.path, app.profile.id, { service: [] });
        const ids: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(ids, (id) =>
            app.api.request(app.actors.owner, "DELETE", `${app.prefix}/accounts/${id}`),
          ).pipe(Effect.orDie),
        );
        const connect = (variant: string) =>
          Effect.gen(function* () {
            const connection = yield* body(
              Resource,
              yield* app.api.request(app.actors.owner, "POST", `${app.path}/connections`, {
                requirement: "service",
                profile: app.profile.id,
              }),
            );
            const account = yield* body(
              Resource,
              yield* app.api.request(
                app.actors.owner,
                "POST",
                `${app.prefix}/connections/${connection.id}/submit`,
                {
                  method: "key",
                  label: "Synthetic variant",
                  fields: { variant, token: randomUUID() },
                },
              ),
            );
            ids.push(account.id);
            return account.id;
          });
        const alpha = yield* connect("alpha");
        const input = { accountId: alpha, input: {} };
        const measured = (name: string, data: Schema.Json = input) =>
          Effect.gen(function* () {
            const start = performance.now();
            const response = yield* app.call(name, data);
            expect(response.status, name).toBe(200);
            yield* body(Schema.Json, response);
            return performance.now() - start;
          });
        const coldMs = yield* measured("alpha_fixture_0000");
        expect((yield* control(origin)).counters.list).toBe(1);
        const warmMs = yield* Effect.forEach([1, 2, 3], () => measured("alpha_fixture_0000"));
        expect((yield* control(origin)).counters.list).toBe(1);
        const listStart = performance.now();
        const listed = yield* app.api.request(
          app.actors.owner,
          "GET",
          `${app.path}/tools?profile=${app.profile.id}`,
        );
        const listMs = performance.now() - listStart;
        expect(listed.status).toBe(200);
        const page = yield* body(
          Schema.Struct({
            items: Schema.Array(Schema.Struct({ name: Schema.String })),
            next: Schema.optionalKey(Schema.String),
          }),
          listed,
        );
        expect(page.items.length).toBe(2000);
        expect(page.next).toBeDefined();
        expect((yield* control(origin)).counters.list).toBe(1);
        // Browsing reads the whole catalog without schemas, then one tool's schemas.
        const indexStart = performance.now();
        const indexed = yield* app.api.request(
          app.actors.owner,
          "GET",
          `${app.path}/tools/index?profile=${app.profile.id}`,
        );
        const indexMs = performance.now() - indexStart;
        expect(indexed.status).toBe(200);
        const index = yield* body(
          Schema.Struct({ items: Schema.Array(Schema.Record(Schema.String, Schema.Json)) }),
          indexed,
        );
        // Every upstream tool plus the app's declared refresh query.
        expect(index.items.length).toBe(3001);
        expect(index.items.some((tool) => "inputSchema" in tool || "outputSchema" in tool)).toBe(
          false,
        );
        const selected = index.items.find((tool) => tool.name !== "refresh")?.name;
        expect(typeof selected).toBe("string");
        const describeStart = performance.now();
        const described = yield* app.api.request(
          app.actors.owner,
          "GET",
          `${app.path}/tools/${String(selected)}?profile=${app.profile.id}`,
        );
        const describeMs = performance.now() - describeStart;
        expect(described.status).toBe(200);
        const tool = yield* body(
          Schema.Struct({
            name: Schema.String,
            inputSchema: Schema.Struct({ anyOf: Schema.Array(Schema.Json) }),
          }),
          described,
        );
        expect(tool.name).toBe(selected);
        expect(tool.inputSchema.anyOf.length).toBe(1);
        expect(
          (yield* app.api.request(
            app.actors.owner,
            "GET",
            `${app.path}/tools/missing_tool?profile=${app.profile.id}`,
          )).status,
        ).toBe(404);
        expect((yield* control(origin)).counters.list).toBe(1);
        yield* Effect.logInfo("MCP catalog browsing measurements", {
          listMs,
          indexMs,
          describeMs,
        });
        const countBefore = (yield* control(origin)).counters.call;
        expect(
          (yield* app.call("alpha_fixture_0000", { accountId: alpha, input: { message: 42 } }))
            .status,
        ).toBe(422);
        expect((yield* control(origin)).counters.call).toBe(countBefore);
        yield* control(origin, { version: 2 });
        yield* Effect.all(
          [measured("refresh", { id: alpha }), measured("refresh", { id: alpha })],
          { concurrency: 2 },
        );
        expect((yield* control(origin)).counters.list).toBe(2);
        expect((yield* app.call("alpha_revision_1", input)).status).toBe(404);
        yield* measured("alpha_revision_2");
        const bravo = yield* connect("bravo");
        yield* selectProfileAccounts(app.actors.owner, app.path, app.profile.id, {
          service: [bravo],
        });
        yield* measured("bravo_fixture_0000", { accountId: bravo, input: {} });
        expect((yield* control(origin)).counters.list).toBe(3);
        expect(
          (yield* app.call("alpha_fixture_0000", { accountId: bravo, input: {} })).status,
        ).toBe(404);
        const baseline = yield* deploy(`${origin}/mcp`, false);
        const uncachedMs = yield* Effect.forEach([1, 2, 3], () =>
          Effect.gen(function* () {
            const before = (yield* control(origin)).counters.list;
            const start = performance.now();
            const response = yield* baseline.call("fixture_0000");
            expect(response.status).toBe(200);
            yield* body(Schema.Json, response);
            const elapsed = performance.now() - start;
            // Deployment/profile indexing may also discover in the background.
            // Every uncached call must issue its own tools/list regardless.
            expect((yield* control(origin)).counters.list).toBeGreaterThan(before);
            return elapsed;
          }),
        );
        yield* Effect.logInfo("MCP catalog cache measurements", {
          coldMs,
          warmMs,
          uncachedMs,
          tools: 3000,
          origin,
        });
      }),
    ),
  );

  it.effect(scenarios.mcpCatalogRefresh.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const origin = yield* fixture();
        yield* control(origin, { count: 8, delayMs: 0 });
        const app = yield* deploy(`${origin}/mcp`, true);
        expect((yield* app.call("fixture_0000")).status).toBe(200);
        yield* control(origin, { fail: true });
        expect((yield* app.call("refresh", { id: "" })).status).toBeGreaterThanOrEqual(400);
        const lists = (yield* control(origin)).counters.list;
        expect((yield* app.call("fixture_0000")).status).toBe(200);
        expect((yield* control(origin)).counters.list).toBe(lists);
        yield* control(origin, { fail: false, notify: true, version: 2, numeric: true });
        expect((yield* app.call("fixture_0000")).status).toBe(200);
        expect((yield* app.call("revision_2", { message: 42 })).status).toBe(200);
        expect((yield* control(origin)).counters.list).toBe(lists + 1);
        const calls = (yield* control(origin)).counters.call;
        expect((yield* app.call("fixture_0000", { message: "old schema" })).status).toBe(422);
        expect((yield* control(origin)).counters.call).toBe(calls);
        expect((yield* app.call("revision_1")).status).toBe(404);

        // Credentials come only with their account: headers without one are refused before
        // the server is contacted, so an unbound credential never keys or fills a shared catalog.
        const unbound = yield* deploy(`${origin}/mcp`, true, false, true);
        const before = (yield* control(origin)).counters;
        const refused = yield* unbound.call("fixture_0000");
        expect(refused.status).toBe(502);
        expect(
          (yield* body(Schema.Struct({ mcp: Schema.Struct({ reason: Schema.String }) }), refused))
            .mcp.reason,
        ).toBe("invalid_input");
        expect((yield* control(origin)).counters).toEqual(before);
      }),
    ),
  );
  it.effect(scenarios.mcpListingCacheChanges.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const origin = yield* fixture();
        yield* control(origin, { count: 3, delayMs: 0 });
        const app = yield* deploy(`${origin}/mcp`, true);
        const mcp = yield* McpClient;
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* app.api.request(app.actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Listing cache changes",
          }),
        );
        yield* Effect.addFinalizer(() =>
          app.api
            .request(app.actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "listing-cache-changes", {
          organization: app.actors.organization.id,
        });
        const listed = Schema.Struct({
          structuredContent: Schema.Struct({
            execution: Schema.Struct({
              ok: Schema.Literal(true),
              value: Schema.Struct({ items: Schema.Array(Schema.Struct({ path: Schema.String })) }),
            }),
          }),
        });
        /** The revision tool each listed target of the app exposes. */
        const revisions = (step: string) =>
          Effect.gen(function* () {
            const result = yield* client.use(step, (client, signal) =>
              client.callTool(
                {
                  name: "execute",
                  arguments: {
                    code: `return await tools.search({ query: "revision", limit: 50 });`,
                  },
                },
                undefined,
                { signal, timeout: 55_000 },
              ),
            );
            const { items } = (yield* Schema.decodeUnknownEffect(listed)(result)).structuredContent
              .execution.value;
            return [
              ...new Set(items.flatMap((item) => /revision_\d+/.exec(item.path) ?? [])),
            ].sort();
          });
        const evidence = yield* Evidence,
          telemetry = yield* Telemetry;
        /**
         * This app's SDK listing reads recorded in the trace of the latest MCP request. Other apps
         * of the organization, such as one installed while the scenario runs, are listed too.
         */
        const listingReads = Effect.gen(function* () {
          const request = (yield* evidence.requests)
            .filter((entry) => entry.path === "/mcp")
            .at(-1);
          if (request === undefined) return yield* Effect.fail(new Error("Missing MCP request"));
          return yield* telemetry.query(request.traceId).pipe(
            Effect.flatMap((result) => {
              const reads = result.data.flatMap(({ span }) => {
                const outcome = span.tags["executor.declarations.cache"];
                return span.operationName === "sdk.tools.listing" &&
                  span.tags["executor.app.id"] === app.id &&
                  outcome !== undefined
                  ? [outcome]
                  : [];
              });
              return reads.length === 0
                ? Effect.fail(new Error("Missing tool listing span"))
                : Effect.succeed(reads);
            }),
            Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 80 }),
          );
        });
        /**
         * What the latest search loaded, as its `mcp.search.discovery` span records it: spans on
         * a Workers I/O clock cannot time its CPU, which grows with these counts.
         */
        const searchDiscovery = Effect.gen(function* () {
          const request = (yield* evidence.requests)
            .filter((entry) => entry.path === "/mcp")
            .at(-1);
          if (request === undefined) return yield* Effect.fail(new Error("Missing MCP request"));
          return yield* telemetry.query(request.traceId).pipe(
            Effect.flatMap((result) => {
              const span = result.data.find(
                ({ span }) => span.operationName === "mcp.search.discovery",
              )?.span;
              return span === undefined
                ? Effect.fail(new Error("Missing search discovery span"))
                : Effect.succeed({
                    apps: Number(span.tags["executor.discovery.apps"]),
                    tools: Number(span.tags["executor.discovery.tools"]),
                  });
            }),
            Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 80 }),
          );
        });
        expect(yield* revisions("First listing")).toEqual(["revision_1"]);
        // A search loads every app it may rank: at least this app and its revision tool.
        const loaded = yield* searchDiscovery;
        expect(loaded.apps).toBeGreaterThanOrEqual(1);
        expect(loaded.tools).toBeGreaterThanOrEqual(1);
        expect(Number.isInteger(loaded.tools)).toBe(true);
        // That evaluation filled the cold app cache, a change that keeps it from being reused;
        // the next one reads the warm cache and is kept.
        expect(yield* revisions("Listing from the warm app cache")).toEqual(["revision_1"]);
        const lists = (yield* control(origin)).counters.list;
        // The listing is kept: a second search neither evaluates the app nor asks the server.
        expect(yield* revisions("Kept listing")).toEqual(["revision_1"]);
        expect((yield* control(origin)).counters.list).toBe(lists);
        for (const outcome of yield* listingReads) expect(outcome).toBe("hit");

        // An explicit refresh replaces the app's cached catalog; the next search lists it again.
        yield* control(origin, { version: 2 });
        expect((yield* app.call("refresh", { id: "" })).status).toBe(200);
        expect(yield* revisions("After a catalog refresh")).toEqual(["revision_2"]);

        // A server that announces a changed tool list during a call invalidates the cached
        // catalog, and the next search lists the changed tools.
        yield* control(origin, { version: 3, notify: true });
        expect((yield* app.call("fixture_0000")).status).toBe(200);
        expect(yield* revisions("After tools/list_changed")).toEqual(["revision_3"]);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.mcpExecuteSignatures.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const origin = yield* fixture();
        yield* control(origin, { count: 200, delayMs: 0 });
        const app = yield* deploy(`${origin}/mcp`, true);
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* app.api.request(app.actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Execute signatures",
          }),
        );
        yield* Effect.addFinalizer(() =>
          app.api
            .request(app.actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const client = yield* (yield* McpClient).connect(key.key, "execute-signatures", {
          organization: app.actors.organization.id,
        });
        const evidence = yield* Evidence,
          telemetry = yield* Telemetry;
        const Executed = Schema.Struct({
          structuredContent: Schema.Struct({
            execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json }),
          }),
        });
        /**
         * Runs one program. Returns its value, the tools its catalog held and the signatures its
         * CodeMode runtime rendered, as the request's `mcp.catalog` and `mcp.execute` spans record.
         */
        const run = (step: string, code: string) =>
          Effect.gen(function* () {
            const result = yield* client.use(step, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, {
                signal,
                timeout: 55_000,
              }),
            );
            const { value } = (yield* Schema.decodeUnknownEffect(Executed)(result))
              .structuredContent.execution;
            const request = (yield* evidence.requests)
              .filter((entry) => entry.path === "/mcp")
              .at(-1);
            if (request === undefined) return yield* Effect.fail(new Error("Missing MCP request"));
            const recorded = yield* telemetry.query(request.traceId).pipe(
              Effect.flatMap((trace) => {
                const span = (name: string) =>
                  trace.data.find(({ span }) => span.operationName === name)?.span;
                const rendered = span("mcp.execute")?.tags["executor.codemode.signatures_rendered"];
                const tools = span("mcp.catalog")?.tags["executor.discovery.tools"];
                return rendered === undefined || tools === undefined
                  ? Effect.fail(new Error(`Missing execute spans for ${step}`))
                  : Effect.succeed({ rendered: Number(rendered), tools: Number(tools) });
              }),
              Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 80 }),
            );
            return { value, ...recorded };
          });

        // Executor's own search ranks its listing projections; the program's runtime renders none.
        const searched = yield* run(
          "Executor search",
          `return await tools.search({ query: "fixture_0007", limit: 5 });`,
        );
        expect(searched.rendered).toBe(0);
        const path = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ items: Schema.Array(Schema.Struct({ path: Schema.String })) }),
        )(searched.value).pipe(
          Effect.map(({ items }) => items.find((item) => item.path.endsWith("fixture_0007"))?.path),
        );
        expect(path).toBeDefined();

        // A program that calls one tool reaches the app's 200, and renders none of their signatures.
        const called = yield* run("One tool call", `return await ${String(path)}({});`);
        expect(called.tools).toBeGreaterThanOrEqual(200);
        expect(called.rendered).toBe(0);

        // CodeMode's own search() reads its search index, so it renders every reachable tool.
        const indexed = yield* run(
          "CodeMode search",
          `return await search({ query: "fixture_0007" });`,
        );
        expect(indexed.tools).toBeGreaterThanOrEqual(200);
        expect(indexed.rendered).toBeGreaterThanOrEqual(indexed.tools);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
