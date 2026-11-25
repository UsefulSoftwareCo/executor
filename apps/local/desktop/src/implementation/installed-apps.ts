import { createHash, randomUUID } from "node:crypto";
import { release } from "node:os";
import {
  app as electronApp,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
  webContents,
  type DownloadItem,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type MessageBoxOptions,
  type Session,
  type WebContents,
} from "electron";
import {
  Cause,
  DateTime,
  Effect,
  FiberSet,
  FileSystem,
  Option,
  Path,
  Redacted,
  Result,
  Schema,
  Semaphore,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { LocalAuthApi } from "@executor-js/local-server/auth";
import {
  type DesktopAccount,
  type DesktopInstalledApp,
  desktopMaximumWindows,
  type DesktopPermission,
  desktopPermissions,
  type DesktopPermissionState,
  type DesktopWindowOptions,
  executorServerIdentityPath,
} from "../../../../../packages/apps/src/contracts/desktop.ts";
import { appIconRoute, appMenuBarRoute } from "../../../../../packages/apps/src/contracts/ui.ts";
import { type BridgeReply, desktopChannels } from "../contracts/bridge-channels.ts";
import { externalUrl } from "../contracts/desktop.ts";
import {
  AppCall,
  AppDetails,
  AppUnavailable,
  appLink,
  appSource,
  BridgeFailure,
  BridgeFailureJson,
  DesktopInvalidInput,
  DesktopPermissionDenied,
  DesktopUnavailable,
  HostCall,
  type InstalledApp,
  type NotificationEvent,
  maximumShortcuts,
  type MenuAnchor,
  parseAppLink,
  type PermissionDecision,
  permissionDetail,
  permissionPrompt,
  ServerIdentity,
  ShortcutTaken,
  shortcutProblem,
  SystemAudioBlocked,
  type WindowBounds,
} from "../contracts/installed-apps.ts";
import {
  appIconImages,
  badgeImage,
  dialogImage,
  type IconImages,
  iconSizes,
  type IconSize,
  trayImage,
} from "./app-icons.ts";
import {
  appIdentity,
  appUserModelId,
  developmentArguments,
  removeOwnedLauncher,
  launcherOutdated,
  writeLauncher,
} from "./launchers.ts";
import { makeInstalledStore } from "./installed-store.ts";
import { setOpenAtLogin } from "./login-item.ts";
import { appStatePage, appStateScheme, pageAction } from "./pages.ts";
import { hostedServerId } from "../contracts/servers.ts";

interface Running {
  readonly key: string;
  readonly server: string;
  readonly app: string;
  readonly installation: string;
  readonly generation: number;
  readonly session: Session;
  readonly label: string | undefined;
  readonly host: string;
  name: string;
  url: string;
  origin: string;
  menuBar: boolean;
  icon: boolean;
  window: BrowserWindow | undefined;
  popover: BrowserWindow | undefined;
  readonly windows: Map<string, BrowserWindow>;
  badge: number | null;
  tray: Tray | undefined;
  title: string | null;
  floating: boolean;
  refreshed: boolean;
  readonly shortcuts: Map<string, string>;
  readonly crashes: Array<number>;
}

export interface AppSource {
  readonly name: string;
  readonly url: string;
  readonly origin: string;
  readonly menuBar: boolean;
  readonly icon: boolean;
}

export interface ServerConnection {
  readonly server: string;
  readonly origin: string;
  readonly session: Session;
  readonly label: string | undefined;
  readonly host: string;
  readonly details: (app: string) => Effect.Effect<AppSource, AppUnavailable | DesktopUnavailable>;
  readonly signedIn: Effect.Effect<void, AppUnavailable | DesktopUnavailable>;
  readonly allows: (url: URL) => boolean;
}

export interface AccountHandler {
  readonly account: (server: string) => Effect.Effect<DesktopAccount, DesktopUnavailable>;
  readonly openMenu: (
    server: string,
    contents: WebContents,
    options: { readonly anchor: MenuAnchor; readonly settings: boolean },
  ) => Effect.Effect<"settings" | null, DesktopUnavailable>;
}

interface Connected extends ServerConnection {
  readonly generation: number;
}

interface AppTarget {
  readonly server: string;
  readonly app: string;
  readonly path?: string;
  readonly hidden?: boolean;
}

const permissionLabels: Record<DesktopPermission, string> = {
  menuBar: "Menu bar item",
  shortcuts: "Keyboard shortcuts",
  floating: "Keep above other windows",
  startAtLogin: "Start at login",
  microphone: "Microphone",
  camera: "Camera",
  systemAudio: "System audio",
  clipboardRead: "Read the clipboard",
  notifications: "Notifications",
};

const systemAudioSupported = () =>
  process.platform === "win32" ||
  (process.platform === "darwin" && Number(release().split(".")[0]) >= 22);
const onThisPlatform = (name: DesktopPermission) =>
  name !== "systemAudio" || systemAudioSupported();
const screenRecordingSettings =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const loginItemSettings = "x-apple.systempreferences:com.apple.LoginItems-Settings.extension";
const extraWindowDefault = { width: 800, height: 600 };

const mediaPermission = (type: string): DesktopPermission | undefined =>
  type === "audio" ? "microphone" : type === "video" ? "camera" : undefined;
const checkedPermission = (
  permission: string,
  mediaType: string | undefined,
): DesktopPermission | undefined => {
  switch (permission) {
    case "notifications":
      return "notifications";
    case "clipboard-read":
      return "clipboardRead";
    case "media":
      return mediaPermission(mediaType ?? "");
    default:
      return undefined;
  }
};
const requestedPermissions = (
  permission: string,
  mediaTypes: ReadonlyArray<string> | undefined,
): ReadonlyArray<DesktopPermission> => {
  switch (permission) {
    case "notifications":
      return ["notifications"];
    case "clipboard-read":
      return ["clipboardRead"];
    case "media": {
      const names = (mediaTypes ?? []).map(mediaPermission);
      const known = names.filter((name): name is DesktopPermission => name !== undefined);
      return known.length > 0 && known.length === names.length ? known : [];
    }
    default:
      return [];
  }
};
const systemMediaAccess = (name: DesktopPermission) =>
  process.platform === "darwin" && (name === "microphone" || name === "camera")
    ? Effect.promise(() => systemPreferences.askForMediaAccess(name))
    : Effect.succeed(true);

const popoverDefault = { width: 320, height: 400 };
const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
const background = () => (nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff");
const maximumIconCharacters = 256 * 1024;
const rendererReloads = 3;
const rendererReloadWindowMillis = 60_000;
const gestureMillis = 5_000;
const gestureInputs: ReadonlySet<string> = new Set([
  "mouseDown",
  "mouseUp",
  "rawKeyDown",
  "keyDown",
  "char",
  "gestureTap",
  "touchEnd",
]);

const serverIdentity = (session: Session, origin: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        session.fetch(`${origin}${executorServerIdentityPath}`, { redirect: "error", signal }),
      catch: () => new DesktopUnavailable(),
    });
    if (!response.ok) return yield* new DesktopUnavailable();
    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new DesktopUnavailable(),
    });
    const identity = yield* Schema.decodeUnknownEffect(ServerIdentity)(body).pipe(
      Effect.mapError(() => new DesktopUnavailable()),
    );
    return identity.serverId;
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.mapError(() => new DesktopUnavailable()),
  );

const sessionFetch =
  (session: Session): typeof globalThis.fetch =>
  (input, init) =>
    session.fetch(input instanceof URL ? input.href : input, init);

const exchangeSession = (session: Session, origin: string, pairing: string) =>
  Effect.gen(function* () {
    const token = new URLSearchParams(URL.parse(pairing)?.hash.slice(1) ?? "").get("pair");
    if (token === null) return yield* new DesktopUnavailable();
    const client = yield* HttpApiClient.make(LocalAuthApi, { baseUrl: origin });
    const signedIn = yield* client.auth.exchange({ payload: { token: Redacted.make(token) } });
    if (!signedIn.authenticated) return yield* new DesktopUnavailable();
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, sessionFetch(session)),
    Effect.provideService(FetchHttpClient.RequestInit, {
      credentials: "include",
      redirect: "error",
    }),
    Effect.timeout("10 seconds"),
    Effect.mapError(() => new DesktopUnavailable()),
  );

const showBox = (parent: BrowserWindow | null | undefined, box: MessageBoxOptions) =>
  Effect.promise(() =>
    parent !== null && parent !== undefined && !parent.isDestroyed() && parent.isVisible()
      ? dialog.showMessageBox(parent, box)
      : dialog.showMessageBox(box),
  );

const openOutside = (value: string) => {
  const url = externalUrl(value);
  if (url !== undefined) void shell.openExternal(url.href).catch(() => undefined);
};

const quoteArgument = (value: string) => `"${value}"`;

const pathOn = (origin: string, path: string) => {
  const url = URL.parse(path, origin);
  return url !== null && url.origin === origin && path.startsWith("/") ? url.href : null;
};

export const titleOf = (name: string, label: string | undefined) =>
  label === undefined ? name : `${name} — ${label}`;

