import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { Locator, Page } from "playwright";
import { Browser } from "./browser.ts";

const fakeDesktopHost = () => {
  const seed: {
    installed?: string[];
    holdFirstRead?: boolean;
    account?: unknown;
    menu?: Array<"settings" | null | "fail">;
  } = JSON.parse(sessionStorage.getItem("desktopHostSeed") ?? "{}");
  const calls: unknown[][] = [];
  const failing = new Set<string>();
  const fresh = () => ({
    menuBar: "prompt",
    shortcuts: "prompt",
    floating: "prompt",
    startAtLogin: "prompt",
    microphone: "prompt",
    camera: "prompt",
    systemAudio: "prompt",
    clipboardRead: "prompt",
    notifications: "unavailable",
  });
  const permissions = new Map<string, Record<string, string>>();
  const permissionsOf = (app: string) => {
    const current = permissions.get(app) ?? {
      menuBar: "prompt",
      shortcuts: "granted",
      floating: "denied",
      startAtLogin: "prompt",
      microphone: "granted",
      camera: "prompt",
      systemAudio: "prompt",
      clipboardRead: "denied",
      notifications: "unavailable",
    };
    permissions.set(app, current);
    return current;
  };
  const record = (app: string) => ({
    server: "e2e-server",
    app,
    name: "Installed app",
    installedAt: "2026-11-24T00:00:00.000Z",
  });
  const installed = new Map((seed.installed ?? []).map((app) => [app, record(app)]));
  let installs = 0;
  let heldRead: (() => void) | undefined;
  const read = <A>(kind: string, value: () => A): Promise<A> =>
    failing.has(kind)
      ? Promise.reject(new Error(`The fake desktop could not read ${kind}`))
      : Promise.resolve(value());
  Reflect.set(window, "desktopHostCalls", calls);
  Reflect.set(window, "desktopHostControl", {
    fail: (kind: string, on: boolean) => (on ? failing.add(kind) : failing.delete(kind)),
    releaseRead: () => heldRead?.(),
  });
  Reflect.set(
    window,
    "__executorDesktopHost",
    Object.freeze({
      version: 1,
      server: "e2e-server",
      installed: (app: string) => {
        calls.push(["installed", app]);
        if (seed.holdFirstRead === true && calls.filter(([m]) => m === "installed").length === 1)
          return new Promise<void>((resolve) => {
            heldRead = resolve;
          }).then(() => installed.get(app) ?? null);
        return read("installed", () => installed.get(app) ?? null);
      },
      install: (app: string) => {
        calls.push(["install", app]);
        installs += 1;
        if (installs === 1) return Promise.resolve(null);
        installed.set(app, record(app));
        permissions.set(app, fresh());
        return Promise.resolve(installed.get(app));
      },
      uninstall: (app: string) => {
        calls.push(["uninstall", app]);
        installed.delete(app);
        permissions.set(app, fresh());
        return Promise.resolve();
      },
      open: (app: string) => {
        calls.push(["open", app]);
        return Promise.resolve();
      },
      permissions: (app: string) => {
        calls.push(["permissions", app]);
        return read("permissions", () => ({ ...permissionsOf(app) }));
      },
      setPermission: (app: string, name: string, state: string) => {
        calls.push(["setPermission", app, name, state]);
        permissionsOf(app)[name] = state;
        return Promise.resolve(state);
      },
      ...(seed.account === undefined
        ? {}
        : {
            account: () => Promise.resolve(seed.account),
            watchAccount: () => () => undefined,
            openAccountMenu: (options: unknown) => {
              calls.push(["openAccountMenu", options]);
              const answer = seed.menu?.shift() ?? null;
              return answer === "fail"
                ? Promise.reject(new Error("The fake desktop could not show its menu"))
                : Promise.resolve(answer);
            },
          }),
    }),
  );
};

const seedDesktopHost = (
  page: Page,
  seed: { readonly installed: readonly string[]; readonly holdFirstRead: boolean },
) =>
  page.evaluate((value) => sessionStorage.setItem("desktopHostSeed", value), JSON.stringify(seed));
