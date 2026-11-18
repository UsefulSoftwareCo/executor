/**
 * The desktop app's update in the local dashboard's sidebar. The desktop window has no preload or
 * IPC bridge: its main process writes the update on the dashboard's document as the
 * `data-desktop-update` attribute's JSON and announces it with the `executor:desktop-update`
 * event, and intercepts the `executor-update:restart` navigation of the sidebar card's button to restart into
 * it. This scenario plays the desktop's part in a browser, so it checks the dashboard's side.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import type { Page } from "playwright";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

type Update = { readonly state: "downloading" | "ready"; readonly version: string } | null;

/** What the desktop's main process runs in the dashboard's page when its update changes. */
const showUpdate = (page: Page, update: Update) =>
  page.evaluate(
    (value) => {
      const root = document.documentElement;
      if (value === null) root.removeAttribute("data-desktop-update");
      else root.setAttribute("data-desktop-update", value);
      window.dispatchEvent(new Event("executor:desktop-update"));
    },
    update === null ? null : JSON.stringify(update),
  );

const restartLink = (page: Page) =>
  page.locator("aside.sidebar").getByRole("link", { name: "Restart Executor to install v2.4.0" });

const box = (page: Page, selector: string) => page.locator(selector).first().boundingBox();

/** The polite live region that says once that the update is ready. */
const announcement = (page: Page) =>
  Promise.all([
    page.locator('[role="status"][aria-live="polite"].desktop-update-announcement').count(),
    page.locator(".desktop-update-announcement").innerText(),
  ]).then(([count, text]) => ({ count, text }));

/**
 * The card's text that is cut off or runs out of the sidebar: each element whose content is wider
 * than its box, and whether the card itself reaches past the sidebar.
 */
const clipped = (page: Page) =>
  page.evaluate(() => {
    const card = document.querySelector("aside.sidebar .sidebar-update");
    const sidebar = document.querySelector("aside.sidebar");
    if (card === null || sidebar === null) return { missing: true };
    const cut = [card, ...card.querySelectorAll("*")]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => element.textContent ?? "");
    return {
      cut,
      outside: card.getBoundingClientRect().right > sidebar.getBoundingClientRect().right,
    };
  });

/** Where the navigation, the divider above the links, the links and the version row sit. */
const layout = (page: Page) =>
  Promise.all([
    box(page, "aside.sidebar nav"),
    box(page, "aside.sidebar .sidebar-utilities"),
    page.locator("aside.sidebar").getByRole("link", { name: "Docs" }).boundingBox(),
    box(page, "aside.sidebar .sidebar-build"),
  ]).then(([navigation, divider, docs, version]) => ({ navigation, divider, docs, version }));

/** The card's box, and whether it sits below the navigation and above the links' divider. */
const placement = (page: Page) =>
  Promise.all([
    box(page, "aside.sidebar .sidebar-update"),
    box(page, "aside.sidebar nav"),
    box(page, "aside.sidebar .sidebar-utilities"),
  ]).then(([card, navigation, divider]) => ({
    belowNavigation:
      card !== null && navigation !== null && card.y >= navigation.y + navigation.height,
    aboveDivider: card !== null && divider !== null && card.y + card.height <= divider.y,
  }));

