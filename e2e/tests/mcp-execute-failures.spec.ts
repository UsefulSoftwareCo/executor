/** Failed and timed-out MCP executions report what happened instead of losing it. */
import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Clock, Effect, Layer, Ref, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { mcpProtocolUpstream } from "../support/mcp-protocol-upstream.ts";
import { requestGate } from "../support/request-gate.ts";

import { appsManifest, withApps } from "../support/apps-release.ts";

// A refresh that runs until its 30 s background limit unless cancelled.
const slowRefresh = `const slowRefresh = (signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, 60_000);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(undefined); }, { once: true });
});
const swr = { key: "swr", schema: string(), freshFor: 0, staleFor: "10 minutes" };`;

// `seed` caches a value that is stale at once; `stale` serves it and keeps refreshing it after the
// call returns. `approved` needs approval before it runs.
const slowAppSource = `import { defineApp, query, mutation, object, string, router } from "apps";
import { always } from "apps/operations/approval";
${slowRefresh}
export default defineApp({ accounts: {} }, async (ctx) => ({
  tools: router({
    seed: query({ input: object({}) }, async () => ctx.cache.get({ ...swr, load: async () => "seed" })),
    stale: query({ input: object({}) }, async () => ctx.cache.get({ ...swr, load: async ({ signal }) => {
      await slowRefresh(signal);
      return "refreshed";
    } })),
    approved: mutation({ input: object({}), approval: always() }, async () => ({ ran: true })),
  }),
}));`;

// The second read serves the cached value and starts a refresh that outlasts the result.
const refreshAppSource = `import { defineApp, query, object, string, router } from "apps";
${slowRefresh}
export default defineApp({ accounts: {} }, async (ctx) => ({ tools: router({
   seed: query({ input: object({}) }, async () => ctx.cache.get({ ...swr, load: async () => "seed" })),
  stale: query({ input: object({}) }, async () => ctx.cache.get({ ...swr, load: async ({ signal }) => {
    await slowRefresh(signal);
    return "refreshed";
  } })),
 }) }));`;

// A required account that nobody has selected keeps the app out of the catalog.
const accountAppSource = `import { defineApp, defineProvider, secrets, object, string, query, router } from "apps";
const service = defineProvider({ name: "Unselected fixture", auth: { key: secrets({ label: "API key", fields: object({ token: string() }) }) } });
export default defineApp({ accounts: { service } }, async () => ({ tools: router({
   read: query({ input: object({}), description: "Read an item" }, async () => "item"),
 }) }));`;

// An error with no message whose own fields say what went wrong, as a spec compiler throws it.
const specInvalid = `class SpecInvalid extends Error {
  constructor() {
    super("");
    this.name = "SpecInvalid";
    this.code = "server_url";
    this.reason = "Server URLs must use HTTPS";
    this.pointer = "/servers/0/url";
  }
}`;

// The factory throws, so the whole app is unavailable.
const throwingAppSource = `import { defineApp } from "apps";
${specInvalid}
export default defineApp({ accounts: {} }, async () => {
  throw new SpecInvalid();
});`;

// Only one nested router throws; the rest of the app loads.
const throwingRouterSource = `import { defineApp, dynamicRouter, object, query, router } from "apps";
${specInvalid}
export default defineApp({ accounts: {} }, async () => ({
  tools: router({
    ping: query({ input: object({}), description: "Answer pong" }, async () => "pong"),
    spec: dynamicRouter({
      list: async () => {
        throw new SpecInvalid();
      },
      resolve: async () => undefined,
    }),
  }),
}));`;

/** What a server says when it refuses a client it has not enabled, with a link to fix it. */
const refusal =
  "App is not enabled for MCP server access. Enable it in the app settings: https://mcp.example.test/apps/settings";

/** What a server says when a tool rejects its arguments. */
const invalidArguments = "Invalid arguments for tool lookup: item is required";

/**
 * Which requests the server answers with a JSON-RPC error: every request with HTTP 400, tool calls
 * with HTTP 400, the session a tool call opens with HTTP 400, or tool calls inside a successful
 * response. Only a tool call's session offers elicitation, so its initialize is told apart by that.
 */
type Refusal = "everything" | "tool-calls" | "call-sessions" | "tool-arguments";

/** The JSON-RPC fields this fixture reads. */
const JsonRpcRequest = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
  params: Schema.optional(
    Schema.Struct({
      protocolVersion: Schema.optional(Schema.String),
      capabilities: Schema.optional(
        Schema.Struct({ elicitation: Schema.optional(Schema.Unknown) }),
      ),
    }),
  ),
});

