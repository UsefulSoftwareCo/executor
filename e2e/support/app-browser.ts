/** Synthetic apps and browser journeys exercise public products, never UI implementations. */
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { Browser } from "./browser.ts";
import { holdQuery, refreshVisiblePage } from "./query-transition.ts";

/** A small deployed app exposes static documents, dynamic workflows, data and a private page. */
export const appBrowserFiles = [
  {
    path: "index.ts",
    content: `import { defineApp, defineDatabase, table, string, query, workflow, object } from "apps";
const database = defineDatabase({ notes: table({ text: string() }) });
export default defineApp({ accounts: {}, database }, {
  queries: { hello: query({ input: object({}) }, async () => "Hello") },
  workflows: {
    report: workflow({ description: "Prepare a small report", input: object({}), output: object({ message: string() }) }, async (ctx) => ctx.step.do("compose", async () => ({ message: "Report ready" }))),
    wait: workflow({ input: object({}) }, async (ctx) => { await ctx.step.sleep("hold", "1 day"); return null; }),
  },
});`,
  },
  {
    path: "skills/report/SKILL.md",
    content:
      "---\nname: report\ndescription: Learn how to prepare reports.\n---\n# Prepare reports\nRead [the example](references/example.md).\n",
  },
  {
    path: "skills/report/references/example.md",
    content: "# Reference version one\nUse a clear title.\n",
  },
  {
    path: "skills/report/scripts/example.ts",
    content: "throw new Error('This script must never run');",
  },
  {
    path: "skills/other/SKILL.md",
    content: "---\nname: other\ndescription: Another guide.\n---\n# Another guide\n",
  },
  {
    path: "ui/index.html",
    content:
      "<!doctype html><html><head><title>Example</title></head><body><h1>Example app</h1></body></html>",
  },
];

