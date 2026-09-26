/** Services Executor cannot add without guessing hand the user a prompt for their agent. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Inventory } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";

const Catalog = Schema.Array(
  Schema.Struct({ id: Schema.String, kind: Schema.String, name: Schema.String }),
);
const Rejected = Schema.Struct({
  _tag: Schema.Literal("CatalogImportFailed"),
  code: Schema.String,
});

layer(HostedLive, { excludeTestServices: true })("Catalog agent setup", (it) => {
  it.effect(scenarios.catalogAgentSetup.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const entries = yield* body(
          Catalog,
          yield* api.request(actors.owner, "GET", "/api/catalog"),
        );
        const graphql = entries.find(
          (entry) => entry.name === "GitHub" && entry.kind === "graphql",
        );
        const cli = entries.find((entry) => entry.name === "GitHub" && entry.kind === "cli");
        const openapi = entries.find((entry) => entry.id === "openapi/cloudflare-com");
        if (!graphql || !cli || !openapi)
          return yield* Effect.die("Published GitHub and Cloudflare catalog fixtures are missing");

        // No entry kind other than MCP is installed, and none reads its API definition first.
        for (const entry of [graphql, cli, openapi]) {
          const name = `Agent setup ${randomUUID().slice(0, 8)}`;
          const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/install`, {
            entry: entry.id,
            name,
          });
          expect(response.status, `${entry.kind}: ${JSON.stringify(response.body)}`).toBe(422);
          expect((yield* body(Rejected, response)).code).toBe("agent_setup_required");
          const inventory = yield* body(
            Inventory,
            yield* api.request(actors.owner, "GET", `${prefix}/inventory`),
          );
          expect(inventory.apps.map((app) => app.name)).not.toContain(name);
        }

        yield* browser.login(actors.owner);
        yield* browser.use("Open Add app", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/add`),
        );
        yield* browser.use("Search GitHub", (page) =>
          page.getByPlaceholder("Search apps…").fill("github"),
        );
        yield* browser.use("GraphQL is listed", (page) =>
          page.getByRole("button", { name: /GitHub.*GraphQL/ }).waitFor(),
        );
        expect(
          yield* browser.use("CLI rows are hidden", (page) =>
            page.getByRole("button", { name: /GitHub.*CLI/ }).count(),
          ),
        ).toBe(0);
        const rowCount = yield* browser.use("Count visible catalog matches", (page) =>
          page.locator(".catalog-list button").count(),
        );
        expect(
          yield* browser.use("Search count excludes CLI entries", (page) =>
            page.getByText(/^\d[\d,]* apps$/).textContent(),
          ),
        ).toBe(`${rowCount} apps`);
        yield* browser.use("Choose GraphQL", (page) =>
          page.getByRole("button", { name: /GitHub.*GraphQL/ }).click(),
        );
        const prompt = yield* browser.use("The entry offers an agent prompt", (page) =>
          page
            .getByRole("region", { name: "Set up with your agent" })
            .waitFor()
            .then(() => page.getByRole("region", { name: "Set up with your agent" }).textContent()),
        );
        expect(prompt).toContain("Help me add GitHub to Executor as an app.");
        expect(prompt).toContain("GraphQL endpoint: https://api.github.com/graphql");
        expect(prompt).toContain("app-authoring skill");
        expect(prompt).toContain("/mcp first.");
        expect(
          yield* browser.use("No install form is offered", (page) =>
            page.getByLabel("App name", { exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.use("The prompt can be copied", (page) =>
          page.getByRole("button", { name: "Copy setup prompt" }).waitFor(),
        );
        yield* browser.checkpoint("GraphQL catalog entry hands off to the user's agent");

        // MCP entries keep quick add, with the prompt as the fallback for other setup.
        const mcp = entries.find((entry) => entry.id === "mcp/cloudflare");
        if (!mcp) return yield* Effect.die("Published Cloudflare MCP fixture is missing");
        yield* browser.use("Return to the catalog", (page) =>
          page.getByRole("button", { name: "All apps" }).click(),
        );
        yield* browser.use("Search Cloudflare", (page) =>
          page.getByPlaceholder("Search apps…").fill(mcp.name),
        );
        yield* browser.use("Choose the MCP entry", (page) =>
          page
            .getByRole("button", { name: new RegExp(`${mcp.name}.*MCP`) })
            .first()
            .click(),
        );
        expect(
          yield* browser.use("MCP entries offer quick add", (page) =>
            page.getByLabel("App name", { exact: true }).inputValue(),
          ),
        ).toBe(mcp.name);
        const fallback = yield* browser.use("MCP entries also offer the prompt", (page) =>
          page.getByRole("region", { name: "Needs an API key or other setup?" }).textContent(),
        );
        expect(fallback).toContain(`Help me add ${mcp.name} to Executor as an app.`);
        yield* browser.checkpoint("MCP catalog entry offers quick add and an agent prompt");

        yield* browser.use("Open Connect a service", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/add/custom`),
        );
        yield* browser.use("Only an MCP URL is accepted directly", (page) =>
          page.getByLabel("MCP server URL", { exact: true }).waitFor(),
        );
        const generic = yield* browser.use("Other services get a prompt", (page) =>
          page.getByRole("region", { name: "Any other service" }).textContent(),
        );
        expect(generic).toContain("Ask me which service I want to connect.");
        yield* browser.checkpoint("Connect a service offers MCP or an agent prompt");
      }),
    ),
  );
});
