// ---------------------------------------------------------------------------
// Data migration: re-file mis-partitioned encrypted-secrets rows.
//
// Before the `ownerForItemId` fix (issue #1453), the provider filed every
// credential under the ACTING caller's partition — so an org connection whose
// OAuth consent completed in a user's browser session stored its token rows
// at owner='user', subject=<that user>, while the connection row said org.
// The consenting user still resolved the tokens (user rows shadow org rows),
// so the connection looked healthy; every other principal failed with
// `oauth_connection_missing`. Mirrors the WorkOS Vault repair from #950
// (apps/cloud/scripts/repartition-vault-metadata.ts), but as a boot-time
// ledger entry — the affected hosts (selfhost, Cloudflare) have no operator
// to run a script by hand. Encryption is global-key, not principal-bound, so
// moving a row is a pure partition change; ciphertext decrypts unchanged.
//
// Only org-embedded ids stuck outside the org partition are moved: that is
// the one direction the pre-fix `ownerOf(binding)` could produce (a
// `*:user:*` id can only ever be minted by a subject-bound executor, which
// the old code filed as 'user' — already correct).
//
// Idempotent: already-correct rows never match, and the copy step is
// insert-or-ignore against the (tenant, owner, subject, plugin_id,
// collection, key) unique index — a post-fix write that already created the
// correct row wins and the mis-filed duplicate is simply dropped.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import {
  DataMigrationError,
  embeddedItemOwner,
  ORG_SUBJECT,
  type SqliteDataMigration,
  type SqliteDataMigrationClient,
} from "@executor-js/sdk";

const MIGRATION_NAME = "2026-07-27-encrypted-secrets-owner-repartition";

const PLUGIN_ID = "encryptedSecrets";
const COLLECTION = "secrets";

const execute = (
  client: SqliteDataMigrationClient,
  stmt: string | { readonly sql: string; readonly args: readonly unknown[] },
) =>
  Effect.tryPromise({
    try: () => client.execute(stmt),
    catch: (cause) => new DataMigrationError({ migration: MIGRATION_NAME, cause }),
  });

const tableExists = (client: SqliteDataMigrationClient, table: string) =>
  Effect.map(
    execute(client, {
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      args: [table],
    }),
    (result) => result.rows.length > 0,
  );

/** Move every encrypted-secrets row whose item id embeds `org` but whose
 *  stored partition is not the org one into `owner='org', subject=''`.
 *  Returns the number of mis-filed rows repaired (moved or, when a post-fix
 *  write already created the org row, dropped in its favor). Fresh databases
 *  lack the table; nothing to do. */
export const runSqliteEncryptedSecretsRepartition = (
  client: SqliteDataMigrationClient,
): Effect.Effect<number, DataMigrationError> =>
  Effect.gen(function* () {
    if (!(yield* tableExists(client, "plugin_storage"))) return 0;

    const rows = yield* execute(client, {
      sql: `SELECT row_id, owner, subject, key
            FROM plugin_storage
            WHERE plugin_id = ? AND collection = ?`,
      args: [PLUGIN_ID, COLLECTION],
    });

    const misfiled: string[] = [];
    for (const row of rows.rows) {
      if (typeof row.row_id !== "string" || typeof row.key !== "string") {
        return yield* new DataMigrationError({
          migration: MIGRATION_NAME,
          cause: `unreadable plugin_storage row: ${JSON.stringify(row)}`,
        });
      }
      if (embeddedItemOwner(row.key) !== "org") continue;
      if (row.owner === "org" && row.subject === ORG_SUBJECT) continue;
      misfiled.push(row.row_id);
    }
    if (misfiled.length === 0) return 0;

    const applyAll = Effect.gen(function* () {
      for (const rowId of misfiled) {
        // Re-file in place: copy into the org partition (no-op when a
        // post-fix write already created it), then drop the mis-filed row.
        yield* execute(client, {
          sql: `INSERT OR IGNORE INTO plugin_storage
                  (row_id, tenant, owner, subject, plugin_id, collection, key, data, created_at, updated_at)
                SELECT row_id || '-repart', tenant, 'org', ?, plugin_id, collection, key, data, created_at, updated_at
                FROM plugin_storage WHERE row_id = ?`,
          args: [ORG_SUBJECT, rowId],
        });
        yield* execute(client, {
          sql: "DELETE FROM plugin_storage WHERE row_id = ?",
          args: [rowId],
        });
      }
      yield* execute(client, "COMMIT");
      return misfiled.length;
    });

    yield* execute(client, "BEGIN");
    return yield* applyAll.pipe(
      Effect.tapError(() => execute(client, "ROLLBACK").pipe(Effect.ignore)),
    );
  });

/** Registry entry for the boot-time data-migration ledger. */
export const encryptedSecretsRepartitionDataMigration: SqliteDataMigration = {
  name: MIGRATION_NAME,
  run: (client: SqliteDataMigrationClient) =>
    runSqliteEncryptedSecretsRepartition(client).pipe(Effect.asVoid),
};
