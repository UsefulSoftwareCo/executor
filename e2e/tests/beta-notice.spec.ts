import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Beta notice", (it) => {
  it.effect(scenarios.betaNotice.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const actors = yield* Actors;

        yield* browser.use("Open the homepage", (page) => page.goto("/home"));
        expect(
          yield* browser.use("Check the preview starts closed", (page) =>
            page.locator("#early-preview-notice").evaluate((dialog) => dialog.hasAttribute("open")),
          ),
        ).toBe(false);
        expect(
          yield* browser.use("Read the homepage banner", (page) =>
            page.locator('aside[aria-label="Beta notice"]').innerText(),
          ),
        ).toContain("Executor v2 Beta");
        const homepageBanner = yield* browser.use("Measure the homepage banner", (page) =>
          page.locator('aside[aria-label="Beta notice"]').evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return {
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height,
              viewport: window.innerWidth,
            };
          }),
        );
        expect(homepageBanner.x).toBe(0);
        expect(homepageBanner.y).toBe(0);
        expect(homepageBanner.width).toBe(homepageBanner.viewport);
        expect(homepageBanner.height).toBeLessThanOrEqual(36);
        yield* browser.checkpoint("Homepage beta banner");
        yield* browser.use("Reopen the homepage preview", (page) =>
          page.getByRole("button", { name: "Learn more" }).click(),
        );
        expect(
          yield* browser.use("Read the homepage preview", (page) =>
            page.getByRole("dialog").innerText(),
          ),
        ).toContain("You may run into bugs or changes");
        yield* browser.checkpoint("Homepage beta banner and preview");
        yield* browser.use("Close the homepage preview", (page) =>
          page.getByRole("button", { name: "Got it", exact: true }).click(),
        );

        yield* browser.login(actors.owner);
        yield* browser.use("Open the cloud dashboard", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        expect(
          yield* browser.use("Read the dashboard banner", (page) =>
            page.locator('aside[aria-label="Beta notice"]').innerText(),
          ),
        ).toContain("Executor v2 Beta");
        const dashboardBanner = yield* browser.use("Measure the dashboard banner", (page) =>
          page.locator('aside[aria-label="Beta notice"]').evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return {
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height,
              viewport: window.innerWidth,
            };
          }),
        );
        expect(dashboardBanner.x).toBe(0);
        expect(dashboardBanner.y).toBe(0);
        expect(dashboardBanner.width).toBe(dashboardBanner.viewport);
        expect(dashboardBanner.height).toBeLessThanOrEqual(36);
        yield* browser.use("Wait for the dashboard content", (page) =>
          page.locator("[data-slot=skeleton]").first().waitFor({ state: "hidden" }),
        );
        yield* browser.checkpoint("Cloud dashboard beta banner");
        yield* browser.use("Open the dashboard preview", (page) =>
          page.getByRole("button", { name: "Learn more" }).click(),
        );
        expect(
          yield* browser.use("Read the dashboard preview", (page) =>
            page.getByRole("dialog").innerText(),
          ),
        ).toContain("You may run into bugs or changes");
        yield* browser.use("Wait for the dashboard preview animation", (page) =>
          page
            .getByRole("dialog")
            .evaluate((element) =>
              Promise.all(
                element.getAnimations({ subtree: true }).map((animation) => animation.finished),
              ).then(() => undefined),
            ),
        );
        yield* browser.checkpoint("Cloud dashboard beta banner and preview");
        yield* browser.use("Close the dashboard preview", (page) =>
          page.getByRole("button", { name: "Got it", exact: true }).click(),
        );
        yield* browser.use("Wait for the dashboard preview to close", (page) =>
          page.getByRole("dialog").waitFor({ state: "hidden" }),
        );
        yield* browser.use("Use a mobile viewport", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        const mobileBanner = yield* browser.use("Measure the mobile banner", (page) =>
          page.locator('aside[aria-label="Beta notice"]').evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return {
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height,
              viewport: window.innerWidth,
            };
          }),
        );
        expect(mobileBanner.x).toBe(0);
        expect(mobileBanner.y).toBe(0);
        expect(mobileBanner.width).toBe(mobileBanner.viewport);
        expect(mobileBanner.height).toBeLessThanOrEqual(36);
        yield* browser.checkpoint("Mobile dashboard beta banner");

        yield* browser.use("Dismiss the dashboard banner", (page) =>
          page.getByRole("button", { name: "Dismiss beta notice" }).click(),
        );
        expect(
          yield* browser.use("Check the dashboard banner is gone", (page) =>
            page.locator('aside[aria-label="Beta notice"]').count(),
          ),
        ).toBe(0);
        yield* browser.use("Reload the dashboard", (page) => page.reload());
        expect(
          yield* browser.use("Check dashboard dismissal survives reload", (page) =>
            page.locator('aside[aria-label="Beta notice"]').count(),
          ),
        ).toBe(0);
        yield* browser.use("Open the homepage after dashboard dismissal", (page) =>
          page.goto("/home"),
        );
        expect(
          yield* browser.use("Check dismissal carries to the homepage", (page) =>
            page.locator('aside[aria-label="Beta notice"]:visible').count(),
          ),
        ).toBe(0);

        yield* browser.use("Clear the dismissal", (page) =>
          page.evaluate(() => localStorage.removeItem("executor-beta-notice-dismissed")),
        );
        yield* browser.use("Reload the homepage with the banner restored", (page) => page.reload());
        yield* browser.use("Dismiss the homepage banner", (page) =>
          page.getByRole("button", { name: "Dismiss beta notice" }).click(),
        );
        yield* browser.use("Reload the homepage", (page) => page.reload());
        expect(
          yield* browser.use("Check homepage dismissal survives reload", (page) =>
            page.locator('aside[aria-label="Beta notice"]:visible').count(),
          ),
        ).toBe(0);
        yield* browser.use("Open the dashboard after homepage dismissal", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        expect(
          yield* browser.use("Check dismissal carries to the dashboard", (page) =>
            page.locator('aside[aria-label="Beta notice"]').count(),
          ),
        ).toBe(0);
      }),
    ),
  );
});
