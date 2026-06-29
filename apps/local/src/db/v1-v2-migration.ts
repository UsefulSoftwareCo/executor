/* oxlint-disable executor/no-json-parse, executor/no-raw-fetch, executor/no-try-catch-or-throw -- boundary: one-shot local SQLite/auth-file migration normalizes legacy on-disk state */

import type { Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { Data, Effect } from "effect";
import { createId } from "@executor-js/fumadb/cuid";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";

import type { FumaTables } from "@executor-js/sdk";
import {
  buildV1RuntimeMetadataIndex,
  migrateGraphqlSourceConfig,
  migrateMcpSourceConfig,
  migrateOpenApiSourceConfig,
  migrateV1PluginStorageRuntimeRow,
  migrateV1ToolAnnotations,
  migrationOAuthAuthorizationUrlFor as authorizationUrlFor,
  migrationOAuthClientPlanKey as oauthClientPlanKey,
  migrationSourceKey,
  parseScope,
  planMigration,
  resolveMigrationOAuthAuthorizationUrls,
  type MigratedSourceConfig,
  type MigrationInput,
  type MigrationOAuthMetadataFetch,
  type MigrationOwner,
  type MigrationPlan,
  type OwnerKeys,
  type V1SourceRow,
} from "@executor-js/sdk/migration";
import { makeKeychainProvider } from "@executor-js/plugin-keychain";

import { createSqliteFumaDb } from "./sqlite-fumadb";
import embeddedLegacyMigrations from "./embedded-migrations.gen";
import { executeSql, openLocalLibsql, queryFirst, queryRows } from "./libsql";

type Row = Record<string, unknown>;

interface V1ToolRow {
  readonly scopeId: string;
  readonly sourceId: string;
  readonly pluginId: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
  readonly annotations: unknown;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface V1DefinitionRow {
  readonly scopeId: string;
  readonly sourceId: string;
  readonly pluginId: string;
  readonly name: string;
  readonly schema: unknown;
  readonly createdAt: number;
}

interface V1PluginStorageRow {
  readonly scopeId: string;
  readonly pluginId: string;
  readonly collection: string;
  readonly key: string;
  readonly data: unknown;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface V1BlobRow {
  readonly namespace: string;
  readonly key: string;
  readonly value: string;
}

interface LocalV1Snapshot {
  readonly input: MigrationInput;
  readonly tools: readonly V1ToolRow[];
  readonly definitions: readonly V1DefinitionRow[];
  readonly pluginStorage: readonly V1PluginStorageRow[];
  readonly blobs: readonly V1BlobRow[];
}

export interface LocalV1V2MigrationResult {
  readonly migrated: boolean;
  readonly backupPath?: string;
  readonly report?: MigrationPlan["report"];
  readonly warnings: readonly string[];
}

export interface LocalV1V2MigrationOptions {
  readonly sqlitePath: string;
  readonly tables: FumaTables;
  readonly namespace: string;
  readonly tenantId: string;
  readonly oauthMetadataFetch?: MigrationOAuthMetadataFetch;
  readonly oauthMetadataTimeoutMs?: number;
}

class LocalV1V2MigrationError extends Data.TaggedError("LocalV1V2MigrationError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const FILE_PROVIDER = "file";
const KEYCHAIN_PROVIDER = "keychain";

const fileSetSuffixes = ["", "-wal", "-shm"] as const;

type MigrationJournalPhase = "building" | "built" | "canonical-moved" | "committed";

interface KeychainSecretBackup {
  readonly id: string;
  readonly backupId: string | null;
  readonly existed: boolean;
}

interface MigrationJournal {
  readonly version: 1;
  readonly source: string;
  readonly normalizedSource: string;
  readonly staging: string;
  readonly backup: string;
  readonly authPath: string;
  readonly authBackup: string | null;
  readonly authExisted: boolean;
  readonly keychainBackups?: readonly KeychainSecretBackup[];
  readonly nonce: string;
  readonly phase: MigrationJournalPhase;
}

const quoteIdent = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const tableExists = async (client: Client, table: string): Promise<boolean> =>
  (await queryFirst(client, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [
    table,
  ])) != null;

const columnNames = async (client: Client, table: string): Promise<ReadonlySet<string>> =>
  new Set(
    (await queryRows<{ name: string }>(client, `PRAGMA table_info(${quoteIdent(table)})`)).map(
      (row) => row.name,
    ),
  );

const optionalColumn = (columns: ReadonlySet<string>, table: string, column: string): string =>
  columns.has(column) ? `${quoteIdent(table)}.${quoteIdent(column)}` : "NULL";

const isLocalV1Database = async (client: Client): Promise<boolean> => {
  if (!(await tableExists(client, "source"))) return false;
  const sourceColumns = await columnNames(client, "source");
  if (!sourceColumns.has("scope_id")) return false;
  if (!(await tableExists(client, "integration"))) return true;
  const connectionColumns = await columnNames(client, "connection");
  return !connectionColumns.has("tenant") || connectionColumns.has("scope_id");
};

// ---------------------------------------------------------------------------
// Data-migration-ledger gate.
//
// Once a database has passed the v1 gate (either it was migrated, or it was
// inspected and found to be v2-native), the boot ledger stamps
// LOCAL_V1_V2_LEDGER_NAME (see apps/local/src/db/data-migrations.ts). On
// every later boot the stamp short-circuits this module before any schema
// probing — the stamp row, not the data shape, is the source of truth.
// ---------------------------------------------------------------------------

export const LOCAL_V1_V2_LEDGER_NAME = "2026-06-11-local-v1-to-v2";

const hasV1GateStamp = async (client: Client): Promise<boolean> => {
  if (!(await tableExists(client, "data_migration"))) return false;
  return (
    (await queryFirst(client, "SELECT name FROM data_migration WHERE name = ?", [
      LOCAL_V1_V2_LEDGER_NAME,
    ])) != null
  );
};

// ---------------------------------------------------------------------------
// Legacy v1 schema replay.
//
// The v1→v2 data migration below reads the v1-FINAL schema (it queries
// `plugin_storage`, which only exists after v1 migration 0011). A database
// last touched by an older release is still mid-chain, so replay the bundled
// legacy drizzle migrations (`apps/local/drizzle-legacy-v1`, embedded into
// the binary by apps/cli/src/build.ts) to bring it to v1-final first — the
// same step every pre-v1.5 release performed at startup.
// ---------------------------------------------------------------------------

const resolveLegacyMigrationsFolder = (): string => {
  if (!embeddedLegacyMigrations) {
    return join(import.meta.dirname, "../../drizzle-legacy-v1");
  }
  // drizzle's migrate() reads a folder from disk; materialize the embedded
  // contents into a tmpdir.
  const dir = fs.mkdtempSync(join(tmpdir(), "executor-legacy-migrations-"));
  for (const [rel, content] of Object.entries(embeddedLegacyMigrations)) {
    const target = join(dir, rel);
    fs.mkdirSync(dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
};

const readBundledLegacyMigrationHashes = (migrationsFolder: string): readonly string[] => {
  const journal = JSON.parse(
    fs.readFileSync(join(migrationsFolder, "meta", "_journal.json")).toString(),
  ) as { entries: ReadonlyArray<{ idx: number; tag: string }> };
  return [...journal.entries]
    .sort((left, right) => left.idx - right.idx)
    .map((entry) =>
      createHash("sha256")
        .update(fs.readFileSync(join(migrationsFolder, `${entry.tag}.sql`)).toString())
        .digest("hex"),
    );
};

const readAppliedLegacyMigrationHashes = async (client: Client): Promise<readonly string[]> =>
  (
    await queryRows<{ hash: string }>(
      client,
      "SELECT hash FROM __drizzle_migrations ORDER BY id ASC",
    )
  ).map((row) => row.hash);

// Errors a statement raises when its work is already done — or when it
// references schema from an earlier era that a later (already-applied)
// migration removed ("no such table/column", "has no column named"). The
// legacy chain's data statements are idempotent by construction (INSERT OR
// IGNORE / OR REPLACE, conditional UPDATEs), so a chain re-executed over a
// database in an unknown mid-chain state converges by skipping exactly these.
const TOLERANT_REPLAY_SKIPPABLE =
  /already exists|duplicate column name|no such table|no such column|no such index|has no column/i;

const readLegacyJournalTags = (migrationsFolder: string): readonly string[] => {
  const journal = JSON.parse(
    fs.readFileSync(join(migrationsFolder, "meta", "_journal.json")).toString(),
  ) as { entries: ReadonlyArray<{ idx: number; tag: string }> };
  return [...journal.entries].sort((left, right) => left.idx - right.idx).map((entry) => entry.tag);
};

/** Recovery path for a v1 database whose drizzle journal can't be trusted
 *  (wiped, rewritten by another tool, or from an unknown build): re-execute
 *  the entire frozen legacy chain statement-by-statement, skipping the
 *  errors that mean "already applied". Statements the database has already
 *  seen fail with `already exists`/`duplicate column`/`no such ...` and are
 *  skipped; statements it never reached execute for real. The chain's own
 *  0011 backfill then populates `plugin_storage` from the per-plugin source
 *  tables, which is exactly the shape `readV1Snapshot` needs. */
const tolerantReplayLegacyChain = async (client: Client, warnings: string[]): Promise<void> => {
  const migrationsFolder = resolveLegacyMigrationsFolder();
  let executed = 0;
  let skipped = 0;
  for (const tag of readLegacyJournalTags(migrationsFolder)) {
    const sql = fs.readFileSync(join(migrationsFolder, `${tag}.sql`)).toString();
    for (const chunk of sql.split("--> statement-breakpoint")) {
      const statement = chunk.trim();
      if (statement.length === 0) continue;
      try {
        await client.execute(statement);
        executed++;
      } catch (cause) {
        // oxlint-disable-next-line executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: classifying raw SqliteError text from the libSQL driver
        const message = cause instanceof Error ? cause.message : String(cause);
        if (!TOLERANT_REPLAY_SKIPPABLE.test(message)) throw cause;
        skipped++;
      }
    }
  }
  warnings.push(
    `v1 database had unusable drizzle migration history; recovered the v1-final schema by tolerant replay (${executed} statements applied, ${skipped} already done).`,
  );
};

/** Bring a v1 database up to the v1-final schema `readV1Snapshot` requires.
 *
 *  The replay exists for ONE reader: `readV1Snapshot` queries
 *  `plugin_storage`, which appears in legacy migration 0011. Real-world v1
 *  databases show up in franken-states the journal can't describe — the
 *  observed crash case was a v1-final schema (plugin_storage and all) with
 *  an EMPTY `__drizzle_migrations` journal, which the old prefix check read
 *  as "nothing applied" and replayed from 0000 straight into
 *  `table blob already exists`. So the gates, in order:
 *
 *  1. Schema marker: `plugin_storage` exists → the schema is already
 *     sufficient; never consult the journal, never replay.
 *  2. Journal is a non-empty strict prefix of the bundled chain → the exact
 *     drizzle replay every pre-v1.5 release performed (fast, hash-checked).
 *  3. Anything else (missing/empty/foreign journal) → tolerant replay; the
 *     old behavior of "skip and read as-is" just crashed later in
 *     `readV1Snapshot` on the missing `plugin_storage` table. */
const replayLegacyV1Migrations = async (client: Client, warnings: string[]): Promise<void> => {
  if (await tableExists(client, "plugin_storage")) return;

  if (await tableExists(client, "__drizzle_migrations")) {
    const applied = await readAppliedLegacyMigrationHashes(client);
    if (applied.length > 0) {
      const migrationsFolder = resolveLegacyMigrationsFolder();
      const bundled = readBundledLegacyMigrationHashes(migrationsFolder);
      const isPrefix =
        applied.length < bundled.length && applied.every((hash, index) => hash === bundled[index]);
      // A full-length journal can't be trusted here: plugin_storage is
      // missing (checked above), so a journal claiming v1-final is lying —
      // fall through to the tolerant replay.
      if (isPrefix) {
        await migrate(drizzle({ client }), { migrationsFolder });
        return;
      }
    }
  }

  await tolerantReplayLegacyChain(client, warnings);
};

const textDecoder = new TextDecoder();

const decodeBytes = (value: ArrayBuffer | ArrayBufferView): string => {
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return textDecoder.decode(bytes);
};

const parseJson = (value: unknown): unknown => {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return parseJson(decodeBytes(value));
  }
  if (typeof value !== "string") return value;
  if (value.trim() === "") return null;
  return JSON.parse(value);
};

const stringOrNull = (value: unknown): string | null => (value == null ? null : String(value));

const numberOrNull = (value: unknown): number | null => {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const numberOrDefault = (value: unknown, fallback: number): number =>
  numberOrNull(value) ?? fallback;

const normalizePluginId = (pluginId: string, kind: string): string =>
  pluginId === "graphql-greenfield" ? "graphql" : pluginId || kind;

const buildConfig = (kind: string, data: Record<string, unknown>): MigratedSourceConfig => {
  const cfg = (data.config as Record<string, unknown> | undefined) ?? data;
  if (kind === "mcp") return migrateMcpSourceConfig(cfg as never);
  if (kind === "graphql") return migrateGraphqlSourceConfig(cfg as never);
  return migrateOpenApiSourceConfig(cfg as never);
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sourceKeyForBinding = (binding: Row): string =>
  migrationSourceKey(
    binding.source_scope_id == null ? String(binding.scope_id) : String(binding.source_scope_id),
    String(binding.source_id),
  );

const mcpOAuthEndpoint = (config: MigratedSourceConfig | undefined): string | null => {
  const value = config?.config;
  if (!isObjectRecord(value)) return null;
  if (typeof value.endpoint !== "string" || value.endpoint.length === 0) return null;
  if (!isObjectRecord(value.auth) || value.auth.kind !== "oauth2") return null;
  return value.endpoint;
};

const canonicalResource = (value: string): string | null => {
  try {
    const url = new URL(value);
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
};

const resourceMatchesEndpoint = (resource: string, endpoint: string): boolean => {
  const actual = canonicalResource(resource);
  const expected = canonicalResource(endpoint);
  return (
    actual != null && expected != null && (actual === expected || expected.startsWith(`${actual}/`))
  );
};

const protectedResourceMetadataUrls = (endpoint: string): readonly string[] => {
  try {
    const url = new URL(endpoint);
    const origin = url.origin;
    const path = url.pathname.replace(/\/+$/, "");
    const urls: string[] = [];
    if (path && path !== "/") urls.push(`${origin}/.well-known/oauth-protected-resource${path}`);
    urls.push(`${origin}/.well-known/oauth-protected-resource`);
    return [...new Set(urls)];
  } catch {
    return [];
  }
};

const discoverProtectedResource = async (endpoint: string): Promise<string | null> => {
  for (const url of protectedResourceMetadataUrls(endpoint)) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) continue;
      const json = (await response.json()) as unknown;
      if (!isObjectRecord(json) || typeof json.resource !== "string") continue;
      if (resourceMatchesEndpoint(json.resource, endpoint)) return json.resource;
    } catch {
      continue;
    }
  }
  return null;
};

const discoverMcpOAuthResourceOverrides = async (
  bindings: readonly Row[],
  migratedConfigs: ReadonlyMap<string, MigratedSourceConfig>,
): Promise<ReadonlyMap<string, string>> => {
  const endpointByKey = new Map<string, string>();
  for (const binding of bindings) {
    if (binding.kind !== "connection") continue;
    const key = sourceKeyForBinding(binding);
    const endpoint = mcpOAuthEndpoint(migratedConfigs.get(key));
    if (endpoint) endpointByKey.set(key, endpoint);
  }
  const resourceByEndpoint = new Map<string, string | null>();
  await Promise.all(
    [...new Set(endpointByKey.values())].map(async (endpoint) => {
      resourceByEndpoint.set(endpoint, await discoverProtectedResource(endpoint));
    }),
  );
  const overrides = new Map<string, string>();
  for (const [key, endpoint] of endpointByKey) {
    const resource = resourceByEndpoint.get(endpoint);
    if (resource) overrides.set(key, resource);
  }
  return overrides;
};

const localOwnerForScope =
  (tenantId: string) =>
  (scopeId: string): OwnerKeys | null => {
    const cloud = parseScope(scopeId);
    if (cloud) return cloud;
    return { owner: "org", subject: "", tenant: tenantId };
  };

const readV1Snapshot = async (client: Client, tenantId: string): Promise<LocalV1Snapshot> => {
  const hasDefinition = await tableExists(client, "definition");
  const hasBlob = await tableExists(client, "blob");
  const bindingColumns = await columnNames(client, "credential_binding");
  const toolColumns = await columnNames(client, "tool");
  const definitionColumns = hasDefinition
    ? await columnNames(client, "definition")
    : new Set<string>();

  const [
    sources,
    secrets,
    bindings,
    connections,
    policies,
    sourceStorage,
    allPluginStorage,
    toolSources,
    tools,
    definitions,
    blobs,
  ] = await Promise.all([
    queryRows<Row>(client, "SELECT scope_id, id, plugin_id, kind, name FROM source"),
    queryRows<Row>(
      client,
      "SELECT id, scope_id, name, provider, owned_by_connection_id FROM secret",
    ),
    queryRows<Row>(
      client,
      `SELECT scope_id, ${optionalColumn(bindingColumns, "credential_binding", "source_scope_id")} AS source_scope_id, source_id, slot_key, kind, secret_id, ${optionalColumn(bindingColumns, "credential_binding", "secret_scope_id")} AS secret_scope_id, connection_id, text_value FROM credential_binding`,
    ),
    queryRows<Row>(
      client,
      "SELECT id, scope_id, provider, identity_label, access_token_secret_id, refresh_token_secret_id, expires_at, provider_state FROM connection",
    ),
    queryRows<Row>(client, "SELECT id, scope_id, pattern, action, position FROM tool_policy"),
    queryRows<Row>(
      client,
      "SELECT ps.scope_id, ps.key AS source_id, ps.data, s.kind FROM plugin_storage ps JOIN source s ON ps.key = s.id AND ps.scope_id = s.scope_id WHERE ps.collection = 'source'",
    ),
    queryRows<Row>(
      client,
      "SELECT scope_id, plugin_id, collection, key, data, created_at, updated_at FROM plugin_storage",
    ),
    queryRows<Row>(client, "SELECT DISTINCT source_id FROM tool"),
    queryRows<Row>(
      client,
      `SELECT scope_id, source_id, plugin_id, name, description, ${optionalColumn(toolColumns, "tool", "input_schema")} AS input_schema, ${optionalColumn(toolColumns, "tool", "output_schema")} AS output_schema, ${optionalColumn(toolColumns, "tool", "annotations")} AS annotations, created_at, updated_at FROM tool`,
    ),
    hasDefinition
      ? queryRows<Row>(
          client,
          `SELECT scope_id, source_id, plugin_id, name, ${optionalColumn(definitionColumns, "definition", "schema")} AS schema, created_at FROM definition`,
        )
      : Promise.resolve([]),
    hasBlob
      ? queryRows<Row>(client, "SELECT namespace, key, value FROM blob")
      : Promise.resolve([]),
  ]);

  const migratedConfigs = new Map<string, MigratedSourceConfig>();
  for (const row of sourceStorage) {
    const data = parseJson(row.data) as Record<string, unknown>;
    migratedConfigs.set(
      migrationSourceKey(String(row.scope_id), String(row.source_id)),
      buildConfig(String(row.kind), data),
    );
  }
  const oauthResourceOverrides = await discoverMcpOAuthResourceOverrides(bindings, migratedConfigs);

  return {
    input: {
      nowMs: Date.now(),
      ownerForScope: localOwnerForScope(tenantId),
      defaultWritableProvider: FILE_PROVIDER,
      sources: sources.map(
        (source): V1SourceRow => ({
          scopeId: String(source.scope_id),
          id: String(source.id),
          pluginId: normalizePluginId(String(source.plugin_id), String(source.kind)),
          name: source.name == null ? String(source.id) : String(source.name),
        }),
      ),
      migratedConfigs,
      oauthResourceOverrides,
      connections: connections.map((connection) => ({
        id: String(connection.id),
        scopeId: String(connection.scope_id),
        provider: String(connection.provider),
        identityLabel: stringOrNull(connection.identity_label),
        accessTokenSecretId: stringOrNull(connection.access_token_secret_id),
        refreshTokenSecretId: stringOrNull(connection.refresh_token_secret_id),
        expiresAt: numberOrNull(connection.expires_at),
        providerState: (parseJson(connection.provider_state) as never) ?? null,
      })),
      bindings: bindings.map((binding) => ({
        scopeId: String(binding.scope_id),
        sourceScopeId:
          binding.source_scope_id == null ? undefined : String(binding.source_scope_id),
        sourceId: String(binding.source_id),
        slotKey: String(binding.slot_key),
        kind: binding.kind as "secret" | "connection" | "text",
        secretId: stringOrNull(binding.secret_id),
        secretScopeId: stringOrNull(binding.secret_scope_id),
        connectionId: stringOrNull(binding.connection_id),
        textValue: stringOrNull(binding.text_value),
      })),
      secrets: secrets.map((secret) => ({
        id: String(secret.id),
        scopeId: String(secret.scope_id),
        name: String(secret.name),
        provider: String(secret.provider),
        ownedByConnectionId: stringOrNull(secret.owned_by_connection_id),
      })),
      policies: policies.map((policy) => ({
        id: String(policy.id),
        scopeId: String(policy.scope_id),
        pattern: String(policy.pattern),
        action: String(policy.action),
        position: String(policy.position),
      })),
      toolSourceIds: toolSources.map((tool) => String(tool.source_id)),
    },
    tools: tools.map((tool) => ({
      scopeId: String(tool.scope_id),
      sourceId: String(tool.source_id),
      pluginId: normalizePluginId(String(tool.plugin_id), ""),
      name: String(tool.name),
      description: String(tool.description),
      inputSchema: parseJson(tool.input_schema),
      outputSchema: parseJson(tool.output_schema),
      annotations: parseJson(tool.annotations),
      createdAt: numberOrDefault(tool.created_at, Date.now()),
      updatedAt: numberOrDefault(tool.updated_at, Date.now()),
    })),
    definitions: definitions.map((definition) => ({
      scopeId: String(definition.scope_id),
      sourceId: String(definition.source_id),
      pluginId: normalizePluginId(String(definition.plugin_id), ""),
      name: String(definition.name),
      schema: parseJson(definition.schema) ?? {},
      createdAt: numberOrDefault(definition.created_at, Date.now()),
    })),
    pluginStorage: allPluginStorage
      .filter((row) => String(row.collection) !== "source")
      .map((row) => ({
        scopeId: String(row.scope_id),
        pluginId: normalizePluginId(String(row.plugin_id), ""),
        collection: String(row.collection),
        key: String(row.key),
        data: parseJson(row.data),
        createdAt: numberOrDefault(row.created_at, Date.now()),
        updatedAt: numberOrDefault(row.updated_at, Date.now()),
      })),
    blobs: blobs.map((blob) => ({
      namespace: String(blob.namespace),
      key: String(blob.key),
      value: String(blob.value),
    })),
  };
};

const resolveFileAuthPath = (): string => {
  const xdg =
    process.env.XDG_DATA_HOME?.trim() ||
    (process.platform === "win32"
      ? process.env.LOCALAPPDATA || process.env.APPDATA || join(homedir(), "AppData", "Local")
      : join(homedir(), ".local", "share"));
  return join(xdg, "executor", "auth.json");
};

type AuthFile = Record<string, string | Record<string, string>>;

const readAuthFile = (path: string): AuthFile => {
  if (!fs.existsSync(path)) return {};
  return JSON.parse(fs.readFileSync(path, "utf-8")) as AuthFile;
};

const readScopedFileSecret = (auth: AuthFile, scopeId: string, secretId: string): string | null => {
  const scoped = auth[scopeId];
  if (scoped && typeof scoped === "object" && !Array.isArray(scoped)) {
    return scoped[secretId] ?? null;
  }
  const flat = auth[secretId];
  return typeof flat === "string" ? flat : null;
};

const flatAuthEntries = (auth: AuthFile): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(auth)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
};

const writeFlatAuthFile = (path: string, values: Record<string, string>): void => {
  if (Object.keys(values).length === 0) return;
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, path);
};

const keychainBaseServiceName = (): string =>
  process.env.EXECUTOR_KEYCHAIN_SERVICE_NAME?.trim() || "executor";

const providerGet = async (
  provider: string,
  scopeId: string,
  secretId: string,
): Promise<string | null> => {
  if (provider === FILE_PROVIDER) {
    return readScopedFileSecret(readAuthFile(resolveFileAuthPath()), scopeId, secretId);
  }
  if (provider === KEYCHAIN_PROVIDER) {
    const oldProvider = makeKeychainProvider(`${keychainBaseServiceName()}/${scopeId}`);
    return await Effect.runPromise(oldProvider.get(secretId as never));
  }
  return null;
};

interface CollectedSecretValues {
  readonly fileValues: Record<string, string>;
  readonly keychainValues: ReadonlyArray<{ readonly id: string; readonly value: string }>;
  readonly idOverrides: ReadonlyMap<string, string>;
  readonly oauthClientIdValues: ReadonlyMap<string, string>;
  readonly warnings: readonly string[];
}

const collectSecretValues = async (plan: MigrationPlan): Promise<CollectedSecretValues> => {
  const authPath = resolveFileAuthPath();
  const fileValues = flatAuthEntries(readAuthFile(authPath));
  const keychainValues: { id: string; value: string }[] = [];
  const idOverrides = new Map<string, string>();
  const oauthClientIdValues = new Map<string, string>();
  const warnings: string[] = [];

  for (const op of plan.secretOps) {
    if (op.targetProvider !== FILE_PROVIDER && op.targetProvider !== KEYCHAIN_PROVIDER) {
      if (op.fromSecret) idOverrides.set(op.itemId, op.fromSecret.secretId);
      continue;
    }

    const value =
      op.fromText ??
      (op.fromSecret
        ? await providerGet(op.fromSecret.provider, op.fromSecret.scopeId, op.fromSecret.secretId)
        : null);
    if (value == null) {
      warnings.push(
        `Could not resolve local secret "${op.fromSecret?.secretId ?? op.itemId}" from provider "${op.fromSecret?.provider ?? op.targetProvider}".`,
      );
      continue;
    }

    if (op.targetProvider === FILE_PROVIDER) {
      fileValues[op.itemId] = value;
    } else {
      keychainValues.push({ id: op.itemId, value });
    }
  }

  for (const client of plan.oauthClients) {
    if (client.clientId.length > 0 || !client.clientIdSecretRef) continue;
    const value = await providerGet(
      client.clientIdSecretRef.provider,
      client.clientIdSecretRef.scopeId,
      client.clientIdSecretRef.secretId,
    );
    if (value == null) {
      warnings.push(
        `Could not resolve OAuth client id "${client.clientIdSecretRef.secretId}" from provider "${client.clientIdSecretRef.provider}".`,
      );
      continue;
    }
    oauthClientIdValues.set(oauthClientPlanKey(client), value);
  }

  return { fileValues, keychainValues, idOverrides, oauthClientIdValues, warnings };
};

const mapId = (id: string | null, overrides: ReadonlyMap<string, string>): string | null =>
  id == null ? null : (overrides.get(id) ?? id);

const mapItemIds = (
  ids: Record<string, string>,
  overrides: ReadonlyMap<string, string>,
): Record<string, string> =>
  Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, overrides.get(id) ?? id]));

