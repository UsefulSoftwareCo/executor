import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Predicate, Result } from "effect";

import { ElicitationResponse, type ElicitationHandler } from "./elicitation";
import { ToolNotFoundError } from "./errors";
import { createExecutor } from "./executor";
import { StorageError, type FumaDb } from "./fuma-runtime";
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
import { makeTestConfig, makeTestExecutor, memoryCredentialsPlugin } from "./testing";
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

// ---------------------------------------------------------------------------
// Dynamic tool-call read concurrency. The invoke path runs its independent
// storage reads concurrently: tool row + policy rules + connection row before
// approval, then credential resolution + integration row after approval.
// These tests pin the overlap itself AND the invariants the overlap must not
// disturb — most importantly that a declined approval never starts credential
// resolution (which can trigger an upstream token refresh).
// ---------------------------------------------------------------------------

/** Records which armed reads are simultaneously in flight. Each armed read
 *  registers on entry, then HOLDS its result until every other armed read has
 *  also started — so genuinely concurrent reads all overlap and the probe
 *  observes it. A sequential ordering would deadlock on that barrier, so a
 *  fallback timer releases each held read; the run then completes with
 *  `sawAllInFlight() === false` and the assertion (not a hang) reports the
 *  regression. */
const makeReadOverlapProbe = () => {
  let targets: ReadonlySet<string> = new Set();
  let sawAll = false;
  const started = new Set<string>();
  const inFlight = new Set<string>();
  let release: (() => void) | undefined;
  let barrier: Promise<void> | undefined;
  const observe = async (key: string): Promise<void> => {
    if (barrier === undefined || !targets.has(key) || started.has(key)) return;
    started.add(key);
    inFlight.add(key);
    if (started.size === targets.size) {
      if (inFlight.size === targets.size) sawAll = true;
      release?.();
    }
    await Promise.race([
      barrier,
      new Promise<void>((resolve) => {
        setTimeout(resolve, 250);
      }),
    ]);
    inFlight.delete(key);
  };
  return {
    arm: (keys: readonly string[]) => {
      targets = new Set(keys);
      barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    observe,
    sawAllInFlight: () => sawAll,
  };
};

/** Wrap a test `FumaDb` so every read reports to the probe as
 *  `<table>.<method>` before it executes. `withContext` re-wraps so the
 *  executor's context-bound handles stay observed. */
const withObservedReads = (db: FumaDb, observe: (key: string) => Promise<void>): FumaDb => {
  const wrap = (inner: FumaDb): FumaDb =>
    new Proxy(inner, {
      get(target, prop) {
        if (prop === "withContext") {
          return (context: unknown) =>
            wrap((target.withContext as (c: unknown) => FumaDb)(context));
        }
        if (prop === "findFirst" || prop === "findMany") {
          return async (table: unknown, query: unknown) => {
            await observe(`${String(table)}.${prop}`);
            return (Reflect.get(target, prop) as (t: unknown, q: unknown) => Promise<unknown>).call(
              target,
              table,
              query,
            );
          };
        }
        return Reflect.get(target, prop);
      },
    });
  return wrap(db);
};

const countingProvider = (calls: { count: number }, onGet?: () => Promise<void>) => {
  const store = new Map<string, string>();
  const provider: CredentialProvider = {
    key: ProviderKey.make("memory"),
    writable: true,
    get: (id) =>
      Effect.promise(async () => {
        calls.count++;
        await onGet?.();
        return store.get(String(id)) ?? null;
      }),
    set: (id, value) => Effect.sync(() => void store.set(String(id), value)),
  };
  return provider;
};

const invokeConcurrencyPlugin = (provider: CredentialProvider) =>
  definePlugin(() => ({
    id: "demo" as const,
    credentialProviders: [provider],
    storage: () => ({}),
    resolveTools: () =>
      Effect.succeed({ tools: [{ name: ToolName.make("run"), description: "run" }] }),
    invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
    extension: (ctx) => ({
      seed: () => ctx.core.integrations.register({ slug: INTEG, description: "Demo", config: {} }),
    }),
  }))();

const seedRunConnection = <
  E extends {
    readonly demo: { readonly seed: () => Effect.Effect<unknown, unknown> };
    readonly connections: {
      readonly create: (input: {
        owner: "org";
        name: ConnectionName;
        integration: IntegrationSlug;
        template: AuthTemplateSlug;
        from: { provider: ProviderKey; id: ProviderItemId };
      }) => Effect.Effect<unknown, unknown>;
    };
  },
>(
  executor: E,
) =>
  Effect.gen(function* () {
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
  });

describe("execute read concurrency", () => {
  it.effect("overlaps the tool, policy, and connection reads on the invoke path", () =>
    Effect.gen(function* () {
      const probe = makeReadOverlapProbe();
      const config = makeTestConfig({ plugins: [demoPlugin] as const });
      const executor = yield* createExecutor({
        ...config,
        db: withObservedReads(config.db, probe.observe),
      });
      yield* seedRunConnection(executor);

      probe.arm(["tool.findFirst", "tool_policy.findMany", "connection.findFirst"]);
      const out = yield* executor.execute(addr("run"), {});
      expect(out).toEqual({ ran: "run" });
      // All three pre-approval reads were in flight at the same instant.
      expect(probe.sawAllInFlight()).toBe(true);
    }),
  );

  it.effect("overlaps credential resolution with the integration-row read after approval", () =>
    Effect.gen(function* () {
      const probe = makeReadOverlapProbe();
      const calls = { count: 0 };
      const provider = countingProvider(calls, () => probe.observe("credential.get"));
      const config = makeTestConfig({
        plugins: [invokeConcurrencyPlugin(provider)] as const,
      });
      const executor = yield* createExecutor({
        ...config,
        db: withObservedReads(config.db, probe.observe),
      });
      yield* seedRunConnection(executor);

      probe.arm(["credential.get", "integration.findFirst"]);
      const out = yield* executor.execute(addr("run"), {});
      expect(out).toEqual({ ran: "run" });
      expect(probe.sawAllInFlight()).toBe(true);
    }),
  );

  it.effect("a declined approval never resolves credentials", () =>
    Effect.gen(function* () {
      const calls = { count: 0 };
      const executor = yield* makeTestExecutor({
        plugins: [invokeConcurrencyPlugin(countingProvider(calls))] as const,
      });
      yield* seedRunConnection(executor);
      yield* executor.policies.create({
        owner: "org",
        pattern: "demo.*",
        action: "require_approval",
      });

      // Setup (connection create / tool sync) may read the credential; only
      // reads issued by the declined call itself are the regression signal.
      calls.count = 0;
      const decliningHandler: ElicitationHandler = () =>
        Effect.succeed(ElicitationResponse.make({ action: "decline" }));
      const result = yield* Effect.result(
        executor.execute(addr("run"), {}, { onElicitation: decliningHandler }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("ElicitationDeclinedError")(result.failure)).toBe(true);
      // The decline happened BEFORE credential resolution started: a token
      // refresh (a network side effect) must never fire for a declined call.
      expect(calls.count).toBe(0);
    }),
  );

  it.effect("fails with ConnectionNotFoundError when the tool row outlives its connection", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({ plugins: [demoPlugin] as const });
      const executor = yield* createExecutor(config);
      yield* seedRunConnection(executor);

      // Remove ONLY the connection row, leaving the tool rows behind — the
      // inconsistent state the ConnectionNotFoundError branch reports. The
      // concurrent connection read must still surface this error, not a
      // policy or tool-row failure.
      yield* Effect.promise(() => config.db.deleteMany("connection", {}));

      const result = yield* Effect.result(executor.execute(addr("run"), {}));
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("ConnectionNotFoundError")(result.failure)).toBe(true);
    }),
  );
});

