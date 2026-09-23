/** Local uses the same account UX without hosted roles or organizations. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { Target } from "../support/platform.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";
layer(TestLive, { excludeTestServices: true })("Local profile picker", (it) => {
  it.effect(scenarios.localProfilePicker.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          target = yield* Target,
          session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const deployed = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: `Local inbox ${randomUUID().slice(0, 6)}`,
            files: [
              {
                path: "index.ts",
                content: `import {defineApp,defineProvider,secrets,query,object,string} from "apps";const service=defineProvider({name:"Mail",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});export default defineApp({accounts:{service}},async ctx=>({queries:{identity:query({input:object({}),description:ctx.accounts.service.id},async()=>ctx.accounts.service.id)}}));`,
              },
            ],
          },
          headers,
        );
        expect(deployed.status).toBe(200);
        const { app } = yield* body(
          Schema.Struct({
            app: Schema.Struct({
              id: Schema.String,
              requirements: Schema.Struct({
                accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
              }),
            }),
          }),
          deployed,
        );
        yield* Effect.addFinalizer(() =>
          session
            .send("DELETE", `/v1/apps/${app.id}`, undefined, headers)
            .pipe(Effect.asVoid, Effect.orDie),
        );
        const accounts: string[] = [];
        for (const label of ["Personal mail", "Work mail"]) {
          const response = yield* session.send(
            "POST",
            "/v1/accounts",
            {
              owner: "local",
              provider: app.requirements.accounts.service.provider,
              method: "key",
              label,
              fields: { token: "synthetic" },
            },
            headers,
          );
          expect(response.status).toBe(200);
          accounts.push((yield* body(Resource, response)).id);
        }
        const [personal, work] = accounts;
        if (!personal || !work) return yield* Effect.die("Missing accounts");
        const pair = yield* body(
          Schema.Struct({ url: Schema.String }),
          yield* session.send("POST", "/auth/pair", undefined, headers),
        );
        yield* browser.use("Pair the local dashboard", (page) => page.goto(pair.url));
        yield* browser.use("Wait for pairing to finish", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible" }),
        );
        yield* browser.use("Open the single app", (page) =>
          page.goto(`/apps/${app.id}?view=tools`),
        );
        for (const label of ["Personal mail", "Work mail"]) {
          yield* browser.use("Open local account management", (page) =>
            page
              .getByRole("navigation", { name: "App navigation" })
              .getByRole("link", { name: "Accounts", exact: true })
              .click(),
          );
          yield* Effect.gen(function* () {
            if (label === "Personal mail") {
              expect(
                yield* browser.use(`Choose accounts for ${label}`, (page) =>
                  page.getByRole("button", { name: "Choose profile", exact: true }).count(),
                ),
              ).toBe(0);
              yield* browser.use(`Choose accounts for ${label}`, (page) =>
                page.getByRole("button", { name: "Add Mail account", exact: true }).click(),
              );
            } else {
              yield* browser.use(`Choose accounts for ${label}`, (page) =>
                page.getByRole("button", { name: "Create a profile", exact: true }).first().click(),
              );
              yield* browser.use(`Choose accounts for ${label}`, (page) =>
                page.getByRole("textbox", { name: "Name", exact: true }).fill(label),
              );
              expect(
                yield* browser.use(`Choose accounts for ${label}`, (page) =>
                  page.getByRole("dialog").getByRole("combobox").count(),
                ),
              ).toBe(0);
              yield* browser.use(`Choose accounts for ${label}`, (page) =>
                page.getByRole("button", { name: "Create profile", exact: true }).click(),
              );
              yield* browser.use(`Choose accounts for ${label}`, (page) =>
                page.getByRole("dialog").waitFor({ state: "hidden" }),
              );
              yield* browser.use(`Choose accounts for ${label}`, (page) =>
                page.getByRole("button", { name: "Add Mail account", exact: true }).click(),
              );
            }
          });
          yield* browser.use("Choose a saved scalar account", (page) =>
            page.getByRole("combobox", { name: "Mail account", exact: true }).click(),
          );
          yield* browser.use("Select the saved identity", (page) =>
            page.getByRole("option", { name: label, exact: true }).click(),
          );
          yield* browser.use("Save this account selection", (page) =>
            page
              .getByRole("button", {
                name: "Save selection",
                exact: true,
              })
              .click(),
          );
          yield* browser.use("Open tools after saving accounts in place", (page) =>
            page
              .getByRole("navigation", { name: "App navigation" })
              .getByRole("link", { name: "Tools", exact: true })
              .click(),
          );
          yield* browser.use("The account's full tools load", (page) =>
            page.getByRole("button", { name: "queries.identity", exact: true }).waitFor(),
          );
        }
        yield* browser.use("Inspect the work account's tool", (page) =>
          page.getByRole("button", { name: "queries.identity", exact: true }).click(),
        );
        yield* browser.use("The description comes from the work account", (page) =>
          page.getByText(work, { exact: true }).waitFor(),
        );
        yield* Effect.gen(function* () {
          yield* browser.use("Select the personal profile", (page) =>
            page.getByRole("button", { name: "Choose profile", exact: true }).click(),
          );
          yield* browser.use("Select the personal profile", (page) =>
            page.getByRole("menuitemradio", { name: "Default", exact: true }).click(),
          );
        });
        yield* browser.use("Inspect the personal account's tool", (page) =>
          page.getByRole("button", { name: "queries.identity", exact: true }).click(),
        );
        expect(
          yield* browser.use("The selected detail no longer describes Work", (page) =>
            page.locator(".tool-detail").getByText(work, { exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.use("The description now comes from the personal account", (page) =>
          page.getByText(personal, { exact: true }).waitFor(),
        );
        const profiles = yield* body(
          Schema.Array(Resource),
          yield* session.send("GET", `/v1/apps/${app.id}/profiles`, undefined, headers),
        );
        expect(profiles).toHaveLength(2);
        const saved = yield* body(
          Schema.Record(Schema.String, Schema.Json),
          yield* session.send("GET", `/v1/apps/${app.id}`, undefined, headers),
        );
        expect(saved).not.toHaveProperty("accounts");
        yield* browser.checkpoint("Local profiles use one app and separate selections");
      }),
    ),
  );
});
