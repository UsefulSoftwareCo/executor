/**
 * The desktop app's update in the local dashboard's sidebar. The desktop window has no preload or
 * IPC bridge: its main process writes the update on the dashboard's document as the
 * `data-desktop-update` attribute's JSON and announces it with the `executor:desktop-update`
 * event, and intercepts the `executor-update:restart` navigation of the sidebar's "Restart to update"
 * link to restart into it. This scenario plays the desktop's part in a browser, so it checks the dashboard's side.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import type { Page } from "playwright";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

type Update = {
  readonly state: "downloading" | "ready";
  readonly version: string;
  readonly current?: string;
  readonly releases?: ReadonlyArray<{
    readonly version: string;
    readonly notes: ReadonlyArray<string>;
  }>;
  readonly releasesSince?: string | undefined;
} | null;

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
 * The block's text that is cut off or runs out of the sidebar: each element whose content is wider
 * or taller than its box, and whether the block itself reaches past the sidebar.
 */
const clipped = (page: Page) =>
  page.evaluate(() => {
    const block = document.querySelector("aside.sidebar .sidebar-update");
    const sidebar = document.querySelector("aside.sidebar");
    if (block === null || sidebar === null) return { missing: true };
    const elements = [block, ...block.querySelectorAll("*")];
    const text = (element: Element) => element.textContent ?? "";
    return {
      wide: elements.filter((element) => element.scrollWidth > element.clientWidth + 1).map(text),
      tall: elements.filter((element) => element.scrollHeight > element.clientHeight + 1).map(text),
      outside: block.getBoundingClientRect().right > sidebar.getBoundingClientRect().right,
    };
  });

/** The sidebar's resource links the block takes the place of. */
const resources = ["Docs", "Feedback", "Star on GitHub"] as const;

/** Which of the resource links the sidebar shows. */
const links = (page: Page) =>
  Promise.all(
    resources.map((name) =>
      page.locator("aside.sidebar").getByRole("link", { name, exact: true }).isVisible(),
    ),
  );

/**
 * Where the navigation, the divider above the footer, the resource links (the list and each link)
 * and the version row sit, and whether the sidebar has more than it shows.
 */
const layout = (page: Page) =>
  Promise.all([
    box(page, "aside.sidebar nav"),
    box(page, "aside.sidebar .sidebar-utilities"),
    // The links' list, or null when the sidebar has none.
    page.evaluate(() => {
      const list = document.querySelector("aside.sidebar .sidebar-resource-links");
      if (list === null) return null;
      const { x, y, width, height } = list.getBoundingClientRect();
      return { x, y, width, height };
    }),
    // Each link's box, or null when the sidebar has none.
    page.locator("aside.sidebar").evaluate(
      (sidebar, names) =>
        names.map((name) => {
          const link = [...sidebar.querySelectorAll(".sidebar-resource-links a")].find(
            (each) => each.getAttribute("title") === name,
          );
          if (link === undefined) return null;
          const { x, y, width, height } = link.getBoundingClientRect();
          return { x, y, width, height };
        }),
      [...resources],
    ),
    box(page, "aside.sidebar .sidebar-build"),
    page
      .locator("aside.sidebar")
      .evaluate((sidebar) => sidebar.scrollHeight > sidebar.clientHeight),
  ]).then(([navigation, divider, linkList, resourceLinks, version, scrolls]) => ({
    navigation,
    divider,
    linkList,
    resourceLinks,
    version,
    scrolls,
  }));

/**
 * The sidebar `without` an update, as it is with the block in place of the resource links: the
 * navigation and the version row stay where they were, and the sidebar does not need to scroll
 * where it did not. The divider above the footer moves down by exactly the links' height, as the
 * footer below it loses them and keeps its place at the bottom; the block takes the room above it.
 */
