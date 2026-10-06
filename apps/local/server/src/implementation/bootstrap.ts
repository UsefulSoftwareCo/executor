/** Persist first-install keys in the OS credential store, or a key file when there is none or when chosen. */
import {
  Config,
  ConfigProvider,
  Console,
  Effect,
  Encoding,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Redacted,
  Result,
  Schema,
} from "effect";
import { lock } from "proper-lockfile";
import { config, keyStorageConfig, type KeyStorage } from "../contracts/config.ts";
import {
  LocalConfigurationReason,
  LocalCredentialService,
  LocalInstallation as Installation,
} from "../contracts/auth.ts";

/** Safe startup instructions. Key values are never displayed; native error text is sanitized. */
export class LocalConfigurationError extends Schema.TaggedError<LocalConfigurationError>()(
  "LocalConfigurationError",
  {
    reason: LocalConfigurationReason,
    message: Schema.String,
  },
) {}

const Keys = Schema.Struct({
  apiKey: Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(32))),
  encryptionKey: Schema.RedactedFromValue(
    Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{64}$/)),
  ),
});
/**
 * Native keyring text, sanitized for display: control characters removed, long hex runs (such
 * as generated keys) redacted, and length capped. Keyring-core text never carries the password.
 */
const detail = (error: unknown) =>
  error instanceof Error
    ? error.message
        .replace(/\p{Cc}+/gu, " ")
        .replace(/[0-9a-fA-F]{32,}/g, "[redacted]")
        .trim()
        .slice(0, 240)
    : "unknown error";
const optIn = "set EXECUTOR_KEY_STORAGE=file to keep this new directory's keys in keys.json";
/** `firstStart` here means EXECUTOR_KEY_STORAGE=os ruled out the automatic key file. */
const unavailable = (reason: string, firstStart: boolean) =>
  new LocalConfigurationError({
    reason: "credential-unavailable",
    message: firstStart
      ? `The OS credential store could not be found (${reason}), and EXECUTOR_KEY_STORAGE=os requires it. On Linux, start a Secret Service such as GNOME Keyring, or ${optIn}. No keys were created.`
      : `The OS credential store could not be found (${reason}), and this directory keeps its keys there. On Linux, start a Secret Service such as GNOME Keyring. No replacement keys were created.`,
  });
const unlock: Readonly<Record<string, string>> = {
  linux: "unlock the keyring first, for example with `gnome-keyring-daemon --unlock`",
  darwin: "unlock the keychain first with `security unlock-keychain`",
};
// Kept apart from `unavailable` so the desktop can offer a restart, which prompts again.
const denied = (reason: string, platform: string, firstStart: boolean) =>
  new LocalConfigurationError({
    reason: "credential-denied",
    message: [
      `Access to the OS credential store was denied, or the store is locked (${reason}).`,
      "Start Executor again to be asked again, then allow access or unlock the store.",
      ...(unlock[platform] === undefined
        ? []
        : [`Where no prompt can appear, such as over SSH, ${unlock[platform]}.`]),
      ...(firstStart ? [`Or ${optIn}.`] : []),
      "No keys were saved to a file.",
    ].join(" "),
  });
const mismatch = (requested: KeyStorage, kept: KeyStorage) =>
  new LocalConfigurationError({
    reason: "misconfigured",
    message: `This directory keeps its keys in ${kept === "file" ? "keys.json" : "the OS credential store"}, so EXECUTOR_KEY_STORAGE=${requested} cannot apply. Executor never switches key storage or moves keys. Unset EXECUTOR_KEY_STORAGE, or use a new EXECUTOR_DATA_DIR. Nothing was changed.`,
  });