const timestamp = (): number => Date.now();

const ownerSubject = (owner: MigrationOwner, subject: string): string =>
  owner === "org" ? "" : subject;

const clientIdFor = (
  client: MigrationPlan["oauthClients"][number],
  values: ReadonlyMap<string, string>,
): string => client.clientId || values.get(oauthClientPlanKey(client)) || "";

const jsonText = (value: unknown): string | null => {
  if (value == null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
};

const requiredJsonText = (value: unknown): string => jsonText(value) ?? JSON.stringify({});

const sqliteBigintText = (value: number | null): string | null =>
  value == null ? null : String(Math.trunc(value));

const legacyBlobNamespace = (
  namespace: string,
): { readonly scopeId: string; readonly pluginId: string } | null => {
  const slash = namespace.indexOf("/");
  if (slash <= 0 || slash === namespace.length - 1) return null;
  return { scopeId: namespace.slice(0, slash), pluginId: namespace.slice(slash + 1) };
};

const v2BlobNamespace = (owner: OwnerKeys, pluginId: string): string => {
  const partition =
    owner.owner === "org" ? `o:${owner.tenant}` : `u:${owner.tenant}:${owner.subject}`;
  return `${partition}/${pluginId}`;
};

const insertPlan = async (
  client: Client,
  snapshot: LocalV1Snapshot,
  plan: MigrationPlan,
  idOverrides: ReadonlyMap<string, string>,
  oauthClientIdValues: ReadonlyMap<string, string>,
  oauthAuthorizationUrls: ReadonlyMap<string, string>,
  tenantId: string,
  secretValues: CollectedSecretValues,
): Promise<void> => {
  const now = timestamp();
  const ownerForScope = localOwnerForScope(tenantId);
  const connectionTargets = plan.connections.map((connection) => ({
    sourceScopeId: connection.sourceScopeId,
    sourceId: connection.sourceId,
    tenant: connection.row.tenant,
    owner: connection.row.owner,
    subject: ownerSubject(connection.row.owner, connection.row.subject),
    connection: connection.row.name,
  }));
  const runtimeMetadata = buildV1RuntimeMetadataIndex(snapshot.pluginStorage);
  const targetsFor = (scopeId: string, sourceId: string) =>
    connectionTargets.filter(
      (target) => target.sourceScopeId === scopeId && target.sourceId === sourceId,
    );

  await client.execute("BEGIN");
  try {
    for (const row of plan.integrations) {
      await executeSql(
        client,
        "INSERT INTO integration (slug, plugin_id, description, config, can_remove, can_refresh, created_at, updated_at, row_id, tenant) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          row.slug,
          row.plugin_id,
          row.description,
          jsonText(row.config),
          1,
          0,
          now,
          now,
          createId(),
          row.tenant,
        ],
      );
    }

    for (const clientRow of plan.oauthClients) {
      await executeSql(
        client,
        "INSERT INTO oauth_client (slug, authorization_url, token_url, grant, client_id, client_secret_item_id, resource, created_at, row_id, tenant, owner, subject) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          clientRow.slug,
          authorizationUrlFor(clientRow, oauthAuthorizationUrls),
          clientRow.tokenUrl,
          clientRow.grant,
          clientIdFor(clientRow, oauthClientIdValues),
          mapId(clientRow.clientSecretItemId, idOverrides),
          clientRow.resource,
          now,
          createId(),
          clientRow.ownerKeys.tenant,
          clientRow.ownerKeys.owner,
          ownerSubject(clientRow.ownerKeys.owner, clientRow.ownerKeys.subject),
        ],
      );
    }

    for (const connection of plan.connections) {
      const row = connection.row;
      await executeSql(
        client,
        "INSERT INTO connection (integration, name, template, provider, item_ids, identity_label, oauth_client, oauth_client_owner, refresh_item_id, expires_at, oauth_scope, provider_state, created_at, updated_at, row_id, tenant, owner, subject) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          row.integration,
          row.name,
          row.template,
          row.provider,
          JSON.stringify(mapItemIds(connection.itemIds, idOverrides)),
          row.identityLabel,
          row.oauthClientSlug,
          row.oauthClientOwner,
          mapId(connection.refreshItemId, idOverrides),
          sqliteBigintText(row.expiresAt),
          row.oauthScope,
          null,
          now,
          now,
          createId(),
          row.tenant,
          row.owner,
          ownerSubject(row.owner, row.subject),
        ],
      );
    }

    for (const row of snapshot.tools) {
      for (const target of targetsFor(row.scopeId, row.sourceId)) {
        await executeSql(
          client,
          "INSERT INTO tool (integration, connection, plugin_id, name, description, input_schema, output_schema, annotations, created_at, updated_at, row_id, tenant, owner, subject) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            row.sourceId,
            target.connection,
            row.pluginId,
            row.name,
            row.description,
            jsonText(row.inputSchema),
            jsonText(row.outputSchema),
            jsonText(migrateV1ToolAnnotations(row, runtimeMetadata)),
            row.createdAt,
            row.updatedAt,
            createId(),
            target.tenant,
            target.owner,
            target.subject,
          ],
        );
      }
    }

    for (const row of snapshot.definitions) {
      for (const target of targetsFor(row.scopeId, row.sourceId)) {
        await executeSql(
          client,
          "INSERT INTO definition (integration, connection, plugin_id, name, schema, created_at, row_id, tenant, owner, subject) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            row.sourceId,
            target.connection,
            row.pluginId,
            row.name,
            requiredJsonText(row.schema),
            row.createdAt,
            createId(),
            target.tenant,
            target.owner,
            target.subject,
          ],
        );
      }
    }

    for (const row of snapshot.pluginStorage) {
      const migrated = migrateV1PluginStorageRuntimeRow(row);
      const baseOwner = ownerForScope(row.scopeId);
      const owner =
        baseOwner && migrated.owner === "catalog"
          ? { ...baseOwner, owner: "org" as const, subject: "" }
          : baseOwner;
      if (!owner) continue;
      await executeSql(
        client,
        "INSERT INTO plugin_storage (plugin_id, collection, key, data, created_at, updated_at, row_id, tenant, owner, subject) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          migrated.pluginId,
          migrated.collection,
          migrated.key,
          requiredJsonText(migrated.data),
          row.createdAt,
          row.updatedAt,
          createId(),
          owner.tenant,
          owner.owner,
          ownerSubject(owner.owner, owner.subject),
        ],
      );
    }

    for (const row of snapshot.blobs) {
      const parsed = legacyBlobNamespace(row.namespace);
      if (!parsed) continue;
      const owner = ownerForScope(parsed.scopeId);
      if (!owner) continue;
      const namespace = v2BlobNamespace(owner, parsed.pluginId);
      await executeSql(
        client,
        "INSERT INTO blob (namespace, key, value, row_id, id) VALUES (?, ?, ?, ?, ?)",
        [namespace, row.key, row.value, createId(), JSON.stringify([namespace, row.key])],
      );
    }

    for (const policy of plan.policies) {
      await executeSql(
        client,
        "INSERT INTO tool_policy (id, pattern, action, position, created_at, updated_at, row_id, tenant, owner, subject) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          policy.id,
          policy.pattern,
          policy.action,
          policy.position,
          now,
          now,
          createId(),
          policy.owner.tenant,
          policy.owner.owner,
          ownerSubject(policy.owner.owner, policy.owner.subject),
        ],
      );
    }

    // Secrets live outside this SQLite transaction (file/keychain providers), so
    // they cannot be made atomically durable with the DB. Write them before the
    // v1→v2 stamp and keep the writes idempotent; if the process dies before
    // COMMIT, the next boot replays the same secret writes harmlessly.
    await writeMigratedSecrets(secretValues);
    await pauseMigrationForTest("secrets-written");
    await executeSql(
      client,
      "CREATE TABLE IF NOT EXISTS data_migration (name TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)",
    );
    await executeSql(client, "INSERT INTO data_migration (name, time_completed) VALUES (?, ?)", [
      LOCAL_V1_V2_LEDGER_NAME,
      Date.now(),
    ]);

    await client.execute("COMMIT");
  } catch (cause) {
    await client.execute("ROLLBACK");
    throw cause;
  }
};

