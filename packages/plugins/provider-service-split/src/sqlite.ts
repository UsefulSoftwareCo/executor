/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor, executor/no-json-parse -- boundary: one-shot provider service split data migration preserves legacy SQLite row coercion and typed DataMigrationError wrapping */
import { Effect } from "effect";
import { DataMigrationError, type SqliteDataMigrationClient } from "@executor-js/sdk";

import {
  operationStorageKey,
  planMigration,
  storageDataRecord,
  tenantHash,
  type BlobRow,
  type ConnectionRow,
  type IntegrationRow,
  type MigrationInput,
  type OrgPlan,
  type PluginStorageRow,
  type ToolPolicyRow,
  type ToolRow,
} from "./planner";

const MIGRATION_NAME = "2026-07-08-provider-service-split";
const LEDGER_TABLE = "provider_service_split_org_migration";

const operationKeyPrefix = (integration: string): string =>
  `${operationStorageKey(integration, "").split(".").slice(0, 2).join(".")}.%`;

const execute = (
  client: SqliteDataMigrationClient,
  stmt: string | { readonly sql: string; readonly args: readonly unknown[] },
) =>
  Effect.tryPromise({
    try: () => client.execute(stmt),
    catch: (cause) => new DataMigrationError({ migration: MIGRATION_NAME, cause }),
  });

const parseJsonLike = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

const scrubJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(scrubJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, inner]) => inner !== undefined)
        .map(([key, inner]) => [key, scrubJson(inner)]),
    );
  }
  return value;
};

const stableId = (...parts: readonly string[]): string => {
  const text = parts.join("\u0000");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return `service_split_${hash.toString(36)}`;
};

const tableExists = (client: SqliteDataMigrationClient, table: string) =>
  execute(client, {
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    args: [table],
  }).pipe(Effect.map((result) => result.rows.length > 0));

const ensureLedgerTable = (client: SqliteDataMigrationClient) =>
  execute(
    client,
    `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
    tenant text PRIMARY KEY NOT NULL,
    time_completed integer NOT NULL
  )`,
  );

const readCompletedTenants = (client: SqliteDataMigrationClient) =>
  execute(client, `SELECT tenant FROM ${LEDGER_TABLE} ORDER BY tenant`).pipe(
    Effect.map((result) => result.rows.map((row) => String(row.tenant))),
  );

const stampCompletedTenant = (client: SqliteDataMigrationClient, tenant: string) =>
  execute(client, {
    sql: `INSERT INTO ${LEDGER_TABLE} (tenant, time_completed)
      VALUES (?, ?)
      ON CONFLICT(tenant) DO UPDATE SET time_completed = excluded.time_completed`,
    args: [tenant, Date.now()],
  });

