import { ConditionType, type Condition } from "fumadb/query";
import type { AnyTable } from "fumadb/schema";

import { StorageError } from "./fuma-runtime";

export const executorScopePolicyName = "executor.scope";
export const executorUnscopedPolicyName = "executor.unscoped";
const unscopedExecutorTables = new Set(["blob"]);

export interface ExecutorScopePolicyContext {
  readonly allowedScopeIds: ReadonlySet<string>;
}

export type ExecutorScopePolicyAccess = "read" | "write" | "delete";
export type ExecutorScopeValue = string | null | undefined;
export type ExecutorScopeTargetColumn = "scope_id" | "source_scope_id";

export interface ExecutorScopeTarget {
  readonly column: ExecutorScopeTargetColumn;
  readonly value: string;
}

export const hasExecutorScopePolicy = (table: AnyTable): boolean =>
  table.policies.some((policy) => policy.name === executorScopePolicyName);

const scopePolicyViolation = (message: string): never => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: FumaDB table policy callbacks are promise callbacks, not Effect effects
  throw new StorageError({ message, cause: undefined });
};

export function assertExecutorScopePolicyTable(table: AnyTable, tableKey?: string): void {
  const tableName = table.ormName || tableKey || table.names.sql;
  const scopedPolicy = table.policies.find((policy) => policy.name === executorScopePolicyName);
  if (
    scopedPolicy?.onRead &&
    scopedPolicy.onCreate &&
    scopedPolicy.onUpdate &&
    scopedPolicy.onDelete
  ) {
    return;
  }

  const unscopedPolicy = table.policies.find(
    (policy) => policy.name === executorUnscopedPolicyName,
  );
  if (unscopedPolicy && unscopedExecutorTables.has(tableName)) return;

  scopePolicyViolation(`Storage table "${tableName}" is missing an executor scope policy.`);
}

const requireExecutorScopeContext = (
  tableName: string,
  access: ExecutorScopePolicyAccess,
  context: ExecutorScopePolicyContext | undefined,
): ExecutorScopePolicyContext => {
  if (context) return context;
  return scopePolicyViolation(
    `Storage ${access} on table "${tableName}" is missing executor scope context.`,
  );
};

export const isExecutorScopeAllowed = (
  tableName: string,
  access: ExecutorScopePolicyAccess,
  value: ExecutorScopeValue,
  context: ExecutorScopePolicyContext | undefined,
): boolean => {
  const scopeContext = requireExecutorScopeContext(tableName, access, context);
  return typeof value === "string" && scopeContext.allowedScopeIds.has(value);
};

export const executorScopeIds = (
  tableName: string,
  access: ExecutorScopePolicyAccess,
  context: ExecutorScopePolicyContext | undefined,
): string[] => [...requireExecutorScopeContext(tableName, access, context).allowedScopeIds];

const findScopeTarget = (
  condition: Condition | undefined,
  columns: readonly ExecutorScopeTargetColumn[],
): ExecutorScopeTarget | null => {
  if (!condition) return null;
  if (condition.type === ConditionType.Compare) {
    const column = columns.find((name) => condition.a.ormName === name);
    if (!column || condition.operator !== "=" || typeof condition.b !== "string") return null;
    return { column, value: condition.b };
  }
  if (condition.type !== ConditionType.And) return null;

  for (const item of condition.items) {
    const target = findScopeTarget(item, columns);
    if (target) return target;
  }
  return null;
};

export const requireExecutorScopeTarget = (
  tableName: string,
  access: Extract<ExecutorScopePolicyAccess, "write" | "delete">,
  where: Condition | undefined,
  context: ExecutorScopePolicyContext | undefined,
  columns: readonly ExecutorScopeTargetColumn[] = ["scope_id"],
): ExecutorScopeTarget => {
  const scopeContext = requireExecutorScopeContext(tableName, access, context);
  const target = findScopeTarget(where, columns);
  if (target && scopeContext.allowedScopeIds.has(target.value)) return target;

  return scopePolicyViolation(
    `Storage ${access} on table "${tableName}" must target an explicit scope in the executor scope stack.`,
  );
};

export const assertExecutorScopeAllowed = (
  tableName: string,
  access: ExecutorScopePolicyAccess,
  value: ExecutorScopeValue,
  context: ExecutorScopePolicyContext | undefined,
): void => {
  if (isExecutorScopeAllowed(tableName, access, value, context)) return;
  scopePolicyViolation(
    `Storage ${access} on table "${tableName}" is outside the executor scope stack.`,
  );
};

export const assertExecutorScopeTargetValue = (
  tableName: string,
  access: Extract<ExecutorScopePolicyAccess, "write" | "delete">,
  value: ExecutorScopeValue,
  target: ExecutorScopeTarget,
  context: ExecutorScopePolicyContext | undefined,
): void => {
  assertExecutorScopeAllowed(tableName, access, value, context);
  if (value === target.value) return;

  scopePolicyViolation(
    `Storage ${access} on table "${tableName}" must write the same scope it explicitly targets.`,
  );
};

export const assertAnyExecutorScopeAllowed = (
  tableName: string,
  access: ExecutorScopePolicyAccess,
  values: readonly ExecutorScopeValue[],
  context: ExecutorScopePolicyContext | undefined,
): void => {
  if (values.some((value) => isExecutorScopeAllowed(tableName, access, value, context))) return;
  scopePolicyViolation(
    `Storage ${access} on table "${tableName}" is outside the executor scope stack.`,
  );
};
