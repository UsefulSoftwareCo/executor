/**
 * Cloud's public site is served for requests at the edge (standing in for `executor.sh`, which
 * v1 forwards to v2). Its canonical URLs name the edge, its sign-in links open the browser origin,
 * and the deployment and browser origins send their site pages there. The published skills index
 * is not a page: installed apps store its URL on the host they were installed with, so every host
 * keeps serving it.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { TestLive, withCase, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { rawRequest, targetHosts } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";

const html = { headers: { accept: "text/html" } };
const skillsIndex = "/.well-known/agent-skills/index.json";
const Bundle = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
    }),
  ),
});

layer(TestLive, { excludeTestServices: true })("Cloud site on the edge", (it) => {
  it.effect(scenarios.cloudSiteEdge.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const hosts = targetHosts(yield* Target);
        const { edge, browser: app, deployment } = hosts;

        // The edge serves the homepage itself, never a redirect, with its canonical URL there.
        const home = yield* rawRequest(`${edge}/`, html);
        expect(home.status).toBe(200);
        // A static page: it sets no cookies.
        expect(home.setCookies).toEqual([]);
        expect(home.text).toContain(`<link rel="canonical" href="${edge}/"`);
        // Sign-in and sign-up open the browser origin.
        expect(home.text).toContain(`href="${app}/login?mode=signup"`);
        expect(home.text).not.toContain('href="/login');

        // Pages, docs and their Markdown come from the site's files with their own headers.
        for (const path of ["/pricing", "/docs", "/docs/mcp", "/blog", "/setup-prompt.md"]) {
          const page = yield* rawRequest(`${edge}${path}`, html);
          expect(page.status, path).toBe(200);
        }
        const pricing = yield* rawRequest(`${edge}/pricing`, html);
        expect(pricing.text).toContain(`<link rel="canonical" href="${edge}/pricing`);
        // The homepage is cached like every other site page.
        expect(home.cacheControl).toBe(pricing.cacheControl);
        expect(pricing.text).toContain(`href="${app}/login?mode=signup"`);
        const markdown = yield* rawRequest(`${edge}/docs/mcp.md`);
        expect(markdown.status).toBe(200);
        expect(markdown.contentType).toContain("text/markdown");
        const skills = yield* rawRequest(`${edge}${skillsIndex}`);
        expect(skills.status).toBe(200);
        // Demos live under `/experiments`, which v1 forwards; `/demo` is a v1 organization.
        expect((yield* rawRequest(`${edge}/experiments/demo/posthog`, html)).status).toBe(200);
        // Pages v1 keeps are not served for the edge: its sign-in and its Google OAuth
        // verification pages. (Static files reach a local Cloud's assets on any host, so
        // `/demo` and the favicons are held to v1 by the contract v1 tests, not here.)
        for (const path of ["/login", "/privacy", "/terms", "/google-oauth"])
          expect((yield* rawRequest(`${edge}${path}`, html)).status, path).toBe(404);
        // An old demo link on the deployment origin finds the demo's new path.
        const demo = yield* rawRequest(`${deployment}/demo/posthog`, html);
        expect(demo.status).toBe(301);
        expect(new URL(demo.location ?? "", deployment).pathname).toBe("/experiments/demo/posthog");

        // The deployment origin sends its site to the edge, path and query intact, and its
        // homepage there for a browser without a session.
        for (const path of ["/", "/pricing?ref=nav", "/docs/mcp", "/blog"]) {
          const moved = yield* rawRequest(`${deployment}${path}`, html);
          expect(moved.status, path).toBe(308);
          expect(moved.location, path).toBe(`${edge}${path}`);
        }
        // So does the browser origin, whose homepage is sign-in for a visitor without a session.
        const appPricing = yield* rawRequest(`${app}/pricing`, html);
        expect(appPricing.status).toBe(308);
        expect(appPricing.location).toBe(`${edge}/pricing`);
        const appHome = yield* rawRequest(`${app}/`, html);
        expect(appHome.status).toBe(307);
        expect(appHome.location).toBe(`${app}/login`);
        // The site's static files load from any host.
        const style = home.text.match(/href="(\/_astro\/[^"]+\.css)"/)?.[1];
        expect(style).toBeDefined();
        for (const at of [edge, deployment])
          expect((yield* rawRequest(`${at}${style}`)).status, at).toBe(200);
      }),
    ),
  );
  it.effect(scenarios.cloudSkillsIndexHosts.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const { edge, browser: app, deployment } = targetHosts(yield* Target);

        // The deployment and browser origins answer the index themselves, as the edge does, and
        // never with a redirect: an app's skill read does not follow one.
        const published = yield* rawRequest(`${edge}${skillsIndex}`);
        expect(published.status).toBe(200);
        for (const at of [deployment, app]) {
          const index = yield* rawRequest(`${at}${skillsIndex}`);
          expect(index.status, at).toBe(200);
          expect(index.location, at).toBeNull();
          expect(index.text, at).toBe(published.text);
        }

        // An Executor app installed before the role hosts names the deployment origin's index.
        // An app with that URL loads its skills there.
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Deployment origin skills ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, dynamicSkills, query, object, router } from "apps";
import { wellKnownSkills } from "apps/skills";
export default defineApp({ accounts: {} }, async (ctx) => ({
  tools: router({ ping: query({ input: object({}) }, async () => "pong") }),
  dynamicSkills: dynamicSkills({ list: () => wellKnownSkills({ url: ${JSON.stringify(`${deployment}${skillsIndex}`)}, cache: ctx.cache, fetch: ctx.fetch, signal: ctx.signal }) }),
}));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const installed = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${installed.id}`).pipe(Effect.orDie),
        );
        const bundle = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/${installed.id}/skill-bundle`,
        );
        expect(bundle.status, JSON.stringify(bundle.body)).toBe(200);
        const { skills } = yield* body(Bundle, bundle);
        expect(skills.map((skill) => skill.name)).toContain("executor");
        expect(
          skills
            .find((skill) => skill.name === "executor")
            ?.files.find((file) => file.path === "SKILL.md")?.content,
        ).toMatch(/^---\nname: executor\n/);
      }),
    ),
  );
});
