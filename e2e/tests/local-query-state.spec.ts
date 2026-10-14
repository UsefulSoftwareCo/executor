import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { connectLocalAccount } from "../support/app-accounts.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

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
        // Agent calls carry the API key and no browser origin.
        const agent: Session = {
          ...session,
          send: (method, path, data, extra = {}) => {
            const { origin: _origin, ...rest } = extra;
            return session.send(method, path, data, { ...rest, ...headers });
          },
        };
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
export default defineApp({ user: { accounts: { service } } }, async () => ({  }));
`,
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
            const account = yield* connectLocalAccount(
              agent,
              {
                app: app.id,
                requirement: "service",
                method: "key",
                label,
                fields: { token: "synthetic-local-draft-token" },
              },
              headers,
            );
            owned.push(`/v1/accounts/${account.id}`);
            return account;
          });
        const first = yield* addAccount("First draft account");
        yield* addAccount("Second draft account");
        const pairing = yield* session.send("POST", "/auth/pair", undefined, headers);
        expect(pairing.status).toBe(200);
        const { url } = yield* body(Schema.Struct({ url: Schema.String }), pairing);
        yield* browser.use("Pair the local browser", (page) => page.goto(url));
        yield* browser.use("The paired inventory is visible", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible" }),
        );
        const rename = (label: string) =>
          browser.use(`Rename ${label}`, (page) =>
            page
              .getByRole("button", { name: `Manage ${label}`, exact: true })
              .click()
              .then(() => page.getByRole("menuitem", { name: "Edit details", exact: true }).click())
              .then(() => page.getByRole("dialog").waitFor({ state: "visible" })),
          );
        yield* browser.use("Open the account list", (page) => page.goto("/accounts"));
        yield* rename("First draft account");
        const draft = "Keep this unsaved account name";
        yield* browser.use("Edit the account name without saving", (page) =>
          page
            .getByRole("dialog")
            .getByRole("textbox", { name: "Account name", exact: true })
            .fill(draft),
        );
        expect(
          (yield* session.send("DELETE", `/v1/accounts/${first.id}`, undefined, headers)).status,
        ).toBe(200);
        yield* browser.use("The live account query reports removal", (page) =>
          page
            .getByRole("dialog")
            .getByRole("alert", { name: "Account no longer available", exact: true })
            .waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("The failed live read keeps the editor", (page) =>
            page
              .getByRole("dialog")
              .getByRole("textbox", { name: "Account name", exact: true })
              .count(),
          ),
        ).toBe(1);
        expect(
          yield* browser.use("The unsaved name remains available", (page) =>
            page
              .getByRole("dialog")
              .getByRole("textbox", { name: "Account name", exact: true })
              .inputValue(),
          ),
        ).toBe(draft);
        yield* browser.checkpoint("Local account draft survives a live read failure");
        yield* browser.use("Close the rename dialog", (page) =>
          page.keyboard
            .press("Escape")
            .then(() => page.getByRole("dialog").waitFor({ state: "hidden" })),
        );
        yield* rename("Second draft account");
        expect(
          yield* browser.use("A different account starts with its own name", (page) =>
            page
              .getByRole("dialog")
              .getByRole("textbox", { name: "Account name", exact: true })
              .inputValue(),
          ),
        ).toBe("Second draft account");
        yield* browser.use("Close the second rename dialog", (page) =>
          page.keyboard.press("Escape"),
        );
        yield* browser.use("Open the app's accounts", (page) =>
          page.goto(`/apps/${app.id}?view=accounts`),
        );
        // The linked account fills the plain requirement, so connecting another replaces it.
        yield* browser.use("Start connecting another account", (page) =>
          page.getByRole("button", { name: "Connect new account", exact: true }).click(),
        );
        const connectionDraft = "keep-this-unsaved-connection-token";
        yield* browser.use("Enter a credential without saving", (page) =>
          page
            .getByRole("dialog", { name: "Connect Draft test service", exact: true })
            .getByLabel("Token", { exact: true })
            .fill(connectionDraft),
        );
        expect(
          (yield* session.send("DELETE", `/v1/apps/${app.id}`, undefined, headers)).status,
        ).toBe(200);
        yield* browser.use("The live app query reports removal", (page) =>
          page
            .getByRole("alert", {
              name: "App no longer available",
              exact: true,
              includeHidden: true,
            })
            .waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("The failed live read keeps the connection dialog", (page) =>
            page.getByRole("dialog", { name: "Connect Draft test service", exact: true }).count(),
          ),
        ).toBe(1);
        expect(
          yield* browser.use("The unsaved credential remains available", (page) =>
            page
              .getByRole("dialog", { name: "Connect Draft test service", exact: true })
              .getByLabel("Token", { exact: true })
              .inputValue(),
          ),
        ).toBe(connectionDraft);
        yield* browser.checkpoint("Local account connection draft survives a live read failure");
      }),
    ),
  );
});
