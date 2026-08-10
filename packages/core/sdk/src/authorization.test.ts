import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Predicate, Result, Schema } from "effect";

import type {
  AuthorizationDecision,
  AuthorizationProvider,
  AuthorizationRequest,
} from "./authorization";
import { ElicitationResponse, type ElicitationHandler } from "./elicitation";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  ToolAddress,
  ToolName,
} from "./ids";
import { definePlugin, tool } from "./plugin";
import type { CredentialProvider } from "./provider";
import { makeTestExecutor } from "./testing";

const VERCEL = IntegrationSlug.make("vercel");
const TEMPLATE = AuthTemplateSlug.make("apiKey");
const CONN = ConnectionName.make("main");

const addr = (tool: string): ToolAddress => ToolAddress.make(`tools.${VERCEL}.org.${CONN}.${tool}`);

const decision = (
  outcome: AuthorizationDecision["outcome"],
  overrides?: Partial<AuthorizationDecision>,
): AuthorizationDecision => ({
  outcome,
  decisionId: overrides?.decisionId ?? "dec-1",
  policyRevision: overrides?.policyRevision ?? "rev-1",
  reason: overrides?.reason ?? `outcome=${outcome}`,
  obligations: overrides?.obligations,
});

const recordingProvider = (
  outcomes:
    | AuthorizationDecision["outcome"]
    | ((req: AuthorizationRequest) => AuthorizationDecision),
  seen: AuthorizationRequest[],
): AuthorizationProvider => ({
  authorize: (request) =>
    Effect.sync(() => {
      seen.push(request);
      return typeof outcomes === "function" ? outcomes(request) : decision(outcomes);
    }),
});

class FailingAuthorizationProviderError extends Data.TaggedError(
  "FailingAuthorizationProviderError",
)<{
  readonly message: string;
}> {}

const failingProvider = (message: string): AuthorizationProvider => ({
  authorize: () => Effect.fail(new FailingAuthorizationProviderError({ message })),
});

/** Credential get that records whether resolution ran. */
const gatedCredentialProvider = (resolved: { count: number }): CredentialProvider => {
  const store = new Map<string, string>([["item", "secret-value"]]);
  return {
    key: ProviderKey.make("memory"),
    writable: true,
    get: (id) =>
      Effect.sync(() => {
        resolved.count++;
        return store.get(String(id)) ?? null;
      }),
    set: (id, value) => Effect.sync(() => void store.set(String(id), value)),
  };
};

const memoryProvider = (): CredentialProvider => {
  const store = new Map<string, string>();
  return {
    key: ProviderKey.make("memory"),
    writable: true,
    get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id, value) => Effect.sync(() => void store.set(String(id), value)),
  };
};

const makeAuthzPlugin = (options?: {
  readonly credentialProvider?: CredentialProvider;
  /** When set, only the named outer tool re-enters via `ctx.execute`. */
  readonly nested?: { readonly outer: string; readonly target: ToolAddress };
  readonly invokeCount?: { count: number };
}) => {
  const credentials = options?.credentialProvider ?? memoryProvider();
  const invokeCount = options?.invokeCount ?? { count: 0 };
  return definePlugin(() => ({
    id: "authz-fixture" as const,
    storage: () => ({}),
    credentialProviders: [credentials],
    resolveTools: () =>
      Effect.succeed({
        tools: [
          { name: ToolName.make("deploy"), description: "deploy" },
          { name: ToolName.make("delete"), description: "delete" },
        ],
      }),
    invokeTool: ({ toolRow, ctx, args }) =>
      Effect.gen(function* () {
        invokeCount.count++;
        if (options?.nested && toolRow.name === options.nested.outer) {
          // Nested re-entry through the same core execute seam.
          const nested = yield* ctx.execute(options.nested.target, args);
          return { ran: toolRow.name, nested };
        }
        return { ran: `${toolRow.integration}.${toolRow.name}` };
      }),
    extension: (ctx) => ({
      seed: () =>
        ctx.core.integrations.register({
          slug: VERCEL,
          description: "Vercel",
          config: {},
        }),
    }),
  }));
};

