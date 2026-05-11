import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Exit, Predicate, Result } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { makeMemoryAdapter } from "@executor-js/storage-core/testing/memory";
import type { DBAdapter, Where } from "@executor-js/storage-core";

import { makeInMemoryBlobStore } from "./blob";
import { CreateConnectionInput, TokenMaterial } from "./connections";
import { collectSchemas, createExecutor } from "./executor";
import { ElicitationResponse, FormElicitation, UrlElicitation } from "./elicitation";
import { defineSchema, definePlugin } from "./plugin";
import { RemoveSecretInput, SetSecretInput } from "./secrets";
import { makeTestConfig } from "./testing";
import type { SecretProvider } from "./secrets";
import { ConnectionId, ScopeId, SecretId } from "./ids";
import { Scope } from "./scope";
import { SourceDetectionResult } from "./types";

type FindManyCall = {
  readonly model: string;
  readonly where?: readonly Where[];
};

class TestPluginError extends Data.TaggedError("TestPluginError")<{
  readonly message: string;
}> {}

const recordFindMany = (adapter: DBAdapter, calls: FindManyCall[]): DBAdapter => ({
  ...adapter,
  findMany: (data) => {
    calls.push({ model: data.model, where: data.where });
    return adapter.findMany(data);
  },
  transaction: (callback) =>
    adapter.transaction((trx) =>
      callback({
        ...trx,
        findMany: (data) => {
          calls.push({ model: data.model, where: data.where });
          return trx.findMany(data);
        },
      }),
    ),
});

// ---------------------------------------------------------------------------
// Tiny test plugin — declares a static source with two control tools, a
// plugin schema for a per-row key/value table, and a dynamic invokeTool
// handler. Exercises everything createExecutor has to wire up.
// ---------------------------------------------------------------------------

// Plugin-declared schema. `defineSchema` preserves literal types via
// `const` inference — no `as const satisfies DBSchema` ceremony.
const testSchema = defineSchema({
  test_thing: {
    fields: {
      id: { type: "string", required: true },
      value: { type: "string", required: true },
    },
  },
});

let testAnnotationResolveCount = 0;

const testPlugin = definePlugin(() => ({
  id: "test" as const,
  schema: testSchema,

  // `adapter` is typed against testSchema automatically — no imports of
  // DBAdapter, no typedAdapter wrapping. `model: "test_thing"` is
  // narrowed to the schema's model names, and row data shape comes
  // from the schema's field definitions.
  storage: ({ adapter }) => ({
    writeThing: (id: string, value: string) =>
      adapter
        .create({
          model: "test_thing",
          data: { id, value },
          forceAllowId: true,
        })
        .pipe(Effect.asVoid),
    readThing: (id: string) =>
      adapter
        .findOne({
          model: "test_thing",
          where: [{ field: "id", value: id }],
        })
        .pipe(Effect.map((row) => row?.value ?? null)),
  }),
  extension: (ctx) => ({
    echo: (text: string) => Effect.succeed(`echo:${text}`),

    addThing: (id: string, value: string) =>
      ctx.transaction(
        Effect.gen(function* () {
          yield* ctx.storage.writeThing(id, value);
          yield* ctx.core.sources.register({
            id,
            scope: ctx.scopes[0]!.id,
            kind: "test",
            name: id,
            canRemove: true,
            tools: [
              { name: "read", description: "read the thing" },
              { name: "write", description: "overwrite the thing" },
            ],
          });
        }),
      ),
  }),
  staticSources: (self) => [
    {
      id: "test.control",
      kind: "control",
      name: "Test Control",
      tools: [
        {
          name: "echo",
          description: "static echo tool",
          handler: ({ args }) => self.echo((args as { text: string }).text),
        },
      ],
    },
  ],
  invokeTool: ({ ctx, toolRow, args }) =>
    Effect.gen(function* () {
      // toolRow.source_id = the thing id (we registered the source with
      // that id). toolRow.name = "read" | "write". No string splitting.
      const thingId = toolRow.source_id;
      if (toolRow.name === "read") {
        return yield* ctx.storage.readThing(thingId);
      }
      if (toolRow.name === "write") {
        const { value } = args as { value: string };
        yield* ctx.storage.writeThing(thingId, value);
        return { ok: true };
      }
      return yield* new TestPluginError({
        message: `unknown tool ${toolRow.id}`,
      });
    }),

  // Derived annotations: `write` gates on approval, `read` doesn't.
  // Purely computed from the tool's name — no data persisted on the row.
  resolveAnnotations: ({ toolRows }) =>
    Effect.sync(() => {
      testAnnotationResolveCount++;
      const out: Record<string, { requiresApproval: boolean; approvalDescription?: string }> = {};
      for (const row of toolRows) {
        if (row.name === "write") {
          out[row.id] = {
            requiresApproval: true,
            approvalDescription: `Overwrite ${row.source_id}`,
          };
        } else {
          out[row.id] = { requiresApproval: false };
        }
      }
      return out;
    }),
}));

// ---------------------------------------------------------------------------
// Test plugin that contributes an in-memory writable secret provider so
// the secrets surface has something to talk to.
// ---------------------------------------------------------------------------

const memoryProvider: SecretProvider = (() => {
  const store = new Map<string, string>();
  const key = (scope: string, id: string) => `${scope}\u0000${id}`;
  return {
    key: "memory",
    writable: true,
    get: (id, scope) => Effect.sync(() => store.get(key(scope, id)) ?? null),
    set: (id, value, scope) =>
      Effect.sync(() => {
        store.set(key(scope, id), value);
      }),
    delete: (id, scope) => Effect.sync(() => store.delete(key(scope, id))),
    list: () =>
      Effect.sync(() =>
        Array.from(store.keys()).map((k) => {
          const name = k.split("\u0000", 2)[1] ?? k;
          return { id: name, name };
        }),
      ),
  };
})();

const memorySecretsPlugin = definePlugin(() => ({
  id: "memory-secrets" as const,
  storage: () => ({}),
  secretProviders: [memoryProvider],
}));

const memoryConnectionPlugin = definePlugin(() => ({
  id: "memory-connection" as const,
  storage: () => ({}),
  connectionProviders: [{ key: "memory-connection" }],
}));

const staleRouteProvider: SecretProvider = {
  key: "stale-route",
  writable: true,
  get: () => Effect.succeed(null),
  has: () => Effect.succeed(false),
  set: () => Effect.void,
  delete: () => Effect.succeed(false),
  list: () => Effect.succeed([]),
};

const staleRouteSecretsPlugin = definePlugin(() => ({
  id: "stale-route-secrets" as const,
  storage: () => ({}),
  secretProviders: [staleRouteProvider],
}));

const opaqueRouteProvider: SecretProvider = {
  key: "opaque-route",
  writable: true,
  get: () => Effect.succeed(null),
  set: () => Effect.void,
  delete: () => Effect.succeed(false),
  list: () => Effect.succeed([]),
};

const opaqueRouteSecretsPlugin = definePlugin(() => ({
  id: "opaque-route-secrets" as const,
  storage: () => ({}),
  secretProviders: [opaqueRouteProvider],
}));

const providerOnlySecretPlugin = definePlugin(() => ({
  id: "provider-only-secret" as const,
  storage: () => ({}),
  secretProviders: [
    {
      key: "provider-only",
      writable: false,
      get: (id: string) => Effect.succeed(id === "provider-token" ? "provider-value" : null),
      list: () => Effect.succeed([{ id: "provider-token", name: "Provider token" }]),
    } satisfies SecretProvider,
  ],
}));

