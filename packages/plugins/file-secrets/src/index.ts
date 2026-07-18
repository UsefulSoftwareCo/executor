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
// Auth file location
// ---------------------------------------------------------------------------

const APP_NAME = "executor";
const AUTH_FILE_NAME = "auth.json";

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

interface AuthLocation {
  readonly filePath: string;
  readonly legacyFilePath: string | null;
}

const legacyAuthFilePath = (): string => path.join(xdgDataHome(), APP_NAME, AUTH_FILE_NAME);

const resolveAuthLocation = (config: FileSecretsPluginConfig | undefined): AuthLocation => {
  if (config?.directory !== undefined) {
    return {
      filePath: path.join(config.directory, AUTH_FILE_NAME),
      legacyFilePath: null,
    };
  }

  const dataDir = process.env.EXECUTOR_DATA_DIR?.trim();
  if (dataDir) {
    return {
      filePath: path.join(dataDir, AUTH_FILE_NAME),
      legacyFilePath: legacyAuthFilePath(),
    };
  }

  return {
    filePath: legacyAuthFilePath(),
    legacyFilePath: null,
  };
};

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
      try: () => {
        fs.writeFileSync(tmp, JSON.stringify(secrets, null, 2), { mode: 0o600 });
        fs.chmodSync(tmp, 0o600);
      },
      catch: toStorageError("Failed to write temporary auth file"),
    });
    yield* Effect.try({
      try: () => fs.renameSync(tmp, filePath),
      catch: toStorageError("Failed to replace auth file"),
    });
  });
};

const migrateLegacyAuthFile = ({
  filePath,
  legacyFilePath,
}: AuthLocation): Effect.Effect<void, StorageError> => {
  if (legacyFilePath === null || fs.existsSync(filePath) || !fs.existsSync(legacyFilePath)) {
    return Effect.void;
  }

  return readAll(legacyFilePath).pipe(
    Effect.matchEffect({
      // A legacy file that cannot be read or decoded must not block startup.
      // The active data-dir store remains empty and all later I/O uses it only.
      onFailure: () => Effect.void,
      onSuccess: (secrets) => writeAll(filePath, secrets),
    }),
  );
};

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

export interface FileSecretsPluginConfig {
  /** Override the directory for auth.json (default: EXECUTOR_DATA_DIR, then XDG data dir) */
  readonly directory?: string;
}

// ---------------------------------------------------------------------------
// Plugin extension — public API on executor.fileSecrets
// ---------------------------------------------------------------------------

const makeFileSecretsExtension = (filePath: string) => ({
  filePath,
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

const makeFileProvider = (location: AuthLocation): CredentialProvider => {
  let migrationComplete = false;
  const ensureMigration = Effect.suspend(() => {
    if (migrationComplete) return Effect.void;
    return migrateLegacyAuthFile(location).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          migrationComplete = true;
        }),
      ),
    );
  });

  return {
    key: FILE_PROVIDER_KEY,
    writable: true,

    get: (id: ProviderItemId) =>
      ensureMigration.pipe(
        Effect.andThen(Effect.suspend(() => readAll(location.filePath))),
        Effect.map((data) => data[id] ?? null),
      ),

    has: (id: ProviderItemId) =>
      ensureMigration.pipe(
        Effect.andThen(Effect.suspend(() => readAll(location.filePath))),
        Effect.map((data) => id in data),
      ),

    set: (id: ProviderItemId, value: string) =>
      ensureMigration.pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const data = yield* readAll(location.filePath);
            data[id] = value;
            yield* writeAll(location.filePath, data);
          }),
        ),
      ),

    delete: (id: ProviderItemId) =>
      ensureMigration.pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const data = yield* readAll(location.filePath);
            if (id in data) {
              delete data[id];
              yield* writeAll(location.filePath, data);
            }
          }),
        ),
      ),

    list: () =>
      ensureMigration.pipe(
        Effect.andThen(Effect.suspend(() => readAll(location.filePath))),
        Effect.map((data) =>
          Object.keys(data).map((k) => ({ id: ProviderItemId.make(k), name: k })),
        ),
      ),
  };
};

// ---------------------------------------------------------------------------
// Plugin definition
//
// Resolve the path once when the configured plugin is constructed. The provider
// performs the one-time migration before its first read or write.
// ---------------------------------------------------------------------------

export const fileSecretsPlugin = definePlugin((options?: FileSecretsPluginConfig) => {
  const location = resolveAuthLocation(options);

  return {
    id: "fileSecrets" as const,
    storage: () => ({}),

    extension: () => makeFileSecretsExtension(location.filePath),

    credentialProviders: (): readonly CredentialProvider[] => [makeFileProvider(location)],
  };
});
