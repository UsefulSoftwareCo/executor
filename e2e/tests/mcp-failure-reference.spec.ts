/**
 * Every failure an MCP agent reads names its cause, the phase it stopped (loading the app,
 * listing its tools or calling one) and the trace of the request that met it, on search, call
 * and execute alike. The Executor app relays the explanation of Executor's own server errors.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { frameworkSession } from "../support/framework.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";
import { appsManifest, mcpSdkVersion, withApps } from "../support/apps-release.ts";

const factoryMarker = "synthetic factory failure";

/** The factory throws its own error: a cause the app states. */
const throwingApp = `import { defineApp } from "apps";
export default defineApp({}, async () => { throw new TypeError(${JSON.stringify(factoryMarker)}); });`;

/**
 * The app's Worker rejects its listing with the text of a runtime limit. The bridge reads the
 * framework's answer through `Response.prototype.json`, which the app replaces, so the Worker
 * stops without an answer from the app's code although nothing failed in the runtime.
 */
const forgedLimit = "Worker exceeded CPU time limit.";
const forgingApp = `import { defineApp, query, object, router } from "apps";
const json = Response.prototype.json;
export default defineApp({}, async () => {
  Response.prototype.json = function () {
    Response.prototype.json = json;
    return Promise.reject(new Error(${JSON.stringify(forgedLimit)}));
  };
  return { tools: router({ ping: query({ input: object({}) }, async () => "pong") }) };
});`;

/** A dynamic router that lists one tool twice, which the framework refuses without details. */
const duplicateApp = `import { defineApp, dynamicRouter, query, object } from "apps";
const ping = { name: "ping", description: "Return pong", inputSchema: { type: "object", properties: {} }, readOnly: true };
export default defineApp({}, {
  tools: dynamicRouter({
    list: async () => [ping, ping],
    resolve: async () => query({ input: object({}) }, async () => "pong"),
  }),
});`;

/** A module whose top-level code throws, so its build fails while Executor loads it. */
const buildMarker = "synthetic module failure";
const throwingModule = `throw new RangeError(${JSON.stringify(buildMarker)});
export default {};`;

/**
 * A tool that reports its service as unavailable without naming the phase, and one whose report
 * claims the service failed while Executor listed the app's tools.
 */
const providerApp = `import { defineApp, query, object, router, ProviderError } from "apps";
export default defineApp({}, { tools: router({
  quota: query({ input: object({}) }, async () => { throw new ProviderError({ reason: "unavailable", status: 503 }); }),
  listing: query({ input: object({}) }, async () => { throw new ProviderError({ reason: "unavailable", phase: "discover", status: 503 }); }),
}) });`;

/** A listing whose service failure claims Executor was calling one of the app's tools. */
const callClaimingApp = `import { defineApp, dynamicRouter, query, object, ProviderError } from "apps";
export default defineApp({}, {
  tools: dynamicRouter({
    list: async () => { throw new ProviderError({ reason: "unavailable", phase: "call", status: 503 }); },
    resolve: async () => query({ input: object({}) }, async () => "pong"),
  }),
});`;

/** Tools from the MCP server at `url`. */
const mcpAppFiles = (url: string) => [
  {
    path: "package.json",
    content: JSON.stringify({
      dependencies: withApps({ "@modelcontextprotocol/sdk": mcpSdkVersion }),
    }),
  },
  {
    path: "index.ts",
    content: `import { defineApp } from "apps";
import { mcpRouter } from "apps/mcp";
export default defineApp({}, async () => ({ tools: await mcpRouter({ url: ${JSON.stringify(url)} }) }));`,
  },
];

/** An MCP server that answers every request with a server error. */
const failingMcpServer = Effect.gen(function* () {
  const services = yield* Layer.build(
    HttpRouter.serve(
      HttpRouter.add("*", "/mcp", Effect.succeed(HttpServerResponse.text("down", { status: 500 }))),
      { disableLogger: true, disableListenLog: true },
    ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  return `http://127.0.0.1:${server.address.port}/mcp`;
});

/** A failure as an agent reads it, with the phase and reference this change adds. */
const Response = Schema.Struct({
  code: Schema.String,
  status: Schema.Number,
  message: Schema.String,
  recovery: Schema.optional(Schema.Struct({ action: Schema.String, instructions: Schema.String })),
  retryable: Schema.Boolean,
  phase: Schema.optional(Schema.String),
  reference: Schema.optional(Schema.String),
});
const Unavailable = Schema.Struct({
  unavailableApps: Schema.Array(
    Schema.Struct({ app: Schema.String, name: Schema.String, reason: Schema.String }),
  ),
});
const decodeResponse = Schema.decodeUnknownSync(Schema.fromJsonString(Response));
const Failed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      kind: Schema.String,
      message: Schema.String,
      response: Schema.optional(Response),
    }),
  }),
  ...Unavailable.fields,
});
const CallFailed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Literal(true),
    value: Schema.Struct({
      path: Schema.String,
      ok: Schema.Literal(false),
      error: Schema.Struct({
        kind: Schema.String,
        message: Schema.String,
        response: Schema.optional(Response),
      }),
    }),
  }),
});

