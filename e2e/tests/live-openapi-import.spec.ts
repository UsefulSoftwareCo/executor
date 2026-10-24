import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { connectionsPath } from "../support/app-accounts.ts";
import {
  clientCredentialsScheme,
  credentialEchoUpstream,
  deployPublicApp,
  invalidSchemaDocument,
  jsonLines,
  malformedSwaggerDocument,
  openapi32Upstream,
  otherHostDocument,
  requestEchoUpstream,
  unsupportedAuthDocument,
  v1Document,
} from "../support/openapi-import.ts";
import { scenarios } from "../test-plan.ts";

/** A router's listing failure; the importer's failures carry every field. */
const RouterFailure = Schema.Struct({
  _tag: Schema.String,
  errorName: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
});
/** What `openapiToolNames` resolves to, as a query returns it. */
const OpenapiToolNames = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      method: Schema.String,
      path: Schema.String,
      kind: Schema.String,
      public: Schema.Boolean,
      methods: Schema.Array(Schema.String),
    }),
  ),
  skipped: Schema.Array(Schema.Unknown),
});
const Catalog = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ name: Schema.String, readOnly: Schema.optionalKey(Schema.Boolean) }),
  ),
  routers: Schema.Array(
    Schema.Struct({ path: Schema.String, error: Schema.optionalKey(RouterFailure) }),
  ),
});
const EvaluationFailed = Schema.Struct({
  _tag: Schema.Literal("AppEvaluationFailed"),
  message: Schema.String,
  failure: Schema.Struct({
    source: Schema.String,
    errorName: Schema.String,
    code: Schema.String,
    message: Schema.String,
  }),
});
/** How every message about left-out operations ends, unless each one streams events. */
const customTool =
  'To call a left-out operation anyway, write a custom tool for it in this app with the same account: see "Custom tools beside generated ones" in the app-authoring skill\'s integrations.md.';
const Recorded = Schema.Struct({ method: Schema.String, url: Schema.String, body: Schema.String });

/** Definitions the importer cannot fully use, each mounted under its own key. */
const diagnosed = `import { defineApp, router } from "apps";
import { liveOpenapiRouter } from "apps/openapi";
const common = { securitySchemes: {}, methods: {}, oauth: [] };
export default defineApp({}, async ({ cache, fetch, signal }) => ({
  tools: router({
    mail: liveOpenapiRouter({ ...common, cache, fetch, signal,
      source: { document: ${JSON.stringify(otherHostDocument)} },
      allowedOrigin: "https://www.example.com" }),
    teams: liveOpenapiRouter({ ...common, cache, fetch, signal,
      source: { document: ${JSON.stringify(invalidSchemaDocument)} },
      allowedOrigin: "https://api.example.com" }),
    status: liveOpenapiRouter({ ...common, cache, fetch, signal,
      source: { document: ${JSON.stringify(malformedSwaggerDocument)} },
      allowedOrigin: "https://status.example.com" }),
    jobs: liveOpenapiRouter({ ...common, cache, fetch, signal,
      source: { document: ${JSON.stringify(unsupportedAuthDocument)} },
      securitySchemes: ${JSON.stringify(clientCredentialsScheme)},
      allowedOrigin: "https://jobs.example.com" }),
  }),
}));
`;

/** A legacy API without operationIds, where a list and a single item share their resource words. */
const pathParameters = (...names: string[]) =>
  names.map((name) => ({ name, in: "path", required: true, schema: { type: "string" } }));
const ok = { responses: { "200": { description: "OK" } } };
const unnamedDocument = {
  openapi: "3.0.3",
  info: { title: "Legacy CI", version: "1" },
  servers: [{ url: "https://ci.example.com" }],
  components: { securitySchemes: { token: { type: "apiKey", in: "header", name: "x-token" } } },
  paths: {
    "/projects": { get: ok },
    "/project/{username}/{project}": { parameters: pathParameters("username", "project"), get: ok },
    "/project/{username}/{project}/envvar/{name}": {
      parameters: pathParameters("username", "project", "name"),
      get: ok,
      delete: ok,
    },
    // Needs an account, so a router without one does not list it.
    "/project/{username}/{project}/build": {
      parameters: pathParameters("username", "project"),
      post: { ...ok, security: [{ token: [] }] },
    },
  },
};
/**
 * An operation, then a sibling the API adds later whose name normalizes to the same one: another
 * version of the path, the path without its parameter, and an operationId equal to a refined name.
 */
