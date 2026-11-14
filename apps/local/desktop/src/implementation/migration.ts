/**
 * One-off move of the desktop app's own data directory into the data directory the CLI uses, so
 * the desktop and the CLI share one background Executor. It runs before the desktop starts or
 * joins the background service.
 *
 * Invariants:
 * - Progress is recorded in `migration.json` beside the legacy directory, written atomically
 *   before each step that changes files. An interrupted run continues on the next launch; once the
 *   record says `done`, later launches change no data. The record then only notes when the notice
 *   naming the CLI data or settings a move set aside has been shown, so a launch that ends first,
 *   as when it is quit while the data moves, does not lose it.
 * - Only a legacy directory with a database moves. One without, such as a desktop that failed
 *   before its first start finished, is recorded as done and the shared directory is left alone.
 * - Nothing is merged and no user data is deleted. Whole directories are only renamed into the
 *   backups folder. The things ever removed are this migration's own copy, named in its record
 *   before it was made, when it is unfinished or rolled back before it was verified; its own lock
 *   directories; and a shared directory or archive that holds nothing else. The one file written
 *   into the copy is `service.json`: the CLI's settings with the desktop's port (see
 *   `sharedSettings`), written again before each attempt to rename the copy into place; the CLI's
 *   own stays in its archive.
 * - The copy's root is 0700, as the CLI creates a data directory, and so is the shared directory
 *   once the copy is in place.
 * - Keys are never generated, rewritten or stored. `installation.json` is copied byte for byte, so
 *   the OS credential entry keyed by its installation ID, or the copied `keys.json`, still holds the
 *   keys for the moved data.
 * - The copy is complete before anything moves: every entry's relative path, type and size, and the
 *   bytes of `installation.json` and `keys.json`, match the source, and every file is synced.
 * - Nothing is copied or moved while a server, its key setup or its telemetry collector uses either
 *   directory. The shared directory is created first if needed, so it is always locked, and both
 *   directories' locks are held from before the copy until after the renames. A lock is a
 *   directory and holds no handle, so the renames work while it is held, also on Windows. Once a
 *   directory has moved, its locks no longer touch its old path, and the lock directories that
 *   moved with it are removed from where it went. A lock lost before its directory moved, as to a
 *   process that took it over, stops the copy at once, and no rename runs without its lock: the
 *   move fails and rolls back as any failure does.
 *
 * No file under a data directory needs rewriting for its new location. Storage, builds, workerd
 * state and repositories are found relative to the directory at each start; PGlite records only
 * its own virtual path, `/pglite/data`; the workerd configuration naming absolute paths is passed
 * to workerd at each start, never saved; the repositories are bare and record no paths.
 * `diagnostics/collector.json` names the old absolute path until the next server start rewrites
 * it, and old log lines keep naming it, which is history rather than configuration.
 */
import * as nodeFs from "node:fs";
import { lock, type LockOptions } from "proper-lockfile";
import {
  DateTime,
  Effect,
  FileSystem,
  Option,
  Path,
  type PlatformError,
  Predicate,
  Schedule,
  Schema,
  Stream,
} from "effect";
import {
  defaultPort,
  ServiceFailed,
  serviceLockFile,
  serviceRegistrationFile,
  type ServiceSettings,
  serviceSettingsFile,
} from "../../../server/src/contracts/service.ts";
import { writeAtomically } from "../../../server/src/implementation/atomic-file.ts";
import { stop } from "../../../server/src/implementation/service-client.ts";
import {
  lockDataDirectory,
  readRegistration,
  readSettings,
  writeSettings,
} from "../../../server/src/implementation/service-files.ts";
import { whileHeld } from "./runtime.ts";

/** The migration did not finish. `message` says why, and what was and was not changed. */
export class DesktopMigrationFailed extends Schema.TaggedError<DesktopMigrationFailed>()(
  "DesktopMigrationFailed",
  {
    reason: Schema.Literals([
      /** A server or another program uses either directory. */
      "in-use",
      /** The CLI's background server did not stop. */
      "stop-failed",
      /** The copy could not be written. */
      "copy-failed",
      /** The copy did not match the desktop data. */
      "verify-failed",
      /** The CLI's data is on another volume than the backups folder. */
      "cross-volume",
      /** A rename failed for another reason. */
      "move-failed",
      /** The migration record could not be read or saved. */
      "record-failed",
      /** An unfinished migration was recorded for other directories. */
      "unfinished",
      /** The directories contain one another. */
      "overlapping",
    ]),
    message: Schema.String,
  },
) {}

const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

/**
 * The CLI's `service.json` settings that the shared directory's no longer has as they were. Its
 * port follows the desktop's data: `port` is the CLI's, `from`, and the desktop's, `to`, when they
 * differ. `variables` are the `env` names that belong to the CLI's data, its port and keys, so they
 * stay only in the archived `service.json`. Names only, since a value may be a key. `removed` are
 * the settings the move turned off: `disabled`, since the desktop always runs the background
 * server, which a disabled service's commands would find holding the data. Every other setting is
 * carried over.
 */
