import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Option, Schema } from "effect";

import { ElicitationResponse, createExecutor, definePlugin } from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";
import { ExecutionToolError } from "./errors";
import { makeExecutorToolInvoker } from "./tool-invoker";

const EmptyInputSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(Schema.Struct({})),
);

const acceptAll = () => Effect.succeed(ElicitationResponse.make({ action: "accept" }));

// Plugin-internal tagged error whose `cause` carries internal diagnostics.
// The dispatcher must route this through the opaque-generic path so none of
// that context reaches the sandbox via Error.message.
class FakePluginInvocationError extends Data.TaggedError("PluginInvocationError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

// Mirrors the openapi plugin's OpenApiInvocationError shape (the dispatcher
// matches it structurally by tag, not by class identity, since this package
// does not depend on the plugin). Pre-flight raises carry statusCode: None
// and no cause and must surface verbatim; transport/post-response failures
// must stay opaque.
class FakeOpenApiInvocationError extends Data.TaggedError("OpenApiInvocationError")<{
  readonly message: string;
  readonly statusCode: Option.Option<number>;
  readonly cause?: unknown;
}> {}

const leakyPlugin = definePlugin(() => ({
  id: "leaky-test" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "leaky",
      kind: "in-memory",
      name: "Leaky",
      tools: [
        {
          name: "failsWithCause",
          description: "",
          inputSchema: EmptyInputSchema,
          handler: () =>
            Effect.fail(
              new FakePluginInvocationError({
                message: "Upstream request failed",
                cause: {
                  _tag: "InternalTransportError",
                  request: {
                    method: "GET",
                    url: "https://internal.service.local/v1/resources?trace=trace-123",
                    headers: { "x-internal-routing": "private-cluster" },
                  },
                  stack: "Error: connect failed\n    at plugin-transport.ts:42:11",
                  note: "internal diagnostic detail",
                },
              }),
            ),
        },
        {
          name: "throwsRawError",
          description: "",
          inputSchema: EmptyInputSchema,
          handler: () =>
            Effect.fail(
              Object.assign(
                // oxlint-disable-next-line executor/no-error-constructor -- boundary: leak test deliberately fails with a raw Error + crafted stack to assert the dispatcher's opaque-generic redaction
                new Error("Internal: secret 'sk_live_abcd' rotation failed"),
                {
                  stack:
                    "Error: Internal: secret 'sk_live_abcd' rotation failed\n    at /home/svc/.../secret-store.ts:88",
                },
              ),
            ),
        },
        {
          name: "failsPreflightPathParam",
          description: "",
          inputSchema: EmptyInputSchema,
          handler: () =>
            Effect.fail(
              new FakeOpenApiInvocationError({
                message: "Missing required path parameter: datasourceId",
                statusCode: Option.none(),
              }),
            ),
        },
        {
          name: "failsPreflightBody",
          description: "",
          inputSchema: EmptyInputSchema,
          handler: () =>
            Effect.fail(
              new FakeOpenApiInvocationError({
                message: "Missing required request body",
                statusCode: Option.none(),
              }),
            ),
        },
        {
          name: "failsOpenApiTransport",
          description: "",
          inputSchema: EmptyInputSchema,
          handler: () =>
            Effect.fail(
              new FakeOpenApiInvocationError({
                message: "HTTP request failed",
                statusCode: Option.none(),
                cause: {
                  _tag: "RequestError",
                  request: { url: "https://internal.service.local/v1?token=tok-456" },
                },
              }),
            ),
        },
        {
          name: "failsOpenApiPostResponse",
          description: "",
          inputSchema: EmptyInputSchema,
          handler: () =>
            Effect.fail(
              new FakeOpenApiInvocationError({
                message: "Failed to read response body",
                statusCode: Option.some(502),
                cause: { _tag: "ResponseError", note: "internal parser detail" },
              }),
            ),
        },
      ],
    },
  ],
}));

