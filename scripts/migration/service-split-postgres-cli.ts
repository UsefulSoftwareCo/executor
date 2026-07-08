/* oxlint-disable executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: one-shot migration CLI */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import postgres from "../../apps/cloud/node_modules/postgres/src/index.js";

import {
  operationStorageKey,
  planMigration,
  renderOrgDiff,
  renderSummary,
  storageDataRecord,
  tenantHash,
  verifyPolicyRewriteNeverWidens,
  type BlobRow,
  type ConnectionRow,
  type IntegrationRow,
  type MigrationInput,
  type OrgPlan,
  type PluginStorageRow,
  type ToolPolicyRow,
  type ToolRow,
} from "./service-split-planner";

export interface SqlClient {
  readonly unsafe: <T extends readonly object[] = readonly Record<string, unknown>[]>(
    query: string,
    params?: readonly unknown[],
  ) => Promise<T>;
  readonly begin: <T>(fn: (sql: SqlClient) => Promise<T>) => Promise<T>;
  readonly end: (options?: { readonly timeout?: number }) => Promise<void>;
}

const args = process.argv.slice(2);
const hasArg = (name: string): boolean => args.includes(name);
const argValue = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const apply = hasArg("--apply");
const inputJson = argValue("--input-json");
const outputDir = resolve(
  argValue("--output-dir") ?? "~/agent-workspace/scratch/service-split-migration-dryrun",
).replace(/^~(?=\/)/, process.env.HOME ?? "~");
const orgFilter = argValue("--org");
const trafficLastTenant = argValue("--traffic-last-tenant");
const databaseUrl = argValue("--database-url") ?? process.env.DATABASE_URL;
const r2CopiesDone = hasArg("--r2-copies-done");
export const LEDGER_TABLE = "provider_service_split_org_migration";

const parseInputJson = (path: string): MigrationInput =>
  JSON.parse(readFileSync(path, "utf8")) as MigrationInput;

const readRows = async <T extends readonly object[]>(sql: SqlClient, query: string): Promise<T> =>
  sql.unsafe<T>(query);