// libSQL releases its OS file handle in a native finalizer, which on Windows
// only runs on garbage collection and so lags client.close(). Forcing a GC
// runs the finalizer, releasing the handle so a follow-up rename/rm succeeds.
// No-op outside the Bun runtime (e.g. vitest on Node), where this is unneeded.
const nudgeNativeHandleRelease = (): void => {
  const bun = (globalThis as { Bun?: { gc?: (sync: boolean) => void } }).Bun;
  bun?.gc?.(true);
};

// Windows reports EBUSY/EPERM on rename for a short window after a SQLite
// handle closes (handle release lags the close call, and antivirus scanners
// briefly lock the file). POSIX renames never hit this — retry with a short
// backoff, forcing handle release first, instead of failing the whole migration.
const renameWithRetry = async (source: string, target: string): Promise<void> => {
  // ~8s total. 1.9s was not enough on Windows: libSQL's native handle and
  // antivirus scans hold the freshly-written db past close() (observed as an
  // EBUSY boot crash in the v1.5.8 publish smoke run).
  const delaysMs = [50, 100, 250, 500, 1000, 2000, 4000];
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(source, target);
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if ((code !== "EBUSY" && code !== "EPERM") || attempt >= delaysMs.length) throw cause;
      nudgeNativeHandleRelease();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delaysMs[attempt]));
    }
  }
};