const control = (page: Page, kind: "installed" | "permissions", on: boolean) =>
  page.evaluate(([kind, on]) => Reflect.get(window, "desktopHostControl").fail(kind, on), [
    kind,
    on,
  ] as const);
const desktopSection = (page: Page) => page.getByRole("region", { name: "Desktop", exact: true });
const button = (page: Page | Locator, name: string) =>
  page.getByRole("button", { name, exact: true });

const openSettings = Effect.gen(function* () {
  const browser = yield* Browser;
  yield* browser.use("Open the app's settings", (page) =>
    page
      .getByRole("navigation", { name: "App navigation" })
      .getByRole("link", { name: "Settings", exact: true })
      .click()
      .then(() => page.getByRole("region", { name: "App name" }).waitFor()),
  );
});

const permissionChoices = (page: Page) =>
  Promise.all(
    ["Menu bar", "Keyboard shortcuts", "Float above other windows"].map((name) =>
      page.getByRole("combobox", { name: `${name} permission` }).innerText(),
    ),
  );
const waitForChoices = (page: Page, expected: readonly string[]) =>
  Promise.all(
    ["Menu bar", "Keyboard shortcuts", "Float above other windows"].map((name, index) =>
      page
        .getByRole("combobox", { name: `${name} permission` })
        .filter({ hasText: new RegExp(`^${expected[index]}$`, "u") })
        .waitFor(),
    ),
  );
const choose = (page: Page, permission: string, choice: string) =>
  page
    .getByRole("combobox", { name: `${permission} permission` })
    .click()
    .then(() => page.getByRole("option", { name: choice, exact: true }).click());

const userAgentOverride = () => {
  const value = sessionStorage.getItem("userAgentOverride");
  if (value === null) return;
  const device: { userAgent: string; platform: string | null; touch: number } = JSON.parse(value);
  Object.defineProperty(Navigator.prototype, "userAgent", {
    get: () => device.userAgent,
    configurable: true,
  });
  Object.defineProperty(Navigator.prototype, "maxTouchPoints", {
    get: () => device.touch,
    configurable: true,
  });
  Object.defineProperty(Navigator.prototype, "userAgentData", {
    get: () =>
      device.platform === null
        ? undefined
        : {
            platform: device.platform,
            mobile: false,
            getHighEntropyValues: () => Promise.resolve({ architecture: "arm" }),
          },
    configurable: true,
  });
};

const device = (userAgent: string, platform: string | null, touch = 0) =>
  JSON.stringify({ userAgent, platform, touch });
const userAgents = {
  mac: device(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "macOS",
  ),
  windows: device(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Windows",
  ),
  linux: device(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Linux",
  ),
  iPhone: device(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    null,
    5,
  ),
  iPad: device(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    null,
    5,
  ),
};

const downloadPage = "https://executor.sh/#install";

const installDialogOn = (page: Page, userAgent: string) =>
  page
    .evaluate((value) => sessionStorage.setItem("userAgentOverride", value), userAgent)
    .then(() => page.reload())
    .then(() => button(page, "Install as app").click())
    .then(() => {
      const dialog = page.getByRole("dialog");
      return Promise.all([
        dialog.getByRole("heading").innerText(),
        dialog.locator('[data-slot="dialog-description"]').innerText(),
        dialog
          .getByRole("link")
          .filter({ visible: true })
          .evaluateAll((links) =>
            links.map((link) => ({
              name: link.textContent ?? "",
              href: link.getAttribute("href") ?? "",
            })),
          ),
      ]);
    })
    .then(([title, description, links]) =>
      page.keyboard
        .press("Escape")
        .then(() => page.getByRole("dialog").waitFor({ state: "detached" }))
        .then(() => ({ title, description, links })),
    );

const desktopReleases = "https://api.github.com/repos/UsefulSoftwareCo/executor/releases*";

