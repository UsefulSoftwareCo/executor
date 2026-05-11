import { Effect, Schema } from "effect";

import type { StorageFailure } from "@executor-js/storage-core";

import { SecretId, ScopeId } from "./ids";

// ---------------------------------------------------------------------------
// SecretProvider — what a concrete backend (keychain, 1password, file,
// memory, workos-vault, …) implements. Providers are contributed by
// plugins via `plugin.secretProviders` and registered in the executor
// at startup; there's no runtime registration.
//
// The `key` field is the provider's identifier in the secret table's
// `provider` column and in `executor.secrets.set({ provider, ... })`.
// Unique per executor.
// ---------------------------------------------------------------------------

export interface SecretProvider {
  /** Unique key (e.g. "keychain", "env", "1password", "memory"). */
  readonly key: string;
  /** If false, `set` and `delete` are never called. The executor
   *  honours this before routing writes — trying to write to a
   *  read-only provider is an error, not a silent drop. */
  readonly writable: boolean;
  /** Get a secret value. `scope` is the executor scope the lookup is
   *  being made on behalf of — providers that partition their storage
   *  by scope (memory, keychain via service name, per-vault in
   *  1password) use it; providers without tenancy ignore it and fall
   *  back to a flat lookup. Failures (provider unreachable, decryption
   *  failed, etc.) surface as `StorageFailure` — the executor treats
   *  a provider call the same as a DB call; `StorageError` is captured
   *  at the HTTP edge to `InternalError`, `UniqueViolationError` dies. */
  readonly get: (id: string, scope: string) => Effect.Effect<string | null, StorageFailure>;
  /** Check whether a provider has a backing value without returning it.
   *  Providers that can answer this cheaply should implement it so
   *  stale core routing rows don't appear as selectable secrets. */
  readonly has?: (id: string, scope: string) => Effect.Effect<boolean, StorageFailure>;
  /** Set a secret value at a named scope. Only called on writable
   *  providers. Providers that partition by scope use this arg to
   *  decide where to write; flat providers ignore it. */
  readonly set?: (id: string, value: string, scope: string) => Effect.Effect<void, StorageFailure>;
  /** Delete a secret at a named scope. Only called on writable providers.
   *  Returns true if something was deleted. */
  readonly delete?: (id: string, scope: string) => Effect.Effect<boolean, StorageFailure>;
  /** Enumerate known secret entries. Optional — not all backends can
   *  enumerate (env-backed providers, for example). */
  readonly list?: () => Effect.Effect<
    readonly { readonly id: string; readonly name: string }[],
    StorageFailure
  >;
  /** Whether the provider may be asked during id-only fallback resolution.
   *  Providers whose own auth depends on `ctx.secrets.get` should opt out to
   *  avoid recursive fallback through themselves. */
  readonly allowFallback?: boolean;
}

// ---------------------------------------------------------------------------
// SecretRef — metadata about a stored secret. Returned from
// `executor.secrets.list()`. The actual value lives in the provider
// and is only reachable via `executor.secrets.get(id)`.
// ---------------------------------------------------------------------------

export class SecretRef extends Schema.Class<SecretRef>("SecretRef")({
  id: SecretId,
  scopeId: ScopeId,
  /** Human-readable label (e.g. "Cloudflare API Token") */
  name: Schema.String,
  /** Which provider holds the value */
  provider: Schema.String,
  createdAt: Schema.Date,
}) {}

// ---------------------------------------------------------------------------
// SetSecretInput — all the metadata to write a secret in one call.
// `executor.secrets.set(input)` takes this and writes both the
// value (to the provider) and the ref (to the `secret` table).
//
// `scope` is required — there's no default write target. Callers name
// which scope in the executor's stack should own the secret. Typical
// pattern: UI wiring up org-level API keys writes to the org scope;
// OAuth token exchange writes to the innermost per-user scope.
// ---------------------------------------------------------------------------

export class SetSecretInput extends Schema.Class<SetSecretInput>("SetSecretInput")({
  id: SecretId,
  /** Scope id to own this secret. Must be one of the executor's
   *  configured scopes. */
  scope: ScopeId,
  /** Display name shown in secret-list UI. */
  name: Schema.String,
  /** The secret value itself — never persisted outside the provider. */
  value: Schema.String,
  /** Optional provider routing. If unset the executor picks the first
   *  writable provider in registration order. */
  provider: Schema.optional(Schema.String),
}) {}

export class RemoveSecretInput extends Schema.Class<RemoveSecretInput>("RemoveSecretInput")({
  id: SecretId,
  /** Scope id whose secret row/value should be removed. Must be one of
   *  the executor's configured scopes. */
  targetScope: ScopeId,
}) {}
