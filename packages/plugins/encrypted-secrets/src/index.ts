import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

import { Effect } from "effect";

import {
  definePlugin,
  Owner,
  ProviderItemId,
  ProviderKey,
  StorageError,
  type CredentialProvider,
  type OwnerBinding,
  type PluginCtx,
} from "@executor-js/sdk";

// ---------------------------------------------------------------------------
// Encrypted DB-backed credential provider for self-host.
//
// Credential values are stored AES-256-GCM-encrypted in the executor's
// plugin-storage table — never in plaintext, unlike the file-secrets provider.
// The master key comes from the host (EXECUTOR_SECRET_KEY or a persisted key
// file); a random per-value IV + auth tag are stored alongside the ciphertext.
// Only node:crypto is used.
//
// This is the multi-tenant-safe default writable provider for the self-hosted
// server, replacing the OS-keychain/plaintext-file providers that assume a
// single desktop user.
//
// v2: the provider sees only an opaque `ProviderItemId` — there is NO scope
// arg. The connection row that references the id owns the (tenant, owner,
// subject) partition; the encrypted value is keyed solely by the opaque id.
// Plugin storage writes still carry an `owner` (the executor's binding), which
// is captured once from the ctx at provider construction.
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

const ENCRYPTED_PROVIDER_KEY = ProviderKey.make("encrypted");

/** Map the executor's (tenant, subject?) binding onto the storage `Owner`
 *  literal: a bound subject writes the user's own partition, otherwise the
 *  org-shared one. */
const ownerOf = (binding: OwnerBinding): Owner =>
  binding.subject == null ? Owner.make("org") : Owner.make("user");

const makeEncryptedProvider = (
  key: Buffer,
  storage: PluginStorage,
  owner: Owner,
): CredentialProvider => ({
  key: ENCRYPTED_PROVIDER_KEY,
  writable: true,

  get: (id: ProviderItemId) =>
    storage
      .get<string>({ collection: COLLECTION, key: id })
      .pipe(
        Effect.flatMap((entry) => (entry ? decryptSecret(key, entry.data) : Effect.succeed(null))),
      ),

  has: (id: ProviderItemId) =>
    storage.get({ collection: COLLECTION, key: id }).pipe(Effect.map((entry) => entry !== null)),

  set: (id: ProviderItemId, value: string) =>
    encryptSecret(key, value).pipe(
      Effect.flatMap((payload) =>
        storage.put({ collection: COLLECTION, key: id, owner, data: payload }),
      ),
      Effect.asVoid,
    ),

  delete: (id: ProviderItemId) => storage.remove({ collection: COLLECTION, key: id, owner }),

  list: () =>
    storage
      .list<string>({ collection: COLLECTION })
      .pipe(
        Effect.map((entries) =>
          entries.map((entry) => ({ id: ProviderItemId.make(entry.key), name: entry.key })),
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
    credentialProviders: (ctx: PluginCtx<unknown>): readonly CredentialProvider[] => [
      makeEncryptedProvider(derivedKey, ctx.pluginStorage, ownerOf(ctx.owner)),
    ],
  };
});

// Exported for host-side tests / reuse.
export { deriveKey, encryptSecret, decryptSecret };
