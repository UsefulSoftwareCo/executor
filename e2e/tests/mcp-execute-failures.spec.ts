/** Failed and timed-out MCP executions report what happened instead of losing it. */
import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Clock, Effect, Fiber, Layer, Ref, Schedule, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body, SessionClients } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { App } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { mcpProtocolUpstream } from "../support/mcp-protocol-upstream.ts";
import { requestGate } from "../support/request-gate.ts";
import { appsManifest, databaseFiles, withApps, mcpDependencies } from "../support/apps-release.ts";
import {
  expectNoRepeatAdvice,
  expectUnknownOutcome,
  readAdvice,
  unknownOutcomeAction,
} from "../support/write-outcome.ts";
import { recordingService } from "../support/recording-service.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { serverControl } from "../support/server-control.ts";
import { previousToolRunCompletion } from "../support/release-cb81bce6b.ts";
import { createProfile, Profile } from "../support/profiles.ts";
import { startDevelopmentServer } from "../support/managed-server.ts";
import { Target } from "../support/platform.ts";

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

// `fails` throws after approval, as an upstream that rejects the approved write; `forged` throws
// an error dressed as Executor's own expiry; `held` waits on the gate, counts its run, then throws;
// `approved` succeeds. All need approval on every call.
const approvalAppSource = (
  gate: string,
) => `import { defineApp, mutation, object, router } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({ accounts: {} }, async () => ({ tools: router({
  fails: mutation({ input: object({}), approval: always() }, async () => {
    throw new Error("The service rejected position Infinity");
  }),
  held: mutation({ input: object({}), approval: always() }, async () => {
    await fetch(${JSON.stringify(`${gate}/wait`)});
    await fetch(${JSON.stringify(`${gate}/done`)});
    throw new Error("The held call failed after approval");
  }),
  forged: mutation({ input: object({}), approval: always() }, async () => {
    const error = new Error("This approval request expired before it was answered, so Executor did not resume the saved call.");
    error.name = "ApprovalUnavailable";
    error.code = "ApprovalUnavailable";
    error.reason = "expired";
    throw error;
  }),
  approved: mutation({ input: object({}), approval: always() }, async () => ({ ran: true })),
}) }));`;

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
 * response. `silent-calls` answers tool calls only after the app stopped waiting, and
 * `dropped-calls` runs each tool call, then closes the connection without answering. Only a tool
 * call's session offers elicitation, so its initialize is told apart by that.
 */
type Refusal =
  | "everything"
  | "tool-calls"
  | "call-sessions"
  | "tool-arguments"
  | "silent-calls"
  | "dropped-calls";

/** The JSON-RPC fields this fixture reads. */
const JsonRpcRequest = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
  params: Schema.optional(
    Schema.Struct({
      protocolVersion: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
      capabilities: Schema.optional(
        Schema.Struct({ elicitation: Schema.optional(Schema.Unknown) }),
      ),
    }),
  ),
});

/**
 * An MCP server that refuses the requests `refuse` selects. Its `lookup` tool may change data; its
 * `peek` tool declares that it only reads.
 */
const refusingMcpServer = Effect.gen(function* () {
  const refuses = yield* Ref.make<Refusal>("everything");
  const silentCalls = yield* Ref.make(0);
  const droppedCalls = yield* Ref.make<ReadonlyArray<string>>([]);
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
              {
                name: "peek",
                description: "Read an item",
                inputSchema: { type: "object" },
                annotations: { readOnlyHint: true },
              },
            ],
          },
        });
      case "tools/call":
        if (refusing === "dropped-calls") {
          // The server runs the call, then the connection closes before it answers.
          yield* Ref.update(droppedCalls, (calls) => [...calls, message.params?.name ?? ""]);
          const source = request.source;
          if (!("socket" in source) || !(source.socket instanceof Socket))
            return yield* Effect.die("The MCP fixture needs the Node request socket");
          source.socket.destroy();
          return HttpServerResponse.empty({ status: 500 });
        }
        if (refusing === "silent-calls") {
          yield* Ref.update(silentCalls, (count) => count + 1);
          // Long after the app stopped waiting, so the request still ends with the scenario.
          yield* Effect.sleep("5 seconds");
        }
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
    /** Tool calls the server received and never answered. */
    silentCalls: Ref.get(silentCalls),
    /** The tools the server ran before its connection closed, in order. */
    droppedCalls: Ref.get(droppedCalls),
  };
});

/** The URL of an MCP server that has stopped listening, so connecting to it is refused. */
const closedMcpUrl = Effect.scoped(
  Effect.gen(function* () {
    const services = yield* Layer.build(
      NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }),
    );
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
    return `http://127.0.0.1:${server.address.port}/mcp`;
  }),
);

/**
 * An app that saves records to the service at `url`. `save` starts saving a record and checks the
 * service's quota at the same time; the quota check is refused with `status` while the record is
 * still pending. `quota` only checks the quota, and `records` reads the saved records.
 */
const pendingWriteAppSource = (
  url: string,
) => `import { defineApp, mutation, query, object, string, router, ProviderError } from "apps";
const service = ${JSON.stringify(url)};
const refusal = (status) =>
  new ProviderError(status === 401 ? { reason: "unauthorized", status } : { reason: "rate_limited", status });
export default defineApp({ accounts: {} }, async () => ({
  tools: router({
    save: mutation({ input: object({ name: string(), status: string() }) }, async ({ fetch }, { name, status }) => {
      const saving = fetch(service + "/records?pending", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
      const quota = await fetch(service + "/quota?after=write&status=" + status);
      if (!quota.ok) {
        saving.catch(() => undefined);
        throw refusal(quota.status);
      }
      await saving;
      return { saved: name };
    }),
    quota: query({ input: object({ status: string() }) }, async ({ fetch }, { status }) => {
      const quota = await fetch(service + "/quota?status=" + status);
      if (!quota.ok) throw refusal(quota.status);
      return "available";
    }),
    records: query({ input: object({}) }, async ({ fetch }) => (await fetch(service + "/records")).json()),
  }),
}));`;

/**
 * An app whose `sync` saves a record to the service at `url`, then initializes a session with the
 * MCP server at `mcp`, reporting a failure to reach it as Executor's MCP helpers do. `check` only
 * initializes the session.
 */
const nestedMcpAppFiles = (url: string, mcp: string) => [
  {
    path: "package.json",
    content: JSON.stringify({ dependencies: withApps({ "@modelcontextprotocol/sdk": "1.30.0" }) }),
  },
  {
    path: "index.ts",
    content: `import { defineApp, mutation, query, object, string, router } from "apps";
import { McpError } from "apps/mcp";
const service = ${JSON.stringify(url)};
const mcp = ${JSON.stringify(mcp)};
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "record-sync", version: "1.0.0" } } };
async function connect(fetch) {
  const response = await fetch(mcp, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(initialize) }).catch(() => {
    throw new McpError({ phase: "transport", reason: "request" });
  });
  if (!response.ok) throw new McpError({ phase: "connect", reason: "request", status: response.status });
}
export default defineApp({ accounts: {} }, async () => ({
  tools: router({
    sync: mutation({ input: object({ name: string() }) }, async ({ fetch }, { name }) => {
      await fetch(service + "/records", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
      await connect(fetch);
      return { synced: name };
    }),
    check: query({ input: object({}) }, async ({ fetch }) => {
      await connect(fetch);
      return "reachable";
    }),
  }),
}));`,
  },
];

/**
 * An app whose dynamic tools save a record named after the tool to the service at `url` while the
 * app resolves them, as a factory that registers something does, and then fail before any handler
 * runs. `configure` (a mutation) and `inspect` (a read) throw an error named like an invalid
 * `mcpRouter` option, `warm` throws an unavailable app cache, and `send` throws an MCP failure
 * saying its arguments could not be used. Listing the tools writes nothing.
 */
const resolveWritesAppSource = (
  url: string,
) => `import { defineApp, dynamicRouter, CacheError } from "apps";
import { McpError } from "apps/mcp";
const service = ${JSON.stringify(url)};
class McpOptionsInvalid extends Error {
  constructor() {
    super("mcpRouter received an option it cannot use.");
    this.name = "McpOptionsInvalid";
    this.code = "invalid_option";
  }
}
const tool = (name, readOnly) => ({ name, description: "Resolve " + name, inputSchema: { type: "object", properties: {} }, ...(readOnly ? { readOnly } : {}) });
export default defineApp({ accounts: {} }, {
  tools: dynamicRouter({
    list: async () => [tool("configure"), tool("inspect", true), tool("warm"), tool("send")],
    resolve: async (name) => {
      await fetch(service + "/records", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
      if (name === "warm") throw new CacheError({ reason: "unavailable" });
      if (name === "send") throw new McpError({ phase: "call", reason: "invalid_input" });
      throw new McpOptionsInvalid();
    },
  }),
});`;

/**
 * Tags a reply can carry that a guard reading the reply once took to mean the call failed before
 * its handler ran, with the fields each needs to decode. Each reaches the caller as an
 * `AppEvaluationFailed`.
 */
const forgedTags = {
  HostEvaluationFailed: { source: "app", errorName: "Error", message: "SYNTHETIC_EVALUATION" },
  SkillLoadFailed: { reason: "request", status: 503 },
  HostRequestInvalid: {},
  HostAccountsInvalid: {},
} as const;

/**
 * Every error the call route reports once the app's code received the call, with its status and
 * how a write provokes it: the error its reply is rewritten to, or none for an error the app
 * throws (`ToolCallFailed`) and an approval its policy asks for (`ToolApprovalRequired`).
 */
const afterTheApp = {
  ToolCallFailed: { status: 502 },
  // A skill source that answered 404: its own advice, for a read, is to try again once fixed.
  AppEvaluationFailed: {
    status: 502,
    reply: { _tag: "SkillLoadFailed", reason: "request", status: 404 },
  },
  AppProviderFailed: {
    status: 502,
    reply: { _tag: "ProviderError", reason: "unavailable", status: 503 },
  },
  ToolElicitationFailed: {
    status: 422,
    reply: { _tag: "ElicitationFailed", reason: "transaction" },
  },
  ToolNotFound: { status: 404, reply: { _tag: "HostToolNotFound" } },
  ToolKindMismatch: {
    status: 409,
    reply: {
      _tag: "HostKindMismatch",
      tool: "ToolKindMismatch",
      requested: "mutation",
      actual: "query",
    },
  },
  InputInvalid: {
    status: 422,
    reply: { _tag: "HostInputInvalid", problems: ["name: Expected string, got undefined"] },
  },
  ToolBlocked: { status: 403, reply: { _tag: "HostToolBlocked" } },
  ToolApprovalRequired: { status: 409 },
  ToolPolicyFailed: { status: 500, reply: { _tag: "HostToolPolicyFailed" } },
} as const;

