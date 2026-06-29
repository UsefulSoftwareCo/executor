import { Effect } from "effect";

import { definePlugin, type CredentialProvider, type PluginCtx } from "@executor-js/sdk";

import {
  deletePassword,
  displayName,
  getPassword,
  isSupportedPlatform,
  resolveServiceName,
  setPassword,
} from "./keyring";
import { makeKeychainProvider } from "./provider";

// Probe the keychain by writing and then deleting a sentinel entry. A
// read-only probe isn't enough — on some Linux environments (WSL2,
// headless CI) `getPassword` for a missing key returns null without
// error, but `setPassword` fails because the secret-service backend
// isn't actually reachable. Writing is the capability the executor
// cares about, so test it directly.
const PROBE_VALUE = "probe";
const probeAccount = (): string =>
  `__executor_keychain_probe__:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { KeychainError } from "./errors";
export { makeKeychainProvider } from "./provider";
export { isSupportedPlatform, displayName } from "./keyring";

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

export interface KeychainPluginConfig {
  /** Override the keychain service name (default: "executor") */
  readonly serviceName?: string;
}

// ---------------------------------------------------------------------------
// Plugin extension — public API on executor.keychain
// ---------------------------------------------------------------------------

export type KeychainExtension = ReturnType<typeof makeKeychainExtension>;

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const makeKeychainExtension = (
  _ctx: PluginCtx<unknown>,
  options: KeychainPluginConfig | undefined,
) => {
  const serviceName = resolveServiceName(options?.serviceName);
  return {
    /** Human-readable name for the keychain on this platform */
    displayName: displayName(),

    /** Whether the current platform supports system keychain */
    isSupported: isSupportedPlatform(),

    /** Check if a secret exists in the system keychain. `id` is the opaque
     *  provider item id (the keychain account); v2 has no scope partitioning. */
    has: (id: string) =>
      getPassword(serviceName, id).pipe(
        Effect.map((value: string | null) => value !== null),
        Effect.orElseSucceed(() => false),
      ),
  };
};

export const keychainPlugin = definePlugin((options?: KeychainPluginConfig) => ({
  id: "keychain" as const,
  storage: () => ({}),

  extension: (ctx: PluginCtx<unknown>): KeychainExtension => makeKeychainExtension(ctx, options),

  credentialProviders: (): Effect.Effect<readonly CredentialProvider[]> =>
    Effect.gen(function* () {
      const serviceName = resolveServiceName(options?.serviceName);
      const account = probeAccount();
      const reachable = yield* setPassword(serviceName, account, PROBE_VALUE).pipe(
        Effect.andThen(deletePassword(serviceName, account).pipe(Effect.catch(() => Effect.void))),
        Effect.as(true),
        Effect.catch(() =>
          Effect.logWarning("keychain unavailable, skipping provider registration").pipe(
            Effect.as(false),
          ),
        ),
      );
      return reachable ? [makeKeychainProvider(serviceName)] : [];
    }),
}));
