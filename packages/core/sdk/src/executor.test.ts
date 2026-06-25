import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Predicate, Result } from "effect";
import { withQueryContext } from "@executor-js/fumadb/query";

import { ToolNotFoundError } from "./errors";
import { StorageError } from "./fuma-runtime";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderItemId,
  ProviderKey,
  Subject,
  Tenant,
  ToolAddress,
  ToolName,
} from "./ids";
import { collectTables, createExecutor } from "./executor";
import { definePlugin, type AnyPlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { IntegrationDetectionResult } from "./types";
import { createSqliteTestFumaDb, makeTestExecutor } from "./testing";
import { serveOAuthTestServer } from "./testing/oauth-test-server";

// removed: v1 secret browser-handoff, source.configure, case-insensitive tool-id
// resolution, secrets/sources/scope-stack. The integration coverage below is
// ported to the v2 surface (integrations/connections/OAuth/resolveTools/execute/
// tools.schema).

class TestPluginError extends Data.TaggedError("TestPluginError")<{
  readonly message: string;
}> {}

const memoryProvider = (): CredentialProvider => {
  const store = new Map<string, string>();
  return {
    key: ProviderKey.make("memory"),
    writable: true,
    get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id, value) => Effect.sync(() => void store.set(String(id), value)),
  };
};

const INTEG = IntegrationSlug.make("demo");
const TEMPLATE = AuthTemplateSlug.make("apiKey");
const CONN = ConnectionName.make("main");

const addr = (tool: string): ToolAddress => ToolAddress.make(`tools.${INTEG}.org.${CONN}.${tool}`);

// ---------------------------------------------------------------------------
// A plugin that registers an integration, produces per-connection tools via
// resolveTools (with shared $defs), and supports ctx.transaction rollback.
// ---------------------------------------------------------------------------

const demoPlugin = definePlugin(() => ({
  id: "demo" as const,
  credentialProviders: [memoryProvider()],
  storage: ({ pluginStorage }) => ({
    put: (owner: "org" | "user", key: string, value: string) =>
      pluginStorage.put({ collection: "item", key, owner, data: { value } }).pipe(Effect.asVoid),
    list: () =>
      pluginStorage
        .list<{ readonly value: string }>({ collection: "item" })
        .pipe(Effect.map((rows) => rows.map((row) => ({ id: row.key, value: row.data.value })))),
  }),
  resolveTools: () =>
    Effect.succeed({
      tools: [
        {
          name: ToolName.make("inspect"),
          description: "inspect",
          inputSchema: {
            type: "object",
            properties: { pet: { $ref: "#/$defs/Pet" } },
            required: ["pet"],
          },
          outputSchema: { $ref: "#/$defs/Owner" },
        },
        { name: ToolName.make("run"), description: "run" },
      ],
      definitions: {
        Pet: { anyOf: [{ $ref: "#/$defs/Dog" }, { $ref: "#/$defs/Cat" }] },
        Dog: {
          type: "object",
          properties: { collar: { $ref: "#/$defs/Collar" } },
        },
        Cat: { type: "object", properties: { lives: { type: "number" } } },
        Collar: { type: "object", properties: { id: { type: "string" } } },
        Owner: { type: "object", properties: { pet: { $ref: "#/$defs/Pet" } } },
        Unused: { type: "object", properties: { value: { type: "string" } } },
      },
    }),
  invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: INTEG,
        description: "Demo",
        config: {},
      }),
    // Stamp the integration's `config_revised_at` so every other binding's
    // connections fall behind and reconverge on their next read.
    reviseConfig: (rev: number) => ctx.core.integrations.update(INTEG, { config: { rev } }),
    storagePut: (owner: "org" | "user", key: string, value: string) =>
      ctx.storage.put(owner, key, value),
    storageList: () => ctx.storage.list(),
    failAfterPluginAndCoreWrites: () =>
      ctx.transaction(
        Effect.gen(function* () {
          yield* ctx.storage.put("org", "tx-row", "created-before-failure");
          yield* ctx.core.integrations.register({
            slug: IntegrationSlug.make("tx-integration"),
            description: "Tx",
            config: {},
          });
          return yield* new TestPluginError({ message: "rollback" });
        }),
      ),
  }),
}))();

