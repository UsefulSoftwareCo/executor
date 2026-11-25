import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect, Fiber, FileSystem, Layer, Option, Path, Schedule, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import type { ElectronApplication, Page } from "playwright";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { driver } from "../support/platform.ts";
import { localNpmRegistry } from "../support/npm-registry.ts";
import { freePort } from "../support/ports.ts";
import { appsManifest } from "../support/apps-release.ts";
import {
  answerDialogs,
  answeredDialogs,
  dashboardReady,
  clickNotification,
  dialogParents,
  clickMenuBarItem,
  desktopCli,
  eventsNamed,
  externalOpens,
  heldDialogs,
  standInForNotifications,
  runsScripts,
  shownNotifications,
  launchDesktop,
  menuBarItemMenu,
  menuBarItems,
  nextServer,
  openDesktopLink,
  permissionsMenu,
  permissionStates,
  pressShortcut,
  systemAudioAvailable,
  recordExternalOpens,
  releaseHeldDialog,
  runnerSession,
  stopBackgroundServers,
  suspendProcess,
  watchDesktopShell,
} from "../support/desktop.ts";
import { crashServer, type ServiceRegistration } from "../support/background-service.ts";
import { scenarios } from "../test-plan.ts";

const services = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);
const onThisComputer = (name: string) => `${name} on this computer's Executor`;

const icon =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#7b5cff"/></svg>';
const appFiles = [
  {
    path: "index.ts",
    content: 'import { defineApp } from "apps"; export default defineApp({}, {});',
  },
  {
    path: "ui/index.html",
    content:
      '<!doctype html><html><head><title>Page title</title></head><body><h1>Installed app</h1><script type="module" src="./main.ts"></script></body></html>',
  },
  {
    path: "ui/main.ts",
    content:
      'window.addEventListener("executor:desktop-shortcut", (event) => { document.body.dataset.shortcut = (event as CustomEvent<{ id: string }>).detail.id; }); window.addEventListener("executor:desktop-window", (event) => { document.body.dataset.windowEvents = `${document.body.dataset.windowEvents ?? ""}${(event as CustomEvent<{ type: string }>).detail.type} `; });',
  },
  { path: "ui/public/note.txt", content: "A note from the app" },
  {
    path: "ui/menubar.html",
    content:
      '<!doctype html><html><head><meta name="executor:menubar" content="width=360, height=240"><title>Menu</title></head><body><p id="menu"></p><script type="module" src="./menubar.ts"></script></body></html>',
  },
  {
    path: "ui/menubar.ts",
    content: 'document.querySelector("#menu")!.textContent = "Menu bar page";',
  },
  { path: "ui/icon.svg", content: icon },
  appsManifest,
];

const desktopHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "executor-desktop-apps-" });
  const runtimePath = yield* Config.String("EXECUTOR_E2E_RUNTIME_PATH").pipe(
    Config.withDefault(process.env.PATH ?? ""),
  );
  const port = yield* freePort;
  const registry = yield* localNpmRegistry;
  const data = path.join(home, "data");
  const profile = path.join(home, "profile");
  const cacheHome = path.join(home, "cache-home");
  const apiKey = randomBytes(32).toString("hex");
  const env: Record<string, string> = {
    ...runnerSession(),
    DO_NOT_TRACK: "1",
    EXECUTOR_NO_UPDATE_CHECK: "1",
    PATH: runtimePath,
    ...(process.platform === "win32"
      ? { LOCALAPPDATA: cacheHome }
      : process.platform === "darwin"
        ? {}
        : { XDG_CACHE_HOME: cacheHome, XDG_CONFIG_HOME: path.join(home, "config") }),
    HOME: process.platform === "darwin" ? cacheHome : (process.env.HOME ?? ""),
    EXECUTOR_PORT: String(port),
    EXECUTOR_DESKTOP_DATA_DIR: data,
    EXECUTOR_DESKTOP_PROFILE_DIR: profile,
    EXECUTOR_NPM_REGISTRY: registry.url,
    EXECUTOR_API_KEY: apiKey,
    EXECUTOR_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  };
  const seen: Array<ServiceRegistration> = [];
  yield* Effect.addFinalizer(() => stopBackgroundServers(data, () => seen));
  return { home, data, profile, cacheHome, env, apiKey, origin: `http://127.0.0.1:${port}`, seen };
});

const Deployed = Schema.Struct({ app: Schema.Struct({ id: Schema.String }) });
const StoredApps = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    servers: Schema.Record(
      Schema.String,
      Schema.Struct({
        apps: Schema.Record(
          Schema.String,
          Schema.Struct({
            name: Schema.String,
            launcher: Schema.NullOr(Schema.String),
            permissions: Schema.Record(Schema.String, Schema.String),
          }),
        ),
      }),
    ),
  }),
);

type DesktopHome = Effect.Success<typeof desktopHome>;

const dashboardOf = (electron: ElectronApplication) =>
  Effect.gen(function* () {
    const dashboard = yield* driver("desktop window", () => electron.firstWindow());
    yield* dashboardReady(dashboard);
    return dashboard;
  });

const deployApp = (dashboard: Page, home: DesktopHome, name: string) =>
  Effect.gen(function* () {
    const response = yield* driver("deploy an app with a menu-bar page and icon", () =>
      dashboard.request.post(`${home.origin}/v1/apps/deploy`, {
        headers: { authorization: `Bearer ${home.apiKey}` },
        data: { owner: "local", name, files: appFiles },
      }),
    );
    expect(response.status(), yield* driver("deploy response", () => response.text())).toBe(200);
    const { app } = yield* driver("read the deployed app", () => response.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Deployed)),
    );
    return app.id;
  });

const appName = () => `Desk ${randomUUID().slice(0, 6)}`;

const startDesktopIn = (home: DesktopHome, name = appName(), args: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const electron = yield* launchDesktop({ cwd: home.home, env: home.env, args });
    const dashboard = yield* dashboardOf(electron);
    if (home.seen.length === 0) home.seen.push(yield* nextServer(home.data, []));
    const app = yield* deployApp(dashboard, home, name);
    const server = yield* driver("read the host bridge's server", () =>
      dashboard.evaluate(() => {
        const bridge: unknown = Reflect.get(window, "__executorDesktopHost");
        return typeof bridge === "object" && bridge !== null ? Reflect.get(bridge, "server") : null;
      }),
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.String)));
    return { ...home, electron, dashboard, name, app, server };
  });

const startDesktop = Effect.flatMap(desktopHome, (home) => startDesktopIn(home));

const foreignSite = Effect.gen(function* () {
  const server = yield* Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createServer>>((resume) => {
      const server = createServer((request, response) => {
        const url = request.url ?? "/";
        if (url === "/redirect") {
          response.writeHead(302, { location: "/landing" });
          return response.end();
        }
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<!doctype html><title>Foreign</title><h1>Foreign ${url}</h1>`);
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    return yield* Effect.die("The foreign site has no port");
  return `http://127.0.0.1:${address.port}`;
});

type BridgeArgument =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: string | number | boolean };

const callBridge = (
  page: Page,
  label: string,
  global: "__executorDesktopHost" | "__executorDesktop",
  method: string,
  args: ReadonlyArray<BridgeArgument>,
) =>
  driver(label, () =>
    page.evaluate(
      ([global, method, args]) => {
        const target: unknown = Reflect.get(window, global);
        const call: unknown =
          typeof target === "object" && target !== null ? Reflect.get(target, method) : undefined;
        if (typeof call !== "function") return { ok: false as const, failure: "missing" };
        return Promise.resolve(Reflect.apply(call, target, JSON.parse(args))).then(
          (value: unknown) => ({ ok: true as const, value }),
          (failure: unknown) => ({ ok: false as const, failure }),
        );
      },
      [global, method, JSON.stringify(args)] as const,
    ),
  );

const host = (page: Page, label: string, method: string, ...args: ReadonlyArray<BridgeArgument>) =>
  callBridge(page, label, "__executorDesktopHost", method, args);

const bridge = (
  page: Page,
  label: string,
  method: string,
  ...args: ReadonlyArray<BridgeArgument>
) => callBridge(page, label, "__executorDesktop", method, args);

const globals = (page: Page, label: string) =>
  driver(label, () =>
    page.evaluate(() => ({
      app: typeof Reflect.get(window, "__executorDesktop"),
      host: typeof Reflect.get(window, "__executorDesktopHost"),
    })),
  );

const appWindow = (electron: ElectronApplication, app: string, path = "/") => {
  const host = `${app.replace(/^app_/, "app-")}.localhost`;
  return Effect.gen(function* () {
    for (const page of electron.windows()) {
      const url = URL.parse(page.url());
      if (url?.hostname !== host || url.pathname !== path) continue;
      if (yield* driver(`check ${host}${path}`, () => runsScripts(electron, page))) return page;
    }
    return yield* Effect.fail(new Error(`No installed app window shows ${host}${path}`));
  }).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 600 }));
};

const nativeWindows = (electron: ElectronApplication, app: string) =>
  driver("read the installed app's native windows", () =>
    electron.evaluate(({ BrowserWindow }, app) => {
      const host = `${app.replace(/^app_/, "app-")}.localhost`;
      return BrowserWindow.getAllWindows()
        .filter((window) => URL.parse(window.webContents.getURL())?.hostname === host)
        .map((window) => ({
          title: window.getTitle(),
          path: URL.parse(window.webContents.getURL())?.pathname ?? "",
          search: URL.parse(window.webContents.getURL())?.search ?? "",
          visible: window.isVisible(),
          focused: window.isFocused(),
          floating: window.isAlwaysOnTop(),
          size: window.getSize(),
        }));
    }, app),
  );

const dialogsTitled = (electron: ElectronApplication, title: string) =>
  answeredDialogs(electron).pipe(
    Effect.map((boxes) => (boxes ?? []).filter((box) => box.title === title)),
  );

const eventually = <A, E, R>(
  label: string,
  effect: Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
) =>
  effect.pipe(
    Effect.flatMap((value) =>
      done(value)
        ? Effect.succeed(value)
        : Effect.fail(new Error(`${label}: not yet, last ${JSON.stringify(value)}`)),
    ),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
  );

const storedApps = (profile: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs
      .readFileString(path.join(profile, "installed-apps.json"))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(StoredApps)));
  });

const launcherFiles = (launcher: string | null) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (launcher === null) return { kind: "none" as const };
    if (process.platform === "darwin") {
      const plist = yield* fs.readFileString(path.join(launcher, "Contents", "Info.plist"));
      const script = yield* fs.readFileString(path.join(launcher, "Contents", "MacOS", "launcher"));
      const mode = (yield* fs.stat(path.join(launcher, "Contents", "MacOS", "launcher"))).mode;
      const icns = yield* fs.readFile(path.join(launcher, "Contents", "Resources", "icon.icns"));
      return {
        kind: "mac" as const,
        plist,
        script,
        executable: (mode & 0o111) === 0o111,
        icns: Buffer.from(icns.subarray(0, 4)).toString("ascii"),
      };
    }
    return { kind: "windows" as const, exists: yield* fs.exists(launcher) };
  });

