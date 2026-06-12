// ---------------------------------------------------------------------------
// Telemetry contracts for the tool-dispatch path.
//
// The dangerous observability failure mode is the signal silently going dark:
// expected tool failures (`ToolResult.fail`) resolve through the Effect
// success channel, so without explicit outcome annotation the tracer records
// a healthy span for a user hitting an upstream error wall — absence of
// error data is indistinguishable from health. These tests drive real
// dispatches through a recording tracer and assert the spans, attributes,
// and error statuses that production queries (Axiom) depend on. A regression
// here fails CI instead of being discovered during the next incident.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Exit } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  ConnectionNotFoundError,
  ElicitationDeclinedError,
  IntegrationSlug,
  NoHandlerError,
  PluginNotLoadedError,
  ToolAddress,
  ToolBlockedError,
  ToolName,
  ToolNotFoundError,
  ToolResult,
  createExecutor,
  definePlugin,
  type CredentialProvider,
} from "@executor-js/sdk";
import { ProviderItemId, ProviderKey } from "@executor-js/sdk";
import {
  makeTestConfig,
  runWithRecordingTracer,
  spanEndedWithError,
} from "@executor-js/sdk/testing";
import { makeExecutorToolInvoker } from "./tool-invoker";

const TEMPLATE = AuthTemplateSlug.make("apiKey");
const CONN = ConnectionName.make("main");
const INTEG = IntegrationSlug.make("upstream");

const memoryProvider = (): CredentialProvider => {
  const store = new Map<string, string>();
  return {
    key: ProviderKey.make("telemetry-memory"),
    writable: true,
    get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id, value) => Effect.sync(() => void store.set(String(id), value)),
    list: () =>
      Effect.sync(() =>
        Array.from(store.keys()).map((key) => ({
          id: ProviderItemId.make(key),
          name: key,
        })),
      ),
  };
};

const EmptyInputJson = { type: "object", properties: {} } as const;

class TelemetryTestDefect extends Data.TaggedError("TelemetryTestDefect")<{
  readonly message: string;
}> {}

// One integration, three tools spanning the outcome classes the telemetry
// contract distinguishes: domain success, expected upstream failure
// (success channel), and an infra defect (failure channel).
const telemetryPlugin = definePlugin(() => ({
  id: "telemetry-test" as const,
  credentialProviders: [memoryProvider()],
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({
      tools: [
        { name: ToolName.make("succeeds"), description: "", inputSchema: EmptyInputJson },
        { name: ToolName.make("failsUpstream"), description: "", inputSchema: EmptyInputJson },
        { name: ToolName.make("defects"), description: "", inputSchema: EmptyInputJson },
      ],
    }),
  invokeTool: ({ toolRow }) => {
    if (toolRow.name === "succeeds") {
      return Effect.succeed(ToolResult.ok({ fine: true }));
    }
    if (toolRow.name === "failsUpstream") {
      return Effect.succeed(
        ToolResult.fail({
          code: "upstream_http_error",
          status: 502,
          message: "Bad gateway from upstream",
        }),
      );
    }
    return Effect.fail(new TelemetryTestDefect({ message: "database exploded" }));
  },
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: INTEG,
        description: "telemetry upstream",
        config: {},
      }),
  }),
}))();

const makeHarness = () =>
  Effect.gen(function* () {
    const executor = yield* createExecutor(makeTestConfig({ plugins: [telemetryPlugin] as const }));
    yield* (executor as never as Record<"telemetry-test", { seed: () => Effect.Effect<unknown> }>)[
      "telemetry-test"
    ].seed();
    yield* executor.connections.create({
      owner: "org",
      name: CONN,
      integration: INTEG,
      template: TEMPLATE,
      value: "token",
    });
    return makeExecutorToolInvoker(executor, { invokeOptions: {} });
  });

const dispatch = (tool: string) =>
  Effect.gen(function* () {
    const invoker = yield* makeHarness();
    return yield* invoker.invoke({ path: `upstream.org.main.${tool}`, args: {} });
  });

