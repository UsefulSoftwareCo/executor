// ---------------------------------------------------------------------------
// Regression test for non-JSON request-body serialization.
//
// Before the fix, the invoke path only had two branches — JSON, or
// `String(bodyValue)` with whatever content-type the spec declared. For an
// object body that meant shipping the literal string `[object Object]`
// with `Content-Type: application/x-www-form-urlencoded`, which servers
// reject or hold open waiting for valid framing.
//
// Now we dispatch on content-type: form-urlencoded → bodyUrlParams,
// multipart → bodyFormDataRecord, string passthrough for pre-serialized
// bodies, JSON.stringify as a last-resort fallback (never `[object Object]`).
// ---------------------------------------------------------------------------

import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient, HttpServerResponse } from "effect/unstable/http";

import {
  createExecutor,
  definePlugin,
  type InvokeOptions,
  type SecretProvider,
} from "@executor-js/sdk";
import { makeTestWorkspaceLayer, serveTestHttpApp, TestWorkspace } from "@executor-js/sdk/testing";

import { openApiPlugin } from "./plugin";

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };
const TEST_SCOPE = "test-scope";

const memoryProvider: SecretProvider = (() => {
  const store = new Map<string, string>();
  return {
    key: "memory",
    writable: true,
    get: (id, scope) => Effect.sync(() => store.get(`${scope}\u0000${id}`) ?? null),
    set: (id, value, scope) =>
      Effect.sync(() => {
        store.set(`${scope}\u0000${id}`, value);
      }),
    delete: (id, scope) => Effect.sync(() => store.delete(`${scope}\u0000${id}`)),
    list: () => Effect.sync(() => []),
  };
})();

const memorySecretsPlugin = definePlugin(() => ({
  id: "memory-secrets" as const,
  storage: () => ({}),
  secretProviders: [memoryProvider],
}));

type Captured = {
  contentType: string;
  body: string;
};

const startEchoServer = () =>
  Effect.gen(function* () {
    const captured: Captured = { contentType: "", body: "" };
    const server = yield* serveTestHttpApp((request) =>
      Effect.gen(function* () {
        captured.contentType = request.headers["content-type"] ?? "";
        captured.body = yield* request.text.pipe(Effect.catch(() => Effect.succeed("")));
        return HttpServerResponse.jsonUnsafe({ ok: true });
      }),
    );
    return { baseUrl: server.baseUrl, captured };
  });

const formSpec = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "FormTest", version: "1.0.0" },
  paths: {
    "/submit": {
      post: {
        operationId: "submit",
        tags: ["forms"],
        requestBody: {
          required: true,
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  email: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { ok: { type: "boolean" } },
                },
              },
            },
          },
        },
      },
    },
  },
});

const plugins = [
  openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
  memorySecretsPlugin(),
] as const;

layer(
  makeTestWorkspaceLayer({
    plugins,
  }),
  { timeout: "15 seconds" },
)("OpenAPI non-JSON request body serialization", (it) => {
  it.effect("form-urlencoded object body is properly encoded (no '[object Object]')", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const { config } = yield* TestWorkspace;
      const executor = yield* createExecutor({ ...config, plugins });

      yield* executor.openapi.addSpec({
        spec: formSpec,
        scope: TEST_SCOPE,
        namespace: "form",
        baseUrl,
      });

      yield* executor.tools.invoke(
        "form.forms.submit",
        { body: { name: "Acme", email: "a@b.com" } },
        autoApprove,
      );

      expect(captured.contentType).toBe("application/x-www-form-urlencoded");
      expect(captured.body).not.toBe("[object Object]");

      const parsed = new URLSearchParams(captured.body);
      expect(parsed.get("name")).toBe("Acme");
      expect(parsed.get("email")).toBe("a@b.com");
    }),
  );
});
