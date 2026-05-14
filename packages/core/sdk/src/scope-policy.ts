import type { AnyTable } from "fumadb/schema";

import { StorageError } from "./fuma-runtime";

export const executorScopePolicyName = "executor.scope";

export interface ExecutorScopePolicyContext {
  readonly allowedScopeIds: ReadonlySet<string>;
}

export type ExecutorScopePolicyAccess = "read" | "write" | "delete";
export type ExecutorScopeValue = string | null | undefined;

export const hasExecutorScopePolicy = (table: AnyTable): boolean =>
  table.policies.some((policy) => policy.name === executorScopePolicyName);

const scopePolicyViolation = (message: string): never => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: FumaDB row policy callbacks are promise callbacks, not Effect effects
  throw new StorageError({ message, cause: undefined });
};

export function assertExecutorScopePolicyTable(table: AnyTable): void {
  if (hasExecutorScopePolicy(table)) return;
  scopePolicyViolation(`Storage table "${table.ormName}" is missing an executor scope policy.`);
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
