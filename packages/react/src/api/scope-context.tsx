import * as React from "react";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import type { ScopeId } from "@executor-js/sdk/shared";
import { scopeAtom } from "./atoms";

export interface ScopeStackEntry {
  readonly id: ScopeId;
  readonly name: string;
  readonly dir: string;
}

export interface ScopeInfo {
  readonly id: ScopeId;
  readonly name: string;
  readonly dir: string;
  readonly stack: readonly ScopeStackEntry[];
}

const ScopeContext = React.createContext<ScopeInfo | null>(null);

/**
 * Provides the server scope to all children.
 * Renders the optional `fallback` until the scope is fetched.
 */
export function ScopeProvider(props: React.PropsWithChildren<{ fallback?: React.ReactNode }>) {
  const result = useAtomValue(scopeAtom);

  if (AsyncResult.isSuccess(result)) {
    return <ScopeContext.Provider value={result.value}>{props.children}</ScopeContext.Provider>;
  }

  return <>{props.fallback ?? null}</>;
}

/**
 * Returns the current scope ID.
 * Must be used inside a ScopeProvider (which gates rendering until scope is loaded).
 */
export function useScope(): ScopeId {
  const scope = React.useContext(ScopeContext);
  if (scope === null) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: React hook invariant
    throw new Error("useScope must be used inside a ScopeProvider");
  }
  return scope.id;
}

/**
 * Returns the full scope info (id + display name).
 * Must be used inside a ScopeProvider.
 */
export function useScopeInfo(): ScopeInfo {
  const scope = React.useContext(ScopeContext);
  if (scope === null) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: React hook invariant
    throw new Error("useScopeInfo must be used inside a ScopeProvider");
  }
  return scope;
}

export function useScopeStack(): readonly ScopeStackEntry[] {
  return useScopeInfo().stack;
}

export function useUserScope(): ScopeId {
  const stack = useScopeStack();
  const innermost = stack[0];
  if (!innermost) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: React hook invariant
    throw new Error("useUserScope requires a non-empty scope stack");
  }
  return innermost.id;
}