describe("internal-error leak audit (opaque defects)", () => {
  it.effect("plugin tagged error: defect surfaces only as opaque generic + correlation id", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [leakyPlugin()] as const }));
      const invoker = makeExecutorToolInvoker(executor, {
        invokeOptions: { onElicitation: acceptAll },
      });

      const err = yield* Effect.flip(invoker.invoke({ path: "leaky.failsWithCause", args: {} }));
      expect(err).toBeInstanceOf(ExecutionToolError);
      // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: leak test inspects the rendered message to assert it is the opaque generic
      const msg = (err as { message: string }).message;
      // Must be the canonical opaque shape: "Internal tool error [<hex>]"
      expect(msg).toMatch(/^Internal tool error \[[0-9a-f]{8}\]$/);
      // Crucially, no internal context leaks
      expect(msg).not.toContain("trace-123");
      expect(msg).not.toContain("private-cluster");
      expect(msg).not.toContain("internal.service.local");
      expect(msg).not.toContain("InternalTransportError");
      expect(msg).not.toContain("Upstream request failed");
    }),
  );

  it.effect("plain Error with stack: stack and message do NOT escape", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [leakyPlugin()] as const }));
      const invoker = makeExecutorToolInvoker(executor, {
        invokeOptions: { onElicitation: acceptAll },
      });

      const err = yield* Effect.flip(invoker.invoke({ path: "leaky.throwsRawError", args: {} }));
      // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: leak test inspects the rendered message to assert it is the opaque generic
      const msg = (err as { message: string }).message;
      expect(msg).toMatch(/^Internal tool error \[[0-9a-f]{8}\]$/);
      expect(msg).not.toContain("secret-store.ts");
      expect(msg).not.toContain("at /home/");
      expect(msg).not.toContain("sk_live_abcd");
    }),
  );
});

describe("openapi pre-flight invocation errors (expected failures)", () => {
  it.effect("missing path parameter surfaces verbatim as invalid_tool_arguments", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [leakyPlugin()] as const }));
      const invoker = makeExecutorToolInvoker(executor, {
        invokeOptions: { onElicitation: acceptAll },
      });

      const result = yield* invoker.invoke({ path: "leaky.failsPreflightPathParam", args: {} });
      expect(result).toEqual({
        ok: false,
        error: {
          code: "invalid_tool_arguments",
          message: "Missing required path parameter: datasourceId",
        },
      });
    }),
  );

  it.effect("missing request body surfaces verbatim as invalid_tool_arguments", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [leakyPlugin()] as const }));
      const invoker = makeExecutorToolInvoker(executor, {
        invokeOptions: { onElicitation: acceptAll },
      });

      const result = yield* invoker.invoke({ path: "leaky.failsPreflightBody", args: {} });
      expect(result).toEqual({
        ok: false,
        error: {
          code: "invalid_tool_arguments",
          message: "Missing required request body",
        },
      });
    }),
  );

  it.effect("transport failure (statusCode None but cause present) stays opaque", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [leakyPlugin()] as const }));
      const invoker = makeExecutorToolInvoker(executor, {
        invokeOptions: { onElicitation: acceptAll },
      });

      const err = yield* Effect.flip(
        invoker.invoke({ path: "leaky.failsOpenApiTransport", args: {} }),
      );
      expect(err).toBeInstanceOf(ExecutionToolError);
      // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: leak test inspects the rendered message to assert it is the opaque generic
      const msg = (err as { message: string }).message;
      expect(msg).toMatch(/^Internal tool error \[[0-9a-f]{8}\]$/);
      expect(msg).not.toContain("internal.service.local");
      expect(msg).not.toContain("tok-456");
      expect(msg).not.toContain("HTTP request failed");
    }),
  );

  it.effect("post-response failure (statusCode Some) stays opaque", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [leakyPlugin()] as const }));
      const invoker = makeExecutorToolInvoker(executor, {
        invokeOptions: { onElicitation: acceptAll },
      });

      const err = yield* Effect.flip(
        invoker.invoke({ path: "leaky.failsOpenApiPostResponse", args: {} }),
      );
      expect(err).toBeInstanceOf(ExecutionToolError);
      // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: leak test inspects the rendered message to assert it is the opaque generic
      const msg = (err as { message: string }).message;
      expect(msg).toMatch(/^Internal tool error \[[0-9a-f]{8}\]$/);
      expect(msg).not.toContain("Failed to read response body");
      expect(msg).not.toContain("internal parser detail");
    }),
  );
});
