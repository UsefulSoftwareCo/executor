/* oxlint-disable executor/no-double-cast, executor/no-error-constructor, executor/no-json-parse, executor/no-try-catch-or-throw -- boundary: one-shot operator migration adapts SQL/WorkOS Promise APIs and fails hard on unsafe cutover preconditions */
/**
 * v1 -> v2 cloud migration runner (operator-run, out-of-band).
 *
 * DRY-RUN by default: reads the v1 tables read-only, builds the full v2 plan via
 * the pure `planMigration` weave, and prints the report. Nothing is written.
 *
 *   op run --env-file=apps/cloud/.env.production -- bun apps/cloud/scripts/migrate-v1-v2.ts
 *
 * APPLY is intentionally double-gated:
 *
 *   op run --env-file=apps/cloud/.env.production -- \
 *     bun apps/cloud/scripts/migrate-v1-v2.ts --apply --confirm-v1-v2-cutover
 *
 * Repair already-migrated OAuth authorization URLs from archived v1 metadata:
 *
 *   op run --env-file=apps/cloud/.env.production -- \
 *     bun apps/cloud/scripts/migrate-v1-v2.ts --repair-oauth-authorization-urls
 *
 *   op run --env-file=apps/cloud/.env.production -- \
 *     bun apps/cloud/scripts/migrate-v1-v2.ts --repair-oauth-authorization-urls --apply --confirm-oauth-authorization-url-repair
 *
 * Apply copies WorkOS Vault values into deterministic v2 item ids first, then
 * runs the structural Postgres transaction: archive v1 executor tables as
 * `v1_*`, create the v2 executor tables, and upsert the planned v2 rows.
 *
 * It never deletes v1 WorkOS Vault objects. Cleanup is a later, separate step.
 */
import { Effect } from "effect";
import { createId } from "fumadb/cuid";
import postgres, { type Sql } from "postgres";

import {
  API_KEY_TEMPLATE_SLUG,
  DEFAULT_VAULT_PREFIX,
  OAUTH_TEMPLATE_SLUG,
  PRIMARY_INPUT_VARIABLE,
  buildV1RuntimeMetadataIndex,
  migrateGraphqlSourceConfig,
  migrateMcpSourceConfig,
  migrateOpenApiSourceConfig,
  migrateV1PluginStorageRuntimeRow,
  migrateV1ToolAnnotations,
  migrationOAuthAuthorizationUrlFor as authorizationUrlFor,
  migrationOAuthClientAuthorizationUrlResolutionSource as oauthAuthorizationResolutionSource,
  migrationOAuthClientNeedsAuthorizationUrlResolution as needsOAuthAuthorizationResolution,
  migrationOAuthClientPlanKey as oauthClientPlanKey,
  migrationSourceKey,
  parseScope,
  planMigration,
  resolveMigrationOAuthAuthorizationUrls,
  vaultV1LegacyObjectName,
  vaultV1ObjectName,
  vaultV2ObjectName,
  type MigratedSourceConfig,
  type MigrationInput,
  type MigrationOAuthMetadataFetch,
  type MigrationOwner,
  type MigrationPlan,
  type OwnerKeys,
  type SecretOp,
  type V1SourceRow,
} from "@executor-js/sdk/migration";
import {
  makeConfiguredWorkOSVaultClient,
  type WorkOSVaultClient,
  type WorkOSVaultClientError,
  type WorkOSVaultObject,
} from "@executor-js/plugin-workos-vault";

type Pg = Sql<Record<string, unknown>>;
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
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface V1DefinitionRow {
  readonly scopeId: string;
  readonly sourceId: string;
  readonly pluginId: string;
  readonly name: string;
  readonly schema: unknown;
  readonly createdAt: Date;
}