/** The summary line's end: the phase and the request's trace, which the agent can share. */
const located = (phase: string, trace: string) => ` Phase: ${phase}. Reference: ${trace}.`;

/** Deploy an app to the organization for the rest of the scenario. */
const deployer = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}/apps`;
  const deploy = (label: string, files: ReadonlyArray<{ path: string; content: string }>) =>
    Effect.gen(function* () {
      const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
        name: `${label} ${randomUUID().slice(0, 8)}`,
        files,
      });
      expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
      const app = yield* body(App, deployed);
      yield* Effect.addFinalizer(() =>
        api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
      );
      return app;
    });
  return deploy;
});

/** An agent's MCP session, with each failure as that agent reads it and its request's trace. */
const agentSession = Effect.gen(function* () {
  const evidence = yield* Evidence;
  const { client } = yield* frameworkSession;
  /** The trace the client sent with its latest request, which the server continues. */
  const latestTrace = evidence.requests.pipe(
    Effect.map((requests) => {
      const id = requests.at(-1)?.traceId;
      if (id === undefined) throw new Error("The request trace was not recorded");
      return id;
    }),
  );
  const tool = (label: string, name: string, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const result = yield* client.use(label, (client, signal) =>
        client.callTool({ name, arguments: args }, undefined, { signal }),
      );
      const trace = yield* latestTrace;
      yield* evidence.json(`${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}.json`, {
        trace,
        result: result.structuredContent,
      });
      return { trace, result: result.structuredContent };
    });
  const root = (app: { readonly slug: string }) => `tools[${JSON.stringify(app.slug)}]`;
  /** Why search could not list an app, as its agent reads it. */
  const searched = (app: { readonly id: string; readonly slug: string }) =>
    Effect.gen(function* () {
      const { trace, result } = yield* tool(`Search ${app.slug}`, "search", {
        namespace: app.slug,
        query: "",
      });
      const entry = (yield* Schema.decodeUnknownEffect(Unavailable)(result)).unavailableApps.find(
        (entry) => entry.app === app.id,
      );
      if (entry === undefined) throw new Error(`Search listed ${app.slug} as available`);
      return { trace, response: decodeResponse(entry.reason) };
    });
  /** A call into one of the app's tools, as its agent reads it. */
  const called = (app: { readonly slug: string }, name: string) =>
    Effect.gen(function* () {
      const { trace, result } = yield* tool(`Call ${app.slug}`, "call", {
        calls: { path: `${root(app)}.${name}`, input: {} },
      });
      const { error } = (yield* Schema.decodeUnknownEffect(CallFailed)(result)).execution.value;
      return { trace, error };
    });
  /** An execute program that calls one of the app's tools, as its agent reads it. */
  const executed = (app: { readonly slug: string }, name: string) =>
    Effect.gen(function* () {
      const { trace, result } = yield* tool(`Execute ${app.slug}`, "execute", {
        code: `return await ${root(app)}.${name}({});`,
      });
      const { error } = (yield* Schema.decodeUnknownEffect(Failed)(result)).execution;
      return { trace, error };
    });
  return { tool, searched, called, executed };
});

layer(HostedLive, { excludeTestServices: true })("MCP failure reference", (it) => {
  it.effect(scenarios.mcpFailureReference.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence;
        const deploy = yield* deployer;
        const throwing = yield* deploy("Throwing factory", [
          { path: "index.ts", content: throwingApp },
          appsManifest,
        ]);
        const forging = yield* deploy("Forged runtime limit", [
          { path: "index.ts", content: forgingApp },
          appsManifest,
        ]);
        const duplicate = yield* deploy("Duplicate tool names", [
          { path: "index.ts", content: duplicateApp },
          appsManifest,
        ]);
        const provider = yield* deploy("Unavailable service", [
          { path: "index.ts", content: providerApp },
          appsManifest,
        ]);
        const server = yield* deploy("Failing MCP server", mcpAppFiles(yield* failingMcpServer));
        const claiming = yield* deploy("Listing claims a call", [
          { path: "index.ts", content: callClaimingApp },
          appsManifest,
        ]);

        const { tool, searched, called, executed } = yield* agentSession;

        // An app whose factory throws: its own error is the cause, in what Executor was doing.
        const thrownSearch = yield* searched(throwing);
        const thrownCall = yield* called(throwing, "anything");
        const thrownExecute = yield* executed(throwing, "anything");
        // An app whose Worker stops without an answer from its code.
        const forgedSearch = yield* searched(forging);
        const forgedExecute = yield* executed(forging, "ping");
        // An app whose framework refuses its tool list without saying why.
        const duplicateSearch = yield* searched(duplicate);
        // A tool whose service failed without naming the phase: Executor was calling it.
        const unavailableCall = yield* called(provider, "quota");
        const unavailableExecute = yield* executed(provider, "quota");
        // App code that names the opposite phase: a call claiming listing, a listing claiming a call.
        const listingClaimed = yield* called(provider, "listing");
        const callClaimed = yield* searched(claiming);
        // An MCP server that fails while Executor lists the app's tools.
        const serverSearch = yield* searched(server);
        // The Executor app relays Executor's own 502 for the throwing app's tool listing.
        const relayed = yield* tool("Execute tools.index through the Executor app", "execute", {
          code: `return await tools.executor.tools.index({ path: { app: ${JSON.stringify(throwing.id)} } });`,
        }).pipe(
          Effect.flatMap(({ trace, result }) =>
            Schema.decodeUnknownEffect(Failed)(result).pipe(
              Effect.map(({ execution }) => ({ trace, error: execution.error })),
            ),
          ),
        );
        // A build whose module throws while it loads, deployed through the Executor app.
        const buildName = `Throwing module ${randomUUID().slice(0, 8)}`;
        const built = yield* tool("Deploy a throwing module through the Executor app", "execute", {
          code: `return await tools.executor.apps.deploy({ body: { name: ${JSON.stringify(buildName)}, files: ${JSON.stringify([{ path: "index.ts", content: throwingModule }, appsManifest])} } });`,
        }).pipe(
          Effect.flatMap(({ trace, result }) =>
            Schema.decodeUnknownEffect(Failed)(result).pipe(
              Effect.map(({ execution }) => ({ trace, error: execution.error })),
            ),
          ),
        );
        yield* evidence.json("agent-failures.json", {
          thrownSearch,
          thrownCall,
          thrownExecute,
          forgedSearch,
          forgedExecute,
          duplicateSearch,
          unavailableCall,
          unavailableExecute,
          listingClaimed,
          callClaimed,
          serverSearch,
          relayed,
          built,
        });

        // Search, call and execute name the app's own error, the phase and the request's trace.
        // The phase is what Executor was doing, here listing the app's tools before any call: that
        // the app's code reports its definition failed does not make it `evaluate`, which only
        // Executor's own checks set.
        expect(thrownSearch.response).toMatchObject({
          code: "AppEvaluationFailed",
          phase: "discover",
          reference: thrownSearch.trace,
        });
        expect(thrownSearch.response.message).toContain(`TypeError: ${factoryMarker}`);
        expect(thrownCall.error.response).toMatchObject({
          code: "AppEvaluationFailed",
          phase: "discover",
          reference: thrownCall.trace,
        });
        expect(thrownCall.error.message.endsWith(located("discover", thrownCall.trace))).toBe(true);
        expect(thrownExecute.error.response).toMatchObject({
          phase: "discover",
          reference: thrownExecute.trace,
        });
        expect(thrownExecute.error.message).toContain(`TypeError: ${factoryMarker}`);
        expect(thrownExecute.error.message.endsWith(located("discover", thrownExecute.trace))).toBe(
          true,
        );
        // Each request has its own trace.
        expect(new Set([thrownSearch.trace, thrownCall.trace, thrownExecute.trace]).size).toBe(3);

        // A Worker that stopped without an answer names that cause and a bounded retry. The
        // runtime limit the app's own code wrote is a match Executor has not confirmed, never a
        // stated cause, and nothing says whose fault it was.
        const workerStopped =
          "Executor could not load this app’s tool definitions. The app’s Worker stopped without an answer from the app’s code. Its error matches this cause, which Executor has not confirmed: The app's Worker exceeded its CPU time limit.";
        expect(forgedSearch.response).toMatchObject({
          code: "AppEvaluationFailed",
          phase: "discover",
          reference: forgedSearch.trace,
          retryable: true,
          message: workerStopped,
        });
        expect(forgedSearch.response.recovery?.action).toMatch(/^Try again once\. /);
        expect(forgedSearch.response.recovery?.instructions).not.toContain(
          "exceeded its CPU time limit.",
        );
        for (const text of [
          forgedSearch.response.message,
          forgedSearch.response.recovery?.instructions ?? "",
        ])
          expect(text).not.toContain("The runtime reported");
        expect(
          forgedExecute.error.message.startsWith(
            `AppEvaluationFailed (HTTP 502): ${workerStopped} `,
          ),
        ).toBe(true);
        expect(forgedExecute.error.message.endsWith(located("discover", forgedExecute.trace))).toBe(
          true,
        );
        // The framework's refusal without details is named as the framework's report.
        expect(duplicateSearch.response).toMatchObject({
          code: "AppEvaluationFailed",
          phase: "discover",
          reference: duplicateSearch.trace,
          message:
            "Executor could not load this app’s tool definitions. The app’s framework answered HostDeclarationInvalid without details: it reported that the app’s tools or skills are declared in a way it cannot host.",
        });

        // A service failure without a phase of its own is in the call Executor was making.
        expect(unavailableCall.error.response).toMatchObject({
          code: "AppProviderFailed",
          phase: "call",
          reference: unavailableCall.trace,
        });
        expect(
          unavailableExecute.error.message.endsWith(located("call", unavailableExecute.trace)),
        ).toBe(true);
        // A phase the app's code names stays in its message and never chooses the reported one.
        expect(listingClaimed.error.response).toMatchObject({
          code: "AppProviderFailed",
          phase: "call",
          reference: listingClaimed.trace,
        });
        expect(listingClaimed.error.message.endsWith(located("call", listingClaimed.trace))).toBe(
          true,
        );
        expect(callClaimed.response).toMatchObject({
          code: "AppProviderFailed",
          phase: "discover",
          reference: callClaimed.trace,
        });

        // An MCP server's failure while connecting to list its tools is in discovery.
        expect(serverSearch.response).toMatchObject({
          code: "AppProviderFailed",
          phase: "discover",
          reference: serverSearch.trace,
        });
        expect(serverSearch.response.message).toContain("HTTP 500");

        // Through the Executor app, Executor's own explanation of its 502 is quoted, not dropped.
        expect(relayed.error.response).toMatchObject({
          code: "AppProviderFailed",
          phase: "call",
          reference: relayed.trace,
        });
        expect(relayed.error.message).toContain(
          `The service reported AppEvaluationFailed: "Executor could not load this app’s tool definitions. The app threw TypeError: ${factoryMarker}`,
        );

        // A failed build names its stage and the module's own error, in the call that deployed it.
        expect(built.error.response).toMatchObject({ phase: "call", reference: built.trace });
        expect(built.error.message).toContain(`RangeError: ${buildMarker}`);
        expect(built.error.message.endsWith(located("call", built.trace))).toBe(true);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );

  // Cloud's runtime keeps the kind it matched in the forged rejection, as self-host's now does. A
  // cause matched from text the app's isolate can write stays unconfirmed on each target.
  it.effect(scenarios.mcpFailureReferenceMatchedLimit.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const deploy = yield* deployer;
        const forging = yield* deploy("Forged runtime limit", [
          { path: "index.ts", content: forgingApp },
          appsManifest,
        ]);
        const { searched, executed } = yield* agentSession;
        const forgedSearch = yield* searched(forging);
        const forgedExecute = yield* executed(forging, "ping");

        const unconfirmed =
          "Executor could not load this app’s tool definitions. The app’s Worker stopped without an answer from the app’s code. Its error matches this cause, which Executor has not confirmed: The app's Worker exceeded its CPU time limit.";
        expect(forgedSearch.response).toMatchObject({
          code: "AppEvaluationFailed",
          status: 502,
          message: unconfirmed,
          retryable: true,
          phase: "discover",
          reference: forgedSearch.trace,
        });
        expect(forgedExecute.error.response).toMatchObject({
          code: "AppEvaluationFailed",
          message: unconfirmed,
          phase: "discover",
          reference: forgedExecute.trace,
        });
        expect(
          forgedExecute.error.message.startsWith(`AppEvaluationFailed (HTTP 502): ${unconfirmed} `),
        ).toBe(true);
        expect(forgedExecute.error.message.endsWith(located("discover", forgedExecute.trace))).toBe(
          true,
        );
        expect(forgedSearch.trace).not.toBe(forgedExecute.trace);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
