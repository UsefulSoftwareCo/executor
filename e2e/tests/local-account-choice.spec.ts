/**
 * Local apps use the accounts linked to them. The Accounts tab links, replaces and unlinks them; a
 * plain requirement uses its one linked account and a many() requirement every linked one. Agents
 * cannot choose accounts per call.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { body, type Session } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { McpClient } from "../support/mcp-client.ts";
import { nameConnectedAccount } from "../support/name-account.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";
import { connectLocalAccount } from "../support/app-accounts.ts";
import {
  accountChoices,
  chooseAccount,
  linkedChoice,
  linkedLabels,
} from "../support/account-choices.ts";
import {
  callLocalQuery,
  linkLocal,
  localAgent,
  localLinks,
  pairLocalBrowser,
  unlinkLocal,
} from "../support/local-links.ts";

const mailProvider = `defineProvider({name:"Mail",auth:{key:secrets({label:"Key",fields:object({token:string()})})}})`;
/** An app whose `service` requirement is `requirement`; its query reports the accounts it ran with. */
const mailApp = (requirement: "service" | "service.many()") => [
  {
    path: "index.ts",
    content: `import {defineApp,defineProvider,secrets,query,object,string,router} from "apps";
const service=${mailProvider};
export default defineApp({user: { accounts:{mail:${requirement}} }},async ctx=>({tools: router({
  identity:query({input:object({})},async()=>${requirement === "service" ? "ctx.user.accounts.mail.id" : "ctx.user.accounts.mail.map(a=>a.id)"}),
})}));`,
  },
  appsManifest,
];
const mailRegion = (page: Page) => page.getByRole("region", { name: "Mail", exact: true });
/** The Mail requirement's linked accounts, in the order shown. */
const linkedMail = (page: Page) => linkedLabels(mailRegion(page), "Mail");
/** Every account the Mail requirement lists, with whether its control is checked. */
const mailChoices = (page: Page) =>
  accountChoices(mailRegion(page), "Mail")
    .locator('[role="radio"], [role="checkbox"]')
    .evaluateAll((controls) =>
      controls.map((control) => [
        control.getAttribute("aria-label") ?? "",
        control.getAttribute("aria-checked") ?? "",
      ]),
    );
const Failure = Schema.Struct({ _tag: Schema.String });

/** Deploy a mail app and remove it, and the accounts the scenario saved, at the end. */
const deploy = (agent: Session, requirement: "service" | "service.many()", saved: string[]) =>
  Effect.gen(function* () {
    const deployed = yield* agent.send("POST", "/v1/apps/deploy", {
      owner: "local",
      name: `Mail ${requirement === "service" ? "one" : "all"} ${randomUUID().slice(0, 6)}`,
      files: mailApp(requirement),
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const { app } = yield* body(Schema.Struct({ app: App }), deployed);
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* agent.send("DELETE", `/v1/apps/${app.id}`);
        for (const account of saved.splice(0))
          yield* agent.send("DELETE", `/v1/accounts/${account}`);
      }).pipe(Effect.orDie),
    );
    return app;
  });