it.live(scenarios.desktopInstalledApps.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const desktop = yield* startDesktop;
      const { electron, dashboard, name, app, server, profile } = desktop;
      const link = `executor://app/${server}/${app}`;
      expect(yield* globals(dashboard, "the dashboard has only the host bridge")).toEqual({
        app: "undefined",
        host: "object",
      });
      expect(yield* host(dashboard, "an app that is not installed", "installed", app)).toEqual({
        ok: true,
        value: null,
      });

      yield* answerDialogs(electron, { [`Install ${name}`]: 1 });
      expect(yield* host(dashboard, "cancel installing the app", "install", app)).toEqual({
        ok: true,
        value: null,
      });
      expect(yield* storedApps(profile).pipe(Effect.option)).toEqual(Option.none());

      yield* answerDialogs(electron, { [`Install ${name}`]: 0, [`${name} permission`]: 1 });
      const installed = yield* host(dashboard, "install the app", "install", app);
      expect(installed).toMatchObject({ ok: true, value: { server, app, name } });
      const [shownInstall] = yield* dialogsTitled(electron, `Install ${name}`);
      expect(shownInstall).toEqual({
        title: `Install ${name}`,
        message: `${onThisComputer(name)} will be installed as an app on this computer.`,
        detail:
          "It gets its own window and icon. It can't reach your files or accounts beyond what the app already uses.",
      });
      expect(yield* host(dashboard, "read the installed app", "installed", app)).toEqual(installed);
      const stored = (yield* storedApps(profile)).servers[server]?.apps[app];
      expect(stored).toMatchObject({ name, permissions: {} });
      const launcher = stored?.launcher ?? null;
      const files = yield* launcherFiles(launcher);
      if (process.platform === "darwin") {
        expect(launcher).toBe(
          path.join(desktop.cacheHome, "Applications", "Executor Apps", `${name}.app`),
        );
        expect(files).toMatchObject({ kind: "mac", executable: true, icns: "icns" });
        if (files.kind === "mac") {
          expect(files.script).toContain(`'${link}'`);
          expect(files.plist).toContain(`<key>CFBundleName</key><string>${name}</string>`);
          expect(files.plist).toMatch(
            /<key>CFBundleIdentifier<\/key><string>com\.usefulsoftware\.executor\.app\.[a-f0-9]{16}<\/string>/u,
          );
        }
      } else if (process.platform === "win32") {
        expect(launcher?.endsWith(`Executor Apps\\${name}.lnk`)).toBe(true);
        expect(files).toEqual({ kind: "windows", exists: true });
        const shortcut = yield* driver("read the Start Menu shortcut", () =>
          electron.evaluate(({ shell }, file) => shell.readShortcutLink(file), launcher ?? ""),
        );
        expect(shortcut.args).toContain(link);
        expect(shortcut.appUserModelId).toMatch(
          /^com\.usefulsoftware\.executor\.app\.[a-f0-9]{16}$/u,
        );
        expect(shortcut.icon?.endsWith("icon.ico")).toBe(true);
      } else expect(files).toEqual({ kind: "none" });

      expect(yield* openDesktopLink({ cwd: desktop.home, env: desktop.env, link })).toBe(0);
      const page = yield* appWindow(electron, app);
      yield* driver("the app window signs in and shows the app", () =>
        page.getByRole("heading", { name: "Installed app" }).waitFor({ timeout: 60_000 }),
      );
      expect(yield* nativeWindows(electron, app)).toMatchObject([{ title: name, path: "/" }]);
      expect(yield* globals(page, "the app window has only the app bridge")).toEqual({
        app: "object",
        host: "undefined",
      });
      yield* eventually(
        "the menu-bar permission was asked",
        dialogsTitled(electron, `${name} permission`),
        (boxes) => boxes.length === 1,
      );
      expect((yield* dialogsTitled(electron, `${name} permission`))[0]?.message).toBe(
        `${onThisComputer(name)} ${process.platform === "darwin" ? "wants to add an item to the menu bar." : "wants to add an icon to the notification area."}`,
      );
      expect(yield* bridge(page, "read the menu-bar permission", "permission", "menuBar")).toEqual({
        ok: true,
        value: "denied",
      });
      expect(
        yield* bridge(page, "set a title without permission", "setMenuBarTitle", "Hi"),
      ).toEqual({
        ok: false,
        failure: { _tag: "DesktopPermissionDenied", permission: "menuBar" },
      });
      expect(yield* dialogsTitled(electron, `${name} permission`)).toHaveLength(1);

      const renamed = `${name} renamed`;
      const rename = yield* driver("rename the app in the dashboard", () =>
        dashboard.evaluate(
          ([app, renamed]) =>
            fetch(`/dashboard/api/apps/${app}/name`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: renamed }),
            }).then((response) => response.status),
          [app, renamed] as const,
        ),
      );
      expect(rename).toBe(200);
      yield* driver("close the app window", () =>
        electron.evaluate(({ BrowserWindow }, app) => {
          const host = `${app.replace(/^app_/, "app-")}.localhost`;
          for (const window of BrowserWindow.getAllWindows())
            if (URL.parse(window.webContents.getURL())?.hostname === host) window.close();
        }, app),
      );
      yield* eventually(
        "the app window closed",
        nativeWindows(electron, app),
        (windows) => windows.length === 0,
      );
      expect(yield* openDesktopLink({ cwd: desktop.home, env: desktop.env, link })).toBe(0);
      const reopened = yield* appWindow(electron, app);
      yield* driver("the reopened window shows the app", () =>
        reopened.getByRole("heading", { name: "Installed app" }).waitFor({ timeout: 60_000 }),
      );
      expect(yield* nativeWindows(electron, app)).toMatchObject([{ title: renamed }]);
      const relaunched = yield* eventually(
        "the launcher follows the new name",
        storedApps(profile).pipe(Effect.map((file) => file.servers[server]?.apps[app])),
        (record) => record?.name === renamed,
      );
      if (process.platform === "darwin") {
        expect(relaunched?.launcher).toBe(
          path.join(desktop.cacheHome, "Applications", "Executor Apps", `${renamed}.app`),
        );
        expect(yield* fs.exists(launcher ?? "")).toBe(false);
      } else if (process.platform === "win32") {
        expect(relaunched?.launcher?.endsWith(`Executor Apps\\${renamed}.lnk`)).toBe(true);
        expect(yield* fs.exists(launcher ?? "")).toBe(false);
      } else expect(relaunched?.launcher).toBeNull();
      expect(relaunched?.permissions).toEqual({ menuBar: "denied" });

      expect(yield* host(dashboard, "uninstall the app", "uninstall", app)).toEqual({ ok: true });
      yield* eventually(
        "the app window closed",
        nativeWindows(electron, app),
        (windows) => windows.length === 0,
      );
      expect(yield* host(dashboard, "the app is no longer installed", "installed", app)).toEqual({
        ok: true,
        value: null,
      });
      expect((yield* storedApps(profile)).servers).toEqual({});
      if (relaunched?.launcher !== null && relaunched?.launcher !== undefined)
        expect(yield* fs.exists(relaunched.launcher)).toBe(false);

      expect(yield* openDesktopLink({ cwd: desktop.home, env: desktop.env, link })).toBe(0);
      const refused = yield* eventually(
        "opening a removed app explains it",
        answeredDialogs(electron),
        (boxes) => (boxes ?? []).some((box) => box.message === "Executor could not open this app."),
      );
      expect(refused?.at(-1)?.message).toBe("Executor could not open this app.");
      expect(yield* nativeWindows(electron, app)).toEqual([]);
    }),
  ).pipe(Effect.provide(services)),
);