/** An MCP server with one `lookup` tool that refuses the requests `refuse` selects. */
const refusingMcpServer = Effect.gen(function* () {
  const refuses = yield* Ref.make<Refusal>("everything");
  const answer = (id: string | number | null, body: object, status = 200) =>
    HttpServerResponse.json({ jsonrpc: "2.0", id, ...body }, { status });
  const refused = (id: string | number | null) =>
    answer(id, { error: { code: -32600, message: refusal } }, 400);
  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const refusing = yield* Ref.get(refuses);
    if (refusing === "everything") return yield* refused(null);
    if (request.method !== "POST") return HttpServerResponse.empty({ status: 405 });
    const message = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonRpcRequest))(
      yield* request.text,
    );
    if (message.id === undefined) return HttpServerResponse.empty({ status: 202 });
    switch (message.method) {
      case "initialize":
        if (refusing === "call-sessions" && message.params?.capabilities?.elicitation !== undefined)
          return yield* refused(message.id);
        return yield* answer(message.id, {
          result: {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "Refusing fixture", version: "1.0.0" },
          },
        });
      case "tools/list":
        return yield* answer(message.id, {
          result: {
            tools: [
              { name: "lookup", description: "Look up an item", inputSchema: { type: "object" } },
            ],
          },
        });
      case "tools/call":
        if (refusing === "tool-calls") return yield* refused(message.id);
        if (refusing === "tool-arguments")
          return yield* answer(message.id, {
            error: { code: -32602, message: invalidArguments },
          });
        return yield* answer(message.id, {
          result: { content: [{ type: "text", text: "found" }] },
        });
      default:
        return yield* answer(message.id, {
          error: { code: -32601, message: "Method not found" },
        });
    }
  });
  const services = yield* Layer.build(
    HttpRouter.serve(HttpRouter.add("*", "/mcp", handler), {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  return {
    url: `http://127.0.0.1:${server.address.port}/mcp`,
    refuse: (requests: Refusal) => Ref.set(refuses, requests),
  };
});

/** An app whose only tools come from the MCP server at `url`. */
const mcpAppFiles = (url: string) => [
  {
    path: "package.json",
    content: JSON.stringify({
      dependencies: withApps({
        "@modelcontextprotocol/client": "2.0.0",
        "@modelcontextprotocol/core": "2.0.0",
      }),
    }),
  },
  {
    path: "index.ts",
    content: `import { defineApp } from "apps";
import { mcpRouter } from "apps/mcp";
export default defineApp({ accounts: {} }, async () => ({ tools: await mcpRouter({ url: ${JSON.stringify(url)} }) }));`,
  },
];

/** The safe JSON projection MCP puts in an unavailable app's reason. */
const Diagnostic = Schema.fromJsonString(
  Schema.Struct({ code: Schema.String, status: Schema.Number, message: Schema.String }),
);

// A nested authored object, as agents most often misplace a field inside one. The optional
// object decodes as a union with an absent value. `tree` nests its whole input, union included,
// through a `$recursiveRef`. `pick` fixes an authored literal and an imported enum longer than
// a problem lists.
const pickColors = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "indigo",
  "violet",
  "black",
  "white",
  "gray",
  "teal",
  "pink",
];
const inputAppSource = `import { defineApp, query, object, string, number, literal, jsonSchema, router } from "apps";
export default defineApp({ accounts: {} }, async () => ({ tools: router({
  find: query({ input: object({ query: object({ text: string(), limit: number().default(10) }), filter: object({ tag: string() }).optional() }) }, async (_, input) => input.query.text),
  tree: query({ input: jsonSchema({ $schema: "https://json-schema.org/draft/2019-09/schema", $recursiveAnchor: true, type: "object", properties: { child: { $recursiveRef: "#" } }, anyOf: [{ required: ["name"] }, { required: ["id"] }] }) }, async () => "tree"),
  pick: query({ input: object({ version: literal("v1"), color: jsonSchema({ type: "string", enum: ${JSON.stringify(pickColors)} }) }) }, async (_, input) => input.color),
  policy: query({ input: jsonSchema({ type: "object", required: ["policyId"], properties: { policyId: { type: "string" }, slug: { type: "string", pattern: "^[a-z-]+$" }, limit: { type: "integer", minimum: 1, maximum: 50 } } }) }, async () => "policy"),
  account: query({ input: jsonSchema({ type: "object", required: ["userId"], properties: { userId: { type: "string" }, user_id: { type: "string" }, count: { type: "number", minimum: 5, exclusiveMinimum: true } } }) }, async () => "account"),
  user: query({ input: object({ userId: string(), user_id: string().optional() }) }, async () => "user"),
  loose: query({ input: jsonSchema({ type: "object", required: ["ref", "closed", "strict", "either"], properties: { ref: { properties: { id: { type: "string" } }, required: ["id"] }, closed: { additionalProperties: false }, strict: { properties: { id: { type: "string" } }, required: ["id"], minLength: 5 }, either: { oneOf: [{ properties: { a: { type: "string" } }, required: ["a"] }, { properties: { b: { type: "string" } }, required: ["b"] }] } } }) }, async () => "loose"),
  same: query({ input: jsonSchema({ type: "object", required: ["value"], properties: { value: { oneOf: [{ const: "x" }, { const: "x" }] } } }) }, async () => "same"),
  overlap: query({ input: jsonSchema({ type: "object", required: ["value"], properties: { value: { oneOf: [{ enum: ["a", "b"] }, { enum: ["b", "c"] }] } } }) }, async () => "overlap"),
  bounded: query({ input: jsonSchema({ type: "object", required: ["value"], properties: { value: { enum: ["a", "b", "c"], oneOf: [{ enum: ["a", "b"] }, { enum: ["b", "c"] }] } } }) }, async () => "bounded"),
}) }));`;

// `remove` declares a policy that denies every call, as an app that never lets agents delete.
const deniedAppSource = `import { defineApp, mutation, object, string, router } from "apps";
export default defineApp({ accounts: {} }, async () => ({ tools: router({
  remove: mutation({ input: object({ id: string() }), approval: () => "denied" }, async () => "removed"),
}) }));`;

