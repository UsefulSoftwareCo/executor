import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

import { Effect } from "effect";

import {
  definePlugin,
  StorageError,
  type PluginCtx,
  type SecretProvider,
} from "@executor-js/sdk/core";

// ---------------------------------------------------------------------------
// Encrypted DB-backed secret provider for self-host.
//
// Secret values are stored AES-256-GCM-encrypted in the executor's
// plugin-storage table (scope-partitioned, scope-policy enforced) — never in
// plaintext, unlike the file-secrets provider. The master key comes from the
// host (EXECUTOR_SECRET_KEY or a persisted key file); a random per-value IV +
// auth tag are stored alongside the ciphertext. Only node:crypto is used.
//
// This is the multi-tenant-safe default writable provider for the self-hosted
// server, replacing the OS-keychain/plaintext-file providers that assume a
// single desktop user.
// ---------------------------------------------------------------------------

type PluginStorage = PluginCtx<unknown>["pluginStorage"];

const COLLECTION = "secrets";
const KEY_SALT = "executor-encrypted-secrets/v1";
const PAYLOAD_VERSION = "v1";

/** Derive a 32-byte AES key from an arbitrary-length master key string. */
const deriveKey = (master: string): Buffer => scryptSync(master, KEY_SALT, 32);

const encryptSecret = (key: Buffer, plaintext: string): Effect.Effect<string, StorageError> =>
  Effect.try({
    try: () => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        PAYLOAD_VERSION,
        iv.toString("base64"),
        tag.toString("base64"),
        ciphertext.toString("base64"),
      ].join(".");
    },
    catch: (cause) => new StorageError({ message: "Failed to encrypt secret", cause }),
  });

const decryptSecret = (key: Buffer, payload: string): Effect.Effect<string, StorageError> =>
  Effect.try({
    // A malformed payload, a wrong key, or tampered bytes all surface here:
    // GCM verification fails in `decipher.final()`, and bad base64/arity throws
    // before that — both land in the StorageError channel.
    try: () => {
      const parts = payload.split(".");
      const iv = Buffer.from(parts[1] ?? "", "base64");
      const tag = Buffer.from(parts[2] ?? "", "base64");
      const ciphertext = Buffer.from(parts[3] ?? "", "base64");
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    },
    catch: (cause) => new StorageError({ message: "Failed to decrypt secret", cause }),
  });

const makeEncryptedProvider = (
  key: Buffer,
  storage: PluginStorage,
  listScope: string,
): SecretProvider => ({
  key: "encrypted",
  writable: true,

  get: (secretId, scope) =>
    storage
      .getAtScope<string>({ collection: COLLECTION, key: secretId, scope })
      .pipe(
        Effect.flatMap((entry) => (entry ? decryptSecret(key, entry.data) : Effect.succeed(null))),
      ),

  has: (secretId, scope) =>
    storage
      .getAtScope({ collection: COLLECTION, key: secretId, scope })
      .pipe(Effect.map((entry) => entry !== null)),

  set: (secretId, value, scope) =>
    encryptSecret(key, value).pipe(
      Effect.flatMap((payload) =>
        storage.put({ collection: COLLECTION, key: secretId, scope, data: payload }),
      ),
      Effect.asVoid,
    ),

  delete: (secretId, scope) =>
    storage
      .getAtScope({ collection: COLLECTION, key: secretId, scope })
      .pipe(
        Effect.flatMap((entry) =>
          entry
            ? storage.remove({ collection: COLLECTION, key: secretId, scope }).pipe(Effect.as(true))
            : Effect.succeed(false),
        ),
      ),

  // Scope-agnostic by interface; like file-secrets we surface the innermost
  // scope for display. Per-call get/set/delete honor the explicit scope arg.
  list: () =>
    storage
      .list<string>({ collection: COLLECTION })
      .pipe(
        Effect.map((entries) =>
          entries
            .filter((entry) => String(entry.scopeId) === listScope)
            .map((entry) => ({ id: entry.key, name: entry.key })),
        ),
      ),
});

export interface EncryptedSecretsPluginConfig {
  /**
   * Master key (any non-empty string) — derived to 32 bytes via scrypt. The
   * host is responsible for supplying a strong, persistent key
   * (EXECUTOR_SECRET_KEY or a generated key file); a secret store with no key
   * is unsafe, so this is required.
   */
  readonly key: string;
}

export const encryptedSecretsPlugin = definePlugin((options?: EncryptedSecretsPluginConfig) => {
  const master = options?.key;
  if (!master) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: a secret store with no master key is unsafe; fail loud at construction
    throw new Error("encryptedSecretsPlugin requires a non-empty `key`");
  }
  const derivedKey = deriveKey(master);
  return {
    id: "encryptedSecrets" as const,
    storage: () => ({}),
    secretProviders: (ctx: PluginCtx<unknown>) => [
      makeEncryptedProvider(derivedKey, ctx.pluginStorage, ctx.scopes[0]!.id),
    ],
  };
});

// Exported for host-side tests / reuse.
export { deriveKey, encryptSecret, decryptSecret };