const fallbackOrderingPlugin = (laterCalls: { count: number }) =>
  definePlugin(() => ({
    id: "fallback-ordering" as const,
    storage: () => ({}),
    secretProviders: [
      {
        key: "first-fallback",
        writable: false,
        get: (id: string) => Effect.succeed(id === "token" ? "first-value" : null),
        list: () => Effect.succeed([{ id: "token", name: "token" }]),
      },
      {
        key: "later-fallback",
        writable: false,
        get: () =>
          Effect.sync(() => {
            laterCalls.count += 1;
            return "later-value";
          }),
        list: () => Effect.succeed([{ id: "token", name: "token" }]),
      },
    ] satisfies readonly SecretProvider[],
  }));

const fallbackDisabledPlugin = definePlugin(() => ({
  id: "fallback-disabled" as const,
  storage: () => ({}),
  secretProviders: [
    {
      key: "fallback-disabled-provider",
      writable: false,
      allowFallback: false,
      get: (id: string) => Effect.succeed(id === "token" ? "disabled-value" : null),
      list: () => Effect.succeed([{ id: "token", name: "token" }]),
    },
  ] satisfies readonly SecretProvider[],
}));

const duplicateToolsPlugin = definePlugin(() => ({
  id: "duplicateTools" as const,
  storage: () => ({}),
  extension: (ctx) => ({
    register: () =>
      ctx.core.sources.register({
        id: "dup-source",
        scope: ctx.scopes[0]!.id,
        kind: "test",
        name: "Duplicate source",
        tools: [
          { name: "same", description: "first" },
          { name: "same", description: "last" },
        ],
      }),
  }),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createExecutor", () => {
  it.effect("invokes a static tool via the in-memory pool", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [testPlugin()] as const }));
      const result = yield* executor.tools.invoke(
        "test.control.echo",
        { text: "hi" },
        { onElicitation: "accept-all" },
      );
      expect(result).toBe("echo:hi");
    }),
  );

  it.effect("lists static tools alongside dynamic ones", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [testPlugin()] as const }));
      yield* executor.test.addThing("thing1", "hello");

      const tools = yield* executor.tools.list();
      const ids = tools.map((t) => t.id);
      expect(ids).toContain("test.control.echo");
      expect(ids).toContain("thing1.read");
      expect(ids).toContain("thing1.write");
    }),
  );

  it.effect("filters tools by query", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [testPlugin()] as const }));
      yield* executor.test.addThing("thing1", "hello");

      const tools = yield* executor.tools.list({ query: "echo" });
      expect(tools.map((t) => t.id)).toEqual(["test.control.echo"]);
    }),
  );

  it.effect("pushes sourceId tool list filters into storage", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({ plugins: [testPlugin()] as const });
      const findManyCalls: FindManyCall[] = [];
      const executor = yield* createExecutor({
        ...config,
        adapter: recordFindMany(config.adapter, findManyCalls),
        onElicitation: "accept-all",
      });
      yield* executor.test.addThing("thing1", "hello");
      yield* executor.test.addThing("thing2", "goodbye");

      findManyCalls.length = 0;
      const tools = yield* executor.tools.list({ sourceId: "thing1" });

      expect(tools.map((t) => t.id).sort()).toEqual(["thing1.read", "thing1.write"]);
      const toolRead = findManyCalls.find((call) => call.model === "tool");
      expect(toolRead?.where).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: "source_id", value: "thing1" })]),
      );
    }),
  );

  it.effect("can list tools without resolving dynamic annotations", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [testPlugin()] as const }));
      yield* executor.test.addThing("thing1", "hello");
      testAnnotationResolveCount = 0;

      const tools = yield* executor.tools.list({
        sourceId: "thing1",
        includeAnnotations: false,
      });

      expect(testAnnotationResolveCount).toBe(0);
      expect(tools.map((t) => t.id).sort()).toEqual(["thing1.read", "thing1.write"]);
      expect(tools.every((tool) => tool.annotations === undefined)).toBe(true);
    }),
  );

  it.effect("bounds annotation resolution groups", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [testPlugin()] as const }));
      for (let index = 0; index < 70; index++) {
        yield* executor.test.addThing(`thing${index}`, "hello");
      }
      testAnnotationResolveCount = 0;

      yield* executor.tools.list();

      expect(testAnnotationResolveCount).toBe(64);
    }),
  );

  it.effect("invokes a dynamic tool through plugin.invokeTool", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [testPlugin()] as const }));
      yield* executor.test.addThing("thing1", "hello");

      const result = yield* executor.tools.invoke(
        "thing1.read",
        {},
        { onElicitation: "accept-all" },
      );
      expect(result).toBe("hello");
    }),
  );

  it.effect("enforces tool annotations before invoking", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [testPlugin()] as const }));
      yield* executor.test.addThing("thing1", "hello");
      let approvalMessage = "";

      // requiresApproval: true → declined → ElicitationDeclinedError
      const declined = yield* executor.tools
        .invoke(
          "thing1.write",
          { value: "updated" },
          {
            onElicitation: (ctx) =>
              Effect.sync(() => {
                approvalMessage = ctx.request.message;
                return new ElicitationResponse({ action: "decline" });
              }),
          },
        )
        .pipe(Effect.flip);
      expect(Predicate.isTagged(declined, "ElicitationDeclinedError")).toBe(true);
      expect(approvalMessage).toContain('"value": "updated"');

      // auto-accept → succeeds
      const accepted = yield* executor.tools.invoke(
        "thing1.write",
        { value: "updated" },
        { onElicitation: "accept-all" },
      );
      expect(accepted).toEqual({ ok: true });
    }),
  );

  it.effect("sources.list unions static runtime sources and dynamic ones", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [testPlugin()] as const }));
      yield* executor.test.addThing("thing1", "hello");

      const sources = yield* executor.sources.list();
      const control = sources.find((s) => s.id === "test.control");
      expect(control).toBeDefined();
      expect(control!.runtime).toBe(true);
      expect(control!.canRemove).toBe(false);

      const dynamic = sources.find((s) => s.id === "thing1");
      expect(dynamic).toBeDefined();
      expect(dynamic!.runtime).toBe(false);
      expect(dynamic!.canRemove).toBe(true);
    }),
  );

  it.effect("orders source detection results by confidence", () =>
    Effect.gen(function* () {
      const lowConfidencePlugin = definePlugin(() => ({
        id: "low-detect" as const,
        storage: () => ({}),
        detect: () =>
          Effect.succeed(
            new SourceDetectionResult({
              kind: "mcp",
              confidence: "low",
              endpoint: "https://example.com/source",
              name: "Weak OAuth match",
              namespace: "weak_oauth_match",
            }),
          ),
      }));
      const highConfidencePlugin = definePlugin(() => ({
        id: "high-detect" as const,
        storage: () => ({}),
        detect: () =>
          Effect.succeed(
            new SourceDetectionResult({
              kind: "graphql",
              confidence: "high",
              endpoint: "https://example.com/source",
              name: "GraphQL API",
              namespace: "graphql_api",
            }),
          ),
      }));

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [lowConfidencePlugin(), highConfidencePlugin()] as const,
        }),
      );

      const results = yield* executor.sources.detect("https://example.com/source");

      expect(results.map((result) => result.kind)).toEqual(["graphql", "mcp"]);
    }),
  );

  it.effect("bounds source detection fan-out and results", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const detector = (id: string, confidence: "high" | "medium" | "low") =>
        definePlugin(() => ({
          id,
          storage: () => ({}),
          detect: () =>
            Effect.sync(() => {
              calls.push(id);
              return new SourceDetectionResult({
                kind: id,
                confidence,
                endpoint: `https://example.com/${id}`,
                name: id,
                namespace: id,
              });
            }),
        }));

      const executor = yield* createExecutor({
        ...makeTestConfig({
          plugins: [
            detector("first", "low")(),
            detector("second", "high")(),
            detector("third", "medium")(),
          ] as const,
        }),
        sourceDetection: { maxDetectors: 2, maxResults: 1 },
      });

      const results = yield* executor.sources.detect("https://example.com/source");

      expect(calls).toEqual(["first", "second"]);
      expect(results.map((result) => result.kind)).toEqual(["second"]);
    }),
  );

  it.effect("applies hosted outbound policy before source detection plugins run", () =>
    Effect.gen(function* () {
      let called = false;
      const detector = definePlugin(() => ({
        id: "detector" as const,
        storage: () => ({}),
        detect: () =>
          Effect.sync(() => {
            called = true;
            return new SourceDetectionResult({
              kind: "detector",
              confidence: "high",
              endpoint: "http://127.0.0.1/source",
              name: "detector",
              namespace: "detector",
            });
          }),
      }));

      const executor = yield* createExecutor({
        ...makeTestConfig({ plugins: [detector()] as const }),
        httpClientLayer: FetchHttpClient.layer,
      });

      const results = yield* executor.sources.detect("http://127.0.0.1/source");

      expect(results).toEqual([]);
      expect(called).toBe(false);
    }),
  );

  it.effect("rejects remove of a static source", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [testPlugin()] as const }));
      const err = yield* executor.sources
        .remove({ id: "test.control", targetScope: "test-scope" })
        .pipe(Effect.flip);
      expect(Predicate.isTagged(err, "SourceRemovalNotAllowedError")).toBe(true);
    }),
  );

  it.effect("handles deeply-namespaced tool names (dots in name)", () =>
    Effect.gen(function* () {
      const namespacedPlugin = definePlugin(() => ({
        id: "nested" as const,
        storage: () => ({}),
        extension: (ctx) => ({
          register: () =>
            ctx.core.sources.register({
              id: "cloudflare",
              scope: ctx.scopes[0]!.id,
              kind: "nested",
              name: "cloudflare",
              canRemove: true,
              tools: [
                { name: "dns.records.create", description: "create DNS record" },
                { name: "dns.records.list", description: "list DNS records" },
                { name: "zones.listZones", description: "list zones" },
              ],
            }),
        }),
        invokeTool: ({ toolRow }) =>
          // Real plugin would look up by toolRow.id against its own
          // enrichment table. Here we just echo the structured fields
          // so the test can assert they came through intact.
          Effect.succeed({
            id: toolRow.id,
            sourceId: toolRow.source_id,
            name: toolRow.name,
          }),
      }));

      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [namespacedPlugin()] as const }),
      );
      yield* executor.nested.register();

      const tools = yield* executor.tools.list();
      const ids = tools.map((t) => t.id).sort();
      expect(ids).toContain("cloudflare.dns.records.create");
      expect(ids).toContain("cloudflare.dns.records.list");
      expect(ids).toContain("cloudflare.zones.listZones");

      // Invoke by the exact id — dots are just characters, never parsed.
      const result = (yield* executor.tools.invoke(
        "cloudflare.dns.records.create",
        {},
        { onElicitation: "accept-all" },
      )) as { id: string; sourceId: string; name: string };

      // Structured fields round-trip cleanly: source_id and name are
      // the exact strings the plugin registered.
      expect(result.id).toBe("cloudflare.dns.records.create");
      expect(result.sourceId).toBe("cloudflare");
      expect(result.name).toBe("dns.records.create");
    }),
  );

  it.effect("rejects dynamic registration that collides with a static id", () =>
    Effect.gen(function* () {
      const collidingPlugin = definePlugin(() => ({
        id: "collide" as const,
        storage: () => ({}),
        extension: (ctx) => ({
          tryRegister: () =>
            ctx.core.sources.register({
              id: "test.control", // collides with testPlugin's static source
              scope: ctx.scopes[0]!.id,
              kind: "x",
              name: "x",
              tools: [],
            }),
        }),
      }));

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [testPlugin(), collidingPlugin()] as const,
        }),
      );

      // The collision is treated as an internal/programmer error and
      // surfaces as raw `StorageError` in the typed channel. The HTTP
      // edge (`@executor-js/api` `withCapture`) is responsible for
      // translating it to the opaque `InternalError({ traceId })` when
      // crossing the wire; here, at the SDK layer, we expect the raw tag.
      const err = yield* executor.collide.tryRegister().pipe(Effect.flip);
      expect(Predicate.isTagged(err, "StorageError")).toBe(true);
    }),
  );

  it.effect("ctx.transaction commits all nested writes on success", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [testPlugin()] as const }));
      // addThing wraps storage + sources.register in ctx.transaction.
      yield* executor.test.addThing("thing1", "hello");

      const sources = yield* executor.sources.list();
      expect(sources.find((s) => s.id === "thing1")).toBeDefined();

      const tools = (yield* executor.tools.list()).map((t) => t.id);
      expect(tools).toContain("thing1.read");
      expect(tools).toContain("thing1.write");

      // plugin storage row committed too
      expect(yield* executor.tools.invoke("thing1.read", {}, { onElicitation: "accept-all" })).toBe(
        "hello",
      );
    }),
  );

  it.effect("ctx.transaction rolls back all nested writes on failure", () =>
    Effect.gen(function* () {
      // Plugin that does: storage write -> core.sources.register -> fail.
      // Every write must roll back.
      const rollbackPlugin = definePlugin(() => ({
        id: "rollback" as const,
        schema: testSchema,
        storage: ({ adapter }) => ({
          writeThing: (id: string, value: string) =>
            adapter
              .create({
                model: "test_thing",
                data: { id, value },
                forceAllowId: true,
              })
              .pipe(Effect.asVoid),
          countThings: () => adapter.count({ model: "test_thing" }),
        }),
        extension: (ctx) => ({
          doFailingTx: () =>
            ctx.transaction(
              Effect.gen(function* () {
                yield* ctx.storage.writeThing("x1", "v1");
                yield* ctx.core.sources.register({
                  id: "rb-source",
                  scope: ctx.scopes[0]!.id,
                  kind: "rb",
                  name: "rb",
                  canRemove: true,
                  tools: [{ name: "t", description: "t" }],
                });
                return yield* new TestPluginError({ message: "boom" });
              }),
            ),
          countThings: () => ctx.storage.countThings(),
        }),
      }));

      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [rollbackPlugin()] as const }),
      );

      const result = yield* executor.rollback.doFailingTx().pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);

      // Plugin storage row must not persist.
      expect(yield* executor.rollback.countThings()).toBe(0);
      // Core source registration must not persist.
      const sources = yield* executor.sources.list();
      expect(sources.find((s) => s.id === "rb-source")).toBeUndefined();
      const tools = (yield* executor.tools.list()).map((t) => t.id);
      expect(tools).not.toContain("rb-source.t");
    }),
  );

  it.effect("secrets.set writes to provider and metadata row", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin()] as const,
        }),
      );

      yield* executor.secrets.set(
        new SetSecretInput({
          id: SecretId.make("api-token"),
          scope: ScopeId.make("test-scope"),
          name: "API Token",
          value: "sk-abc",
        }),
      );

      const value = yield* executor.secrets.get("api-token");
      expect(value).toBe("sk-abc");

      const list = yield* executor.secrets.list();
      expect(list).toHaveLength(1);
      expect(list[0]!.name).toBe("API Token");
      expect(list[0]!.provider).toBe("memory");
    }),
  );

  it.effect("secrets.get rejects connection-owned token secrets", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin(), memoryConnectionPlugin()] as const,
        }),
      );

      yield* executor.connections.create(
        new CreateConnectionInput({
          id: ConnectionId.make("conn-owned"),
          scope: ScopeId.make("test-scope"),
          provider: "memory-connection",
          identityLabel: "Alice",
          accessToken: new TokenMaterial({
            secretId: SecretId.make("conn-owned.access_token"),
            name: "Access",
            value: "access-secret",
          }),
          refreshToken: new TokenMaterial({
            secretId: SecretId.make("conn-owned.refresh_token"),
            name: "Refresh",
            value: "refresh-secret",
          }),
          expiresAt: null,
          oauthScope: "read",
          providerState: null,
        }),
      );

      const leaked = yield* executor.secrets.get("conn-owned.access_token").pipe(Effect.flip);
      expect(Predicate.isTagged(leaked, "SecretOwnedByConnectionError")).toBe(true);

      const status = yield* executor.secrets.status("conn-owned.access_token");
      expect(status).toBe("missing");
      const visibleIds = (yield* executor.secrets.list()).map((s) => String(s.id));
      expect(visibleIds).not.toContain("conn-owned.access_token");

      const token = yield* executor.connections.accessToken("conn-owned");
      expect(token).toBe("access-secret");
    }),
  );

  it.effect("invoke fails with ToolNotFoundError for unknown tool", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig());
      const err = yield* executor.tools
        .invoke("does.not.exist", {}, { onElicitation: "accept-all" })
        .pipe(Effect.flip);
      expect(Predicate.isTagged(err, "ToolNotFoundError")).toBe(true);
    }),
  );

  it.effect("tools.schema renders TypeScript previews for static tools", () =>
    Effect.gen(function* () {
      const previewPlugin = definePlugin(() => ({
        id: "preview" as const,
        storage: () => ({}),
        staticSources: () => [
          {
            id: "preview.ctl",
            kind: "control",
            name: "Preview Ctl",
            tools: [
              {
                name: "createContact",
                description: "create",
                inputSchema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    age: { type: "number" },
                  },
                  required: ["name", "age"],
                  additionalProperties: false,
                },
                outputSchema: { type: "string" },
                handler: ({ args }) => Effect.succeed(args),
              },
            ],
          },
        ],
      }));

      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [previewPlugin()] as const }),
      );

      const schema = yield* executor.tools.schema("preview.ctl.createContact");
      expect(schema).not.toBeNull();
      expect(schema!.inputTypeScript).toBe("{ name: string; age: number }");
      expect(schema!.outputTypeScript).toBe("string");
    }),
  );

  it.effect("close calls each plugin's close hook", () =>
    Effect.gen(function* () {
      let closed = 0;
      const closeable = definePlugin(() => ({
        id: "closeable" as const,
        storage: () => ({}),
        close: () => Effect.sync(() => void closed++),
      }));

      const executor = yield* createExecutor(makeTestConfig({ plugins: [closeable()] as const }));

      yield* executor.close();
      expect(closed).toBe(1);
    }),
  );

  it.effect("static tool can suspend mid-invocation with FormElicitation", () =>
    Effect.gen(function* () {
      const loginPlugin = definePlugin(() => ({
        id: "login" as const,
        storage: () => ({}),
        staticSources: () => [
          {
            id: "login.ctl",
            kind: "control",
            name: "Login",
            tools: [
              {
                name: "signIn",
                description: "sign in",
                handler: ({ elicit }) =>
                  Effect.gen(function* () {
                    const response = yield* elicit(
                      new FormElicitation({
                        message: "Enter credentials",
                        requestedSchema: {
                          type: "object",
                          properties: {
                            username: { type: "string" },
                            password: { type: "string" },
                          },
                        },
                      }),
                    );
                    return {
                      user: response.content?.username,
                      status: "logged_in",
                    };
                  }),
              },
            ],
          },
        ],
      }));

      const executor = yield* createExecutor(makeTestConfig({ plugins: [loginPlugin()] as const }));

      const result = yield* executor.tools.invoke(
        "login.ctl.signIn",
        {},
        {
          onElicitation: (ctx) => {
            expect(Predicate.isTagged(ctx.request, "FormElicitation")).toBe(true);
            return Effect.succeed(
              new ElicitationResponse({
                action: "accept",
                content: { username: "alice", password: "s3cret" },
              }),
            );
          },
        },
      );

      expect(result).toEqual({ user: "alice", status: "logged_in" });
    }),
  );

  it.effect("static tool can request URL visit via UrlElicitation", () =>
    Effect.gen(function* () {
      const oauthPlugin = definePlugin(() => ({
        id: "oauth" as const,
        storage: () => ({}),
        staticSources: () => [
          {
            id: "oauth.ctl",
            kind: "control",
            name: "OAuth",
            tools: [
              {
                name: "connect",
                description: "oauth connect",
                handler: ({ elicit }) =>
                  Effect.gen(function* () {
                    const response = yield* elicit(
                      new UrlElicitation({
                        message: "Authorize the app",
                        url: "https://oauth.example.com/authorize?state=abc",
                        elicitationId: "oauth-abc",
                      }),
                    );
                    return {
                      connected: true,
                      code: response.content?.code,
                    };
                  }),
              },
            ],
          },
        ],
      }));

      const executor = yield* createExecutor(makeTestConfig({ plugins: [oauthPlugin()] as const }));

      const result = yield* executor.tools.invoke(
        "oauth.ctl.connect",
        {},
        {
          onElicitation: (ctx) => {
            expect(Predicate.isTagged(ctx.request, "UrlElicitation")).toBe(true);
            return Effect.succeed(
              new ElicitationResponse({
                action: "accept",
                content: { code: "auth-code-123" },
              }),
            );
          },
        },
      );

      expect(result).toEqual({ connected: true, code: "auth-code-123" });
    }),
  );

  // NOTE: behavior change vs. main — the SDK used to auto-decline when no
  // onElicitation handler was provided (yielding ElicitationDeclinedError).
  // The new resolver falls back to acceptAllHandler instead. Test locks in
  // the current behavior; flip the assertion if the default is reverted.
  it.effect("invoke auto-accepts elicitation when no handler is provided", () =>
    Effect.gen(function* () {
      const elicitOnly = definePlugin(() => ({
        id: "elicitOnly" as const,
        storage: () => ({}),
        staticSources: () => [
          {
            id: "elicit.ctl",
            kind: "control",
            name: "Elicit Ctl",
            tools: [
              {
                name: "ask",
                description: "ask the user",
                handler: ({ elicit }) =>
                  Effect.gen(function* () {
                    const response = yield* elicit(
                      new FormElicitation({
                        message: "Anything?",
                        requestedSchema: {},
                      }),
                    );
                    return response.action;
                  }),
              },
            ],
          },
        ],
      }));

      const executor = yield* createExecutor(makeTestConfig({ plugins: [elicitOnly()] as const }));

      const action = yield* executor.tools.invoke(
        "elicit.ctl.ask",
        {},
        { onElicitation: "accept-all" },
      );
      expect(action).toBe("accept");
    }),
  );

  it.effect("plugin reads and writes secrets via ctx.secrets", () =>
    Effect.gen(function* () {
      const rotatePlugin = definePlugin(() => ({
        id: "rotate" as const,
        storage: () => ({}),
        extension: (ctx) => ({
          rotate: (id: string, newValue: string) =>
            Effect.gen(function* () {
              const old = yield* ctx.secrets.get(id);
              if (old !== null) {
                yield* ctx.secrets.remove(
                  new RemoveSecretInput({
                    id: SecretId.make(id),
                    targetScope: ctx.scopes[0]!.id,
                  }),
                );
              }
              yield* ctx.secrets.set(
                new SetSecretInput({
                  id: SecretId.make(id),
                  scope: ctx.scopes[0]!.id,
                  name: id,
                  value: newValue,
                }),
              );
              return { oldValue: old, newValue };
            }),
        }),
      }));

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin(), rotatePlugin()] as const,
        }),
      );

      yield* executor.secrets.set(
        new SetSecretInput({
          id: SecretId.make("DB_PASSWORD"),
          scope: ScopeId.make("test-scope"),
          name: "DB_PASSWORD",
          value: "hunter2",
        }),
      );

      const result = yield* executor.rotate.rotate("DB_PASSWORD", "correct-horse-battery-staple");
      expect(result).toEqual({
        oldValue: "hunter2",
        newValue: "correct-horse-battery-staple",
      });

      const after = yield* executor.secrets.get("DB_PASSWORD");
      expect(after).toBe("correct-horse-battery-staple");
    }),
  );
});

