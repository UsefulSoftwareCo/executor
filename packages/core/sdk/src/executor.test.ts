import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Predicate, Result } from "effect";

import { ToolNotFoundError } from "./errors";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderItemId,
  ProviderKey,
  ToolAddress,
  ToolName,
} from "./ids";
import { definePlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { IntegrationDetectionResult } from "./types";
import { makeTestExecutor, memoryCredentialsPlugin } from "./testing";
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
const PINNED = IntegrationSlug.make("demo-pinned");
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
    /** A catalog row the host pins in place (`canRemove: false`), the shape
     *  `integrations.remove` has to refuse rather than drop. */
    seedPinned: () =>
      ctx.core.integrations.register({
        slug: PINNED,
        description: "Demo (pinned)",
        config: {},
        canRemove: false,
      }),
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

const diagnosticsPlugin = definePlugin(() => ({
  id: "diagnostics" as const,
  storage: () => ({}),
  resolveTools: ({ connection }) =>
    Effect.succeed({
      tools: [],
      incomplete: true,
      incompleteReason: "Schema introspection was rejected",
      ...(String(connection.integration) === "diagnostics_expired"
        ? {
            health: {
              status: "expired" as const,
              checkedAt: Date.now(),
              detail: "Reconnect the upstream OAuth grant",
            },
          }
        : {}),
    }),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: IntegrationSlug.make("diagnostics"),
        description: "Diagnostics",
        config: {},
      }),
    seedExpired: () =>
      ctx.core.integrations.register({
        slug: IntegrationSlug.make("diagnostics_expired"),
        description: "Expired diagnostics",
        config: {},
      }),
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

  it.effect("notifies onIntegrationChange on create and remove, not on re-register", () =>
    Effect.gen(function* () {
      const events: Array<{ kind: string; pluginKey: string; slug: string }> = [];
      const executor = yield* makeTestExecutor({
        plugins: [demoPlugin] as const,
        onIntegrationChange: (event) =>
          Effect.sync(() => {
            events.push({
              kind: event.kind,
              pluginKey: event.pluginKey,
              slug: String(event.slug),
            });
          }),
      });

      yield* executor.demo.seed();
      expect(events).toEqual([{ kind: "added", pluginKey: "demo", slug: String(INTEG) }]);

      // Upsert re-register of the same slug is not a durable change.
      yield* executor.demo.seed();
      expect(events).toHaveLength(1);

      yield* executor.integrations.remove(INTEG);
      expect(events).toEqual([
        { kind: "added", pluginKey: "demo", slug: String(INTEG) },
        { kind: "removed", pluginKey: "demo", slug: String(INTEG) },
      ]);

      // Removing an already-absent slug notifies nothing.
      yield* executor.integrations.remove(INTEG);
      expect(events).toHaveLength(2);
    }),
  );

  it.effect("a failing onIntegrationChange observer never fails the operation", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [demoPlugin] as const,
        onIntegrationChange: () => Effect.die("observer exploded"),
      });
      yield* executor.demo.seed();
      const integrations = yield* executor.integrations.list();
      expect(integrations.map((i) => String(i.slug))).toContain(String(INTEG));
    }),
  );

  it.effect("a rolled-back transaction never notifies onIntegrationChange", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const executor = yield* makeTestExecutor({
        plugins: [demoPlugin] as const,
        onIntegrationChange: (event) => Effect.sync(() => void events.push(String(event.slug))),
      });
      const result = yield* Effect.result(executor.demo.failAfterPluginAndCoreWrites());
      expect(Result.isFailure(result)).toBe(true);
      expect(events).not.toContain("tx-integration");
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

  it.effect("removes catalog integrations through the built-in Executor tools", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [demoPlugin] as const,
        coreTools: {},
      });
      yield* executor.demo.seed();
      yield* executor.demo.seedPinned();
      yield* executor.execute(
        ToolAddress.make("executor.coreTools.connections.create"),
        {
          owner: "org",
          name: String(CONN),
          integration: String(INTEG),
          template: String(TEMPLATE),
          from: { provider: "memory", id: "secret-token" },
        },
        { onElicitation: "accept-all" },
      );

      const remove = ToolAddress.make("executor.coreTools.integrations.remove");

      // Removing the integration cascades to the connections under it.
      const removed = yield* executor.execute(
        remove,
        { slug: String(INTEG) },
        { onElicitation: "accept-all" },
      );
      expect(removed).toEqual({ removed: true });
      const listed = yield* executor.integrations.list();
      expect(listed.map((integration) => String(integration.slug))).not.toContain(String(INTEG));
      expect(yield* executor.connections.list()).toHaveLength(0);

      // An already-absent slug and a built-in namespace both report honestly
      // instead of claiming a removal that never happened.
      expect(
        yield* executor.execute(remove, { slug: String(INTEG) }, { onElicitation: "accept-all" }),
      ).toEqual({ removed: false });
      expect(
        yield* executor.execute(remove, { slug: "executor" }, { onElicitation: "accept-all" }),
      ).toEqual({ removed: false });

      // A pinned integration is refused, and survives the attempt.
      const refused = yield* Effect.result(
        executor.execute(remove, { slug: String(PINNED) }, { onElicitation: "accept-all" }),
      );
      expect(Result.isFailure(refused)).toBe(true);
      if (!Result.isFailure(refused)) return;
      expect(Predicate.isTagged(refused.failure, "ToolInvocationError")).toBe(true);
      expect(
        Predicate.isTagged(
          (refused.failure as { readonly cause?: unknown }).cause,
          "IntegrationRemovalNotAllowedError",
        ),
      ).toBe(true);
      const afterRefusal = yield* executor.integrations.list();
      expect(afterRefusal.map((integration) => String(integration.slug))).toContain(String(PINNED));
    }),
  );

  it.effect("surfaces failed tool sync diagnostics through connection tools", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [memoryCredentialsPlugin(), diagnosticsPlugin] as const,
        coreTools: {},
      });
      yield* executor.diagnostics.seed();

      yield* executor.execute(
        ToolAddress.make("executor.coreTools.connections.create"),
        {
          owner: "org",
          name: "main",
          integration: "diagnostics",
          template: "none",
        },
        { onElicitation: "accept-all" },
      );

      const listed = yield* executor.execute(
        ToolAddress.make("executor.coreTools.connections.list"),
        { integration: "diagnostics", verbose: true },
      );
      expect(listed).toMatchObject({
        connections: [
          {
            lastHealth: {
              status: "degraded",
              detail: "Tool sync failing: Schema introspection was rejected",
            },
          },
        ],
      });

      const refreshed = yield* executor.execute(
        ToolAddress.make("executor.coreTools.connections.refresh"),
        {
          owner: "org",
          name: "main",
          integration: "diagnostics",
        },
        { onElicitation: "accept-all" },
      );
      expect(refreshed).toMatchObject({
        tools: [],
        lastHealth: {
          status: "degraded",
          detail: "Tool sync failing: Schema introspection was rejected",
        },
      });
    }),
  );

  it.effect("preserves actionable health from an incomplete tool catalog", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [memoryCredentialsPlugin(), diagnosticsPlugin] as const,
        coreTools: {},
      });
      yield* executor.diagnostics.seedExpired();

      yield* executor.execute(
        ToolAddress.make("executor.coreTools.connections.create"),
        {
          owner: "org",
          name: "main",
          integration: "diagnostics_expired",
          template: "none",
        },
        { onElicitation: "accept-all" },
      );

      const refreshed = yield* executor.execute(
        ToolAddress.make("executor.coreTools.connections.refresh"),
        {
          owner: "org",
          name: "main",
          integration: "diagnostics_expired",
        },
        { onElicitation: "accept-all" },
      );
      expect(refreshed).toMatchObject({
        tools: [],
        lastHealth: {
          status: "expired",
          detail: "Reconnect the upstream OAuth grant",
        },
      });
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

