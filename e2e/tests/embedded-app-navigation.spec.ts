/** How the App tab appears, which tab opens, and what a prewarmed screen does behind other tabs. */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import type { Page, Request, Route } from "playwright";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { waitForAppUrl } from "../support/app-pages.ts";
import { openThroughBrowser } from "../support/in-app-navigation.ts";

const screenFiles = [
  {
    path: "index.ts",
    content: `import { defineApp } from "apps"; export default defineApp({}, {});`,
  },
  {
    path: "ui/index.html",
    content: `<!doctype html><html><head><title>Screen fixture</title></head><body><main><h1>Screen fixture</h1></main></body></html>`,
  },
  appsManifest,
];

/** Polls one query every second through the app client, and shows whether its host shows it. */
const pollingFiles = [
  {
    path: "index.ts",
    content: `import { defineApp, query, object, router } from "apps";
export const ping = query({ input: object({}) }, async () => "pong");
export default defineApp({}, { tools: router({ ping }) });`,
  },
  {
    path: "ui/index.html",
    content: `<!doctype html><html><head><title>Polling fixture</title></head><body><main><h1>Polling fixture</h1></main><script type="module" src="./main.ts"></script></body></html>`,
  },
  {
    path: "ui/main.ts",
    content: `import { string } from "apps";
import { createAppClient, queryReference } from "apps/client";
import type { ping } from "../index.ts";
const client = createAppClient();
const read = () => void client.query(queryReference<typeof ping>("ping"), {}, string());
read();
client.poll(read, 1000);
const show = (active: boolean) => (document.body.dataset.active = String(active));
show(client.isActive());
client.onActiveChange(show);`,
  },
  appsManifest,
];

const navigation = (page: Page) => page.getByRole("navigation", { name: "App navigation" });
const tab = (page: Page, name: string) => navigation(page).getByRole("link", { name, exact: true });
const selected = (page: Page) =>
  navigation(page)
    .locator('[aria-current="page"]')
    .allTextContents()
    .then((names) => names.map((name) => name.trim()));

/** Hold every read whose URL matches until released, whether batched or sent on its own. */
const hold = (page: Page, matches: (url: URL) => boolean) => {
  let release!: () => void;
  let requested!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const seen = new Promise<void>((resolve) => (requested = resolve));
  const held: Array<Promise<void>> = [];
  const route = (route: Route) => {
    requested();
    const continued = gate.then(() => route.continue());
    held.push(continued);
    return continued;
  };
  return page.route(matches, route).then(() => ({
    requested: seen,
    // Held reads continue before the route is removed.
    release: () => {
      release();
      return Promise.all(held).then(() => page.unroute(matches, route));
    },
  }));
};

const readOf = (app: string, suffix: string) => (url: URL) =>
  url.pathname.startsWith("/api/organizations/") && url.pathname.endsWith(`/apps/${app}${suffix}`);