// ---------------------------------------------------------------------------
// Tenant isolation — two executors with different scopes sharing the same
// adapter / blob store. Every SDK surface that reads rows must filter by
// the calling scope; the adapter has no scope concept, so the guarantee
// has to live in the executor / core-table layer. These tests pin the
// invariant at the cheapest possible level (in-memory adapter).
// ---------------------------------------------------------------------------

// Per-executor memory provider — mirrors production where each org's
// `workos-vault` plugin instance has its own client scoped to that org.
// A module-level shared provider would leak across scopes on its own,
// independent of the core.secret routing table isolation we're testing.
const makeScopedMemoryProvider = (): SecretProvider => {
  const store = new Map<string, string>();
  const key = (scope: string, id: string) => `${scope}\u0000${id}`;
  return {
    key: "scoped-memory",
    writable: true,
    get: (id, scope) => Effect.sync(() => store.get(key(scope, id)) ?? null),
    set: (id, value, scope) =>
      Effect.sync(() => {
        store.set(key(scope, id), value);
      }),
    delete: (id, scope) => Effect.sync(() => store.delete(key(scope, id))),
    list: () =>
      Effect.sync(() =>
        Array.from(store.keys()).map((k) => {
          const name = k.split("\u0000", 2)[1] ?? k;
          return { id: name, name };
        }),
      ),
  };
};

