import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { holdQuery } from "../support/query-transition.ts";
import { connectionsPath, linkedAccountIds } from "../support/app-accounts.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const fixture = `import {defineApp,defineProvider,secrets,query,object,string, router} from "apps";
const service=defineProvider({name:"Grouped fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const identity=query({input:object({})},async ctx=>({account:ctx.user.accounts.service.id}));
export default defineApp({user: { accounts:{service} }},async ctx=>({tools:router(ctx.user.accounts.service.fields.token==="work"?{identity,common:identity,labels:identity,threads:identity}:{identity,common:identity,drafts:identity})}));`;

layer(HostedLive, { excludeTestServices: true })("Grouped accounts", (it) => {
  it.effect(scenarios.groupedAccounts.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const app = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Grouped ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: fixture }, appsManifest],
          }),
        );
        const path = `${prefix}/apps/${app.id}`;
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", path);
            for (const id of accounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${id}`);
          }).pipe(Effect.orDie),
        );
        const create = (label: string, token: string) =>
          Effect.gen(function* () {
            const connection = yield* body(
              Resource,
              yield* api.request(
                actors.owner,
                "POST",
                connectionsPath(path, "user", "service"),
                {},
              ),
            );
            const account = yield* body(
              Resource,
              yield* api.request(
                actors.owner,
                "POST",
                `${prefix}/connections/${connection.id}/submit`,
                { method: "key", label, fields: { token } },
              ),
            );
            accounts.push(account.id);
            return account.id;
          });
        // The plain requirement keeps one linked account: connecting Personal for it after Work
        // replaced Work, which stays saved.
        const work = yield* create("Work", "work"),
          personal = yield* create("Personal", "personal");
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([personal]);
        expect((yield* api.request(actors.owner, "GET", `${prefix}/accounts/${work}`)).status).toBe(
          200,
        );
        const Tools = Schema.Struct({
          items: Schema.Array(Schema.Struct({ name: Schema.String })),
        });
        const toolNames = (query: string) =>
          Effect.gen(function* () {
            const listed = yield* api.request(actors.owner, "GET", `${path}/tools${query}`);
            expect(listed.status, JSON.stringify(listed.body)).toBe(200);
            return (yield* body(Tools, listed)).items.map((tool) => tool.name).sort();
          });
        // The full catalog loads for the linked account without any choice.
        expect(yield* toolNames("")).toEqual(["common", "drafts", "identity"]);
        const workQuery = `?accounts=${encodeURIComponent(JSON.stringify({ service: [work] }))}`;
        yield* browser.login(actors.owner);
        yield* browser.use("Open the app summary", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=overview`),
        );
        yield* Effect.gen(function* () {
          const summary = yield* browser.use("Accounts summarizes the linked account", (page) =>
            Promise.resolve(page.getByRole("region", { name: "App accounts", exact: true })),
          );
          yield* browser.use("Accounts summarizes the linked account", () =>
            summary.getByText("1 linked", { exact: true }).waitFor(),
          );
        });
        yield* browser.use("Summary includes the linked account's drafts", (page) =>
          page
            .getByRole("region", { name: "App tools preview" })
            .getByRole("link")
            .filter({ has: page.getByText("drafts", { exact: true }) })
            .waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("Tools appear once in the summary", (page) =>
            page
              .getByRole("region", { name: "App tools preview" })
              .getByRole("link")
              .filter({ has: page.getByText("common", { exact: true }) })
              .count(),
          ),
        ).toBe(1);
        yield* browser.checkpoint("Overview summarizes the linked account's catalog");
        // An old address naming an account choice selects nothing: the linked account is used.
        yield* browser.use("Open tools from an address naming Work", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}${workQuery}&view=tools`),
        );
        const catalogShows = (label: string, present: string, absent: string, size: number) =>
          Effect.gen(function* () {
            yield* browser.use(`${label} has its own full catalog`, (page) =>
              page.getByRole("button", { name: present, exact: true }).waitFor(),
            );
            expect(
              yield* browser.use(`${label} has its own full catalog`, (page) =>
                Promise.all([
                  page.getByRole("button", { name: absent, exact: true }).count(),
                  page
                    .getByRole("navigation", { name: "App tools", exact: true })
                    .locator("button[aria-pressed]")
                    .count(),
                  page.getByRole("heading", { name: "Choose an account", exact: true }).count(),
                  page.getByRole("combobox", { name: "Grouped fixture account" }).count(),
                ]),
              ),
            ).toEqual([0, size, 0, 0]);
          });
        yield* catalogShows("Personal", "drafts", "threads", 3);
        const runIdentity = (label: string, expected: string, other: string) =>
          Effect.gen(function* () {
            yield* browser.use(`Run the same tool as ${label}`, (page) =>
              page.getByRole("button", { name: "identity", exact: true }).click(),
            );
            const running = yield* browser.use(`The runner says it runs as ${label}`, (page) =>
              page
                .getByText("Running as", { exact: false })
                .first()
                .waitFor()
                .then(() => page.getByText("Running as", { exact: false }).first().textContent()),
            );
            expect(running).toContain(label);
            expect(running).not.toContain(other);
            yield* browser.use(`Run the same tool as ${label}`, (page) =>
              page
                .getByRole("tablist", { name: "Input format", exact: true })
                .getByRole("tab", { name: "JSON", exact: true })
                .click()
                .then(() => page.getByRole("textbox", { name: "Input", exact: true }).fill("{}")),
            );
            yield* browser.use(`Run the same tool as ${label}`, (page) =>
              page.getByRole("button", { name: "Run tool", exact: true }).click(),
            );
            yield* browser.use(`Run the same tool as ${label}`, (page) =>
              page.getByRole("region", { name: "Tool result", exact: true }).waitFor(),
            );
            expect(
              yield* browser.use(`Run the same tool as ${label}`, (page) =>
                page.getByRole("region", { name: "Tool result", exact: true }).textContent(),
              ),
            ).toContain(expected);
          });
        yield* runIdentity("Personal", personal, "Work");
        yield* browser.checkpoint("Tool calls run with the linked account");
        // Linking Work from the Accounts tab replaces Personal; the catalog follows the new link.
        yield* browser.use("Open Accounts", (page) =>
          page
            .getByRole("navigation", { name: "App navigation" })
            .getByRole("link", { name: "Accounts", exact: true })
            .click(),
        );
        const accountsRegion = yield* browser.use("Find the service accounts", (page) =>
          Promise.resolve(page.getByRole("region", { name: "Grouped fixture", exact: true })),
        );
        // The plain requirement lists both saved accounts with Personal selected; selecting Work
        // links it in Personal's place.
        // The dashboard may address the organization by slug, so match the path from the app on.
        const workLink = `/apps/${app.id}/accounts/user/service/${work}`;
        const replaced = yield* browser.use("Link Work in place of Personal", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === "PUT" &&
                new URL(response.url()).pathname.endsWith(workLink),
            ),
            accountsRegion
              .getByRole("radiogroup", { name: "Grouped fixture account", exact: true })
              .getByRole("radio", { name: "Work", exact: true })
              .click(),
          ]).then(([response]) => response.status()),
        );
        expect(replaced).toBe(200);
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([work]);
        const held = yield* holdQuery(
          [actors.organization.id, actors.organization.slug].map(
            (id) => `/api/organizations/${id}/apps/${app.id}/tools/index`,
          ),
          "fail",
        );
        yield* browser.use("Open tools after replacing", (page) =>
          page
            .getByRole("navigation", { name: "App navigation" })
            .getByRole("link", { name: "Tools", exact: true })
            .click(),
        );
        yield* held.requested;
        expect(
          yield* browser.use("Personal tools are not shown for the new link", (page) =>
            page.getByRole("button", { name: "drafts", exact: true }).count(),
          ),
        ).toBe(0);
        yield* held.release;
        yield* browser.use("The new catalog's failure is visible", (page) =>
          page.getByRole("alert", { name: "Can’t reach the server", exact: true }).waitFor(),
        );
        yield* browser.use("Retry Work", (page) =>
          page.getByRole("button", { name: "Try again", exact: true }).click(),
        );
        yield* catalogShows("Work", "threads", "drafts", 4);
        yield* runIdentity("Work", work, "Personal");
        yield* browser.checkpoint("The catalog and calls follow the replacing link");
        // An `accounts` field or query chooses nothing: calls run with the linked account.
        expect(yield* toolNames(workQuery.replace(work, personal))).toEqual([
          "common",
          "identity",
          "labels",
          "threads",
        ]);
        const call = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "identity",
          kind: "query",
          input: {},
          accounts: { service: [personal] },
        });
        expect(call.status, JSON.stringify(call.body)).toBe(200);
        expect(JSON.stringify(call.body)).toContain(work);
        expect(JSON.stringify(call.body)).not.toContain(personal);
        yield* Effect.gen(function* () {
          yield* browser.use("Unlink Work from Accounts", (page) =>
            page
              .getByRole("navigation", { name: "App navigation" })
              .getByRole("link", { name: "Accounts", exact: true })
              .click(),
          );
          // The row's menu button can leave the accessibility tree before the unlink is answered,
          // so the reads below wait for the unlink's own response.
          const unlinked = yield* browser.use("Unlink Work from Accounts", (page) =>
            Promise.all([
              page.waitForResponse(
                (response) =>
                  response.request().method() === "DELETE" &&
                  new URL(response.url()).pathname.endsWith(workLink),
              ),
              page
                .getByRole("list", { name: "Grouped fixture accounts", exact: true })
                .getByRole("button", { name: "Manage Work", exact: true })
                .click()
                .then(() => page.getByRole("menuitem", { name: "Unlink", exact: true }).click()),
            ]).then(([response]) => response.status()),
          );
          expect(unlinked).toBe(200);
          // Both accounts stay listed as ones the owner could link again, neither selected.
          yield* browser.use("Unlink Work from Accounts", (page) =>
            page
              .getByRole("list", { name: "Grouped fixture accounts", exact: true })
              .getByRole("radio", { name: "Work", exact: true, checked: false })
              .waitFor(),
          );
        });
        // Unlinking keeps both accounts, and no saved account is used in place of a link.
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([]);
        for (const account of [work, personal])
          expect(
            (yield* api.request(actors.owner, "GET", `${prefix}/accounts/${account}`)).status,
          ).toBe(200);
        const unlinkedCall = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "identity",
          kind: "query",
          input: {},
        });
        expect(unlinkedCall.status, JSON.stringify(unlinkedCall.body)).toBe(409);
        expect(unlinkedCall.body).toMatchObject({ _tag: "AccountRequired", slot: "service" });
        yield* browser.use("Open tools without a linked account", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=tools`),
        );
        yield* browser.use("Tools ask for a linked account", (page) =>
          page
            .getByText("Link an account in Accounts to start using this app.", { exact: true })
            .waitFor(),
        );
        expect(
          yield* browser.use("No catalog loads without a linked account", (page) =>
            page.getByRole("navigation", { name: "App tools", exact: true }).count(),
          ),
        ).toBe(0);
      }),
    ),
  );
});
