/**
 * Per-checkout state for zero-configuration cloud development.
 *
 * Each checkout gets its own Alchemy stage, so a rift never adopts the Postgres container or
 * Worker storage recorded in state copied from another checkout. Secrets and the emulator
 * instance persist under `.local/cloud-dev/<stage>/`; ports are allocated on every run and
 * appear only in the running session file, which the launcher removes on exit.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, FileSystem, Schema } from "effect";
import { checkoutLabel } from "../../../../scripts/dev-host.ts";

const repositoryRoot = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));

/** `dev` in the canonical checkout and `dev-<checkout>` in a rift; never the 1Password `development` stage. */
export const localDevelopmentStage = (() => {
  const label = checkoutLabel();
  return label === undefined ? "dev" : `dev-${label}`;
})();

export const localDevelopmentDirectory = join(
  repositoryRoot,
  ".local",
  "cloud-dev",
  localDevelopmentStage,
);

export const localDevelopmentFiles = {
  secrets: join(localDevelopmentDirectory, "secrets.json"),
  emulators: join(localDevelopmentDirectory, "emulators.json"),
  session: join(localDevelopmentDirectory, "session.json"),
  alchemyHome: join(localDevelopmentDirectory, "alchemy-home"),
} as const;

const Hex64 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

/** Generated once per checkout; the database volume and encrypted records depend on them. */
export const LocalSecrets = Schema.Struct({
  version: Schema.Literal(1),
  betterAuthSecret: Hex64,
  encryptionKey: Hex64,
  databasePassword: Hex64,
});

const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

/** Written while the launcher runs so local tools can reach this checkout's stack. */
export const LocalSession = Schema.Struct({
  pid: Schema.Int,
  origin: Schema.String,
  apiPort: Port,
  databasePort: Port,
});

export class LocalDevelopmentUnavailable extends Schema.TaggedError<LocalDevelopmentUnavailable>()(
  "LocalDevelopmentUnavailable",
  { reason: Schema.String },
) {
  get message() {
    return this.reason;
  }
}

const readFile = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file);
  });

export const readLocalSecrets = readFile(localDevelopmentFiles.secrets).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(LocalSecrets))),
  Effect.mapError(
    () =>
      new LocalDevelopmentUnavailable({
        reason: `No cloud dev secrets for this checkout; run bun run hosted:cloud:dev once`,
      }),
  ),
);

const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The running stack for this checkout, or a clear failure when it is not running. */
export const readLocalSession = readFile(localDevelopmentFiles.session).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(LocalSession))),
  Effect.filterOrFail(
    (session) => running(session.pid),
    () => new Error("Stale cloud dev session"),
  ),
  Effect.mapError(
    () =>
      new LocalDevelopmentUnavailable({
        reason: `Cloud dev is not running in this checkout; start bun run hosted:cloud:dev`,
      }),
  ),
);
