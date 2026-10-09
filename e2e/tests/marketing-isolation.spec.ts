/** The deployed public site must not run in the API Worker's remote placement. */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { driver, Target } from "../support/platform.ts";
import { rawRequest, targetHosts } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";

const read = (url: string) =>
  driver("Read public site and placement", (signal) =>
    fetch(url, { redirect: "manual", signal }),
  ).pipe(
    Effect.flatMap((response) =>
      driver("Read public document", () => response.text()).pipe(
        Effect.map((text) => ({
          status: response.status,
          placement: response.headers.get("cf-placement"),
          cacheControl: response.headers.get("cache-control"),
          cookies: response.headers.getSetCookie(),
          text,
        })),
      ),
    ),
  );

layer(TestLive, { excludeTestServices: true })("Marketing isolation", (it) => {
  it.effect(scenarios.marketingIsolation.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { edge } = targetHosts(yield* Target);
        const home = yield* read(`${edge}/`);
        expect(home.status).toBe(200);
        expect(
          home.placement === null || home.placement.startsWith("local-"),
          `Homepage placement: ${home.placement}`,
        ).toBe(true);
        // The homepage is a plain static page: no cookies, cached like the site's other pages.
        expect(home.cookies).toEqual([]);
        const pricing = yield* read(`${edge}/pricing`);
        expect(pricing.status).toBe(200);
        expect(home.cacheControl).toBe(pricing.cacheControl);
        expect(home.text).toContain(`<link rel="canonical" href="${edge}/"`);
        const stylesheet = home.text.match(/href="(\/_astro\/[^"]+\.css)"/)?.[1];
        expect(stylesheet).toBeDefined();
        if (stylesheet === undefined) return yield* Effect.die("Homepage has no stylesheet");
        for (const path of [stylesheet, "/pricing", "/docs/mcp.md"]) {
          const response = yield* read(`${edge}${path}`);
          expect(response.status, path).toBe(200);
          expect(
            response.placement === null || response.placement.startsWith("local-"),
            `${path} placement: ${response.placement}`,
          ).toBe(true);
        }
        // Dynamic public endpoints still reach their owning API handler through the gateway.
        const skills = yield* rawRequest(`${edge}/.well-known/agent-skills/index.json`);
        expect(skills.status).toBe(200);
        expect(skills.contentType).toContain("application/json");
        for (const path of ["/login", "/privacy", "/terms", "/google-oauth"])
          expect((yield* rawRequest(`${edge}${path}`)).status, path).toBe(404);
        const browser = yield* Browser;
        yield* browser.use("Open the isolated marketing homepage", (page) => page.goto(edge));
        yield* browser.use("Homepage renders its headline", (page) =>
          page.getByRole("heading", { level: 1 }).waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("Marketing served at the edge");
      }),
    ),
  );
});
