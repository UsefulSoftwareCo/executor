import { memorySourceStorage } from "@executor-js/sdk/testing";
/** Real SDK, PGlite, retained app bundle, provider socket and OTLP receiver. */
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { build } from "esbuild";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiClient } from "effect/unstable/httpapi";
import { pgliteLayer } from "fumadb-effect/pglite";
import { telemetryLayer } from "@executor-js/telemetry";
import {
  createExecutor,
  makeExecutorStorage,
  aesGcmCredentials,
  ExecutorApi,
  executorHandlers,
  OwnerId,
  ToolName,
} from "../src/core.ts";
import { nodeRuntime } from "../src/node.ts";

const Export = Schema.fromJsonString(
  Schema.Struct({
    resourceSpans: Schema.Array(
      Schema.Struct({
        scopeSpans: Schema.Array(
          Schema.Struct({
            spans: Schema.Array(
              Schema.Struct({
                traceId: Schema.String,
                spanId: Schema.String,
                parentSpanId: Schema.optional(Schema.String),
                name: Schema.String,
              }),
            ),
          }),
        ),
      }),
    ),
  }),
);

test(
  "browser-compatible client joins HTTP, SDK, retained app and provider in one trace",
  { timeout: process.env.TELEMETRY_BROWSER_PROOF === "1" ? 300_000 : 30_000 },
  async () => {
    const batches: string[] = [];
    const providerParents: string[] = [];
    const receiver = createServer(async (request, response) => {
      response.setHeader("access-control-allow-origin", "*");
      response.setHeader("access-control-allow-headers", "content-type");
      if (request.method === "OPTIONS") {
        response.writeHead(204).end();
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      if (request.url === "/v1/traces") {
        batches.push(body);
        const destination = process.env.TELEMETRY_TEST_ENDPOINT;
        if (destination !== undefined) {
          const exported = await fetch(destination, {
            method: "POST",
            body,
            headers: {
              "content-type": "application/json",
              ...(process.env.TELEMETRY_TEST_TOKEN === undefined
                ? {}
                : { authorization: `Bearer ${process.env.TELEMETRY_TEST_TOKEN}` }),
              ...(process.env.TELEMETRY_TEST_DATASET === undefined
                ? {}
                : { "x-axiom-dataset": process.env.TELEMETRY_TEST_DATASET }),
            },
          });
          assert.ok(exported.ok, `Proof export returned ${exported.status}`);
        }
      } else if (request.url === "/provider")
        providerParents.push(String(request.headers.traceparent));
      response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    try {
      const address = receiver.address();
      assert.ok(address !== null && typeof address !== "string");
      const origin = `http://127.0.0.1:${address.port}`;
      const telemetry = telemetryLayer(
        {
          service: "executor-test",
          version: "test-build",
          environment: "test",
          traces: { url: `${origin}/v1/traces` },
        },
        "event",
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const directory = yield* fs.makeTempDirectoryScoped();
            const storage = yield* makeExecutorStorage({ provider: "postgresql" });
            yield* storage.migrate;
            const credentials = yield* aesGcmCredentials(Redacted.make("ab".repeat(32)), crypto);
            const executor = yield* createExecutor({
              blobs: memoryBlobStore(),
              sources: memorySourceStorage(),
              storage,
              credentials,
              runtime: nodeRuntime({ workDirectory: directory }),
            });
            const { app, deployment } = yield* executor.apps.deploy({
              owner: OwnerId.make("synthetic"),
              name: "Telemetry fixture",
              files: [
                {
                  path: "index.ts",
                  content: `import { query, mutation, defineApp, object } from "apps";
export default defineApp({ accounts: {} }, async (appContext) => ({  mutations: { ping: mutation({ description: "Synthetic provider",
            input: object({}) }, async (operationContext, _input) => {
            const ctx = { ...appContext, ...operationContext };
            return (await ctx.fetch(${JSON.stringify(origin + "/provider")})).json();
        }) } }));
`,
                },
              ],
            });
            // Exercise retained blob restoration, rather than only a warm local build.
            yield* fs.remove(`${directory}/${deployment.build}`, { recursive: true });
            const browser = process.env.TELEMETRY_BROWSER_PROOF === "1";
            const script = browser
              ? (yield* Effect.promise(() =>
                  build({
                    stdin: {
                      resolveDir: new URL("../", import.meta.url).pathname,
                      contents: `
        import { Effect } from "effect";
        import { FetchHttpClient } from "effect/unstable/http";
        import { HttpApiClient } from "effect/unstable/httpapi";
        import { ExecutorApi } from "@executor-js/sdk/core";
        import { telemetryLayer } from "@executor-js/telemetry";
        document.querySelector('button').onclick = async () => {
          try {
            await Effect.runPromise(Effect.gen(function* () {
              const api = yield* HttpApiClient.make(ExecutorApi, { baseUrl: location.origin });
              yield* api.tools.call({ payload: { app: ${JSON.stringify(app.id)}, tool: "mutations.ping", input: {} } });
            }).pipe(Effect.withSpan("ui.tool.call"), Effect.provide(FetchHttpClient.layer), Effect.provide(telemetryLayer({
              service: "executor-browser-proof", version: "test-build", environment: "test", traces: { url: ${JSON.stringify(origin + "/v1/traces")} }
            }, "event"))));
            document.querySelector('p').textContent = 'Trace exported';
          } catch (error) { document.querySelector('p').textContent = String(error); }
        };`,
                    },
                    bundle: true,
                    write: false,
                    platform: "browser",
                    format: "esm",
                  }),
                )).outputFiles[0]?.text
              : "";
            const routes = Layer.merge(
              HttpApiBuilder.layer(ExecutorApi).pipe(Layer.provide(executorHandlers(executor))),
              HttpRouter.add(
                "GET",
                "/",
                Effect.succeed(
                  HttpServerResponse.html(
                    `<!doctype html><title>Executor telemetry proof</title><button>Run traced tool</button><p>Ready</p><script type="module">${script}</script>`,
                  ),
                ),
              ),
            );
            const server = ManagedRuntime.make(
              HttpRouter.serve(routes, { disableLogger: true }).pipe(
                Layer.provideMerge(
                  NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }),
                ),
                Layer.provide(NodeServices.layer),
                Layer.provide(telemetry),
              ),
            );
            yield* Effect.addFinalizer(() => Effect.promise(() => server.dispose()));
            const listener = yield* Effect.promise(() => server.runPromise(HttpServer.HttpServer));
            assert.equal(listener.address._tag, "InetAddressV4");
            if (listener.address._tag !== "InetAddressV4")
              return yield* Effect.die("Expected TCP listener");
            const baseUrl = `http://127.0.0.1:${listener.address.port}`;
            if (browser) {
              console.log(`BROWSER_PROOF_URL=${baseUrl}`);
              yield* Effect.promise(async () => {
                const deadline = Date.now() + 240_000;
                while (!batches.some((batch) => batch.includes('"name":"ui.tool.call"'))) {
                  if (Date.now() > deadline) throw new Error("Browser proof timed out");
                  await new Promise((resolve) => setTimeout(resolve, 250));
                }
              });
              return;
            }
            yield* Effect.gen(function* () {
              const client = yield* HttpApiClient.make(ExecutorApi, { baseUrl });
              const response = yield* client.tools.call({
                payload: { app: app.id, tool: ToolName.make("mutations.ping"), input: {} },
              });
              assert.deepEqual(response, { status: "completed", value: { ok: true } });
            }).pipe(
              Effect.withSpan("ui.tool.call"),
              Effect.provide(FetchHttpClient.layer),
              Effect.provide(telemetry),
            );
          }),
        ).pipe(
          Effect.provide(Layer.mergeAll(NodeServices.layer, BrowserCrypto.layer, pgliteLayer())),
        ),
      );
      const spans = batches.flatMap((body) =>
        Schema.decodeUnknownSync(Export)(body).resourceSpans.flatMap((r) =>
          r.scopeSpans.flatMap((s) => s.spans),
        ),
      );
      const action = spans.find((span) => span.name === "ui.tool.call");
      assert.ok(action);
      if (process.env.TELEMETRY_TEST_ENDPOINT !== undefined)
        console.log(`EXPORTED_TRACE_ID=${action.traceId}`);
      const dispatch = spans.find(
        (span) => span.name === "app.dispatch" && span.traceId === action.traceId,
      );
      assert.ok(dispatch, "retained app must export into the caller's trace");
      assert.ok(spans.some((span) => span.spanId === dispatch.parentSpanId));
      for (const name of [
        "storage.blob.get",
        "runtime.node.manifest",
        "runtime.node.materialize",
        "runtime.node.extract",
        "runtime.node.import",
        "app.accounts.bind",
        "app.operation.execute",
        "provider.http.response.read",
      ]) {
        assert.ok(
          spans.some((span) => span.name === name && span.traceId === action.traceId),
          `Missing correlated ${name}`,
        );
      }
      assert.equal(providerParents.length, 1);
      assert.ok(providerParents[0]?.includes(action.traceId));
      assert.ok(
        spans.some(
          (span) => providerParents[0]?.includes(span.spanId) && span.traceId === action.traceId,
        ),
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        receiver.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