it.live(scenarios.desktopAppPermissions.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const desktop = yield* startDesktop;
      const { electron, dashboard, name, app, profile, server } = desktop;
      const permissionTitle = `${name} permission`;
      yield* watchDesktopShell(electron);
      yield* standInForNotifications(electron);
      yield* answerDialogs(electron, { [`Install ${name}`]: 0, [permissionTitle]: 0 });
      expect((yield* host(dashboard, "install the app", "install", app)).ok).toBe(true);
      expect(yield* host(dashboard, "open the app from the dashboard", "open", app)).toEqual({
        ok: true,
      });
      const page = yield* appWindow(electron, app);
      yield* driver("the app window shows the app", () =>
        page.getByRole("heading", { name: "Installed app" }).waitFor({ timeout: 60_000 }),
      );
      expect(
        yield* eventually(
          "the menu-bar item shows",
          menuBarItems(electron),
          (items) => items.length === 1,
        ),
      ).toEqual([name]);
      expect(yield* dialogsTitled(electron, permissionTitle)).toHaveLength(1);
      expect(yield* dialogParents(electron, permissionTitle)).toEqual(["visible"]);

      expect(yield* bridge(page, "set the menu-bar title", "setMenuBarTitle", "3 new")).toEqual({
        ok: true,
      });
      expect(yield* menuBarItems(electron)).toEqual(["3 new"]);
      expect(
        yield* bridge(page, "refuse a long title", "setMenuBarTitle", "x".repeat(25)),
      ).toMatchObject({ ok: false, failure: { _tag: "DesktopInvalidInput" } });
      expect(yield* bridge(page, "restore the app's name", "setMenuBarTitle", null)).toEqual({
        ok: true,
      });
      expect(yield* menuBarItems(electron)).toEqual([name]);

      yield* clickMenuBarItem(electron, name);
      const popover = yield* appWindow(electron, app, "/_executor/menubar");
      yield* driver("the popover shows the menu-bar page", () =>
        popover.locator("#menu").filter({ hasText: "Menu bar page" }).waitFor({ timeout: 60_000 }),
      );
      expect(yield* globals(popover, "the popover has the app bridge")).toEqual({
        app: "object",
        host: "undefined",
      });
      yield* eventually(
        "the popover takes the page's size",
        nativeWindows(electron, app),
        (windows) =>
          windows.some(
            (window) =>
              window.path === "/_executor/menubar" &&
              window.size[0] === 360 &&
              window.size[1] === 240,
          ),
      );

      yield* answerDialogs(electron, { [permissionTitle]: 1 });
      const denied = yield* bridge(
        page,
        "register a shortcut, denied",
        "registerShortcut",
        "CommandOrControl+Alt+K",
      );
      expect(denied).toEqual({
        ok: false,
        failure: { _tag: "DesktopPermissionDenied", permission: "shortcuts" },
      });
      expect(
        yield* bridge(page, "register again", "registerShortcut", "CommandOrControl+Alt+K"),
      ).toEqual(denied);
      expect(yield* dialogsTitled(electron, permissionTitle)).toEqual([
        {
          title: permissionTitle,
          message: `${onThisComputer(name)} wants to use a keyboard shortcut that works while you are in other apps.`,
          detail: "You can change this later in the app's menu or in its Desktop settings.",
        },
      ]);
      expect(yield* host(dashboard, "read the app's permissions", "permissions", app)).toEqual({
        ok: true,
        value: permissionStates({ menuBar: "granted", shortcuts: "denied" }),
      });
      expect(
        yield* host(dashboard, "ask again next time", "setPermission", app, "shortcuts", "prompt"),
      ).toEqual({ ok: true, value: "prompt" });

      yield* answerDialogs(electron, { [permissionTitle]: 0 });
      const registered = yield* bridge(
        page,
        "register a shortcut",
        "registerShortcut",
        "CommandOrControl+Alt+K",
      );
      expect(registered).toMatchObject({
        ok: true,
        value: { id: expect.stringMatching(/^[a-f0-9-]{36}$/u) },
      });
      yield* pressShortcut(electron, "CommandOrControl+Alt+K");
      const shortcut = yield* eventually(
        "the page receives the shortcut",
        driver("read the delivered shortcut", () =>
          page.evaluate(() => document.body.dataset.shortcut ?? ""),
        ),
        (value) => value !== "",
      );
      expect(registered).toEqual({ ok: true, value: { id: shortcut } });
      expect(yield* bridge(page, "register a bare key", "registerShortcut", "K")).toEqual({
        ok: false,
        failure: {
          _tag: "DesktopInvalidInput",
          message:
            "K would take a key away from typing in every other app. A global shortcut needs CommandOrControl, Control, Command, Alt or Super; Shift alone is not enough. Only F13 to F24 and media keys work alone.",
        },
      });
      expect(
        yield* bridge(page, "register Shift and a key", "registerShortcut", "Shift+K"),
      ).toMatchObject({
        ok: false,
        failure: {
          _tag: "DesktopInvalidInput",
          message: expect.stringContaining("Shift alone is not enough"),
        },
      });
      expect(
        yield* bridge(page, "register modifiers alone", "registerShortcut", "CommandOrControl+Alt"),
      ).toMatchObject({
        ok: false,
        failure: {
          _tag: "DesktopInvalidInput",
          message: expect.stringContaining("is not a keyboard shortcut the desktop understands"),
        },
      });
      expect(yield* menuBarItemMenu(electron, name)).toContain(
        `${permissionsMenu(["menuBar", "shortcuts"])}, -, Shortcuts in use, CommandOrControl+Alt+K`,
      );
      yield* driver("another program holds a shortcut", () =>
        electron.evaluate(({ globalShortcut }) =>
          globalShortcut.register("CommandOrControl+Alt+J", () => undefined),
        ),
      );
      expect(
        yield* bridge(
          page,
          "register a taken shortcut",
          "registerShortcut",
          "CommandOrControl+Alt+J",
        ),
      ).toEqual({
        ok: false,
        failure: { _tag: "ShortcutTaken", accelerator: "CommandOrControl+Alt+J" },
      });

      const more = ["1", "2", "3", "4", "5", "6", "7"].map(
        (key) => `CommandOrControl+Alt+Shift+${key}`,
      );
      for (const accelerator of more)
        expect(
          yield* bridge(page, `register ${accelerator}`, "registerShortcut", accelerator),
        ).toMatchObject({ ok: true });
      expect(
        yield* bridge(
          page,
          "register a ninth shortcut",
          "registerShortcut",
          "CommandOrControl+Alt+Shift+8",
        ),
      ).toEqual({
        ok: false,
        failure: {
          _tag: "DesktopInvalidInput",
          message: `${name} already has 8 keyboard shortcuts. Unregister one before adding another.`,
        },
      });

      expect(yield* bridge(page, "float the window", "setFloating", true)).toEqual({ ok: true });
      expect(
        (yield* nativeWindows(electron, app)).find((window) => window.path === "/")?.floating,
      ).toBe(true);
      expect(yield* bridge(page, "stop floating", "setFloating", false)).toEqual({ ok: true });
      expect(
        (yield* nativeWindows(electron, app)).find((window) => window.path === "/")?.floating,
      ).toBe(false);

      const notify = (label: string) =>
        driver(label, () =>
          page.evaluate(() =>
            Notification.requestPermission().then((permission) =>
              new Promise<string>((resolve) => {
                const notification = new Notification("From the app");
                notification.addEventListener("show", () => resolve("show"));
                notification.addEventListener("error", () => resolve("error"));
                setTimeout(() => resolve("no event"), 10_000);
              }).then((shown) => ({ permission, current: Notification.permission, shown })),
            ),
          ),
        );
      yield* answerDialogs(electron, { [permissionTitle]: 1 });
      expect(yield* notify("notify without permission")).toEqual({
        permission: "denied",
        current: "denied",
        shown: "error",
      });
      expect(
        yield* host(
          dashboard,
          "ask about notifications again",
          "setPermission",
          app,
          "notifications",
          "prompt",
        ),
      ).toEqual({ ok: true, value: "prompt" });
      yield* answerDialogs(electron, { [permissionTitle]: 0 });
      const allowed = yield* notify("notify with permission");
      expect(allowed).toEqual({ permission: "granted", current: "granted", shown: "show" });
      expect((yield* answeredDialogs(electron))?.map((box) => box.message)).toEqual([
        `${onThisComputer(name)} wants to show notifications.`,
      ]);
      const sent = yield* eventually(
        "the desktop showed the allowed notification itself",
        shownNotifications(electron),
        (shown) => shown.length === 1,
      );
      expect(sent).toEqual([
        { id: expect.stringMatching(/^[0-9a-f-]{36}$/u), title: "From the app", body: "" },
      ]);
      yield* driver("show a notification that reports its click", () =>
        page.evaluate(() => {
          const notification = new Notification("Click me", { body: "Then see the click" });
          Object.assign(window, {
            executorE2EClicked: new Promise<string>((resolve) => {
              notification.onclick = (event) => resolve(event.type);
            }),
          });
        }),
      );
      yield* eventually("the desktop showed it", shownNotifications(electron), (shown) =>
        shown.some((entry) => entry.title === "Click me" && entry.body === "Then see the click"),
      );
      yield* clickNotification(electron, 1);
      expect(
        yield* driver("the page heard the click", () =>
          page.evaluate(() => Reflect.get(window, "executorE2EClicked") as Promise<string>),
        ),
      ).toBe("click");
      yield* driver("show a notification that opens a path", () =>
        page.evaluate(() => {
          new Notification("Open notes", { data: { path: "/notes/3?from=notification" } });
        }),
      );
      yield* eventually("the desktop showed it", shownNotifications(electron), (shown) =>
        shown.some((entry) => entry.title === "Open notes"),
      );
      yield* clickNotification(electron, 2);
      yield* eventually(
        "the click opened the app at the notification's path",
        nativeWindows(electron, app),
        (windows) =>
          windows.some(
            (window) => window.path === "/notes/3" && window.search === "?from=notification",
          ),
      );
      yield* driver("return the app to its first page", () =>
        page
          .goto(new URL("/", page.url()).href)
          .then(() =>
            page.getByRole("heading", { name: "Installed app" }).waitFor({ timeout: 60_000 }),
          ),
      );

      expect(
        yield* host(dashboard, "revoke shortcuts", "setPermission", app, "shortcuts", "denied"),
      ).toEqual({ ok: true, value: "denied" });
      expect(
        yield* driver("the shortcuts are released", () =>
          electron.evaluate(
            ({ globalShortcut }, accelerators) =>
              accelerators.filter((accelerator) => globalShortcut.isRegistered(accelerator)),
            ["CommandOrControl+Alt+K", ...more],
          ),
        ),
      ).toEqual([]);

      expect(yield* menuBarItemMenu(electron, name)).toEqual([
        `Open ${name}`,
        "Reload",
        permissionsMenu(["menuBar", "floating", "notifications"]),
        "Remove from menu bar",
        "-",
        `Quit ${name}`,
      ]);
      yield* driver("close the app window", () =>
        electron.evaluate(({ BrowserWindow }, app) => {
          const host = `${app.replace(/^app_/, "app-")}.localhost`;
          for (const window of BrowserWindow.getAllWindows())
            if (
              URL.parse(window.webContents.getURL())?.pathname === "/" &&
              URL.parse(window.webContents.getURL())?.hostname === host
            )
              window.close();
        }, app),
      );
      expect(
        yield* eventually("the app keeps running hidden", nativeWindows(electron, app), (windows) =>
          windows.some((window) => window.path === "/" && !window.visible),
        ),
      ).toContainEqual(expect.objectContaining({ path: "/", visible: false }));
      expect(yield* menuBarItems(electron)).toEqual([name]);
      yield* menuBarItemMenu(electron, name, `Quit ${name}`);
      expect(
        yield* eventually(
          "the app quits",
          nativeWindows(electron, app),
          (windows) => windows.length === 0,
        ),
      ).toEqual([]);
      expect(yield* menuBarItems(electron)).toEqual([]);
      expect((yield* storedApps(profile)).servers[server]?.apps[app]?.permissions).toEqual({
        menuBar: "granted",
        shortcuts: "denied",
        floating: "granted",
        notifications: "granted",
      });
    }),
  ).pipe(Effect.provide(services)),
);

const isRegistered = (electron: ElectronApplication, accelerator: string) =>
  driver(`read whether ${accelerator} is registered`, () =>
    electron.evaluate(
      ({ globalShortcut }, accelerator) => globalShortcut.isRegistered(accelerator),
      accelerator,
    ),
  );

const appWindowAction = (
  electron: ElectronApplication,
  app: string,
  action: "crash" | "hide" | "show" | "close",
  url = "",
) =>
  driver(`${action} the installed app's window`, () =>
    electron.evaluate(
      ({ BrowserWindow }, [app, action, url]) => {
        const host = `${app.replace(/^app_/, "app-")}.localhost`;
        const window = BrowserWindow.getAllWindows().find((candidate) => {
          const shown = URL.parse(candidate.webContents.getURL());
          return shown?.hostname === host && shown.pathname === "/";
        });
        if (window === undefined) throw new Error(`No window shows ${host}`);
        if (url !== "") return void window.webContents.loadURL(url);
        if (action === "crash") window.webContents.forcefullyCrashRenderer();
        else if (action === "hide") window.hide();
        else if (action === "close") window.close();
        else window.show();
      },
      [app, action, url] as const,
    ),
  );

const shown = (page: Page, label: string) =>
  driver(label, () =>
    page.getByRole("heading", { name: "Installed app" }).waitFor({ timeout: 5_000 }),
  ).pipe(Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }));

const reloaded = (electron: ElectronApplication, app: string, label: string) =>
  eventually(
    label,
    driver("read the app window's heading", () =>
      electron.evaluate(({ BrowserWindow }, app) => {
        const host = `${app.replace(/^app_/, "app-")}.localhost`;
        const window = BrowserWindow.getAllWindows().find((candidate) => {
          const shown = URL.parse(candidate.webContents.getURL());
          return shown?.hostname === host && shown.pathname === "/";
        });
        if (
          window === undefined ||
          window.webContents.isCrashed() ||
          window.webContents.isLoading()
        )
          return Promise.resolve("");
        return window.webContents.executeJavaScript(
          'document.querySelector("h1")?.textContent ?? ""',
        );
      }, app),
    ),
    (heading) => heading === "Installed app",
  );