const inPlaceOfLinks = (without: Awaited<ReturnType<typeof layout>>) => {
  const { divider, linkList } = without;
  if (divider === null || linkList === null) throw new Error("No divider or links to measure");
  return {
    ...without,
    divider: {
      ...divider,
      y: divider.y + linkList.height,
      height: divider.height - linkList.height,
    },
    linkList: null,
    resourceLinks: [null, null, null],
  };
};

/** The block's box, and whether it sits below the navigation and above the links' divider. */
const placement = (page: Page) =>
  Promise.all([
    box(page, "aside.sidebar .sidebar-update"),
    box(page, "aside.sidebar nav"),
    box(page, "aside.sidebar .sidebar-utilities"),
  ]).then(([block, navigation, divider]) => ({
    belowNavigation:
      block !== null && navigation !== null && block.y >= navigation.y + navigation.height,
    aboveDivider: block !== null && divider !== null && block.y + block.height <= divider.y,
  }));

/**
 * The update's mark in the icon rail: its name, what text it shows, its icons and dot, its size,
 * and whether it sits below the navigation and above the links' divider.
 */
const railMark = (page: Page) =>
  page.evaluate(() => {
    const marks = document.querySelectorAll<HTMLElement>(
      "aside.sidebar .sidebar-notice-mark button",
    );
    const mark = marks[0];
    const navigation = document.querySelector("aside.sidebar nav");
    const divider = document.querySelector("aside.sidebar .sidebar-utilities");
    if (marks.length !== 1 || mark === undefined || navigation === null || divider === null)
      return { marks: marks.length };
    const { top, bottom, width, height } = mark.getBoundingClientRect();
    return {
      marks: 1,
      label: mark.getAttribute("aria-label"),
      title: mark.getAttribute("title"),
      text: mark.innerText.trim(),
      icons: mark.querySelectorAll("svg").length,
      dots: mark.querySelectorAll(".sidebar-notice-dot").length,
      small: width <= 32 && height <= 32,
      belowNavigation: top >= navigation.getBoundingClientRect().bottom,
      aboveDivider: bottom <= divider.getBoundingClientRect().top,
    };
  });

/** The block's lines of text, top to bottom. */
const lines = (page: Page) =>
  page
    .locator("aside.sidebar .sidebar-update")
    .innerText()
    .then((text) => text.split("\n").filter((line) => line.trim() !== ""));

/**
 * How the block is drawn: the tag is a pill of its own, the block has no border or fill of a card
 * around it, and the restart, when there is one, is a text link narrower than the block rather than
 * a full-width button.
 */
const look = (page: Page) =>
  page.evaluate(() => {
    const block = document.querySelector<HTMLElement>("aside.sidebar .sidebar-update");
    const tag = block?.querySelector<HTMLElement>(".sidebar-news-tag");
    if (block === null || block === undefined || tag === null || tag === undefined)
      return { missing: true };
    const style = getComputedStyle(block);
    const link = block.querySelector("a");
    return {
      tag: tag.innerText,
      tagIsPill: getComputedStyle(tag).borderTopWidth !== "0px",
      blockBorder: style.borderTopWidth,
      blockFill: style.backgroundColor,
      buttons: block.querySelectorAll("button").length,
      linkNarrowerThanBlock:
        link === null ? null : link.getBoundingClientRect().width < block.clientWidth / 2,
    };
  });

