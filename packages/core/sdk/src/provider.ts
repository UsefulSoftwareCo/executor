import type { Effect } from "effect";

import type { StorageFailure } from "./fuma-runtime";
import type { ProviderItemId, ProviderKey } from "./ids";

/* Where a credential's value actually lives — the v2 successor to v1's
 * `SecretProvider`. The default store holds pasted values; external backends
 * (1Password, keychain, workos-vault) resolve an opaque `id` on demand — the
 * value never lands in our core storage. Core never knows how the id is shaped;
 * only the provider interprets it. Registered alongside the executor, a separate
 * axis from integration plugins. No `scope` arg — the connection row owns the
 * (tenant, owner, subject) partition; the provider sees only an opaque id. */

export interface ProviderEntry {
  /** The provider's own opaque handle for this entry. Surfaced for discovery so
   *  a connection can reference it without core knowing its internal shape. */
  readonly id: ProviderItemId;
  readonly name: string;
}

/** Partition that owns a connection credential. Providers without partitioned
 * storage may ignore it. */
export interface CredentialProviderScope {
  readonly owner: "org" | "user";
  /** Empty for org credentials; the connection row's subject for user credentials. */
  readonly subject: string;
}

export interface CredentialProvider {
  readonly key: ProviderKey;
  /** If false, we never write here — `set`/`delete` are skipped and a referenced
   *  connection's `remove` only drops our routing, leaving the item intact. */
  readonly writable: boolean;
  /** Resolve a value by opaque id. The single hop a credential goes through
   *  before its template is applied. The provider interprets the id. */
  readonly get: (
    id: ProviderItemId,
    scope?: CredentialProviderScope,
  ) => Effect.Effect<string | null, StorageFailure>;
  readonly has?: (
    id: ProviderItemId,
    scope?: CredentialProviderScope,
  ) => Effect.Effect<boolean, StorageFailure>;
  readonly set?: (
    id: ProviderItemId,
    value: string,
    scope?: CredentialProviderScope,
  ) => Effect.Effect<void, StorageFailure>;
  readonly delete?: (
    id: ProviderItemId,
    scope?: CredentialProviderScope,
  ) => Effect.Effect<void, StorageFailure>;
  /** Browse entries for discovery (pick a 1Password item). Optional — some
   *  backends can't enumerate. */
  readonly list?: () => Effect.Effect<readonly ProviderEntry[], StorageFailure>;
}
