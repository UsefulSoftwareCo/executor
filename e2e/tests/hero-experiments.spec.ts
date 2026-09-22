import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

const readHero = Effect.gen(function* () {
  const browser = yield* Browser;
  yield* browser.use("Hero is visible", (page) =>
    page.locator("[data-hero-variant]").waitFor({ state: "visible" }),
  );
  const variant = yield* browser.use("Read the rendered assignment", (page) =>
    page.locator("[data-hero-variant]").getAttribute("data-hero-variant"),
  );
  const headline = yield* browser.use("Read the rendered headline", (page) =>
    page.locator("[data-hero-variant] h1").innerText(),
  );
  return { variant, headline };
});

layer(TestLive, { excludeTestServices: true })("Hero experiments", (it) => {
  it.effect(scenarios.heroExperiments.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        yield* browser.use("Block scripts before navigation", (page) =>
          page.route("**/*", (route) =>
            route.request().resourceType() === "script" ? route.abort() : route.continue(),
          ),
        );
        const response = yield* browser.use("Open the server-rendered homepage", (page) =>
          page.goto("/"),
        );
        if (response === null) return yield* Effect.die("Missing document response");
        yield* browser.use("Dismiss the early preview notice", (page) =>
          page.getByRole("button", { name: "Got it", exact: true }).click(),
        );
        const html = yield* browser.use("Read the original HTML", () => response.text());
        const initial = yield* readHero;
        expect(initial.variant).toMatch(/^(category|outcome)-(intent|build)$/);
        expect(html).toContain(`data-hero-variant="${initial.variant}"`);
        expect(html).toContain(initial.headline);
        expect(response.headers()["cache-control"]).toContain("no-store");
        yield* browser.checkpoint("Server-rendered hero before any scripts");
        yield* browser.use("Allow scripts", (page) => page.unroute("**/*"));
        yield* browser.use("Reload the same assignment", (page) => page.reload());
        expect(yield* readHero).toEqual(initial);
        yield* browser.use("Use a mobile viewport", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        for (const variant of [
          "category-intent",
          "category-build",
          "outcome-intent",
          "outcome-build",
        ]) {
          const preview = yield* browser.use(`Preview ${variant}`, (page) =>
            page.goto(`/?hero=${variant}`),
          );
          expect((yield* readHero).variant).toBe(variant);
          const steps = yield* browser.use("The hero has three steps", (page) =>
            page.locator("[data-hero-variant] ol > li").count(),
          );
          expect(steps).toBe(variant.endsWith("-intent") ? 0 : 3);
          expect(preview?.headers()["x-robots-tag"]).toBe("noindex");
          yield* browser.checkpoint(`Mobile hero ${variant}`);
        }
        yield* browser.use("Return from previews", (page) => page.goto("/"));
        expect((yield* readHero).variant).toBe(initial.variant);
      }),
    ),
  );
});