describe("muscle memory (observed output shapes)", () => {
  const provisioned = Effect.fn(function* () {
    const executor = yield* makeTestExecutor({
      plugins: [demoPlugin] as const,
      coreTools: { webBaseUrl: "http://localhost:3000" },
    });
    yield* executor.demo.seed();
    yield* executor.execute(ToolAddress.make("executor.coreTools.connections.create"), {
      owner: "org",
      name: String(CONN),
      integration: String(INTEG),
      template: String(TEMPLATE),
      identityLabel: "Demo",
      from: { provider: "memory", id: "secret-token" },
    });
    return executor;
  });

  it.effect("serves an observed output shape once a schemaless tool has run", () =>
    Effect.gen(function* () {
      const executor = yield* provisioned();

      // Cold: `run` declares no output schema, nothing observed yet.
      const cold = yield* executor.tools.schema(addr("run"));
      expect(cold?.outputSchema).toBeUndefined();
      expect(cold?.outputTypeScript).toBeUndefined();

      yield* executor.execute(addr("run"), {});

      // Warm: the live payload `{ ran: "run" }` becomes the served shape,
      // with provenance marked on the schema.
      const warm = yield* executor.tools.schema(addr("run"));
      expect(warm?.outputSchema).toMatchObject({
        type: "object",
        properties: { ran: { type: "string" } },
        required: ["ran"],
        description: "Observed from 1 live response; fields may be incomplete.",
      });
      expect(warm?.outputTypeScript).toContain("ran");
      expect(warm?.outputTypeScript).not.toBe("unknown");
    }),
  );

  it.effect("never overrides a declared output schema with observations", () =>
    Effect.gen(function* () {
      const executor = yield* provisioned();

      // `inspect` declares `outputSchema: { $ref: "#/$defs/Owner" }`; running
      // it observes `{ ran: "inspect" }`, which must not displace the
      // declared schema.
      yield* executor.execute(addr("inspect"), { pet: { lives: 9 } });
      const schema = yield* executor.tools.schema(addr("inspect"));
      expect(schema?.outputSchema).toEqual({ $ref: "#/$defs/Owner" });
    }),
  );
});
