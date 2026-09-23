import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

layer(TestLive, { excludeTestServices: true })("Local query state", (it) => {
  it.effect(scenarios.localQueryState.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const browser = yield* Browser;
        const target = yield* Target;
        const session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const deployed = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: `Local drafts ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `
import { defineApp, defineProvider, secrets, object, string } from "apps";
const service = defineProvider({ name: "Draft test service", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ accounts: { service } }, async () => ({  }));
`,
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
              owner: Schema.String,
              requirements: Schema.Struct({
                accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
              }),
            }),
          }),
          deployed,
        );
        const owned = [`/v1/apps/${app.id}`];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(owned, (path) =>
            session
              .send("DELETE", path, undefined, headers)
              .pipe(Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200)))),
          ).pipe(Effect.orDie),
        );
        const addAccount = (label: string) =>
          Effect.gen(function* () {
            const response = yield* session.send(
              "POST",
              "/v1/accounts",
              {
                owner: app.owner,
                provider: app.requirements.accounts.service.provider,
                method: "key",
                label,
                fields: { token: "synthetic-local-draft-token" },
              },
              headers,
            );
            expect(response.status).toBe(200);
            const account = yield* body(Resource, response);
            owned.push(`/v1/accounts/${account.id}`);
            return account;
          });
        const first = yield* addAccount("First draft account");
        const second = yield* addAccount("Second draft account");
        const pairing = yield* session.send("POST", "/auth/pair", undefined, headers);
        expect(pairing.status).toBe(200);
        const { url } = yield* body(Schema.Struct({ url: Schema.String }), pairing);
        yield* browser.use("Pair the local browser", (page) => page.goto(url));
        yield* browser.use("The paired inventory is visible", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible" }),
        );
        yield* browser.use("Open the first account", (page) => page.goto(`/accounts/${first.id}`));
        const draft = "Keep this unsaved account name";
        yield* browser.use("Edit the account name without saving", (page) =>
          page.getByRole("textbox", { name: "Account name", exact: true }).fill(draft),
        );
        expect(
          (yield* session.send("DELETE", `/v1/accounts/${first.id}`, undefined, headers)).status,
        ).toBe(200);
        yield* browser.use("The live account query reports removal", (page) =>
          page.locator(".setup-page .error-state").waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("The failed live read keeps the editor", (page) =>
            page.getByRole("textbox", { name: "Account name", exact: true }).count(),
          ),
        ).toBe(1);
        expect(
          yield* browser.use("The unsaved name remains available", (page) =>
            page.getByRole("textbox", { name: "Account name", exact: true }).inputValue(),
          ),
        ).toBe(draft);
        yield* browser.checkpoint("Local account draft survives a live read failure");
        yield* browser.use("Return to the account list", (page) =>
          page.locator(".back-link").click(),
        );
        yield* browser.use("Choose a different account", (page) =>
          page.getByRole("link", { name: "Second draft account", exact: true }).click(),
        );
        yield* browser.use("The second resource is selected", (page) =>
          page.waitForURL((url) => url.pathname === `/accounts/${second.id}`),
        );
        expect(
          yield* browser.use("A different account starts with its own name", (page) =>
            page.getByRole("textbox", { name: "Account name", exact: true }).inputValue(),
          ),
        ).toBe("Second draft account");
        yield* browser.use("Open account selection", (page) => page.goto(`/apps/${app.id}/setup`));
        yield* browser.use("Choose a saved account", (page) => page.getByRole("combobox").click());
        yield* browser.use("Make an unsaved account selection", (page) =>
          page.getByRole("option", { name: "Second draft account", exact: true }).click(),
        );
        yield* browser.use("The account picker has closed", (page) =>
          page.getByRole("listbox").waitFor({ state: "hidden" }),
        );
        expect(
          (yield* session.send("DELETE", `/v1/apps/${app.id}`, undefined, headers)).status,
        ).toBe(200);
        yield* browser.use("The live app query reports removal", (page) =>
          page
            .getByRole("dialog", { name: "Choose accounts", exact: true })
            .getByText("App not found", { exact: true })
            .waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("The failed live read keeps account selection", (page) =>
            page.getByRole("combobox").count(),
          ),
        ).toBe(1);
        expect(
          yield* browser.use("The unsaved selection remains available", (page) =>
            page.getByRole("combobox").textContent(),
          ),
        ).toContain("Second draft account");
        yield* browser.checkpoint("Local account selection survives a live read failure");
      }),
    ),
  );
});
