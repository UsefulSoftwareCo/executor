import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Config,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type ElectronApplication,
  type Page,
  type Route,
} from "playwright";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { scenarios } from "../test-plan.ts";
import { provisionSelfHostActors } from "../support/actors.ts";
import { body, SessionClients } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { chooseConsentOrganization, consentValue } from "../support/consent-page.ts";
import { App } from "../support/contracts.ts";
import {
  answerDialogs,
  answeredDialogs,
  externalOpens,
  runsScripts,
  launchDesktop,
  menuBar,
  menuBarItems,
  nextServer,
  openDesktopLink,
  recordExternalOpens,
  registeredServer,
  runnerSession,
  serverStarts,
  stopBackgroundServers,
  watchDesktopShell,
  permissionStates,
  welcomeWindow,
} from "../support/desktop.ts";
import type { ServiceRegistration } from "../support/background-service.ts";
import { reveal } from "../support/failure-text.ts";
import { startManagedServer } from "../support/managed-server.ts";
import { localNpmRegistry } from "../support/npm-registry.ts";
import { driver, Target } from "../support/platform.ts";
import { freePort } from "../support/ports.ts";
import { publicCatalogs } from "../support/public-catalogs.ts";

const services = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);

const appFiles = (heading: string, menuBar: boolean) => [
  {
    path: "index.ts",
    content: 'import { defineApp } from "apps"; export default defineApp({}, {});',
  },
  {
    path: "ui/index.html",
    content: `<!doctype html><html><head><title>Page title</title></head><body><h1>${heading}</h1></body></html>`,
  },
  ...(menuBar
    ? [
        {
          path: "ui/menubar.html",
          content:
            "<!doctype html><html><head><title>Menu</title></head><body><p>Menu bar page</p></body></html>",
        },
      ]
    : []),
  {
    path: "ui/icon.svg",
    content:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#2f9e6e"/></svg>',
  },
  appsManifest,
];

const Location = Schema.Struct({ status: Schema.String, url: Schema.NullOr(Schema.String) });
const Identity = Schema.Struct({ serverId: Schema.String, kind: Schema.String });
const Consents = Schema.Array(Schema.Struct({ id: Schema.String }));
const SessionUser = Schema.NullOr(Schema.Struct({ user: Schema.Struct({ email: Schema.String }) }));
const Deployed = Schema.Struct({ app: Schema.Struct({ id: Schema.String }) });
const Organization = Schema.Struct({ id: Schema.String, slug: Schema.String, name: Schema.String });
const StoredServers = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(2),
    accounts: Schema.Array(
      Schema.Struct({
        serverId: Schema.String,
        organizationId: Schema.String,
        kind: Schema.String,
        label: Schema.String,
        partition: Schema.String,
        state: Schema.String,
        account: Schema.Struct({ email: Schema.String }),
        sealedRefreshToken: Schema.NullOr(Schema.String),
      }),
    ),
  }),
);
const StoredApps = Schema.fromJsonString(
  Schema.Struct({
    servers: Schema.Record(
      Schema.String,
      Schema.Struct({
        apps: Schema.Record(
          Schema.String,
          Schema.Struct({ name: Schema.String, server: Schema.String }),
        ),
      }),
    ),
  }),
);
const AccountView = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  team: Schema.String,
  host: Schema.String,
  state: Schema.String,
});
const AccountsView = Schema.Struct({
  current: Schema.String,
  accounts: Schema.Array(AccountView),
  local: Schema.Boolean,
});
type AccountsView = typeof AccountsView.Type;

const selfHostedServer = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-desktop-servers-" });
  const registry = yield* localNpmRegistry;
  const catalogs = yield* publicCatalogs;
  const pending: typeof Target.Service = {
    metadata: {
      target: "self-host",
      origin: "http://127.0.0.1:0",
      mode: "managed",
      runtime: "node",
      commit: "desktop-servers",
      dirty: true,
      startedAt: new Date().toISOString(),
      interactive: false,
      diagnostics: "",
    },
    directory,
    apiKey: Redacted.make(randomBytes(32).toString("hex")),
    rows: 1,
    observeUI: false,
    recordingPaceMs: 0,
  };
  const { origin } = yield* startManagedServer(pending, "product", {
    EXECUTOR_NPM_REGISTRY: registry.url,
    EXECUTOR_CATALOG_URL: `${catalogs.origin}/catalog/index.json`,
    EXECUTOR_REGISTRY_URL: catalogs.origin,
  });
  const target = { ...pending, metadata: { ...pending.metadata, origin } };
  const clients = yield* SessionClients.pipe(
    Effect.provide(SessionClients.layer),
    Effect.provideService(Target, target),
  );
  const actors = yield* provisionSelfHostActors.pipe(
    Effect.provideService(SessionClients, clients),
  );
  const http = yield* HttpClient.HttpClient;
  const identity = yield* http.get(`${origin}/.well-known/executor`).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(Identity)),
  );
  const team = yield* clients.request(actors.owner, "GET", "/api/auth/organization/list").pipe(
    Effect.flatMap((response) => body(Schema.Array(Organization), response)),
    Effect.map(
      (organizations) =>
        organizations.find((organization) => organization.id === actors.organization.id)?.name ??
        "",
    ),
  );
  const deploy = (organization: string, name: string, heading: string, withMenuBar = false) =>
    Effect.gen(function* () {
      const prefix = `/api/organizations/${organization}/apps`;
      const deployed = yield* clients.request(actors.owner, "POST", `${prefix}/deploy`, {
        name,
        files: appFiles(heading, withMenuBar),
      });
      expect(deployed.status).toBe(200);
      const app = (yield* body(App, deployed)).id;
      const url = yield* eventually(
        `${name}'s page is ready`,
        clients
          .request(actors.owner, "GET", `${prefix}/${app}/ui`)
          .pipe(Effect.flatMap((response) => body(Location, response))),
        (location) => location.status === "ready",
      ).pipe(Effect.map((location) => new URL(location.url ?? "")));
      return { app, url, name };
    });
  return {
    origin,
    host: new URL(origin).host,
    clients,
    actors,
    identity,
    team,
    deploy,
  };
});

const desktopHome = (options: { readonly cloud?: string } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "executor-desktop-servers-home-" });
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
          : { XDG_CACHE_HOME: cacheHome }),
      HOME: process.platform === "darwin" ? cacheHome : (process.env.HOME ?? ""),
      EXECUTOR_PORT: String(port),
      EXECUTOR_DESKTOP_DATA_DIR: data,
      EXECUTOR_DESKTOP_PROFILE_DIR: profile,
      EXECUTOR_NPM_REGISTRY: registry.url,
      EXECUTOR_API_KEY: apiKey,
      EXECUTOR_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      ...(options.cloud === undefined ? {} : { EXECUTOR_DESKTOP_CLOUD_ORIGIN: options.cloud }),
    };
    const seen: Array<ServiceRegistration> = [];
    yield* Effect.addFinalizer(() => stopBackgroundServers(data, () => seen));
    return { home, data, profile, env, apiKey, origin: `http://127.0.0.1:${port}`, seen };
  });

const retrying = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 600 }));

const eventually = <A, E, R>(
  label: string,
  effect: Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
) =>
  retrying(
    effect.pipe(
      Effect.flatMap((value) =>
        done(value)
          ? Effect.succeed(value)
          : Effect.fail(new Error(`${label}: not yet, last ${JSON.stringify(value)}`)),
      ),
    ),
  );

const windowWhere = (
  electron: ElectronApplication,
  label: string,
  matches: (url: URL) => boolean,
) =>
  retrying(
    Effect.suspend(() => {
      const found = electron.windows().find((page) => {
        if (page.isClosed()) return false;
        const url = URL.parse(page.url());
        return url !== null && matches(url);
      });
      return found === undefined
        ? Effect.fail(new Error(`No window shows ${label}`))
        : Effect.succeed(found);
    }),
  );

const appWindow = (
  electron: ElectronApplication,
  label: string,
  matches: (url: URL) => boolean,
  operation: string,
  heading: string,
) =>
  retrying(
    Effect.gen(function* () {
      for (const page of electron.windows()) {
        const url = URL.parse(page.url());
        if (url === null || !matches(url) || url.pathname.startsWith("/_executor/")) continue;
        if (yield* driver(`check ${label}`, () => runsScripts(electron, page))) return page;
      }
      return yield* Effect.fail(new Error(`No installed app window shows ${label}`));
    }),
  ).pipe(
    Effect.tap((page) =>
      driver(operation, () =>
        page.getByRole("heading", { name: heading }).waitFor({ timeout: 60_000 }),
      ),
    ),
  );

const windowTitled = (electron: ElectronApplication, title: string) =>
  retrying(
    driver(`find the ${title} window`, () =>
      Promise.all(
        electron.windows().map((page) =>
          page.isClosed()
            ? Promise.resolve({ found: "", page })
            : page
                .title()
                .then((found) => ({ found, page }))
                .catch(() => ({ found: "", page })),
        ),
      ).then((pages) => {
        const match = pages.find(({ found }) => found === title);
        if (match === undefined) throw new Error(`No window is titled ${title}`);
        return match.page;
      }),
    ),
  );

const host = (page: Page, label: string, method: string, ...args: ReadonlyArray<unknown>) =>
  driver(label, () =>
    page.evaluate(
      ([method, args]) => {
        const target: unknown = Reflect.get(window, "__executorDesktopHost");
        const call: unknown =
          typeof target === "object" && target !== null ? Reflect.get(target, method) : undefined;
        if (typeof call !== "function") return { ok: false as const, failure: "missing" };
        return Promise.resolve(Reflect.apply(call, target, [...args])).then(
          (value: unknown) => ({ ok: true as const, value }),
          (failure: unknown) => ({ ok: false as const, failure }),
        );
      },
      [method, args] as const,
    ),
  );

const accountMenuTitle = "Account menu";

const closedMenu = (menu: Page) =>
  driver("close the account menu with Escape", () =>
    Promise.all([
      menu.waitForEvent("close", { timeout: 10_000 }),
      menu.keyboard
        .press("Escape")
        .catch((error: unknown) => (menu.isClosed() ? undefined : Promise.reject(error))),
    ]).then(() => undefined),
  );

const shownMenu = (electron: ElectronApplication) =>
  Effect.gen(function* () {
    const menu = yield* windowTitled(electron, accountMenuTitle);
    yield* driver("the account menu shows", () => menu.getByRole("menu").first().waitFor());
    return menu;
  });

const openMenu = (electron: ElectronApplication, dashboard: Page) =>
  driver("ask the desktop for its account menu", () =>
    dashboard.evaluate(() => {
      const bridge: unknown = Reflect.get(window, "__executorDesktopHost");
      const open: unknown =
        typeof bridge === "object" && bridge !== null
          ? Reflect.get(bridge, "openAccountMenu")
          : undefined;
      if (typeof open !== "function") throw new Error("The dashboard has no account menu bridge");
      void Reflect.apply(open, bridge, [
        { anchor: { x: 8, y: 400, width: 200, height: 40 }, settings: false },
      ]);
    }),
  ).pipe(Effect.andThen(shownMenu(electron)));

