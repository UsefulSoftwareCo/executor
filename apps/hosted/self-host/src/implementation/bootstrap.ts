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
import { dataDirectory } from "../contracts/config.ts";

/** Startup failures contain instructions, never secret values or parser input. */
class BootstrapError extends Schema.TaggedError<BootstrapError>()("SelfHostBootstrapError", {
  message: Schema.String,
}) {}

const sessionSecret = Schema.String.check(Schema.isMinLength(32));
const encryptionKey = Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{64}$/));

/** Resolve self-host defaults before opening the database or starting diagnostics. */
export const selfHostConfiguration = Effect.scoped(
  Effect.gen(function* () {
    const base = yield* ConfigProvider.ConfigProvider;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.resolve(yield* dataDirectory);
    const explicitOrigin = yield* Config.String("BETTER_AUTH_URL").pipe(Config.option);
    const railwayDomain = yield* Config.String("RAILWAY_PUBLIC_DOMAIN").pipe(Config.option);
    const port = yield* Config.Number("PORT").pipe(Config.withDefault(4400));
    let origin: string;
    if (Option.isSome(explicitOrigin)) origin = explicitOrigin.value;
    else if (Option.isSome(railwayDomain)) {
      if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(railwayDomain.value))
        return yield* new BootstrapError({
          message:
            "RAILWAY_PUBLIC_DOMAIN must be a hostname. Set BETTER_AUTH_URL to use another public origin.",
        });
      origin = `https://${railwayDomain.value}`;
    } else origin = `http://localhost:${port}`;
    const parsedOrigin = URL.parse(origin);
    if (
      parsedOrigin === null ||
      !["http:", "https:"].includes(parsedOrigin.protocol) ||
      parsedOrigin.origin !== origin
    )
      return yield* new BootstrapError({
        message: "BETTER_AUTH_URL must be an HTTP(S) origin without a trailing slash.",
      });

    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    // Serialize first-boot key creation; the database separately owns the lifetime lock.
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          lock(directory, { retries: 0, lockfilePath: path.join(directory, ".bootstrap.lock") }),
        catch: () =>
          new BootstrapError({
            message: "Cannot lock the self-host data directory. Run one instance per volume.",
          }),
      }),
      (unlock) => Effect.promise(() => unlock()),
    );
    const existingDatabase = yield* fs.exists(path.join(directory, "hosted.pglite"));
    const resolveSecret = (variable: string, filename: string, schema: typeof sessionSecret) =>
      Effect.gen(function* () {
        const explicit = yield* Config.Redacted(variable).pipe(Config.option);
        if (Option.isSome(explicit)) {
          yield* Schema.decodeUnknownEffect(schema)(Redacted.value(explicit.value)).pipe(
            Effect.mapError(
              () =>
                new BootstrapError({
                  message: `${variable} is invalid. Supply a session secret of at least 32 characters and an encryption key of exactly 64 hexadecimal characters.`,
                }),
            ),
          );
          return explicit.value;
        }
        const destination = path.join(directory, filename);
        if (yield* fs.exists(destination)) {
          const value = yield* fs.readFileString(destination);
          const parsed = yield* Schema.decodeUnknownEffect(schema)(value).pipe(
            Effect.mapError(
              () =>
                new BootstrapError({
                  message: `Saved ${variable} is invalid. Restore its original file from a backup or set the original value in the environment.`,
                }),
            ),
          );
          yield* fs.chmod(destination, 0o600);
          return Redacted.make(parsed);
        }
        if (existingDatabase)
          return yield* new BootstrapError({
            message: `${variable} is missing for an existing database. Restore its original file from a backup or set the original value in the environment.`,
          });
        const generated = Encoding.encodeHex(crypto.getRandomValues(new Uint8Array(32)));
        const temporary = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".bootstrap-" });
        const staged = path.join(temporary, filename);
        const file = yield* fs.open(staged, { flag: "wx", mode: 0o600 });
        yield* file.writeAll(new TextEncoder().encode(generated));
        yield* file.sync;
        yield* fs.rename(staged, destination);
        const parent = yield* fs.open(directory);
        yield* parent.sync;
        return Redacted.make(generated);
      });
    const secret = yield* resolveSecret("BETTER_AUTH_SECRET", "auth-secret.key", sessionSecret);
    const key = yield* resolveSecret("EXECUTOR_ENCRYPTION_KEY", "encryption.key", encryptionKey);
    return ConfigProvider.fromUnknown({
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: Redacted.value(secret),
      EXECUTOR_ENCRYPTION_KEY: Redacted.value(key),
    }).pipe(ConfigProvider.orElse(base));
  }),
).pipe(
  Effect.catchTag("PlatformError", () =>
    Effect.fail(
      new BootstrapError({
        message:
          "Cannot read or write the self-host data directory. Mount a writable persistent volume at EXECUTOR_DATA_DIR (Docker: /app/data).",
      }),
    ),
  ),
);
