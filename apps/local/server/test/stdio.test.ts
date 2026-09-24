/** Real generated source, npm dependency installation, subprocesses, product HTTP, and an MCP client. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Effect, FileSystem, Layer, ManagedRuntime, Path, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { ExecutorApi, OwnerId, ToolName } from "@executor-js/sdk";
import { DashboardApi } from "../src/contracts/dashboard.ts";
import { ServerConfig } from "../src/contracts/config.ts";
import { ExecuteResult } from "@executor-js/mcp";
import { localApi } from "../src/implementation/server.ts";

const apiKey = "synthetic-stdio-host-key-0000000000000000";
const ProcessEvent = Schema.Struct({ pid: Schema.Number, event: Schema.String });
const hasCode = (error: unknown, code: string) =>
  Schema.is(Schema.Struct({ code: Schema.Literal(code) }))(error);

async function events(directory: string) {
  try {
    return (await readFile(`${directory}/processes.jsonl`, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(ProcessEvent))(line));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
}
function running(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasCode(error, "ESRCH")) return false;
    throw error;
  }
}
async function stopped(directory: string) {
  const deadline = Date.now() + 6_000;
  while (true) {
    const alive = [...new Set((await events(directory)).map((entry) => entry.pid))].filter(running);
    if (alive.length === 0) return;
    assert.ok(Date.now() < deadline, `MCP subprocesses still alive: ${alive.join(", ")}`);
    await delay(20);
  }
}
async function entered(directory: string, after: number, method: string) {
  const deadline = Date.now() + 5_000;
  while (!(await events(directory)).slice(after).some((entry) => entry.event === method)) {
    assert.ok(Date.now() < deadline, `MCP subprocess never entered ${method}`);
    await delay(20);
  }
}

async function start(directory: string) {
  const runtime = ManagedRuntime.make(
    HttpRouter.serve(
      Layer.unwrap(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer;
          if (server.address._tag !== "InetAddressV4") throw new Error("TCP listener required");
          return localApi(
            Schema.decodeUnknownSync(ServerConfig)({
              directory,
              port: server.address.port,
              apiKey,
              encryptionKey: "ab".repeat(32),
            }),
            crypto,
          );
        }),
      ),
      { disableLogger: true },
    ).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      Layer.provide(NodeServices.layer),
    ),
  );
  try {
    const server = await runtime.runPromise(HttpServer.HttpServer);
    if (server.address._tag !== "InetAddressV4") throw new Error("TCP listener required");
    const baseUrl = `http://127.0.0.1:${server.address.port}`;
    const sdk = await Effect.runPromise(
      HttpApiClient.make(ExecutorApi, {
        baseUrl,
        transformClient: (client) =>
          client.pipe(
            HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", `Bearer ${apiKey}`)),
          ),
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );
    const dashboard = await Effect.runPromise(
      HttpApiClient.make(DashboardApi, {
        baseUrl,
        transformClient: (client) =>
          client.pipe(
            HttpClient.mapRequest(
              HttpClientRequest.setHeaders({ authorization: `Bearer ${apiKey}`, origin: baseUrl }),
            ),
          ),
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );
    return { baseUrl, sdk, dashboard: dashboard.dashboard, close: () => runtime.dispose() };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

test(
  "stdio imports are ordinary apps with isolated account environments and owned process lifetimes",
  { timeout: 120_000 },
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-stdio-" });
          const journal = path.join(directory, "journal");
          const workDirectory = path.join(directory, "working directory");
          yield* fs.makeDirectory(journal);
          yield* fs.makeDirectory(workDirectory);
          const cwd = yield* fs.realPath(workDirectory);
          const fixture = yield* path.fromFileUrl(
            new URL("./fixtures/stdio-mcp.ts", import.meta.url),
          );
          yield* Effect.tryPromise({
            try: async () => {
              const server = await start(directory);
              const previous = process.env.EXECUTOR_STDIO_TEST_SECRET;
              process.env.EXECUTOR_STDIO_TEST_SECRET = "synthetic-parent-secret";
              const { sdk, dashboard } = server;
              const argument = 'a path with spaces; $(touch should-not-exist) "quoted"';
              try {
                const app = await Effect.runPromise(
                  dashboard.importCustomApp({
                    payload: {
                      source: {
                        kind: "mcp-stdio",
                        name: "Local account MCP",
                        command: process.execPath,
                        args: [fixture, journal, argument],
                        cwd,
                        environment: ["TEST_TOKEN", "MODE"],
                        timeoutMs: 2_000,
                      },
                    },
                  }),
                );
                assert.deepEqual(
                  await events(journal),
                  [],
                  "deploying must not launch the MCP server",
                );
                const source = await Effect.runPromise(
                  dashboard.source({
                    params: { app: app.id, deployment: app.activeDeployment },
                  }),
                );
                assert.deepEqual(source.files.map((file) => file.path).sort(), [
                  "index.ts",
                  "package.json",
                  "provider.ts",
                ]);
                const manifest = source.files.find((file) => file.path === "package.json");
                assert.ok(manifest);
                assert.equal(
                  Schema.decodeUnknownSync(
                    Schema.fromJsonString(Schema.Struct({ name: Schema.String })),
                  )(manifest.content).name,
                  "local-account-mcp",
                );
                assert.ok(
                  source.files
                    .find((file) => file.path === "index.ts")
                    ?.content.includes('from "apps/mcp/stdio"'),
                );
                assert.ok(
                  !source.files.some((file) => file.content.includes("synthetic-parent-secret")),
                );
                const provider = app.requirements.accounts.service?.provider;
                assert.ok(provider);
                const account = async (token: string, mode = "normal") =>
                  Effect.runPromise(
                    dashboard.addAccount({
                      payload: {
                        provider,
                        method: "environment",
                        label: `${token} ${mode}`,
                        fields: Redacted.make({ TEST_TOKEN: token, MODE: mode }),
                      },
                    }),
                  );
                const alpha = await account("alpha");
                const beta = await account("beta");
                const second = await Effect.runPromise(
                  sdk.apps.copy({
                    payload: { from: app.id, owner: OwnerId.make("local"), name: "Second process" },
                  }),
                );
                const appProfile = await Effect.runPromise(
                  sdk.appProfiles.create({
                    params: { app: app.id },
                    payload: {
                      owner: app.owner,
                      subject: "local",
                      idempotencyKey: "test",
                      accounts: {},
                    },
                  }),
                );
                const secondProfile = await Effect.runPromise(
                  sdk.appProfiles.create({
                    params: { app: second.id },
                    payload: {
                      owner: second.owner,
                      subject: "local",
                      idempotencyKey: "test",
                      accounts: {},
                    },
                  }),
                );
                for (const [item, selected] of [
                  [app, alpha],
                  [second, beta],
                ] as const) {
                  await Effect.runPromise(
                    sdk.appProfiles.update({
                      params: {
                        app: item.id,
                        profile: item.id === app.id ? appProfile.id : secondProfile.id,
                      },
                      payload: { accounts: { service: selected.id }, expectedRevision: 1 },
                    }),
                  );
                  const page = await Effect.runPromise(
                    dashboard.tools({
                      params: { app: item.id },
                      query: { profile: item.id === app.id ? appProfile.id : secondProfile.id },
                    }),
                  );
                  assert.deepEqual(
                    page.items.map((tool) => tool.name),
                    ["mutations.failure", `queries.${selected.label.split(" ")[0]}`],
                  );
                  assert.equal(page.items[1]?.annotations?.readOnlyHint, true);
                  assert.equal(page.items[1]?._meta?.fixture, true);
                  assert.equal(page.items[1]?.outputSchema?.type, "object");
                  await stopped(journal);
                }
                const input = { value: "hello" };
                const called = await Effect.runPromise(
                  sdk.tools.call({
                    payload: {
                      app: app.id,
                      profile: appProfile.id,
                      tool: ToolName.make("queries.alpha"),
                      input,
                    },
                  }),
                );
                assert.deepEqual(called, {
                  status: "completed",
                  value: {
                    content: [{ type: "text", text: "Connected" }],
                    structuredContent: {
                      account: "alpha",
                      cwd,
                      argument,
                      hostSecretPresent: false,
                    },
                    _meta: { fixture: true },
                  },
                });
                const failure = await Effect.runPromise(
                  sdk.tools.call({
                    payload: {
                      app: app.id,
                      profile: appProfile.id,
                      tool: ToolName.make("mutations.failure"),
                      input: {},
                    },
                  }),
                );
                assert.deepEqual(failure, {
                  status: "completed",
                  value: { content: [{ type: "text", text: "Expected failure" }], isError: true },
                });
                const callsBefore = (await events(journal)).filter(
                  (entry) => entry.event === "tools/call",
                ).length;
                await assert.rejects(() =>
                  Effect.runPromise(
                    sdk.tools.call({
                      payload: {
                        app: app.id,
                        profile: appProfile.id,
                        tool: ToolName.make("queries.alpha"),
                        input: {},
                      },
                    }),
                  ),
                );
                assert.equal(
                  (await events(journal)).filter((entry) => entry.event === "tools/call").length,
                  callsBefore,
                );
                await stopped(journal);

                const client = new Client({ name: "stdio-integration-test", version: "1" });
                const transport = new StreamableHTTPClientTransport(
                  new URL("/mcp", server.baseUrl),
                  { requestInit: { headers: { authorization: `Bearer ${apiKey}` } } },
                );
                const compatible: Omit<StreamableHTTPClientTransport, "sessionId"> = transport;
                try {
                  await client.connect(compatible);
                  const response = await client.callTool({
                    name: "execute",
                    arguments: {
                      code: `return await Promise.all([tools[${JSON.stringify(app.slug)}].profiles[${JSON.stringify(appProfile.id)}].queries.alpha({value:"one"}), tools[${JSON.stringify(second.slug)}].profiles[${JSON.stringify(secondProfile.id)}].queries.beta({value:"two"})])`,
                    },
                  });
                  const result = Schema.decodeUnknownSync(ExecuteResult)(
                    response.structuredContent,
                  );
                  assert.equal(result.execution.ok, true);
                  if (result.execution.ok)
                    assert.deepEqual(
                      Schema.decodeUnknownSync(
                        Schema.Array(
                          Schema.Struct({
                            structuredContent: Schema.Struct({ account: Schema.String }),
                          }),
                        ),
                      )(result.execution.value).map((value) => value.structuredContent.account),
                      ["alpha", "beta"],
                    );
                } finally {
                  await client.close();
                }
                await stopped(journal);

                // Failure and timeout leave no child running. A stale process cannot retain another account's environment.
                for (const mode of [
                  "cursor-loop",
                  "exit",
                  "hang-initialize",
                  "hang-list",
                  "stubborn",
                ]) {
                  const selected = await account("alpha", mode);
                  await Effect.runPromise(
                    sdk.appProfiles.update({
                      params: { app: app.id, profile: appProfile.id },
                      payload: {
                        accounts: { service: selected.id },
                        expectedRevision: (
                          await Effect.runPromise(
                            sdk.appProfiles.get({
                              params: { app: app.id, profile: appProfile.id },
                              query: {},
                            }),
                          )
                        ).revision,
                      },
                    }),
                  );
                  await assert.rejects(() =>
                    Effect.runPromise(
                      dashboard.tools({
                        params: { app: app.id },
                        query: { profile: appProfile.id },
                      }),
                    ),
                  );
                  await stopped(journal);
                }
                for (const mode of ["hang-initialize", "hang-call"]) {
                  const selected = await account("alpha", mode);
                  await Effect.runPromise(
                    sdk.appProfiles.update({
                      params: { app: app.id, profile: appProfile.id },
                      payload: {
                        accounts: { service: selected.id },
                        expectedRevision: (
                          await Effect.runPromise(
                            sdk.appProfiles.get({
                              params: { app: app.id, profile: appProfile.id },
                              query: {},
                            }),
                          )
                        ).revision,
                      },
                    }),
                  );
                  const before = (await events(journal)).length;
                  const controller = new AbortController();
                  const pending = Effect.runPromise(
                    sdk.tools.call({
                      payload: {
                        app: app.id,
                        profile: appProfile.id,
                        tool: ToolName.make("queries.alpha"),
                        input,
                      },
                    }),
                    { signal: controller.signal },
                  );
                  const rejected = assert.rejects(pending);
                  await entered(
                    journal,
                    before,
                    mode === "hang-call" ? "tools/call" : "initialize",
                  );
                  controller.abort();
                  await rejected;
                  await stopped(journal);
                }

                const publicApp = await Effect.runPromise(
                  dashboard.importCustomApp({
                    payload: {
                      source: {
                        kind: "mcp-stdio",
                        name: "Public process",
                        command: process.execPath,
                        args: [fixture, journal],
                        environment: [],
                      },
                    },
                  }),
                );
                assert.deepEqual(publicApp.requirements.accounts, {});
                assert.deepEqual(
                  (
                    await Effect.runPromise(
                      dashboard.tools({ params: { app: publicApp.id }, query: {} }),
                    )
                  ).items.map((tool) => tool.name),
                  ["mutations.failure", "queries.public"],
                );
                await stopped(journal);

                const missing = await Effect.runPromise(
                  dashboard.importCustomApp({
                    payload: {
                      source: {
                        kind: "mcp-stdio",
                        name: "Missing executable",
                        command: `${directory}/does-not-exist`,
                        args: [],
                        environment: [],
                      },
                    },
                  }),
                );
                const error = await Effect.runPromise(
                  Effect.flip(dashboard.tools({ params: { app: missing.id }, query: {} })),
                );
                assert.equal(error._tag, "AppEvaluationFailed");
                await stopped(journal);
              } finally {
                if (previous === undefined) delete process.env.EXECUTOR_STDIO_TEST_SECRET;
                else process.env.EXECUTOR_STDIO_TEST_SECRET = previous;
                await server.close();
                await stopped(journal);
              }
            },
            catch: (error) => error,
          });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
);