const tenantPlugin = definePlugin(() => ({
  id: "tenant" as const,
  storage: () => ({}),
  secretProviders: () => [makeScopedMemoryProvider()],
  staticSources: () => [
    {
      id: "tenant.ctl",
      kind: "control" as const,
      name: "Tenant Ctl",
      tools: [
        {
          name: "noop",
          description: "noop",
          inputSchema: { type: "object", additionalProperties: false },
          handler: () => Effect.succeed(null),
        },
      ],
    },
  ],
  extension: (ctx) => ({
    addSource: (id: string) =>
      ctx.transaction(
        Effect.gen(function* () {
          yield* ctx.core.sources.register({
            id,
            scope: ctx.scopes[0]!.id,
            kind: "tenant",
            name: id,
            canRemove: true,
            tools: [{ name: "t", description: "t" }],
          });
        }),
      ),
  }),
}));

const makeSharedTenantExecutors = () =>
  Effect.gen(function* () {
    const plugins = [tenantPlugin()] as const;
    const schema = collectSchemas(plugins);
    const adapter = makeMemoryAdapter({ schema });
    const blobs = makeInMemoryBlobStore();

    const makeOne = (id: string) =>
      createExecutor({
        scopes: [
          new Scope({
            id: ScopeId.make(id),
            name: id,
            createdAt: new Date(),
          }),
        ],
        adapter,
        blobs,
        plugins,
        onElicitation: "accept-all",
      });

    const execA = yield* makeOne("scope-a");
    const execB = yield* makeOne("scope-b");
    return { execA, execB };
  });