const clickMenu = (electron: ElectronApplication, dashboard: Page, team: string) =>
  Effect.gen(function* () {
    yield* driver("open the account menu from its button", () =>
      dashboard
        .waitForFunction(() => document.documentElement.hasAttribute("data-hydrated"), undefined, {
          timeout: 60_000,
        })
        .then(() =>
          dashboard.getByRole("button", { name: `Account: ${team}`, exact: true }).click(),
        ),
    );
    return yield* shownMenu(electron);
  });

const accountsOf = (electron: ElectronApplication, dashboard: Page) =>
  Effect.gen(function* () {
    const menu = yield* openMenu(electron, dashboard);
    const rows = yield* driver("read the accounts in the account menu", () =>
      menu.locator("[data-account]").evaluateAll((elements) =>
        elements.map((element) => ({
          id: element.getAttribute("data-account") ?? "",
          kind: element.getAttribute("data-kind") ?? "",
          team: element.getAttribute("data-team") ?? "",
          host: element.getAttribute("data-host") ?? "",
          state: element.getAttribute("data-state") ?? "",
          current: element.querySelector('[aria-current="true"]') !== null,
        })),
      ),
    );
    yield* closedMenu(menu);
    const accounts = yield* Schema.decodeUnknownEffect(Schema.Array(AccountView))(rows);
    return {
      current: rows.find((row) => row.current)?.id ?? "",
      accounts,
      local: accounts.some((account) => account.kind === "local"),
    } satisfies AccountsView;
  });

const mark = (team: string) => [...team.trim()][0]?.toUpperCase() ?? "";

const summary = (accounts: AccountsView) =>
  accounts.accounts.map(({ team, host, state, kind }) => `${team} · ${host} · ${kind} · ${state}`);

const inMenu = (
  electron: ElectronApplication,
  dashboard: Page,
  label: string,
  choose: (menu: Page) => Promise<unknown>,
) =>
  Effect.gen(function* () {
    const menu = yield* openMenu(electron, dashboard);
    yield* driver(label, () => choose(menu));
    return menu;
  });

const row = (menu: Page, account: string) => menu.locator(`[data-account="${account}"]`);

const switchAccount = (
  electron: ElectronApplication,
  dashboard: Page,
  label: string,
  account: string,
) =>
  inMenu(electron, dashboard, label, (menu) =>
    row(menu, account).getByRole("menuitem").click(),
  ).pipe(Effect.asVoid);

const addAccount = (
  electron: ElectronApplication,
  dashboard: Page,
  label: string,
  item: "Sign in to Executor Cloud" | "Run locally" | "Self-hosted server…",
) =>
  inMenu(electron, dashboard, label, (menu) =>
    menu
      .getByRole("menuitem", { name: "Add account" })
      .count()
      .then((nested) =>
        nested === 0
          ? undefined
          : menu
              .getByRole("menuitem", { name: "Add account" })
              .click()
              .then(() => menu.getByRole("menu", { name: "Add account" }).waitFor()),
      )
      .then(() => menu.getByRole("menuitem", { name: item }).click()),
  ).pipe(Effect.asVoid);

const pill = (
  electron: ElectronApplication,
  dashboard: Page,
  label: string,
  account: string,
  button: "Retry" | "Cancel" | "Sign in",
) =>
  Effect.gen(function* () {
    const menu = yield* inMenu(electron, dashboard, label, (menu) =>
      row(menu, account).getByRole("button", { name: button, exact: true }).click(),
    );
    if (button !== "Sign in") yield* closedMenu(menu);
  });

const signOutCurrent = (electron: ElectronApplication, dashboard: Page, team: string) =>
  Effect.gen(function* () {
    yield* inMenu(electron, dashboard, `choose Sign out of ${team}`, (menu) =>
      menu.getByRole("menuitem", { name: `Sign out of ${team}`, exact: true }).click(),
    );
    const confirm = yield* prompted(electron, `Sign out of ${team}?`);
    expect(confirm.shown).toEqual({
      title: `Sign out of ${team}?`,
      body: `Your installed ${team} apps stay on this computer. They'll ask you to sign in again when you open them.`,
      buttons: ["Cancel", "Sign out"],
      teamMark: false,
    });
    yield* answerPrompt(confirm.page, "Sign out");
  });

const removeAccount = (
  electron: ElectronApplication,
  dashboard: Page,
  account: { readonly id: string; readonly team: string; readonly current: boolean },
) =>
  Effect.gen(function* () {
    yield* inMenu(electron, dashboard, `choose to remove ${account.team}`, (menu) =>
      account.current
        ? menu.getByRole("menuitem", { name: "Remove from this computer…", exact: true }).click()
        : row(menu, account.id).getByRole("menuitem").click({ button: "right" }),
    );
    const confirm = yield* prompted(electron, `Remove ${account.team} from this computer?`);
    yield* answerPrompt(confirm.page, "Remove");
    return confirm.shown;
  });

const bridgeServer = (page: Page) =>
  driver("read the host bridge's server", () =>
    page.evaluate(() => {
      const bridge: unknown = Reflect.get(window, "__executorDesktopHost");
      return typeof bridge === "object" && bridge !== null ? Reflect.get(bridge, "server") : null;
    }),
  );

const windowsOn = (electron: ElectronApplication, hostname: string) =>
  driver(`read the windows on ${hostname}`, () =>
    electron.evaluate(({ BrowserWindow }, hostname) => {
      return BrowserWindow.getAllWindows()
        .filter((window) => URL.parse(window.webContents.getURL())?.hostname === hostname)
        .map((window) => ({ title: window.getTitle(), visible: window.isVisible() }));
    }, hostname),
  );

const windowsAt = (electron: ElectronApplication, origin: string) =>
  driver(`read the windows on ${origin}`, () =>
    electron.evaluate(({ BrowserWindow }, origin) => {
      return BrowserWindow.getAllWindows()
        .filter((window) => URL.parse(window.webContents.getURL())?.origin === origin)
        .map((window) => window.getTitle());
    }, origin),
  );

const readJsonFile = <A>(schema: Schema.Decoder<A, never>, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* Schema.decodeUnknownEffect(schema)(yield* fs.readFileString(file));
  });

const dashboardVisible = (page: Page, label: string) =>
  driver(label, () =>
    page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible", timeout: 60_000 }),
  );

const hostedDashboard = (electron: ElectronApplication, origin: string, slug: string) =>
  windowWhere(
    electron,
    `the ${slug} dashboard`,
    (url) => url.origin === origin && url.pathname.startsWith(`/org/${slug}`),
  ).pipe(Effect.tap((page) => dashboardVisible(page, `the ${slug} dashboard is visible`)));

const localDashboard = (electron: ElectronApplication, origin: string) =>
  windowWhere(electron, "the local dashboard", (url) => url.origin === origin).pipe(
    Effect.tap((page) => dashboardVisible(page, "the local dashboard is visible")),
  );

const systemBrowser = Effect.acquireRelease(
  driver("launch the system browser stand-in", () => chromium.launch()),
  (opened) => driver("close the system browser stand-in", () => opened.close()).pipe(Effect.ignore),
);

const consentIn = (
  browser: Browser,
  cookies: Parameters<BrowserContext["addCookies"]>[0],
  authorization: string,
  team: string,
  decision: "Connect" | "Cancel",
) =>
  driver(`${decision === "Connect" ? "approve" : "decline"} the desktop for ${team}`, () =>
    browser.newContext().then((context) =>
      context
        .addCookies([...cookies])
        .then(() => context.newPage())
        .then((page) =>
          page
            .goto(authorization)
            .then(() => chooseConsentOrganization(page, team))
            .then(() =>
              decision === "Connect"
                ? page
                    .getByRole("button", { name: decision, exact: true })
                    .click()
                    .then(() =>
                      page
                        .getByRole("heading", { name: "Executor is signed in" })
                        .waitFor({ timeout: 30_000 }),
                    )
                : Promise.all([
                    page.waitForResponse(
                      (response) => URL.parse(response.url())?.pathname === "/callback",
                      { timeout: 30_000 },
                    ),
                    page.getByRole("button", { name: decision, exact: true }).click(),
                  ]).then(() => undefined),
            )
            .then(() => context.close()),
        ),
    ),
  );

const authorizationAt = (electron: ElectronApplication, count: number) =>
  eventually(
    "the desktop opened browser sign-in",
    externalOpens(electron),
    (opened) => opened.length >= count,
  ).pipe(Effect.map((opened) => opened[count - 1] ?? ""));

const signInFromWelcome = (
  electron: ElectronApplication,
  origin: string,
  form: "self-host" | "cloud",
) =>
  Effect.gen(function* () {
    const welcome = yield* welcomeWindow(electron);
    if (form === "cloud")
      return yield* driver("press Sign in", () =>
        welcome.getByRole("button", { name: "Sign in", exact: true }).click(),
      );
    yield* driver("sign in to the self-hosted server", () =>
      welcome
        .locator("details")
        .evaluate((details) => {
          if (details instanceof HTMLDetailsElement) details.open = true;
        })
        .then(() => welcome.getByRole("textbox", { name: "Server address" }).fill(origin))
        .then(() =>
          welcome.getByRole("button", { name: "Sign in to this server", exact: true }).click(),
        ),
    );
  });

const waitingShown = (electron: ElectronApplication) =>
  retrying(
    driver("find the window waiting for the browser", () =>
      Promise.all(
        electron.windows().map((page) =>
          page.isClosed() || !page.url().startsWith("data:")
            ? Promise.resolve({ page, waiting: 0 })
            : page
                .getByRole("status", { name: "Finish signing in in your browser" })
                .count()
                .then((waiting) => ({ page, waiting }))
                .catch(() => ({ page, waiting: 0 })),
        ),
      ).then((pages) => {
        const found = pages.find(({ waiting }) => waiting > 0);
        if (found === undefined) throw new Error("No window waits for the browser");
        return found.page;
      }),
    ),
  );