export const desktopHostAbsent = (
  path: string,
  app: { readonly id: string; readonly name: string; readonly organization?: string },
) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.use("Let the scenario choose the browser's user agent", (page) =>
      page.context().addInitScript(userAgentOverride),
    );
    yield* browser.use("Answer the desktop release list with no release", (page) =>
      page.context().route(desktopReleases, (route) =>
        route.fulfill({
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: "[]",
        }),
      ),
    );
    yield* browser.use("Open the app's page in a browser", (page) => page.goto(path));
    yield* browser.use("The browser Open app link and install action render", (page) =>
      Promise.all([
        page.getByRole("link", { name: "Open app", exact: true }).waitFor(),
        button(page, "Install as app").waitFor(),
      ]),
    );
    expect(
      yield* browser.use("Only the browser's install action renders", (page) =>
        Promise.all([
          button(page, "Install as app").count(),
          page.getByRole("button", { name: /^(?:Open app|Uninstall)$/u }).count(),
        ]),
      ),
    ).toEqual([1, 0]);
    const origin = yield* browser.use("Read the dashboard's origin", (page) =>
      Promise.resolve(new URL(page.url()).origin),
    );
    const title = `Install ${app.name} as a desktop app`;
    const description =
      "In the Executor desktop app, it gets its own window and icon, and can use the menu bar and keyboard shortcuts.";
    const mac = yield* browser.use("Open the install dialog on a Mac", (page) =>
      installDialogOn(page, userAgents.mac),
    );
    const handoff = mac.links.find((link) => link.name === "Open in Executor")?.href ?? "";
    const handoffUrl = new URL(handoff);
    expect({
      link: `${handoffUrl.protocol}//${handoffUrl.host}`,
      ...Object.fromEntries(handoffUrl.searchParams),
    }).toEqual({
      link: "executor://install",
      server: origin,
      app: app.id,
      name: app.name,
      ...(app.organization === undefined
        ? {}
        : { org: app.organization, team: handoffUrl.searchParams.get("team") ?? "" }),
    });
    if (app.organization !== undefined) expect(handoffUrl.searchParams.get("team")).not.toBe("");
    expect(mac).toEqual({
      title,
      description,
      links: [
        { name: "Download for Mac", href: downloadPage },
        { name: "Open in Executor", href: handoff },
        { name: "Update Executor", href: downloadPage },
      ],
    });
    expect(
      yield* browser.use("Open the install dialog on Windows", (page) =>
        installDialogOn(page, userAgents.windows),
      ),
    ).toEqual({
      title,
      description,
      links: [
        { name: "Download for Windows", href: downloadPage },
        { name: "Open in Executor", href: handoff },
        { name: "Update Executor", href: downloadPage },
      ],
    });
    expect(
      yield* browser.use("Open the install dialog on Linux", (page) =>
        installDialogOn(page, userAgents.linux),
      ),
    ).toEqual({
      title,
      description:
        "The Executor desktop app is for Mac and Windows. There, this app gets its own window and icon, and can use the menu bar and keyboard shortcuts.",
      links: [
        { name: "Download for Mac", href: downloadPage },
        { name: "Download for Mac (Intel)", href: downloadPage },
        { name: "Download for Windows", href: downloadPage },
      ],
    });
    for (const [name, handheld] of [
      ["an iPhone", userAgents.iPhone],
      ["an iPad", userAgents.iPad],
    ] as const)
      expect(
        yield* browser.use(`Open the install dialog on ${name}`, (page) =>
          installDialogOn(page, handheld),
        ),
      ).toEqual({
        title,
        description: "Executor's desktop app is for Mac and Windows.",
        links: [],
      });
    yield* browser.use("Show the install dialog on a Mac", (page) =>
      page
        .evaluate((value) => sessionStorage.setItem("userAgentOverride", value), userAgents.mac)
        .then(() => page.reload())
        .then(() => button(page, "Install as app").click())
        .then(() => page.getByRole("dialog").waitFor())
        .then(() =>
          page.evaluate(() =>
            Promise.all(
              document
                .getAnimations()
                .filter((shown) => shown.effect?.getComputedTiming().endTime !== Infinity)
                .map((shown) => shown.finished.catch(() => shown)),
            ).then(() => undefined),
          ),
        ),
    );
    yield* browser.checkpoint("Without the desktop bridge the page offers the desktop app");
    yield* browser.use("Close the install dialog", (page) =>
      page.keyboard
        .press("Escape")
        .then(() => page.getByRole("dialog").waitFor({ state: "detached" })),
    );
    yield* openSettings;
    expect(
      yield* browser.use("No Desktop section renders", (page) => desktopSection(page).count()),
    ).toBe(0);
  });