const seedConnection = (
  executor: {
    readonly ["authz-fixture"]: { readonly seed: () => Effect.Effect<unknown, unknown> };
    readonly connections: {
      readonly create: (input: {
        readonly owner: "org";
        readonly name: ConnectionName;
        readonly integration: IntegrationSlug;
        readonly template: AuthTemplateSlug;
        readonly from: { readonly provider: ProviderKey; readonly id: ProviderItemId };
      }) => Effect.Effect<unknown, unknown>;
    };
  },
  itemId = "item",
) =>
  Effect.gen(function* () {
    yield* executor["authz-fixture"].seed();
    yield* executor.connections.create({
      owner: "org",
      name: CONN,
      integration: VERCEL,
      template: TEMPLATE,
      from: {
        provider: ProviderKey.make("memory"),
        id: ProviderItemId.make(itemId),
      },
    });
  });

const recordingHandler = (calls: { count: number }): ElicitationHandler =>
  (() => {
    calls.count++;
    return Effect.succeed(ElicitationResponse.make({ action: "accept" }));
  }) as ElicitationHandler;

describe("AuthorizationProvider seam", () => {
  it.effect("absent provider preserves current allow behavior", () =>
    Effect.gen(function* () {
      const invokeCount = { count: 0 };
      const executor = yield* makeTestExecutor({
        plugins: [makeAuthzPlugin({ invokeCount })()] as const,
      });
      yield* seedConnection(executor);
      const result = yield* executor.execute(addr("deploy"), { x: 1 });
      expect(result).toEqual({ ran: "vercel.deploy" });
      expect(invokeCount.count).toBe(1);
    }),
  );

  it.effect("identity is executor-bound, not caller-controlled via args", () =>
    Effect.gen(function* () {
      const seen: AuthorizationRequest[] = [];
      const executor = yield* makeTestExecutor({
        tenant: "bound-tenant",
        subject: "bound-subject",
        authorizationProvider: recordingProvider("allow", seen),
        plugins: [makeAuthzPlugin()()] as const,
      });
      yield* seedConnection(executor);

      yield* executor.execute(addr("deploy"), {
        tenant: "attacker-tenant",
        subject: "attacker-subject",
        identity: { tenant: "nope", subject: "nope" },
      });

      expect(seen).toHaveLength(1);
      expect(String(seen[0]!.identity.tenant)).toBe("bound-tenant");
      expect(String(seen[0]!.identity.subject)).toBe("bound-subject");
      expect(seen[0]!.operation).toBe("tool.execute");
      expect(seen[0]!.tool.integration).toBe("vercel");
      expect(seen[0]!.tool.owner).toBe("org");
      expect(seen[0]!.tool.connection).toBe("main");
      expect(seen[0]!.tool.plugin).toBe("authz-fixture");
      expect(seen[0]!.tool.name).toBe("deploy");
      expect(seen[0]!.args).toEqual({
        tenant: "attacker-tenant",
        subject: "attacker-subject",
        identity: { tenant: "nope", subject: "nope" },
      });
    }),
  );

  it.effect("deny fails closed before credential resolution", () =>
    Effect.gen(function* () {
      const resolved = { count: 0 };
      const invokeCount = { count: 0 };
      const seen: AuthorizationRequest[] = [];
      const executor = yield* makeTestExecutor({
        authorizationProvider: recordingProvider("deny", seen),
        plugins: [
          makeAuthzPlugin({
            credentialProvider: gatedCredentialProvider(resolved),
            invokeCount,
          })(),
        ] as const,
      });
      yield* seedConnection(executor);

      // Seed may touch credential storage for connection create; reset after setup.
      resolved.count = 0;
      invokeCount.count = 0;

      const result = yield* Effect.result(
        executor.execute(addr("deploy"), {}, { onElicitation: "accept-all" }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("AuthorizationDeniedError")(result.failure)).toBe(true);
      expect(seen).toHaveLength(1);
      expect(resolved.count).toBe(0);
      expect(invokeCount.count).toBe(0);
    }),
  );

  it.effect("provider allow cannot weaken an existing hard block", () =>
    Effect.gen(function* () {
      const resolved = { count: 0 };
      const invokeCount = { count: 0 };
      const seen: AuthorizationRequest[] = [];
      const executor = yield* makeTestExecutor({
        authorizationProvider: recordingProvider("allow", seen),
        plugins: [
          makeAuthzPlugin({
            credentialProvider: gatedCredentialProvider(resolved),
            invokeCount,
          })(),
        ] as const,
      });
      yield* seedConnection(executor);
      yield* executor.policies.create({
        owner: "org",
        pattern: "vercel.org.main.deploy",
        action: "block",
      });
      resolved.count = 0;
      invokeCount.count = 0;

      const result = yield* Effect.result(
        executor.execute(addr("deploy"), {}, { onElicitation: "accept-all" }),
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(seen).toHaveLength(0);
      expect(resolved.count).toBe(0);
      expect(invokeCount.count).toBe(0);
    }),
  );

  it.effect("provider allow cannot weaken an existing approval requirement", () =>
    Effect.gen(function* () {
      const seen: AuthorizationRequest[] = [];
      const calls = { count: 0 };
      const invokeCount = { count: 0 };
      const executor = yield* makeTestExecutor({
        authorizationProvider: recordingProvider("allow", seen),
        plugins: [makeAuthzPlugin({ invokeCount })()] as const,
      });
      yield* seedConnection(executor);
      yield* executor.policies.create({
        owner: "org",
        pattern: "vercel.org.main.deploy",
        action: "require_approval",
      });

      const result = yield* executor.execute(
        addr("deploy"),
        {},
        { onElicitation: recordingHandler(calls) },
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]!.policy.action).toBe("require_approval");
      expect(calls.count).toBe(1);
      expect(result).toEqual({ ran: "vercel.deploy" });
      expect(invokeCount.count).toBe(1);
    }),
  );

  it.effect("require_approval feeds existing elicitation path", () =>
    Effect.gen(function* () {
      const seen: AuthorizationRequest[] = [];
      const calls = { count: 0 };
      const invokeCount = { count: 0 };
      const executor = yield* makeTestExecutor({
        authorizationProvider: recordingProvider("require_approval", seen),
        plugins: [makeAuthzPlugin({ invokeCount })()] as const,
      });
      yield* seedConnection(executor);

      const result = yield* executor.execute(
        addr("deploy"),
        {},
        { onElicitation: recordingHandler(calls) },
      );
      expect(calls.count).toBe(1);
      expect(result).toEqual({ ran: "vercel.deploy" });
      expect(invokeCount.count).toBe(1);
      expect(seen).toHaveLength(1);
    }),
  );

  it.effect("require_approval declined does not invoke and cannot bypass deny", () =>
    Effect.gen(function* () {
      const invokeCount = { count: 0 };
      // Deny is absolute: a provider that denies never reaches elicitation.
      const denyExecutor = yield* makeTestExecutor({
        authorizationProvider: recordingProvider("deny", []),
        plugins: [makeAuthzPlugin({ invokeCount })()] as const,
      });
      yield* seedConnection(denyExecutor);
      const denied = yield* Effect.result(
        denyExecutor.execute(
          addr("deploy"),
          {},
          {
            onElicitation: () => Effect.succeed(ElicitationResponse.make({ action: "accept" })),
          },
        ),
      );
      expect(Result.isFailure(denied)).toBe(true);
      if (!Result.isFailure(denied)) return;
      expect(Predicate.isTagged("AuthorizationDeniedError")(denied.failure)).toBe(true);
      expect(invokeCount.count).toBe(0);

      // require_approval + decline still fails closed via elicitation.
      const approveCalls = { count: 0 };
      const reqExecutor = yield* makeTestExecutor({
        authorizationProvider: recordingProvider("require_approval", []),
        plugins: [makeAuthzPlugin({ invokeCount })()] as const,
      });
      yield* seedConnection(reqExecutor);
      const declined = yield* Effect.result(
        reqExecutor.execute(
          addr("deploy"),
          {},
          {
            onElicitation: () => {
              approveCalls.count++;
              return Effect.succeed(ElicitationResponse.make({ action: "decline" }));
            },
          },
        ),
      );
      expect(Result.isFailure(declined)).toBe(true);
      if (!Result.isFailure(declined)) return;
      expect(Predicate.isTagged("ElicitationDeclinedError")(declined.failure)).toBe(true);
      expect(approveCalls.count).toBe(1);
      expect(invokeCount.count).toBe(0);
    }),
  );

  it.effect("nested ctx.execute re-enters the authorization seam", () =>
    Effect.gen(function* () {
      const seen: AuthorizationRequest[] = [];
      const outer = addr("deploy");
      const inner = addr("delete");
      const executor = yield* makeTestExecutor({
        authorizationProvider: recordingProvider("allow", seen),
        plugins: [makeAuthzPlugin({ nested: { outer: "deploy", target: inner } })()] as const,
      });
      yield* seedConnection(executor);

      const result = yield* executor.execute(outer, { nested: true });
      expect(result).toEqual({
        ran: "deploy",
        nested: { ran: "vercel.delete" },
      });
      expect(seen.map((r) => r.tool.name)).toEqual(["deploy", "delete"]);
      expect(seen.every((r) => r.operation === "tool.execute")).toBe(true);
    }),
  );

  it.effect("provider failure fails closed without invoke", () =>
    Effect.gen(function* () {
      const invokeCount = { count: 0 };
      const resolved = { count: 0 };
      const executor = yield* makeTestExecutor({
        authorizationProvider: failingProvider("upstream policy unavailable"),
        plugins: [
          makeAuthzPlugin({
            credentialProvider: gatedCredentialProvider(resolved),
            invokeCount,
          })(),
        ] as const,
      });
      yield* seedConnection(executor);
      resolved.count = 0;
      invokeCount.count = 0;

      const result = yield* Effect.result(executor.execute(addr("deploy"), {}));
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("AuthorizationProviderError")(result.failure)).toBe(true);
      expect(resolved.count).toBe(0);
      expect(invokeCount.count).toBe(0);
    }),
  );

  it.effect("static tools also consult the provider", () =>
    Effect.gen(function* () {
      const seen: AuthorizationRequest[] = [];
      const staticPlugin = definePlugin(() => ({
        id: "static-authz" as const,
        storage: () => ({}),
        staticIntegrations: () => [
          {
            id: "static-authz.ctl",
            kind: "control" as const,
            name: "Static Authz",
            tools: [
              tool({
                name: "ping",
                description: "ping",
                inputSchema: Schema.toStandardSchemaV1(
                  Schema.toStandardJSONSchemaV1(Schema.Struct({})),
                ),
                execute: () => Effect.succeed("pong"),
              }),
            ],
          },
        ],
      }))();

      const allowExecutor = yield* makeTestExecutor({
        authorizationProvider: recordingProvider("allow", seen),
        plugins: [staticPlugin] as const,
      });
      const allowed = yield* allowExecutor.execute(ToolAddress.make("static-authz.ctl.ping"), {});
      expect(allowed).toBe("pong");
      expect(seen).toHaveLength(1);
      expect(seen[0]!.tool.plugin).toBe("static-authz");
      expect(seen[0]!.tool.name).toBe("ping");

      const denyExecutor = yield* makeTestExecutor({
        authorizationProvider: recordingProvider("deny", []),
        plugins: [staticPlugin] as const,
      });
      const denied = yield* Effect.result(
        denyExecutor.execute(ToolAddress.make("static-authz.ctl.ping"), {}),
      );
      expect(Result.isFailure(denied)).toBe(true);
      if (!Result.isFailure(denied)) return;
      expect(Predicate.isTagged("AuthorizationDeniedError")(denied.failure)).toBe(true);
    }),
  );
});
