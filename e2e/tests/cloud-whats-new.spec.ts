import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import type { Page } from "playwright";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { cloudTestNotes } from "../support/cloud-release-notes.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const sidebar = (page: Page) => page.locator("aside.sidebar");
const opener = (page: Page) => sidebar(page).getByRole("button", { name: "Open what's new" });
const panel = (page: Page) => page.getByRole("dialog", { name: "What's new" });

const lines = (page: Page) =>
  sidebar(page)
    .locator(".sidebar-update")
    .innerText()
    .then((text) => text.split("\n").filter((line) => line.trim() !== ""));

const resources = (page: Page) =>
  Promise.all([
    ...["Docs", "Feedback", "Star on GitHub"].map((name) =>
      sidebar(page).getByRole("link", { name, exact: true }).isVisible(),
    ),
    sidebar(page).getByRole("button", { name: "Get support" }).isVisible(),
  ]);

const placement = (page: Page) =>
  page.evaluate(() => {
    const box = (selector: string) =>
      document.querySelector(`aside.sidebar ${selector}`)?.getBoundingClientRect();
    const block = box(".sidebar-update");
    const navigation = box("nav");
    const divider = box(".sidebar-utilities");
    const aside = document.querySelector("aside.sidebar")!;
    return {
      belowNavigation:
        block !== undefined && navigation !== undefined && block.top >= navigation.bottom,
      aboveDivider: block !== undefined && divider !== undefined && block.bottom <= divider.top,
      scrolls: aside.scrollHeight > aside.clientHeight,
    };
  });

const openAt = (page: Page, slug: string, time: string) =>
  page.clock
    .setFixedTime(new Date(time))
    .then(() => page.goto(`/org/${slug}/apps`))
    .then(() => page.getByRole("heading", { level: 1, name: /^Apps/ }).waitFor());

const day = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

