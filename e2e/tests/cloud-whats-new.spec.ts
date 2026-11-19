/**
 * Cloud's "What's new" in the sidebar, above the resource links, which stay: the notes of the
 * changes that reached Cloud in the 30 days before the deployed commit, which the deploy writes and
 * the dashboard's build takes. The scenarios' local Cloud builds it with fixed notes
 * (e2e/support/cloud-release-notes.ts), so the block, its panel and its layout are checked against
 * the same notes whatever main's history holds. The block leads with the newest note its writer
 * called a feature or an improvement, never a newer fix, and the panel lists every note, fixes
 * included; which notes the deploy writes from that history is
 * the release notes cases' to check (`release-notes.spec.ts`), and a build without notes the
 * dashboard build cases' (`dashboard-file-names.spec.ts`). The browser's clock is set, and shown
 * to change nothing. A local Cloud of its own builds the dashboard with an empty notes file, as a
 * deploy whose window has no notes does (`e2e:cloud --release-notes empty`). Two more build it
 * with notes the deploy's own notes script writes from commit messages (`cloudChanges`), so the
 * kind words are cut where a deploy cuts them: one whose notes are all fixes, one marked `Fix:`
 * and one unmarked, shows a plain line (`--release-notes fixes`), and one whose newest note is a
 * feature leads with it (`--release-notes feature`).
 */
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

/** The block's lines, top to bottom. */
const lines = (page: Page) =>
  sidebar(page)
    .locator(".sidebar-update")
    .innerText()
    .then((text) => text.split("\n").filter((line) => line.trim() !== ""));

/** Which of the sidebar's resource links and its support trigger a person sees. */
const resources = (page: Page) =>
  Promise.all([
    ...["Docs", "Feedback", "Star on GitHub"].map((name) =>
      sidebar(page).getByRole("link", { name, exact: true }).isVisible(),
    ),
    sidebar(page).getByRole("button", { name: "Get support" }).isVisible(),
  ]);

/** Whether the block sits below the navigation and above the divider over the links. */
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

/** Open the dashboard as it would be at `time` by the browser's clock. */
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

        // Self-host has no Cloud notes: no block and no space kept for one.
        if (target.metadata.target !== "cloud") {
          expect(
            yield* browser.use("Check the sidebar has no notes", (page) =>
              Promise.all([opener(page).count(), sidebar(page).locator(".sidebar-notice").count()]),
            ),
          ).toEqual([0, 0]);
          return;
        }

        // The block: a "What's new" tag and the newest feature or improvement the allow-list
        // accepts, not the newer fix above it, as one button with no card around it, below the
        // navigation and above the divider. The resource links
        // and the support trigger stay under it: only an update takes their place.
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

        // It opens every note by the day it reached Cloud, newest first, as text, the fix the block
        // passed over included and without the refused line, and Escape returns focus to it.
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

        // The shortest window still shows it, with the links, as the sidebar scrolls.
        yield* browser.use("Shorten the window", (page) =>
          page.setViewportSize({ width: 1280, height: 540 }),
        );
        expect(
          yield* browser.use("Check the short window", (page) =>
            Promise.all([opener(page).isVisible(), resources(page)]),
          ),
        ).toEqual([true, [true, true, true, true]]);
        yield* browser.checkpoint("What's new in a short window");
        // The collapsed rail has no room for it and keeps its links.
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

        // The browser's clock decides nothing: a deploy writes the notes of the 30 days before its
        // commit, and Cloud deploys every merge, so the build's notes are what is new. Months
        // later, or before the notes' own days, the same notes show.
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

        // Every member sees it, not only owners and admins.
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

  /**
   * The block and the panel of a Cloud built with `cloudChanges[source]`: the block's line is
   * `line`, and the panel lists `notes`, every change's note newest first as the text after its
   * kind word.
   */
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
      // The changes merged today, so their notes are one day's, and no kind word reaches the
      // dashboard.
      expect(listed.days).toBe(1);
      expect(listed.notes).toEqual(notes);
      expect(listed.text).not.toMatch(/\b(?:Feature|Improvement|Fix):/iu);
    });

  it.effect(scenarios.cloudWhatsNewFixes.title, (context) =>
    withHostedCase(
      context,
      // Neither fix leads, the one marked Fix: nor the unmarked one: the block says to look.
      fromCommits("See recent changes to Executor Cloud.", [
        "The apps page no longer shows a blank list first.",
        "Search no longer drops the last result.",
      ]),
    ),
  );

  it.effect(scenarios.cloudWhatsNewFeature.title, (context) =>
    withHostedCase(
      context,
      // The newest note is a feature, so it leads, without the Feature: its writer put before it.
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
        // A deploy whose window has no notes writes a file with none: no block, and no frame kept
        // for one, while the resource links and the support trigger stay.
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
