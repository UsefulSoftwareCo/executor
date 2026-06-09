import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  isToolResult,
  type PluginCtx,
  type ResolveToolsInput,
  type ToolInvocationCredential,
  type ToolResult,
  type ToolRow,
} from "@executor-js/sdk";

import { httpSourcePlugin, REQUEST_TOOL_NAME } from "./plugin";
import { variable, type HttpSourceConfig } from "./types";

const plugin = httpSourcePlugin();

// The store + invoke-input types the plugin's hooks expect (store inferred as
// `{}` from `storage: () => ({})`). Derive them so the test inputs line up.
type Store = ReturnType<typeof plugin.storage>;
type InvokeInput = Parameters<NonNullable<typeof plugin.invokeTool>>[0];

const config: HttpSourceConfig = {
  baseUrl: "https://api.example.com",
  authenticationTemplate: [
    {
      slug: AuthTemplateSlug.make("apiKey"),
      type: "apiKey",
      headers: { Authorization: ["Bearer ", variable("token")] },
    },
  ],
};

const capturingLayer = (
  capture: { request?: HttpClientRequest.HttpClientRequest },
  response: Response,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
      capture.request = request;
      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    }),
  );

const emptyHttpLayer: Layer.Layer<HttpClient.HttpClient> = capturingLayer(
  {},
  new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  }),
);

// Test fixture: the hooks only read `ctx.httpClientLayer` (and `detect` ignores
// ctx entirely), so a stub carrying just that is sufficient.
const ctxWith = (httpClientLayer: Layer.Layer<HttpClient.HttpClient>): PluginCtx<Store> =>
  // lint-allow-double-cast: test stub — hooks under test only touch httpClientLayer
  ({ httpClientLayer }) as unknown as PluginCtx<Store>;

const credential = (value: string | null): ToolInvocationCredential => ({
  owner: "user",
  integration: IntegrationSlug.make("example"),
  connection: ConnectionName.make("default"),
  template: AuthTemplateSlug.make("apiKey"),
  value,
  values: value === null ? {} : { token: value },
  config,
});

const toolRow =
  // lint-allow-double-cast: test fixture — invokeTool doesn't read toolRow fields
  {
    name: String(REQUEST_TOOL_NAME),
    integration: "example",
    connection: "default",
  } as unknown as ToolRow;

const noElicit = (() => Effect.die("no elicit")) as InvokeInput["elicit"];

// Assert an invokeTool result is a failed ToolResult and return its error code.
const failureCode = (out: unknown): string => {
  expect(isToolResult(out)).toBe(true);
  const result = out as ToolResult<unknown>;
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.error.code;
};

describe("httpSourcePlugin.resolveTools", () => {
  it.effect("produces a single `request` tool referencing the base URL", () =>
    Effect.gen(function* () {
      const input: ResolveToolsInput = {
        integration: {
          slug: IntegrationSlug.make("example"),
          description: "Example",
          kind: "http-source",
          canRemove: true,
          canRefresh: true,
          authMethods: [],
        },
        config,
        connection: {
          owner: "user",
          integration: IntegrationSlug.make("example"),
          name: ConnectionName.make("default"),
        },
        getValue: () => Effect.succeed(null),
      };
      const result = yield* plugin.resolveTools!(input);
      expect(result.tools).toHaveLength(1);
      expect(String(result.tools[0]!.name)).toBe("request");
      expect(result.tools[0]!.description).toContain("https://api.example.com");
    }),
  );
});

describe("httpSourcePlugin.invokeTool", () => {
  it.effect("renders the auth template onto the request and returns ToolResult.ok", () =>
    Effect.gen(function* () {
      const capture: { request?: HttpClientRequest.HttpClientRequest } = {};
      const layer = capturingLayer(
        capture,
        new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      const input: InvokeInput = {
        ctx: ctxWith(layer),
        toolRow,
        credential: credential("sk-secret"),
        args: { method: "GET", path: "/ping" },
        elicit: noElicit,
      };

      const out = yield* plugin.invokeTool!(input);
      expect(isToolResult(out)).toBe(true);
      expect(out).toMatchObject({ ok: true, data: { status: 200 } });
      expect(capture.request!.headers["authorization"]).toBe("Bearer sk-secret");
      expect(capture.request!.url).toContain("https://api.example.com/ping");
    }),
  );

  it.effect("returns an auth failure ToolResult when the credential value is missing", () =>
    Effect.gen(function* () {
      const capture: { request?: HttpClientRequest.HttpClientRequest } = {};
      const layer = capturingLayer(capture, new Response("{}", { status: 200 }));

      const input: InvokeInput = {
        ctx: ctxWith(layer),
        toolRow,
        credential: credential(null),
        args: { path: "/ping" },
        elicit: noElicit,
      };

      const out = yield* plugin.invokeTool!(input);
      expect(failureCode(out)).toBe("connection_value_missing");
      // No request should have been issued.
      expect(capture.request).toBeUndefined();
    }),
  );

  it.effect("rejects args without a `path`", () =>
    Effect.gen(function* () {
      const input: InvokeInput = {
        ctx: ctxWith(emptyHttpLayer),
        toolRow,
        credential: credential("sk"),
        args: { method: "GET" },
        elicit: noElicit,
      };
      const out = yield* plugin.invokeTool!(input);
      expect(failureCode(out)).toBe("invalid_arguments");
    }),
  );
});

describe("httpSourcePlugin.detect", () => {
  it.effect("claims any http(s) URL at low confidence", () =>
    Effect.gen(function* () {
      const result = yield* plugin.detect!({
        ctx: ctxWith(emptyHttpLayer),
        url: "https://api.acme.dev/v1",
      });
      expect(result).toEqual({
        kind: "http-source",
        confidence: "low",
        endpoint: "https://api.acme.dev/v1",
        name: "api.acme.dev",
        slug: "api.acme.dev",
      });
    }),
  );

  it.effect("ignores non-http URLs", () =>
    Effect.gen(function* () {
      const result = yield* plugin.detect!({
        ctx: ctxWith(emptyHttpLayer),
        url: "ftp://example.com",
      });
      expect(result).toBeNull();
    }),
  );
});