layer(HostedLive, { excludeTestServices: true })("Cloud what's new", (it) => {
  it.effect(scenarios.cloudWhatsNew.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          actors = yield* Actors,
          target = yield* Target;
        const slug = actors.organization.slug;
        yield* browser.login(actors.owner);
        yield* browser.use("Open the dashboard", (page) =>
          page
            .setViewportSize({ width: 1280, height: 800 })
            .then(() => openAt(page, slug, "2026-11-15T12:00:00Z")),
        );

        if (target.metadata.target !== "cloud") {
          expect(
            yield* browser.use("Check the sidebar has no notes", (page) =>
              Promise.all([opener(page).count(), sidebar(page).locator(".sidebar-notice").count()]),
            ),
          ).toEqual([0, 0]);
          return;
        }

        yield* browser.use("Wait for the block", (page) => opener(page).waitFor());
        yield* browser.checkpoint("What's new in the sidebar");
        expect(yield* browser.use("Read the block", lines)).toEqual([
          "What's new",
          "Apps open from the sidebar in one click.",
        ]);
        expect(
          yield* browser.use("Check the block is not a card", (page) =>
            sidebar(page)
              .locator(".sidebar-update")
              .evaluate((block) => [
                getComputedStyle(block).borderTopWidth,
                block.querySelectorAll("a, button").length,
              ]),
          ),
        ).toEqual(["0px", 1]);
        expect(yield* browser.use("Place the block", placement)).toEqual({
          belowNavigation: true,
          aboveDivider: true,
          scrolls: false,
        });
        expect(yield* browser.use("Read the links under the block", resources)).toEqual([
          true,
          true,
          true,
          true,
        ]);

        yield* browser.use("Open what's new", (page) =>
          opener(page)
            .focus()
            .then(() => page.keyboard.press("Enter"))
            .then(() => panel(page).waitFor()),
        );
        yield* browser.checkpoint("What's new panel");
        const readPanel = (page: Page) =>
          panel(page).evaluate((element) => ({
            description: element.querySelector("p")?.textContent,
            days: [...element.querySelectorAll(".release-notes-release")].map((group) => [
              group.querySelector("h3")?.textContent,
              ...[...group.querySelectorAll("li")].map((item) => item.textContent),
            ]),
            markup: element.querySelectorAll("b").length,
          }));
        const accepted = cloudTestNotes.notes.slice(1);
        const byDay = (notes: ReadonlyArray<{ readonly date: string; readonly text: string }>) =>
          [...new Set(notes.map((note) => note.date))].map((date) => [
            day(date),
            ...notes.filter((note) => note.date === date).map((note) => note.text),
          ]);
        expect(yield* browser.use("Read the panel", readPanel)).toEqual({
          description: "Changes to Executor Cloud in the last 30 days.",
          days: byDay(accepted),
          markup: 0,
        });
        expect(byDay(accepted)).toEqual([
          [
            "Nov 14, 2026",
            "The apps page no longer shows a blank list first.",
            "Apps open from the sidebar in one click.",
          ],
          ["Nov 12, 2026", "Search finds apps by the tools they offer."],
          ["Nov 3, 2026", "Members can leave an organization themselves."],
        ]);
        yield* browser.use("Close what's new", (page) =>
          page.keyboard.press("Escape").then(() => panel(page).waitFor({ state: "detached" })),
        );
        expect(
          yield* browser.use("Read the focused control", (page) =>
            page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null),
          ),
        ).toBe("Open what's new");

        yield* browser.use("Shorten the window", (page) =>
          page.setViewportSize({ width: 1280, height: 540 }),
        );
        expect(
          yield* browser.use("Check the short window", (page) =>
            Promise.all([opener(page).isVisible(), resources(page)]),
          ),
        ).toEqual([true, [true, true, true, true]]);
        yield* browser.checkpoint("What's new in a short window");
        yield* browser.use("Collapse the rail", (page) =>
          page
            .setViewportSize({ width: 900, height: 800 })
            .then(() => page.getByRole("button", { name: "Expand sidebar" }).waitFor()),
        );
        expect(
          yield* browser.use("Check the collapsed rail", (page) =>
            Promise.all([
              opener(page).count(),
              sidebar(page).locator(".sidebar-notice").count(),
              sidebar(page).getByRole("link", { name: "Docs", exact: true }).count(),
            ]),
          ),
        ).toEqual([0, 0, 1]);

        for (const time of ["2027-03-01T12:00:00Z", "2026-10-01T12:00:00Z"]) {
          yield* browser.use(`Open the dashboard at ${time}`, (page) =>
            page
              .setViewportSize({ width: 1280, height: 800 })
              .then(() => openAt(page, slug, time))
              .then(() => opener(page).waitFor()),
          );
          yield* browser.use(`Open the notes at ${time}`, (page) =>
            opener(page)
              .click()
              .then(() => panel(page).waitFor()),
          );
          expect((yield* browser.use(`Read the panel at ${time}`, readPanel)).days, time).toEqual(
            byDay(accepted),
          );
          yield* browser.use(`Close the notes at ${time}`, (page) =>
            page.keyboard.press("Escape").then(() => panel(page).waitFor({ state: "detached" })),
          );
        }

        yield* browser.login(actors.member);
        yield* browser.use("Open the member's dashboard", (page) =>
          openAt(page, slug, "2026-11-15T12:00:00Z").then(() => opener(page).waitFor()),
        );
        expect(yield* browser.use("Read the member's block", lines)).toEqual([
          "What's new",
          "Apps open from the sidebar in one click.",
        ]);
      }),
    ),
  );

  const fromCommits = (line: string, notes: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const browser = yield* Browser,
        actors = yield* Actors;
      yield* browser.login(actors.owner);
      yield* browser.use("Open the dashboard", (page) =>
        page
          .setViewportSize({ width: 1280, height: 800 })
          .then(() => openAt(page, actors.organization.slug, "2026-11-15T12:00:00Z"))
          .then(() => opener(page).waitFor()),
      );
      yield* browser.checkpoint("What's new in the sidebar");
      expect(yield* browser.use("Read the block", lines)).toEqual(["What's new", line]);
      yield* browser.use("Open what's new", (page) =>
        opener(page)
          .click()
          .then(() => panel(page).waitFor()),
      );
      yield* browser.checkpoint("What's new panel");
      const listed = yield* browser.use("Read the panel", (page) =>
        panel(page).evaluate((element) => ({
          days: element.querySelectorAll(".release-notes-release").length,
          notes: [...element.querySelectorAll("li")].map((item) => item.textContent),
          text: element.textContent ?? "",
        })),
      );
      expect(listed.days).toBe(1);
      expect(listed.notes).toEqual(notes);
      expect(listed.text).not.toMatch(/\b(?:Feature|Improvement|Fix):/iu);
    });

  it.effect(scenarios.cloudWhatsNewFixes.title, (context) =>
    withHostedCase(
      context,
      fromCommits("See recent changes to Executor Cloud.", [
        "The apps page no longer shows a blank list first.",
        "Search no longer drops the last result.",
      ]),
    ),
  );

  it.effect(scenarios.cloudWhatsNewFeature.title, (context) =>
    withHostedCase(
      context,
      fromCommits("Apps open from the sidebar in one click.", [
        "Apps open from the sidebar in one click.",
        "The apps page no longer shows a blank list first.",
        "Search finds apps by the tools they offer.",
      ]),
    ),
  );

  it.effect(scenarios.cloudWhatsNewEmpty.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          actors = yield* Actors;
        yield* browser.login(actors.owner);
        yield* browser.use("Open the dashboard", (page) =>
          page
            .setViewportSize({ width: 1280, height: 800 })
            .then(() => openAt(page, actors.organization.slug, "2026-11-15T12:00:00Z")),
        );
        yield* browser.checkpoint("No what's new in the sidebar");
        expect(
          yield* browser.use("Check the sidebar has no notes", (page) =>
            Promise.all([
              opener(page).count(),
              sidebar(page).locator(".sidebar-update").count(),
              sidebar(page).locator(".sidebar-notice").count(),
            ]),
          ),
        ).toEqual([0, 0, 0]);
        expect(yield* browser.use("Read the links", resources)).toEqual([true, true, true, true]);
      }),
    ),
  );
});