/**
 * The errors the call route declares that are reported before the host hands the call to the app's
 * code, or only by a tool listing, so none records that a call may have written.
 */
const beforeTheApp = [
  "RequestInvalid",
  "Unauthorized",
  "Forbidden",
  "OrganizationForbidden",
  "AuthenticationUnavailable",
  "ProfileNotFound",
  "ProfileConflict",
  "AppNotFound",
  "AppNotDeployed",
  "DeploymentNotFound",
  "AccountNotFound",
  "AccountRequired",
  "AccountSelectionInvalid",
  "OAuthReconnectRequired",
  "OAuthRenewalFailed",
  "ToolListingTimedOut",
];

/**
 * Executor's own failures, which the call route can report before the host hands the call to the
 * app's code or after it, such as saving the approval request a write's policy asked for. After
 * it, they record that the call may have written (`mcpExecuteApprovalSaveFailed`).
 */
const eitherSide = ["StorageError", "CredentialsError"];

/** The reply each forging tool's failure is rewritten to. */
const forgedReplies = {
  ...Object.fromEntries(
    Object.entries(forgedTags).map(([tag, fields]) => [tag, { _tag: tag, ...fields }]),
  ),
  ...Object.fromEntries(
    Object.entries(afterTheApp).flatMap(([name, provoke]) =>
      "reply" in provoke ? [[name, provoke.reply]] : [],
    ),
  ),
  // A query refused for its kind: its caller keeps the advice to call it as a mutation.
  readKind: { _tag: "HostKindMismatch", tool: "readKind", requested: "query", actual: "mutation" },
};

/**
 * An app whose mutations each write a cache marker under their own name and then fail. The app's
 * own code rewrites a forging tool's failure in its reply (`forgedReplies`); `ToolCallFailed`
 * throws its error unchanged, and `ToolApprovalRequired`'s approval policy writes and then asks for
 * approval. `marker` reads a marker back. Deployed with a database, its calls run in its data facet;
 * without one, in its Worker.
 */
const writeFailuresAppSource = `import { defineApp, query, mutation, object, string, router } from "apps";
const replies = ${JSON.stringify(forgedReplies)};
const json = Response.prototype.json;
Response.prototype.json = async function (this: Response) {
  const reply = await json.call(this);
  const message = reply?.error?.message;
  const tool = typeof message === "string" && message.startsWith("FORGE:") ? message.slice(6) : undefined;
  return tool === undefined ? reply : { ...reply, error: replies[tool] };
} as typeof json;
export default defineApp({ accounts: {} }, async (ctx) => {
  const wrote = (tool: string) => ctx.cache.write([{ key: tool, value: "written" }], "1 minute");
  const write = (tool: string) => mutation({ input: object({}) }, async () => {
    await wrote(tool);
    throw new Error(tool in replies ? "FORGE:" + tool : "SYNTHETIC_CALL");
  });
  return { tools: router({
    ${[
      ...Object.keys(forgedTags),
      ...Object.keys(afterTheApp).filter((name) => name !== "ToolApprovalRequired"),
    ]
      .map((name) => `${name}: write(${JSON.stringify(name)}),`)
      .join("\n    ")}
    ToolApprovalRequired: mutation({ input: object({}), approval: async () => {
      await wrote("ToolApprovalRequired");
      return "user-approval" as const;
    } }, async () => "ran"),
    readKind: query({ input: object({}) }, async () => { throw new Error("FORGE:readKind"); }),
    marker: query({ input: object({ tag: string() }) }, async (_, { tag }) => (await ctx.cache.read(tag, string())) ?? "missing"),
  }) };
});`;

/** The OpenAPI document's error tags for one operation: each JSON error response's `_tag`s. */
/**
 * An app whose mutation's approval policy writes a cache marker and then asks for approval, so
 * Executor saves an approval request after the app's code received the call. `marker` reads it.
 */
const approvalSaveAppSource = `import { defineApp, query, mutation, object, string, router } from "apps";
export default defineApp({ accounts: {} }, async (ctx) => ({ tools: router({
  guarded: mutation({ input: object({}), approval: async () => {
    await ctx.cache.write([{ key: "guarded", value: "written" }], "1 minute");
    return "user-approval" as const;
  } }, async () => "ran"),
  marker: query({ input: object({}) }, async () => (await ctx.cache.read("guarded", string())) ?? "missing"),
}) }));`;

/**
 * An app whose factory saves a record each time it is evaluated. Its queries save a record and
 * then fail with an unavailable cache (`check`), or have an approval policy that saves a record
 * and then asks for approval (`approved`).
 */
const unnamedKindAppSource = (
  url: string,
) => `import { defineApp, query, object, router, CacheError } from "apps";
const save = (name) => fetch(${JSON.stringify(`${url}/records`)}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
export default defineApp({ accounts: {} }, async () => {
  await save("factory");
  return { tools: router({
    check: query({ input: object({}) }, async () => {
      await save("handler");
      throw new CacheError({ reason: "unavailable" });
    }),
    approved: query({ input: object({}), approval: async () => {
      await save("policy");
      return "user-approval" as const;
    } }, async () => "ran"),
  }) };
});`;

const declaredErrors = (document: unknown, path: string, method: string) => {
  const record = (value: unknown): Readonly<Record<string, unknown>> =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const schemas = record(record(record(document).components).schemas);
  const resolve = (value: unknown): Readonly<Record<string, unknown>> => {
    const shape = record(value);
    return typeof shape.$ref === "string"
      ? resolve(schemas[shape.$ref.split("/").at(-1) ?? ""])
      : shape;
  };
  const tags = (value: unknown): ReadonlyArray<readonly [string, ReadonlyArray<string>]> => {
    const shape = resolve(value);
    const alternatives = shape.anyOf ?? shape.oneOf;
    if (Array.isArray(alternatives)) return alternatives.flatMap(tags);
    const properties = record(shape.properties);
    const tag = record(properties._tag);
    const name = tag.const ?? (Array.isArray(tag.enum) ? tag.enum[0] : undefined);
    return typeof name === "string" ? [[name, Object.keys(properties)]] : [];
  };
  const operation = record(record(record(record(document).paths)[path])[method]);
  return Object.entries(record(operation.responses))
    .filter(([status]) => Number(status) >= 400)
    .flatMap(([, response]) =>
      tags(record(record(record(response).content)["application/json"]).schema),
    );
};

/** A REST failure's body: its code, message, any recovery, and whether it records a write. */
const RestFailure = Schema.Struct({
  _tag: Schema.String,
  message: Schema.String,
  mayHaveWritten: Schema.optional(Schema.Boolean),
  recovery: Schema.optional(Schema.Struct({ action: Schema.String, instructions: Schema.String })),
});

/** An app whose only tools come from the MCP server at `url`, waiting `timeoutMs` for each call. */
const mcpAppFiles = (url: string, timeoutMs?: number) => [
  {
    path: "package.json",
    content: JSON.stringify({
      dependencies: withApps(mcpDependencies),
    }),
  },
  {
    path: "index.ts",
    content: `import { defineApp } from "apps";
import { mcpRouter } from "apps/mcp";
export default defineApp({ accounts: {} }, async () => ({ tools: await mcpRouter({ url: ${JSON.stringify(url)}${timeoutMs === undefined ? "" : `, timeoutMs: ${timeoutMs}`} }) }));`,
  },
];

/** A program that failed on a tool's error, with the agent-facing explanation and retry policy. */
const ToolFailed = Schema.Struct({
  execution: Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      message: Schema.String,
      response: Schema.Struct({
        code: Schema.String,
        retryable: Schema.Boolean,
        recovery: Schema.Struct({ action: Schema.String, instructions: Schema.String }),
      }),
    }),
  }),
});

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

// `publish` needs approval for every call and records each run, so `runs` shows which calls ran.
// `ask` asks the person a question too large for any execute result, and reports how that failed.
const publishAppFiles = [
  {
    path: "migrations/0001_runs.sql",
    content: "CREATE TABLE runs (title TEXT NOT NULL, length INTEGER NOT NULL);\n",
  },
  {
    path: "index.ts",
    content: `import { defineApp, mutation, query, object, string, router } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({ accounts: {} }, async () => ({ tools: router({
  publish: mutation({ input: object({ title: string(), body: string() }), approval: always() }, async ({ sql }, { title, body }) => {
    sql.exec("INSERT INTO runs (title, length) VALUES (?, ?)", title, body.length);
    return { title, length: body.length };
  }),
  runs: query({ input: object({}) }, async ({ sql }) => sql.exec("SELECT title, length FROM runs ORDER BY rowid").toArray()),
  ask: mutation({ input: object({}) }, async ({ elicit }) => {
    try {
      await elicit({ mode: "form", message: "Q".repeat(70000), requestedSchema: { type: "object", properties: {} } });
      return { asked: true };
    } catch (error) {
      return { reason: error.reason };
    }
  }),
}) }));`,
  },
  appsManifest,
];

/** A pending approval with the arguments it binds and the prompt a person reviews. */
const PublishPending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
  invocation: Schema.Struct({
    tool: Schema.String,
    input: Schema.Struct({ title: Schema.String, body: Schema.String }),
  }),
  elicitation: Schema.Struct({ message: Schema.String }),
});
const LinkedPending = Schema.Struct({ ...PublishPending.fields, approvalUrl: Schema.String });
/** The last characters of a long argument, which a shortened prompt would hide. */
const ending = "END-OF-THE-BODY";

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

