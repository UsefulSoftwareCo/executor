import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@effect/vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import {
  createDrizzleRuntimeSchemaSqlFromTables,
  ensureDrizzleRuntimeSchemaFromTables,
} from "./index";
import { column, idColumn, table } from "../../schema";

const NS = "executor";

// An older database baseline: `integration` has only id + slug.
const v1Tables = {
  integration: table("integration", {
    id: idColumn("id", "varchar(255)"),
    slug: column("slug", "varchar(255)"),
  }),
};

// The running schema adds two nullable columns the old file predates — the
// shape of the integration-descriptions feature (name + config_revised_at).
const v2Tables = {
  integration: table("integration", {
    id: idColumn("id", "varchar(255)"),
    slug: column("slug", "varchar(255)"),
    name: column("name", "string").nullable(),
    config_revised_at: column("config_revised_at", "bigint").nullable(),
  }),
};

const columnNames = async (client: ReturnType<typeof createClient>): Promise<readonly string[]> => {
  const info = await client.execute("PRAGMA table_info('integration')");
  return info.rows.map((row) => String(row["name"]));
};

// This is the boot bring-up that backs apps/local, apps/host-selfhost, and
// apps/host-cloudflare: `CREATE TABLE IF NOT EXISTS` never alters an existing
// table, so without column evolution a file from an earlier baseline would
// 500 on the first query against a new column. (Cloud Postgres gets the same
// columns from a generated drizzle migration instead.)
test("ensure evolves an existing table with the schema's new nullable columns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fumadb-ensure-"));
  const client = createClient({ url: `file:${join(dir, "test.db")}` });
  const db = drizzle({ client });

  try {
    // Stand up the old database baseline directly (CREATE TABLE only).
    for (const statement of createDrizzleRuntimeSchemaSqlFromTables({
      tables: v1Tables,
      namespace: NS,
      version: "1.0.0",
      provider: "sqlite",
    })) {
      await client.execute(statement);
    }
    expect(await columnNames(client)).not.toContain("name");

    // Boot with the new schema → the missing columns are added in place.
    await ensureDrizzleRuntimeSchemaFromTables(db, {
      tables: v2Tables,
      namespace: NS,
      version: "1.0.0",
      provider: "sqlite",
    });
    const evolved = await columnNames(client);
    expect(evolved).toContain("name");
    expect(evolved).toContain("config_revised_at");

    // Idempotent: a second boot tolerates the now-duplicate columns.
    await ensureDrizzleRuntimeSchemaFromTables(db, {
      tables: v2Tables,
      namespace: NS,
      version: "1.0.0",
      provider: "sqlite",
    });
    expect(await columnNames(client)).toEqual(evolved);
  } finally {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
