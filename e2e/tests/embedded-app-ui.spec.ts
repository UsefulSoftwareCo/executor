/** Browser proof through a real self-host, including the existing browser-bound sign-in protocol. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import type { Page, Request, Route } from "playwright";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { waitForAppUrl } from "../support/app-pages.ts";
import { saveAndDeploy } from "../support/app-authoring.ts";
import { batchPath, batchedReads } from "../support/read-batches.ts";
import { Target } from "../support/platform.ts";

const files = [
  {
    path: "index.ts",
    content: `import { defineApp } from "apps"; export default defineApp({}, {});`,
  },
  {
    path: "ui/index.html",
    content: `<!doctype html><html><head><title>Embedded fixture</title><style>body{font:14px system-ui;margin:28px;color:#18181b}h1{font-size:24px;letter-spacing:-.02em}label{display:grid;gap:8px;max-width:360px}input{font:inherit;border:1px solid #d4d4d8;border-radius:6px;padding:8px}</style></head><body><main><h1>Embedded fixture screen</h1><label>Draft<input name="draft"></label></main></body></html>`,
  },
  appsManifest,
];

/** Location reads of one app, sent on their own or inside a dashboard read batch. */
const locationReads = (app: string, request: Request) => {
  const path = new URL(request.url()).pathname;
  if (path.endsWith(`/apps/${app}/ui`)) return 1;
  if (path !== batchPath || request.method() !== "POST") return 0;
  return batchedReads(request.postData()).filter(
    (read) => read.group === "appUi" && read.endpoint === "location" && read.params.app === app,
  ).length;
};

/** Hold an app's location read until released, whether it travels alone or in a batch. */
const holdLocation = (page: Page, organization: string, app: string) => {
  let release!: () => void;
  let requested!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const seen = new Promise<void>((resolve) => (requested = resolve));
  const direct = `**/api/organizations/${organization}/apps/${app}/ui`;
  const batch = `**${batchPath}`;
  const held: Array<Promise<void>> = [];
  const hold = (route: Route) => {
    requested();
    const continued = gate.then(() => route.continue());
    held.push(continued);
    return continued;
  };
  const batched = (route: Route) =>
    locationReads(app, route.request()) > 0 ? hold(route) : route.fallback();
  return Promise.all([page.route(direct, hold), page.route(batch, batched)]).then(() => ({
    requested: seen,
    // Held reads continue before their routes are removed.
    release: () => {
      release();
      return Promise.all(held).then(() =>
        Promise.all([page.unroute(direct, hold), page.unroute(batch, batched)]),
      );
    },
  }));
};

/** Count frames of `title` the page removes and app loading states it adds from now on. */
const watchFrame = (page: Page, title: string) =>
  page.evaluate((title) => {
    const seen = { removed: 0, loading: 0 };
    const has = (node: Node, selector: string) =>
      node instanceof Element && (node.matches(selector) || node.querySelector(selector) !== null);
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes)
          if (has(node, `iframe[title="${title}"]`)) seen.removed++;
        for (const node of record.addedNodes)
          if (has(node, '[aria-label="Loading app"]')) seen.loading++;
      }
    }).observe(document.body, { childList: true, subtree: true });
    Reflect.set(window, "__frameChanges", seen);
  }, title);
const frameChanges = (page: Page) =>
  page.evaluate(
    () => Reflect.get(window, "__frameChanges") as { removed: number; loading: number },
  );

