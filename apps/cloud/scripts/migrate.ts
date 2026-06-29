/* oxlint-disable executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: out-of-band migration CLI */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as migrateDrizzle } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { cloudCodeMigrations, runCodeMigrations } from "./code-migrations/index";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = resolve(__dirname, "../drizzle");

const args = process.argv.slice(2);
const hasArg = (name: string): boolean => args.includes(name);
const argValue = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const dryRun = hasArg("--dry-run");
const schemaOnly = hasArg("--schema-only");
const codeOnly = hasArg("--code-only");
const r2Bucket = argValue("--bucket") ?? process.env.CLOUD_CODE_MIGRATION_R2_BUCKET;
const limitRaw = argValue("--limit");
const limit = limitRaw ? Number(limitRaw) : undefined;

if (schemaOnly && codeOnly) {
  throw new Error("--schema-only and --code-only cannot be used together");
}
if (limitRaw && !Number.isFinite(limit)) {
  throw new Error("--limit must be a number");
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const usesLocalDatabase =
  connectionString.includes("127.0.0.1") || connectionString.includes("localhost");

const sql = postgres(connectionString, {
  max: 1,
  prepare: false,
  ...(usesLocalDatabase ? {} : { ssl: "require" as const }),
});

try {
  if (!codeOnly) {
    if (dryRun) {
      console.log("[schema-migrate] dry run: Drizzle SQL migrations are not applied");
    } else {
      console.log(`[schema-migrate] running Drizzle migrations from ${MIGRATIONS_FOLDER}`);
      await migrateDrizzle(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });
      console.log("[schema-migrate] complete");
    }
  }

  if (!schemaOnly) {
    const migrations = cloudCodeMigrations({ r2Bucket, limit });
    if (migrations.length === 0) {
      console.log("[code-migrate] no code migrations configured");
    } else {
      const applied = await runCodeMigrations(sql, migrations, { dryRun });
      console.log(
        dryRun
          ? `[code-migrate] dry run planned ${applied.length} migration(s)`
          : `[code-migrate] applied ${applied.length} migration(s)`,
      );
    }
  }
} finally {
  await sql.end({ timeout: 0 });
}
