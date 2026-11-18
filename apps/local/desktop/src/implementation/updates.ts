/**
 * Desktop updater. The packaged build's app-update.yml names its channel feed;
 * builds without one (unsigned macOS, Linux packages other than AppImage) only
 * point people to the download page. A development build checks only a feed that
 * EXECUTOR_DESKTOP_DEV_UPDATE_CONFIG names, as the desktop update scenario does
 * (`development-updates.ts`); a release build does not contain that setting.
 */
import { app, dialog } from "electron";
import { autoUpdater } from "electron-updater";
import { Duration, Effect, FileSystem, Option, Path, Ref, Schedule, Semaphore } from "effect";

import {
  type DesktopUpdate,
  feedReleases,
  feedReleasesSince,
} from "../../../web/src/contracts/desktop-update.ts";
import { UpdateFailed } from "../contracts/desktop.ts";
const invoke = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: () => new UpdateFailed() });

const firstCheck = Duration.seconds(15);
const checkInterval = Duration.hours(4);

/**
 * Check in the background and download quietly. The update is shown, never offered in a dialog:
 * `show` receives it while it downloads and once it is ready, and the dashboard's sidebar offers
 * the restart that `install` performs. The menu's check answers in dialogs, since it was asked.
 */
export const makeUpdater = (options: {
  readonly restart: (install: () => void) => void;
  readonly show: (update: Option.Option<DesktopUpdate>) => void;
}) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Release bundles define EXECUTOR_DESKTOP_DEV as "0", which leaves this import out of them.
    const development =
      process.env.EXECUTOR_DESKTOP_DEV !== "0" && !app.isPackaged
        ? yield* Effect.promise(() => import("./development-updates.ts")).pipe(
            Effect.flatMap(({ developmentFeed }) => developmentFeed),
          )
        : false;
    const configured =
      (process.platform !== "linux" || process.env.APPIMAGE !== undefined) &&
      (development || (yield* fs.exists(path.join(process.resourcesPath, "app-update.yml"))));
    // Assigning a channel at runtime would also allow downgrades, so the feed's channel stays in app-update.yml.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;
    const onError = () => {}; // Promise failures are presented below, never provider payloads.
    autoUpdater.on("error", onError);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => autoUpdater.removeListener("error", onError)),
    );
    const update = yield* Ref.make(Option.none<DesktopUpdate>());
    const set = (next: Option.Option<DesktopUpdate>) =>
      Ref.set(update, next).pipe(Effect.andThen(Effect.sync(() => options.show(next))));

    /** Restart into the downloaded version, if one is ready. */
    const install = Effect.gen(function* () {
      const current = yield* Ref.get(update);
      if (Option.isSome(current) && current.value.state === "ready")
        options.restart(() => autoUpdater.quitAndInstall());
    });

    const offerRestart = (version: string) =>
      Effect.gen(function* () {
        const confirmation = yield* invoke(() =>
          dialog.showMessageBox({
            type: "question",
            message: `Executor 2 ${version} is ready to install.`,
            detail:
              "Executor restarts to install it. Its background server keeps running until the new version replaces it.",
            buttons: ["Restart", "Later"],
            defaultId: 1,
            cancelId: 1,
          }),
        );
        if (confirmation.response === 0) yield* install;
      });

    /**
     * Download a newer version, shown as downloading meanwhile and as ready once it is. A failed
     * download or verification shows nothing: electron-updater drops the installer it held
     * before, so an older version shown as ready could no longer be installed. The next check,
     * on the schedule, from the menu or at the next start, downloads it again.
     */
    const download = (announce: boolean) =>
      Effect.gen(function* () {
        const result = yield* invoke(() => autoUpdater.checkForUpdates());
        if (result === null || !result.isUpdateAvailable) return Option.none<string>();
        const version = result.updateInfo.version;
        // The notes come in the feed file this check already read; nothing else is fetched.
        const releases = feedReleases(result.updateInfo.releaseNotes, version);
        const releasesSince = feedReleasesSince(result.updateInfo);
        const running = app.getVersion();
        const previous = yield* Ref.get(update);
        if (
          Option.isSome(previous) &&
          previous.value.state === "ready" &&
          previous.value.version === version
        )
          return Option.some(version);
        // The download can take a while; the restart prompt follows when it finishes.
        if (announce)
          void dialog.showMessageBox({
            type: "info",
            message: `Downloading Executor 2 ${version}.`,
            detail: "You will be asked to restart when it is ready.",
          });
        const cancellation = result.cancellationToken;
        if (cancellation === undefined) return yield* new UpdateFailed();
        yield* set(Option.some({ state: "downloading", version }));
        yield* invoke(() => autoUpdater.downloadUpdate(cancellation)).pipe(
          Effect.onInterrupt(() => Effect.sync(() => cancellation.cancel())),
          Effect.onError(() => set(Option.none())),
        );
        yield* set(
          Option.some({
            state: "ready",
            version,
            current: running,
            ...(releases === undefined ? {} : { releases }),
            ...(releases === undefined || releasesSince === undefined ? {} : { releasesSince }),
          }),
        );
        return Option.some(version);
      });

    const background = download(false).pipe(
      Effect.asVoid,
      lock.withPermitsIfAvailable(1),
      Effect.catch(() => Effect.logWarning("Desktop update check failed")),
    );

    const manual = Effect.gen(function* () {
      if (!configured) {
        yield* invoke(() =>
          dialog.showMessageBox({
            type: "info",
            message: "Updates are installed from the download page.",
            detail:
              "Download the current Executor 2 installer and install it over this app. Your data will be kept.",
          }),
        );
        return;
      }
      const version = yield* download(true);
      if (Option.isNone(version)) {
        yield* invoke(() =>
          dialog.showMessageBox({ type: "info", message: "Executor 2 is up to date." }),
        );
        return;
      }
      yield* offerRestart(version.value);
    }).pipe(
      lock.withPermits(1),
      Effect.catch(() =>
        invoke(() =>
          dialog.showMessageBox({
            type: "error",
            message: "The update could not be completed.",
            detail: "Your installed version and data are unchanged. Try again later.",
          }),
        ).pipe(Effect.ignore),
      ),
    );

    if (configured)
      yield* background.pipe(
        Effect.repeat(Schedule.spaced(checkInterval)),
        Effect.delay(firstCheck),
        Effect.forkScoped,
      );
    return { check: manual, install, configured };
  });
