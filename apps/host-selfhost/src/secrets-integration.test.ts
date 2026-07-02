import { createClient } from "@libsql/client";
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

// In v2 a connection IS the credential: its inline `value` is written through the
// default writable provider — here the encrypted-secrets provider, which stores
// an AES-GCM payload at rest. This test registers an integration, attaches an
// org connection carrying a plaintext needle, and asserts the needle never
// reaches the SQLite file while the versioned "v1." ciphertext does.
const dataDir = mkdtempSync(join(tmpdir(), "eh-secrets-"));
const dbPath = join(dataDir, "data.db");
process.env.EXECUTOR_DATA_DIR = dataDir;
process.env.EXECUTOR_SECRET_KEY = "integration-test-master-key";

const createScopedExecutor = (
  accountId: string,
  organizationId: string,
  organizationName: string,
) =>
  makeScopedExecutor<SelfHostPlugins>(accountId, organizationId, organizationName).pipe(
    Effect.provide(SelfHostScopedExecutorSeams),
  );

const dbHandle = await createSelfHostDb({
  path: dbPath,
  namespace: "executor_selfhost",
  version: "1.0.0",
});
const dbLayer = Layer.succeed(SelfHostDb)(dbHandle);
afterAll(() => dbHandle.close());

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

const NEEDLE = "PLAINTEXT_NEEDLE_9f3a";

test("a connection value is stored encrypted at rest by the 'encrypted' provider", async () => {
  const created = await Effect.runPromise(
    Effect.gen(function* () {
      const admin = yield* createScopedExecutor("admin", "default-org", "Default");
      yield* admin.openapi.addSpec({
        spec: { kind: "blob", value: TINY_SPEC },
        slug: "tiny",
        baseUrl: "",
      });
      // The connection's inline `value` is opaque to core (D11) — it is written
      // through the default writable provider regardless of the template slug.
      return yield* admin.connections.create({
        owner: "org",
        name: ConnectionName.make("gh"),
        integration: IntegrationSlug.make("tiny"),
        template: AuthTemplateSlug.make("bearer"),
        value: NEEDLE,
      });
    }).pipe(Effect.provide(dbLayer), Effect.scoped),
  );

  // The first writable provider is the encrypted one — it handled the write.
  expect(String(created.provider)).toBe("encrypted");

  // Inspect the real SQLite file through a SEPARATE libSQL connection: the
  // plaintext must NOT appear anywhere, and a versioned AES-GCM payload ("v1.")
  // must be present. Reading through an independent connection also exercises the
  // cross-connection visibility of FumaDB's writes.
  const db = createClient({ url: `file:${dbPath}` });
  const tables = (await db.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map(
    // oxlint-disable-next-line executor/no-redundant-primitive-cast -- boundary: sqlite_master.name is TEXT; narrow libSQL's SQLValue to string for the table list
    (r) => r.name as string,
  );
  const cells: string[] = [];
  for (const name of tables) {
    const rows = (await db.execute(`SELECT * FROM "${name}"`)).rows;
    for (const row of rows) {
      for (const value of Object.values(row)) {
        // Plugin-storage data is a BLOB (libSQL returns ArrayBuffer); decode it.
        if (typeof value === "string") cells.push(value);
        else if (value instanceof ArrayBuffer) cells.push(Buffer.from(value).toString("utf8"));
        else if (ArrayBuffer.isView(value))
          cells.push(
            Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8"),
          );
      }
    }
  }
  db.close();

  expect(cells.some((c) => c.includes(NEEDLE))).toBe(false);
  expect(cells.some((c) => c.includes("v1."))).toBe(true);
});