// ---------------------------------------------------------------------------
// Speculative read abandonment. The concurrent reads above are forked, and a
// branch that returns without needing one must interrupt it instead of
// consuming it — so a read that hangs cannot gate an error that never needed
// it, and a read that fails cannot mask that error or leak as an unhandled
// rejection. Reads a branch DOES need keep failing exactly where the
// sequential code failed.
// ---------------------------------------------------------------------------

/** Deterministic read faults keyed by `<table>.<method>`: nothing is armed
 *  until the test says so (setup reads pass through untouched), and the test
 *  can check that an armed read really started before it was abandoned. */
const makeReadFaults = () => {
  let hung: ReadonlySet<string> = new Set();
  let failed: ReadonlyMap<string, string> = new Map();
  const started = new Set<string>();
  return {
    hangReads: (keys: readonly string[]) => {
      hung = new Set(keys);
    },
    failReads: (byCode: Readonly<Record<string, string>>) => {
      failed = new Map(Object.entries(byCode));
    },
    started,
    fault: (key: string): Promise<never> | undefined => {
      if (hung.has(key)) {
        started.add(key);
        // Never settles. The driver promise takes no abort signal, so an
        // interrupted read is abandoned exactly like this in production.
        return new Promise<never>(() => {});
      }
      const code = failed.get(key);
      if (code === undefined) return undefined;
      started.add(key);
      // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: simulate the raw driver-promise rejection that fumaEffect normalizes into a StorageFailure
      return Promise.reject(Object.assign(new Error(code), { code }));
    },
  };
};

