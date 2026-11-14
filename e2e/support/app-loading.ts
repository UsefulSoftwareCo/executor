/** Exercise each real app tab across held metadata and content reads. */
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { Browser } from "./browser.ts";
import { openThroughBrowser } from "./in-app-navigation.ts";
import { holdQuery } from "./query-transition.ts";
import type { Page } from "playwright";

const tabs = [
  { view: "overview", title: "Overview", loading: "Loading overview" },
  { view: "accounts", title: "Accounts", loading: "Loading accounts" },
  { view: "tools", title: "Tools", loading: "Loading tools" },
  { view: "source", title: "Working source", loading: "Loading source" },
  { view: "history", title: "Working source", loading: "Loading source history" },
  { view: "versions", title: "Versions", loading: "Loading versions" },
  { view: "settings", title: "Settings", loading: "Loading settings" },
] as const;
const redundantTitles = ["Overview", "Accounts", "Versions", "Settings"];
/**
 * The bounds of a section's header row once it is laid out. An in-app navigation shows the route's
 * pending view and then the page itself; an element being swapped out has no layout, so the
 * measurement waits for a laid-out one.
 */
const box = (page: Page, title: string) =>
  page
    .waitForFunction(
      ({ title, navigation }) => {
        const row = navigation
          ? document.querySelector('nav[aria-label="App navigation"]')
          : (() => {
              const heading = Array.from(document.querySelectorAll("h2")).find(
                (element) =>
                  element.textContent === title && element.getBoundingClientRect().width > 0,
              );
              const header = heading?.closest("header");
              return title === "Working source" ? header?.parentElement : header;
            })();
        const rect = row?.getBoundingClientRect();
        return rect !== undefined && rect.width > 0 && rect.height > 0
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : false;
      },
      { title, navigation: redundantTitles.includes(title) },
    )
    .then((handle) => handle.jsonValue())
    .then((bounds) => {
      if (bounds === false) throw new Error(`Section header missing: ${title}`);
      return bounds;
    });

type Bounds = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};
const contentBox = (
  page: Page,
  view: (typeof tabs)[number]["view"],
  loading: boolean,
): Promise<Bounds | readonly Bounds[] | null> => {
  if (view === "tools" && loading)
    return page.getByRole("status", { name: "Loading tools", exact: true }).evaluate((element) => {
      const container = element.closest(".tools-section") ?? element.parentElement;
      if (!container) throw new Error("Tool loading frame missing");
      const rect = container.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
  if (view === "overview")
    return page.locator(".app-overview > div > section").evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }),
    );
  const region = loading
    ? {
        overview: '[aria-label="App accounts placeholder"]',
        accounts: ".accounts-section",
        tools: '[aria-label="Loading tools"]',
        source: '[aria-label="Loading files"]',
        history: '[aria-label="Loading history"] > div > div:first-child',
        versions: '[aria-label="Loading versions"]',
        settings: '[aria-label="Loading settings"] > div > div:first-child',
      }[view]
    : {
        overview: '[aria-label="App accounts"]',
        accounts: ".accounts-section",
        tools: ".tools-section",
        source: '[aria-label="Source browser"]',
        history: '[aria-label="Source history"] li:first-child',
        versions: '[aria-label="App versions"]',
        settings: '[aria-label="App name"]',
      }[view];
  return page.locator(region).boundingBox();
};

