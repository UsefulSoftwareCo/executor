import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import {
  createExecutor,
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";
import { makeOpenApiHttpApiTestIntegrationConfig } from "../testing";

import { openApiPlugin } from "./plugin";

const BODY_READ_DEADLINE_MS = 15_000;
const RESPONSE_BODY_TIMEOUT_MS = 100;
const TOOL = "data.getData";

const DataGroup = HttpApiGroup.make("data").add(
  HttpApiEndpoint.get("getData", "/data", {
    success: Schema.Unknown,
  }),
);

const TimeoutApi = HttpApi.make("responseBodyTimeoutTest")
  .add(DataGroup)
  .annotateMerge(OpenApi.annotations({ title: "ResponseBodyTimeoutTest", version: "1.0.0" }));

const testPlugins = () =>
  [
    openApiPlugin({
      httpClientLayer: FetchHttpClient.layer,
      invokeOptions: { responseBodyTimeoutMs: RESPONSE_BODY_TIMEOUT_MS },
    }),
    memoryCredentialsPlugin(),
  ] as const;

const buildExecutor = (baseUrl: string) =>
  Effect.gen(function* () {
    const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));
    yield* executor.openapi.addSpec(
      makeOpenApiHttpApiTestIntegrationConfig(TimeoutApi, {
        slug: "body_timeout",
        baseUrl,
      }),
    );
    yield* executor.connections.create({
      owner: "org",
      name: ConnectionName.make("main"),
      integration: IntegrationSlug.make("body_timeout"),
      template: AuthTemplateSlug.make("apiKey"),
      value: "token",
    });
    return {
      executor,
      address: ToolAddress.make(`tools.body_timeout.org.main.${TOOL}`),
    };
  });

const startStalledBodyServer = () =>
  Effect.acquireRelease(
    Effect.callback<{ baseUrl: string; close: () => void }>((resume) => {
      const sockets = new Set<Socket>();
      const server = createServer((req, res) => {
        if (req.url?.split("?")[0] !== "/data") {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"data":');
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
              for (const socket of sockets) socket.destroy();
              server.close();
            },
          }),
        );
      });
    }),
    (server) => Effect.sync(() => server.close()),
  );

const observeUntil = <A, E>(fiber: Fiber.Fiber<A, E>, deadlineMs: number) =>
  Effect.callback<Option.Option<Exit.Exit<A, E>>>((resume) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resume(Effect.succeed(Option.none()));
    }, deadlineMs);
    const removeObserver = fiber.addObserver((exit) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resume(Effect.succeed(Option.some(exit)));
    });
    return Effect.sync(() => {
      clearTimeout(timer);
      removeObserver();
    });
  });

describe("OpenAPI response body timeout", () => {
  it.effect(
    "aborts a stalled non-streaming JSON body and returns an actionable tool failure",
    () =>
      Effect.gen(function* () {
        const server = yield* startStalledBodyServer();
        const { executor, address } = yield* buildExecutor(server.baseUrl);
        const startedAt = Date.now();

        const invocation = yield* executor.execute(address, {}).pipe(Effect.forkDetach);
        const result = yield* observeUntil(invocation, BODY_READ_DEADLINE_MS);
        const elapsedMs = Date.now() - startedAt;

        expect(
          Option.isSome(result),
          `body read did not time out: hung until test deadline (${elapsedMs}ms)`,
        ).toBe(true);
        if (Option.isNone(result)) return;

        expect(Exit.isSuccess(result.value)).toBe(true);
        if (Exit.isFailure(result.value)) return;

        expect(result.value.value).toMatchObject({
          ok: false,
          error: {
            code: "upstream_response_body_timeout",
            message: expect.stringContaining("response body"),
          },
        });
      }),
    { timeout: 20_000 },
  );
});