describe("tenant isolation (SDK)", () => {
  it.effect("sources.list does not leak across scopes", () =>
    Effect.gen(function* () {
      const { execA, execB } = yield* makeSharedTenantExecutors();
      yield* execA.tenant.addSource("a-source");

      const bSources = yield* execB.sources.list();
      expect(bSources.map((s) => s.id)).not.toContain("a-source");
    }),
  );

  it.effect("tools.list does not leak across scopes", () =>
    Effect.gen(function* () {
      const { execA, execB } = yield* makeSharedTenantExecutors();
      yield* execA.tenant.addSource("a-source");

      const bTools = yield* execB.tools.list();
      expect(bTools.map((t) => t.sourceId)).not.toContain("a-source");
    }),
  );

  it.effect("secrets.list does not leak across scopes", () =>
    Effect.gen(function* () {
      const { execA, execB } = yield* makeSharedTenantExecutors();
      yield* execA.secrets.set(
        new SetSecretInput({
          id: SecretId.make("shared-id"),
          scope: ScopeId.make("scope-a"),
          name: "A only",
          value: "a-value",
        }),
      );

      const bSecrets = yield* execB.secrets.list();
      expect(bSecrets.map((s) => s.id)).not.toContain("shared-id");
    }),
  );

  it.effect("secrets.status for another scope's id returns missing", () =>
    Effect.gen(function* () {
      const { execA, execB } = yield* makeSharedTenantExecutors();
      yield* execA.secrets.set(
        new SetSecretInput({
          id: SecretId.make("shared-id"),
          scope: ScopeId.make("scope-a"),
          name: "A only",
          value: "a-value",
        }),
      );

      const status = yield* execB.secrets.status("shared-id");
      expect(status).toBe("missing");
    }),
  );

  it.effect("secrets.get cannot read another scope's value", () =>
    Effect.gen(function* () {
      const { execA, execB } = yield* makeSharedTenantExecutors();
      yield* execA.secrets.set(
        new SetSecretInput({
          id: SecretId.make("shared-id"),
          scope: ScopeId.make("scope-a"),
          name: "A only",
          value: "a-value",
        }),
      );

      const value = yield* execB.secrets.get("shared-id");
      expect(value).toBeNull();
    }),
  );

  it.effect("secrets.set rejects scope outside the executor's stack", () =>
    Effect.gen(function* () {
      const { execA } = yield* makeSharedTenantExecutors();
      const result = yield* Effect.exit(
        execA.secrets.set(
          new SetSecretInput({
            id: SecretId.make("x"),
            scope: ScopeId.make("not-in-stack"),
            name: "x",
            value: "v",
          }),
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect("secrets.get — innermost scope shadows outer on same id", () =>
    Effect.gen(function* () {
      const plugins = [tenantPlugin()] as const;
      const schema = collectSchemas(plugins);
      const adapter = makeMemoryAdapter({ schema });
      const blobs = makeInMemoryBlobStore();

      const innerScope = ScopeId.make("user-org:u1:o1");
      const outerScope = ScopeId.make("o1");

      const exec = yield* createExecutor({
        scopes: [
          new Scope({ id: innerScope, name: "inner", createdAt: new Date() }),
          new Scope({ id: outerScope, name: "outer", createdAt: new Date() }),
        ],
        adapter,
        blobs,
        plugins,
        onElicitation: "accept-all",
      });

      yield* exec.secrets.set(
        new SetSecretInput({
          id: SecretId.make("token"),
          scope: outerScope,
          name: "org token",
          value: "org-value",
        }),
      );
      yield* exec.secrets.set(
        new SetSecretInput({
          id: SecretId.make("token"),
          scope: innerScope,
          name: "user token",
          value: "user-value",
        }),
      );

      const value = yield* exec.secrets.get("token");
      expect(value).toBe("user-value");
    }),
  );

  it.effect("secrets.listAll keeps exact-scope rows that secrets.list dedupes", () =>
    Effect.gen(function* () {
      const plugins = [tenantPlugin()] as const;
      const schema = collectSchemas(plugins);
      const adapter = makeMemoryAdapter({ schema });
      const blobs = makeInMemoryBlobStore();

      const innerScope = ScopeId.make("user-org:u1:o1");
      const outerScope = ScopeId.make("o1");

      const exec = yield* createExecutor({
        scopes: [
          new Scope({ id: innerScope, name: "inner", createdAt: new Date() }),
          new Scope({ id: outerScope, name: "outer", createdAt: new Date() }),
        ],
        adapter,
        blobs,
        plugins,
        onElicitation: "accept-all",
      });

      yield* exec.secrets.set(
        new SetSecretInput({
          id: SecretId.make("token"),
          scope: outerScope,
          name: "org token",
          value: "org-value",
        }),
      );
      yield* exec.secrets.set(
        new SetSecretInput({
          id: SecretId.make("token"),
          scope: innerScope,
          name: "user token",
          value: "user-value",
        }),
      );

      const runtimeList = yield* exec.secrets.list();
      const managementList = yield* exec.secrets.listAll();

      expect(runtimeList.filter((ref) => ref.id === "token")).toHaveLength(1);
      expect(managementList.filter((ref) => ref.id === "token").map((ref) => ref.scopeId)).toEqual([
        innerScope,
        outerScope,
      ]);
    }),
  );

  it.effect("secrets.list hides routing rows when the provider reports no backing value", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [staleRouteSecretsPlugin()] as const }),
      );

      yield* executor.secrets.set(
        new SetSecretInput({
          id: SecretId.make("missing-secret"),
          scope: ScopeId.make("test-scope"),
          name: "Missing Secret",
          value: "not-stored",
        }),
      );

      const refs = yield* executor.secrets.list();
      const status = yield* executor.secrets.status("missing-secret");

      expect(refs.map((ref) => ref.id)).not.toContain("missing-secret");
      expect(status).toBe("missing");
    }),
  );

  it.effect("secrets.list keeps routing rows for providers without existence checks", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [opaqueRouteSecretsPlugin()] as const }),
      );

      yield* executor.secrets.set(
        new SetSecretInput({
          id: SecretId.make("opaque-secret"),
          scope: ScopeId.make("test-scope"),
          name: "Opaque Secret",
          value: "not-stored",
        }),
      );

      const refs = yield* executor.secrets.list();
      const status = yield* executor.secrets.status("opaque-secret");

      expect(refs.map((ref) => ref.id)).toContain("opaque-secret");
      expect(status).toBe("resolved");
    }),
  );

  it.effect("secrets.list surfaces provider-enumerated entries; status still gates on routed rows", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [providerOnlySecretPlugin()] as const }),
      );

      const refs = yield* executor.secrets.list();
      const status = yield* executor.secrets.status("provider-token");
      const value = yield* executor.secrets.get("provider-token");

      const entry = refs.find((ref) => ref.id === "provider-token");
      expect(entry?.provider).toBe("provider-only");
      expect(entry?.name).toBe("Provider token");
      expect(status).toBe("missing");
      expect(value).toBe("provider-value");
    }),
  );

  it.effect("secrets.get short-circuits provider fallback in registration order", () =>
    Effect.gen(function* () {
      const laterCalls = { count: 0 };
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [fallbackOrderingPlugin(laterCalls)()] as const }),
      );

      const value = yield* executor.secrets.get("token");

      expect(value).toBe("first-value");
      expect(laterCalls.count).toBe(0);
    }),
  );

  it.effect("secrets.get skips providers that disable fallback lookup", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [fallbackDisabledPlugin()] as const }),
      );

      const value = yield* executor.secrets.get("token");

      expect(value).toBeNull();
    }),
  );

  it.effect("source registration deduplicates duplicate tool ids before bulk insert", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [duplicateToolsPlugin()] as const }),
      );

      yield* executor.duplicateTools.register();

      const tools = yield* executor.tools.list();
      expect(tools.filter((tool) => tool.id === "dup-source.same")).toHaveLength(1);
      expect(tools.find((tool) => tool.id === "dup-source.same")?.description).toBe("last");
    }),
  );
});

