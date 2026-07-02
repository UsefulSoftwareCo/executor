import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";
import { afterAll, expect, test } from "@effect/vitest";

import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk";
import { makeScopedExecutor } from "@executor-js/api/server";

import { createSelfHostDb, SelfHostDb } from "./db/self-host-db";
import { SelfHostScopedExecutorSeams } from "./execution";
import type { SelfHostPlugins } from "./plugins";

// The self-host scoped-executor seams (DbProvider over the long-lived SelfHostDb,
// fresh per-request plugins, host config) over the shared `makeScopedExecutor`,
// leaving `SelfHostDb` as the only requirement (the production path provides the
// same seams via `SelfHostExecutionStackLayer`).
const createScopedExecutor = (
  accountId: string,
  organizationId: string,
  organizationName: string,
) =>
  makeScopedExecutor<SelfHostPlugins>(accountId, organizationId, organizationName).pipe(
    Effect.provide(SelfHostScopedExecutorSeams),
  );

const dataDir = mkdtempSync(join(tmpdir(), "eh-src-"));
process.env.EXECUTOR_DATA_DIR = dataDir;

const dbHandle = await createSelfHostDb({
  path: join(dataDir, "data.db"),
  namespace: "executor_selfhost",
  version: "1.0.0",
});
const dbLayer = Layer.succeed(SelfHostDb)(dbHandle);
afterAll(() => dbHandle.close());

// Inline OpenAPI spec so the test doesn't depend on the network to register.
const TINY_SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Tiny", version: "1.0.0" },
  servers: [{ url: "https://httpbin.org" }],
  paths: {
    "/get": {
      get: {
        operationId: "httpGet",
        summary: "GET",
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

test("an org-owned connection registers tools shared across org members", async () => {
  // Alice (a member) uploads the integration spec and attaches an org-owned
  // connection. Org-owned connections (and their per-connection tools) are
  // visible to every member of the tenant.
  const added = await Effect.runPromise(
    Effect.gen(function* () {
      const alice = yield* createScopedExecutor("alice", "default-org", "Default");
      const result = yield* alice.openapi.addSpec({
        spec: { kind: "blob", value: TINY_SPEC },
        slug: "tiny",
        baseUrl: "",
      });
      yield* alice.connections.create({
        owner: "org",
        name: ConnectionName.make("shared"),
        integration: IntegrationSlug.make("tiny"),
        template: AuthTemplateSlug.make("none"),
        value: "",
      });
      return result;
    }).pipe(Effect.provide(dbLayer), Effect.scoped),
  );
  expect(String(added.slug)).toBe("tiny");
  expect(added.toolCount).toBeGreaterThan(0);

  // Bob — a different user in the SAME org — sees the org-owned connection's
  // tools (addressed `tools.tiny.org.shared.<tool>`).
  const bobToolAddresses = await Effect.runPromise(
    Effect.gen(function* () {
      const bob = yield* createScopedExecutor("bob", "default-org", "Default");
      const tools = yield* bob.tools.list();
      return tools.map((tool) => String(tool.address));
    }).pipe(Effect.provide(dbLayer), Effect.scoped),
  );
  expect(bobToolAddresses.some((address) => address.startsWith("tools.tiny.org."))).toBe(true);
});