/**
 * Why the OS credential store could not be used, as reported by @napi-rs/keyring 2.1.0.
 *
 * Its errors carry no native code, only keyring-core text ("Platform failure: …" or
 * "Couldn't access platform storage: …"), and macOS detail text is localized. So only
 * these count as an absent store:
 * - the native module cannot load, or `new AsyncEntry` throws. Only the Linux Secret
 *   Service store does work there: it connects to the D-Bus session bus and opens a
 *   Secret Service session, so a missing bus or provider fails at construction.
 * - Windows ERROR_NO_SUCH_LOGON_SESSION: the logon session has no credential vault,
 *   as for a service or an SSH logon.
 * Every other failure is treated as denied and retryable: a cancelled macOS prompt
 * (-128), failed authentication or a locked keychain; a locked Linux collection or a
 * dismissed unlock prompt; and any error that cannot be identified.
 */
type StoreFailure = { readonly kind: "absent" | "denied"; readonly reason: string };
const absent = (error: unknown): StoreFailure => ({ kind: "absent", reason: detail(error) });
const classify =
  (platform: string) =>
  (error: unknown): StoreFailure => ({
    kind:
      platform === "win32" &&
      error instanceof Error &&
      error.message.includes("ERROR_NO_SUCH_LOGON_SESSION")
        ? "absent"
        : "denied",
    reason: detail(error),
  });
const invalid = () =>
  new LocalConfigurationError({
    reason: "invalid",
    message:
      "Executor's saved key or installation record is invalid. Restore the original OS credential or key file and installation.json from your backup. Keys have not been replaced.",
  });

/** One message for an unusable key file; the reason says whether it is gone, unreadable or damaged. */
const keyFileUnusable = (
  keyFile: string,
  error: PlatformError.PlatformError | Schema.SchemaError,
) =>
  new LocalConfigurationError({
    reason:
      error._tag === "SchemaError"
        ? "invalid"
        : error.reason._tag === "NotFound"
          ? "credential-missing"
          : "io",
    message: `Executor's key file ${keyFile} is missing or invalid. Restore it from your backup. Keys have not been replaced.`,
  });

const randomKey = () =>
  Redacted.make(Encoding.encodeHex(crypto.getRandomValues(new Uint8Array(32))));

/** Hold the directory's bootstrap lock for the current scope. */
const lockDirectory = (directory: string, message: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          lock(directory, { retries: 0, lockfilePath: path.join(directory, ".bootstrap.lock") }),
        catch: () => new LocalConfigurationError({ reason: "locked", message }),
      }),
      (unlock) => Effect.promise(() => unlock()),
    );
  });

/** Stage, fsync and atomically rename so an interrupted write never leaves a partial file. */
const writeAtomically = (
  platform: string,
  directory: string,
  destination: string,
  contents: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporary = yield* fs.makeTempDirectoryScoped({
        directory,
        prefix: ".bootstrap-",
      });
      const staged = path.join(temporary, path.basename(destination));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(staged, { flag: "wx", mode: 0o600 });
          yield* file.writeAll(new TextEncoder().encode(contents));
          yield* file.sync;
        }),
      );
      // The create mode is masked by umask; set it explicitly as v1 did.
      yield* fs.chmod(staged, 0o600);
      yield* fs.rename(staged, destination);
      // Windows does not allow opening directories as ordinary file handles.
      if (platform !== "win32") {
        const parent = yield* fs.open(directory);
        yield* parent.sync;
      }
    }),
  );

/** One installation's OS credential. Construction failures mean the store is absent. */
const credentialEntry = (id: string) =>
  Effect.gen(function* () {
    const { AsyncEntry } = yield* Effect.tryPromise({
      try: () => import("@napi-rs/keyring"),
      catch: absent,
    });
    return yield* Effect.try({
      try: () =>
        new AsyncEntry(LocalCredentialService, id, {
          linux: { store: "secret-service" },
        }),
      catch: absent,
    });
  });

