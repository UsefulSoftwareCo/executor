/** Exercise each real app tab across held metadata and content reads. */
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { Browser } from "./browser.ts";
import { holdQuery } from "./query-transition.ts";
import type { Page } from "playwright";

const tabs = [
  { view: "overview", title: "Overview", loading: "Loading overview" },
  { view: "accounts", title: "Accounts", loading: "Loading accounts" },
  { view: "tools", title: "Tools", loading: "Loading tools" },
  { view: "source", title: "Working source", loading: "Loading source" },
  { view: "history", title: "Working source", loading: "Loading source history" },
  { view: "deployments", title: "Deployments", loading: "Loading deployments" },
  { view: "settings", title: "Settings", loading: "Loading settings" },
] as const;
const redundantTitles = ["Overview", "Accounts", "Deployments", "Settings"];
const box = (page: Page, title: string) =>
  redundantTitles.includes(title)
    ? page.getByRole("navigation", { name: "App navigation" }).evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })
    : page.getByRole("heading", { name: title, exact: true, level: 2 }).evaluate((element) => {
        const header = element.closest("header");
        if (!header) throw new Error("Section header missing");
        const row = element.textContent === "Working source" ? header.parentElement : header;
        if (!row) throw new Error("Section row missing");
        const rect = row.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
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
        accounts: '.accounts-section .empty-state, [aria-label="Loading accounts"] .empty-state',
        tools: '[aria-label="Loading tools"]',
        source: '[aria-label="Loading files"]',
        history: '[aria-label="Loading history"] > div > div:first-child',
        deployments: '[aria-label="Loading deployments"]',
        settings: '[aria-label="Loading settings"] > div > div:first-child',
      }[view]
    : {
        overview: '[aria-label="App accounts"]',
        accounts: ".accounts-section .empty-state",
        tools: ".tools-section",
        source: '[aria-label="Source browser"]',
        history: '[aria-label="Source history"] li:first-child',
        deployments: '[aria-label="App deployments"]',
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
  readonly deployments?: readonly string[];
  readonly source: readonly string[];
}) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      yield* browser.use("Set the viewport", (page) => page.setViewportSize(viewport));
      const coldInventory = input.coldInventory;
      if (coldInventory)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const inventory = yield* holdQuery(coldInventory, "continue", { allRequests: true });
            yield* browser.use("Open Source before inventory arrives", (page) =>
              page.goto(`${input.url}?view=source`),
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
            yield* browser.use("Open Overview with inventory held", (page) =>
              page.goto(`${input.url}?view=overview`),
            );
            yield* inventory.requested;
            yield* browser.use("Accounts stays a card while inventory loads", (page) =>
              page.getByRole("status", { name: "Loading accounts preview", exact: true }).waitFor(),
            );
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
            yield* browser.use("Account card loading ends", (page) =>
              page
                .getByRole("status", { name: "Loading accounts preview", exact: true })
                .waitFor({ state: "hidden" }),
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
            const title = selectedTool ? "queries.hello" : tab.title;
            const metadata = yield* holdQuery(input.metadata, "continue", { allRequests: true });
            const content =
              tab.view === "tools"
                ? yield* holdQuery(input.tools, "continue", { allRequests: true })
                : tab.view === "source" || tab.view === "history"
                  ? yield* holdQuery(input.workspace, "continue", { allRequests: true })
                  : tab.view === "deployments"
                    ? yield* holdQuery(input.source, "continue", { allRequests: true })
                    : undefined;
            const history =
              tab.view === "history"
                ? yield* holdQuery(input.history, "continue", { allRequests: true })
                : undefined;
            const versions =
              tab.view === "deployments" && input.deployments
                ? yield* holdQuery(input.deployments, "continue", { allRequests: true })
                : undefined;
            yield* browser.use(`Open ${tab.view}`, (page) =>
              page.goto(
                `${input.url}?view=${tab.view}${selectedTool ? "&tool=queries.hello" : ""}`,
              ),
            );
            yield* metadata.requested;
            yield* browser.use(`${tab.view} reserves its own content`, (page) =>
              page.getByRole("status", { name: tab.loading, exact: true }).waitFor(),
            );
            // Metadata is held, but the independent permission read must establish the manager layout.
            yield* browser.use("Manager navigation resolves while metadata is held", (page) =>
              page.getByRole("link", { name: "Source", exact: true }).waitFor(),
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
              yield* browser.checkpoint(`${viewport.width} deployment list pending`);
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
                    .getByRole("link", { name: "queries.hello A simple greeting", exact: true })
                    .waitFor(),
                );
                break;
              case "accounts":
                yield* browser.use("Known empty accounts remain explicit", (page) =>
                  page
                    .getByRole("heading", { name: "No accounts required", exact: true })
                    .waitFor(),
                );
                break;
              case "tools":
                if (selectedTool) {
                  yield* browser.use("The selected tool detail arrives", (page) =>
                    page.getByText("A simple greeting", { exact: true }).waitFor(),
                  );
                } else {
                  yield* browser.use("Tool discovery completes", (page) =>
                    page.getByRole("button", { name: "queries.hello", exact: true }).waitFor(),
                  );
                  expect(
                    yield* browser.use("The search survives loading", (page) =>
                      page.getByPlaceholder("Search tools…").inputValue(),
                    ),
                  ).toBe("hello");
                }
                break;
              case "source":
              case "deployments":
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
