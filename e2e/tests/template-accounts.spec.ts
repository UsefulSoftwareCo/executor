/** Multi-account routing is verified through skill-authored source and public profile/tool APIs. */
import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { authoredAppFiles } from "../support/authored-templates.ts";
import { strictTypeProblems } from "../support/apps-package.ts";
import { withApps } from "../support/apps-release.ts";
import { McpClient } from "../support/mcp-client.ts";
import { outputContractProblems } from "../support/output-contract.ts";
import { templateUpstream } from "../support/template-upstream.ts";
import { scenarios } from "../test-plan.ts";

const Profile = Schema.Struct({
  id: Schema.String,
  revision: Schema.Number,
  accounts: Schema.Struct({ service: Schema.Array(Schema.String) }),
});
const Tools = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      inputSchema: Schema.Json,
      outputSchema: Schema.optionalKey(Schema.Json),
    }),
  ),
});
/** What one MCP execution described and returned for the profile's MCP tool. */
const Searched = Schema.Struct({
  structuredContent: Schema.Struct({
    execution: Schema.Struct({
      ok: Schema.Literal(true),
      value: Schema.Struct({
        items: Schema.Array(Schema.Struct({ path: Schema.String, signature: Schema.String })),
        results: Schema.Array(Schema.Json),
      }),
    }),
  }),
});

/** A tool call whose result did not match the tool's output schema. */
const OutputRejected = Schema.Struct({
  _tag: Schema.Literal("ToolCallFailed"),
  failure: Schema.Struct({ errorName: Schema.Literal("SchemaError"), message: Schema.String }),
});
const TreeMessage = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.String,
  params: Schema.optional(
    Schema.Struct({
      arguments: Schema.optional(Schema.Struct({ complete: Schema.optional(Schema.Boolean) })),
    }),
  ),
});

/**
 * An MCP server whose `tree` tool declares a recursive output schema. A complete tree names every
 * node; otherwise the child's own child is the only node with a name.
 */
const treeUpstream = Effect.gen(function* () {
  const tool = {
    name: "tree",
    description: "Read a tree",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { complete: { type: "boolean" } },
      required: ["complete"],
    },
    outputSchema: {
      $schema: "https://json-schema.org/draft/2019-09/schema",
      $recursiveAnchor: true,
      type: "object",
      properties: { name: { type: "string" }, child: { $recursiveRef: "#" } },
      required: ["name"],
    },
  };
  const routes = Layer.mergeAll(
    HttpRouter.add("GET", "/mcp", HttpServerResponse.empty({ status: 405 })),
    HttpRouter.add(
      "POST",
      "/mcp",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const message = yield* request.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(TreeMessage)),
        );
        if (message.id === undefined) return HttpServerResponse.empty({ status: 202 });
        const tree =
          message.params?.arguments?.complete === true
            ? { name: "root", child: { name: "leaf" } }
            : { name: "root", child: { child: { name: "leaf" } } };
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "trees", version: "1" },
              }
            : message.method === "tools/list"
              ? { tools: [tool] }
              : {
                  content: [{ type: "text", text: JSON.stringify(tree) }],
                  structuredContent: tree,
                };
        return yield* HttpServerResponse.json({ jsonrpc: "2.0", id: message.id, result });
      }),
    ),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    ),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  return `http://127.0.0.1:${server.address.port}`;
});

/**
 * One app with both `accountRouter` callback forms integrations.md shows: a synchronous callback
 * returning `liveOpenapiRouter`, and a router of hand-written queries and mutations whose handlers
 * take `(_ctx, input)`. No casts, so it type-checks only if the framework's types accept them.
 */
const routedAppFiles = (origin: string) => [
  {
    path: "index.ts",
    content: `import { accountRouter, defineApp, defineProvider, mutation, object, query, router, secrets, string } from "apps";
import { liveOpenapiRouter } from "apps/openapi";

const service = defineProvider({
  name: "Routed accounts",
  auth: { apiKey: secrets({ label: "API key", fields: object({ token: string({ minLength: 1 }) }) }) },
});

export default defineApp({ accounts: { service: service.many() } }, async ({ accounts, cache, fetch, signal }) => ({
  tools: router({
    own: await accountRouter(
      accounts.service,
      (account) =>
        router({
          whoami: query({ input: object({}) }, async () => account.id),
          echo: mutation({ input: object({ text: string() }) }, async (_ctx, input) => input.text),
        }),
      { signal },
    ),
    api: await accountRouter(
      accounts.service,
      (account) =>
        liveOpenapiRouter({
          source: { url: ${JSON.stringify(`${origin}/openapi.json`)} },
          allowedOrigin: ${JSON.stringify(origin)},
          baseUrl: ${JSON.stringify(origin)},
          securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
          methods: { apiKey: [{ scheme: "bearer", field: "token", part: "value", prefix: "" }] },
          oauth: [],
          cache,
          fetch,
          signal,
          account,
        }),
      { signal },
    ),
  }),
}));
`,
  },
  {
    path: "package.json",
    content: JSON.stringify({
      name: "routed-app",
      private: true,
      type: "module",
      dependencies: withApps(),
    }),
  },
];