export const makeInstalledApps = (options: {
  readonly session: Session;
  readonly profile: string;
  readonly changed: () => void;
  readonly signInAgain: (server: string) => void;
  readonly askToRunLocally: (message: string) => void;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const store = yield* makeInstalledStore(options.profile);
    const runPromise = yield* FiberSet.makeRuntimePromise<FileSystem.FileSystem | Path.Path>();
    const fork = yield* FiberSet.makeRuntime<FileSystem.FileSystem | Path.Path>();
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const promptLock = yield* Semaphore.make(1);
    const appLocks = new Map<string, Semaphore.Semaphore>();
    const appPreload = path.join(__dirname, "preload-app.cjs");

    const connections = new Map<string, Connected>();
    const problems = new Map<string, "signed-out">();
    const hosts = new Map<string, { readonly label: string | undefined; readonly host: string }>();
    const stateWindows = new Map<string, BrowserWindow>();
    const showing = new WeakSet<BrowserWindow>();
    let accountHandler: AccountHandler | undefined;
    let local: Connected | undefined;
    let lastLocal: string | undefined;
    let generation = 0;
    let resume:
      | {
          readonly server: string;
          readonly apps: ReadonlyArray<{ readonly app: string; readonly visible: boolean }>;
        }
      | undefined;
    const pending: Array<AppTarget> = [];
    const localWaiters = new Set<(server: string) => void>();
    const running = new Map<string, Running>();
    const owners = new Map<number, Running>();
    let baseMenu: Menu | undefined;
    let menuOwner: Running | undefined;

    const keyOf = (server: string, app: string) => `${server}/${app}`;
    const iconDirectory = (server: string, app: string) =>
      path.join(options.profile, "installed-apps", appIdentity(server, app));
    const serially = (key: string) => {
      const found = appLocks.get(key);
      const lock = found ?? Semaphore.makeUnsafe(1);
      if (found === undefined) appLocks.set(key, lock);
      return lock.withPermits(1);
    };

    const connectedTo = (server: string) =>
      Effect.suspend(() => {
        const found = connections.get(server);
        if (problems.has(server)) return Effect.fail(new AppUnavailable({ reason: "signed-out" }));
        return found === undefined
          ? Effect.fail(new AppUnavailable({ reason: "offline" }))
          : Effect.succeed(found);
      });

    const request = (session: Session, url: string) =>
      Effect.tryPromise({
        try: (signal) => session.fetch(url, { credentials: "include", redirect: "error", signal }),
        catch: () => new DesktopUnavailable(),
      });

    const localDetails = (origin: string) => (app: string) =>
      Effect.gen(function* () {
        const response = yield* request(
          options.session,
          `${origin}/dashboard/api/apps/${encodeURIComponent(app)}`,
        ).pipe(Effect.mapError(() => new AppUnavailable({ reason: "offline" })));
        if (response.status === 404) return yield* new AppUnavailable({ reason: "gone" });
        if (!response.ok) return yield* new AppUnavailable({ reason: "offline" });
        const body = yield* Effect.tryPromise({
          try: () => response.json(),
          catch: () => new AppUnavailable({ reason: "offline" }),
        });
        const decoded = yield* Schema.decodeUnknownEffect(AppDetails)(body).pipe(
          Effect.mapError(() => new AppUnavailable({ reason: "offline" })),
        );
        const ui = decoded.uiUrl === null ? undefined : externalUrl(decoded.uiUrl);
        if (ui === undefined || decoded.app.id !== app)
          return yield* new AppUnavailable({ reason: "gone" });
        return {
          name: decoded.app.name,
          url: ui.href,
          origin: ui.origin,
          menuBar: decoded.uiMenuBar,
          icon: decoded.uiIcon,
        };
      });

    const allowedNavigation = (server: string, origin: string, value: string) => {
      const url = URL.parse(value);
      if (url === null) return false;
      if (url.origin === origin) return true;
      const connection = connections.get(server);
      return connection !== undefined && url.origin === connection.origin && connection.allows(url);
    };
    const guard = (contents: WebContents, server: string, origin: () => string) => {
      let gestureAt = 0;
      contents.on("input-event", (_event, input) => {
        if (gestureInputs.has(input.type)) gestureAt = Date.now();
      });
      const outside = (url: string) => {
        const followsGesture = Date.now() - gestureAt < gestureMillis;
        gestureAt = 0;
        if (followsGesture) return openOutside(url);
        fork(
          Effect.logWarning(
            "Blocked an installed app from opening a page outside it without a click or key press",
          ),
        );
      };
      contents.on("will-navigate", (event) => {
        if (allowedNavigation(server, origin(), event.url)) return;
        event.preventDefault();
        outside(event.url);
      });
      contents.on("will-redirect", (event) => {
        if (!event.isMainFrame || allowedNavigation(server, origin(), event.url)) return;
        event.preventDefault();
      });
      contents.on("will-attach-webview", (event) => event.preventDefault());
      contents.setWindowOpenHandler(({ url }) => {
        outside(url);
        return { action: "deny" };
      });
    };

    const signIn = (
      connection: ServerConnection,
      target: { readonly url: string; readonly origin: string },
    ) =>
      Effect.acquireUseRelease(
        Effect.sync(
          () =>
            new BrowserWindow({
              show: false,
              webPreferences: {
                session: connection.session,
                javascript: false,
                images: false,
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
              },
            }),
        ),
        (window) =>
          Effect.gen(function* () {
            guard(window.webContents, connection.server, () => target.origin);
            yield* Effect.tryPromise(() => window.loadURL(target.url)).pipe(
              Effect.timeout("20 seconds"),
              Effect.ignore,
            );
          }),
        (window) => Effect.sync(() => window.destroy()),
      );

    const iconSource = (
      connection: ServerConnection,
      target: { readonly url: string; readonly origin: string },
    ) =>
      Effect.gen(function* () {
        const read = request(connection.session, new URL(appIconRoute, target.origin).href);
        let response = yield* read;
        if (response.status === 401) {
          yield* signIn(connection, target);
          response = yield* read;
        }
        const type = response.headers.get("content-type") ?? "";
        if (!response.ok || !type.startsWith("image/svg+xml"))
          return yield* new DesktopUnavailable();
        const text = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: () => new DesktopUnavailable(),
        });
        if (text.length > maximumIconCharacters) return yield* new DesktopUnavailable();
        return text;
      }).pipe(
        Effect.map(Option.some),
        Effect.catch(() =>
          Effect.logWarning("Could not read an app's icon; using its monogram").pipe(
            Effect.as(Option.none<string>()),
          ),
        ),
      );

    const iconKey = (name: string, svg: Option.Option<string>) =>
      Option.match(svg, {
        onNone: () => `monogram:${name}`,
        onSome: (text) => `svg:${createHash("sha256").update(text).digest("hex")}`,
      });

    const iconFile = (directory: string, size: IconSize) =>
      path.join(directory, `icon-${size}.png`);
    const writeIcons = (directory: string, images: IconImages) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* Effect.forEach(
          iconSizes,
          (size) => fs.writeFile(iconFile(directory, size), new Uint8Array(images[size])),
          { discard: true },
        );
      });
    const readIcons = (server: string, app: string) =>
      Effect.gen(function* () {
        const directory = iconDirectory(server, app);
        const read = (size: IconSize) =>
          fs.readFile(iconFile(directory, size)).pipe(Effect.map((bytes) => Buffer.from(bytes)));
        const images: IconImages = {
          16: yield* read(16),
          32: yield* read(32),
          48: yield* read(48),
          64: yield* read(64),
          128: yield* read(128),
          256: yield* read(256),
          512: yield* read(512),
          1024: yield* read(1024),
        };
        return images;
      }).pipe(Effect.option);

    const recordOf = (current: Running) =>
      Option.filter(
        store.peek(current.server, current.app),
        (record) => record.installation === current.installation,
      );
    const live = (current: Running) =>
      running.get(current.key) === current &&
      connections.get(current.server)?.generation === current.generation &&
      Option.isSome(recordOf(current));
    const stateOf = (current: Running, name: DesktopPermission): DesktopPermissionState => {
      const record = recordOf(current);
      if (
        Option.isNone(record) ||
        record.value.origin !== current.origin ||
        (name === "menuBar" && !current.menuBar) ||
        !onThisPlatform(name)
      )
        return "unavailable";
      return record.value.permissions[name] ?? "prompt";
    };
    const granted = (current: Running, name: DesktopPermission) =>
      live(current) && stateOf(current, name) === "granted";
    const refusal = (current: Running, name: DesktopPermission) =>
      live(current) ? new DesktopPermissionDenied({ permission: name }) : new DesktopUnavailable();

    const ownerOf = (contents: WebContents) => {
      const current = owners.get(contents.id);
      return current !== undefined && live(current) ? current : undefined;
    };
    const own = (current: Running, contents: WebContents) => {
      owners.set(contents.id, current);
      const id = contents.id;
      contents.once("destroyed", () => {
        if (owners.get(id) === current) owners.delete(id);
      });
    };

    const restoreBaseMenu = () => {
      menuOwner = undefined;
      if (baseMenu !== undefined) Menu.setApplicationMenu(baseMenu);
    };

    const clearShortcuts = (current: Running) => {
      for (const accelerator of current.shortcuts.values()) globalShortcut.unregister(accelerator);
      current.shortcuts.clear();
    };
    const stopFloating = (current: Running) => {
      current.floating = false;
      for (const window of [current.window, ...current.windows.values()])
        if (window !== undefined && !window.isDestroyed()) window.setAlwaysOnTop(false);
    };

    const windowsOf = (current: Running) =>
      [current.window, current.popover, ...current.windows.values()].filter(
        (window): window is BrowserWindow => window !== undefined && !window.isDestroyed(),
      );

    const reportFocus = (window: BrowserWindow) => {
      const report = (type: "focus" | "blur") => () => {
        if (!window.isDestroyed()) window.webContents.send(desktopChannels.appWindowEvent, type);
      };
      window.on("focus", report("focus"));
      window.on("blur", report("blur"));
    };

    const bringForward = (window: BrowserWindow) => {
      if (window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      if (process.platform === "darwin") electronApp.focus({ steal: true });
      if (process.platform === "win32" && !window.isAlwaysOnTop()) {
        window.setAlwaysOnTop(true);
        window.focus();
        window.setAlwaysOnTop(false);
      }
      window.moveTop();
      window.focus();
    };

    const navigate = (window: BrowserWindow, url: string) => {
      if (window.webContents.getURL() !== url) void window.loadURL(url).catch(() => undefined);
    };

    const overlays = new Map<string, Electron.NativeImage>();
    const overlayOf = (text: string) => {
      const found = overlays.get(text);
      if (found !== undefined) return Effect.succeed(found);
      return badgeImage(text).pipe(
        Effect.tap((image) => Effect.sync(() => overlays.set(text, image))),
      );
    };
    const setOverlay = (current: Running) =>
      Effect.gen(function* () {
        if (process.platform !== "win32") return;
        const count = current.badge;
        const image = count === null ? null : yield* overlayOf(count > 99 ? "99+" : String(count));
        if (current.badge !== count) return;
        for (const window of [current.window, ...current.windows.values()])
          if (window !== undefined && !window.isDestroyed())
            window.setOverlayIcon(image, count === null ? "" : `${current.name}: ${count}`);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not draw an installed app's badge", cause),
        ),
      );
    const applyBadges = () => {
      if (process.platform === "win32") return;
      let total = 0;
      for (const current of running.values()) total += current.badge ?? 0;
      electronApp.setBadgeCount(total);
    };
    const setBadge = (current: Running, count: number | null) => {
      current.badge = count === 0 ? null : count;
      applyBadges();
      fork(setOverlay(current));
    };

    const end = (current: Running) => {
      if (running.get(current.key) !== current) return;
      running.delete(current.key);
      const window = current.window;
      if (window !== undefined && !window.isDestroyed() && window.isVisible())
        saveBounds(current, window);
      clearShortcuts(current);
      current.tray?.destroy();
      current.tray = undefined;
      current.badge = null;
      applyBadges();
      for (const [id, owner] of owners) {
        if (owner !== current) continue;
        owners.delete(id);
        const contents = webContents.fromId(id);
        const owned = contents === undefined ? null : BrowserWindow.fromWebContents(contents);
        if (owned !== null && !owned.isDestroyed()) owned.destroy();
      }
      for (const window of [current.window, current.popover])
        if (window !== undefined && !window.isDestroyed()) window.destroy();
      current.window = undefined;
      current.popover = undefined;
      current.windows.clear();
      if (menuOwner === current) restoreBaseMenu();
      options.changed();
      fork(
        Effect.logInfo("Closed an installed app").pipe(Effect.annotateLogs({ app: current.app })),
      );
    };

    const writeDecision = (
      server: string,
      app: string,
      name: DesktopPermission,
      setting: PermissionDecision | "prompt",
      expected?: { readonly installation: string; readonly revision: number },
    ) => {
      let applied = false;
      return store
        .update(server, app, (found) => {
          if (Option.isNone(found)) return found;
          const record = found.value;
          if (
            expected !== undefined &&
            (record.installation !== expected.installation || record.revision !== expected.revision)
          )
            return found;
          const permissions: { [Name in DesktopPermission]?: PermissionDecision } = {
            ...record.permissions,
          };
          if (setting === "prompt") delete permissions[name];
          else permissions[name] = setting;
          applied = true;
          return Option.some({ ...record, permissions, revision: record.revision + 1 });
        })
        .pipe(
          Effect.map(() => applied),
          Effect.tap((changed) =>
            changed
              ? Effect.logInfo("Changed an installed app's permission").pipe(
                  Effect.annotateLogs({ app, permission: name, state: setting }),
                )
              : Effect.logInfo(
                  "Ignored a permission answer that a newer change or removal replaced",
                ).pipe(Effect.annotateLogs({ app, permission: name })),
          ),
        );
    };

    const shownWhenPending = (window: BrowserWindow | undefined) =>
      Effect.callback<void>((resume) => {
        if (window === undefined || window.isDestroyed() || !showing.has(window))
          return resume(Effect.void);
        const contents = window.webContents;
        const done = () => resume(Effect.void);
        window.once("show", done);
        window.once("closed", done);
        contents.once("did-fail-load", done);
        contents.once("render-process-gone", done);
        return Effect.sync(() => {
          window.removeListener("show", done);
          window.removeListener("closed", done);
          if (contents.isDestroyed()) return;
          contents.removeListener("did-fail-load", done);
          contents.removeListener("render-process-gone", done);
        });
      });

    const dashboardServer = (contents: WebContents) => {
      for (const connection of connections.values())
        if (
          contents.session === connection.session &&
          URL.parse(contents.getURL())?.origin === connection.origin
        )
          return connection.server;
      return undefined;
    };

    const installedChanged = (server: string, app: string) => {
      for (const contents of webContents.getAllWebContents())
        if (!contents.isDestroyed() && dashboardServer(contents) === server)
          contents.send(desktopChannels.hostInstalled, app);
    };

    const ensure = (current: Running, name: DesktopPermission) =>
      promptLock.withPermits(1)(
        Effect.gen(function* () {
          if (!live(current)) return yield* new DesktopUnavailable();
          const state = stateOf(current, name);
          if (state === "granted") return;
          if (state === "unavailable") return yield* new DesktopUnavailable();
          if (state === "denied") return yield* new DesktopPermissionDenied({ permission: name });
          const record = recordOf(current);
          if (Option.isNone(record)) return yield* new DesktopUnavailable();
          const expected = { installation: current.installation, revision: record.value.revision };
          const images = yield* readIcons(current.server, current.app);
          yield* shownWhenPending(current.window);
          const answer = yield* showBox(current.window, {
            type: "none",
            title: `${current.name} permission`,
            message: `${appSource(current.name, current.label, current.host)} ${permissionPrompt(name, process.platform)}`,
            detail: permissionDetail(name, process.platform),
            buttons: ["Allow", "Don't Allow"],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
            ...Option.match(images, {
              onNone: () => ({}),
              onSome: (value) => ({ icon: dialogImage(value) }),
            }),
          });
          yield* writeDecision(
            current.server,
            current.app,
            name,
            answer.response === 0 ? "granted" : "denied",
            expected,
          );
          if (live(current)) refreshMenus(current);
          if (name === "startAtLogin") yield* syncLoginItem;
          if (!granted(current, name)) return yield* refusal(current, name);
        }),
      );

    const changePermission = (current: Running, name: DesktopPermission, on: boolean) =>
      fork(
        setPermission(current.server, current.app, name, on ? "granted" : "denied").pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not change an installed app's permission", cause),
          ),
        ),
      );

    const permissionItems = (current: Running): Array<MenuItemConstructorOptions> => {
      const items: Array<MenuItemConstructorOptions> = desktopPermissions
        .filter((name) => (name !== "menuBar" || current.menuBar) && onThisPlatform(name))
        .map((name) => {
          const on = stateOf(current, name) === "granted";
          return {
            label: permissionLabels[name],
            type: "checkbox" as const,
            checked: on,
            click: () => changePermission(current, name, !on),
          };
        });
      const shortcuts = [...current.shortcuts.values()];
      if (shortcuts.length === 0) return items;
      return [
        ...items,
        { type: "separator" },
        { label: "Shortcuts in use", enabled: false },
        ...shortcuts.map((accelerator) => ({ label: accelerator, enabled: false })),
      ];
    };

    const trayMenu = (current: Running) =>
      Menu.buildFromTemplate([
        { label: `Open ${current.name}`, click: () => fork(openLogged(current)) },
        {
          label: "Reload",
          click: () => {
            current.window?.webContents.reload();
            current.popover?.webContents.reload();
          },
        },
        { label: "Permissions", submenu: permissionItems(current) },
        {
          label: "Remove from menu bar",
          click: () => changePermission(current, "menuBar", false),
        },
        { type: "separator" },
        { label: `Quit ${current.name}`, click: () => end(current) },
      ]);

    const windowMenu = (current: Running) =>
      Menu.buildFromTemplate([
        ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
        {
          label: current.name,
          submenu: [
            {
              label: "Reload",
              accelerator: "CmdOrCtrl+R",
              click: () => current.window?.webContents.reload(),
            },
            { label: "Permissions", submenu: permissionItems(current) },
            ...(current.tray === undefined
              ? []
              : [
                  {
                    label: "Remove from menu bar",
                    click: () => changePermission(current, "menuBar", false),
                  },
                ]),
            { type: "separator" },
            { label: `Remove ${current.name}…`, click: () => fork(confirmUninstall(current)) },
            { type: "separator" },
            { role: "close" },
          ],
        },
        { role: "editMenu" },
        { role: "windowMenu" },
      ]);

    const refreshMenus = (current: Running) => {
      if (process.platform !== "darwin")
        for (const window of [current.window, ...current.windows.values()])
          if (window !== undefined && !window.isDestroyed()) window.setMenu(windowMenu(current));
      if (process.platform === "darwin" && menuOwner === current)
        Menu.setApplicationMenu(windowMenu(current));
      if (current.tray !== undefined && process.platform !== "darwin")
        current.tray.setContextMenu(trayMenu(current));
    };

    const removeTray = (current: Running) => {
      if (current.tray === undefined) return;
      current.tray.destroy();
      current.tray = undefined;
      if (current.popover !== undefined && !current.popover.isDestroyed())
        current.popover.destroy();
      current.popover = undefined;
      fork(
        Effect.logInfo("Removed an installed app's menu-bar item").pipe(
          Effect.annotateLogs({ app: current.app }),
        ),
      );
      const window = current.window;
      if (window === undefined) end(current);
      else if (!window.isDestroyed() && !window.isVisible()) window.destroy();
      else refreshMenus(current);
    };

    const trayTitle = (current: Running) => current.title ?? current.name;
    const trayTooltip = (current: Running) => titleOf(trayTitle(current), current.label);
    const showTray = (current: Running) =>
      Effect.gen(function* () {
        if (!granted(current, "menuBar")) return removeTray(current);
        const images = yield* readIcons(current.server, current.app);
        if (!granted(current, "menuBar")) return removeTray(current);
        const image = Option.match(images, {
          onNone: () => nativeImage.createEmpty(),
          onSome: trayImage,
        });
        let tray = current.tray;
        if (tray === undefined) {
          const created = new Tray(image);
          tray = created;
          current.tray = created;
          created.on("click", () => togglePopover(current));
          if (process.platform === "darwin")
            created.on("right-click", () => created.popUpContextMenu(trayMenu(current)));
        } else tray.setImage(image);
        tray.setToolTip(trayTooltip(current));
        if (process.platform === "darwin") tray.setTitle(trayTitle(current));
        refreshMenus(current);
        yield* Effect.logInfo("Showing an installed app's menu-bar item").pipe(
          Effect.annotateLogs({ app: current.app }),
        );
      });

    const crashed = (
      current: Running,
      window: BrowserWindow,
      details: Electron.RenderProcessGoneDetails,
    ) => {
      fork(
        Effect.logError("An installed app's renderer exited", details).pipe(
          Effect.annotateLogs({ app: current.app }),
        ),
      );
      if (details.reason === "clean-exit" || window.isDestroyed()) return;
      if (running.get(current.key) !== current) return;
      clearShortcuts(current);
      stopFloating(current);
      if (current.title !== null) {
        current.title = null;
        if (current.tray !== undefined) fork(showTray(current));
      }
      refreshMenus(current);
      const now = Date.now();
      current.crashes.splice(
        0,
        current.crashes.length,
        ...current.crashes.filter((at) => now - at < rendererReloadWindowMillis),
        now,
      );
      if (current.crashes.length > rendererReloads) {
        fork(
          Effect.logError("Ended an installed app whose window kept crashing").pipe(
            Effect.annotateLogs({ app: current.app }),
          ),
        );
        return end(current);
      }
      if (window === current.popover) {
        current.popover = undefined;
        return window.destroy();
      }
      window.webContents.reload();
    };

    const placePopover = (current: Running, popover: BrowserWindow) => {
      const [width = popoverDefault.width, height = popoverDefault.height] = popover.getSize();
      const tray = current.tray?.getBounds();
      const anchor =
        tray !== undefined && tray.width > 0
          ? tray
          : { ...screen.getCursorScreenPoint(), width: 0, height: 0 };
      const area = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y }).workArea;
      const below = anchor.y < area.y + area.height / 2;
      const x = clamp(
        Math.round(anchor.x + anchor.width / 2 - width / 2),
        area.x,
        area.x + area.width - width,
      );
      const y = clamp(
        below ? anchor.y + anchor.height + 4 : anchor.y - height - 4,
        area.y,
        area.y + area.height - height,
      );
      popover.setPosition(x, y);
    };

    const sizePopover = (current: Running, popover: BrowserWindow) =>
      Effect.gen(function* () {
        if (
          popover.isDestroyed() ||
          URL.parse(popover.webContents.getURL())?.origin !== current.origin
        )
          return;
        const content = yield* Effect.tryPromise(() =>
          popover.webContents.executeJavaScript(
            `document.querySelector('meta[name="executor:menubar"]')?.getAttribute("content") ?? ""`,
          ),
        ).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.String)),
          Effect.orElseSucceed(() => ""),
        );
        const width = Number(
          /(?:^|[\s,])width\s*=\s*(\d{1,4})/u.exec(content)?.[1] ?? popoverDefault.width,
        );
        const height = Number(
          /(?:^|[\s,])height\s*=\s*(\d{1,4})/u.exec(content)?.[1] ?? popoverDefault.height,
        );
        if (popover.isDestroyed()) return;
        popover.setResizable(true);
        popover.setSize(clamp(width, 200, 640), clamp(height, 120, 720));
        popover.setResizable(false);
        if (popover.isVisible()) placePopover(current, popover);
      });

    const appPreferences = (current: Running): Electron.WebPreferences => ({
      session: current.session,
      preload: appPreload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    });

    const togglePopover = (current: Running) => {
      if (!live(current)) return;
      const existing = current.popover;
      if (existing !== undefined && !existing.isDestroyed() && existing.isVisible())
        return existing.hide();
      const popover =
        existing !== undefined && !existing.isDestroyed() ? existing : createPopover(current);
      placePopover(current, popover);
      popover.show();
      popover.focus();
    };

    const createPopover = (current: Running) => {
      const popover = new BrowserWindow({
        ...popoverDefault,
        show: false,
        frame: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        title: titleOf(current.name, current.label),
        backgroundColor: background(),
        webPreferences: appPreferences(current),
      });
      current.popover = popover;
      popover.on("page-title-updated", (event) => event.preventDefault());
      own(current, popover.webContents);
      guard(popover.webContents, current.server, () => current.origin);
      popover.webContents.on("render-process-gone", (_event, details) =>
        crashed(current, popover, details),
      );
      reportFocus(popover);
      popover.on("blur", () => {
        if (!popover.isDestroyed()) popover.hide();
      });
      popover.once("closed", () => {
        if (current.popover === popover) current.popover = undefined;
      });
      popover.webContents.on("did-finish-load", () => fork(sizePopover(current, popover)));
      fork(
        Effect.tryPromise(() =>
          popover.loadURL(new URL(appMenuBarRoute, current.origin).href),
        ).pipe(
          Effect.catch(() => Effect.logWarning("Could not load an installed app's menu-bar page")),
        ),
      );
      return popover;
    };

    const visibleBounds = (bounds: WindowBounds | undefined) =>
      bounds !== undefined &&
      screen
        .getAllDisplays()
        .some(
          ({ workArea }) =>
            bounds.x < workArea.x + workArea.width &&
            bounds.x + bounds.width > workArea.x &&
            bounds.y < workArea.y + workArea.height &&
            bounds.y + bounds.height > workArea.y,
        )
        ? { x: bounds.x, y: bounds.y }
        : {};

    const saveBounds = (current: Running, window: BrowserWindow) => {
      const { x, y, width, height } = window.getNormalBounds();
      fork(
        store
          .update(current.server, current.app, (record) =>
            Option.map(
              Option.filter(record, (value) => value.installation === current.installation),
              (value): InstalledApp => ({
                ...value,
                bounds: {
                  x: Math.round(x),
                  y: Math.round(y),
                  width: Math.round(width),
                  height: Math.round(height),
                },
              }),
            ),
          )
          .pipe(Effect.ignore),
      );
    };

    const appWindowChrome = (current: Running, window: BrowserWindow) => {
      own(current, window.webContents);
      guard(window.webContents, current.server, () => current.origin);
      window.webContents.on("render-process-gone", (_event, details) =>
        crashed(current, window, details),
      );
      window.on("page-title-updated", (event) => event.preventDefault());
      reportFocus(window);
      if (process.platform === "win32")
        window.setAppDetails({
          appId: appUserModelId(current.server, current.app),
          appIconPath: path.join(iconDirectory(current.server, current.app), "icon.ico"),
          relaunchCommand: [
            process.execPath,
            ...developmentArguments(),
            appLink(current.server, current.app),
          ]
            .map(quoteArgument)
            .join(" "),
          relaunchDisplayName: current.name,
        });
      if (process.platform === "darwin") {
        window.on("focus", () => {
          menuOwner = current;
          Menu.setApplicationMenu(windowMenu(current));
        });
        window.on("blur", () => {
          if (menuOwner === current) restoreBaseMenu();
        });
      } else window.setMenu(windowMenu(current));
      if (current.badge !== null) fork(setOverlay(current));
    };

    const createExtraWindow = (
      current: Running,
      key: string,
      url: string,
      options: DesktopWindowOptions,
    ) => {
      const window = new BrowserWindow({
        width: options.width ?? extraWindowDefault.width,
        height: options.height ?? extraWindowDefault.height,
        minWidth: 200,
        minHeight: 120,
        title: titleOf(current.name, current.label),
        show: false,
        autoHideMenuBar: true,
        backgroundColor: background(),
        webPreferences: appPreferences(current),
      });
      current.windows.set(key, window);
      appWindowChrome(current, window);
      if (options.floating === true) window.setAlwaysOnTop(true, "floating");
      window.once("ready-to-show", () => bringForward(window));
      window.once("closed", () => {
        if (current.windows.get(key) === window) current.windows.delete(key);
      });
      fork(
        Effect.tryPromise(() => window.loadURL(url)).pipe(
          Effect.catch(() => Effect.logWarning("Could not load an installed app's other window")),
        ),
      );
    };

    const createWindow = (
      current: Running,
      record: InstalledApp,
      images: Option.Option<IconImages>,
      show: boolean,
      url: string,
    ) => {
      const bounds = record.bounds;
      const window = new BrowserWindow({
        width: bounds?.width ?? 1024,
        height: bounds?.height ?? 720,
        ...visibleBounds(bounds),
        minWidth: 360,
        minHeight: 240,
        title: titleOf(current.name, current.label),
        show: false,
        autoHideMenuBar: true,
        backgroundColor: background(),
        ...(process.platform === "darwin" || Option.isNone(images)
          ? {}
          : { icon: nativeImage.createFromBuffer(images.value[256]) }),
        webPreferences: appPreferences(current),
      });
      current.window = window;
      appWindowChrome(current, window);
      if (show) {
        showing.add(window);
        window.once("show", () => showing.delete(window));
      }
      window.once("ready-to-show", () => {
        if (show && !window.isDestroyed()) window.show();
      });
      window.on("close", (event) => {
        saveBounds(current, window);
        if (current.tray !== undefined && running.get(current.key) === current) {
          event.preventDefault();
          window.hide();
        }
      });
      window.once("closed", () => {
        if (current.window === window) current.window = undefined;
        if (current.tray === undefined) end(current);
      });
      window.webContents.on("did-finish-load", () => {
        if (current.refreshed || URL.parse(window.webContents.getURL())?.origin !== current.origin)
          return;
        current.refreshed = true;
        fork(refresh(current));
      });
      fork(
        Effect.tryPromise(() => window.loadURL(url)).pipe(
          Effect.catch(() => Effect.logWarning("Could not load an installed app's window")),
        ),
      );
    };

    const refresh = (current: Running) =>
      Effect.gen(function* () {
        const connection = yield* connectedTo(current.server);
        const svg = current.icon ? yield* iconSource(connection, current) : Option.none<string>();
        const icon = iconKey(current.name, svg);
        const updated = yield* serially(current.key)(
          Effect.gen(function* () {
            const record = yield* store.get(current.server, current.app);
            if (Option.isNone(record) || record.value.installation !== current.installation)
              return Option.none<IconImages>();
            const saved = yield* readIcons(current.server, current.app);
            if (
              record.value.name === current.name &&
              record.value.icon === icon &&
              Option.isSome(saved) &&
              !(yield* launcherOutdated(record.value.launcher))
            )
              return Option.none<IconImages>();
            const images = yield* appIconImages(current.name, Option.getOrUndefined(svg));
            const directory = iconDirectory(current.server, current.app);
            yield* writeIcons(directory, images);
            const launcher = yield* writeLauncher(
              { server: current.server, app: current.app, name: current.name, icons: images },
              Option.fromNullOr(record.value.launcher),
              directory,
            );
            yield* store.update(current.server, current.app, (value) =>
              Option.map(
                Option.filter(value, (found) => found.installation === current.installation),
                (found): InstalledApp => ({
                  ...found,
                  name: current.name,
                  icon,
                  launcher: Option.getOrNull(launcher),
                }),
              ),
            );
            return Option.some(images);
          }),
        );
        if (Option.isNone(updated)) return;
        if (current.tray !== undefined) yield* showTray(current);
        const window = current.window;
        if (window !== undefined && !window.isDestroyed() && process.platform !== "darwin")
          window.setIcon(nativeImage.createFromBuffer(updated.value[256]));
        yield* Effect.logInfo("Updated an installed app's launcher").pipe(
          Effect.annotateLogs({ app: current.app }),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not update an installed app's launcher", cause),
        ),
      );

    const rebind = (record: InstalledApp, origin: string) =>
      Effect.gen(function* () {
        yield* store.update(record.server, record.app, (found) =>
          Option.map(
            Option.filter(found, (value) => value.installation === record.installation),
            (value): InstalledApp => ({
              ...value,
              origin,
              permissions: {},
              revision: value.revision + 1,
            }),
          ),
        );
        yield* Effect.logWarning(
          "An installed app now opens from another address, so its permissions were cleared",
        ).pipe(Effect.annotateLogs({ app: record.app }));
        if (record.permissions.startAtLogin === "granted") yield* syncLoginItem;
      });

    const openApp = (target: AppTarget) =>
      Effect.gen(function* () {
        const { server, app } = target;
        const show = target.hidden !== true;
        if (!connections.has(server) && !problems.has(server) && local === undefined) {
          const record = yield* store.get(server, app);
          if (Option.isNone(record)) return yield* new DesktopUnavailable();
          if (server === lastLocal) return yield* new AppUnavailable({ reason: "offline" });
          pending.push(target);
          if (show && !hostedServerId(server))
            options.askToRunLocally(
              `${record.value.name} is an app on this computer's Executor. Run locally to open it.`,
            );
          return;
        }
        const key = keyOf(server, app);
        const current = yield* serially(key)(
          Effect.gen(function* () {
            const record = yield* store.get(server, app);
            if (Option.isNone(record)) return yield* new DesktopUnavailable();
            const connected = yield* connectedTo(server);
            const details = yield* connected.details(app);
            yield* connected.signedIn;
            const images = yield* readIcons(server, app);
            if (connections.get(server) !== connected) return yield* new DesktopUnavailable();
            if (record.value.origin !== details.origin) yield* rebind(record.value, details.origin);
            const existing = running.get(key);
            const reused =
              existing !== undefined &&
              live(existing) &&
              existing.installation === record.value.installation &&
              existing.origin === details.origin
                ? existing
                : undefined;
            if (existing !== undefined && reused === undefined) end(existing);
            const current: Running = reused ?? {
              key,
              server,
              app,
              installation: record.value.installation,
              generation: connected.generation,
              session: connected.session,
              label: connected.label,
              host: connected.host,
              ...details,
              window: undefined,
              popover: undefined,
              tray: undefined,
              windows: new Map(),
              badge: null,
              title: null,
              floating: false,
              refreshed: false,
              shortcuts: new Map(),
              crashes: [],
            };
            Object.assign(current, details);
            running.set(key, current);
            const destination =
              target.path === undefined ? undefined : pathOn(current.origin, target.path);
            if (destination === null) return yield* new DesktopUnavailable();
            const window = current.window;
            if (window === undefined || window.isDestroyed())
              createWindow(current, record.value, images, show, destination ?? current.url);
            else {
              window.setTitle(titleOf(current.name, current.label));
              if (destination !== undefined) navigate(window, destination);
              if (show) bringForward(window);
            }
            refreshMenus(current);
            options.changed();
            return current;
          }),
        );
        closeStateWindow({ server, app });
        yield* Effect.logInfo("Opened an installed app").pipe(Effect.annotateLogs({ app }));
        if (current.menuBar) {
          if (stateOf(current, "menuBar") === "prompt")
            yield* ensure(current, "menuBar").pipe(Effect.ignore);
          yield* showTray(current);
        } else removeTray(current);
      });

    const closeStateWindow = (target: AppTarget) => {
      const key = keyOf(target.server, target.app);
      const window = stateWindows.get(key);
      stateWindows.delete(key);
      if (window !== undefined && !window.isDestroyed()) window.destroy();
    };

    const showStateWindow = (target: AppTarget, record: InstalledApp, reason: AppUnavailable) => {
      const key = keyOf(target.server, target.app);
      const where = hosts.get(target.server);
      const page = appStatePage({
        state: reason.reason,
        name: record.name,
        team: where?.label,
        host: where?.host ?? "this computer's Executor",
      });
      const existing = stateWindows.get(key);
      const window =
        existing !== undefined && !existing.isDestroyed()
          ? existing
          : new BrowserWindow({
              width: 520,
              height: 360,
              ...visibleBounds(record.bounds),
              minWidth: 360,
              minHeight: 240,
              title: titleOf(record.name, where?.label),
              show: false,
              autoHideMenuBar: true,
              backgroundColor: background(),
              webPreferences: {
                session: session.fromPartition("executor-desktop-settings"),
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                webSecurity: true,
              },
            });
      if (window !== existing) {
        stateWindows.set(key, window);
        window.once("closed", () => {
          if (stateWindows.get(key) === window) stateWindows.delete(key);
        });
        window.on("page-title-updated", (event) => event.preventDefault());
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-attach-webview", (event) => event.preventDefault());
        window.once("ready-to-show", () => {
          if (!window.isDestroyed()) window.show();
        });
        window.webContents.on("will-navigate", (event, url) => {
          event.preventDefault();
          const chosen = pageAction(appStateScheme, url);
          switch (chosen?.action) {
            case "retry":
              return fork(openLogged(target));
            case "uninstall":
              closeStateWindow(target);
              return fork(
                uninstall(target.server, target.app).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Could not remove an installed app", cause),
                  ),
                ),
              );
            case "sign-in":
              closeStateWindow(target);
              return options.signInAgain(target.server);
            default:
              return closeStateWindow(target);
          }
        });
      } else {
        window.show();
        window.focus();
      }
      void window.loadURL(page).catch(() => undefined);
    };

    const couldNotOpen = (target: AppTarget, cause: Cause.Cause<unknown>) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("Could not open an installed app", cause).pipe(
          Effect.annotateLogs({ app: target.app }),
        );
        if (target.hidden === true) return;
        const reason = Option.filter(Cause.findErrorOption(cause), Schema.is(AppUnavailable));
        const record = store.peek(target.server, target.app);
        if (Option.isSome(reason) && Option.isSome(record))
          return showStateWindow(target, record.value, reason.value);
        yield* showBox(undefined, {
          type: "warning",
          message: "Executor could not open this app.",
          detail:
            "It may have been removed from this computer, or its Executor server is not running.",
        });
      });

    const openLogged = (target: AppTarget) =>
      openApp(target).pipe(Effect.catchCause((cause) => couldNotOpen(target, cause)));

    const notifications = new Map<string, { readonly shown: Notification; readonly tag: string }>();
    const showNotification = (
      current: Running,
      page: WebContents,
      request: {
        readonly id: string;
        readonly title: string;
        readonly body: string;
        readonly tag: string;
        readonly silent: boolean;
        readonly path: string | null;
      },
      images: Option.Option<IconImages>,
    ) => {
      const key = `${current.key} ${request.id}`;
      if (request.tag !== "")
        for (const [other, entry] of notifications)
          if (other.startsWith(`${current.key} `) && entry.tag === request.tag) entry.shown.close();
      const shown = new Notification({
        id: request.id,
        title: request.title,
        body: request.body,
        silent: request.silent,
        ...Option.match(images, {
          onNone: () => ({}),
          onSome: (value) => ({ icon: nativeImage.createFromBuffer(value[256]) }),
        }),
      });
      const tell = (type: NotificationEvent) => {
        if (!page.isDestroyed()) page.send(desktopChannels.appNotification, request.id, type);
      };
      const forget = () => {
        if (notifications.get(key)?.shown === shown) notifications.delete(key);
      };
      notifications.set(key, { shown, tag: request.tag });
      shown.on("show", () => tell("show"));
      shown.on("click", () => {
        tell("click");
        if (live(current) && granted(current, "notifications"))
          showAt(current, request.path ?? undefined);
      });
      shown.on("close", () => {
        forget();
        tell("close");
      });
      shown.on("failed", (_event, error) => {
        forget();
        tell("error");
        fork(
          Effect.logWarning("Could not show an installed app's notification").pipe(
            Effect.annotateLogs({ app: current.app, error }),
          ),
        );
      });
      shown.show();
    };

    const showAt = (current: Running, path: string | undefined) => {
      const window = current.window;
      if (window === undefined || window.isDestroyed())
        return fork(
          openLogged({
            server: current.server,
            app: current.app,
            ...(path === undefined ? {} : { path }),
          }),
        );
      const destination = path === undefined ? undefined : pathOn(current.origin, path);
      if (destination === null) return;
      if (destination !== undefined) navigate(window, destination);
      bringForward(window);
    };

    const openLink = (value: string) => {
      const target = parseAppLink(value);
      if (target === undefined)
        return fork(Effect.logWarning("Ignored a link that does not name an installed app"));
      fork(openLogged(target));
    };

    const install = (server: string, app: string, parent: BrowserWindow | null) =>
      serially(keyOf(server, app))(
        Effect.gen(function* () {
          const existing = yield* store.get(server, app);
          if (Option.isSome(existing)) return existing;
          const connection = yield* connectedTo(server);
          const target = yield* connection.details(app);
          if (target.icon) yield* connection.signedIn;
          const svg = target.icon ? yield* iconSource(connection, target) : Option.none<string>();
          const images = yield* appIconImages(target.name, Option.getOrUndefined(svg));
          const answer = yield* showBox(parent, {
            type: "none",
            title: `Install ${target.name}`,
            message: `${appSource(target.name, connection.label, connection.host)} will be installed as an app on this computer.`,
            detail:
              "It gets its own window and icon. It can't reach your files or accounts beyond what the app already uses.",
            buttons: ["Install", "Cancel"],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
            icon: dialogImage(images),
          });
          if (answer.response !== 0) return Option.none<InstalledApp>();
          const directory = iconDirectory(server, app);
          yield* writeIcons(directory, images);
          const launcher = yield* writeLauncher(
            { server, app, name: target.name, icons: images },
            Option.none(),
            directory,
          );
          const record: InstalledApp = {
            server,
            app,
            installation: randomUUID(),
            revision: 0,
            name: target.name,
            origin: target.origin,
            icon: iconKey(target.name, svg),
            launcher: Option.getOrNull(launcher),
            installedAt: DateTime.formatIso(yield* DateTime.now),
            permissions: {},
          };
          yield* store.update(server, app, () => Option.some(record));
          yield* Effect.logInfo("Installed an app").pipe(Effect.annotateLogs({ app }));
          installedChanged(server, app);
          return Option.some(record);
        }),
      );

    const installFromLink = (server: string, app: string) =>
      Effect.gen(function* () {
        const existing = yield* store.get(server, app);
        const installed = Option.isSome(existing) ? existing : yield* install(server, app, null);
        if (Option.isNone(installed)) return false;
        yield* openLogged({ server, app });
        return true;
      });

    const localReady = Effect.callback<string>((resume) => {
      if (local !== undefined) return resume(Effect.succeed(local.server));
      const waiter = (server: string) => resume(Effect.succeed(server));
      localWaiters.add(waiter);
      return Effect.sync(() => localWaiters.delete(waiter));
    });

    const uninstall = (server: string, app: string) =>
      serially(keyOf(server, app))(
        Effect.gen(function* () {
          const current = running.get(keyOf(server, app));
          if (current !== undefined) end(current);
          const record = yield* store.get(server, app);
          if (Option.isNone(record)) return;
          if (record.value.launcher !== null)
            yield* removeOwnedLauncher({ server, app }, record.value.launcher);
          yield* fs
            .remove(iconDirectory(server, app), { recursive: true, force: true })
            .pipe(Effect.ignore);
          yield* store.update(server, app, () => Option.none());
          yield* Effect.logInfo("Removed an installed app").pipe(Effect.annotateLogs({ app }));
          installedChanged(server, app);
          if (record.value.permissions.startAtLogin === "granted") yield* syncLoginItem;
        }),
      );

    const confirmUninstall = (current: Running) =>
      Effect.gen(function* () {
        const answer = yield* showBox(current.window, {
          type: "warning",
          title: `Remove ${current.name}`,
          message: `Remove ${current.name} from this computer?`,
          detail:
            "Its window, launcher and permissions are removed. The app stays on its Executor server.",
          buttons: ["Remove", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (answer.response === 0) yield* uninstall(current.server, current.app);
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Could not remove an installed app", cause)),
      );

    let loginItem: boolean | undefined;
    const syncLoginItem: Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> = Effect.gen(
      function* () {
        let wanted = false;
        for (const server of yield* store.servers)
          for (const record of yield* store.appsOf(server))
            if (record.permissions.startAtLogin === "granted") wanted = true;
        if (wanted === loginItem) return;
        const outcome = yield* setOpenAtLogin(wanted);
        loginItem = wanted;
        yield* Effect.logInfo(
          wanted
            ? "Executor starts at login to open the apps allowed to"
            : "Executor no longer starts at login",
        );
        if (outcome !== "requires-approval") return;
        const answer = yield* showBox(undefined, {
          type: "none",
          title: "Allow Executor at login",
          message: `Allow ${electronApp.getName()} to open at login`,
          detail: `Turn on ${electronApp.getName()} in System Settings › General › Login Items, so the apps you allowed can start when you log in.`,
          buttons: ["Open System Settings", "Not now"],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        if (answer.response === 0)
          yield* Effect.tryPromise(() => shell.openExternal(loginItemSettings)).pipe(Effect.ignore);
      },
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not change whether Executor starts at login", cause),
      ),
    );

    const applyPermission = (server: string, app: string, name: DesktopPermission) =>
      Effect.gen(function* () {
        if (name === "startAtLogin") yield* syncLoginItem;
        const current = running.get(keyOf(server, app));
        if (current === undefined || !live(current)) return;
        if (granted(current, name)) {
          if (name === "menuBar") yield* showTray(current);
        } else
          switch (name) {
            case "menuBar":
              removeTray(current);
              break;
            case "shortcuts":
              clearShortcuts(current);
              break;
            case "floating":
              stopFloating(current);
              break;
            case "microphone":
            case "camera":
            case "systemAudio":
              for (const window of windowsOf(current)) window.webContents.reload();
              break;
            case "startAtLogin":
            case "clipboardRead":
            case "notifications":
              break;
          }
        if (live(current)) refreshMenus(current);
      });

    const setPermission = (
      server: string,
      app: string,
      name: DesktopPermission,
      setting: PermissionDecision | "prompt",
    ) =>
      Effect.gen(function* () {
        const record = yield* store.get(server, app);
        if (Option.isNone(record)) return yield* new DesktopUnavailable();
        yield* writeDecision(server, app, name, setting);
        yield* applyPermission(server, app, name);
      });

    const confirmGrant = (
      server: string,
      app: string,
      name: DesktopPermission,
      parent: BrowserWindow | null,
    ) =>
      promptLock.withPermits(1)(
        Effect.gen(function* () {
          const record = yield* store.get(server, app);
          if (Option.isNone(record)) return yield* new DesktopUnavailable();
          if (!onThisPlatform(name) || record.value.permissions[name] === "granted") return;
          const expected = {
            installation: record.value.installation,
            revision: record.value.revision,
          };
          const where = hosts.get(server);
          const images = yield* readIcons(server, app);
          const answer = yield* showBox(parent, {
            type: "none",
            title: `${record.value.name} permission`,
            message: `${appSource(record.value.name, where?.label, where?.host ?? "this computer's Executor")} ${permissionPrompt(name, process.platform)}`,
            detail: permissionDetail(name, process.platform),
            buttons: ["Allow", "Don't Allow"],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
            ...Option.match(images, {
              onNone: () => ({}),
              onSome: (value) => ({ icon: dialogImage(value) }),
            }),
          });
          if (answer.response !== 0) return;
          if (yield* writeDecision(server, app, name, "granted", expected))
            yield* applyPermission(server, app, name);
        }),
      );

    const dashboardPermission = (
      server: string,
      app: string,
      name: DesktopPermission,
      setting: PermissionDecision | "prompt",
      parent: BrowserWindow | null,
    ) =>
      Effect.gen(function* () {
        if (setting === "granted") yield* confirmGrant(server, app, name, parent);
        else yield* setPermission(server, app, name, setting);
        return (yield* permissionsOf(server, app))[name];
      });

    const permissionsOf = (server: string, app: string) =>
      Effect.gen(function* () {
        const record = yield* store.get(server, app);
        const state = (name: DesktopPermission): DesktopPermissionState =>
          Option.isNone(record) || !onThisPlatform(name)
            ? "unavailable"
            : (record.value.permissions[name] ?? "prompt");
        const states: Record<DesktopPermission, DesktopPermissionState> = {
          menuBar: state("menuBar"),
          shortcuts: state("shortcuts"),
          floating: state("floating"),
          startAtLogin: state("startAtLogin"),
          microphone: state("microphone"),
          camera: state("camera"),
          systemAudio: state("systemAudio"),
          clipboardRead: state("clipboardRead"),
          notifications: state("notifications"),
        };
        return states;
      });

    const published = (record: InstalledApp): DesktopInstalledApp => ({
      server: record.server,
      app: record.app,
      name: record.name,
      installedAt: record.installedAt,
    });

    const reply = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
      runPromise(
        effect.pipe(
          Effect.map((value): BridgeReply => ({ ok: true, value })),
          Effect.catchCause((cause) => {
            const error = Cause.findErrorOption(cause);
            const known = Option.filter(error, Schema.is(BridgeFailure));
            return (
              Option.isSome(known)
                ? Effect.void
                : Effect.logWarning("A desktop bridge call failed", cause)
            ).pipe(
              Effect.as<BridgeReply>({
                ok: false,
                failure: Schema.encodeSync(BridgeFailureJson)(
                  Option.getOrElse(known, () => new DesktopUnavailable()),
                ),
              }),
            );
          }),
        ),
      );

    const invalid = () =>
      new DesktopInvalidInput({ message: "The desktop bridge call is invalid." });

    const hostServer = (event: IpcMainEvent | IpcMainInvokeEvent) => {
      const frame = event.senderFrame;
      if (frame === null || frame.parent !== null || owners.has(event.sender.id)) return undefined;
      for (const connection of connections.values())
        if (event.sender.session === connection.session && frame.origin === connection.origin)
          return connection.server;
      return undefined;
    };

    const hostCall = (event: IpcMainInvokeEvent, input: unknown) =>
      reply(
        Effect.gen(function* () {
          const server = hostServer(event);
          if (server === undefined) return yield* new DesktopUnavailable();
          const call = yield* Schema.decodeUnknownEffect(HostCall)(input).pipe(
            Effect.mapError(invalid),
          );
          switch (call.method) {
            case "account":
              return accountHandler === undefined
                ? yield* new DesktopUnavailable()
                : yield* accountHandler.account(server);
            case "accountMenu":
              return accountHandler === undefined
                ? yield* new DesktopUnavailable()
                : yield* accountHandler.openMenu(server, event.sender, {
                    anchor: call.anchor,
                    settings: call.settings,
                  });
            case "installed":
              return Option.getOrNull(Option.map(yield* store.get(server, call.app), published));
            case "install":
              return Option.getOrNull(
                Option.map(
                  yield* install(server, call.app, BrowserWindow.fromWebContents(event.sender)),
                  published,
                ),
              );
            case "uninstall":
              return yield* uninstall(server, call.app);
            case "open":
              return yield* openApp({ server, app: call.app });
            case "permissions":
              return yield* permissionsOf(server, call.app);
            case "setPermission":
              return yield* dashboardPermission(
                server,
                call.app,
                call.name,
                call.state,
                BrowserWindow.fromWebContents(event.sender),
              );
          }
        }),
      );

    const appCaller = (event: IpcMainEvent | IpcMainInvokeEvent) => {
      const current = ownerOf(event.sender);
      const frame = event.senderFrame;
      if (
        current === undefined ||
        frame === null ||
        frame.parent !== null ||
        frame.origin !== current.origin
      )
        return undefined;
      return current;
    };

    const deliverShortcut = (current: Running, id: string) => {
      for (const window of windowsOf(current))
        window.webContents.send(desktopChannels.appShortcut, id);
    };

    const windowAction = (window: BrowserWindow, action: "show" | "hide" | "focus" | "toggle") => {
      switch (action) {
        case "show":
          return window.show();
        case "hide":
          return window.hide();
        case "focus":
          return bringForward(window);
        case "toggle":
          return window.isVisible() && window.isFocused() ? window.hide() : bringForward(window);
      }
    };

    const tooManyWindows = (current: Running) =>
      new DesktopInvalidInput({
        message: `${current.name} already has ${desktopMaximumWindows} other windows open. Close one before opening another.`,
      });

    const openWindow = (current: Running, path: string, options: DesktopWindowOptions) =>
      Effect.gen(function* () {
        const url = new URL(path, current.origin);
        if (url.origin !== current.origin)
          return yield* new DesktopInvalidInput({
            message: `${path} is not a path on this app, such as /notes/42.`,
          });
        const key = `${url.pathname}${url.search}`;
        const existing = current.windows.get(key);
        if (existing !== undefined && !existing.isDestroyed()) return bringForward(existing);
        if (current.windows.size >= desktopMaximumWindows) return yield* tooManyWindows(current);
        if (options.floating === true) {
          yield* ensure(current, "floating");
          if (!granted(current, "floating")) return yield* refusal(current, "floating");
        }
        if (!live(current)) return yield* new DesktopUnavailable();
        const raced = current.windows.get(key);
        if (raced !== undefined && !raced.isDestroyed()) return bringForward(raced);
        if (current.windows.size >= desktopMaximumWindows) return yield* tooManyWindows(current);
        createExtraWindow(current, key, url.href, options);
      });

    const screenRecordingAllowed = () =>
      process.platform !== "darwin" ||
      systemPreferences.getMediaAccessStatus("screen") === "granted";

    const systemAudio = (current: Running) =>
      Effect.gen(function* () {
        if (!systemAudioSupported()) return yield* new DesktopUnavailable();
        yield* ensure(current, "systemAudio");
        if (!granted(current, "systemAudio")) return yield* refusal(current, "systemAudio");
        if (screenRecordingAllowed()) return;
        const name = electronApp.getName();
        const answer = yield* showBox(current.window, {
          type: "none",
          title: "Allow system audio",
          message: `Allow ${name} to record system audio`,
          detail: `Turn on ${name} in System Settings › Privacy & Security › Screen & System Audio Recording, then try again.`,
          buttons: ["Open System Settings", "Not now"],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        if (answer.response === 0) {
          yield* Effect.tryPromise(() =>
            desktopCapturer.getSources({
              types: ["screen"],
              thumbnailSize: { width: 0, height: 0 },
            }),
          ).pipe(Effect.ignore);
          yield* Effect.tryPromise(() => shell.openExternal(screenRecordingSettings)).pipe(
            Effect.ignore,
          );
        }
        return yield* new SystemAudioBlocked();
      });

    const tooManyShortcuts = (current: Running) =>
      new DesktopInvalidInput({
        message: `${current.name} already has ${maximumShortcuts} keyboard shortcuts. Unregister one before adding another.`,
      });

    const registerShortcut = (current: Running, accelerator: string) =>
      Effect.gen(function* () {
        const problem = shortcutProblem(accelerator);
        if (problem !== undefined) return yield* new DesktopInvalidInput({ message: problem });
        if (current.shortcuts.size >= maximumShortcuts) return yield* tooManyShortcuts(current);
        yield* ensure(current, "shortcuts");
        return yield* Effect.suspend(
          (): Effect.Effect<
            { readonly id: string },
            DesktopInvalidInput | ShortcutTaken | DesktopPermissionDenied | DesktopUnavailable
          > => {
            if (!granted(current, "shortcuts")) return Effect.fail(refusal(current, "shortcuts"));
            if (current.shortcuts.size >= maximumShortcuts)
              return Effect.fail(tooManyShortcuts(current));
            if (globalShortcut.isRegistered(accelerator))
              return Effect.fail(new ShortcutTaken({ accelerator }));
            const id = randomUUID();
            const registered = Result.try({
              try: () => globalShortcut.register(accelerator, () => deliverShortcut(current, id)),
              catch: () =>
                new DesktopInvalidInput({
                  message: `${accelerator} is not a keyboard shortcut the desktop understands.`,
                }),
            });
            if (Result.isFailure(registered)) return Effect.fail(registered.failure);
            if (!registered.success) return Effect.fail(new ShortcutTaken({ accelerator }));
            current.shortcuts.set(id, accelerator);
            refreshMenus(current);
            return Effect.succeed({ id });
          },
        );
      });

    const appCall = (event: IpcMainInvokeEvent, input: unknown) =>
      reply(
        Effect.gen(function* () {
          const current = appCaller(event);
          const caller = BrowserWindow.fromWebContents(event.sender);
          if (current === undefined || caller === null) return yield* new DesktopUnavailable();
          const call = yield* Schema.decodeUnknownEffect(AppCall)(input).pipe(
            Effect.mapError(invalid),
          );
          switch (call.method) {
            case "permission":
              return stateOf(current, call.name);
            case "notify": {
              if (!granted(current, "notifications"))
                return yield* new DesktopPermissionDenied({ permission: "notifications" });
              const images = yield* readIcons(current.server, current.app);
              showNotification(current, event.sender, call, images);
              return null;
            }
            case "closeNotification":
              notifications.get(`${current.key} ${call.id}`)?.shown.close();
              return null;
            case "prepareCapture": {
              for (const name of call.names) {
                yield* ensure(current, name).pipe(
                  Effect.catchTag("DesktopPermissionDenied", () => Effect.void),
                );
                if (!granted(current, name) || !(yield* systemMediaAccess(name))) return false;
              }
              return true;
            }
            case "requestPermission": {
              if (stateOf(current, call.name) === "unavailable") return "unavailable";
              yield* ensure(current, call.name).pipe(
                Effect.catchTag("DesktopPermissionDenied", () => Effect.void),
              );
              if (call.name === "menuBar" && granted(current, "menuBar")) yield* showTray(current);
              return stateOf(current, call.name);
            }
            case "setMenuBarTitle": {
              if (!current.menuBar) return yield* new DesktopUnavailable();
              yield* ensure(current, "menuBar");
              if (!granted(current, "menuBar")) return yield* refusal(current, "menuBar");
              current.title = call.text;
              return yield* showTray(current);
            }
            case "registerShortcut":
              return yield* registerShortcut(current, call.accelerator);
            case "unregisterShortcut": {
              const accelerator = current.shortcuts.get(call.id);
              if (accelerator === undefined) return;
              globalShortcut.unregister(accelerator);
              current.shortcuts.delete(call.id);
              refreshMenus(current);
              return;
            }
            case "setFloating": {
              if (call.on) yield* ensure(current, "floating");
              return yield* Effect.suspend(() => {
                if (call.on && !granted(current, "floating"))
                  return Effect.fail(refusal(current, "floating"));
                current.floating = call.on;
                const window = current.window;
                if (window !== undefined && !window.isDestroyed())
                  window.setAlwaysOnTop(call.on, "floating");
                return Effect.void;
              });
            }
            case "windowAction":
              return windowAction(caller, call.action);
            case "openWindow":
              return yield* openWindow(current, call.path, call.options);
            case "setBadge":
              return setBadge(current, call.count);
            case "systemAudio":
              return yield* systemAudio(current);
          }
        }),
      );

    const appHello = (event: IpcMainEvent) => {
      event.returnValue = appCaller(event) !== undefined;
    };
    ipcMain.handle(desktopChannels.hostCall, hostCall);
    ipcMain.handle(desktopChannels.appCall, appCall);
    ipcMain.on(desktopChannels.appHello, appHello);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        ipcMain.removeHandler(desktopChannels.hostCall);
        ipcMain.removeHandler(desktopChannels.appCall);
        ipcMain.removeListener(desktopChannels.appHello, appHello);
        for (const { shown } of notifications.values()) shown.close();
        for (const current of running.values()) end(current);
        for (const window of stateWindows.values()) if (!window.isDestroyed()) window.destroy();
      }),
    );

    const endServerApps = (server: string) => {
      const apps = [...running.values()].filter((current) => current.server === server);
      for (const current of apps) end(current);
      return apps;
    };

    const connect = (connection: ServerConnection) => {
      generation += 1;
      const connected: Connected = { ...connection, generation };
      const previous = connections.get(connection.server);
      if (previous !== undefined) endServerApps(connection.server);
      connections.set(connection.server, connected);
      hosts.set(connection.server, { label: connection.label, host: connection.host });
      problems.delete(connection.server);
      options.changed();
      return connected;
    };

    const disconnect = (server: string, problem?: "signed-out") => {
      connections.delete(server);
      if (problem === undefined) problems.delete(server);
      else problems.set(server, problem);
      const apps = endServerApps(server);
      if (apps.length > 0)
        fork(
          Effect.logInfo("Closed a server's installed apps").pipe(
            Effect.annotateLogs({ apps: apps.length }),
          ),
        );
      options.changed();
    };

    let localAttempt = 0;
    const serverGone = () => {
      localAttempt += 1;
      const was = local;
      local = undefined;
      if (was === undefined) return;
      connections.delete(was.server);
      const apps = endServerApps(was.server);
      if (apps.length > 0) {
        resume = {
          server: was.server,
          apps: apps.map((current) => ({
            app: current.app,
            visible:
              current.window !== undefined &&
              !current.window.isDestroyed() &&
              current.window.isVisible(),
          })),
        };
        fork(Effect.logInfo("Closed installed apps while the local server is unavailable"));
      }
      options.changed();
    };

    const serverReady = <E>(origin: string, pair: Effect.Effect<string, E>) =>
      Effect.gen(function* () {
        const attempt = localAttempt;
        const server = yield* serverIdentity(options.session, origin);
        const signedIn = yield* pair.pipe(
          Effect.flatMap((pairing) => exchangeSession(options.session, origin, pairing)),
          Effect.result,
        );
        if (localAttempt !== attempt) return false;
        lastLocal = server;
        local = connect({
          server,
          origin,
          session: options.session,
          label: undefined,
          host: "this computer's Executor",
          details: localDetails(origin),
          signedIn: Effect.void,
          allows: (url) => url.pathname === "/app-auth",
        });
        if (Result.isFailure(signedIn)) {
          yield* Effect.logError(
            "Could not sign the desktop's session in to the local server; app links that arrived before it could not open",
          );
          const waiting = pending.splice(0);
          for (const target of waiting) fork(couldNotOpen(target, Cause.fail(signedIn.failure)));
          return false;
        }
        const waiters = Array.from(localWaiters);
        localWaiters.clear();
        for (const waiter of waiters) waiter(server);
        const resumed = resume;
        resume = undefined;
        if (resumed !== undefined) {
          if (resumed.server === server)
            for (const { app, visible } of resumed.apps)
              fork(openLogged({ server, app, hidden: !visible }));
          else
            yield* Effect.logWarning(
              "The local server has another identity now; its earlier apps stay closed",
            );
        }
        for (const target of pending.splice(0)) fork(openLogged(target));
        return true;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError(
              "Installed apps stay closed: the local server did not confirm its identity",
              cause,
            );
            for (const target of pending.splice(0)) fork(couldNotOpen(target, cause));
            return false;
          }),
        ),
        Effect.provideContext(services),
      );

    const removeServer = (server: string) =>
      Effect.gen(function* () {
        disconnect(server);
        const apps = yield* store.appsOf(server);
        yield* Effect.forEach(apps, (record) => uninstall(server, record.app), { discard: true });
        return apps.length;
      });

    const permissionCheck = (
      contents: WebContents | null,
      permission: string,
      requestingOrigin: string,
      details: {
        readonly isMainFrame: boolean;
        readonly requestingUrl?: string;
        readonly mediaType?: string;
      },
    ) => {
      const name = checkedPermission(permission, details.mediaType);
      if (contents === null || name === undefined || !details.isMainFrame) return false;
      const current = ownerOf(contents);
      return (
        current !== undefined &&
        URL.parse(requestingOrigin)?.origin === current.origin &&
        URL.parse(details.requestingUrl ?? "")?.origin === current.origin &&
        URL.parse(contents.getURL())?.origin === current.origin &&
        granted(current, name)
      );
    };

    const permissionRequest = (
      contents: WebContents,
      permission: string,
      callback: (granted: boolean) => void,
      details: {
        readonly isMainFrame: boolean;
        readonly requestingUrl: string;
        readonly mediaTypes?: ReadonlyArray<string>;
      },
    ) => {
      const current = ownerOf(contents);
      if (
        current === undefined ||
        !details.isMainFrame ||
        URL.parse(details.requestingUrl)?.origin !== current.origin
      )
        return callback(false);
      if (permission === "clipboard-sanitized-write") return callback(true);
      const names = requestedPermissions(permission, details.mediaTypes);
      if (names.length === 0) return callback(false);
      fork(
        Effect.forEach(
          names,
          (name) =>
            ensure(current, name).pipe(
              Effect.andThen(systemMediaAccess(name)),
              Effect.flatMap((allowed) =>
                allowed ? Effect.void : Effect.fail(new DesktopUnavailable()),
              ),
            ),
          { discard: true },
        ).pipe(
          Effect.match({
            onSuccess: () => callback(names.every((name) => granted(current, name))),
            onFailure: () => callback(false),
          }),
        ),
      );
    };

    const displayMediaRequest = (
      request: Electron.DisplayMediaRequestHandlerHandlerRequest,
      callback: (streams: Electron.Streams) => void,
    ) => {
      const frame = request.frame;
      const contents = frame === null ? undefined : webContents.fromFrame(frame);
      const current = contents === undefined ? undefined : ownerOf(contents);
      if (
        frame === null ||
        current === undefined ||
        frame.parent !== null ||
        frame.origin !== current.origin ||
        !request.audioRequested ||
        !systemAudioSupported() ||
        !granted(current, "systemAudio") ||
        !screenRecordingAllowed()
      ) {
        fork(
          Effect.logInfo("Refused a request to capture the screen or system audio").pipe(
            Effect.annotateLogs({ app: current?.app ?? "none" }),
          ),
        );
        return callback({});
      }
      fork(
        Effect.logInfo("Gave an installed app system audio").pipe(
          Effect.annotateLogs({ app: current.app }),
        ),
      );
      callback({ video: frame, audio: "loopback" });
    };

    const download = (item: DownloadItem, contents: WebContents) => {
      const current = ownerOf(contents);
      if (current === undefined) return;
      const source = BrowserWindow.fromWebContents(contents);
      const parent =
        source !== null && source !== current.popover && source.isVisible() ? source : undefined;
      const box = {
        title: `Save from ${current.name}`,
        defaultPath: path.join(electronApp.getPath("downloads"), item.getFilename()),
      };
      const chosen =
        parent === undefined
          ? dialog.showSaveDialogSync(box)
          : dialog.showSaveDialogSync(parent, box);
      if (chosen === undefined) {
        item.cancel();
        return fork(
          Effect.logInfo("Cancelled an installed app's download").pipe(
            Effect.annotateLogs({ app: current.app }),
          ),
        );
      }
      item.setSavePath(chosen);
      item.once("done", (_event, state) => {
        if (state === "completed" && process.platform === "darwin")
          electronApp.dock?.downloadFinished(chosen);
        fork(
          Effect.logInfo("An installed app's download ended").pipe(
            Effect.annotateLogs({ app: current.app, state }),
          ),
        );
      });
    };

    const attachSession = (target: Session, dashboardOrigin: () => string | undefined) => {
      target.setPermissionRequestHandler((contents, permission, callback, details) =>
        owners.has(contents.id)
          ? permissionRequest(contents, permission, callback, details)
          : callback(
              permission === "clipboard-sanitized-write" &&
                URL.parse(details.requestingUrl)?.origin === dashboardOrigin(),
            ),
      );
      target.setPermissionCheckHandler(permissionCheck);
      target.setDisplayMediaRequestHandler(displayMediaRequest);
      target.on("will-download", (_event, item, contents) => download(item, contents));
    };

    return {
      serverReady,
      serverGone,
      connect: (connection: ServerConnection) => {
        connect(connection);
        const waiting = pending.filter((target) => target.server === connection.server);
        for (const target of waiting) pending.splice(pending.indexOf(target), 1);
        for (const target of waiting) fork(openLogged(target));
      },
      disconnect,
      removeServer,
      appNames: (server: string) =>
        store.appsOf(server).pipe(
          Effect.map((apps) => apps.map((record) => record.name).toSorted()),
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        ),
      setAccountHandler: (handler: AccountHandler) => {
        accountHandler = handler;
      },
      dashboardServer,
      installedServers: store.servers,
      runningApps: (server: string) =>
        [...running.values()]
          .filter((current) => current.server === server)
          .map((current) => ({ app: current.app, name: current.name })),
      open: (server: string, app: string) => fork(openLogged({ server, app })),
      localServer: () => local?.server,
      localReady,
      installFromLink,
      hostServer: (event: IpcMainEvent) => hostServer(event) ?? null,
      openLink,
      owns: (contents: WebContents) => owners.has(contents.id),
      setBaseMenu: (menu: Menu) => {
        baseMenu = menu;
        if (menuOwner === undefined) Menu.setApplicationMenu(menu);
      },
      attachSession,
      openAtLogin: Effect.gen(function* () {
        for (const server of yield* store.servers)
          for (const record of yield* store.appsOf(server))
            if (record.permissions.startAtLogin === "granted")
              fork(openLogged({ server, app: record.app, hidden: true }));
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not open the apps allowed to start at login", cause),
        ),
      ),
    };
  });

export type InstalledApps = Effect.Success<ReturnType<typeof makeInstalledApps>>;