const readDatabaseInput = (
  client: SqliteDataMigrationClient,
  options: {
    readonly blobBackend?: MigrationInput["blobBackend"];
    readonly blobs?: readonly BlobRow[];
  } = {},
): Effect.Effect<MigrationInput, DataMigrationError> =>
  Effect.gen(function* () {
    yield* ensureLedgerTable(client);
    const completedTenants = yield* readCompletedTenants(client);
    const integrations = yield* execute(
      client,
      `SELECT tenant, slug, plugin_id, name, description, config, health_check,
        config_revised_at, can_remove, can_refresh, CAST(created_at AS TEXT) AS created_at,
        CAST(updated_at AS TEXT) AS updated_at, row_id
       FROM integration
       WHERE plugin_id IN ('google', 'microsoft')
          OR slug IN ('google', 'microsoft')
          OR tenant IN (
            SELECT tenant FROM integration
            WHERE plugin_id IN ('google', 'microsoft')
          )
       ORDER BY tenant, slug`,
    );
    const monolithTenants = new Set(
      integrations.rows
        .filter((row) => row.plugin_id === "google" || row.plugin_id === "microsoft")
        .map((row) => String(row.tenant)),
    );
    if (monolithTenants.size === 0) {
      return {
        integrations: [],
        connections: [],
        tools: [],
        pluginStorage: [],
        blobs: options.blobs ?? [],
        policies: [],
        completedTenants,
      };
    }

    const connections = yield* execute(
      client,
      `SELECT tenant, owner, subject, integration, name, template, provider, item_ids,
        identity_label, description, last_health, tools_synced_at, oauth_client,
        oauth_client_owner, refresh_item_id, expires_at, oauth_scope, oauth_token_url,
        provider_state, CAST(created_at AS TEXT) AS created_at,
        CAST(updated_at AS TEXT) AS updated_at, row_id
       FROM connection
       ORDER BY tenant, integration, owner, subject, name`,
    );
    const tools = yield* execute(
      client,
      `SELECT tenant, owner, subject, integration, connection, plugin_id, name, description,
        input_schema, output_schema, annotations, CAST(created_at AS TEXT) AS created_at,
        CAST(updated_at AS TEXT) AS updated_at, row_id
       FROM tool
       ORDER BY tenant, integration, connection, name`,
    );
    const pluginStorage = yield* execute(
      client,
      `SELECT tenant, owner, subject, plugin_id, collection, key, data,
        CAST(created_at AS TEXT) AS created_at, CAST(updated_at AS TEXT) AS updated_at, row_id
       FROM plugin_storage
       WHERE plugin_id IN ('google', 'microsoft')
         AND collection = 'operation'
       ORDER BY tenant, plugin_id, collection, key`,
    );
    const blobs = yield* execute(
      client,
      `SELECT id, namespace, key
       FROM blob
       WHERE key LIKE 'spec/%' OR key LIKE 'defs/%'
       ORDER BY namespace, key`,
    );
    const policies = yield* execute(
      client,
      `SELECT tenant, owner, subject, id, pattern, action, position,
        CAST(created_at AS TEXT) AS created_at, CAST(updated_at AS TEXT) AS updated_at, row_id
       FROM tool_policy
       ORDER BY tenant, owner, subject, position, id`,
    );

    const tenantFilter = (row: Record<string, unknown>) => monolithTenants.has(String(row.tenant));
    return {
      integrations: integrations.rows.filter(tenantFilter).map(
        (row): IntegrationRow => ({
          tenant: String(row.tenant),
          slug: String(row.slug),
          plugin_id: String(row.plugin_id),
          name: typeof row.name === "string" ? row.name : null,
          description: typeof row.description === "string" ? row.description : null,
          config: parseJsonLike(row.config),
          health_check: parseJsonLike(row.health_check),
          config_revised_at: row.config_revised_at as string | number | bigint | null,
          can_remove: Boolean(row.can_remove),
          can_refresh: Boolean(row.can_refresh),
          created_at: String(row.created_at),
          updated_at: String(row.updated_at),
          row_id: String(row.row_id),
        }),
      ),
      connections: connections.rows.filter(tenantFilter).map(
        (row): ConnectionRow => ({
          tenant: String(row.tenant),
          owner: String(row.owner),
          subject: String(row.subject),
          integration: String(row.integration),
          name: String(row.name),
          template: String(row.template),
          provider: String(row.provider),
          item_ids: parseJsonLike(row.item_ids),
          identity_label: typeof row.identity_label === "string" ? row.identity_label : null,
          description: typeof row.description === "string" ? row.description : null,
          last_health: parseJsonLike(row.last_health),
          tools_synced_at: row.tools_synced_at as string | number | bigint | null,
          oauth_client: typeof row.oauth_client === "string" ? row.oauth_client : null,
          oauth_client_owner:
            typeof row.oauth_client_owner === "string" ? row.oauth_client_owner : null,
          refresh_item_id: typeof row.refresh_item_id === "string" ? row.refresh_item_id : null,
          expires_at: row.expires_at as string | number | bigint | null,
          oauth_scope: typeof row.oauth_scope === "string" ? row.oauth_scope : null,
          oauth_token_url: typeof row.oauth_token_url === "string" ? row.oauth_token_url : null,
          provider_state: parseJsonLike(row.provider_state),
          created_at: String(row.created_at),
          updated_at: String(row.updated_at),
          row_id: String(row.row_id),
        }),
      ),
      tools: tools.rows.filter(tenantFilter).map(
        (row): ToolRow => ({
          tenant: String(row.tenant),
          owner: String(row.owner),
          subject: String(row.subject),
          integration: String(row.integration),
          connection: String(row.connection),
          plugin_id: String(row.plugin_id),
          name: String(row.name),
          description: typeof row.description === "string" ? row.description : undefined,
          input_schema: parseJsonLike(row.input_schema),
          output_schema: parseJsonLike(row.output_schema),
          annotations: parseJsonLike(row.annotations),
          created_at: String(row.created_at),
          updated_at: String(row.updated_at),
          row_id: String(row.row_id),
        }),
      ),
      pluginStorage: pluginStorage.rows.filter(tenantFilter).map(
        (row): PluginStorageRow => ({
          tenant: String(row.tenant),
          owner: String(row.owner),
          subject: String(row.subject),
          plugin_id: String(row.plugin_id),
          collection: String(row.collection),
          key: String(row.key),
          data: parseJsonLike(row.data),
          created_at: String(row.created_at),
          updated_at: String(row.updated_at),
          row_id: String(row.row_id),
        }),
      ),
      blobs: [
        ...blobs.rows.map(
          (row): BlobRow => ({
            id: String(row.id),
            namespace: String(row.namespace),
            key: String(row.key),
          }),
        ),
        ...(options.blobs ?? []),
      ],
      policies: policies.rows.filter(tenantFilter).map(
        (row): ToolPolicyRow => ({
          tenant: String(row.tenant),
          owner: String(row.owner),
          subject: String(row.subject),
          id: String(row.id),
          pattern: String(row.pattern),
          action: String(row.action),
          position: String(row.position),
          created_at: String(row.created_at),
          updated_at: String(row.updated_at),
          row_id: String(row.row_id),
        }),
      ),
      blobBackend: options.blobBackend ?? "database",
      orphanPolicyMode: "retarget_all",
      collectPolicyErrors: true,
      bootRailCreateToolImpliedServices: true,
      completedTenants,
    };
  });