/** Resolve one profile's keys. Existing data never causes a new credential to be generated. */
export const localConfiguration = (platform: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* ConfigProvider.ConfigProvider;
      // Read before touching the directory, so an invalid value changes nothing.
      const keyStorage = yield* keyStorageConfig.pipe(
        Effect.mapError(
          () =>
            new LocalConfigurationError({
              reason: "misconfigured",
              message:
                'EXECUTOR_KEY_STORAGE must be "file" (keep keys in keys.json) or "os" (OS credential store only), or unset. Nothing was changed.',
            }),
        ),
      );
      const directory = path.resolve(
        yield* Config.String("EXECUTOR_DATA_DIR").pipe(Config.withDefault(".local/executor")),
      );
      const marker = path.join(directory, "installation.json");
      const explicitApi = yield* Config.Redacted("EXECUTOR_API_KEY").pipe(Config.option);
      const explicitEncryption = yield* Config.Redacted("EXECUTOR_ENCRYPTION_KEY").pipe(
        Config.option,
      );

      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      yield* lockDirectory(
        directory,
        "Executor could not lock its data directory. Start one instance per directory.",
      );

      const databases = yield* Effect.forEach(
        ["executor.pglite", "browser-auth.pglite", "mcp-auth.pglite"],
        (name) => fs.exists(path.join(directory, name)),
      );
      const existing = databases.some(Boolean);
      const savedMarker = yield* fs.exists(marker);
      const explicit = Option.isSome(explicitApi) || Option.isSome(explicitEncryption);
      if (!explicit && !savedMarker && existing)
        return yield* new LocalConfigurationError({
          reason: "credential-missing",
          message:
            "Existing Executor data has no installation record. Supply its original EXECUTOR_API_KEY and EXECUTOR_ENCRYPTION_KEY, or restore installation.json and its matching OS credential or key file. No new keys were created.",
        });
      const installation = savedMarker
        ? yield* fs
            .readFileString(marker)
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Installation))),
              Effect.mapError(invalid),
            )
        : Installation.make({
            version: 1,
            id: crypto.randomUUID(),
            state: explicit ? "external" : "pending",
          });

      const keyFile = path.join(directory, "keys.json");

      const writeFile = (destination: string, contents: string) =>
        writeAtomically(platform, directory, destination, contents);
      const writeMarker = (state: typeof Installation.Type.state) =>
        writeFile(marker, JSON.stringify({ ...installation, state }));
      const configure = (keys: typeof Keys.Type) =>
        config.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              EXECUTOR_DATA_DIR: directory,
              EXECUTOR_API_KEY: Redacted.value(keys.apiKey),
              EXECUTOR_ENCRYPTION_KEY: Redacted.value(keys.encryptionKey),
            }).pipe(ConfigProvider.orElse(base)),
          ),
        );
      if (explicit) {
        if (Option.isSome(keyStorage))
          return yield* new LocalConfigurationError({
            reason: "misconfigured",
            message:
              "Supplied EXECUTOR_API_KEY and EXECUTOR_ENCRYPTION_KEY are never stored, so EXECUTOR_KEY_STORAGE cannot apply. Unset one or the other.",
          });
        if (Option.isNone(explicitApi) || Option.isNone(explicitEncryption))
          return yield* new LocalConfigurationError({
            reason: "misconfigured",
            message:
              "Supply both EXECUTOR_API_KEY and EXECUTOR_ENCRYPTION_KEY, or leave both unset to use the OS credential store.",
          });
        if (installation.state !== "external")
          return yield* new LocalConfigurationError({
            reason: "misconfigured",
            message: `This directory uses ${installation.state === "file" ? "its key file" : "the OS credential store"}. Unset EXECUTOR_API_KEY and EXECUTOR_ENCRYPTION_KEY to use its saved keys. Changing key storage requires an explicit transfer.`,
          });
        const settings = yield* config;
        if (!savedMarker) yield* writeMarker("external");
        return settings;
      }
      if (installation.state === "external")
        return yield* new LocalConfigurationError({
          reason: "credential-missing",
          message:
            "This directory uses supplied keys. Set its original EXECUTOR_API_KEY and EXECUTOR_ENCRYPTION_KEY. No replacement keys were created.",
        });
      const readKeyFile = fs.readFileString(keyFile).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Keys))),
        Effect.mapError((error) => keyFileUnusable(keyFile, error)),
      );
      // Only a directory that has never held keys may choose the key file. Once a
      // record says "ready" or data exists, the credential store stays mandatory.
      const firstStart = installation.state === "pending" && !existing;
      // A first start interrupted after saving its key file finishes in file mode
      // with those keys; the bootstrap lock keeps this check and the write exclusive.
      const interrupted = firstStart && (yield* fs.exists(keyFile));
      const kept: KeyStorage | undefined =
        installation.state === "file" || interrupted ? "file" : firstStart ? undefined : "os";
      if (Option.isSome(keyStorage) && kept !== undefined && keyStorage.value !== kept)
        return yield* mismatch(keyStorage.value, kept);
      if (installation.state === "file") return yield* configure(yield* readKeyFile);
      if (!savedMarker) yield* writeMarker("pending");
      if (interrupted) {
        const keys = yield* readKeyFile;
        yield* writeMarker("file");
        return yield* configure(keys);
      }

      const generated = () => Keys.make({ apiKey: randomKey(), encryptionKey: randomKey() });
      const saveKeyFile = (notice: string) =>
        Effect.gen(function* () {
          const keys = generated();
          yield* writeFile(keyFile, yield* Schema.encodeEffect(Schema.fromJsonString(Keys))(keys));
          yield* writeMarker("file");
          // stdout is the desktop readiness protocol; this notice belongs on stderr.
          yield* Console.error(`${notice}${keyFile}`);
          return yield* configure(keys);
        });
      if (Option.contains(keyStorage, "file"))
        return yield* saveKeyFile("EXECUTOR_KEY_STORAGE=file; keys saved to ");
      // Denied access leaves the pending record and no key file, so the next start
      // prompts again and can still fall back if the store turns out to be absent.
      const storeFailed = (failure: StoreFailure) =>
        failure.kind === "denied"
          ? Effect.fail(denied(failure.reason, platform, firstStart))
          : firstStart && Option.isNone(keyStorage)
            ? saveKeyFile("OS credential store not found; keys saved to ")
            : Effect.fail(unavailable(failure.reason, firstStart));

      const store = yield* Effect.gen(function* () {
        const entry = yield* credentialEntry(installation.id);
        const stored = yield* Effect.tryPromise({
          try: (signal) => entry.getPassword(signal),
          catch: classify(platform),
        });
        return { entry, stored };
      }).pipe(Effect.result);
      if (Result.isFailure(store)) return yield* storeFailed(store.failure);
      const { entry, stored } = store.success;
      if (stored !== undefined && stored !== null) {
        const keys = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Keys))(stored).pipe(
          Effect.mapError(invalid),
        );
        if (installation.state === "pending") yield* writeMarker("ready");
        return yield* configure(keys);
      }
      if (!firstStart)
        return yield* new LocalConfigurationError({
          reason: "credential-missing",
          message:
            "Executor's OS credential is missing for an existing installation. Restore that credential from your backup. It has not been replaced.",
        });
      const keys = generated();
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Keys))(keys);
      const saved = yield* Effect.tryPromise({
        try: (signal) => entry.setPassword(encoded, signal),
        catch: classify(platform),
      }).pipe(Effect.result);
      if (Result.isFailure(saved)) return yield* storeFailed(saved.failure);
      yield* writeMarker("ready");
      return yield* configure(keys);
    }),
  ).pipe(
    Effect.catchTag("PlatformError", () =>
      Effect.fail(
        new LocalConfigurationError({
          reason: "io",
          message:
            "Executor could not read or write its installation record. Check the data directory permissions and available disk space. Existing keys have not been replaced.",
        }),
      ),
    ),
  );