it.live(scenarios.desktopFirstRun.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const server = yield* selfHostedServer;
      const home = yield* desktopHome({ cloud: server.origin });
      const electron = yield* launchDesktop({ cwd: home.home, env: home.env, welcome: true });
      yield* recordExternalOpens(electron);
      const welcome = yield* welcomeWindow(electron);
      expect(
        yield* driver("read the welcome window", () =>
          Promise.all([
            welcome.getByRole("heading").first().innerText(),
            welcome.getByRole("button").allInnerTexts(),
            welcome.locator('summary[aria-label="Customize"]').count(),
          ]),
        ),
      ).toEqual(["Welcome to Executor", ["Sign in", "Run locally"], 1]);
      expect(yield* menuBar(electron)).not.toContainEqual(
        expect.objectContaining({ menu: "Servers" }),
      );

      yield* signInFromWelcome(electron, server.origin, "cloud");
      const waiting = yield* waitingShown(electron);
      expect(
        yield* driver("the waiting page names the server", () =>
          waiting.locator("p.lead").innerText(),
        ),
      ).toBe(`We opened ${server.host}. Come back here when you're done.`);
      const first = new URL(yield* authorizationAt(electron, 1));
      expect(`${first.origin}${first.pathname}`).toBe(`${server.origin}/api/auth/oauth2/authorize`);
      yield* driver("open the page again", () =>
        waiting.getByRole("button", { name: "Open the page again" }).click(),
      );
      expect(yield* authorizationAt(electron, 2)).toBe(first.href);
      yield* driver("cancel the sign-in", () =>
        waiting.getByRole("button", { name: "Cancel" }).click(),
      );
      const cancelled = yield* welcomeWindow(electron);
      expect(
        yield* driver("the welcome window says it was cancelled", () =>
          cancelled.getByRole("alert").innerText({ timeout: 30_000 }),
        ),
      ).toBe("Sign-in was cancelled.");
      const redirect = new URL(first.searchParams.get("redirect_uri") ?? "");
      expect(
        yield* driver("the cancelled sign-in's callback is closed", () =>
          fetch(`${redirect.origin}/callback?code=late&state=late`).then(
            (response) => response.status,
            () => "closed",
          ),
        ),
      ).toBe("closed");

      const browser = yield* systemBrowser;
      const ownerCookies = reveal(yield* server.actors.owner.cookies);
      yield* signInFromWelcome(electron, server.origin, "cloud");
      yield* waitingShown(electron);
      const declined = yield* authorizationAt(electron, 3);
      yield* consentIn(browser, ownerCookies, declined, server.team, "Cancel");
      const refused = yield* welcomeWindow(electron);
      expect(
        yield* driver("the welcome window explains the declined sign-in", () =>
          refused.getByRole("alert").innerText({ timeout: 30_000 }),
        ),
      ).toBe("You didn't allow Executor to sign in. Try again when you're ready.");

      yield* signInFromWelcome(electron, server.origin, "cloud");
      yield* waitingShown(electron);
      yield* consentIn(
        browser,
        ownerCookies,
        yield* authorizationAt(electron, 4),
        server.team,
        "Connect",
      );
      const dashboard = yield* hostedDashboard(
        electron,
        server.origin,
        server.actors.organization.slug,
      );
      yield* eventually(
        "the welcome window closed",
        driver("read the open windows", () =>
          Promise.resolve(electron.windows().filter((page) => !page.isClosed()).length),
        ),
        (count) => count === 1,
      );
      const key = `${server.identity.serverId}.${server.actors.organization.id}`;
      expect(yield* bridgeServer(dashboard)).toBe(key);
      const held = yield* accountsOf(electron, dashboard);
      expect(summary(held)).toEqual([`${server.team} · ${server.host} · self-host · signed-in`]);
      expect(held.current).toBe(key);
      expect(held.local).toBe(false);
      expect(yield* serverStarts(home.data)).toBe(0);
      expect(Option.isNone(yield* registeredServer(home.data))).toBe(true);
      expect(yield* fs.exists(path.join(home.data, "installation.json"))).toBe(false);

      expect(
        yield* driver("the dashboard sees only its own account", () =>
          dashboard.evaluate(() => {
            const bridge: unknown = Reflect.get(window, "__executorDesktopHost");
            return typeof bridge === "object" && bridge !== null
              ? Object.keys(bridge).toSorted()
              : [];
          }),
        ),
      ).toEqual([
        "account",
        "install",
        "installed",
        "open",
        "openAccountMenu",
        "permissions",
        "server",
        "setPermission",
        "uninstall",
        "version",
        "watchAccount",
        "watchInstalled",
      ]);
      expect(yield* host(dashboard, "read its own account", "account")).toEqual({
        ok: true,
        value: {
          id: key,
          kind: "self-host",
          team: server.team,
          host: server.host,
          state: "signed-in",
        },
      });
      const opened = yield* clickMenu(electron, dashboard, server.team);
      const placed = yield* driver("read where the menu and its button are", () =>
        Promise.all([
          electron.evaluate(({ BrowserWindow }, title) => {
            const shown = BrowserWindow.getAllWindows().find(
              (window) => window.webContents.getTitle() === title,
            );
            const parent = shown?.getParentWindow();
            return shown === undefined || parent === null || parent === undefined
              ? null
              : { menu: shown.getBounds(), content: parent.getContentBounds() };
          }, accountMenuTitle),
          dashboard.getByRole("button", { name: `Account: ${server.team}` }).evaluate((element) => {
            const box = element.getBoundingClientRect();
            return { x: box.x, y: box.y };
          }),
        ]),
      );
      expect(placed[0]).not.toBeNull();
      if (placed[0] !== null) {
        expect(placed[0].menu.x).toBe(Math.round(placed[0].content.x + placed[1].x));
        expect(placed[0].menu.y + placed[0].menu.height).toBeLessThanOrEqual(
          Math.round(placed[0].content.y + placed[1].y),
        );
      }
      expect(
        yield* driver("read the account menu", () =>
          Promise.all([
            opened.locator(".label").innerText(),
            opened.getByRole("menuitem").allInnerTexts(),
          ]),
        ),
      ).toEqual([
        `${server.team}\nowner@example.test`,
        [
          `${mark(server.team)}\n${server.team}\n${server.host}`,
          "Add account",
          "Account settings",
          `Sign out of ${server.team}`,
          "Remove from this computer…",
        ],
      ]);
      expect(
        yield* driver("the current account is checked", () =>
          row(opened, key).getByRole("menuitem").getAttribute("aria-current"),
        ),
      ).toBe("true");
      yield* driver("press Escape once in the dashboard under the menu", () =>
        Promise.all([
          opened.waitForEvent("close", { timeout: 10_000 }),
          electron.evaluate(({ BrowserWindow }, title) => {
            const shown = BrowserWindow.getAllWindows().find(
              (window) => window.webContents.getTitle() === title,
            );
            shown?.getParentWindow()?.webContents.sendInputEvent({
              type: "keyDown",
              keyCode: "Escape",
            });
          }, accountMenuTitle),
        ]),
      );
      const menu = yield* clickMenu(electron, dashboard, server.team);
      yield* driver("open Add account", () =>
        menu
          .getByRole("menuitem", { name: "Add account" })
          .click()
          .then(() => menu.getByRole("menu", { name: "Add account" }).waitFor()),
      );
      expect(
        yield* driver("read Add account", () => menu.getByRole("menuitem").allInnerTexts()),
      ).toEqual(["Add account", "Sign in to Executor Cloud", "Run locally", "Self-hosted server…"]);
      yield* driver("go back to the accounts", () =>
        menu
          .getByRole("menuitem", { name: "Add account" })
          .click()
          .then(() => menu.getByRole("menu", { name: accountMenuTitle }).waitFor()),
      );
      yield* driver("choose Account settings", () =>
        Promise.all([
          menu.waitForEvent("close"),
          menu.getByRole("menuitem", { name: "Account settings" }).click(),
        ]),
      );
      yield* driver("the dashboard opens its account settings", () =>
        dashboard.waitForURL((url) => url.pathname === "/account/profile", { timeout: 30_000 }),
      );
      yield* driver("go back to the dashboard", () =>
        dashboard
          .goBack()
          .then(() =>
            dashboard.getByRole("heading", { name: /^Apps/u }).waitFor({ timeout: 60_000 }),
          ),
      );
      yield* addAccount(electron, dashboard, "choose Run locally", "Run locally");
      home.seen.push(yield* nextServer(home.data, []));
      const local = yield* localDashboard(electron, home.origin);
      expect(yield* fs.exists(path.join(home.data, "installation.json"))).toBe(true);
      const both = yield* accountsOf(electron, local);
      expect(summary(both)).toEqual([
        `${server.team} · ${server.host} · self-host · signed-in`,
        "This computer · local · local · signed-in",
      ]);
      expect(both.local).toBe(true);
      expect(yield* windowsAt(electron, server.origin)).toEqual([]);
    }),
  ).pipe(Effect.provide(services)),
);

interface FakeTeam {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly apps: Record<string, string>;
}