describe("telemetry contract: tool dispatch spans", () => {
  it.effect("a successful tool stamps outcome=ok on dispatch and execute spans", () =>
    Effect.gen(function* () {
      const { exit, recording } = yield* runWithRecordingTracer(dispatch("succeeds"));
      expect(Exit.isSuccess(exit)).toBe(true);

      const dispatchSpan = recording.single("mcp.tool.dispatch");
      expect(dispatchSpan.attributes.get("mcp.tool.name")).toBe("upstream.org.main.succeeds");
      expect(dispatchSpan.attributes.get("mcp.tool.integration")).toBe("upstream");
      expect(dispatchSpan.attributes.get("executor.tool.outcome")).toBe("ok");

      const executeSpan = recording.single("executor.tool.execute");
      expect(executeSpan.attributes.get("executor.tool.outcome")).toBe("ok");
      // Org/tenant attribution on the tool span itself — production queries
      // must not need a trace-id join against the outer request span.
      expect(executeSpan.attributes.get("executor.tenant")).toBe("test-tenant");
      expect(executeSpan.attributes.get("executor.subject")).toBe("test-subject");
    }),
  );

  it.effect(
    "an expected upstream failure (success channel) stamps outcome=fail + code + status",
    () =>
      Effect.gen(function* () {
        const { exit, recording } = yield* runWithRecordingTracer(dispatch("failsUpstream"));
        // The contract under test: the failure is a VALUE, not an Effect error…
        expect(Exit.isSuccess(exit)).toBe(true);

        // …so the span must carry the outcome explicitly, on both the
        // sandbox-dispatch span and the executor-execute span.
        for (const name of ["mcp.tool.dispatch", "executor.tool.execute"]) {
          const span = recording.single(name);
          expect(span.attributes.get("executor.tool.outcome")).toBe("fail");
          expect(span.attributes.get("executor.tool.error_code")).toBe("upstream_http_error");
          expect(span.attributes.get("executor.tool.error_status")).toBe(502);
        }
      }),
  );

  it.effect("an infra defect ends the dispatch span with an error exit", () =>
    Effect.gen(function* () {
      const { exit, recording } = yield* runWithRecordingTracer(dispatch("defects"));
      expect(Exit.isFailure(exit)).toBe(true);

      const dispatchSpan = recording.single("mcp.tool.dispatch");
      expect(spanEndedWithError(dispatchSpan)).toBe(true);
    }),
  );

  it.effect("tool_not_found surfaces as outcome=fail with its code on the dispatch span", () =>
    Effect.gen(function* () {
      const { exit, recording } = yield* runWithRecordingTracer(dispatch("doesNotExist"));
      // tool_not_found is an expected failure: surfaced as a ToolResult.fail
      // VALUE through the success channel.
      expect(Exit.isSuccess(exit)).toBe(true);

      const dispatchSpan = recording.single("mcp.tool.dispatch");
      expect(dispatchSpan.attributes.get("executor.tool.outcome")).toBe("fail");
      expect(dispatchSpan.attributes.get("executor.tool.error_code")).toBe("tool_not_found");
    }),
  );
});

describe("telemetry contract: error messages", () => {
  it("sdk tagged errors render a non-empty message for span status", () => {
    // These messages become OTLP status.message via Cause.prettyErrors —
    // before the derived getters, 562 of 804 error spans in a week of prod
    // data had an EMPTY status message (the error class defined no
    // `message`, and TaggedErrorClass instances default to "").
    const address = ToolAddress.make("tools.upstream.org.main.failsUpstream");
    const errors: ReadonlyArray<Error> = [
      new ToolNotFoundError({ address }),
      new ToolBlockedError({ address, pattern: "*" }),
      new PluginNotLoadedError({ address, pluginId: "p" }),
      new NoHandlerError({ address, pluginId: "p" }),
      new ConnectionNotFoundError({
        owner: "org",
        integration: INTEG,
        name: CONN,
      }),
      new ElicitationDeclinedError({ address, action: "decline" }),
    ];
    for (const error of errors) {
      // oxlint-disable-next-line executor/no-unknown-error-message -- the test asserts ON the message contract itself
      const { message, name } = error;
      expect(message.length, `${name} must derive a message`).toBeGreaterThan(0);
      expect(message).not.toContain("[object Object]");
    }
  });
});