const SettingsChanges = Schema.Struct({
  port: Schema.optionalKey(Schema.Struct({ from: Port, to: Port })),
  variables: Schema.optionalKey(Schema.Array(Schema.String)),
  removed: Schema.optionalKey(Schema.Array(Schema.Literal("disabled"))),
});
type SettingsChanges = typeof SettingsChanges.Type;

/**
 * What the migration did. `moved`: the shared directory held no data. `replaced`: it held the
 * CLI's data, now in `archived`. `backup` is the legacy directory's new place; absent when it had
 * to stay in place because the backups folder is on another volume. `settings`: what changed of
 * the CLI's settings, which `archived` keeps as they were.
 */
export const DesktopMigration = Schema.Struct({
  kind: Schema.Literals(["none", "moved", "replaced"]),
  archived: Schema.optionalKey(Schema.String),
  backup: Schema.optionalKey(Schema.String),
  settings: Schema.optionalKey(SettingsChanges),
});
export type DesktopMigration = typeof DesktopMigration.Type;

/** `migration.json`. Paths are absolute and chosen once, so a resumed run finds its own work. */
const MigrationRecord = Schema.Struct({
  version: Schema.Literal(1),
  /** `copying`: the copy may be partial. `copied`: it was verified. `done`: nothing is left. */
  state: Schema.Literals(["copying", "copied", "done"]),
  legacy: Schema.String,
  shared: Schema.String,
  /** This migration's copy, beside the shared directory until it is renamed into place. */
  temporary: Schema.String,
  /** Where the legacy directory is renamed to. */
  backup: Schema.String,
  /** Each place the shared directory was renamed to, recorded before its rename. */
  archives: Schema.Array(Schema.String),
  /** The legacy directory could not be renamed into the backups folder, so it stays in place. */
  kept: Schema.Boolean,
  /** The desktop's port, saved in the copy's `service.json`. */
  port: Schema.optionalKey(Port),
  /**
   * How the copy's `service.json` differs from the CLI's, recorded each time it is written, just
   * before the copy is renamed into place, since the CLI's directory may have moved aside by the
   * time the move is done.
   */
  settings: Schema.optionalKey(SettingsChanges),
  result: Schema.optionalKey(DesktopMigration),
  /**
   * Whether the notice naming where a move put the CLI's data, or its changed settings, has been
   * shown; `pending` from when the move is done until the desktop has shown it.
   */
  notice: Schema.optionalKey(Schema.Literals(["pending", "shown"])),
});
type MigrationRecord = typeof MigrationRecord.Type;
const RecordJson = Schema.fromJsonString(MigrationRecord);

const recordFile = "migration.json";
/** Key setup's lock, as `bootstrap.ts` takes it with proper-lockfile's defaults. */
const bootstrapLockFile = ".bootstrap.lock";
/** Held while copying, by this migration; never copied or compared. */
const lockEntries = new Set([serviceLockFile, `${serviceLockFile}.takeover`, bootstrapLockFile]);

const Pid = Schema.Int.check(Schema.isGreaterThan(0));
const RecordedPid = Schema.fromJsonString(Schema.Struct({ pid: Pid }));
const CollectorStatus = Schema.fromJsonString(
  Schema.Struct({
    state: Schema.Literals(["starting", "running", "restarting", "stopped"]),
    pid: Schema.optional(Pid),
  }),
);

/** Whether a Node system error, as a PlatformError's or Effect.try's cause, has one of `codes`. */
const hasCode = (...codes: [string, ...Array<string>]) =>
  Schema.is(Schema.Struct({ cause: Schema.Struct({ code: Schema.Literals(codes) }) }));

/** Signal 0 checks that a process exists; EPERM means it exists under another user. */
const alive = (pid: number) =>
  Effect.try(() => process.kill(pid, 0)).pipe(
    Effect.as(true),
    Effect.catch((error) => Effect.succeed(hasCode("EPERM")(error))),
  );

const failure = (reason: DesktopMigrationFailed["reason"], message: string) =>
  new DesktopMigrationFailed({ reason, message });

const inUse = (directory: string) =>
  failure(
    "in-use",
    `Another Executor server is using ${directory}. Quit it (for the CLI, run \`executor service stop\` or stop it in its terminal), then start Executor again.`,
  );

/** A sortable UTC time and a random suffix, as reset backups are named. */
const stamp = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const random = Array.from(crypto.getRandomValues(new Uint8Array(3)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${DateTime.formatIso(now)
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")}-${random}`;
});

/** The names in `directory`; none when it does not exist. */
const namesIn = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readDirectory(directory).pipe(
      Effect.catchIf(
        (error) => Predicate.isTagged(error.reason, "NotFound"),
        () => Effect.succeed<Array<string>>([]),
      ),
    );
  });

const isDatabase = (name: string) => name.endsWith(".pglite");

/**
 * `env` variables that belong to the data they were set for: its port, and how its keys are kept or
 * supplied. A server would refuse the desktop's data with the CLI's key settings.
 */
const dataVariables = new Set([
  "EXECUTOR_PORT",
  "EXECUTOR_KEY_STORAGE",
  "EXECUTOR_API_KEY",
  "EXECUTOR_ENCRYPTION_KEY",
]);

/**
 * The shared directory's settings once the desktop's data is in it: the CLI's, with the desktop's
 * port, or none for the default, without the `env` variables of the CLI's data, and with the
 * service on. `changes` says what that changed, if anything.
 */