// Same lingering-handle window as renameWithRetry: on Windows a libSQL file's
// native handle (and antivirus locks) can briefly outlive close(), so removing
// a just-closed source/staging db throws EBUSY/EPERM. POSIX never hits this.
const rmWithRetry = async (path: string): Promise<void> => {
  const delaysMs = [50, 100, 250, 500, 1000, 2000, 4000];
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(path, { force: true });
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if ((code !== "EBUSY" && code !== "EPERM") || attempt >= delaysMs.length) throw cause;
      nudgeNativeHandleRelease();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delaysMs[attempt]));
    }
  }
};

const removeSqliteFileSetWithRetry = async (path: string): Promise<void> => {
  for (const suffix of fileSetSuffixes) await rmWithRetry(`${path}${suffix}`);
};

const fsyncFileIfExists = (path: string): void => {
  if (!fs.existsSync(path)) return;
  // Windows FlushFileBuffers requires a writable handle, so fsync on a
  // read-only ("r") fd throws EPERM and would crash the v1->v2 migration at
  // boot. Open read-write for the flush, and treat fsync as best-effort
  // durability hardening (the rename/copy already wrote the bytes) so a
  // platform or filesystem that refuses the flush does not fail the migration.
  let fd: number;
  try {
    fd = fs.openSync(path, "r+");
  } catch {
    return;
  }
  try {
    fs.fsyncSync(fd);
  } catch {
    // best-effort: some platforms/filesystems refuse fsync on certain handles
  } finally {
    fs.closeSync(fd);
  }
};