export const desktopHostPresent = (path: string, app: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.use("Give the dashboard a desktop host bridge", (page) =>
      page.context().addInitScript(fakeDesktopHost),
    );
    yield* browser.use("Hold the desktop's first answer for an installed app", (page) =>
      seedDesktopHost(page, { installed: [app], holdFirstRead: true }),
    );
    yield* browser.use("Open the app's page in the desktop", (page) =>
      page
        .goto(path)
        .then(() =>
          page.getByRole("status", { name: "Checking the desktop app", exact: true }).waitFor(),
        ),
    );
    yield* browser.checkpoint("While the desktop has not answered the actions are reserved");
    expect(
      yield* browser.use("No action renders before the desktop answers", (page) =>
        Promise.all([
          page.getByRole("link", { name: "Open app", exact: true }).count(),
          page.getByRole("button", { name: /^(?:Open app|Install as app|Uninstall)$/u }).count(),
        ]),
      ),
    ).toEqual([0, 0]);
    yield* browser.use("The desktop answers that the app is installed", (page) =>
      page
        .evaluate(() => Reflect.get(window, "desktopHostControl").releaseRead())
        .then(() => button(page, "Uninstall").waitFor()),
    );
    expect(
      yield* browser.use("The installed app's actions replace the browser link", (page) =>
        Promise.all([
          page.getByRole("link", { name: "Open app", exact: true }).count(),
          button(page, "Open app").count(),
          button(page, "Install as app").count(),
        ]),
      ),
    ).toEqual([0, 1, 0]);
    yield* browser.use("Open the installed app", (page) =>
      button(page, "Open app")
        .click()
        .then(() =>
          page.waitForFunction(() =>
            Reflect.get(window, "desktopHostCalls").some((call: unknown[]) => call[0] === "open"),
          ),
        ),
    );

    yield* openSettings;
    yield* browser.use("The Desktop section lists the installed app's permissions", (page) =>
      waitForChoices(page, ["Ask next time", "Allow", "Don't allow"]),
    );
    expect(
      yield* browser.use("The Desktop section lists the capture permissions", (page) =>
        Promise.all(
          ["Start at login", "Microphone", "Camera", "System audio", "Read clipboard"].map((name) =>
            page.getByRole("combobox", { name: `${name} permission` }).innerText(),
          ),
        ),
      ),
    ).toEqual(["Ask next time", "Allow", "Ask next time", "Ask next time", "Don't allow"]);
    expect(
      yield* browser.use("Notifications are not available on this computer", (page) =>
        desktopSection(page).getByText("Not available on this computer").count(),
      ),
    ).toBe(1);
    yield* browser.use("Uninstall the app with Settings open", (page) =>
      button(page, "Uninstall")
        .click()
        .then(() => button(page, "Install as app").waitFor()),
    );
    yield* browser.use("The Desktop section shows the permissions the desktop reset", (page) =>
      waitForChoices(page, ["Ask next time", "Ask next time", "Ask next time"]),
    );
    expect(
      yield* browser.use("The uninstalled app offers the browser link again", (page) =>
        page.getByRole("link", { name: "Open app", exact: true }).count(),
      ),
    ).toBe(1);
    yield* browser.use("Allow the menu bar", (page) =>
      choose(page, "Menu bar", "Allow").then(() =>
        waitForChoices(page, ["Allow", "Ask next time", "Ask next time"]),
      ),
    );
    yield* browser.use("Cancel the desktop's install dialog", (page) =>
      button(page, "Install as app")
        .click()
        .then(() =>
          page.waitForFunction(
            () =>
              Reflect.get(window, "desktopHostCalls").filter(
                (call: unknown[]) => call[0] === "install",
              ).length === 1,
          ),
        )
        .then(() => button(page, "Install as app").waitFor()),
    );
    yield* browser.use("Install the app with Settings open", (page) =>
      button(page, "Install as app")
        .click()
        .then(() => button(page, "Uninstall").waitFor()),
    );
    expect(
      yield* browser.use("The desktop installs without the browser's dialog", (page) =>
        Promise.all([
          page.getByRole("dialog").count(),
          page.getByRole("link", { name: "Open in Executor" }).count(),
        ]),
      ),
    ).toEqual([0, 0]);
    yield* browser.use("The Desktop section shows the new install's permissions", (page) =>
      waitForChoices(page, ["Ask next time", "Ask next time", "Ask next time"]),
    );
    yield* browser.checkpoint("Install and uninstall refresh the open Desktop section");

    yield* browser.use("Stop the desktop answering permission reads", (page) =>
      control(page, "permissions", true),
    );
    yield* browser.use("Allow floating, whose follow-up read fails", (page) =>
      choose(page, "Float above other windows", "Allow").then(() =>
        desktopSection(page)
          .getByRole("status")
          .filter({ hasText: "Could not read this app from the Executor desktop app." })
          .waitFor(),
      ),
    );
    yield* browser.checkpoint("A failed permission read keeps the controls beside its error");
    expect(
      yield* browser.use("The confirmed permissions stay mounted", (page) =>
        permissionChoices(page),
      ),
    ).toEqual(["Ask next time", "Ask next time", "Allow"]);
    yield* browser.use("Check the permissions again once the desktop answers", (page) =>
      control(page, "permissions", false)
        .then(() => button(desktopSection(page), "Check again").click())
        .then(() => desktopSection(page).getByRole("status").waitFor({ state: "detached" })),
    );

    yield* browser.use("Stop the desktop answering install reads", (page) =>
      control(page, "installed", true),
    );
    yield* browser.use("Uninstall the app, whose follow-up read fails", (page) =>
      button(page, "Uninstall")
        .click()
        .then(() => button(page, "Install as app").waitFor())
        .then(() =>
          page
            .getByRole("status")
            .filter({ hasText: "Could not read this app from the Executor desktop app." })
            .first()
            .waitFor(),
        ),
    );
    yield* browser.checkpoint("A failed install read keeps the confirmed actions beside its error");
    expect(
      yield* browser.use("The confirmed actions stay with a way to check again", (page) =>
        Promise.all([
          page.getByRole("link", { name: "Open app", exact: true }).count(),
          button(page, "Install as app").count(),
          button(page, "Check again").count(),
        ]),
      ),
    ).toEqual([1, 1, 1]);
    yield* browser.use("Check the install again once the desktop answers", (page) =>
      control(page, "installed", false)
        .then(() => button(page, "Check again").click())
        .then(() => button(page, "Check again").waitFor({ state: "detached" })),
    );
    expect(
      yield* browser.use("The install actions remain", (page) =>
        button(page, "Install as app").count(),
      ),
    ).toBe(1);

    const calls = yield* browser.use("Read the desktop host calls", (page) =>
      page.evaluate((): unknown[][] => Reflect.get(window, "desktopHostCalls")),
    );
    expect(calls.every((call) => call[1] === app)).toBe(true);
    expect(calls.filter(([method]) => method !== "installed" && method !== "permissions")).toEqual([
      ["open", app],
      ["uninstall", app],
      ["setPermission", app, "menuBar", "granted"],
      ["install", app],
      ["install", app],
      ["setPermission", app, "floating", "granted"],
      ["uninstall", app],
    ]);
  });

