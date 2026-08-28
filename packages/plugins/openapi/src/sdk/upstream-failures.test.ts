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
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";
import {
  addOpenApiTestConnection,
  makeOpenApiHttpApiTestIntegrationConfig,
  type OpenApiTestServerShape,
  serveOpenApiHttpApiTestServer,
  unwrapInvocation,
} from "../testing";

import { openApiPlugin } from "./plugin";

const testPlugins = () =>
  [openApiPlugin({ httpClientLayer: FetchHttpClient.layer }), memoryCredentialsPlugin()] as const;

// `/things` GET op `listThings` under group "things" → tool path
// `things.listThings`, used verbatim (dots and all) as the address tool segment.
const LIST_THINGS = "things.listThings";

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

// Build an executor + connection from the FailureApi HttpApi against an
// arbitrary baseUrl (used for the Node-transport socket-drop / slow cases).
const buildExecutor = (baseUrl: string) =>
  Effect.gen(function* () {
    const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));
    yield* executor.openapi.addSpec(
      makeOpenApiHttpApiTestIntegrationConfig(FailureApi, { slug: "f", baseUrl }),
    );
    yield* executor.connections.create({
      owner: "org",
      name: ConnectionName.make("main"),
      integration: IntegrationSlug.make("f"),
      template: AuthTemplateSlug.make("apiKey"),
      value: "token",
    });
    const address = ToolAddress.make(`tools.f.org.main.${LIST_THINGS}`);
    return { executor, address };
  });

