import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";
/** The same Effect program runs against both hosted products. Only injected actor setup differs. */
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, Result, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource, Inventory } from "../support/contracts.ts";

const files = [
  {
    path: "index.ts",
    content: `
import { mutation, defineApp, defineProvider, secrets, object, string } from "apps";
const service = defineProvider({ name: "Parity service", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ accounts: { service } }, async ({ accounts }) => ({
   mutations: {
    echo: mutation({ description: "Echo with the connected account", input: object({ message: string() })},
      async (_, input) => ({ message: input.message, connected: accounts.service.fields.token === "synthetic-parity-token" }))
  }
}));
`,
  },
];

layer(HostedLive, { excludeTestServices: true })("Hosted parity", (it) => {
  it.effect(scenarios.hosted.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          browser = yield* Browser,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}`,
          name = `Parity ${randomUUID().slice(0, 8)}`;
        const anonymous = yield* api.session();
        const created: { app?: string; account?: string } = {};
        yield* Effect.addFinalizer((exit) =>
          Effect.gen(function* () {
            const cleanup = yield* Effect.forEach(
              [
                ...(created.app ? [`${prefix}/apps/${created.app}`] : []),
                ...(created.account ? [`${prefix}/accounts/${created.account}`] : []),
              ],
              (path) =>
                api.request(actors.owner, "DELETE", path).pipe(
                  Effect.flatMap((response) =>
                    response.status === 200
                      ? Effect.void
                      : Effect.fail(new Error("Cleanup rejected")),
                  ),
                  Effect.result,
                ),
              { concurrency: 2 },
            );
            yield* evidence.json("cleanup.json", cleanup);
            if (Exit.isSuccess(exit))
              expect(cleanup.every((result) => Result.isSuccess(result))).toBe(true);
          }).pipe(Effect.orDie),
        );
        yield* browser.login(actors.owner);
        yield* browser.use("Owner opens the hosted dashboard", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        yield* browser.use("Owner can add apps", (page) =>
          page.getByRole("link", { name: "Add app", exact: true }).waitFor({ state: "visible" }),
        );
        yield* evidence.step(
          "Signed-out requests cannot read the organization",
          Effect.gen(function* () {
            expect((yield* api.request(anonymous, "GET", `${prefix}/inventory`)).status).toBe(401);
          }),
        );
        yield* evidence.step(
          "New apps are private until their creator shares them",
          Effect.gen(function* () {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name,
              files,
            });
            expect(deployed.status).toBe(200);
            created.app = (yield* body(App, deployed)).id;
            expect(
              (yield* api.request(actors.member, "GET", `${prefix}/apps/${created.app}`)).status,
            ).toBe(403);
            const access = yield* body(
              Schema.Struct({ revision: Schema.String }),
              yield* api.request(actors.owner, "GET", `${prefix}/apps/${created.app}/access`),
            );
            expect(
              (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${created.app}/access`, {
                revision: access.revision,
                audience: { kind: "everyone" },
              })).status,
            ).toBe(200);
            const read = yield* api.request(actors.member, "GET", `${prefix}/apps/${created.app}`);
            expect(read.status).toBe(200);
            expect((yield* body(App, read)).id).toBe(created.app);
          }),
        );
        const ownerProfile = yield* createProfile(actors.owner, `${prefix}/apps/${created.app}`);
        yield* evidence.step(
          "Owner connects an account",
          Effect.gen(function* () {
            const connection = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/apps/${created.app}/connections`,
              {
                requirement: "service",
                profile: ownerProfile.id,
                destination: { kind: "shared", audience: { kind: "everyone" } },
              },
            );
            expect(connection.status).toBe(200);
            const { id } = yield* body(Resource, connection);
            const saved = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${id}/submit`,
              { method: "key", label: name, fields: { token: "synthetic-parity-token" } },
            );
            expect(saved.status).toBe(200);
            created.account = (yield* body(Resource, saved)).id;
            const selected = yield* api.request(
              actors.owner,
              "GET",
              `${prefix}/apps/${created.app}/profiles/${ownerProfile.id}`,
            );
            expect(selected.status).toBe(200);
            expect(
              (yield* body(
                Schema.Struct({ accounts: Schema.Struct({ service: Schema.String }) }),
                selected,
              )).accounts.service,
            ).toBe(created.account);
          }),
        );
        yield* evidence.step(
          "Members and admins can use explicitly shared apps and accounts",
          Effect.gen(function* () {
            if (created.account === undefined) return yield* Effect.die("Shared account missing");
            const memberProfile = yield* createProfile(
              actors.member,
              `${prefix}/apps/${created.app}`,
            );
            const adminProfile = yield* createProfile(
              actors.admin,
              `${prefix}/apps/${created.app}`,
            );
            for (const [actor, profile] of [
              [actors.member, memberProfile],
              [actors.admin, adminProfile],
            ] as const)
              expect(
                (yield* selectProfileAccounts(actor, `${prefix}/apps/${created.app}`, profile.id, {
                  service: created.account,
                })).status,
              ).toBe(200);
            const tools = yield* api.request(
              actors.member,
              "GET",
              `${prefix}/apps/${created.app}/tools?profile=${memberProfile.id}`,
            );
            expect(tools.status).toBe(200);
            expect(
              (yield* body(
                Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) }),
                tools,
              )).items.map((tool) => tool.name),
            ).toContain("mutations.echo");
            const call = { tool: "mutations.echo", input: { message: "shared hosted scenario" } };
            expect(
              (yield* api.request(
                actors.member,
                "POST",
                `${prefix}/apps/${created.app}/tools/call`,
                { ...call, profile: memberProfile.id },
              )).status,
            ).toBe(200);
            const invoked = yield* api.request(
              actors.admin,
              "POST",
              `${prefix}/apps/${created.app}/tools/call`,
              { ...call, profile: adminProfile.id },
            );
            expect(invoked.status).toBe(200);
            expect(invoked.body).toEqual({ message: "shared hosted scenario", connected: true });
            const response = yield* api.request(actors.member, "GET", `${prefix}/inventory`);
            expect(response.status).toBe(200);
            const visible = yield* body(Inventory, response);
            expect(visible.apps.some((app) => app.id === created.app)).toBe(true);
            expect(visible.accounts.some((account) => account.id === created.account)).toBe(true);
            expect(visible.apps.some((app) => app.name === `${name} denied`)).toBe(false);
          }),
        );
        for (const role of ["owner", "member"] as const) {
          yield* browser.login(actors[role]);
          yield* browser.use(`${role} opens the app list`, (page) =>
            page.goto(`/org/${actors.organization.slug}/apps`),
          );
          yield* browser.use(`${role} sees the connected app`, (page) =>
            page
              .getByRole("link", { name: `Open ${name}`, exact: true })
              .waitFor({ state: "visible" }),
          );
          yield* browser.use(`${role} has the correct Add permission`, (page) =>
            page.getByRole("link", { name: "Add app", exact: true }).waitFor({ state: "visible" }),
          );
          yield* browser.checkpoint(`${role} dashboard on the hosted target`);
        }
      }),
    ),
  );
  it.effect(scenarios.remoteMcp.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}`,
          name = `Cloudflare Docs ${randomUUID().slice(0, 8)}`;
        let created: string | undefined;
        yield* Effect.addFinalizer((exit) =>
          Effect.gen(function* () {
            if (!created) return;
            const removed = yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${created}`);
            yield* evidence.json("remote-mcp-cleanup.json", { status: removed.status });
            if (Exit.isSuccess(exit)) expect(removed.status).toBe(200);
          }).pipe(Effect.orDie),
        );
        yield* evidence.step(
          "Owner imports a public remote MCP server",
          Effect.gen(function* () {
            const imported = yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
              source: {
                kind: "mcp",
                name,
                url: "https://docs.mcp.cloudflare.com/mcp",
              },
            });
            expect(imported.status).toBe(200);
            created = (yield* body(App, imported)).id;
            const access = yield* body(
              Schema.Struct({ revision: Schema.String }),
              yield* api.request(actors.owner, "GET", `${prefix}/apps/${created}/access`),
            );
            expect(
              (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${created}/access`, {
                revision: access.revision,
                audience: { kind: "everyone" },
              })).status,
            ).toBe(200);
          }),
        );
        yield* evidence.step(
          "The live upstream catalog is discoverable without an account",
          Effect.gen(function* () {
            const tools = yield* api.request(
              actors.member,
              "GET",
              `${prefix}/apps/${created}/tools`,
            );
            expect(tools.status).toBe(200);
            expect(
              (yield* body(
                Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) }),
                tools,
              )).items.map((tool) => tool.name),
            ).toContain("queries.search_cloudflare_documentation");
          }),
        );
        yield* evidence.step(
          "An admin calls the real read-only search tool",
          Effect.gen(function* () {
            const invoked = yield* api.request(
              actors.admin,
              "POST",
              `${prefix}/apps/${created}/tools/call`,
              { tool: "queries.search_cloudflare_documentation", input: { query: "Workers KV" } },
            );
            expect(invoked.status).toBe(200);
            const result = yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                structuredContent: Schema.Struct({
                  results: Schema.Array(
                    Schema.Struct({ url: Schema.String, title: Schema.String }),
                  ),
                }),
              }),
            )(invoked.body);
            expect(result.structuredContent.results.length).toBeGreaterThan(0);
            expect(
              result.structuredContent.results.some((entry) =>
                entry.url.startsWith("https://developers.cloudflare.com/"),
              ),
            ).toBe(true);
          }),
        );
      }),
    ),
  );
});
