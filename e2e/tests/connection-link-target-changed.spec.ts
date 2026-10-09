/** A connection link issued before its app changed provider reports the change, not the old sign-in. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import type { Locator } from "playwright";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, TestLive, withCase, withHostedCase } from "../support/case.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { Target, type Response } from "../support/platform.ts";
import { createProfile } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const App = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const Redeployed = Schema.Struct({ app: App });
const Profile = Schema.Struct({ id: Schema.String });
const Link = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  provider: Schema.Struct({
    id: Schema.String,
    definition: Schema.Struct({
      auth: Schema.Record(Schema.String, Schema.Struct({ type: Schema.String })),
    }),
  }),
});
const TargetChanged = Schema.Struct({
  _tag: Schema.Literal("AccountConnectionTargetChanged"),
  app: Schema.String,
  requirement: Schema.Literal("service"),
});
const Selected = Schema.Struct({ accounts: Schema.Struct({ service: Schema.String }) });

const oauthSource = (
  issuer: string,
) => `import { defineApp, defineProvider, oauth2, router } from "apps";
const service = defineProvider({ name: "Sample service", auth: { oauth: oauth2({ discover: ${JSON.stringify(`${issuer}/mcp`)} }) } });
export default defineApp({ accounts: { service } }, async () => ({ tools: router({}) }));`;
const keySource = `import { defineApp, defineProvider, object, router, secrets, string } from "apps";
const service = defineProvider({
  name: "Sample service",
  hosts: ["api.sample.example"],
  auth: { apiKey: secrets({ label: "API key", fields: object({ token: string() }) }) },
});
export default defineApp({ accounts: { service } }, async () => ({ tools: router({}) }));`;

/** The request names the changed app requirement instead of offering the old provider's sign-in. */
const targetChanged = (app: string, response: Response) =>
  Effect.gen(function* () {
    expect(response.status).toBe(409);
    expect(yield* body(TargetChanged, response)).toEqual({
      _tag: "AccountConnectionTargetChanged",
      app,
      requirement: "service",
    });
  });