const applyOrg = (
  client: SqliteDataMigrationClient,
  org: OrgPlan,
): Effect.Effect<void, DataMigrationError> =>
  Effect.gen(function* () {
    if (org.completed) return;
    if (org.hardErrors.length > 0) return;
    const now = Date.now();

    for (const copy of org.blobCopies.filter((item) => item.backend === "database")) {
      const source = yield* execute(client, {
        sql: "SELECT value FROM blob WHERE namespace = ? AND key = ? LIMIT 1",
        args: [copy.sourceNamespace, copy.key],
      });
      const sourceRow = source.rows[0];
      if (!sourceRow || typeof sourceRow.value !== "string") {
        return yield* new DataMigrationError({
          migration: MIGRATION_NAME,
          cause: `Missing source blob ${copy.sourceNamespace}/${copy.key}`,
        });
      }
      yield* execute(client, {
        sql: `INSERT OR IGNORE INTO blob (namespace, key, value, row_id, id)
          VALUES (?, ?, ?, ?, ?)`,
        args: [
          copy.targetNamespace,
          copy.key,
          sourceRow.value,
          stableId("blob", org.tenant, copy.targetNamespace, copy.key),
          JSON.stringify([copy.targetNamespace, copy.key]),
        ],
      });
    }

    for (const row of org.integrations.filter((item) => item.action === "create")) {
      yield* execute(client, {
        sql: `INSERT OR IGNORE INTO integration
          (slug, plugin_id, name, description, config, health_check, config_revised_at,
           can_remove, can_refresh, created_at, updated_at, row_id, tenant)
          VALUES (?, ?, ?, ?, ?, ?, NULL, 1, 1, ?, ?, ?, ?)`,
        args: [
          row.target.slug,
          row.target.pluginId,
          row.target.name,
          row.target.description,
          JSON.stringify(scrubJson(row.config)),
          row.healthCheck ? JSON.stringify(scrubJson(row.healthCheck)) : null,
          now,
          now,
          stableId("integration", org.tenant, row.target.slug),
          org.tenant,
        ],
      });
    }

    for (const row of org.connections.filter((item) => item.action === "clone")) {
      yield* execute(client, {
        sql: `INSERT OR IGNORE INTO connection
          (integration, name, template, provider, item_ids, identity_label, description,
           last_health, tools_synced_at, oauth_client, oauth_client_owner, refresh_item_id,
           expires_at, oauth_scope, oauth_token_url, provider_state, created_at, updated_at,
           row_id, tenant, owner, subject)
          SELECT ?, name, template, provider, item_ids, identity_label, description,
            NULL, NULL, oauth_client, oauth_client_owner, refresh_item_id, expires_at,
            oauth_scope, oauth_token_url, provider_state, created_at, ?, ?, tenant, owner, subject
          FROM connection
          WHERE tenant = ? AND owner = ? AND subject = ? AND integration = ? AND name = ?`,
        args: [
          row.targetIntegration,
          now,
          stableId(
            "connection",
            org.tenant,
            row.source.owner,
            row.source.subject,
            row.targetIntegration,
            row.source.name,
          ),
          org.tenant,
          row.source.owner,
          row.source.subject,
          row.source.integration,
          row.source.name,
        ],
      });
    }

    for (const integration of org.integrations) {
      for (const contribution of integration.sourceContributions) {
        for (const toolName of contribution.operationToolNames) {
          const operation = yield* execute(client, {
            sql: `SELECT data, created_at, updated_at
            FROM plugin_storage
            WHERE tenant = ?
              AND owner = 'org'
              AND subject = ''
              AND plugin_id = ?
              AND collection = 'operation'
              AND (
                key = ?
                OR (
                  json_extract(data, '$.integration') = ?
                  AND json_extract(data, '$.toolName') = ?
                )
              )
            LIMIT 1`,
            args: [
              org.tenant,
              contribution.source.plugin_id,
              operationStorageKey(contribution.source.slug, toolName),
              contribution.source.slug,
              toolName,
            ],
          });
          const source = operation.rows[0];
          if (!source) {
            return yield* new DataMigrationError({
              migration: MIGRATION_NAME,
              cause: new Error(
                `Missing operation row for ${tenantHash(org.tenant)}/${contribution.source.slug}/${toolName}`,
              ),
            });
          }
          yield* execute(client, {
            sql: `INSERT INTO plugin_storage
            (plugin_id, collection, key, data, created_at, updated_at, row_id, tenant, owner, subject)
            VALUES (?, 'operation', ?, ?, ?, ?, ?, ?, 'org', '')
            ON CONFLICT(tenant, owner, subject, plugin_id, collection, key)
            DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
            args: [
              integration.target.pluginId,
              operationStorageKey(integration.target.slug, toolName),
              JSON.stringify(
                scrubJson({
                  ...storageDataRecord({ data: parseJsonLike(source.data) }),
                  integration: integration.target.slug,
                  toolName,
                }),
              ),
              source.created_at,
              now,
              stableId("operation", org.tenant, integration.target.slug, toolName),
              org.tenant,
            ],
          });
          yield* execute(client, {
            sql: `INSERT OR IGNORE INTO tool
            (integration, connection, plugin_id, name, description, input_schema, output_schema,
             annotations, created_at, updated_at, row_id, tenant, owner, subject)
            SELECT ?, connection, ?, name, description, input_schema, output_schema,
              annotations, created_at, ?, ? || '_' || row_id, tenant, owner, subject
            FROM tool
            WHERE tenant = ? AND integration = ? AND name = ?`,
            args: [
              integration.target.slug,
              integration.target.pluginId,
              now,
              stableId("tool", org.tenant, integration.target.slug),
              org.tenant,
              contribution.source.slug,
              toolName,
            ],
          });
        }
      }
    }

    for (const policy of org.policies) {
      yield* execute(client, {
        sql: "DELETE FROM tool_policy WHERE tenant = ? AND owner = ? AND subject = ? AND id = ?",
        args: [org.tenant, policy.policy.owner, policy.policy.subject, policy.policy.id],
      });
      for (const [index, pattern] of policy.afterPatterns.entries()) {
        yield* execute(client, {
          sql: `INSERT OR IGNORE INTO tool_policy
            (id, pattern, action, position, created_at, updated_at, row_id, tenant, owner, subject)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            policy.afterPatterns.length === 1
              ? policy.policy.id
              : `${policy.policy.id}_${index + 1}`,
            pattern,
            policy.policy.action,
            policy.policy.position,
            now,
            now,
            stableId("policy", org.tenant, policy.policy.id, pattern),
            org.tenant,
            policy.policy.owner,
            policy.policy.subject,
          ],
        });
      }
    }

    for (const monolith of org.deleteMonoliths) {
      yield* execute(client, {
        sql: "DELETE FROM tool WHERE tenant = ? AND integration = ?",
        args: [org.tenant, monolith.slug],
      });
      yield* execute(client, {
        sql: "DELETE FROM connection WHERE tenant = ? AND integration = ?",
        args: [org.tenant, monolith.slug],
      });
      yield* execute(client, {
        sql: `DELETE FROM plugin_storage
          WHERE tenant = ?
            AND owner = 'org'
            AND subject = ''
            AND plugin_id = ?
            AND collection = 'operation'
            AND (
              json_extract(data, '$.integration') = ?
              OR key LIKE ?
            )`,
        args: [org.tenant, monolith.plugin_id, monolith.slug, operationKeyPrefix(monolith.slug)],
      });
      yield* execute(client, {
        sql: "DELETE FROM integration WHERE tenant = ? AND slug = ? AND plugin_id = ?",
        args: [org.tenant, monolith.slug, monolith.plugin_id],
      });
    }
  });