const readBody = (request: import("node:http").IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

const listening = (created: Server) =>
  new Promise<number>((resolve) =>
    created.listen(0, "127.0.0.1", () => {
      const address = created.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    }),
  );

const closing = (created: Server) =>
  new Promise<void>((resolve) => {
    created.closeAllConnections();
    created.close(() => resolve());
  });

const fakeCloud = (teams: ReadonlyArray<FakeTeam>) =>
  Effect.gen(function* () {
    const state = {
      choose: teams[0]?.id ?? "",
      codes: new Map<string, string>(),
      refresh: new Map<string, string>(),
      access: new Map<string, string>(),
      sessions: new Map<string, string>(),
      revoked: new Set<string>(),
      origin: "",
      apps: "",
    };
    const serverId = `cloud-${randomBytes(16).toString("hex")}`;
    const teamOf = (id: string | undefined) => teams.find((team) => team.id === id);
    const json = (response: import("node:http").ServerResponse, status: number, value: unknown) =>
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    const tokens = (team: string) => {
      const access = `at-${randomUUID()}`;
      const refresh = `rt-${randomUUID()}`;
      state.access.set(access, team);
      state.refresh.set(refresh, team);
      return { access_token: access, refresh_token: refresh, expires_in: 3600 };
    };
    const bearer = (request: import("node:http").IncomingMessage) =>
      state.access.get((request.headers.authorization ?? "").replace(/^Bearer /u, ""));
    const sessionOf = (request: import("node:http").IncomingMessage) =>
      state.sessions.get(/(?:^|; )session=([^;]+)/u.exec(request.headers.cookie ?? "")?.[1] ?? "");
    const api = createServer((request, response) => {
      void readBody(request).then((text) => {
        const url = new URL(request.url ?? "/", state.origin);
        const form = new URLSearchParams(text);
        const at = state.origin;
        switch (`${request.method} ${url.pathname}`) {
          case "GET /.well-known/executor":
            return json(response, 200, {
              serverId,
              kind: "cloud",
              origins: { dashboard: at, api: at, auth: at },
            });
          case "GET /.well-known/oauth-protected-resource/api/desktop":
            return json(response, 200, {
              resource: `${at}/api/desktop`,
              authorization_servers: [`${at}/api/auth`],
            });
          case "GET /.well-known/oauth-authorization-server/api/auth":
            return json(response, 200, {
              issuer: `${at}/api/auth`,
              authorization_endpoint: `${at}/api/auth/oauth2/authorize`,
              token_endpoint: `${at}/api/auth/oauth2/token`,
              registration_endpoint: `${at}/api/auth/oauth2/register`,
              revocation_endpoint: `${at}/api/auth/oauth2/revoke`,
            });
          case "POST /api/auth/oauth2/register":
            return json(response, 200, { client_id: `client-${randomUUID()}` });
          case "GET /api/auth/oauth2/authorize": {
            const code = `code-${randomUUID()}`;
            state.codes.set(code, state.choose);
            const back = new URL(url.searchParams.get("redirect_uri") ?? "");
            back.search = new URLSearchParams({
              code,
              state: url.searchParams.get("state") ?? "",
            }).toString();
            return response.writeHead(302, { location: back.href }).end();
          }
          case "POST /api/auth/oauth2/token": {
            if (form.get("grant_type") === "authorization_code") {
              const team = state.codes.get(form.get("code") ?? "");
              state.codes.delete(form.get("code") ?? "");
              return team === undefined
                ? json(response, 400, { error: "invalid_grant" })
                : json(response, 200, tokens(team));
            }
            const team = state.refresh.get(form.get("refresh_token") ?? "");
            if (team === undefined || state.revoked.has(team))
              return json(response, 400, { error: "invalid_grant" });
            state.refresh.delete(form.get("refresh_token") ?? "");
            return json(response, 200, tokens(team));
          }
          case "POST /api/auth/oauth2/revoke":
            state.refresh.delete(form.get("token") ?? "");
            return json(response, 200, {});
          case "GET /api/auth/desktop/account": {
            const team = teamOf(bearer(request));
            return team === undefined
              ? json(response, 401, {})
              : json(response, 200, {
                  user: { id: "user_owner", email: "owner@example.test" },
                  organization: { id: team.id, slug: team.slug, name: team.name },
                });
          }
          case "POST /api/auth/desktop/session-link": {
            const team = bearer(request);
            if (team === undefined) return json(response, 401, {});
            const body = JSON.parse(text) as { returnTo: string };
            const link = new URL("/desktop-link", at);
            link.searchParams.set("team", team);
            link.searchParams.set("returnTo", body.returnTo);
            return json(response, 200, {
              url: link.href,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            });
          }
          case "GET /desktop-link": {
            const session = randomUUID();
            state.sessions.set(session, url.searchParams.get("team") ?? "");
            return response
              .writeHead(302, {
                "set-cookie": `session=${session}; Path=/; HttpOnly; SameSite=Lax`,
                location: url.searchParams.get("returnTo") ?? "/",
              })
              .end();
          }
          case "GET /api/auth/get-session":
            return json(
              response,
              200,
              sessionOf(request) === undefined ? null : { user: { id: "user_owner" } },
            );
        }
        const page = /^\/org\/([^/]+)/u.exec(url.pathname);
        if (request.method === "GET" && page !== null) {
          const team = teams.find((candidate) => candidate.slug === page[1]);
          return response
            .writeHead(200, { "content-type": "text/html; charset=utf-8" })
            .end(
              `<!doctype html><html><head><title>Executor</title></head><body><h1>Apps · ${team?.name ?? ""}</h1></body></html>`,
            );
        }
        const details = /^\/api\/organizations\/([^/]+)\/apps\/([^/]+)\/ui$/u.exec(url.pathname);
        if (request.method === "GET" && details !== null) {
          const team = teamOf(details[1]);
          if (team === undefined || bearer(request) !== team.id) return json(response, 401, {});
          const name = team.apps[details[2] ?? ""];
          return name === undefined
            ? json(response, 404, {})
            : json(response, 200, {
                status: "ready",
                url: `${state.apps}/${details[2]}/`,
                name,
                icon: false,
                menuBar: false,
              });
        }
        response.writeHead(404).end();
      });
    });
    const pages = createServer((request, response) => {
      const app = (request.url ?? "/").split("/")[1] ?? "";
      const name = teams.flatMap((team) => Object.entries(team.apps)).find(([id]) => id === app);
      response
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(
          `<!doctype html><html><head><title>Page title</title></head><body><h1>${name?.[1] ?? "Unknown"} page</h1></body></html>`,
        );
    });
    const apiPort = yield* Effect.acquireRelease(
      driver("start the Cloud-shaped server", () => listening(api)),
      () => driver("stop the Cloud-shaped server", () => closing(api)).pipe(Effect.ignore),
    );
    const pagesPort = yield* Effect.acquireRelease(
      driver("start the Cloud-shaped app pages", () => listening(pages)),
      () => driver("stop the Cloud-shaped app pages", () => closing(pages)).pipe(Effect.ignore),
    );
    state.origin = `http://127.0.0.1:${apiPort}`;
    state.apps = `http://127.0.0.1:${pagesPort}`;
    return {
      origin: state.origin,
      host: new URL(state.origin).host,
      appsOrigin: state.apps,
      serverId,
      choose: (team: string) => {
        state.choose = team;
      },
      revoke: (team: string) => state.revoked.add(team),
      moveApps: () => {
        state.apps = `http://localhost:${pagesPort}`;
        return state.apps;
      },
      consent: (authorization: string) =>
        driver("consent in the browser", () =>
          fetch(authorization, { redirect: "manual" }).then((response) =>
            fetch(response.headers.get("location") ?? "").then((callback) => callback.status),
          ),
        ),
    };
  });

it.live(scenarios.desktopAccounts.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const acmeTeam: FakeTeam = {
        id: "org_acme",
        slug: "acme",
        name: "Acme",
        apps: { app_skyline: "Skyline" },
      };
      const northwindTeam: FakeTeam = {
        id: "org_northwind",
        slug: "northwind",
        name: "Northwind",
        apps: { app_atlas: "Atlas" },
      };
      const cloud = yield* fakeCloud([acmeTeam, northwindTeam]);
      const home = yield* desktopHome({ cloud: cloud.origin });
      const labPort = yield* freePort;
      const lab = `http://127.0.0.1:${labPort}`;
      const labServer = `self-host-${randomBytes(16).toString("hex")}`;
      const labKey = `${labServer}.org_lab`;
      const labRecord = {
        serverId: labServer,
        kind: "self-host",
        origin: lab,
        organizationId: "org_lab",
        organizationSlug: "lab",
        label: "Lab",
        account: { id: "user_lab", email: "lab@example.test" },
        partition: randomUUID(),
        state: "signed-in",
        endpoints: {
          resource: `${lab}/api/desktop`,
          api: lab,
          token: `${lab}/api/auth/oauth2/token`,
          revocation: null,
          clientId: "client_lab",
        },
        sealedRefreshToken: "c2VhbGVk",
      };
      const labApp = {
        server: labKey,
        app: "app_lab",
        installation: randomUUID(),
        revision: 0,
        name: "Lab notes",
        origin: lab,
        icon: "monogram:Lab notes",
        launcher: null,
        installedAt: new Date().toISOString(),
        permissions: {},
      };
      yield* fs.makeDirectory(home.profile, { recursive: true });
      yield* fs.writeFileString(
        path.join(home.profile, "servers.json"),
        JSON.stringify({ version: 2, accounts: [labRecord] }),
      );
      yield* fs.writeFileString(
        path.join(home.profile, "installed-apps.json"),
        JSON.stringify({ version: 1, servers: { [labKey]: { apps: { app_lab: labApp } } } }),
      );
      const labAnswers = createServer((_request, response) =>
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ serverId: labServer, kind: "self-host" })),
      );
      yield* Effect.addFinalizer(() =>
        driver("stop the lab server", () => closing(labAnswers)).pipe(Effect.ignore),
      );
      const labHost = new URL(lab).host;
      const acmeKey = `${cloud.serverId}.org_acme`;
      const northwindKey = `${cloud.serverId}.org_northwind`;
      const dashboardFor = (electron: ElectronApplication, slug: string) =>
        windowWhere(
          electron,
          `the ${slug} dashboard`,
          (url) => url.origin === cloud.origin && url.pathname === `/org/${slug}`,
        ).pipe(
          Effect.tap((page) =>
            driver(`the ${slug} dashboard is visible`, () =>
              page.getByRole("heading", { name: /^Apps/u }).waitFor({ timeout: 60_000 }),
            ),
          ),
        );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const electron = yield* launchDesktop({ cwd: home.home, env: home.env });
          home.seen.push(yield* nextServer(home.data, []));
          const local = yield* localDashboard(electron, home.origin);
          yield* recordExternalOpens(electron);
          yield* answerDialogs(electron, { "Install Skyline": 0, "Install Atlas": 0 });
          yield* eventually(
            "a server that does not answer is shown as unreachable",
            accountsOf(electron, local).pipe(Effect.map(summary)),
            (accounts) => accounts[0] === `Lab · ${labHost} · self-host · unreachable`,
          );

          yield* addAccount(
            electron,
            local,
            "sign in to Executor Cloud",
            "Sign in to Executor Cloud",
          );
          yield* waitingShown(electron);
          expect(summary(yield* accountsOf(electron, local))).toEqual([
            `Lab · ${labHost} · self-host · unreachable`,
            `Executor Cloud · ${cloud.host} · cloud · waiting`,
            "This computer · local · local · signed-in",
          ]);
          cloud.choose(acmeTeam.id);
          expect(yield* cloud.consent(yield* authorizationAt(electron, 1))).toBe(200);
          const acme = yield* dashboardFor(electron, "acme");
          expect(yield* bridgeServer(acme)).toBe(acmeKey);
          expect(
            yield* host(acme, "install the first team's app", "install", "app_skyline"),
          ).toMatchObject({ ok: true, value: { server: acmeKey, app: "app_skyline" } });

          expect(
            yield* openDesktopLink({
              cwd: home.home,
              env: home.env,
              link: installLink(cloud.origin, "app_atlas", northwindTeam.id, {
                name: "Atlas",
                team: northwindTeam.name,
              }),
            }),
          ).toBe(0);
          const otherTeam = yield* prompted(electron, "Atlas is in Northwind");
          expect(otherTeam.shown).toEqual({
            title: "Atlas is in Northwind",
            body: "You're signed in to Acme on this computer. Sign in to Northwind to install Atlas; Acme stays signed in.",
            buttons: ["Not now", "Sign in to Northwind"],
            teamMark: true,
          });
          yield* answerPrompt(otherTeam.page, "Sign in to Northwind");
          yield* waitingShown(electron);
          cloud.choose(northwindTeam.id);
          expect(yield* cloud.consent(yield* authorizationAt(electron, 2))).toBe(200);
          yield* appWindow(
            electron,
            "the other team's app",
            (url) => url.origin === cloud.appsOrigin && url.pathname === "/app_atlas/",
            "the other team's app opens",
            "Atlas page",
          );
          expect(yield* bridgeServer(acme)).toBe(acmeKey);

          const all = yield* accountsOf(electron, acme);
          expect(all.current).toBe(acmeKey);
          expect(summary(all)).toEqual([
            `Lab · ${labHost} · self-host · unreachable`,
            `Acme · ${cloud.host} · cloud · signed-in`,
            `Northwind · ${cloud.host} · cloud · signed-in`,
            "This computer · local · local · signed-in",
          ]);
          const installedNames = (yield* readJsonFile(
            StoredApps,
            path.join(home.profile, "installed-apps.json"),
          )).servers;
          expect(
            [labKey, acmeKey, northwindKey].map((key) =>
              Object.values(installedNames[key]?.apps ?? {}).map((app) => app.name),
            ),
          ).toEqual([["Lab notes"], ["Skyline"], ["Atlas"]]);
          const stored = yield* readJsonFile(
            StoredServers,
            path.join(home.profile, "servers.json"),
          );
          expect(
            stored.accounts.map((record) => `${record.serverId}.${record.organizationId}`),
          ).toEqual([labKey, acmeKey, northwindKey]);
          expect(new Set(stored.accounts.map((record) => record.partition)).size).toBe(3);

          yield* switchAccount(electron, acme, "switch to the second team", northwindKey);
          const northwind = yield* dashboardFor(electron, "northwind");
          expect(yield* bridgeServer(northwind)).toBe(northwindKey);
          yield* eventually(
            "switching closed the other team's window",
            windowsAt(electron, cloud.origin),
            (windows) => windows.length === 1,
          );
          const localAccount =
            (yield* accountsOf(electron, northwind)).accounts.find(
              (account) => account.kind === "local",
            )?.id ?? "";
          yield* switchAccount(electron, northwind, "switch to this computer", localAccount);
          const localAgain = yield* localDashboard(electron, home.origin);
          expect(yield* windowsAt(electron, cloud.origin)).toEqual([]);
          yield* switchAccount(electron, localAgain, "switch to the first team", acmeKey);
          const acmeAgain = yield* dashboardFor(electron, "acme");

          yield* addAccount(
            electron,
            acmeAgain,
            "start a sign-in and leave it waiting",
            "Sign in to Executor Cloud",
          );
          yield* waitingShown(electron);
          const pending = (yield* accountsOf(electron, acmeAgain)).accounts.find(
            (account) => account.state === "waiting",
          );
          expect(pending?.team).toBe("Executor Cloud");
          yield* pill(
            electron,
            acmeAgain,
            "cancel the waiting sign-in",
            pending?.id ?? "",
            "Cancel",
          );
          yield* eventually(
            "the cancelled sign-in left no row",
            accountsOf(electron, acmeAgain).pipe(Effect.map(summary)),
            (accounts) => accounts.every((account) => !account.endsWith("waiting")),
          );

          yield* driver(
            "start the unreachable server",
            () =>
              new Promise<void>((resolve) =>
                labAnswers.listen(labPort, "127.0.0.1", () => resolve()),
              ),
          );
          yield* pill(electron, acmeAgain, "retry the unreachable server", labKey, "Retry");
          yield* eventually(
            "the server answers again",
            accountsOf(electron, acmeAgain).pipe(Effect.map(summary)),
            (accounts) => accounts[0] === `Lab · ${labHost} · self-host · signed-in`,
          );
          yield* switchAccount(
            electron,
            acmeAgain,
            "switch to the second team before quitting",
            northwindKey,
          );
          yield* dashboardFor(electron, "northwind");
        }),
      );

      const relaunched = yield* launchDesktop({ cwd: home.home, env: home.env });
      const reopened = yield* dashboardFor(relaunched, "northwind");
      expect(yield* bridgeServer(reopened)).toBe(northwindKey);
      expect(
        yield* driver("the last used team opens first, alone", () =>
          Promise.resolve(relaunched.windows().filter((page) => !page.isClosed()).length),
        ),
      ).toBe(1);
      yield* answerDialogs(relaunched, {});

      yield* switchAccount(relaunched, reopened, "switch to the first team to sign out", acmeKey);
      yield* signOutCurrent(relaunched, yield* dashboardFor(relaunched, "acme"), acmeTeam.name);
      const localNow = yield* localDashboard(relaunched, home.origin);
      const afterSignOut = yield* readJsonFile(
        StoredServers,
        path.join(home.profile, "servers.json"),
      );
      expect(
        afterSignOut.accounts.find((record) => record.organizationId === acmeTeam.id),
      ).toMatchObject({ state: "sign-in-again", sealedRefreshToken: null });
      expect(
        Object.keys(
          (yield* readJsonFile(StoredApps, path.join(home.profile, "installed-apps.json"))).servers[
            acmeKey
          ]?.apps ?? {},
        ),
      ).toEqual(["app_skyline"]);
      expect(summary(yield* accountsOf(relaunched, localNow))[1]).toBe(
        `Acme · ${cloud.host} · cloud · sign-in-again`,
      );
      expect(
        yield* openDesktopLink({
          cwd: home.home,
          env: home.env,
          link: `executor://app/${acmeKey}/app_skyline`,
        }),
      ).toBe(0);
      const signedOut = yield* windowTitled(relaunched, "Skyline");
      expect(
        yield* driver("the signed-out app asks to sign in again", () =>
          Promise.all([
            signedOut.getByRole("heading").innerText(),
            signedOut.getByRole("button").allInnerTexts(),
          ]),
        ),
      ).toEqual(["Sign in again to open Skyline", ["Close", "Sign in again"]]);
      yield* driver("close the signed-out app's page", () =>
        signedOut.getByRole("button", { name: "Close" }).click(),
      );

      const northwindPartition = `executor-account-${
        afterSignOut.accounts.find((record) => record.organizationId === northwindTeam.id)
          ?.partition ?? ""
      }`;
      const partitionCookies = driver("read the removed team's cookies", () =>
        relaunched.evaluate(
          ({ session }, name) =>
            session
              .fromPartition(name)
              .cookies.get({})
              .then((cookies) => cookies.length),
          northwindPartition,
        ),
      );
      expect(yield* partitionCookies).toBeGreaterThan(0);
      expect(
        yield* removeAccount(relaunched, localNow, {
          id: northwindKey,
          team: northwindTeam.name,
          current: false,
        }),
      ).toEqual({
        title: "Remove Northwind from this computer?",
        body: `This signs out, uninstalls Atlas from this computer and clears Northwind's saved data and permissions here. Nothing changes on ${cloud.host}; the apps stay in your team.`,
        buttons: ["Cancel", "Remove"],
        teamMark: false,
      });
      const localAfter = yield* localDashboard(relaunched, home.origin);
      yield* eventually(
        "the removed team left the menu",
        accountsOf(relaunched, localAfter).pipe(Effect.map(summary)),
        (accounts) => accounts.length === 3,
      );
      expect(summary(yield* accountsOf(relaunched, localAfter))).toEqual([
        `Lab · ${labHost} · self-host · signed-in`,
        `Acme · ${cloud.host} · cloud · sign-in-again`,
        "This computer · local · local · signed-in",
      ]);
      expect(
        Object.keys(
          (yield* readJsonFile(StoredApps, path.join(home.profile, "installed-apps.json"))).servers,
        ).toSorted(),
      ).toEqual([labKey, acmeKey].toSorted());
      expect(yield* partitionCookies).toBe(0);
      expect(yield* answeredDialogs(relaunched)).toEqual([]);
    }),
  ).pipe(Effect.provide(services)),
);

