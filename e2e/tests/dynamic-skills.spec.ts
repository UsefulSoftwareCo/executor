/** Dynamic skill freshness through the real app compiler, runtime, HTTP, MCP and browser. */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { App } from "../support/contracts.ts";
import { Browser } from "../support/browser.ts";
import { McpClient } from "../support/mcp-client.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { skillUpstream } from "../support/skill-upstream.ts";
import { createProfile } from "../support/profiles.ts";

const Bundle = Schema.Struct({
  deployment: Schema.String,
  revision: Schema.String,
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
    }),
  ),
});
layer(HostedLive, { excludeTestServices: true })("Dynamic skills", (it) => {
  it.effect(scenarios.dynamicSkills.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const upstream = yield* skillUpstream;
        const mcp = yield* McpClient,
          oauth = yield* McpOAuth;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Dynamic skills ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, dynamicSkills, query, object } from "apps";
import { githubSkills, wellKnownSkills } from "apps/skills";
export default defineApp({ accounts: {} }, async (ctx) => ({
  queries: { ping: query({ input: object({}) }, async () => "pong") },
  dynamicSkills: dynamicSkills({ list: async () => [
    ...await wellKnownSkills({ url: ${JSON.stringify(upstream.url)}, fetch: ctx.fetch, signal: ctx.signal }),
    ...await githubSkills({ repo: "synthetic/skills", path: "skills", signal: ctx.signal, fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return ctx.fetch(${JSON.stringify(upstream.url)} + "/github" + url.pathname + url.search, init);
    } }),
  ] }),
}));`,
            },
            {
              path: "skills/packaged-guide/SKILL.md",
              content:
                "---\nname: packaged-guide\ndescription: Packaged instructions.\n---\n# Packaged guide",
            },
            { path: "skills/packaged-guide/references/example.md", content: "Pinned reference" },
          ],
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const app = yield* body(App, response);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        const base = `${prefix}/${app.id}`;
        const profile = yield* createProfile(actors.owner, base);
        const tools = yield* api.request(
          actors.owner,
          "GET",
          `${base}/tools?profile=${profile.id}`,
        );
        expect(tools.status).toBe(200);
        const ping = yield* api.request(actors.owner, "POST", `${base}/tools/call`, {
          profile: profile.id,
          tool: "queries.ping",
          input: {},
        });
        expect(ping.status).toBe(200);
        expect(ping.body).toBe("pong");
        expect(yield* upstream.requests).toEqual([]);
        const firstResponse = yield* api.request(actors.owner, "GET", `${base}/skill-bundle`);
        expect(
          firstResponse.status,
          JSON.stringify({ response: firstResponse.body, requests: yield* upstream.requests }),
        ).toBe(200);
        const first = yield* body(Bundle, firstResponse);
        expect(first.skills.map((skill) => skill.name)).toEqual([
          "github-guide",
          "packaged-guide",
          "remote-guide",
        ]);
        expect(
          first.skills
            .filter((skill) => skill.name !== "packaged-guide")
            .every((skill) => skill.files.some((file) => file.content.includes("Reference 1"))),
        ).toBe(true);
        const firstCommit = yield* upstream.commit;
        expect(
          (yield* upstream.requests).some((path) =>
            path.includes(`/synthetic/skills/${firstCommit}/skills/`),
          ),
        ).toBe(true);
        yield* browser.login(actors.owner);
        const grant = yield* oauth.authorize;
        const client = yield* mcp.connect(
          Redacted.make(Redacted.value(grant.tokens).access_token),
          "dynamic-skills",
        );
        const mcpRead = (revision?: string) =>
          client.use("Read current remote skill through MCP", (client, signal) =>
            client.callTool(
              {
                name: "skills",
                arguments: {
                  app: app.slug,
                  name: "remote-guide",
                  ...(revision === undefined ? {} : { revision }),
                },
              },
              undefined,
              { signal },
            ),
          );
        const firstMcp = yield* mcpRead();
        expect(firstMcp.isError).not.toBe(true);
        expect(firstMcp.structuredContent).toMatchObject({
          revision: first.revision,
          content: expect.stringContaining("Guide 1"),
        });
        yield* upstream.publish(2);
        const secondResponse = yield* api.request(actors.owner, "GET", `${base}/skill-bundle`);
        expect(secondResponse.status).toBe(200);
        const second = yield* body(Bundle, secondResponse);
        expect(second.deployment).toBe(first.deployment);
        expect(second.revision).not.toBe(first.revision);
        expect(second.skills.find((skill) => skill.name === "packaged-guide")).toEqual(
          first.skills.find((skill) => skill.name === "packaged-guide"),
        );
        expect((yield* mcpRead(first.revision)).isError).toBe(true);
        expect((yield* mcpRead()).structuredContent).toMatchObject({
          revision: second.revision,
          content: expect.stringContaining("Guide 2"),
        });
        expect(
          second.skills
            .filter((skill) => skill.name !== "packaged-guide")
            .every((skill) => skill.files.some((file) => file.content.includes("Reference 2"))),
        ).toBe(true);
        expect(
          (yield* api.request(
            actors.owner,
            "GET",
            `${base}/skills/remote-guide?revision=${first.revision}&file=references/example.md`,
          )).status,
        ).toBe(409);
        const pinned = yield* api.request(
          actors.owner,
          "GET",
          `${base}/skills/remote-guide?revision=${second.revision}&file=references/example.md`,
        );
        expect(pinned.status).toBe(200);
        expect((yield* body(Schema.Struct({ content: Schema.String }), pinned)).content).toBe(
          "# Reference 2",
        );
        for (const malformed of ["github", "well-known"] as const) {
          yield* upstream.publish(3, { malformed });
          expect((yield* api.request(actors.owner, "GET", `${base}/skill-bundle`)).status).toBe(
            502,
          );
        }
        yield* upstream.publish(3, { broken: true });
        expect((yield* api.request(actors.owner, "GET", `${base}/skill-bundle`)).status).toBe(502);
        yield* upstream.publish(3, { traversal: true });
        expect((yield* api.request(actors.owner, "GET", `${base}/skill-bundle`)).status).toBe(502);
        for (const fileFailure of ["oversized", "encoding", "redirect"] as const) {
          yield* upstream.publish(3, { fileFailure });
          expect(
            (yield* api.request(actors.owner, "GET", `${base}/skill-bundle`)).status,
            fileFailure,
          ).toBe(502);
        }
        expect((yield* upstream.requests).some((path) => path.includes("private.txt"))).toBe(false);
        yield* upstream.publish(3);
        expect((yield* api.request(actors.owner, "GET", `${base}/skill-bundle`)).status).toBe(200);
        const anonymous = yield* api.session();
        expect((yield* api.request(anonymous, "GET", `${base}/skill-bundle`)).status).toBe(401);
        yield* browser.login(actors.owner);
        yield* browser.use("Read dynamic app instructions", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=skills`),
        );
        yield* browser.use("Select the remote skill's instructions", (page) =>
          page
            .getByRole("group", { name: "remote-guide", exact: true })
            .getByRole("button", { name: "Instructions", exact: true })
            .click(),
        );
        yield* browser.use("Latest instructions are visible", (page) =>
          page.getByRole("heading", { name: "Guide 3", exact: true }).waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("Skills refreshed without redeploying the app");
      }).pipe(Effect.provide(Layer.mergeAll(McpClient.layer, McpOAuth.layer))),
    ),
  );
});