const sharedSettings = (cli: ServiceSettings, port: number | undefined) => {
  const { port: cliPort, env, disabled, ...others } = cli;
  const entries = Object.entries(env ?? {});
  const kept = entries.filter(([name]) => !dataVariables.has(name));
  const variables = entries.flatMap(([name]) => (dataVariables.has(name) ? [name] : []));
  const [from, to] = [cliPort ?? defaultPort, port ?? defaultPort];
  const settings: ServiceSettings = {
    ...others,
    ...(kept.length === 0 ? {} : { env: Object.fromEntries(kept) }),
    ...(port === undefined ? {} : { port }),
  };
  const changes: SettingsChanges | undefined =
    from === to && variables.length === 0 && disabled !== true
      ? undefined
      : {
          ...(from === to ? {} : { port: { from, to } }),
          ...(variables.length === 0 ? {} : { variables }),
          ...(disabled === true ? { removed: ["disabled" as const] } : {}),
        };
  return { settings, changes };
};

/** A data directory holds data once it has an installation record or a database. */
const hasData = (directory: string) =>
  Effect.map(namesIn(directory), (names) =>
    names.some((name) => name === "installation.json" || isDatabase(name)),
  );

type Entry =
  | { readonly kind: "directory"; readonly path: string; readonly mode: number }
  | { readonly kind: "file"; readonly path: string; readonly mode: number; readonly size: bigint }
  | { readonly kind: "link"; readonly path: string; readonly target: string };

/**
 * Every entry under `root` in a stable order, parents before children, except the root-level
 * names `skip` excludes. Symbolic links are listed, never followed. Sockets, FIFOs and devices
 * hold no data and are left out.
 */
const listTree = (root: string, skip: (name: string) => boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries: Array<Entry> = [];
    const visit = (relative: string): Effect.Effect<void, PlatformError.PlatformError> =>
      Effect.gen(function* () {
        const names = (yield* fs.readDirectory(path.join(root, relative))).toSorted();
        for (const name of names) {
          if (relative === "" && skip(name)) continue;
          const child = relative === "" ? name : path.join(relative, name);
          const absolute = path.join(root, child);
          const target = yield* fs.readLink(absolute).pipe(Effect.option);
          if (Option.isSome(target)) {
            entries.push({ kind: "link", path: child, target: target.value });
            continue;
          }
          const info = yield* fs.stat(absolute);
          if (info.type === "Directory") {
            entries.push({ kind: "directory", path: child, mode: info.mode });
            yield* visit(child);
          } else if (info.type === "File")
            entries.push({ kind: "file", path: child, mode: info.mode, size: info.size });
        }
      });
    yield* visit("");
    return entries;
  });

const sameEntries = (left: ReadonlyArray<Entry>, right: ReadonlyArray<Entry>) =>
  left.length === right.length &&
  left.every((entry, index) => {
    const other = right[index];
    if (other === undefined || other.kind !== entry.kind || other.path !== entry.path) return false;
    if (entry.kind === "file" && other.kind === "file") return entry.size === other.size;
    if (entry.kind === "link" && other.kind === "link") return entry.target === other.target;
    return true;
  });

/** Both files are missing, or both hold the same bytes. */
const sameBytes = (left: string, right: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const [hasLeft, hasRight] = [yield* fs.exists(left), yield* fs.exists(right)];
    if (!hasLeft || !hasRight) return hasLeft === hasRight;
    const [a, b] = [yield* fs.readFile(left), yield* fs.readFile(right)];
    return a.length === b.length && a.every((byte, index) => byte === b[index]);
  });

const syncDirectory = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.scoped(Effect.flatMap(fs.open(directory), (handle) => handle.sync));
  });

/** Write a new file with `from`'s bytes and sync it, so a crash never leaves a short copy. */
const copyFile = (from: string, to: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* fs.open(to, { flag: "wx", mode: 0o600 });
      yield* fs
        .stream(from, { chunkSize: 1024 * 1024 })
        .pipe(Stream.runForEach((chunk) => file.writeAll(chunk)));
      yield* file.sync;
    }),
  );

/**
 * Copy `from` to the new directory `to`, leaving out lock directories, with the same modes below
 * the root. The root is 0700, as the CLI creates a data directory: old desktops created theirs with
 * the default mode, often 0755, and only the root keeps other users out of what it holds.
 */
const copyTree = (platform: string, from: string, to: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* listTree(from, (name) => lockEntries.has(name));
    yield* fs.makeDirectory(path.dirname(to), { recursive: true, mode: 0o700 });
    yield* fs.makeDirectory(to, { mode: 0o700 });
    for (const entry of entries) {
      const target = path.join(to, entry.path);
      if (entry.kind === "directory") yield* fs.makeDirectory(target, { mode: 0o700 });
      else if (entry.kind === "link") yield* fs.symlink(entry.target, target);
      else yield* copyFile(path.join(from, entry.path), target);
    }
    // Deepest first, so a read-only directory is set only once its contents are written.
    const all: ReadonlyArray<Entry> = [{ kind: "directory", path: "", mode: 0o700 }, ...entries];
    for (const entry of all.toReversed()) {
      if (entry.kind === "link") continue;
      const target = path.join(to, entry.path);
      yield* fs.chmod(target, entry.mode & 0o777);
      // Windows does not allow opening directories as ordinary file handles.
      if (entry.kind === "directory" && platform !== "win32") yield* syncDirectory(target);
    }
    if (platform !== "win32") yield* syncDirectory(path.dirname(to));
  });