/** The server responses remain unchanged; only their delivery is held for assertions and screenshots. */
export const checkAppLoading = (input: {
  readonly url: string;
  readonly name: string;
  readonly metadata: readonly string[];
  readonly coldInventory?: readonly string[];
  readonly overviewInventory?: readonly string[];
  readonly tools: readonly string[];
  readonly workspace: readonly string[];
  readonly history: readonly string[];
  readonly versions?: readonly string[];
  readonly source: readonly string[];
  readonly viewports?: readonly { readonly width: number; readonly height: number }[];
}) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    for (const viewport of input.viewports ?? [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      yield* browser.use("Set the viewport", (page) => page.setViewportSize(viewport));
      const coldInventory = input.coldInventory;
      if (coldInventory)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const inventory = yield* holdQuery(coldInventory, "continue", { allRequests: true });
            yield* openThroughBrowser(
              "Open Source before inventory arrives",
              `${input.url}?view=source`,
            );
            yield* inventory.requested;
            yield* browser.use("Cold inventory keeps the app source frame", (page) =>
              page.getByRole("status", { name: "Loading source", exact: true }).waitFor(),
            );
            expect(
              yield* browser.use("Cold app entry is not an inventory table", (page) =>
                page.locator(".loading-rows").count(),
              ),
            ).toBe(0);
            const pending = yield* browser.use("Cold entry header geometry", (page) =>
              box(page, "Working source"),
            );
            yield* browser.checkpoint(`${viewport.width} source before inventory`);
            yield* inventory.release;
            yield* browser.use("Source loads after inventory", (page) =>
              page.getByRole("region", { name: "Source browser", exact: true }).waitFor(),
            );
            expect(
              yield* browser.use("Cold entry keeps the same source position", (page) =>
                box(page, "Working source"),
              ),
            ).toEqual(pending);
          }),
        );
      const overviewInventory = input.overviewInventory;
      if (overviewInventory)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const inventory = yield* holdQuery(overviewInventory, "continue", {
              allRequests: true,
            });
            yield* openThroughBrowser(
              "Open Overview with inventory held",
              `${input.url}?view=overview`,
            );
            yield* inventory.requested;
            yield* browser.use(
              "Known empty requirements stay visible while inventory loads",
              (page) => page.getByText("No accounts required.", { exact: true }).waitFor(),
            );
            expect(
              yield* browser.use("No invented account rows appear", (page) =>
                page.getByRole("status", { name: "Loading accounts preview", exact: true }).count(),
              ),
            ).toBe(0);
            yield* browser.use("Manager navigation resolves while inventory is held", (page) =>
              page.getByRole("link", { name: "Source", exact: true }).waitFor(),
            );
            expect(
              yield* browser.use("Card reads never insert table rows", (page) =>
                page.locator(".loading-rows").count(),
              ),
            ).toBe(0);
            const pending = yield* browser.use("Partial overview card bounds", (page) =>
              contentBox(page, "overview", false),
            );
            yield* browser.checkpoint(`${viewport.width} overview inventory pending`);
            yield* inventory.release;
            yield* browser.use("The loaded card confirms the empty requirements", (page) =>
              page.getByRole("heading", { name: "No accounts required", exact: true }).waitFor(),
            );
            expect(
              yield* browser.use("Partial overview retains the card layout", (page) =>
                contentBox(page, "overview", false),
              ),
            ).toEqual(pending);
          }),
        );
      for (const tab of tabs)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const selectedTool = tab.view === "tools" && viewport.width < 740;
            const title = selectedTool ? "hello" : tab.title;
            const metadata = yield* holdQuery(input.metadata, "continue", { allRequests: true });
            const content =
              tab.view === "tools"
                ? yield* holdQuery(input.tools, "continue", { allRequests: true })
                : tab.view === "source" || tab.view === "history"
                  ? yield* holdQuery(input.workspace, "continue", { allRequests: true })
                  : tab.view === "versions"
                    ? yield* holdQuery(input.source, "continue", { allRequests: true })
                    : undefined;
            const history =
              tab.view === "history"
                ? yield* holdQuery(input.history, "continue", { allRequests: true })
                : undefined;
            const versions =
              tab.view === "versions" && input.versions
                ? yield* holdQuery(input.versions, "continue", { allRequests: true })
                : undefined;
            yield* openThroughBrowser(
              `Open ${tab.view}`,
              `${input.url}?view=${tab.view}${selectedTool ? "&tool=hello" : ""}`,
            );
            yield* metadata.requested;
            yield* browser.use(`${tab.view} reserves its own content`, (page) =>
              page.getByRole("status", { name: tab.loading, exact: true }).waitFor(),
            );
            // Metadata is held, but the independent permission read must establish the manager layout.
            yield* browser.use("Manager navigation resolves while metadata is held", (page) =>
              page.getByRole("link", { name: "Source", exact: true }).waitFor(),
            );
            yield* browser.use("Typography is ready before comparing data-loading layout", (page) =>
              page.evaluate(() => document.fonts.ready.then(() => undefined)),
            );
            expect(
              yield* browser.use("Only functional pane headings appear below the tabs", (page) =>
                page.getByRole("heading", { name: title, exact: true, level: 2 }).count(),
              ),
            ).toBe(redundantTitles.includes(title) ? 0 : 1);
            expect(
              yield* browser.use("No generic detail or inventory skeleton", (page) =>
                page
                  .locator(
                    '.loading-rows, [aria-label="Loading app"], [aria-label="Loading details"]',
                  )
                  .count(),
              ),
            ).toBe(0);
            const pending = yield* browser.use("Measure the pending section header", (page) =>
              box(page, title),
            );
            expect(pending.height).toBe(
              redundantTitles.includes(title)
                ? 44
                : viewport.width >= 768
                  ? 48
                  : tab.view === "accounts" || selectedTool
                    ? 60
                    : tab.view === "source" || tab.view === "history"
                      ? 94.5
                      : 48,
            );
            if (tab.view === "overview")
              expect(
                yield* browser.use("Overview reserves all five fixed-height cards", (page) =>
                  page.locator('[aria-label$=" placeholder"]').count(),
                ),
              ).toBe(5);
            if (tab.view === "source")
              expect(
                yield* browser.use("Source reserves the file viewport", (page) =>
                  page.getByRole("status", { name: "Loading files", exact: true }).count(),
                ),
              ).toBe(1);
            yield* browser.use("Known app metadata remains visible", (page) =>
              page
                .getByRole("heading", { name: `${input.name} overview`, exact: true, level: 1 })
                .waitFor(),
            );
            const pendingTitle = selectedTool
              ? yield* browser.use("Selected tool title position", (page) =>
                  page.getByRole("heading", { name: title, exact: true, level: 2 }).boundingBox(),
                )
              : undefined;
            const pendingContent = yield* browser.use(
              "Measure the destination content placeholder",
              (page) => contentBox(page, tab.view, true),
            );
            expect(pendingContent).not.toBeNull();
            yield* browser.checkpoint(`${viewport.width} ${tab.view} metadata pending`);
            yield* metadata.release;
            if (versions) {
              yield* versions.requested;
              yield* browser.checkpoint(`${viewport.width} version list pending`);
              yield* versions.release;
            }
            if (content) {
              yield* content.requested;
              yield* browser.checkpoint(`${viewport.width} ${tab.view} content pending`);
              expect(
                yield* browser.use("Nested reads retain the section header", (page) =>
                  box(page, title),
                ),
              ).toEqual(pending);
              if (tab.view === "tools" && !selectedTool)
                yield* browser.use("Search is usable while discovery is pending", (page) =>
                  page.getByPlaceholder("Search tools…").fill("hello"),
                );
              yield* content.release;
            }
            if (history) {
              yield* history.requested;
              yield* browser.use("History has commit-row placeholders", (page) =>
                page.getByRole("status", { name: "Loading history", exact: true }).waitFor(),
              );
              yield* browser.checkpoint(`${viewport.width} commit history pending`);
              yield* history.release;
            }
            switch (tab.view) {
              case "overview":
                yield* browser.use("Overview cards arrive", (page) =>
                  page
                    .getByRole("region", { name: "App tools preview", exact: true })
                    .getByRole("link", { name: "hello A simple greeting", exact: true })
                    .waitFor(),
                );
                break;
              case "accounts":
                for (const heading of ["No app accounts", "No user accounts"])
                  yield* browser.use(`${heading} remains explicit`, (page) =>
                    page.getByRole("heading", { name: heading, exact: true }).waitFor(),
                  );
                break;
              case "tools":
                if (selectedTool) {
                  yield* browser.use("The selected tool detail arrives", (page) =>
                    page.getByText("A simple greeting", { exact: true }).waitFor(),
                  );
                } else {
                  yield* browser.use("Tool discovery completes", (page) =>
                    page.getByRole("button", { name: "hello", exact: true }).waitFor(),
                  );
                  expect(
                    yield* browser.use("The search survives loading", (page) =>
                      page.getByPlaceholder("Search tools…").inputValue(),
                    ),
                  ).toBe("hello");
                }
                break;
              case "source":
              case "versions":
                yield* browser.use("The source viewport arrives", (page) =>
                  page.getByRole("region", { name: "Source browser", exact: true }).waitFor(),
                );
                break;
              case "history":
                yield* browser.use("Real commits arrive", (page) =>
                  page
                    .getByRole("region", { name: "Source history", exact: true })
                    .getByRole("listitem")
                    .first()
                    .waitFor(),
                );
                break;
              case "settings":
                yield* browser.use("Settings cards arrive", (page) =>
                  page.getByRole("region", { name: "App name", exact: true }).waitFor(),
                );
                break;
            }
            yield* browser.use("Initial loading completes", (page) =>
              page
                .getByRole("status", { name: tab.loading, exact: true })
                .waitFor({ state: "hidden" }),
            );
            expect(
              yield* browser.use("Loaded header keeps its position and dimensions", (page) =>
                box(page, title),
              ),
            ).toEqual(pending);
            if (selectedTool)
              expect(
                yield* browser.use("Selected tool title keeps its position", (page) =>
                  page.getByRole("heading", { name: title, exact: true, level: 2 }).boundingBox(),
                ),
              ).toEqual(pendingTitle);
            expect(
              yield* browser.use("Loaded content occupies the placeholder's bounds", (page) =>
                contentBox(page, tab.view, false),
              ),
            ).toEqual(pendingContent);
            yield* browser.checkpoint(`${viewport.width} ${tab.view} loaded`);
          }),
        );
    }
  });