layer(TestLive, { excludeTestServices: true })("Local account links", (it) => {
  it.effect(scenarios.localAccountChoice.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const { agent } = yield* localAgent;
        const saved: string[] = [];
        const one = yield* deploy(agent, "service", saved);
        const all = yield* deploy(agent, "service.many()", saved);
        yield* pairLocalBrowser(agent);
        const openAccounts = (app: string) =>
          browser.use("Open the app's Accounts tab", (page) =>
            page
              .goto(`/apps/${app}?view=accounts`)
              .then(() => mailRegion(page).waitFor({ state: "visible" })),
          );
        const note = (text: string) =>
          browser.use(`The requirement says: ${text}`, (page) =>
            mailRegion(page).getByText(text, { exact: true }).waitFor(),
          );
        /** Connect a new account from the open Accounts tab; connecting links it to the app. */
        const connectNew = (label: string) =>
          Effect.gen(function* () {
            yield* browser.use(`Connect ${label}`, (page) =>
              mailRegion(page)
                .getByRole("button", { name: "Connect new account", exact: true })
                .click(),
            );
            yield* browser.use(`Enter ${label}'s credential`, (page) =>
              page.getByLabel("Token", { exact: true }).fill(`synthetic-${randomUUID()}`),
            );
            yield* browser.use(`Save ${label}`, (page) =>
              page.getByRole("button", { name: "Add account", exact: true }).click(),
            );
            yield* browser.use(`Name ${label}`, (page) => nameConnectedAccount(page, label));
            yield* browser.use(`${label} is linked`, (page) =>
              linkedChoice(mailRegion(page), "Mail", label).waitFor(),
            );
          });
        /** Link a saved account by selecting it in the requirement's list. */
        const linkExisting = (label: string) =>
          browser.use(`Link ${label}`, (page) => chooseAccount(mailRegion(page), "Mail", label));

        // A plain requirement with nothing linked offers to connect one.
        yield* openAccounts(one.id);
        yield* note("Link an account to use this app.");
        yield* connectNew("Personal mail");
        yield* note("The app uses this account when you use it.");
        const [personal] = yield* localLinks(agent, one.id);
        if (personal === undefined) return yield* Effect.die("Personal mail is not linked");
        saved.push(personal);
        expect(yield* callLocalQuery(agent, one.id, "identity")).toBe(personal);

        // A saved account is linked to another app only when linked there; many() adds each one.
        expect(yield* localLinks(agent, all.id)).toEqual([]);
        yield* openAccounts(all.id);
        yield* note("The app uses every account you link.");
        yield* linkExisting("Personal mail");
        yield* connectNew("Work mail");
        const linkedToAll = yield* localLinks(agent, all.id);
        const work = linkedToAll.find((id) => id !== personal);
        if (work === undefined) return yield* Effect.die("Work mail is not linked");
        saved.push(work);
        expect(linkedToAll).toEqual([personal, work]);
        expect(yield* browser.use("Both accounts are checked", linkedMail)).toEqual([
          "Personal mail",
          "Work mail",
        ]);
        expect(yield* callLocalQuery(agent, all.id, "identity")).toEqual([personal, work]);
        // Connecting from the many() app did not link Work mail to the plain app.
        expect(yield* localLinks(agent, one.id)).toEqual([personal]);
        yield* browser.checkpoint("A many() requirement uses every linked account");

        // Selecting another account for the plain requirement links it instead of the old one.
        yield* openAccounts(one.id);
        yield* browser.use("The saved Work mail is offered", (page) =>
          accountChoices(mailRegion(page), "Mail")
            .getByRole("radio", { name: "Work mail", exact: true })
            .waitFor(),
        );
        expect(
          yield* browser.use("Personal mail is selected, Work mail offered", (page) =>
            Promise.all([
              mailChoices(page),
              mailRegion(page)
                .getByRole("button", { name: "Connect new account", exact: true })
                .count(),
            ]),
          ),
        ).toEqual([
          [
            ["Personal mail", "true"],
            ["Work mail", "false"],
          ],
          1,
        ]);
        yield* linkExisting("Work mail");
        yield* browser.use("Personal mail is no longer selected", (page) =>
          accountChoices(mailRegion(page), "Mail")
            .getByRole("radio", { name: "Personal mail", exact: true, checked: false })
            .waitFor(),
        );
        expect(yield* browser.use("Read the linked accounts", linkedMail)).toEqual(["Work mail"]);
        yield* browser.checkpoint("Linking another account replaces the plain requirement's");
        expect(yield* localLinks(agent, one.id)).toEqual([work]);
        expect(yield* callLocalQuery(agent, one.id, "identity")).toBe(work);
        // The replaced account stays saved and stays linked to the other app.
        expect((yield* agent.send("GET", `/v1/accounts/${personal}`)).status).toBe(200);
        expect(yield* localLinks(agent, all.id)).toEqual([personal, work]);

        // The tool runner names the linked account; it offers no choice.
        yield* browser.use("Open the plain app's tool", (page) =>
          page.goto(`/apps/${one.id}?view=tools&tool=identity`),
        );
        yield* browser.use("The runner runs as the linked account", (page) =>
          page.getByText("Running as", { exact: false }).getByText("Work mail").waitFor(),
        );
        expect(
          yield* browser.use("The runner has no account picker", (page) =>
            page.getByRole("combobox").count(),
          ),
        ).toBe(0);

        // Unlinking stops the many() app using an account; the account stays saved.
        yield* openAccounts(all.id);
        yield* browser.use("Open Personal mail's menu", (page) =>
          mailRegion(page)
            .getByRole("button", { name: "Manage Personal mail", exact: true })
            .click(),
        );
        yield* browser.use("Unlink Personal mail", (page) =>
          page.getByRole("menuitem", { name: "Unlink", exact: true }).click(),
        );
        // No app uses Personal mail now, so the tab offers to delete it; keep it.
        yield* browser.use("Keep the unused account", (page) =>
          page
            .getByRole("dialog", { name: "Delete unused account?", exact: true })
            .getByRole("button", { name: "Keep account", exact: true })
            .click(),
        );
        yield* browser.use("Personal mail is no longer checked", (page) =>
          accountChoices(mailRegion(page), "Mail")
            .getByRole("checkbox", { name: "Personal mail", exact: true, checked: false })
            .waitFor(),
        );
        expect(yield* browser.use("Read the linked accounts", linkedMail)).toEqual(["Work mail"]);
        expect(yield* localLinks(agent, all.id)).toEqual([work]);
        expect(yield* callLocalQuery(agent, all.id, "identity")).toEqual([work]);
        expect((yield* agent.send("GET", `/v1/accounts/${personal}`)).status).toBe(200);

        // Connecting from the plain app replaces its account too; the other app keeps its link.
        yield* openAccounts(one.id);
        yield* connectNew("Home mail");
        expect(yield* browser.use("Home mail replaced Work mail", linkedMail)).toEqual([
          "Home mail",
        ]);
        const [home] = yield* localLinks(agent, one.id);
        if (home === undefined || home === work)
          return yield* Effect.die("Home mail is not linked");
        saved.push(home);
        expect(yield* localLinks(agent, one.id)).toEqual([home]);
        expect(yield* localLinks(agent, all.id)).toEqual([work]);

        // With nothing linked, the plain app has no account to run with.
        yield* unlinkLocal(agent, one.id, "mail", home);
        const unlinked = yield* agent.send("POST", "/v1/tools/call", {
          app: one.id,
          tool: "identity",
          kind: "query",
          input: {},
        });
        expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(409);
        expect((yield* body(Failure, unlinked))._tag).toBe("AccountRequired");
        yield* browser.use("Reload the Accounts tab", (page) => page.reload());
        yield* note("Link an account to use this app.");
        yield* browser.checkpoint("A plain requirement with nothing linked");
      }),
    ),
  );

  it.effect(scenarios.localAccountChoiceUnsupported.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const mcp = yield* McpClient;
        const { agent, target } = yield* localAgent;
        const saved: string[] = [];
        const one = yield* deploy(agent, "service", saved);
        // An account saved for another app is not used until it is linked.
        const other = yield* deploy(agent, "service.many()", saved);
        const account = yield* connectLocalAccount(agent, {
          app: other.id,
          requirement: "mail",
          method: "key",
          label: "Saved mail",
          fields: { token: "synthetic" },
        });
        saved.push(account.id);
        expect(yield* localLinks(agent, one.id)).toEqual([]);
        yield* linkLocal(agent, one.id, "mail", account.id);
        expect(yield* callLocalQuery(agent, one.id, "identity")).toBe(account.id);
        const choice = { mail: [account.id] };

        // The SDK routes refuse a choice in a call's body and in a query.
        const called = yield* agent.send("POST", "/v1/tools/call", {
          app: one.id,
          accounts: choice,
          tool: "identity",
          kind: "query",
          input: {},
        });
        expect(called.status, JSON.stringify(called.body)).toBe(400);
        expect((yield* body(Failure, called))._tag).toBe("AccountChoiceUnsupported");
        const listed = yield* agent.send(
          "GET",
          `/v1/tools?app=${one.id}&accounts=${encodeURIComponent(JSON.stringify(choice))}`,
        );
        expect(listed.status, JSON.stringify(listed.body)).toBe(400);
        expect((yield* body(Failure, listed))._tag).toBe("AccountChoiceUnsupported");
        // A choice in a shape the routes do not accept is refused the same way.
        const call = (accounts: unknown) =>
          agent.send("POST", "/v1/tools/call", {
            app: one.id,
            accounts,
            tool: "identity",
            kind: "query",
            input: {},
          });
        const list = (accounts: string) =>
          agent.send("GET", `/v1/tools?app=${one.id}&accounts=${encodeURIComponent(accounts)}`);
        const malformed = [
          yield* call("mail"),
          yield* call({ mail: ["not-an-account"] }),
          yield* call({ mail: { nested: [1, { mail: null }] } }),
          yield* call([account.id]),
          yield* list("mail"),
          yield* list(JSON.stringify({ mail: ["not-an-account"] })),
          yield* list(JSON.stringify({ mail: { nested: [1] } })),
        ];
        for (const refused of malformed) {
          expect(refused.status, JSON.stringify(refused.body)).toBe(400);
          expect(refused.body).toEqual(called.body);
        }
        // Another request the routes do not accept, naming no accounts, is invalid input.
        const invalid = yield* agent.send("POST", "/v1/tools/call", {
          app: one.id,
          tool: 42,
          kind: "query",
          input: {},
        });
        expect(invalid.status, JSON.stringify(invalid.body)).toBe(400);
        expect(invalid.body).toEqual({
          _tag: "RequestInvalid",
          message:
            "Could not accept this request's input. Check it against the operation's schema; submitted values are not repeated here.",
        });

        // Code mode refuses `$accounts` before running the tool.
        const client = yield* mcp.connect(target.apiKey, "local-account-choice");
        const execute = (code: string) =>
          client
            .use("Run a program that chooses an account", (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            )
            .pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(
                  Schema.Struct({
                    status: Schema.Literal("completed"),
                    execution: Schema.Struct({
                      ok: Schema.Boolean,
                      value: Schema.optional(Schema.Unknown),
                      error: Schema.optional(Schema.Struct({ message: Schema.String })),
                    }),
                  }),
                )(result.structuredContent),
              ),
            );
        const tool = `tools[${JSON.stringify(one.slug)}].identity`;
        const caught = yield* execute(
          `try { return await ${tool}({ $accounts: ${JSON.stringify(choice)} }); } catch (error) { return JSON.parse(error.message); }`,
        );
        expect(caught.execution.value).toMatchObject({
          code: "AccountChoiceUnsupported",
          status: 400,
        });
        const uncaught = yield* execute(
          `return await ${tool}({ $accounts: ${JSON.stringify(choice)} });`,
        );
        expect(uncaught.execution.ok).toBe(false);
        expect(uncaught.execution.error?.message).toMatch(
          /^AccountChoiceUnsupported \(HTTP 400\): Accounts are not chosen per call\./,
        );
        // Without a choice the program runs with the linked account.
        const linked = yield* execute(`return await ${tool}({});`);
        expect(linked.execution).toMatchObject({ ok: true, value: account.id });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