export const runSqliteProviderServiceSplitMigration = (
  client: SqliteDataMigrationClient,
  options: {
    readonly beforeStampOrg?: (org: OrgPlan) => Effect.Effect<void, DataMigrationError>;
    readonly blobBackend?: MigrationInput["blobBackend"];
    readonly blobs?: readonly BlobRow[];
  } = {},
): Effect.Effect<number, DataMigrationError> =>
  Effect.gen(function* () {
    if (!(yield* tableExists(client, "integration"))) return 0;
    const input = yield* readDatabaseInput(client, options);
    const plan = planMigration(input);
    const moved = plan.orgs.filter((org) => !org.completed && org.hardErrors.length === 0).length;
    if (moved === 0) return 0;

    for (const org of plan.orgs) {
      if (org.completed) continue;
      if (org.hardErrors.length > 0) {
        console.warn(
          `provider-service-split: skipped org ${org.tenantHash}: ${org.hardErrors.join("; ")}`,
        );
        continue;
      }
      yield* execute(client, "BEGIN");
      const applyOne = Effect.gen(function* () {
        yield* applyOrg(client, org);
        if (options.beforeStampOrg) yield* options.beforeStampOrg(org);
        yield* stampCompletedTenant(client, org.tenant);
        yield* execute(client, "COMMIT");
      });
      yield* applyOne.pipe(Effect.tapError(() => execute(client, "ROLLBACK").pipe(Effect.ignore)));
    }
    return moved;
  });

export const providerServiceSplitDataMigration = {
  name: MIGRATION_NAME,
  run: (client: SqliteDataMigrationClient) =>
    runSqliteProviderServiceSplitMigration(client).pipe(Effect.asVoid),
};
