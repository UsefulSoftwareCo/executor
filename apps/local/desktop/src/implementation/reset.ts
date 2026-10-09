/**
 * Reset with backup: move the whole data directory aside and start fresh. Nothing is deleted.
 * The backup keeps `installation.json`, so it stays paired with its untouched OS credential entry,
 * and keeps its `keys.json` when the keys are in a file.
 */
import { dialog, shell, type BaseWindow } from "electron";
import { lock } from "proper-lockfile";
import {
  DateTime,
  Effect,
  FileSystem,
  Option,
  Path,
  Result,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import { LocalCredentialService, LocalInstallation } from "@executor-js/local-server/auth";
import { BackupManifest, ResetFailed } from "../contracts/desktop.ts";
import type { Supervisor } from "./supervisor.ts";

const Collector = Schema.Struct({
  state: Schema.Literals(["starting", "running", "restarting", "stopped"]),
  pid: Schema.optional(Schema.Number),
});

const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

/**
 * The backend's telemetry collector shares its process group, which the supervisor signals once
 * the backend has exited. Wait for it so its database handle does not follow the rename, or on
 * Windows block it.
 */
const collectorStopped = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(directory, "diagnostics", "collector.json");
    if (!(yield* fs.exists(file))) return;
    const status = yield* fs
      .readFileString(file)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Collector))));
    const pid = status.pid;
    if (status.state === "stopped" || pid === undefined) return;
    yield* Effect.suspend(() =>
      running(pid) ? Effect.fail(new ResetFailed({ stage: "stop" })) : Effect.void,
    ).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 50 }));
  }).pipe(
    Effect.catchTag("PlatformError", () => Effect.fail(new ResetFailed({ stage: "stop" }))),
    Effect.catchTag("SchemaError", () => Effect.fail(new ResetFailed({ stage: "stop" }))),
  );