/** Hold and fail actual HTTP reads while preserving the user's selected file. */
export const checkAppBrowser = (input: {
  readonly url: string;
  readonly listUrl: string;
  readonly name: string;
  readonly readPaths: readonly string[];
  readonly deployment: string;
}) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const catalog = yield* holdQuery(
      input.readPaths.map((path) => `${path}/skill-bundle`),
      "continue",
      { allRequests: true },
    );
    yield* browser.use("Open Skills while its catalog is loading", (page) =>
      page.goto(`${input.url}?view=skills`),
    );
    yield* catalog.requested;
    expect(
      yield* browser.use("Skills loading matches the reader", (page) =>
        page
          .getByRole("status", { name: "Loading skills", exact: true })
          .locator("[data-slot=skeleton]")
          .count(),
      ),
    ).toBeGreaterThan(4);
    yield* browser.use("Skills owns the loading region", (page) =>
      page.getByRole("status").filter({ hasText: "Loading skills" }).waitFor({ state: "visible" }),
    );
    expect(
      yield* browser.use("App navigation remains usable", (page) =>
        page.getByRole("navigation", { name: "App navigation" }).isVisible(),
      ),
    ).toBe(true);
    yield* browser.checkpoint("Skills loading inside the app frame");
    yield* catalog.release;
    yield* browser.use("The skill bundle has loaded", (page) =>
      page.getByRole("navigation", { name: "Skills", exact: true }).waitFor({ state: "visible" }),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const guard = yield* holdQuery(
          input.readPaths.flatMap((path) => [
            `${path}/skill-bundle`,
            `${path}/skills/report`,
            `${path}/skills/other`,
          ]),
          "fail",
          { allRequests: true },
        );
        yield* guard.release;
        yield* browser.use("Choose the report skill", (page) =>
          page
            .getByRole("navigation", { name: "Skills", exact: true })
            .getByRole("button")
            .filter({ hasText: "report" })
            .click(),
        );
        yield* browser.use("Read rendered instructions", (page) =>
          page
            .getByRole("heading", { name: "Prepare reports", exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.use("Follow an in-skill reference", (page) =>
          page.getByRole("button", { name: "the example", exact: true }).click(),
        );
        yield* browser.use("Read the reference", (page) =>
          page
            .getByRole("heading", { name: "Reference version one" })
            .waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("Reference selection is retained", (page) =>
            page.getByLabel("Current skill file").textContent(),
          ),
        ).toBe("example.md");
        yield* browser.use("Switch to another already-loaded skill", (page) =>
          page
            .getByRole("navigation", { name: "Skills", exact: true })
            .getByRole("button")
            .filter({ hasText: "other" })
            .click(),
        );
        yield* browser.use("The other document needs no request", (page) =>
          page
            .getByRole("heading", { name: "Another guide", exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.use("Return to the report skill", (page) =>
          page
            .getByRole("navigation", { name: "Skills", exact: true })
            .getByRole("button")
            .filter({ hasText: "report" })
            .click(),
        );
        yield* browser.use("Open a preloaded script", (page) =>
          page.getByRole("button", { name: /^Files / }).click(),
        );
        yield* browser.use("Select the script", (page) =>
          page.getByRole("menuitemradio", { name: "scripts/example.ts", exact: true }).click(),
        );
        yield* browser.use("The script is text without another read", (page) =>
          page
            .getByText("This script must never run", { exact: false })
            .waitFor({ state: "visible" }),
        );
        yield* browser.use("Return to instructions", (page) =>
          page.getByRole("button", { name: "Back to instructions" }).click(),
        );
        yield* browser.use("Restore the reference selection", (page) =>
          page.getByRole("button", { name: "the example", exact: true }).click(),
        );
        expect(
          yield* browser.use("Preloaded navigation has no read failure", (page) =>
            page.getByRole("alert").count(),
          ),
        ).toBe(0);
      }),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const failure = yield* holdQuery(
          input.readPaths.map((path) => `${path}/skill-bundle`),
          "fail",
          { allRequests: true },
        );
        yield* refreshVisiblePage;
        yield* failure.requested;
        yield* browser.checkpoint("Reference remains visible during refresh");
        yield* failure.release;
        yield* browser.use("Show the read failure alongside the reference", (page) =>
          page.getByRole("alert").first().waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("Failed refresh preserves the selected file", (page) =>
            page.getByLabel("Current skill file").textContent(),
          ),
        ).toBe("example.md");
        expect(
          yield* browser.use("Failed refresh preserves the document", (page) =>
            page.getByRole("heading", { name: "Reference version one" }).isVisible(),
          ),
        ).toBe(true);
      }),
    );
    const recovery = yield* holdQuery(
      input.readPaths.map((path) => `${path}/skill-bundle`),
      "continue",
      { allRequests: true },
    );
    yield* refreshVisiblePage;
    yield* recovery.requested;
    yield* recovery.release;
    yield* browser.use("Read failure clears after recovery", (page) =>
      page.getByRole("alert").first().waitFor({ state: "hidden" }),
    );
    yield* browser.use("Inspect a bundled script without running it", (page) =>
      page.getByRole("button", { name: /^Files / }).click(),
    );
    yield* browser.use("Choose the script file", (page) =>
      page.getByRole("menuitemradio", { name: "scripts/example.ts", exact: true }).click(),
    );
    yield* browser.use("The script is displayed as text", (page) =>
      page.getByText("This script must never run", { exact: false }).waitFor({ state: "visible" }),
    );
    yield* browser.use("Return to the instructions", (page) =>
      page.getByRole("button", { name: "Back to instructions" }).click(),
    );
    yield* browser.use("Open the reference again", (page) =>
      page.getByRole("button", { name: "the example", exact: true }).click(),
    );
    yield* browser.checkpoint("Skill reference reader");
    yield* browser.use("Open workflow definitions", (page) =>
      page
        .getByRole("navigation", { name: "App navigation" })
        .getByRole("link", { name: "Workflows", exact: true })
        .click(),
    );
    yield* browser.use("Recent runs are the first workflow view", (page) =>
      page.getByRole("heading", { name: "Recent runs", exact: true }).waitFor({ state: "visible" }),
    );
    expect(
      yield* browser.use("Workflows does not show schemas or code", (page) =>
        page.getByRole("region", { name: "App workflows" }).locator("pre").count(),
      ),
    ).toBe(0);
    yield* browser.use("Choose a workflow by its description", (page) =>
      page
        .getByRole("navigation", { name: "Workflows", exact: true })
        .getByRole("button")
        .filter({ hasText: "Prepare a small report" })
        .click(),
    );
    yield* browser.use("Show what the workflow does", (page) =>
      page
        .getByRole("region", { name: "Workflow run history" })
        .getByText("Prepare a small report", { exact: true })
        .first()
        .waitFor({ state: "visible" }),
    );
    yield* browser.use("Choose a completed run", (page) =>
      page.getByRole("button", { name: "View report run: Complete", exact: true }).first().click(),
    );
    yield* browser.use("Read the actual run output", (page) =>
      page.getByText("Report ready", { exact: false }).waitFor({ state: "visible" }),
    );
    expect(
      yield* browser.use("Run information is not shown", (page) =>
        page.getByText("Run information", { exact: true }).count(),
      ),
    ).toBe(0);
    expect(
      yield* browser.use("Deployment identifiers are not shown", (page) =>
        page.getByRole("region", { name: "Workflow run details" }).textContent(),
      ),
    ).not.toContain(input.deployment);
    expect(
      yield* browser.use("Run results remain readable without code blocks", (page) =>
        page.getByRole("region", { name: "Workflow run details" }).locator("pre").count(),
      ),
    ).toBe(0);
    yield* browser.checkpoint("Workflow runs and readable result");
    yield* browser.use("Filter to a workflow without runs", (page) =>
      page
        .getByRole("navigation", { name: "Workflows", exact: true })
        .getByRole("button", { name: "wait", exact: true })
        .click(),
    );
    yield* browser.use("The workflow has an explicit empty history", (page) =>
      page.getByRole("heading", { name: "No runs yet", exact: true }).waitFor({ state: "visible" }),
    );
    yield* browser.use("Return to all runs", (page) =>
      page.getByRole("button", { name: "All runs", exact: true }).click(),
    );
    yield* browser.use("The completed run returns", (page) =>
      page
        .getByRole("button", { name: "View report run: Complete", exact: true })
        .waitFor({ state: "visible" }),
    );
    yield* browser.use("Open the app overview", (page) =>
      page
        .getByRole("navigation", { name: "App navigation" })
        .getByRole("link", { name: "Overview", exact: true })
        .click(),
    );
    yield* browser.use("Overview lists actual skills", (page) =>
      page
        .getByRole("region", { name: "App skills preview" })
        .getByText("Learn how to prepare reports.", { exact: true })
        .waitFor({ state: "visible" }),
    );
    yield* browser.use("Overview lists actual workflows", (page) =>
      page
        .getByRole("region", { name: "App workflows preview" })
        .getByText("Prepare a small report", { exact: true })
        .waitFor({ state: "visible" }),
    );
    yield* browser.use("Overview tools have loaded", (page) =>
      page
        .getByRole("region", { name: "App tools preview" })
        .getByText("queries.hello", { exact: true })
        .waitFor({ state: "visible" }),
    );
    expect(
      yield* browser.use("Overview has no capability badges", (page) =>
        page.getByLabel("App capabilities", { exact: true }).count(),
      ),
    ).toBe(0);
    expect(
      yield* browser.use("Overview has no duplicate subheading", (page) =>
        page.getByRole("heading", { name: "Overview", level: 2, exact: true }).count(),
      ),
    ).toBe(0);
    const cards = yield* browser.use(
      "Empty and populated overview cards keep the same height",
      (page) =>
        page.locator(".app-overview > div > section").evaluateAll((cards) =>
          cards.map((card) => ({
            height: card.getBoundingClientRect().height,
            empty: card.querySelector(".empty-state") !== null,
          })),
        ),
    );
    expect(cards.length).toBeGreaterThanOrEqual(4);
    expect(cards.some((card) => card.empty)).toBe(true);
    expect(cards.some((card) => !card.empty)).toBe(true);
    for (const card of cards) {
      expect(card.height).toBe(320);
    }
    yield* browser.checkpoint("Overview with skills and workflows");
    yield* browser.use("Open Skills from its Overview card", (page) =>
      page
        .getByRole("region", { name: "App skills preview" })
        .getByRole("link", { name: "View all", exact: true })
        .click(),
    );
    yield* browser.use("Skills card opens the reader", (page) =>
      page.getByRole("navigation", { name: "Skills", exact: true }).waitFor({ state: "visible" }),
    );
    yield* browser.use("Return to Overview", (page) =>
      page
        .getByRole("navigation", { name: "App navigation" })
        .getByRole("link", { name: "Overview", exact: true })
        .click(),
    );
    yield* browser.use("Open Workflows from its Overview card", (page) =>
      page
        .getByRole("region", { name: "App workflows preview" })
        .getByRole("link", { name: "View all", exact: true })
        .click(),
    );
    yield* browser.use("Workflows card opens recent runs", (page) =>
      page.getByRole("heading", { name: "Recent runs", exact: true }).waitFor({ state: "visible" }),
    );
    yield* browser.use("Open the app list", (page) => page.goto(input.listUrl));
    yield* browser.use("The app card is ready", (page) =>
      page
        .getByRole("link", { name: `Open ${input.name}`, exact: true })
        .waitFor({ state: "visible" }),
    );
    expect(
      yield* browser.use("App cards do not show capability badges", (page) =>
        page
          .getByRole("link", { name: `Open ${input.name}`, exact: true })
          .getByLabel("App capabilities", { exact: true })
          .count(),
      ),
    ).toBe(0);
    yield* browser.checkpoint("Simple app cards");
    yield* browser.use("Use a mobile viewport", (page) =>
      page.setViewportSize({ width: 390, height: 844 }),
    );
    yield* browser.use("Read the app card on mobile", (page) =>
      page.getByRole("link", { name: `Open ${input.name}`, exact: true }).click(),
    );
    yield* browser.use("Open Skills on mobile", (page) =>
      page
        .getByRole("navigation", { name: "App navigation" })
        .getByRole("link", { name: "Skills", exact: true })
        .click(),
    );
    yield* browser.use("Choose the report skill on mobile", (page) =>
      page
        .getByRole("navigation", { name: "Skills", exact: true })
        .getByRole("button")
        .filter({ hasText: "report" })
        .click(),
    );
    yield* browser.use("Mobile reader loads", (page) =>
      page
        .getByRole("heading", { name: "Prepare reports", exact: true })
        .waitFor({ state: "visible" }),
    );
    expect(
      yield* browser.use("The page fits the viewport", (page) =>
        page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ),
    ).toBe(true);
    yield* browser.checkpoint("Mobile skill reader");
  });
