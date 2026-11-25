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

export class DesktopMigrationFailed extends Schema.TaggedError<DesktopMigrationFailed>()(
  "DesktopMigrationFailed",
  {
    reason: Schema.Literals([
      "in-use",
      "stop-failed",
      "copy-failed",
      "verify-failed",
      "cross-volume",
      "move-failed",
      "record-failed",
      "unfinished",
      "overlapping",
    ]),
    message: Schema.String,
  },
) {}

const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

const SettingsChanges = Schema.Struct({
  port: Schema.optionalKey(Schema.Struct({ from: Port, to: Port })),
  variables: Schema.optionalKey(Schema.Array(Schema.String)),
  removed: Schema.optionalKey(Schema.Array(Schema.Literal("disabled"))),
});
type SettingsChanges = typeof SettingsChanges.Type;

export const DesktopMigration = Schema.Struct({
  kind: Schema.Literals(["none", "moved", "replaced"]),
  archived: Schema.optionalKey(Schema.String),
  backup: Schema.optionalKey(Schema.String),
  settings: Schema.optionalKey(SettingsChanges),
});
export type DesktopMigration = typeof DesktopMigration.Type;

const MigrationRecord = Schema.Struct({
  version: Schema.Literal(1),
  state: Schema.Literals(["copying", "copied", "done"]),
  legacy: Schema.String,
  shared: Schema.String,
  temporary: Schema.String,
  backup: Schema.String,
  archives: Schema.Array(Schema.String),
  kept: Schema.Boolean,
  port: Schema.optionalKey(Port),
  settings: Schema.optionalKey(SettingsChanges),
  result: Schema.optionalKey(DesktopMigration),
  notice: Schema.optionalKey(Schema.Literals(["pending", "shown"])),
});
type MigrationRecord = typeof MigrationRecord.Type;
const RecordJson = Schema.fromJsonString(MigrationRecord);

const recordFile = "migration.json";
const bootstrapLockFile = ".bootstrap.lock";
const lockEntries = new Set([serviceLockFile, `${serviceLockFile}.takeover`, bootstrapLockFile]);

const Pid = Schema.Int.check(Schema.isGreaterThan(0));
const RecordedPid = Schema.fromJsonString(Schema.Struct({ pid: Pid }));
const CollectorStatus = Schema.fromJsonString(
  Schema.Struct({
    state: Schema.Literals(["starting", "running", "restarting", "stopped"]),
    pid: Schema.optional(Pid),
  }),
);

const hasCode = (...codes: [string, ...Array<string>]) =>
  Schema.is(Schema.Struct({ cause: Schema.Struct({ code: Schema.Literals(codes) }) }));

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

const stamp = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const random = Array.from(crypto.getRandomValues(new Uint8Array(3)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${DateTime.formatIso(now)
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")}-${random}`;
});

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

const dataVariables = new Set([
  "EXECUTOR_PORT",
  "EXECUTOR_KEY_STORAGE",
  "EXECUTOR_API_KEY",
  "EXECUTOR_ENCRYPTION_KEY",
]);

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

const hasData = (directory: string) =>
  Effect.map(namesIn(directory), (names) =>
    names.some((name) => name === "installation.json" || isDatabase(name)),
  );

type Entry =
  | { readonly kind: "directory"; readonly path: string; readonly mode: number }
  | { readonly kind: "file"; readonly path: string; readonly mode: number; readonly size: bigint }
  | { readonly kind: "link"; readonly path: string; readonly target: string };

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
    const all: ReadonlyArray<Entry> = [{ kind: "directory", path: "", mode: 0o700 }, ...entries];
    for (const entry of all.toReversed()) {
      if (entry.kind === "link") continue;
      const target = path.join(to, entry.path);
      yield* fs.chmod(target, entry.mode & 0o777);
      if (entry.kind === "directory" && platform !== "win32") yield* syncDirectory(target);
    }
    if (platform !== "win32") yield* syncDirectory(path.dirname(to));
  });

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

const hold = (file: string, options: LockOptions, directory: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => lock(file, { retries: 0, onCompromised: () => {}, ...options }),
      catch: () => inUse(directory),
    }),
    (release) => Effect.promise(() => release().catch(() => undefined)),
  );

