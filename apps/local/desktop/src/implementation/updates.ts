/** Optional desktop updater. The packaged build owns its feed; no legacy channel is inferred. */
import { dialog } from "electron";
import { autoUpdater } from "electron-updater";
import { Effect, FileSystem, Path, Semaphore } from "effect";

import { UpdateFailed } from "../contracts/desktop.ts";
const invoke = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: () => new UpdateFailed() });

/** Make one scoped, user-initiated check/download/restart action. Unconfigured builds do no I/O. */
export const makeUpdateAction = (restart: (install: () => void) => void) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    const onError = () => {}; // Promise failures are presented below, never provider payloads.
    autoUpdater.on("error", onError);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => autoUpdater.removeListener("error", onError)),
    );
    const check = Effect.gen(function* () {
      if (!(yield* fs.exists(path.join(process.resourcesPath, "app-update.yml")))) {
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
      const result = yield* invoke(() => autoUpdater.checkForUpdates());
      if (result === null || !result.isUpdateAvailable) {
        yield* invoke(() =>
          dialog.showMessageBox({ type: "info", message: "Executor 2 is up to date." }),
        );
        return;
      }
      const download = yield* invoke(() =>
        dialog.showMessageBox({
          type: "question",
          message: "An Executor 2 update is available.",
          buttons: ["Download", "Later"],
          defaultId: 0,
          cancelId: 1,
        }),
      );
      if (download.response !== 0) return;
      const cancellation = result.cancellationToken;
      if (cancellation === undefined) return yield* new UpdateFailed();
      yield* invoke(() => autoUpdater.downloadUpdate(cancellation)).pipe(
        Effect.onInterrupt(() => Effect.sync(() => cancellation.cancel())),
      );
      const confirmation = yield* invoke(() =>
        dialog.showMessageBox({
          type: "question",
          message: "Restart to install the update?",
          detail: "The local server will stop while Executor restarts.",
          buttons: ["Restart", "Later"],
          defaultId: 1,
          cancelId: 1,
        }),
      );
      if (confirmation.response === 0) restart(() => autoUpdater.quitAndInstall());
    }).pipe(
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
    return lock.withPermitsIfAvailable(1)(check);
  });