const StoredGrants = Schema.fromJsonString(
  Schema.Struct({
    servers: Schema.Record(
      Schema.String,
      Schema.Struct({
        apps: Schema.Record(
          Schema.String,
          Schema.Struct({
            origin: Schema.String,
            permissions: Schema.Record(Schema.String, Schema.String),
          }),
        ),
      }),
    ),
  }),
);

const forgedServer = (identity: { readonly serverId: string; readonly kind: string }) =>
  Effect.gen(function* () {
    let origin = "";
    const forged = createServer((request, response) => {
      if (request.url !== "/.well-known/executor") return response.writeHead(404).end();
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          ...identity,
          origins: { dashboard: origin, api: origin, auth: origin },
        }),
      );
    });
    const port = yield* Effect.acquireRelease(
      driver("start a forged server", () => listening(forged)),
      () => driver("stop the forged server", () => closing(forged)).pipe(Effect.ignore),
    );
    origin = `http://127.0.0.1:${port}`;
    return origin;
  });

it.live(scenarios.desktopForgedServer.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const acmeTeam: FakeTeam = {
        id: "org_acme",
        slug: "acme",
        name: "Acme",
        apps: { app_skyline: "Skyline" },
      };
      const cloud = yield* fakeCloud([acmeTeam]);
      const home = yield* desktopHome({ cloud: cloud.origin });
      const lab = `http://127.0.0.1:${yield* freePort}`;
      const labServer = `self-host-${randomBytes(16).toString("hex")}`;
      const labKey = `${labServer}.org_lab`;
      const labRecord = {
        serverId: labServer,
        kind: "self-host",
        origin: lab,
        organizationId: "org_lab",
        organizationSlug: "lab",
        label: "Lab",
        account: { id: "user_lab", email: "lab@example.test" },
        partition: randomUUID(),
        state: "signed-in",
        endpoints: {
          resource: `${lab}/api/desktop`,
          api: lab,
          token: `${lab}/api/auth/oauth2/token`,
          revocation: null,
          clientId: "client_lab",
        },
        sealedRefreshToken: "c2VhbGVk",
      };
      yield* fs.makeDirectory(home.profile, { recursive: true });
      yield* fs.writeFileString(
        path.join(home.profile, "servers.json"),
        JSON.stringify({ version: 2, accounts: [labRecord] }),
      );
      const acmeKey = `${cloud.serverId}.${acmeTeam.id}`;
      const electron = yield* launchDesktop({ cwd: home.home, env: home.env });
      home.seen.push(yield* nextServer(home.data, []));
      const local = yield* localDashboard(electron, home.origin);
      yield* recordExternalOpens(electron);
      yield* answerDialogs(electron, { "Install Skyline": 0, "Skyline permission": 0 });

      yield* addAccount(electron, local, "sign in to Executor Cloud", "Sign in to Executor Cloud");
      yield* waitingShown(electron);
      expect(yield* cloud.consent(yield* authorizationAt(electron, 1))).toBe(200);
      const acme = yield* windowWhere(
        electron,
        "the team's dashboard",
        (url) => url.origin === cloud.origin && url.pathname === `/org/${acmeTeam.slug}`,
      );
      yield* dashboardVisible(acme, "the team's dashboard");
      expect(yield* host(acme, "install the team's app", "install", "app_skyline")).toMatchObject({
        ok: true,
        value: { server: acmeKey, app: "app_skyline" },
      });
      expect(
        yield* host(
          acme,
          "allow the app to float",
          "setPermission",
          "app_skyline",
          "floating",
          "granted",
        ),
      ).toEqual({ ok: true, value: "granted" });
      expect(yield* host(acme, "open the app", "open", "app_skyline")).toMatchObject({ ok: true });
      yield* appWindow(
        electron,
        "the app at its first address",
        (url) => url.origin === cloud.appsOrigin,
        "the app opens",
        "Skyline page",
      );
      const grants = () =>
        readJsonFile(StoredGrants, path.join(home.profile, "installed-apps.json")).pipe(
          Effect.map((stored) => stored.servers[acmeKey]?.apps.app_skyline),
        );
      expect(yield* grants()).toEqual({
        origin: cloud.appsOrigin,
        permissions: { floating: "granted" },
      });

      const moved = cloud.moveApps();
      yield* driver("close the app", () =>
        electron.evaluate(({ BrowserWindow }, origin) => {
          for (const window of BrowserWindow.getAllWindows())
            if (URL.parse(window.webContents.getURL())?.origin === origin) window.close();
        }, cloud.appsOrigin),
      );
      expect(yield* host(acme, "open the app again", "open", "app_skyline")).toMatchObject({
        ok: true,
      });
      yield* appWindow(
        electron,
        "the app at its new address",
        (url) => url.origin === moved,
        "the app opens from its new address",
        "Skyline page",
      );
      expect(yield* grants()).toEqual({ origin: moved, permissions: {} });
      expect(
        yield* host(acme, "read the moved app's permissions", "permissions", "app_skyline"),
      ).toMatchObject({ ok: true, value: { floating: "prompt" } });

      yield* answerDialogs(electron, { "Skyline permission": 1 });
      expect(
        yield* host(
          acme,
          "ask to allow the camera",
          "setPermission",
          "app_skyline",
          "camera",
          "granted",
        ),
      ).toEqual({ ok: true, value: "prompt" });
      expect(yield* answeredDialogs(electron)).toEqual([
        {
          title: "Skyline permission",
          message: `Skyline · Acme on ${cloud.host} wants to use your camera.`,
          detail: "You can change this later in the app's menu or in its Desktop settings.",
        },
      ]);
      expect(
        yield* host(acme, "deny the camera", "setPermission", "app_skyline", "camera", "denied"),
      ).toEqual({ ok: true, value: "denied" });
      expect(yield* answeredDialogs(electron)).toHaveLength(1);

      const claimsLab = yield* forgedServer({ serverId: labServer, kind: "self-host" });
      const claimsCloud = yield* forgedServer({ serverId: cloud.serverId, kind: "cloud" });
      const borrowsCloud = yield* forgedServer({ serverId: cloud.serverId, kind: "self-host" });
      const refusedSignIn = (origin: string) =>
        Effect.gen(function* () {
          yield* addAccount(electron, acme, "add the forged server", "Self-hosted server…");
          yield* signInFromWelcome(electron, origin, "self-host");
          const welcome = yield* welcomeWindow(electron);
          return yield* driver("read why the desktop did not sign in", () =>
            welcome.getByRole("alert").innerText({ timeout: 30_000 }),
          );
        });
      const hostOf = (origin: string) => new URL(origin).host;
      expect(yield* refusedSignIn(claimsLab)).toBe(
        `${hostOf(claimsLab)} says it is the Executor server at ${hostOf(lab)}, which this computer already signs in to. Executor did not sign in.`,
      );
      expect(yield* refusedSignIn(claimsCloud)).toBe(
        `${hostOf(claimsCloud)} says it is Executor Cloud, which is only at ${cloud.host}. Executor did not sign in.`,
      );
      expect(yield* refusedSignIn(borrowsCloud)).toBe(
        `${hostOf(borrowsCloud)} did not answer as an Executor server. Executor did not sign in.`,
      );

      expect(
        yield* openDesktopLink({
          cwd: home.home,
          env: home.env,
          link: installLink(claimsLab, "app_lab", "org_lab", { name: "Lab notes", team: "Lab" }),
        }),
      ).toBe(0);
      const refusedInstall = yield* prompted(electron, "Executor can't install this app");
      expect(refusedInstall.shown).toEqual({
        title: "Executor can't install this app",
        body: `${hostOf(claimsLab)} says it is the Executor server at ${hostOf(lab)}, which this computer already signs in to. Executor did not install Lab notes.`,
        buttons: ["OK"],
        teamMark: false,
      });
      yield* answerPrompt(refusedInstall.page, "OK");

      const stored = yield* readJsonFile(StoredServers, path.join(home.profile, "servers.json"));
      expect(
        stored.accounts.map((record) => `${record.serverId}.${record.organizationId}`),
      ).toEqual([labKey, acmeKey]);
      expect(
        (yield* readJsonFile(
          Schema.fromJsonString(
            Schema.Struct({ accounts: Schema.Array(Schema.Struct({ origin: Schema.String })) }),
          ),
          path.join(home.profile, "servers.json"),
        )).accounts.map((record) => record.origin),
      ).toEqual([lab, cloud.origin]);
    }),
  ).pipe(Effect.provide(services)),
);