const collisions = {
  version: [{ "/v1/items": { get: ok } }, { "/v2/items": { get: ok } }],
  parameter: [
    { "/orgs/{org}/items": { parameters: pathParameters("org"), get: ok } },
    { "/orgs/items": { get: ok } },
  ],
  operationId: [
    { "/items/{id}": { parameters: pathParameters("id"), get: ok } },
    { "/items/lookup": { get: { ...ok, operationId: "getItemsById" } } },
  ],
};
const itemsDocument = (paths: Record<string, unknown>) => ({
  openapi: "3.0.3",
  info: { title: "Items", version: "1" },
  servers: [{ url: "https://ci.example.com" }],
  paths,
});
/** Each case alone, after the sibling is added, and with the definition's order reversed. */
const collisionPlans = Object.entries(collisions).flatMap(([name, [existing, sibling]]) => {
  // An operation no sibling collides with, so every definition imports something.
  const added = { "/status": { get: ok }, ...existing, ...sibling };
  return Object.entries({
    alone: { "/status": { get: ok }, ...existing },
    added,
    reordered: Object.fromEntries(Object.entries(added).reverse()),
  }).map(([shape, paths]) => ({ plan: `${name} ${shape}`, document: itemsDocument(paths) }));
});
const named = `import { defineApp, object, query, router, withApprovals } from "apps";
import { liveOpenapiRouter, openapiToolNames } from "apps/openapi";
import { always } from "apps/operations/approval";
const options = {
  source: { document: ${JSON.stringify(unnamedDocument)} },
  allowedOrigin: "https://ci.example.com",
  securitySchemes: { token: { type: "apiKey", in: "header", name: "x-token" } },
  methods: { apiKey: [{ scheme: "token", field: "token", part: "value", prefix: "" }] },
  oauth: [],
};
const common = { allowedOrigin: "https://ci.example.com", securitySchemes: {}, methods: {}, oauth: [] };
const plans = ${JSON.stringify(collisionPlans)};
const approvals = new Map([["project.deleteEnvvar", always()]]);
export default defineApp({}, async ({ cache, fetch, signal }) => ({
  tools: router({
    api: withApprovals(
      liveOpenapiRouter({ ...options, cache, fetch, signal }),
      (_, name) => approvals.get(name),
    ),
    names: query({ description: "Tool names", input: object({}) }, () =>
      openapiToolNames({ ...options, signal }),
    ),
    collisions: query({ description: "Tool names for each plan", input: object({}) }, async () => {
      const listings: Record<string, string[]> = {};
      for (const { plan, document } of plans) {
        const { tools, skipped } = await openapiToolNames({ ...common, source: { document } });
        listings[plan] = [
          ...tools.map((tool) => tool.method + " " + tool.path + " " + tool.name),
          ...skipped.map((left) => left.method + " " + left.path + " left out: " + left.code),
        ].sort();
      }
      return listings;
    }),
  }),
}));
`;

/**
 * Operations that accept one of several credentials, where some alternatives name a scheme the
 * app's securitySchemes leaves out or the definition never declares. Each router's account fills
 * one alternative.
 */
