import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeMcpBuildServer, makeScopedExecutor } from "@executor-js/api/server";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug, type Executor } from "@executor-js/sdk";
import type { Principal } from "@executor-js/host-mcp";
import { createSelfHostDb, SelfHostDb, type SelfHostDbHandle } from "../db/self-host-db";
import { SelfHostExecutionStackLayer, SelfHostScopedExecutorSeams } from "../execution";
import type { SelfHostPlugins } from "../plugins";

const dataDir = mkdtempSync(join(tmpdir(), "executor-session-init-"));
const originalDataDir = process.env.EXECUTOR_DATA_DIR;
process.env.EXECUTOR_DATA_DIR = dataDir;
let db: SelfHostDbHandle;
let seed: Executor<SelfHostPlugins>;
const principal: Principal = {
  accountId: "alice",
  organizationId: "session-test",
  organizationName: "Session test",
  email: "alice@example.test",
  name: "Alice",
  avatarUrl: null,
  roles: ["user"],
  orgRoleModel: "organization",
};
const spec = (operationId: string) =>
  JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Session fixture", version: "1" },
    servers: [{ url: "https://fixture.example.test" }],
    paths: { "/read": { get: { operationId, responses: { "200": { description: "ok" } } } } },
  });

beforeAll(async () => {
  db = await createSelfHostDb({ path: join(dataDir, "data.db") });
  seed = await Effect.runPromise(
    makeScopedExecutor<SelfHostPlugins>(
      principal.accountId,
      principal.organizationId,
      principal.organizationName,
    ).pipe(Effect.provide(SelfHostScopedExecutorSeams), Effect.provideService(SelfHostDb, db)),
  );
  await Effect.runPromise(
    seed.openapi.addSpec({ spec: { kind: "blob", value: spec("readFirst") }, slug: "fixture" }),
  );
  await Effect.runPromise(
    seed.connections.create({
      owner: "org",
      name: ConnectionName.make("shared"),
      integration: IntegrationSlug.make("fixture"),
      template: AuthTemplateSlug.make("none"),
      value: "",
    }),
  );
});

afterAll(async () => {
  if (seed) await Effect.runPromise(seed.close());
  await db?.close();
  if (originalDataDir === undefined) delete process.env.EXECUTOR_DATA_DIR;
  else process.env.EXECUTOR_DATA_DIR = originalDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const withSession = async (binding: Principal, check: (client: Client) => Promise<void>) => {
  const built = await Effect.runPromise(
    makeMcpBuildServer(
      SelfHostExecutionStackLayer.pipe(Layer.provide(Layer.succeed(SelfHostDb)(db))),
    )(binding, { mode: "passthrough", artifactsEnabled: false }),
  );
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "session-test", version: "1" }, { capabilities: {} });
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: MCP test cleanup must run after client assertion failures
  try {
    await built.mcpServer.connect(st);
    await client.connect(ct);
    await check(client);
  } finally {
    await client.close();
    await built.mcpServer.close();
    await Effect.runPromise(built.engine.shutdown);
    await Effect.runPromise(built.executor!.close());
  }
};

const searchIds = async (client: Client): Promise<readonly string[]> => {
  const result = await client.callTool({
    name: "search",
    arguments: { query: "read", integration: "fixture", limit: 10 },
  });
  expect(result.isError).not.toBe(true);
  const output = result.structuredContent as { items: readonly { id: string }[] };
  return output.items.map((item) => item.id);
};

test("session key reuse keeps policy revocation, catalog changes, and tenant binding current", async () => {
  const first = "tools.fixture.org.shared.read.readFirst";
  await withSession(principal, async (client) => {
    expect(await searchIds(client)).toEqual([first]);
    const block = await Effect.runPromise(
      seed.policies.create({
        owner: "org",
        pattern: "fixture.org.shared.read.readFirst",
        action: "block",
      }),
    );
    expect(await searchIds(client)).toEqual([]);
    await withSession(principal, async (fresh) => {
      expect(await searchIds(fresh)).toEqual([]);
    });
    await Effect.runPromise(seed.policies.remove({ owner: "org", id: block.id }));
    expect(await searchIds(client)).toEqual([first]);
    await Effect.runPromise(
      seed.openapi.updateSpec(IntegrationSlug.make("fixture"), {
        spec: { kind: "blob", value: spec("readNext") },
      }),
    );
    const next = "tools.fixture.org.shared.read.readNext";
    expect(await searchIds(client)).toEqual([next]);
    await withSession(principal, async (fresh) => {
      expect(await searchIds(fresh)).toEqual([next]);
    });
    await withSession({ ...principal, organizationId: "other-tenant" }, async (other) => {
      expect(await searchIds(other)).toEqual([]);
    });
    await Effect.runPromise(seed.integrations.remove(IntegrationSlug.make("fixture")));
    expect(await searchIds(client)).toEqual([]);
    await withSession(principal, async (fresh) => {
      expect(await searchIds(fresh)).toEqual([]);
    });
  });
});
