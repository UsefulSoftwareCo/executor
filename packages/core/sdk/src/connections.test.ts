import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Result } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  ToolAddress,
  ToolName,
} from "./ids";
import { definePlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { makeTestExecutor } from "./testing";

// removed: v1 connection-refresh lifecycle, ConnectionProvider.refresh,
// SecretProvider, accessToken token-refresh + in-flight dedup tests — the v2
// model folds secret/connection into one provider-resolved Connection, and OAuth
// refresh is core's responsibility (stubbed for milestone 1). The cases below
// cover the v2 connection surface: create (inline + external), list, get,
// remove, refresh, and per-connection tool production.

const memoryProvider = (): CredentialProvider => {
  const store = new Map<string, string>();
  return {
    key: ProviderKey.make("memory"),
    writable: true,
    get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id, value) => Effect.sync(() => void store.set(String(id), value)),
    has: (id) => Effect.sync(() => store.has(String(id))),
    list: () =>
      Effect.sync(() =>
        Array.from(store.keys()).map((key) => ({
          id: ProviderItemId.make(key),
          name: key,
        })),
      ),
  };
};

const INTEG = IntegrationSlug.make("vercel");
const TEMPLATE = AuthTemplateSlug.make("apiKey");

const demoPlugin = definePlugin(() => ({
  id: "demo" as const,
  credentialProviders: [memoryProvider()],
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({
      tools: [
        { name: ToolName.make("deploy"), description: "deploy" },
        { name: ToolName.make("list"), description: "list" },
      ],
    }),
  invokeTool: ({ toolRow, credential }) =>
    Effect.succeed({ ran: toolRow.name, value: credential.value }),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: INTEG,
        description: "Vercel",
        config: {},
      }),
    resolveValue: (owner: "org" | "user", name: string) =>
      ctx.connections.resolveValue({
        owner,
        integration: INTEG,
        name: ConnectionName.make(name),
      }),
  }),
}))();

const setup = () =>
  makeTestExecutor({ plugins: [demoPlugin] as const }).pipe(
    Effect.tap((executor) => executor.demo.seed()),
  );

describe("connections.create", () => {
  it.effect("inline value writes to the default writable provider and produces tools", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      const connection = yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: INTEG,
        template: TEMPLATE,
        value: "secret-token",
      });
      expect(connection.provider).toBe(ProviderKey.make("memory"));
      expect(String(connection.address)).toBe("tools.vercel.org.main");

      const tools = yield* executor.tools.list();
      expect(tools.map((t) => String(t.name)).sort()).toEqual(["deploy", "list"]);

      // The inline value is resolvable via the connection's provider.
      const value = yield* executor.demo.resolveValue("org", "main");
      expect(value).toBe("secret-token");
    }),
  );

  it.effect("normalizes free-form names into JS-callable connection identifiers", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      const connection = yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("my-api-key"),
        integration: INTEG,
        template: TEMPLATE,
        value: "secret-token",
      });

      expect(String(connection.name)).toBe("myApiKey");
      expect(String(connection.address)).toBe("tools.vercel.org.myApiKey");

      const tools = yield* executor.tools.list();
      expect(tools.map((t) => String(t.address)).sort()).toEqual([
        "tools.vercel.org.myApiKey.deploy",
        "tools.vercel.org.myApiKey.list",
      ]);

      const value = yield* executor.demo.resolveValue("org", "myApiKey");
      expect(value).toBe("secret-token");
    }),
  );

  it.effect("external `from` references a provider item without writing it", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      const connection = yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("byo"),
        integration: INTEG,
        template: TEMPLATE,
        from: {
          provider: ProviderKey.make("memory"),
          id: ProviderItemId.make("ext-item"),
        },
      });
      expect(connection.provider).toBe(ProviderKey.make("memory"));
      // No value was stored (external reference) — resolveValue returns null.
      const value = yield* executor.demo.resolveValue("org", "byo");
      expect(value).toBeNull();
    }),
  );

  it.effect("create on an unknown integration fails with IntegrationNotFoundError", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      const result = yield* Effect.result(
        executor.connections.create({
          owner: "org",
          name: ConnectionName.make("x"),
          integration: IntegrationSlug.make("unknown"),
          template: TEMPLATE,
          value: "v",
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("IntegrationNotFoundError")(result.failure)).toBe(true);
    }),
  );

  // A credentialed connection is "born wired": it must reference at least one
  // credential input. An empty binding (an empty `values`/`inputs` map) produces
  // a credential with no credential — it persists, produces a full tool catalog,
  // and then fails every invocation with `connection_value_missing`. These cases
  // must be rejected at create with a typed `InvalidConnectionInputError` (the
  // HTTP edge answers 400 with the reason, not an opaque 500). The exception is
  // the no-auth template ("none"), where zero inputs and an empty `item_ids`
  // map are the canonical shape — covered below. (An empty-STRING value is also
  // allowed, and an external `from` that resolves to null is a supported case —
  // both covered by their own tests.)
  it.effect("rejects an empty `values` map on a credentialed template and persists nothing", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      const result = yield* Effect.result(
        executor.connections.create({
          owner: "org",
          name: ConnectionName.make("empty"),
          integration: INTEG,
          template: TEMPLATE,
          values: {},
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("InvalidConnectionInputError")(result.failure)).toBe(true);
      // No connection row and — critically — no tools were produced.
      expect(yield* executor.connections.list()).toEqual([]);
      expect(yield* executor.tools.list()).toEqual([]);
    }),
  );

  it.effect("rejects an empty `inputs` map on a credentialed template", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      const result = yield* Effect.result(
        executor.connections.create({
          owner: "org",
          name: ConnectionName.make("empty2"),
          integration: INTEG,
          template: TEMPLATE,
          inputs: {},
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("InvalidConnectionInputError")(result.failure)).toBe(true);
      expect(yield* executor.connections.list()).toEqual([]);
    }),
  );

  // The no-auth template: public servers need no credential. The UI submits
  // `values: {}` for them and the persisted row carries an empty `item_ids`
  // map — that is the canonical shape (every migrated no-auth connection in
  // prod has it), so it must create cleanly and keep its tools on refresh.
  it.effect('creates a no-auth (`template: "none"`) connection from an empty `values` map', () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      const connection = yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("public"),
        integration: INTEG,
        template: AuthTemplateSlug.make("none"),
        values: {},
      });
      expect(String(connection.address)).toBe("tools.vercel.org.public");

      const tools = yield* executor.tools.list();
      expect(tools.map((t) => String(t.name)).sort()).toEqual(["deploy", "list"]);

      // Refresh must NOT treat the empty binding as invalid and wipe the tools.
      const refreshed = yield* executor.connections.refresh({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("public"),
      });
      expect(refreshed.map((t) => String(t.name)).sort()).toEqual(["deploy", "list"]);
      expect((yield* executor.tools.list()).length).toBe(2);
    }),
  );

  it.effect("allows an empty-string value (no-auth integrations bind one)", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      const connection = yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("noauth"),
        integration: INTEG,
        template: TEMPLATE,
        value: "",
      });
      // The binding exists (non-empty item_ids), so tools are produced; the
      // empty value itself is the integration's concern, surfaced at invoke.
      expect(String(connection.address)).toBe("tools.vercel.org.noauth");
      const tools = yield* executor.tools.list();
      expect(tools.map((t) => String(t.name)).sort()).toEqual(["deploy", "list"]);
    }),
  );
});