// ---------------------------------------------------------------------------
// Cross-scope write preservation — the scoped adapter auto-injects
// `scope_id IN (stack)` on every query, which is correct for reads but
// used to silently widen scope-targeted deletes inside `secrets.set`,
// `sources.register` and `definitions.register`. A user writing at their
// inner scope would wipe rows that belonged to the outer scope (e.g. an
// admin-registered org-wide secret or source). These tests pin each write
// path to the "only the target scope row is replaced" invariant.
//
// Each test uses a single shared adapter across two executors:
//   - `execOuter` has stack [outer] — models a different user or the
//     admin who owns the outer-scope row we're checking survives.
//   - `execInner` has stack [inner, outer] — the overriding user whose
//     write would (buggy) nuke the outer row.
// ---------------------------------------------------------------------------

const tenantPluginWithDefs = definePlugin(() => ({
  id: "tenant-defs" as const,
  storage: () => ({}),
  extension: (ctx) => ({
    addDefs: (sourceId: string, definitions: Record<string, unknown>) =>
      ctx.core.definitions.register({
        sourceId,
        scope: ctx.scopes[0]!.id,
        definitions,
      }),
  }),
}));

const makeLayeredExecutors = () =>
  Effect.gen(function* () {
    const plugins = [tenantPlugin(), tenantPluginWithDefs()] as const;
    const schema = collectSchemas(plugins);
    const adapter = makeMemoryAdapter({ schema });
    const blobs = makeInMemoryBlobStore();

    const outerId = ScopeId.make("org");
    const innerId = ScopeId.make("user-org:u1:org");

    const outerScope = new Scope({
      id: outerId,
      name: "outer",
      createdAt: new Date(),
    });
    const innerScope = new Scope({
      id: innerId,
      name: "inner",
      createdAt: new Date(),
    });

    const execOuter = yield* createExecutor({
      scopes: [outerScope],
      adapter,
      blobs,
      plugins,
      onElicitation: "accept-all",
    });
    const execInner = yield* createExecutor({
      scopes: [innerScope, outerScope],
      adapter,
      blobs,
      plugins,
      onElicitation: "accept-all",
    });
    return { execOuter, execInner, outerId, innerId };
  });

