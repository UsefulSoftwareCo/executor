import {
  app,
  BrowserWindow,
  ipcMain,
  type IpcMainEvent,
  nativeTheme,
  type Rectangle,
  screen,
  session,
  type WebContents,
} from "electron";
import {
  Effect,
  FiberSet,
  FileSystem,
  Option,
  Path,
  Predicate,
  Ref,
  Schema,
  Semaphore,
} from "effect";
import type { DesktopAccount } from "../../../../../packages/apps/src/contracts/desktop.ts";
import { writeAtomically } from "../../../server/src/implementation/atomic-file.ts";
import { desktopChannels } from "../contracts/bridge-channels.ts";
import { DesktopUnavailable, type MenuAnchor } from "../contracts/installed-apps.ts";
import { AccountPreferences, preferencesFileName, serverOfAccount } from "../contracts/servers.ts";
import {
  type HostedServers,
  hostOf,
  plainHttpWarning,
  plainStorageWarning,
  serverOrigin,
  type SignInExpectation,
  type SignInOutcome,
} from "./hosted-servers.ts";
import type { InstalledApps } from "./installed-apps.ts";
import {
  type AccountMenu,
  accountMenuPage,
  accountMenuUpdate,
  type MenuAccount,
  type Prompt,
  pageAction,
  promptPage,
  promptScheme,
  type SelfHostForm,
  waitingPage,
  welcomePage,
  welcomeScheme,
} from "./pages.ts";

const localAccount = "local";
const prewarmLimit = 3;
const MenuChoice = Schema.Struct({
  action: Schema.String.check(Schema.isMaxLength(32)),
  account: Schema.NullOr(Schema.String.check(Schema.isMaxLength(300))),
});
const PreferencesJson = Schema.fromJsonString(AccountPreferences);
const background = () => (nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff");

export const readPreferences = (profile: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(path.join(profile, preferencesFileName)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PreferencesJson)),
      Effect.catchIf(
        (error) => Predicate.isTagged(error, "PlatformError") && error.reason._tag === "NotFound",
        () => Effect.succeed<AccountPreferences>({ version: 1, local: false, lastUsed: null }),
      ),
      Effect.tapError((error) =>
        Effect.logWarning("Could not read which accounts this desktop used last", error),
      ),
      Effect.orElseSucceed((): AccountPreferences => ({
        version: 1,
        local: false,
        lastUsed: null,
      })),
    );
  });

export interface LocalAccount {
  readonly running: () => boolean;
  readonly start: () => void;
  readonly window: () => BrowserWindow | undefined;
  readonly painted: (window: BrowserWindow) => boolean;
  readonly open: (bounds: Rectangle | undefined) => BrowserWindow | undefined;
}

type Choice = { readonly kind: "welcome" } | { readonly kind: "account"; readonly id: string };