/**
 * Whether `copy` matches `source`: the same entries, file sizes and link targets, and the same
 * `installation.json` and `keys.json` bytes. `service.json` is left out; the copy's holds the shared settings.
 */
const verify = (source: string, copy: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const skip = (name: string) => lockEntries.has(name) || name === serviceSettingsFile;
    const expected = yield* listTree(source, skip);
    const actual = yield* listTree(copy, skip);
    if (!sameEntries(expected, actual)) return false;
    for (const name of ["installation.json", "keys.json"])
      if (!(yield* sameBytes(path.join(source, name), path.join(copy, name)))) return false;
    return true;
  });

/**
 * The file system proper-lockfile uses for the locks held in one directory. Once `moved` runs, as
 * that directory has been renamed, releasing those locks removes nothing: their old paths then
 * belong to the directory renamed into place, which another server may already have locked.
 */
const lockFileSystem = () => {
  let moved = false;
  return {
    fs: {
      ...nodeFs,
      rmdir: (target: nodeFs.PathLike, done: nodeFs.NoParamCallback) =>
        moved ? done(null) : nodeFs.rmdir(target, done),
      rmdirSync: (target: nodeFs.PathLike) => {
        if (!moved) nodeFs.rmdirSync(target);
      },
    },
    moved: Effect.sync(() => {
      moved = true;
    }),
  };
};

/** Hold one lock for the current scope; another holder means the directory is in use. */
const hold = (file: string, options: LockOptions, directory: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      // A lock this migration holds may move with its directory; its refresh then fails quietly.
      try: () => lock(file, { retries: 0, onCompromised: () => {}, ...options }),
      catch: () => inUse(directory),
    }),
    (release) => Effect.promise(() => release().catch(() => undefined)),
  );

/** A directory's locks, as `holdDirectory` holds them. */
interface Held {
  /** Run once the directory has been renamed: its locks then stay where it went. */
  readonly moved: Effect.Effect<void>;
  /** Fails unless its server lock is still held, as after another process took it over. */
  readonly intact: Effect.Effect<void, DesktopMigrationFailed>;
  /** Fails once its server lock is lost. */
  readonly lost: Effect.Effect<never, DesktopMigrationFailed>;
}

/** A directory a resumed run already renamed, so it holds none of its locks. */
const alreadyMoved: Held = { moved: Effect.void, intact: Effect.void, lost: Effect.never };

/**
 * Hold `directory`'s server lock and key setup lock for the current scope, as a server takes them,
 * so no server opens it while it is copied or renamed. The server lock is taken with the servers'
 * own `lockDataDirectory`, recording this process as its owner, so a lock a crashed or killed
 * server left is taken over, and a live server's never is, however long ago it was refreshed; the
 * same rule keeps this one held. Its loss, which only matters until the directory has moved, as
 * its lock then stays where it went, stops the move.
 */
const holdDirectory = (directory: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const locks = lockFileSystem();
    const server = yield* lockDataDirectory(directory, { fs: locks.fs }).pipe(
      Effect.catchTag("ServiceFailed", () => Effect.fail(inUse(directory))),
    );
    yield* hold(
      directory,
      { lockfilePath: path.join(directory, bootstrapLockFile), fs: locks.fs },
      directory,
    );
    const lost = failure(
      "in-use",
      `Another Executor process took over ${directory} while Executor moved its data, so Executor stopped.`,
    );
    return {
      moved: locks.moved,
      intact: Effect.flatMap(server.held, (ours) => (ours ? Effect.void : Effect.fail(lost))),
      lost: server.lost.pipe(Effect.andThen(Effect.fail(lost))),
    } satisfies Held;
  });

/** Remove the lock directories this migration held in `directory` before it was renamed. */
const removeLocks = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const name of lockEntries)
      yield* fs.remove(path.join(directory, name), { recursive: true, force: true });
  });

/**
 * Refuse while a process recorded in `directory` still runs: a server's `server.json`, including
 * the format servers wrote before the background service, or a telemetry collector, which may
 * outlive a server that was killed. A collector gets five seconds to stop, as a reset gives it.
 */
const noProcessRecorded = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const recordPath = path.join(directory, serviceRegistrationFile);
    const server = yield* fs
      .readFileString(recordPath)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(RecordedPid)), Effect.option);
    if (Option.isSome(server) && (yield* alive(server.value.pid)))
      return yield* failure(
        "in-use",
        `An Executor server (process ${server.value.pid}) is using ${directory}. Quit it, then start Executor again. If no Executor server is running, remove ${recordPath} and start Executor again.`,
      );
    const collector = yield* fs
      .readFileString(path.join(directory, "diagnostics", "collector.json"))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(CollectorStatus)), Effect.option);
    if (Option.isNone(collector) || collector.value.state === "stopped") return;
    const pid = collector.value.pid;
    if (pid === undefined) return;
    const running = yield* alive(pid).pipe(
      Effect.repeat({
        while: (running) => running,
        schedule: Schedule.spaced("100 millis").pipe(Schedule.upTo({ times: 50 })),
      }),
    );
    if (running)
      return yield* failure(
        "in-use",
        `An Executor process (${pid}) is still using ${directory}. Quit Executor everywhere, then start it again.`,
      );
  });

