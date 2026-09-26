/** MCP catalog caching through real app deployment, storage and upstream HTTP boundaries. */
import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Config, Effect, Layer, Option, Schema } from "effect";
import {
  HttpRouter,
  HttpClient,
  HttpClientRequest,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { createProfile, selectProfileAccounts } from "../support/profiles.ts";

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

const source = (url: string, cached: boolean, accounts: boolean) => [
  {
    path: "package.json",
    content: JSON.stringify({ dependencies: { "@modelcontextprotocol/sdk": "1.30.0" } }),
  },
  {
    path: "index.ts",
    content: `
import { defineApp, defineProvider, accountOperations, secrets, object, string, query } from "apps";
import { mcpOperations } from "apps/mcp";
const provider = defineProvider({ name: "Cache fixture", auth: { key: secrets({ label: "Variant", fields: object({ token: string() }) }) } });
export default defineApp({ accounts: ${accounts ? "{ service: provider.many() }" : "{}"} }, async ctx => {
  const options = account => ({ url: ${JSON.stringify(url)}, signal: ctx.signal,
    ${cached ? "cache: account ? ctx.cache.forAccount(account) : ctx.cache," : ""}
    ...(account ? { accountId: account.id, headers: { "X-Fixture-Variant": account.fields.token } } : {}),
  });
  const tools = ${accounts ? "await accountOperations(ctx.accounts.service, account => mcpOperations(options(account)), { signal: ctx.signal })" : "await mcpOperations(options(undefined))"};
  return { ...tools, queries: { ...tools.queries,
    refresh: query({ input: object({ id: string() }) }, async (_, { id }) => {
      const account = ${accounts ? "ctx.accounts.service.find(account => account.id === id)" : "undefined"};
      ${accounts ? 'if (!account) throw new Error("Missing account");' : ""}
      await mcpOperations({ ...options(account), revalidate: true }); return true;
    }),
  } };
});`,
  },
];

const deploy = (url: string, cached: boolean, accounts = false) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const actors = yield* Actors;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: `MCP cache ${randomUUID().slice(0, 8)}`,
      files: source(url, cached, accounts),
    });
    expect(response.status).toBe(200);
    const path = `${prefix}/apps/${(yield* body(App, response)).id}`;
    yield* Effect.addFinalizer(() => api.request(actors.owner, "DELETE", path).pipe(Effect.orDie));
    const profile = yield* createProfile(actors.owner, path);
    const call = (name: string, input: Schema.Json = {}, profileId = profile.id) =>
      api.request(actors.owner, "POST", `${path}/tools/call`, {
        profile: profileId,
        tool: `queries.${name}`,
        input,
      });
    return { api, actors, path, prefix, profile, call };
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
        const connect = (token: string) =>
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
                { method: "key", label: "Synthetic variant", fields: { token } },
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
        const selected = index.items.find((tool) => tool.name !== "queries.refresh")?.name;
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
            `${app.path}/tools/queries.missing_tool?profile=${app.profile.id}`,
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
      }),
    ),
  );
});