/** The self-host test host's storage fault; see `apps/hosted/testing/storage-fault-fixture.ts`. */
const storageFault = "/api/devtools/storage-fault";
/** Whether the armed read failed, and the spans it ran inside, innermost first. */
const Faulted = Schema.Struct({
  failed: Schema.Boolean,
  spans: Schema.optional(Schema.Array(Schema.String)),
});
/** The resume's context check: the SDK's snapshot of the saved call's app and profile. */
const contextCheck = ["sdk.invocation.snapshot", "sdk.tools.resume"];
const Users = Schema.Struct({
  users: Schema.Array(Schema.Struct({ id: Schema.String, email: Schema.String })),
});
const Organizations = Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String }));

/** A resume that found no answerable request, and why. */
const Unavailable = Schema.Struct({
  status: Schema.Literal("unavailable"),
  requestId: Schema.String,
  reason: Schema.String,
  message: Schema.String,
});

/** Answer one pending request and return the structured result. */
const resumeOnce = (client: Connected, label: string, requestId: string, file: string) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence;
    const resumed = yield* client.use(label, (client, signal) =>
      client.callTool(
        { name: "resume", arguments: { requestId, response: { action: "accept", content: {} } } },
        undefined,
        { signal, timeout: 55_000 },
      ),
    );
    yield* evidence.json(file, resumed.structuredContent);
    return resumed.structuredContent;
  });

/** Run one program until it asks for approval and return the request ID. */
const pendingApproval = (client: Connected, label: string, code: string, file: string) =>
  executeOnce(client, label, code, file).pipe(
    Effect.flatMap(({ structured }) => Schema.decodeUnknownEffect(Pending)(structured)),
    Effect.map(({ requestId }) => requestId),
  );

/** Deploy an app in the hosted organization and connect a PAT MCP client to it. */
const hostedApp = (name: string, source: string) =>
  hostedAppFiles(name, [{ path: "index.ts", content: source }, appsManifest]);

