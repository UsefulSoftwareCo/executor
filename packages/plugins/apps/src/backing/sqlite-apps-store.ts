import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createClient, type Client } from "@libsql/client";
import { Effect } from "effect";

import type { StorageFailure } from "@executor-js/sdk";

import type { AppDescriptor } from "../pipeline/descriptor";
import type { AppsStore } from "../plugin/store";

// ---------------------------------------------------------------------------
// SQLite-backed AppsStore (self-hosted). The apps subsystem owns its own
// metadata store on disk: one small SQLite file holding the published
// descriptor per scope and the content-addressed blobs (compiled ui bundles +
// skill bodies). Kept separate from the executor DB so the plugin's persistence
// is self-contained (matching the per-scope-file philosophy) and doesn't couple
// to the executor's owner-policy layer.
// ---------------------------------------------------------------------------

const toUrl = (path: string): string => (path === ":memory:" ? path : `file:${resolve(path)}`);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS descriptors (scope TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, descriptor TEXT NOT NULL, published_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS blobs (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scope_connections (connection_name TEXT PRIMARY KEY, scope TEXT NOT NULL);
`;

// Not-really-failing storage errors from libSQL wrapped opaquely.
const storageFail = (message: string, cause: unknown): StorageFailure =>
  ({ _tag: "StorageError", message, cause }) as unknown as StorageFailure;

export interface SqliteAppsStoreOptions {
  readonly path: string;
}

export const makeSqliteAppsStore = (options: SqliteAppsStoreOptions): AppsStore => {
  if (options.path !== ":memory:") mkdirSync(dirname(resolve(options.path)), { recursive: true });
  const client: Client = createClient({ url: toUrl(options.path) });
  let ready: Promise<void> | undefined;
  const init = async () => {
    if (!ready) {
      ready = (async () => {
        for (const stmt of SCHEMA.split(";")) {
          const s = stmt.trim();
          if (s) await client.execute(s);
        }
      })();
    }
    return ready;
  };

  return {
    putDescriptor: (_owner, descriptor) =>
      Effect.tryPromise({
        try: async () => {
          await init();
          await client.execute({
            sql: `INSERT INTO descriptors (scope, snapshot_id, descriptor, published_at)
                  VALUES (?, ?, ?, ?)
                  ON CONFLICT(scope) DO UPDATE SET snapshot_id=excluded.snapshot_id, descriptor=excluded.descriptor, published_at=excluded.published_at`,
            args: [descriptor.scope, descriptor.snapshotId, JSON.stringify(descriptor), Date.now()],
          });
        },
        catch: (cause) => storageFail("putDescriptor failed", cause),
      }),
    getDescriptor: (scope) =>
      Effect.tryPromise({
        try: async () => {
          await init();
          const res = await client.execute({
            sql: "SELECT descriptor FROM descriptors WHERE scope = ?",
            args: [scope],
          });
          const row = res.rows[0];
          return row ? (JSON.parse(String(row.descriptor)) as AppDescriptor) : null;
        },
        catch: (cause) => storageFail("getDescriptor failed", cause),
      }),
    putScopeForConnection: (connectionName, scope) =>
      Effect.tryPromise({
        try: async () => {
          await init();
          await client.execute({
            sql: "INSERT INTO scope_connections (connection_name, scope) VALUES (?, ?) ON CONFLICT(connection_name) DO UPDATE SET scope=excluded.scope",
            args: [connectionName, scope],
          });
        },
        catch: (cause) => storageFail("putScopeForConnection failed", cause),
      }),
    getScopeForConnection: (connectionName) =>
      Effect.tryPromise({
        try: async () => {
          await init();
          const res = await client.execute({
            sql: "SELECT scope FROM scope_connections WHERE connection_name = ?",
            args: [connectionName],
          });
          return res.rows[0] ? String(res.rows[0].scope) : null;
        },
        catch: (cause) => storageFail("getScopeForConnection failed", cause),
      }),
    putBlob: (key, value) =>
      Effect.tryPromise({
        try: async () => {
          await init();
          await client.execute({
            sql: "INSERT INTO blobs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            args: [key, value],
          });
        },
        catch: (cause) => storageFail("putBlob failed", cause),
      }),
    getBlob: (key) =>
      Effect.tryPromise({
        try: async () => {
          await init();
          const res = await client.execute({
            sql: "SELECT value FROM blobs WHERE key = ?",
            args: [key],
          });
          return res.rows[0] ? String(res.rows[0].value) : null;
        },
        catch: (cause) => storageFail("getBlob failed", cause),
      }),
  };
};
