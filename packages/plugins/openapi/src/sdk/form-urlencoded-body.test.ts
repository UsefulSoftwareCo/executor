// ---------------------------------------------------------------------------
// Regression test for non-JSON request-body serialization.
//
// Before the fix, the invoke path only had two branches: JSON, or
// `String(bodyValue)` with whatever content-type the spec declared. For an
// object body that meant shipping the literal string `[object Object]` with
// `Content-Type: application/x-www-form-urlencoded`.
// ---------------------------------------------------------------------------

import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/unstable/httpapi";

import {
  createExecutor,
  definePlugin,
  type InvokeOptions,
  type SecretProvider,
} from "@executor-js/sdk";
import { makeTestWorkspaceLayer, TestWorkspace } from "@executor-js/sdk/testing";
import { serveOpenApiHttpApiTestServer } from "@executor-js/plugin-openapi/testing";

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

const FormPayload = Schema.Struct({
  name: Schema.String,
  email: Schema.String,
}).pipe(HttpApiSchema.asFormUrlEncoded());
const Ok = Schema.Struct({ ok: Schema.Boolean });

const FormsGroup = HttpApiGroup.make("forms").add(
  HttpApiEndpoint.post("submit", "/submit", {
    payload: FormPayload,
    success: Ok,
  }),
);

const FormApi = HttpApi.make("formTest").add(FormsGroup);

const startEchoServer = () =>
  Effect.gen(function* () {
    const captured: Captured = { contentType: "", body: "" };
    const FormsLive = HttpApiBuilder.group(FormApi, "forms", (handlers) =>
      handlers.handleRaw("submit", () =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          captured.contentType = request.headers["content-type"] ?? "";
          captured.body = yield* request.text.pipe(Effect.catch(() => Effect.succeed("")));
          return HttpServerResponse.jsonUnsafe({ ok: true });
        }),
      ),
    );
    const server = yield* serveOpenApiHttpApiTestServer({
      api: FormApi,
      handlersLayer: FormsLive,
    });
    return { baseUrl: server.baseUrl, specJson: server.specJson, captured };
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
      const { baseUrl, specJson, captured } = yield* startEchoServer();
      const { config } = yield* TestWorkspace;
      const executor = yield* createExecutor({ ...config, plugins });

      yield* executor.openapi.addSpec({
        spec: specJson,
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
