import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  ToolAddress,
  ToolName,
} from "./ids";
import {
  ElicitationDeclinedError,
  ElicitationResponse,
  type ElicitationHandler,
} from "./elicitation";
import { ToolInvocationError } from "./errors";
import { definePlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { makeTestExecutor } from "./testing";
import { ToolResult } from "./tool-result";
import {
  clampToolCallLimit,
  toolCallArgKeys,
  toolCallOutcome,
  TOOL_CALL_ARG_KEY_LIMIT,
  TOOL_CALL_LIST_DEFAULT_LIMIT,
  TOOL_CALL_LIST_MAX_LIMIT,
} from "./tool-call-log";

// ---------------------------------------------------------------------------
// Pure classification — no executor required.
// ---------------------------------------------------------------------------

describe("toolCallOutcome", () => {
  it("records a plain success as ok", () => {
    expect(toolCallOutcome(Exit.succeed({ ran: true }))).toEqual({
      outcome: "ok",
      errorCode: null,
      errorMessage: null,
    });
  });

  it("records a ToolResult.fail as fail, not ok", () => {
    // The case the span-only telemetry gets wrong: an expected tool failure
    // travels the SUCCESS channel, so anything that looks at the Effect
    // channel alone reports an upstream 404 as a healthy call.
    const summary = toolCallOutcome(
      Exit.succeed(ToolResult.fail({ code: "http_error", message: "404 Not Found", status: 404 })),
    );
    expect(summary.outcome).toBe("fail");
    expect(summary.errorCode).toBe("http_error");
  });

  it("keeps the upstream's code and never its message", () => {
    // Plugins derive that message from the upstream response body, which
    // routinely echoes the request back — including whatever was in it.
    const summary = toolCallOutcome(
      Exit.succeed(
        ToolResult.fail({
          code: "http_error",
          message: "invalid token ghp_averyrealsecrettoken for user@example.com",
        }),
      ),
    );
    expect(summary.errorCode).toBe("http_error");
    expect(summary.errorMessage).toBeNull();
    expect(JSON.stringify(summary)).not.toContain("ghp_averyrealsecrettoken");
  });

  it("records a decline a tool handler raised, not a generic error", () => {
    // `execute` wraps any handler failure in ToolInvocationError on the way
    // out, so the decline arrives one level down.
    const declined = new ElicitationDeclinedError({
      address: ToolAddress.make("tools.github.org.main.delete"),
      action: "decline",
    });
    const summary = toolCallOutcome(
      Exit.fail(
        new ToolInvocationError({
          address: ToolAddress.make("tools.github.org.main.delete"),
          message: "declined",
          cause: declined,
        }),
      ),
    );
    expect(summary.outcome).toBe("declined");
  });

  it("drops an error code that is not shaped like one", () => {
    // `ToolError.code` is typed as any string, so a plugin can forward an
    // upstream body into it. The outcome already says what happened.
    const summary = toolCallOutcome(
      Exit.succeed(
        ToolResult.fail({
          code: '{"error":"invalid_grant","token":"ghp_averyrealsecrettoken"}',
          message: "upstream said no",
        }),
      ),
    );
    expect(summary.outcome).toBe("fail");
    expect(summary.errorCode).toBeNull();
    expect(JSON.stringify(summary)).not.toContain("ghp_averyrealsecrettoken");
  });

  it("records a defect as an error rather than losing the call", () => {
    // The point of the test is an untyped throw from outside the Effect domain.
    // oxlint-disable-next-line executor/no-error-constructor -- boundary: simulating a defect
    const summary = toolCallOutcome(Exit.failCause(Cause.die(new Error("boom"))));
    expect(summary.outcome).toBe("error");
    // The tag, never the message: a defect's text comes from outside.
    expect(summary.errorMessage).toBeNull();
  });
});

describe("toolCallArgKeys", () => {
  it("keeps the names and never the values", () => {
    const keys = toolCallArgKeys({ siteUrl: "sc-domain:example.com", token: "s3cr3t" });
    expect(keys).toEqual(["siteUrl", "token"]);
    expect(JSON.stringify(keys)).not.toContain("s3cr3t");
  });

  it("has nothing to say about absent or non-object arguments", () => {
    expect(toolCallArgKeys(undefined)).toBeNull();
    expect(toolCallArgKeys("just a string")).toBeNull();
    expect(toolCallArgKeys([1, 2, 3])).toBeNull();
    expect(toolCallArgKeys({})).toBeNull();
  });

  it("caps a pathological argument map", () => {
    const args = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
    expect(toolCallArgKeys(args)).toHaveLength(TOOL_CALL_ARG_KEY_LIMIT);
  });

  it("drops names that are payloads or credentials rather than parameters", () => {
    // `execute` takes `unknown` arguments, so a KEY is caller-controlled too.
    const keys = toolCallArgKeys({
      siteUrl: "ok",
      ghp_averyrealsecrettoken: null,
      ["x".repeat(500)]: 1,
      eyJhbGciOiJIUzI1NiJ9: 1,
      "0123456789abcdef0123456789abcdef": 1,
      '{"nested":"json"}': 1,
    });
    expect(keys).toEqual(["siteUrl"]);
  });
});

describe("clampToolCallLimit", () => {
  it("defaults, floors and caps", () => {
    expect(clampToolCallLimit(undefined)).toBe(TOOL_CALL_LIST_DEFAULT_LIMIT);
    expect(clampToolCallLimit(Number.NaN)).toBe(TOOL_CALL_LIST_DEFAULT_LIMIT);
    expect(clampToolCallLimit(0)).toBe(1);
    expect(clampToolCallLimit(25)).toBe(25);
    expect(clampToolCallLimit(10_000)).toBe(TOOL_CALL_LIST_MAX_LIMIT);
  });
});

// ---------------------------------------------------------------------------
// Executor integration — every ending a call can have must leave a row.
// ---------------------------------------------------------------------------

const memoryProvider = (): CredentialProvider => {
  const store = new Map<string, string>();
  return {
    key: ProviderKey.make("memory"),
    writable: true,
    get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id, value) => Effect.sync(() => void store.set(String(id), value)),
  };
};