/**
 * Read one directory's saved keys for a client of its running server, such as `executor pair`.
 * Unlike `localConfiguration` it never creates the directory, an installation record or keys, and
 * takes no lock: the server holds none once started, and nothing here is written.
 */
export const savedConfiguration = (platform: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* ConfigProvider.ConfigProvider;
    const directory = path.resolve(
      yield* Config.String("EXECUTOR_DATA_DIR").pipe(Config.withDefault(".local/executor")),
    );
    const explicitApi = yield* Config.Redacted("EXECUTOR_API_KEY").pipe(Config.option);
    const explicitEncryption = yield* Config.Redacted("EXECUTOR_ENCRYPTION_KEY").pipe(
      Config.option,
    );
    if (Option.isSome(explicitApi) !== Option.isSome(explicitEncryption))
      return yield* new LocalConfigurationError({
        reason: "misconfigured",
        message:
          "Supply both EXECUTOR_API_KEY and EXECUTOR_ENCRYPTION_KEY, or leave both unset to use the saved keys.",
      });
    if (Option.isSome(explicitApi)) return yield* config;
    const marker = path.join(directory, "installation.json");
    const installation = (yield* fs.exists(marker))
      ? yield* fs
          .readFileString(marker)
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Installation))),
            Effect.mapError(invalid),
          )
      : undefined;
    if (installation === undefined || installation.state === "pending")
      return yield* new LocalConfigurationError({
        reason: "credential-missing",
        message: `${directory} has no saved keys. Start Executor first, or set EXECUTOR_DATA_DIR to the folder the running server uses. No new keys were created.`,
      });
    if (installation.state === "external")
      return yield* new LocalConfigurationError({
        reason: "credential-missing",
        message:
          "This directory uses supplied keys. Set its original EXECUTOR_API_KEY and EXECUTOR_ENCRYPTION_KEY. No replacement keys were created.",
      });
    const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Keys));
    const keyFile = path.join(directory, "keys.json");
    const keys =
      installation.state === "file"
        ? yield* fs.readFileString(keyFile).pipe(
            Effect.flatMap(decode),
            Effect.mapError((error) => keyFileUnusable(keyFile, error)),
          )
        : yield* credentialEntry(installation.id).pipe(
            Effect.flatMap((entry) =>
              Effect.tryPromise({
                try: (signal) => entry.getPassword(signal),
                catch: classify(platform),
              }),
            ),
            Effect.mapError((failure) =>
              failure.kind === "denied"
                ? new LocalConfigurationError({
                    reason: "credential-denied",
                    message: `Access to the OS credential store was denied, or the store is locked (${failure.reason}). Allow access or unlock the store, then try again. Nothing was changed.`,
                  })
                : unavailable(failure.reason, false),
            ),
            Effect.flatMap((stored) =>
              stored === undefined || stored === null
                ? Effect.fail(
                    new LocalConfigurationError({
                      reason: "credential-missing",
                      message:
                        "Executor's OS credential is missing for an existing installation. Restore that credential from your backup. It has not been replaced.",
                    }),
                  )
                : decode(stored).pipe(Effect.mapError(invalid)),
            ),
          );
    return yield* config.pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          EXECUTOR_DATA_DIR: directory,
          EXECUTOR_API_KEY: Redacted.value(keys.apiKey),
          EXECUTOR_ENCRYPTION_KEY: Redacted.value(keys.encryptionKey),
        }).pipe(ConfigProvider.orElse(base)),
      ),
    );
  }).pipe(
    Effect.catchTag("PlatformError", () =>
      Effect.fail(
        new LocalConfigurationError({
          reason: "io",
          message:
            "Executor could not check for its installation record. Check the data directory permissions. Nothing was changed.",
        }),
      ),
    ),
  );

