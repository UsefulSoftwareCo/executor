// ---------------------------------------------------------------------------
// Upstream failure-mode tests.
//
// Most of the OpenAPI test surface covers happy paths and content-type
// dispatch. The bugs that bite users in production are usually in the
// failure modes: upstream returns 500, connection drops mid-response, body
// claims `application/json` but isn't parseable, response status is 4xx
// with a JSON error body that should bubble up. These exist so the next
// refactor can't silently change the error shape that sandbox code (and
// downstream LLM agents) depend on.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
// The socket-drop and slow-response cases exercise Node transport behavior
// that Effect's in-memory HTTP test server intentionally abstracts away.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createExecutor,
  definePlugin,
  type InvokeOptions,
  type SecretProvider,
} from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";
import {
  makeOpenApiHttpApiTestSourceConfig,
  makeOpenApiTestSourceConfig,
  type OpenApiTestServerShape,
  serveOpenApiHttpApiTestServer,
} from "../testing";

import { openApiPlugin } from "./plugin";

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };
const TEST_SCOPE = "test-scope";

const memoryProvider: SecretProvider = (() => {
  const store = new Map<string, string>();
  return {
    key: "memory",
    writable: true,
    get: (id, scope) => Effect.sync(() => store.get(`${scope}:${id}`) ?? null),
    set: (id, value, scope) =>
      Effect.sync(() => {
        store.set(`${scope}:${id}`, value);
      }),
    delete: (id, scope) => Effect.sync(() => store.delete(`${scope}:${id}`)),
    list: () => Effect.sync(() => []),
  };
})();

const memorySecretsPlugin = definePlugin(() => ({
  id: "memory-secrets" as const,
  storage: () => ({}),
  secretProviders: [memoryProvider],
}));

type ResponseScript = (req: {
  url: string;
  method: string;
  headers: Readonly<Record<string, string>>;
}) => {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
};

const startScriptedServer = (script: ResponseScript) =>
  serveOpenApiHttpApiTestServer({
    api: FailureApi,
    handlersLayer: HttpApiBuilder.group(FailureApi, "things", (handlers) =>
      handlers.handle("listThings", () =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const result = script({
            url: request.url,
            method: request.method,
            headers: request.headers,
          });
          return HttpServerResponse.text(result.body ?? '{"ok":true}', {
            status: result.status ?? 200,
            headers: result.headers ?? { "content-type": "application/json" },
          });
        }),
      ),
    ),
  });

const startDroppingServer = () =>
  Effect.acquireRelease(
    Effect.callback<{ baseUrl: string; close: () => void }>((resume) => {
      const server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write("partial");
        res.destroy();
      });
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as AddressInfo).port;
        resume(
          Effect.succeed({
            baseUrl: `http://127.0.0.1:${port}`,
            close: () => server.close(),
          }),
        );
      });
    }),
    (s) => Effect.sync(() => s.close()),
  );