const detector = (id: string, confidence: IntegrationDetectionResult["confidence"]) =>
  definePlugin(() => ({
    id,
    storage: () => ({}),
    detect: () =>
      Effect.succeed(
        IntegrationDetectionResult.make({
          kind: id,
          confidence,
          endpoint: `https://example.com/${id}`,
          name: id,
          slug: id,
        }),
      ),
  }))();

describe("createExecutor", () => {
  it.effect("rolls back plugin and core writes from ctx.transaction failures", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [demoPlugin] as const,
      });
      const result = yield* Effect.result(executor.demo.failAfterPluginAndCoreWrites());
      expect(Result.isFailure(result)).toBe(true);

      // Neither the plugin row nor the core integration row should survive.
      const rows = yield* executor.demo.storageList();
      expect(rows).toEqual([]);
      const integrations = yield* executor.integrations.list();
      expect(integrations.map((i) => String(i.slug))).not.toContain("tx-integration");
    }),
  );

  it.effect("runs plugin close hooks", () =>
    Effect.gen(function* () {
      let closed = false;
      const closingPlugin = definePlugin(() => ({
        id: "closing" as const,
        storage: () => ({}),
        close: () => Effect.sync(() => void (closed = true)),
      }))();
      const executor = yield* makeTestExecutor({
        plugins: [closingPlugin] as const,
      });
      yield* executor.close();
      expect(closed).toBe(true);
    }),
  );

  it.effect("projects core tools as the built-in Executor integration", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        coreTools: { webBaseUrl: "http://localhost:3000" },
      });
      const integrations = yield* executor.integrations.list();
      const executorIntegration = integrations.find((i) => String(i.slug) === "executor");
      expect(executorIntegration).toMatchObject({
        description: "Executor",
        kind: "built-in",
        canRemove: false,
        canRefresh: false,
      });

      const address = ToolAddress.make("executor.coreTools.integrations.list");
      const tools = yield* executor.tools.list({
        integration: IntegrationSlug.make("executor"),
        includeBlocked: true,
      });
      const listed = tools.find((toolRow) => toolRow.address === address);
      expect(listed).toMatchObject({
        address,
        integration: IntegrationSlug.make("executor"),
        connection: ConnectionName.make("coreTools"),
        name: ToolName.make("coreTools.integrations.list"),
        static: true,
      });

      const schema = yield* executor.tools.schema(address);
      expect(schema).toMatchObject({
        address,
        name: "coreTools.integrations.list",
        outputSchema: {
          type: "object",
          required: ["integrations"],
        },
      });

      const out = yield* executor.execute(address, {});
      expect(out).toMatchObject({
        integrations: [expect.objectContaining({ slug: "executor" })],
      });
    }),
  );

  it.effect("can omit provider tools from the built-in Executor integration", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        coreTools: {
          webBaseUrl: "http://localhost:3000",
          includeProviders: false,
        },
      });

      const tools = yield* executor.tools.list({
        integration: IntegrationSlug.make("executor"),
        includeBlocked: true,
      });
      const names = tools.map((toolRow) => String(toolRow.name)).sort();

      expect(names).toContain("coreTools.integrations.list");
      expect(names).not.toContain("coreTools.providers.list");
      expect(names).not.toContain("coreTools.providers.items");
    }),
  );

  it.effect("creates provider-backed connections through the built-in Executor tools", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [demoPlugin] as const,
        coreTools: { webBaseUrl: "http://localhost:3000" },
      });
      yield* executor.demo.seed();

      const created = yield* executor.execute(
        ToolAddress.make("executor.coreTools.connections.create"),
        {
          owner: "org",
          name: String(CONN),
          integration: String(INTEG),
          template: String(TEMPLATE),
          identityLabel: "Demo",
          from: { provider: "memory", id: "secret-token" },
        },
      );
      expect(created).toMatchObject({
        owner: "org",
        name: String(CONN),
        integration: String(INTEG),
        template: String(TEMPLATE),
        address: "tools.demo.org.main",
        identityLabel: "Demo",
        oauthClient: null,
      });

      const listed = yield* executor.execute(
        ToolAddress.make("executor.coreTools.connections.list"),
        { integration: String(INTEG), owner: "org" },
      );
      expect(listed).toMatchObject({
        connections: [expect.objectContaining({ address: "tools.demo.org.main" })],
      });

      const out = yield* executor.execute(addr("run"), {});
      expect(out).toEqual({ ran: "run" });
    }),
  );

  it.effect("hands pasted credential entry to the web UI", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        coreTools: { webBaseUrl: "http://localhost:3000" },
      });

      const handoff = yield* executor.execute(
        ToolAddress.make("executor.coreTools.connections.createHandoff"),
        {
          integration: String(INTEG),
          owner: "user",
          template: String(TEMPLATE),
          label: "Demo token",
        },
      );

      expect(handoff).toMatchObject({
        instructions: expect.stringContaining("Do not ask them to paste"),
      });
      const handoffOutput = handoff as { readonly url: string };
      const url = new URL(handoffOutput.url);
      expect(url.origin).toBe("http://localhost:3000");
      expect(url.pathname).toBe(`/integrations/${String(INTEG)}`);
      expect(url.searchParams.get("addAccount")).toBe("1");
      expect(url.searchParams.get("owner")).toBe("user");
      expect(url.searchParams.get("template")).toBe(String(TEMPLATE));
      expect(url.searchParams.get("label")).toBe("Demo token");
      expect(url.search).not.toContain("secret");
    }),
  );

  it.effect("starts a client-credentials connection through the oauth.start tool", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const executor = yield* makeTestExecutor({
          plugins: [demoPlugin] as const,
          coreTools: { webBaseUrl: "http://localhost:3000" },
          redirectUri: null,
        });
        yield* executor.demo.seed();

        const client = OAuthClientSlug.make("demo-machine");
        // A confidential client_credentials app carries a secret, so it is
        // registered through the service layer (the browser-handoff path the web
        // UI uses) rather than the agent-facing `oauth.clients.create` tool,
        // which no longer accepts a client secret. The connection still starts
        // through the `oauth.start` tool below.
        const registered = yield* executor.oauth.createClient({
          owner: "org",
          slug: client,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "client_credentials",
          clientId: "test-client",
          clientSecret: "test-secret",
          resource: server.resourceUrl,
        });
        expect(registered).toEqual(client);

        const started = yield* executor.execute(
          ToolAddress.make("executor.coreTools.oauth.start"),
          {
            client: String(client),
            clientOwner: "org",
            owner: "org",
            name: "oauth",
            integration: String(INTEG),
            template: String(TEMPLATE),
          },
        );
        expect(started).toMatchObject({
          status: "connected",
          connection: {
            owner: "org",
            name: "oauth",
            integration: String(INTEG),
            oauthClient: String(client),
            oauthClientOwner: "org",
          },
        });

        const requests = yield* server.requests;
        const tokenRequest = requests.find(
          (request) =>
            request.path === "/token" && request.body.includes("grant_type=client_credentials"),
        );
        expect(tokenRequest).toBeDefined();
        expect(new URLSearchParams(tokenRequest!.body).get("resource")).toBe(server.resourceUrl);

        const out = yield* executor.execute(ToolAddress.make("tools.demo.org.oauth.run"), {});
        expect(out).toEqual({ ran: "run" });
      }),
    ),
  );

  it.effect("orders integration detection results by confidence", () =>
    Effect.gen(function* () {
      const plugins = [
        detector("low-detector", "low"),
        detector("high-detector", "high"),
        detector("medium-detector", "medium"),
      ] as const;
      const executor = yield* makeTestExecutor({ plugins });
      const results = yield* executor.integrations.detect("https://example.com/thing");
      // Every detector recognizes the URL; the list contains all three.
      expect(results.map((r) => r.kind).sort()).toEqual([
        "high-detector",
        "low-detector",
        "medium-detector",
      ]);
    }),
  );

  it.effect("tools.schema returns roots with shared reachable definitions", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [demoPlugin] as const,
      });
      yield* executor.demo.seed();
      yield* executor.connections.create({
        owner: "org",
        name: CONN,
        integration: INTEG,
        template: TEMPLATE,
        from: {
          provider: ProviderKey.make("memory"),
          id: ProviderItemId.make("v"),
        },
      });

      const schema = yield* executor.tools.schema(addr("inspect"));
      expect(schema).not.toBeNull();
      const defs = schema?.schemaDefinitions ?? {};
      // Reachable defs from inspect's input/output are attached; Unused is not.
      expect(Object.keys(defs).sort()).toEqual(["Cat", "Collar", "Dog", "Owner", "Pet"]);
    }),
  );

  it.effect("execute dispatches a connection-produced tool to the owning plugin", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [demoPlugin] as const,
      });
      yield* executor.demo.seed();
      yield* executor.connections.create({
        owner: "org",
        name: CONN,
        integration: INTEG,
        template: TEMPLATE,
        from: {
          provider: ProviderKey.make("memory"),
          id: ProviderItemId.make("v"),
        },
      });

      const out = yield* executor.execute(addr("run"), {});
      expect(out).toEqual({ ran: "run" });
    }),
  );

  it.effect("execute on a missing address fails with ToolNotFoundError", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [demoPlugin] as const,
      });
      yield* executor.demo.seed();
      yield* executor.connections.create({
        owner: "org",
        name: CONN,
        integration: INTEG,
        template: TEMPLATE,
        from: {
          provider: ProviderKey.make("memory"),
          id: ProviderItemId.make("v"),
        },
      });
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("other"),
        integration: INTEG,
        template: TEMPLATE,
        from: {
          provider: ProviderKey.make("memory"),
          id: ProviderItemId.make("v"),
        },
      });

      const result = yield* Effect.result(executor.execute(addr("un"), {}));
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      const error = result.failure;
      expect(Predicate.isTagged(error, "ToolNotFoundError")).toBe(true);
      const suggestions = (error as ToolNotFoundError).suggestions ?? [];
      expect(suggestions).toEqual([addr("run")]);
      expect(
        suggestions.every((suggestion) =>
          String(suggestion).startsWith(`tools.${INTEG}.org.${CONN}.`),
        ),
      ).toBe(true);
    }),
  );
});

