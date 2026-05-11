import { Effect } from "effect";

import { StorageError, type SecretProvider } from "@executor-js/sdk/core";

import type { KeychainError } from "./errors";
import { getPassword, setPassword, deletePassword } from "./keyring";

// ---------------------------------------------------------------------------
// SecretProvider adapter — bridges keyring into SDK resolution chain
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
// ---------------------------------------------------------------------------

const toStorageError = (cause: KeychainError) => {
  const { cause: underlyingCause } = cause;
  // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: typed KeychainError message becomes StorageError message
  return new StorageError({ message: cause.message, cause: underlyingCause ?? cause });
};

export const scopedKeychainServiceName = (baseServiceName: string, scope: string): string =>
  `${baseServiceName}/${scope}`;

export const makeKeychainProvider = (baseServiceName: string): SecretProvider => ({
  key: "keychain",
  writable: true,
  get: (secretId, scope) =>
    getPassword(scopedKeychainServiceName(baseServiceName, scope), secretId).pipe(
      Effect.mapError(toStorageError),
    ),
  set: (secretId, value, scope) =>
    setPassword(scopedKeychainServiceName(baseServiceName, scope), secretId, value).pipe(
      Effect.mapError(toStorageError),
    ),
  delete: (secretId, scope) =>
    deletePassword(scopedKeychainServiceName(baseServiceName, scope), secretId).pipe(
      Effect.mapError(toStorageError),
    ),
  // Keychain doesn't support enumerating — you need to know the account name
  list: undefined,
});