layer(HostedLive, { excludeTestServices: true })("Connection link target changes", (it) => {
  it.effect(scenarios.connectionLinkTargetChanged.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        // The service refuses registration, as one did when its app moved to API keys.
        const issuer = yield* oauthSetupIssuer;
        yield* issuer.configure({ registrationStatus: 400, registrationError: "invalid_request" });
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Sample ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: oauthSource(issuer.origin) }, appsManifest],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const profile = yield* api
          .request(actors.owner, "POST", `${prefix}/apps/${app.id}/profiles`, {
            accounts: {},
            idempotencyKey: randomUUID(),
          })
          .pipe(Effect.flatMap((response) => body(Profile, response)));
        const issue = api
          .request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
            requirement: "service",
            profile: profile.id,
          })
          .pipe(Effect.flatMap((response) => body(Link, response)));
        const stale = yield* issue;
        expect(Object.keys(stale.provider.definition.auth)).toEqual(["oauth"]);
        const redeploy = (content: string) =>
          api
            .request(actors.owner, "POST", `${prefix}/apps/${app.id}/deploy`, {
              files: [{ path: "index.ts", content }, appsManifest],
            })
            .pipe(
              Effect.flatMap((response) => {
                expect(response.status).toBe(200);
                return body(Redeployed, response);
              }),
            );

        // The user opens the link while the app still signs in with OAuth.
        yield* browser.login(actors.owner);
        yield* browser.use("Open the link before the app changes", (page) =>
          page
            .goto(new URL(stale.url).pathname)
            .then(() =>
              page
                .getByRole("dialog")
                .getByRole("button", { name: "Connect Sample service", exact: true })
                .waitFor(),
            ),
        );

        // The app moves to an API key while the dialog is open.
        const redeployed = yield* redeploy(keySource);
        const keyProvider = redeployed.app.requirements.accounts.service.provider;
        expect(keyProvider).not.toBe(stale.provider.id);

        // Hosted connection routes read the request before acting, so each fails in that read.
        const changed = (response: Response) => targetChanged(app.id, response);
        /** The dialog drops its old form and explains the change once, with hosted's recovery. */
        const replacedByChange = (step: string, dropped: (dialog: Locator) => Promise<void>) =>
          browser
            .use(step, (page) => {
              const dialog = page.getByRole("dialog");
              return dropped(dialog).then(() =>
                Promise.all([
                  dialog.getByText("App account setup changed", { exact: true }).waitFor(),
                  dialog
                    .getByText("Close this form and start account setup again.", { exact: true })
                    .waitFor(),
                ]).then(() =>
                  dialog.getByText("App account setup changed", { exact: true }).count(),
                ),
              );
            })
            .pipe(Effect.map((shown) => expect(shown).toBe(1)));
        // The agent's status check names the change instead of a pending OAuth sign-in.
        yield* changed(
          yield* api.request(actors.owner, "GET", `${prefix}/connections/${stale.id}`),
        );
        const contacted = yield* issuer.metrics;
        yield* changed(
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${stale.id}/oauth/start`,
            {
              method: "oauth",
            },
          ),
        );
        // The old provider's service is never asked to register another client.
        const after = yield* issuer.metrics;
        expect(after.registrations).toBe(contacted.registrations);
        expect(after.discoveries).toBe(contacted.discoveries);
        yield* changed(
          yield* api.request(actors.owner, "POST", `${prefix}/connections/${stale.id}/submit`, {
            method: "apiKey",
            fields: { token: "synthetic-api-key" },
          }),
        );

        // The dialog opened before the change reads the request again when its sign-in is refused.
        const started = yield* browser.use(
          "Sign in from the dialog opened before the change",
          (page) =>
            Promise.all([
              page.waitForResponse((response) =>
                new URL(response.url()).pathname.endsWith(`/connections/${stale.id}/oauth/start`),
              ),
              page
                .getByRole("dialog")
                .getByRole("button", { name: "Connect Sample service", exact: true })
                .click(),
            ]).then(([response]) =>
              response.json().then((data: unknown) => ({ status: response.status(), body: data })),
            ),
        );
        yield* changed(started);
        yield* replacedByChange("The dialog replaces the old sign-in with the change", (dialog) =>
          dialog
            .getByRole("button", { name: "Connect Sample service", exact: true })
            .waitFor({ state: "detached" }),
        );
        yield* browser.checkpoint("Dialog opened before the change");

        const signInRequests: string[] = [];
        const onRequest = (request: { url: () => string }) => {
          const path = new URL(request.url()).pathname;
          if (path.includes("/oauth/")) signInRequests.push(path);
        };
        yield* browser.use("Watch for sign-in requests", (page) =>
          Promise.resolve(page.on("request", onRequest)),
        );
        yield* browser.use("Open the link issued before the change", (page) =>
          page.goto(new URL(stale.url).pathname),
        );
        yield* browser.use("The link explains the app changed", (page) => {
          const dialog = page.getByRole("dialog");
          return Promise.all([
            dialog.getByText("App account setup changed", { exact: true }).waitFor(),
            dialog
              .getByText("This connection no longer matches the app’s requirements.", {
                exact: true,
              })
              .waitFor(),
            dialog
              .getByText("Close this form and start account setup again.", { exact: true })
              .waitFor(),
          ]);
        });
        expect(
          yield* browser.use("The old sign-in is not offered", (page) =>
            page.getByRole("button", { name: "Connect Sample service", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Stale connection link");
        yield* browser.use("Stop watching sign-in requests", (page) =>
          Promise.resolve(page.off("request", onRequest)),
        );
        expect(signInRequests).toEqual([]);

        // A new link for the same profile offers the API key and selects the saved account.
        const fresh = yield* issue;
        expect(fresh.provider.id).toBe(keyProvider);
        expect(Object.keys(fresh.provider.definition.auth)).toEqual(["apiKey"]);
        yield* browser.use("Open the new link", (page) =>
          page
            .goto(new URL(fresh.url).pathname)
            .then(() => page.getByRole("dialog").getByLabel("Token", { exact: true }).waitFor())
            // Let the dialog's entrance finish so the checkpoint shows the settled form.
            .then(() =>
              page.evaluate(() =>
                Promise.all(
                  document
                    .getAnimations()
                    .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
                    .map((animation) => animation.finished),
                ),
              ),
            ),
        );
        yield* browser.checkpoint("New connection link");

        // The key form drops the same way when the app moves back to OAuth before it is submitted.
        yield* redeploy(oauthSource(issuer.origin));
        const submitted = yield* browser.use(
          "Submit the key from the dialog opened before",
          (page) => {
            const dialog = page.getByRole("dialog");
            return dialog
              .getByLabel("Token", { exact: true })
              .fill("synthetic-api-key")
              .then(() =>
                Promise.all([
                  page.waitForResponse((response) =>
                    new URL(response.url()).pathname.endsWith(`/connections/${fresh.id}/submit`),
                  ),
                  dialog.getByRole("button", { name: "Connect account", exact: true }).click(),
                ]),
              )
              .then(([response]) =>
                response
                  .json()
                  .then((data: unknown) => ({ status: response.status(), body: data })),
              );
          },
        );
        yield* changed(submitted);
        yield* replacedByChange("The dialog replaces the key form with the change", (dialog) =>
          dialog.getByLabel("Token", { exact: true }).waitFor({ state: "detached" }),
        );

        // Once the app asks for the key again, a new link saves it and selects the account.
        expect((yield* redeploy(keySource)).app.requirements.accounts.service.provider).toBe(
          keyProvider,
        );
        const final = yield* issue;
        expect(
          (yield* api.request(actors.owner, "POST", `${prefix}/connections/${final.id}/submit`, {
            method: "apiKey",
            fields: { token: "synthetic-api-key" },
          })).status,
        ).toBe(200);
        const selected = yield* api
          .request(actors.owner, "GET", `${prefix}/apps/${app.id}/profiles/${profile.id}`)
          .pipe(Effect.flatMap((response) => body(Selected, response)));
        expect(selected.accounts.service).toMatch(/^acc_/);
      }),
    ),
  );
});

const LocalLink = Schema.Struct({ connection: Schema.String, url: Schema.String });

layer(TestLive, { excludeTestServices: true })("Local connection link target changes", (it) => {
  it.effect(scenarios.localConnectionLinkTargetChanged.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          target = yield* Target;
        const session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const agent: Session = {
          ...session,
          send: (method, path, data, extra = {}) => {
            const { origin: _origin, ...rest } = extra;
            return session.send(method, path, data, { ...rest, ...headers });
          },
        };
        const issuer = yield* oauthSetupIssuer;
        yield* issuer.configure({ registrationStatus: 400, registrationError: "invalid_request" });
        const deployed = yield* agent.send("POST", "/v1/apps/deploy", {
          owner: "local",
          name: `Sample ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: oauthSource(issuer.origin) }, appsManifest],
        });
        expect(deployed.status).toBe(200);
        const { app } = yield* body(Redeployed, deployed);
        yield* Effect.addFinalizer(() =>
          agent.send("DELETE", `/v1/apps/${app.id}`).pipe(Effect.orDie),
        );
        const profile = yield* createProfile(agent, `/v1/apps/${app.id}`, {
          owner: "local",
          subject: "local",
        });
        const issue = agent
          .send("POST", "/account-connect/api/requests", {
            owner: "local",
            target: { app: app.id, profile: profile.id, requirement: "service" },
          })
          .pipe(
            Effect.flatMap((response) => {
              expect(response.status).toBe(200);
              return body(LocalLink, response);
            }),
          );
        const redeploy = (content: string) =>
          agent
            .send("POST", "/v1/apps/deploy", {
              owner: "local",
              app: app.id,
              files: [{ path: "index.ts", content }, appsManifest],
            })
            .pipe(Effect.map((response) => expect(response.status).toBe(200)));
        const link = yield* issue;
        const grant = {
          connection: link.connection,
          token: new URLSearchParams(new URL(link.url).hash.slice(1)).get("token"),
        };

        // The user opens the link while the app still signs in with OAuth.
        yield* browser.use("Open the link before the app changes", (page) =>
          page
            .goto(link.url)
            .then(() =>
              page.getByRole("button", { name: "Connect Sample service", exact: true }).waitFor(),
            ),
        );
        // The app moves to an API key while the page is open.
        yield* redeploy(keySource);

        // Local link routes call the SDK directly, so its OAuth start must refuse the old provider.
        const contacted = yield* issuer.metrics;
        const started = yield* browser.use(
          "Sign in from the page opened before the change",
          (page) =>
            Promise.all([
              page.waitForResponse(
                (response) =>
                  new URL(response.url()).pathname === "/account-connect/api/oauth/start",
              ),
              page.getByRole("button", { name: "Connect Sample service", exact: true }).click(),
            ]).then(([response]) =>
              response.json().then((data: unknown) => ({ status: response.status(), body: data })),
            ),
        );
        yield* targetChanged(app.id, started);
        // The page reloads the connection, so the change replaces the old form instead of joining it.
        yield* browser.use("The page replaces the old form with the change", (page) =>
          Promise.all([
            page
              .getByRole("button", { name: "Connect Sample service", exact: true })
              .waitFor({ state: "detached" }),
            page
              .getByRole("heading", { name: "Connect Sample service", exact: true })
              .waitFor({ state: "detached" }),
          ]).then(() =>
            page
              .getByRole("alert")
              .getByText("App account setup changed", { exact: true })
              .waitFor(),
          ),
        );
        expect(
          yield* browser.use("The change is explained once", (page) =>
            page.getByText("App account setup changed", { exact: true }).count(),
          ),
        ).toBe(1);
        // The link page cannot start account setup itself; only the agent can issue a new link.
        expect(
          yield* browser.use("The recovery names the agent, not a form to close", (page) =>
            page
              .getByRole("alert")
              .getByText("Ask your agent for a new connection link.", { exact: true })
              .waitFor()
              .then(() => page.getByText("Close this form and start account setup again.").count()),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Local stale connection link");
        // The old provider's service is never asked to register another client.
        const after = yield* issuer.metrics;
        expect(after.registrations).toBe(contacted.registrations);
        expect(after.discoveries).toBe(contacted.discoveries);

        // Submitting the new API key on the old link names the change, not an invalid method.
        yield* targetChanged(
          app.id,
          yield* api.request(session, "POST", "/account-connect/api/submit", {
            ...grant,
            method: "apiKey",
            fields: { token: "synthetic-api-key" },
          }),
        );
        // The agent's status check names the change instead of a pending OAuth sign-in.
        yield* targetChanged(
          app.id,
          yield* agent.send("GET", `/v1/account-connections/${link.connection}`),
        );

        // A key form opened before the app moves back to OAuth drops its form once the key is refused.
        const fresh = yield* issue;
        yield* browser.use("Open a new link that asks for the API key", (page) =>
          page.goto(fresh.url).then(() => page.getByLabel("Token", { exact: true }).waitFor()),
        );
        yield* redeploy(oauthSource(issuer.origin));
        const submitted = yield* browser.use("Submit the key from the page opened before", (page) =>
          page
            .getByLabel("Token", { exact: true })
            .fill("synthetic-api-key")
            .then(() =>
              Promise.all([
                page.waitForResponse(
                  (response) => new URL(response.url()).pathname === "/account-connect/api/submit",
                ),
                page.getByRole("button", { name: "Connect account", exact: true }).click(),
              ]),
            )
            .then(([response]) =>
              response.json().then((data: unknown) => ({ status: response.status(), body: data })),
            ),
        );
        yield* targetChanged(app.id, submitted);
        yield* browser.use("The page replaces the key form with the change", (page) =>
          Promise.all([
            page.getByLabel("Token", { exact: true }).waitFor({ state: "detached" }),
            page
              .getByRole("button", { name: "Connect account", exact: true })
              .waitFor({ state: "detached" }),
          ]).then(() =>
            page
              .getByRole("alert")
              .getByText("App account setup changed", { exact: true })
              .waitFor(),
          ),
        );

        // A sign-in page left in another tab finds the change when the user returns to it.
        const returning = yield* issue;
        yield* browser.use("Open a new link that signs in with OAuth", (page) =>
          page
            .goto(returning.url)
            .then(() =>
              page.getByRole("button", { name: "Connect Sample service", exact: true }).waitFor(),
            ),
        );
        yield* redeploy(keySource);
        const setupRead = yield* browser.use("Return to the page opened before", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) => new URL(response.url()).pathname === "/account-connect/api/oauth/setup",
            ),
            page.evaluate(() => window.dispatchEvent(new Event("visibilitychange"))),
          ]).then(([response]) =>
            response.json().then((data: unknown) => ({ status: response.status(), body: data })),
          ),
        );
        yield* targetChanged(app.id, setupRead);
        yield* browser.use("The page replaces the sign-in form with the change", (page) =>
          Promise.all([
            page
              .getByRole("heading", { name: "Connect Sample service", exact: true })
              .waitFor({ state: "detached" }),
            page
              .getByRole("button", { name: "Cancel", exact: true })
              .waitFor({ state: "detached" }),
          ]).then(() =>
            page
              .getByRole("alert")
              .getByText("App account setup changed", { exact: true })
              .waitFor(),
          ),
        );
        expect(
          yield* browser.use("The returned page explains the change once", (page) =>
            page.getByText("App account setup changed", { exact: true }).count(),
          ),
        ).toBe(1);
        yield* browser.checkpoint("Local connection link after returning to the tab");
      }),
    ),
  );
});