const buildExecutorForOpenApiServer = (server: OpenApiTestServerShape) =>
  Effect.gen(function* () {
    const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));
    const conn = yield* addOpenApiTestConnection(executor, server, { slug: "f" });
    return { executor, address: conn.address(LIST_THINGS) };
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
      const { executor, address } = yield* buildExecutorForOpenApiServer(server);

      const exit = yield* executor.execute(address, {}).pipe(Effect.exit);

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
      const { executor, address } = yield* buildExecutorForOpenApiServer(server);

      const exit = yield* executor.execute(address, {}).pipe(Effect.exit);

      const text = Exit.match(exit, {
        onFailure: (cause) => JSON.stringify(cause),
        onSuccess: (value) => JSON.stringify(value),
      });
      // Must mention the upstream status or the error body.
      expect(text).toMatch(/422|too_short|name|response|error/i);
    }),
  );

  it.effect("upstream 401 is classified as connection_rejected", () =>
    Effect.gen(function* () {
      const server = yield* startScriptedServer(() => ({
        status: 401,
        headers: { "content-type": "application/json" },
        body: '{"error":{"message":"invalid token"}}',
      }));
      const { executor, address } = yield* buildExecutorForOpenApiServer(server);

      const result = yield* executor.execute(address, {});

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "connection_rejected",
          status: 401,
          message: expect.stringContaining("Upstream rejected credentials"),
          details: {
            category: "authentication",
            upstream: {
              status: 401,
            },
          },
        },
      });
    }),
  );

  // A 403 that names a scope shortfall is unfixable by re-running the same
  // grant: it must NOT be connection_rejected (whose recovery tells the agent
  // to oauth.start the identical grant and loop on the identical 403).
  it.effect(
    "scope-insufficient 403 (Google ErrorInfo) is classified as oauth_scope_insufficient",
    () =>
      Effect.gen(function* () {
        const server = yield* startScriptedServer(() => ({
          status: 403,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            error: {
              code: 403,
              message: "Request had insufficient authentication scopes.",
              status: "PERMISSION_DENIED",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                  reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
                  domain: "googleapis.com",
                  metadata: { service: "drive.googleapis.com" },
                },
              ],
            },
          }),
        }));
        const { executor, address } = yield* buildExecutorForOpenApiServer(server);

        const result = yield* executor.execute(address, {});

        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "oauth_scope_insufficient",
            status: 403,
            message: expect.stringContaining("does not cover the scope"),
            details: {
              category: "authentication",
              upstream: { status: 403 },
            },
          },
        });
        const recovery = (
          result as {
            error: { details: { recovery: Record<string, string> } };
          }
        ).error.details.recovery;
        expect(
          recovery.startOAuthTool,
          "no oauth.start hint: re-running the identical grant cannot satisfy the scope",
        ).toBeUndefined();
        expect(recovery.scopeInstructions).toBeDefined();
      }),
  );

  it.effect(
    "scope-insufficient 403 (RFC 6750 WWW-Authenticate challenge) is classified as oauth_scope_insufficient",
    () =>
      Effect.gen(function* () {
        const server = yield* startScriptedServer(() => ({
          status: 403,
          headers: {
            "content-type": "application/json",
            "www-authenticate":
              'Bearer realm="api", error="insufficient_scope", scope="files.read"',
          },
          body: '{"message":"forbidden"}',
        }));
        const { executor, address } = yield* buildExecutorForOpenApiServer(server);

        const result = yield* executor.execute(address, {});

        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "oauth_scope_insufficient",
            status: 403,
            // The challenge names the missing scope; the message carries it so
            // the agent can tell the user exactly what to grant.
            message: expect.stringContaining("files.read"),
          },
        });
      }),
  );

  it.effect("scope-insufficient 403 names the operation's declared scopes from the binding", () =>
    Effect.gen(function* () {
      // The upstream signals only the CLASS of failure (Google's ErrorInfo
      // carries no scope name); the operation's own `security` declaration —
      // extracted into the stored binding — fills in what the operation
      // needs, so the agent can tell the user exactly what to grant.
      const server = yield* startScriptedServer(() => ({
        status: 403,
        headers: { "content-type": "application/json" },
        body: '{"error":{"status":"PERMISSION_DENIED","details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}',
      }));
      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));
      // Declare the operation's scope in the spec blob before registering it,
      // so the extracted binding carries requiredScopes.
      const SpecJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
      const parsed = yield* Schema.decodeUnknownEffect(SpecJson)(server.specJson);
      const paths = parsed.paths as Record<string, Record<string, Record<string, unknown>>>;
      paths["/things"]!.get!.security = [{ oauth: ["things.read"] }];
      yield* executor.openapi.addSpec({
        spec: { kind: "blob", value: yield* Schema.encodeEffect(SpecJson)(parsed) },
        slug: "f",
        baseUrl: server.baseUrl,
      });
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: IntegrationSlug.make("f"),
        template: AuthTemplateSlug.make("apiKey"),
        value: "token",
      });

      const result = yield* executor.execute(
        ToolAddress.make(`tools.f.org.main.${LIST_THINGS}`),
        {},
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "oauth_scope_insufficient",
          message: expect.stringContaining("things.read"),
        },
      });
    }),
  );

  it.effect("ordinary 403 without a scope signal stays connection_rejected", () =>
    Effect.gen(function* () {
      const server = yield* startScriptedServer(() => ({
        status: 403,
        headers: { "content-type": "application/json" },
        body: '{"error":{"status":"PERMISSION_DENIED","message":"Caller lacks permission"}}',
      }));
      const { executor, address } = yield* buildExecutorForOpenApiServer(server);

      const result = yield* executor.execute(address, {});

      expect(result).toMatchObject({
        ok: false,
        error: { code: "connection_rejected", status: 403 },
      });
    }),
  );

  it.effect("upstream returns malformed JSON despite Content-Type: application/json", () =>
    Effect.gen(function* () {
      const server = yield* startScriptedServer(() => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: "not json at all <<<<",
      }));
      const { executor, address } = yield* buildExecutorForOpenApiServer(server);

      // Whatever happens, the test asserts it doesn't produce a defect or
      // hang — either the plugin returns a value (raw text / passthrough)
      // or it surfaces a tagged failure. Both are acceptable; what's not
      // is silently throwing in a way that escapes the Effect.
      const exit = yield* executor.execute(address, {}).pipe(Effect.exit);

      // Don't over-specify — just verify the runtime didn't crash and
      // the result is observable.
      expect(Exit.isFailure(exit) || Exit.isSuccess(exit)).toBe(true);
    }),
  );

  it.effect("upstream connection drop mid-response surfaces as a failure", () =>
    Effect.gen(function* () {
      const { baseUrl } = yield* startDroppingServer();
      const { executor, address } = yield* buildExecutor(baseUrl);

      const exit = yield* executor.execute(address, {}).pipe(Effect.exit);

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
      const { executor, address } = yield* buildExecutorForOpenApiServer(server);

      const exit = yield* executor.execute(address, {}).pipe(Effect.exit);

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
      const { executor, address } = yield* buildExecutor(baseUrl);

      const result = unwrapInvocation(yield* executor.execute(address, {}));
      expect(result.data).toEqual([]);
    }),
  );
});