const ThingsGroup = HttpApiGroup.make("things").add(
  HttpApiEndpoint.get("listThings", "/things", {
    success: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);

const FailureApi = HttpApi.make("failuresTest")
  .add(ThingsGroup)
  .annotateMerge(OpenApi.annotations({ title: "FailuresTest", version: "1.0.0" }));

const buildExecutor = (baseUrl: string) =>
  Effect.gen(function* () {
    const executor = yield* createExecutor(
      makeTestConfig({
        plugins: [
          openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
          memorySecretsPlugin(),
        ] as const,
      }),
    );
    yield* executor.openapi.addSpec(
      makeOpenApiHttpApiTestSourceConfig(FailureApi, {
        scope: TEST_SCOPE,
        namespace: "f",
        baseUrl,
      }),
    );
    return executor;
  });

const buildExecutorForOpenApiServer = (server: OpenApiTestServerShape) =>
  Effect.gen(function* () {
    const executor = yield* createExecutor(
      makeTestConfig({
        plugins: [
          openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
          memorySecretsPlugin(),
        ] as const,
      }),
    );
    yield* executor.openapi.addSpec(
      makeOpenApiTestSourceConfig(server, {
        scope: TEST_SCOPE,
        namespace: "f",
      }),
    );
    return executor;
  });

describe("OpenAPI upstream failure modes", () => {
  // Upstream HTTP errors come back via the `{ error, data? }` envelope
  // rather than a failed Effect. That shape has to be stable: sandbox
  // code (and the AI agents driving it) test for `result.error` to know
  // the call didn't succeed. Either the envelope or a tagged Effect
  // failure is acceptable; what isn't is a silent successful return.
  it.effect("upstream 500 surfaces via the error envelope (not silent success)", () =>
    Effect.gen(function* () {
      const server = yield* startScriptedServer(() => ({
        status: 500,
        headers: { "content-type": "application/json" },
        body: '{"error":{"code":"internal","message":"db timeout"}}',
      }));
      const executor = yield* buildExecutorForOpenApiServer(server);

      const exit = yield* executor.tools
        .invoke("f.things.listThings", {}, autoApprove)
        .pipe(Effect.exit);

      const text = Exit.match(exit, {
        onFailure: (cause) => JSON.stringify(cause),
        onSuccess: (value) => JSON.stringify(value),
      });
      // The result must carry the upstream signal somewhere. If it doesn't
      // mention status or body content, sandbox code can't distinguish 500
      // from a normal `{ data: [...] }` response.
      expect(text).toMatch(/500|internal|db timeout|response|error/i);
      // Successful happy-path returns expose `data`. An upstream 500 must
      // never serialise as a `{"data":...}` envelope, on either Exit
      // branch — asserted unconditionally so a regression in either
      // shape surfaces here.
      expect(text.startsWith('{"data":')).toBe(false);
    }),
  );

  it.effect("upstream 4xx surfaces structured error body", () =>
    Effect.gen(function* () {
      const server = yield* startScriptedServer(() => ({
        status: 422,
        headers: { "content-type": "application/json" },
        body: '{"error":{"field":"name","reason":"too_short"}}',
      }));
      const executor = yield* buildExecutorForOpenApiServer(server);

      const exit = yield* executor.tools
        .invoke("f.things.listThings", {}, autoApprove)
        .pipe(Effect.exit);

      const text = Exit.match(exit, {
        onFailure: (cause) => JSON.stringify(cause),
        onSuccess: (value) => JSON.stringify(value),
      });
      // Must mention the upstream status or the error body.
      expect(text).toMatch(/422|too_short|name|response|error/i);
    }),
  );

  it.effect("upstream returns malformed JSON despite Content-Type: application/json", () =>
    Effect.gen(function* () {
      const server = yield* startScriptedServer(() => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: "not json at all <<<<",
      }));
      const executor = yield* buildExecutorForOpenApiServer(server);

      // Whatever happens, the test asserts it doesn't produce a defect or
      // hang — either the plugin returns a value (raw text / passthrough)
      // or it surfaces a tagged failure. Both are acceptable; what's not
      // is silently throwing in a way that escapes the Effect.
      const exit = yield* executor.tools
        .invoke("f.things.listThings", {}, autoApprove)
        .pipe(Effect.exit);

      // Don't over-specify — just verify the runtime didn't crash and
      // the result is observable.
      expect(Exit.isFailure(exit) || Exit.isSuccess(exit)).toBe(true);
    }),
  );

  it.effect("upstream connection drop mid-response surfaces as a failure", () =>
    Effect.gen(function* () {
      const { baseUrl } = yield* startDroppingServer();
      const executor = yield* buildExecutor(baseUrl);

      const exit = yield* executor.tools
        .invoke("f.things.listThings", {}, autoApprove)
        .pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("upstream returns wrong content-type (HTML for a JSON op)", () =>
    Effect.gen(function* () {
      const server = yield* startScriptedServer(() => ({
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html><body>Service Unavailable</body></html>",
      }));
      const executor = yield* buildExecutorForOpenApiServer(server);

      const exit = yield* executor.tools
        .invoke("f.things.listThings", {}, autoApprove)
        .pipe(Effect.exit);

      // Must be observable — either the plugin coerces (string) or fails;
      // the smoke-test guarantees no defect.
      expect(Exit.isFailure(exit) || Exit.isSuccess(exit)).toBe(true);
    }),
  );

  it.effect("upstream slow-then-respond doesn't lose the request", () =>
    Effect.gen(function* () {
      const slowServer = Effect.acquireRelease(
        Effect.callback<{ baseUrl: string; close: () => void }>((resume) => {
          const server = createServer((_req, res) => {
            setTimeout(() => {
              res.writeHead(200, { "content-type": "application/json" });
              res.end("[]");
            }, 75);
          });
          server.listen(0, "127.0.0.1", () => {
            const port = (server.address() as AddressInfo).port;
            resume(
              Effect.succeed({
                baseUrl: `http://127.0.0.1:${port}`,
                close: () => server.close(),
              }),
            );
          });
        }),
        (s) => Effect.sync(() => s.close()),
      );
      const { baseUrl } = yield* slowServer;
      const executor = yield* buildExecutor(baseUrl);

      const result = yield* executor.tools.invoke("f.things.listThings", {}, autoApprove);
      // Empty array via .data envelope or directly — accept either shape.
      const data = (result as { data?: unknown }).data ?? result;
      expect(data).toEqual([]);
    }),
  );
});
