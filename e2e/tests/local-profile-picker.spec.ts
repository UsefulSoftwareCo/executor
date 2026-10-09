/** Local chooses profile accounts in place without hosted roles or organizations. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { Target } from "../support/platform.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { nameConnectedAccount } from "../support/name-account.ts";
import { Profile } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const slotRegion = (page: Page, slot: "service" | "mailboxes") =>
  page.getByRole("region", { name: `Mail (${slot})`, exact: true });
const accountChoice = (page: Page, label: string) =>
  slotRegion(page, "service").getByRole("radio", { name: label, exact: true });
const mailbox = (page: Page, label: string) =>
  slotRegion(page, "mailboxes").getByRole("checkbox", { name: label, exact: true });

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
                content: `import {defineApp,defineProvider,secrets,query,object,string, router} from "apps";const service=defineProvider({name:"Mail",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});export default defineApp({accounts:{service,mailboxes:service.many()}},async ctx=>({tools: router({
  identity:query({input:object({}),description:ctx.accounts.service.id},async()=>ctx.accounts.service.id),
})}));`,
              },
              appsManifest,
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
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* session.send("DELETE", `/v1/apps/${app.id}`, undefined, headers);
            for (const account of accounts)
              yield* session.send("DELETE", `/v1/accounts/${account}`, undefined, headers);
          }).pipe(Effect.orDie),
        );
        for (const label of ["Personal mail", "Spare mail"]) {
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
        const [personal, spare] = accounts;
        if (!personal || !spare) return yield* Effect.die("Missing accounts");
        const saved = (profile: string) =>
          Effect.gen(function* () {
            const response = yield* session.send(
              "GET",
              `/v1/apps/${app.id}/profiles/${profile}`,
              undefined,
              headers,
            );
            expect(response.status).toBe(200);
            return (yield* body(Profile, response)).accounts;
          });
        const shownProfile = browser.use("Read the shown profile", (page) =>
          Promise.resolve(new URL(page.url()).searchParams.get("profile")),
        );
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
        yield* browser.use("Open local account management", (page) =>
          page
            .getByRole("navigation", { name: "App navigation" })
            .getByRole("link", { name: "Accounts", exact: true })
            .click(),
        );
        yield* browser.use("Saved accounts are listed in place", (page) =>
          accountChoice(page, "Spare mail").waitFor(),
        );
        expect(
          yield* browser.use("No profile exists before the first choice", (page) =>
            Promise.all([
              page.getByRole("button", { name: "Choose profile", exact: true }).count(),
              slotRegion(page, "service").getByRole("radio", { checked: true }).count(),
              slotRegion(page, "mailboxes").getByRole("checkbox", { checked: true }).count(),
              slotRegion(page, "mailboxes").getByRole("checkbox").count(),
            ]),
          ),
        ).toEqual([0, 0, 0, 2]);

        yield* browser.use("Choose the spare account", (page) =>
          accountChoice(page, "Spare mail").click(),
        );
        yield* browser.use("The first choice creates the default profile", (page) =>
          page.waitForURL((url) => url.searchParams.get("profile") !== null),
        );
        yield* browser.use("The spare account is chosen", (page) =>
          page.getByRole("radio", { name: "Spare mail", exact: true, checked: true }).waitFor(),
        );
        const defaultProfile = yield* shownProfile;
        if (defaultProfile === null) return yield* Effect.die("Missing default profile");
        expect(yield* saved(defaultProfile)).toEqual({ service: spare, mailboxes: [] });
        yield* browser.use("Reload the saved choice", (page) => page.reload());
        yield* browser.use("The spare account is still chosen after reload", (page) =>
          page.getByRole("radio", { name: "Spare mail", exact: true, checked: true }).waitFor(),
        );
        yield* browser.use("Switch to the personal account", (page) =>
          accountChoice(page, "Personal mail").click(),
        );
        yield* browser.use("The personal account replaces the spare account", (page) =>
          page.getByRole("radio", { name: "Personal mail", exact: true, checked: true }).waitFor(),
        );
        expect(
          yield* browser.use("Only one account is chosen", (page) =>
            slotRegion(page, "service").getByRole("radio", { checked: true }).count(),
          ),
        ).toBe(1);
        expect(yield* saved(defaultProfile)).toEqual({ service: personal, mailboxes: [] });

        for (const [label, expected] of [
          ["Personal mail", [personal]],
          ["Spare mail", [personal, spare]],
        ] as const) {
          yield* browser.use(`Check ${label} as a mailbox`, (page) => mailbox(page, label).click());
          yield* browser.use(`${label} is saved as a mailbox`, (page) =>
            slotRegion(page, "mailboxes")
              .getByRole("checkbox", { name: label, exact: true, checked: true })
              .waitFor(),
          );
          expect((yield* saved(defaultProfile)).mailboxes).toEqual(expected);
        }
        yield* browser.use("Reload the saved mailboxes", (page) => page.reload());
        for (const label of ["Personal mail", "Spare mail"])
          yield* browser.use(`${label} is still checked after reload`, (page) =>
            slotRegion(page, "mailboxes")
              .getByRole("checkbox", { name: label, exact: true, checked: true })
              .waitFor(),
          );
        yield* browser.use("Uncheck the spare mailbox", (page) =>
          mailbox(page, "Spare mail").click(),
        );
        yield* browser.use("The spare mailbox is removed", (page) =>
          slotRegion(page, "mailboxes")
            .getByRole("checkbox", { name: "Spare mail", exact: true, checked: false })
            .waitFor(),
        );
        expect(yield* saved(defaultProfile)).toEqual({ service: personal, mailboxes: [personal] });
        expect(yield* shownProfile).toBe(defaultProfile);
        yield* browser.checkpoint("Local account choices save in place");

        yield* browser.use("Create a work profile", (page) =>
          page.getByRole("button", { name: "Create a profile", exact: true }).first().click(),
        );
        yield* browser.use("Name the work profile", (page) =>
          page.getByRole("textbox", { name: "Name", exact: true }).fill("Work mail"),
        );
        expect(
          yield* browser.use("Profile creation asks for no accounts", (page) =>
            page.getByRole("dialog").getByRole("combobox").count(),
          ),
        ).toBe(0);
        yield* browser.use("Save the work profile", (page) =>
          page.getByRole("button", { name: "Create profile", exact: true }).click(),
        );
        yield* browser.use("The profile dialog closes", (page) =>
          page.getByRole("dialog").waitFor({ state: "hidden" }),
        );
        yield* browser.use("The work profile is shown", (page) =>
          page.waitForURL((url) => {
            const shown = url.searchParams.get("profile");
            return shown !== null && shown !== defaultProfile;
          }),
        );
        const workProfile = yield* shownProfile;
        if (workProfile === null) return yield* Effect.die("Missing work profile");
        const connect = (slot: "service" | "mailboxes", label: string) =>
          Effect.gen(function* () {
            yield* browser.use(`Connect ${label}`, (page) =>
              slotRegion(page, slot)
                .getByRole("button", { name: "Connect new account", exact: true })
                .click(),
            );
            yield* browser.use(`Enter the credential for ${label}`, (page) =>
              page.getByLabel("Token", { exact: true }).fill("synthetic"),
            );
            yield* browser.use(`Save ${label}`, (page) =>
              page.getByRole("button", { name: "Add account", exact: true }).click(),
            );
            // A new account is named once saved, in the dialog that replaces the connection form.
            yield* browser.use(`Name ${label}`, (page) => nameConnectedAccount(page, label));
            yield* browser.use(`The connection dialog closes for ${label}`, (page) =>
              page.getByRole("dialog").waitFor({ state: "hidden" }),
            );
          });
        yield* connect("service", "Work mail");
        yield* browser.use("The new account is chosen for the work profile", (page) =>
          page.getByRole("radio", { name: "Work mail", exact: true, checked: true }).waitFor(),
        );
        const workAccounts = yield* saved(workProfile);
        const work = workAccounts.service;
        if (typeof work !== "string") return yield* Effect.die("Missing work account");
        accounts.push(work);
        expect([personal, spare]).not.toContain(work);
        expect(workAccounts).toEqual({ service: work, mailboxes: [] });
        yield* browser.use("Check the personal mailbox for work", (page) =>
          mailbox(page, "Personal mail").click(),
        );
        yield* browser.use("The personal mailbox is saved for work", (page) =>
          slotRegion(page, "mailboxes")
            .getByRole("checkbox", { name: "Personal mail", exact: true, checked: true })
            .waitFor(),
        );
        yield* connect("mailboxes", "Work archive");
        yield* browser.use("The new mailbox is added beside the existing one", (page) =>
          slotRegion(page, "mailboxes")
            .getByRole("checkbox", { name: "Work archive", exact: true, checked: true })
            .waitFor(),
        );
        const workMailboxes = (yield* saved(workProfile)).mailboxes;
        if (!Array.isArray(workMailboxes)) return yield* Effect.die("Missing work mailboxes");
        const archive = workMailboxes.find((id) => ![personal, spare, work].includes(id));
        if (archive === undefined) return yield* Effect.die("Missing archive account");
        accounts.push(archive);
        expect(workMailboxes).toEqual([personal, archive]);
        expect(yield* saved(defaultProfile)).toEqual({ service: personal, mailboxes: [personal] });
        yield* browser.checkpoint("Connected accounts are chosen in place");

        // An account connected here and then deleted leaves the list, even before any reload.
        const mailboxRows = browser.use("Read the mailbox rows", (page) =>
          slotRegion(page, "mailboxes")
            .getByRole("checkbox")
            .evaluateAll((boxes) => boxes.map((box) => box.closest("label")?.textContent ?? "")),
        );
        const rowsBefore = yield* mailboxRows;
        yield* connect("mailboxes", "Old mailbox");
        const oldMailbox = (page: Page) =>
          slotRegion(page, "mailboxes").getByRole("checkbox", { name: "Old mailbox", exact: true });
        yield* browser.use("The old mailbox is chosen", (page) =>
          slotRegion(page, "mailboxes")
            .getByRole("checkbox", { name: "Old mailbox", exact: true, checked: true })
            .waitFor(),
        );
        yield* browser.use("Remove the old mailbox from its row", (page) =>
          oldMailbox(page).hover(),
        );
        yield* browser.use("Remove the old mailbox from its row", (page) =>
          slotRegion(page, "mailboxes")
            .getByRole("button", { name: "Manage Old mailbox", exact: true })
            .click()
            .then(() => page.getByRole("menuitem", { name: "Remove", exact: true }).click()),
        );
        yield* browser.use("Delete the old mailbox when offered", (page) =>
          page
            .getByRole("dialog", { name: "Delete unused account?" })
            .getByRole("button", { name: "Delete account", exact: true })
            .click(),
        );
        yield* browser.use("The deletion offer closes", (page) =>
          page.getByRole("dialog", { name: "Delete unused account?" }).waitFor({ state: "hidden" }),
        );
        yield* browser.use("The deleted mailbox leaves the list", (page) =>
          oldMailbox(page).waitFor({ state: "detached" }),
        );
        expect((yield* saved(workProfile)).mailboxes).toEqual([personal, archive]);
        expect(yield* mailboxRows).toEqual(rowsBefore);

        yield* browser.use("Open tools after choosing accounts in place", (page) =>
          page
            .getByRole("navigation", { name: "App navigation" })
            .getByRole("link", { name: "Tools", exact: true })
            .click(),
        );
        yield* browser.use("Inspect the work account's tool", (page) =>
          page.getByRole("button", { name: "identity", exact: true }).click(),
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
          page.getByRole("button", { name: "identity", exact: true }).click(),
        );
        expect(
          yield* browser.use("The selected detail no longer describes Work", (page) =>
            page.locator(".tool-detail").getByText(work, { exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.use("The description now comes from the personal account", (page) =>
          page.getByText(personal, { exact: true }).waitFor(),
        );

        // Connections select their account on the server, so setup links only open Accounts.
        yield* browser.use("A setup link opens the app's Accounts", (page) =>
          page
            .goto(`/apps/${app.id}/setup?profile=${defaultProfile}`)
            .then(() =>
              page.waitForURL(
                (url) =>
                  url.pathname === `/apps/${app.id}` && url.searchParams.get("view") === "accounts",
              ),
            ),
        );
        expect(yield* saved(workProfile)).toEqual({
          service: work,
          mailboxes: [personal, archive],
        });

        const profiles = yield* body(
          Schema.Array(Resource),
          yield* session.send("GET", `/v1/apps/${app.id}/profiles`, undefined, headers),
        );
        expect(profiles).toHaveLength(2);
        const stored = yield* body(
          Schema.Record(Schema.String, Schema.Json),
          yield* session.send("GET", `/v1/apps/${app.id}`, undefined, headers),
        );
        expect(stored).not.toHaveProperty("accounts");
        yield* browser.checkpoint("Local profiles use one app and separate selections");
      }),
    ),
  );
});