it.live(scenarios.desktopAppColdStart.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* desktopHome;
      const name = appName();
      const managed = path.join(home.cacheHome, "Applications", "Executor Apps");
      const foreignPlist = path.join(managed, `${name}.app`, "Contents", "Info.plist");
      const foreignText =
        '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.someone-else</string></dict></plist>';
      if (process.platform === "darwin") {
        yield* fs.makeDirectory(path.dirname(foreignPlist), { recursive: true });
        yield* fs.writeFileString(foreignPlist, foreignText);
      }
      const { server, app } = yield* Effect.scoped(
        Effect.gen(function* () {
          const desktop = yield* startDesktopIn(home, name);
          const { electron, dashboard, app, server } = desktop;
          yield* answerDialogs(electron, { [`Install ${name}`]: 0 });
          expect((yield* host(dashboard, "install the app", "install", app)).ok).toBe(true);
          expect(
            yield* host(
              dashboard,
              "keep the app out of the menu bar",
              "setPermission",
              app,
              "menuBar",
              "denied",
            ),
          ).toEqual({ ok: true, value: "denied" });
          const stored = (yield* storedApps(home.profile)).servers[server]?.apps[app];
          if (process.platform === "darwin") {
            const identity = createHash("sha256").update(`${server}\n${app}`).digest("hex");
            expect(stored?.launcher).toBe(
              path.join(managed, `${name} ${identity.slice(0, 6)}.app`),
            );
            expect(yield* fs.readFileString(foreignPlist)).toBe(foreignText);
          }
          return { server, app };
        }),
      );

      const decoy = path.join(home.home, "decoy-launcher");
      yield* fs.writeFileString(decoy, "not written by Executor");
      const Editable = Schema.fromJsonString(
        Schema.Struct({
          version: Schema.Literal(1),
          servers: Schema.Record(
            Schema.String,
            Schema.Struct({
              apps: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
            }),
          ),
        }),
      );
      const file = path.join(home.profile, "installed-apps.json");
      const saved = yield* fs
        .readFileString(file)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Editable)));
      const record = saved.servers[server]?.apps[app];
      expect(record).toBeDefined();
      yield* fs.writeFileString(
        file,
        yield* Schema.encodeEffect(Editable)({
          ...saved,
          servers: {
            ...saved.servers,
            [server]: { apps: { [app]: { ...record, launcher: decoy } } },
          },
        }),
      );

      const link = `executor://app/${server}/${app}`;
      const electron = yield* launchDesktop({ cwd: home.home, env: home.env, args: [link] });
      const page = yield* appWindow(electron, app);
      yield* shown(page, "the app window opens signed in on a cold start");
      expect(yield* globals(page, "the cold-started window has only the app bridge")).toEqual({
        app: "object",
        host: "undefined",
      });
      expect(yield* nativeWindows(electron, app)).toMatchObject([{ title: name, path: "/" }]);

      const dashboard = yield* dashboardOf(electron);
      expect(yield* host(dashboard, "uninstall the app", "uninstall", app)).toEqual({ ok: true });
      expect((yield* storedApps(home.profile)).servers).toEqual({});
      expect(yield* fs.readFileString(decoy)).toBe("not written by Executor");
    }),
  ).pipe(Effect.provide(services)),
);

const installLink = (server: string, app: string, org?: string) =>
  `executor://install?${new URLSearchParams({ server, app, ...(org === undefined ? {} : { org }) }).toString()}`;

const identitySite = (identity: unknown) =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.callback<ReturnType<typeof createServer>>((resume) => {
        const server = createServer((_request, response) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(identity));
        });
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
      }),
      (server) =>
        Effect.callback<void>((resume) => {
          server.closeAllConnections();
          server.close(() => resume(Effect.void));
        }),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      return yield* Effect.die("The identity site has no port");
    return `http://127.0.0.1:${address.port}`;
  });

const installDialog = (name: string) => ({
  title: `Install ${name}`,
  message: `${onThisComputer(name)} will be installed as an app on this computer.`,
  detail:
    "It gets its own window and icon. It can't reach your files or accounts beyond what the app already uses.",
});

it.live(scenarios.desktopInstallLink.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const desktop = yield* startDesktop;
      const { electron, dashboard, name, app, server, profile, data } = desktop;
      const open = (link: string) => openDesktopLink({ cwd: desktop.home, env: desktop.env, link });
      const install = `Install ${name}`;
      const link = installLink(desktop.origin, app);

      yield* answerDialogs(electron, { [install]: 1 });
      expect(yield* open(link)).toBe(0);
      const [cancelled] = yield* eventually(
        "the link showed the install dialog",
        dialogsTitled(electron, install),
        (boxes) => boxes.length === 1,
      );
      expect(cancelled).toEqual(installDialog(name));
      expect(yield* host(dashboard, "a cancelled link installs nothing", "installed", app)).toEqual(
        { ok: true, value: null },
      );
      expect(yield* nativeWindows(electron, app)).toEqual([]);
      yield* driver("open the app's page in the dashboard", () =>
        dashboard
          .goto(`${desktop.origin}/apps/${app}`)
          .then(() =>
            dashboard
              .getByRole("button", { name: "Install as app", exact: true })
              .waitFor({ timeout: 60_000 }),
          ),
      );

      yield* answerDialogs(electron, { [install]: "held" });
      expect(yield* open(link)).toBe(0);
      yield* eventually(
        "the install dialog waits for an answer",
        heldDialogs(electron, install),
        (count) => count === 1,
      );
      expect(yield* open(link)).toBe(0);
      yield* eventsNamed(data, "Ignored a repeated install link", 1);
      expect(yield* heldDialogs(electron, install)).toBe(1);
      yield* releaseHeldDialog(electron, install, 0);
      const page = yield* appWindow(electron, app);
      yield* shown(page, "the installed app opens signed in");
      expect(yield* nativeWindows(electron, app)).toMatchObject([{ title: name, path: "/" }]);
      expect(yield* host(dashboard, "the link installed the app", "installed", app)).toMatchObject({
        ok: true,
        value: { server, app, name },
      });
      expect(yield* dialogsTitled(electron, install)).toHaveLength(1);
      yield* driver("the dashboard's app page shows the link's install without a reload", () =>
        dashboard
          .getByRole("button", { name: "Uninstall", exact: true })
          .waitFor({ timeout: 30_000 }),
      );
      expect(
        yield* driver("the app page no longer offers to install", () =>
          dashboard.getByRole("button", { name: "Install as app", exact: true }).count(),
        ),
      ).toBe(0);

      const foreign = yield* foreignSite;
      const otherComputer = yield* identitySite({
        serverId: `local-${randomBytes(16).toString("hex")}`,
        kind: "local",
      });
      const localHost = new URL(desktop.origin).host;
      const unusable = "It is not a link to install an app from an Executor dashboard.";
      const cases = [
        {
          link: installLink("http://executor.example.com", app),
          title: "Executor can't use this link",
          detail: unusable,
        },
        {
          link: `${link}&next=${encodeURIComponent("https://example.com")}`,
          title: "Executor can't use this link",
          detail: unusable,
        },
        {
          link: installLink(desktop.origin, "../dashboard"),
          title: "Executor can't use this link",
          detail: unusable,
        },
        {
          link: installLink(foreign, app),
          title: "Executor can't install this app",
          detail: `${new URL(foreign).host} did not answer as an Executor server.`,
        },
        {
          link: installLink(otherComputer, app),
          title: "Executor can't install this app",
          detail: `${new URL(otherComputer).host} is an Executor on another computer. Only this computer's Executor and the accounts you sign in to can install apps here.`,
        },
        {
          link: installLink(desktop.origin, app, "org_elsewhere"),
          title: "Executor can't use this link",
          detail: `${localHost} is an Executor on a computer, which has no teams, but the link names one.`,
        },
        {
          link: installLink(desktop.origin, "app_missing"),
          title: "This app isn't available",
          detail:
            "this computer's Executor has no app with this link that you can open, or it has no page to open as an app. It may have been removed, or you may not have access to it.",
        },
      ];
      const shownPrompts: Array<{ title: string; detail: string; buttons: Array<string> }> = [];
      for (const refused of cases) {
        expect(yield* open(refused.link)).toBe(0);
        const prompt = yield* Effect.suspend(() => {
          const found = electron
            .windows()
            .find((page) => !page.isClosed() && page.url().startsWith("data:"));
          return found === undefined
            ? Effect.fail(new Error("No window explains the refused link"))
            : Effect.succeed(found);
        }).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }));
        shownPrompts.push(
          yield* driver("read the refusal", () =>
            Promise.all([
              prompt.getByRole("dialog").getByRole("heading").innerText(),
              prompt.locator("#description").innerText(),
              prompt.locator(".actions button").allInnerTexts(),
            ]).then(([title, detail, buttons]) => ({ title, detail, buttons })),
          ),
        );
        yield* driver("close the refusal", () =>
          prompt.getByRole("button", { name: "OK", exact: true }).click(),
        );
        yield* eventually(
          "the refusal closed",
          Effect.sync(() => prompt.isClosed()),
          (closed) => closed,
        );
      }
      expect(shownPrompts).toEqual(
        cases.map(({ title, detail }) => ({ title, detail, buttons: ["OK"] })),
      );
      expect(yield* dialogsTitled(electron, install)).toHaveLength(1);
      expect(Object.keys((yield* storedApps(profile)).servers[server]?.apps ?? {})).toEqual([app]);
      expect(yield* nativeWindows(electron, app)).toHaveLength(1);
    }),
  ).pipe(Effect.provide(services)),
);

const statePage = (electron: ElectronApplication, name: string) =>
  driver(`find the page that explains why ${name} did not open`, () =>
    Promise.all(
      electron
        .windows()
        .filter((page) => !page.isClosed() && page.url().startsWith("data:"))
        .map((page) =>
          page
            .title()
            .then((title) => ({ page, title }))
            .catch(() => ({ page, title: "" })),
        ),
    ).then((pages) => {
      const found = pages.find(({ title }) => title === name);
      if (found === undefined) throw new Error(`No window explains why ${name} did not open`);
      return Promise.all([
        found.page.getByRole("heading").innerText(),
        found.page.getByRole("button").allInnerTexts(),
      ]).then(([heading, buttons]) => ({ page: found.page, heading, buttons }));
    }),
  ).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }));

it.live(scenarios.desktopAppStates.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const desktop = yield* startDesktop;
      const { electron, dashboard, name, app, server } = desktop;
      yield* answerDialogs(electron, { [`Install ${name}`]: 0, [`${name} permission`]: 1 });
      expect(yield* host(dashboard, "install the app", "install", app)).toMatchObject({ ok: true });
      const cli = yield* desktopCli({
        env: { ...desktop.env, EXECUTOR_DATA_DIR: desktop.data },
        cwd: desktop.home,
      });
      expect((yield* cli.run(["service", "stop"])).code).toBe(0);
      const link = `executor://app/${server}/${app}`;
      expect(yield* openDesktopLink({ cwd: desktop.home, env: desktop.env, link })).toBe(0);
      const offline = yield* statePage(electron, name);
      expect({ heading: offline.heading, buttons: offline.buttons }).toEqual({
        heading: "Can't reach this computer's Executor",
        buttons: ["Close", "Retry"],
      });
      expect(yield* nativeWindows(electron, app)).toEqual([]);
      expect((yield* cli.run(["service", "start"])).code).toBe(0);
      desktop.seen.push(yield* nextServer(desktop.data, desktop.seen));
      const ready = yield* dashboardOf(electron);
      yield* eventually(
        "Retry opens the app once its server runs again",
        driver("press Retry", () =>
          offline.page.isClosed()
            ? Promise.resolve(true)
            : offline.page
                .getByRole("button", { name: "Retry" })
                .click({ timeout: 2_000 })
                .then(() => false)
                .catch(() => offline.page.isClosed()),
        ).pipe(Effect.andThen(nativeWindows(electron, app))),
        (windows) => windows.length === 1,
      );
      const page = yield* appWindow(electron, app);
      yield* shown(page, "the app opens after Retry");
      expect(offline.page.isClosed()).toBe(true);

      yield* driver("close the app", () => page.close());
      const removed = yield* driver("remove the app from its server", () =>
        ready.request.delete(`${desktop.origin}/v1/apps/${app}`, {
          headers: { authorization: `Bearer ${desktop.apiKey}` },
        }),
      );
      expect(removed.status()).toBe(200);
      expect(yield* openDesktopLink({ cwd: desktop.home, env: desktop.env, link })).toBe(0);
      const gone = yield* statePage(electron, name);
      expect({ heading: gone.heading, buttons: gone.buttons }).toEqual({
        heading: `${name} is no longer available`,
        buttons: ["Close", "Uninstall"],
      });
      yield* driver("uninstall it from that page", () =>
        gone.page.getByRole("button", { name: "Uninstall" }).click(),
      );
      yield* eventually(
        "the removed app is uninstalled",
        storedApps(desktop.profile).pipe(Effect.map((stored) => Object.keys(stored.servers))),
        (servers) => servers.length === 0,
      );
      expect(yield* nativeWindows(electron, app)).toEqual([]);
    }),
  ).pipe(Effect.provide(services)),
);

