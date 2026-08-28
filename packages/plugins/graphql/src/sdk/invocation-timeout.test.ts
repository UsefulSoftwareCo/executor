import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { introspectionFromSchema } from "graphql";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
  createExecutor,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { makeGreetingGraphqlSchema } from "../testing";
import { graphqlPlugin } from "./plugin";

const INVOCATION_TIMEOUT_MS = 100;

const startHangingResponseServer = (closed: Deferred.Deferred<void>) =>
  Effect.acquireRelease(
    Effect.callback<{ endpoint: string; close: () => void }>((resume) => {
      const sockets = new Set<Socket>();
      const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"data":');
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
            endpoint: `http://127.0.0.1:${port}/graphql`,
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

const introspectionJson = JSON.stringify({
  data: introspectionFromSchema(makeGreetingGraphqlSchema({ includeMutation: false })),
});

describe("GraphQL invocation timeout", () => {
  it.live("aborts a hanging response body and returns an actionable tool failure", () =>
    Effect.gen(function* () {
      const closed = yield* Deferred.make<void>();
      const server = yield* startHangingResponseServer(closed);
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            memoryCredentialsPlugin(),
            graphqlPlugin({
              httpClientLayer: FetchHttpClient.layer,
              invokeOptions: { timeoutMs: INVOCATION_TIMEOUT_MS },
            }),
          ] as const,
        }),
      );

      yield* executor.graphql.addIntegration({
        endpoint: server.endpoint,
        slug: "invocation_timeout",
        introspectionJson,
      });
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: IntegrationSlug.make("invocation_timeout"),
        template: AuthTemplateSlug.make("none"),
        value: "unused",
      });

      const startedAt = Date.now();
      const resultOption = yield* executor
        .execute(ToolAddress.make("tools.invocation_timeout.org.main.query.hello"), {})
        .pipe(Effect.timeoutOption(1_000));
      const elapsedMs = Date.now() - startedAt;
      const socketClosed = yield* Deferred.await(closed).pipe(Effect.timeoutOption(1_000));
      const result = Option.getOrNull(resultOption);

      expect(elapsedMs).toBeGreaterThanOrEqual(INVOCATION_TIMEOUT_MS - 25);
      expect(elapsedMs).toBeLessThan(1_000);
      expect(Option.isSome(socketClosed)).toBe(true);
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "graphql_request_timeout",
          message: expect.stringContaining("GraphQL upstream did not complete within 100ms"),
        },
      });
    }),
  );
});