describe("connections.list / get", () => {
  it.effect("lists created connections and filters by integration", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("a"),
        integration: INTEG,
        template: TEMPLATE,
        value: "v",
      });
      const all = yield* executor.connections.list();
      expect(all.map((c) => String(c.name))).toEqual(["a"]);
      const filtered = yield* executor.connections.list({ integration: INTEG });
      expect(filtered.length).toBe(1);
      const get = yield* executor.connections.get({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("a"),
      });
      expect(get?.name).toBe(ConnectionName.make("a"));
    }),
  );

  it.effect("get returns null for an unknown connection", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      const get = yield* executor.connections.get({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("missing"),
      });
      expect(get).toBeNull();
    }),
  );
});

describe("connections.remove", () => {
  it.effect("removes the connection and its tools", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: INTEG,
        template: TEMPLATE,
        value: "v",
      });
      yield* executor.connections.remove({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("main"),
      });
      const connections = yield* executor.connections.list();
      expect(connections).toEqual([]);
      const tools = yield* executor.tools.list();
      expect(tools).toEqual([]);
    }),
  );

  it.effect("remove on an unknown connection fails with ConnectionNotFoundError", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      const result = yield* Effect.result(
        executor.connections.remove({
          owner: "org",
          integration: INTEG,
          name: ConnectionName.make("missing"),
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("ConnectionNotFoundError")(result.failure)).toBe(true);
    }),
  );
});

describe("connections.refresh", () => {
  it.effect("re-produces the connection's tools", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: INTEG,
        template: TEMPLATE,
        value: "v",
      });
      const tools = yield* executor.connections.refresh({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("main"),
      });
      expect(tools.map((t) => String(t.name)).sort()).toEqual(["deploy", "list"]);
    }),
  );
});

describe("execute over a connection", () => {
  it.effect("resolves the credential value and hands it to invokeTool", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: INTEG,
        template: TEMPLATE,
        value: "secret-token",
      });
      const out = yield* executor.execute(ToolAddress.make("tools.vercel.org.main.deploy"), {});
      expect(out).toEqual({ ran: "deploy", value: "secret-token" });
    }),
  );
});