it.live(scenarios.desktopInstallLinkColdStart.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const home = yield* desktopHome;
      const name = appName();
      const { server, app } = yield* Effect.scoped(
        Effect.map(startDesktopIn(home, name), ({ server, app }) => ({ server, app })),
      );
      const running = home.seen[0];
      if (running === undefined) return yield* Effect.die("No background server ran");
      const held = yield* suspendProcess(running.pid);
      const electron = yield* launchDesktop({
        cwd: home.home,
        env: home.env,
        args: [installLink(home.origin, app)],
      });
      yield* answerDialogs(electron, { [`Install ${name}`]: 0 });
      yield* held.resume;
      const page = yield* appWindow(electron, app);
      yield* shown(page, "the app installed from a cold start opens signed in");
      expect(yield* dialogsTitled(electron, `Install ${name}`)).toEqual([installDialog(name)]);
      expect(Object.keys((yield* storedApps(home.profile)).servers[server]?.apps ?? {})).toEqual([
        app,
      ]);
      const dashboard = yield* dashboardOf(electron);
      expect(
        yield* host(dashboard, "the dashboard sees the install", "installed", app),
      ).toMatchObject({ ok: true, value: { server, app, name } });
    }),
  ).pipe(Effect.provide(services)),
);

it.live(scenarios.desktopAppRevocation.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const desktop = yield* startDesktop;
      const { electron, dashboard, name, app, profile, server } = desktop;
      const permissionTitle = `${name} permission`;
      yield* watchDesktopShell(electron);
      yield* answerDialogs(electron, { [`Install ${name}`]: 0, [permissionTitle]: "held" });
      expect((yield* host(dashboard, "install the app", "install", app)).ok).toBe(true);
      const opening = yield* Effect.forkChild(host(dashboard, "open the app", "open", app));
      yield* eventually(
        "the menu-bar prompt waits",
        heldDialogs(electron, permissionTitle),
        (count) => count === 1,
      );
      yield* releaseHeldDialog(electron, permissionTitle, 1);
      expect(yield* Fiber.join(opening)).toEqual({ ok: true });
      const page = yield* appWindow(electron, app);
      yield* shown(page, "the app window shows the app");

      const answerLate = <A, PendingError, ChangeError>(
        label: string,
        pending: Effect.Effect<A, PendingError>,
        change: Effect.Effect<unknown, ChangeError>,
      ) =>
        Effect.gen(function* () {
          const call = yield* Effect.forkChild(pending);
          yield* eventually(
            `${label}: the prompt waits`,
            heldDialogs(electron, permissionTitle),
            (count) => count === 1,
          );
          yield* change;
          yield* releaseHeldDialog(electron, permissionTitle, 0);
          return yield* Fiber.join(call);
        });

      expect(
        yield* answerLate(
          "shortcuts",
          bridge(
            page,
            "register while the prompt waits",
            "registerShortcut",
            "CommandOrControl+Alt+K",
          ),
          host(dashboard, "deny shortcuts meanwhile", "setPermission", app, "shortcuts", "denied"),
        ),
      ).toEqual({
        ok: false,
        failure: { _tag: "DesktopPermissionDenied", permission: "shortcuts" },
      });
      expect(yield* isRegistered(electron, "CommandOrControl+Alt+K")).toBe(false);

      expect(
        yield* host(
          dashboard,
          "ask about the menu bar again",
          "setPermission",
          app,
          "menuBar",
          "prompt",
        ),
      ).toEqual({ ok: true, value: "prompt" });
      expect(
        yield* answerLate(
          "menu bar",
          bridge(page, "set a title while the prompt waits", "setMenuBarTitle", "Hi"),
          host(dashboard, "deny the menu bar meanwhile", "setPermission", app, "menuBar", "denied"),
        ),
      ).toEqual({ ok: false, failure: { _tag: "DesktopPermissionDenied", permission: "menuBar" } });
      expect(yield* menuBarItems(electron)).toEqual([]);
      expect((yield* storedApps(profile)).servers[server]?.apps[app]?.permissions).toEqual({
        menuBar: "denied",
        shortcuts: "denied",
      });

      const floating = yield* Effect.forkChild(
        bridge(page, "float while the prompt waits", "setFloating", true).pipe(Effect.result),
      );
      yield* eventually(
        "the floating prompt waits",
        heldDialogs(electron, permissionTitle),
        (count) => count === 1,
      );
      expect(yield* host(dashboard, "uninstall the app meanwhile", "uninstall", app)).toEqual({
        ok: true,
      });
      expect(yield* host(dashboard, "install the app again", "install", app)).toMatchObject({
        ok: true,
      });
      yield* releaseHeldDialog(electron, permissionTitle, 0);
      yield* Fiber.join(floating);
      expect((yield* storedApps(profile)).servers[server]?.apps[app]?.permissions).toEqual({});
      expect(yield* nativeWindows(electron, app)).toEqual([]);
    }),
  ).pipe(Effect.provide(services)),
);

it.live(scenarios.desktopAppLifecycle.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const desktop = yield* startDesktop;
      const { electron, dashboard, name, app } = desktop;
      yield* watchDesktopShell(electron);
      yield* answerDialogs(electron, { [`Install ${name}`]: 0, [`${name} permission`]: 0 });
      expect((yield* host(dashboard, "install the app", "install", app)).ok).toBe(true);
      expect(yield* host(dashboard, "open the app", "open", app)).toEqual({ ok: true });
      let page = yield* appWindow(electron, app);
      yield* shown(page, "the app window shows the app");
      yield* eventually(
        "the menu-bar item shows",
        menuBarItems(electron),
        (items) => items.length === 1,
      );
      const accelerator = "CommandOrControl+Alt+K";
      expect(
        yield* bridge(page, "register a shortcut", "registerShortcut", accelerator),
      ).toMatchObject({ ok: true });
      expect(yield* bridge(page, "float the window", "setFloating", true)).toEqual({ ok: true });

      yield* appWindowAction(electron, app, "crash");
      yield* eventually(
        "the crash releases the shortcut",
        isRegistered(electron, accelerator),
        (registered) => !registered,
      );
      expect(
        (yield* nativeWindows(electron, app)).find((window) => window.path === "/")?.floating,
      ).toBe(false);
      yield* reloaded(electron, app, "the window reloads after a crash");
      expect(yield* menuBarItems(electron)).toEqual([name]);
      for (const attempt of [2, 3]) {
        yield* appWindowAction(electron, app, "crash");
        yield* Effect.sleep("500 millis");
        yield* reloaded(electron, app, `the window reloads after crash ${attempt}`);
      }
      yield* appWindowAction(electron, app, "crash");
      yield* eventually(
        "a fourth crash ends the app",
        nativeWindows(electron, app),
        (windows) => windows.length === 0,
      );
      expect(yield* menuBarItems(electron)).toEqual([]);

      expect(yield* host(dashboard, "open the app again", "open", app)).toEqual({ ok: true });
      const before = yield* appWindow(electron, app);
      yield* shown(before, "the app opens again");
      expect(
        yield* bridge(before, "register the shortcut again", "registerShortcut", accelerator),
      ).toMatchObject({ ok: true });
      expect(yield* bridge(before, "float again", "setFloating", true)).toEqual({ ok: true });
      const [first] = desktop.seen;
      if (first === undefined) return yield* Effect.die("No background server was recorded");
      yield* crashServer(first.pid);
      expect(
        yield* eventually(
          "losing the server releases the app before the next server is ready",
          Effect.all({
            windows: nativeWindows(electron, app).pipe(Effect.map((windows) => windows.length)),
            items: menuBarItems(electron),
            shortcut: isRegistered(electron, accelerator),
          }),
          (state) => state.windows === 0,
        ),
      ).toEqual({ windows: 0, items: [], shortcut: false });
      desktop.seen.push(yield* nextServer(desktop.data, desktop.seen));
      yield* eventually(
        "the old window closes with its server",
        Effect.sync(() => before.isClosed()),
        (closed) => closed,
      );
      const reopened = yield* appWindow(electron, app);
      yield* shown(reopened, "the app reopens signed in to the same server");
      expect(yield* isRegistered(electron, accelerator)).toBe(false);
      expect(
        (yield* nativeWindows(electron, app)).find((window) => window.path === "/")?.floating,
      ).toBe(false);
      expect(
        yield* eventually(
          "the menu-bar item returns",
          menuBarItems(electron),
          (items) => items.length === 1,
        ),
      ).toEqual([name]);
      expect(
        yield* bridge(
          reopened,
          "the grant survives for the same server",
          "permission",
          "shortcuts",
        ),
      ).toEqual({ ok: true, value: "granted" });
    }),
  ).pipe(Effect.provide(services)),
);

