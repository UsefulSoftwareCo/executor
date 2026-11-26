import { expect, layer } from "@effect/vitest";
import { Effect, Schedule } from "effect";
import { randomUUID } from "node:crypto";
import type { Page, Route } from "playwright";
import { scenarios } from "../test-plan.ts";
import {
  awaitSentry,
  awaitSentryWholeEnvironment,
  captureThroughPage,
  sentryEvents,
} from "../support/browser-observability.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import type { DriverFailed } from "../support/platform.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { batchPath } from "../support/read-batches.ts";

const unreachable = (page: Page) => page.getByRole("heading", { name: "Can’t reach Executor" });
const connectionNotice = (page: Page) =>
  page
    .getByRole("alert")
    .filter({ has: unreachable(page) })
    .first();
const noPrivateApps = (page: Page) =>
  page.getByRole("heading", { name: "No apps match these filters", exact: true });
const readBatch = (url: URL) => url.pathname === batchPath;
const heldPage = "/connection-scenario/held";
const noContentPage = "/connection-scenario/no-content";
const attachmentPage = "/connection-scenario/attachment";

layer(HostedLive, { excludeTestServices: true })("Browser connection failures", (it) => {
  it.effect(scenarios.browserConnectionFailures.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          actors = yield* Actors,
          telemetry = yield* Telemetry,
          evidence = yield* Evidence;
        yield* browser.login(actors.owner);
        yield* browser.use("Record every failure handed to the error reporter", (page) =>
          page.addInitScript(() => {
            const failures: Array<string> = [];
            Object.assign(window, { reportedFailures: failures });
            window.addEventListener("executor:operation-failed", (event) => {
              if (!(event instanceof CustomEvent)) return;
              failures.push(String(event.detail.error_type));
              const tab: unknown = JSON.parse(sessionStorage.getItem("reportedFailures") ?? "[]");
              sessionStorage.setItem(
                "reportedFailures",
                JSON.stringify([...(Array.isArray(tab) ? tab : []), event.detail.error_type]),
              );
            });
          }),
        );
        yield* browser.use("Open the organization's apps", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        yield* browser.use("Open filters", (page) =>
          page.getByRole("button", { name: "Filters", exact: true }).click(),
        );
        yield* browser.use("Open group selection", (page) =>
          page.getByRole("combobox", { name: "Filter apps by group" }).click(),
        );
        yield* browser.use("Choose private apps", (page) =>
          page.getByRole("option", { name: "Private apps", exact: true }).click(),
        );
        yield* browser.use("The group menu has closed", (page) =>
          page.getByRole("listbox").waitFor({ state: "hidden" }),
        );
        yield* browser.use("Close the filters", (page) => page.keyboard.press("Escape"));
        yield* browser.use("The filters have closed", (page) =>
          page.getByRole("dialog", { name: "App filters" }).waitFor({ state: "hidden" }),
        );
        yield* browser.use("The organization has no private apps", (page) =>
          noPrivateApps(page).waitFor(),
        );
        const marker = `connection scenario marker ${randomUUID()}`;
        yield* captureThroughPage(marker);
        const [markerEvent] = yield* awaitSentryWholeEnvironment(
          (event) => event.exception?.values.some((value) => value.value === marker) === true,
        );
        expect(typeof markerEvent?.tags?.page_id).toBe("string");
        const pageId = String(markerEvent?.tags?.page_id);
        const reportedFailures = browser.use(
          "Read the failures handed to the error reporter",
          (page) =>
            page.evaluate(() => {
              const failures: unknown = Reflect.get(window, "reportedFailures");
              if (!Array.isArray(failures)) throw new Error("The reporter is not being recorded");
              return failures.map(String);
            }),
        );
        const returnToTab = browser.use("Return to the tab, which reads its pages again", (page) =>
          page.evaluate(() =>
            document.dispatchEvent(new Event("visibilitychange", { bubbles: true })),
          ),
        );
        const explainsLostConnection = Effect.gen(function* () {
          yield* browser.use("The page explains that Executor cannot be reached", (page) =>
            unreachable(page).first().waitFor(),
          );
          const notice = yield* browser.use("Read the connection notice", (page) =>
            connectionNotice(page).innerText(),
          );
          expect(notice).toContain("Check your internet connection, then try again.");
          expect(notice).toContain("ConnectionFailed");
          expect(notice).not.toContain("unexpected error");
          expect(notice).not.toContain("Copy fix prompt");
        });
        const recovers = (screenshot: string) =>
          Effect.gen(function* () {
            yield* browser.use("Try again", (page) =>
              connectionNotice(page).getByRole("button", { name: "Try again" }).click(),
            );
            yield* browser.use("The connection notice clears", (page) =>
              unreachable(page).first().waitFor({ state: "detached", timeout: 15_000 }),
            );
            yield* browser.use("The answered app list is shown again", (page) =>
              noPrivateApps(page).waitFor(),
            );
            expect(
              yield* browser.use("No placeholder or loading cards remain", (page) =>
                page.getByRole("status", { name: /^(Loading apps|Installing app)$/ }).count(),
              ),
            ).toBe(0);
            const recovered = yield* browser.use("Capture the recovered page", (page) =>
              page.screenshot(),
            );
            yield* evidence.attach(screenshot, "image/png", recovered);
          });
        type Tags = Readonly<Record<string, string>>;
        const connectionSpans = (
          expected: string,
          delivered: (spans: ReadonlyArray<Tags>) => boolean,
        ) =>
          telemetry
            .search(
              "ui.api.transport",
              { page: pageId },
              { "error.type": "BrowserConnectionFailed", "executor.error.expected": expected },
            )
            .pipe(
              Effect.map((found) => found.data.map(({ span }): Tags => span.tags)),
              Effect.flatMap((spans) =>
                delivered(spans)
                  ? Effect.succeed(spans)
                  : Effect.fail(new Error("The lost connection's spans were not delivered")),
              ),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 30 }),
            );

        yield* browser.use("Lose the network", (page) => page.context().setOffline(true));
        yield* returnToTab;
        yield* explainsLostConnection;
        const shown = yield* browser.use("Capture the connection notice", (page) =>
          page.screenshot(),
        );
        yield* evidence.attach("connection-failed.png", "image/png", shown);
        expect(yield* reportedFailures).toEqual([]);
        yield* browser.use("Restore the network", (page) => page.context().setOffline(false));
        yield* recovers("connection-recovered.png");
        expect(yield* reportedFailures).toEqual([]);

        expect(
          yield* browser.use("The page is online and visible", (page) =>
            page.evaluate(() => [navigator.onLine, document.visibilityState]),
          ),
        ).toEqual([true, "visible"]);
        yield* browser.use("Reset the connection of every read batch", (page) =>
          page.route(readBatch, (route) => route.abort("connectionreset")),
        );
        yield* returnToTab;
        yield* explainsLostConnection;
        const reset = yield* browser.use("Capture the reset connection notice", (page) =>
          page.screenshot(),
        );
        yield* evidence.attach("connection-reset.png", "image/png", reset);
        expect(yield* reportedFailures).toContain("BrowserConnectionFailed");
        yield* awaitSentry(
          { page: pageId },
          (event) =>
            event.tags?.page_id === pageId && event.tags.error_type === "BrowserConnectionFailed",
        );
        yield* browser.use("Stop resetting read batches", (page) => page.unroute(readBatch));
        yield* recovers("connection-reset-recovered.png");

        const reportedBeforeLeaving = yield* reportedFailures;
        yield* browser.use("Reset the connection of every read batch", (page) =>
          page.route(readBatch, (route) => route.abort("connectionreset")),
        );
        yield* browser.use("Start leaving the page", (page) =>
          page.evaluate(() =>
            window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
          ),
        );
        yield* returnToTab;
        yield* explainsLostConnection;
        expect(yield* reportedFailures).toEqual(reportedBeforeLeaving);
        yield* browser.use("Come back to the page", (page) =>
          page.evaluate(() =>
            window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
          ),
        );
        yield* browser.use("Stop resetting read batches", (page) => page.unroute(readBatch));
        yield* recovers("connection-leaving-recovered.png");

        const offline = (tags: Tags) => tags["executor.browser.online"] === "false";
        const leaving = (tags: Tags) => tags["executor.page.leaving"] === "true";
        const expected = yield* connectionSpans(
          "true",
          (spans) => spans.some(offline) && spans.some(leaving),
        );
        expect(expected.every((tags) => offline(tags) !== leaving(tags))).toBe(true);
        const reported = yield* connectionSpans("false", (spans) => spans.length > 0);
        for (const tags of reported) {
          expect(tags["executor.browser.online"]).toBe("true");
          expect(tags["executor.page.visibility"]).toBe("visible");
          expect(tags["executor.page.leaving"]).toBe("false");
        }

        const reportsResetAfter = (
          move: Effect.Effect<unknown, DriverFailed>,
          screenshot: string,
        ) =>
          Effect.gen(function* () {
            const before = (yield* reportedFailures).length;
            yield* browser.use("Reset the connection of every read batch", (page) =>
              page.route(readBatch, (route) => route.abort("connectionreset")),
            );
            yield* move;
            yield* returnToTab;
            yield* explainsLostConnection;
            expect((yield* reportedFailures).slice(before)).toContain("BrowserConnectionFailed");
            yield* browser.use("Stop resetting read batches", (page) => page.unroute(readBatch));
            yield* recovers(screenshot);
          });
        yield* reportsResetAfter(
          Effect.gen(function* () {
            yield* browser.use("Hold the next page without an answer", (page) =>
              page.route(heldPage, () => undefined),
            );
            yield* browser.use("Start opening the page, then cancel it", (page) =>
              page.evaluate(
                (path) =>
                  new Promise<void>((resolve) => {
                    const navigation: unknown = Reflect.get(window, "navigation");
                    if (!(navigation instanceof EventTarget))
                      throw new Error("The browser has no Navigation API");
                    navigation.addEventListener("navigateerror", () => resolve(), { once: true });
                    location.assign(path);
                    setTimeout(() => window.stop(), 200);
                  }),
                heldPage,
              ),
            );
            yield* browser.use("Stop holding the page", (page) => page.unroute(heldPage));
          }),
          "connection-cancelled-navigation-recovered.png",
        );
        yield* reportsResetAfter(
          Effect.gen(function* () {
            yield* browser.use("Answer the next page with no content", (page) =>
              page.route(noContentPage, (route) => route.fulfill({ status: 204 })),
            );
            yield* browser.use("Open the page, which stays on this one", (page) =>
              Promise.all([
                page.waitForResponse((response) => response.url().endsWith(noContentPage)),
                page.evaluate((path) => location.assign(path), noContentPage),
              ]),
            );
            yield* browser.use("Stop answering the page", (page) => page.unroute(noContentPage));
          }),
          "connection-no-content-recovered.png",
        );
        yield* reportsResetAfter(
          Effect.gen(function* () {
            yield* browser.use("Answer the next page with an attachment", (page) =>
              page.route(attachmentPage, (route) =>
                route.fulfill({
                  status: 200,
                  headers: { "content-disposition": 'attachment; filename="report.txt"' },
                  body: "report",
                }),
              ),
            );
            const [download] = yield* browser.use("Open the page, which downloads it", (page) =>
              Promise.all([
                page.waitForEvent("download"),
                page.evaluate((path) => location.assign(path), attachmentPage),
              ]),
            );
            yield* browser.use("The attachment has downloaded", () => download.path());
            yield* browser.use("Stop answering the page", (page) => page.unroute(attachmentPage));
          }),
          "connection-attachment-recovered.png",
        );
        const reportsHeldReadResetAcross = (
          navigate: Effect.Effect<unknown, DriverFailed>,
          settle: Effect.Effect<unknown, DriverFailed>,
          screenshot: string,
        ) =>
          Effect.gen(function* () {
            const before = (yield* reportedFailures).length;
            const heldReads: Array<Route> = [];
            let readHeld = () => {};
            const firstReadHeld = new Promise<void>((resolve) => {
              readHeld = resolve;
            });
            yield* browser.use("Hold the read batches without an answer", (page) =>
              page.route(readBatch, (route) => {
                heldReads.push(route);
                readHeld();
              }),
            );
            yield* browser.use("Return to the tab, so a read is in flight", (page) =>
              Promise.all([
                firstReadHeld,
                page.evaluate(() =>
                  document.dispatchEvent(new Event("visibilitychange", { bubbles: true })),
                ),
              ]),
            );
            yield* navigate;
            const interruptedReads = heldReads.splice(0);
            expect(interruptedReads.length).toBeGreaterThan(0);
            yield* browser.use("Reset the reads that were in flight", () =>
              Promise.all(interruptedReads.map((route) => route.abort("connectionreset"))),
            );
            yield* explainsLostConnection;
            expect((yield* reportedFailures).slice(before)).toContain("BrowserConnectionFailed");
            yield* settle;
            yield* browser.use("Stop holding read batches", (page) => page.unroute(readBatch));
            yield* browser.use("Answer any read held since", () =>
              Promise.all(heldReads.map((route) => route.continue())),
            );
            yield* recovers(screenshot);
          });
        yield* reportsHeldReadResetAcross(
          browser.use("Start a navigation the page intercepts and keeps in progress", (page) =>
            page.evaluate(() => {
              const navigation: unknown = Reflect.get(window, "navigation");
              if (!(navigation instanceof EventTarget))
                throw new Error("The browser has no Navigation API");
              navigation.addEventListener(
                "navigate",
                (event) =>
                  Reflect.get(event, "intercept").call(event, {
                    handler: () =>
                      new Promise<void>((resolve) =>
                        Object.assign(window, { finishNavigation: resolve }),
                      ),
                  }),
                { once: true },
              );
              const navigate: unknown = Reflect.get(navigation, "navigate");
              if (typeof navigate !== "function") throw new Error("navigation.navigate is missing");
              navigate.call(navigation, location.href);
              if (Reflect.get(navigation, "transition") === null)
                throw new Error("The navigation was not intercepted");
            }),
          ),
          browser.use("Finish the navigation", (page) =>
            page.evaluate(() => {
              const finish: unknown = Reflect.get(window, "finishNavigation");
              if (typeof finish !== "function")
                throw new Error("The navigation is not in progress");
              finish();
            }),
          ),
          "connection-intercepted-navigation-recovered.png",
        );
        yield* reportsHeldReadResetAcross(
          browser.use("Navigate within the page and wait for the navigation to finish", (page) =>
            page.evaluate(() => {
              const navigation: unknown = Reflect.get(window, "navigation");
              if (!(navigation instanceof EventTarget))
                throw new Error("The browser has no Navigation API");
              navigation.addEventListener(
                "navigate",
                (event) =>
                  Reflect.get(event, "intercept").call(event, { handler: () => Promise.resolve() }),
                { once: true },
              );
              const navigate: unknown = Reflect.get(navigation, "navigate");
              if (typeof navigate !== "function") throw new Error("navigation.navigate is missing");
              const result: unknown = navigate.call(navigation, location.href);
              if (Reflect.get(navigation, "transition") === null)
                throw new Error("The navigation was not intercepted");
              const finished: unknown = Reflect.get(Object(result), "finished");
              if (!(finished instanceof Promise)) throw new Error("The navigation has no result");
              return finished.then(() => {
                if (Reflect.get(navigation, "transition") !== null)
                  throw new Error("The navigation is still in progress");
              });
            }),
          ),
          Effect.void,
          "connection-intercepted-navigation-finished-recovered.png",
        );

        const reportedAfterNavigations = yield* connectionSpans(
          "false",
          (spans) => spans.length > reported.length,
        );
        for (const tags of reportedAfterNavigations) {
          expect(tags["executor.browser.online"]).toBe("true");
          expect(tags["executor.page.visibility"]).toBe("visible");
          expect(tags["executor.page.leaving"]).toBe("false");
        }
        yield* evidence.json("connection-spans.json", {
          expected,
          reported: reportedAfterNavigations,
        });
        const fromPage = (yield* sentryEvents({ page: pageId })).filter(
          (event) => event.tags?.page_id === pageId && event.tags.error_type !== undefined,
        );
        expect(fromPage.length).toBeGreaterThan(0);
        expect(new Set(fromPage.map((event) => event.tags?.error_type))).toEqual(
          new Set(["BrowserConnectionFailed"]),
        );

        const tabReports = browser.use("Read the reports kept by the tab", (page) =>
          page.evaluate(() => sessionStorage.getItem("reportedFailures")),
        );
        const tabReportsBeforeLeaving = yield* tabReports;
        let holding = true;
        yield* browser.use("Hold the next read batch without an answer", (page) =>
          page.route(readBatch, (route) => {
            if (!holding) return route.continue();
            holding = false;
            return undefined;
          }),
        );
        yield* browser.use("Return to the tab, so a read is in flight", (page) =>
          Promise.all([
            page.waitForRequest((request) => readBatch(new URL(request.url()))),
            page.evaluate(() =>
              document.dispatchEvent(new Event("visibilitychange", { bubbles: true })),
            ),
          ]),
        );
        yield* browser.use("Leave the page while the read is in flight", (page) =>
          Promise.all([
            page.waitForEvent("load"),
            page.evaluate(() => location.assign(location.href)),
          ]),
        );
        yield* browser.use("Stop holding read batches", (page) => page.unroute(readBatch));
        expect(yield* tabReports).toEqual(tabReportsBeforeLeaving);
      }),
    ),
  );
});
