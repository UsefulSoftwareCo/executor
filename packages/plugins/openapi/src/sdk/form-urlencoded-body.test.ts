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
import { FetchHttpClient } from "effect/unstable/http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createExecutor,
  definePlugin,
  type InvokeOptions,
  type SecretProvider,
} from "@executor-js/sdk";
import { makeTestExecutorLayer, TestExecutor } from "@executor-js/sdk/testing";

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
  Effect.acquireRelease(
    Effect.callback<{ baseUrl: string; captured: Captured; close: () => void }>((resume) => {
      const captured: Captured = { contentType: "", body: "" };
      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          captured.contentType = req.headers["content-type"] ?? "";
          captured.body = Buffer.concat(chunks).toString("utf8");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as AddressInfo).port;
        resume(
          Effect.succeed({
            baseUrl: `http://127.0.0.1:${port}`,
            captured,
            close: () => server.close(),
          }),
        );
      });
    }),
    (s) => Effect.sync(() => s.close()),
  );

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
  makeTestExecutorLayer({
    plugins,
  }),
  { timeout: "15 seconds" },
)("OpenAPI non-JSON request body serialization", (it) => {
  it.effect("form-urlencoded object body is properly encoded (no '[object Object]')", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const { config } = yield* TestExecutor;
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