it.live(scenarios.desktopAppIsolation.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const desktop = yield* startDesktop;
      const { electron, dashboard, name, app } = desktop;
      const otherName = appName();
      const other = yield* deployApp(dashboard, desktop, otherName);
      const foreign = yield* foreignSite;
      yield* recordExternalOpens(electron);
      yield* answerDialogs(electron, {
        [`Install ${name}`]: 0,
        [`Install ${otherName}`]: 0,
        [`${name} permission`]: 1,
        [`${otherName} permission`]: 1,
      });
      for (const id of [app, other]) {
        expect((yield* host(dashboard, "install an app", "install", id)).ok).toBe(true);
        expect(yield* host(dashboard, "open an app", "open", id)).toEqual({ ok: true });
      }
      const page = yield* appWindow(electron, app);
      const otherPage = yield* appWindow(electron, other);
      yield* shown(page, "the first app shows");
      yield* shown(otherPage, "the second app shows");

      yield* answerDialogs(electron, { [`${name} permission`]: 0, [`${otherName} permission`]: 1 });
      const registered = yield* bridge(
        page,
        "the first app registers a shortcut",
        "registerShortcut",
        "CommandOrControl+Alt+K",
      );
      expect(registered).toMatchObject({ ok: true });
      const id = registered.ok
        ? Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(registered.value).id
        : "";
      expect(
        yield* bridge(otherPage, "the second app has not been asked", "permission", "shortcuts"),
      ).toEqual({ ok: true, value: "prompt" });
      expect(
        yield* bridge(
          otherPage,
          "the second app is refused",
          "registerShortcut",
          "CommandOrControl+Alt+L",
        ),
      ).toEqual({
        ok: false,
        failure: { _tag: "DesktopPermissionDenied", permission: "shortcuts" },
      });
      expect(
        yield* bridge(
          otherPage,
          "the second app names the first app's shortcut",
          "unregisterShortcut",
          id,
        ),
      ).toEqual({ ok: true });
      expect(yield* isRegistered(electron, "CommandOrControl+Alt+K")).toBe(true);
      expect(
        yield* host(dashboard, "read the first app's permissions", "permissions", app),
      ).toMatchObject({ ok: true, value: { shortcuts: "granted" } });
      expect(
        yield* host(dashboard, "read the second app's permissions", "permissions", other),
      ).toMatchObject({ ok: true, value: { shortcuts: "denied" } });

      expect(
        yield* host(
          dashboard,
          "allow the first app's notifications",
          "setPermission",
          app,
          "notifications",
          "granted",
        ),
      ).toEqual({ ok: true, value: "granted" });
      expect(
        yield* driver("the app reads its notification grant", () =>
          page.evaluate(() => Notification.permission),
        ),
      ).toBe("granted");
      expect(
        yield* driver("the second app has none", () =>
          otherPage.evaluate(() => Notification.permission),
        ),
      ).not.toBe("granted");
      yield* appWindowAction(electron, app, "hide");
      yield* driver("click a notification from script", () =>
        page.evaluate(() => {
          new Notification("Synthetic").dispatchEvent(new Event("click"));
          return new Promise((resolve) => setTimeout(resolve, 1_000));
        }),
      );
      expect(
        (yield* nativeWindows(electron, app)).find((window) => window.path === "/")?.visible,
      ).toBe(false);
      yield* appWindowAction(electron, app, "show");

      const addFrame = (src: string) =>
        driver("add an iframe", () =>
          page.evaluate((src) => {
            const frame = document.createElement("iframe");
            frame.src = src;
            document.body.append(frame);
          }, src),
        );
      const frameAt = (url: string) =>
        eventually(
          `a frame shows ${url}`,
          Effect.sync(() => page.frames().find((frame) => frame.url() === url)),
          (frame) => frame !== undefined,
        ).pipe(
          Effect.flatMap((frame) =>
            frame === undefined ? Effect.die("No frame") : Effect.succeed(frame),
          ),
        );
      yield* addFrame(`${foreign}/framed`);
      const framed = yield* frameAt(`${foreign}/framed`);
      expect(
        yield* driver("the foreign iframe reads the bridges", () =>
          framed.evaluate(() => ({
            app: typeof Reflect.get(window, "__executorDesktop"),
            host: typeof Reflect.get(window, "__executorDesktopHost"),
            notifications: Notification.permission,
          })),
        ),
      ).toMatchObject({
        app: "undefined",
        host: "undefined",
        notifications: expect.not.stringMatching(/^granted$/u),
      });
      yield* addFrame(`${foreign}/redirect`);
      yield* frameAt(`${foreign}/landing`);

      yield* driver("add a link", () =>
        page.evaluate((url) => {
          const link = document.createElement("a");
          link.id = "out";
          link.href = url;
          link.target = "_blank";
          link.textContent = "Out";
          document.body.prepend(link);
        }, `${foreign}/clicked`),
      );
      yield* driver("click the link", () => page.click("#out"));
      expect(
        yield* eventually(
          "the click opens the system browser",
          externalOpens(electron),
          (opened) => opened.length === 1,
        ),
      ).toEqual([`${foreign}/clicked`]);

      yield* driver("leave the app without a click", () =>
        page.evaluate((url) => {
          window.open(`${url}/popup`);
          window.location.href = `${url}/away`;
        }, foreign),
      );
      yield* Effect.sleep("1 second");
      expect(URL.parse(page.url())?.hostname).toBe(`${app.replace(/^app_/, "app-")}.localhost`);
      expect(yield* externalOpens(electron)).toEqual([`${foreign}/clicked`]);
      yield* appWindowAction(electron, app, "show", `${foreign}/elsewhere`);
      yield* eventually(
        "the window shows another site",
        Effect.sync(() => page.url()),
        (url) => url === `${foreign}/elsewhere`,
      );
      yield* driver("the other site loads", () =>
        page.getByRole("heading", { name: "Foreign /elsewhere" }).waitFor(),
      );
      expect(
        yield* driver("the navigated-away page reads the bridges", () =>
          page.evaluate(() => ({
            app: typeof Reflect.get(window, "__executorDesktop"),
            host: typeof Reflect.get(window, "__executorDesktopHost"),
            notifications: Notification.permission,
          })),
        ),
      ).toMatchObject({
        app: "undefined",
        host: "undefined",
        notifications: expect.not.stringMatching(/^granted$/u),
      });
    }),
  ).pipe(Effect.provide(services)),
);

it.live(scenarios.desktopAppStoreUnreadable.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* desktopHome;
      const unreadable = path.join(home.profile, "installed-apps.json");
      yield* fs.makeDirectory(unreadable, { recursive: true });
      yield* fs.writeFileString(path.join(unreadable, "kept"), "kept");
      const desktop = yield* startDesktopIn(home);
      const { electron, dashboard, app, server } = desktop;
      yield* answerDialogs(electron, {});
      const unavailable = { ok: false, failure: { _tag: "DesktopUnavailable" } };
      expect(yield* host(dashboard, "read whether the app is installed", "installed", app)).toEqual(
        unavailable,
      );
      expect(yield* host(dashboard, "install the app", "install", app)).toEqual(unavailable);
      expect(
        yield* openDesktopLink({
          cwd: home.home,
          env: home.env,
          link: `executor://app/${server}/${app}`,
        }),
      ).toBe(0);
      yield* eventually("opening explains it", answeredDialogs(electron), (boxes) =>
        (boxes ?? []).some((box) => box.message === "Executor could not open this app."),
      );
      expect((yield* answeredDialogs(electron))?.map((box) => box.title)).not.toContain(
        `Install ${desktop.name}`,
      );
      expect(yield* nativeWindows(electron, app)).toEqual([]);
      expect((yield* fs.stat(unreadable)).type).toBe("Directory");
      expect(yield* fs.readFileString(path.join(unreadable, "kept"))).toBe("kept");
    }),
  ).pipe(Effect.provide(services)),
);

type AppWindowState = Effect.Success<ReturnType<typeof nativeWindows>>[number];

const mainWindowOf = (electron: ElectronApplication, app: string) =>
  nativeWindows(electron, app).pipe(
    Effect.map((windows) => windows.find((window) => window.path === "/")),
  );

const mainWindowIs = (
  electron: ElectronApplication,
  app: string,
  label: string,
  done: (window: AppWindowState) => boolean,
) =>
  eventually(label, mainWindowOf(electron, app), (window) => window !== undefined && done(window));

const focusDashboard = (electron: ElectronApplication, origin: string) =>
  driver("focus the dashboard window", () =>
    electron.evaluate(({ BrowserWindow }, origin) => {
      const found = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().startsWith(origin),
      );
      if (found === undefined) throw new Error("The desktop shows no dashboard window");
      found.show();
      found.focus();
    }, origin),
  );

const windowEvents = (page: Page) =>
  driver("read the page's window events", () =>
    page.evaluate(() => document.body.dataset.windowEvents ?? ""),
  );

const watchBadges = (electron: ElectronApplication) =>
  driver("record badge counts and overlays", () =>
    electron.evaluate(({ app, BrowserWindow }) => {
      const record = { counts: [] as Array<number>, overlays: [] as Array<string> };
      Object.assign(globalThis, { executorE2EBadges: record });
      const setBadgeCount = app.setBadgeCount.bind(app);
      app.setBadgeCount = (count?: number) => {
        record.counts.push(count ?? 0);
        return setBadgeCount(count);
      };
      if (process.platform !== "win32") return;
      const setOverlayIcon = BrowserWindow.prototype.setOverlayIcon;
      BrowserWindow.prototype.setOverlayIcon = function (
        this: Electron.BrowserWindow,
        overlay: Electron.NativeImage | null,
        description: string,
      ) {
        record.overlays.push(description);
        return setOverlayIcon.call(this, overlay, description);
      };
    }),
  );

const badges = (electron: ElectronApplication) =>
  driver("read badge counts and overlays", () =>
    electron.evaluate(
      () =>
        Reflect.get(globalThis, "executorE2EBadges") as {
          counts: Array<number>;
          overlays: Array<string>;
        },
    ),
  );

const badgeShows = (electron: ElectronApplication, name: string, count: number) =>
  eventually(`the badge shows ${count}`, badges(electron), (record) =>
    process.platform === "win32"
      ? record.overlays.at(-1) === (count === 0 ? "" : `${name}: ${count}`)
      : record.counts.at(-1) === count,
  );

const installAndOpen = (
  desktop: Effect.Success<ReturnType<typeof startDesktopIn>>,
  answers: Readonly<Record<string, number>>,
) =>
  Effect.gen(function* () {
    const { electron, dashboard, name, app } = desktop;
    yield* answerDialogs(electron, { [`Install ${name}`]: 0, ...answers });
    expect((yield* host(dashboard, "install the app", "install", app)).ok).toBe(true);
    expect(yield* host(dashboard, "open the app", "open", app)).toEqual({ ok: true });
    const page = yield* appWindow(electron, app);
    yield* driver("the app window shows the app", () =>
      page.getByRole("heading", { name: "Installed app" }).waitFor({ timeout: 60_000 }),
    );
    return page;
  });