// ---------------------------------------------------------------------------
// Stale-connection-tools sync: the read path (`tools.list`) must converge a
// connection whose catalog predates its integration's last config revision,
// but must NOT re-scan connections on every read once everything is synced at
// the current revision watermark.
// ---------------------------------------------------------------------------

const FLAKY = IntegrationSlug.make("flaky");

// Build an executor over a real SQLite DB whose adapter counts how many reads
// hit each table. The counter is installed on the adapter BEFORE the query
// context is layered on, so every derived contextual query forwards to it.
const makeCountingExecutor = <const TPlugins extends readonly AnyPlugin[]>(input: {
  readonly tenant: string;
  readonly subject: string;
  readonly plugins: TPlugins;
}) =>
  Effect.gen(function* () {
    const tables = collectTables();
    const real = yield* Effect.promise(() =>
      createSqliteTestFumaDb({ tables, namespace: "executor_test" }),
    );
    const counts: Record<string, number> = {};
    // Count reads per table at the adapter seam, BEFORE the query context is
    // layered on, so every derived contextual query forwards through it.
    const adapter = real.db.internal;
    const realFindMany = adapter.findMany.bind(adapter);
    adapter.findMany = (table, options) => {
      counts[table.ormName] = (counts[table.ormName] ?? 0) + 1;
      return realFindMany(table, options);
    };
    const db = withQueryContext(real.db, { tenant: input.tenant, subject: input.subject });
    const executor = yield* createExecutor({
      tenant: Tenant.make(input.tenant),
      subject: Subject.make(input.subject),
      db,
      plugins: input.plugins,
      onElicitation: "accept-all",
    });
    return {
      executor,
      counts,
      reset: () => {
        for (const key of Object.keys(counts)) counts[key] = 0;
      },
      close: () =>
        executor.close().pipe(Effect.ignore, Effect.andThen(Effect.promise(() => real.close()))),
    };
  });