it.live(scenarios.desktopHostedServers.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const http = yield* HttpClient.HttpClient;
      const fs = yield* FileSystem.FileSystem;
      const server = yield* selfHostedServer;
      const hosted = yield* server.deploy(
        server.actors.organization.id,
        `Hosted ${randomUUID().slice(0, 6)}`,
        "Hosted app",
        true,
      );
      const second = yield* server.deploy(
        server.actors.organization.id,
        `Second ${randomUUID().slice(0, 6)}`,
        "Second app",
      );
      const home = yield* desktopHome();
      yield* fs.makeDirectory(home.profile, { recursive: true });
      const forgotten = `self-host-${randomBytes(16).toString("hex")}.org_gone`;
      yield* fs.writeFileString(
        path.join(home.profile, "installed-apps.json"),
        JSON.stringify({
          version: 1,
          servers: {
            [forgotten]: {
              apps: {
                app_forgotten: {
                  server: forgotten,
                  app: "app_forgotten",
                  installation: randomUUID(),
                  revision: 1,
                  name: "Forgotten",
                  origin: "https://forgotten.example",
                  icon: "monogram:Forgotten",
                  launcher: null,
                  installedAt: new Date().toISOString(),
                  permissions: { floating: "granted" },
                },
              },
            },
          },
        }),
      );
      const electron = yield* launchDesktop({ cwd: home.home, env: home.env });
      home.seen.push(yield* nextServer(home.data, []));
      let local = yield* localDashboard(electron, home.origin);
      const localServer = yield* bridgeServer(local).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.String)),
      );
      expect(localServer).toMatch(/^local-[0-9a-f]{32}$/u);
      yield* eventually(
        "installs of an account this computer no longer holds are removed at startup",
        readJsonFile(StoredApps, path.join(home.profile, "installed-apps.json")).pipe(
          Effect.map((stored) => Object.keys(stored.servers)),
        ),
        (servers) => servers.length === 0,
      );
      yield* recordExternalOpens(electron);
      yield* watchDesktopShell(electron);
      const localName = `Local ${randomUUID().slice(0, 6)}`;
      yield* answerDialogs(electron, {
        [`Install ${hosted.name}`]: 0,
        [`Install ${second.name}`]: 0,
        [`${hosted.name} permission`]: 0,
        [`Install ${localName}`]: 0,
      });
      const localDeployed = yield* driver("deploy a local app", () =>
        local.request.post(`${home.origin}/v1/apps/deploy`, {
          headers: { authorization: `Bearer ${home.apiKey}` },
          data: { owner: "local", name: localName, files: appFiles("Local app", false) },
        }),
      );
      expect(localDeployed.status()).toBe(200);
      const localApp = (yield* driver("read the local app", () => localDeployed.json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Deployed)),
      )).app.id;
      expect(yield* host(local, "install the local app", "install", localApp)).toMatchObject({
        ok: true,
        value: { server: localServer, app: localApp, name: localName },
      });

      yield* addAccount(electron, local, "add a self-hosted server", "Self-hosted server…");
      yield* signInFromWelcome(electron, server.origin, "self-host");
      yield* waitingShown(electron);
      const authorization = new URL(yield* authorizationAt(electron, 1));
      expect(`${authorization.origin}${authorization.pathname}`).toBe(
        `${server.origin}/api/auth/oauth2/authorize`,
      );
      const redirect = new URL(authorization.searchParams.get("redirect_uri") ?? "");
      expect({
        redirect: `${redirect.protocol}//${redirect.hostname}${redirect.pathname}`,
        scope: authorization.searchParams.get("scope"),
        resource: authorization.searchParams.get("resource"),
        method: authorization.searchParams.get("code_challenge_method"),
      }).toEqual({
        redirect: "http://127.0.0.1/callback",
        scope: "desktop offline_access",
        resource: `${server.origin}/api/desktop`,
        method: "S256",
      });
      const callback = `${redirect.origin}${redirect.pathname}`;
      const callbackStatus = (query: string) =>
        driver(`send the loopback callback ${query}`, () =>
          fetch(`${callback}?${query}`).then(
            (response) => response.status,
            () => "closed",
          ),
        );
      expect(
        yield* Effect.all({
          otherState: callbackStatus("code=forged&state=forged"),
          otherStateError: callbackStatus("error=access_denied&state=forged"),
          noState: callbackStatus("code=forged"),
          stateOnly: callbackStatus(
            `state=${encodeURIComponent(authorization.searchParams.get("state") ?? "")}`,
          ),
        }),
      ).toEqual({ otherState: 400, otherStateError: 400, noState: 400, stateOnly: 400 });

      const browser = yield* systemBrowser;
      const ownerCookies = reveal(yield* server.actors.owner.cookies);
      const consent = yield* driver("open the consent page signed in as the owner", () =>
        browser.newContext().then((context) =>
          context
            .addCookies([...ownerCookies])
            .then(() => context.newPage())
            .then((page) => page.goto(authorization.href).then(() => page)),
        ),
      );
      yield* driver("choose the organization on the consent page", () =>
        chooseConsentOrganization(consent, server.team),
      );
      expect(
        yield* driver("the consent names the desktop's access", () =>
          consentValue(consent, "Access"),
        ),
      ).toBe("Your Executor account");
      const callbackTwice: Array<number> = [];
      const browserRepeats: Array<string> = [];
      let sentTwice = false;
      let sentUrl = "";
      const forward = (route: Route, response: globalThis.Response) =>
        response.text().then((text) =>
          route.fulfill({
            status: response.status,
            contentType: "text/html; charset=utf-8",
            body: text,
          }),
        );
      yield* driver("send the consent page's callback twice at once, as Cloud's page does", () =>
        consent.route(`${callback}?*`, (route) => {
          const url = route.request().url();
          // external: Chromium can issue one cross-origin navigation request twice.
          if (sentTwice)
            return fetch(url).then((response) => {
              browserRepeats.push(`${response.status} ${url === sentUrl ? "same" : "other"}`);
              return forward(route, response);
            });
          sentTwice = true;
          sentUrl = url;
          return Promise.all([fetch(url), fetch(url)]).then(([first, again]) => {
            callbackTwice.push(first.status, again.status);
            return forward(route, first);
          });
        }),
      );
      yield* driver("approve the desktop", () =>
        consent.getByRole("button", { name: "Connect", exact: true }).click(),
      );
      yield* driver("the desktop's loopback callback received the sign-in", () =>
        consent
          .getByRole("heading", { name: "Executor is signed in" })
          .waitFor({ timeout: 30_000 }),
      );
      expect(callbackTwice).toEqual([200, 200]);
      expect(browserRepeats.filter((repeat) => repeat !== "200 same")).toEqual([]);
      const dashboard = yield* hostedDashboard(
        electron,
        server.origin,
        server.actors.organization.slug,
      );
      const key = `${server.identity.serverId}.${server.actors.organization.id}`;
      expect(yield* bridgeServer(dashboard)).toBe(key);
      const again = `code=again&state=${encodeURIComponent(authorization.searchParams.get("state") ?? "")}`;
      expect(yield* callbackStatus(again)).not.toBe(200);
      yield* eventually(
        "the loopback listener closes after the sign-in",
        callbackStatus(again),
        (status) => status === "closed",
      );
      const signedIn = yield* driver("read the hosted dashboard's session", () =>
        dashboard.evaluate(() =>
          fetch("/api/auth/get-session").then((response) => response.json()),
        ),
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(SessionUser)));
      expect(signedIn?.user.email).toBe("owner@example.test");
      const stored = yield* readJsonFile(StoredServers, path.join(home.profile, "servers.json"));
      const [record] = stored.accounts;
      expect(record).toMatchObject({
        serverId: server.identity.serverId,
        organizationId: server.actors.organization.id,
        kind: "self-host",
        label: server.team,
        state: "signed-in",
        account: { email: "owner@example.test" },
      });
      const partition = `executor-account-${record?.partition ?? ""}`;
      const cookiesIn = (name: string) =>
        driver(`read the ${name} partition's cookies`, () =>
          electron.evaluate(
            ({ session }, name) =>
              session
                .fromPartition(name)
                .cookies.get({})
                .then((cookies) =>
                  cookies
                    .filter((cookie) => cookie.httpOnly)
                    .map((cookie) => `${cookie.name}=${cookie.value}`),
                ),
            name,
          ),
        );
      const partitionCookies = cookiesIn(partition);
      const hostedCookies = yield* partitionCookies;
      expect(hostedCookies.length).toBeGreaterThan(0);
      expect(hostedCookies.some((cookie) => cookie.startsWith("executor-desktop-link="))).toBe(
        false,
      );
      const localCookies = yield* cookiesIn("executor-desktop");
      expect(hostedCookies.filter((cookie) => localCookies.includes(cookie))).toEqual([]);

      expect(yield* host(dashboard, "install the hosted app", "install", hosted.app)).toMatchObject(
        {
          ok: true,
          value: { server: key, app: hosted.app, name: hosted.name },
        },
      );
      expect(
        yield* openDesktopLink({
          cwd: home.home,
          env: home.env,
          link: `executor://app/${key}/${hosted.app}`,
        }),
      ).toBe(0);
      yield* appWindow(
        electron,
        "the hosted app",
        (url) => url.origin === hosted.url.origin,
        "the hosted app opens signed in",
        "Hosted app",
      );
      expect(yield* windowsOn(electron, hosted.url.hostname)).toEqual([
        { title: `${hosted.name} — ${server.team}`, visible: true },
      ]);
      yield* eventually(
        "the hosted app's menu-bar item names its team",
        menuBarItems(electron),
        (items) => items.includes(`${hosted.name} — ${server.team}`),
      );
      expect(
        yield* openDesktopLink({
          cwd: home.home,
          env: home.env,
          link: `executor://app/${localServer}/${localApp}`,
        }),
      ).toBe(0);
      const localHost = `${localApp.replace(/^app_/, "app-")}.localhost`;
      yield* appWindow(
        electron,
        "the local app",
        (url) => url.hostname === localHost,
        "the local app opens signed in",
        "Local app",
      );
      expect(
        yield* host(dashboard, "the hosted bridge cannot see the local app", "installed", localApp),
      ).toEqual({ ok: true, value: null });
      expect(
        yield* host(
          dashboard,
          "allow the hosted app to float",
          "setPermission",
          hosted.app,
          "floating",
          "granted",
        ),
      ).toEqual({ ok: true, value: "granted" });
      expect(
        ((yield* answeredDialogs(electron)) ?? []).filter(
          (shown) => shown.title === `${hosted.name} permission`,
        ),
      ).toContainEqual({
        title: `${hosted.name} permission`,
        message: `${hosted.name} · ${server.team} on ${server.host} wants to keep its window above other windows.`,
        detail: "You can change this later in the app's menu or in its Desktop settings.",
      });
      expect(
        yield* host(dashboard, "read the hosted app's permissions", "permissions", hosted.app),
      ).toEqual({
        ok: true,
        value: permissionStates({ menuBar: "granted", floating: "granted" }),
      });
      expect(
        yield* host(dashboard, "install the second hosted app", "install", second.app),
      ).toMatchObject({ ok: true, value: { server: key, app: second.app, name: second.name } });

      yield* driver("record the binding cookies the desktop sets", () =>
        electron.evaluate(({ session }, name) => {
          const set: Array<{ expires: number; at: number }> = [];
          Object.assign(globalThis, { executorE2ELinkCookies: set });
          session.fromPartition(name).cookies.on("changed", (_event, cookie, _cause, removed) => {
            if (!removed && cookie.name.endsWith("executor-desktop-link"))
              set.push({ expires: cookie.expirationDate ?? 1e12, at: Date.now() / 1000 });
          });
        }, partition),
      );
      yield* switchAccount(electron, dashboard, "switch to this computer", localServer);
      local = yield* localDashboard(electron, home.origin);
      expect(
        yield* host(local, "the local bridge cannot see the hosted app", "installed", hosted.app),
      ).toEqual({ ok: true, value: null });
      yield* driver("end the hosted session", () =>
        electron.evaluate(
          ({ session }, name) =>
            session.fromPartition(name).clearStorageData({ storages: ["cookies"] }),
          partition,
        ),
      );
      const switching = yield* openMenu(electron, local);
      yield* driver("switch to the team and open both apps at the same moment", () =>
        Promise.all([
          row(switching, key).getByRole("menuitem").click(),
          electron.evaluate(
            ({ app }, links) => {
              for (const link of links)
                app.emit("open-url", { preventDefault: () => undefined }, link);
            },
            [`executor://app/${key}/${hosted.app}`, `executor://app/${key}/${second.app}`],
          ),
        ]),
      );
      yield* hostedDashboard(electron, server.origin, server.actors.organization.slug);
      yield* appWindow(
        electron,
        "the second hosted app",
        (url) => url.origin === second.url.origin,
        "the second hosted app opens signed in",
        "Second app",
      );
      expect(yield* windowsAt(electron, server.origin)).toEqual([`Executor — ${server.team}`]);
      const linkCookies = yield* driver("read the binding cookies the desktop set", () =>
        electron.evaluate(
          () =>
            Reflect.get(globalThis, "executorE2ELinkCookies") as Array<{
              expires: number;
              at: number;
            }>,
        ),
      );
      expect(linkCookies).toHaveLength(1);
      expect(linkCookies.every((cookie) => cookie.expires - cookie.at <= 61)).toBe(true);

      const linkSession = yield* partitionCookies;
      const sessionWith = (cookies: ReadonlyArray<string>) =>
        http
          .get(`${server.origin}/api/auth/get-session`, {
            headers: { cookie: cookies.join("; ") },
          })
          .pipe(
            Effect.flatMap((response) => response.json),
            Effect.flatMap(Schema.decodeUnknownEffect(SessionUser)),
          );
      expect((yield* sessionWith(linkSession))?.user.email).toBe("owner@example.test");
      const consents = yield* server.clients
        .request(server.actors.owner, "GET", "/api/auth/oauth2/get-consents")
        .pipe(Effect.flatMap((response) => body(Consents, response)));
      expect(consents.length).toBeGreaterThan(0);
      for (const granted of consents)
        expect(
          (yield* server.clients.request(
            server.actors.owner,
            "POST",
            "/api/auth/oauth2/delete-consent",
            { id: granted.id },
          )).status,
        ).toBe(200);
      yield* driver("close the hosted app's window", () =>
        electron.evaluate(({ BrowserWindow }, hostname) => {
          for (const window of BrowserWindow.getAllWindows())
            if (URL.parse(window.webContents.getURL())?.hostname === hostname) window.close();
        }, hosted.url.hostname),
      );
      expect(
        yield* openDesktopLink({
          cwd: home.home,
          env: home.env,
          link: `executor://app/${key}/${hosted.app}`,
        }),
      ).toBe(0);
      const signInAgain = yield* windowTitled(electron, hosted.name);
      expect(
        yield* driver("the revoked team's app asks to sign in again", () =>
          signInAgain.getByRole("heading").innerText({ timeout: 30_000 }),
        ),
      ).toBe(`Sign in again to open ${hosted.name}`);
      expect(yield* windowsOn(electron, hosted.url.hostname)).toEqual([]);
      expect(yield* windowsOn(electron, second.url.hostname)).toEqual([]);
      expect(yield* menuBarItems(electron)).toEqual([]);
      local = yield* localDashboard(electron, home.origin);
      yield* eventually(
        "no window stays on the revoked server's origin",
        windowsAt(electron, server.origin),
        (windows) => windows.length === 0,
      );
      expect(yield* partitionCookies).toEqual([]);
      expect(yield* sessionWith(linkSession)).toBeNull();
      expect(summary(yield* accountsOf(electron, local))).toEqual([
        `${server.team} · ${server.host} · self-host · sign-in-again`,
        "This computer · local · local · signed-in",
      ]);
      expect(
        (yield* readJsonFile(StoredServers, path.join(home.profile, "servers.json"))).accounts[0]
          ?.state,
      ).toBe("sign-in-again");
      expect(yield* windowsOn(electron, localHost)).toHaveLength(1);

      yield* removeAccount(electron, local, { id: key, team: server.team, current: false });
      yield* eventually(
        "the removed team left this computer",
        readJsonFile(StoredServers, path.join(home.profile, "servers.json")).pipe(
          Effect.map((stored) => stored.accounts.length),
        ),
        (count) => count === 0,
      );
      expect(
        (yield* readJsonFile(StoredServers, path.join(home.profile, "servers.json"))).accounts,
      ).toEqual([]);
      const apps = yield* readJsonFile(StoredApps, path.join(home.profile, "installed-apps.json"));
      expect(Object.keys(apps.servers)).toEqual([localServer]);
      expect(Object.keys(apps.servers[localServer]?.apps ?? {}).toSorted()).toEqual([localApp]);
      expect(yield* partitionCookies).toEqual([]);
      const onlyLocal = yield* openMenu(electron, local);
      expect(
        yield* driver("read the local-only account menu", () =>
          onlyLocal.getByRole("menuitem").allInnerTexts(),
        ),
      ).toEqual([
        "Sign in to Executor Cloud\nUse your team's apps here too",
        "Self-hosted server…",
      ]);
      yield* closedMenu(onlyLocal);
      expect(yield* windowsOn(electron, localHost)).toEqual([{ title: localName, visible: true }]);
    }),
  ).pipe(Effect.provide(services)),
);