it.live(scenarios.desktopAppWindows.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const desktop = yield* startDesktop;
      const { electron, name, app, origin } = desktop;
      const permissionTitle = `${name} permission`;
      yield* watchBadges(electron);
      const page = yield* installAndOpen(desktop, { [permissionTitle]: 1 });
      yield* mainWindowIs(electron, app, "the window is visible", (window) => window.visible);

      expect(yield* bridge(page, "hide the window", "windowAction", "hide")).toEqual({ ok: true });
      yield* mainWindowIs(electron, app, "the window hides", (window) => !window.visible);
      expect(yield* bridge(page, "the hidden page keeps running", "permission", "menuBar")).toEqual(
        { ok: true, value: "denied" },
      );
      expect(yield* bridge(page, "show the window", "windowAction", "show")).toEqual({ ok: true });
      yield* mainWindowIs(electron, app, "the window shows", (window) => window.visible);

      yield* focusDashboard(electron, origin);
      yield* mainWindowIs(electron, app, "the dashboard takes focus", (window) => !window.focused);
      expect(yield* bridge(page, "focus the window", "windowAction", "focus")).toEqual({
        ok: true,
      });
      yield* mainWindowIs(
        electron,
        app,
        "the window comes to the front",
        (window) => window.visible && window.focused,
      );
      yield* eventually("the page hears it lose and regain focus", windowEvents(page), (events) =>
        events.endsWith("blur focus "),
      );
      expect(yield* bridge(page, "toggle the focused window", "windowAction", "toggle")).toEqual({
        ok: true,
      });
      yield* mainWindowIs(electron, app, "toggling hides a focused window", (window) => {
        return !window.visible;
      });
      expect(yield* bridge(page, "toggle the hidden window", "windowAction", "toggle")).toEqual({
        ok: true,
      });
      yield* mainWindowIs(
        electron,
        app,
        "toggling focuses a hidden window",
        (window) => window.visible && window.focused,
      );

      expect(
        yield* bridge(page, "open another window", "openWindow", "/second?tab=1", {
          width: 420,
          height: 300,
        }),
      ).toEqual({ ok: true });
      const second = yield* appWindow(electron, app, "/second");
      yield* driver("the other window shows the app", () =>
        second.getByRole("heading", { name: "Installed app" }).waitFor({ timeout: 60_000 }),
      );
      expect(yield* globals(second, "the other window has the app bridge")).toEqual({
        app: "object",
        host: "undefined",
      });
      expect(
        yield* bridge(second, "the other window shares the app's answers", "permission", "menuBar"),
      ).toEqual({ ok: true, value: "denied" });
      const others = nativeWindows(electron, app).pipe(
        Effect.map((windows) => windows.filter((window) => window.path !== "/")),
      );
      expect(yield* others).toMatchObject([
        { path: "/second", search: "?tab=1", size: [420, 300], title: name, visible: true },
      ]);
      expect(
        yield* bridge(page, "open the same path again", "openWindow", "/second?tab=1", {}),
      ).toEqual({ ok: true });
      expect(yield* others).toHaveLength(1);
      expect(
        yield* bridge(page, "open a window elsewhere", "openWindow", "//example.com/", {}),
      ).toEqual({
        ok: false,
        failure: { _tag: "DesktopInvalidInput", message: "The desktop bridge call is invalid." },
      });
      expect(
        yield* bridge(page, "open a floating window, denied", "openWindow", "/float", {
          floating: true,
        }),
      ).toEqual({
        ok: false,
        failure: { _tag: "DesktopPermissionDenied", permission: "floating" },
      });
      expect(yield* bridge(second, "hide the other window", "windowAction", "hide")).toEqual({
        ok: true,
      });
      yield* eventually(
        "only the other window hides",
        nativeWindows(electron, app),
        (windows) =>
          windows.some((window) => window.path === "/second" && !window.visible) &&
          windows.some((window) => window.path === "/" && window.visible),
      );
      for (const index of [1, 2, 3, 4, 5, 6, 7])
        expect(
          yield* bridge(page, `open window ${index}`, "openWindow", `/more/${index}`, {}),
        ).toEqual({ ok: true });
      expect(yield* bridge(page, "open a ninth other window", "openWindow", "/more/8", {})).toEqual(
        {
          ok: false,
          failure: {
            _tag: "DesktopInvalidInput",
            message: `${name} already has 8 other windows open. Close one before opening another.`,
          },
        },
      );

      expect(yield* bridge(page, "badge the app", "setBadge", 3)).toEqual({ ok: true });
      yield* badgeShows(electron, name, 3);
      for (const [label, count] of [
        ["refuse a fraction", 2.5],
        ["refuse a negative count", -1],
        ["refuse a count too large", 100_000],
      ] as const)
        expect(yield* bridge(page, label, "setBadge", count)).toEqual({
          ok: false,
          failure: { _tag: "DesktopInvalidInput", message: "The desktop bridge call is invalid." },
        });
      expect(yield* bridge(second, "badge from the other window", "setBadge", 5)).toEqual({
        ok: true,
      });
      yield* badgeShows(electron, name, 5);
      expect(yield* bridge(page, "clear the badge", "setBadge", 0)).toEqual({ ok: true });
      yield* badgeShows(electron, name, 0);
      expect(yield* bridge(page, "badge the app again", "setBadge", 7)).toEqual({ ok: true });
      yield* badgeShows(electron, name, 7);

      yield* appWindowAction(electron, app, "close");
      expect(
        yield* eventually(
          "closing the main window quits the app with its other windows",
          nativeWindows(electron, app),
          (windows) => windows.length === 0,
        ),
      ).toEqual([]);
      if (process.platform !== "win32") yield* badgeShows(electron, name, 0);
    }),
  ).pipe(Effect.provide(services)),
);

it.live(scenarios.desktopAppOpenAtPath.title, (context) =>
  Effect.scoped(
    Effect.gen(function* () {
      const desktop = yield* startDesktop;
      const { electron, dashboard, name, app, server } = desktop;
      yield* answerDialogs(electron, { [`Install ${name}`]: 0, [`${name} permission`]: 1 });
      expect((yield* host(dashboard, "install the app", "install", app)).ok).toBe(true);
      const link = `executor://app/${server}/${app}`;
      const open = (path: string) =>
        openDesktopLink({ cwd: desktop.home, env: desktop.env, link: `${link}${path}` });

      expect(yield* open("/notes/42?tab=edit")).toBe(0);
      const page = yield* appWindow(electron, app, "/notes/42");
      yield* driver("the app opens at the path", () =>
        page.getByRole("heading", { name: "Installed app" }).waitFor({ timeout: 60_000 }),
      );
      expect(yield* nativeWindows(electron, app)).toMatchObject([
        { path: "/notes/42", search: "?tab=edit", visible: true },
      ]);
      expect(yield* globals(page, "the page at the path has the app bridge")).toEqual({
        app: "object",
        host: "undefined",
      });

      expect(yield* open("/notes/7")).toBe(0);
      yield* eventually(
        "the running app's window moves to the new path",
        nativeWindows(electron, app),
        (windows) =>
          windows.length === 1 && windows[0]?.path === "/notes/7" && windows[0]?.search === "",
      );

      expect(yield* open("/notes/9#top")).toBe(0);
      yield* eventually(
        "a link with a fragment brings the dashboard forward instead",
        driver("read the dashboard's focus", () =>
          electron.evaluate(
            ({ BrowserWindow }, origin) =>
              BrowserWindow.getAllWindows().some(
                (window) => window.webContents.getURL().startsWith(origin) && window.isFocused(),
              ),
            desktop.origin,
          ),
        ),
        (focused) => focused,
      );
      expect(yield* nativeWindows(electron, app)).toMatchObject([{ path: "/notes/7" }]);
      yield* driver("record the unverified notification click", () =>
        context.annotate(
          "Unverified: a trusted click on a shown notification cannot be produced here, so a notification's data.path opening that path is not exercised; the same open-at-path step the link uses runs on it.",
          "unverified",
        ),
      );
    }),
  ).pipe(Effect.provide(services)),
);

const capture = (page: Page, label: string, constraints: { audio?: boolean; video?: boolean }) =>
  driver(label, () =>
    page.evaluate(
      (constraints) =>
        navigator.mediaDevices.getUserMedia(constraints).then(
          (stream) => {
            const kinds = stream
              .getTracks()
              .map((track) => track.kind)
              .sort();
            for (const track of stream.getTracks()) track.stop();
            return { kinds };
          },
          (error: unknown) => ({ error: error instanceof DOMException ? error.name : "other" }),
        ),
      constraints,
    ),
  );

const readClipboard = (page: Page, label: string) =>
  driver(label, () =>
    page.evaluate(() =>
      navigator.clipboard.readText().then(
        (text) => ({ text }),
        (error: unknown) => ({ error: error instanceof DOMException ? error.name : "other" }),
      ),
    ),
  );

it.live(scenarios.desktopAppCapture.title, (context) =>
  Effect.scoped(
    Effect.gen(function* () {
      const home = yield* desktopHome;
      const desktop = yield* startDesktopIn(home, appName(), [
        "--use-fake-device-for-media-stream",
      ]);
      const { electron, dashboard, name, app } = desktop;
      const permissionTitle = `${name} permission`;
      const hint = "You can change this later in the app's menu or in its Desktop settings.";
      const page = yield* installAndOpen(desktop, { [permissionTitle]: 1 });
      const asked = dialogsTitled(electron, permissionTitle).pipe(
        Effect.map((boxes) => boxes.map((box) => box.message)),
      );

      yield* answerDialogs(electron, { [permissionTitle]: 1 });
      expect(yield* capture(page, "record, denied", { audio: true })).toEqual({
        error: "NotAllowedError",
      });
      expect(yield* dialogsTitled(electron, permissionTitle)).toEqual([
        {
          title: permissionTitle,
          message: `${onThisComputer(name)} wants to use your microphone.`,
          detail: hint,
        },
      ]);
      expect(yield* capture(page, "record again", { audio: true })).toEqual({
        error: "NotAllowedError",
      });
      expect(yield* asked).toHaveLength(1);

      expect(
        yield* host(dashboard, "ask again", "setPermission", app, "microphone", "prompt"),
      ).toEqual({ ok: true, value: "prompt" });
      yield* answerDialogs(electron, { [permissionTitle]: 0 });
      expect(yield* capture(page, "record, allowed", { audio: true })).toEqual({
        kinds: ["audio"],
      });
      expect(yield* capture(page, "film, allowed", { video: true })).toEqual({ kinds: ["video"] });
      expect(yield* capture(page, "record and film", { audio: true, video: true })).toEqual({
        kinds: ["audio", "video"],
      });
      expect(yield* asked).toEqual([
        `${onThisComputer(name)} wants to use your microphone.`,
        `${onThisComputer(name)} wants to use your camera.`,
      ]);
      expect(
        yield* bridge(page, "read the microphone permission", "permission", "microphone"),
      ).toEqual({ ok: true, value: "granted" });

      yield* driver("mark the page before revoking", () =>
        page.evaluate(() => Reflect.set(window, "beforeRevoke", true)),
      );
      expect(
        yield* host(
          dashboard,
          "revoke the microphone",
          "setPermission",
          app,
          "microphone",
          "denied",
        ),
      ).toEqual({ ok: true, value: "denied" });
      yield* eventually(
        "revoking reloads the app's pages",
        driver("read the page's mark", () =>
          page.evaluate(() => Reflect.get(window, "beforeRevoke") === true),
        ).pipe(Effect.orElseSucceed(() => true)),
        (marked) => !marked,
      );
      yield* driver("the reloaded page shows the app", () =>
        page.getByRole("heading", { name: "Installed app" }).waitFor({ timeout: 60_000 }),
      );
      expect(yield* capture(page, "record, revoked", { audio: true })).toEqual({
        error: "NotAllowedError",
      });
      expect(yield* capture(page, "film, still allowed", { video: true })).toEqual({
        kinds: ["video"],
      });
      expect(yield* asked).toHaveLength(2);

      yield* driver("another app copies text", () =>
        electron.evaluate(({ clipboard }) => clipboard.writeText("Copied in another app")),
      );
      expect(yield* bridge(page, "focus the app", "windowAction", "focus")).toEqual({ ok: true });
      yield* eventually(
        "the page has focus",
        driver("read the page's focus", () => page.evaluate(() => document.hasFocus())),
        (focused) => focused,
      );
      yield* answerDialogs(electron, { [permissionTitle]: 1 });
      expect(yield* readClipboard(page, "read the clipboard, denied")).toEqual({
        error: "NotAllowedError",
      });
      expect(yield* dialogsTitled(electron, permissionTitle)).toEqual([
        {
          title: permissionTitle,
          message: `${onThisComputer(name)} wants to read what you copy.`,
          detail: `It can read text you copy in any app, whenever it asks. ${hint}`,
        },
      ]);
      expect(
        yield* host(dashboard, "ask again", "setPermission", app, "clipboardRead", "prompt"),
      ).toEqual({ ok: true, value: "prompt" });
      yield* answerDialogs(electron, { [permissionTitle]: 0 });
      expect(yield* readClipboard(page, "read the clipboard, allowed")).toEqual({
        text: "Copied in another app",
      });

      const displayAudio = driver("capture the display with audio", () =>
        page.evaluate(() =>
          navigator.mediaDevices.getDisplayMedia({ audio: true, video: true }).then(
            (stream) => {
              const kinds = stream.getAudioTracks().map((track) => track.kind);
              for (const track of stream.getTracks()) track.stop();
              return { kinds };
            },
            (error: unknown) => ({ error: error instanceof DOMException ? error.name : "other" }),
          ),
        ),
      );
      if (systemAudioAvailable) {
        yield* answerDialogs(electron, { [permissionTitle]: 0, "Allow system audio": 1 });
        const allowed = yield* bridge(page, "ask for system audio", "systemAudio");
        expect(yield* asked).toEqual([
          `${onThisComputer(name)} wants to hear audio playing on this computer.`,
        ]);
        expect((yield* dialogsTitled(electron, permissionTitle)).map((box) => box.detail)).toEqual([
          "For example the other people in a call. It can't see your screen.",
        ]);
        if (allowed.ok) expect(yield* displayAudio).toEqual({ kinds: ["audio"] });
        else {
          expect(allowed).toEqual({ ok: false, failure: { _tag: "SystemAudioBlocked" } });
          expect(yield* dialogsTitled(electron, "Allow system audio")).toEqual([
            {
              title: "Allow system audio",
              message: expect.stringMatching(/^Allow .+ to record system audio$/u),
              detail: expect.stringContaining(
                "System Settings › Privacy & Security › Screen & System Audio Recording",
              ),
            },
          ]);
        }
      } else {
        expect(
          yield* bridge(page, "read the system audio permission", "permission", "systemAudio"),
        ).toEqual({ ok: true, value: "unavailable" });
        expect(
          yield* bridge(page, "ask for system audio", "requestPermission", "systemAudio"),
        ).toEqual({ ok: true, value: "unavailable" });
        expect(yield* bridge(page, "capture system audio", "systemAudio")).toEqual({
          ok: false,
          failure: { _tag: "DesktopUnavailable" },
        });
        expect(yield* displayAudio).toMatchObject({ error: expect.any(String) });
        yield* driver("record the unverified system audio", () =>
          context.annotate(
            "Unverified: Electron captures system audio only on Windows and macOS 13 or later, so on Linux this checks that system audio is unavailable and getDisplayMedia is refused; the loopback track is not exercised.",
            "unverified",
          ),
        );
      }
      expect(yield* host(dashboard, "read the app's permissions", "permissions", app)).toEqual({
        ok: true,
        value: permissionStates({
          menuBar: "denied",
          microphone: "denied",
          camera: "granted",
          clipboardRead: "granted",
          ...(systemAudioAvailable ? { systemAudio: "granted" } : {}),
        }),
      });
    }),
  ).pipe(Effect.provide(services)),
);

