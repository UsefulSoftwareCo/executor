/** GraphQL metadata caching through real app deployment and an external introspection server. */
import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Schema } from "effect";
import {
  HttpRouter,
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

const fixture = () =>
  Effect.gen(function* () {
    let version = 1,
      fail = false,
      discover = 0,
      calls = 0;
    let lastQuery = "";
    const scalar = (name: string) => ({ kind: "SCALAR", name, ofType: null });
    const required = (name: string) => ({ kind: "NON_NULL", name: null, ofType: scalar(name) });
    const argument = (name: string, type: Schema.Json, defaultValue: string | null = null) => ({
      name,
      type,
      description: null,
      defaultValue,
    });
    const routes = HttpRouter.add(
      "POST",
      "/graphql",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const message = yield* request.json.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({
                query: Schema.String,
                variables: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
              }),
            ),
          ),
        );
        const variant = request.headers["x-fixture-variant"] ?? "public";
        if (message.query.includes("__schema")) {
          discover++;
          yield* Effect.sleep("3 seconds");
          if (fail) return HttpServerResponse.empty({ status: 503 });
          const field = (
            name: string,
            args: readonly Schema.Json[] = [],
            type: Schema.Json = scalar("String"),
          ) => ({ name, description: `Revision ${version}`, args, type });
          const type = (kind: string, name: string, extra: Record<string, Schema.Json> = {}) => ({
            kind,
            name,
            fields: null,
            inputFields: null,
            enumValues: null,
            ...extra,
          });
          return yield* HttpServerResponse.json({
            data: {
              __schema: {
                queryType: { name: "Query" },
                mutationType: { name: "Mutation" },
                types: [
                  type("OBJECT", "Query", {
                    fields: [
                      ...Array.from({ length: 2998 }, (_, i) => field(`${variant}_fixture_${i}`)),
                      field(
                        `${variant}_record`,
                        [
                          argument("value", required(version === 1 ? "String" : "Int")),
                          argument("filter", {
                            kind: "INPUT_OBJECT",
                            name: "Filter",
                            ofType: null,
                          }),
                          argument("mode", { kind: "ENUM", name: "Mode", ofType: null }, '"A"'),
                        ],
                        { kind: "OBJECT", name: "Item", ofType: null },
                      ),
                      field(`${variant}_revision_${version}`),
                    ],
                  }),
                  type("OBJECT", "Mutation", {
                    fields: [
                      field(
                        `${variant}_update`,
                        [argument("value", required("Int"))],
                        scalar("Int"),
                      ),
                    ],
                  }),
                  type("OBJECT", "Item", {
                    fields: [field("id"), field("value", [], scalar("String"))],
                  }),
                  type("INPUT_OBJECT", "Filter", {
                    inputFields: [
                      argument("label", scalar("String")),
                      argument("next", { kind: "INPUT_OBJECT", name: "Filter", ofType: null }),
                    ],
                  }),
                  type("ENUM", "Mode", { enumValues: [{ name: "A" }, { name: "B" }] }),
                  type("SCALAR", "String"),
                  type("SCALAR", "Int"),
                ],
              },
            },
          });
        }
        calls++;
        lastQuery = message.query;
        const name = /\{\s*(\w+)/.exec(message.query)?.[1];
        if (!name || !name.startsWith(`${variant}_`))
          return HttpServerResponse.empty({ status: 400 });
        const value = name.endsWith("record")
          ? { id: variant, value: String(message.variables?.value) }
          : name.endsWith("update")
            ? (message.variables?.value ?? null)
            : `revision ${version}`;
        return yield* HttpServerResponse.json({ data: { [name]: value } });
      }),
    );
    const services = yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      ),
    );
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address)) return yield* Effect.die("Expected TCP fixture");
    return {
      url: `http://127.0.0.1:${server.address.port}/graphql`,
      stats: Effect.sync(() => ({ discover, calls, lastQuery })),
      configure: (next: { version: number; fail: boolean }) =>
        Effect.sync(() => {
          version = next.version;
          fail = next.fail;
        }),
    };
  });