/** Connect another MCP client through a PAT of its own, so a separate grant, as `member` or the owner. */
const otherGrant = (name: string, member = false) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      mcp = yield* McpClient;
    const actor = member ? actors.member : actors.owner;
    const key = yield* body(
      Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
      yield* api.request(actor, "POST", "/api/auth/api-key/create", { name }),
    );
    yield* Effect.addFinalizer(() =>
      api.request(actor, "POST", "/api/auth/api-key/delete", { keyId: key.id }).pipe(Effect.orDie),
    );
    return yield* mcp.connect(key.key, name.toLowerCase().replaceAll(" ", "-"), {
      organization: actors.organization.id,
    });
  });

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
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
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
    return {
      client,
      key: key.key,
      slug: app.slug,
      id: app.id,
      path: `${prefix}/apps/${app.id}`,
    };
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

  it.effect(scenarios.mcpResumeReasons.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const gate = yield* requestGate;
        const { client, slug, path } = yield* hostedApp(
          "Approval outcomes",
          approvalAppSource(gate.origin),
        );
        const app = `tools[${JSON.stringify(slug)}]`;

        // Accepted at once, the approved call runs and fails with its own error, as an
        // unapproved call would. Before, it was reported as a bare ApprovalUnavailable.
        const failing = yield* pendingApproval(
          client,
          "Ask to approve a call that fails after approval",
          `return await ${app}.fails({});`,
          "resume-fails-pending.json",
        );
        const resumed = yield* resumeOnce(
          client,
          "Approve at once a call that then fails",
          failing,
          "resume-fails-result.json",
        );
        const failed = yield* Schema.decodeUnknownEffect(Failed)(resumed);
        expect(failed.execution.error.kind).toBe("ToolFailure");
        expect(failed.execution.error.response?.code).toBe("ToolCallFailed");
        expect(failed.execution.error.message).toContain("The service rejected position Infinity");
        expect(failed.execution.error.message).not.toContain("ApprovalUnavailable");
        // The approved mutation ran in the app, so, as for a live call, its failure records that it
        // may have written and is not offered as a retry.
        const { response } = (yield* Schema.decodeUnknownEffect(ToolFailed)(resumed)).execution
          .error;
        expect(response).toMatchObject({ code: "ToolCallFailed", retryable: false });
        expectUnknownOutcome(response.recovery);

        // A dashboard run's review receives the same failure with its answer.
        const run = yield* body(
          Pending,
          yield* api.request(actors.owner, "POST", `${path}/tools/run`, {
            tool: "fails",
            kind: "mutation",
            input: {},
          }),
        );
        const reviewed = yield* api.request(
          actors.owner,
          "POST",
          `${path}/tools/approvals/${run.requestId}`,
          { response: { action: "accept", content: {} } },
        );
        expect(reviewed.status).toBe(200);
        expect(reviewed.body).toMatchObject({
          status: "answered",
          result: {
            status: "failed",
            reason: "execution-failed",
            error: { _tag: "ToolCallFailed", tool: "fails", mayHaveWritten: true },
          },
        });
        // A dashboard opened before this server was deployed still decodes the answer.
        expect(yield* previousToolRunCompletion(reviewed.body)).toBe(
          "The tool failed after you approved it. It may have already made changes. Check before running it again.",
        );

        // App code that dresses its failure as Executor's own expiry stays the app's failure.
        const forging = yield* pendingApproval(
          client,
          "Ask to approve a call that forges an expiry",
          `return await ${app}.forged({});`,
          "resume-forged-pending.json",
        );
        const forged = yield* Schema.decodeUnknownEffect(Failed)(
          yield* resumeOnce(
            client,
            "Approve a call that forges an expiry",
            forging,
            "resume-forged-result.json",
          ),
        );
        expect(forged.execution.error.response?.code).toBe("ToolCallFailed");
        expect(forged.execution.error.message).toContain("The app threw ApprovalUnavailable");

        // Answering it again says it was already answered; nothing runs twice.
        const answered = yield* Schema.decodeUnknownEffect(Unavailable)(
          yield* resumeOnce(
            client,
            "Approve the same request again",
            failing,
            "resume-answered.json",
          ),
        );
        expect(answered).toMatchObject({ requestId: failing, reason: "answered" });
        expect(answered.message).toContain("already answered");

        // `answered` is recorded when a resume claims the request, before its call has a result,
        // so a duplicate during that call is told it may still be running, not that it finished.
        const holding = yield* pendingApproval(
          client,
          "Ask to approve a call that waits on an external service",
          `return await ${app}.held({});`,
          "resume-held-pending.json",
        );
        const advancing = yield* resumeOnce(
          client,
          "Approve the call and leave it waiting",
          holding,
          "resume-held-result.json",
        ).pipe(Effect.forkScoped);
        yield* gate.arrived;
        const claimed = yield* Schema.decodeUnknownEffect(Unavailable)(
          yield* resumeOnce(
            client,
            "Answer the request again while its call is still running",
            holding,
            "resume-held-answered.json",
          ),
        );
        expect(claimed).toMatchObject({ requestId: holding, reason: "answered" });
        expect(claimed.message).toContain("may still be running");
        // The previous copy claimed the earlier resume had already received the result.
        expect(claimed.message).not.toContain("received the program's result");
        expect(yield* gate.completed).toBe(0);
        yield* gate.release;
        const held = yield* Schema.decodeUnknownEffect(Failed)(yield* Fiber.join(advancing));
        expect(held.execution.error.response?.code).toBe("ToolCallFailed");
        expect(held.execution.error.message).toContain("The held call failed after approval");
        // The duplicate ran nothing: the call ran once, for the resume that claimed it.
        expect(yield* gate.completed).toBe(1);
        // Another person cannot learn that the request existed or was answered.
        const member = yield* otherGrant("Approval outcomes member", true);
        expect(
          yield* Schema.decodeUnknownEffect(Unavailable)(
            yield* resumeOnce(
              member,
              "Another person answers the answered request",
              failing,
              "resume-member-not-found.json",
            ),
          ),
        ).toMatchObject({ requestId: failing, reason: "not-found" });

        // Another grant cannot see the request, and its attempt leaves it pending for its owner.
        const pending = yield* pendingApproval(
          client,
          "Ask to approve a call from the first grant",
          `return await ${app}.approved({});`,
          "resume-other-grant-pending.json",
        );
        const other = yield* otherGrant("Approval outcomes other grant");
        const foreign = yield* Schema.decodeUnknownEffect(Unavailable)(
          yield* resumeOnce(
            other,
            "Answer the first grant's request from another grant",
            pending,
            "resume-not-found.json",
          ),
        );
        expect(foreign).toMatchObject({ requestId: pending, reason: "not-found" });
        expect(foreign.message).not.toContain("already answered");
        const owned = yield* Schema.decodeUnknownEffect(Completed)(
          yield* resumeOnce(
            client,
            "Approve the request from its own grant",
            pending,
            "resume-own-grant.json",
          ),
        );
        expect(owned.execution).toMatchObject({ ok: true, value: { ran: true } });

        // A profile that changes while its call waits is not resumed with other settings.
        const profile = yield* createProfile(actors.owner, path);
        const changing = yield* pendingApproval(
          client,
          "Ask to approve a call through a profile",
          `return await ${app}.profiles[${JSON.stringify(profile.id)}].approved({});`,
          "resume-context-pending.json",
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/profiles/${profile.id}`, {
            expectedRevision: profile.revision,
            accounts: {},
          })).status,
        ).toBe(200);
        const changed = yield* Schema.decodeUnknownEffect(Failed)(
          yield* resumeOnce(
            client,
            "Approve the call after its profile changed",
            changing,
            "resume-context-changed.json",
          ),
        );
        expect(changed.execution.error.response?.code).toBe("ApprovalUnavailable");
        expect(changed.execution.error.message).toContain("changed");
        expect(changed.execution.error.message).not.toContain("did not run");
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.mcpResumeContextUnconfirmed.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          mcp = yield* McpClient,
          evidence = yield* Evidence;
        // Only the test entry point mounts the storage fault.
        const origin = yield* startDevelopmentServer(target);
        const api = yield* Api.pipe(
          Effect.provide(Layer.fresh(Api.layer)),
          Effect.provide(Layer.fresh(SessionClients.layer)),
          Effect.provideService(Target, { ...target, metadata: { ...target.metadata, origin } }),
        );
        const owner = yield* api.session(),
          headers = { origin };
        const send = (method: "GET" | "POST" | "DELETE", path: string, payload?: unknown) =>
          api.request(owner, method, `${origin}${path}`, payload, headers);
        expect((yield* send("POST", "/api/devtools/operator", {})).status).toBe(200);
        const directory = yield* body(Users, yield* send("GET", "/api/auth/admin/list-users"));
        const developer = directory.users.find((user) => user.email === "agent-agent@example.test");
        if (!developer) return yield* Effect.die("Development owner is missing");
        expect(
          (yield* send("POST", "/api/auth/admin/impersonate-user", { userId: developer.id }))
            .status,
        ).toBe(200);
        const organization = (yield* body(
          Organizations,
          yield* send("GET", "/api/auth/organization/list"),
        ))[0];
        if (!organization) return yield* Effect.die("Development organization is missing");
        const prefix = `/api/organizations/${organization.id}`;
        // A failed assertion must not leave the fault armed.
        yield* Effect.addFinalizer(() => send("DELETE", storageFault).pipe(Effect.orDie));

        const gate = yield* requestGate;
        const deployed = yield* send("POST", `${prefix}/apps/deploy`, {
          name: `Unconfirmed context ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: approvalAppSource(gate.origin) }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() => send("DELETE", path).pipe(Effect.orDie));
        const profile = yield* body(
          Profile,
          yield* send("POST", `${path}/profiles`, { accounts: {}, idempotencyKey: randomUUID() }),
        );
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* send("POST", "/api/auth/api-key/create", { name: "Unconfirmed context" }),
        );
        yield* Effect.addFinalizer(() =>
          send("POST", "/api/auth/api-key/delete", { keyId: key.id }).pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "unconfirmed-context", {
          organization: organization.id,
          origin,
        });
        const call = `return await tools[${JSON.stringify(app.slug)}].profiles[${JSON.stringify(profile.id)}].approved({});`;
        /**
         * Fail the resume's read of this profile in its context check. The host's own reads of
         * the profile, which authorize the caller first, are left alone: a failure there is a
         * `StorageError` before the SDK checks the context.
         */
        const failContextCheck = send("POST", storageFault, {
          profile: profile.id,
          within: contextCheck,
        }).pipe(Effect.map((armed) => expect(armed.status).toBe(200)));
        /** The fault fired, and on a read inside the context check. */
        const faultedContextCheck = (message: string, file: string) =>
          Effect.gen(function* () {
            const faulted = yield* body(Faulted, yield* send("GET", storageFault));
            yield* evidence.json(file, faulted);
            expect(faulted, message).toEqual({
              failed: true,
              spans: expect.arrayContaining(contextCheck),
            });
          });

        // Storage fails while the resume reads the profile to compare it with the reviewed call.
        const pending = yield* pendingApproval(
          client,
          "Ask to approve a call through a profile",
          call,
          "resume-unconfirmed-pending.json",
        );
        yield* failContextCheck;
        const resumed = yield* resumeOnce(
          client,
          "Approve the call while its profile cannot be read",
          pending,
          "resume-unconfirmed.json",
        );
        yield* faultedContextCheck(
          "The MCP resume's context check read the profile",
          "resume-unconfirmed-fault.json",
        );
        const unconfirmed = yield* Schema.decodeUnknownEffect(Failed)(resumed);
        expect(unconfirmed.execution.error.response?.code).toBe("ApprovalUnavailable");
        expect(unconfirmed.execution.error.message).toContain("could not read");
        expect(unconfirmed.execution.error.message).toContain("storage failed");
        // Before, a failed read was reported as a change Executor never observed.
        expect(unconfirmed.execution.error.message).not.toContain(
          "changed after this call was saved",
        );

        // Nothing changed: once storage answers, the same call through the profile runs.
        const again = yield* pendingApproval(
          client,
          "Ask again once storage answers",
          call,
          "resume-unconfirmed-again-pending.json",
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Completed)(
            yield* resumeOnce(
              client,
              "Approve the call with storage answering",
              again,
              "resume-unconfirmed-again.json",
            ),
          )).execution,
        ).toMatchObject({ ok: true, value: { ran: true } });

        // A dashboard review receives the storage error, not a changed-context answer.
        const run = yield* body(
          Pending,
          yield* send("POST", `${path}/tools/run`, {
            tool: "approved",
            kind: "mutation",
            input: {},
            profile: profile.id,
          }),
        );
        yield* failContextCheck;
        const reviewed = yield* send("POST", `${path}/tools/approvals/${run.requestId}`, {
          response: { action: "accept", content: {} },
        });
        expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
        expect(reviewed.body).toMatchObject({
          status: "answered",
          result: {
            status: "failed",
            reason: "execution-failed",
            context: "unconfirmed",
            error: { _tag: "StorageError" },
          },
        });
        // A dashboard opened before this server was deployed rejects an unknown reason as "Cannot
        // reach Executor". It ignores the field, so it still shows that the call failed.
        expect(yield* previousToolRunCompletion(reviewed.body)).toBe(
          "The tool failed after you approved it. It may have already made changes. Check before running it again.",
        );
        yield* faultedContextCheck(
          "The dashboard resume's context check read the profile",
          "review-unconfirmed-fault.json",
        );
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
                  dependencies: withApps(mcpDependencies),
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
          "InputInvalid (HTTP 422): Input failed validation: input.query: Expected object {text, limit?} Recovery: Change the input to the shape each problem expects, then call the tool again. Retryable (unchanged call): no.",
        );
        // `retryable: false` is about the unchanged call: a program that corrects the input makes
        // a new call, which runs.
        const corrected = yield* executeOnce(
          client,
          "Correct the input after a validation error that is not retryable, then call again",
          `const find = tools[${JSON.stringify(slug)}].find;
try { return await find({query: "fixture text"}); } catch (error) {
  const { retryable } = JSON.parse(error.message);
  return { retryable, value: await find({query: {text: "fixture text"}}) };
}`,
          "input-shape-corrected-result.json",
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Completed)(corrected.structured)).execution.value,
        ).toEqual({ retryable: false, value: "fixture text" });
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
          "InputInvalid (HTTP 422): Input failed validation: input.filter: Expected object {tag} Recovery: Change the input to the shape each problem expects, then call the tool again. Retryable (unchanged call): no.",
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
          "InputInvalid (HTTP 422): Input failed validation: input.child: Expected object {child?, name, ...} or object {child?, id, ...}. Closest is alternative 1, whose problems follow; input.child.name: Missing key Recovery: Change the input to the shape each problem expects, then call the tool again. Retryable (unchanged call): no.",
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
        // The agent learns that the app's own policy refused the call and not to repeat it, not
        // only the error's name. The policy is the app's code and ran after the app received the
        // mutation, so the refusal does not show that nothing changed.
        expect(error.message).toBe(
          `ToolBlocked (HTTP 403): The approval policy in the app’s code denied this call to “remove”. Recovery: ${unknownOutcomeAction} Retryable (unchanged call): no.`,
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
        expect(recovery.recovery.action).toBe(unknownOutcomeAction);
        expect(recovery.recovery.instructions).toContain(
          "For a call that only reads, the advice for this failure is: “Check what the app’s approval policy requires for this tool.",
        );
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
          `The approval policy in the app’s code denied this call to “remove”. ${unknownOutcomeAction}`,
        );
        yield* browser.checkpoint("Denied tool call in the dashboard");
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.mcpExecuteApprovalSize.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          mcp = yield* McpClient,
          browser = yield* Browser,
          evidence = yield* Evidence;
        const { client, key, slug } = yield* hostedAppFiles("Large approval", publishAppFiles);
        const app = `tools[${JSON.stringify(slug)}]`;
        // `body` is a JavaScript expression evaluated by the program.
        const publish = (title: string, body: string) =>
          `${app}.publish({ title: ${JSON.stringify(title)}, body: ${body} })`;
        const ascii = (length: number) => `"A".repeat(${length})`;
        const ended = (length: number) => `"A".repeat(${length}) + ${JSON.stringify(ending)}`;
        const runs = (label: string, file: string) =>
          Effect.gen(function* () {
            const read = yield* executeOnce(client, label, `return await ${app}.runs({});`, file);
            return (yield* Schema.decodeUnknownEffect(Completed)(read.structured)).execution.value;
          });
        const accept = (label: string, requestId: string, file: string) =>
          Effect.gen(function* () {
            const resumed = yield* client.use(label, (client, signal) =>
              client.callTool(
                { name: "resume", arguments: { requestId, response: { action: "accept" } } },
                undefined,
                { signal, timeout: 55_000 },
              ),
            );
            yield* evidence.json(file, resumed.structuredContent);
            return (yield* Schema.decodeUnknownEffect(Completed)(resumed.structuredContent))
              .execution;
          });

        // 40 KB of arguments: well inside the 64 KiB execute result, but not when it holds them twice.
        const parked = yield* executeOnce(
          client,
          "Ask approval for a call with 40 KB of arguments",
          `return await ${publish("Weekly report", ascii(40_000))};`,
          "large-approval.json",
        );
        expect(parked.structured).toMatchObject({ status: "approval-required" });
        const pending = yield* Schema.decodeUnknownEffect(PublishPending)(parked.structured);
        // The request binds the exact arguments; its saved prompt shortens the long value, saying
        // how long it is.
        expect(pending.invocation.input).toEqual({
          title: "Weekly report",
          body: "A".repeat(40_000),
        });
        expect(pending.elicitation.message).toContain("Approve publish?");
        expect(pending.elicitation.message).toContain('"title": "Weekly report"');
        expect(pending.elicitation.message).toContain(`"${"A".repeat(100)}`);
        expect(pending.elicitation.message).toContain('"… (40000 characters)');
        expect(pending.elicitation.message).toContain(
          "Approving runs the call with the complete arguments",
        );
        expect(pending.elicitation.message.length).toBeLessThan(5_000);
        expect(
          yield* accept(
            "Approve the call with 40 KB of arguments",
            pending.requestId,
            "large-approval-resumed.json",
          ),
        ).toMatchObject({ ok: true, value: { title: "Weekly report", length: 40_000 } });

        // 60 KB of ASCII still fits once, so it is offered and runs.
        const boundary = yield* executeOnce(
          client,
          "Ask approval for a call with 60 KB of arguments",
          `return await ${publish("Boundary report", ascii(60_000))};`,
          "boundary-approval.json",
        );
        const near = yield* Schema.decodeUnknownEffect(PublishPending)(boundary.structured);
        expect(near.invocation.input.body).toHaveLength(60_000);
        expect(
          yield* accept(
            "Approve the call with 60 KB of arguments",
            near.requestId,
            "boundary-approval-resumed.json",
          ),
        ).toMatchObject({ ok: true, value: { title: "Boundary report", length: 60_000 } });

        // Arguments the execute result cannot hold once are refused with the request's size and
        // the limit, not only the error's name.
        const refusal =
          /^ApprovalTooLarge \(HTTP 413\): The approval request for “publish” is (\d+) bytes, over the 65536-byte limit for an approval request, so Executor did not ask for approval and will not run the call\. Recovery: Make the arguments smaller/u;
        const refusedBytes = (label: string, body: string, file: string) =>
          Effect.gen(function* () {
            const refused = yield* executeOnce(
              client,
              label,
              `return await ${publish("Oversized report", body)};`,
              file,
            );
            const { error } = (yield* Schema.decodeUnknownEffect(Failed)(refused.structured))
              .execution;
            expect(error.response).toEqual({ code: "ApprovalTooLarge", status: 413 });
            const measured = refusal.exec(error.message);
            if (measured === null) return yield* Effect.die(`Unexpected refusal: ${error.message}`);
            return { bytes: Number(measured[1]), structured: refused.structured };
          });
        const refused = yield* refusedBytes(
          "Ask approval for a call with 70 KB of arguments",
          ascii(70_000),
          "oversized-approval.json",
        );
        expect(refused.bytes).toBeGreaterThan(70_000);
        expect(refused.bytes).toBeLessThan(75_000);
        // 25,000 three-byte characters: short in characters, but over the limit in UTF-8 bytes.
        const multibyte = yield* refusedBytes(
          "Ask approval for a call with 25,000 euro signs",
          `"€".repeat(25_000)`,
          "oversized-multibyte-approval.json",
        );
        expect(multibyte.bytes).toBeGreaterThan(75_000);
        const caught = yield* executeOnce(
          client,
          "Catch the oversized approval and read its recovery",
          `try { await ${publish("Oversized report", ascii(70_000))}; return "ran"; } catch (error) { return error.message; }`,
          "oversized-approval-caught.json",
        );
        const recovery = yield* Schema.decodeUnknownEffect(CaughtRecovery)(
          (yield* Schema.decodeUnknownEffect(Completed)(caught.structured)).execution.value,
        );
        expect(recovery).toMatchObject({ code: "ApprovalTooLarge", status: 413 });
        expect(recovery.recovery.instructions).toContain(
          "Calling it again with the same arguments fails the same way",
        );
        expect(recovery.recovery.instructions).toContain("a URL");
        const uncaught = yield* Schema.decodeUnknownEffect(UncaughtRecovery)(refused.structured);
        expect(uncaught.execution.error.response.recovery).toEqual(recovery.recovery);
        // None of the refused calls ran.
        expect(yield* runs("Read the runs after the refusals", "runs-after-refusal.json")).toEqual([
          { title: "Weekly report", length: 40_000 },
          { title: "Boundary report", length: 60_000 },
        ]);

        // An app's own question too large to return reaches the app as an invalid request, and
        // the program finishes instead of waiting for an answer.
        const asked = yield* executeOnce(
          client,
          "Ask a question larger than an execute result",
          `return await ${app}.ask({});`,
          "oversized-question.json",
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Completed)(asked.structured)).execution,
        ).toMatchObject({ ok: true, value: { reason: "invalid-request" } });

        // The browser review shows the exact arguments, so its end is visible, and approving
        // there runs the call.
        yield* browser.login(actors.owner);
        const linked = yield* mcp.connect(key, "large-approval-browser", {
          organization: actors.organization.id,
          mode: "browser",
        });
        const reviewed = yield* linked.use(
          "Ask approval in the browser for a call with 40 KB of arguments",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: { code: `return await ${publish("Browser report", ended(40_000))};` },
              },
              undefined,
              { signal, timeout: 55_000 },
            ),
        );
        yield* evidence.json("browser-large-approval.json", reviewed.structuredContent);
        const link = yield* Schema.decodeUnknownEffect(LinkedPending)(reviewed.structuredContent);
        expect(link.elicitation.message).not.toContain(ending);
        const url = new URL(link.approvalUrl);
        expect(
          yield* browser.use("The review page shows the end of the long argument", (page) =>
            page
              .goto(`${url.pathname}${url.search}`)
              .then(() =>
                page.getByRole("heading", { name: "Review tool request", exact: true }).waitFor(),
              )
              .then(() => page.getByText(ending, { exact: false }).count()),
          ),
        ).toBe(1);
        yield* browser.checkpoint("Review of a call with 40 KB of arguments");
        yield* browser.use("Approve the call in the browser", (page) =>
          page
            .getByRole("button", { name: "Approve", exact: true })
            .click()
            .then(() => page.getByText("Response saved", { exact: true }).waitFor()),
        );
        const collected = yield* linked.use(
          "Collect the browser approval through resume",
          (client, signal) =>
            client.callTool(
              { name: "resume", arguments: { requestId: link.requestId } },
              undefined,
              { signal, timeout: 55_000 },
            ),
        );
        yield* evidence.json("browser-large-approval-resumed.json", collected.structuredContent);
        expect(
          (yield* Schema.decodeUnknownEffect(Completed)(collected.structuredContent)).execution,
        ).toMatchObject({ ok: true, value: { title: "Browser report", length: 40_015 } });

        // A native client is sent only the prompt. It shows the exact arguments when they fit an
        // execute result, and the shortened prompt above that, so larger calls are approved too.
        const native = yield* mcp.connect(key, "large-approval-native", {
          organization: actors.organization.id,
          mode: "native",
        });
        const nativeCall = (label: string, title: string, body: string, file: string) =>
          Effect.gen(function* () {
            const approved = yield* native.use(label, (client, signal) =>
              client.callTool(
                { name: "execute", arguments: { code: `return await ${publish(title, body)};` } },
                undefined,
                { signal, timeout: 55_000 },
              ),
            );
            yield* evidence.json(file, approved.structuredContent);
            return (yield* Schema.decodeUnknownEffect(Completed)(approved.structuredContent))
              .execution;
          });
        expect(
          yield* nativeCall(
            "Approve a call with 40 KB of arguments shown in full",
            "Native exact report",
            ended(40_000),
            "native-exact-approval.json",
          ),
        ).toMatchObject({ ok: true, value: { title: "Native exact report", length: 40_015 } });
        expect(
          yield* nativeCall(
            "Approve a call with 100 KB of arguments in the client's prompt",
            "Native report",
            ascii(100_000),
            "native-large-approval.json",
          ),
        ).toMatchObject({ ok: true, value: { title: "Native report", length: 100_000 } });
        const [exactPrompt, shortenedPrompt] = yield* native.prompts;
        yield* evidence.json("native-prompts.json", {
          lengths: (yield* native.prompts).map((prompt) => prompt.length),
        });
        expect(yield* native.elicitationCount).toBe(2);
        expect(exactPrompt).toContain(`Arguments:\n{\n  "title": "Native exact report"`);
        expect(exactPrompt).toContain(`${"A".repeat(1_000)}${ending}"`);
        expect(shortenedPrompt).toContain("Approving runs the call with the complete arguments");
        expect(shortenedPrompt).toContain('"… (100000 characters)');
        expect(shortenedPrompt?.length).toBeLessThan(5_000);
        expect(
          yield* runs("Read the runs after the native approvals", "runs-after-native.json"),
        ).toEqual([
          { title: "Weekly report", length: 40_000 },
          { title: "Boundary report", length: 60_000 },
          { title: "Browser report", length: 40_015 },
          { title: "Native exact report", length: 40_015 },
          { title: "Native report", length: 100_000 },
        ]);
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
                dependencies: withApps(mcpDependencies),
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
  it.effect(scenarios.mcpExecuteCallTimedOut.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const server = yield* refusingMcpServer;
        // The server lists its tools, then never answers a call; the app waits one second for it.
        yield* server.refuse("silent-calls");
        const app = yield* hostedAppFiles("Silent MCP call", mcpAppFiles(server.url, 1_000));

        // The API names the timed-out call and says the server may still finish it. The tool may
        // change data, so the agent is told not to repeat it at all.
        const called = yield* api.request(actors.owner, "POST", `${app.path}/tools/call`, {
          tool: "lookup",
          input: {},
        });
        expect(called.status, JSON.stringify(called.body)).toBe(502);
        expect(called.body).toMatchObject({
          _tag: "ToolCallFailed",
          mcp: { phase: "call", reason: "timeout" },
          mayHaveWritten: true,
          message: expect.stringContaining("did not answer the tool call in time"),
        });
        // The read's one more attempt is not offered for a call that may have written.
        const timedOut = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            recovery: Schema.Struct({ action: Schema.String, instructions: Schema.String }),
          }),
        )(called.body);
        expectUnknownOutcome(
          timedOut.recovery,
          "For a call that only reads, the advice for this failure is: “You may retry once.",
        );
        expect(JSON.stringify(called.body)).not.toContain("keep timing out");

        // An agent's program receives the same explanation with its retry policy, and can read
        // it from a caught error to stop instead of calling again.
        const executed = yield* executeOnce(
          app.client,
          "Call a tool whose MCP server never answers",
          `return await tools[${JSON.stringify(app.slug)}].lookup({});`,
          "silent-call.json",
        );
        const { message, response } = (yield* Schema.decodeUnknownEffect(ToolFailed)(
          executed.structured,
        )).execution.error;
        expect(message).toBe(
          `ToolCallFailed (HTTP 502): The app’s MCP server did not answer the tool call in time, so Executor stopped waiting. The server may still finish it. Recovery: ${unknownOutcomeAction} Retryable (unchanged call): no.`,
        );
        expect(message).not.toContain("The app threw");
        expect(response).toMatchObject({ code: "ToolCallFailed", retryable: false });
        expectUnknownOutcome(response.recovery, "Do not expose credentials.");
        const caught = yield* executeOnce(
          app.client,
          "Read the retry policy from a caught tool error",
          `try { await tools[${JSON.stringify(app.slug)}].lookup({}); return "answered"; } catch (error) { return JSON.parse(error.message).retryable; }`,
          "silent-call-caught.json",
        );
        expect(caught.structured).toMatchObject({ execution: { ok: true, value: false } });

        // A tool that only reads cannot repeat a change, so one more attempt is offered, and the
        // retry flag says so too.
        const peeked = yield* executeOnce(
          app.client,
          "Call a read-only tool whose MCP server never answers",
          `return await tools[${JSON.stringify(app.slug)}].peek({});`,
          "silent-read.json",
        );
        const read = (yield* Schema.decodeUnknownEffect(ToolFailed)(peeked.structured)).execution
          .error;
        expect(read.response).toMatchObject({
          code: "ToolCallFailed",
          retryable: true,
          recovery: {
            action: "You may retry once. If it times out again, investigate before repeating it.",
            instructions:
              "The server may still complete the first attempt. For a read, you may retry once; if it times out again, check the server’s status before repeating it. Reduce the input only if that still meets the task. Do not expose credentials.",
          },
        });
        expect(read.message).toMatch(/ Retryable \(unchanged call\): yes\.$/);
        // A program can follow the flag: it repeats the read once, unchanged, and stops there.
        const retried = yield* executeOnce(
          app.client,
          "Repeat a timed-out read once when its error says it is retryable",
          `const call = () => tools[${JSON.stringify(app.slug)}].peek({});
let retries = 0;
try { return await call(); } catch (error) {
  if (!JSON.parse(error.message).retryable) throw error;
  retries += 1;
  try { return await call(); } catch (again) { return { retries, retryable: JSON.parse(again.message).retryable }; }
}`,
          "silent-read-retried.json",
        );
        expect(retried.structured).toMatchObject({
          execution: { ok: true, value: { retries: 1, retryable: true } },
        });
        // Every call reached the server once; Executor repeated none of them, and the program's
        // own retry is the one extra read.
        expect(yield* server.silentCalls).toBe(6);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.mcpExecuteCallDropped.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const server = yield* refusingMcpServer;
        // The server runs each call, then its connection closes before it answers.
        yield* server.refuse("dropped-calls");
        const app = yield* hostedAppFiles("Dropped MCP call", mcpAppFiles(server.url));

        // The call may have changed data and its outcome is unknown, so the agent is told not to
        // repeat it.
        const called = yield* api.request(actors.owner, "POST", `${app.path}/tools/call`, {
          tool: "lookup",
          input: {},
        });
        expect(called.status, JSON.stringify(called.body)).toBe(502);
        expect(called.body).toMatchObject({
          _tag: "ToolCallFailed",
          mcp: { phase: "call", reason: "request" },
          mayHaveWritten: true,
          message:
            "The request to the app’s MCP server failed before the server answered the tool call, so Executor cannot tell whether the server ran it.",
          recovery: { action: unknownOutcomeAction },
        });
        expect(called.body).not.toHaveProperty("mcp.status");
        expect(called.body).not.toHaveProperty("mcp.upstream");

        const executed = yield* executeOnce(
          app.client,
          "Call a tool whose MCP server closes the connection after running it",
          `return await tools[${JSON.stringify(app.slug)}].lookup({});`,
          "dropped-call.json",
        );
        const write = (yield* Schema.decodeUnknownEffect(ToolFailed)(executed.structured)).execution
          .error;
        expect(write.response).toMatchObject({ code: "ToolCallFailed", retryable: false });
        expectUnknownOutcome(
          write.response.recovery,
          "For a call that only reads, the advice for this failure is: “Retry at most once.",
        );
        expect(write.message).toBe(
          `ToolCallFailed (HTTP 502): The request to the app’s MCP server failed before the server answered the tool call, so Executor cannot tell whether the server ran it. Recovery: ${unknownOutcomeAction} Retryable (unchanged call): no.`,
        );
        expect(write.message).not.toContain("Try again");

        // The same failure of a read can be repeated: it cannot repeat a change.
        const peeked = yield* executeOnce(
          app.client,
          "Call a read-only tool whose MCP server closes the connection after running it",
          `return await tools[${JSON.stringify(app.slug)}].peek({});`,
          "dropped-read.json",
        );
        const read = (yield* Schema.decodeUnknownEffect(ToolFailed)(peeked.structured)).execution
          .error;
        expect(read.response).toMatchObject({
          code: "ToolCallFailed",
          retryable: true,
          recovery: {
            action:
              "Retry at most once. If it fails again, check the server’s status and connection.",
          },
        });
        expect(read.message).toMatch(/ Retryable \(unchanged call\): yes\.$/);
        // The server ran every call exactly once: Executor repeated none of them.
        expect(yield* server.droppedCalls).toEqual(["lookup", "lookup", "peek"]);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.mcpExecutePendingWriteRefused.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const service = yield* recordingService;
        const app = yield* hostedApp("Pending write", pendingWriteAppSource(service.url));
        const tools = `tools[${JSON.stringify(app.slug)}]`;
        const read = (label: string, file: string) =>
          executeOnce(app.client, label, `return await ${tools}.records({});`, file).pipe(
            Effect.flatMap(({ structured }) =>
              Schema.decodeUnknownEffect(
                Schema.Struct({
                  execution: Schema.Struct({
                    ok: Schema.Literal(true),
                    value: Schema.Struct({ records: Schema.Array(Schema.String) }),
                  }),
                }),
              )(structured),
            ),
            Effect.map(({ execution }) => execution.value.records),
          );
        for (const [status, name] of [
          ["401", "first"],
          ["429", "second"],
        ] as const) {
          // The service accepts the record to save later, then refuses the call's quota check at
          // once. The refused request did not run, but the call's change is still pending.
          const executed = yield* executeOnce(
            app.client,
            `Save a record while the service refuses another request with HTTP ${status}`,
            `return await ${tools}.save({ name: ${JSON.stringify(name)}, status: ${JSON.stringify(status)} });`,
            `pending-write-${status}.json`,
          );
          const { message, response } = (yield* Schema.decodeUnknownEffect(ToolFailed)(
            executed.structured,
          )).execution.error;
          expect(response).toMatchObject({ code: "AppProviderFailed", retryable: false });
          expectUnknownOutcome(response.recovery);
          expect(message).toContain(`(HTTP ${status}) while calling a tool.`);
          expect(
            message.endsWith(` Recovery: ${unknownOutcomeAction} Retryable (unchanged call): no.`),
          ).toBe(true);
          // A read right after the failure shows nothing saved, yet the change still lands.
          expect(
            yield* read(
              "Read the records right after the failure",
              `pending-write-${status}-read.json`,
            ),
          ).not.toContain(name);
          yield* service.commit;
          expect(
            yield* read(
              "Read the records once the service saved them",
              `pending-write-${status}-later.json`,
            ),
          ).toContain(name);
        }

        // The HTTP API records that the call may have written.
        const called = yield* api.request(actors.owner, "POST", `${app.path}/tools/call`, {
          tool: "save",
          input: { name: "third", status: "429" },
        });
        expect(called.status, JSON.stringify(called.body)).toBe(502);
        expect(called.body).toMatchObject({
          _tag: "AppProviderFailed",
          reason: "rate_limited",
          status: 429,
          mayHaveWritten: true,
          recovery: { action: unknownOutcomeAction },
        });
        yield* service.commit;

        // The same refusal of a read changed nothing, so it keeps its own retry advice.
        const limited = yield* executeOnce(
          app.client,
          "Check the quota while the service refuses with HTTP 429",
          `return await ${tools}.quota({ status: "429" });`,
          "pending-write-read-limited.json",
        );
        const read429 = (yield* Schema.decodeUnknownEffect(ToolFailed)(limited.structured))
          .execution.error;
        expect(read429.response).toMatchObject({
          code: "AppProviderFailed",
          retryable: true,
          recovery: { action: "Wait for the service’s rate limit to reset before trying again." },
        });
        // Each call ran once: Executor repeated none of them.
        expect(yield* service.saved).toEqual(["first", "second", "third"]);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.mcpExecuteNestedMcpAfterWrite.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const service = yield* recordingService;
        const app = yield* hostedAppFiles(
          "Nested MCP after write",
          nestedMcpAppFiles(service.url, yield* closedMcpUrl),
        );
        const tools = `tools[${JSON.stringify(app.slug)}]`;
        const unreachable =
          "Executor’s request to the app’s MCP server failed before the server answered, while connecting.";

        // The tool saves a record, then cannot reach the MCP server it syncs with. The failure
        // is the same as one while loading the app's tools, but the tool has already written.
        const called = yield* api.request(actors.owner, "POST", `${app.path}/tools/call`, {
          tool: "sync",
          input: { name: "first" },
        });
        expect(called.status, JSON.stringify(called.body)).toBe(502);
        expect(called.body).toMatchObject({
          _tag: "AppEvaluationFailed",
          mcp: { phase: "transport", reason: "request" },
          mayHaveWritten: true,
          message: unreachable,
          recovery: { action: unknownOutcomeAction },
        });
        const executed = yield* executeOnce(
          app.client,
          "Call a tool that writes and then cannot reach its MCP server",
          `return await ${tools}.sync({ name: "second" });`,
          "nested-mcp-after-write.json",
        );
        const write = (yield* Schema.decodeUnknownEffect(ToolFailed)(executed.structured)).execution
          .error;
        expect(write.response).toMatchObject({ code: "AppEvaluationFailed", retryable: false });
        expectUnknownOutcome(
          write.response.recovery,
          readAdvice(
            "Try again. If this continues, check the MCP server’s address and status. Use the reported phase and error to identify the failure. Check the server URL, transport or access settings only when relevant. Do not expose credentials.",
          ),
        );
        expect(write.message).toBe(
          `AppEvaluationFailed (HTTP 502): ${unreachable} Recovery: ${unknownOutcomeAction} Retryable (unchanged call): no.`,
        );
        // Both calls saved their record before the MCP connection failed.
        expect(yield* service.saved).toEqual(["first", "second"]);

        // The same failure in a read changed nothing, so it may be repeated.
        const checked = yield* executeOnce(
          app.client,
          "Call a read that cannot reach its MCP server",
          `return await ${tools}.check({});`,
          "nested-mcp-read.json",
        );
        const read = (yield* Schema.decodeUnknownEffect(ToolFailed)(checked.structured)).execution
          .error;
        expect(read.response).toMatchObject({
          code: "AppEvaluationFailed",
          retryable: true,
          recovery: {
            action: "Try again. If this continues, check the MCP server’s address and status.",
          },
        });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.mcpExecuteResolveWrote.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const service = yield* recordingService;
        const app = yield* hostedApp("Resolve wrote", resolveWritesAppSource(service.url));
        const tools = `tools[${JSON.stringify(app.slug)}]`;
        const optionsFailure =
          "Executor could not load this app’s tool definitions. The app threw McpOptionsInvalid (invalid_option): mcpRouter received an option it cannot use.";
        const failedTool = (code: string, label: string, file: string) =>
          executeOnce(app.client, label, `return await ${tools}.${code};`, file).pipe(
            Effect.flatMap((executed) =>
              Schema.decodeUnknownEffect(ToolFailed)(executed.structured),
            ),
            Effect.map(({ execution }) => execution.error),
          );

        // The app saved a record while resolving the mutation, then threw an error named like a
        // configuration failure. Its name and fields come from the app, so the call's outcome is
        // unknown and it is not offered as a retry.
        const called = yield* api.request(actors.owner, "POST", `${app.path}/tools/call`, {
          tool: "configure",
          kind: "mutation",
          input: {},
        });
        expect(called.status, JSON.stringify(called.body)).toBe(502);
        expect(called.body).toMatchObject({
          _tag: "AppEvaluationFailed",
          failure: { errorName: "McpOptionsInvalid", code: "invalid_option" },
          mayHaveWritten: true,
          message: optionsFailure,
          recovery: { action: unknownOutcomeAction },
        });
        expect(yield* service.saved).toEqual(["configure"]);

        const configure = yield* failedTool(
          "configure({})",
          "Call a mutation whose app wrote and then reported invalid options",
          "resolve-wrote-mutation.json",
        );
        expect(configure.response).toMatchObject({
          code: "AppEvaluationFailed",
          retryable: false,
        });
        expectUnknownOutcome(configure.response.recovery);
        expect(configure.response.recovery.instructions).toContain(
          "For a call that only reads, the advice for this failure is: “Try again. If this continues, investigate this error and fix its cause.",
        );
        expect(configure.message).toBe(
          `AppEvaluationFailed (HTTP 502): ${optionsFailure} Recovery: ${unknownOutcomeAction} Retryable (unchanged call): no.`,
        );
        // One record for each call: the agent was not told to repeat either.
        expect(yield* service.saved).toEqual(["configure", "configure"]);

        // An unavailable app cache while resolving a write is outcome unknown too.
        const warm = yield* failedTool(
          "warm({})",
          "Call a mutation whose app wrote and then reported an unavailable cache",
          "resolve-wrote-cache.json",
        );
        expect(warm.response).toMatchObject({ code: "AppEvaluationFailed", retryable: false });
        expectUnknownOutcome(warm.response.recovery);
        expect(warm.message).toContain("Retryable (unchanged call): no.");
        expect(yield* service.saved).toEqual(["configure", "configure", "warm"]);

        // The app reports that the arguments could not be used; for a write that may have run,
        // the copy does not claim that anything was not sent.
        const send = yield* failedTool(
          "send({})",
          "Call a mutation whose app wrote and then reported unusable MCP arguments",
          "resolve-wrote-mcp.json",
        );
        expect(send.response).toMatchObject({ code: "ToolCallFailed", retryable: false });
        expectUnknownOutcome(send.response.recovery);
        expect(send.message).toContain(
          "The app reported that it could not use the input as the MCP tool’s arguments.",
        );
        expect(send.message).not.toMatch(/not (be )?sent/i);
        expect(send.response.recovery.instructions).not.toMatch(/not (be )?sent/i);
        expect(yield* service.saved).toEqual(["configure", "configure", "warm", "send"]);

        // The same failure in a read keeps its advice to try again.
        const inspect = yield* failedTool(
          "inspect({})",
          "Call a read whose app reported invalid options",
          "resolve-read.json",
        );
        expect(inspect.response).toMatchObject({
          code: "AppEvaluationFailed",
          retryable: true,
          recovery: {
            action: "Try again. If this continues, investigate this error and fix its cause.",
          },
        });
        expect(inspect.message).toContain("Retryable (unchanged call): yes.");
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.mcpExecuteWriteFailureSurfaces.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry,
          browser = yield* Browser;
        // Every error the call route declares is either one a write reports after its app code
        // received the call, checked below on every surface, or one reported before it. A new
        // error fails here until it is classified.
        const document = yield* api.request(yield* api.session(), "GET", "/openapi.json");
        expect(document.status).toBe(200);
        const fields = new Map(
          declaredErrors(
            document.body,
            "/api/organizations/{organization}/apps/{app}/tools/call",
            "post",
          ),
        );
        const declared = new Set(fields.keys());
        yield* evidence.json("call-route-errors.json", [...declared].sort());
        expect(
          [...declared].filter(
            (tag) =>
              !(tag in afterTheApp) && !beforeTheApp.includes(tag) && !eitherSide.includes(tag),
          ),
        ).toEqual([]);
        const afterIt = [...Object.keys(afterTheApp), ...eitherSide];
        expect(afterIt.filter((tag) => !declared.has(tag))).toEqual([]);
        // Every error a call can report after the hand-off can record the write.
        expect(afterIt.filter((tag) => !fields.get(tag)?.includes("mayHaveWritten"))).toEqual([]);

        /** Every message a request's trace recorded, once its tool call span was delivered. */
        const recorded = (trace: string) =>
          Effect.gen(function* () {
            const spans = (yield* telemetry.query(trace)).data;
            if (!spans.some(({ span }) => span.operationName === "sdk.tools.call"))
              return yield* Effect.fail(new Error(`The trace ${trace} has not been delivered`));
            return spans.flatMap(({ span }) => [
              ...span.events.flatMap(({ name, attributes }) =>
                name === "exception" ? [`${attributes["exception.message"]}`] : [],
              ),
              ...(span.statusMessage === undefined ? [] : [span.statusMessage]),
            ]);
          }).pipe(Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }));

        for (const [mode, database] of [
          ["worker", false],
          ["facet", true],
        ] as const) {
          const app = yield* hostedAppFiles(`Write failures ${mode}`, [
            { path: "index.ts", content: writeFailuresAppSource },
            appsManifest,
            ...databaseFiles(database),
          ]);
          const tools = `tools[${JSON.stringify(app.slug)}]`;
          const call = (tool: string, kind: "query" | "mutation", input: object = {}) =>
            api.request(actors.owner, "POST", `${app.path}/tools/call`, { tool, kind, input });
          const marker = (tag: string) =>
            call("marker", "query", { tag }).pipe(Effect.map((read) => read.body));
          const cases = [
            ...Object.entries(afterTheApp).map(([tool, { status }]) => ({
              tool,
              code: tool,
              status,
            })),
            ...Object.keys(forgedTags).map((tool) => ({
              tool,
              code: "AppEvaluationFailed",
              status: 502,
            })),
          ];
          for (const { tool, code, status } of cases) {
            const label = `${mode} ${tool}`;
            // REST: the error keeps its code and status, records the write, and leads with the
            // instruction not to repeat the call.
            const rest = yield* call(tool, "mutation");
            const trace = (yield* evidence.requests).at(-1)?.traceId;
            expect(rest.status, JSON.stringify(rest.body)).toBe(status);
            const failure = yield* Schema.decodeUnknownEffect(RestFailure)(rest.body);
            expect(failure, label).toMatchObject({ _tag: code, mayHaveWritten: true });
            if (failure.recovery === undefined)
              expect(failure.message.startsWith(`${unknownOutcomeAction} `), label).toBe(true);
            else expectUnknownOutcome(failure.recovery);
            for (const text of [
              failure.message,
              failure.recovery?.action ?? "",
              failure.recovery?.instructions ?? "",
            ])
              expectNoRepeatAdvice(text, `${label} REST`);
            // The write happened.
            expect(yield* marker(tool), label).toBe("written");
            // Traces record no claim about what ran.
            if (trace === undefined) return yield* Effect.die("The call's trace was not recorded");
            const messages = yield* recorded(trace);
            yield* evidence.json(`write-failure-${mode}-${tool}-recorded.json`, messages);
            for (const message of messages) expectNoRepeatAdvice(message, `${label} recorded`);
            if (tool === "ToolApprovalRequired") continue;
            // MCP execute: the agent is told the same, and the call is never offered as a retry.
            const executed = yield* executeOnce(
              app.client,
              `Call a ${mode} mutation that wrote and then failed with ${tool}`,
              `return await ${tools}.${tool}({});`,
              `write-failure-${mode}-${tool}.json`,
            );
            const failed = (yield* Schema.decodeUnknownEffect(ToolFailed)(executed.structured))
              .execution.error;
            expect(failed.response, label).toMatchObject({ code, retryable: false });
            expectUnknownOutcome(failed.response.recovery);
            expect(failed.message.startsWith(`${code} (HTTP ${status}): `), failed.message).toBe(
              true,
            );
            expect(failed.message, label).toContain(
              `Recovery: ${unknownOutcomeAction} Retryable (unchanged call): no.`,
            );
            expectNoRepeatAdvice(failed.message, `${label} MCP`);
            expectNoRepeatAdvice(failed.response.recovery.instructions, `${label} MCP`);
          }

          // A kind mismatch states what happened without telling the agent to call again.
          const mismatch = yield* call("ToolKindMismatch", "mutation");
          expect(mismatch.body).toMatchObject({
            message: `${unknownOutcomeAction} The tool “ToolKindMismatch” is a query, but it was called as a mutation.`,
          });
          const mismatched = (yield* Schema.decodeUnknownEffect(ToolFailed)(
            (yield* executeOnce(
              app.client,
              `Read the ${mode} kind mismatch`,
              `return await ${tools}.ToolKindMismatch({});`,
              `write-failure-${mode}-kind-mismatch.json`,
            )).structured,
          )).execution.error;
          expect(mismatched.message).toBe(
            `ToolKindMismatch (HTTP 409): The tool “ToolKindMismatch” is a query, but it was called as a mutation. Recovery: ${unknownOutcomeAction} Retryable (unchanged call): no.`,
          );
          // A REST caller that cannot present the approval prompt is told the call may have
          // written; MCP still presents the approval, and the approved call runs.
          const approval = yield* call("ToolApprovalRequired", "mutation");
          expect(approval.body).toMatchObject({
            _tag: "ToolApprovalRequired",
            mayHaveWritten: true,
            message: `${unknownOutcomeAction} “ToolApprovalRequired” needs approval, and this request cannot present an approval prompt.`,
          });
          const parked = yield* executeOnce(
            app.client,
            `Ask for approval of the ${mode} mutation`,
            `return await ${tools}.ToolApprovalRequired({});`,
            `write-failure-${mode}-approval.json`,
          );
          const pending = yield* Schema.decodeUnknownEffect(Pending)(parked.structured);
          const resumed = yield* app.client.use("Approve the mutation", (client, signal) =>
            client.callTool(
              {
                name: "resume",
                arguments: { requestId: pending.requestId, response: { action: "accept" } },
              },
              undefined,
              { signal, timeout: 55_000 },
            ),
          );
          expect(
            (yield* Schema.decodeUnknownEffect(Completed)(resumed.structuredContent)).execution,
          ).toMatchObject({ ok: true, value: "ran" });
          // The approval policy's failure is recorded without claiming the tool did not run.
          const policy = yield* call("ToolPolicyFailed", "mutation");
          expect(policy.status).toBe(500);
          const policyTrace = (yield* evidence.requests).at(-1)?.traceId;
          if (policyTrace === undefined)
            return yield* Effect.die("The call's trace was not recorded");
          expect(yield* recorded(policyTrace)).toContain(
            "The tool's approval policy failed before deciding.",
          );
          // A query's refusal keeps its own advice and records no write.
          const read = yield* call("readKind", "query");
          expect(read.status).toBe(409);
          expect(read.body).toMatchObject({
            _tag: "ToolKindMismatch",
            message:
              "The tool “readKind” is a mutation, but it was called as a query. Call it as a mutation.",
          });
          expect(read.body).not.toHaveProperty("mayHaveWritten");
          // The forged reply reached the host: the skill failure's fields came from it.
          const skill = yield* call("SkillLoadFailed", "mutation");
          expect(skill.body).toMatchObject({ skills: { reason: "request", status: 503 } });
          // The calls ran where the case says: the facet loads its build in facet mode.
          yield* telemetry
            .spans("runtime.app.build.load", {
              "executor.app.id": app.id,
              "executor.runtime.mode": mode,
            })
            .pipe(
              Effect.flatMap((spans) =>
                spans.length > 0
                  ? Effect.void
                  : Effect.fail(new Error(`Missing ${mode} build load`)),
              ),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 80 }),
            );
          if (mode === "facet") continue;
          // The dashboard's tool runner shows the same warning instead of its own advice. It
          // presents an approval for review itself, so it never reports ToolApprovalRequired.
          yield* browser.login(actors.owner);
          for (const [tool, description] of [
            [
              "ToolKindMismatch",
              "The tool “ToolKindMismatch” is a query, but it was called as a mutation.",
            ],
          ] as const) {
            yield* browser.use(`Open ${tool} in the Tools tab`, (page) =>
              page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=tools&tool=${tool}`),
            );
            yield* browser.use(`Run ${tool}`, (page) =>
              page.getByRole("button", { name: "Run tool", exact: true }).click(),
            );
            expect(
              yield* browser.use(`The ${tool} failure carries the write warning`, (page) =>
                page
                  .getByRole("alert")
                  .filter({ hasText: unknownOutcomeAction })
                  .waitFor()
                  .then(() =>
                    page.getByRole("alert").filter({ hasText: unknownOutcomeAction }).textContent(),
                  ),
              ),
            ).toBe(`${description} ${unknownOutcomeAction}`);
            yield* browser.checkpoint(`${tool} after a write in the dashboard`);
          }
        }
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.mcpExecuteApprovalSaveFailed.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        // Executor's storage refuses every approval request this organization saves.
        if (!/^[A-Za-z0-9_-]+$/.test(actors.organization.id))
          return yield* Effect.die("Expected an organization ID");
        yield* legacyStorage([
          {
            sql: `CREATE FUNCTION e2e_approval_fault() RETURNS trigger LANGUAGE plpgsql AS $$
              BEGIN RAISE EXCEPTION 'Synthetic storage failure for an e2e approval'; END $$`,
          },
          {
            sql: `CREATE TRIGGER e2e_approval_fault BEFORE INSERT ON executor_tool_approvals
              FOR EACH ROW WHEN (NEW.owner = 'organization:${actors.organization.id}')
              EXECUTE FUNCTION e2e_approval_fault()`,
          },
        ]);
        yield* serverControl("start");
        const app = yield* hostedAppFiles("Approval save failure", [
          { path: "index.ts", content: approvalSaveAppSource },
          appsManifest,
        ]);
        const call = (tool: string, kind: "query" | "mutation") =>
          api.request(actors.owner, "POST", `${app.path}/tools/call`, { tool, kind, input: {} });

        // REST: the policy wrote, then saving its approval request failed. The storage failure
        // keeps its code and status, records the write, and is not offered as a retry.
        const rest = yield* call("guarded", "mutation");
        expect(rest.status, JSON.stringify(rest.body)).toBe(500);
        const failure = yield* Schema.decodeUnknownEffect(RestFailure)(rest.body);
        expect(failure).toMatchObject({
          _tag: "StorageError",
          mayHaveWritten: true,
          message: "Executor could not read or write its saved data.",
        });
        if (failure.recovery === undefined)
          return yield* Effect.die("The storage failure has no recovery");
        expectUnknownOutcome(failure.recovery);
        for (const text of [
          failure.message,
          failure.recovery.action,
          failure.recovery.instructions,
        ])
          expectNoRepeatAdvice(text, "REST");
        expect((yield* call("marker", "query")).body).toBe("written");

        // MCP execute: the agent is told the same, and repeating the call is not advised.
        const executed = yield* executeOnce(
          app.client,
          "Call a mutation whose approval could not be saved",
          `return await tools[${JSON.stringify(app.slug)}].guarded({});`,
          "approval-save-failed.json",
        );
        const failed = (yield* Schema.decodeUnknownEffect(ToolFailed)(executed.structured))
          .execution.error;
        expect(failed.response).toMatchObject({ code: "StorageError", retryable: false });
        expectUnknownOutcome(failed.response.recovery);
        expect(failed.message).toBe(
          `StorageError (HTTP 500): Executor could not read or write its saved data. Recovery: ${unknownOutcomeAction} Retryable (unchanged call): no.`,
        );
        expectNoRepeatAdvice(failed.response.recovery.instructions, "MCP");
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.mcpExecuteUnnamedKindWrote.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const service = yield* recordingService;
        const app = yield* hostedApp("Unnamed kind wrote", unnamedKindAppSource(service.url));
        const call = (kind?: "query", tool = "check") =>
          api.request(actors.owner, "POST", `${app.path}/tools/call`, {
            tool,
            ...(kind === undefined ? {} : { kind }),
            input: {},
          });

        // The caller names no kind. Reading the catalog for it ran the app's factory, which saved
        // a record, before the catalog named the tool a query. The query's cache failure keeps
        // the write warning and is not offered as a retry.
        const unnamed = yield* call();
        expect(unnamed.status, JSON.stringify(unnamed.body)).toBe(502);
        const failure = yield* Schema.decodeUnknownEffect(RestFailure)(unnamed.body);
        expect(unnamed.body).toMatchObject({
          _tag: "ToolCallFailed",
          failure: { errorName: "CacheError", code: "unavailable" },
          mayHaveWritten: true,
        });
        expectUnknownOutcome(failure.recovery);
        for (const text of [
          failure.message,
          failure.recovery?.action ?? "",
          failure.recovery?.instructions ?? "",
        ])
          expectNoRepeatAdvice(text, "unnamed kind");
        // The catalog read and the call each evaluated the factory once; the call ran once and
        // was not repeated.
        expect(yield* service.saved).toEqual(["factory", "factory", "handler"]);

        // The same call named a query keeps the query's own advice.
        const named = yield* call("query");
        expect(named.status, JSON.stringify(named.body)).toBe(502);
        expect(named.body).toMatchObject({
          _tag: "ToolCallFailed",
          recovery: {
            action:
              "Retry once after a short wait. If it fails again, report that the app’s storage is failing.",
          },
        });
        expect(named.body).not.toHaveProperty("mayHaveWritten");
        expect(yield* service.saved).toEqual([
          "factory",
          "factory",
          "handler",
          "factory",
          "handler",
        ]);

        // The same holds when the query's approval policy saved a record and asked for approval:
        // the pending request keeps the caller's missing kind, so REST, which cannot present the
        // prompt, warns about the write instead of saying the tool has not run.
        const pending = yield* call(undefined, "approved");
        expect(pending.status, JSON.stringify(pending.body)).toBe(409);
        const approval = yield* Schema.decodeUnknownEffect(RestFailure)(pending.body);
        expect(approval).toMatchObject({ _tag: "ToolApprovalRequired", mayHaveWritten: true });
        if (approval.recovery === undefined)
          expect(approval.message.startsWith(`${unknownOutcomeAction} `)).toBe(true);
        else expectUnknownOutcome(approval.recovery);
        expect(approval.message).not.toContain("before it runs");
        for (const text of [
          approval.message,
          approval.recovery?.action ?? "",
          approval.recovery?.instructions ?? "",
        ])
          expectNoRepeatAdvice(text, "unnamed kind approval");
        // The first call kept the catalog's listing, which names this tool's kind, so only the
        // call itself evaluated the factory before the policy saved its record.
        expect((yield* service.saved).slice(5)).toEqual(["factory", "policy"]);

        // Named a query, the approval keeps the query's copy.
        const queried = yield* call("query", "approved");
        expect(queried.status, JSON.stringify(queried.body)).toBe(409);
        expect(queried.body).toMatchObject({
          _tag: "ToolApprovalRequired",
          message:
            "“approved” needs approval before it runs, and this request cannot present an approval prompt.",
        });
        expect(queried.body).not.toHaveProperty("mayHaveWritten");
        expect((yield* service.saved).slice(7)).toEqual(["factory", "policy"]);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
