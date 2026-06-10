/* oxlint-disable executor/no-try-catch-or-throw -- boundary: out-of-band migration script over a raw postgres connection */
// ---------------------------------------------------------------------------
// One-off data migration: re-file mis-partitioned WorkOS Vault metadata rows.
//
// A bug in the v1.5 vault provider (`ownerOf(binding)`) filed every credential
// created by a bound user — including ORG-shared connections — under that
// user's private partition. Org-shared credentials then resolved only for
// whoever pasted them; every other org member got `connection_value_missing`.
//
// The fix (secret-store.ts: `ownerForItemId`) files by the owner embedded in
// the item id. This script repairs the rows already written wrong: an item id
// of `connection:org:…` / `oauth:org:…` / `oauth-client:org:…` whose metadata
// row sits at owner='user' is moved to owner='org', subject=''. The Vault
// object itself is untouched (flat context) — only the metadata pointer moves.
//
//   bun run db:repartition-vault:prod      # op run --env-file=.env.production
//   bun run db:repartition-vault:dev       # against the local PGlite dev db
//
// Idempotent — already-correct rows are skipped. Pass --dry-run to print the
// plan without writing.
// ---------------------------------------------------------------------------

import postgres from "postgres";

const VAULT_PLUGIN_ID = "workosVault";
const METADATA_COLLECTION = "metadata";
// Item-id prefixes whose second colon-segment is the owning partition.
const OWNER_SCOPED_PREFIXES = ["connection", "oauth", "oauth-client"];

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const dryRun = process.argv.includes("--dry-run");

// Direct (non-Hyperdrive) connection — PlanetScale requires TLS.
const sql = postgres(connectionString, { max: 1, prepare: false, ssl: "require" });

type Row = {
  row_id: string;
  tenant: string;
  owner: string;
  subject: string;
  key: string;
};

const embeddedOwner = (key: string): "org" | "user" | null => {
  const [prefix, owner] = key.split(":");
  if (!OWNER_SCOPED_PREFIXES.includes(prefix ?? "")) return null;
  return owner === "org" || owner === "user" ? owner : null;
};

try {
  const rows = await sql<Row[]>`
    SELECT row_id, tenant, owner, subject, key
    FROM plugin_storage
    WHERE plugin_id = ${VAULT_PLUGIN_ID} AND collection = ${METADATA_COLLECTION}
  `;

  // A row is mis-filed when its stored partition disagrees with the owner
  // embedded in its item id. In practice only org credentials stuck in a user
  // partition, but compute it generally and symmetrically.
  const misfiled = rows.filter((row) => {
    const want = embeddedOwner(row.key);
    if (want === null) return false;
    const wantSubject = want === "org" ? "" : row.subject;
    return row.owner !== want || row.subject !== wantSubject;
  });

  console.log(`${rows.length} vault metadata row(s), ${misfiled.length} mis-partitioned`);
  const byPrefix = new Map<string, number>();
  for (const row of misfiled) {
    const prefix = row.key.split(":")[0] ?? "?";
    byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1);
  }
  for (const [prefix, n] of byPrefix) console.log(`  ${prefix}: ${n}`);

  if (dryRun) {
    for (const row of misfiled) {
      console.log(
        `  would move ${row.owner}/${row.subject || "''"} → ${embeddedOwner(row.key)} : ${row.key}`,
      );
    }
  } else if (misfiled.length > 0) {
    let moved = 0;
    await sql.begin(async (tx) => {
      for (const row of misfiled) {
        const want = embeddedOwner(row.key)!;
        const wantSubject = want === "org" ? "" : row.subject;
        // Re-file in place: copy the data into the correct partition (no-op if a
        // post-fix write already created it), then drop the mis-filed row.
        await tx`
          INSERT INTO plugin_storage
            (row_id, tenant, owner, subject, plugin_id, collection, key, data, created_at, updated_at)
          SELECT row_id || '-repart', tenant, ${want}, ${wantSubject},
                 plugin_id, collection, key, data, created_at, now()
          FROM plugin_storage WHERE row_id = ${row.row_id}
          ON CONFLICT (tenant, owner, subject, plugin_id, collection, key) DO NOTHING
        `;
        await tx`DELETE FROM plugin_storage WHERE row_id = ${row.row_id}`;
        moved += 1;
      }
    });
    console.log(`re-filed ${moved} row(s)`);
  }
} finally {
  await sql.end();
}
