import { Effect, Schema } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  definePlugin,
  ProviderItemId,
  ProviderKey,
  StorageError,
  type CredentialProvider,
} from "@executor-js/sdk";

// ---------------------------------------------------------------------------
// XDG data dir resolution
// ---------------------------------------------------------------------------

const APP_NAME = "executor";

export const xdgDataHome = (): string => {
  if (process.env.XDG_DATA_HOME?.trim()) return process.env.XDG_DATA_HOME.trim();
  if (process.platform === "win32") {
    return (
      process.env.LOCALAPPDATA ||
      process.env.APPDATA ||
      path.join(process.env.USERPROFILE || "~", "AppData", "Local")
    );
  }
  return path.join(process.env.HOME || "~", ".local", "share");
};

const authDir = (overrideDir?: string): string => overrideDir ?? path.join(xdgDataHome(), APP_NAME);

const authFilePath = (overrideDir?: string): string => path.join(authDir(overrideDir), "auth.json");

// ---------------------------------------------------------------------------
// Schema for the auth file
//
// v2: the file is a FLAT map of opaque provider item id -> value.
//   { "github-token": "ghp_xxx" }
// The v1 per-scope partition (`{ scopeId: { secretId: value } }`) is gone:
// the connection row owns the (tenant, owner, subject) partition, and the
// provider only ever sees an opaque `ProviderItemId`.
// ---------------------------------------------------------------------------

const FlatAuthFile = Schema.Record(Schema.String, Schema.String);
const decodeFlatAuthFile = Schema.decodeUnknownEffect(Schema.fromJsonString(FlatAuthFile));

// ---------------------------------------------------------------------------
// File I/O with restricted permissions
//
// These helpers keep real I/O and decode failures in the Effect error
// channel as `StorageError`. Missing files are still treated as an empty
// auth file, but malformed JSON, schema decode failures, and permission
// errors no longer collapse into "empty file".
// ---------------------------------------------------------------------------

const isFileNotFoundCause = (cause: unknown): cause is NodeJS.ErrnoException =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

const toStorageError =
  (message: string) =>
  (cause: unknown): StorageError =>
    new StorageError({ message, cause });

const readAll = (filePath: string): Effect.Effect<Record<string, string>, StorageError> => {
  if (!fs.existsSync(filePath)) return Effect.succeed({});
  return Effect.try({
    try: () => fs.readFileSync(filePath, "utf-8"),
    catch: toStorageError("Failed to read auth file"),
  }).pipe(
    Effect.catchIf(
      (error: StorageError) => isFileNotFoundCause(error.cause),
      () => Effect.succeed(""),
    ),
    Effect.flatMap((raw: string) =>
      raw === ""
        ? Effect.succeed<Record<string, string>>({})
        : decodeFlatAuthFile(raw).pipe(
            Effect.mapError(toStorageError("Failed to parse auth file")),
          ),
    ),
  );
};

const writeAll = (
  filePath: string,
  secrets: Record<string, string>,
): Effect.Effect<void, StorageError> => {
  const dir = path.dirname(filePath);
  const tmp = `${filePath}.tmp`;
  return Effect.gen(function* () {
    if (!fs.existsSync(dir)) {
      yield* Effect.try({
        try: () => fs.mkdirSync(dir, { recursive: true, mode: 0o700 }),
        catch: toStorageError("Failed to create auth directory"),
      });
    }
    yield* Effect.try({
      try: () => fs.writeFileSync(tmp, JSON.stringify(secrets, null, 2), { mode: 0o600 }),
      catch: toStorageError("Failed to write temporary auth file"),
    });
    yield* Effect.try({
      try: () => fs.renameSync(tmp, filePath),
      catch: toStorageError("Failed to replace auth file"),
    });
  });
};

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

export interface FileSecretsPluginConfig {
  /** Override the directory for auth.json (default: XDG data dir) */
  readonly directory?: string;
}

// ---------------------------------------------------------------------------
// Plugin extension — public API on executor.fileSecrets
// ---------------------------------------------------------------------------

const makeFileSecretsExtension = (options: FileSecretsPluginConfig | undefined) => ({
  filePath: resolveFilePath(options),
});

export type FileSecretsExtension = ReturnType<typeof makeFileSecretsExtension>;

// ---------------------------------------------------------------------------
// CredentialProvider — flat opaque-id storage in auth.json.
//
// v2: no scope partitioning. Each `ProviderItemId` is a flat top-level key in
// the file; the connection row that references it owns the (tenant, owner,
// subject) partition. `delete` returns void; absence is not an error.
// ---------------------------------------------------------------------------

const FILE_PROVIDER_KEY = ProviderKey.make("file");

const makeFileProvider = (filePath: string): CredentialProvider => ({
  key: FILE_PROVIDER_KEY,
  writable: true,

  get: (id: ProviderItemId) => readAll(filePath).pipe(Effect.map((data) => data[id] ?? null)),

  has: (id: ProviderItemId) => readAll(filePath).pipe(Effect.map((data) => id in data)),

  set: (id: ProviderItemId, value: string) =>
    Effect.gen(function* () {
      const data = yield* readAll(filePath);
      data[id] = value;
      yield* writeAll(filePath, data);
    }),

  delete: (id: ProviderItemId) =>
    Effect.gen(function* () {
      const data = yield* readAll(filePath);
      if (id in data) {
        delete data[id];
        yield* writeAll(filePath, data);
      }
    }),

  list: () =>
    readAll(filePath).pipe(
      Effect.map((data) => Object.keys(data).map((k) => ({ id: ProviderItemId.make(k), name: k }))),
    ),
});

// ---------------------------------------------------------------------------
// Plugin definition
//
// Compute the file path identically in `extension` (for `filePath`) and
// `credentialProviders` (for the provider's read/write). Both are called once
// per createExecutor.
// ---------------------------------------------------------------------------

const resolveFilePath = (config: FileSecretsPluginConfig | undefined): string =>
  authFilePath(config?.directory);

export const fileSecretsPlugin = definePlugin((options?: FileSecretsPluginConfig) => ({
  id: "fileSecrets" as const,
  storage: () => ({}),

  extension: () => makeFileSecretsExtension(options),

  credentialProviders: (): readonly CredentialProvider[] => [
    makeFileProvider(resolveFilePath(options)),
  ],
}));
