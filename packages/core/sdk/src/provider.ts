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
  /** Optional provenance label for pickers when a provider spans several
   *  containers (a 1Password vault name). Purely presentational. */
  readonly group?: string;
}

export interface CredentialProvider {
  readonly key: ProviderKey;
  /** If false, we never write here — `set`/`delete` are skipped and a referenced
   *  connection's `remove` only drops our routing, leaving the item intact. */
  readonly writable: boolean;
  /** Resolve a value by opaque id. The single hop a credential goes through
   *  before its template is applied. The provider interprets the id.
   *
   *  AN ITEM ID IS UNIQUE ONLY WITHIN AN OWNER PARTITION, never globally. The
   *  ids the SDK constructs embed the owner LITERAL (`org` / `user`) but not the
   *  subject, so two members of the same org computing an id for their own
   *  `user`-owned connection arrive at the SAME string. A provider that keeps
   *  one flat namespace across subjects will therefore let one member's write
   *  overwrite another's, and one member's delete remove another's — the shipped
   *  stores avoid this by filing rows per `(tenant, owner, subject)`. Partition
   *  by the same key, or two people quietly share one credential slot. */
  readonly get: (id: ProviderItemId) => Effect.Effect<string | null, StorageFailure>;
  readonly has?: (id: ProviderItemId) => Effect.Effect<boolean, StorageFailure>;
  readonly set?: (id: ProviderItemId, value: string) => Effect.Effect<void, StorageFailure>;
  readonly delete?: (id: ProviderItemId) => Effect.Effect<void, StorageFailure>;
  /** Browse entries for discovery (pick a 1Password item). Optional — some
   *  backends can't enumerate. */
  readonly list?: () => Effect.Effect<readonly ProviderEntry[], StorageFailure>;
}