const installLink = (
  server: string,
  app: string,
  org: string,
  labels: { readonly name?: string; readonly team?: string } = {},
) => `executor://install?${new URLSearchParams({ server, app, org, ...labels }).toString()}`;

const installDialog = (name: string, where: string) => ({
  title: `Install ${name}`,
  message: `${name} · ${where} will be installed as an app on this computer.`,
  detail:
    "It gets its own window and icon. It can't reach your files or accounts beyond what the app already uses.",
});

const prompted = (electron: ElectronApplication, title: string) =>
  Effect.gen(function* () {
    const page = yield* windowTitled(electron, title);
    const text = yield* driver(`read the ${title} prompt`, () =>
      Promise.all([
        page.getByRole("dialog").getByRole("heading").innerText(),
        page.locator("#description").innerText(),
        page.locator(".actions button").allInnerTexts(),
        page.locator(".tile .team").count(),
      ]),
    );
    return {
      page,
      shown: { title: text[0], body: text[1], buttons: text[2], teamMark: text[3] === 1 },
    };
  });

const answerPrompt = (page: Page, button: string) =>
  driver(`answer ${button}`, () => page.getByRole("button", { name: button, exact: true }).click());

it.live(scenarios.desktopHostedInstallLink.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const server = yield* selfHostedServer;
      const first = yield* server.deploy(
        server.actors.organization.id,
        `Linked ${randomUUID().slice(0, 6)}`,
        "Linked app",
      );
      const second = yield* server.deploy(
        server.actors.organization.id,
        `Relay ${randomUUID().slice(0, 6)}`,
        "Relay app",
      );
      const home = yield* desktopHome();
      const electron = yield* launchDesktop({ cwd: home.home, env: home.env });
      home.seen.push(yield* nextServer(home.data, []));
      yield* localDashboard(electron, home.origin);
      yield* recordExternalOpens(electron);
      yield* answerDialogs(electron, {
        [`Install ${first.name}`]: 0,
        [`Install ${second.name}`]: 0,
      });
      const shownDialogs = (title: string) =>
        answeredDialogs(electron).pipe(
          Effect.map((boxes) => (boxes ?? []).filter((box) => box.title === title)),
        );
      const open = (link: string) => openDesktopLink({ cwd: home.home, env: home.env, link });
      const firstLink = installLink(server.origin, first.app, server.actors.organization.id, {
        name: first.name,
        team: server.team,
      });

      expect(yield* open(firstLink)).toBe(0);
      const ask = yield* prompted(electron, `Sign in to install ${first.name}`);
      expect(ask.shown).toEqual({
        title: `Sign in to install ${first.name}`,
        body: `You're using Executor on this computer. ${first.name} is in the ${server.team} team on ${server.host}. Sign in to ${server.host} and it opens as an app here. Your local apps stay as they are.`,
        buttons: ["Not now", "Sign in"],
        teamMark: true,
      });
      yield* answerPrompt(ask.page, "Not now");
      expect(yield* externalOpens(electron)).toEqual([]);
      expect(yield* open(firstLink)).toBe(0);
      const again = yield* prompted(electron, `Sign in to install ${first.name}`);
      yield* answerPrompt(again.page, "Sign in");
      yield* waitingShown(electron);
      const browser = yield* systemBrowser;
      const ownerCookies = reveal(yield* server.actors.owner.cookies);
      yield* consentIn(
        browser,
        ownerCookies,
        yield* authorizationAt(electron, 1),
        server.team,
        "Connect",
      );
      yield* appWindow(
        electron,
        "the linked app",
        (url) => url.origin === first.url.origin,
        "the linked app opens signed in",
        "Linked app",
      );
      expect(yield* shownDialogs(`Install ${first.name}`)).toEqual([
        installDialog(first.name, `${server.team} on ${server.host}`),
      ]);
      const acmeKey = `${server.identity.serverId}.${server.actors.organization.id}`;

      yield* driver("close the linked app", () =>
        electron.evaluate(({ BrowserWindow }, origin) => {
          for (const window of BrowserWindow.getAllWindows())
            if (URL.parse(window.webContents.getURL())?.origin === origin) window.close();
        }, first.url.origin),
      );
      expect(yield* open(firstLink)).toBe(0);
      yield* appWindow(
        electron,
        "the installed app again",
        (url) => url.origin === first.url.origin,
        "the installed app opens again",
        "Linked app",
      );
      expect(yield* shownDialogs(`Install ${first.name}`)).toHaveLength(1);

      yield* signOutCurrent(
        electron,
        yield* hostedDashboard(electron, server.origin, server.actors.organization.slug),
        server.team,
      );
      yield* localDashboard(electron, home.origin);
      expect(
        yield* open(
          installLink(server.origin, second.app, server.actors.organization.id, {
            name: second.name,
            team: server.team,
          }),
        ),
      ).toBe(0);
      const reauth = yield* prompted(electron, `Sign in again to install ${second.name}`);
      expect(reauth.shown).toEqual({
        title: `Sign in again to install ${second.name}`,
        body: `This computer's sign-in to ${server.team} on ${server.host} ended. Sign in again and ${second.name} opens as an app here.`,
        buttons: ["Not now", "Sign in again"],
        teamMark: true,
      });
      yield* answerPrompt(reauth.page, "Sign in again");
      yield* waitingShown(electron);
      yield* consentIn(
        browser,
        ownerCookies,
        yield* authorizationAt(electron, 2),
        server.team,
        "Connect",
      );
      yield* appWindow(
        electron,
        "the app installed after signing in again",
        (url) => url.origin === second.url.origin,
        "the app opens after signing in again",
        "Relay app",
      );
      const apps = yield* readJsonFile(StoredApps, path.join(home.profile, "installed-apps.json"));
      expect(Object.keys(apps.servers[acmeKey]?.apps ?? {}).toSorted()).toEqual(
        [first.app, second.app].toSorted(),
      );

      expect(
        yield* open(
          installLink(server.origin, "app_missing", server.actors.organization.id, {
            name: "Missing",
          }),
        ),
      ).toBe(0);
      const missing = yield* prompted(electron, "Missing isn't available");
      expect(missing.shown).toEqual({
        title: "Missing isn't available",
        body: `${server.host} has no app with this link that you can open, or it has no page to open as an app. It may have been removed, or you may not have access to it.`,
        buttons: ["OK"],
        teamMark: false,
      });
      yield* answerPrompt(missing.page, "OK");
      expect(yield* externalOpens(electron)).toHaveLength(2);
    }),
  ).pipe(Effect.provide(services)),
);