// A plugin whose resolveTools can be toggled to fail, to exercise the
// best-effort retry path (a failed rebuild must not be cached as "synced").
const makeFlakyPlugin = () => {
  let fail = false;
  return definePlugin(() => ({
    id: "flaky" as const,
    credentialProviders: [memoryProvider()],
    storage: () => ({}),
    resolveTools: () =>
      fail
        ? Effect.fail(new StorageError({ message: "resolveTools boom", cause: undefined }))
        : Effect.succeed({
            tools: [{ name: ToolName.make("ping"), description: "ping" }],
            definitions: {},
          }),
    invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
    extension: (ctx) => ({
      seed: () => ctx.core.integrations.register({ slug: FLAKY, description: "Flaky", config: {} }),
      reviseConfig: (rev: number) => ctx.core.integrations.update(FLAKY, { config: { rev } }),
      setFail: (value: boolean) =>
        Effect.sync(() => {
          fail = value;
        }),
    }),
  }))();
};

describe("syncStaleConnectionTools", () => {
  it.effect(
    "skips the connection scan once synced at the current revision, re-scans on a new one",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeCountingExecutor({
          tenant: "wm-skip-tenant",
          subject: "wm-skip-subject",
          plugins: [demoPlugin] as const,
        });
        yield* harness.executor.demo.seed();
        yield* harness.executor.connections.create({
          owner: "org",
          name: CONN,
          integration: INTEG,
          template: TEMPLATE,
          from: { provider: ProviderKey.make("memory"), id: ProviderItemId.make("v") },
        });
        // Revise config so the freshly-created connection is now stale.
        yield* harness.executor.demo.reviseConfig(1);

        // First read converges: it scans connections and rebuilds the stale one.
        harness.reset();
        yield* harness.executor.tools.list();
        expect(harness.counts.connection ?? 0).toBeGreaterThanOrEqual(1);

        // Second read at the same watermark skips the connection scan entirely
        // (it still reads the integration watermark).
        harness.reset();
        yield* harness.executor.tools.list();
        expect(harness.counts.connection ?? 0).toBe(0);
        expect(harness.counts.integration ?? 0).toBeGreaterThanOrEqual(1);

        // A new revision moves the watermark and busts the cache: re-scan.
        yield* harness.executor.demo.reviseConfig(2);
        harness.reset();
        yield* harness.executor.tools.list();
        expect(harness.counts.connection ?? 0).toBeGreaterThanOrEqual(1);

        yield* harness.close();
      }),
  );

  it.effect("retries on the next read when a rebuild fails (does not cache failures)", () =>
    Effect.gen(function* () {
      const flaky = makeFlakyPlugin();
      const harness = yield* makeCountingExecutor({
        tenant: "wm-retry-tenant",
        subject: "wm-retry-subject",
        plugins: [flaky] as const,
      });
      yield* harness.executor.flaky.seed();
      yield* harness.executor.connections.create({
        owner: "org",
        name: CONN,
        integration: FLAKY,
        template: TEMPLATE,
        from: { provider: ProviderKey.make("memory"), id: ProviderItemId.make("v") },
      });

      // Make the next rebuild fail, then revise so the connection is stale.
      yield* harness.executor.flaky.setFail(true);
      yield* harness.executor.flaky.reviseConfig(1);

      // Two reads at the same watermark: both must scan (the failed rebuild is
      // never cached as synced).
      harness.reset();
      yield* harness.executor.tools.list();
      expect(harness.counts.connection ?? 0).toBeGreaterThanOrEqual(1);

      harness.reset();
      yield* harness.executor.tools.list();
      expect(harness.counts.connection ?? 0).toBeGreaterThanOrEqual(1);

      // Once it can succeed, the connection converges and the next read skips.
      yield* harness.executor.flaky.setFail(false);
      yield* harness.executor.tools.list();
      harness.reset();
      yield* harness.executor.tools.list();
      expect(harness.counts.connection ?? 0).toBe(0);

      yield* harness.close();
    }),
  );
});
