import { autoUpdater } from "electron-updater";
import { Config, Effect, Option, Path } from "effect";

export const developmentFeed = Effect.gen(function* () {
  const path = yield* Path.Path;
  const file = yield* Config.String("EXECUTOR_DESKTOP_DEV_UPDATE_CONFIG").pipe(Config.option);
  if (Option.isNone(file)) return false;
  autoUpdater.forceDevUpdateConfig = true;
  autoUpdater.updateConfigPath = path.resolve(file.value);
  return true;
});