/** The recovery a caught tool error carries as JSON, as an agent program reads it. */
const CaughtRecovery = Schema.fromJsonString(
  Schema.Struct({
    code: Schema.String,
    status: Schema.Number,
    message: Schema.String,
    recovery: Schema.Struct({ action: Schema.String, instructions: Schema.String }),
  }),
);

/** The recovery an uncaught tool error carries in the execute response. */
const UncaughtRecovery = Schema.Struct({
  execution: Schema.Struct({
    error: Schema.Struct({
      response: Schema.Struct({
        recovery: Schema.Struct({ action: Schema.String, instructions: Schema.String }),
      }),
    }),
  }),
});

const Failed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      kind: Schema.String,
      message: Schema.String,
      response: Schema.optional(Schema.Struct({ code: Schema.String, status: Schema.Number })),
    }),
  }),
  unavailableApps: Schema.Array(
    Schema.Struct({
      app: Schema.String,
      reason: Schema.String,
      router: Schema.optional(Schema.String),
    }),
  ),
});

/** The thrown error's name, code and fields reach the agent, not only that evaluation failed. */
const expectThrownDetail = (text: string) => {
  expect(text).toContain("The app threw SpecInvalid (server_url)");
  expect(text).toContain('reason: "Server URLs must use HTTPS"');
  expect(text).toContain('pointer: "/servers/0/url"');
};

const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Struct({ kind: Schema.String, message: Schema.String })),
    logs: Schema.optional(Schema.Array(Schema.String)),
  }),
});

const Pending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
});

type Connected = Effect.Success<ReturnType<Effect.Success<typeof McpClient>["connect"]>>;

/** Run one execute and return its decoded completed result with the client's elapsed time. */
const executeOnce = (client: Connected, label: string, code: string, file: string) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence;
    const started = yield* Clock.currentTimeMillis;
    const result = yield* client.use(label, (client, signal) =>
      client.callTool({ name: "execute", arguments: { code } }, undefined, {
        signal,
        timeout: 55_000,
      }),
    );
    const elapsed = (yield* Clock.currentTimeMillis) - started;
    yield* evidence.json(file, { elapsed, result: result.structuredContent });
    return { elapsed, structured: result.structuredContent };
  });

/** A program that finishes returns at once, even when a tool left a background refresh running. */
const checkRefreshNotAwaited = (client: Connected, slug: string) =>
  Effect.gen(function* () {
    const app = `tools[${JSON.stringify(slug)}]`;
    const seeded = yield* executeOnce(
      client,
      "Cache a value that is immediately stale",
      `return await ${app}.seed({});`,
      "refresh-seed.json",
    );
    expect(yield* Schema.decodeUnknownEffect(Completed)(seeded.structured)).toMatchObject({
      execution: { ok: true, value: "seed" },
    });
    const served = yield* executeOnce(
      client,
      "Read the stale value while its refresh keeps running",
      `const value = await ${app}.stale({});
console.log("served", value);
return value;`,
      "refresh-served.json",
    );
    const completed = yield* Schema.decodeUnknownEffect(Completed)(served.structured);
    // The program's own result is returned, not a timeout caused by the refresh.
    expect(completed.execution.error).toBeUndefined();
    expect(completed.execution).toMatchObject({ ok: true, value: "seed" });
    expect(completed.execution.logs ?? []).toContainEqual(expect.stringContaining("served seed"));
    // The refresh runs for up to 30 s after the result; the result does not wait for it.
    expect(served.elapsed).toBeLessThan(10_000);
  });

/**
 * An approval is requested as soon as the call asks for it, even while an earlier call's cache
 * refresh keeps running in the background. Approving it runs the mutation.
 */
const checkApprovalAfterRefresh = (client: Connected, slug: string) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence;
    const app = `tools[${JSON.stringify(slug)}]`;
    const parked = yield* executeOnce(
      client,
      "Ask for approval after a read that leaves a cache refresh running",
      `await ${app}.seed({});
const value = await ${app}.stale({});
console.log("served", value);
return await ${app}.approved({});`,
      "approval-after-refresh.json",
    );
    const pending = yield* Schema.decodeUnknownEffect(Pending)(parked.structured);
    // The refresh runs for up to 30 s; the approval request does not wait for it.
    expect(parked.elapsed).toBeLessThan(10_000);
    const started = yield* Clock.currentTimeMillis;
    const resumed = yield* client.use("Approve the mutation", (client, signal) =>
      client.callTool(
        {
          name: "resume",
          arguments: { requestId: pending.requestId, response: { action: "accept" } },
        },
        undefined,
        { signal, timeout: 55_000 },
      ),
    );
    const elapsed = (yield* Clock.currentTimeMillis) - started;
    yield* evidence.json("approval-after-refresh-resumed.json", {
      elapsed,
      result: resumed.structuredContent,
    });
    const completed = yield* Schema.decodeUnknownEffect(Completed)(resumed.structuredContent);
    expect(completed.execution).toMatchObject({ ok: true, value: { ran: true } });
    expect(completed.execution.logs ?? []).toContainEqual(expect.stringContaining("served seed"));
    expect(elapsed).toBeLessThan(10_000);
  });

/** Deploy an app in the hosted organization and connect a PAT MCP client to it. */
const hostedApp = (name: string, source: string) =>
  hostedAppFiles(name, [{ path: "index.ts", content: source }, appsManifest]);

