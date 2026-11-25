import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Deferred, Effect, Layer, Schema, Semaphore } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { connectionsPath } from "../support/app-accounts.ts";
import { Evidence } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { withApps, mcpSdkVersion } from "../support/apps-release.ts";

const Wire = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});

interface Received {
  readonly http: "POST" | "GET" | "DELETE";
  readonly method?: string;
  readonly id?: number | string;
  readonly cancels?: Schema.Json;
  readonly session?: string;
  readonly authorization?: string;
  readonly receivedAt: number;
  answeredAt?: number;
}

const deleteAnswerMs = 600;

interface Options {
  readonly awaitingHeaders: number;
  readonly beforeHeadersMs: number;
  readonly deleteMs: number;
}

const sessionServer = (options: Options) =>
  Effect.gen(function* () {
    const received: Received[] = [];
    const gate = yield* Semaphore.make(options.awaitingHeaders);
    const ended = yield* Deferred.make<void>();
    yield* Effect.addFinalizer(() => Deferred.succeed(ended, undefined));
    let sessions = 0;
    const json = (id: number | string, result: Schema.Json, headers?: Record<string, string>) =>
      HttpServerResponse.jsonUnsafe(
        { jsonrpc: "2.0", id, result },
        headers === undefined ? {} : { headers },
      );
    const served = (
      entry: Omit<Received, "receivedAt" | "answeredAt">,
      answer: (entry: Received) => Effect.Effect<HttpServerResponse.HttpServerResponse>,
      beforeHeadersMs = options.beforeHeadersMs,
    ) =>
      Effect.gen(function* () {
        const row: Received = { ...entry, receivedAt: performance.now() };
        received.push(row);
        return yield* gate.withPermits(1)(
          Effect.sleep(beforeHeadersMs).pipe(
            Effect.andThen(answer(row)),
            Effect.tap(() =>
              Effect.sync(() => {
                row.answeredAt = performance.now();
              }),
            ),
          ),
        );
      });
    const headersOf = (request: HttpServerRequest.HttpServerRequest) => ({
      ...(request.headers["mcp-session-id"] === undefined
        ? {}
        : { session: request.headers["mcp-session-id"] }),
      ...(request.headers.authorization === undefined
        ? {}
        : { authorization: request.headers.authorization }),
    });
    const routes = Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/mcp",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          return yield* served({ http: "GET", ...headersOf(request) }, () =>
            Effect.succeed(HttpServerResponse.empty({ status: 405 })),
          );
        }),
      ),
      HttpRouter.add(
        "DELETE",
        "/mcp",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          return yield* served(
            { http: "DELETE", ...headersOf(request) },
            () => Effect.succeed(HttpServerResponse.empty({ status: 200 })),
            options.deleteMs,
          );
        }),
      ),
      HttpRouter.add(
        "POST",
        "/mcp",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const message = yield* request.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Wire)),
            Effect.orDie,
          );
          const id = message.id;
          return yield* served(
            {
              http: "POST",
              method: message.method,
              ...(id === undefined ? {} : { id }),
              ...(message.method === "notifications/cancelled"
                ? { cancels: message.params?.requestId ?? null }
                : {}),
              ...headersOf(request),
            },
            () => {
              if (id === undefined)
                return Effect.succeed(HttpServerResponse.empty({ status: 202 }));
              if (message.method === "initialize")
                return Effect.succeed(
                  json(
                    id,
                    {
                      protocolVersion: "2025-11-25",
                      capabilities: { tools: {} },
                      serverInfo: { name: "Session fixture", version: "1" },
                    },
                    { "mcp-session-id": `session-${++sessions}` },
                  ),
                );
              if (message.method === "tools/list")
                return Effect.succeed(
                  json(id, {
                    tools: ["work", "stall"].map((name) => ({
                      name,
                      description: `Synthetic ${name}`,
                      inputSchema: {
                        type: "object",
                        properties: { i: { type: "number" } },
                        additionalProperties: false,
                      },
                      annotations: { readOnlyHint: true },
                    })),
                  }),
                );
              if (message.method === "tools/call" && message.params?.name === "stall")
                return Deferred.await(ended).pipe(Effect.as(HttpServerResponse.empty()));
              if (message.method === "tools/call")
                return Effect.sleep("100 millis").pipe(
                  Effect.as(
                    json(id, {
                      content: [{ type: "text", text: "done" }],
                      structuredContent: { done: message.params?.arguments ?? null },
                    }),
                  ),
                );
              return Effect.succeed(json(id, {}));
            },
          );
        }),
      ),
    );
    const services = yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      ),
    );
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address)) return yield* Effect.die("Expected a TCP listener");
    return {
      url: `http://127.0.0.1:${server.address.port}/mcp`,
      received,
      reset: Effect.sync(() => {
        received.length = 0;
      }),
    };
  });

