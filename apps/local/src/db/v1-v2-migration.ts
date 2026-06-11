/* oxlint-disable executor/no-json-parse, executor/no-raw-fetch, executor/no-try-catch-or-throw -- boundary: one-shot local SQLite/auth-file migration normalizes legacy on-disk state */

import type { Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { Effect } from "effect";
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

const FILE_PROVIDER = "file";
const KEYCHAIN_PROVIDER = "keychain";

const fileSetSuffixes = ["", "-wal", "-shm"] as const;

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

/** Bring a v1 database that predates v1-final up to the last v1 schema. Only
 *  replays when the database's drizzle history is a strict prefix of the
 *  bundled legacy chain — anything else is left as-is with a warning (the
 *  data migration may still succeed if the schema is close enough). */
const replayLegacyV1Migrations = async (client: Client, warnings: string[]): Promise<void> => {
  if (!(await tableExists(client, "__drizzle_migrations"))) {
    warnings.push(
      "v1 database has no drizzle migration history; skipping the legacy schema replay.",
    );
    return;
  }
  const migrationsFolder = resolveLegacyMigrationsFolder();
  const bundled = readBundledLegacyMigrationHashes(migrationsFolder);
  const applied = await readAppliedLegacyMigrationHashes(client);
  const isPrefix =
    applied.length <= bundled.length && applied.every((hash, index) => hash === bundled[index]);
  if (!isPrefix) {
    warnings.push(
      "v1 database migration history does not match this build's bundled legacy migrations; reading the schema as-is.",
    );
    return;
  }
  if (applied.length === bundled.length) return; // already v1-final
  await migrate(drizzle({ client }), { migrationsFolder });
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
  if (fs.existsSync(path)) {
    fs.copyFileSync(path, `${path}.v1-v2-${Date.now()}-${randomBytes(4).toString("hex")}`);
  }
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

const collectSecretValues = async (
  plan: MigrationPlan,
): Promise<{
  readonly fileValues: Record<string, string>;
  readonly keychainValues: ReadonlyArray<{ readonly id: string; readonly value: string }>;
  readonly idOverrides: ReadonlyMap<string, string>;
  readonly oauthClientIdValues: ReadonlyMap<string, string>;
  readonly warnings: readonly string[];
}> => {
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

    await client.execute("COMMIT");
  } catch (cause) {
    await client.execute("ROLLBACK");
    throw cause;
  }
};

// Windows reports EBUSY/EPERM on rename for a short window after a SQLite
// handle closes (handle release lags the close call, and antivirus scanners
// briefly lock the file). POSIX renames never hit this — retry with a short
// backoff instead of failing the whole migration.
const renameWithRetry = async (source: string, target: string): Promise<void> => {
  const delaysMs = [50, 100, 250, 500, 1000];
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(source, target);
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if ((code !== "EBUSY" && code !== "EPERM") || attempt >= delaysMs.length) throw cause;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delaysMs[attempt]));
    }
  }
};

const moveSqliteFileSet = async (source: string, target: string): Promise<void> => {
  await renameWithRetry(source, target);
  for (const suffix of ["-wal", "-shm"] as const) {
    if (fs.existsSync(`${source}${suffix}`))
      await renameWithRetry(`${source}${suffix}`, `${target}${suffix}`);
  }
};

const removeSqliteFileSet = (path: string): void => {
  for (const suffix of fileSetSuffixes) fs.rmSync(`${path}${suffix}`, { force: true });
};

const backupPathFor = (sqlitePath: string): string =>
  `${sqlitePath}.v1-v2-${Date.now()}-${randomBytes(4).toString("hex")}`;

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

export const migrateLocalV1ToV2IfNeeded = async (
  options: LocalV1V2MigrationOptions,
): Promise<LocalV1V2MigrationResult> => {
  if (!fs.existsSync(options.sqlitePath)) return { migrated: false, warnings: [] };

  const reader = await openLocalLibsql(options.sqlitePath);
  try {
    if (!(await isLocalV1Database(reader))) return { migrated: false, warnings: [] };
    const replayWarnings: string[] = [];
    await replayLegacyV1Migrations(reader, replayWarnings);
    const snapshot = await readV1Snapshot(reader, options.tenantId);
    const plan = planMigration(snapshot.input);
    const secretValues = await collectSecretValues(plan);
    const oauthAuthorizationUrls = await resolveMigrationOAuthAuthorizationUrls(plan, {
      fetch: options.oauthMetadataFetch ?? fetch,
      timeoutMs: options.oauthMetadataTimeoutMs,
    });
    const backupPath = backupPathFor(options.sqlitePath);

    reader.close();
    await moveSqliteFileSet(options.sqlitePath, backupPath);

    let target: Awaited<ReturnType<typeof createSqliteFumaDb>> | null = null;
    try {
      target = await createSqliteFumaDb({
        tables: options.tables,
        namespace: options.namespace,
        path: options.sqlitePath,
      });
      await insertPlan(
        target.client,
        snapshot,
        plan,
        secretValues.idOverrides,
        secretValues.oauthClientIdValues,
        oauthAuthorizationUrls,
        options.tenantId,
      );
      await target.close();
      target = null;
      await writeMigratedSecrets(secretValues);
      return {
        migrated: true,
        backupPath,
        report: plan.report,
        warnings: [...replayWarnings, ...plan.report.warnings, ...secretValues.warnings],
      };
    } catch (cause) {
      if (target) await target.close();
      removeSqliteFileSet(options.sqlitePath);
      if (fs.existsSync(backupPath)) await moveSqliteFileSet(backupPath, options.sqlitePath);
      throw cause;
    }
  } finally {
    try {
      reader.close();
    } catch {
      // already closed after the snapshot was read
    }
  }
};
