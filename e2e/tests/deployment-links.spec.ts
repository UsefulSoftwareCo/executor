import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Deployment links", (it) => {
  it.effect(scenarios.deploymentLinks.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const actors = yield* Actors;
        const { metadata } = yield* Target;
        const origin = metadata.origin;
        yield* browser.use("Open the public homepage", (page) => page.goto("/home"));
        yield* browser.use("Dismiss the early preview notice", (page) =>
          page.getByRole("button", { name: "Got it", exact: true }).click(),
        );
        const prompt = yield* browser.use("Read the copied setup prompt", (page) =>
          page.locator("button[data-copy]").first().getAttribute("data-copy"),
        );
        expect(prompt).toContain(`${origin}/login`);
        expect(prompt).toContain(`${origin}/docs`);
        expect(
          yield* browser.use("Read the self-hosting guide link", (page) =>
            page.getByRole("link", { name: "Self-hosting docs", exact: true }).getAttribute("href"),
          ),
        ).toBe("/docs/run/self-host");

        for (const path of [
          "/setup-prompt.md",
          "/index.md",
          "/pricing.md",
          "/llms.txt",
          "/docs/llms.txt",
        ]) {
          const response = yield* browser.use(`Fetch ${path}`, (page) => page.request.get(path));
          const text = yield* browser.use(`Read ${path}`, () => response.text());
          expect(response.status()).toBe(200);
          expect(text).toContain(`${origin}/docs`);
          expect(text).not.toMatch(/https:\/\/executor\.sh(?:\/|\b)/);
          if (path === "/setup-prompt.md" || path === "/pricing.md")
            expect(text).toContain(`${origin}/login`);
        }
        yield* browser.use("Follow the current self-hosting guide", (page) =>
          page.getByRole("link", { name: "Self-hosting docs", exact: true }).click(),
        );
        expect(
          yield* browser.use("Read the current guide heading", (page) =>
            page.locator("h1").innerText(),
          ),
        ).toBe("Self-host with Docker");

        yield* browser.login(actors.owner);
        yield* browser.use("Open API keys", (page) =>
          page.goto(`/org/${actors.organization.slug}/api-keys`),
        );
        expect(
          yield* browser.use("Read desktop dashboard Docs destination", (page) =>
            page.getByRole("link", { name: "Docs", exact: true }).getAttribute("href"),
          ),
        ).toBe("/docs/");
        yield* browser.use("Open token creation help", (page) =>
          page.getByRole("button", { name: "Create token", exact: true }).click(),
        );
        expect(
          yield* browser.use("Read token documentation destination", (page) =>
            page.locator('a[href*="api-keys/#personal-access-tokens"]').getAttribute("href"),
          ),
        ).toBe("/docs/api-keys/#personal-access-tokens");
        yield* browser.use("Close token creation", (page) => page.keyboard.press("Escape"));
        yield* browser.use("Use a mobile viewport", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        yield* browser.use("Open the mobile menu", (page) =>
          page.getByRole("button", { name: "Menu", exact: true }).click(),
        );
        expect(
          yield* browser.use("Read mobile dashboard Docs destination", (page) =>
            page
              .getByRole("dialog")
              .getByRole("link", { name: "Docs", exact: true })
              .getAttribute("href"),
          ),
        ).toBe("/docs/");
      }),
    ),
  );
});
