import {
  connectionsPath,
  linkAccount,
  linkedAccountIds,
  unlinkAccount,
} from "../support/app-accounts.ts";
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
import { appsManifest } from "../support/apps-release.ts";
import { docsMcpFixture, docsOrigin, docsSearchTool } from "../support/docs-mcp-fixture.ts";

const files = [
  {
    path: "index.ts",
    content: `
import { mutation, defineApp, defineProvider, secrets, object, string, router } from "apps";
const service = defineProvider({ name: "Parity service", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ user: { accounts: { service } } }, async ({ user: { accounts } }) => ({
   tools: router({
     echo: mutation({ description: "Echo with the connected account", input: object({ message: string() })},
      async (_, input) => ({ message: input.message, connected: accounts.service.fields.token === "synthetic-parity-token" })),
   })
}));
`,
  },
  appsManifest,
];

/**
 * An owner imports a public MCP server that needs no account and shares it, a member discovers its
 * tools without an account, and an admin calls its read-only search tool and gets structured
 * results whose pages live at `resultsOrigin`.
 */
const remoteMcpJourney = (server: {
  readonly label: string;
  readonly url: string;
  readonly tool: string;
  readonly resultsOrigin: string;
}) =>
  Effect.gen(function* () {
    const actors = yield* Actors,
      api = yield* Api,
      evidence = yield* Evidence;
    const prefix = `/api/organizations/${actors.organization.id}`,
      name = `${server.label} ${randomUUID().slice(0, 8)}`;
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
          source: { kind: "mcp", name, url: server.url },
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
        const tools = yield* api.request(actors.member, "GET", `${prefix}/apps/${created}/tools`);
        expect(tools.status).toBe(200);
        expect(
          (yield* body(
            Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) }),
            tools,
          )).items.map((tool) => tool.name),
        ).toContain(server.tool);
      }),
    );
    yield* evidence.step(
      "An admin calls the read-only search tool",
      Effect.gen(function* () {
        const invoked = yield* api.request(
          actors.admin,
          "POST",
          `${prefix}/apps/${created}/tools/call`,
          { tool: server.tool, kind: "query", input: { query: "Workers KV" } },
        );
        expect(invoked.status).toBe(200);
        const result = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            structuredContent: Schema.Struct({
              results: Schema.Array(Schema.Struct({ url: Schema.String, title: Schema.String })),
            }),
          }),
        )(invoked.body);
        expect(result.structuredContent.results.length).toBeGreaterThan(0);
        expect(
          result.structuredContent.results.some((entry) =>
            entry.url.startsWith(server.resultsOrigin),
          ),
        ).toBe(true);
      }),
    );
  });

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
        yield* evidence.step(
          "Owner connects an account",
          Effect.gen(function* () {
            const connection = yield* api.request(
              actors.owner,
              "POST",
              connectionsPath(`${prefix}/apps/${created.app}`, "user", "service"),
              { destination: { kind: "shared", audience: { kind: "everyone" } } },
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
            // Connecting from the app links the new account to it for the owner.
            expect(yield* linkedAccountIds(actors.owner, `${prefix}/apps/${created.app}`)).toEqual([
              created.account,
            ]);
          }),
        );
        yield* evidence.step(
          "Members and admins can use explicitly shared apps and accounts",
          Effect.gen(function* () {
            if (created.account === undefined) return yield* Effect.die("Shared account missing");
            for (const actor of [actors.member, actors.admin]) {
              yield* linkAccount(
                actor,
                `${prefix}/apps/${created.app}`,
                "service",
                created.account,
              );
              expect(yield* linkedAccountIds(actor, `${prefix}/apps/${created.app}`)).toEqual([
                created.account,
              ]);
            }
            const tools = yield* api.request(
              actors.member,
              "GET",
              `${prefix}/apps/${created.app}/tools`,
            );
            expect(tools.status).toBe(200);
            expect(
              (yield* body(
                Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) }),
                tools,
              )).items.map((tool) => tool.name),
            ).toContain("echo");
            const call = {
              tool: "echo",
              kind: "mutation",
              input: { message: "shared hosted scenario" },
            };
            expect(
              (yield* api.request(
                actors.member,
                "POST",
                `${prefix}/apps/${created.app}/tools/call`,
                call,
              )).status,
            ).toBe(200);
            const invoked = yield* api.request(
              actors.admin,
              "POST",
              `${prefix}/apps/${created.app}/tools/call`,
              call,
            );
            expect(invoked.status).toBe(200);
            expect(invoked.body).toEqual({ message: "shared hosted scenario", connected: true });
            const response = yield* api.request(actors.member, "GET", `${prefix}/inventory`);
            expect(response.status).toBe(200);
            const visible = yield* body(Inventory, response);
            expect(visible.apps.some((app) => app.id === created.app)).toBe(true);
            expect(visible.accounts.some((account) => account.id === created.account)).toBe(true);
            expect(visible.links).toContainEqual({ app: created.app, account: created.account });
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
  it.effect(scenarios.sharedAccountLinks.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const app = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Shared links ${randomUUID().slice(0, 8)}`,
            files,
          }),
        );
        const path = `${prefix}/apps/${app.id}`;
        const created: { account?: string } = {};
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", path);
            if (created.account !== undefined)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${created.account}`);
          }).pipe(Effect.orDie),
        );
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${path}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        // The admin creates a shared account from the app, which links it for the admin only.
        const connection = yield* body(
          Resource,
          yield* api.request(actors.admin, "POST", connectionsPath(path, "user", "service"), {
            destination: { kind: "shared", audience: { kind: "everyone" } },
          }),
        );
        const saved = yield* api.request(
          actors.admin,
          "POST",
          `${prefix}/connections/${connection.id}/submit`,
          { method: "key", label: "Shared by admin", fields: { token: "synthetic-parity-token" } },
        );
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        const account = (yield* body(Resource, saved)).id;
        created.account = account;
        expect(yield* linkedAccountIds(actors.admin, path)).toEqual([account]);
        expect(yield* linkedAccountIds(actors.member, path)).toEqual([]);
        const call = { tool: "echo", kind: "mutation", input: { message: "linked by member" } };
        const unlinked = yield* api.request(actors.member, "POST", `${path}/tools/call`, call);
        expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(409);
        expect(unlinked.body).toMatchObject({ _tag: "AccountRequired" });
        // Another member links the shared account and their calls run with it.
        yield* linkAccount(actors.member, path, "service", account);
        expect(yield* linkedAccountIds(actors.member, path)).toEqual([account]);
        const tools = yield* api.request(actors.member, "GET", `${path}/tools`);
        expect(tools.status, JSON.stringify(tools.body)).toBe(200);
        expect(
          (yield* body(
            Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) }),
            tools,
          )).items.map((tool) => tool.name),
        ).toContain("echo");
        const invoked = yield* api.request(actors.member, "POST", `${path}/tools/call`, call);
        expect(invoked.status, JSON.stringify(invoked.body)).toBe(200);
        expect(invoked.body).toEqual({ message: "linked by member", connected: true });
        const inventory = yield* body(
          Inventory,
          yield* api.request(actors.member, "GET", `${prefix}/inventory`),
        );
        expect(inventory.links).toContainEqual({ app: app.id, account });
        // The creator's own unlink leaves the member's link and calls untouched.
        yield* unlinkAccount(actors.admin, path, "service", account);
        expect(yield* linkedAccountIds(actors.admin, path)).toEqual([]);
        expect(yield* linkedAccountIds(actors.member, path)).toEqual([account]);
        const after = yield* api.request(actors.member, "POST", `${path}/tools/call`, call);
        expect(after.status, JSON.stringify(after.body)).toBe(200);
        expect(after.body).toEqual({ message: "linked by member", connected: true });
      }),
    ),
  );
  it.effect(scenarios.remoteMcp.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const docs = yield* docsMcpFixture;
        yield* remoteMcpJourney({
          label: "Fixture Docs",
          url: docs.url,
          tool: docsSearchTool,
          resultsOrigin: `${docsOrigin}/`,
        });
        // The admin's call reached the upstream server with its input.
        expect(yield* docs.queries).toEqual(["Workers KV"]);
      }),
    ),
  );
  it.effect(scenarios.remoteMcpCloudflare.title, (context) =>
    withHostedCase(
      context,
      remoteMcpJourney({
        label: "Cloudflare Docs",
        url: "https://docs.mcp.cloudflare.com/mcp",
        tool: "search_cloudflare_documentation",
        resultsOrigin: "https://developers.cloudflare.com/",
      }),
    ),
  );
});
