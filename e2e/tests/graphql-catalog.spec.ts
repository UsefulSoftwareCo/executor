/** Catalog imports run through the browser, real deployment, and account-bound GraphQL calls. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { holdQuery } from "../support/query-transition.ts";
import { templateUpstream } from "../support/template-upstream.ts";
import { scenarios } from "../test-plan.ts";

const Catalog = Schema.Array(
  Schema.Struct({ id: Schema.String, kind: Schema.String, name: Schema.String }),
);
const Source = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});
const Tools = Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) });

layer(HostedLive, { excludeTestServices: true })("GraphQL catalog", (it) => {
  it.effect(scenarios.graphqlCatalogImport.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          actors = yield* Actors,
          origin = yield* templateUpstream;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const entries = yield* body(
          Catalog,
          yield* api.request(actors.owner, "GET", "/api/catalog"),
        );
        const github = entries.find((entry) => entry.name === "GitHub" && entry.kind === "graphql");
        const cli = entries.find((entry) => entry.name === "GitHub" && entry.kind === "cli");
        if (!github || !cli)
          return yield* Effect.die("Published GitHub GraphQL and CLI fixtures are missing");
        const name = `GraphQL catalog ${randomUUID().slice(0, 8)}`;
        const apps: string[] = [],
          accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const id of apps)
              yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${id}`);
            for (const id of accounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${id}`);
          }).pipe(Effect.orDie),
        );

        // An API caller can use the catalog's endpoint and token header without UI overrides.
        const defaults = yield* api.request(actors.owner, "POST", `${prefix}/apps/install`, {
          entry: github.id,
          name,
        });
        expect(defaults.status, JSON.stringify(defaults.body)).toBe(200);
        const defaultApp = yield* body(App, defaults);
        apps.push(defaultApp.id);
        const source = yield* body(
          Source,
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${defaultApp.id}/source`),
        );
        expect(source.files.find((file) => file.path === "index.ts")?.content).toContain(
          "https://api.github.com/graphql",
        );
        expect(source.files.find((file) => file.path === "index.ts")?.content).toContain(
          '"Bearer "',
        );
        expect(source.files.find((file) => file.path === "provider.ts")?.content).toContain(
          "apiKey: secrets",
        );
        const unsupported = yield* api.request(actors.owner, "POST", `${prefix}/apps/install`, {
          entry: cli.id,
          name: `${name} CLI`,
        });
        expect(unsupported.status).toBe(422);

        yield* browser.login(actors.owner);
        yield* browser.use("Open Add app", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/add`),
        );
        yield* browser.use("Search GitHub", (page) =>
          page.getByPlaceholder("Search apps…").fill("github"),
        );
        yield* browser.use("GraphQL is available", (page) =>
          page.getByRole("button", { name: /GitHub.*GraphQL/ }).waitFor(),
        );
        expect(
          yield* browser.use("CLI rows are hidden", (page) =>
            page.getByRole("button", { name: /GitHub.*CLI/ }).count(),
          ),
        ).toBe(0);
        expect(
          yield* browser.use("GraphQL is enabled", (page) =>
            page.getByRole("button", { name: /GitHub.*GraphQL/ }).isEnabled(),
          ),
        ).toBe(true);
        const rowCount = yield* browser.use("Count visible catalog matches", (page) =>
          page.locator(".catalog-list button").count(),
        );
        expect(
          yield* browser.use("Search count excludes CLI entries", (page) =>
            page.getByText(/^\d[\d,]* apps$/).textContent(),
          ),
        ).toBe(`${rowCount} apps`);
        yield* browser.checkpoint("GitHub catalog with GraphQL and no CLI");
        yield* browser.use("Choose GraphQL", (page) =>
          page.getByRole("button", { name: /GitHub.*GraphQL/ }).click(),
        );
        expect(
          yield* browser.use("Catalog name is filled", (page) =>
            page.getByLabel("App name", { exact: true }).inputValue(),
          ),
        ).toBe("GitHub");
        expect(
          yield* browser.use("Catalog endpoint is filled", (page) =>
            page.getByLabel("GraphQL endpoint").inputValue(),
          ),
        ).toBe("https://api.github.com/graphql");
        expect(
          yield* browser.use("Token header is filled", (page) =>
            page.getByLabel("Header name").inputValue(),
          ),
        ).toBe("Authorization");
        expect(
          yield* browser.use("Token prefix is filled", (page) =>
            page.getByLabel("Prefix", { exact: true }).inputValue(),
          ),
        ).toBe("Bearer ");
        yield* browser.checkpoint("GraphQL catalog import settings");
        yield* browser.use("Use the existing app name", (page) =>
          page.getByLabel("App name", { exact: true }).fill(name),
        );
        yield* browser.use("Edit the catalog endpoint", (page) =>
          page.getByLabel("GraphQL endpoint").fill(`${origin}/graphql`),
        );
        const held = yield* holdQuery(/\/api\/organizations\/[^/]+\/apps\/install$/, "continue", {
          method: "POST",
        });
        yield* browser.use("Submit the import", (page) =>
          page.getByRole("button", { name: "Add app", exact: true }).click(),
        );
        yield* held.requested;
        expect(
          yield* browser.use("Submission stays pending", (page) =>
            page.getByRole("button", { name: "Creating app…", exact: true }).isDisabled(),
          ),
        ).toBe(true);
        expect(
          yield* browser.use("Pending endpoint is retained", (page) =>
            page.getByLabel("GraphQL endpoint").inputValue(),
          ),
        ).toBe(`${origin}/graphql`);
        yield* held.release;
        yield* browser.use("The name conflict is shown", (page) =>
          page.getByText(/already.*name|name.*already/i).waitFor(),
        );
        expect(
          yield* browser.use("Edited endpoint survives failure", (page) =>
            page.getByLabel("GraphQL endpoint").inputValue(),
          ),
        ).toBe(`${origin}/graphql`);
        expect(
          yield* browser.use("Name survives failure", (page) =>
            page.getByLabel("App name", { exact: true }).inputValue(),
          ),
        ).toBe(name);
        yield* browser.use("Correct the duplicate name", (page) =>
          page.getByLabel("App name", { exact: true }).fill(`${name} connected`),
        );
        yield* browser.use("Retry the import", (page) =>
          page.getByRole("button", { name: "Add app", exact: true }).click(),
        );
        yield* browser.use("Account setup follows installation", (page) =>
          page.waitForURL("**/apps/*?view=accounts"),
        );
        const pathname = yield* browser.use("Read installed app location", (page) =>
          page.evaluate(() => location.pathname),
        );
        const id = yield* Schema.decodeUnknownEffect(Schema.String)(
          /^\/org\/[^/]+\/apps\/([^/]+)$/.exec(pathname)?.[1],
        );
        apps.push(id);
        const path = `${prefix}/apps/${id}`;
        const app = yield* body(App, yield* api.request(actors.owner, "GET", path));
        expect(app.name).toBe(`${name} connected`);
        yield* browser.checkpoint("GraphQL installed and ready for an account");
        const created = yield* api.request(actors.owner, "POST", `${path}/profiles`, {
          accounts: { service: [] },
          idempotencyKey: randomUUID(),
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const profile = yield* body(Resource, created);
        const start = yield* api.request(actors.owner, "POST", `${path}/connections`, {
          requirement: "service",
          profile: profile.id,
        });
        expect(start.status).toBe(200);
        const connection = yield* body(Resource, start);
        const saved = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/submit`,
          {
            method: "apiKey",
            label: "Synthetic GraphQL account",
            fields: { token: "synthetic-work" },
          },
        );
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        const account = yield* body(Resource, saved);
        accounts.push(account.id);
        const tools = yield* api.request(
          actors.owner,
          "GET",
          `${path}/tools?profile=${profile.id}`,
        );
        expect(tools.status, JSON.stringify(tools.body)).toBe(200);
        expect((yield* body(Tools, tools)).items.map((tool) => tool.name)).toEqual([
          "queries.query_identity",
        ]);
        const called = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          profile: profile.id,
          tool: "queries.query_identity",
          input: { accountId: account.id, input: {} },
        });
        expect(called.status, JSON.stringify(called.body)).toBe(200);
        expect(called.body).toBe("work");
        const retained = yield* body(
          Source,
          yield* api.request(actors.owner, "GET", `${path}/source`),
        );
        expect(JSON.stringify(retained)).not.toContain("synthetic-work");
      }),
    ),
  );
});