layer(TestLive, { excludeTestServices: true })("Local desktop update", (it) => {
  it.effect(scenarios.localDesktopUpdate.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          target = yield* Target,
          session = yield* api.session();
        const { url } = yield* body(
          Schema.Struct({ url: Schema.String }),
          yield* session.send("POST", "/auth/pair", undefined, {
            authorization: `Bearer ${Redacted.value(target.apiKey)}`,
          }),
        );
        yield* browser.use("Pair the local dashboard", (page) =>
          page.setViewportSize({ width: 1180, height: 800 }).then(() => page.goto(url)),
        );
        yield* browser.use("Wait for apps", (page) =>
          page.getByRole("heading", { level: 1, name: /^Apps/ }).waitFor(),
        );

        // A dashboard the desktop has told about no update, as in any browser, shows no card and
        // keeps nothing in its place.
        expect(
          yield* browser.use("Check the sidebar has no update", (page) =>
            Promise.all([
              page.locator("aside.sidebar .sidebar-update").count(),
              page.locator("aside.sidebar .sidebar-notice").count(),
            ]),
          ),
        ).toEqual([0, 0]);
        const without = yield* browser.use("Measure the sidebar", layout);
        // The live region that says the update is ready is on the page already, and empty, so the
        // moment it fills is announced.
        expect(yield* browser.use("Read the empty announcement", announcement)).toEqual({
          count: 1,
          text: "",
        });

        // While the update downloads, a quieter card says so and offers nothing to press.
        yield* browser.use("Show a downloading update", (page) =>
          showUpdate(page, { state: "downloading", version: "2.4.0" }),
        );
        yield* browser.use("Wait for the download status", (page) =>
          page
            .locator("aside.sidebar")
            .getByRole("status")
            .filter({ hasText: "Downloading v2.4.0" })
            .waitFor(),
        );
        expect(
          yield* browser.use("Check there is no restart yet", (page) => restartLink(page).count()),
        ).toBe(0);
        expect(yield* browser.use("Read the announcement while downloading", announcement)).toEqual(
          { count: 1, text: "" },
        );
        expect(yield* browser.use("Place the downloading card", placement)).toEqual({
          belowNavigation: true,
          aboveDivider: true,
        });
        expect(yield* browser.use("Measure the sidebar while downloading", layout)).toEqual(
          without,
        );

        // Once it is ready, the card names the version, says Executor restarts to install it and
        // has one button that restarts into it. It sits above the links' divider and moves neither
        // the navigation nor the links.
        yield* browser.use("Show a ready update", (page) =>
          showUpdate(page, { state: "ready", version: "2.4.0" }),
        );
        yield* browser.use("Wait for the restart button", (page) => restartLink(page).waitFor());
        yield* browser.checkpoint("Update ready in the sidebar");
        expect(
          yield* browser.use("Read the card", (page) =>
            Promise.all([
              page
                .locator("aside.sidebar .sidebar-update")
                .innerText()
                .then((text) => text.split("\n").filter((line) => line.trim() !== "")),
              restartLink(page).getAttribute("href"),
              restartLink(page).innerText(),
              page.locator("aside.sidebar .sidebar-update a").count(),
            ]),
          ),
        ).toEqual([
          ["Update ready", "v2.4.0", "Executor restarts to install it.", "Restart to update"],
          "executor-update:restart",
          "Restart to update",
          1,
        ]);
        expect(yield* browser.use("Read the ready announcement", announcement)).toEqual({
          count: 1,
          text: "Update ready: Executor v2.4.0. Restart Executor to install it.",
        });
        expect(yield* browser.use("Place the ready card", placement)).toEqual({
          belowNavigation: true,
          aboveDivider: true,
        });
        expect(yield* browser.use("Measure the sidebar with the update", layout)).toEqual(without);

        // The keyboard reaches it, and pressing it follows the link the desktop intercepts. The
        // browser has no handler for that scheme, so the page records where it would go instead.
        const focused = (page: Page) =>
          page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null);
        yield* browser.use("Start from the page", (page) => page.locator("body").focus());
        let reached = false;
        for (let step = 0; step < 40 && !reached; step += 1) {
          yield* browser.use("Press Tab", (page) => page.keyboard.press("Tab"));
          reached =
            (yield* browser.use("Read the focused control", focused)) ===
            "Restart Executor to install v2.4.0";
        }
        expect(reached).toBe(true);
        yield* browser.use("Record where links go", (page) =>
          page.evaluate(() => {
            window.addEventListener("click", (event) => {
              const link = (event.target as Element).closest("a");
              if (link === null) return;
              event.preventDefault();
              document.documentElement.dataset.followed = link.getAttribute("href") ?? "";
            });
          }),
        );
        yield* browser.use("Press the restart link", (page) => page.keyboard.press("Enter"));
        expect(
          yield* browser.use("Read where it went", (page) =>
            page.evaluate(() => document.documentElement.dataset.followed),
          ),
        ).toBe("executor-update:restart");

        // A short window drops the card's description. With a navigation longer than the window, the
        // sidebar scrolls as it always has, and the card stays below the navigation.
        yield* browser.use("Shorten the window", (page) =>
          page.setViewportSize({ width: 1180, height: 540 }),
        );
        expect(
          yield* browser.use("Check the short card", (page) =>
            page.getByText("Executor restarts to install it.").isVisible(),
          ),
        ).toBe(false);
        yield* browser.use("Lengthen the navigation", (page) =>
          page.evaluate(() => {
            const navigation = document.querySelector("aside.sidebar nav");
            if (navigation === null) return;
            const items = [...navigation.querySelectorAll("a")];
            for (let round = 0; round < 3; round += 1)
              for (const item of items) navigation.append(item.cloneNode(true));
          }),
        );
        expect(
          yield* browser.use("Check the sidebar scrolls", (page) =>
            page.evaluate(() => {
              const sidebar = document.querySelector("aside.sidebar");
              return sidebar !== null && sidebar.scrollHeight > sidebar.clientHeight;
            }),
          ),
        ).toBe(true);
        expect(yield* browser.use("Place the card under a long navigation", placement)).toEqual({
          belowNavigation: true,
          aboveDivider: true,
        });
        yield* browser.use("Restore the navigation", (page) => page.reload());
        yield* browser.use("Wait for apps again", (page) =>
          page.getByRole("heading", { level: 1, name: /^Apps/ }).waitFor(),
        );
        // The Geist faces use `font-display: optional`, so a page load whose font arrives late
        // keeps the fallback face, and the reloaded page may set the links' text in another face
        // than the first. Clearing the update below must leave this page's sidebar as it was.
        const reloaded = yield* browser.use("Measure the reloaded sidebar", (page) =>
          page.setViewportSize({ width: 1180, height: 800 }).then(() => layout(page)),
        );
        yield* browser.use("Show the ready update again", (page) =>
          showUpdate(page, { state: "ready", version: "2.4.0" }),
        );

        // The collapsed rail keeps it above the divider as an icon button with the same name and
        // a tooltip.
        yield* browser.use("Collapse the rail", (page) =>
          page
            .setViewportSize({ width: 900, height: 800 })
            .then(() => page.getByRole("button", { name: "Expand sidebar" }).waitFor()),
        );
        expect(
          yield* browser.use("Check the collapsed restart button", (page) =>
            Promise.all([restartLink(page).isVisible(), restartLink(page).innerText()]),
          ),
        ).toEqual([true, ""]);
        expect(yield* browser.use("Place the collapsed card", placement)).toEqual({
          belowNavigation: true,
          aboveDivider: true,
        });
        yield* browser.use("Focus the collapsed restart button", (page) =>
          restartLink(page).focus(),
        );
        expect(
          yield* browser.use("Read the tooltip", (page) => page.getByRole("tooltip").innerText()),
        ).toBe("Restart Executor to install v2.4.0");
        // The collapsed rail's icon has no text of its own; the same region still says it.
        expect(yield* browser.use("Read the collapsed announcement", announcement)).toEqual({
          count: 1,
          text: "Update ready: Executor v2.4.0. Restart Executor to install it.",
        });
        yield* browser.checkpoint("Update ready in the collapsed rail");

        // When the desktop clears it, as after a failed download, the card goes away and the
        // sidebar is as it was.
        yield* browser.use("Widen the window", (page) =>
          page
            .setViewportSize({ width: 1180, height: 800 })
            .then(() =>
              page.getByRole("button", { name: "Expand sidebar" }).waitFor({ state: "detached" }),
            ),
        );
        yield* browser.use("Clear the update", (page) => showUpdate(page, null));
        yield* browser.use("Wait for the update to go", (page) =>
          page.locator("aside.sidebar .sidebar-update").waitFor({ state: "detached" }),
        );
        expect(yield* browser.use("Measure the sidebar without the update", layout)).toEqual(
          reloaded,
        );
        expect(yield* browser.use("Read the cleared announcement", announcement)).toEqual({
          count: 1,
          text: "",
        });

        // A long prerelease version wraps instead of being cut off, in the narrowest sidebar, which
        // a window under 1,000 px wide shows when the rail is expanded: while it downloads, once
        // it is ready, and in the collapsed rail's tooltip.
        const long = "2.0.0-beta.123";
        yield* browser.use("Narrow the window and expand the rail", (page) =>
          page
            .setViewportSize({ width: 960, height: 800 })
            .then(() => page.getByRole("button", { name: "Expand sidebar" }).click())
            .then(() => page.getByRole("button", { name: "Collapse sidebar" }).waitFor()),
        );
        expect(
          yield* browser.use("Measure the narrow sidebar", (page) =>
            box(page, "aside.sidebar").then((sidebar) => sidebar?.width),
          ),
        ).toBe(190);
        yield* browser.use("Show a long downloading version", (page) =>
          showUpdate(page, { state: "downloading", version: long }),
        );
        yield* browser.use("Wait for the long download status", (page) =>
          page
            .locator("aside.sidebar")
            .getByRole("status")
            .filter({ hasText: `Downloading v${long}` })
            .waitFor(),
        );
        expect(yield* browser.use("Check the long download status fits", clipped)).toEqual({
          cut: [],
          outside: false,
        });
        yield* browser.checkpoint("Long version downloading");
        yield* browser.use("Show a long ready version", (page) =>
          showUpdate(page, { state: "ready", version: long }),
        );
        const longRestart = (page: Page) =>
          page
            .locator("aside.sidebar")
            .getByRole("link", { name: `Restart Executor to install v${long}` });
        yield* browser.use("Wait for the long restart button", (page) =>
          longRestart(page).waitFor(),
        );
        expect(
          yield* browser.use("Read the long card", (page) =>
            page
              .locator("aside.sidebar .sidebar-update")
              .innerText()
              .then((text) => text.split("\n").filter((line) => line.trim() !== "")),
          ),
        ).toEqual([
          "Update ready",
          `v${long}`,
          "Executor restarts to install it.",
          "Restart to update",
        ]);
        expect(yield* browser.use("Check the long ready card fits", clipped)).toEqual({
          cut: [],
          outside: false,
        });
        expect(yield* browser.use("Read the long announcement", announcement)).toEqual({
          count: 1,
          text: `Update ready: Executor v${long}. Restart Executor to install it.`,
        });
        yield* browser.checkpoint("Long version ready");
        yield* browser.use("Collapse the rail for the long version", (page) =>
          page
            .getByRole("button", { name: "Collapse sidebar" })
            .click()
            .then(() => page.getByRole("button", { name: "Expand sidebar" }).waitFor()),
        );
        yield* browser.use("Focus the long collapsed restart button", (page) =>
          longRestart(page).focus(),
        );
        expect(
          yield* browser.use("Read the long tooltip", (page) =>
            Promise.all([
              page.getByRole("tooltip").innerText(),
              page.getByRole("tooltip").evaluate((tooltip) => {
                const bounds = tooltip.getBoundingClientRect();
                return bounds.right <= window.innerWidth && bounds.left >= 0;
              }),
            ]),
          ),
        ).toEqual([`Restart Executor to install v${long}`, true]);
        yield* browser.checkpoint("Long version in the collapsed tooltip");
      }),
    ),
  );
});