/**
 * Move the desktop's legacy data directory into the shared directory the CLI and the background
 * service use, once. The desktop's data wins: CLI data already there is renamed into `backups`
 * as `cli-data-<time>`, and the legacy directory is renamed into `backups` as
 * `desktop-data-<time>` once its copy is in place. The port follows the desktop's data:
 * `legacyPort`, the old `desktop.json` port, becomes the shared directory's `service.json` port,
 * or the default when there is none. The CLI's other settings are carried over, except the `env`
 * variables of its own data and `disabled`, and the result names what changed.
 */
export const migrateDesktopData = (input: {
  readonly platform: string;
  readonly legacyDirectory: string;
  readonly sharedDirectory: string;
  readonly backups: string;
  readonly legacyPort: number | undefined;
  /** Runs once, when there is data to move: stopping, copying and renaming can take a while. */
  readonly onMoving: Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const legacy = path.resolve(input.legacyDirectory);
    const shared = path.resolve(input.sharedDirectory);
    const backups = path.resolve(input.backups);
    const recordDirectory = path.dirname(legacy);
    const recordPath = path.join(recordDirectory, recordFile);
    const none: DesktopMigration = { kind: "none" };
    // The desktop already uses the shared directory.
    if (legacy === shared) return none;
    const within = (child: string, parent: string) =>
      child === parent || child.startsWith(`${parent}${path.sep}`);
    const pairs = [
      [legacy, shared],
      [legacy, backups],
      [shared, backups],
    ] as const;
    if (pairs.some(([a, b]) => within(a, b) || within(b, a)))
      return yield* failure(
        "overlapping",
        `The desktop data directory ${legacy}, the CLI's data directory ${shared} and the backups folder ${backups} must not contain one another. Nothing was changed.`,
      );

    const saved = yield* Effect.gen(function* () {
      if (!(yield* fs.exists(recordPath))) return Option.none<MigrationRecord>();
      const text = yield* fs.readFileString(recordPath);
      return Option.some(yield* Schema.decodeUnknownEffect(RecordJson)(text));
    }).pipe(
      Effect.mapError(() =>
        failure(
          "record-failed",
          `Executor's migration record ${recordPath} is unreadable, so it cannot tell how far moving your desktop data got. Nothing was changed. Your data is in ${legacy}, ${shared} or ${backups}.`,
        ),
      ),
    );
    if (Option.isSome(saved) && saved.value.state === "done") return none;
    if (Option.isSome(saved) && (saved.value.legacy !== legacy || saved.value.shared !== shared))
      return yield* failure(
        "unfinished",
        `Executor started moving its desktop data from ${saved.value.legacy} to ${saved.value.shared}, and ${recordPath} records that move as unfinished. Start Executor with those folders again to finish it. Nothing was changed.`,
      );
    const legacyNames = Option.isSome(saved)
      ? []
      : yield* namesIn(legacy).pipe(
          Effect.mapError(() =>
            failure(
              "copy-failed",
              `Executor could not read its desktop data in ${legacy}. Check that folder's permissions. Nothing was changed.`,
            ),
          ),
        );
    if (Option.isNone(saved) && legacyNames.length === 0) return none;

    let record: MigrationRecord = Option.isSome(saved)
      ? saved.value
      : yield* Effect.map(stamp, (id) => ({
          version: 1 as const,
          state: "copying" as const,
          legacy,
          shared,
          temporary: path.join(path.dirname(shared), `.${path.basename(shared)}-migrating-${id}`),
          backup: path.join(backups, `desktop-data-${id}`),
          archives: [],
          kept: false,
          ...(input.legacyPort === undefined ? {} : { port: input.legacyPort }),
        }));
    const save = (next: MigrationRecord) =>
      Schema.encodeEffect(RecordJson)(next).pipe(
        Effect.flatMap((contents) =>
          writeAtomically(input.platform, recordDirectory, recordPath, contents),
        ),
        Effect.mapError(() =>
          failure(
            "record-failed",
            `Executor could not save its migration record in ${recordDirectory}. Check that folder's permissions and free disk space.`,
          ),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            record = next;
          }),
        ),
      );
    // A desktop that never created its main database, as one whose first start failed, has
    // nothing to move, and must not replace the CLI's data with its empty installation. Browser
    // sessions alone, in browser-auth.pglite, are not worth replacing it for.
    if (Option.isNone(saved) && !legacyNames.includes("executor.pglite")) {
      yield* save({ ...record, state: "done", result: none });
      yield* Effect.logInfo("The desktop's old data directory holds no database to move").pipe(
        Effect.annotateLogs({ legacy }),
      );
      return none;
    }
    const renameFailed = (from: string) => (error: PlatformError.PlatformError) =>
      hasCode("EBUSY")(error) || (input.platform === "win32" && hasCode("EPERM", "EACCES")(error))
        ? failure(
            "in-use",
            `A program is using files in ${from}, so Executor could not move it. Close any program using that folder, then start Executor again.`,
          )
        : failure(
            "move-failed",
            `Executor could not move ${from}. Check that it can write to ${path.dirname(from)} and ${backups}.`,
          );
    const copyFailed = failure(
      "copy-failed",
      `Executor could not copy your desktop data from ${legacy} to ${shared}. Check that the drive has enough free space and that Executor can write to ${path.dirname(shared)}.`,
    );
    const existing = (paths: ReadonlyArray<string>) => Effect.filter(paths, (at) => fs.exists(at));
    /** The copy is in place: renamed before an interruption recorded it. */
    const placed = (source: string) =>
      Effect.gen(function* () {
        if ((yield* fs.exists(record.temporary)) || !(yield* fs.exists(shared))) return false;
        if (yield* fs.exists(path.join(source, "installation.json")))
          return yield* sameBytes(
            path.join(source, "installation.json"),
            path.join(shared, "installation.json"),
          );
        return yield* verify(source, shared);
      });

    /** Copy the desktop data beside the shared directory and verify it, unless that is done. */
    const prepare = Effect.gen(function* () {
      const source = (yield* fs.exists(legacy)) ? legacy : record.backup;
      // A copy recorded as verified is checked again: its source may have changed since.
      if (record.state === "copied") {
        if (yield* fs.exists(record.temporary)) {
          if (yield* verify(source, record.temporary)) return;
        } else if (yield* placed(source)) return;
      }
      // Renaming the shared directory, which holds its locks, into the backups folder must not
      // fail after a long copy.
      yield* fs.makeDirectory(backups, { recursive: true, mode: 0o700 });
      if ((yield* fs.stat(shared)).dev !== (yield* fs.stat(backups)).dev)
        return yield* failure(
          "cross-volume",
          `The CLI's data directory ${shared} is on another drive than the backups folder ${backups}, so Executor cannot move it aside. Move or rename ${shared} yourself, then start Executor again.`,
        );
      yield* save({ ...record, state: "copying" });
      // Only this migration's own unfinished copy, named in its record, is ever removed.
      yield* fs.remove(record.temporary, { recursive: true, force: true });
      yield* copyTree(input.platform, source, record.temporary);
      if (!(yield* verify(source, record.temporary)))
        return yield* failure(
          "verify-failed",
          `Your desktop data in ${source} changed while Executor copied it, or the copy is incomplete. Quit any program using files in it, then start Executor again.`,
        );
      yield* save({ ...record, state: "copied" });
    }).pipe(Effect.catchTag("PlatformError", () => Effect.fail(copyFailed)));

    /**
     * Write the shared settings into the copy and record what they changed, before each attempt
     * to rename it into place, from the CLI's settings as they are then: where its directory is
     * now, in place or in the archive an interrupted swap already renamed it to. A copy an earlier
     * launch kept may be older than settings the CLI saved since. Its `service.json` is never
     * verified, so the copy stays verified.
     */
    const configure = Effect.gen(function* () {
      if (!(yield* fs.exists(record.temporary))) return;
      const { settings, changes } = sharedSettings(
        yield* readSettings((yield* existing(record.archives))[0] ?? shared),
        record.port,
      );
      yield* writeSettings(input.platform, record.temporary, settings);
      const { settings: _previous, ...rest } = record;
      yield* save({ ...rest, ...(changes === undefined ? {} : { settings: changes }) });
    }).pipe(
      Effect.catchTags({
        PlatformError: () => Effect.fail(copyFailed),
        SchemaError: () => Effect.fail(copyFailed),
        ServiceSettingInvalid: (error) => Effect.fail(failure("copy-failed", error.message)),
      }),
    );

    /**
     * Rename the legacy directory into the backups folder, while its locks are still held; on
     * another volume it stays. `held.moved` leaves those locks where it went.
     */
    const backUp = (held: Held) =>
      Effect.gen(function* () {
        if (record.kept || !(yield* fs.exists(legacy))) return;
        yield* fs.makeDirectory(backups, { recursive: true, mode: 0o700 });
        yield* held.intact;
        yield* whileHeld(fs.rename(legacy, record.backup)).pipe(
          Effect.andThen(held.moved),
          // The copy is verified, so the move succeeds without the legacy directory's backup.
          Effect.catchIf(hasCode("EXDEV"), () => save({ ...record, kept: true })),
          Effect.catchTag("PlatformError", (error) => Effect.fail(renameFailed(legacy)(error))),
        );
      }).pipe(
        Effect.catchTag("PlatformError", (error) => Effect.fail(renameFailed(legacy)(error))),
      );

    /**
     * Move the shared directory, with what it holds and its locks, while they are still held, into
     * the backups folder and put the copy there. `held.moved` leaves those locks where it went.
     */
    const swap = (held: Held) =>
      Effect.gen(function* () {
        if (!(yield* fs.exists(record.temporary))) return;
        if (yield* fs.exists(shared)) {
          const archive = path.join(backups, `cli-data-${yield* stamp}`);
          yield* held.intact;
          yield* save({ ...record, archives: [...record.archives, archive] });
          yield* whileHeld(fs.rename(shared, archive)).pipe(
            Effect.andThen(held.moved),
            Effect.catchIf(hasCode("EXDEV"), () =>
              Effect.fail(
                failure(
                  "cross-volume",
                  `The CLI's data directory ${shared} is on another drive than the backups folder ${backups}, so Executor cannot move it aside. Move or rename ${shared} yourself, then start Executor again.`,
                ),
              ),
            ),
            Effect.catchTag("PlatformError", (error) => Effect.fail(renameFailed(shared)(error))),
          );
        }
        yield* whileHeld(fs.rename(record.temporary, shared)).pipe(
          Effect.catchIf(hasCode("ENOTEMPTY", "EEXIST"), () => Effect.fail(inUse(shared))),
          Effect.catchTag("PlatformError", (error) =>
            Effect.fail(renameFailed(record.temporary)(error)),
          ),
        );
      }).pipe(
        Effect.catchTag("PlatformError", (error) => Effect.fail(renameFailed(shared)(error))),
      );

    /**
     * Remove the lock directories that moved into the backups folder, and each archive that held
     * nothing else, as when the shared directory was created only to be locked.
     */
    const tidy = Effect.gen(function* () {
      for (const archive of yield* existing(record.archives)) {
        yield* removeLocks(archive);
        if ((yield* namesIn(archive)).length === 0)
          yield* Effect.tryPromise(() => nodeFs.promises.rmdir(archive));
      }
      if (!record.kept && (yield* fs.exists(record.backup))) yield* removeLocks(record.backup);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not remove the migration's locks from the backups", cause),
      ),
    );

    /**
     * Undo this migration's renames, newest first, and remove its copy and record, but only when
     * that restores the start and the copy was not verified: otherwise the record stays and the
     * next launch continues, from a verified copy without copying again. Its locks, released by
     * now, are removed from a directory before it moves back.
     */
    const rollback = Effect.gen(function* () {
      for (const archive of record.archives.toReversed())
        if ((yield* fs.exists(archive)) && !(yield* fs.exists(shared))) {
          yield* removeLocks(archive);
          yield* whileHeld(fs.rename(archive, shared));
        }
      if (!record.kept && !(yield* fs.exists(legacy)) && (yield* fs.exists(record.backup))) {
        yield* removeLocks(record.backup);
        yield* whileHeld(fs.rename(record.backup, legacy));
      }
      if ((yield* existing(record.archives)).length > 0 || !(yield* fs.exists(legacy))) return;
      // A rename can fail for longer than the retries, as while a scanner reads the new copy.
      if (record.state === "copied") return;
      yield* fs.remove(record.temporary, { recursive: true, force: true });
      yield* fs.remove(recordPath, { force: true });
    }).pipe(Effect.ignore);

    /** Where the data is now, for a failure's message. */
    const whereabouts = (stopped: boolean) =>
      Effect.gen(function* () {
        const service = stopped
          ? " Executor stopped the CLI's background server; the next `executor` command starts it again."
          : "";
        if (!(yield* fs.exists(recordPath)))
          return `Nothing was changed. Your desktop data is still in ${legacy}${(yield* hasData(shared)) ? `, and the CLI's data in ${shared}` : ""}.${service}`;
        const desktop = (yield* fs.exists(legacy))
          ? legacy
          : (yield* fs.exists(record.backup))
            ? record.backup
            : record.temporary;
        const archives = yield* existing(record.archives);
        return (
          [
            "Nothing was deleted, and Executor continues moving your data the next time it starts.",
            `Your desktop data is in ${desktop}.`,
            ...(archives.length === 0
              ? []
              : [`The CLI's previous data is in ${archives.join(" and ")}.`]),
          ].join(" ") + service
        );
      }).pipe(Effect.orElseSucceed(() => ""));

    // Rollback applies once this run has started changing files, until the copy is in place.
    let undo = false;
    /** This run created the shared directory, so a failure leaves none if it still holds nothing. */
    let created = false;
    const registered = yield* readRegistration(shared);
    return yield* Effect.gen(function* () {
      yield* input.onMoving;
      yield* stop(shared).pipe(
        Effect.mapError((error) =>
          failure(
            "stop-failed",
            `${Schema.is(ServiceFailed)(error) ? error.message : `The CLI's background Executor for ${shared} did not stop.`} Stop it with \`executor service stop\`, then start Executor again.`,
          ),
        ),
      );
      // The locks are held until the renames are done, and released before anything is tidied.
      yield* Effect.scoped(
        Effect.gen(function* () {
          // A resumed run may already have renamed the legacy directory.
          const legacyHeld = (yield* fs.exists(legacy))
            ? yield* noProcessRecorded(legacy).pipe(Effect.andThen(holdDirectory(legacy)))
            : alreadyMoved;
          // A server can start in a directory that does not exist yet, so the shared directory is
          // created to be locked.
          yield* fs.makeDirectory(path.dirname(shared), { recursive: true, mode: 0o700 });
          created = yield* fs.makeDirectory(shared, { mode: 0o700 }).pipe(
            Effect.as(true),
            Effect.catchIf(
              (error) => Predicate.isTagged(error.reason, "AlreadyExists"),
              () => Effect.succeed(false),
            ),
          );
          yield* noProcessRecorded(shared);
          const sharedHeld = yield* holdDirectory(shared);
          undo = true;
          // The copy stops once either lock is lost; each rename checks its own lock first.
          yield* Effect.raceFirst(prepare, Effect.raceFirst(legacyHeld.lost, sharedHeld.lost));
          yield* backUp(legacyHeld);
          yield* configure;
          yield* swap(sharedHeld);
          undo = false;
        }),
      ).pipe(Effect.catchTag("PlatformError", () => Effect.fail(copyFailed)));
      yield* tidy;
      // Private, as the CLI creates it, whatever the desktop's mode was. This also covers a copy
      // an earlier launch swapped into place.
      yield* fs.chmod(shared, 0o700);
      const archives = yield* existing(record.archives);
      const holding = yield* Effect.filter(archives, hasData);
      const archived = holding[0] ?? archives[0];
      const result: DesktopMigration = {
        kind: holding.length > 0 ? "replaced" : "moved",
        ...(archived === undefined ? {} : { archived }),
        ...(record.kept ? {} : { backup: record.backup }),
        // Settings change only for a CLI that left something behind; otherwise it had none.
        ...(archived === undefined || record.settings === undefined
          ? {}
          : { settings: record.settings }),
      };
      yield* save({
        ...record,
        state: "done",
        result,
        ...(result.kind === "replaced" || result.settings !== undefined
          ? { notice: "pending" as const }
          : {}),
      });
      yield* Effect.logInfo("Moved desktop data to the shared data directory").pipe(
        Effect.annotateLogs({ shared, ...result }),
      );
      return result;
    }).pipe(
      Effect.catchTag("PlatformError", () =>
        Effect.fail(
          failure(
            "record-failed",
            `Executor moved your desktop data to ${shared} but could not check the result.`,
          ),
        ),
      ),
      Effect.catchTag("DesktopMigrationFailed", (error) =>
        Effect.gen(function* () {
          if (undo) yield* rollback;
          // rmdir refuses a directory that holds anything, such as a server's lock.
          if (created)
            yield* Effect.tryPromise(() => nodeFs.promises.rmdir(shared)).pipe(Effect.ignore);
          return yield* failure(
            error.reason,
            `${error.message} ${yield* whereabouts(Option.isSome(registered))}`,
          );
        }),
      ),
    );
  });