const GITHUB = IntegrationSlug.make("github");
const TEMPLATE = AuthTemplateSlug.make("apiKey");
const CONN = ConnectionName.make("main");

const addr = (toolName: string): ToolAddress =>
  ToolAddress.make(`tools.${GITHUB}.org.${CONN}.${toolName}`);

const logTestPlugin = definePlugin(() => ({
  id: "logtest" as const,
  storage: () => ({}),
  credentialProviders: [memoryProvider()],
  resolveTools: () =>
    Effect.succeed({
      tools: [
        { name: ToolName.make("get"), description: "read a repo" },
        { name: ToolName.make("missing"), description: "always 404s upstream" },
        {
          name: ToolName.make("delete"),
          description: "delete a repo",
          annotations: { requiresApproval: true },
        },
      ],
    }),
  invokeTool: ({ toolRow }) =>
    toolRow.name === "missing"
      ? Effect.succeed(ToolResult.fail({ code: "http_error", message: "404", status: 404 }))
      : Effect.succeed(ToolResult.ok({ ran: toolRow.name })),
  extension: (ctx) => ({
    seed: () => ctx.core.integrations.register({ slug: GITHUB, description: "GitHub", config: {} }),
  }),
}));

const decliningHandler: ElicitationHandler = () =>
  Effect.succeed(ElicitationResponse.make({ action: "decline" }));

const setupExecutor = () =>
  makeTestExecutor({ plugins: [logTestPlugin()] as const }).pipe(
    Effect.tap((executor) =>
      Effect.gen(function* () {
        yield* executor.logtest.seed();
        yield* executor.connections.create({
          owner: "org",
          name: CONN,
          integration: GITHUB,
          template: TEMPLATE,
          from: { provider: ProviderKey.make("memory"), id: ProviderItemId.make("g") },
        });
      }),
    ),
  );

describe("executor.toolCalls", () => {
  it.effect("is empty before anything runs", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      expect(yield* executor.toolCalls.list()).toEqual([]);
    }),
  );

  it.effect("records a successful call with its address, policy and duration", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      yield* executor.execute(addr("get"), { owner: "midego1", repo: "hermes-box" });

      const calls = yield* executor.toolCalls.list();
      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call?.address).toBe(String(addr("get")));
      expect(call?.integration).toBe("github");
      expect(call?.connection).toBe("main");
      expect(call?.tool).toBe("get");
      expect(call?.outcome).toBe("ok");
      expect(call?.errorCode).toBeNull();
      expect(call?.argKeys).toEqual(["owner", "repo"]);
      expect(call?.durationMs).toBeGreaterThanOrEqual(0);
    }),
  );

  it.effect("never stores argument values, only their names", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      yield* executor.execute(addr("get"), { token: "ghp_averyrealsecrettoken" });

      const [call] = yield* executor.toolCalls.list();
      expect(call?.argKeys).toEqual(["token"]);
      expect(JSON.stringify(call)).not.toContain("ghp_averyrealsecrettoken");
    }),
  );

  it.effect("records an upstream failure as fail, with the upstream's own code", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      yield* executor.execute(addr("missing"), {});

      const [call] = yield* executor.toolCalls.list();
      expect(call?.outcome).toBe("fail");
      expect(call?.errorCode).toBe("http_error");
    }),
  );

  it.effect("records a call a policy blocked — the one that leaves no other trace", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      yield* executor.policies.create({ owner: "org", pattern: "github.*.*.get", action: "block" });
      yield* Effect.result(executor.execute(addr("get"), {}));

      const [call] = yield* executor.toolCalls.list();
      expect(call?.outcome).toBe("blocked");
      expect(call?.errorCode).toBe("tool_blocked");
      expect(call?.policyAction).toBe("block");
      expect(call?.policyPattern).toBe("github.*.*.get");
    }),
  );

  it.effect("records an approval the caller declined", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      yield* Effect.result(
        executor.execute(addr("delete"), {}, { onElicitation: decliningHandler }),
      );

      const [call] = yield* executor.toolCalls.list();
      expect(call?.outcome).toBe("declined");
      expect(call?.errorCode).toBe("approval_declined");
    }),
  );

  it.effect("records a call to a tool that does not exist", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      yield* Effect.result(executor.execute(addr("nope"), {}));

      const [call] = yield* executor.toolCalls.list();
      expect(call?.outcome).toBe("error");
      expect(call?.errorCode).toBe("ToolNotFoundError");
    }),
  );

  it.effect("lists newest first and filters by integration, outcome and limit", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      yield* executor.execute(addr("get"), {});
      yield* executor.execute(addr("missing"), {});
      yield* executor.execute(addr("get"), {});

      const all = yield* executor.toolCalls.list();
      expect(all).toHaveLength(3);

      const failures = yield* executor.toolCalls.list({ outcome: "fail" });
      expect(failures).toHaveLength(1);
      expect(failures[0]?.tool).toBe("missing");

      const byIntegration = yield* executor.toolCalls.list({ integration: "github" });
      expect(byIntegration).toHaveLength(3);
      expect(yield* executor.toolCalls.list({ integration: "gsc" })).toEqual([]);

      const limited = yield* executor.toolCalls.list({ limit: 2 });
      expect(limited).toHaveLength(2);
    }),
  );
});
