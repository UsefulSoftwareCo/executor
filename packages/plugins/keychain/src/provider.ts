import { Effect } from "effect";

import {
  StorageError,
  ProviderKey,
  type CredentialProvider,
  type ProviderItemId,
} from "@executor-js/sdk";

import type { KeychainError } from "./errors";
import { getPassword, setPassword, deletePassword } from "./keyring";

// ---------------------------------------------------------------------------
// CredentialProvider adapter — bridges keyring into the v2 resolution chain.
//
// The underlying `@napi-rs/keyring` sync API encodes "no entry" as an
// ordinary return value (`getPassword()` → `null`, `deletePassword()` →
// `false`), and only throws on real failures (keychain locked, permission
// denied, platform init failure, etc.). `keyring.ts` wraps those thrown
// failures as `KeychainError`. We translate `KeychainError` →
// `StorageError` so the HTTP edge can capture it to telemetry and surface
// an opaque `InternalError({ traceId })` — previously `orElseSucceed`
// silently converted every failure into "nothing found", which made it
// impossible to debug why secrets weren't resolving.
//
// v2: the provider sees only an opaque `ProviderItemId` (the keychain
// account). There is NO scope arg — the connection row owns the (tenant,
// owner, subject) partition. We use a single, flat keychain service name;
// the connection's opaque id is the account that uniquely keys the entry.
// ---------------------------------------------------------------------------

const toStorageError = (cause: KeychainError) => {
  const { cause: underlyingCause } = cause;
  // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: typed KeychainError message becomes StorageError message
  return new StorageError({ message: cause.message, cause: underlyingCause ?? cause });
};

const KEYCHAIN_PROVIDER_KEY = ProviderKey.make("keychain");

export const makeKeychainProvider = (serviceName: string): CredentialProvider => ({
  key: KEYCHAIN_PROVIDER_KEY,
  writable: true,
  get: (id: ProviderItemId) => getPassword(serviceName, id).pipe(Effect.mapError(toStorageError)),
  has: (id: ProviderItemId) =>
    getPassword(serviceName, id).pipe(
      Effect.map((value: string | null) => value !== null),
      Effect.mapError(toStorageError),
    ),
  set: (id: ProviderItemId, value: string) =>
    setPassword(serviceName, id, value).pipe(Effect.mapError(toStorageError)),
  delete: (id: ProviderItemId) =>
    deletePassword(serviceName, id).pipe(Effect.asVoid, Effect.mapError(toStorageError)),
  // Keychain doesn't support enumerating — you need to know the account name.
  list: undefined,
});