const alternatives = (origin: string) => {
  const json = { "application/json": { schema: { type: "object" } } };
  const get = (operationId: string, security: readonly Record<string, string[]>[]) => ({
    get: { operationId, security, responses: { "200": { description: "OK", content: json } } },
  });
  const oauth2 = {
    type: "oauth2",
    flows: {
      authorizationCode: {
        authorizationUrl: `${origin}/oauth/authorize`,
        tokenUrl: `${origin}/oauth/token`,
        scopes: { read: "Read" },
      },
    },
  };
  const definition = (schemes: Record<string, unknown>, paths: Record<string, unknown>) => ({
    openapi: "3.1.0",
    info: { title: "Alternatives", version: "1" },
    servers: [{ url: origin }],
    components: { securitySchemes: schemes },
    paths,
  });
  const botToken = { type: "apiKey", in: "header", name: "Authorization" };
  const queryKey = { type: "apiKey", in: "query", name: "key" };
  const basicAuth = { type: "http", scheme: "basic" };
  const options = {
    // The definition declares OAuth, but the app declares only the schemes its account fills.
    bot: {
      source: {
        document: definition(
          { botToken, queryKey, oauth: oauth2 },
          {
            "/channels": get("listChannels", [{ botToken: [] }, { oauth: ["read"] }]),
            // The first alternative pairs the query key with a scheme declared nowhere.
            "/guilds": get("listGuilds", [{ queryKey: [], session: [] }, { botToken: [] }]),
          },
        ),
      },
      securitySchemes: { botToken, queryKey },
      methods: {
        bot: [
          { scheme: "botToken", field: "token", part: "value", prefix: "Bot " },
          { scheme: "queryKey", field: "key", part: "value", prefix: "" },
        ],
      },
      oauth: [],
    },
    basic: {
      source: {
        document: definition(
          { basicAuth, oauth: oauth2 },
          { "/items": get("listItems", [{ basicAuth: [] }, { oauth: [] }]) },
        ),
      },
      securitySchemes: { basicAuth },
      methods: {
        basic: [
          { scheme: "basicAuth", field: "username", part: "username", prefix: "" },
          { scheme: "basicAuth", field: "password", part: "password", prefix: "" },
        ],
      },
      oauth: [],
    },
    // The definition itself names a scheme it never declares.
    posts: {
      source: {
        document: definition(
          { userOauth: oauth2 },
          {
            "/posts": get("listPosts", [{ userOauth: ["read"] }, { userToken: [] }]),
            "/admin": get("getAdmin", [{ userToken: [] }, { adminKey: [], userOauth: [] }]),
          },
        ),
      },
      securitySchemes: { userOauth: oauth2 },
      methods: {},
      oauth: ["userOauth"],
    },
  };
  const accounts = {
    bot: { method: "bot", fields: { token: "synthetic-bot", key: "synthetic-key" } },
    basic: { method: "basic", fields: { username: "synthetic-user", password: "synthetic-pass" } },
    posts: { method: "userOauth", fields: { access_token: "synthetic-access" } },
  };
  return `import { defineApp, object, query, router } from "apps";
import { liveOpenapiRouter, openapiToolNames } from "apps/openapi";
const options = ${JSON.stringify(options)};
const accounts = ${JSON.stringify(accounts)};
const allowedOrigin = ${JSON.stringify(origin)};
export default defineApp({}, async ({ cache, fetch, signal }) => ({
  tools: router({
    bot: liveOpenapiRouter({ ...options.bot, allowedOrigin, cache, fetch, signal, account: accounts.bot }),
    basic: liveOpenapiRouter({ ...options.basic, allowedOrigin, cache, fetch, signal, account: accounts.basic }),
    posts: liveOpenapiRouter({ ...options.posts, allowedOrigin, cache, fetch, signal, account: accounts.posts }),
    names: query({ description: "Tool names of each definition", input: object({}) }, async () => {
      const listings: Record<string, unknown> = {};
      for (const [name, settings] of Object.entries(options))
        listings[name] = await openapiToolNames({ ...settings, allowedOrigin, fetch, signal });
      return listings;
    }),
  }),
}));
`;
};

/**
 * Stripe's shape: an expandable field is an ID or the object, and the `x-expansionResources`
 * extension names the object with a `$ref` the converter leaves as written. Each account's
 * schemas are nested under its branch of the merged tool, which must not read the extension.
 */