interface V1PluginStorageRow {
  readonly scopeId: string;
  readonly pluginId: string;
  readonly collection: string;
  readonly key: string;
  readonly data: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface V1BlobRow {
  readonly namespace: string;
  readonly key: string;
  readonly value: string;
}

interface CloudV1Snapshot {
  readonly input: MigrationInput;
  readonly tools: readonly V1ToolRow[];
  readonly definitions: readonly V1DefinitionRow[];
  readonly pluginStorage: readonly V1PluginStorageRow[];
  readonly blobs: readonly V1BlobRow[];
  readonly v1Prefix: "" | "v1_";
}

interface WorkosSecretCopyResult {
  readonly oauthClientIdValues: ReadonlyMap<string, string>;
  readonly metadataRows: readonly WorkosVaultMetadataRow[];
  readonly copied: number;
  readonly existing: number;
  readonly missing: readonly string[];
  readonly warnings: readonly string[];
}

interface WorkosVaultMetadataRow {
  readonly owner: OwnerKeys;
  readonly id: string;
  readonly name: string;
  readonly purpose: string | null;
  readonly createdAt: Date;
}

export interface CloudMigrationResult {
  readonly applied: boolean;
  readonly report: MigrationPlan["report"];
  readonly secretCopy?: {
    readonly copied: number;
    readonly existing: number;
    readonly missing: readonly string[];
    readonly warnings: readonly string[];
  };
}

export interface CloudOAuthAuthorizationUrlRepairRow {
  readonly tenant: string;
  readonly owner: MigrationOwner;
  readonly subject: string;
  readonly slug: string;
  readonly currentAuthorizationUrl: string;
  readonly repairedAuthorizationUrl: string;
  readonly resolutionSource: string;
}

export interface CloudOAuthAuthorizationUrlRepairResult {
  readonly applied: boolean;
  readonly checked: number;
  readonly changed: readonly CloudOAuthAuthorizationUrlRepairRow[];
}

export interface CloudMigrationOptions {
  readonly sql: Pg;
  readonly apply: boolean;
  readonly confirmApply?: boolean;
  readonly objectPrefix?: string;
  readonly oauthMetadataFetch?: MigrationOAuthMetadataFetch;
  readonly oauthMetadataTimeoutMs?: number;
  readonly workosCredentials?: {
    readonly apiKey: string;
    readonly clientId: string;
  };
  readonly vaultClient?: WorkOSVaultClient;
  readonly log?: (message: string) => void;
  readonly now?: Date;
}

export interface CloudOAuthAuthorizationUrlRepairOptions {
  readonly sql: Pg;
  readonly apply: boolean;
  readonly confirmApply?: boolean;
  readonly oauthMetadataFetch?: MigrationOAuthMetadataFetch;
  readonly oauthMetadataTimeoutMs?: number;
  readonly log?: (message: string) => void;
  readonly now?: Date;
}

const APPLY = process.argv.includes("--apply");
const CONFIRM_APPLY = process.argv.includes("--confirm-v1-v2-cutover");
const REPAIR_OAUTH_AUTHORIZATION_URLS = process.argv.includes("--repair-oauth-authorization-urls");
const CONFIRM_REPAIR_OAUTH_AUTHORIZATION_URLS = process.argv.includes(
  "--confirm-oauth-authorization-url-repair",
);
const WORKOS_VAULT_PROVIDER = "workos-vault";
const WORKOS_VAULT_METADATA_PLUGIN_ID = "workos-vault";
const WORKOS_VAULT_METADATA_COLLECTION = "metadata";
const VAULT_CONTEXT = { app: "executor" } as const;
const MAX_CONFLICT_ATTEMPTS = 3;
const MAX_KEK_NOT_READY_ATTEMPTS = 20;
const KEK_NOT_READY_BACKOFF_MS = 1000;

const v1ExecutorTables = [
  "source",
  "secret",
  "credential_binding",
  "connection",
  "oauth2_session",
  "tool_policy",
  "tool",
  "definition",
  "plugin_storage",
  "blob",
] as const;

const quoteIdent = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const tableName = (prefix: "" | "v1_", name: string): string => `${prefix}${name}`;

const tableExists = async (sql: Pg, name: string): Promise<boolean> => {
  const rows = await sql<{ exists: boolean }[]>`
    select to_regclass(${name}) is not null as "exists"
  `;
  return rows[0]?.exists === true;
};

const indexExists = async (sql: Pg, name: string): Promise<boolean> => {
  const rows = await sql<{ exists: boolean }[]>`
    select to_regclass(${name}) is not null as "exists"
  `;
  return rows[0]?.exists === true;
};

const columnNames = async (sql: Pg, table: string): Promise<ReadonlySet<string>> => {
  const rows = await sql<{ column_name: string }[]>`
    select column_name
    from information_schema.columns
    where table_schema = current_schema()
      and table_name = ${table}
  `;
  return new Set(rows.map((row) => row.column_name));
};

const optionalColumn = (columns: ReadonlySet<string>, table: string, column: string): string =>
  columns.has(column) ? `${quoteIdent(table)}.${quoteIdent(column)}` : "NULL";

const resolveV1Prefix = async (sql: Pg): Promise<"" | "v1_"> => {
  const hasLiveV1 = await tableExists(sql, "source");
  const hasArchivedV1 = await tableExists(sql, "v1_source");
  if (hasLiveV1 && hasArchivedV1) {
    throw new Error("Both source and v1_source exist; refusing ambiguous migration input.");
  }
  if (hasLiveV1) return "";
  if (hasArchivedV1) return "v1_";
  throw new Error("No v1 source table found (expected source or v1_source).");
};

const rows = async (sql: Pg, query: string): Promise<Row[]> =>
  (await sql.unsafe(query)) as unknown as Row[];

const parseJson = (value: unknown): unknown => {
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

const dateOrNow = (value: unknown, now: Date): Date => {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === "number" || typeof value === "string") {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date;
  }
  return now;
};

const normalizePluginId = (pluginId: string, kind: string): string =>
  pluginId === "graphql-greenfield" ? "graphql" : pluginId || kind;

const buildConfig = (kind: string, data: Record<string, unknown>): MigratedSourceConfig => {
  const cfg = (data.config as Record<string, unknown> | undefined) ?? data;
  if (kind === "mcp") return migrateMcpSourceConfig(cfg as never);
  if (kind === "graphql") return migrateGraphqlSourceConfig(cfg as never);
  return migrateOpenApiSourceConfig(cfg as never);
};

const sourceKeyForBinding = (binding: Row): string =>
  migrationSourceKey(
    binding.source_scope_id == null ? String(binding.scope_id) : String(binding.source_scope_id),
    String(binding.source_id),
  );

const templateSlugForSlot = (slotKey: string): string => {
  if (slotKey === "auth:oauth2:connection") return OAUTH_TEMPLATE_SLUG;
  if (slotKey.startsWith("oauth2:") && slotKey.endsWith(":connection")) {
    const [, scheme] = slotKey.split(":");
    return scheme || OAUTH_TEMPLATE_SLUG;
  }
  return API_KEY_TEMPLATE_SLUG;
};

const variableNameForApiKeySlot = (slotKey: string, multiInput: boolean): string => {
  if (!multiInput) return PRIMARY_INPUT_VARIABLE;
  return (
    slotKey
      .replace(/^(header|query_param|spec_fetch_header):/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "input"
  );
};

const inferDryRunConfigsFromBindings = (
  bindings: readonly Row[],
): ReadonlyMap<string, MigratedSourceConfig> => {
  const bindingsBySource = new Map<string, Row[]>();
  for (const binding of bindings) {
    const key = sourceKeyForBinding(binding);
    const list = bindingsBySource.get(key) ?? [];
    list.push(binding);
    bindingsBySource.set(key, list);
  }

  const configs = new Map<string, MigratedSourceConfig>();
  for (const [key, sourceBindings] of bindingsBySource) {
    const slotToTemplateSlug: Record<string, string> = {};
    const slotToVariable: Record<string, string> = {};
    const apiKeySlots = [
      ...new Set(
        sourceBindings
          .filter((binding) => String(binding.kind) === "secret")
          .map((binding) => String(binding.slot_key)),
      ),
    ];
    const multiApiKeyInput = apiKeySlots.length > 1;

    for (const binding of sourceBindings) {
      const slotKey = String(binding.slot_key);
      slotToTemplateSlug[slotKey] = templateSlugForSlot(slotKey);
      slotToVariable[slotKey] =
        slotToTemplateSlug[slotKey] === API_KEY_TEMPLATE_SLUG
          ? variableNameForApiKeySlot(slotKey, multiApiKeyInput)
          : PRIMARY_INPUT_VARIABLE;
    }

    configs.set(key, {
      config: {},
      slotToTemplateSlug,
      slotToVariable,
      warnings: [],
    });
  }
  return configs;
};

const readV1Snapshot = async (
  sql: Pg,
  now: Date,
  includeStructuralRows: boolean,
  log?: (message: string) => void,
): Promise<CloudV1Snapshot> => {
  const v1Prefix = await resolveV1Prefix(sql);
  log?.(`snapshot:         reading ${v1Prefix === "" ? "live v1" : "archived v1"} tables`);
  const t = (name: string) => quoteIdent(tableName(v1Prefix, name));
  const toolTable = tableName(v1Prefix, "tool");
  const definitionTable = tableName(v1Prefix, "definition");
  const bindingTable = tableName(v1Prefix, "credential_binding");

  const hasDefinition = includeStructuralRows && (await tableExists(sql, definitionTable));
  const hasBlob = includeStructuralRows && (await tableExists(sql, tableName(v1Prefix, "blob")));
  const bindingColumns = await columnNames(sql, bindingTable);
  const toolColumns = includeStructuralRows ? await columnNames(sql, toolTable) : new Set<string>();
  const definitionColumns = hasDefinition
    ? await columnNames(sql, definitionTable)
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
    toolRows,
    definitionRows,
    blobRows,
  ] = await Promise.all([
    rows(sql, `select scope_id, id, plugin_id, kind, name from ${t("source")}`),
    rows(sql, `select id, scope_id, name, provider, owned_by_connection_id from ${t("secret")}`),
    rows(
      sql,
      `select scope_id, ${optionalColumn(bindingColumns, tableName(v1Prefix, "credential_binding"), "source_scope_id")} as source_scope_id, source_id, slot_key, kind, secret_id, ${optionalColumn(bindingColumns, tableName(v1Prefix, "credential_binding"), "secret_scope_id")} as secret_scope_id, connection_id, text_value from ${t("credential_binding")}`,
    ),
    rows(
      sql,
      `select id, scope_id, provider, identity_label, access_token_secret_id, refresh_token_secret_id, expires_at, provider_state from ${t("connection")}`,
    ),
    rows(sql, `select id, scope_id, pattern, action, position from ${t("tool_policy")}`),
    includeStructuralRows
      ? rows(
          sql,
          `select ps.scope_id, ps.key as source_id, ps.data, s.kind from ${t("plugin_storage")} ps join ${t("source")} s on ps.key = s.id and ps.scope_id = s.scope_id where ps.collection = 'source'`,
        )
      : Promise.resolve([]),
    includeStructuralRows
      ? rows(
          sql,
          `select scope_id, plugin_id, collection, key, data, created_at, updated_at from ${t("plugin_storage")} where collection <> 'source'`,
        )
      : Promise.resolve([]),
    rows(sql, `select distinct source_id from ${t("tool")}`),
    includeStructuralRows
      ? rows(
          sql,
          `select scope_id, source_id, plugin_id, name, description, ${optionalColumn(toolColumns, tableName(v1Prefix, "tool"), "input_schema")} as input_schema, ${optionalColumn(toolColumns, tableName(v1Prefix, "tool"), "output_schema")} as output_schema, ${optionalColumn(toolColumns, tableName(v1Prefix, "tool"), "annotations")} as annotations, created_at, updated_at from ${t("tool")}`,
        )
      : Promise.resolve([]),
    hasDefinition
      ? rows(
          sql,
          `select scope_id, source_id, plugin_id, name, ${optionalColumn(definitionColumns, tableName(v1Prefix, "definition"), "schema")} as schema, created_at from ${t("definition")}`,
        )
      : Promise.resolve([]),
    hasBlob ? rows(sql, `select namespace, key, value from ${t("blob")}`) : Promise.resolve([]),
  ]);

  log?.(
    `snapshot:         ${sources.length} sources · ${bindings.length} bindings · ${connections.length} v1 connections · ${
      includeStructuralRows ? `${toolRows.length} tools` : `${toolSources.length} tool-source ids`
    }`,
  );

  const migratedConfigs = new Map<string, MigratedSourceConfig>();
  if (includeStructuralRows) {
    for (const [index, row] of sourceStorage.entries()) {
      if (index > 0 && index % 25 === 0) {
        log?.(`configs:          migrated ${index}/${sourceStorage.length} source configs`);
      }
      migratedConfigs.set(
        migrationSourceKey(String(row.scope_id), String(row.source_id)),
        buildConfig(String(row.kind), parseJson(row.data) as Record<string, unknown>),
      );
    }
    log?.(
      `configs:          migrated ${sourceStorage.length}/${sourceStorage.length} source configs`,
    );
  } else {
    for (const [key, value] of inferDryRunConfigsFromBindings(bindings)) {
      migratedConfigs.set(key, value);
    }
    log?.(`configs:          inferred ${migratedConfigs.size} source config slot map(s)`);
  }

  return {
    v1Prefix,
    input: {
      nowMs: now.getTime(),
      sources: sources.map(
        (source): V1SourceRow => ({
          scopeId: String(source.scope_id),
          id: String(source.id),
          pluginId: normalizePluginId(String(source.plugin_id), String(source.kind)),
          name: source.name == null ? String(source.id) : String(source.name),
        }),
      ),
      migratedConfigs,
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
    tools: toolRows.map((tool) => ({
      scopeId: String(tool.scope_id),
      sourceId: String(tool.source_id),
      pluginId: normalizePluginId(String(tool.plugin_id), ""),
      name: String(tool.name),
      description: String(tool.description),
      inputSchema: parseJson(tool.input_schema),
      outputSchema: parseJson(tool.output_schema),
      annotations: parseJson(tool.annotations),
      createdAt: dateOrNow(tool.created_at, now),
      updatedAt: dateOrNow(tool.updated_at, now),
    })),
    definitions: definitionRows.map((definition) => ({
      scopeId: String(definition.scope_id),
      sourceId: String(definition.source_id),
      pluginId: normalizePluginId(String(definition.plugin_id), ""),
      name: String(definition.name),
      schema: parseJson(definition.schema) ?? {},
      createdAt: dateOrNow(definition.created_at, now),
    })),
    pluginStorage: allPluginStorage
      .filter((row) => String(row.collection) !== "source")
      .map((row) => ({
        scopeId: String(row.scope_id),
        pluginId: normalizePluginId(String(row.plugin_id), ""),
        collection: String(row.collection),
        key: String(row.key),
        data: parseJson(row.data),
        createdAt: dateOrNow(row.created_at, now),
        updatedAt: dateOrNow(row.updated_at, now),
      })),
    blobs: blobRows.map((blob) => ({
      namespace: String(blob.namespace),
      key: String(blob.key),
      value: String(blob.value),
    })),
  };
};

const ownerSubject = (owner: MigrationOwner, subject: string): string =>
  owner === "org" ? "" : subject;

const secretRefKey = (scopeId: string, secretId: string): string => `${scopeId}\0${secretId}`;

const secretNameByRef = (input: MigrationInput): ReadonlyMap<string, string> =>
  new Map(input.secrets.map((secret) => [secretRefKey(secret.scopeId, secret.id), secret.name]));

const metadataNameForOp = (op: SecretOp, names: ReadonlyMap<string, string>): string => {
  if (!op.fromSecret) return op.itemId;
  const name = names.get(secretRefKey(op.fromSecret.scopeId, op.fromSecret.secretId))?.trim();
  return name || op.itemId;
};

const isExpectedMissingVaultObject = (error: WorkOSVaultClientError): boolean =>
  error.status === 400 || error.status === 404;

const readVaultObjectOrNull = (
  client: WorkOSVaultClient,
  name: string,
): Promise<WorkOSVaultObject | null> =>
  Effect.runPromise(
    client.readObjectByName(name).pipe(
      Effect.catch((error: WorkOSVaultClientError) => {
        if (isExpectedMissingVaultObject(error)) return Effect.succeed(null);
        return Effect.fail(error);
      }),
    ),
  );

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const upsertVaultObject = async (
  client: WorkOSVaultClient,
  name: string,
  value: string,
): Promise<"created" | "updated"> => {
  for (let kekAttempt = 1; kekAttempt <= MAX_KEK_NOT_READY_ATTEMPTS; kekAttempt += 1) {
    for (let conflictAttempt = 1; conflictAttempt <= MAX_CONFLICT_ATTEMPTS; conflictAttempt += 1) {
      try {
        const existing = await readVaultObjectOrNull(client, name);
        if (existing) {
          await Effect.runPromise(
            client.updateObject({
              id: existing.id,
              value,
              versionCheck: existing.metadata.versionId,
            }),
          );
          return "updated";
        }
        await Effect.runPromise(client.createObject({ name, value, context: VAULT_CONTEXT }));
        return "created";
      } catch (cause) {
        const error = cause as WorkOSVaultClientError;
        if (error.status === 409 && conflictAttempt < MAX_CONFLICT_ATTEMPTS) continue;
        if (error.retryKind === "kek_not_ready" && kekAttempt < MAX_KEK_NOT_READY_ATTEMPTS) {
          await sleep(KEK_NOT_READY_BACKOFF_MS);
          break;
        }
        throw cause;
      }
    }
  }
  throw new Error(`WorkOS Vault KEK was not ready after ${MAX_KEK_NOT_READY_ATTEMPTS} attempts.`);
};

const readV1WorkosSecret = async (
  client: WorkOSVaultClient,
  prefix: string,
  scopeId: string,
  secretId: string,
): Promise<string | null> => {
  const encoded = await readVaultObjectOrNull(client, vaultV1ObjectName(prefix, scopeId, secretId));
  if (encoded?.value != null) return encoded.value;
  const legacy = await readVaultObjectOrNull(
    client,
    vaultV1LegacyObjectName(prefix, scopeId, secretId),
  );
  return legacy?.value ?? null;
};

const copyWorkosSecrets = async (input: {
  readonly snapshot: CloudV1Snapshot;
  readonly plan: MigrationPlan;
  readonly client: WorkOSVaultClient;
  readonly prefix: string;
  readonly now: Date;
}): Promise<WorkosSecretCopyResult> => {
  const names = secretNameByRef(input.snapshot.input);
  const metadataRows: WorkosVaultMetadataRow[] = [];
  const oauthClientIdValues = new Map<string, string>();
  const missing: string[] = [];
  const warnings: string[] = [];
  let copied = 0;
  let existing = 0;

  for (const op of input.plan.secretOps) {
    if (op.targetProvider !== WORKOS_VAULT_PROVIDER) {
      warnings.push(
        `Skipping secret "${op.itemId}" for unsupported cloud provider "${op.targetProvider}".`,
      );
      continue;
    }

    metadataRows.push({
      owner: op.owner,
      id: op.itemId,
      name: metadataNameForOp(op, names),
      purpose: op.role,
      createdAt: input.now,
    });

    const v2Name = vaultV2ObjectName(input.prefix, op.itemId);
    const alreadyCopied = await readVaultObjectOrNull(input.client, v2Name);
    if (alreadyCopied) {
      existing += 1;
      continue;
    }

    const value =
      op.fromText ??
      (op.fromSecret
        ? await readV1WorkosSecret(
            input.client,
            input.prefix,
            op.fromSecret.scopeId,
            op.fromSecret.secretId,
          )
        : null);
    if (value == null) {
      missing.push(
        op.fromSecret ? `${op.fromSecret.scopeId}/${op.fromSecret.secretId}` : op.itemId,
      );
      continue;
    }

    await upsertVaultObject(input.client, v2Name, value);
    copied += 1;
  }

  for (const clientRow of input.plan.oauthClients) {
    if (clientRow.clientId.length > 0 || !clientRow.clientIdSecretRef) continue;
    if (clientRow.clientIdSecretRef.provider !== WORKOS_VAULT_PROVIDER) {
      missing.push(
        `${clientRow.clientIdSecretRef.scopeId}/${clientRow.clientIdSecretRef.secretId}`,
      );
      continue;
    }
    const value = await readV1WorkosSecret(
      input.client,
      input.prefix,
      clientRow.clientIdSecretRef.scopeId,
      clientRow.clientIdSecretRef.secretId,
    );
    if (value == null) {
      missing.push(
        `${clientRow.clientIdSecretRef.scopeId}/${clientRow.clientIdSecretRef.secretId}`,
      );
      continue;
    }
    oauthClientIdValues.set(oauthClientPlanKey(clientRow), value);
  }

  return { oauthClientIdValues, metadataRows, copied, existing, missing, warnings };
};

const clientIdFor = (
  client: MigrationPlan["oauthClients"][number],
  values: ReadonlyMap<string, string>,
): string => client.clientId || values.get(oauthClientPlanKey(client)) || "";

const oauthClientStorageKey = (input: {
  readonly tenant: string;
  readonly owner: string;
  readonly subject: string;
  readonly slug: string;
}): string => `${input.tenant}\0${input.owner}\0${input.subject}\0${input.slug}`;

const jsonValue = (sql: Pg, value: unknown): unknown => (value == null ? null : sql.json(value));

const requiredJsonValue = (sql: Pg, value: unknown): unknown => sql.json(value ?? {});

const mapItemIds = (ids: Record<string, string>): Record<string, string> => ({ ...ids });

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

const archiveV1Tables = async (sql: Pg): Promise<void> => {
  const sourceExists = await tableExists(sql, "source");
  if (!sourceExists) return;
  for (const table of v1ExecutorTables) {
    const archived = `v1_${table}`;
    if (await tableExists(sql, archived)) {
      throw new Error(`Cannot archive ${table}: ${archived} already exists.`);
    }
  }
  for (const table of v1ExecutorTables) {
    if (await tableExists(sql, table)) {
      await sql.unsafe(`alter table ${quoteIdent(table)} rename to ${quoteIdent(`v1_${table}`)}`);
    }
  }
  if ((await indexExists(sql, "blob_id_uidx")) && !(await indexExists(sql, "v1_blob_id_uidx"))) {
    await sql.unsafe(
      `alter index ${quoteIdent("blob_id_uidx")} rename to ${quoteIdent("v1_blob_id_uidx")}`,
    );
  }
};

const createV2Schema = async (sql: Pg): Promise<void> => {
  await sql.unsafe(`
    create table if not exists "blob" (
      "namespace" varchar(255) not null,
      "key" varchar(255) not null,
      "value" text not null,
      "row_id" varchar(255) primary key not null,
      "id" varchar(255) not null
    )
  `);
  await sql.unsafe(`
    create table if not exists "integration" (
      "slug" varchar(255) not null,
      "plugin_id" text not null,
      "description" text not null,
      "config" json,
      "can_remove" boolean default true not null,
      "can_refresh" boolean default false not null,
      "created_at" timestamp not null,
      "updated_at" timestamp not null,
      "row_id" varchar(255) primary key not null,
      "tenant" varchar(255) not null
    )
  `);
  await sql.unsafe(`
    create table if not exists "oauth_client" (
      "slug" varchar(255) not null,
      "authorization_url" text not null,
      "token_url" text not null,
      "grant" text not null,
      "client_id" text not null,
      "client_secret_item_id" text,
      "resource" text,
      "created_at" timestamp not null,
      "row_id" varchar(255) primary key not null,
      "tenant" varchar(255) not null,
      "owner" varchar(255) not null,
      "subject" varchar(255) not null
    )
  `);
  await sql.unsafe(`
    create table if not exists "connection" (
      "integration" varchar(255) not null,
      "name" varchar(255) not null,
      "template" text not null,
      "provider" text not null,
      "item_ids" json not null,
      "identity_label" text,
      "oauth_client" text,
      "oauth_client_owner" text,
      "refresh_item_id" text,
      "expires_at" bigint,
      "oauth_scope" text,
      "provider_state" json,
      "created_at" timestamp not null,
      "updated_at" timestamp not null,
      "row_id" varchar(255) primary key not null,
      "tenant" varchar(255) not null,
      "owner" varchar(255) not null,
      "subject" varchar(255) not null
    )
  `);
  await sql.unsafe(`
    create table if not exists "tool" (
      "integration" varchar(255) not null,
      "connection" varchar(255) not null,
      "plugin_id" text not null,
      "name" varchar(255) not null,
      "description" text not null,
      "input_schema" json,
      "output_schema" json,
      "annotations" json,
      "created_at" timestamp not null,
      "updated_at" timestamp not null,
      "row_id" varchar(255) primary key not null,
      "tenant" varchar(255) not null,
      "owner" varchar(255) not null,
      "subject" varchar(255) not null
    )
  `);
  await sql.unsafe(`
    create table if not exists "definition" (
      "integration" varchar(255) not null,
      "connection" varchar(255) not null,
      "plugin_id" text not null,
      "name" text not null,
      "schema" json not null,
      "created_at" timestamp not null,
      "row_id" varchar(255) primary key not null,
      "tenant" varchar(255) not null,
      "owner" varchar(255) not null,
      "subject" varchar(255) not null
    )
  `);
  await sql.unsafe(`
    create table if not exists "plugin_storage" (
      "plugin_id" varchar(255) not null,
      "collection" varchar(255) not null,
      "key" varchar(255) not null,
      "data" json not null,
      "created_at" timestamp not null,
      "updated_at" timestamp not null,
      "row_id" varchar(255) primary key not null,
      "tenant" varchar(255) not null,
      "owner" varchar(255) not null,
      "subject" varchar(255) not null
    )
  `);
  await sql.unsafe(`
    create table if not exists "tool_policy" (
      "id" varchar(255) not null,
      "pattern" text not null,
      "action" text not null,
      "position" text not null,
      "created_at" timestamp not null,
      "updated_at" timestamp not null,
      "row_id" varchar(255) primary key not null,
      "tenant" varchar(255) not null,
      "owner" varchar(255) not null,
      "subject" varchar(255) not null
    )
  `);
  await sql.unsafe(`
    create table if not exists "oauth_session" (
      "state" varchar(255) not null,
      "client_slug" text not null,
      "integration" text not null,
      "name" text not null,
      "template" text not null,
      "redirect_url" text not null,
      "pkce_verifier" text,
      "identity_label" text,
      "payload" json not null,
      "expires_at" bigint not null,
      "created_at" timestamp not null,
      "row_id" varchar(255) primary key not null,
      "tenant" varchar(255) not null,
      "owner" varchar(255) not null,
      "subject" varchar(255) not null
    )
  `);
  await sql.unsafe(`
    create table if not exists "private_executor_cloud_settings" (
      "id" varchar(255) primary key not null,
      "version" varchar(255) default '1.0.0' not null
    )
  `);

  await sql.unsafe(`create unique index if not exists "blob_id_uidx" on "blob" using btree ("id")`);
  await sql.unsafe(
    `create unique index if not exists "integration_uidx" on "integration" using btree ("tenant", "slug")`,
  );
  await sql.unsafe(
    `create unique index if not exists "oauth_client_uidx" on "oauth_client" using btree ("tenant", "owner", "subject", "slug")`,
  );
  await sql.unsafe(
    `create unique index if not exists "connection_uidx" on "connection" using btree ("tenant", "owner", "subject", "integration", "name")`,
  );
  await sql.unsafe(
    `create unique index if not exists "tool_uidx" on "tool" using btree ("tenant", "owner", "subject", "integration", "connection", "name")`,
  );
  await sql.unsafe(
    `create unique index if not exists "definition_uidx" on "definition" using btree ("tenant", "owner", "subject", "integration", "connection", "name")`,
  );
  await sql.unsafe(
    `create unique index if not exists "plugin_storage_uidx" on "plugin_storage" using btree ("tenant", "owner", "subject", "plugin_id", "collection", "key")`,
  );
  await sql.unsafe(
    `create unique index if not exists "tool_policy_uidx" on "tool_policy" using btree ("tenant", "owner", "subject", "id")`,
  );
  await sql.unsafe(
    `create unique index if not exists "oauth_session_uidx" on "oauth_session" using btree ("tenant", "state")`,
  );
};

const insertPlan = async (
  sql: Pg,
  snapshot: CloudV1Snapshot,
  plan: MigrationPlan,
  secretCopy: WorkosSecretCopyResult,
  oauthAuthorizationUrls: ReadonlyMap<string, string>,
  now: Date,
): Promise<void> => {
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

  for (const row of plan.integrations) {
    await sql`
      insert into integration (slug, plugin_id, description, config, can_remove, can_refresh, created_at, updated_at, row_id, tenant)
      values (${row.slug}, ${row.plugin_id}, ${row.description}, ${jsonValue(sql, row.config)}, true, false, ${now}, ${now}, ${createId()}, ${row.tenant})
      on conflict (tenant, slug) do update set
        plugin_id = excluded.plugin_id,
        description = excluded.description,
        config = excluded.config,
        updated_at = excluded.updated_at
    `;
  }

  for (const clientRow of plan.oauthClients) {
    await sql`
      insert into oauth_client (slug, authorization_url, token_url, grant, client_id, client_secret_item_id, resource, created_at, row_id, tenant, owner, subject)
      values (${clientRow.slug}, ${authorizationUrlFor(clientRow, oauthAuthorizationUrls)}, ${clientRow.tokenUrl}, ${clientRow.grant}, ${clientIdFor(clientRow, secretCopy.oauthClientIdValues)}, ${clientRow.clientSecretItemId}, ${clientRow.resource}, ${now}, ${createId()}, ${clientRow.ownerKeys.tenant}, ${clientRow.ownerKeys.owner}, ${ownerSubject(clientRow.ownerKeys.owner, clientRow.ownerKeys.subject)})
      on conflict (tenant, owner, subject, slug) do update set
        authorization_url = excluded.authorization_url,
        token_url = excluded.token_url,
        grant = excluded.grant,
        client_id = excluded.client_id,
        client_secret_item_id = excluded.client_secret_item_id,
        resource = excluded.resource
    `;
  }

  for (const connection of plan.connections) {
    const row = connection.row;
    await sql`
      insert into connection (integration, name, template, provider, item_ids, identity_label, oauth_client, oauth_client_owner, refresh_item_id, expires_at, oauth_scope, provider_state, created_at, updated_at, row_id, tenant, owner, subject)
      values (${row.integration}, ${row.name}, ${row.template}, ${row.provider}, ${sql.json(mapItemIds(connection.itemIds))}, ${row.identityLabel}, ${row.oauthClientSlug}, ${row.oauthClientOwner}, ${connection.refreshItemId}, ${row.expiresAt}, ${row.oauthScope}, ${null}, ${now}, ${now}, ${createId()}, ${row.tenant}, ${row.owner}, ${ownerSubject(row.owner, row.subject)})
      on conflict (tenant, owner, subject, integration, name) do update set
        template = excluded.template,
        provider = excluded.provider,
        item_ids = excluded.item_ids,
        identity_label = excluded.identity_label,
        oauth_client = excluded.oauth_client,
        oauth_client_owner = excluded.oauth_client_owner,
        refresh_item_id = excluded.refresh_item_id,
        expires_at = excluded.expires_at,
        oauth_scope = excluded.oauth_scope,
        provider_state = excluded.provider_state,
        updated_at = excluded.updated_at
    `;
  }

  for (const row of snapshot.tools) {
    for (const target of targetsFor(row.scopeId, row.sourceId)) {
      await sql`
        insert into tool (integration, connection, plugin_id, name, description, input_schema, output_schema, annotations, created_at, updated_at, row_id, tenant, owner, subject)
        values (${row.sourceId}, ${target.connection}, ${row.pluginId}, ${row.name}, ${row.description}, ${jsonValue(sql, row.inputSchema)}, ${jsonValue(sql, row.outputSchema)}, ${jsonValue(sql, migrateV1ToolAnnotations(row, runtimeMetadata))}, ${row.createdAt}, ${row.updatedAt}, ${createId()}, ${target.tenant}, ${target.owner}, ${target.subject})
        on conflict (tenant, owner, subject, integration, connection, name) do update set
          plugin_id = excluded.plugin_id,
          description = excluded.description,
          input_schema = excluded.input_schema,
          output_schema = excluded.output_schema,
          annotations = excluded.annotations,
          updated_at = excluded.updated_at
      `;
    }
  }

  for (const row of snapshot.definitions) {
    for (const target of targetsFor(row.scopeId, row.sourceId)) {
      await sql`
        insert into definition (integration, connection, plugin_id, name, schema, created_at, row_id, tenant, owner, subject)
        values (${row.sourceId}, ${target.connection}, ${row.pluginId}, ${row.name}, ${requiredJsonValue(sql, row.schema)}, ${row.createdAt}, ${createId()}, ${target.tenant}, ${target.owner}, ${target.subject})
        on conflict (tenant, owner, subject, integration, connection, name) do update set
          plugin_id = excluded.plugin_id,
          schema = excluded.schema
      `;
    }
  }

  for (const row of snapshot.pluginStorage) {
    const migrated = migrateV1PluginStorageRuntimeRow(row);
    const baseOwner = parseScope(row.scopeId);
    const owner =
      baseOwner && migrated.owner === "catalog"
        ? { ...baseOwner, owner: "org" as const, subject: "" }
        : baseOwner;
    if (!owner) continue;
    await insertPluginStorage(sql, {
      tenant: owner.tenant,
      owner: owner.owner,
      subject: ownerSubject(owner.owner, owner.subject),
      pluginId: migrated.pluginId,
      collection: migrated.collection,
      key: migrated.key,
      data: migrated.data,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  for (const row of secretCopy.metadataRows) {
    await insertPluginStorage(sql, {
      tenant: row.owner.tenant,
      owner: row.owner.owner,
      subject: ownerSubject(row.owner.owner, row.owner.subject),
      pluginId: WORKOS_VAULT_METADATA_PLUGIN_ID,
      collection: WORKOS_VAULT_METADATA_COLLECTION,
      key: row.id,
      data: {
        name: row.name,
        purpose: row.purpose,
        createdAt: row.createdAt.toISOString(),
      },
      createdAt: row.createdAt,
      updatedAt: now,
    });
  }

  for (const row of snapshot.blobs) {
    const parsed = legacyBlobNamespace(row.namespace);
    if (!parsed) continue;
    const owner = parseScope(parsed.scopeId);
    if (!owner) continue;
    const namespace = v2BlobNamespace(owner, parsed.pluginId);
    await sql`
      insert into blob (namespace, key, value, row_id, id)
      values (${namespace}, ${row.key}, ${row.value}, ${createId()}, ${JSON.stringify([namespace, row.key])})
      on conflict (id) do update set
        namespace = excluded.namespace,
        key = excluded.key,
        value = excluded.value
    `;
  }

  for (const policy of plan.policies) {
    await sql`
      insert into tool_policy (id, pattern, action, position, created_at, updated_at, row_id, tenant, owner, subject)
      values (${policy.id}, ${policy.pattern}, ${policy.action}, ${policy.position}, ${now}, ${now}, ${createId()}, ${policy.owner.tenant}, ${policy.owner.owner}, ${ownerSubject(policy.owner.owner, policy.owner.subject)})
      on conflict (tenant, owner, subject, id) do update set
        pattern = excluded.pattern,
        action = excluded.action,
        position = excluded.position,
        updated_at = excluded.updated_at
    `;
  }
};

const insertPluginStorage = async (
  sql: Pg,
  row: {
    readonly tenant: string;
    readonly owner: MigrationOwner;
    readonly subject: string;
    readonly pluginId: string;
    readonly collection: string;
    readonly key: string;
    readonly data: unknown;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  },
): Promise<void> => {
  await sql`
    insert into plugin_storage (plugin_id, collection, key, data, created_at, updated_at, row_id, tenant, owner, subject)
    values (${row.pluginId}, ${row.collection}, ${row.key}, ${requiredJsonValue(sql, row.data)}, ${row.createdAt}, ${row.updatedAt}, ${createId()}, ${row.tenant}, ${row.owner}, ${row.subject})
    on conflict (tenant, owner, subject, plugin_id, collection, key) do update set
      data = excluded.data,
      updated_at = excluded.updated_at
  `;
};

const applyStructuralMigration = async (
  sql: Pg,
  snapshot: CloudV1Snapshot,
  plan: MigrationPlan,
  secretCopy: WorkosSecretCopyResult,
  oauthAuthorizationUrls: ReadonlyMap<string, string>,
  now: Date,
): Promise<void> => {
  await sql.begin(async (tx) => {
    await archiveV1Tables(tx as Pg);
    await createV2Schema(tx as Pg);
    await insertPlan(tx as Pg, snapshot, plan, secretCopy, oauthAuthorizationUrls, now);
  });
};

const printReport = (
  log: (message: string) => void,
  mode: "DRY-RUN" | "APPLY",
  plan: MigrationPlan,
): void => {
  const r = plan.report;
  const roleCounts = plan.secretOps.reduce<Record<string, number>>((acc, op) => {
    acc[op.role] = (acc[op.role] ?? 0) + 1;
    return acc;
  }, {});

  log(`=== v1 -> v2 migration ${mode} ===`);
  log(`integrations:      ${r.integrations}`);
  log(`connections:       ${r.connections}`);
  log(`oauth clients:     ${r.oauthClients}`);
  log(`secret ops:        ${r.secretOps}  ${JSON.stringify(roleCounts)}`);
  log(`stale connections: ${r.staleConnections} (unbound v1 rows -> tokens orphaned)`);
  log(
    `policies:          ${r.policies.ok} ok · ${r.policies.static} static · ${r.policies.deadInert} dead-inert`,
  );
  log(`warnings:          ${r.warnings.length}`);
  for (const warning of r.warnings) log(`  - ${warning}`);
};

const readCurrentOAuthAuthorizationUrls = async (sql: Pg): Promise<ReadonlyMap<string, string>> => {
  const rows = await sql<
    {
      readonly tenant: string;
      readonly owner: string;
      readonly subject: string;
      readonly slug: string;
      readonly authorization_url: string;
    }[]
  >`
    select tenant, owner, subject, slug, authorization_url
    from oauth_client
  `;
  return new Map(rows.map((row) => [oauthClientStorageKey(row), row.authorization_url]));
};

export const repairCloudOAuthAuthorizationUrls = async (
  options: CloudOAuthAuthorizationUrlRepairOptions,
): Promise<CloudOAuthAuthorizationUrlRepairResult> => {
  const log = options.log ?? console.log;
  const now = options.now ?? new Date();
  const snapshot = await readV1Snapshot(options.sql, now, false, log);
  log("plan:             building OAuth authorization URL repair plan");
  const plan = planMigration(snapshot.input);
  const oauthAuthorizationUrls = await resolveMigrationOAuthAuthorizationUrls(plan, {
    fetch: options.oauthMetadataFetch ?? fetch,
    timeoutMs: options.oauthMetadataTimeoutMs,
  });
  const currentAuthorizationUrls = await readCurrentOAuthAuthorizationUrls(options.sql);

  const changed: CloudOAuthAuthorizationUrlRepairRow[] = [];
  let checked = 0;
  for (const clientRow of plan.oauthClients) {
    if (!needsOAuthAuthorizationResolution(clientRow)) continue;
    checked++;

    const currentAuthorizationUrl = currentAuthorizationUrls.get(oauthClientPlanKey(clientRow));
    if (currentAuthorizationUrl == null) {
      log(
        `  - missing current oauth_client row for ${clientRow.ownerKeys.tenant}/${clientRow.slug}`,
      );
      continue;
    }

    const repairedAuthorizationUrl = authorizationUrlFor(clientRow, oauthAuthorizationUrls);
    if (currentAuthorizationUrl === repairedAuthorizationUrl) continue;
    changed.push({
      tenant: clientRow.ownerKeys.tenant,
      owner: clientRow.ownerKeys.owner,
      subject: ownerSubject(clientRow.ownerKeys.owner, clientRow.ownerKeys.subject),
      slug: clientRow.slug,
      currentAuthorizationUrl,
      repairedAuthorizationUrl,
      resolutionSource: oauthAuthorizationResolutionSource(clientRow),
    });
  }

  log(`oauth repair:      ${checked} discoverable client(s) checked`);
  log(`oauth repair:      ${changed.length} client(s) need authorization_url update`);
  for (const row of changed) {
    log(
      `  - ${row.tenant}/${row.owner}/${row.subject || "<org>"}/${row.slug}: ${row.currentAuthorizationUrl} -> ${row.repairedAuthorizationUrl} (via ${row.resolutionSource})`,
    );
  }

  if (!options.apply) return { applied: false, checked, changed };
  if (!options.confirmApply) {
    throw new Error("Refusing OAuth authorization URL repair without confirmation flag.");
  }

  await options.sql.begin(async (tx) => {
    for (const row of changed) {
      await (tx as Pg)`
        update oauth_client
        set authorization_url = ${row.repairedAuthorizationUrl}
        where tenant = ${row.tenant}
          and owner = ${row.owner}
          and subject = ${row.subject}
          and slug = ${row.slug}
      `;
    }
  });
  log("oauth repair:      complete");

  return { applied: true, checked, changed };
};

export const runCloudV1V2Migration = async (
  options: CloudMigrationOptions,
): Promise<CloudMigrationResult> => {
  const log = options.log ?? console.log;
  const now = options.now ?? new Date();
  const snapshot = await readV1Snapshot(options.sql, now, options.apply, log);
  log("plan:             building migration plan");
  const plan = planMigration(snapshot.input);
  log("plan:             complete");
  printReport(log, options.apply ? "APPLY" : "DRY-RUN", plan);

  if (!options.apply) return { applied: false, report: plan.report };
  if (!options.confirmApply) {
    throw new Error("Refusing to apply without --confirm-v1-v2-cutover.");
  }

  const client =
    options.vaultClient ??
    (await Effect.runPromise(
      makeConfiguredWorkOSVaultClient({
        apiKey: options.workosCredentials?.apiKey ?? "",
        clientId: options.workosCredentials?.clientId ?? "",
      }),
    ));

  const secretCopy = await copyWorkosSecrets({
    snapshot,
    plan,
    client,
    prefix: options.objectPrefix ?? DEFAULT_VAULT_PREFIX,
    now,
  });

  log(
    `vault copy:        ${secretCopy.copied} copied · ${secretCopy.existing} already present · ${secretCopy.missing.length} missing`,
  );
  for (const warning of secretCopy.warnings) log(`  - ${warning}`);
  if (secretCopy.missing.length > 0) {
    throw new Error(
      `Refusing structural apply: ${secretCopy.missing.length} required WorkOS Vault value(s) were missing.`,
    );
  }

  const oauthAuthorizationUrls = await resolveMigrationOAuthAuthorizationUrls(plan, {
    fetch: options.oauthMetadataFetch ?? fetch,
    timeoutMs: options.oauthMetadataTimeoutMs,
  });
  if (oauthAuthorizationUrls.size > 0) {
    log(`oauth metadata:     resolved ${oauthAuthorizationUrls.size} authorization URL(s)`);
  }

  await applyStructuralMigration(
    options.sql,
    snapshot,
    plan,
    secretCopy,
    oauthAuthorizationUrls,
    now,
  );
  log("apply:             complete");
  return {
    applied: true,
    report: plan.report,
    secretCopy: {
      copied: secretCopy.copied,
      existing: secretCopy.existing,
      missing: secretCopy.missing,
      warnings: secretCopy.warnings,
    },
  };
};

const main = async (): Promise<void> => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set (run via `op run --env-file=.env.production --`).");
    process.exit(1);
  }
  const databaseSsl = process.env.DATABASE_SSL?.trim().toLowerCase();
  const ssl =
    databaseSsl === "disable" || databaseSsl === "false" || databaseSsl === "0" ? false : "require";
  const sql = postgres(databaseUrl, { max: 1, prepare: false, ssl }) as Pg;
  try {
    if (REPAIR_OAUTH_AUTHORIZATION_URLS) {
      await repairCloudOAuthAuthorizationUrls({
        sql,
        apply: APPLY,
        confirmApply: CONFIRM_REPAIR_OAUTH_AUTHORIZATION_URLS,
      });
    } else {
      await runCloudV1V2Migration({
        sql,
        apply: APPLY,
        confirmApply: CONFIRM_APPLY,
        workosCredentials: {
          apiKey: process.env.WORKOS_API_KEY ?? "",
          clientId: process.env.WORKOS_CLIENT_ID ?? "",
        },
      });
    }
  } finally {
    await sql.end();
  }
};

if (import.meta.main) await main();