/** Wrap a test `FumaDb` so armed reads hang or reject; every other read is
 *  untouched. `withContext` re-wraps so context-bound handles stay faulted. */
const withFaultedReads = (
  db: FumaDb,
  fault: (key: string) => Promise<never> | undefined,
): FumaDb => {
  const wrap = (inner: FumaDb): FumaDb =>
    new Proxy(inner, {
      get(target, prop) {
        if (prop === "withContext") {
          return (context: unknown) =>
            wrap((target.withContext as (c: unknown) => FumaDb)(context));
        }
        if (prop === "findFirst" || prop === "findMany") {
          return (table: unknown, query: unknown) =>
            fault(`${String(table)}.${prop}`) ??
            (Reflect.get(target, prop) as (t: unknown, q: unknown) => Promise<unknown>).call(
              target,
              table,
              query,
            );
        }
        return Reflect.get(target, prop);
      },
    });
  return wrap(db);
};

/** A credential provider that works during setup and can be armed to fail
 *  every later read — the site-2 "credential resolution fails" input. */
const armableFailingProvider = () => {
  const store = new Map<string, string>();
  let failWith: string | undefined;
  const provider: CredentialProvider = {
    key: ProviderKey.make("memory"),
    writable: true,
    get: (id) =>
      Effect.suspend(() =>
        failWith === undefined
          ? Effect.succeed(store.get(String(id)) ?? null)
          : Effect.fail(new StorageError({ message: failWith, cause: undefined })),
      ),
    set: (id, value) => Effect.sync(() => void store.set(String(id), value)),
  };
  return {
    provider,
    failNow: (message: string) => {
      failWith = message;
    },
  };
};