layer(HostedLive, { excludeTestServices: true })("Embedded app navigation", (it) => {
  const deploy = (name: string, files: ReadonlyArray<{ path: string; content: string }>) =>
    Effect.gen(function* () {
      const api = yield* Api,
        actors = yield* Actors;
      const prefix = `/api/organizations/${actors.organization.id}`;
      const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
        name,
        files,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const app = yield* body(App, response);
      yield* Effect.addFinalizer(() =>
        api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
      );
      const hasUi = files.some((file) => file.path.startsWith("ui/"));
      const url = hasUi ? yield* waitForAppUrl(actors.owner, `${prefix}/apps/${app.id}/ui`) : "";
      return { app, url, detail: `/org/${actors.organization.slug}/apps/${app.id}` };
    });

  it.effect(scenarios.embeddedAppTabDirectEntry.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser;
        const screen = yield* deploy("Screen fixture", screenFiles);
        const toolOnly = yield* deploy(
          "Tool only fixture",
          screenFiles.filter((file) => !file.path.startsWith("ui/")),
        );
        yield* browser.login(actors.owner);
        // A document load renders the app's access on the server, so the page is opened in the
        // browser from a page that never read the Apps list.
        const access = yield* browser.use("Hold the app's access", (page) =>
          hold(page, readOf(screen.app.id, "/access")),
        );
        yield* Effect.addFinalizer(() =>
          browser.use("Release the access hold", () => access.release()).pipe(Effect.orDie),
        );
        yield* openThroughBrowser("Open the app without the Apps list", screen.detail);
        yield* browser.use("Wait for the app's access read", () => access.requested);
        // Until access answers, the tab keeps its place, nothing is selected and no frame loads.
        expect(
          yield* browser.use("The App tab holds its place", (page) =>
            Promise.all([
              navigation(page).getByRole("status", { name: "Checking for an app screen" }).count(),
              tab(page, "App").count(),
              selected(page),
              page.locator("iframe").count(),
            ]),
          ),
        ).toEqual([1, 0, [], 0]);
        yield* browser.checkpoint("app-tab-pending");
        yield* browser.use("Release the app's access", () => access.release());
        yield* browser.use("The App tab opens by default", (page) =>
          tab(page, "App")
            .and(page.locator('[aria-current="page"]'))
            .waitFor()
            .then(() =>
              page
                .frameLocator("iframe")
                .getByRole("heading", { name: "Screen fixture" })
                .waitFor(),
            ),
        );
        expect(
          yield* browser.use("Only App is selected, without a view in the URL", (page) =>
            selected(page).then((names) => ({ names, search: new URL(page.url()).search })),
          ),
        ).toEqual({ names: ["App"], search: "" });
        yield* browser.checkpoint("app-tab-default");

        yield* browser.use("Open the app's overview by URL", (page) =>
          page
            .goto(`${screen.detail}?view=overview`)
            .then(() => tab(page, "App").waitFor())
            .then(() =>
              // Roles skip a hidden frame's content, so the prewarmed heading is found by text.
              page
                .frameLocator("iframe")
                .locator("h1", { hasText: "Screen fixture" })
                .waitFor({ state: "attached" }),
            ),
        );
        expect(
          yield* browser.use("An explicit view stays selected once the screen loads", selected),
        ).toEqual(["Overview"]);

        // A tool-only app opens on Overview while its access is still unknown: its record alone
        // says it has no screen, so its tab never holds a place.
        const toolAccess = yield* browser.use("Hold the tool-only app's access", (page) =>
          hold(page, readOf(toolOnly.app.id, "/access")),
        );
        yield* Effect.addFinalizer(() =>
          browser.use("Release the tool-only hold", () => toolAccess.release()).pipe(Effect.orDie),
        );
        yield* openThroughBrowser("Open the tool-only app", toolOnly.detail);
        yield* browser.use("Wait for the tool-only app's access read", () => toolAccess.requested);
        yield* browser.use("The tool-only app opens on its overview", (page) =>
          tab(page, "Overview").and(page.locator('[aria-current="page"]')).waitFor(),
        );
        expect(
          yield* browser.use("A tool-only app never shows an App tab, pending or not", (page) =>
            Promise.all([
              tab(page, "App").count(),
              navigation(page).getByRole("status", { name: "Checking for an app screen" }).count(),
              page.locator("iframe").count(),
            ]),
          ),
        ).toEqual([0, 0, 0]);
        yield* browser.use("Release the tool-only app's access", () => toolAccess.release());
      }),
    ),
  );

  it.effect(scenarios.embeddedAppHiddenPolling.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser;
        const polling = yield* deploy("Polling fixture", pollingFiles);
        const appOrigin = new URL(polling.url).origin;
        const queries: Request[] = [];
        const count = (request: Request) => {
          const url = new URL(request.url());
          if (url.origin === appOrigin && url.pathname === "/_executor/api/query")
            queries.push(request);
        };
        yield* browser.login(actors.owner);
        const frame = (page: Page) => page.frameLocator(`iframe[title="${polling.app.name} app"]`);
        const shown = (page: Page, active: boolean) =>
          frame(page).locator(`body[data-active="${active}"]`).waitFor({ state: "attached" });
        // The frame loads behind Overview and hears that its host does not show it.
        yield* browser.use("Prewarm the screen behind Overview", (page) => {
          page.on("request", count);
          return page.goto(`${polling.detail}?view=overview`).then(() => shown(page, false));
        });
        // A poll that ignored its host would query three times in this window.
        const sent = (window: Parameters<typeof Effect.sleep>[0]) =>
          Effect.gen(function* () {
            const before = queries.length;
            yield* Effect.sleep(window);
            return queries.length - before;
          });
        expect(yield* sent("3500 millis"), "queries behind Overview").toBe(0);
        const original = yield* browser.use("Keep the prewarmed frame", (page) =>
          page.locator("iframe").elementHandle(),
        );
        yield* browser.use("Showing the screen refreshes it once, at once", (page) =>
          Promise.all([
            page.waitForRequest(
              (request) => {
                const url = new URL(request.url());
                return url.origin === appOrigin && url.pathname === "/_executor/api/query";
              },
              { timeout: 900 },
            ),
            tab(page, "App").click(),
          ]),
        );
        expect(yield* sent("2500 millis"), "queries while shown").toBeGreaterThanOrEqual(2);
        yield* browser.use("Hide the screen behind Accounts", (page) =>
          tab(page, "Accounts")
            .click()
            .then(() => shown(page, false)),
        );
        expect(yield* sent("3500 millis"), "queries behind Accounts").toBe(0);
        expect(
          yield* browser.use("The frame was never replaced", (page) =>
            page
              .locator(`iframe[title="${polling.app.name} app"]`)
              .evaluate((element, previous) => element === previous, original),
          ),
        ).toBe(true);
        yield* browser.use("Stop counting", (page) => {
          page.off("request", count);
          return Promise.resolve();
        });
      }),
    ),
  );
});