const fsyncDirectory = (path: string): void => {
  try {
    const fd = fs.openSync(path, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Some platforms/filesystems do not allow fsync on directories. The rename
    // still happened; this is best-effort durability hardening.
  }
};

const fsyncSqliteFileSet = (path: string): void => {
  for (const suffix of fileSetSuffixes) fsyncFileIfExists(`${path}${suffix}`);
};

const moveSqliteFileSet = async (source: string, target: string): Promise<void> => {
  await renameWithRetry(source, target);
  fsyncDirectory(dirname(target));
  for (const suffix of ["-wal", "-shm"] as const) {
    if (fs.existsSync(`${source}${suffix}`)) {
      await renameWithRetry(`${source}${suffix}`, `${target}${suffix}`);
      fsyncDirectory(dirname(target));
    } else {
      await rmWithRetry(`${target}${suffix}`);
    }
  }
};

const moveExistingSqliteFileSet = async (source: string, target: string): Promise<void> => {
  for (const suffix of fileSetSuffixes) {
    const from = `${source}${suffix}`;
    if (!fs.existsSync(from)) continue;
    const to = `${target}${suffix}`;
    if (fs.existsSync(to)) {
      await rmWithRetry(from);
    } else {
      await renameWithRetry(from, to);
      fsyncDirectory(dirname(to));
    }
  }
};

const copySqliteFileSet = (source: string, target: string): void => {
  removeSqliteFileSet(target);
  for (const suffix of fileSetSuffixes) {
    const from = `${source}${suffix}`;
    const to = `${target}${suffix}`;
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, to);
      fsyncFileIfExists(to);
    } else {
      fs.rmSync(to, { force: true });
    }
  }
  fsyncDirectory(dirname(target));
};

