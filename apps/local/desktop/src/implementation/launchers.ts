import { createHash } from "node:crypto";
import { app, shell } from "electron";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { appLink } from "../contracts/installed-apps.ts";
import { type IconImages, icns, ico } from "./app-icons.ts";

export class LauncherFailed extends Schema.TaggedError<LauncherFailed>()("LauncherFailed", {}) {}

export interface LauncherRef {
  readonly server: string;
  readonly app: string;
}

export interface LauncherTarget extends LauncherRef {
  readonly name: string;
  readonly icons: IconImages;
}

export const appIdentity = (server: string, appId: string) =>
  createHash("sha256").update(`${server}\n${appId}`).digest("hex").slice(0, 16);

export const appUserModelId = (server: string, appId: string) =>
  `com.usefulsoftware.executor.app.${appIdentity(server, appId)}`;

const fileName = (name: string) =>
  name
    .replace(/[\p{Cc}<>:"/\\|?*]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^\.+/u, "")
    .slice(0, 80) || "App";

const xml = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character] ??
      character,
  );

const BundleIdentifier = /<key>CFBundleIdentifier<\/key>\s*<string>([A-Za-z0-9.-]+)<\/string>/u;

const executorBundleId = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const plist = path.resolve(app.getPath("exe"), "../../Info.plist");
  const text = yield* fs.readFileString(plist).pipe(Effect.option);
  return Option.flatMap(text, (value) => Option.fromNullishOr(BundleIdentifier.exec(value)?.[1]));
});

export const developmentArguments = () => (app.isPackaged ? [] : [app.getAppPath()]);

export const macLauncherDirectory = () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(app.getPath("home"), "Applications", "Executor Apps");
  });

export const windowsLauncherDirectory = () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(
      app.getPath("appData"),
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Executor Apps",
    );
  });

const BundleIdentifierOf = (text: string) => BundleIdentifier.exec(text)?.[1];

const managedDirectory = () =>
  process.platform === "darwin"
    ? macLauncherDirectory().pipe(Effect.map(Option.some))
    : process.platform === "win32"
      ? windowsLauncherDirectory().pipe(Effect.map(Option.some))
      : Effect.succeed(Option.none<string>());

const insideManaged = (directory: string, file: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const relative = path.relative(directory, path.resolve(file));
    return (
      relative !== "" &&
      !path.isAbsolute(relative) &&
      !relative.startsWith("..") &&
      !relative.includes(path.sep)
    );
  });

const ownedBy = (target: LauncherRef, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const expected = appUserModelId(target.server, target.app);
    if (process.platform === "darwin")
      return yield* fs.readFileString(path.join(file, "Contents", "Info.plist")).pipe(
        Effect.map((text) => BundleIdentifierOf(text) === expected),
        Effect.orElseSucceed(() => false),
      );
    return yield* Effect.try(() => shell.readShortcutLink(file).appUserModelId === expected).pipe(
      Effect.orElseSucceed(() => false),
    );
  });

const managedAndOwned = (target: LauncherRef, file: string) =>
  Effect.gen(function* () {
    const directory = yield* managedDirectory();
    if (Option.isNone(directory)) return false;
    if (!(yield* insideManaged(directory.value, file))) return false;
    return yield* ownedBy(target, file);
  });

const freeName = (target: LauncherTarget, directory: string, extension: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const identity = appIdentity(target.server, target.app);
    const base = fileName(target.name);
    for (const name of [base, `${base} ${identity.slice(0, 6)}`, `${base} ${identity}`]) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (!(yield* fs.exists(candidate)) || (yield* ownedBy(target, candidate))) return candidate;
    }
    return yield* new LauncherFailed();
  });