const expandable = (origin: string) => {
  const customer = { $ref: "#/components/schemas/customer" };
  const expansion = { "x-expansionResources": { oneOf: [customer] } };
  const document = {
    openapi: "3.0.0",
    info: { title: "Charges", version: "1" },
    servers: [{ url: origin }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: {
        customer: { type: "object", properties: { id: { type: "string" } } },
        charge: {
          type: "object",
          properties: { customer: { anyOf: [{ type: "string" }, customer], ...expansion } },
        },
      },
    },
    paths: {
      "/v1/charges": {
        get: {
          operationId: "GetCharges",
          parameters: [{ name: "customer", in: "query", schema: { type: "string", ...expansion } }],
          responses: {
            "200": {
              description: "OK",
              content: { "application/json": { schema: { $ref: "#/components/schemas/charge" } } },
            },
          },
        },
      },
    },
  };
  return `import { accountRouter, defineApp, defineProvider, object, secrets, string } from "apps";
import { liveOpenapiRouter } from "apps/openapi";
const charges = defineProvider({
  name: "Charges fixture",
  auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) },
});
export default defineApp({ user: { accounts: { charges: charges.many() } } }, async ({ user, cache, fetch, signal }) => ({
  tools: await accountRouter(user?.accounts.charges ?? [], (account) => liveOpenapiRouter({
    source: { document: ${JSON.stringify(document)} },
    allowedOrigin: ${JSON.stringify(origin)},
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    methods: { key: [{ scheme: "bearerAuth", field: "token", part: "value", prefix: "" }] },
    oauth: [], cache, fetch, signal, account,
  }), { signal }),
}));
`;
};

