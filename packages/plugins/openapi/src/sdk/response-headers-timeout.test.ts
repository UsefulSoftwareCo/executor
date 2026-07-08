import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import {
  createExecutor,
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";
import { makeOpenApiHttpApiTestIntegrationConfig, unwrapInvocation } from "../testing";

import { invokeWithLayer } from "./invoke";
import { openApiPlugin } from "./plugin";
import type { OperationBinding } from "./types";

const RESPONSE_HEADERS_TIMEOUT_MS = 100;
const STREAM_TOOL = "logs.getLogs";
const encoder = new TextEncoder();

const LogsGroup = HttpApiGroup.make("logs").add(
  HttpApiEndpoint.get("getLogs", "/logs", {
    success: Schema.Unknown,
  }),
);

const TimeoutApi = HttpApi.make("responseHeadersTimeoutTest")
  .add(LogsGroup)
  .annotateMerge(OpenApi.annotations({ title: "ResponseHeadersTimeoutTest", version: "1.0.0" }));

const testPlugins = () =>
  [
    openApiPlugin({
      httpClientLayer: FetchHttpClient.layer,
      invokeOptions: { responseHeadersTimeoutMs: RESPONSE_HEADERS_TIMEOUT_MS },
    }),
    memoryCredentialsPlugin(),
  ] as const;

const buildExecutor = (baseUrl: string) =>
  Effect.gen(function* () {
    const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));
    yield* executor.openapi.addSpec(
      makeOpenApiHttpApiTestIntegrationConfig(TimeoutApi, { slug: "headers_timeout", baseUrl }),
    );
    yield* executor.connections.create({
      owner: "org",
      name: ConnectionName.make("main"),
      integration: IntegrationSlug.make("headers_timeout"),
      template: AuthTemplateSlug.make("apiKey"),
      value: "token",
    });
    return {
      executor,
      address: ToolAddress.make(`tools.headers_timeout.org.main.${STREAM_TOOL}`),
    };
  });

const startRawServer = (handler: (res: ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.callback<{ baseUrl: string; close: () => void }>((resume) => {
      const sockets = new Set<Socket>();
      const timers = new Set<ReturnType<typeof setTimeout>>();
      const server = createServer((req, res) => {
        if (req.url?.split("?")[0] !== "/logs") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        handler(res);
      });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as AddressInfo).port;
        resume(
          Effect.succeed({
            baseUrl: `http://127.0.0.1:${port}`,
            close: () => {
              for (const timer of timers) clearTimeout(timer);
              for (const socket of sockets) socket.destroy();
              server.close();
            },
          }),
        );
      });
    }),
    (server) => Effect.sync(() => server.close()),
  );

const startHeaderlessServer = (closed: Deferred.Deferred<void>) =>
  Effect.acquireRelease(
    Effect.callback<{ baseUrl: string; close: () => void }>((resume) => {
      const sockets = new Set<Socket>();
      const server = createServer((req, res) => {
        if (req.url?.split("?")[0] === "/logs") return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => {
          sockets.delete(socket);
          Effect.runFork(Deferred.succeed(closed, undefined));
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as AddressInfo).port;
        resume(
          Effect.succeed({
            baseUrl: `http://127.0.0.1:${port}`,
            close: () => {
              for (const socket of sockets) socket.destroy();
              server.close();
            },
          }),
        );
      });
    }),
    (server) => Effect.sync(() => server.close()),
  );

const operation: OperationBinding = {
  method: "get",
  pathTemplate: "/logs",
  parameters: [],
  requestBody: Option.none(),
  responseBody: Option.none(),
  servers: [],
};

describe("OpenAPI response headers timeout", () => {
  it.effect("aborts a headerless upstream and returns an actionable tool failure", () =>
    Effect.gen(function* () {
      const closed = yield* Deferred.make<void>();
      const server = yield* startHeaderlessServer(closed);
      const { executor, address } = yield* buildExecutor(server.baseUrl);
      const startedAt = Date.now();

      const result = yield* executor.execute(address, {});
      const elapsedMs = Date.now() - startedAt;
      const socketClosed = yield* Deferred.await(closed).pipe(Effect.timeoutOption(1_000));

      expect(elapsedMs).toBeGreaterThanOrEqual(RESPONSE_HEADERS_TIMEOUT_MS - 25);
      expect(elapsedMs).toBeLessThan(2_000);
      expect(Option.isSome(socketClosed)).toBe(true);
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "upstream_response_headers_timeout",
          message: expect.stringContaining("Upstream returned no response headers within 100ms"),
        },
      });
    }),
  );

  it.effect("leaves normal fast JSON responses unaffected", () =>
    Effect.gen(function* () {
      const server = yield* startRawServer((res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      const { executor, address } = yield* buildExecutor(server.baseUrl);

      const result = unwrapInvocation<Record<string, unknown>>(
        yield* executor.execute(address, {}),
      );

      expect(result.status).toBe(200);
      expect(result.data).toEqual({ ok: true });
    }),
  );

  it.effect("does not apply the headers timeout after streaming response headers arrive", () =>
    Effect.gen(function* () {
      const server = yield* startRawServer((res) => {
        res.writeHead(200, { "content-type": "application/jsonl" });
        res.write(encoder.encode(`${JSON.stringify({ id: 1 })}\n`));
        setTimeout(() => {
          res.write(encoder.encode(`${JSON.stringify({ id: 2 })}\n`));
          res.end();
        }, RESPONSE_HEADERS_TIMEOUT_MS + 100);
      });

      const result = yield* invokeWithLayer(
        operation,
        {},
        server.baseUrl,
        {},
        {},
        FetchHttpClient.layer,
        { responseHeadersTimeoutMs: RESPONSE_HEADERS_TIMEOUT_MS },
      );

      expect(result.status).toBe(200);
      expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
      expect(result.headers["x-executor-stream"]).toBe("complete");
    }),
  );
});
