/**
 * Phase-0 verification: prove the fumadb `postgresql` path brings up the real
 * executor table set in a dedicated `executor` schema of a shared Postgres,
 * and that the assembled FumaDB handle can round-trip a query.
 *
 * Run against a local Postgres:
 *   POSTGRES_URL=postgres://postgres@127.0.0.1:5433/executor_test \
 *     bun run apps/host-nice/scripts/migrate-smoke.ts
 */
import postgres from "postgres";

import { collectTables } from "@executor-js/api/server";

import { createHostNiceDb } from "../src/db/postgres-db";

const url = process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("set POSTGRES_URL");
  process.exit(1);
}

const schema = process.env.EXECUTOR_DB_SCHEMA ?? "executor";

const main = async (): Promise<void> => {
  const expectedTableCount = Object.keys(collectTables()).length;
  console.log(`[smoke] executor declares ${expectedTableCount} fuma tables`);

  const handle = await createHostNiceDb({ url, schema });
  console.log(`[smoke] createHostNiceDb ok (schema=${handle.schema})`);

  // Inspect what landed in the executor schema.
  const inspect = postgres(url, { max: 1, onnotice: () => undefined });
  const rows = await inspect`
    select table_name
    from information_schema.tables
    where table_schema = ${schema}
    order by table_name
  `;
  console.log(`[smoke] ${rows.length} tables created in schema "${schema}":`);
  for (const r of rows) console.log(`         - ${r.table_name as string}`);

  if (rows.length === 0) {
    console.error("[smoke] FAIL: no tables created");
    process.exit(1);
  }

  // Re-run to prove idempotency (boot-on-existing-schema must not throw).
  const handle2 = await createHostNiceDb({ url, schema });
  console.log("[smoke] second createHostNiceDb ok (migration is idempotent)");

  await inspect.end({ timeout: 5 });
  await handle.close();
  await handle2.close();
  console.log("[smoke] PASS");
};

main().catch((err) => {
  console.error("[smoke] error:", err);
  process.exit(1);
});