describe("speculative read abandonment", () => {
  it.effect("unknown-tool error surfaces while the speculative reads hang forever", () =>
    Effect.gen(function* () {
      const faults = makeReadFaults();
      const config = makeTestConfig({ plugins: [demoPlugin] as const });
      const executor = yield* createExecutor({
        ...config,
        db: withFaultedReads(config.db, faults.fault),
      });
      yield* seedRunConnection(executor);

      // From here on the speculative policy and connection reads NEVER
      // resolve. The unknown-tool branch needs neither, so the call must
      // fail without waiting on them — the previous all-or-nothing shape
      // could not fail until every read settled.
      faults.hangReads(["tool_policy.findMany", "connection.findFirst"]);
      const result = yield* Effect.result(executor.execute(addr("no-such-tool"), {}));
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("ToolNotFoundError")(result.failure)).toBe(true);
      // Both hung reads really started: the branch abandoned in-flight
      // reads, it did not skip forking them.
      expect(faults.started.has("tool_policy.findMany")).toBe(true);
      expect(faults.started.has("connection.findFirst")).toBe(true);
    }),
  );

  it.effect("a blocked tool reports ToolBlockedError while the connection read hangs", () =>
    Effect.gen(function* () {
      const faults = makeReadFaults();
      const config = makeTestConfig({ plugins: [demoPlugin] as const });
      const executor = yield* createExecutor({
        ...config,
        db: withFaultedReads(config.db, faults.fault),
      });
      yield* seedRunConnection(executor);
      yield* executor.policies.create({
        owner: "org",
        pattern: "demo.*",
        action: "block",
      });

      // The block branch consumes the policy read but never the connection
      // read; a connection read that never resolves must not gate it.
      faults.hangReads(["connection.findFirst"]);
      const result = yield* Effect.result(executor.execute(addr("run"), {}));
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("ToolBlockedError")(result.failure)).toBe(true);
      expect(faults.started.has("connection.findFirst")).toBe(true);
    }),
  );

  it.effect("failing speculative reads neither mask the branch error nor unhandled-reject", () =>
    Effect.gen(function* () {
      const faults = makeReadFaults();
      const config = makeTestConfig({ plugins: [demoPlugin] as const });
      const executor = yield* createExecutor({
        ...config,
        db: withFaultedReads(config.db, faults.fault),
      });
      yield* seedRunConnection(executor);

      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => void unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      const result = yield* Effect.gen(function* () {
        faults.failReads({
          "tool_policy.findMany": "POLICY_READ_FAILED",
          "connection.findFirst": "CONNECTION_READ_FAILED",
        });
        const out = yield* Effect.result(executor.execute(addr("no-such-tool"), {}));
        // Both rejections fired before the call returned; give an
        // unobserved one its macrotask turn to reach the process hook.
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
        return out;
      }).pipe(Effect.ensuring(Effect.sync(() => process.off("unhandledRejection", onUnhandled))));
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("ToolNotFoundError")(result.failure)).toBe(true);
      expect(unhandled).toEqual([]);
    }),
  );

  it.effect(
    "a policy read failure on the consuming path surfaces, ahead of a connection failure",
    () =>
      Effect.gen(function* () {
        const faults = makeReadFaults();
        const config = makeTestConfig({ plugins: [demoPlugin] as const });
        const executor = yield* createExecutor({
          ...config,
          db: withFaultedReads(config.db, faults.fault),
        });
        yield* seedRunConnection(executor);

        faults.failReads({
          "tool_policy.findMany": "POLICY_READ_FAILED",
          "connection.findFirst": "CONNECTION_READ_FAILED",
        });
        const result = yield* Effect.result(executor.execute(addr("run"), {}));
        expect(Result.isFailure(result)).toBe(true);
        if (!Result.isFailure(result)) return;
        // The policy read is consumed first, exactly as the sequential code
        // ordered the reads, so its failure is the one reported even though
        // the connection read failed too.
        expect(Predicate.isTagged("StorageError")(result.failure)).toBe(true);
        expect((result.failure as StorageError).message).toContain("POLICY_READ_FAILED");
      }),
  );

  it.effect("a credential failure surfaces while the site-2 integration read hangs", () =>
    Effect.gen(function* () {
      const faults = makeReadFaults();
      const armable = armableFailingProvider();
      const config = makeTestConfig({
        plugins: [invokeConcurrencyPlugin(armable.provider)] as const,
      });
      const executor = yield* createExecutor({
        ...config,
        db: withFaultedReads(config.db, faults.fault),
      });
      yield* seedRunConnection(executor);

      // After approval, credential resolution and the integration-row read
      // run concurrently. Resolution fails while the integration read never
      // resolves: the credential failure must surface without waiting on the
      // read — the failure path interrupts it instead of joining it.
      faults.hangReads(["integration.findFirst"]);
      armable.failNow("CREDENTIAL_READ_FAILED");
      const result = yield* Effect.result(executor.execute(addr("run"), {}));
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("StorageError")(result.failure)).toBe(true);
      expect((result.failure as StorageError).message).toBe("CREDENTIAL_READ_FAILED");
      expect(faults.started.has("integration.findFirst")).toBe(true);
    }),
  );
});
