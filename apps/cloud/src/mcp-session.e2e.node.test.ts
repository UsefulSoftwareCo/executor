// End-to-end coverage for the cloud MCP server.
//
// The `McpSessionDO` in mcp-session.ts wires several things that previously
// had zero integration coverage:
//   - a per-request executor bound to `{ tenant, subject }` against a real
//     FumaDB/Drizzle handle (the 2026-04-16 prod outage was a schema spread bug
//     here; see db/db.schema.test.ts)
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
import { Effect, Schema } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";

import { createExecutorMcpServer } from "@executor-js/host-mcp/tool-server";
import { createExecutionEngine } from "@executor-js/execution";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { collectTables } from "@executor-js/api/server";
import {
  ElicitationResponse,
  FormElicitation,
  Subject,
  Tenant,
  createExecutor,
  definePlugin,
} from "@executor-js/sdk";
import { FetchHttpClient } from "effect/unstable/http";
import { makeTestWorkOSVaultClient } from "@executor-js/plugin-workos-vault/testing";
import executorConfig from "../executor.config";
import { DbService } from "./db/db";
import { createDrizzleFumaDb } from "./db/fuma";

// ---------------------------------------------------------------------------
// Test-only plugin: exposes one in-memory tool that elicits once. Lets the
// eliciting test drive the real engine + sandbox rather than a stub engine.
// ---------------------------------------------------------------------------

const EMPTY_INPUT_SCHEMA = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(Schema.Struct({})),
);

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
                FormElicitation.make({
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

type BuildOptions = {
  readonly withElicitingPlugin?: boolean;
  readonly elicitationMode?: "model" | "native";
};

const buildScopedExecutor = (
  organizationId: string,
  _organizationName: string,
  options: BuildOptions = {},
) =>
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const basePlugins = executorConfig.plugins({
      workosVaultClient: makeTestWorkOSVaultClient(),
    });
    const plugins = options.withElicitingPlugin
      ? ([...basePlugins, elicitingTestPlugin()] as const)
      : basePlugins;
    const fuma = createDrizzleFumaDb({
      db,
      tables: collectTables(),
      namespace: "executor_cloud",
      provider: "postgresql",
    });
    return yield* createExecutor({
      tenant: Tenant.make(organizationId),
      subject: Subject.make(`user_${organizationId}`),
      db: fuma.db,
      plugins,
      httpClientLayer: FetchHttpClient.layer,
      onElicitation: "accept-all",
    });
  });

// Builds a scope, wires a real execution engine + MCP server, and yields
// them connected to an in-memory MCP client. Shaped as an acquireRelease so
// the transport teardown is guaranteed when the test scope closes.
const openSession = (
  organizationId: string,
  options: BuildOptions & { readonly caps?: ClientCapabilities } = {},
) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const executor = yield* buildScopedExecutor(organizationId, `Org ${organizationId}`, options);
      const engine = createExecutionEngine({ executor, codeExecutor: makeQuickJsExecutor() });
      const mcpServer = yield* createExecutorMcpServer({
        engine,
        elicitationMode: options.elicitationMode ? { mode: options.elicitationMode } : undefined,
      });
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
  // thrown at `executor.integrations.list()` when the MCP session's drizzle
  // instance lost the executor-schema tables.
  it.effect("exercises the drizzle adapter directly via executor.integrations.list", () =>
    Effect.gen(function* () {
      const executor = yield* buildScopedExecutor(nextOrgId(), "drizzle-probe");
      const integrations = yield* executor.integrations.list();
      expect(Array.isArray(integrations)).toBe(true);
    }).pipe(Effect.provide(DbService.Live), Effect.scoped),
  );

  it.effect("bridges a form elicitation from engine to client and back", () =>
    Effect.gen(function* () {
      const { client } = yield* openSession(nextOrgId(), {
        withElicitingPlugin: true,
        elicitationMode: "native",
      });

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