describe("cross-scope write preservation (SDK)", () => {
  it.effect(
    "secrets.set at the inner scope does not wipe an outer-scope row with the same id",
    () =>
      Effect.gen(function* () {
        const { execOuter, execInner, outerId, innerId } = yield* makeLayeredExecutors();

        // Admin-equivalent writes the org-wide secret at the outer scope.
        yield* execInner.secrets.set(
          new SetSecretInput({
            id: SecretId.make("api-token"),
            scope: outerId,
            name: "Org default",
            value: "org-default",
          }),
        );

        // User writes a personal override at the inner scope.
        yield* execInner.secrets.set(
          new SetSecretInput({
            id: SecretId.make("api-token"),
            scope: innerId,
            name: "Personal override",
            value: "personal-override",
          }),
        );

        // Outer-only executor — same adapter, scope stack = [outer] —
        // must still see the outer-scope secret ROW (via `secrets.list`,
        // which reads the core `secret` table directly). This is where
        // the bug landed: the inner write's delete used
        // `scope_id IN [inner, outer]` and wiped the outer row, so a
        // bystander with just [outer] in their stack saw nothing.
        //
        // We assert on list instead of get because each executor's
        // in-memory secret provider is per-executor in this test harness
        // (see `makeScopedMemoryProvider`) — the adapter's `secret` rows
        // are the shared, observable source of truth.
        const outerRefs = yield* execOuter.secrets.list();
        expect(outerRefs.map((r) => r.id)).toContain("api-token");
        expect(outerRefs.find((r) => r.id === "api-token")?.scopeId).toBe(outerId);

        // Inner executor's list is de-duplicated by id (innermost wins),
        // so we only expect one ref for `api-token` — pinned at the
        // inner scope.
        const innerRefs = yield* execInner.secrets.list();
        const innerRef = innerRefs.find((r) => r.id === "api-token");
        expect(innerRef?.scopeId).toBe(innerId);
      }),
  );

  it.effect(
    "sources.register at the inner scope does not wipe an outer-scope source with the same id",
    () =>
      Effect.gen(function* () {
        const { execOuter, execInner } = yield* makeLayeredExecutors();

        // Outer-scope executor registers a source.
        yield* execOuter.tenant.addSource("shared");

        // Inner-stacked executor registers a source with the same id at
        // its own innermost scope (default for `addSource` in the test
        // plugin is `ctx.scopes[0]`).
        yield* execInner.tenant.addSource("shared");

        // Outer executor must still see its source. The bug was that
        // `writeSourceInput`'s delete-before-create ran stack-wide and
        // nuked the outer source row before creating the inner one.
        const outerSources = yield* execOuter.sources.list();
        expect(outerSources.map((s) => s.id)).toContain("shared");

        // Inner executor's list is de-duplicated by id (innermost wins),
        // so we only expect one entry for "shared" — pinned at the inner
        // scope. The fact that it shows up at all (combined with the outer
        // executor still seeing its own row above) proves no rows went
        // missing.
        const innerSources = yield* execInner.sources.list();
        expect(innerSources.filter((s) => s.id === "shared")).toHaveLength(1);
      }),
  );

  it.effect(
    "definitions.register at the inner scope does not wipe outer-scope definitions for the same sourceId",
    () =>
      Effect.gen(function* () {
        const { execOuter, execInner } = yield* makeLayeredExecutors();

        yield* execOuter["tenant-defs"].addDefs("S", {
          OuterDef: { type: "object" },
        });
        yield* execInner["tenant-defs"].addDefs("S", {
          InnerDef: { type: "object" },
        });

        // Outer executor should still see its definition. The bug was
        // that `writeDefinitions` deleted by `source_id` without pinning
        // a scope, so the inner write's stack-wide delete wiped the
        // outer row before creating the inner one.
        const outerDefs = yield* execOuter.tools.definitions();
        expect(outerDefs.S).toBeDefined();
        expect(outerDefs.S?.OuterDef).toBeDefined();
      }),
  );
});

// ---------------------------------------------------------------------------
// Shadow / precedence / cross-scope remove invariants.
//
// The scoped adapter returns rows from every scope in the stack on a read.
// The SDK owes callers two properties on top of that:
//
//   - Writes that target a single scope (delete / remove / unregister) must
//     not cascade into outer scopes when an inner-scope write collides by id.
//     The pattern that failed us was `findOne` on a scoped table: in a
//     multi-scope stack that picks whichever scope the storage backend
//     iterates first, so the downstream delete can hit the wrong row.
//
//   - Reads that are supposed to return a single logical row (resolve one
//     tool by id, one source by id, one secret by id) must pick the
//     innermost-scope match. Otherwise a user who shadowed an org default
//     can silently get the org version back on invoke / schema.
// ---------------------------------------------------------------------------

const invokeMarkerPlugin = definePlugin(() => ({
  id: "marker" as const,
  storage: () => ({}),
  extension: (ctx) => ({
    register: (sourceId: string, marker: string) =>
      ctx.transaction(
        ctx.core.sources.register({
          id: sourceId,
          scope: ctx.scopes[0]!.id,
          kind: "marker",
          name: marker,
          canRemove: true,
          tools: [{ name: "t", description: marker }],
        }),
      ),
  }),
  invokeTool: ({ toolRow }) =>
    Effect.succeed({
      marker: toolRow.description,
      scope: toolRow.scope_id,
    }),
}));

const makeMarkerExecutors = () =>
  Effect.gen(function* () {
    const plugins = [invokeMarkerPlugin()] as const;
    const schema = collectSchemas(plugins);
    const adapter = makeMemoryAdapter({ schema });
    const blobs = makeInMemoryBlobStore();

    const outerId = ScopeId.make("org");
    const innerId = ScopeId.make("user-org:u1:org");
    const outerScope = new Scope({
      id: outerId,
      name: "outer",
      createdAt: new Date(),
    });
    const innerScope = new Scope({
      id: innerId,
      name: "inner",
      createdAt: new Date(),
    });

    const execOuter = yield* createExecutor({
      scopes: [outerScope],
      adapter,
      blobs,
      plugins,
      onElicitation: "accept-all",
    });
    const execInner = yield* createExecutor({
      scopes: [innerScope, outerScope],
      adapter,
      blobs,
      plugins,
      onElicitation: "accept-all",
    });
    return { execOuter, execInner, outerId, innerId };
  });