layer(HostedLive, { excludeTestServices: true })("Embedded app screens", (it) => {
  it.effect(scenarios.embeddedAppUi.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          target = yield* Target;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deploy = (name: string, ancestor?: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name,
              files:
                ancestor === undefined
                  ? files
                  : files.map((file) =>
                      file.path === "ui/index.html"
                        ? {
                            ...file,
                            content: file.content.replace(
                              "</main>",
                              `<iframe title="Foreign app frame" src="${ancestor}"></iframe></main>`,
                            ),
                          }
                        : file,
                    ),
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const app = yield* body(App, response);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
            );
            const url = yield* waitForAppUrl(actors.owner, `${prefix}/apps/${app.id}/ui`);
            expect(new URL(url).hostname).toBe(`a-${app.id.slice(4)}.fixture.localhost`);
            return { app, url };
          });
        const first = yield* deploy("Embedded fixture one");
        const second = yield* deploy("Embedded fixture two", first.url);
        const failing = yield* deploy("Embedded fixture failure");
        const unknownHost = `a-${crypto.randomUUID()}.fixture.localhost`;
        const unknownApp = yield* browser.use("Unknown opaque app hosts are refused", (page) =>
          page.context().request.get(first.url, { headers: { Host: unknownHost } }),
        );
        expect([403, 404]).toContain(unknownApp.status());
        yield* browser.login(actors.owner);
        // Cookies never enter retained network traces or screenshots.
        yield* browser.omitNetworkTrace;
        const detail = `/org/${actors.organization.slug}/apps/${first.app.id}`;
        let appListUiRequests = 0;
        yield* browser.use("App cards use their list payload for screen labels", (page) => {
          const countUiRequest = (request: Request) => {
            appListUiRequests += locationReads(first.app.id, request);
          };
          page.on("request", countUiRequest);
          return page
            .goto(`/org/${actors.organization.slug}/apps`)
            .then(() =>
              page
                .getByRole("link", { name: `Open ${first.app.name}`, exact: true })
                .getByText("App screen")
                .waitFor(),
            )
            .finally(() => page.off("request", countUiRequest));
        });
        expect(appListUiRequests).toBe(0);
        yield* browser.checkpoint("apps-list-with-screen");
        const firstLocation = yield* browser.use(
          "Hold app location while the detail tab renders",
          (page) =>
            holdLocation(page, actors.organization.id, first.app.id).then((hold) =>
              page
                .goto(detail)
                .then(() => hold.requested)
                .then(() => hold),
            ),
        );
        yield* Effect.addFinalizer(() =>
          browser
            .use("Release the first location hold", () => firstLocation.release())
            .pipe(Effect.orDie),
        );
        yield* browser.use("App is selected while its location is held", (page) => {
          const navigation = page.getByRole("navigation", { name: "App navigation" });
          return Promise.all([
            navigation.getByRole("link", { name: "App", exact: true }).getAttribute("aria-current"),
            navigation
              .getByRole("link", { name: "Overview", exact: true })
              .getAttribute("aria-current"),
          ]).then(([appView, overview]) => {
            expect(appView).toBe("page");
            expect(overview).toBeNull();
          });
        });
        yield* browser.use("Release the app location", () => firstLocation.release());
        yield* browser.use("The App frame completes sign-in while prewarmed", (page) =>
          page.waitForResponse(
            (response) =>
              new URL(response.url()).origin === first.url &&
              new URL(response.url()).pathname === "/_executor/auth/callback" &&
              response.status() === 302 &&
              response.request().frame() !== page.mainFrame(),
          ),
        );
        yield* browser.use("App stays selected after the location resolves", (page) => {
          const navigation = page.getByRole("navigation", { name: "App navigation" });
          return Promise.all([
            navigation.getByRole("link", { name: "App", exact: true }).getAttribute("aria-current"),
            navigation
              .getByRole("link", { name: "Overview", exact: true })
              .getAttribute("aria-current"),
          ]).then(([appView, overview]) => {
            expect(appView).toBe("page");
            expect(overview).toBeNull();
          });
        });
        yield* browser.checkpoint("embedded-app-default-app");
        yield* browser.use("The App link keeps the shown screen", (page) =>
          page
            .getByRole("navigation", { name: "App navigation" })
            .getByRole("link", { name: "App", exact: true })
            .click()
            .then(() =>
              page
                .frameLocator(`iframe[title="${first.app.name} app"]`)
                .getByRole("heading", { name: "Embedded fixture screen" })
                .waitFor(),
            ),
        );
        yield* browser.use("The host receives app readiness", (page) =>
          page.getByRole("status", { name: "Loading app" }).waitFor({ state: "hidden" }),
        );
        yield* browser.use("The opened App tab has the approved sandbox", (page) =>
          Promise.all([
            page
              .getByRole("navigation", { name: "App navigation" })
              .getByRole("link", { name: "App", exact: true })
              .getAttribute("aria-current"),
            page.locator("iframe").getAttribute("sandbox"),
            page.locator("iframe").getAttribute("allow"),
            page.locator("iframe").getAttribute("referrerpolicy"),
            page.getByRole("link", { name: "Open in new tab" }).getAttribute("href"),
          ]).then(([appView, sandbox, allow, referrer, href]) => {
            expect(page.url()).toBe(`${target.metadata.origin}${detail}?view=app`);
            expect(appView).toBe("page");
            expect(sandbox).toBe(
              "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads",
            );
            expect(allow).toBe("clipboard-write");
            expect(referrer).toBe("no-referrer");
            expect(href).toBe(first.url);
          }),
        );
        yield* browser.checkpoint("embedded-app-tab");
        yield* browser.use("Switching tabs keeps the ready frame mounted", (page) => {
          const iframe = page.locator(`iframe[title="${first.app.name} app"]`);
          let documentLoads = 0;
          const countLoad = (request: { resourceType(): string; url(): string }) => {
            const url = new URL(request.url());
            if (
              request.resourceType() === "document" &&
              url.origin === new URL(first.url).origin &&
              url.pathname === "/"
            )
              documentLoads++;
          };
          page.on("request", countLoad);
          const before = documentLoads;
          const navigation = page.getByRole("navigation", { name: "App navigation" });
          return iframe.elementHandle().then((original) =>
            navigation
              .getByRole("link", { name: "App", exact: true })
              .click()
              .then(() => navigation.getByRole("link", { name: "Overview", exact: true }).click())
              .then(() => navigation.getByRole("link", { name: "App", exact: true }).click())
              .then(() =>
                Promise.all([
                  iframe.evaluate((element, previous) => element === previous, original),
                  page.getByRole("status", { name: "Loading app" }).count(),
                ]),
              )
              .then(([sameFrame, loading]) => {
                expect(sameFrame).toBe(true);
                expect(documentLoads).toBe(before);
                expect(loading).toBe(0);
              })
              .finally(() => page.off("request", countLoad)),
          );
        });
        yield* browser.use("Watch the open App frame", (page) =>
          watchFrame(page, `${first.app.name} app`),
        );
        const original = yield* browser.use("Keep the open App frame", (page) =>
          page.locator(`iframe[title="${first.app.name} app"]`).elementHandle(),
        );
        const updated = yield* saveAndDeploy(actors.owner, `${prefix}/apps/${first.app.id}`, {
          files: files.map((file) =>
            file.path === "ui/index.html"
              ? {
                  ...file,
                  content: file.content.replace(
                    "Embedded fixture screen</h1>",
                    "Embedded fixture screen updated</h1>",
                  ),
                }
              : file,
          ),
        });
        expect(updated.status, JSON.stringify(updated.body)).toBe(200);
        const { app: activated } = yield* body(
          Schema.Struct({ app: Schema.Struct({ activeVersion: Schema.String }) }),
          updated,
        );
        yield* browser.use("The frame's own watch script loads the new version", (page) =>
          page
            .frameLocator(`iframe[title="${first.app.name} app"]`)
            .getByRole("heading", { name: "Embedded fixture screen updated" })
            .waitFor({ timeout: 20_000 }),
        );
        yield* browser.use("The dashboard reads the activated version", (page) => {
          // A returning tab reads the app and its location again; the activated version then reads
          // the location once more. Chrome does not always keep streamed batch bodies, so either
          // signal shows the dashboard has the new version.
          const appRead = page.waitForResponse((response) => {
            const url = new URL(response.url());
            return url.origin === target.metadata.origin &&
              (url.pathname === batchPath || url.pathname.endsWith(`/apps/${first.app.id}`))
              ? response.text().then(
                  (text) => text.includes(activated.activeVersion),
                  () => false,
                )
              : false;
          });
          let reads = 0;
          let reread!: () => void;
          const reread2 = new Promise<void>((resolve) => (reread = resolve));
          const countReads = (request: Request) => {
            reads += locationReads(first.app.id, request);
            if (reads >= 2) reread();
          };
          page.on("request", countReads);
          return page
            .evaluate(() =>
              document.dispatchEvent(new Event("visibilitychange", { bubbles: true })),
            )
            .then(() => Promise.race([appRead, reread2]))
            .finally(() => page.off("request", countReads))
            .then(() =>
              page.evaluate(
                () =>
                  new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)),
                  ),
              ),
            );
        });
        yield* browser.use("Activation keeps the mounted frame without a loading state", (page) =>
          Promise.all([
            frameChanges(page),
            page
              .locator(`iframe[title="${first.app.name} app"]`)
              .evaluate((element, previous) => element === previous, original),
            page.getByRole("status", { name: "Loading app" }).count(),
          ]).then(([changes, sameFrame, loading]) => {
            expect(changes).toEqual({ removed: 0, loading: 0 });
            expect(sameFrame).toBe(true);
            expect(loading).toBe(0);
          }),
        );
        yield* browser.checkpoint("embedded-app-activated");
        yield* browser.use("Open in new tab still opens the canonical app URL", (page) => {
          const pagePromise = page.context().waitForEvent("page");
          const url = new URL(first.url).href;
          return Promise.all([
            pagePromise,
            page.getByRole("link", { name: "Open in new tab" }).click(),
          ]).then(([opened]) =>
            opened
              .waitForURL(url)
              .then(() => opened.waitForLoadState())
              .then(() => {
                expect(new URL(opened.url()).href).toBe(url);
                return opened.close();
              }),
          );
        });
        yield* browser.use("App origins cannot read the dashboard DOM or cookies", (page) => {
          const frame = page.frames().find((frame) => frame.url().startsWith(first.url));
          expect(frame).toBeDefined();
          return Promise.all([
            frame!.evaluate(() => {
              try {
                void parent.document.body;
                return false;
              } catch {
                return true;
              }
            }),
            frame!.evaluate(() => document.cookie),
          ]).then(([blocked, cookies]) => {
            expect(blocked).toBe(true);
            expect(cookies).toBe("");
          });
        });
        yield* browser.use("Host-only Lax cookies and app-scoped tokens isolate sessions", (page) =>
          page
            .context()
            .cookies(first.url)
            .then((cookies) => {
              const session = cookies.find((cookie) => cookie.name === "executor_app");
              expect(
                session !== undefined &&
                  session.httpOnly &&
                  session.sameSite === "Lax" &&
                  session.domain === new URL(first.url).hostname,
              ).toBe(true);
              return page
                .context()
                .request.get(`${second.url}/`, {
                  headers: {
                    Cookie: `${session!.name}=${session!.value}`,
                    Accept: "application/json",
                  },
                })
                .then((response) => expect(response.status()).toBe(401));
            }),
        );
        yield* browser.use("The second app has no first-app cookie", (page) =>
          page
            .context()
            .cookies(second.url)
            .then((cookies) =>
              expect(cookies.some((cookie) => cookie.name === "executor_app")).toBe(false),
            ),
        );
        yield* browser.use("Only the dashboard may frame app documents", (page) =>
          page
            .context()
            .request.get(first.url)
            .then((response) =>
              expect(response.headers()["content-security-policy"]).toBe(
                `frame-ancestors ${target.metadata.origin}`,
              ),
            ),
        );
        yield* browser.use("Only app-auth allows same-origin framing", (page) =>
          page
            .context()
            .request.get(`${target.metadata.origin}/app-auth`)
            .then((response) => {
              expect(response.headers()["content-security-policy"]).toBe("frame-ancestors 'self'");
              expect(response.headers()["x-frame-options"]).toBe("SAMEORIGIN");
            }),
        );
        yield* browser.use("Other dashboard pages refuse all ancestors", (page) =>
          page
            .context()
            .request.get(`${target.metadata.origin}/`)
            .then((response) =>
              expect(response.headers()["content-security-policy"]).toBe("frame-ancestors 'none'"),
            ),
        );
        // Hold both the location read and the app document, so tab switches land mid-load.
        let releaseDocument!: () => void;
        const documentHeld = new Promise<void>((resolve) => (releaseDocument = resolve));
        const heldDocuments: Array<Promise<void>> = [];
        const holdDocument = (route: Route) => {
          const continued = documentHeld.then(() => route.continue());
          heldDocuments.push(continued);
          return continued;
        };
        yield* Effect.addFinalizer(() =>
          browser
            .use("Release the app document hold", (page) => {
              releaseDocument();
              return Promise.all(heldDocuments).then(() =>
                page.unroute(`${second.url}/`, holdDocument),
              );
            })
            .pipe(Effect.orDie),
        );
        let secondLocationReads = 0;
        const countSecondLocation = (request: Request) => {
          secondLocationReads += locationReads(second.app.id, request);
        };
        const secondLocation = yield* browser.use("Open the second app's own frame", (page) =>
          page
            .route(`${second.url}/`, holdDocument)
            .then(() => holdLocation(page, actors.organization.id, second.app.id))
            .then((hold) => {
              page.on("request", countSecondLocation);
              return page
                .goto(`/org/${actors.organization.slug}/apps/${second.app.id}?view=app`)
                .then(() => hold.requested)
                .then(() => hold);
            }),
        );
        const switchTabs = (page: Page) => {
          const navigation = page.getByRole("navigation", { name: "App navigation" });
          const loading = page.getByRole("status", { name: "Loading app" });
          return loading
            .waitFor()
            .then(() => navigation.getByRole("link", { name: "Overview", exact: true }).click())
            .then(() => loading.waitFor({ state: "hidden" }))
            .then(() => navigation.getByRole("link", { name: "App", exact: true }).click())
            .then(() => loading.waitFor());
        };
        yield* Effect.addFinalizer(() =>
          browser
            .use("Release the second location hold", () => secondLocation.release())
            .pipe(Effect.orDie),
        );
        yield* browser.use("Switching tabs while the location loads keeps it pending", switchTabs);
        yield* browser.use("Release the second app's location", () => secondLocation.release());
        const secondFrame = yield* browser.use("The second app's frame mounts", (page) =>
          page.locator(`iframe[title="${second.app.name} app"]`).elementHandle(),
        );
        yield* browser.use("Switching tabs while the frame loads keeps it pending", switchTabs);
        yield* browser.use("Release the second app's document", (page) => {
          releaseDocument();
          return Promise.all(heldDocuments).then(() =>
            page.unroute(`${second.url}/`, holdDocument),
          );
        });
        yield* browser.use("The second app has its own screen", (page) =>
          page
            .frameLocator("iframe")
            .getByRole("heading", { name: "Embedded fixture screen" })
            .waitFor(),
        );
        yield* browser.use("Mid-load tab switches kept one location read and one frame", (page) =>
          Promise.all([
            page
              .locator(`iframe[title="${second.app.name} app"]`)
              .evaluate((element, previous) => element === previous, secondFrame),
            page.getByRole("status", { name: "Loading app" }).waitFor({ state: "hidden" }),
          ]).then(([sameFrame]) => {
            page.off("request", countSecondLocation);
            expect(sameFrame).toBe(true);
            expect(secondLocationReads).toBe(1);
          }),
        );
        yield* browser.use("The second app cannot fetch the first app's session", (page) => {
          const frame = page.frames().find((frame) => frame.url().startsWith(second.url));
          expect(frame).toBeDefined();
          return Promise.all([
            page.waitForRequest((request) => request.url() === `${first.url}/`),
            frame!
              .evaluate(
                (url) =>
                  fetch(url, { credentials: "include" }).then(
                    () => false,
                    () => true,
                  ),
                first.url,
              )
              .then((blocked) => expect(blocked).toBe(true)),
          ]);
        });
        yield* browser.use(
          "The server refuses a second-app origin even with first-app cookies",
          (page) =>
            page
              .context()
              .request.get(first.url, { headers: { Origin: second.url } })
              .then((response) => expect(response.status()).toBe(403)),
        );
        yield* browser.checkpoint("second-app-isolated");
        const foreign = yield* browser.use("Open a foreign same-site origin", (page) =>
          page.context().newPage(),
        );
        yield* Effect.addFinalizer(() =>
          browser.use("Close the foreign page", () => foreign.close()).pipe(Effect.orDie),
        );
        const foreignOrigin = second.url;
        const foreignResult = yield* browser.use("Browser CSP refuses the foreign ancestor", () => {
          const refused = { csp: false, failures: [] as string[] };
          foreign.on("console", (message) => {
            if (message.text().includes("frame-ancestors")) refused.csp = true;
          });
          foreign.on("requestfailed", (request) => {
            if (request.resourceType() === "document")
              refused.failures.push(request.failure()?.errorText ?? "unknown");
          });
          return foreign.goto(foreignOrigin).then(() => ({
            ...refused,
            appCommitted: foreign.frames().some((frame) => frame.url().startsWith(first.url)),
          }));
        });
        expect(foreignResult).toEqual({
          csp: true,
          failures: ["net::ERR_BLOCKED_BY_RESPONSE"],
          appCommitted: false,
        });
        // Network failure and time are controlled at the browser boundary.
        // The held document fails before its route is removed, so it cannot load late.
        let failDocument!: () => void;
        const documentGate = new Promise<void>((resolve) => (failDocument = resolve));
        const failedDocuments: Array<Promise<void>> = [];
        const failLater = (route: Route) => {
          const failed = documentGate.then(() => route.abort("failed"));
          failedDocuments.push(failed);
          return failed;
        };
        yield* browser.use("Hold the next app document", (page) =>
          page.route(`${failing.url}/`, failLater),
        );
        yield* browser.use("Control the frame loading deadline", (page) => page.clock.install());
        const failingDetail = `/org/${actors.organization.slug}/apps/${failing.app.id}`;
        yield* browser.use("Open the failing frame", (page) =>
          page.goto(`${failingDetail}?view=app`),
        );
        yield* browser.use("The pending frame announces loading", (page) =>
          page.getByRole("status", { name: "Loading app" }).waitFor(),
        );
        yield* browser.use("Reach the loading deadline", (page) => page.clock.runFor(30001));
        yield* browser.use("The failed frame offers recovery", (page) =>
          page.getByRole("alert").filter({ hasText: "The app did not finish loading" }).waitFor(),
        );
        yield* browser.checkpoint("embedded-app-failed");
        yield* browser.use("Restore app documents", (page) => {
          failDocument();
          return Promise.all(failedDocuments).then(() =>
            page.unroute(`${failing.url}/`, failLater),
          );
        });
        yield* browser.use("Retry the app frame", (page) =>
          page.getByRole("button", { name: "Retry", exact: true }).click(),
        );
        yield* browser.use("Retry renders the real screen", (page) =>
          page
            .frameLocator("iframe")
            .getByRole("heading", { name: "Embedded fixture screen" })
            .waitFor(),
        );
        yield* browser.checkpoint("embedded-app-recovered");
        const renamed = yield* api.request(
          actors.owner,
          "PATCH",
          `${prefix}/apps/${first.app.id}/name`,
          { name: "Renamed embedded fixture" },
        );
        expect(renamed.status).toBe(200);
        expect(yield* waitForAppUrl(actors.owner, `${prefix}/apps/${first.app.id}/ui`)).toBe(
          first.url,
        );
        const toolResponse = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Tool only fixture",
          files: files.filter((file) => !file.path.startsWith("ui/")),
        });
        expect(toolResponse.status).toBe(200);
        const toolOnly = yield* body(App, toolResponse);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${toolOnly.id}`).pipe(Effect.orDie),
        );
        const toolLocation = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/apps/${toolOnly.id}/ui`,
        );
        expect(toolLocation.body).toEqual({
          status: "unavailable",
          embedded: true,
          reason: "no_ui",
          url: null,
        });
        yield* browser.use("Open an app whose deployed version has no UI", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${toolOnly.id}`),
        );
        yield* browser.use("The tool-only app keeps its overview", (page) =>
          page.getByRole("heading", { name: toolOnly.name }).waitFor(),
        );
        expect(
          yield* browser.use("Tool-only apps have no App tab or frame", (page) =>
            Promise.all([
              page
                .getByRole("navigation", { name: "App navigation" })
                .getByRole("link", { name: "App", exact: true })
                .count(),
              page.locator("iframe").count(),
            ]),
          ),
        ).toEqual([0, 0]);
        yield* browser.use("Opening App for a tool-only app explains it has no screen", (page) =>
          page
            .goto(`/org/${actors.organization.slug}/apps/${toolOnly.id}?view=app`)
            .then(() =>
              page.getByRole("status").filter({ hasText: "This app has no screen." }).waitFor(),
            ),
        );
        yield* browser.checkpoint("embedded-app-no-screen");
        const draftResponse = yield* api.request(actors.owner, "POST", `${prefix}/apps`, {
          name: "Undeployed screen fixture",
          files,
        });
        expect(draftResponse.status).toBe(200);
        const draft = yield* body(App, draftResponse);
        expect(draftResponse.body).toMatchObject({ activeVersion: null });
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${draft.id}`).pipe(Effect.orDie),
        );
        yield* browser.use("An undeployed app explains it has no screen", (page) =>
          page
            .goto(`/org/${actors.organization.slug}/apps/${draft.id}?view=app`)
            .then(() =>
              page.getByRole("status").filter({ hasText: "This app has no screen." }).waitFor(),
            ),
        );
        const adminAccess = yield* api.request(
          actors.admin,
          "GET",
          `${prefix}/apps/${first.app.id}/access`,
        );
        expect(adminAccess.body).toMatchObject({ canManage: true, canUse: false });
        yield* browser.login(actors.admin);
        let adminLocationReads = 0;
        yield* browser.use("Manage-only admins get no App tab or prewarm", (page) => {
          const count = (request: Request) => {
            adminLocationReads += locationReads(first.app.id, request);
          };
          page.on("request", count);
          return page
            .goto(`${detail}?view=app`)
            .then(() =>
              page
                .getByText("This app is not shared with you. You can manage its settings.")
                .waitFor(),
            )
            .then(() =>
              Promise.all([
                page
                  .getByRole("navigation", { name: "App navigation" })
                  .getByRole("link", { name: "App", exact: true })
                  .count(),
                page.locator("iframe").count(),
              ]),
            )
            .then((counts) => {
              expect(counts).toEqual([0, 0]);
              expect(adminLocationReads).toBe(0);
            })
            .finally(() => page.off("request", count));
        });
      }),
    ),
  );
});
