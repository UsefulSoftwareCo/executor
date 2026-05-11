// Shared pre-migration schema used by the four migrate-*-bindings.test.ts
// suites. Each test seeds this hand-rolled DDL (the DB shape immediately
// after 0006_neat_terror), then runs drizzle's migrator which executes
// only `0007_normalize_plugin_secret_refs.sql` thanks to the stamp.

import { Database } from "bun:sqlite";

export const PRE_0007_SQL = `
  CREATE TABLE __drizzle_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hash TEXT NOT NULL,
    created_at NUMERIC
  );

  CREATE TABLE graphql_source (
    id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    name TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    headers TEXT,
    query_params TEXT,
    auth TEXT,
    PRIMARY KEY (scope_id, id)
  );

  CREATE TABLE graphql_operation (
    id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    binding TEXT NOT NULL,
    PRIMARY KEY (scope_id, id)
  );

  CREATE TABLE openapi_source (
    id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    name TEXT NOT NULL,
    spec TEXT NOT NULL,
    source_url TEXT,
    base_url TEXT,
    headers TEXT,
    query_params TEXT,
    oauth2 TEXT,
    invocation_config TEXT NOT NULL,
    PRIMARY KEY (scope_id, id)
  );

  CREATE TABLE openapi_source_binding (
    id TEXT PRIMARY KEY NOT NULL,
    source_id TEXT NOT NULL,
    source_scope_id TEXT NOT NULL,
    target_scope_id TEXT NOT NULL,
    slot TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE secret (
    id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    owned_by_connection_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (scope_id, id)
  );

  CREATE INDEX secret_scope_id_idx ON secret (scope_id);
  CREATE INDEX secret_provider_idx ON secret (provider);
  CREATE INDEX secret_owned_by_connection_id_idx ON secret (owned_by_connection_id);

  CREATE TABLE connection (
    id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    identity_label TEXT,
    access_token_secret_id TEXT NOT NULL,
    refresh_token_secret_id TEXT,
    expires_at INTEGER,
    scope TEXT,
    provider_state TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope_id, id)
  );

  CREATE INDEX connection_scope_id_idx ON connection (scope_id);
  CREATE INDEX connection_provider_idx ON connection (provider);

  CREATE TABLE mcp_source (
    id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    name TEXT NOT NULL,
    config TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (scope_id, id)
  );

  CREATE TABLE mcp_binding (
    id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    binding TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (scope_id, id)
  );

  CREATE TABLE google_discovery_source (
    id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    name TEXT NOT NULL,
    config TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope_id, id)
  );

  CREATE TABLE google_discovery_binding (
    id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    binding TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (scope_id, id)
  );
`;

// 0006_neat_terror.when. drizzle's sqlite migrator picks the latest
// `created_at` from __drizzle_migrations and skips any migration whose
// folderMillis (from the journal) is <= that timestamp.
export const STAMP_BEFORE = 1777850000001;

export const stampPriorMigrationsApplied = (db: Database) => {
  db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(
    "pre-0007-marker",
    STAMP_BEFORE,
  );
};
