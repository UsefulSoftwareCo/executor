import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Schema } from "effect";

import { ElicitationResponse, createExecutor, definePlugin } from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";
import { makeExecutorToolInvoker } from "./tool-invoker";

const EmptyInputSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(Schema.Struct({})),
);

const acceptAll = () => Effect.succeed(ElicitationResponse.make({ action: "accept" }));

// Simulate a realistic plugin-internal tagged error whose `cause` carries
// sensitive internal context (DB connection string, full HTTP request with
// Authorization header echoed back, file paths, stack traces).
class FakeOpenApiInvocationError extends Data.TaggedError("OpenApiInvocationError")<{
  readonly message: string;
  readonly cause: unknown;
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
            Effect.fail(new FakeOpenApiInvocationError({
              message: "HTTP request failed",
              cause: {
                _tag: "HttpClientError",
                request: {
                  method: "GET",
                  url: "https://internal.dealcloud/v1/entities?accessToken=SECRET_TOKEN_xyz",
                  headers: { Authorization: "Bearer SECRET_TOKEN_xyz" },
                },
                stack:
                  "Error: ECONNREFUSED\n    at /home/svc/executor/packages/plugins/openapi/...:142:11",
                dbConnString: "postgres://app:p@ssw0rd@10.0.0.5:5432/executor",
              },
            })),
        },
        {
          name: "throwsRawError",
          description: "",
          inputSchema: EmptyInputSchema,
          handler: () =>
            Effect.fail(
              Object.assign(new Error("Internal: secret 'sk_live_abcd' rotation failed"), {
                stack:
                  "Error: Internal: secret 'sk_live_abcd' rotation failed\n    at /home/svc/.../secret-store.ts:88",
              }),
            ),
        },
      ],
    },
  ],
}));

describe("internal-error leak audit", () => {
  it.effect("plugin tagged error: only .message escapes, cause stays hidden", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [leakyPlugin()] as const }),
      );
      const invoker = makeExecutorToolInvoker(executor, {
        invokeOptions: { onElicitation: acceptAll },
      });

      const err = yield* Effect.flip(
        invoker.invoke({ path: "leaky.failsWithCause", args: {} }),
      );
      const msg = (err as { message: string }).message;
      // eslint-disable-next-line no-console
      console.log("[leak failsWithCause]", msg);

      expect(msg).toBe("HTTP request failed");
      expect(msg).not.toContain("SECRET_TOKEN_xyz");
      expect(msg).not.toContain("p@ssw0rd");
      expect(msg).not.toContain("packages/plugins");
      expect(msg).not.toContain("HttpClientError");
    }),
  );

  it.effect("plain Error with stack: stack does NOT leak, only message", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [leakyPlugin()] as const }),
      );
      const invoker = makeExecutorToolInvoker(executor, {
        invokeOptions: { onElicitation: acceptAll },
      });

      const err = yield* Effect.flip(
        invoker.invoke({ path: "leaky.throwsRawError", args: {} }),
      );
      const msg = (err as { message: string }).message;
      // eslint-disable-next-line no-console
      console.log("[leak throwsRawError]", msg);

      // message itself contains the secret because the plugin put it there —
      // that's plugin discipline. But stack and file path should not appear.
      expect(msg).not.toContain("secret-store.ts");
      expect(msg).not.toContain("at /home/");
    }),
  );
});