const readCompletedTenants = async (
  sql: SqlClient,
  dryRun: boolean,
): Promise<readonly string[]> => {
  const [table] = await sql.unsafe<{ ledger_table: string | null }[]>(
    `SELECT to_regclass('public.${LEDGER_TABLE}')::text AS ledger_table`,
  );
  if (!table?.ledger_table) {
    if (dryRun) return [];
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
        tenant text PRIMARY KEY,
        time_completed bigint NOT NULL
      )
    `);
    return [];
  }
  const rows = await sql.unsafe<{ tenant: string }[]>(
    `SELECT tenant FROM ${LEDGER_TABLE} ORDER BY tenant`,
  );
  return rows.map((row) => row.tenant);
};

const filterInputByOrg = (input: MigrationInput, filter: string | undefined): MigrationInput => {
  if (!filter) return input;
  const tenantMatches = new Set(
    input.integrations
      .map((row) => row.tenant)
      .filter((tenant) => tenant === filter || tenantHash(tenant) === filter),
  );
  return {
    ...input,
    integrations: input.integrations.filter((row) => tenantMatches.has(row.tenant)),
    connections: input.connections.filter((row) => tenantMatches.has(row.tenant)),
    tools: input.tools.filter((row) => tenantMatches.has(row.tenant)),
    pluginStorage: input.pluginStorage?.filter((row) => tenantMatches.has(row.tenant)),
    blobs: input.blobs?.filter((row) => {
      for (const tenant of tenantMatches) {
        if (row.namespace.startsWith(`o:${tenant}/`)) return true;
      }
      return false;
    }),
    policies: input.policies.filter((row) => tenantMatches.has(row.tenant)),
    completedTenants: input.completedTenants?.filter((tenant) => tenantMatches.has(tenant)),
  };
};

export const readDatabaseInput = async (
  sql: SqlClient,
  dryRun: boolean,
  blobBackend: MigrationInput["blobBackend"],
): Promise<MigrationInput> => {
  const completedTenants = await readCompletedTenants(sql, dryRun);
  const integrations = await readRows<IntegrationRow[]>(
    sql,
    `
      SELECT tenant, slug, plugin_id, name, description, config, health_check, config_revised_at,
        can_remove, can_refresh, created_at::text, updated_at::text, row_id
      FROM integration
      WHERE plugin_id IN ('google', 'microsoft')
         OR slug IN ('google', 'microsoft')
         OR tenant IN (
          SELECT tenant FROM integration
          WHERE plugin_id IN ('google', 'microsoft')
         )
      ORDER BY tenant, slug
    `,
  );
  const connections = await readRows<ConnectionRow[]>(
    sql,
    `
      SELECT tenant, owner, subject, integration, name, template, provider, item_ids,
        identity_label, description, last_health, tools_synced_at, oauth_client,
        oauth_client_owner, refresh_item_id, expires_at, oauth_scope, oauth_token_url,
        provider_state, created_at::text, updated_at::text, row_id
      FROM connection
      WHERE tenant IN (
        SELECT tenant FROM integration
        WHERE plugin_id IN ('google', 'microsoft')
      )
      ORDER BY tenant, integration, owner, subject, name
    `,
  );
  const tools = await readRows<ToolRow[]>(
    sql,
    `
      SELECT tenant, owner, subject, integration, connection, plugin_id, name, description,
        input_schema, output_schema, annotations, created_at::text, updated_at::text, row_id
      FROM tool
      WHERE tenant IN (
        SELECT tenant FROM integration
        WHERE plugin_id IN ('google', 'microsoft')
      )
      ORDER BY tenant, integration, connection, name
    `,
  );
  const pluginStorage = await sql.unsafe<PluginStorageRow[]>(
    `
      SELECT tenant, owner, subject, plugin_id, collection, key, data,
        created_at::text, updated_at::text, row_id
      FROM plugin_storage
      WHERE tenant IN (
        SELECT tenant FROM integration
        WHERE plugin_id IN ('google', 'microsoft')
        )
        AND plugin_id IN ('google', 'microsoft')
        AND collection = 'operation'
      ORDER BY tenant, plugin_id, collection, key
    `,
  );
  const blobs = await readRows<BlobRow[]>(
    sql,
    `
      SELECT id, namespace, key
      FROM blob
      WHERE namespace IN (
        SELECT 'o:' || tenant || '/' || plugin_id
        FROM integration
        WHERE plugin_id IN ('google', 'microsoft')
      )
        AND (key LIKE 'spec/%' OR key LIKE 'defs/%')
      ORDER BY namespace, key
    `,
  );
  const policies = await readRows<ToolPolicyRow[]>(
    sql,
    `
      SELECT tenant, owner, subject, id, pattern, action, position, created_at::text,
        updated_at::text, row_id
      FROM tool_policy
      WHERE tenant IN (
        SELECT tenant FROM integration
        WHERE plugin_id IN ('google', 'microsoft')
      )
      ORDER BY tenant, owner, subject, position, id
    `,
  );
  return {
    integrations,
    connections,
    tools,
    pluginStorage,
    blobs,
    policies,
    completedTenants,
    trafficLastTenant,
    blobBackend,
    assumeExternalBlobSourcePresent: blobBackend === "external",
  };
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

const operationKeyPrefix = (integration: string): string =>
  `${operationStorageKey(integration, "").split(".").slice(0, 2).join(".")}.%`;

export const applyOrg = async (sql: SqlClient, org: OrgPlan): Promise<void> => {
  if (org.completed) return;
  if (org.hardErrors.length > 0) {
    throw new Error(`org ${org.tenantHash} has unresolved hard errors; apply is blocked`);
  }
  await sql.begin(async (tx) => {
    const now = new Date();
    for (const copy of org.blobCopies.filter((item) => item.backend === "database")) {
      const [source] = await tx.unsafe<{ readonly value: string }[]>(
        "SELECT value FROM blob WHERE namespace = $1 AND key = $2 LIMIT 1",
        [copy.sourceNamespace, copy.key],
      );
      if (!source) {
        throw new Error(`Missing source blob ${copy.sourceNamespace}/${copy.key}`);
      }
      await tx.unsafe(
        `
          INSERT INTO blob (namespace, key, value, row_id, id)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (id) DO NOTHING
        `,
        [
          copy.targetNamespace,
          copy.key,
          source.value,
          stableId("blob", org.tenant, copy.targetNamespace, copy.key),
          JSON.stringify([copy.targetNamespace, copy.key]),
        ],
      );
    }

    for (const row of org.integrations.filter((item) => item.action === "create")) {
      await tx.unsafe(
        `
          INSERT INTO integration (
            slug, plugin_id, name, description, config, health_check, config_revised_at,
            can_remove, can_refresh, created_at, updated_at, row_id, tenant
          )
          VALUES ($1, $2, $3, $4, $5::json, $6::json, NULL, true, true, $7, $7, $8, $9)
          ON CONFLICT (tenant, slug) DO NOTHING
        `,
        [
          row.target.slug,
          row.target.pluginId,
          row.target.name,
          row.target.description,
          JSON.stringify(scrubJson(row.config)),
          row.healthCheck ? JSON.stringify(scrubJson(row.healthCheck)) : null,
          now,
          stableId("integration", org.tenant, row.target.slug),
          org.tenant,
        ],
      );
    }

    for (const row of org.connections.filter((item) => item.action === "clone")) {
      await tx.unsafe(
        `
          INSERT INTO connection (
            integration, name, template, provider, item_ids, identity_label, description,
            last_health, tools_synced_at, oauth_client, oauth_client_owner, refresh_item_id,
            expires_at, oauth_scope, oauth_token_url, provider_state, created_at, updated_at,
            row_id, tenant, owner, subject
          )
          SELECT $1, name, template, provider, item_ids, identity_label, description,
            NULL, NULL, oauth_client, oauth_client_owner, refresh_item_id, expires_at,
            oauth_scope, oauth_token_url, provider_state, created_at, $2, $3, tenant, owner, subject
          FROM connection
          WHERE tenant = $4 AND owner = $5 AND subject = $6 AND integration = $7 AND name = $8
          ON CONFLICT (tenant, owner, subject, integration, name) DO NOTHING
        `,
        [
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
      );
    }

    for (const integration of org.integrations) {
      for (const contribution of integration.sourceContributions) {
        for (const toolName of contribution.operationToolNames) {
          const [operation] = await tx.unsafe<
            {
              readonly data: unknown;
              readonly created_at: string;
              readonly updated_at: string;
            }[]
          >(
            `
            SELECT data, created_at::text, updated_at::text
            FROM plugin_storage
            WHERE tenant = $1
              AND owner = 'org'
              AND subject = ''
              AND plugin_id = $2
              AND collection = 'operation'
              AND (
                key = $3
                OR (
                  data::jsonb ->> 'integration' = $4
                  AND data::jsonb ->> 'toolName' = $5
                )
              )
            LIMIT 1
          `,
            [
              org.tenant,
              contribution.source.plugin_id,
              operationStorageKey(contribution.source.slug, toolName),
              contribution.source.slug,
              toolName,
            ],
          );
          if (!operation) {
            throw new Error(
              `Missing operation row for ${tenantHash(org.tenant)}/${contribution.source.slug}/${toolName}`,
            );
          }
          await tx.unsafe(
            `
            INSERT INTO plugin_storage (
              plugin_id, collection, key, data, created_at, updated_at, row_id,
              tenant, owner, subject
            )
            VALUES ($1, 'operation', $2, $3::json, $4, $5, $6, $7, 'org', '')
            ON CONFLICT (tenant, owner, subject, plugin_id, collection, key)
            DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
          `,
            [
              integration.target.pluginId,
              operationStorageKey(integration.target.slug, toolName),
              JSON.stringify(
                scrubJson({
                  ...storageDataRecord(operation),
                  integration: integration.target.slug,
                  toolName,
                }),
              ),
              operation.created_at,
              now,
              stableId("operation", org.tenant, integration.target.slug, toolName),
              org.tenant,
            ],
          );
          await tx.unsafe(
            `
            INSERT INTO tool (
              integration, connection, plugin_id, name, description, input_schema, output_schema,
              annotations, created_at, updated_at, row_id, tenant, owner, subject
            )
            SELECT $1, connection, $2, name, description, input_schema, output_schema,
              annotations, created_at, $3, concat($4::text, '_', row_id), tenant, owner, subject
            FROM tool
            WHERE tenant = $5 AND integration = $6 AND name = $7
            ON CONFLICT (tenant, owner, subject, integration, connection, name) DO NOTHING
          `,
            [
              integration.target.slug,
              integration.target.pluginId,
              now,
              stableId("tool", org.tenant, integration.target.slug),
              org.tenant,
              contribution.source.slug,
              toolName,
            ],
          );
        }
      }
    }

    for (const policy of org.policies.filter((item) => item.action === "rewrite")) {
      await tx.unsafe(
        "DELETE FROM tool_policy WHERE tenant = $1 AND owner = $2 AND subject = $3 AND id = $4",
        [org.tenant, policy.policy.owner, policy.policy.subject, policy.policy.id],
      );
      for (const [index, pattern] of policy.afterPatterns.entries()) {
        await tx.unsafe(
          `
            INSERT INTO tool_policy (
              id, pattern, action, position, created_at, updated_at, row_id, tenant, owner, subject
            )
            VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9)
            ON CONFLICT (tenant, owner, subject, id) DO NOTHING
          `,
          [
            policy.afterPatterns.length === 1
              ? policy.policy.id
              : `${policy.policy.id}_${index + 1}`,
            pattern,
            policy.policy.action,
            policy.policy.position,
            now,
            stableId("policy", org.tenant, policy.policy.id, pattern),
            org.tenant,
            policy.policy.owner,
            policy.policy.subject,
          ],
        );
      }
    }

    for (const monolith of org.deleteMonoliths) {
      await tx.unsafe("DELETE FROM tool WHERE tenant = $1 AND integration = $2", [
        org.tenant,
        monolith.slug,
      ]);
      await tx.unsafe("DELETE FROM connection WHERE tenant = $1 AND integration = $2", [
        org.tenant,
        monolith.slug,
      ]);
      await tx.unsafe(
        "DELETE FROM integration WHERE tenant = $1 AND slug = $2 AND plugin_id = $3",
        [org.tenant, monolith.slug, monolith.plugin_id],
      );
      await tx.unsafe(
        `
          DELETE FROM plugin_storage
          WHERE tenant = $1
            AND owner = 'org'
            AND subject = ''
            AND plugin_id = $2
            AND collection = 'operation'
            AND (
              data::jsonb ->> 'integration' = $3
              OR key LIKE $4
            )
        `,
        [org.tenant, monolith.plugin_id, monolith.slug, operationKeyPrefix(monolith.slug)],
      );
    }

    await tx.unsafe(
      `
        INSERT INTO ${LEDGER_TABLE} (tenant, time_completed)
        VALUES ($1, $2)
        ON CONFLICT (tenant) DO UPDATE SET time_completed = EXCLUDED.time_completed
      `,
      [org.tenant, Date.now()],
    );
  });
};

const writeDryRun = (planInput: MigrationInput): void => {
  const plan = planMigration({ ...planInput, collectPolicyErrors: true });
  const neverWiden = verifyPolicyRewriteNeverWidens(plan, planInput);
  const r2Copies = plan.orgs
    .filter((org) => !org.completed && org.hardErrors.length === 0)
    .flatMap((org) =>
      org.blobCopies
        .filter((copy) => copy.backend === "external")
        .map((copy) => ({
          tenantHash: org.tenantHash,
          tenant: org.tenant,
          sourceKey: copy.sourceObjectName,
          destKey: copy.targetObjectName,
        })),
    );
  mkdirSync(outputDir, { recursive: true });
  for (const org of plan.orgs) {
    writeFileSync(`${outputDir}/org-${org.tenantHash}.md`, renderOrgDiff(org));
  }
  writeFileSync(`${outputDir}/r2-copy-manifest.json`, `${JSON.stringify(r2Copies, null, 2)}\n`);
  writeFileSync(
    `${outputDir}/summary.md`,
    `${renderSummary(plan)}\npolicy_never_widen=${neverWiden.ok}\npolicy_never_widen_checked=${neverWiden.checkedPolicies}\nr2_copy_manifest=${outputDir}/r2-copy-manifest.json\nr2_copy_count=${r2Copies.length}\nr2_copy_command=wrangler r2 object get <bucket>/<sourceKey> | wrangler r2 object put <bucket>/<destKey> --pipe\n`,
  );
  console.log(renderSummary(plan));
  console.log(`policy_never_widen=${neverWiden.ok}`);
  console.log(`policy_never_widen_checked=${neverWiden.checkedPolicies}`);
  console.log(`r2_copy_manifest=${outputDir}/r2-copy-manifest.json`);
  console.log(`r2_copy_count=${r2Copies.length}`);
  console.log(
    "r2_copy_command=wrangler r2 object get <bucket>/<sourceKey> | wrangler r2 object put <bucket>/<destKey> --pipe",
  );
  console.log(`diff_dir=${outputDir}`);
  if (!neverWiden.ok) {
    throw new Error(
      `Policy rewrite failed coverage checks: widened=${neverWiden.widened.length}, narrowed=${neverWiden.narrowed.length}`,
    );
  }
  if (
    plan.summary.integrationsMissingSpecBlob > 0 ||
    plan.summary.integrationsMissingDefsBlob > 0
  ) {
    throw new Error(
      `Serving blob check failed: missing spec=${plan.summary.integrationsMissingSpecBlob}, missing defs=${plan.summary.integrationsMissingDefsBlob}`,
    );
  }
  const zeroOperationIntegrations = plan.orgs
    .filter((org) => !org.completed && org.hardErrors.length === 0)
    .flatMap((org) => org.integrations)
    .filter(
      (integration) =>
        integration.servingState.operationsToBuild === 0 &&
        !integration.servingState.expectedZeroOperations,
    );
  if (zeroOperationIntegrations.length > 0) {
    throw new Error(
      `Serving operation check failed for ${zeroOperationIntegrations.length} planned integration(s)`,
    );
  }
};

const main = async (): Promise<void> => {
  if (inputJson) {
    const input = parseInputJson(inputJson);
    writeDryRun(
      filterInputByOrg(
        {
          ...input,
          trafficLastTenant: trafficLastTenant ?? input.trafficLastTenant,
        },
        orgFilter,
      ),
    );
    return;
  }
  if (!databaseUrl) {
    throw new Error("Set DATABASE_URL or pass --input-json");
  }
  const usesLocalDatabase = databaseUrl.includes("127.0.0.1") || databaseUrl.includes("localhost");
  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    ...(usesLocalDatabase ? {} : { ssl: "require" as const }),
  }) as unknown as SqlClient;
  try {
    const input = filterInputByOrg(
      await readDatabaseInput(sql, !apply, usesLocalDatabase ? "database" : "external"),
      orgFilter,
    );
    if (!apply) {
      writeDryRun(input);
      return;
    }
    const plan = planMigration(input);
    const neverWiden = verifyPolicyRewriteNeverWidens(plan, input);
    if (!neverWiden.ok) {
      throw new Error(
        `Policy rewrite failed coverage checks: widened=${neverWiden.widened.length}, narrowed=${neverWiden.narrowed.length}`,
      );
    }
    if (
      plan.summary.integrationsMissingSpecBlob > 0 ||
      plan.summary.integrationsMissingDefsBlob > 0
    ) {
      throw new Error(
        `Serving blob check failed: missing spec=${plan.summary.integrationsMissingSpecBlob}, missing defs=${plan.summary.integrationsMissingDefsBlob}`,
      );
    }
    const zeroOperationIntegrations = plan.orgs
      .filter((org) => !org.completed && org.hardErrors.length === 0)
      .flatMap((org) => org.integrations)
      .filter(
        (integration) =>
          integration.servingState.operationsToBuild === 0 &&
          !integration.servingState.expectedZeroOperations,
      );
    if (zeroOperationIntegrations.length > 0) {
      throw new Error(
        `Serving operation check failed for ${zeroOperationIntegrations.length} planned integration(s)`,
      );
    }
    const requiredR2Copies = plan.orgs
      .filter((org) => !org.completed && org.hardErrors.length === 0)
      .flatMap((org) => org.blobCopies.filter((copy) => copy.backend === "external"));
    if (requiredR2Copies.length > 0 && !r2CopiesDone) {
      throw new Error(
        `External R2 blob copies are required before apply (${requiredR2Copies.length}); run dry-run, execute r2-copy-manifest.json, then pass --r2-copies-done`,
      );
    }
    for (const org of plan.orgs) {
      await applyOrg(sql, org);
      console.log(`applied_org=${tenantHash(org.tenant)}`);
    }
    console.log(renderSummary(plan));
  } finally {
    await sql.end({ timeout: 0 });
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
