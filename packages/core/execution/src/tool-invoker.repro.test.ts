import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { ElicitationResponse, createExecutor, definePlugin } from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";
import { makeExecutorToolInvoker } from "./tool-invoker";

const EmptyInputSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(Schema.Struct({})),
);

const acceptAll = () => Effect.succeed(ElicitationResponse.make({ action: "accept" }));

// Simulate the kind of error envelopes real upstreams (SharePoint, DealCloud,
// Microsoft Graph, etc.) actually return.
const upstreamErrorPlugin = definePlugin(() => ({
  id: "upstream-error-test" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "upstream",
      kind: "in-memory",
      name: "Upstream",
      tools: [
        {
          // Microsoft Graph / SharePoint shape: { error: { code, message } }
          name: "sharepointShape",
          description: "",
          inputSchema: EmptyInputSchema,
          handler: () =>
            Effect.succeed({
              data: null,
              error: {
                error: {
                  code: "invalidRequest",
                  message:
                    "The expression \"foo\" is not valid. Provide a valid expression.",
                },
              },
            }),
        },
        {
          // DealCloud-ish shape: errorCode + errorMessage
          name: "dealcloudShape",
          description: "",
          inputSchema: EmptyInputSchema,
          handler: () =>
            Effect.succeed({
              data: null,
              error: {
                errorCode: 400,
                errorMessage: "Entity 'Deals' has no field 'XYZ'",
              },
            }),
        },
        {
          // JSON:API / multi-errors shape
          name: "errorsArrayShape",
          description: "",
          inputSchema: EmptyInputSchema,
          handler: () =>
            Effect.succeed({
              data: null,
              error: {
                errors: [
                  { status: "403", title: "Forbidden", detail: "Insufficient scope" },
                ],
              },
            }),
        },
        {
          // Plain string body
          name: "stringShape",
          description: "",
          inputSchema: EmptyInputSchema,
          handler: () =>
            Effect.succeed({
              data: null,
              error: "Internal Server Error",
            }),
        },
      ],
    },
  ],
}));

describe("repro: opaque tool execution failures", () => {
  it.effect("SharePoint/Graph nested error.message is LOST -> 'Tool execution failed'", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [upstreamErrorPlugin()] as const }),
      );
      const invoker = makeExecutorToolInvoker(executor, {
        invokeOptions: { onElicitation: acceptAll },
      });

      const err = yield* Effect.flip(
        invoker.invoke({ path: "upstream.sharepointShape", args: {} }),
      );
      // eslint-disable-next-line no-console
      console.log("[repro sharepoint]", (err as { message: string }).message);
      expect((err as { message: string }).message).toBe("Tool execution failed");
    }),
  );

  it.effect("DealCloud errorMessage is LOST -> 'Tool execution failed'", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [upstreamErrorPlugin()] as const }),
      );
      const invoker = makeExecutorToolInvoker(executor, {
        invokeOptions: { onElicitation: acceptAll },
      });

      const err = yield* Effect.flip(
        invoker.invoke({ path: "upstream.dealcloudShape", args: {} }),
      );
      // eslint-disable-next-line no-console
      console.log("[repro dealcloud]", (err as { message: string }).message);
      expect((err as { message: string }).message).toBe("Tool execution failed");
    }),
  );

  it.effect("JSON:API errors[] is LOST -> 'Tool execution failed'", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [upstreamErrorPlugin()] as const }),
      );
      const invoker = makeExecutorToolInvoker(executor, {
        invokeOptions: { onElicitation: acceptAll },
      });

      const err = yield* Effect.flip(
        invoker.invoke({ path: "upstream.errorsArrayShape", args: {} }),
      );
      // eslint-disable-next-line no-console
      console.log("[repro errors-array]", (err as { message: string }).message);
      expect((err as { message: string }).message).toBe("Tool execution failed");
    }),
  );

  it.effect("plain string error body is preserved", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [upstreamErrorPlugin()] as const }),
      );
      const invoker = makeExecutorToolInvoker(executor, {
        invokeOptions: { onElicitation: acceptAll },
      });

      const err = yield* Effect.flip(
        invoker.invoke({ path: "upstream.stringShape", args: {} }),
      );
      // eslint-disable-next-line no-console
      console.log("[repro string]", (err as { message: string }).message);
      expect((err as { message: string }).message).toBe("Internal Server Error");
    }),
  );
});