const callSessions = (received: readonly Received[]) =>
  new Map(
    received
      .filter((row) => row.method === "tools/call" && row.session !== undefined)
      .map((row) => [row.session!, row] as const),
  );

const shape = (received: readonly Received[], session: string) =>
  received
    .filter((row) => row.session === session)
    .map((row) => (row.method === undefined ? row.http : `${row.http} ${row.method}`))
    .sort();

const completedCall = ["DELETE", "GET", "POST notifications/initialized", "POST tools/call"];

const sessionsEnded = (received: readonly Received[], sessions: readonly string[]) =>
  Effect.gen(function* () {
    const ended = () =>
      sessions.every((session) =>
        received.some(
          (row) => row.http === "DELETE" && row.session === session && row.answeredAt !== undefined,
        ),
      );
    while (!ended()) yield* Effect.sleep("20 millis");
  }).pipe(Effect.timeout("20 seconds"));

const deploy = (url: string, token: string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: `MCP teardown ${randomUUID().slice(0, 8)}`,
      files: [
        {
          path: "package.json",
          content: JSON.stringify({
            dependencies: withApps({ "@modelcontextprotocol/sdk": mcpSdkVersion }),
          }),
        },
        {
          path: "index.ts",
          content: `
import { defineApp, defineProvider, secrets, object, string } from "apps";
import { mcpRouter } from "apps/mcp";
const provider = defineProvider({ name: "Session fixture", hosts: ${JSON.stringify([new URL(url).host])}, auth: { key: secrets({ label: "Token", fields: object({ token: string() }) }) } });
export default defineApp({ app: { accounts: { service: provider } } }, async ({ app, cache, signal }) => ({
  tools: await mcpRouter({
    url: ${JSON.stringify(url)},
    account: app.accounts.service,
    cache,
    headers: { Authorization: "Bearer " + app.accounts.service.fields.token },
    signal,
    // The budget of each call, so a call the server never answers is cancelled within the scenario.
    timeoutMs: 3000,
  }),
}));`,
        },
      ],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const app = yield* body(App, response);
    const path = `${prefix}/apps/${app.id}`;
    yield* Effect.addFinalizer(() => api.request(actors.owner, "DELETE", path).pipe(Effect.orDie));
    const connection = yield* body(
      Resource,
      yield* api.request(actors.owner, "POST", connectionsPath(path, "app", "service"), {}),
    );
    const account = yield* body(
      Resource,
      yield* api.request(actors.owner, "POST", `${prefix}/connections/${connection.id}/submit`, {
        method: "key",
        label: "Session fixture token",
        fields: { token },
      }),
    );
    yield* Effect.addFinalizer(() =>
      api.request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`).pipe(Effect.orDie),
    );
    const key = yield* body(
      Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
      yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
        name: "MCP teardown",
      }),
    );
    yield* Effect.addFinalizer(() =>
      api
        .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
        .pipe(Effect.orDie),
    );
    const client = yield* (yield* McpClient).connect(key.key, "mcp-teardown", {
      organization: actors.organization.id,
    });
    const tools = `tools[${JSON.stringify(app.slug)}]`;
    const execute = (step: string, code: string) =>
      client
        .use(step, (client, signal) =>
          client.callTool({ name: "execute", arguments: { code } }, undefined, {
            signal,
            timeout: 55_000,
          }),
        )
        .pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({
                structuredContent: Schema.Struct({
                  execution: Schema.Struct({
                    ok: Schema.Boolean,
                    value: Schema.optional(Schema.Unknown),
                  }),
                }),
              }),
            ),
          ),
          Effect.map((result) => ({
            ...result.structuredContent.execution,
            returnedAt: performance.now(),
          })),
        );
    return { tools, execute };
  });

const unbounded = { awaitingHeaders: 1000, beforeHeadersMs: 0, deleteMs: deleteAnswerMs };

layer(HostedLive, { excludeTestServices: true })("MCP call teardown", (it) => {
  it.effect(scenarios.mcpCallTeardownCompleted.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence;
        const server = yield* sessionServer(unbounded);
        const token = randomUUID();
        const { tools, execute } = yield* deploy(server.url, token);
        const warm = yield* execute(
          "Discover and call once",
          `return await ${tools}.work({ i: 0 });`,
        );
        expect(warm.ok, JSON.stringify(warm)).toBe(true);
        yield* sessionsEnded(server.received, [...callSessions(server.received).keys()]);
        yield* server.reset;

        const result = yield* execute("Call one tool", `return await ${tools}.work({ i: 1 });`);
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(result.value).toMatchObject({ structuredContent: { done: { i: 1 } } });
        const calls = [...callSessions(server.received).keys()];
        expect(calls).toHaveLength(1);
        const session = calls[0]!;
        yield* sessionsEnded(server.received, [session]);
        yield* evidence.json("completed-call.json", {
          returnedAt: result.returnedAt,
          received: server.received,
        });
        expect(server.received.filter((row) => row.method === "initialize")).toHaveLength(1);
        expect(shape(server.received, session)).toEqual(completedCall);
        expect(server.received.filter((row) => row.method === "notifications/cancelled")).toEqual(
          [],
        );
        const deleted = server.received.find(
          (row) => row.http === "DELETE" && row.session === session,
        )!;
        expect(deleted.authorization).toBe(`Bearer ${token}`);
        expect(result.returnedAt).toBeLessThan(deleted.answeredAt!);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.mcpCallTeardownCancelled.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence;
        const server = yield* sessionServer(unbounded);
        const { tools, execute } = yield* deploy(server.url, randomUUID());
        const warm = yield* execute("Discover the tools", `return await ${tools}.work({ i: 0 });`);
        expect(warm.ok, JSON.stringify(warm)).toBe(true);
        yield* sessionsEnded(server.received, [...callSessions(server.received).keys()]);
        yield* server.reset;

        const result = yield* execute(
          "Complete one call, then give up on another",
          `const done = await ${tools}.work({ i: 1 });
let failed = false;
try { await ${tools}.stall({ i: 2 }); } catch { failed = true; }
return { done: done.structuredContent, failed };`,
        );
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(result.value).toEqual({ done: { done: { i: 1 } }, failed: true });
        const sessions = callSessions(server.received);
        expect(sessions.size).toBe(2);
        const stalled = [...sessions.values()].find((row) => row.answeredAt === undefined);
        expect(stalled).toBeDefined();
        yield* sessionsEnded(server.received, [...sessions.keys()]);
        yield* evidence.json("cancelled-call.json", server.received);
        const cancelled = server.received.filter((row) => row.method === "notifications/cancelled");
        expect(cancelled.map((row) => ({ session: row.session, cancels: row.cancels }))).toEqual([
          { session: stalled!.session, cancels: stalled!.id },
        ]);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.mcpCallTeardownConcurrent.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence;
        const server = yield* sessionServer({
          awaitingHeaders: 6,
          beforeHeadersMs: 200,
          deleteMs: 200,
        });
        const { tools, execute } = yield* deploy(server.url, randomUUID());
        const warm = yield* execute("Discover the tools", `return await ${tools}.work({ i: 0 });`);
        expect(warm.ok, JSON.stringify(warm)).toBe(true);
        yield* sessionsEnded(server.received, [...callSessions(server.received).keys()]);
        yield* server.reset;

        const started = performance.now();
        const result = yield* execute(
          "Call one tool ten times at once",
          `const results = await Promise.all(Array.from({ length: 10 }, (_, i) => ${tools}.work({ i })));
return results.map((result) => result.structuredContent.done.i);`,
        );
        const wallMs = result.returnedAt - started;
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(result.value).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        const sessions = [...callSessions(server.received).keys()];
        expect(sessions).toHaveLength(10);
        yield* sessionsEnded(server.received, sessions);
        yield* evidence.json("concurrent-calls.json", {
          wallMs,
          requests: server.received.length,
          received: server.received,
        });
        expect(server.received.filter((row) => row.method === "notifications/cancelled")).toEqual(
          [],
        );
        for (const session of sessions)
          expect(shape(server.received, session)).toEqual(completedCall);
        expect(server.received).toHaveLength(50);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
