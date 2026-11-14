/**
 * Desktop updater. The packaged build's app-update.yml names its channel feed;
 * builds without one (unsigned macOS, Linux packages other than AppImage) only
 * point people to the download page.
 */
import { dialog } from "electron";
import { autoUpdater } from "electron-updater";
import { Duration, Effect, FileSystem, Option, Path, Ref, Schedule, Semaphore } from "effect";

import { UpdateFailed } from "../contracts/desktop.ts";
const invoke = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: () => new UpdateFailed() });

const firstCheck = Duration.seconds(15);
const checkInterval = Duration.hours(4);

/**
 * Check in the background, download quietly and offer one restart per version.
 * Returns the menu action, which also offers a version declined earlier.
 */
export const makeUpdater = (restart: (install: () => void) => void) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configured =
      (process.platform !== "linux" || process.env.APPIMAGE !== undefined) &&
      (yield* fs.exists(path.join(process.resourcesPath, "app-update.yml")));
    // Assigning a channel at runtime would also allow downgrades, so the feed's channel stays in app-update.yml.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;
    const onError = () => {}; // Promise failures are presented below, never provider payloads.
    autoUpdater.on("error", onError);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => autoUpdater.removeListener("error", onError)),
    );
    const declined = yield* Ref.make(Option.none<string>());

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
        if (confirmation.response === 0) restart(() => autoUpdater.quitAndInstall());
        else yield* Ref.set(declined, Option.some(version));
      });

    const download = (announce: boolean) =>
      Effect.gen(function* () {
        const result = yield* invoke(() => autoUpdater.checkForUpdates());
        if (result === null || !result.isUpdateAvailable) return Option.none<string>();
        // The download can take a while; the restart prompt follows when it finishes.
        if (announce)
          void dialog.showMessageBox({
            type: "info",
            message: `Downloading Executor 2 ${result.updateInfo.version}.`,
            detail: "You will be asked to restart when it is ready.",
          });
        const cancellation = result.cancellationToken;
        if (cancellation === undefined) return yield* new UpdateFailed();
        yield* invoke(() => autoUpdater.downloadUpdate(cancellation)).pipe(
          Effect.onInterrupt(() => Effect.sync(() => cancellation.cancel())),
        );
        return Option.some(result.updateInfo.version);
      });

    const background = Effect.gen(function* () {
      const version = yield* download(false);
      if (Option.isNone(version)) return;
      const skipped = yield* Ref.get(declined);
      if (Option.isSome(skipped) && skipped.value === version.value) return;
      yield* offerRestart(version.value);
    }).pipe(
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
    return manual;
  });