/** An account router whose handler needs a GitHub account the app does not declare. */
const undeclaredAccountFiles = [
  {
    path: "index.ts",
    content: `import { accountRouter, defineApp, defineProvider, object, query, router, secrets, string, type QueryContext } from "apps";
const service = defineProvider({ name: "Service", auth: { apiKey: secrets({ label: "API key", fields: object({ token: string() }) }) } });
const github = defineProvider({ name: "GitHub", auth: { token: secrets({ label: "Token", fields: object({ token: string() }) }) } });
const repo = query({ input: object({}) }, async (ctx: QueryContext<{ accounts: { github: typeof github } }>) => ctx.accounts.github.id);
export default defineApp({ accounts: { service: service.many() } }, async ({ accounts, signal }) => ({
  tools: await accountRouter(accounts.service, () => router({ repo }), { signal }),
}));
`,
  },
  {
    path: "package.json",
    content: JSON.stringify({ type: "module", dependencies: withApps() }),
  },
];

layer(HostedLive, { excludeTestServices: true })("Template accounts", (it) => {
  it.effect(scenarios.templateAccounts.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          origin = yield* templateUpstream;
        const prefix = `/api/organizations/${actors.organization.id}`;
        for (const kind of ["openapi", "mcp", "graphql"] as const) {
          const name = `Accounts ${kind} ${randomUUID().slice(0, 8)}`;
          const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name,
            files: authoredAppFiles(kind, origin, "apiKey", name),
          });
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          const app = yield* body(App, response),
            path = `${prefix}/apps/${app.id}`;
          const accounts: string[] = [];
          let profileId: string | undefined;
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              if (profileId !== undefined)
                yield* api.request(actors.owner, "DELETE", `${path}/profiles/${profileId}`);
              yield* api.request(actors.owner, "DELETE", path);
              for (const id of accounts)
                yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${id}`);
            }).pipe(Effect.orDie),
          );
          const create = yield* api.request(actors.owner, "POST", `${path}/profiles`, {
            accounts: { service: [] },
            idempotencyKey: randomUUID(),
          });
          expect(
            create.status,
            `${kind} accepts an account array: ${JSON.stringify(create.body)}`,
          ).toBe(200);
          let profile = yield* body(Profile, create);
          profileId = profile.id;
          const catalog = () =>
            api.request(actors.owner, "GET", `${path}/tools?profile=${profile.id}`);
          const empty = yield* catalog();
          expect(empty.status, JSON.stringify(empty.body)).toBe(200);
          expect((yield* body(Tools, empty)).items).toEqual([]);
          for (const label of ["work", "personal"]) {
            const start = yield* api.request(actors.owner, "POST", `${path}/connections`, {
              requirement: "service",
              profile: profile.id,
            });
            expect(start.status, JSON.stringify(start.body)).toBe(200);
            const connection = yield* body(Resource, start);
            const saved = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/submit`,
              {
                method: "apiKey",
                label,
                fields: { token: `synthetic-${label}` },
              },
            );
            expect(saved.status, JSON.stringify(saved.body)).toBe(200);
            accounts.push((yield* body(Resource, saved)).id);
          }
          profile = yield* body(
            Profile,
            yield* api.request(actors.owner, "GET", `${path}/profiles/${profile.id}`),
          );
          expect(profile.accounts.service).toEqual(accounts);
          const tools = yield* catalog();
          expect(tools.status, JSON.stringify(tools.body)).toBe(200);
          const tool =
            kind === "graphql"
              ? "query_identity"
              : kind === "openapi"
                ? "identity.getIdentity"
                : "identity";
          expect((yield* body(Tools, tools)).items.map((item) => item.name)).toEqual([tool]);
          if (kind === "mcp") {
            const descriptions = JSON.stringify((yield* body(Tools, tools)).items);
            expect(descriptions).toContain('"value"');
            expect(descriptions).toContain('"work"');
            expect(descriptions).toContain('"#/anyOf/0/properties/input/$defs/Value"');
            expect(descriptions).toContain('"#/anyOf/1/properties/input/$defs/Value"');
            // Calls return the whole MCP result; the server's schema describes its structuredContent.
            expect(descriptions).toContain('"#/anyOf/0/$defs/Account"');
            expect(descriptions).toContain('"#/anyOf/1/$defs/Account"');
          }
          const call = (accountId: string, label: string) =>
            api.request(actors.owner, "POST", `${path}/tools/call`, {
              profile: profile.id,
              tool,
              // Every template's identity operation is a read.
              kind: "query",
              input: { accountId, input: kind === "mcp" ? { value: label } : {} },
            });
          for (const [index, label] of ["work", "personal"].entries()) {
            const id = accounts[index];
            if (id === undefined) return yield* Effect.die("Account fixture missing");
            const called = yield* call(id, label);
            expect(called.status, `${kind}: ${JSON.stringify(called.body)}`).toBe(200);
            if (kind === "mcp")
              expect(called.body).toMatchObject({ structuredContent: { account: label } });
            else expect(called.body).toEqual(kind === "graphql" ? label : { account: label });
            if (kind === "mcp") {
              const wrongSchema = yield* call(id, label === "work" ? "personal" : "work");
              expect(wrongSchema.status).toBeGreaterThanOrEqual(400);
              expect(wrongSchema.status).toBeLessThan(500);
            }
          }
          if (kind === "mcp") {
            // The output type an agent reads from tools.search.describe must accept what the
            // same calls return.
            const key = yield* body(
              Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
              yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
                name: "Template account output types",
              }),
            );
            yield* Effect.addFinalizer(() =>
              api
                .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
                .pipe(Effect.orDie),
            );
            const client = yield* (yield* McpClient).connect(key.key, "template-account-outputs", {
              organization: actors.organization.id,
            });
            const expression = `tools[${JSON.stringify(app.slug)}].profiles[${JSON.stringify(profile.id)}].${tool}`;
            const searched = yield* client.use("Describe and call the MCP tool", (client, signal) =>
              client.callTool(
                {
                  name: "execute",
                  arguments: {
                    code: `const found = await tools.search.describe({ paths: [${JSON.stringify(expression)}] });
const results = [];
for (const [accountId, value] of ${JSON.stringify(accounts.map((id, index) => [id, ["work", "personal"][index]]))})
  results.push(await ${expression}({ accountId, input: { value } }));
return { items: found.items, results };`,
                  },
                },
                undefined,
                { signal },
              ),
            );
            const { items, results } = (yield* Schema.decodeUnknownEffect(Searched)(searched))
              .structuredContent.execution.value;
            const signature = items.find(
              (item) => item.path.includes(profile.id) && item.path.endsWith(".identity"),
            )?.signature;
            if (signature === undefined)
              return yield* Effect.die(`Missing described MCP tool: ${JSON.stringify(items)}`);
            expect(results).toHaveLength(2);
            for (const result of results)
              expect(
                outputContractProblems(
                  signature,
                  result,
                  // Each account's schema is nested, so the account's type renders as unknown.
                  "const account: unknown = value.isError ? undefined : value.structuredContent.account;",
                ),
                signature,
              ).toEqual([]);
          }
          const removed = accounts[0],
            retained = accounts[1];
          if (removed === undefined || retained === undefined)
            return yield* Effect.die("Account fixtures missing");
          const updated = yield* api.request(
            actors.owner,
            "PATCH",
            `${path}/profiles/${profile.id}`,
            {
              expectedRevision: profile.revision,
              accounts: { service: [retained] },
            },
          );
          expect(updated.status, JSON.stringify(updated.body)).toBe(200);
          const rejected = yield* call(removed, "work");
          expect(rejected.status).toBeGreaterThanOrEqual(400);
          expect(rejected.status).toBeLessThan(500);
          const stillAvailable = yield* call(retained, "personal");
          expect(stillAvailable.status, JSON.stringify(stillAvailable.body)).toBe(200);
        }
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.templateAccountsRecursiveOutput.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          origin = yield* treeUpstream;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const name = `Accounts tree ${randomUUID().slice(0, 8)}`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name,
          files: authoredAppFiles("mcp", origin, "apiKey", name),
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const app = yield* body(App, response),
          path = `${prefix}/apps/${app.id}`;
        const profile = yield* body(
          Profile,
          yield* api.request(actors.owner, "POST", `${path}/profiles`, {
            accounts: { service: [] },
            idempotencyKey: randomUUID(),
          }),
        );
        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${path}/connections`, {
            requirement: "service",
            profile: profile.id,
          }),
        );
        const account = yield* body(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/submit`,
            {
              method: "apiKey",
              label: "Tree reader",
              fields: { token: "synthetic-tree" },
            },
          ),
        );
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", `${path}/profiles/${profile.id}`);
            yield* api.request(actors.owner, "DELETE", path);
            yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`);
          }).pipe(Effect.orDie),
        );
        const call = (complete: boolean) =>
          api.request(actors.owner, "POST", `${path}/tools/call`, {
            profile: profile.id,
            tool: "tree",
            kind: "query",
            input: { accountId: account.id, input: { complete } },
          });
        const complete = yield* call(true);
        expect(complete.status, JSON.stringify(complete.body)).toBe(200);
        expect(complete.body).toMatchObject({
          structuredContent: { name: "root", child: { name: "leaf" } },
        });
        // The result schema nests the server's schema, so its recursive reference becomes a
        // pointer to the nested root. A child without a name must still be rejected. The combined
        // account operation checks each account's result itself, so the mismatch is its failure.
        const incomplete = yield* call(false);
        expect(incomplete.status, JSON.stringify(incomplete.body)).toBe(502);
        const rejected = yield* body(OutputRejected, incomplete);
        expect(rejected.failure.message).toContain(
          'Missing key. Expected string\n  at ["structuredContent"]["child"]["name"]',
        );
      }),
    ),
  );
  it.effect(scenarios.templateAccountsRouterForms.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          origin = yield* templateUpstream;
        const files = routedAppFiles(origin);
        // deploy.md's local check, with the package this run deploys against.
        expect(yield* strictTypeProblems(files)).toEqual([]);
        // The routed handlers keep their context, so defineApp sees the missing account.
        expect(yield* strictTypeProblems(undeclaredAccountFiles)).toEqual([
          {
            file: "index.ts",
            line: 5,
            code: 2345,
            message: expect.stringContaining(
              "Property 'github' is missing in type '{ readonly service: readonly { readonly id: string & Brand<\"acc\">;",
            ),
          },
        ]);
        const prefix = `/api/organizations/${actors.organization.id}`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Routed accounts ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const path = `${prefix}/apps/${(yield* body(App, response)).id}`;
        const accounts: string[] = [];
        let profile = yield* body(
          Profile,
          yield* api.request(actors.owner, "POST", `${path}/profiles`, {
            accounts: { service: [] },
            idempotencyKey: randomUUID(),
          }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", `${path}/profiles/${profile.id}`);
            yield* api.request(actors.owner, "DELETE", path);
            for (const id of accounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${id}`);
          }).pipe(Effect.orDie),
        );
        for (const label of ["work", "personal"]) {
          const connection = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${path}/connections`, {
              requirement: "service",
              profile: profile.id,
            }),
          );
          const saved = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/submit`,
            { method: "apiKey", label, fields: { token: `synthetic-${label}` } },
          );
          expect(saved.status, JSON.stringify(saved.body)).toBe(200);
          accounts.push((yield* body(Resource, saved)).id);
        }
        profile = yield* body(
          Profile,
          yield* api.request(actors.owner, "GET", `${path}/profiles/${profile.id}`),
        );
        const tools = yield* api.request(
          actors.owner,
          "GET",
          `${path}/tools?profile=${profile.id}`,
        );
        expect(tools.status, JSON.stringify(tools.body)).toBe(200);
        expect(
          (yield* body(Tools, tools)).items.map((item) => item.name).toSorted(),
          JSON.stringify(tools.body),
        ).toEqual(["api.identity.getIdentity", "own.echo", "own.whoami"]);
        const call = (
          tool: string,
          kind: "query" | "mutation",
          accountId: string,
          input: unknown,
        ) =>
          api.request(actors.owner, "POST", `${path}/tools/call`, {
            profile: profile.id,
            tool,
            kind,
            input: { accountId, input },
          });
        // Each call reaches the selected account's own router.
        for (const [index, label] of ["work", "personal"].entries()) {
          const id = accounts[index];
          if (id === undefined) return yield* Effect.die("Account fixture missing");
          const whoami = yield* call("own.whoami", "query", id, {});
          expect(whoami.status, JSON.stringify(whoami.body)).toBe(200);
          expect(whoami.body).toBe(id);
          const echo = yield* call("own.echo", "mutation", id, { text: label });
          expect(echo.status, JSON.stringify(echo.body)).toBe(200);
          expect(echo.body).toBe(label);
          const identity = yield* call("api.identity.getIdentity", "query", id, {});
          expect(identity.status, JSON.stringify(identity.body)).toBe(200);
          expect(identity.body).toEqual({ account: label });
        }
      }),
    ),
  );
});
