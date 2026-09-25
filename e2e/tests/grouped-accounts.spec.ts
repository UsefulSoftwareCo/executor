import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { holdQuery } from "../support/query-transition.ts";
import { scenarios } from "../test-plan.ts";

const fixture = `import {defineApp,defineProvider,secrets,query,object,string} from "apps";
const service=defineProvider({name:"Grouped fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const identity=query({input:object({})},async ctx=>({account:ctx.accounts.service.id}));
export default defineApp({accounts:{service}},async ctx=>({queries:ctx.accounts.service.fields.token==="work"?{identity,common:identity,labels:identity,threads:identity}:{identity,common:identity,drafts:identity}}));`;

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
            files: [{ path: "index.ts", content: fixture }],
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
            const profile = yield* body(
              Resource,
              yield* api.request(actors.owner, "POST", `${path}/profiles`, {
                name: label,
                accounts: {},
                idempotencyKey: randomUUID(),
              }),
            );
            const connection = yield* body(
              Resource,
              yield* api.request(actors.owner, "POST", `${path}/connections`, {
                profile: profile.id,
                requirement: "service",
              }),
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
            return { profile: profile.id, account: account.id };
          });
        const personal = yield* create("Personal", "personal"),
          work = yield* create("Work", "work");
        const unfinished = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${path}/profiles`, {
            accounts: {},
            idempotencyKey: randomUUID(),
          }),
        );
        expect(
          (yield* api.request(actors.owner, "GET", `${path}/tools?profile=${unfinished.id}`))
            .status,
        ).toBe(409);
        yield* browser.login(actors.owner);
        yield* browser.use("Open the app summary", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=overview`),
        );
        for (const name of ["queries.drafts", "queries.labels"])
          yield* browser.use(`Summary includes ${name}`, (page) =>
            page
              .getByRole("region", { name: "App tools preview" })
              .getByRole("link")
              .filter({ has: page.getByText(name, { exact: true }) })
              .waitFor({ state: "visible" }),
          );
        expect(
          yield* browser.use("Incomplete setup does not fail the app preview", (page) =>
            page
              .getByRole("region", { name: "App tools preview" })
              .getByText("Unable to complete this request", { exact: true })
              .count(),
          ),
        ).toBe(0);
        yield* Effect.gen(function* () {
          const summary = yield* browser.use("Accounts summarizes incomplete setup once", (page) =>
            Promise.resolve(page.getByRole("region", { name: "App accounts", exact: true })),
          );
          yield* browser.use("Accounts summarizes incomplete setup once", () =>
            summary.getByText("2 accounts", { exact: true }).waitFor(),
          );
          yield* browser.use("Accounts summarizes incomplete setup once", () =>
            summary.getByText("1 profile needs accounts", { exact: true }).waitFor(),
          );
        });
        expect(
          yield* browser.use("Duplicate tools appear once in the summary", (page) =>
            page
              .getByRole("region", { name: "App tools preview" })
              .getByRole("link")
              .filter({ has: page.getByText("queries.common", { exact: true }) })
              .count(),
          ),
        ).toBe(1);
        expect(
          yield* browser.use("Summary has no account groups", (page) =>
            page
              .getByRole("main")
              .getByRole("button", { name: /^(Personal|Work)/ })
              .count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Overview summarizes the app without account groups");
        const choose = (label: string) =>
          Effect.gen(function* () {
            yield* browser.use(`Choose ${label}`, (page) =>
              page.getByRole("button", { name: "Choose profile", exact: true }).click(),
            );
            yield* browser.use(`Choose ${label}`, (page) =>
              page.getByRole("menuitemradio", { name: label, exact: true }).click(),
            );
          });
        yield* browser.use("Open Personal tools", (page) =>
          page.goto(
            `/org/${actors.organization.slug}/apps/${app.id}?view=tools&profile=${personal.profile}`,
          ),
        );
        yield* Effect.gen(function* () {
          yield* browser.use("Personal has its own full catalog", (page) =>
            page.getByRole("button", { name: "queries.drafts", exact: true }).waitFor(),
          );
          expect(
            yield* browser.use("Personal has its own full catalog", (page) =>
              page.getByRole("button", { name: "queries.threads", exact: true }).count(),
            ),
          ).toBe(0);
          expect(
            yield* browser.use("Personal has its own full catalog", (page) =>
              page
                .getByRole("navigation", { name: "App tools", exact: true })
                .locator("button[aria-pressed]")
                .count(),
            ),
          ).toBe(3);
        });
        const held = yield* holdQuery(
          [actors.organization.id, actors.organization.slug].map(
            (id) => `/api/organizations/${id}/apps/${app.id}/tools/index`,
          ),
          "fail",
          { query: { profile: work.profile } },
        );
        yield* choose("Work");
        yield* held.requested;
        expect(
          yield* browser.use("Personal tools disappear during the switch", (page) =>
            page.getByRole("button", { name: "queries.drafts", exact: true }).count(),
          ),
        ).toBe(0);
        yield* held.release;
        yield* browser.use("The selected catalog failure is visible", (page) =>
          page.getByRole("alert", { name: "Action unavailable", exact: true }).waitFor(),
        );
        yield* browser.use("Retry Work", (page) =>
          page.getByRole("button", { name: "Try again", exact: true }).click(),
        );
        yield* Effect.gen(function* () {
          yield* browser.use("Work has its own full catalog", (page) =>
            page.getByRole("button", { name: "queries.threads", exact: true }).waitFor(),
          );
          expect(
            yield* browser.use("Work has its own full catalog", (page) =>
              page.getByRole("button", { name: "queries.drafts", exact: true }).count(),
            ),
          ).toBe(0);
          expect(
            yield* browser.use("Work has its own full catalog", (page) =>
              page
                .getByRole("navigation", { name: "App tools", exact: true })
                .locator("button[aria-pressed]")
                .count(),
            ),
          ).toBe(4);
        });
        for (const [label, expected] of [
          ["Personal", personal.account],
          ["Work", work.account],
        ] as const) {
          yield* choose(label);
          yield* Effect.gen(function* () {
            yield* browser.use(`Run the same tool as ${label}`, (page) =>
              page.getByRole("button", { name: "queries.identity", exact: true }).click(),
            );
            yield* browser.use(`Run the same tool as ${label}`, (page) =>
              page.getByRole("textbox", { name: "Input", exact: true }).fill("{}"),
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
        }
        yield* Effect.gen(function* () {
          yield* browser.use("Disable Work from Accounts", (page) =>
            page
              .getByRole("navigation", { name: "App navigation" })
              .getByRole("link", { name: "Accounts", exact: true })
              .click(),
          );
          yield* browser.use("Disable Work from Accounts", (page) =>
            page.getByRole("button", { name: "Choose profile", exact: true }).click(),
          );
          yield* browser.use("Disable Work from Accounts", (page) =>
            page.getByRole("menuitemcheckbox", { name: "Enabled", exact: true }).click(),
          );
          yield* browser.use("Disable Work from Accounts", (page) =>
            page.getByRole("menuitemcheckbox", { name: "Enabled", exact: true }).press("Escape"),
          );
          yield* browser.use("Disable Work from Accounts", (page) =>
            page
              .getByRole("navigation", { name: "App navigation" })
              .getByRole("link", { name: "Tools", exact: true })
              .click(),
          );
          yield* browser.use("Disable Work from Accounts", (page) =>
            page.getByText("This profile is disabled.", { exact: false }).waitFor(),
          );
        });
        const state = yield* body(
          Schema.Struct({
            enabled: Schema.Boolean,
            accounts: Schema.Struct({ service: Schema.String }),
          }),
          yield* api.request(actors.owner, "GET", `${path}/profiles/${work.profile}`),
        );
        expect(state.enabled).toBe(false);
        expect(state.accounts.service).toBe(work.account);
        yield* choose("Personal");
        yield* browser.use("Personal stays usable", (page) =>
          page.getByRole("button", { name: "queries.identity", exact: true }).waitFor(),
        );
        yield* browser.use("Reload the disabled profile directly", (page) =>
          page.goto(
            `/org/${actors.organization.slug}/apps/${app.id}?view=accounts&profile=${work.profile}`,
          ),
        );
        yield* Effect.gen(function* () {
          yield* browser.use("Disabled profile remains configurable", (page) =>
            page
              .getByRole("button", { name: "Switch Grouped fixture account", exact: true })
              .waitFor(),
          );
          yield* browser.use("Disabled profile remains configurable", (page) =>
            page.getByRole("button", { name: "Choose profile", exact: true }).click(),
          );
          expect(
            yield* browser.use("Disabled profile remains configurable", (page) =>
              page
                .getByRole("menuitemcheckbox", { name: "Enabled", exact: true })
                .getAttribute("aria-checked"),
            ),
          ).toBe("false");
          yield* browser.use("Disabled profile remains configurable", (page) =>
            page.getByRole("menuitemcheckbox", { name: "Enabled", exact: true }).click(),
          );
          yield* browser.use("Disabled profile remains configurable", (page) =>
            page.getByRole("menuitemcheckbox", { name: "Enabled", exact: true }).press("Escape"),
          );
        });
        yield* Effect.gen(function* () {
          yield* browser.use("An unavailable selection never falls back", (page) =>
            page.goto(
              `/org/${actors.organization.slug}/apps/${app.id}?view=tools&profile=ins_missing`,
            ),
          );
          yield* browser.use("An unavailable selection never falls back", (page) =>
            page
              .getByText("This profile is unavailable. Choose another profile in Accounts.", {
                exact: true,
              })
              .waitFor(),
          );
          expect(
            yield* browser.use("An unavailable selection never falls back", (page) =>
              page.getByRole("navigation", { name: "App tools", exact: true }).count(),
            ),
          ).toBe(0);
        });
      }),
    ),
  );
});
