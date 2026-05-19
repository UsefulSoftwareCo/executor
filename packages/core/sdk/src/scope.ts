import { Schema } from "effect";

import { ScopeId } from "./ids";

export const Scope = Schema.Struct({
  id: ScopeId,
  name: Schema.String,
  createdAt: Schema.Date,
});
export type Scope = typeof Scope.Type;

/**
 * Source-add flows that do not expose a user-facing placement choice install
 * sources at the outermost visible scope. Local executors have one scope, while
 * cloud executors use an innermost personal scope plus an outer organization
 * scope where shared sources live.
 */
export const defaultSourceInstallScopeId = (
  scopes: readonly { readonly id: ScopeId | string }[],
): string | null => {
  const scope = scopes[scopes.length - 1];
  return scope ? String(scope.id) : null;
};