const removeSqliteFileSet = (path: string): void => {
  for (const suffix of fileSetSuffixes) fs.rmSync(`${path}${suffix}`, { force: true });
};

const backupPathFor = (sqlitePath: string, nonce: string): string =>
  `${sqlitePath}.v1-v2-${Date.now()}-${nonce}`;

const stagingPathFor = (sqlitePath: string, nonce: string): string =>
  `${sqlitePath}.building-${nonce}`;

const normalizedSourcePathFor = (sqlitePath: string, nonce: string): string =>
  `${sqlitePath}.source-${nonce}`;

const migrationJournalPath = (sqlitePath: string): string => `${sqlitePath}.v1-v2-migration.json`;

const writeMigrationJournal = async (path: string, journal: MigrationJournal): Promise<void> => {
  fs.mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${journal.nonce}`;
  fs.writeFileSync(tmp, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  fsyncFileIfExists(tmp);
  await renameWithRetry(tmp, path);
  fsyncDirectory(dirname(path));
};

const removeMigrationJournal = (path: string): void => {
  fs.rmSync(path, { force: true });
  fsyncDirectory(dirname(path));
};

type MigrationJournalReadResult =
  | { readonly kind: "missing" }
  | { readonly kind: "valid"; readonly journal: MigrationJournal }
  | { readonly kind: "unreadable"; readonly cause: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isMigrationJournalPhase = (value: unknown): value is MigrationJournalPhase =>
  value === "building" || value === "built" || value === "canonical-moved" || value === "committed";

const isKeychainSecretBackup = (value: unknown): value is KeychainSecretBackup => {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    (typeof value.backupId === "string" || value.backupId === null) &&
    typeof value.existed === "boolean"
  );
};

const isMigrationJournal = (value: unknown): value is MigrationJournal => {
  if (!isRecord(value)) return false;
  const keychainBackups = value.keychainBackups;
  return (
    value.version === 1 &&
    typeof value.source === "string" &&
    typeof value.normalizedSource === "string" &&
    typeof value.staging === "string" &&
    typeof value.backup === "string" &&
    typeof value.authPath === "string" &&
    (typeof value.authBackup === "string" || value.authBackup === null) &&
    typeof value.authExisted === "boolean" &&
    (keychainBackups === undefined ||
      (Array.isArray(keychainBackups) && keychainBackups.every(isKeychainSecretBackup))) &&
    typeof value.nonce === "string" &&
    isMigrationJournalPhase(value.phase)
  );
};

const readMigrationJournal = (path: string): MigrationJournalReadResult => {
  if (!fs.existsSync(path)) return { kind: "missing" };
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf-8"));
    if (!isMigrationJournal(parsed)) {
      return {
        kind: "unreadable",
        cause: new LocalV1V2MigrationError({
          message: `Migration journal has an unrecognized shape: ${path}`,
          cause: parsed,
        }),
      };
    }
    return { kind: "valid", journal: parsed };
  } catch (cause) {
    return { kind: "unreadable", cause };
  }
};

const authBackupInfoForMigration = (
  nonce: string,
): {
  readonly path: string;
  readonly backup: string | null;
  readonly existed: boolean;
} => {
  const path = resolveFileAuthPath();
  const existed = fs.existsSync(path);
  return { path, backup: existed ? `${path}.v1-v2-${nonce}` : null, existed };
};

const writeAuthBackupForMigration = (input: {
  readonly path: string;
  readonly backup: string | null;
  readonly existed: boolean;
}): void => {
  if (!input.existed || !input.backup) return;
  fs.copyFileSync(input.path, input.backup);
  fsyncFileIfExists(input.backup);
  fsyncDirectory(dirname(input.backup));
};

const keychainMigrationBackupId = (nonce: string, id: string): string =>
  `v1-v2-migration-backup:${nonce}:${createHash("sha256").update(id).digest("hex")}`;

const backupKeychainSecretsForMigration = async (input: {
  readonly nonce: string;
  readonly keychainValues: ReadonlyArray<{ readonly id: string; readonly value: string }>;
}): Promise<readonly KeychainSecretBackup[]> => {
  const ids = [...new Set(input.keychainValues.map((entry) => entry.id))].sort();
  if (ids.length === 0) return [];

  const keychain = makeKeychainProvider(keychainBaseServiceName());
  const backups: KeychainSecretBackup[] = [];
  for (const id of ids) {
    const existing = await Effect.runPromise(keychain.get(id as never));
    if (existing === null) {
      backups.push({ id, backupId: null, existed: false });
      continue;
    }

    const backupId = keychainMigrationBackupId(input.nonce, id);
    await Effect.runPromise(keychain.set!(backupId as never, existing));
    backups.push({ id, backupId, existed: true });
  }
  return backups;
};

const restoreKeychainBackupsFromJournal = async (journal: MigrationJournal): Promise<void> => {
  const backups = journal.keychainBackups ?? [];
  if (backups.length === 0) return;

  const keychain = makeKeychainProvider(keychainBaseServiceName());
  for (const backup of backups) {
    if (!backup.existed) {
      await Effect.runPromise(keychain.delete!(backup.id as never));
      continue;
    }
    if (!backup.backupId) {
      throw new LocalV1V2MigrationError({
        message: `Migration journal is missing keychain backup id for ${backup.id}`,
      });
    }
    const value = await Effect.runPromise(keychain.get(backup.backupId as never));
    if (value === null) {
      throw new LocalV1V2MigrationError({
        message: `Migration keychain backup ${backup.backupId} is missing`,
      });
    }
    await Effect.runPromise(keychain.set!(backup.id as never, value));
  }
};

const restoreAuthFromJournal = async (journal: MigrationJournal): Promise<void> => {
  await restoreKeychainBackupsFromJournal(journal);
  if (journal.authBackup && fs.existsSync(journal.authBackup)) {
    fs.mkdirSync(dirname(journal.authPath), { recursive: true, mode: 0o700 });
    const tmp = `${journal.authPath}.restore-${journal.nonce}.tmp`;
    fs.copyFileSync(journal.authBackup, tmp);
    fsyncFileIfExists(tmp);
    await renameWithRetry(tmp, journal.authPath);
  } else if (!journal.authExisted) {
    fs.rmSync(journal.authPath, { force: true });
  }
  fsyncDirectory(dirname(journal.authPath));
};

const cleanupKeychainBackups = async (journal: MigrationJournal): Promise<void> => {
  const keychain = makeKeychainProvider(keychainBaseServiceName());
  for (const backup of journal.keychainBackups ?? []) {
    if (!backup.backupId) continue;
    await Effect.runPromise(keychain.delete!(backup.backupId as never));
  }
};

const cleanupSecretBackups = async (journal: MigrationJournal): Promise<void> => {
  await cleanupKeychainBackups(journal);
  if (journal.authBackup) {
    fs.rmSync(journal.authBackup, { force: true });
    fsyncDirectory(dirname(journal.authBackup));
  }
};

const pauseMigrationForTest = async (point: string): Promise<void> => {
  if (process.env.NODE_ENV !== "test") return;
  if (process.env.EXECUTOR_V1_V2_MIGRATION_PAUSE_AT !== point) return;
  const marker = process.env.EXECUTOR_V1_V2_MIGRATION_PAUSE_FILE;
  if (!marker) return;
  fs.mkdirSync(dirname(marker), { recursive: true });
  fs.writeFileSync(marker, `${point}\n`, { mode: 0o600 });
  fsyncFileIfExists(marker);
  await new Promise<void>(() => {});
};

const writeMigratedSecrets = async (input: {
  readonly fileValues: Record<string, string>;
  readonly keychainValues: ReadonlyArray<{ readonly id: string; readonly value: string }>;
}): Promise<void> => {
  const newKeychain = makeKeychainProvider(keychainBaseServiceName());
  for (const entry of input.keychainValues) {
    await Effect.runPromise(newKeychain.set!(entry.id as never, entry.value));
  }
  writeFlatAuthFile(resolveFileAuthPath(), input.fileValues);
};

interface MigrationExpectedCounts {
  readonly integrations: number;
  readonly connections: number;
  readonly oauthClients: number;
  readonly policies: number;
}

const expectedCountsFor = (plan: MigrationPlan): MigrationExpectedCounts => ({
  integrations: plan.integrations.length,
  connections: plan.connections.length,
  oauthClients: plan.oauthClients.length,
  policies: plan.policies.length,
});

const scalarNumber = async (client: Client, sql: string): Promise<number> => {
  const result = await client.execute(sql);
  const value = result.rows[0]?.["n"];
  return typeof value === "number" ? value : Number(value ?? 0);
};

const checkpointTruncate = async (client: Client, path: string): Promise<void> => {
  const result = await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  const row = result.rows[0] ?? {};
  const busy = Number(row["busy"] ?? 0);
  const log = Number(row["log"] ?? 0);
  const checkpointed = Number(row["checkpointed"] ?? 0);
  if (busy !== 0 || log !== checkpointed) {
    throw new LocalV1V2MigrationError({
      message: `Could not fully checkpoint SQLite WAL for ${path}`,
      cause: row,
    });
  }
};

const checkpointSqliteFileSetIfBaseExists = async (path: string): Promise<void> => {
  if (!fs.existsSync(path)) return;
  const client = await openLocalLibsql(path);
  try {
    await checkpointTruncate(client, path);
  } finally {
    client.close();
  }
  fsyncSqliteFileSet(path);
};

const verifyStagingDatabase = async (
  path: string,
  expected: MigrationExpectedCounts,
): Promise<void> => {
  const client = await openLocalLibsql(path);
  try {
    const integrity = await client.execute("PRAGMA integrity_check");
    if (integrity.rows[0]?.["integrity_check"] !== "ok") {
      throw new LocalV1V2MigrationError({
        message: `Staged v2 database failed integrity_check: ${JSON.stringify(integrity.rows)}`,
        cause: integrity.rows,
      });
    }
    const stamped = await queryFirst<{ name: string }>(
      client,
      "SELECT name FROM data_migration WHERE name = ?",
      [LOCAL_V1_V2_LEDGER_NAME],
    );
    if (!stamped) {
      throw new LocalV1V2MigrationError({
        message: "Staged v2 database is missing the v1→v2 stamp",
      });
    }

    const actual = {
      integrations: await scalarNumber(client, "SELECT COUNT(*) AS n FROM integration"),
      connections: await scalarNumber(client, "SELECT COUNT(*) AS n FROM connection"),
      oauthClients: await scalarNumber(client, "SELECT COUNT(*) AS n FROM oauth_client"),
      policies: await scalarNumber(client, "SELECT COUNT(*) AS n FROM tool_policy"),
    };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new LocalV1V2MigrationError({
        message: `Staged v2 database row-count mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        cause: { expected, actual },
      });
    }
    await checkpointTruncate(client, path);
  } finally {
    client.close();
  }
  fsyncSqliteFileSet(path);
};