interface Held {
  readonly moved: Effect.Effect<void>;
  readonly intact: Effect.Effect<void, DesktopMigrationFailed>;
  readonly lost: Effect.Effect<never, DesktopMigrationFailed>;
}

const alreadyMoved: Held = { moved: Effect.void, intact: Effect.void, lost: Effect.never };

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

const removeLocks = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const name of lockEntries)
      yield* fs.remove(path.join(directory, name), { recursive: true, force: true });
  });

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

export const migrateDesktopData = (input: {
  readonly platform: string;
  readonly legacyDirectory: string;
  readonly sharedDirectory: string;
  readonly backups: string;
  readonly legacyPort: number | undefined;
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

    const prepare = Effect.gen(function* () {
      const source = (yield* fs.exists(legacy)) ? legacy : record.backup;
      if (record.state === "copied") {
        if (yield* fs.exists(record.temporary)) {
          if (yield* verify(source, record.temporary)) return;
        } else if (yield* placed(source)) return;
      }
      yield* fs.makeDirectory(backups, { recursive: true, mode: 0o700 });
      if ((yield* fs.stat(shared)).dev !== (yield* fs.stat(backups)).dev)
        return yield* failure(
          "cross-volume",
          `The CLI's data directory ${shared} is on another drive than the backups folder ${backups}, so Executor cannot move it aside. Move or rename ${shared} yourself, then start Executor again.`,
        );
      yield* save({ ...record, state: "copying" });
      yield* fs.remove(record.temporary, { recursive: true, force: true });
      yield* copyTree(input.platform, source, record.temporary);
      if (!(yield* verify(source, record.temporary)))
        return yield* failure(
          "verify-failed",
          `Your desktop data in ${source} changed while Executor copied it, or the copy is incomplete. Quit any program using files in it, then start Executor again.`,
        );
      yield* save({ ...record, state: "copied" });
    }).pipe(Effect.catchTag("PlatformError", () => Effect.fail(copyFailed)));

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

    const backUp = (held: Held) =>
      Effect.gen(function* () {
        if (record.kept || !(yield* fs.exists(legacy))) return;
        yield* fs.makeDirectory(backups, { recursive: true, mode: 0o700 });
        yield* held.intact;
        yield* whileHeld(fs.rename(legacy, record.backup)).pipe(
          Effect.andThen(held.moved),
          Effect.catchIf(hasCode("EXDEV"), () => save({ ...record, kept: true })),
          Effect.catchTag("PlatformError", (error) => Effect.fail(renameFailed(legacy)(error))),
        );
      }).pipe(
        Effect.catchTag("PlatformError", (error) => Effect.fail(renameFailed(legacy)(error))),
      );

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
      if (record.state === "copied") return;
      yield* fs.remove(record.temporary, { recursive: true, force: true });
      yield* fs.remove(recordPath, { force: true });
    }).pipe(Effect.ignore);

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

    let undo = false;
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
      yield* Effect.scoped(
        Effect.gen(function* () {
          const legacyHeld = (yield* fs.exists(legacy))
            ? yield* noProcessRecorded(legacy).pipe(Effect.andThen(holdDirectory(legacy)))
            : alreadyMoved;
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
          yield* Effect.raceFirst(prepare, Effect.raceFirst(legacyHeld.lost, sharedHeld.lost));
          yield* backUp(legacyHeld);
          yield* configure;
          yield* swap(sharedHeld);
          undo = false;
        }),
      ).pipe(Effect.catchTag("PlatformError", () => Effect.fail(copyFailed)));
      yield* tidy;
      yield* fs.chmod(shared, 0o700);
      const archives = yield* existing(record.archives);
      const holding = yield* Effect.filter(archives, hasData);
      const archived = holding[0] ?? archives[0];
      const result: DesktopMigration = {
        kind: holding.length > 0 ? "replaced" : "moved",
        ...(archived === undefined ? {} : { archived }),
        ...(record.kept ? {} : { backup: record.backup }),
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

export interface MoveNotice {
  readonly archived: string;
  readonly detail: string;
}

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
