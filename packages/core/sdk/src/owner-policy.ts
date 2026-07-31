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

/** How far a context's READS reach. Writes ignore this entirely — see
 *  `assertOwnerWritable`. */
export type ExecutorReach =
  /** The product view: this subject's rows plus the tenant's org rows. */
  | "bound"
  /** The platform view: every row in the tenant, whatever subject owns it.
   *  READ-ONLY by construction — it widens `ownerVisibilityCondition` and
   *  nothing else. */
  | "tenant";

/** Whether a context may mutate at all. Orthogonal to `reach`: reach says how
 *  far reads SEE, this says whether writes are permitted. */
export type ExecutorWrites =
  /** The default: writes are allowed, bounded by `assertOwnerWritable`. */
  | "allowed"
  /** Every create/update/delete is rejected outright, at every reach. */
  | "denied";

export interface ExecutorOwnerPolicyContext {
  readonly tenant: string;
  /** The acting member, or null for a pure-org executor (no `owner:"user"`
   *  reads/writes are allowed when null). */
  readonly subject: string | null;
  /** Read reach; defaults to `"bound"`. A `"tenant"`-reach context is the
   *  platform view: it sees the whole tenant but writes exactly as a bound
   *  context does, so it can never mutate another subject's rows. */
  readonly reach?: ExecutorReach;
  /**
   * Write permission; defaults to `"allowed"`. `"denied"` makes the context
   * read-only at the STORAGE boundary, independently of reach.
   *
   * WHY THIS IS SEPARATE FROM `reach`. A tenant-reach context is always
   * write-denied (a widened write would hit every subject in the tenant), so
   * `reach: "tenant"` implies this. But the converse does not hold: the
   * platform executor needs its ORDINARY, bound-reach surfaces to be read-only
   * too, and it must NOT get tenant reach on them — widening those reads would
   * hand every subject's `connection` row, credential item ids included, to a
   * surface that only ever needed the admin projection. So read-only-ness is
   * its own axis rather than a side effect of reach.
   */
  readonly writes?: ExecutorWrites;
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
 *  tenant, plus this subject's own user rows.
 *
 *  Under `reach: "tenant"` (the platform view) this widens to the whole tenant:
 *  every subject's rows, not just the bound one. That is a READ widening only —
 *  the policy uses this condition for `onRead`/`onUpdate`/`onDelete` filtering,
 *  but the write assertions below reject a tenant-reach context outright, so a
 *  widened context can never be the one doing the mutating. */
export const ownerVisibilityCondition = (
  builder: AnyConditionBuilder,
  context: ExecutorOwnerPolicyContext,
): Condition | boolean => {
  // The platform view: partition by tenant alone. Still never cross-tenant —
  // `tenant` is the one clause that is NEVER relaxed, at any reach.
  if (context.reach === "tenant") return builder("tenant", "=", context.tenant);
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

/**
 * THE security property of the platform view: it never mutates. Two contexts
 * are read-only, for two different reasons, and this one guard covers both:
 *
 *   - `reach: "tenant"` — `ownerVisibilityCondition` is also what filters
 *     `onUpdate`/`onDelete`, so a widened context reaching any mutation would
 *     silently mutate EVERY subject in the tenant.
 *   - `writes: "denied"` — an explicitly read-only context. The platform
 *     executor's ordinary (bound-reach) surfaces carry this: they are not
 *     widened, so the reach clause above would not catch them, yet a
 *     subject-less platform executor still binds to the tenant's org partition
 *     and could otherwise create, update and delete every `owner: "org"` row
 *     in it through `connections` / `policies` / `integrations` / `oauth`.
 *
 * Every write path calls this first and fails loudly — a write arriving on a
 * read-only handle is a programmer error, not something to quietly demote to
 * bound behavior.
 */
export const assertReachReadOnly = (
  tableName: string,
  access: string,
  context: ExecutorOwnerPolicyContext | undefined,
): void => {
  if (context === undefined) return;
  if (context.reach !== "tenant" && context.writes !== "denied") return;
  policyViolation(
    `Storage ${access} on table "${tableName}" is not allowed: the platform view is read-only.`,
  );
};

/** Assert a create/upsert writes a row inside the bound partition. */
export const assertOwnerWritable = (
  tableName: string,
  values: Record<string, unknown>,
  context: ExecutorOwnerPolicyContext | undefined,
): void => {
  const ctx = requireContext(tableName, "write", context);
  assertReachReadOnly(tableName, "write", ctx);
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
  assertReachReadOnly(tableName, "write", ctx);
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