const completeJournaledFlip = async (
  journalPath: string,
  journal: MigrationJournal,
): Promise<void> => {
  // The staging base file is the monotonic recovery marker. While it exists,
  // the staged v2 DB has not been installed yet, so it is safe to keep moving
  // any remaining canonical v1 file-set members to the backup and then consume
  // staging. Once the staging base is gone, the install rename already happened
  // and `source` may hold the v2 DB; recovery must never move/delete it again.
  if (fs.existsSync(journal.staging)) {
    await checkpointSqliteFileSetIfBaseExists(journal.source);
    await writeMigrationJournal(journalPath, { ...journal, phase: "canonical-moved" });
    await moveExistingSqliteFileSet(journal.source, journal.backup);
    await pauseMigrationForTest("canonical-moved");
    await moveSqliteFileSet(journal.staging, journal.source);
    await pauseMigrationForTest("staging-consumed");
  }
  await writeMigrationJournal(journalPath, { ...journal, phase: "committed" });
  await removeSqliteFileSetWithRetry(journal.normalizedSource);
  await removeSqliteFileSetWithRetry(journal.staging);
  await cleanupSecretBackups(journal);
  removeMigrationJournal(journalPath);
};

type MigrationRecoveryResult = "missing" | "recovered" | "unreadable";

