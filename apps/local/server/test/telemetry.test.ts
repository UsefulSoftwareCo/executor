/** Real browser sessions and sockets verify telemetry ingestion status codes. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  ManagedRuntime,
  Redacted,
  Schema,
} from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { telemetryLayer } from "@executor-js/telemetry";
import { defaultMcpLimits } from "@executor-js/mcp";
import { ServerConfig } from "../src/contracts/config.ts";
import { makeLocalAuth, sessionCookie } from "../src/implementation/auth.ts";
import { browserTelemetry } from "../src/implementation/telemetry.ts";
import { startLocalServer } from "../src/node.ts";

test(
  "browser ingestion reports forwarding failures and rejects foreign origins",
  { timeout: 15_000 },
  async () => {
    let status: number | "timeout" = 503;
    const collector = createServer((_request, response) => {
      if (status !== "timeout") response.writeHead(status).end();
    });
    await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
    try {
      const target = collector.address();
      assert.ok(target !== null && typeof target !== "string");
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const auth = yield* makeLocalAuth(crypto, yield* fs.makeTempDirectoryScoped());
            const grant = yield* auth.issue();
            const cookie = yield* auth.exchange(grant.token);
            const server = ManagedRuntime.make(
              HttpRouter.serve(
                Layer.unwrap(
                  Effect.gen(function* () {
                    const http = yield* HttpServer.HttpServer;
                    assert.equal(http.address._tag, "InetAddressV4");
                    if (http.address._tag !== "InetAddressV4")
                      return yield* Effect.die("Expected a TCP listener");
                    const config = Schema.decodeUnknownSync(ServerConfig)({
                      directory: "unused",
                      port: http.address.port,
                      apiKey: "synthetic-api-key-000000000000000000",
                      encryptionKey: "ab".repeat(32),
                      mcp: defaultMcpLimits,
                    });
                    return Layer.mergeAll(
                      HttpRouter.add(
                        "POST",
                        "/dashboard/api/telemetry/traces",
                        browserTelemetry(config, "traces"),
                      ),
                      HttpRouter.add(
                        "POST",
                        "/dashboard/api/telemetry/logs",
                        browserTelemetry(config, "logs"),
                      ),
                    );
                  }),
                ),
                {
                  disableLogger: true,
                  disableListenLog: true,
                  middleware: (request) => request.pipe(Effect.withTracerEnabled(false)),
                },
              ).pipe(
                Layer.provideMerge(
                  NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }),
                ),
                Layer.provide(NodeServices.layer),
                Layer.provide(
                  telemetryLayer(
                    {
                      service: "browser-relay-test",
                      version: "test",
                      environment: "test",
                      traces: { url: `http://127.0.0.1:${target.port}/v1/traces` },
                    },
                    "event",
                  ),
                ),
              ),
            );
            yield* Effect.addFinalizer(() => Effect.promise(() => server.dispose()));
            const http = yield* Effect.promise(() => server.runPromise(HttpServer.HttpServer));
            assert.equal(http.address._tag, "InetAddressV4");
            if (http.address._tag !== "InetAddressV4")
              return yield* Effect.die("Expected a TCP listener");
            const port = http.address.port;
            const origin = `http://127.0.0.1:${port}`;
            const post = (body: string, authenticated = true, from = origin) =>
              fetch(`${origin}/dashboard/api/telemetry/traces`, {
                method: "POST",
                headers: {
                  origin: from,
                  "content-type": "application/json",
                  ...(authenticated
                    ? { cookie: `${sessionCookie({ port })}=${Redacted.value(cookie)}` }
                    : {}),
                },
                body,
              });
            assert.equal((yield* Effect.promise(() => post('{"resourceSpans":[]}'))).status, 502);
            assert.equal((yield* Effect.promise(() => post("not json"))).status, 400);
            assert.equal(
              (yield* Effect.promise(() => post('{"resourceSpans":[]}', false))).status,
              502,
            );
            assert.equal(
              (yield* Effect.promise(() =>
                post('{"resourceSpans":[]}', true, "https://foreign.test"),
              )).status,
              403,
            );
            status = "timeout";
            assert.equal((yield* Effect.promise(() => post('{"resourceSpans":[]}'))).status, 504);
            status = 200;
            assert.equal((yield* Effect.promise(() => post('{"resourceSpans":[]}'))).status, 202);
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
    } finally {
      collector.closeAllConnections();
      await new Promise<void>((resolve) => collector.close(() => resolve()));
    }
  },
);

test(
  "local server starts and serves requests when Motel cannot be launched",
  { timeout: 20_000 },
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped();
          yield* Effect.scoped(
            Effect.gen(function* () {
              const settings = Schema.decodeUnknownSync(ServerConfig)({
                directory,
                port: 0,
                apiKey: "synthetic-api-key-000000000000000000",
                encryptionKey: "ab".repeat(32),
                mcp: defaultMcpLimits,
              });
              const server = yield* startLocalServer(settings).pipe(
                Effect.provideService(
                  ConfigProvider.ConfigProvider,
                  ConfigProvider.fromUnknown({
                    EXECUTOR_MOTEL_BUNDLE: `${directory}/missing-bundle`,
                  }),
                ),
              );
              const response = yield* Effect.promise(() =>
                fetch(`${server.url}/auth/session`, { headers: { origin: server.url } }),
              );
              assert.equal(response.status, 200);
              assert.deepEqual(yield* Effect.promise(() => response.json()), {
                authenticated: false,
              });
            }),
          );
          const logs = yield* fs.readFileString(`${directory}/diagnostics/executor-local.jsonl`);
          assert.match(logs, /Local server ready/);
          assert.match(logs, /Local telemetry collector failed/);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
);