const stamp = (now: DateTime.Utc) =>
  `${DateTime.formatIso(now)
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")}-${Array.from(crypto.getRandomValues(new Uint8Array(3)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;

/**
 * Move `directory` to `backups/data-<stamp>-<random>` and describe it in a manifest. The backend
 * must already be stopped. Any failure before the rename leaves the data in place.
 */
export const backupData = (options: {
  readonly directory: string;
  readonly backups: string;
  readonly appVersion: string;
  readonly platform: NodeJS.Platform;
  /** Runs the rename while the desktop's own log holds its writes, so earlier lines move too. */
  readonly whileMoving: <A, E, R>(move: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory, backups } = options;
    yield* collectorStopped(directory);
    const now = yield* DateTime.now;
    const backup = path.join(backups, `data-${stamp(now)}`);
    yield* fs
      .makeDirectory(backups, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(() => new ResetFailed({ stage: "move" })));
    // The bootstrap lock proves no other Executor process is setting up this directory.
    const lockfilePath = path.join(directory, ".bootstrap.lock");
    const release = yield* Effect.tryPromise({
      // The lock moves with the directory, so its refresh timer must not throw afterward.
      try: () => lock(directory, { retries: 0, lockfilePath, onCompromised: () => {} }),
      catch: () => new ResetFailed({ stage: "lock" }),
    });
    yield* options.whileMoving(fs.rename(directory, backup)).pipe(
      Effect.mapError(() => new ResetFailed({ stage: "move" })),
      Effect.ensuring(Effect.promise(() => release().catch(() => undefined))),
    );
    yield* fs.remove(path.join(backup, ".bootstrap.lock"), { recursive: true }).pipe(Effect.ignore);
    yield* Effect.logInfo("Moved Executor data to a backup").pipe(Effect.annotateLogs({ backup }));

    // The data is safe from here. A manifest or sync failure is logged but does not undo the move.
    yield* Effect.gen(function* () {
      const installation = yield* fs
        .readFileString(path.join(backup, "installation.json"))
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(LocalInstallation))),
          Effect.option,
        );
      const manifest = yield* Schema.encodeEffect(Schema.fromJsonString(BackupManifest))({
        version: 1,
        appVersion: options.appVersion,
        createdAt: DateTime.formatIso(now),
        source: directory,
        ...Option.match(installation, {
          onNone: () => ({}),
          onSome: ({ id, state }) => ({
            installation:
              state === "external"
                ? { id, keySource: "environment" as const }
                : state === "file"
                  ? { id, keySource: "key-file" as const }
                  : {
                      id,
                      keySource: "os-credential-store" as const,
                      credential: { service: LocalCredentialService, account: id },
                    },
          }),
        }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(path.join(backup, "executor-backup.json"), {
            flag: "wx",
            mode: 0o600,
          });
          yield* file.writeAll(new TextEncoder().encode(`${manifest}\n`));
          yield* file.sync;
        }),
      );
      // Windows does not allow opening directories as ordinary file handles.
      if (options.platform !== "win32")
        yield* Effect.forEach([backup, backups, path.dirname(directory)], (parent) =>
          Effect.scoped(Effect.flatMap(fs.open(parent), (handle) => handle.sync)),
        );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not complete the backup manifest", cause),
      ),
    );
    // The parent's own diagnostics keep writing to the fresh directory.
    yield* fs
      .makeDirectory(path.join(directory, "diagnostics"), { recursive: true, mode: 0o700 })
      .pipe(Effect.ignore);
    return backup;
  });

const failureDetail: Record<(typeof ResetFailed.Type)["stage"], string> = {
  stop: "Executor's local server or its telemetry collector did not stop in time.",
  lock: "Another Executor process is using the data directory. Quit it and try again.",
  move: "The data directory could not be moved. Close any program using files in it and try again.",
};

/** Confirm, stop the backend, back up the data, restart and announce the backup. Serialized. */
export const makeResetAction = (options: {
  readonly supervisor: Supervisor;
  readonly directory: string;
  readonly backups: string;
  readonly appVersion: string;
  readonly whileMoving: <A, E, R>(move: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly window: () => BaseWindow | undefined;
}) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const permit = yield* Semaphore.make(1);
    const messageBox = (box: Electron.MessageBoxOptions) =>
      Effect.promise(() => {
        const parent = options.window();
        return parent === undefined || parent.isDestroyed()
          ? dialog.showMessageBox(box)
          : dialog.showMessageBox(parent, box);
      });
    const reset = Effect.gen(function* () {
      const { response } = yield* messageBox({
        type: "warning",
        title: "Reset Executor data?",
        message: "Start over with fresh Executor data?",
        detail: `Executor will stop, move all of its data to a backup folder and start again without your apps, accounts or connections. Nothing is deleted. Backups are kept in:\n\n${options.backups}\n\nSaved keys, in the OS credential store or keys.json, are kept for the backup.`,
        buttons: ["Reset and back up", "Cancel"],
        defaultId: 1,
        cancelId: 1,
      });
      if (response !== 0) return;
      yield* Effect.logInfo("Resetting Executor data");
      const result = yield* options.supervisor.whileStopped(
        backupData({
          directory: options.directory,
          backups: options.backups,
          appVersion: options.appVersion,
          platform: process.platform,
          whileMoving: options.whileMoving,
        }).pipe(Effect.provideContext(services), Effect.result),
      );
      if (Result.isFailure(result)) {
        yield* Effect.logError("Executor data reset failed", result.failure);
        yield* messageBox({
          type: "error",
          title: "Reset failed",
          message: "Executor could not reset its data. Your data was left in place.",
          detail: failureDetail[result.failure.stage],
        });
        return;
      }
      const backup = result.success;
      const announced = yield* messageBox({
        type: "info",
        title: "Executor data reset",
        message: "Your previous data has been backed up.",
        detail: `If you need anything from before the reset, it is here:\n\n${backup}\n\nExecutor is now running with fresh data.`,
        buttons: ["Show in folder", "OK"],
        defaultId: 1,
        cancelId: 1,
      });
      if (announced.response === 0) shell.showItemInFolder(backup);
    });
    return permit.withPermitsIfAvailable(1)(reset);
  });