export const desktopInstalledWithoutPage = (path: string, app: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.use("Mark an app without a page as installed in the desktop", (page) =>
      seedDesktopHost(page, { installed: [app], holdFirstRead: false }),
    );
    yield* browser.use("Open the settings of the installed app without a page", (page) =>
      page.goto(path).then(() => button(page, "Uninstall").waitFor()),
    );
    yield* browser.use("Its Desktop section still manages permissions", (page) =>
      waitForChoices(page, ["Ask next time", "Allow", "Don't allow"]),
    );
    yield* browser.checkpoint("An installed app without a page keeps its desktop management");
    expect(
      yield* browser.use("Open app is disabled and no browser link or install renders", (page) =>
        Promise.all([
          button(page, "Open app").isDisabled(),
          page.getByRole("link", { name: "Open app", exact: true }).count(),
          button(page, "Install as app").count(),
        ]),
      ),
    ).toEqual([true, 0, 0]);
    yield* browser.use("Uninstall the app without a page", (page) =>
      button(page, "Uninstall")
        .click()
        .then(() => button(page, "Uninstall").waitFor({ state: "detached" }))
        .then(() => desktopSection(page).waitFor({ state: "detached" })),
    );
    expect(
      yield* browser.use("An uninstalled app without a page offers no desktop action", (page) =>
        Promise.all([
          page.getByRole("button", { name: /^(?:Open app|Install as app|Uninstall)$/u }).count(),
          desktopSection(page).count(),
        ]),
      ),
    ).toEqual([0, 0]);
  });