it.live(scenarios.desktopServerDiscovery.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const advertised = {
        origins: { dashboard: "", api: "", auth: "" },
        resource: "",
        issuer: "",
      };
      const fake = yield* Effect.acquireRelease(
        driver("start a server that answers Executor discovery", () => {
          const created = createServer((request, response) => {
            const url = new URL(request.url ?? "/", "http://placeholder");
            seen.push(`${request.method} ${url.pathname}`);
            const at = `http://${request.headers.host ?? ""}`;
            const answers: Record<string, unknown> = {
              "/.well-known/executor": {
                serverId: `self-host-${"0".repeat(32)}`,
                kind: "self-host",
                origins: advertised.origins,
              },
              "/.well-known/oauth-protected-resource/api/desktop": {
                resource: advertised.resource,
                authorization_servers: [advertised.issuer],
              },
              "/.well-known/oauth-authorization-server/api/auth": {
                issuer: advertised.issuer,
                authorization_endpoint: `${at}/api/auth/oauth2/authorize`,
                token_endpoint: `${at}/api/auth/oauth2/token`,
                registration_endpoint: `${at}/api/auth/oauth2/register`,
              },
            };
            const answer = request.method === "GET" ? answers[url.pathname] : undefined;
            if (answer === undefined) response.writeHead(404).end();
            else
              response
                .writeHead(200, { "content-type": "application/json" })
                .end(JSON.stringify(answer));
          });
          return new Promise<{ readonly server: Server; readonly port: number }>((resolve) =>
            created.listen(0, "127.0.0.1", () => {
              const address = created.address();
              resolve({
                server: created,
                port: typeof address === "object" && address !== null ? address.port : 0,
              });
            }),
          );
        }),
        ({ server }) =>
          driver(
            "stop the discovery server",
            () =>
              new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
              }),
          ).pipe(Effect.ignore),
      );
      const loopback = `http://127.0.0.1:${fake.port}`;
      const elsewhere = `http://localhost:${fake.port}`;
      const offLoopback = `http://0.0.0.0:${fake.port}`;

      const home = yield* desktopHome();
      const electron = yield* launchDesktop({ cwd: home.home, env: home.env, welcome: true });
      yield* recordExternalOpens(electron);
      const welcome = yield* welcomeWindow(electron);
      const backend = yield* driver("read the credential store Electron chose", () =>
        electron.evaluate(({ safeStorage }) =>
          process.platform === "linux" ? safeStorage.getSelectedStorageBackend() : "os",
        ),
      );
      const keyringExpected = yield* Config.Boolean("EXECUTOR_E2E_EXPECT_KEYRING").pipe(
        Config.withDefault(false),
      );
      if (keyringExpected) expect(backend).not.toBe("basic_text");
      expect(
        yield* driver("read the welcome window's notes", () =>
          welcome.getByRole("note").allInnerTexts(),
        ),
      ).toEqual(
        backend === "basic_text"
          ? [
              "This computer has no credential store Executor can use, so the sign-in it keeps is protected only by your account's file permissions.",
            ]
          : [],
      );
      const attempt = (origin: string) =>
        Effect.gen(function* () {
          const before = seen.length;
          yield* signInFromWelcome(electron, origin, "self-host");
          yield* eventually(
            "the desktop asked the server",
            Effect.sync(() => seen.length),
            (count) => count > before,
          );
          const page = yield* welcomeWindow(electron);
          return yield* driver(`read the refusal for ${origin}`, () =>
            page.getByRole("alert").first().innerText({ timeout: 30_000 }),
          );
        });

      const refusal = `127.0.0.1:${fake.port} sends desktop sign-in to another address, so Executor did not sign in.`;
      const cases = [
        { origins: { dashboard: loopback, api: elsewhere, auth: loopback }, at: loopback },
        { origins: { dashboard: loopback, api: loopback, auth: elsewhere }, at: loopback },
        { origins: { dashboard: elsewhere, api: elsewhere, auth: elsewhere }, at: loopback },
        { origins: { dashboard: loopback, api: loopback, auth: loopback }, at: elsewhere },
        {
          origins: { dashboard: loopback, api: loopback, auth: loopback },
          at: loopback,
          issuer: elsewhere,
        },
      ];
      for (const { origins, at, issuer } of cases) {
        advertised.origins = origins;
        advertised.resource = `${at}/api/desktop`;
        advertised.issuer = `${issuer ?? loopback}/api/auth`;
        expect(yield* attempt(loopback), JSON.stringify({ origins, at, issuer })).toBe(refusal);
      }

      const asked = seen.length;
      yield* signInFromWelcome(electron, offLoopback, "self-host");
      const plain = yield* welcomeWindow(electron);
      expect(
        yield* driver("the form asks before plain http", () =>
          plain.locator(".popover .warning").innerText({ timeout: 30_000 }),
        ),
      ).toBe(
        "This server isn't encrypted. Your sign-in would travel in plain text on this network.",
      );
      expect(seen.length).toBe(asked);
      yield* driver("submit without confirming", () =>
        plain.getByRole("button", { name: "Sign in to this server", exact: true }).click(),
      );
      expect(
        yield* driver("the unchecked confirmation stops the form", () =>
          plain
            .getByRole("checkbox", { name: "Sign in without encryption" })
            .evaluate((input) => (input instanceof HTMLInputElement ? input.validity.valid : true)),
        ),
      ).toBe(false);
      expect(seen.length).toBe(asked);
      advertised.origins = { dashboard: loopback, api: loopback, auth: loopback };
      advertised.resource = `${loopback}/api/desktop`;
      advertised.issuer = `${loopback}/api/auth`;
      yield* driver("confirm signing in without encryption", () =>
        plain
          .getByRole("checkbox", { name: "Sign in without encryption" })
          .check()
          .then(() =>
            plain.getByRole("button", { name: "Sign in to this server", exact: true }).click(),
          ),
      );
      const confirmed = yield* welcomeWindow(electron);
      expect(
        yield* driver("the plain-text server is refused for its discovery", () =>
          confirmed
            .getByText("sends desktop sign-in to another address")
            .innerText({ timeout: 30_000 }),
        ),
      ).toBe(
        `0.0.0.0:${fake.port} sends desktop sign-in to another address, so Executor did not sign in.`,
      );
      expect(seen.filter((request) => !request.startsWith("GET /.well-known/"))).toEqual([]);
      expect(yield* externalOpens(electron)).toEqual([]);
      expect(yield* serverStarts(home.data)).toBe(0);
    }),
  ).pipe(Effect.provide(services)),
);
