import { type Condition, type ConditionBuilder } from "@executor-js/fumadb/query";
import type { AnyColumn, AnyTable } from "@executor-js/fumadb/schema";

import { StorageError } from "./fuma-runtime";

/* The v2 owner policy — successor to v1's `executor.scope` policy. Every owned
 * row carries `tenant` + `owner`('org'|'user') + `subject`; org rows use the
 * empty-string sentinel for `subject` (NOT null, so unique indexes stay portable).
 *
 * An executor binds to `{ tenant, subject }`. The policy guards storage so it can
 * only read/write rows it owns:
 *   - read/update/delete → tenant matches AND (owner='org' OR subject matches)
 *   - create → the written (tenant, owner, subject) must match the binding
 * No scope stack, no innermost-wins shadowing: a tool address names its owner
 * segment, so org and user rows are distinct, both visible to the acting subject. */

export const executorOwnerPolicyName = "executor.owner";
/** Tenant-shared tables (the integration catalog) — partitioned by `tenant` only. */
export const executorTenantPolicyName = "executor.tenant";
/** Truly global tables (the blob store) — isolation carried in the row namespace. */
export const executorUnscopedPolicyName = "executor.unscoped";

/** Sentinel `subject` value for org-owned rows. */
export const ORG_SUBJECT = "";

const unscopedExecutorTables = new Set(["blob"]);

export interface ExecutorOwnerPolicyContext {
  readonly tenant: string;
  /** The acting member, or null for a pure-org executor (no `owner:"user"`
   *  reads/writes are allowed when null). */
  readonly subject: string | null;
}

type AnyConditionBuilder = ConditionBuilder<Record<string, AnyColumn>>;

const policyViolation = (message: string): never => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: FumaDB table policy callbacks are promise callbacks, not Effect effects
  throw new StorageError({ message, cause: undefined });
};

const requireContext = (
  tableName: string,
  access: string,
  context: ExecutorOwnerPolicyContext | undefined,
): ExecutorOwnerPolicyContext => {
  if (context) return context;
  return policyViolation(
    `Storage ${access} on table "${tableName}" is missing executor owner context.`,
  );
};

/** The rows the bound `{ tenant, subject }` may see/mutate: org rows in the
 *  tenant, plus this subject's own user rows. */
export const ownerVisibilityCondition = (
  builder: AnyConditionBuilder,
  context: ExecutorOwnerPolicyContext,
): Condition | boolean => {
  const orgClause = builder.and(
    builder("tenant", "=", context.tenant),
    builder("owner", "=", "org"),
  );
  if (context.subject == null) return orgClause;
  const userClause = builder.and(
    builder("tenant", "=", context.tenant),
    builder("owner", "=", "user"),
    builder("subject", "=", context.subject),
  );
  return builder.or(orgClause, userClause);
};

/** Assert a create/upsert writes a row inside the bound partition. */
export const assertOwnerWritable = (
  tableName: string,
  values: Record<string, unknown>,
  context: ExecutorOwnerPolicyContext | undefined,
): void => {
  const ctx = requireContext(tableName, "write", context);
  if (values.tenant !== ctx.tenant) {
    policyViolation(`Storage write on table "${tableName}" is outside the executor tenant.`);
  }
  if (values.owner === "org") {
    if (values.subject !== ORG_SUBJECT) {
      policyViolation(`Storage write on table "${tableName}" set a subject on an org row.`);
    }
    return;
  }
  if (values.owner === "user") {
    if (ctx.subject == null || values.subject !== ctx.subject) {
      policyViolation(
        `Storage write on table "${tableName}" targets a user row outside the bound subject.`,
      );
    }
    return;
  }
  policyViolation(
    `Storage write on table "${tableName}" has an invalid owner "${String(values.owner)}".`,
  );
};

/** Assert a patch (`set`) doesn't move a row out of the bound partition. Only
 *  validates the partition columns that are actually being written. */
export const assertOwnerPatch = (
  tableName: string,
  patch: Record<string, unknown> | undefined,
  context: ExecutorOwnerPolicyContext | undefined,
): void => {
  const ctx = requireContext(tableName, "write", context);
  if (!patch) return;
  if (patch.tenant !== undefined && patch.tenant !== ctx.tenant) {
    policyViolation(`Storage write on table "${tableName}" cannot move a row across tenants.`);
  }
  if (patch.owner === "user" && (ctx.subject == null || patch.subject !== ctx.subject)) {
    policyViolation(
      `Storage write on table "${tableName}" cannot move a row outside the bound subject.`,
    );
  }
};

export const hasExecutorOwnerPolicy = (table: AnyTable): boolean =>
  table.policies.some((policy) => policy.name === executorOwnerPolicyName);

export function assertExecutorOwnerPolicyTable(table: AnyTable, tableKey?: string): void {
  const tableName = table.ormName || tableKey || table.names.sql;
  const owned = table.policies.find((policy) => policy.name === executorOwnerPolicyName);
  if (owned?.onRead && owned.onCreate && owned.onUpdate && owned.onDelete) return;

  const tenant = table.policies.find((policy) => policy.name === executorTenantPolicyName);
  if (tenant?.onRead && tenant.onCreate && tenant.onUpdate && tenant.onDelete) return;

  const unscoped = table.policies.find((policy) => policy.name === executorUnscopedPolicyName);
  if (unscoped && unscopedExecutorTables.has(tableName)) return;

  policyViolation(`Storage table "${tableName}" is missing an executor owner policy.`);
}