/** The migration record that `legacyDirectory`'s migration keeps beside it, if any. */
const readRecord = (legacyDirectory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const recordPath = path.join(path.dirname(path.resolve(legacyDirectory)), recordFile);
    if (!(yield* fs.exists(recordPath))) return Option.none<MigrationRecord>();
    return Option.some(
      yield* fs
        .readFileString(recordPath)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(RecordJson))),
    );
  });

/** The notice a move leaves for the desktop: where the CLI's data or settings went, and its text. */
export interface MoveNotice {
  readonly archived: string;
  readonly detail: string;
}

/** The notice's text: where the CLI's data or settings went, and which of its settings changed. */
const noticeDetail = (archived: string, result: DesktopMigration) => {
  const { port, variables = [], removed = [] } = result.settings ?? {};
  return [
    result.kind === "replaced"
      ? `The CLI's previous data was moved aside, not deleted. It is here:\n\n${archived}`
      : `The CLI's previous settings were moved aside, not deleted. They are here:\n\n${archived}`,
    ...(port === undefined
      ? []
      : [
          `The background Executor now uses port ${port.to}, as the desktop did, instead of the CLI's port ${port.from}. Update MCP clients that use port ${port.from}, or change the port with File → Server port….`,
        ]),
    ...(variables.length === 0
      ? []
      : [
          `These CLI env settings belonged to its previous data, so they stayed with it: ${variables.join(", ")}.`,
        ]),
    ...(removed.includes("disabled")
      ? [
          "The CLI's disabled setting was removed: the desktop runs the background Executor, so `executor` and `executor apps` use it too.",
        ]
      : []),
  ].join("\n\n");
};

/**
 * Where a finished migration moved the CLI's data or changed settings aside, and the notice's text,
 * while that notice has not been shown. A launch that ends before showing it, as one quit while
 * the data moves, leaves it for the next launch.
 */
export const pendingNotice = (legacyDirectory: string) =>
  readRecord(legacyDirectory).pipe(
    Effect.map(
      Option.flatMap((record): Option.Option<MoveNotice> =>
        record.state === "done" &&
        record.notice === "pending" &&
        record.result?.archived !== undefined
          ? Option.some({
              archived: record.result.archived,
              detail: noticeDetail(record.result.archived, record.result),
            })
          : Option.none(),
      ),
    ),
  );

/** Record that the notice naming the CLI data a migration moved aside has been shown. */
export const noticeShown = (platform: string, legacyDirectory: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const recordDirectory = path.dirname(path.resolve(legacyDirectory));
    const record = yield* readRecord(legacyDirectory);
    if (Option.isNone(record) || record.value.notice !== "pending") return;
    const contents = yield* Schema.encodeEffect(RecordJson)({ ...record.value, notice: "shown" });
    yield* writeAtomically(
      platform,
      recordDirectory,
      path.join(recordDirectory, recordFile),
      contents,
    );
  });