const menuCalls = (page: Page) =>
  page.evaluate(() =>
    (Reflect.get(window, "desktopHostCalls") as unknown[][])
      .filter(([method]) => method === "openAccountMenu")
      .map(([, options]) => options),
  );

export const desktopAccountMenu = (path: string, kind: "hosted" | "local") =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const title = kind === "hosted" ? "Acme" : "This computer";
    yield* browser.use("Give the dashboard a desktop host bridge with its own account", (page) =>
      page.context().addInitScript(fakeDesktopHost),
    );
    yield* browser.use("Seed the dashboard's own account", (page) =>
      page.evaluate(
        (value) => sessionStorage.setItem("desktopHostSeed", value),
        JSON.stringify({
          installed: [],
          holdFirstRead: false,
          account:
            kind === "hosted"
              ? {
                  id: "e2e-server",
                  kind: "cloud",
                  team: "Acme",
                  host: "executor.sh",
                  state: "signed-in",
                }
              : {
                  id: "e2e-server",
                  kind: "local",
                  team: "This computer",
                  host: "local",
                  state: "signed-in",
                },
          menu: kind === "hosted" ? ["fail", "settings"] : [null],
        }),
      ),
    );
    yield* browser.use("Open the dashboard in the desktop", (page) => page.goto(path));
    const button = (page: Page) =>
      page.getByRole("button", { name: `Account: ${title}`, exact: true });
    const shown = yield* browser.use("Read the account button", (page) =>
      Promise.all([
        button(page).innerText(),
        button(page).getAttribute("aria-haspopup"),
        page.getByRole("menu").count(),
      ]),
    );
    expect(shown[0].split("\n")).toContain(title);
    expect(shown.slice(1)).toEqual(["menu", 0]);
    const opened = (page: Page) =>
      button(page)
        .evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        })
        .then((rect) =>
          button(page)
            .click()
            .then(() => rect),
        );
    const box = yield* browser.use("Open the desktop's account menu", opened);
    if (kind === "local") {
      expect(yield* browser.use("Read the desktop calls", menuCalls)).toEqual([
        { anchor: box, settings: false },
      ]);
      yield* browser.checkpoint("The local dashboard asks the desktop for its account menu");
      return;
    }
    yield* browser.use("The dashboard explains a menu the desktop could not show", (page) =>
      page
        .getByRole("alert")
        .filter({ hasText: "The Executor desktop app could not change this account. Try again." })
        .waitFor(),
    );
    const again = yield* browser.use(
      "Open the menu again and choose Account settings there",
      opened,
    );
    yield* browser.use("The dashboard opens its account settings", (page) =>
      page.waitForURL((url) => url.pathname === "/account/profile"),
    );
    const calls = yield* browser.use("Read the desktop calls", menuCalls);
    expect(calls).toEqual([
      { anchor: box, settings: true },
      { anchor: again, settings: true },
    ]);
    yield* browser.checkpoint(
      "The hosted dashboard shows only its own account and opens settings the desktop menu chose",
    );
  });