/** Deploy these files as a hosted app and connect a PAT MCP client to it. */
const hostedAppFiles = (
  name: string,
  files: ReadonlyArray<{ readonly path: string; readonly content: string }>,
) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      mcp = yield* McpClient;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const key = yield* body(
      Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
      yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", { name }),
    );
    const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: `${name} ${randomUUID().slice(0, 8)}`,
      files,
    });
    expect(deployed.status).toBe(200);
    const app = yield* body(App, deployed);
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* api.request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id });
        yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`);
      }).pipe(Effect.orDie),
    );
    const client = yield* mcp.connect(key.key, name.toLowerCase().replaceAll(" ", "-"), {
      organization: actors.organization.id,
    });
    return { client, slug: app.slug, id: app.id, path: `${prefix}/apps/${app.id}` };
  });

layer(HostedLive, { excludeTestServices: true })("Hosted MCP execute failures", (it) => {
  it.effect(scenarios.mcpExecuteApprovalAfterRefresh.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { client, slug } = yield* hostedApp("Approval after refresh", slowAppSource);
        yield* checkApprovalAfterRefresh(client, slug);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.mcpExecuteRefreshNotAwaited.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { client, slug } = yield* hostedApp("Background refresh", refreshAppSource);
        yield* checkRefreshNotAwaited(client, slug);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.mcpExecuteUnavailableApp.title, (context) =>
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
            name: "Unavailable app",
          }),
        );
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Needs account ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: accountAppSource }, appsManifest],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id });
            yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`);
          }).pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "unavailable-app", {
          organization: actors.organization.id,
        });
        const root = `tools[${JSON.stringify(app.slug)}]`;
        const call = (label: string, file: string, code: string) =>
          Effect.gen(function* () {
            const result = yield* client.use(label, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            );
            yield* evidence.json(file, result.structuredContent);
            const failed = yield* Schema.decodeUnknownEffect(Failed)(result.structuredContent);
            const reason = failed.unavailableApps.find((entry) => entry.app === app.id)?.reason;
            return { error: failed.execution.error, reason };
          });
        // Without a profile, a call into the app says why instead of reporting an unknown tool.
        const unprofiled = yield* call(
          "Call a tool of an account app that has no profile",
          "no-profile-result.json",
          `return await ${root}.read({});`,
        );
        // An app nobody has set up is not listed on every execute; only a call into it reports it.
        expect(unprofiled.reason).toBeUndefined();
        expect(unprofiled.error.kind).toBe("ToolFailure");
        expect(unprofiled.error.response?.code).toBe("AppProfileRequired");
        expect(unprofiled.error.message).toContain("you have no enabled profile for it");
        const profile = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${app.id}/profiles`,
          { accounts: {}, idempotencyKey: randomUUID() },
        );
        expect(profile.status).toBe(200);
        const { id } = yield* body(Schema.Struct({ id: Schema.String }), profile);
        // With a profile but no selected account, the SDK's curated error reaches the caller.
        const unselected = yield* call(
          "Call a tool of an app whose account is not selected",
          "unselected-result.json",
          `return await ${root}.profiles[${JSON.stringify(id)}].read({});`,
        );
        expect(unselected.reason ?? "").toContain(
          "This app needs an account that has not been selected yet.",
        );
        expect(unselected.error.kind).toBe("ToolFailure");
        expect(unselected.error.response?.code).toBe("AccountRequired");
        expect(unselected.error.message).toContain("Open Accounts");
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  for (const [scenario, route] of [
    [scenarios.mcpFallbackRefused, "missing"],
    [scenarios.mcpSessionLost, "session-loss"],
  ] as const) {
    it.effect(scenario.title, (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            mcp = yield* McpClient,
            evidence = yield* Evidence;
          const upstream = yield* mcpProtocolUpstream();
          const prefix = `/api/organizations/${actors.organization.id}`;
          const key = yield* body(
            Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
            yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
              name: "Refused MCP server",
            }),
          );
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Moved MCP ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "package.json",
                content: JSON.stringify({
                  dependencies: withApps({
                    "@modelcontextprotocol/client": "2.0.0",
                    "@modelcontextprotocol/core": "2.0.0",
                  }),
                }),
              },
              {
                path: "index.ts",
                content: `import { defineApp, router } from "apps";