layer(HostedLive, { excludeTestServices: true })("Live OpenAPI import", (it) => {
  it.effect(scenarios.liveOpenapiAlternatives.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const upstream = yield* credentialEchoUpstream;
        const app = yield* deployPublicApp(alternatives(upstream.origin));

        // Before an account connects, each operation with a met alternative lists the method that
        // meets it; the one whose every alternative names an undeclared scheme is left out.
        const listing = yield* app.call("names", "query", {});
        expect(listing.status, JSON.stringify(listing.body)).toBe(200);
        const names = yield* body(Schema.Record(Schema.String, OpenapiToolNames), listing);
        const tools = (name: string) =>
          names[name]?.tools.map((tool) => [tool.name, tool.methods, tool.public]);
        expect(tools("bot")).toEqual([
          ["channels.listChannels", ["bot"], false],
          ["guilds.listGuilds", ["bot"], false],
        ]);
        expect(tools("basic")).toEqual([["items.listItems", ["basic"], false]]);
        expect(tools("posts")).toEqual([["posts.listPosts", ["userOauth"], false]]);
        const reason =
          'Every security requirement names a scheme securitySchemes does not declare: "userToken", "adminKey". Declare and fill every scheme in one complete alternative (securitySchemes plus methods or oauth).';
        expect(names.bot?.skipped).toEqual([]);
        expect(names.basic?.skipped).toEqual([]);
        expect(names.posts?.skipped).toEqual([
          { name: "admin.getAdmin", method: "GET", path: "/admin", code: "auth_method", reason },
        ]);

        const listed = yield* app.tools;
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        const catalog = yield* body(Catalog, listed);
        expect(catalog.routers.filter((router) => router.error !== undefined)).toEqual([]);
        expect(
          catalog.items
            .map((tool) => tool.name)
            .filter((name) => name !== "names")
            .sort(),
        ).toEqual([
          "basic.items.listItems",
          "bot.channels.listChannels",
          "bot.guilds.listGuilds",
          "posts.posts.listPosts",
        ]);

        // Each call carries only the met alternative's credentials: the bot token, never the
        // query key paired with an undeclared scheme.
        const Echo = Schema.Struct({
          method: Schema.String,
          url: Schema.String,
          authorization: Schema.NullOr(Schema.String),
        });
        const call = (tool: string) =>
          app.call(tool, "query", {}).pipe(
            Effect.tap((response) =>
              Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
            ),
            Effect.flatMap((response) => body(Echo, response)),
          );
        expect(yield* call("bot.channels.listChannels")).toEqual({
          method: "GET",
          url: "/channels",
          authorization: "Bot synthetic-bot",
        });
        expect(yield* call("bot.guilds.listGuilds")).toEqual({
          method: "GET",
          url: "/guilds",
          authorization: "Bot synthetic-bot",
        });
        expect(yield* call("basic.items.listItems")).toEqual({
          method: "GET",
          url: "/items",
          authorization: `Basic ${Buffer.from("synthetic-user:synthetic-pass").toString("base64")}`,
        });
        expect(yield* call("posts.posts.listPosts")).toEqual({
          method: "GET",
          url: "/posts",
          authorization: "Bearer synthetic-access",
        });

        // Calling the left-out operation explains why, without sending a request.
        const admin = yield* app.call("posts.admin.getAdmin", "query", {});
        expect(admin.status, JSON.stringify(admin.body)).toBe(502);
        expect((yield* body(EvaluationFailed, admin)).failure).toEqual({
          source: "app",
          errorName: "OpenapiCompileError",
          code: "auth_method",
          message: `${reason} Left out: GET /admin. ${customTool}`,
        });
      }),
    ),
  );

  it.effect(scenarios.liveOpenapiDiagnostics.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const app = yield* deployPublicApp(diagnosed);
        const listed = yield* app.tools;
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        const catalog = yield* body(Catalog, listed);
        const routers = catalog.routers;
        const failure = (path: string) => routers.find((router) => router.path === path)?.error;

        // An allowed origin no operation uses names the origins they do use, and each operation.
        expect(failure("mail")).toMatchObject({
          errorName: "OpenapiCompileError",
          code: "no_supported_operations",
        });
        expect(failure("mail")?.message).toContain(
          "allowedOrigin https://www.example.com is not the origin of any operation. They resolve to https://mail.example.com.",
        );
        expect(failure("mail")?.message).toContain(
          "GET /mail/v1/users/{userId}/messages and 1 more (multiple_hosts:",
        );

        // An operation whose schema holds an unresolvable reference is left out; the rest import,
        // including an invalid schema without a reference.
        expect(failure("teams")).toBeUndefined();
        const teams = catalog.items.filter((tool) => tool.name.startsWith("teams."));
        expect(teams.map((tool) => tool.name)).toEqual(["teams.teams.listTeams"]);

        // Reading or calling the left-out tool names the invalid schema by its JSON Pointer and
        // the operation that reaches it.
        const pointer =
          "#/components/schemas/Team/allOf/1/properties/_embedded/properties/members/items";
        const leftOut = {
          source: "app",
          errorName: "OpenapiCompileError",
          code: "schema_keyword",
          message: `The schema at ${pointer} is invalid: "items" must be a schema, not an array, so the reference inside it cannot be resolved. Left out: GET /teams/{team}. ${customTool}`,
        };
        const read = yield* app.tool("teams.teams.getTeam");
        expect(read.status, JSON.stringify(read.body)).toBe(502);
        const evaluation = yield* body(EvaluationFailed, read);
        expect(evaluation.failure).toEqual(leftOut);
        expect(evaluation.message).toContain(pointer);
        const called = yield* app.call("teams.teams.getTeam", "query", {
          path: { team: "core" },
        });
        expect(called.status, JSON.stringify(called.body)).toBe(502);
        expect((yield* body(EvaluationFailed, called)).failure).toEqual(leftOut);

        // A malformed Swagger 2.0 definition is named by its JSON Pointer before it is upgraded.
        expect(failure("status")).toEqual({
          _tag: "HostEvaluationFailed",
          errorName: "OpenapiCompileError",
          code: "invalid_document",
          message:
            "The response at #/paths/~1status/get/responses/200 is invalid: Expected object.",
        });

        // When no operation can be called, each one says which authentication or response it
        // needs.
        expect(failure("jobs")).toMatchObject({
          errorName: "OpenapiCompileError",
          code: "no_supported_operations",
        });
        expect(failure("jobs")?.message).toContain(
          "GET /jobs (auth_method: None of its security requirements can be used to authenticate: client (oauth2 clientCredentials)); GET /jobs/events (event_stream: It responds with text/event-stream",
        );
        // It still offers a custom tool, for the operation that needs other authentication.
        expect(failure("jobs")?.message?.endsWith(customTool)).toBe(true);
      }),
    ),
  );

  it.effect(scenarios.liveOpenapiExtensions.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const upstream = yield* credentialEchoUpstream;
        const app = yield* deployPublicApp(expandable(upstream.origin));
        // Connecting from the app links the new account to its requirement for the caller.
        const connection = yield* body(
          Resource,
          yield* app.api.request(
            app.actors.owner,
            "POST",
            connectionsPath(app.path, "user", "charges"),
            {},
          ),
        );
        const account = yield* body(
          Resource,
          yield* app.api.request(
            app.actors.owner,
            "POST",
            `${app.organization}/connections/${connection.id}/submit`,
            { method: "key", label: "Synthetic charges", fields: { token: "synthetic-charges" } },
          ),
        );
        yield* Effect.addFinalizer(() =>
          app.api
            .request(app.actors.owner, "DELETE", `${app.organization}/accounts/${account.id}`)
            .pipe(Effect.orDie),
        );

        const listed = yield* app.tools;
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        expect((yield* body(Catalog, listed)).items.map((tool) => tool.name)).toEqual([
          "charges.getCharges",
        ]);
        // The extension is kept as the definition wrote it, outside the schemas that validate.
        const described = yield* app.tool("charges.getCharges");
        expect(described.status, JSON.stringify(described.body)).toBe(200);
        expect(JSON.stringify(described.body)).toContain(
          '"x-expansionResources":{"oneOf":[{"$ref":"#/components/schemas/customer"}]}',
        );
        const called = yield* app.call("charges.getCharges", "query", {
          accountId: account.id,
          input: { query: { customer: "cus_1" } },
        });
        expect(called.status, JSON.stringify(called.body)).toBe(200);
        expect(yield* body(Schema.Json, called)).toEqual({
          method: "GET",
          url: "/v1/charges?customer=cus_1",
          authorization: "Bearer synthetic-charges",
        });
      }),
    ),
  );

  it.effect(scenarios.liveOpenapi32.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const upstream = yield* openapi32Upstream;
        const app = yield* deployPublicApp(`import { defineApp } from "apps";
import { liveOpenapiRouter } from "apps/openapi";
export default defineApp({}, async ({ cache, fetch, signal }) => ({
  tools: liveOpenapiRouter({ cache, fetch, signal,
    source: { url: ${JSON.stringify(`${upstream.origin}/openapi.json`)} },
    allowedOrigin: ${JSON.stringify(upstream.origin)},
    // The definition's paths omit the project segment every route needs.
    pathPrefix: "/projects/{project}",
    securitySchemes: {}, methods: {}, oauth: [] }),
}));
`);
        const listed = yield* app.tools;
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        // Unnamed operations in one group are told apart by their paths, not hashes. QUERY is a
        // query; a method Executor cannot send is left out.
        const tools = (yield* body(Catalog, listed)).items;
        expect(tools.map((tool) => tool.name).sort()).toEqual([
          "artifacts.findArtifacts",
          "builds.getBuilds",
          "builds.getBuildsByBuildNum",
          "builds.searchBuilds",
          "events.getEvents",
        ]);
        expect(tools.every((tool) => tool.readOnly === true)).toBe(true);

        const call = (tool: string, input: unknown) =>
          app.call(tool, "query", input).pipe(
            Effect.tap((response) =>
              Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
            ),
            Effect.flatMap((response) => body(Recorded, response)),
          );
        const project = { project: "alpha" };
        expect(yield* call("builds.getBuilds", { path: project })).toEqual({
          method: "GET",
          url: "/projects/alpha/builds",
          body: "",
        });
        expect(
          yield* call("builds.getBuildsByBuildNum", { path: { ...project, build_num: 7 } }),
        ).toMatchObject({ method: "GET", url: "/projects/alpha/builds/7" });
        expect(
          yield* call("builds.searchBuilds", { path: project, body: { status: "failed" } }),
        ).toEqual({ method: "QUERY", url: "/projects/alpha/builds", body: '{"status":"failed"}' });
        expect(
          yield* call("artifacts.findArtifacts", {
            path: project,
            querystring: { filter: { name: "app log", tag: ["x", "y"] } },
          }),
        ).toMatchObject({
          method: "GET",
          url: "/projects/alpha/artifacts?name=app+log&tag=x&tag=y",
        });
        // JSON Lines are returned as their text, not parsed as one JSON value.
        const events = yield* app.call("events.getEvents", "query", { path: project });
        expect(events.status, JSON.stringify(events.body)).toBe(200);
        expect(yield* body(Schema.String, events)).toBe(jsonLines);
        expect((yield* upstream.requests).map((request) => request.method)).toEqual([
          "GET",
          "GET",
          "QUERY",
          "GET",
        ]);
      }),
    ),
  );

  it.effect(scenarios.liveOpenapiV1Documents.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const upstream = yield* requestEchoUpstream;
        const app = yield* deployPublicApp(`import { defineApp, object, query, router } from "apps";
import { liveOpenapiRouter, openapiToolNames } from "apps/openapi";
const options = {
  source: { document: ${JSON.stringify(v1Document(upstream.origin))} },
  allowedOrigin: ${JSON.stringify(upstream.origin)},
  securitySchemes: {}, methods: {}, oauth: [],
};
export default defineApp({}, async ({ cache, fetch, signal }) => ({
  tools: router({
    api: liveOpenapiRouter({ ...options, cache, fetch, signal }),
    names: query({ description: "Tool names", input: object({}) }, () =>
      openapiToolNames({ ...options, signal }),
    ),
  }),
}));
`);
        // Every operation v1 imported is a tool. Only the one that answers with nothing but an
        // event stream is not: a tool cannot return a stream.
        const listing = yield* app.call("names", "query", {});
        expect(listing.status, JSON.stringify(listing.body)).toBe(200);
        const { tools, skipped } = yield* body(OpenapiToolNames, listing);
        expect(skipped).toEqual([]);
        expect(tools.map((tool) => [tool.name, tool.method, tool.path])).toEqual([
          ["items.createItem", "POST", "/items"],
          ["items.copyItem", "POST", "/items/copy"],
          ["items.streamItems", "GET", "/items/stream"],
          ["search.searchItems", "GET", "/search?type=items"],
          ["items.getItems", "GET", "/items/{id}?view=full"],
          // Their names differ only in the stable hash of the whole path.
          ["docs.readDocsGet00jgt2p1", "GET", "/docs#latest"],
          ["docs.readDocsGet00ru2ttw", "GET", "/docs#archive"],
          ["legacy.postLegacy", "POST", "/legacy"],
        ]);

        const Echo = Schema.Struct({
          method: Schema.String,
          url: Schema.String,
          accept: Schema.NullOr(Schema.String),
          body: Schema.String,
        });
        const call = (tool: string, kind: "query" | "mutation", input: unknown) =>
          app.call(`api.${tool}`, kind, input).pipe(
            Effect.tap((response) =>
              Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
            ),
            Effect.flatMap((response) => body(Echo, response)),
          );
        const rejected = (tool: string, kind: "query" | "mutation", input: unknown) =>
          app
            .call(`api.${tool}`, kind, input)
            .pipe(
              Effect.tap((response) =>
                Effect.sync(() =>
                  expect(response.status, `${tool}: ${JSON.stringify(response.body)}`).not.toBe(
                    200,
                  ),
                ),
              ),
            );

        // A reference into another component's properties validates the input as its target.
        expect(
          yield* call("items.createItem", "mutation", { body: { owner: { name: "Ada" } } }),
        ).toMatchObject({ method: "POST", url: "/items", body: '{"owner":{"name":"Ada"}}' });
        yield* rejected("items.createItem", "mutation", { body: { owner: {} } });
        // So do a request body that reuses another operation's schema and a parameter schema
        // that points into a Parameter Object.
        expect(
          yield* call("items.copyItem", "mutation", {
            query: { max: 2 },
            body: { owner: { name: "Ada" } },
          }),
        ).toMatchObject({ method: "POST", url: "/items/copy?max=2" });
        yield* rejected("items.copyItem", "mutation", {
          query: { max: 0 },
          body: { owner: { name: "Ada" } },
        });
        yield* rejected("items.copyItem", "mutation", { body: { owner: { title: "Ada" } } });
        // The response refers to a component whose name is not URI-encoded; its schema is read.
        const described = yield* app.tool("api.items.createItem");
        expect(described.status, JSON.stringify(described.body)).toBe(200);
        expect(JSON.stringify(described.body)).toContain('"required":["id"]');

        // The operation that can also answer with JSON asks for JSON only.
        expect(yield* call("items.streamItems", "query", {})).toEqual({
          method: "GET",
          url: "/items/stream",
          accept: "application/json",
          body: "",
        });
        // A path's fixed query is sent with the operation's own; its fragment is not sent.
        expect(yield* call("search.searchItems", "query", { query: { q: "lamp" } })).toMatchObject({
          method: "GET",
          url: "/search?type=items&q=lamp",
        });
        expect(yield* call("items.getItems", "query", { path: { id: "a1" } })).toMatchObject({
          method: "GET",
          url: "/items/a1?view=full",
        });
        for (const docs of ["docs.readDocsGet00jgt2p1", "docs.readDocsGet00ru2ttw"])
          expect(yield* call(docs, "query", {})).toMatchObject({ method: "GET", url: "/docs" });
        // An empty operationId is no operationId. The parameter in `body` and the request body
        // without media types are not inputs, as v1 dropped them.
        expect(yield* call("legacy.postLegacy", "mutation", { query: { q: "old" } })).toEqual({
          method: "POST",
          url: "/legacy?q=old",
          accept: "application/json",
          body: "",
        });
        yield* rejected("legacy.postLegacy", "mutation", { body: {} });
      }),
    ),
  );

  it.effect(scenarios.liveOpenapiNaming.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const app = yield* deployPublicApp(named);
        const listed = yield* app.tools;
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        const names = (yield* body(Catalog, listed)).items
          .map((tool) => tool.name)
          .filter((name) => name.startsWith("api."));
        // Released names stay: an operation without an operationId drops its path parameters, so
        // the single item reads like a list.
        expect(names.sort()).toEqual([
          "api.project.deleteEnvvar",
          "api.project.getEnvvar",
          "api.project.getProject",
          "api.projects.getProjects",
        ]);

        // The definition alone lists the tools the router exposes and the accounts that expose
        // each, including the one this router cannot list without an account.
        const listing = yield* app.call("names", "query", {});
        expect(listing.status, JSON.stringify(listing.body)).toBe(200);
        const { tools, skipped } = yield* body(OpenapiToolNames, listing);
        expect(
          tools
            .filter((tool) => tool.public)
            .map((tool) => `api.${tool.name}`)
            .sort(),
        ).toEqual(names);
        expect(tools).toEqual(
          [
            ["projects.getProjects", "GET", "/projects", "query"],
            ["project.getProject", "GET", "/project/{username}/{project}", "query"],
            ["project.getEnvvar", "GET", "/project/{username}/{project}/envvar/{name}", "query"],
            [
              "project.deleteEnvvar",
              "DELETE",
              "/project/{username}/{project}/envvar/{name}",
              "mutation",
            ],
          ]
            .map(([name, method, path, kind]) => ({
              name,
              method,
              path,
              kind,
              public: true,
              methods: ["apiKey"],
            }))
            .concat({
              name: "project.postBuild",
              method: "POST",
              path: "/project/{username}/{project}/build",
              kind: "mutation",
              public: false,
              methods: ["apiKey"],
            }),
        );
        expect(skipped).toEqual([]);

        // Released collision handling stays: adding a colliding sibling refines both names, in
        // either order.
        const collided = yield* app.call("collisions", "query", {});
        expect(collided.status, JSON.stringify(collided.body)).toBe(200);
        const status = "GET /status status.getStatus";
        const released = {
          version: [
            "GET /v1/items items.getItems",
            ["GET /v1/items items.v1.getItems", "GET /v2/items items.v2.getItems"],
          ],
          parameter: [
            "GET /orgs/{org}/items orgs.getItems",
            ["GET /orgs/items orgs.getItems", "GET /orgs/{org}/items orgs.getItemsByOrg"],
          ],
          operationId: [
            "GET /items/{id} items.getItems",
            ["GET /items/lookup items.getItemsById", "GET /items/{id} items.getItems"],
          ],
        } as const;
        const expected: Record<string, readonly string[]> = {};
        for (const [name, [alone, added]] of Object.entries(released)) {
          expected[`${name} alone`] = [alone, status].sort();
          expected[`${name} added`] = [status, ...added].sort();
          expected[`${name} reordered`] = [status, ...added].sort();
        }
        expect(collided.body).toEqual(expected);

        // An approval policy keyed by a listed name applies before any request is sent.
        const deleted = yield* app.call("api.project.deleteEnvvar", "mutation", {
          path: { username: "octo", project: "demo", name: "TOKEN" },
        });
        expect(deleted.status, JSON.stringify(deleted.body)).toBe(409);
        expect(deleted.body).toMatchObject({ _tag: "ToolApprovalRequired" });
      }),
    ),
  );
});