const recoverV1V2Migration = async (sqlitePath: string): Promise<MigrationRecoveryResult> => {
  const journalPath = migrationJournalPath(sqlitePath);
  const journalRead = readMigrationJournal(journalPath);
  if (journalRead.kind === "missing") return "missing";
  if (journalRead.kind === "unreadable") {
    if (fs.existsSync(sqlitePath)) return "unreadable";
    throw new LocalV1V2MigrationError({
      message: `Cannot recover local v1→v2 migration because the journal is unreadable and the canonical database is missing: ${journalPath}`,
      cause: journalRead.cause,
    });
  }

  const { journal } = journalRead;
  if (journal.phase === "building") {
    await removeSqliteFileSetWithRetry(journal.normalizedSource);
    await removeSqliteFileSetWithRetry(journal.staging);
    await restoreAuthFromJournal(journal);
    await cleanupSecretBackups(journal);
    removeMigrationJournal(journalPath);
    return "recovered";
  }

  if (journal.phase === "built" || journal.phase === "canonical-moved") {
    await completeJournaledFlip(journalPath, journal);
    return "recovered";
  }

  await removeSqliteFileSetWithRetry(journal.normalizedSource);
  await removeSqliteFileSetWithRetry(journal.staging);
  await cleanupSecretBackups(journal);
  removeMigrationJournal(journalPath);
  return "recovered";
};

// No migration-internal process lock: this runs only inside
// openOwnedLocalDatabase, after the data-dir ownership lock is acquired, so the
// caller guarantees this process is the sole writer of the data dir. The
// journal + recoverV1V2Migration still cover the orthogonal failure where this
// sole owner dies mid-migration and the next sole owner resumes.
export const migrateLocalV1ToV2IfNeeded = async (
  options: LocalV1V2MigrationOptions,
): Promise<LocalV1V2MigrationResult> => {
  const journalPath = migrationJournalPath(options.sqlitePath);

  const recovery = await recoverV1V2Migration(options.sqlitePath);

  if (!fs.existsSync(options.sqlitePath)) return { migrated: false, warnings: [] };

  // The caller holds the data-dir ownership lock, so this process is the sole
  // writer and recovery already ran above. A single probe decides the outcome:
  // already-migrated databases short-circuit on their ledger stamp, and only an
  // actual v1 database falls through to the heavy copy/stage/flip path below.
  const probe: Client = await openLocalLibsql(options.sqlitePath);
  try {
    if (await hasV1GateStamp(probe)) {
      if (recovery === "unreadable") removeMigrationJournal(journalPath);
      return { migrated: false, warnings: [] };
    }
    if (!(await isLocalV1Database(probe))) {
      if (recovery === "unreadable") removeMigrationJournal(journalPath);
      return { migrated: false, warnings: [] };
    }
  } finally {
    probe.close();
  }

  let normalizedSourcePath: string | null = null;
  let stagingPath: string | null = null;
  let target: Awaited<ReturnType<typeof createSqliteFumaDb>> | null = null;
  let reader: Client | null = null;
  let journal: MigrationJournal | null = null;
  let authBackup: ReturnType<typeof authBackupInfoForMigration> | null = null;
  let flipStarted = false;

  try {
    const nonce = randomBytes(4).toString("hex");
    normalizedSourcePath = normalizedSourcePathFor(options.sqlitePath, nonce);
    stagingPath = stagingPathFor(options.sqlitePath, nonce);
    const backupPath = backupPathFor(options.sqlitePath, nonce);
    authBackup = authBackupInfoForMigration(nonce);

    journal = {
      version: 1,
      source: options.sqlitePath,
      normalizedSource: normalizedSourcePath,
      staging: stagingPath,
      backup: backupPath,
      authPath: authBackup.path,
      authBackup: authBackup.backup,
      authExisted: authBackup.existed,
      keychainBackups: [],
      nonce,
      phase: "building",
    };
    await writeMigrationJournal(journalPath, journal);
    await pauseMigrationForTest("journal-written");
    writeAuthBackupForMigration(authBackup);
    await pauseMigrationForTest("building");

    copySqliteFileSet(options.sqlitePath, normalizedSourcePath);
    reader = await openLocalLibsql(normalizedSourcePath);

    const replayWarnings: string[] = [];
    // Legacy replay is intentionally confined to the normalized source copy;
    // the canonical data.db remains a complete v1 database until the final
    // journaled flip installs the staged v2 database.
    await replayLegacyV1Migrations(reader, replayWarnings);
    const snapshot = await readV1Snapshot(reader, options.tenantId);
    reader.close();
    reader = null;

    const plan = planMigration(snapshot.input);
    const secretValues = await collectSecretValues(plan);
    journal = {
      ...journal,
      keychainBackups: await backupKeychainSecretsForMigration({
        nonce,
        keychainValues: secretValues.keychainValues,
      }),
    };
    await writeMigrationJournal(journalPath, journal);
    const oauthAuthorizationUrls = await resolveMigrationOAuthAuthorizationUrls(plan, {
      fetch: options.oauthMetadataFetch ?? fetch,
      timeoutMs: options.oauthMetadataTimeoutMs,
    });

    target = await createSqliteFumaDb({
      tables: options.tables,
      namespace: options.namespace,
      path: stagingPath,
    });
    await insertPlan(
      target.client,
      snapshot,
      plan,
      secretValues.idOverrides,
      secretValues.oauthClientIdValues,
      oauthAuthorizationUrls,
      options.tenantId,
      secretValues,
    );
    await checkpointTruncate(target.client, stagingPath);
    await target.close();
    target = null;
    await pauseMigrationForTest("staging-built");

    await verifyStagingDatabase(stagingPath, expectedCountsFor(plan));
    // The flip is a single base-file rename from staging to canonical. The
    // checkpoint above put all staged data in the base DB, so discard volatile
    // WAL/SHM sidecars before journaling the staged DB as complete; otherwise a
    // crash mid-sidecar move would make staging appear present after the base DB
    // had already been installed.
    for (const suffix of ["-wal", "-shm"] as const) await rmWithRetry(`${stagingPath}${suffix}`);
    fsyncDirectory(dirname(stagingPath));
    await writeMigrationJournal(journalPath, { ...journal, phase: "built" });
    await pauseMigrationForTest("built");
    flipStarted = true;
    await completeJournaledFlip(journalPath, { ...journal, phase: "built" });

    normalizedSourcePath = null;
    stagingPath = null;
    journal = null;
    return {
      migrated: true,
      backupPath,
      report: plan.report,
      warnings: [...replayWarnings, ...plan.report.warnings, ...secretValues.warnings],
    };
  } catch (cause) {
    if (target) await target.close();
    if (reader) reader.close();
    if (!flipStarted) {
      if (journal) {
        await restoreAuthFromJournal(journal);
        await cleanupSecretBackups(journal);
      }
      if (normalizedSourcePath) await removeSqliteFileSetWithRetry(normalizedSourcePath);
      if (stagingPath) await removeSqliteFileSetWithRetry(stagingPath);
      removeMigrationJournal(journalPath);
    }
    throw cause;
  }
};