const unchanged = (reason: LocalConfigurationReason, message: string) =>
  new LocalConfigurationError({ reason, message: `${message} The API key was not changed.` });

/**
 * Replace one directory's saved API key where it is kept, in the OS credential store or
 * keys.json. The encryption key is retained, so saved accounts and MCP sign-ins still decrypt.
 * The bootstrap lock serializes this with a starting server. A running server keeps its current key
 * until it restarts; its next start also updates the managed Executor account.
 */
export const rotateApiKey = (platform: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = path.resolve(
        yield* Config.String("EXECUTOR_DATA_DIR").pipe(Config.withDefault(".local/executor")),
      );
      const explicitApi = yield* Config.Redacted("EXECUTOR_API_KEY").pipe(Config.option);
      const explicitEncryption = yield* Config.Redacted("EXECUTOR_ENCRYPTION_KEY").pipe(
        Config.option,
      );
      if (Option.isSome(explicitApi) || Option.isSome(explicitEncryption))
        return yield* unchanged(
          "misconfigured",
          "Supplied EXECUTOR_API_KEY and EXECUTOR_ENCRYPTION_KEY are never stored. Change EXECUTOR_API_KEY where you set it.",
        );
      const marker = path.join(directory, "installation.json");
      if (!(yield* fs.exists(marker)))
        return yield* unchanged(
          "credential-missing",
          "This directory has no saved keys. Start Executor once to create them.",
        );
      yield* lockDirectory(
        directory,
        "Executor is starting with this data directory. Try again once it has started. The API key was not changed.",
      );
      const installation = yield* fs
        .readFileString(marker)
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Installation))),
          Effect.mapError(invalid),
        );
      const encode = Schema.encodeEffect(Schema.fromJsonString(Keys));
      const rotated = (keys: typeof Keys.Type) =>
        Keys.make({ apiKey: randomKey(), encryptionKey: keys.encryptionKey });
      switch (installation.state) {
        case "external":
          return yield* unchanged(
            "misconfigured",
            "This directory uses supplied keys, which Executor never stores. Change EXECUTOR_API_KEY where you set it.",
          );
        case "pending":
          return yield* unchanged(
            "credential-missing",
            "This directory has not finished its first start. Start Executor once to create its keys.",
          );
        case "file": {
          const keyFile = path.join(directory, "keys.json");
          const keys = yield* fs.readFileString(keyFile).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Keys))),
            Effect.mapError((error) => keyFileUnusable(keyFile, error)),
          );
          yield* writeAtomically(platform, directory, keyFile, yield* encode(rotated(keys)));
          return;
        }
        case "ready": {
          const storeFailed = (failure: StoreFailure) =>
            failure.kind === "denied"
              ? unchanged(
                  "credential-denied",
                  `Access to the OS credential store was denied, or the store is locked (${failure.reason}). Allow access or unlock the store, then try again.`,
                )
              : unavailable(failure.reason, false);
          const entry = yield* credentialEntry(installation.id).pipe(Effect.mapError(storeFailed));
          const stored = yield* Effect.tryPromise({
            try: (signal) => entry.getPassword(signal),
            catch: classify(platform),
          }).pipe(Effect.mapError(storeFailed));
          if (stored === undefined || stored === null)
            return yield* new LocalConfigurationError({
              reason: "credential-missing",
              message:
                "Executor's OS credential is missing for an existing installation. Restore that credential from your backup. It has not been replaced.",
            });
          const keys = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Keys))(stored).pipe(
            Effect.mapError(invalid),
          );
          const encoded = yield* encode(rotated(keys));
          yield* Effect.tryPromise({
            try: (signal) => entry.setPassword(encoded, signal),
            catch: classify(platform),
          }).pipe(Effect.mapError(storeFailed));
          return;
        }
      }
    }),
  ).pipe(
    Effect.catchTag("PlatformError", () =>
      Effect.fail(
        unchanged(
          "io",
          "Executor could not read or write its installation record or key file. Check the data directory permissions and available disk space.",
        ),
      ),
    ),
  );