const source = (url: string, cached: boolean, accounts: boolean) => [
  { path: "package.json", content: JSON.stringify({ dependencies: { graphql: "16.11.0" } }) },
  {
    path: "index.ts",
    content: `
import { defineApp, defineProvider, accountOperations, secrets, object, string, query } from "apps";
import { graphqlOperations } from "apps/graphql";
const provider = defineProvider({ name: "GraphQL fixture", auth: { key: secrets({ label: "Variant", fields: object({ token: string() }) }) } });
export default defineApp({ accounts: ${accounts ? "{ service: provider.many() }" : "{}"} }, async ctx => {
  const options = account => ({ url: ${JSON.stringify(url)}, signal: ctx.signal,
    ${cached ? "cache: account ? ctx.cache.forAccount(account) : ctx.cache," : ""}
    ...(account ? { accountId: account.id, headers: { "X-Fixture-Variant": account.fields.token } } : {}),
  });
  const tools = ${accounts ? "await accountOperations(ctx.accounts.service, account => graphqlOperations(options(account)), { signal: ctx.signal })" : "await graphqlOperations(options(undefined))"};
  return { ...tools, queries: { ...tools.queries,
    refresh: query({ input: object({ id: string() }) }, async (_, { id }) => {
      const account = ${accounts ? "ctx.accounts.service.find(account => account.id === id)" : "undefined"};
      ${accounts ? 'if (!account) throw new Error("Missing account");' : ""}
      await graphqlOperations({ ...options(account), revalidate: true }); return true;
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
      name: `GraphQL cache ${randomUUID().slice(0, 8)}`,
      files: source(url, cached, accounts),
    });
    expect(response.status).toBe(200);
    const path = `${prefix}/apps/${(yield* body(App, response)).id}`;
    yield* Effect.addFinalizer(() => api.request(actors.owner, "DELETE", path).pipe(Effect.orDie));
    const profile = yield* createProfile(actors.owner, path);
    const call = (name: string, input: Schema.Json = {}, profileId = profile.id) =>
      api.request(actors.owner, "POST", `${path}/tools/call`, {
        profile: profileId,
        tool: name.startsWith("mutation_") ? `mutations.${name}` : `queries.${name}`,
        input,
      });
    return { api, actors, path, prefix, profile, call };
  });

layer(HostedLive, { excludeTestServices: true })("GraphQL cache", (it) => {
  it.effect(scenarios.graphqlPublicCache.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const upstream = yield* fixture();
        const app = yield* deploy(upstream.url, true);
        const first = yield* app.call("query_public_fixture_0");
        expect(first.status).toBe(200);
        expect(yield* body(Schema.Json, first)).toBe("revision 1");
        expect((yield* upstream.stats).discover).toBe(1);
        const other = yield* createProfile(app.actors.owner, app.path);
        yield* upstream.configure({ version: 2, fail: true });
        // Only introspection fails; execution still runs live using the shared metadata.
        const next = yield* app.call("query_public_fixture_0", {}, other.id);
        expect(next.status).toBe(200);
        expect(yield* body(Schema.Json, next)).toBe("revision 2");
        expect((yield* upstream.stats).discover).toBe(1);
        expect((yield* upstream.stats).calls).toBe(2);
      }),
    ),
  );

  it.effect(scenarios.graphqlCatalogCache.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const upstream = yield* fixture();
        const app = yield* deploy(upstream.url, true, true);
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
                { method: "key", label: "Synthetic GraphQL", fields: { token } },
              ),
            );
            ids.push(account.id);
            return account.id;
          });
        const alpha = yield* connect("alpha");
        const input = {
          accountId: alpha,
          input: {
            arguments: { value: "hello", filter: { next: { label: "nested" } }, mode: "B" },
          },
        };
        const coldStart = performance.now();
        const first = yield* app.call("query_alpha_record", input);
        expect(first.status).toBe(200);
        expect(yield* body(Schema.Json, first)).toEqual({ id: "alpha", value: "hello" });
        const coldMs = performance.now() - coldStart;
        expect((yield* upstream.stats).discover).toBe(1);
        const warmMs = yield* Effect.forEach([1, 2, 3], () =>
          Effect.gen(function* () {
            const start = performance.now();
            expect((yield* app.call("query_alpha_record", input)).status).toBe(200);
            return performance.now() - start;
          }),
        );
        expect((yield* upstream.stats).discover).toBe(1);
        expect((yield* upstream.stats).lastQuery).toContain("$value: String!");
        const page = yield* app.api.request(
          app.actors.owner,
          "GET",
          `${app.path}/tools?profile=${app.profile.id}`,
        );
        expect(page.status).toBe(200);
        expect(
          (yield* body(
            Schema.Struct({ items: Schema.Array(Schema.Json), next: Schema.String }),
            page,
          )).items,
        ).toHaveLength(2000);
        const beforeInvalid = (yield* upstream.stats).calls;
        expect(
          (yield* app.call("query_alpha_record", {
            accountId: alpha,
            input: { arguments: { value: 42 } },
          })).status,
        ).toBe(422);
        expect((yield* upstream.stats).calls).toBe(beforeInvalid);
        const mutation = yield* app.call("mutation_alpha_update", {
          accountId: alpha,
          input: { arguments: { value: 7 } },
        });
        expect(mutation.status).toBe(200);
        expect(yield* body(Schema.Json, mutation)).toBe(7);
        expect((yield* upstream.stats).lastQuery).toMatch(/^mutation/);
        expect((yield* upstream.stats).discover).toBe(1);
        yield* upstream.configure({ version: 2, fail: false });
        const refreshes = yield* Effect.all(
          [app.call("refresh", { id: alpha }), app.call("refresh", { id: alpha })],
          { concurrency: 2 },
        );
        for (const response of refreshes) expect(response.status).toBe(200);
        expect((yield* upstream.stats).discover).toBe(2);
        expect(
          (yield* app.call("query_alpha_revision_1", { accountId: alpha, input: {} })).status,
        ).toBe(404);
        expect(
          (yield* app.call("query_alpha_revision_2", { accountId: alpha, input: {} })).status,
        ).toBe(200);
        expect((yield* app.call("query_alpha_record", input)).status).toBe(422);
        expect(
          (yield* app.call("query_alpha_record", {
            accountId: alpha,
            input: { arguments: { value: 42 }, select: "id" },
          })).status,
        ).toBe(200);
        expect((yield* upstream.stats).lastQuery).toContain("$value: Int!");
        yield* upstream.configure({ version: 2, fail: true });
        expect((yield* app.call("refresh", { id: alpha })).status).toBe(502);
        expect(
          (yield* app.call("query_alpha_revision_2", { accountId: alpha, input: {} })).status,
        ).toBe(200);
        expect((yield* upstream.stats).discover).toBe(3);
        yield* upstream.configure({ version: 2, fail: false });
        const bravo = yield* connect("bravo");
        yield* selectProfileAccounts(app.actors.owner, app.path, app.profile.id, {
          service: [bravo],
        });
        expect(
          (yield* app.call("query_bravo_revision_2", { accountId: bravo, input: {} })).status,
        ).toBe(200);
        expect(
          (yield* app.call("query_alpha_revision_2", { accountId: bravo, input: {} })).status,
        ).toBe(404);
        expect((yield* upstream.stats).discover).toBe(4);
        const reconnect = yield* body(
          Resource,
          yield* app.api.request(
            app.actors.owner,
            "POST",
            `${app.prefix}/accounts/${bravo}/connections`,
          ),
        );
        expect(
          (yield* app.api.request(
            app.actors.owner,
            "POST",
            `${app.prefix}/connections/${reconnect.id}/submit`,
            { method: "key", label: "Rotated GraphQL", fields: { token: "rotated" } },
          )).status,
        ).toBe(200);
        expect(
          (yield* app.call("query_rotated_revision_2", { accountId: bravo, input: {} })).status,
        ).toBe(200);
        expect(
          (yield* app.call("query_bravo_revision_2", { accountId: bravo, input: {} })).status,
        ).toBe(404);
        expect((yield* upstream.stats).discover).toBe(5);
        yield* Effect.logInfo("GraphQL cache measurements", { coldMs, warmMs, fields: 3001 });
      }),
    ),
  );
});