import { mcpRouter } from "apps/mcp";
export default defineApp({ accounts: {} }, async () => ({ tools: await mcpRouter({ url: ${JSON.stringify(`${upstream.origin}/${route}?private=credential-sentinel`)} }) }));`,
              },
            ],
          });
          expect(deployed.status).toBe(200);
          const app = yield* body(App, deployed);
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              yield* api.request(actors.owner, "POST", "/api/auth/api-key/delete", {
                keyId: key.id,
              });
              yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`);
            }).pipe(Effect.orDie),
          );
          const client = yield* mcp.connect(key.key, "refused-mcp", {
            organization: actors.organization.id,
          });
          const code = `return await tools[${JSON.stringify(app.slug)}].anything({});`;
          const started = yield* Clock.currentTimeMillis;
          const result = yield* client.use(
            "Call a tool of an app whose MCP server refuses connections",
            (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
          );
          const elapsed = (yield* Clock.currentTimeMillis) - started;
          yield* evidence.json("refused-result.json", {
            elapsed,
            result: result.structuredContent,
          });
          const failed = yield* Schema.decodeUnknownEffect(Failed)(result.structuredContent);
          const reason = failed.unavailableApps.find((entry) => entry.app === app.id)?.reason ?? "";
          // The MCP server's refusal is named, instead of a generic tool-definition failure.
          expect(reason).toContain("refused the request while connecting (HTTP 404)");
          expect(failed.execution.error.kind).toBe("ToolFailure");
          expect(failed.execution.error.message).toContain("HTTP 404");
          expect(failed.execution.error.message).toContain(
            "Legacy SSE fallback also failed (HTTP 405)",
          );
          expect(
            failed.execution.error.message.includes("session failed after initialization"),
          ).toBe(route === "session-loss");
          expect(JSON.stringify(result.structuredContent)).not.toContain("credential-sentinel");
          expect(JSON.stringify(result.structuredContent)).not.toContain("upstream-body-secret");
          yield* evidence.json("refused-upstream-requests.json", upstream.requests);
          expect(
            upstream.requests.some((request) => request.method === "GET" && request.status === 405),
          ).toBe(true);
          if (route === "session-loss") {
            expect(
              upstream.requests.some(
                (request) => request.method === "initialize" && request.status === 200,
              ),
            ).toBe(true);
            expect(
              upstream.requests.some(
                (request) =>
                  request.method === "notifications/initialized" && request.status === 404,
              ),
            ).toBe(true);
          }
          // A deterministic refusal fails without waiting for a connection timeout.
          expect(elapsed).toBeLessThan(10_000);
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    );
  }
  it.effect(scenarios.mcpExecuteAppThrew.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const whole = yield* hostedApp("Throwing app", throwingAppSource);
        // The HTTP error keeps the thrown error's name, code and fields as data.
        const index = yield* api.request(actors.owner, "GET", `${whole.path}/tools/index`);
        expect(index.status).toBe(502);
        const failure = yield* body(
          Schema.Struct({
            _tag: Schema.Literal("AppEvaluationFailed"),
            message: Schema.String,
            failure: Schema.Struct({
              source: Schema.String,
              errorName: Schema.String,
              code: Schema.optional(Schema.String),
              fields: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
            }),
          }),
          index,
        );
        expect(failure.failure).toMatchObject({
          source: "app",
          errorName: "SpecInvalid",
          code: "server_url",
          fields: { reason: "Server URLs must use HTTPS", pointer: "/servers/0/url" },
        });
        expectThrownDetail(failure.message);
        // A call into the app reports the same detail, both in the diagnostic and the error.
        const root = yield* executeOnce(
          whole.client,
          "Call a tool of an app whose factory threw",
          `return await tools[${JSON.stringify(whole.slug)}].anything({});`,
          "app-threw-result.json",
        );
        const failedRoot = yield* Schema.decodeUnknownEffect(Failed)(root.structured);
        const rootReason = failedRoot.unavailableApps.find((entry) => entry.app === whole.id);
        if (rootReason === undefined) return yield* Effect.die("The app was not reported");
        const rootDiagnostic = yield* Schema.decodeUnknownEffect(Diagnostic)(rootReason.reason);
        expect(rootDiagnostic.code).toBe("AppEvaluationFailed");
        expectThrownDetail(rootDiagnostic.message);
        expectThrownDetail(failedRoot.execution.error.message);

        // A nested router that throws is reported at its own namespace with the same detail.
        const nested = yield* hostedApp("Throwing router", throwingRouterSource);
        const searched = yield* executeOnce(
          nested.client,
          "Search an app whose nested router threw",
          `return await tools.search({ query: "pong", namespace: ${JSON.stringify(nested.slug)} });`,
          "router-threw-search.json",
        );
        const search = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
            unavailableApps: Failed.fields.unavailableApps,
          }),
        )(searched.structured);
        expect(JSON.stringify(search.execution.value)).toContain(".ping");
        const routerReason = search.unavailableApps.find(
          (entry) => entry.app === nested.id && entry.router === "spec",
        );
        if (routerReason === undefined) return yield* Effect.die("The router was not reported");
        const routerDiagnostic = yield* Schema.decodeUnknownEffect(Diagnostic)(routerReason.reason);
        expect(routerDiagnostic.code).toBe("AppEvaluationFailed");
        expectThrownDetail(routerDiagnostic.message);
        const called = yield* executeOnce(
          nested.client,
          "Call a tool under the router that threw",
          `return await tools[${JSON.stringify(nested.slug)}].spec.anything({});`,
          "router-threw-call.json",
        );
        expectThrownDetail(
          (yield* Schema.decodeUnknownEffect(Failed)(called.structured)).execution.error.message,
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.mcpExecuteInputShape.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { client, slug } = yield* hostedApp("Input shape", inputAppSource);
        const rejected = yield* executeOnce(
          client,
          "Pass the query text in place of the query object",
          `return await tools[${JSON.stringify(slug)}].find({query: "fixture text"});`,
          "input-shape-result.json",
        );
        const { error } = (yield* Schema.decodeUnknownEffect(Failed)(rejected.structured))
          .execution;
        // The problem names the keys the object takes; the supplied text is not echoed.
        expect(error.message).toBe(
          "InputInvalid (HTTP 422): Input failed validation: input.query: Expected object {text, limit?} Recovery: Change the input to the shape each problem expects, then call the tool again.",
        );
        const optional = yield* executeOnce(
          client,
          "Pass the filter text in place of the optional filter object",
          `return await tools[${JSON.stringify(slug)}].find({query: {text: "fixture text"}, filter: "fixture filter"});`,
          "input-shape-optional-result.json",
        );
        // An optional object is described by its keys, not as a union with undefined.
        expect(
          (yield* Schema.decodeUnknownEffect(Failed)(optional.structured)).execution.error.message,
        ).toBe(
          "InputInvalid (HTTP 422): Input failed validation: input.filter: Expected object {tag} Recovery: Change the input to the shape each problem expects, then call the tool again.",
        );
        const nested = yield* executeOnce(
          client,
          "Pass a nested tree node that names neither alternative's key",
          `return await tools[${JSON.stringify(slug)}].tree({name: "fixture root", child: {label: "fixture child"}});`,
          "input-shape-recursive-result.json",
        );
        // A union reached through a recursive reference is described like any other.
        expect(
          (yield* Schema.decodeUnknownEffect(Failed)(nested.structured)).execution.error.message,
        ).toBe(
          "InputInvalid (HTTP 422): Input failed validation: input.child: Expected object {child?, name, ...} or object {child?, id, ...}. Closest is alternative 1, whose problems follow; input.child.name: Missing key Recovery: Change the input to the shape each problem expects, then call the tool again.",
        );
        // Fixed values are listed, as the signature shows them: a literal quoted, and an enum up
        // to ten values before the rest are counted. Each call fails on its one wrong field.
        const values = yield* executeOnce(
          client,
          "Pass a wrong literal version, then a color outside the enum",
          `const messages = [];
for (const input of [{version: "v2", color: "red"}, {version: "v1", color: "fixture color"}]) {
  try { await tools[${JSON.stringify(slug)}].pick(input); } catch (error) { messages.push(JSON.parse(error.message).message); }
}
return messages;`,
          "input-shape-values-result.json",
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Completed)(values.structured)).execution.value,
        ).toEqual([
          'Input failed validation: input.version: Expected "v1"',
          'Input failed validation: input.color: Expected one of "red", "orange", "yellow", "green", "blue", "indigo", "violet", "black", "white", "gray" and 2 more',
        ]);
        // A missing key states what it expects, and asks about a place where the input may have
        // that key instead: under another spelling or nested one object too deep. A key the
        // schema declares where the input has it is never suggested. A schema that fixes no type
        // states no expected type. A constraint states the limit the validator applies.
        const missing = yield* executeOnce(
          client,
          "Omit, misspell, misplace and exceed keys across native and imported schemas",
          `const messages = [];
for (const [tool, input] of [
  ["find", {}],
  ["find", {query: {query: {text: "fixture text"}}}],
  ["policy", {policy_id: "fixture policy"}],
  ["policy", {input: {policyId: "fixture policy"}}],
  ["policy", {policyId: "fixture policy", limit: 0}],
  ["policy", {policyId: "fixture policy", slug: "Fixture Slug"}],
  ["account", {user_id: "fixture user"}],
  ["user", {user_id: "fixture user"}],
  ["tree", {child: {name: "fixture child"}}],
  ["account", {userId: "fixture user", count: 5}],
  ["account", {userId: "fixture user", count: 4}],
  ["loose", {}],
  ["loose", {ref: "fixture ref", closed: "fixture closed", strict: "x", either: {a: "fixture a"}}],
  ["loose", {ref: "fixture ref", closed: "fixture closed", strict: "fixture strict", either: 1}],
  ["loose", {ref: "fixture ref", closed: "fixture closed", strict: "fixture strict", either: {a: "fixture a"}}],
  ["same", {}],
  ["same", {value: "x"}],
  ["same", {value: "y"}],
  ["overlap", {}],
  ["overlap", {value: "b"}],
  ["overlap", {value: "d"}],
  ["overlap", {value: "a"}],
  ["bounded", {}],
]) {
  try { await tools[${JSON.stringify(slug)}][tool](input); messages.push("accepted"); } catch (error) { messages.push(JSON.parse(error.message).message); }
}
return messages;`,
          "input-shape-missing-result.json",
        );
        const messages = (yield* Schema.decodeUnknownEffect(Completed)(missing.structured))
          .execution.value;
        expect(messages).toEqual([
          "Input failed validation: input.query: Missing key. Expected object {text, limit?}",
          "Input failed validation: input.query.text: Missing key. Expected string. The input has text at input.query.query.text; did you mean input.query.text?",
          "Input failed validation: input.policyId: Missing key. Expected string. The input has policy_id at input.policy_id; did you mean input.policyId?",
          "Input failed validation: input.policyId: Missing key. Expected string. The input has policyId at input.input.policyId; did you mean input.policyId?",
          "Input failed validation: input.limit: Expected a number of at least 1",
          'Input failed validation: input.slug: Expected a string matching the pattern "^[a-z-]+$"',
          // user_id and the child's name are declared where the input has them.
          "Input failed validation: input.userId: Missing key. Expected string",
          "Input failed validation: input.userId: Missing key. Expected string",
          "Input failed validation: input: Expected object {child?, name, ...} or object {child?, id, ...}. Closest is alternative 1, whose problems follow; input.name: Missing key",
          // The validator applies minimum inclusively, whatever a draft 4 exclusiveMinimum says.
          "accepted",
          "Input failed validation: input.count: Expected a number of at least 5",
          // A schema without a type promises none: object keywords alone accept other values,
          // and other keywords or alternatives may still reject them.
          "Input failed validation: input.ref: Missing key; input.closed: Missing key; input.strict: Missing key; input.either: Missing key",
          "Input failed validation: input.strict: Expected a string of at least 5 characters",
          "Input failed validation: input.either: Expected object {a, ...} or object {b, ...}. Exactly one may match, but 2 do",
          "accepted",
          // A oneOf's alternatives may overlap, so a missing key promises none of their values,
          // even beside the key's own enum, a value more than one alternative allows is rejected
          // as such, and a value none allows keeps the alternatives apart.
          "Input failed validation: input.value: Missing key",
          'Input failed validation: input.value: Expected "x" or "x". Exactly one may match, but 2 do',
          'Input failed validation: input.value: Expected "x" or "x". Exactly one alternative must match',
          "Input failed validation: input.value: Missing key",
          'Input failed validation: input.value: Expected one of "a", "b" or one of "b", "c". Exactly one may match, but 2 do',
          'Input failed validation: input.value: Expected one of "a", "b" or one of "b", "c". Exactly one alternative must match',
          "accepted",
          "Input failed validation: input.value: Missing key",
        ]);
        // Supplied values are never echoed, only the schema's keys, limits and patterns.
        expect(JSON.stringify(messages)).not.toContain("fixture");
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.mcpExecuteToolBlocked.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { client, slug, id } = yield* hostedApp("Denied tool", deniedAppSource);
        const app = `tools[${JSON.stringify(slug)}]`;
        const blocked = yield* executeOnce(
          client,
          "Call a tool whose approval policy denies it",
          `return await ${app}.remove({id: "fixture item"});`,
          "tool-blocked-result.json",
        );
        const { error } = (yield* Schema.decodeUnknownEffect(Failed)(blocked.structured)).execution;
        // The agent learns that the app's own policy refused the call and not to repeat it
        // unchanged, not only the error's name.
        expect(error.message).toBe(
          "ToolBlocked (HTTP 403): The approval policy in the app’s code denied this call to “remove”. Recovery: Check what the app’s approval policy requires for this tool. If the call should be allowed, meet those requirements or, with the user’s agreement, change the policy and deploy it. Otherwise use a different tool.",
        );
        expect(error.response).toEqual({ code: "ToolBlocked", status: 403 });
        const caught = yield* executeOnce(
          client,
          "Catch the denied call and read its recovery",
          `try { await ${app}.remove({id: "fixture item"}); return "ran"; } catch (error) { return error.message; }`,
          "tool-blocked-caught.json",
        );
        const completed = yield* Schema.decodeUnknownEffect(Completed)(caught.structured);
        const recovery = yield* Schema.decodeUnknownEffect(CaughtRecovery)(
          completed.execution.value,
        );
        expect(recovery.code).toBe("ToolBlocked");
        expect(recovery.recovery.instructions).toContain("Do not retry the call unchanged.");
        expect(recovery.recovery.instructions).toContain("Read the policy to see what it checks");
        expect(recovery.recovery.instructions).toContain("user-approval");
        // An uncaught failure carries the same recovery in its response.
        const uncaught = yield* Schema.decodeUnknownEffect(UncaughtRecovery)(blocked.structured);
        expect(uncaught.execution.error.response.recovery).toEqual(recovery.recovery);
        // The dashboard's tool runner shows the same explanation and next step.
        const actors = yield* Actors,
          browser = yield* Browser;
        yield* browser.login(actors.owner);
        yield* browser.use("Open the denied tool in the Tools tab", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${id}?view=tools&tool=remove`),
        );
        yield* browser.use("Run the denied tool", (page) =>
          page
            .getByLabel("ID", { exact: true })
            .fill("fixture item")
            .then(() => page.getByRole("button", { name: "Run tool", exact: true }).click()),
        );
        expect(
          yield* browser.use("The block is explained", (page) =>
            page
              .getByRole("alert")
              .filter({ hasText: "approval policy" })
              .waitFor()
              .then(() =>
                page.getByRole("alert").filter({ hasText: "approval policy" }).textContent(),
              ),
          ),
        ).toBe(
          "The approval policy in the app’s code denied this call to “remove”. Check what the app’s approval policy requires for this tool. If the call should be allowed, meet those requirements or, with the user’s agreement, change the policy and deploy it. Otherwise use a different tool.",
        );
        yield* browser.checkpoint("Denied tool call in the dashboard");
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.mcpExecuteServerRefused.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient,
          evidence = yield* Evidence;
        // Every path other than the gate's own routes answers 404, like a moved MCP server.
        const gate = yield* requestGate;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Refused MCP server",
          }),
        );
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Moved MCP ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "package.json",
              content: JSON.stringify({
                dependencies: withApps({
                  "@modelcontextprotocol/client": "2.0.0",
                  "@modelcontextprotocol/core": "2.0.0",
                }),
              }),
            },
            {
              path: "index.ts",
              content: `import { defineApp, router } from "apps";
import { mcpRouter } from "apps/mcp";
export default defineApp({ accounts: {} }, async () => ({ tools: await mcpRouter({ url: ${JSON.stringify(`${gate.origin}/moved/mcp`)} }) }));`,
            },
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id });
            yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`);
          }).pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "refused-mcp", {
          organization: actors.organization.id,
        });
        const code = `return await tools[${JSON.stringify(app.slug)}].anything({});`;
        const started = yield* Clock.currentTimeMillis;
        const result = yield* client.use(
          "Call a tool of an app whose MCP server refuses connections",
          (client, signal) =>
            client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
        );
        const elapsed = (yield* Clock.currentTimeMillis) - started;
        yield* evidence.json("refused-result.json", { elapsed, result: result.structuredContent });
        const failed = yield* Schema.decodeUnknownEffect(Failed)(result.structuredContent);
        const reason = failed.unavailableApps.find((entry) => entry.app === app.id)?.reason ?? "";
        // The MCP server's refusal is named, instead of a generic tool-definition failure.
        expect(reason).toContain("refused the request while connecting (HTTP 404)");
        expect(failed.execution.error.kind).toBe("ToolFailure");
        expect(failed.execution.error.message).toContain("HTTP 404");
        // A deterministic refusal fails without waiting for a connection timeout.
        expect(elapsed).toBeLessThan(10_000);

        // A server that refuses with a JSON-RPC error has its code and message reported, such as
        // a client app it has not enabled, with the settings link that enables it.
        const refusing = yield* hostedAppFiles(
          "JSON-RPC refusal",
          mcpAppFiles((yield* refusingMcpServer).url),
        );
        const index = yield* api.request(actors.owner, "GET", `${refusing.path}/tools/index`);
        expect(index.status).toBe(502);
        expect(index.body).toMatchObject({
          _tag: "AppEvaluationFailed",
          mcp: {
            phase: "connect",
            reason: "request",
            status: 400,
            upstream: { code: -32600, message: refusal },
          },
        });
        const rejected = yield* executeOnce(
          refusing.client,
          "Call a tool of an app whose MCP server answers with a JSON-RPC error",
          `return await tools[${JSON.stringify(refusing.slug)}].anything({});`,
          "json-rpc-refusal.json",
        );
        const refused = yield* Schema.decodeUnknownEffect(Failed)(rejected.structured);
        const entry = refused.unavailableApps.find((entry) => entry.app === refusing.id);
        if (entry === undefined) return yield* Effect.die("The app was not reported");
        const diagnostic = yield* Schema.decodeUnknownEffect(Diagnostic)(entry.reason);
        expect(diagnostic.message).toContain("refused the request while connecting (HTTP 400)");
        const stated = `JSON-RPC error -32600: ${JSON.stringify(refusal)}`;
        expect(diagnostic.message).toContain(stated);
        expect(refused.execution.error.message).toContain(stated);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.mcpExecuteCallRefused.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const server = yield* refusingMcpServer;
        // The server lists its tool and refuses only what each step selects.
        yield* server.refuse("tool-calls");
        const app = yield* hostedAppFiles("JSON-RPC call refusal", mcpAppFiles(server.url));
        const lookup = (label: string, file: string) =>
          executeOnce(
            app.client,
            label,
            `return await tools[${JSON.stringify(app.slug)}].lookup({});`,
            file,
          ).pipe(
            Effect.flatMap(({ structured }) => Schema.decodeUnknownEffect(Failed)(structured)),
            Effect.map(({ execution }) => execution.error.message),
          );
        const refused = `JSON-RPC error -32600: ${JSON.stringify(refusal)}`;

        // A refused tools/call fails the call, with the server's own error, not as an app error.
        const called = yield* api.request(actors.owner, "POST", `${app.path}/tools/call`, {
          tool: "lookup",
          input: {},
        });
        expect(called.status, JSON.stringify(called.body)).toBe(502);
        expect(called.body).toMatchObject({
          _tag: "ToolCallFailed",
          mcp: {
            phase: "call",
            reason: "request",
            status: 400,
            upstream: { code: -32600, message: refusal },
          },
        });
        const callRefused = yield* lookup(
          "Call a tool whose MCP server refuses tools/call with a JSON-RPC error",
          "json-rpc-call-refused.json",
        );
        expect(callRefused).toContain("ToolCallFailed");
        expect(callRefused).toContain("refused the request while calling a tool (HTTP 400)");
        expect(callRefused).toContain(refused);
        expect(callRefused).not.toContain("The app threw");

        // An error inside a successful response, such as arguments the tool rejects.
        yield* server.refuse("tool-arguments");
        const argumentsRejected = yield* lookup(
          "Call a tool whose MCP server answers with a JSON-RPC error in its response",
          "json-rpc-call-error.json",
        );
        expect(argumentsRejected).toContain("returned an error while calling a tool");
        expect(argumentsRejected).toContain(
          `JSON-RPC error -32602: ${JSON.stringify(invalidArguments)}`,
        );
        expect(argumentsRejected).not.toContain("could not reach");

        // Each call opens its own session. A server that refuses it reports why, also when the
        // app's tool listing is kept and not read again.
        yield* server.refuse("call-sessions");
        const sessionRefused = yield* lookup(
          "Call a tool whose MCP server refuses the call's session with a JSON-RPC error",
          "json-rpc-call-session-refused.json",
        );
        expect(sessionRefused).toContain("refused the request while connecting (HTTP 400)");
        expect(sessionRefused).toContain(refused);
        expect(sessionRefused).not.toContain("The app threw");
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
