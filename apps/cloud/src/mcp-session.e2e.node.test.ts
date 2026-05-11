// End-to-end coverage for the cloud MCP server.
//
// The `McpSessionDO` in mcp-session.ts wires several things that previously
// had zero integration coverage:
//   - `createScopedExecutor` against a real drizzle adapter (the 2026-04-16
//     prod outage was a schema spread bug here; see services/db.schema.test.ts)
//   - `createExecutionEngine` with an in-process code executor
//   - `createExecutorMcpServer` for the MCP request surface
//   - Real `@modelcontextprotocol/sdk` Client → server round-trips
//
// This test replicates the DO's init path (minus the WorkerTransport and
// Durable Object routing, which are thin CF plumbing) and drives it with a
// real MCP Client over in-memory transports. If any of the wiring drifts —
// schema, plugin list, engine contract, MCP handshake — these tests fail
// before prod does.

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";

import { createExecutorMcpServer } from "@executor-js/host-mcp";
import { createExecutionEngine } from "@executor-js/execution";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import {
  ElicitationResponse,
  FormElicitation,
  Scope,
  ScopeId,
  collectSchemas,
  createExecutor,
  definePlugin,
} from "@executor-js/sdk";
import { FetchHttpClient } from "effect/unstable/http";
import { makePostgresAdapter, makePostgresBlobStore } from "@executor-js/storage-postgres";
import { makeTestWorkOSVaultClient } from "@executor-js/plugin-workos-vault/testing";
import executorConfig from "../executor.config";
import { DbService } from "./services/db";

// ---------------------------------------------------------------------------
// Test-only plugin: exposes one in-memory tool that elicits once. Lets the
// eliciting test drive the real engine + sandbox rather than a stub engine.
// ---------------------------------------------------------------------------

const EMPTY_INPUT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const elicitingTestPlugin = definePlugin(() => ({
  id: "eliciting-test" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "e2e",
      kind: "in-memory",
      name: "E2E Test",
      tools: [
        {
          name: "needsApproval",
          description: "Tool that asks the caller to approve before returning.",
          inputSchema: EMPTY_INPUT_SCHEMA,
          handler: ({
            elicit,
          }: {
            elicit: (r: FormElicitation) => Effect.Effect<typeof ElicitationResponse.Type, unknown>;
          }) =>
            Effect.gen(function* () {
              const response = yield* elicit(
                new FormElicitation({
                  message: "Approve?",
                  requestedSchema: {
                    type: "object",
                    properties: { approved: { type: "boolean" } },
                  },
                }),
              );
              return { action: response.action, content: response.content ?? null };
            }).pipe(Effect.orDie),
        },
      ],
    },
  ],
}));

// ---------------------------------------------------------------------------
// Session harness — mirrors McpSessionDO.init() minus the WorkerTransport
// ---------------------------------------------------------------------------

const ELICITATION_CAPS: ClientCapabilities = {
  elicitation: { form: {}, url: {} },
};

type BuildOptions = { readonly withElicitingPlugin?: boolean };

const buildScopedExecutor = (scopeId: string, scopeName: string, options: BuildOptions = {}) =>
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const basePlugins = executorConfig.plugins({
      workosVaultClient: makeTestWorkOSVaultClient(),
    });
    const plugins = options.withElicitingPlugin
      ? ([...basePlugins, elicitingTestPlugin()] as const)
      : basePlugins;
    const schema = collectSchemas(plugins);
    const adapter = makePostgresAdapter({ db, schema });
    const blobs = makePostgresBlobStore({ db });
    const scope = new Scope({
      id: ScopeId.make(scopeId),
      name: scopeName,
      createdAt: new Date(),
    });
    return yield* createExecutor({
      scopes: [scope],
      adapter,
      blobs,
      plugins,
      httpClientLayer: FetchHttpClient.layer,
      onElicitation: "accept-all",
    });
  });

// Builds a scope, wires a real execution engine + MCP server, and yields
// them connected to an in-memory MCP client. Shaped as an acquireRelease so
// the transport teardown is guaranteed when the test scope closes.
const openSession = (
  orgId: string,
  options: BuildOptions & { readonly caps?: ClientCapabilities } = {},
) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const executor = yield* buildScopedExecutor(orgId, `Org ${orgId}`, options);
      const engine = createExecutionEngine({ executor, codeExecutor: makeQuickJsExecutor() });
      const mcpServer = yield* createExecutorMcpServer({ engine });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client(
        { name: "cloud-e2e-test", version: "1.0.0" },
        { capabilities: options.caps ?? ELICITATION_CAPS },
      );
      yield* Effect.promise(() => mcpServer.connect(serverTransport));
      yield* Effect.promise(() => client.connect(clientTransport));
      return { client, clientTransport, serverTransport };
    }),
    ({ clientTransport, serverTransport }) =>
      Effect.all(
        [
          Effect.tryPromise({
            try: () => clientTransport.close(),
            catch: (cause) => cause,
          }).pipe(Effect.ignore),
          Effect.tryPromise({
            try: () => serverTransport.close(),
            catch: (cause) => cause,
          }).pipe(Effect.ignore),
        ],
        { discard: true },
      ),
  ).pipe(Effect.map(({ client }) => ({ client })));

const nextOrgId = (() => {
  let seq = 0;
  return () => `org_mcp_e2e_${++seq}_${crypto.randomUUID().slice(0, 8)}`;
})();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cloud MCP session end-to-end", () => {
  it.effect("initializes and exposes the execute tool to the MCP client", () =>
    Effect.gen(function* () {
      const { client } = yield* openSession(nextOrgId());
      const tools = yield* Effect.promise(() => client.listTools());
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain("execute");
    }).pipe(Effect.provide(DbService.Live), Effect.scoped),
  );

  it.effect("runs user code via the execute tool end-to-end", () =>
    Effect.gen(function* () {
      const { client } = yield* openSession(nextOrgId());
      const result = yield* Effect.promise(() =>
        client.callTool({ name: "execute", arguments: { code: "return 1 + 2" } }),
      );
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("3");
    }).pipe(Effect.provide(DbService.Live), Effect.scoped),
  );

  // Isolates the drizzle adapter path so a schema spread drift surfaces as
  // a raw "unknown model" error. The prod outage on 2026-04-16 would have
  // thrown at `executor.sources.list()` when the MCP session's drizzle
  // instance lost the executor-schema tables.
  it.effect("exercises the drizzle adapter directly via executor.sources.list", () =>
    Effect.gen(function* () {
      const executor = yield* buildScopedExecutor(nextOrgId(), "drizzle-probe");
      const sources = yield* executor.sources.list();
      expect(Array.isArray(sources)).toBe(true);
    }).pipe(Effect.provide(DbService.Live), Effect.scoped),
  );

  it.effect("bridges a form elicitation from engine to client and back", () =>
    Effect.gen(function* () {
      const { client } = yield* openSession(nextOrgId(), { withElicitingPlugin: true });

      client.setRequestHandler(ElicitRequestSchema, async () => ({
        action: "accept" as const,
        content: { approved: true },
      }));

      const result = yield* Effect.promise(() =>
        client.callTool({
          name: "execute",
          arguments: { code: "return await tools.e2e.needsApproval({});" },
        }),
      );
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("accept");
      expect(text).toContain("approved");
    }).pipe(Effect.provide(DbService.Live), Effect.scoped),
  );
});
