/** Persist first-install keys in the OS credential store before opening local storage. */
import {
  Config,
  ConfigProvider,
  Effect,
  Encoding,
  FileSystem,
  Option,
  Path,
  Redacted,
  Schema,
} from "effect";
import { lock } from "proper-lockfile";
import { config } from "../contracts/config.ts";

/** Safe startup instructions. Native credential errors and key values are never displayed. */
export class LocalConfigurationError extends Schema.TaggedError<LocalConfigurationError>()(
  "LocalConfigurationError",
  {
    message: Schema.String,
  },
) {}

const Installation = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String.check(Schema.isUUID()),
  state: Schema.Literals(["pending", "ready", "external"]),
});
const Keys = Schema.Struct({
  apiKey: Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(32))),
  encryptionKey: Schema.RedactedFromValue(
    Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{64}$/)),
  ),
});
const unavailable = () =>
  new LocalConfigurationError({
    message:
      "The OS credential store could not be opened. Unlock it and allow Executor access. On Linux, start a Secret Service such as GNOME Keyring. Headless installs can supply both EXECUTOR_API_KEY and EXECUTOR_ENCRYPTION_KEY before the first start.",
  });
const invalid = () =>
  new LocalConfigurationError({
    message:
      "Executor's saved key or installation record is invalid. Restore the original OS credential and installation.json from your backup. Keys have not been replaced.",
  });

/** Resolve one profile's keys. Existing data never causes a new credential to be generated. */
export const localConfiguration = (platform: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* ConfigProvider.ConfigProvider;
      const directory = path.resolve(
        yield* Config.String("EXECUTOR_DATA_DIR").pipe(Config.withDefault(".local/executor")),
      );
      const marker = path.join(directory, "installation.json");
      const explicitApi = yield* Config.Redacted("EXECUTOR_API_KEY").pipe(Config.option);
      const explicitEncryption = yield* Config.Redacted("EXECUTOR_ENCRYPTION_KEY").pipe(
        Config.option,
      );

      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            lock(directory, { retries: 0, lockfilePath: path.join(directory, ".bootstrap.lock") }),
          catch: () =>
            new LocalConfigurationError({
              message:
                "Executor could not lock its data directory. Start one instance per directory.",
            }),
        }),
        (unlock) => Effect.promise(() => unlock()),
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
          message:
            "Existing Executor data has no OS credential record. Supply its original EXECUTOR_API_KEY and EXECUTOR_ENCRYPTION_KEY, or restore installation.json and its matching credential. No new keys were created.",
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

      const writeMarker = (state: typeof Installation.Type.state) =>
        Effect.scoped(
          Effect.gen(function* () {
            const temporary = yield* fs.makeTempDirectoryScoped({
              directory,
              prefix: ".bootstrap-",
            });
            const staged = path.join(temporary, "installation.json");
            yield* Effect.scoped(
              Effect.gen(function* () {
                const file = yield* fs.open(staged, { flag: "wx", mode: 0o600 });
                yield* file.writeAll(
                  new TextEncoder().encode(JSON.stringify({ ...installation, state })),
                );
                yield* file.sync;
              }),
            );
            yield* fs.rename(staged, marker);
            // Windows does not allow opening directories as ordinary file handles.
            if (platform !== "win32") {
              const parent = yield* fs.open(directory);
              yield* parent.sync;
            }
          }),
        );
      if (explicit) {
        if (Option.isNone(explicitApi) || Option.isNone(explicitEncryption))
          return yield* new LocalConfigurationError({
            message:
              "Supply both EXECUTOR_API_KEY and EXECUTOR_ENCRYPTION_KEY, or leave both unset to use the OS credential store.",
          });
        if (installation.state !== "external")
          return yield* new LocalConfigurationError({
            message:
              "This directory uses the OS credential store. Unset EXECUTOR_API_KEY and EXECUTOR_ENCRYPTION_KEY to use its saved keys. Changing key storage requires an explicit transfer.",
          });
        const settings = yield* config;
        if (!savedMarker) yield* writeMarker("external");
        return settings;
      }
      if (installation.state === "external")
        return yield* new LocalConfigurationError({
          message:
            "This directory uses supplied keys. Set its original EXECUTOR_API_KEY and EXECUTOR_ENCRYPTION_KEY. No replacement keys were created.",
        });
      if (!savedMarker) yield* writeMarker("pending");

      const { AsyncEntry } = yield* Effect.tryPromise({
        try: () => import("@napi-rs/keyring"),
        catch: unavailable,
      });
      const entry = yield* Effect.try({
        try: () =>
          new AsyncEntry("com.usefulsoftware.executor.v2", installation.id, {
            linux: { store: "secret-service" },
          }),
        catch: unavailable,
      });
      const stored = yield* Effect.tryPromise({
        try: (signal) => entry.getPassword(signal),
        catch: unavailable,
      });
      let keys: typeof Keys.Type;
      if (stored === undefined || stored === null) {
        if (existing || installation.state === "ready")
          return yield* new LocalConfigurationError({
            message:
              "Executor's OS credential is missing for an existing installation. Restore that credential from your backup. It has not been replaced.",
          });
        const randomKey = () =>
          Redacted.make(Encoding.encodeHex(crypto.getRandomValues(new Uint8Array(32))));
        keys = Keys.make({ apiKey: randomKey(), encryptionKey: randomKey() });
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Keys))(keys);
        yield* Effect.tryPromise({
          try: (signal) => entry.setPassword(encoded, signal),
          catch: unavailable,
        });
      } else {
        keys = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Keys))(stored).pipe(
          Effect.mapError(invalid),
        );
      }
      if (installation.state === "pending") yield* writeMarker("ready");
      const provider = ConfigProvider.fromUnknown({
        EXECUTOR_DATA_DIR: directory,
        EXECUTOR_API_KEY: Redacted.value(keys.apiKey),
        EXECUTOR_ENCRYPTION_KEY: Redacted.value(keys.encryptionKey),
      }).pipe(ConfigProvider.orElse(base));
      return yield* config.pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider));
    }),
  ).pipe(
    Effect.catchTag("PlatformError", () =>
      Effect.fail(
        new LocalConfigurationError({
          message:
            "Executor could not read or write its installation record. Check the data directory permissions and available disk space. Existing keys have not been replaced.",
        }),
      ),
    ),
  );
