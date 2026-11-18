/**
 * A development desktop's update feed, for the desktop update scenario: the updater config that
 * EXECUTOR_DESKTOP_DEV_UPDATE_CONFIG names, in app-update.yml's form. `updates.ts` imports this
 * module only where `process.env.EXECUTOR_DESKTOP_DEV` is not "0", and the release build defines it
 * as "0" (`scripts/build.mjs --release`), so a release bundle does not contain this module.
 */
import { autoUpdater } from "electron-updater";
import { Config, Effect, Option, Path } from "effect";

/** Point the updater at the named feed. Whether one was named. */
export const developmentFeed = Effect.gen(function* () {
  const path = yield* Path.Path;
  const file = yield* Config.String("EXECUTOR_DESKTOP_DEV_UPDATE_CONFIG").pipe(Config.option);
  if (Option.isNone(file)) return false;
  autoUpdater.forceDevUpdateConfig = true;
  autoUpdater.updateConfigPath = path.resolve(file.value);
  return true;
});
