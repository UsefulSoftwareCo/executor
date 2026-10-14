import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const App = Schema.Struct({ id: Schema.String });

/** MCP servers often namespace every tool with their own name, repeating the router's key. */
const source = `import { defineApp, object, query, router } from "apps";
const tool = (description: string) => query({ description, input: object({}) }, async () => "ok");
export default defineApp({}, async () => ({
  tools: router({
    planetscale: router({
      planetscale_list_databases: tool("List databases"),
      planetscale_list_branches: tool("List branches"),
      planetscale_search_documentation: tool("Search documentation"),
    }),
    cloudflare: router({
      d1_list: tool("List D1 databases"),
      d1_query: tool("Query a D1 database"),
    }),
  }),
}));`;

layer(HostedLive, { excludeTestServices: true })("Tool tree prefixes", (it) => {
  it.effect(scenarios.toolTreePrefixes.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Prefixed tools",
          files: [{ path: "index.ts", content: source }, appsManifest],
        });
        expect(response.status).toBe(200);
        const app = yield* body(App, response);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        yield* browser.login(actors.owner);
        yield* browser.use("Open the app's tools", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=tools`),
        );
        const nav = "App tools";
        yield* browser.use("The prefixed tools load", (page) =>
          page
            .getByRole("navigation", { name: nav, exact: true })
            .getByRole("button", { name: "planetscale.planetscale_list_databases", exact: true })
            .waitFor(),
        );
        const groups = yield* browser.use("Read the group headings", (page) =>
          page
            .getByRole("navigation", { name: nav, exact: true })
            .locator("button[aria-expanded]")
            .allInnerTexts(),
        );
        // The repeated prefix does not become a second Planetscale group; List groups directly.
        expect(groups.map((text) => text.replace(/\s+/g, " ").trim())).toEqual([
          "Cloudflare 2",
          "D1 2",
          "Planetscale 3",
          "List 2",
        ]);
        const label = yield* browser.use("Read the ungrouped tool's label", (page) =>
          page
            .getByRole("navigation", { name: nav, exact: true })
            .getByRole("button", { name: "planetscale.planetscale_search_documentation" })
            .innerText(),
        );
        expect(label.trim()).toBe("Search documentation");
        yield* browser.checkpoint("Tool-tree-prefixes");
      }),
    ),
  );
});