const macLauncher = (target: LauncherTarget, previous: Option.Option<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* macLauncherDirectory();
    yield* fs.makeDirectory(directory, { recursive: true });
    const identity = appIdentity(target.server, target.app);
    const bundle = yield* freeName(target, directory, ".app");
    const staging = path.join(directory, `.${identity}.staging.app`);
    yield* fs.remove(staging, { recursive: true, force: true });
    yield* fs.makeDirectory(path.join(staging, "Contents", "MacOS"), { recursive: true });
    yield* fs.makeDirectory(path.join(staging, "Contents", "Resources"), { recursive: true });
    const bundleId = yield* executorBundleId;
    const link = appLink(target.server, target.app);
    const executable = path.join(staging, "Contents", "MacOS", "launcher");
    yield* fs.copyFile(launcherStub(), executable);
    yield* fs.chmod(executable, 0o755);
    yield* fs.writeFile(
      path.join(staging, "Contents", "Resources", "icon.icns"),
      new Uint8Array(icns(target.icons)),
    );
    yield* fs.writeFileString(
      path.join(staging, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>${xml(target.name)}</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundleIdentifier</key><string>${appUserModelId(target.server, target.app)}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>${xml(target.name)}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>ExecutorAppLink</key><string>${xml(link)}</string>${Option.match(bundleId, {
    onNone: () => "",
    onSome: (id) => `\n  <key>ExecutorBundleIdentifier</key><string>${xml(id)}</string>`,
  })}
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`,
    );
    if (Option.isSome(previous) && previous.value !== bundle)
      yield* removeOwnedLauncher(target, previous.value);
    if (yield* fs.exists(bundle)) {
      if (!(yield* ownedBy(target, bundle))) return yield* new LauncherFailed();
      yield* fs.remove(bundle, { recursive: true });
    }
    yield* fs.rename(staging, bundle);
    return bundle;
  });

const windowsLauncher = (target: LauncherTarget, previous: Option.Option<string>, icons: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* windowsLauncherDirectory();
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.makeDirectory(icons, { recursive: true });
    const icon = path.join(icons, "icon.ico");
    yield* fs.writeFile(icon, new Uint8Array(ico(target.icons)));
    const shortcut = yield* freeName(target, directory, ".lnk");
    const written = shell.writeShortcutLink(shortcut, "create", {
      target: process.execPath,
      args: [...developmentArguments(), appLink(target.server, target.app)]
        .map((value) => `"${value}"`)
        .join(" "),
      description: target.name,
      icon,
      iconIndex: 0,
      appUserModelId: appUserModelId(target.server, target.app),
    });
    if (!written) return yield* new LauncherFailed();
    if (Option.isSome(previous) && previous.value !== shortcut)
      yield* removeOwnedLauncher(target, previous.value);
    return shortcut;
  });

const trash = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(file))) return;
    yield* Effect.tryPromise(() => shell.trashItem(file)).pipe(
      Effect.catch(() =>
        Effect.logWarning("Could not move an app launcher to the Trash").pipe(
          Effect.annotateLogs({ detail: file }),
        ),
      ),
    );
  });

const launcherStub = () =>
  app.isPackaged
    ? `${process.resourcesPath}/launcher-stub`
    : `${app.getAppPath()}/dist/launcher-stub`;

export const launcherOutdated = (launcher: string | null) =>
  Effect.gen(function* () {
    if (process.platform !== "darwin" || launcher === null) return false;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const head = yield* fs
      .readFile(path.join(launcher, "Contents", "MacOS", "launcher"))
      .pipe(Effect.orElseSucceed(() => new Uint8Array()));
    return head[0] === 0x23 && head[1] === 0x21;
  });

export const writeLauncher = (
  target: LauncherTarget,
  previous: Option.Option<string>,
  icons: string,
) =>
  (process.platform === "darwin"
    ? macLauncher(target, previous).pipe(Effect.map(Option.some))
    : process.platform === "win32"
      ? windowsLauncher(target, previous, icons).pipe(Effect.map(Option.some))
      : Effect.succeed(Option.none<string>())
  ).pipe(
    Effect.tapCause((cause) => Effect.logError("Could not write an app launcher", cause)),
    Effect.mapError(() => new LauncherFailed()),
  );

export const removeOwnedLauncher = (target: LauncherRef, launcher: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(launcher))) return;
    if (!(yield* managedAndOwned(target, launcher)))
      return yield* Effect.logWarning(
        "Left a launcher in place that Executor did not write for this app",
      ).pipe(Effect.annotateLogs({ detail: launcher }));
    if (process.platform === "darwin") return yield* trash(launcher);
    yield* fs.remove(launcher);
  }).pipe(
    Effect.catch(() =>
      Effect.logWarning("Could not remove an app launcher").pipe(
        Effect.annotateLogs({ detail: launcher }),
      ),
    ),
  );