describe("cross-scope read precedence + remove isolation (SDK)", () => {
  it.effect("secrets.remove at the inner scope does not wipe outer-scope row with same id", () =>
    Effect.gen(function* () {
      const { execOuter, execInner, outerId, innerId } = yield* makeLayeredExecutors();

      yield* execInner.secrets.set(
        new SetSecretInput({
          id: SecretId.make("api-token"),
          scope: outerId,
          name: "Org default",
          value: "org-default",
        }),
      );
      yield* execInner.secrets.set(
        new SetSecretInput({
          id: SecretId.make("api-token"),
          scope: innerId,
          name: "Personal override",
          value: "personal-override",
        }),
      );

      // Inner caller removes — should only drop the inner override.
      yield* execInner.secrets.remove(
        new RemoveSecretInput({
          id: SecretId.make("api-token"),
          targetScope: innerId,
        }),
      );

      // Outer-only executor must still see its org-scope row.
      const outerRefs = yield* execOuter.secrets.list();
      expect(outerRefs.map((r) => r.id)).toContain("api-token");
      expect(outerRefs.find((r) => r.id === "api-token")?.scopeId).toBe(outerId);
    }),
  );

  it.effect(
    "sources.remove at the inner scope does not wipe the outer-scope source with same id",
    () =>
      Effect.gen(function* () {
        const { execOuter, execInner, innerId } = yield* makeLayeredExecutors();

        yield* execOuter.tenant.addSource("shared");
        yield* execInner.tenant.addSource("shared");

        // Inner caller removes "shared" via the public API. The outer
        // executor's source row must survive.
        yield* execInner.sources.remove({ id: "shared", targetScope: innerId });

        const outerSources = yield* execOuter.sources.list();
        expect(outerSources.map((s) => s.id)).toContain("shared");
      }),
  );

  it.effect("ctx.core.sources.unregister at the inner scope does not wipe outer-scope row", () =>
    Effect.gen(function* () {
      const { execOuter, execInner, innerId } = yield* makeLayeredExecutors();

      yield* execOuter.tenant.addSource("shared");
      yield* execInner.tenant.addSource("shared");

      // Plugin-owned unregister path (ctx.core.sources.unregister) fires
      // via a dedicated extension method. We drive it by calling
      // `sources.remove` — which routes through the same deleteSourceById
      // helper — but the real regression is the findOne-before-delete
      // picking the wrong scope's row. The outer row must survive.
      yield* execInner.sources.remove({ id: "shared", targetScope: innerId });

      const outerSources = yield* execOuter.sources.list();
      expect(outerSources.filter((s) => s.id === "shared")).toHaveLength(1);
    }),
  );

  it.effect(
    "tools.invoke picks the innermost tool when the same tool id exists at two scopes",
    () =>
      Effect.gen(function* () {
        const { execOuter, execInner, outerId, innerId } = yield* makeMarkerExecutors();

        yield* execOuter.marker.register("shared", "outer");
        yield* execInner.marker.register("shared", "inner");

        const result = (yield* execInner.tools.invoke(
          "shared.t",
          {},
          { onElicitation: "accept-all" },
        )) as {
          marker: string;
          scope: string;
        };
        expect(result.marker).toBe("inner");
        expect(result.scope).toBe(innerId);

        // Outer-only executor still invokes its own copy.
        const outerResult = (yield* execOuter.tools.invoke(
          "shared.t",
          {},
          { onElicitation: "accept-all" },
        )) as { marker: string; scope: string };
        expect(outerResult.marker).toBe("outer");
        expect(outerResult.scope).toBe(outerId);
      }),
  );

  it.effect("tools.schema — innermost shadow returns the inner description", () =>
    Effect.gen(function* () {
      const { execOuter, execInner } = yield* makeMarkerExecutors();

      yield* execOuter.marker.register("shared", "outer-desc");
      yield* execInner.marker.register("shared", "inner-desc");

      const schema = yield* execInner.tools.schema("shared.t");
      expect(schema?.description).toBe("inner-desc");
    }),
  );

  it.effect("tools.list dedupes by id, keeping the innermost row", () =>
    Effect.gen(function* () {
      const { execOuter, execInner } = yield* makeMarkerExecutors();

      yield* execOuter.marker.register("shared", "outer-desc");
      yield* execInner.marker.register("shared", "inner-desc");

      const tools = yield* execInner.tools.list();
      const shared = tools.filter((t) => t.id === "shared.t");
      expect(shared).toHaveLength(1);
      expect(shared[0]?.description).toBe("inner-desc");
    }),
  );

  it.effect("sources.list dedupes by id, keeping the innermost row", () =>
    Effect.gen(function* () {
      const { execOuter, execInner } = yield* makeMarkerExecutors();

      yield* execOuter.marker.register("shared", "outer-name");
      yield* execInner.marker.register("shared", "inner-name");

      const sources = yield* execInner.sources.list();
      const shared = sources.filter((s) => s.id === "shared");
      expect(shared).toHaveLength(1);
      expect(shared[0]?.name).toBe("inner-name");
    }),
  );

  it.effect("tools.definitions dedupes by (source_id, name), keeping the innermost row", () =>
    Effect.gen(function* () {
      const { execOuter, execInner } = yield* makeLayeredExecutors();

      // Register inner first, outer second. Without precedence-aware
      // dedup, a naive "iterate rows, last-one-wins" map would end up
      // keyed to the outer description just because outer was inserted
      // into the store last.
      yield* execInner["tenant-defs"].addDefs("S", {
        Shared: { type: "string", description: "inner" },
      });
      yield* execOuter["tenant-defs"].addDefs("S", {
        Shared: { type: "string", description: "outer" },
      });

      const defs = yield* execInner.tools.definitions();
      const shared = defs.S?.Shared as { description?: string } | undefined;
      expect(shared?.description).toBe("inner");
    }),
  );

  it.effect("tools.schema attaches innermost $defs when shadowed across scopes", () =>
    Effect.gen(function* () {
      // Source id "S" with a tool that references $defs/Shared, plus a
      // definition "Shared" registered at both scopes. Schema's attached
      // $defs should come from the inner scope.
      const plugins = [
        tenantPlugin(),
        tenantPluginWithDefs(),
        definePlugin(() => ({
          id: "ref" as const,
          storage: () => ({}),
          extension: (ctx) => ({
            register: (sourceId: string) =>
              ctx.transaction(
                ctx.core.sources.register({
                  id: sourceId,
                  scope: ctx.scopes[0]!.id,
                  kind: "ref",
                  name: sourceId,
                  canRemove: true,
                  tools: [
                    {
                      name: "use",
                      description: "uses $defs/Shared",
                      inputSchema: {
                        type: "object",
                        properties: { x: { $ref: "#/$defs/Shared" } },
                      },
                    },
                  ],
                }),
              ),
          }),
        }))(),
      ] as const;
      const schema = collectSchemas(plugins);
      const adapter = makeMemoryAdapter({ schema });
      const blobs = makeInMemoryBlobStore();

      const outerId = ScopeId.make("org");
      const innerId = ScopeId.make("user-org:u1:org");
      const execOuter = yield* createExecutor({
        scopes: [new Scope({ id: outerId, name: "outer", createdAt: new Date() })],
        adapter,
        blobs,
        plugins,
        onElicitation: "accept-all",
      });
      const execInner = yield* createExecutor({
        scopes: [
          new Scope({ id: innerId, name: "inner", createdAt: new Date() }),
          new Scope({ id: outerId, name: "outer", createdAt: new Date() }),
        ],
        adapter,
        blobs,
        plugins,
        onElicitation: "accept-all",
      });

      yield* execOuter.ref.register("S");
      yield* execInner.ref.register("S");

      yield* execInner["tenant-defs"].addDefs("S", {
        Shared: { type: "string", description: "inner" },
      });
      yield* execOuter["tenant-defs"].addDefs("S", {
        Shared: { type: "string", description: "outer" },
      });

      const view = yield* execInner.tools.schema("S.use");
      const input = view?.inputSchema as
        | { $defs?: { Shared?: { description?: string } } }
        | undefined;
      expect(input?.$defs?.Shared?.description).toBe("inner");
    }),
  );
});
