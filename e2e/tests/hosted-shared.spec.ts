import {
  connectionsPath,
  linkAccountResponse,
  linkedAccountIds,
  type LinkScope,
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

/**
 * An app whose `echo` reports whether its `service` account is the synthetic parity account. In
 * app scope, someone who can edit the app links one account for everyone; in user scope, each
 * caller links their own.
 */
const parityFiles = (scope: LinkScope) => [
  {
    path: "index.ts",
    content: `
import { mutation, defineApp, defineProvider, secrets, object, string, router, type MutationContext } from "apps";
const service = defineProvider({ name: "Parity service", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
const requirements = { ${scope}: { accounts: { service } } };
export default defineApp(requirements, async () => ({
   tools: router({
     echo: mutation({ description: "Echo with the connected account", input: object({ message: string() })},
      async (ctx: MutationContext<typeof requirements>, input) => ({ message: input.message, connected: ctx.${scope}.accounts.service.fields.token === "synthetic-parity-token" })),
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
              // The app goes first: its app link keeps the account from being deleted.
              { concurrency: 1 },
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
          page.getByRole("button", { name: "Add app", exact: true }).waitFor({ state: "visible" }),
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
              files: parityFiles("app"),
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
          "Owner connects an account for everyone",
          Effect.gen(function* () {
            const connection = yield* api.request(
              actors.owner,
              "POST",
              connectionsPath(`${prefix}/apps/${created.app}`, "app", "service"),
              {},
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
            // Connecting for the app's own requirement links the new account for everyone.
            expect(
              yield* linkedAccountIds(actors.owner, `${prefix}/apps/${created.app}`, "app"),
            ).toEqual([created.account]);
          }),
        );
        yield* evidence.step(
          "Members and admins use the shared app with the account linked for everyone",
          Effect.gen(function* () {
            if (created.account === undefined) return yield* Effect.die("Linked account missing");
            // Neither links anything: the app link serves their calls.
            for (const actor of [actors.member, actors.admin])
              expect(yield* linkedAccountIds(actor, `${prefix}/apps/${created.app}`)).toEqual([]);
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
            const memberCall = yield* api.request(
              actors.member,
              "POST",
              `${prefix}/apps/${created.app}/tools/call`,
              call,
            );
            expect(memberCall.status, JSON.stringify(memberCall.body)).toBe(200);
            expect(memberCall.body).toEqual({ message: "shared hosted scenario", connected: true });
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
            // The account stays the owner's: only the owner's inventory lists it.
            expect(visible.accounts.some((account) => account.id === created.account)).toBe(false);
            const owned = yield* body(
              Inventory,
              yield* api.request(actors.owner, "GET", `${prefix}/inventory`),
            );
            expect(owned.accounts.some((account) => account.id === created.account)).toBe(true);
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
            page
              .getByRole("button", { name: "Add app", exact: true })
              .waitFor({ state: "visible" }),
          );
          yield* browser.checkpoint(`${role} dashboard on the hosted target`);
        }
      }),
    ),
  );
  it.effect(scenarios.personalAccountLinks.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const app = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Personal links ${randomUUID().slice(0, 8)}`,
            files: parityFiles("user"),
          }),
        );
        const path = `${prefix}/apps/${app.id}`;
        const created: { account?: string; memberAccount?: string } = {};
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", path);
            if (created.account !== undefined)
              yield* api.request(actors.admin, "DELETE", `${prefix}/accounts/${created.account}`);
            if (created.memberAccount !== undefined)
              yield* api.request(
                actors.member,
                "DELETE",
                `${prefix}/accounts/${created.memberAccount}`,
              );
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
        // The admin saves an account from the app, which links it for the admin only.
        const connection = yield* body(
          Resource,
          yield* api.request(actors.admin, "POST", connectionsPath(path, "user", "service"), {}),
        );
        const saved = yield* api.request(
          actors.admin,
          "POST",
          `${prefix}/connections/${connection.id}/submit`,
          { method: "key", label: "Admin's own", fields: { token: "synthetic-parity-token" } },
        );
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        const account = (yield* body(Resource, saved)).id;
        created.account = account;
        expect(yield* linkedAccountIds(actors.admin, path)).toEqual([account]);
        const call = { tool: "echo", kind: "mutation", input: { message: "personal account" } };
        const own = yield* api.request(actors.admin, "POST", `${path}/tools/call`, call);
        expect(own.status, JSON.stringify(own.body)).toBe(200);
        expect(own.body).toEqual({ message: "personal account", connected: true });
        // The account is the admin's alone: the admin reads and manages it, and no route shares it
        // or reads a policy for it.
        const accountPath = `${prefix}/accounts/${account}`;
        const detail = yield* body(
          Schema.Struct({ account: Resource, canManage: Schema.Boolean }),
          yield* api.request(actors.admin, "GET", accountPath),
        );
        expect(detail).toEqual({ account: { id: account }, canManage: true });
        const adminInventory = yield* body(
          Inventory,
          yield* api.request(actors.admin, "GET", `${prefix}/inventory`),
        );
        expect(adminInventory.accounts.map((item) => item.id)).toContain(account);
        for (const method of ["GET", "PATCH"] as const) {
          const removed = yield* api.request(
            actors.admin,
            method,
            `${accountPath}/access`,
            method === "PATCH" ? { audience: { kind: "everyone" } } : undefined,
          );
          // The route is gone: self-host answers 404, Cloud's router may answer 404 or 405.
          expect([404, 405], `${method} ${JSON.stringify(removed.body)}`).toContain(removed.status);
        }
        // Other members, the organization's owner included, can neither read it nor link it, so
        // their calls never run with it.
        for (const actor of [actors.member, actors.owner]) {
          const read = yield* api.request(actor, "GET", accountPath);
          expect(read.status, JSON.stringify(read.body)).toBe(403);
          const linked = yield* linkAccountResponse(actor, path, "service", account);
          expect(linked.status, JSON.stringify(linked.body)).toBe(403);
          expect(yield* linkedAccountIds(actor, path)).toEqual([]);
          const refused = yield* api.request(actor, "POST", `${path}/tools/call`, call);
          expect(refused.status, JSON.stringify(refused.body)).toBe(409);
          expect(refused.body).toMatchObject({ _tag: "AccountRequired" });
          const inventory = yield* body(
            Inventory,
            yield* api.request(actor, "GET", `${prefix}/inventory`),
          );
          expect(inventory.accounts.some((item) => item.id === account)).toBe(false);
          expect(inventory.links).not.toContainEqual({ app: app.id, account });
          // Nor can they replace its credentials by reconnecting it.
          const reconnect = yield* api.request(
            actor,
            "POST",
            connectionsPath(path, "user", "service"),
            { account },
          );
          expect(reconnect.status, JSON.stringify(reconnect.body)).toBe(403);
        }

        // A client that still asks for a shared account gets the connecting member's own: the
        // destination is no longer part of a connection.
        const asked = yield* body(
          Resource,
          yield* api.request(actors.member, "POST", connectionsPath(path, "user", "service"), {
            destination: { kind: "shared" },
          }),
        );
        const memberSaved = yield* api.request(
          actors.member,
          "POST",
          `${prefix}/connections/${asked.id}/submit`,
          { method: "key", label: "Asked to share", fields: { token: "synthetic-asked" } },
        );
        expect(memberSaved.status, JSON.stringify(memberSaved.body)).toBe(200);
        const memberAccount = (yield* body(Resource, memberSaved)).id;
        created.memberAccount = memberAccount;
        expect(
          (yield* api.request(actors.member, "GET", `${prefix}/accounts/${memberAccount}`)).status,
        ).toBe(200);
        for (const actor of [actors.owner, actors.admin]) {
          expect(
            (yield* api.request(actor, "GET", `${prefix}/accounts/${memberAccount}`)).status,
          ).toBe(403);
          expect((yield* linkAccountResponse(actor, path, "service", memberAccount)).status).toBe(
            403,
          );
        }
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
