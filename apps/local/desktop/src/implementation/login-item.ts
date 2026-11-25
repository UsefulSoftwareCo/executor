import { homedir } from "node:os";
import { app } from "electron";
import { Effect, FileSystem, Path } from "effect";
import { developmentArguments } from "./launchers.ts";

export const loginArgument = "--executor-login";

export const launchedAtLogin = () =>
  process.argv.includes(loginArgument) ||
  (process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin);

const desktopEntryArgument = (value: string) =>
  `"${value.replace(/[\\"`$]/gu, (character) => `\\${character}`)}"`;

const linuxEntry = Effect.gen(function* () {
  const path = yield* Path.Path;
  const config = process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config");
  const name = app
    .getName()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return path.join(config, "autostart", `${name}-login.desktop`);
});

const linuxEntryText = () => {
  const executable = process.env.APPIMAGE ?? process.execPath;
  const command = [executable, ...developmentArguments()].map(desktopEntryArgument).join(" ");
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${app.getName()}`,
    "Comment=Opens the Executor apps you allowed to start at login",
    `Exec=${command} ${loginArgument}`,
    "NoDisplay=true",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
};

const windowsArgs = () => [...developmentArguments(), loginArgument];
export const setOpenAtLogin = (on: boolean) =>
  Effect.gen(function* () {
    if (process.platform === "linux") {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = yield* linuxEntry;
      if (!on) {
        yield* fs.remove(file, { force: true });
        return "done" as const;
      }
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, linuxEntryText());
      return "done" as const;
    }
    if (process.platform === "win32") {
      app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: windowsArgs() });
      return "done" as const;
    }
    app.setLoginItemSettings({ openAtLogin: on });
    return on && app.getLoginItemSettings().status === "requires-approval"
      ? ("requires-approval" as const)
      : ("done" as const);
  });
