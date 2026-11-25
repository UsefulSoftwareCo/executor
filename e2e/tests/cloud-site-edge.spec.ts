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

        const home = yield* rawRequest(`${edge}/`, html);
        expect(home.status).toBe(200);
        expect(home.setCookies).toEqual([]);
        expect(home.text).toContain(`<link rel="canonical" href="${edge}/"`);
        expect(home.text).toContain(`href="${app}/login?mode=signup"`);
        expect(home.text).not.toContain('href="/login');

        for (const path of ["/pricing", "/docs", "/docs/mcp", "/blog", "/setup-prompt.md"]) {
          const page = yield* rawRequest(`${edge}${path}`, html);
          expect(page.status, path).toBe(200);
        }
        const pricing = yield* rawRequest(`${edge}/pricing`, html);
        expect(pricing.text).toContain(`<link rel="canonical" href="${edge}/pricing`);
        expect(home.cacheControl).toBe(pricing.cacheControl);
        expect(pricing.text).toContain(`href="${app}/login?mode=signup"`);
        const markdown = yield* rawRequest(`${edge}/docs/mcp.md`);
        expect(markdown.status).toBe(200);
        expect(markdown.contentType).toContain("text/markdown");
        const skills = yield* rawRequest(`${edge}${skillsIndex}`);
        expect(skills.status).toBe(200);
        expect((yield* rawRequest(`${edge}/experiments/demo/posthog`, html)).status).toBe(200);
        const signIn = yield* rawRequest(`${edge}/login`, html);
        expect(signIn.status).toBe(302);
        expect(signIn.location).toBe(`${app}/login`);
        for (const path of ["/privacy", "/terms", "/google-oauth"])
          expect((yield* rawRequest(`${edge}${path}`, html)).status, path).toBe(200);
        const demo = yield* rawRequest(`${deployment}/demo/posthog`, html);
        expect(demo.status).toBe(301);
        expect(new URL(demo.location ?? "", deployment).pathname).toBe("/experiments/demo/posthog");

        for (const path of ["/", "/pricing?ref=nav", "/docs/mcp", "/blog"]) {
          const moved = yield* rawRequest(`${deployment}${path}`, html);
          expect(moved.status, path).toBe(308);
          expect(moved.location, path).toBe(`${edge}${path}`);
        }
        const appPricing = yield* rawRequest(`${app}/pricing`, html);
        expect(appPricing.status).toBe(308);
        expect(appPricing.location).toBe(`${edge}/pricing`);
        const appHome = yield* rawRequest(`${app}/`, html);
        expect(appHome.status).toBe(307);
        expect(appHome.location).toBe(`${app}/login`);
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

        const published = yield* rawRequest(`${edge}${skillsIndex}`);
        expect(published.status).toBe(200);
        for (const at of [deployment, app]) {
          const index = yield* rawRequest(`${at}${skillsIndex}`);
          expect(index.status, at).toBe(200);
          expect(index.location, at).toBeNull();
          expect(index.text, at).toBe(published.text);
        }

        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Deployment origin skills ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, dynamicSkills, query, object, router } from "apps";
import { wellKnownSkills } from "apps/skills";
export default defineApp({}, async (ctx) => ({
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
