import { createRequire } from "node:module";

import { Effect } from "effect";

import { KeychainError } from "./errors";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SERVICE_NAME = "executor";
const SERVICE_NAME_ENV = "EXECUTOR_KEYCHAIN_SERVICE_NAME";

// ---------------------------------------------------------------------------
// Platform helpers
// ---------------------------------------------------------------------------

export const isSupportedPlatform = () =>
  process.platform === "darwin" || process.platform === "linux" || process.platform === "win32";

export const displayName = () =>
  process.platform === "darwin"
    ? "macOS Keychain"
    : process.platform === "win32"
      ? "Windows Credential Manager"
      : "Desktop Keyring";

/**
 * Why the keychain may or may not be usable as the DEFAULT credential store.
 *
 * Platform truth, encoded: on macOS/Windows the OS keychain is a durable,
 * persistent store. On Linux, `isSupportedPlatform()` is true but the
 * backing secret-service daemon may be absent (WSL2, headless CI,
 * containers) — in those environments the keyring degrades to an in-memory
 * keyring that a stop/recreate wipes, while only EXECUTOR_DATA_DIR is
 * persisted. The host (apps/local) uses this to decide whether keychain or
 * the file store should be the default for minted OAuth tokens.
 */
export type KeychainAvailability =
  | { readonly kind: "persistent"; readonly name: string }
  | { readonly kind: "ephemeral-or-unavailable"; readonly name: string };

export const describeKeychainAvailability = (): KeychainAvailability => {
  const name = displayName();
  if (process.platform === "darwin" || process.platform === "win32") {
    return { kind: "persistent", name };
  }
  // Linux: the platform probe (write+delete sentinel) decides at plugin
  // registration time whether a real secret-service backend is reachable.
  // We cannot know here; the probe result is authoritative. Report the
  // platform capability honestly and let the probe's reachable flag decide.
  return { kind: "ephemeral-or-unavailable", name };
};

export const resolveServiceName = (explicit?: string): string =>
  explicit?.trim() || process.env[SERVICE_NAME_ENV]?.trim() || DEFAULT_SERVICE_NAME;

// ---------------------------------------------------------------------------
// Lazy-load @napi-rs/keyring (native module)
// ---------------------------------------------------------------------------

type EntryConstructor = (typeof import("@napi-rs/keyring"))["Entry"];

let entryCtorPromise: Promise<EntryConstructor> | null = null;

// In compiled bun binaries (`bun build --compile`) `.node` modules aren't
// included in bunfs and there's no node_modules at runtime, so
// @napi-rs/keyring's loader can't find its platform-specific binding.
// `apps/cli/src/build.ts` copies the .node next to the executor and
// `apps/cli/src/main.ts` exports its absolute path here. We load it
// directly because @napi-rs/keyring@1.2.0's NAPI_RS_NATIVE_LIBRARY_PATH
// branch is buggy (assigns to a local that gets overwritten before return).
const loadEntryCtor = async (): Promise<EntryConstructor> => {
  const directPath = process.env.EXECUTOR_KEYRING_NATIVE_PATH;
  if (directPath) {
    const req = createRequire(import.meta.url);
    return (req(directPath) as { Entry: EntryConstructor }).Entry;
  }
  const { Entry } = await import("@napi-rs/keyring");
  return Entry;
};

const loadEntry = (): Effect.Effect<EntryConstructor, KeychainError> =>
  isSupportedPlatform()
    ? Effect.tryPromise({
        try: async () => {
          entryCtorPromise ??= loadEntryCtor();
          return await entryCtorPromise;
        },
        catch: (cause) =>
          new KeychainError({
            message: "Failed loading native keyring",
            cause,
          }),
      })
    : Effect.fail(
        new KeychainError({
          message: `Failed loading native keyring: unsupported platform '${process.platform}'`,
        }),
      );

const createEntry = (serviceName: string, account: string) =>
  Effect.flatMap(loadEntry(), (Entry) =>
    Effect.try({
      try: () => new Entry(serviceName, account),
      catch: (cause) =>
        new KeychainError({
          message: "Failed creating keyring entry",
          cause,
        }),
    }),
  );

// ---------------------------------------------------------------------------
// Low-level keychain operations
// ---------------------------------------------------------------------------

export const getPassword = (
  serviceName: string,
  account: string,
): Effect.Effect<string | null, KeychainError> =>
  Effect.flatMap(createEntry(serviceName, account), (entry) =>
    Effect.try({
      try: () => entry.getPassword(),
      catch: () => new KeychainError({ message: `Failed reading secret for account '${account}'` }),
    }),
  );

export const setPassword = (
  serviceName: string,
  account: string,
  value: string,
): Effect.Effect<void, KeychainError> =>
  Effect.flatMap(createEntry(serviceName, account), (entry) =>
    Effect.try({
      try: () => entry.setPassword(value),
      catch: (cause) =>
        new KeychainError({
          message: "Failed writing secret",
          cause,
        }),
    }).pipe(Effect.asVoid),
  );

export const deletePassword = (
  serviceName: string,
  account: string,
): Effect.Effect<boolean, KeychainError> =>
  Effect.flatMap(createEntry(serviceName, account), (entry) =>
    Effect.try({
      try: () => {
        entry.deletePassword();
        return true;
      },
      catch: () =>
        new KeychainError({ message: `Failed deleting secret for account '${account}'` }),
    }),
  );