export const makeAccounts = (options: {
  readonly profile: string;
  readonly preferences: AccountPreferences;
  readonly hosted: HostedServers;
  readonly installedApps: InstalledApps;
  readonly local: LocalAccount;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fork = yield* FiberSet.makeRuntime<FileSystem.FileSystem | Path.Path>();
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const saving = yield* Semaphore.make(1);
    const preferences = yield* Ref.make(options.preferences);
    const { hosted, installedApps, local } = options;
    let active: Choice = { kind: "welcome" };
    let welcome: BrowserWindow | undefined;
    let welcomeSignIn: string | undefined;
    let welcomeMessage: string | undefined;
    let prompting: BrowserWindow | undefined;
    let intent = 0;
    let warmed = false;
    const watched = new WeakSet<BrowserWindow>();

    const savePreferences = (change: (current: AccountPreferences) => AccountPreferences) =>
      fork(
        saving.withPermits(1)(
          Effect.gen(function* () {
            const next = change(yield* Ref.get(preferences));
            yield* Ref.set(preferences, next);
            yield* fs.makeDirectory(options.profile, { recursive: true });
            yield* writeAtomically(
              process.platform,
              options.profile,
              path.join(options.profile, preferencesFileName),
              yield* Schema.encodeEffect(PreferencesJson)(next),
            );
          }).pipe(
            Effect.provideContext(services),
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not save which account this desktop used last", cause),
            ),
          ),
        ),
      );

    const activeId = () => (active.kind === "account" ? active.id : undefined);

    const currentWindow = () => {
      const id = activeId();
      const window =
        id === undefined ? welcome : id === localAccount ? local.window() : hosted.dashboard(id);
      return window === undefined || window.isDestroyed() ? undefined : window;
    };

    const boundsOf = (window: BrowserWindow | undefined) =>
      window === undefined || window.isDestroyed() || window === welcome
        ? undefined
        : window.getNormalBounds();

    const accountWindows = () => [
      ...hosted.dashboards().map(([, window]) => window),
      ...Option.toArray(Option.fromUndefinedOr(local.window())),
    ];

    const closeWelcome = () => {
      const window = welcome;
      welcome = undefined;
      if (window !== undefined && !window.isDestroyed()) window.destroy();
    };

    const leave = (previous: BrowserWindow | undefined, next: BrowserWindow) => {
      if (previous === welcome && previous !== next) closeWelcome();
      for (const window of accountWindows())
        if (window !== next && !window.isDestroyed() && window.isVisible()) window.hide();
    };

    const dropKept = (closed: BrowserWindow) => {
      if (closed !== currentWindow()) return;
      for (const [id, window] of hosted.dashboards())
        if (window !== closed) hosted.closeDashboard(id);
      const kept = local.window();
      if (kept !== undefined && kept !== closed) kept.destroy();
    };

    const reveal = (window: BrowserWindow) => {
      if (window.isDestroyed()) return;
      if (window !== welcome && !watched.has(window)) {
        watched.add(window);
        window.on("close", () => dropKept(window));
      }
      window.show();
      window.focus();
    };

    const follow = (window: BrowserWindow, previous: BrowserWindow | undefined) => {
      const bounds = boundsOf(previous);
      if (
        bounds === undefined ||
        window === previous ||
        window.isMaximized() ||
        window.isFullScreen()
      )
        return;
      window.setBounds(bounds);
    };

    const shownNow = () => currentWindow()?.isVisible() === true;

    const prewarm = () => {
      if (!shownNow()) return;
      const current = activeId();
      const cold = hosted
        .views()
        .filter(
          (view) =>
            view.id !== current &&
            view.state === "signed-in" &&
            hosted.dashboard(view.id) === undefined,
        )
        .slice(0, prewarmLimit);
      for (const view of cold)
        fork(
          hosted.openDashboard(view.id, undefined).pipe(
            Effect.matchEffect({
              onFailure: () =>
                Effect.logInfo("Could not prepare a hosted account's dashboard ahead of a switch"),
              onSuccess: (window) =>
                Effect.sync(() => {
                  if (!shownNow() && window !== currentWindow()) hosted.closeDashboard(view.id);
                }),
            }),
          ),
        );
      if (current !== localAccount && local.running() && local.window() === undefined)
        local.open(undefined);
    };

    const warmOnce = () => {
      if (warmed) return;
      warmed = true;
      prewarm();
    };

    const showLocal = (previous: BrowserWindow | undefined) => {
      const mine = ++intent;
      active = { kind: "account", id: localAccount };
      savePreferences((current) => ({ ...current, lastUsed: localAccount }));
      const kept = local.window();
      const opened = kept ?? local.open(boundsOf(previous));
      if (opened === undefined) return;
      if (opened === previous) return reveal(opened);
      const done = () => {
        if (mine !== intent || opened.isDestroyed()) return;
        if (kept !== undefined) follow(opened, previous);
        reveal(opened);
        leave(previous, opened);
        warmOnce();
      };
      if (previous === undefined || opened.isVisible() || local.painted(opened)) done();
      else opened.once("ready-to-show", done);
      push();
    };

    const showHosted = (id: string, previous: BrowserWindow | undefined) =>
      Effect.gen(function* () {
        const mine = ++intent;
        const opened = yield* hosted.openDashboard(id, boundsOf(previous)).pipe(Effect.option);
        if (mine !== intent) return true;
        if (Option.isNone(opened)) {
          yield* Effect.logWarning("Could not open a hosted account's dashboard");
          return false;
        }
        active = { kind: "account", id };
        savePreferences((current) => ({ ...current, lastUsed: id }));
        follow(opened.value, previous);
        reveal(opened.value);
        leave(previous, opened.value);
        push();
        warmOnce();
        return true;
      });

    const usable = (id: string) => {
      const state = hosted.accountOf(id)?.state;
      return state === "signed-in" || state === "unreachable";
    };

    const fallback = (previous: BrowserWindow | undefined) =>
      Effect.gen(function* () {
        if (local.running()) return showLocal(previous);
        for (const view of hosted.views())
          if (view.id !== activeId() && usable(view.id) && (yield* showHosted(view.id, previous)))
            return;
        intent += 1;
        active = { kind: "welcome" };
        showWelcome(undefined);
        const shown = welcome;
        if (shown !== undefined) leave(previous, shown);
      });

    const switchTo = (id: string) =>
      Effect.gen(function* () {
        const previous = currentWindow();
        if (id === localAccount) return showLocal(previous);
        if (!usable(id)) return signInAgain(id);
        if (!(yield* showHosted(id, previous)) && previous === undefined) yield* fallback(previous);
      });

    const launch = (launching: { readonly hidden: boolean }) =>
      Effect.gen(function* () {
        const last = (yield* Ref.get(preferences)).lastUsed;
        if (launching.hidden) {
          const id =
            last !== null && last !== localAccount && usable(last)
              ? last
              : local.running()
                ? localAccount
                : hosted.views().find((view) => usable(view.id))?.id;
          if (id === undefined) return;
          active = { kind: "account", id };
          if (id === localAccount) local.open(undefined);
          return;
        }
        if (last !== null && last !== localAccount && usable(last)) {
          if (yield* showHosted(last, undefined)) return;
        }
        if (local.running()) return showLocal(undefined);
        for (const view of hosted.views())
          if (usable(view.id) && (yield* showHosted(view.id, undefined))) return;
        showWelcome(undefined);
      });

    const showCurrent = () => {
      const window = currentWindow();
      if (window !== undefined) return reveal(window);
      const id = activeId();
      if (id === localAccount) return showLocal(undefined);
      if (id !== undefined) return fork(switchTo(id));
      showWelcome(undefined);
    };

    const welcomeUrl = (selfHost: SelfHostForm | undefined) => {
      if (welcomeSignIn !== undefined) {
        const entry = hosted.waitingFor(welcomeSignIn);
        if (entry !== undefined) return waitingPage(entry.host);
      }
      return welcomePage({
        message: welcomeMessage,
        note: hosted.plainStorage ? plainStorageWarning : undefined,
        local: !local.running(),
        selfHost,
      });
    };

    const loadWelcome = (selfHost: SelfHostForm | undefined) => {
      const window = welcome;
      if (window === undefined || window.isDestroyed()) return;
      void window.loadURL(welcomeUrl(selfHost)).catch(() => undefined);
    };

    const welcomeAction = (url: string) => {
      const chosen = pageAction(welcomeScheme, url);
      switch (chosen?.action) {
        case "cloud":
          welcomeMessage = undefined;
          return signIn(hosted.cloudOrigin, undefined, true);
        case "local":
          return runLocally();
        case "self-host": {
          const value = chosen.params.get("url") ?? "";
          const entered = serverOrigin(value);
          if (entered === undefined)
            return loadWelcome({
              value,
              error: "Enter the server's address, such as https://executor.example.com.",
              warning: undefined,
              confirmPlain: false,
            });
          if (entered.plain && chosen.params.get("plain") !== "yes")
            return loadWelcome({
              value: entered.origin,
              error: undefined,
              warning: plainHttpWarning,
              confirmPlain: true,
            });
          welcomeMessage = undefined;
          return signIn(entered.origin, undefined, true);
        }
        case "reopen":
          if (welcomeSignIn !== undefined) hosted.reopen(welcomeSignIn);
          return loadWelcome(undefined);
        case "cancel":
          if (welcomeSignIn !== undefined) fork(hosted.cancel(welcomeSignIn));
          return;
        default:
          return;
      }
    };

    const showWelcome = (selfHost: SelfHostForm | undefined) => {
      const existing = welcome;
      if (existing !== undefined && !existing.isDestroyed()) {
        loadWelcome(selfHost);
        return reveal(existing);
      }
      const window = new BrowserWindow({
        width: 440,
        height: 400,
        useContentSize: true,
        resizable: false,
        minimizable: true,
        maximizable: false,
        fullscreenable: false,
        title: "Executor",
        show: false,
        backgroundColor: background(),
        webPreferences: {
          session: session.fromPartition("executor-desktop-settings"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      });
      welcome = window;
      window.on("page-title-updated", (event) => event.preventDefault());
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-attach-webview", (event) => event.preventDefault());
      window.once("ready-to-show", () => reveal(window));
      window.webContents.on("will-navigate", (event, url) => {
        event.preventDefault();
        welcomeAction(url);
      });
      window.once("closed", () => {
        if (welcome === window) welcome = undefined;
        const pendingSignIn = welcomeSignIn;
        if (pendingSignIn !== undefined && active.kind === "welcome")
          fork(hosted.cancel(pendingSignIn));
      });
      loadWelcome(selfHost);
    };

    const signIn = (
      origin: string,
      expected: SignInExpectation | undefined,
      switchAfter: boolean,
    ) => {
      welcomeSignIn = hosted.begin(origin, expected, (outcome) =>
        finishSignIn(outcome, switchAfter),
      );
      showWelcome(undefined);
    };

    const waitForSignIn = (origin: string, expected: SignInExpectation | undefined) =>
      Effect.callback<SignInOutcome>((resume) => {
        const id = hosted.begin(origin, expected, (outcome) => {
          finishSignIn(outcome, false);
          resume(Effect.succeed(outcome));
        });
        welcomeSignIn = id;
        showWelcome(undefined);
      });

    const finishSignIn = (outcome: SignInOutcome, switchAfter: boolean) => {
      welcomeSignIn = undefined;
      const hasDashboard = activeId() !== undefined && currentWindow() !== undefined;
      switch (outcome.kind) {
        case "signed-in":
          welcomeMessage = undefined;
          if (switchAfter || activeId() === undefined || activeId() === localAccount)
            return fork(switchTo(outcome.account).pipe(Effect.tap(() => Effect.sync(prewarm))));
          closeWelcome();
          return prewarm();
        case "cancelled":
          if (hasDashboard) return closeWelcome();
          welcomeMessage = "Sign-in was cancelled.";
          return loadWelcome(undefined);
        case "failed":
          welcomeMessage = outcome.message;
          return loadWelcome(undefined);
      }
    };

    const signInAgain = (id: string) => {
      const origin = hosted.originOf(id);
      if (origin === undefined) return;
      signIn(origin, hosted.expectation(id), true);
    };

    const askToRunLocally = (message: string) => {
      if (local.running()) return;
      welcomeMessage = message;
      showWelcome(undefined);
    };

    const runLocally = () => {
      savePreferences((current) => ({ ...current, local: true, lastUsed: localAccount }));
      if (!local.running()) local.start();
      welcomeMessage = undefined;
      showLocal(currentWindow());
    };

    const prompt = (shown: Prompt) =>
      Effect.callback<boolean>((resume) => {
        if (prompting !== undefined && !prompting.isDestroyed()) prompting.destroy();
        const parent = currentWindow();
        const window = new BrowserWindow({
          width: 420,
          height: 250,
          useContentSize: true,
          resizable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          ...(parent === undefined || !parent.isVisible() ? {} : { parent, modal: true }),
          title: shown.title,
          show: false,
          backgroundColor: background(),
          webPreferences: {
            session: session.fromPartition("executor-desktop-settings"),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
          },
        });
        prompting = window;
        let answered = false;
        const answer = (accepted: boolean) => {
          if (answered) return;
          answered = true;
          if (prompting === window) prompting = undefined;
          if (!window.isDestroyed()) window.destroy();
          resume(Effect.succeed(accepted));
        };
        window.on("page-title-updated", (event) => event.preventDefault());
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-attach-webview", (event) => event.preventDefault());
        window.once("ready-to-show", () => reveal(window));
        window.webContents.on("will-navigate", (event, url) => {
          event.preventDefault();
          answer(pageAction(promptScheme, url)?.action === "accept");
        });
        window.once("closed", () => answer(false));
        void window.loadURL(promptPage(shown)).catch(() => undefined);
        return Effect.sync(() => answer(false));
      });

    const localEntry = (): MenuAccount => ({
      id: installedApps.localServer() ?? localAccount,
      kind: "local",
      team: "This computer",
      host: "local",
      state: "signed-in",
    });

    const ownAccount = (server: string): DesktopAccount | undefined => {
      if (server === installedApps.localServer()) {
        const { id, kind, team, host } = localEntry();
        return { id, kind, team, host, state: "signed-in" };
      }
      const view = hosted.accountOf(server);
      if (view === undefined || view.state === "waiting") return undefined;
      return { id: view.id, kind: view.kind, team: view.team, host: view.host, state: view.state };
    };

    const account = (server: string) =>
      Effect.suspend(() => {
        const found = ownAccount(server);
        return found === undefined ? Effect.fail(new DesktopUnavailable()) : Effect.succeed(found);
      });

    const menuAccounts = (): ReadonlyArray<MenuAccount> => [
      ...hosted.views().map((view): MenuAccount => ({
        id: view.id,
        kind: view.kind,
        team: view.team,
        host: view.host,
        state: view.state,
      })),
      ...(local.running() ? [localEntry()] : []),
    ];

    interface OpenMenu {
      readonly window: BrowserWindow;
      readonly server: string;
      readonly parent: BrowserWindow;
      readonly anchor: MenuAnchor;
      readonly settings: boolean;
      view: AccountMenu["view"];
      loading: boolean;
      loaded: boolean;
      readonly finish: (chosen: "settings" | null) => void;
    }
    let menu: OpenMenu | undefined;
    const menuWidth = 264;
    const menuGap = 6;

    const menuOf = (open: OpenMenu): AccountMenu | undefined => {
      const current = ownAccount(open.server);
      if (current === undefined) return undefined;
      return {
        view: open.view,
        current,
        email: hosted.accountOf(open.server)?.email,
        accounts: menuAccounts(),
        local: local.running(),
        settings: open.settings,
      };
    };

    const clamp = (value: number, minimum: number, maximum: number) =>
      Math.min(Math.max(value, minimum), Math.max(minimum, maximum));

    const placeMenu = (open: OpenMenu, height: number) => {
      if (open.window.isDestroyed() || open.parent.isDestroyed()) return;
      const content = open.parent.getContentBounds();
      const zoom = open.parent.webContents.getZoomFactor();
      const left = clamp(open.anchor.x, 0, content.width / zoom);
      const top = clamp(open.anchor.y, 0, content.height / zoom);
      const bottom = clamp(open.anchor.y + open.anchor.height, top, content.height / zoom);
      const area = screen.getDisplayMatching(content).workArea;
      const above = Math.round(content.y + top * zoom) - menuGap - height;
      const y =
        above >= area.y
          ? above
          : clamp(
              Math.round(content.y + bottom * zoom) + menuGap,
              area.y,
              area.y + area.height - height,
            );
      const x = clamp(Math.round(content.x + left * zoom), area.x, area.x + area.width - menuWidth);
      open.window.setBounds({ x, y, width: menuWidth, height });
    };

    const renderMenu = (open: OpenMenu) => {
      const shown = menuOf(open);
      if (shown === undefined) return open.finish(null);
      if (open.window.isDestroyed()) return;
      if (open.loaded) return fork(updateMenu(open, shown));
      if (open.loading) return;
      open.loading = true;
      void open.window.loadURL(accountMenuPage(shown)).catch(() => open.finish(null));
    };

    const updateMenu = (open: OpenMenu, shown: AccountMenu) =>
      Effect.tryPromise(() =>
        open.window.webContents.executeJavaScript(accountMenuUpdate(shown)),
      ).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Finite)),
        Effect.match({
          onFailure: () => open.finish(null),
          onSuccess: (height) => {
            if (menu !== open || open.window.isDestroyed()) return;
            placeMenu(open, clamp(height, 40, 640));
            if (open.window.isVisible()) return;
            open.window.show();
            open.window.focus();
            open.window.webContents.focus();
          },
        }),
      );

    const menuLoaded = (open: OpenMenu) => {
      open.loaded = true;
      const shown = menuOf(open);
      if (shown === undefined) return open.finish(null);
      fork(updateMenu(open, shown));
    };

    const knownAccount = (id: string | null) =>
      id === null ? undefined : menuAccounts().find((entry) => entry.id === id);

    const confirmSignOut = (id: string) =>
      Effect.gen(function* () {
        const view = hosted.accountOf(id);
        if (view === undefined) return;
        const accepted = yield* prompt({
          title: `Sign out of ${view.team}?`,
          body: [
            {
              text: `Your installed ${view.team} apps stay on this computer. They'll ask you to sign in again when you open them.`,
            },
          ],
          app: view.team,
          team: undefined,
          accept: "Sign out",
          dismiss: "Cancel",
        });
        if (accepted) yield* hosted.signOut(id).pipe(Effect.catch(() => couldNotChange));
      });

    const listNames = (names: ReadonlyArray<string>) =>
      names.length <= 1
        ? (names[0] ?? "")
        : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

    const confirmRemove = (id: string) =>
      Effect.gen(function* () {
        const view = hosted.accountOf(id);
        if (view === undefined) return;
        const apps = yield* installedApps.appNames(id);
        const accepted = yield* prompt({
          title: `Remove ${view.team} from this computer?`,
          body: [
            {
              text: `This signs out${apps.length > 0 ? `, uninstalls ${listNames(apps)} from this computer` : ""} and clears ${view.team}'s saved data and permissions here. Nothing changes on ${view.host}; the apps stay in your team.`,
            },
          ],
          app: view.team,
          team: undefined,
          accept: "Remove",
          dismiss: "Cancel",
        });
        if (accepted) yield* hosted.remove(id).pipe(Effect.catch(() => couldNotChange));
      }).pipe(Effect.provideContext(services));

    const couldNotChange = prompt({
      title: "Executor could not change this account",
      body: [{ text: "The Executor desktop app could not do this. Try again." }],
      app: undefined,
      team: undefined,
      accept: undefined,
      dismiss: "OK",
    }).pipe(Effect.asVoid);

    const select = (id: string) =>
      Effect.gen(function* () {
        const chosen = knownAccount(id);
        if (chosen === undefined || chosen.state === "waiting") return;
        if (chosen.kind !== "local" && chosen.state === "sign-in-again") return signInAgain(id);
        return yield* switchTo(chosen.kind === "local" ? localAccount : id);
      });

    const menuAction = (open: OpenMenu, choice: typeof MenuChoice.Type) => {
      const chosen = choice;
      const target = knownAccount(choice.account);
      const removable =
        target !== undefined && target.kind !== "local" && target.state !== "waiting";
      const then = (run: () => void) => {
        open.finish(null);
        run();
      };
      switch (chosen?.action) {
        case "add":
          open.view = "add";
          return renderMenu(open);
        case "back":
          open.view = "accounts";
          return renderMenu(open);
        case "select":
          return target === undefined ? open.finish(null) : then(() => fork(select(target.id)));
        case "sign-in-again":
          return target === undefined || target.kind === "local"
            ? open.finish(null)
            : then(() => signInAgain(target.id));
        case "retry":
          if (target !== undefined) fork(hosted.retry(target.id));
          return;
        case "cancel":
          if (target?.state === "waiting") fork(hosted.cancel(target.id));
          return;
        case "cloud":
          return then(() => {
            welcomeMessage = undefined;
            signIn(hosted.cloudOrigin, undefined, true);
          });
        case "self-host":
          return then(() => {
            welcomeMessage = undefined;
            showWelcome({ value: "", error: undefined, warning: undefined, confirmPlain: false });
          });
        case "run-locally":
          return then(runLocally);
        case "settings":
          return open.finish(open.settings ? "settings" : null);
        case "sign-out":
          return ownAccount(open.server)?.kind === "local"
            ? open.finish(null)
            : then(() => fork(confirmSignOut(open.server)));
        case "remove":
          return removable ? then(() => fork(confirmRemove(target.id))) : open.finish(null);
        default:
          return open.finish(null);
      }
    };

    const menuContextAction = (open: OpenMenu, x: number, y: number) =>
      Effect.tryPromise(() =>
        open.window.webContents.executeJavaScript(
          `document.elementFromPoint(${x}, ${y})?.closest("[data-account]")?.getAttribute("data-account") ?? ""`,
        ),
      ).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.String)),
        Effect.match({
          onFailure: () => undefined,
          onSuccess: (id) => {
            const target = knownAccount(id);
            if (
              target === undefined ||
              target.id === open.server ||
              target.kind === "local" ||
              target.state === "waiting"
            )
              return;
            open.finish(null);
            fork(confirmRemove(target.id));
          },
        }),
      );

    const closeMenu = () => menu?.finish(null);

    const menuChoice = (event: IpcMainEvent, input: unknown) => {
      const open = menu;
      if (
        open === undefined ||
        open.window.isDestroyed() ||
        event.sender !== open.window.webContents
      )
        return;
      Option.match(Schema.decodeUnknownOption(MenuChoice)(input), {
        onNone: () => open.finish(null),
        onSome: (choice) => menuAction(open, choice),
      });
    };
    ipcMain.on(desktopChannels.menuChoice, menuChoice);

    const openMenu = (
      server: string,
      contents: WebContents,
      options: { readonly anchor: MenuAnchor; readonly settings: boolean },
    ) =>
      Effect.callback<"settings" | null, DesktopUnavailable>((resume) => {
        const parent = BrowserWindow.fromWebContents(contents);
        if (
          parent === null ||
          parent.isDestroyed() ||
          !parent.isVisible() ||
          ownAccount(server) === undefined
        )
          return resume(Effect.fail(new DesktopUnavailable()));
        closeMenu();
        const window = new BrowserWindow({
          parent,
          width: menuWidth,
          height: 40,
          useContentSize: true,
          show: false,
          frame: false,
          resizable: false,
          movable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          skipTaskbar: true,
          title: "Account menu",
          backgroundColor: background(),
          webPreferences: {
            session: session.fromPartition("executor-desktop-settings"),
            preload: path.join(__dirname, "preload-menu.cjs"),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
          },
        });
        let done = false;
        const escapeFrom = (event: Electron.Event, input: Electron.Input) => {
          if (input.type !== "keyDown" || input.key !== "Escape") return;
          event.preventDefault();
          open.finish(null);
        };
        const clickedBeside = (_event: Electron.Event, mouse: Electron.MouseInputEvent) => {
          if (mouse.type === "mouseDown") open.finish(null);
        };
        const appInactive = () => open.finish(null);
        const otherWindowFocused = (_event: Electron.Event, focused: BrowserWindow) => {
          if (focused !== window && focused !== parent) open.finish(null);
        };
        const parentBlurred = () =>
          setImmediate(() => {
            if (done || window.isDestroyed()) return;
            const focused = BrowserWindow.getFocusedWindow();
            if (focused !== window && focused !== parent) open.finish(null);
          });
        const parentHidden = () => open.finish(null);
        const followParent = () => {
          if (!window.isDestroyed() && window.isVisible())
            placeMenu(open, window.getContentBounds().height);
        };
        const open: OpenMenu = {
          window,
          server,
          parent,
          anchor: options.anchor,
          settings: options.settings,
          view: "accounts",
          loading: false,
          loaded: false,
          finish: (chosen) => {
            if (done) return;
            done = true;
            app.off("did-resign-active", appInactive);
            app.off("browser-window-focus", otherWindowFocused);
            if (!parent.isDestroyed()) {
              parent.webContents.off("before-input-event", escapeFrom);
              parent.webContents.off("before-mouse-event", clickedBeside);
              parent.off("move", followParent);
              parent.off("resize", followParent);
              parent.off("blur", parentBlurred);
              parent.off("hide", parentHidden);
            }
            if (menu === open) menu = undefined;
            if (!window.isDestroyed()) window.destroy();
            resume(Effect.succeed(chosen));
          },
        };
        menu = open;
        window.on("page-title-updated", (event) => event.preventDefault());
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-attach-webview", (event) => event.preventDefault());
        window.webContents.on("will-navigate", (event) => {
          event.preventDefault();
          open.finish(null);
        });
        window.webContents.on("did-finish-load", () => menuLoaded(open));
        window.webContents.on("before-input-event", escapeFrom);
        parent.webContents.on("before-input-event", escapeFrom);
        parent.webContents.on("before-mouse-event", clickedBeside);
        parent.on("move", followParent);
        parent.on("resize", followParent);
        parent.on("blur", parentBlurred);
        parent.on("hide", parentHidden);
        app.on("did-resign-active", appInactive);
        app.on("browser-window-focus", otherWindowFocused);
        window.webContents.on("context-menu", (_event, params) =>
          fork(menuContextAction(open, params.x, params.y)),
        );
        window.on("blur", () =>
          setImmediate(() => {
            if (done || window.isDestroyed()) return;
            if (parent.isDestroyed() || BrowserWindow.getFocusedWindow() !== parent)
              return open.finish(null);
            window.focus();
            window.webContents.focus();
          }),
        );
        window.once("closed", () => open.finish(null));
        renderMenu(open);
        return Effect.sync(() => open.finish(null));
      });

    const push = () =>
      fork(
        Effect.gen(function* () {
          for (const window of accountWindows()) {
            if (window.isDestroyed()) continue;
            const server = installedApps.dashboardServer(window.webContents);
            if (server === undefined) continue;
            const own = ownAccount(server);
            if (own !== undefined) window.webContents.send(desktopChannels.hostAccount, own);
          }
          if (menu !== undefined) renderMenu(menu);
        }),
      );

    installedApps.setAccountHandler({
      account,
      openMenu: (server, contents, options) =>
        openMenu(server, contents, options).pipe(
          Effect.tap(() =>
            Effect.logInfo("Closed this desktop's account menu").pipe(
              Effect.annotateLogs({ from: serverOfAccount(server) }),
            ),
          ),
        ),
    });

    const dashboardClosed = (id: string, byDesktop: boolean) => {
      if (!byDesktop || activeId() !== id) return;
      fork(fallback(undefined));
    };

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        ipcMain.removeListener(desktopChannels.menuChoice, menuChoice);
        closeMenu();
        for (const window of [welcome, prompting])
          if (window !== undefined && !window.isDestroyed()) window.destroy();
      }),
    );

    return {
      launch,
      showCurrent,
      push,
      prompt,
      signInForLink: waitForSignIn,
      signInAgain,
      askToRunLocally,
      dashboardClosed,
      isActive: (id: string) => activeId() === id,
      showLocal: () => fork(switchTo(localAccount)),
      hostOf,
    };
  });

export type Accounts = Effect.Success<ReturnType<typeof makeAccounts>>;