it.live(scenarios.desktopAppStartAtLogin.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* desktopHome;
      const name = appName();
      const permissionTitle = `${name} permission`;
      const autostart = path.join(home.home, "config", "autostart");
      const loginItem = (electron: ElectronApplication) =>
        process.platform === "linux"
          ? Effect.gen(function* () {
              if (!(yield* fs.exists(autostart))) return [];
              const files = yield* fs.readDirectory(autostart);
              return yield* Effect.forEach(files, (file) =>
                fs.readFileString(path.join(autostart, file)),
              );
            })
          : driver("read Executor's login item", () =>
              electron.evaluate(({ app }) =>
                app.getLoginItemSettings().openAtLogin ? ["on"] : [],
              ),
            );
      const app = yield* Effect.scoped(
        Effect.gen(function* () {
          const desktop = yield* startDesktopIn(home, name);
          const { electron, dashboard, app } = desktop;
          const page = yield* installAndOpen(desktop, { [permissionTitle]: 1 });
          yield* answerDialogs(electron, { [permissionTitle]: 1 });
          expect(
            yield* bridge(
              page,
              "ask to start at login, denied",
              "requestPermission",
              "startAtLogin",
            ),
          ).toEqual({ ok: true, value: "denied" });
          expect(yield* dialogsTitled(electron, permissionTitle)).toEqual([
            {
              title: permissionTitle,
              message: `${onThisComputer(name)} wants to start when you log in to this computer.`,
              detail: `It opens without a window${process.platform === "darwin" ? ", in the menu bar" : ""} until you open it. You can change this later in the app's menu or in its Desktop settings.`,
            },
          ]);
          expect(yield* loginItem(electron)).toEqual([]);
          expect(
            yield* host(dashboard, "ask again", "setPermission", app, "startAtLogin", "prompt"),
          ).toEqual({ ok: true, value: "prompt" });
          yield* answerDialogs(electron, { [permissionTitle]: 0 });
          expect(
            yield* bridge(
              page,
              "ask to start at login, allowed",
              "requestPermission",
              "startAtLogin",
            ),
          ).toEqual({ ok: true, value: "granted" });
          const [entry] = yield* loginItem(electron);
          if (process.platform === "linux") {
            expect(entry).toContain("[Desktop Entry]");
            expect(entry).toMatch(/^Exec=.+ --executor-login$/mu);
          } else expect(entry).toBe("on");
          expect(
            yield* bridge(page, "ask again once allowed", "requestPermission", "startAtLogin"),
          ).toEqual({ ok: true, value: "granted" });
          expect(yield* dialogsTitled(electron, permissionTitle)).toHaveLength(1);
          return app;
        }),
      );

      const electron = yield* launchDesktop({
        cwd: home.home,
        env: home.env,
        args: ["--executor-login"],
      });
      const page = yield* appWindow(electron, app);
      yield* driver("the app opens at login", () =>
        page.getByRole("heading", { name: "Installed app" }).waitFor({ timeout: 60_000 }),
      );
      yield* mainWindowIs(electron, app, "the app opens hidden", (window) => !window.visible);
      expect(
        yield* driver("read the dashboard's visibility", () =>
          electron.evaluate(({ BrowserWindow }, app) => {
            const host = `${app.replace(/^app_/, "app-")}.localhost`;
            return BrowserWindow.getAllWindows()
              .filter((window) => URL.parse(window.webContents.getURL())?.hostname !== host)
              .map((window) => window.isVisible());
          }, app),
        ),
      ).toEqual([false]);
      expect(yield* bridge(page, "the app's bridge works", "permission", "startAtLogin")).toEqual({
        ok: true,
        value: "granted",
      });
      expect(yield* bridge(page, "summon the app", "windowAction", "focus")).toEqual({ ok: true });
      yield* mainWindowIs(electron, app, "the app shows", (window) => window.visible);

      const dashboard = yield* dashboardOf(electron);
      expect(
        yield* host(
          dashboard,
          "stop starting at login",
          "setPermission",
          app,
          "startAtLogin",
          "denied",
        ),
      ).toEqual({ ok: true, value: "denied" });
      expect(yield* loginItem(electron)).toEqual([]);
    }),
  ).pipe(Effect.provide(services)),
);

const saveDialogs = (electron: ElectronApplication, answers: ReadonlyArray<string | null>) =>
  driver("answer save dialogs", () =>
    electron.evaluate(({ dialog }, answers) => {
      const record: Array<{ title: string; defaultPath: string; parent: boolean }> = [];
      Object.assign(globalThis, { executorE2ESaves: record });
      const queue = [...answers];
      Object.assign(dialog, {
        showSaveDialogSync: (...args: ReadonlyArray<unknown>) => {
          const options = args[args.length - 1] as { title?: string; defaultPath?: string };
          record.push({
            title: options.title ?? "",
            defaultPath: options.defaultPath ?? "",
            parent: args.length > 1,
          });
          return queue.shift() ?? undefined;
        },
      });
    }, answers),
  );

const download = (page: Page, label: string, kind: "link" | "blob", fileName: string) =>
  Effect.gen(function* () {
    yield* driver(`${label}: add the link`, () =>
      page.evaluate(
        ([kind, fileName]) => {
          const anchor = document.createElement("a");
          anchor.id = "download-link";
          anchor.textContent = "Download";
          anchor.href =
            kind === "link"
              ? "/note.txt"
              : URL.createObjectURL(new Blob(["Made in the page"], { type: "text/plain" }));
          anchor.download = fileName;
          document.body.append(anchor);
        },
        [kind, fileName] as const,
      ),
    );
    yield* driver(`${label}: click it`, () => page.click("#download-link"));
    yield* driver(`${label}: remove the link`, () =>
      page.evaluate(() => document.querySelector("#download-link")?.remove()),
    );
  });

it.live(scenarios.desktopAppDownloads.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const desktop = yield* startDesktop;
      const { electron, name, app } = desktop;
      const saved = path.join(desktop.home, "saved");
      yield* fs.makeDirectory(saved, { recursive: true });
      yield* watchDesktopShell(electron);
      const page = yield* installAndOpen(desktop, { [`${name} permission`]: 0 });
      yield* eventually("the menu-bar item shows", menuBarItems(electron), (items) =>
        items.includes(name),
      );
      const landed = (file: string) =>
        eventually(
          `${file} lands`,
          fs.readFileString(path.join(saved, file)).pipe(Effect.orElseSucceed(() => "")),
          (text) => text !== "",
        );
      yield* saveDialogs(electron, [
        path.join(saved, "from-link.txt"),
        path.join(saved, "from-blob.txt"),
        null,
        path.join(saved, "from-popover.txt"),
      ]);

      yield* download(page, "download a file from the app", "link", "note.txt");
      expect(yield* landed("from-link.txt")).toBe("A note from the app");
      yield* download(page, "download a blob", "blob", "made.txt");
      expect(yield* landed("from-blob.txt")).toBe("Made in the page");
      yield* download(page, "cancel a download", "blob", "cancelled.txt");
      yield* eventsNamed(desktop.data, "Cancelled an installed app's download", 1);

      yield* clickMenuBarItem(electron, name);
      const popover = yield* appWindow(electron, app, "/_executor/menubar");
      yield* driver("the popover shows the menu-bar page", () =>
        popover.locator("#menu").filter({ hasText: "Menu bar page" }).waitFor({ timeout: 60_000 }),
      );
      yield* download(popover, "download from the popover", "blob", "popover.txt");
      expect(yield* landed("from-popover.txt")).toBe("Made in the page");

      const downloads = yield* driver("read the Downloads folder", () =>
        electron.evaluate(({ app }) => app.getPath("downloads")),
      );
      const asked = (file: string, parent: boolean) => ({
        title: `Save from ${name}`,
        defaultPath: path.join(downloads, file),
        parent,
      });
      expect(
        yield* driver("read the save dialogs", () =>
          electron.evaluate(() => Reflect.get(globalThis, "executorE2ESaves") as Array<unknown>),
        ),
      ).toEqual([
        asked("note.txt", true),
        asked("made.txt", true),
        asked("cancelled.txt", true),
        asked("popover.txt", false),
      ]);
      expect((yield* fs.readDirectory(saved)).sort()).toEqual([
        "from-blob.txt",
        "from-link.txt",
        "from-popover.txt",
      ]);
    }),
  ).pipe(Effect.provide(services)),
);
