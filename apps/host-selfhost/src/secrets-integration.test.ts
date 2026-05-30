import { createClient } from "@libsql/client";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "@effect/vitest";

const dataDir = mkdtempSync(join(tmpdir(), "eh-secrets-"));
process.env.EXECUTOR_DATA_DIR = dataDir;
process.env.EXECUTOR_SECRET_KEY = "integration-test-master-key";

const { makeSelfHostTestApp, singleAdminIdentityLayer } = await import("./testing/test-app");

const { handler, dispose } = await makeSelfHostTestApp({
  identity: singleAdminIdentityLayer({
    userId: "admin",
    organizationId: "default-org",
    organizationName: "Default",
  }),
});
afterAll(() => dispose());

const NEEDLE = "PLAINTEXT_NEEDLE_9f3a";

test("a secret set via the API is stored encrypted at rest by the 'encrypted' provider", async () => {
  const setRes = await handler(
    new Request("http://localhost/api/scopes/default-org/secrets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "gh-token", name: "GitHub", value: NEEDLE }),
    }),
  );
  expect(setRes.status).toBe(200);
  const ref = (await setRes.json()) as { id: string; provider: string };
  expect(ref.id).toBe("gh-token");
  // The first writable provider is the encrypted one — it handled the write.
  expect(ref.provider).toBe("encrypted");

  // The status endpoint resolves it (decrypt round-trips through the provider).
  const statusRes = await handler(
    new Request("http://localhost/api/scopes/default-org/secrets/gh-token/status"),
  );
  expect(statusRes.status).toBe(200);
  expect(((await statusRes.json()) as { status: string }).status).toBe("resolved");

  // Inspect the real SQLite file through a SEPARATE libSQL connection (the app's
  // own libSQL client wrote it): the plaintext must NOT appear anywhere, and a
  // versioned AES-GCM payload ("v1.") must be present. Reading this file through
  // an independent connection also exercises the cross-connection visibility of
  // FumaDB's writes.
  const db = createClient({ url: `file:${join(dataDir, "data.db")}` });
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