/** Whether the sidebar shows the block or its restart, as a person or a screen reader meets it. */
const shown = (page: Page) =>
  Promise.all([
    page.locator("aside.sidebar .sidebar-update").isVisible(),
    page
      .locator("aside.sidebar")
      .getByRole("link", { name: /^Restart Executor/ })
      .isVisible(),
  ]);

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
        // The Geist faces load with `font-display: optional`: a face that misses the first paint
        // is kept from that text but used for text laid out later, such as the links coming back
        // below, which would then measure differently. Once both faces are loaded, a reload paints
        // with them from the start.
        expect(
          yield* browser.use("Load the dashboard's fonts", (page) =>
            page.evaluate(() =>
              document.fonts.ready.then(() =>
                ["12px Geist", "12px 'Geist Mono'"].map((font) => document.fonts.check(font)),
              ),
            ),
          ),
        ).toEqual([true, true]);
        yield* browser.use("Reload with the fonts", (page) =>
          page
            .reload()
            .then(() => page.getByRole("heading", { level: 1, name: /^Apps/ }).waitFor()),
        );

        // A dashboard the desktop has told about no update, as in any browser, shows no block and
        // keeps nothing in its place; the resource links are there.
        expect(
          yield* browser.use("Check the sidebar has no update", (page) =>
            Promise.all([
              page.locator("aside.sidebar .sidebar-update").count(),
              page.locator("aside.sidebar .sidebar-notice").count(),
            ]),
          ),
        ).toEqual([0, 0]);
        expect(yield* browser.use("Read the resource links", links)).toEqual([true, true, true]);
        const without = yield* browser.use("Measure the sidebar", layout);
        expect(without.scrolls).toBe(false);
        // The live region that says the update is ready is on the page already, and empty, so the
        // moment it fills is announced.
        expect(yield* browser.use("Read the empty announcement", announcement)).toEqual({
          count: 1,
          text: "",
        });

        // While the update downloads, a "Downloading" tag and the version say so as a status and
        // offer nothing to press.
        yield* browser.use("Show a downloading update", (page) =>
          showUpdate(page, { state: "downloading", version: "2.4.0" }),
        );
        yield* browser.use("Wait for the download status", (page) =>
          page
            .locator("aside.sidebar")
            .getByRole("status")
            .filter({ hasText: "Version 2.4.0" })
            .waitFor(),
        );
        expect(yield* browser.use("Read the downloading block", lines)).toEqual([
          "Downloading",
          "Version 2.4.0",
        ]);
        expect(yield* browser.use("Look at the downloading block", look)).toEqual({
          tag: "Downloading",
          tagIsPill: true,
          blockBorder: "0px",
          blockFill: "rgba(0, 0, 0, 0)",
          buttons: 0,
          linkNarrowerThanBlock: null,
        });
        expect(
          yield* browser.use("Check there is no restart yet", (page) => restartLink(page).count()),
        ).toBe(0);
        expect(yield* browser.use("Read the announcement while downloading", announcement)).toEqual(
          { count: 1, text: "" },
        );
        expect(yield* browser.use("Place the downloading block", placement)).toEqual({
          belowNavigation: true,
          aboveDivider: true,
        });
        // It takes the place of the resource links, and leaves the navigation and the version
        // row where they were.
        expect(yield* browser.use("Read the links while downloading", links)).toEqual([
          false,
          false,
          false,
        ]);
        expect(yield* browser.use("Measure the sidebar while downloading", layout)).toEqual(
          inPlaceOfLinks(without),
        );
        yield* browser.checkpoint("Update downloading in the sidebar");

        // Once it is ready, an "Update ready" tag and one line name the version, and a text link
        // under them restarts into it. There is no card around them and no full-width button. It
        // sits above the footer's divider in place of the resource links.
        yield* browser.use("Show a ready update", (page) =>
          showUpdate(page, { state: "ready", version: "2.4.0" }),
        );
        yield* browser.use("Wait for the restart link", (page) => restartLink(page).waitFor());
        yield* browser.checkpoint("Update ready in the sidebar");
        expect(
          yield* browser.use("Read the block", (page) =>
            Promise.all([
              lines(page),
              restartLink(page).getAttribute("href"),
              restartLink(page).innerText(),
              page.locator("aside.sidebar .sidebar-update a").count(),
            ]),
          ),
        ).toEqual([
          ["Update ready", "Version 2.4.0 is ready to install.", "Restart to update"],
          "executor-update:restart",
          "Restart to update",
          1,
        ]);
        expect(yield* browser.use("Look at the ready block", look)).toEqual({
          tag: "Update ready",
          tagIsPill: true,
          blockBorder: "0px",
          blockFill: "rgba(0, 0, 0, 0)",
          buttons: 0,
          linkNarrowerThanBlock: true,
        });
        expect(yield* browser.use("Read the ready announcement", announcement)).toEqual({
          count: 1,
          text: "Update ready: Executor v2.4.0. Restart Executor to install it.",
        });
        expect(yield* browser.use("Place the ready block", placement)).toEqual({
          belowNavigation: true,
          aboveDivider: true,
        });
        expect(yield* browser.use("Read the links with the update", links)).toEqual([
          false,
          false,
          false,
        ]);
        expect(yield* browser.use("Measure the sidebar with the update", layout)).toEqual(
          inPlaceOfLinks(without),
        );

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

        // The shortest desktop window, 540 px tall, still shows it where the links were, with no
        // need to scroll: the navigation and the version row stay where they are at that height
        // without an update.
        yield* browser.use("Clear the update for the short window", (page) =>
          showUpdate(page, null),
        );
        yield* browser.use("Shorten the window", (page) =>
          page.setViewportSize({ width: 1180, height: 540 }),
        );
        yield* browser.use("Wait for the links in the short window", (page) =>
          page.locator("aside.sidebar").getByRole("link", { name: "Docs", exact: true }).waitFor(),
        );
        const shortWithout = yield* browser.use("Measure the short sidebar", layout);
        expect(shortWithout.scrolls).toBe(false);
        yield* browser.use("Show the ready update in the short window", (page) =>
          showUpdate(page, { state: "ready", version: "2.4.0" }),
        );
        yield* browser.use("Wait for the short window's announcement", (page) =>
          page
            .locator(".desktop-update-announcement")
            .filter({ hasText: "Update ready" })
            .waitFor({ state: "attached" }),
        );
        expect(yield* browser.use("Check the short window", shown)).toEqual([true, true]);
        expect(yield* browser.use("Place the block in the short window", placement)).toEqual({
          belowNavigation: true,
          aboveDivider: true,
        });
        expect(yield* browser.use("Measure the short sidebar with the update", layout)).toEqual(
          inPlaceOfLinks(shortWithout),
        );
        yield* browser.checkpoint("Update ready in a short window");

        // The collapsed rail has no room for the block and keeps its resource links where they are
        // without an update. Above them one small icon, with a dot and no text, says the update is
        // ready; the same region still says it to a screen reader.
        yield* browser.use("Collapse the rail", (page) =>
          page
            .setViewportSize({ width: 900, height: 800 })
            .then(() => page.getByRole("button", { name: "Expand sidebar" }).waitFor()),
        );
        expect(yield* browser.use("Look at the collapsed rail's mark", railMark)).toEqual({
          marks: 1,
          label: "Update ready: version 2.4.0",
          title: "Update ready: version 2.4.0",
          text: "",
          icons: 1,
          dots: 1,
          small: true,
          belowNavigation: true,
          aboveDivider: true,
        });
        expect(
          yield* browser.use("Check the collapsed rail", (page) =>
            Promise.all([
              page.locator("aside.sidebar .sidebar-update").count(),
              page.locator("aside.sidebar .sidebar-notice").count(),
              restartLink(page).count(),
            ]),
          ),
        ).toEqual([0, 0, 0]);
        expect(yield* browser.use("Read the collapsed rail's links", links)).toEqual([
          true,
          true,
          true,
        ]);
        const collapsedWith = yield* browser.use("Measure the collapsed rail", layout);
        expect(yield* browser.use("Read the collapsed announcement", announcement)).toEqual({
          count: 1,
          text: "Update ready: Executor v2.4.0. Restart Executor to install it.",
        });
        yield* browser.checkpoint("Update ready in the collapsed rail");
        // While it downloads the icon has no dot, and nothing marks a rail without an update; the
        // links stay where they are throughout.
        yield* browser.use("Show the download in the rail", (page) =>
          showUpdate(page, { state: "downloading", version: "2.4.0" }),
        );
        expect(yield* browser.use("Look at the downloading mark", railMark)).toEqual({
          marks: 1,
          label: "Downloading version 2.4.0",
          title: "Downloading version 2.4.0",
          text: "",
          icons: 1,
          dots: 0,
          small: true,
          belowNavigation: true,
          aboveDivider: true,
        });
        expect(yield* browser.use("Measure the rail while downloading", layout)).toEqual(
          collapsedWith,
        );
        yield* browser.checkpoint("Update downloading in the collapsed rail");
        yield* browser.use("Clear the update in the rail", (page) => showUpdate(page, null));
        expect(yield* browser.use("Look for a mark without an update", railMark)).toEqual({
          marks: 0,
        });
        expect(yield* browser.use("Measure the collapsed rail without it", layout)).toEqual(
          collapsedWith,
        );

        // Pressing the mark expands the rail to the block and its restart.
        yield* browser.use("Show the ready update in the rail again", (page) =>
          showUpdate(page, { state: "ready", version: "2.4.0" }),
        );
        yield* browser.use("Press the rail's mark", (page) =>
          page
            .locator("aside.sidebar")
            .getByRole("button", { name: "Update ready: version 2.4.0" })
            .click(),
        );
        yield* browser.use("Wait for the expanded rail", (page) =>
          page.getByRole("button", { name: "Collapse sidebar" }).waitFor(),
        );
        expect(yield* browser.use("Check the expanded rail", shown)).toEqual([true, true]);
        expect(yield* browser.use("Look for the mark once expanded", railMark)).toEqual({
          marks: 0,
        });
        yield* browser.use("Collapse the rail again", (page) =>
          page
            .getByRole("button", { name: "Collapse sidebar" })
            .click()
            .then(() => page.getByRole("button", { name: "Expand sidebar" }).waitFor()),
        );
        yield* browser.use("Clear the update in the collapsed rail", (page) =>
          showUpdate(page, null),
        );

        // When the desktop clears it, as after a failed download, the block goes away and the
        // resource links come back, where they were.
        yield* browser.use("Widen the window", (page) =>
          page.setViewportSize({ width: 1180, height: 800 }),
        );
        yield* browser.use("Show the ready update once more", (page) =>
          showUpdate(page, { state: "ready", version: "2.4.0" }),
        );
        yield* browser.use("Wait for the restart link again", (page) =>
          restartLink(page).waitFor(),
        );
        yield* browser.use("Clear the update", (page) => showUpdate(page, null));
        yield* browser.use("Wait for the update to go", (page) =>
          page.locator("aside.sidebar .sidebar-update").waitFor({ state: "detached" }),
        );
        expect(yield* browser.use("Read the links once it is cleared", links)).toEqual([
          true,
          true,
          true,
        ]);
        expect(yield* browser.use("Measure the sidebar without the update", layout)).toEqual(
          without,
        );
        expect(yield* browser.use("Read the cleared announcement", announcement)).toEqual({
          count: 1,
          text: "",
        });

        // A long prerelease version wraps in full instead of being cut off, in the narrowest
        // sidebar, which a window under 1,000 px wide shows when the rail is expanded: while it
        // downloads and once it is ready. Its last identifier has 80 digits.
        const long = `2.0.0-beta.${"1234567890".repeat(8)}`;
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
            .filter({ hasText: `Version ${long}` })
            .waitFor(),
        );
        expect(yield* browser.use("Check the long download status fits", clipped)).toEqual({
          wide: [],
          tall: [],
          outside: false,
        });
        yield* browser.checkpoint("Long version downloading");
        yield* browser.use("Show a long ready version", (page) =>
          showUpdate(page, { state: "ready", version: long }),
        );
        yield* browser.use("Wait for the long restart link", (page) =>
          page
            .locator("aside.sidebar")
            .getByRole("link", { name: `Restart Executor to install v${long}` })
            .waitFor(),
        );
        expect(yield* browser.use("Read the long block", lines)).toEqual([
          "Update ready",
          `Version ${long} is ready to install.`,
          "Restart to update",
        ]);
        expect(yield* browser.use("Check the long ready block fits", clipped)).toEqual({
          wide: [],
          tall: [],
          outside: false,
        });
        expect(yield* browser.use("Read the long announcement", announcement)).toEqual({
          count: 1,
          text: `Update ready: Executor v${long}. Restart Executor to install it.`,
        });
        yield* browser.checkpoint("Long version ready");
      }),
    ),
  );

  it.effect(scenarios.localDesktopUpdateNotes.title, (context) =>
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
        const without = yield* browser.use("Measure the sidebar", layout);
        const title = yield* browser.use("Read the page title", (page) => page.title());

        // The desktop runs 2.2.0 and its feed lists notes for the releases up to 2.4.0, and says
        // that every release after 2.0.0 is there. One of 2.4.0's lines is HTML, and one of 2.3.0's
        // a Markdown link: neither is a note the release notes' allow-list accepts, so the
        // dashboard leaves both out, whatever the desktop sent.
        const ready: Update = {
          state: "ready",
          version: "2.4.0",
          current: "2.2.0",
          releasesSince: "2.0.0",
          releases: [
            {
              version: "2.4.0",
              notes: [
                "Apps open from the sidebar.",
                '<img src=x onerror="document.title=1">',
                "The desktop app restarts faster.",
              ],
            },
            {
              version: "2.3.0",
              notes: ["[Read more](https://example.invalid)"],
            },
            { version: "2.2.0", notes: ["Already installed."] },
            { version: "2.1.0", notes: ["Older still."] },
          ],
        };
        yield* browser.use("Show a ready update with notes", (page) => showUpdate(page, ready));
        const opener = (page: Page) =>
          page.locator("aside.sidebar").getByRole("button", { name: "See what's new in v2.4.0" });
        yield* browser.use("Wait for the block's button", (page) => opener(page).waitFor());
        // The line leads with the ready version's newest note; the restart link is as before.
        expect(yield* browser.use("Read the block", lines)).toEqual([
          "Update ready",
          "v2.4.0 Apps open from the sidebar.",
          "Restart to update",
        ]);
        expect(
          yield* browser.use("Read the restart link", (page) =>
            Promise.all([
              restartLink(page).getAttribute("href"),
              page.locator("aside.sidebar .sidebar-update a").count(),
              page.locator("aside.sidebar .sidebar-update button").count(),
            ]),
          ),
        ).toEqual(["executor-update:restart", 1, 1]);
        expect(yield* browser.use("Measure the block in place of the links", layout)).toEqual(
          inPlaceOfLinks(without),
        );
        yield* browser.checkpoint("Update ready with its newest note");

        // The keyboard opens the panel: every release after the running one up to the ready one,
        // newest first, each with its notes as text and its public release page.
        yield* browser.use("Focus the block's button", (page) => opener(page).focus());
        yield* browser.use("Open the notes", (page) => page.keyboard.press("Enter"));
        const dialog = (page: Page) => page.getByRole("dialog", { name: "What's new in v2.4.0" });
        yield* browser.use("Wait for the notes", (page) => dialog(page).waitFor());
        yield* browser.checkpoint("What's new in the ready update");
        expect(
          yield* browser.use("Read the notes", (page) =>
            dialog(page).evaluate((element) => ({
              description: element.querySelector("p")?.textContent,
              releases: [...element.querySelectorAll(".release-notes-release")].map((release) => ({
                heading: release.querySelector("h3")?.textContent,
                notes: [...release.querySelectorAll("li")].map((item) => item.textContent),
                empty: release.querySelector("p")?.textContent ?? null,
                page: release.querySelector("a")?.getAttribute("href"),
              })),
              links: [...element.querySelectorAll("a")].map((link) => [
                link.textContent,
                link.getAttribute("href"),
                link.getAttribute("target"),
              ]),
              images: element.querySelectorAll("img").length,
            })),
          ),
        ).toEqual({
          description:
            "Changes since v2.2.0, the version running now. Executor restarts to install it.",
          releases: [
            {
              heading: "v2.4.0",
              notes: ["Apps open from the sidebar.", "The desktop app restarts faster."],
              empty: null,
              page: "https://github.com/UsefulSoftwareCo/executor/releases/tag/executor%402.4.0",
            },
            {
              heading: "v2.3.0",
              notes: [],
              empty: "No changes were listed for this release.",
              page: "https://github.com/UsefulSoftwareCo/executor/releases/tag/executor%402.3.0",
            },
          ],
          links: [
            [
              "Release page",
              "https://github.com/UsefulSoftwareCo/executor/releases/tag/executor%402.4.0",
              "_blank",
            ],
            [
              "Release page",
              "https://github.com/UsefulSoftwareCo/executor/releases/tag/executor%402.3.0",
              "_blank",
            ],
            ["All releases", "https://github.com/UsefulSoftwareCo/executor/releases", "_blank"],
            ["Restart to update", "executor-update:restart", null],
          ],
          images: 0,
        });
        // Nothing from the refused HTML ran.
        expect(yield* browser.use("Read the page title again", (page) => page.title())).toBe(title);
        // The panel repeats the restart, with the sidebar link's name.
        expect(
          yield* browser.use("Read the panel's restart", (page) =>
            dialog(page)
              .getByRole("link", { name: "Restart Executor to install v2.4.0" })
              .getAttribute("href"),
          ),
        ).toBe("executor-update:restart");
        // Escape closes it and returns focus to the block.
        yield* browser.use("Close the notes", (page) => page.keyboard.press("Escape"));
        yield* browser.use("Wait for the notes to close", (page) =>
          dialog(page).waitFor({ state: "detached" }),
        );
        expect(
          yield* browser.use("Read the focused control", (page) =>
            page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null),
          ),
        ).toBe("See what's new in v2.4.0");

        // A ready version with no notes of its own shows the version alone; the panel still lists
        // what changed in between.
        yield* browser.use("Show a ready update whose version has no notes", (page) =>
          showUpdate(page, {
            ...ready,
            releases: [{ version: "2.4.0", notes: [] }, ...(ready.releases ?? []).slice(1)],
          }),
        );
        yield* browser.use("Wait for the version line", (page) =>
          page
            .locator("aside.sidebar .sidebar-update")
            .getByText("Version 2.4.0 is ready to install.")
            .waitFor(),
        );
        expect(yield* browser.use("Read the version-only block", lines)).toEqual([
          "Update ready",
          "Version 2.4.0 is ready to install.",
          "Restart to update",
        ]);
        expect(yield* browser.use("Check the block opens", (page) => opener(page).count())).toBe(1);

        // A development build runs no release version: every release up to the ready one is listed.
        yield* browser.use("Show a development build's update", (page) =>
          showUpdate(page, { ...ready, current: "0.0.0" }),
        );
        yield* browser.use("Open the development build's notes", (page) =>
          opener(page)
            .click()
            .then(() => dialog(page).waitFor()),
        );
        expect(
          yield* browser.use("Read the development build's notes", (page) =>
            dialog(page).evaluate((element) => ({
              description: element.querySelector("p")?.textContent,
              versions: [...element.querySelectorAll(".release-notes-release h3")].map(
                (heading) => heading.textContent,
              ),
            })),
          ),
        ).toEqual({
          description: "Executor restarts to install it.",
          versions: ["v2.4.0", "v2.3.0", "v2.2.0", "v2.1.0"],
        });
        yield* browser.use("Close the development build's notes", (page) =>
          page.keyboard.press("Escape"),
        );

        // Only the feed knows whether its list is whole: the notes script leaves out a release it
        // cannot place. The panel says "since" the running version only when the feed says the
        // list is whole back to it, and otherwise says the list may leave some out.
        yield* browser.use("Wait for the development build's notes to close", (page) =>
          dialog(page).waitFor({ state: "detached" }),
        );
        const describe = (version: string) => (page: Page) =>
          page.getByRole("dialog", { name: `What's new in v${version}` }).evaluate((element) => ({
            description: element.querySelector("p")?.textContent,
            versions: [...element.querySelectorAll(".release-notes-release h3")].map(
              (heading) => heading.textContent,
            ),
            more: [...element.querySelectorAll("a")]
              .filter((link) => link.textContent === "All releases")
              .map((link) => link.getAttribute("href")),
          }));
        const partial =
          "Recent changes. Some releases since the version running now may not be listed here; All releases has every one. Executor restarts to install it.";
        for (const [name, update, expected] of [
          // Whole back to 2.0.0, which runs now: no release lies between it and the oldest listed,
          // and the panel does not claim one does.
          [
            "whole back to the running version",
            { ...ready, current: "2.0.0" },
            {
              description:
                "Changes since v2.0.0, the version running now. Executor restarts to install it.",
              versions: ["v2.4.0", "v2.3.0", "v2.2.0", "v2.1.0"],
            },
          ],
          // The same between two betas next to each other.
          [
            "whole between two betas",
            {
              state: "ready",
              version: "2.0.0-beta.2",
              current: "2.0.0-beta.1",
              releasesSince: "2.0.0-beta.1",
              releases: [{ version: "2.0.0-beta.2", notes: ["Apps open from the sidebar."] }],
            },
            {
              description:
                "Changes since v2.0.0-beta.1, the version running now. Executor restarts to install it.",
              versions: ["v2.0.0-beta.2"],
            },
          ],
          // A feed holding only 2.4.0, whole only after 2.3.0, on a desktop running 2.0.0.
          [
            "whole only after a later release",
            {
              state: "ready",
              version: "2.4.0",
              current: "2.0.0",
              releasesSince: "2.3.0",
              releases: [{ version: "2.4.0", notes: ["Apps open from the sidebar."] }],
            },
            { description: partial, versions: ["v2.4.0"] },
          ],
          // A feed that does not say, even with an entry as old as the running version.
          [
            "silent about its range",
            { ...ready, releasesSince: undefined },
            { description: partial, versions: ["v2.4.0", "v2.3.0"] },
          ],
        ] as const) {
          const version = update.version;
          yield* browser.use(`Show an update ${name}`, (page) => showUpdate(page, update));
          yield* browser.use(`Open the notes ${name}`, (page) =>
            page
              .locator("aside.sidebar")
              .getByRole("button", { name: `See what's new in v${version}` })
              .click()
              .then(() =>
                page.getByRole("dialog", { name: `What's new in v${version}` }).waitFor(),
              ),
          );
          expect(yield* browser.use(`Read the notes ${name}`, describe(version)), name).toEqual({
            ...expected,
            more: ["https://github.com/UsefulSoftwareCo/executor/releases"],
          });
          if (name === "whole only after a later release")
            yield* browser.checkpoint("Notes the feed does not say are whole");
          yield* browser.use(`Close the notes ${name}`, (page) =>
            page.keyboard
              .press("Escape")
              .then(() => page.getByRole("dialog").waitFor({ state: "detached" })),
          );
        }

        // A feed with no notes, or with none after the running version, shows the block of a
        // plain update: the version, the restart, nothing to open.
        for (const [name, update] of [
          ["no notes", { state: "ready", version: "2.4.0", current: "2.2.0" }],
          [
            "none newer",
            { ...ready, releases: [{ version: "2.2.0", notes: ["Already installed."] }] },
          ],
        ] as const) {
          yield* browser.use(`Show an update with ${name}`, (page) => showUpdate(page, update));
          yield* browser.use(`Wait for the plain block with ${name}`, (page) =>
            opener(page).waitFor({ state: "detached" }),
          );
          expect(yield* browser.use(`Read the block with ${name}`, lines)).toEqual([
            "Update ready",
            "Version 2.4.0 is ready to install.",
            "Restart to update",
          ]);
        }
      }),
    ),
  );
});
