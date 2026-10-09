/**
 * Every check Executor makes when matching a callback to the sign-in it started has its own
 * completion reason, and the hosted callback page derives its recovery from that reason alone.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { oauthMcpAppFiles } from "../support/authored-templates.ts";
import { createProfile } from "../support/profiles.ts";
import { nameConnectedAccount } from "../support/name-account.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const AppProvider = Schema.Struct({ id: Schema.String });
const Redirect = Schema.Struct({
  status: Schema.Literal("redirect"),
  authorizationUrl: Schema.String,
  redirectUri: Schema.String,
});
const Failure = Schema.Struct({
  _tag: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
});
const client = { clientId: "confidential-client", clientSecret: "synthetic-manual-secret" };

layer(HostedLive, { excludeTestServices: true })("OAuth completion reasons", (it) => {
  it.effect(scenarios.oauthCompletionReasons.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          http = yield* HttpClient.HttpClient,
          target = yield* Target;
        const issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        // As with Google, the service signs users in on one host and names it as `iss`.
        const signInOrigin = issuer.origin.replace("127.0.0.1", "localhost");
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Completion reasons ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, oauth2, router } from "apps";
const service=defineProvider({name:"Declared issuer",auth:{oauth:oauth2(${JSON.stringify({
                authorizationUrl: `${signInOrigin}/authorize`,
                tokenUrl: `${issuer.origin}/token`,
                issuer: signInOrigin,
                scopes: ["read"],
              })})}});
export default defineApp({accounts:{service}},async()=>({tools: router({})}));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(AppProvider, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        yield* issuer.configure({ callbackIssuer: signInOrigin });
        const connect = Effect.gen(function* () {
          const profile = yield* createProfile(actors.owner, `${prefix}/apps/${app.id}`);
          return (yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
              requirement: "service",
              profile: profile.id,
            }),
          )).id;
        });
        const start = (connection: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection}/oauth/start`,
              { method: "oauth", label: "Completion reasons", client },
            );
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const redirect = yield* body(Redirect, response);
            yield* issuer.allowClient({ ...client, redirect: redirect.redirectUri });
            return redirect;
          });
        const consent = (authorizationUrl: string) =>
          Effect.scoped(
            Effect.gen(function* () {
              const response = yield* HttpClient.withScope(http).get(authorizationUrl);
              expect(response.status).toBe(302);
              const location = response.headers.location;
              if (location === undefined)
                return yield* Effect.die("Issuer did not return a callback");
              return new URL(location);
            }),
          ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
        const signIn = Effect.gen(function* () {
          const connection = yield* connect;
          const started = yield* start(connection);
          return { connection, callback: yield* consent(started.authorizationUrl) };
        });
        const complete = (connection: string, callback: URL | string) =>
          api.request(actors.owner, "POST", `${prefix}/connections/${connection}/oauth/complete`, {
            callbackUrl: typeof callback === "string" ? callback : callback.href,
          });
        const expectReason = (
          label: string,
          response: { readonly status: number; readonly body: unknown },
          reason: string,
        ) =>
          Effect.gen(function* () {
            expect(response.status, label).toBe(400);
            expect(yield* body(Failure, response), label).toEqual({
              _tag: "OAuthCompletionFailed",
              reason,
            });
          });
        const edited = (callback: URL, edit: (url: URL) => void) => {
          const url = new URL(callback);
          edit(url);
          return url;
        };

        const exchangesBefore = (yield* issuer.metrics).tokenExchanges;
        const malformed = yield* signIn;
        const malformedCallbacks: ReadonlyArray<readonly [string, URL | string]> = [
          ["No state", edited(malformed.callback, (url) => url.searchParams.delete("state"))],
          [
            "Duplicate state",
            edited(malformed.callback, (url) =>
              url.searchParams.append("state", malformed.callback.searchParams.get("state") ?? ""),
            ),
          ],
          ["Short state", edited(malformed.callback, (url) => url.searchParams.set("state", "x"))],
          ["Fragment", `${malformed.callback.href}#fragment`],
        ];
        for (const [label, callback] of malformedCallbacks)
          yield* expectReason(
            label,
            yield* complete(malformed.connection, callback),
            "callback_malformed",
          );
        yield* expectReason(
          "Unknown state",
          yield* complete(
            malformed.connection,
            edited(malformed.callback, (url) =>
              url.searchParams.set("state", randomUUID() + randomUUID()),
            ),
          ),
          "sign_in_not_found",
        );
        yield* expectReason(
          "Different callback path",
          yield* complete(
            malformed.connection,
            edited(malformed.callback, (url) => {
              url.pathname = `${url.pathname}-elsewhere`;
            }),
          ),
          "redirect_mismatch",
        );
        // A callback with a valid state but no code claims the sign-in, which then cannot be reused.
        yield* expectReason(
          "No code",
          yield* complete(
            malformed.connection,
            edited(malformed.callback, (url) => url.searchParams.delete("code")),
          ),
          "callback_malformed",
        );
        yield* expectReason(
          "Reused sign-in",
          yield* complete(malformed.connection, malformed.callback),
          "sign_in_used",
        );

        // Only the newest sign-in for a connection can finish.
        const replaced = yield* signIn;
        const newer = yield* start(replaced.connection);
        yield* expectReason(
          "Replaced sign-in",
          yield* complete(replaced.connection, replaced.callback),
          "sign_in_replaced",
        );
        const other = yield* connect;
        yield* expectReason(
          "Another connection's sign-in",
          yield* complete(other, (yield* consent(newer.authorizationUrl)).href),
          "sign_in_replaced",
        );
        expect((yield* issuer.metrics).tokenExchanges).toBe(exchangesBefore);

        // A callback from another issuer is a configuration problem: the page offers the fix
        // prompt and a way back, never a retry or a client change.
        yield* issuer.configure({
          callbackIssuer: issuer.origin,
          browserReturn: target.metadata.origin,
        });
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.owner);
        yield* browser.use("Open the app", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
        );
        yield* browser.use("Connect with a client the service accepts", (page) => {
          const dialog = page.getByRole("dialog");
          return page
            .getByRole("button", { name: "Connect new account", exact: true })
            .click()
            .then(() => dialog.getByLabel("Client ID", { exact: true }).fill(client.clientId))
            .then(() => dialog.getByLabel(/^Client secret/).fill(client.clientSecret))
            .then(() =>
              dialog.getByRole("button", { name: "Connect Declared issuer", exact: true }).click(),
            );
        });
        yield* browser.use("An issuer mismatch offers the fix prompt", (page) =>
          page
            .getByRole("button", { name: "Copy fix prompt", exact: true })
            .waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("Read the recovery actions", (page) =>
            Promise.all([
              page.getByText("didn’t name the issuer", { exact: false }).count(),
              page.getByRole("link", { name: "Try again", exact: true }).count(),
              page.getByRole("link", { name: "Update client details", exact: true }).count(),
              page.getByRole("link", { name: "Back to app", exact: true }).count(),
            ]),
          ),
        ).toEqual([1, 0, 0, 1]);
        yield* browser.checkpoint("Issuer mismatch callback");

        // A client Executor registered is not the user's to edit. A saved registration the
        // service stops accepting is discarded and "Try again" registers a new one; a client
        // rejected right after registration is a configuration problem that a retry cannot fix.
        const deployRegistered = Effect.gen(function* () {
          const name = `Registered client ${randomUUID().slice(0, 8)}`;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name,
            files: oauthMcpAppFiles(name, `${issuer.origin}/mcp`),
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const deployedApp = yield* body(AppProvider, deployed);
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.owner, "DELETE", `${prefix}/apps/${deployedApp.id}`)
              .pipe(Effect.orDie),
          );
          return { id: deployedApp.id, name };
        });
        const openAccounts = (registeredApp: { readonly id: string }) =>
          browser.use("Open the registered-client app", (page) =>
            page.goto(`/org/${actors.organization.slug}/apps/${registeredApp.id}?view=accounts`),
          );
        const connectInDialog = (registeredApp: { readonly name: string }, label: string) =>
          browser.use(`Connect ${label}`, (page) =>
            page
              .getByRole("dialog")
              .getByRole("button", { name: `Connect ${registeredApp.name}`, exact: true })
              .click(),
          );
        const nameAccount = (label: string) =>
          browser.use(`Name the ${label} account after it connects`, (page) =>
            nameConnectedAccount(page, label),
          );
        const addAccount = (
          registeredApp: { readonly id: string; readonly name: string },
          label: string,
        ) =>
          Effect.gen(function* () {
            yield* openAccounts(registeredApp);
            yield* browser.use("Add an account", (page) =>
              page.getByRole("button", { name: "Connect new account", exact: true }).click(),
            );
            yield* connectInDialog(registeredApp, label);
          });
        const accounts = (count: string) =>
          browser.use(`Wait for ${count}`, (page) =>
            page.getByText(count, { exact: true }).waitFor({ state: "visible" }),
          );
        const recoveryActions = (step: string, text: string) =>
          browser.use(step, (page) =>
            Promise.all([
              page.getByText(text, { exact: false }).count(),
              page.getByRole("link", { name: "Try again", exact: true }).count(),
              page.getByRole("link", { name: "Update client details", exact: true }).count(),
              page.getByRole("button", { name: "Copy fix prompt", exact: true }).count(),
            ]),
          );

        yield* issuer.configure({ callbackIssuer: null, tokenError: null });
        const reusedApp = yield* deployRegistered;
        yield* addAccount(reusedApp, "First");
        yield* nameAccount("First");
        yield* accounts("1 account");
        // The next sign-in reuses the saved registration, which the service now refuses.
        yield* issuer.configure({ tokenError: { status: 401, body: { error: "invalid_client" } } });
        const registrations = (yield* issuer.metrics).registrations;
        yield* addAccount(reusedApp, "Second");
        yield* browser.use("A rejected saved client offers a retry", (page) =>
          page.getByRole("link", { name: "Try again", exact: true }).waitFor({ state: "visible" }),
        );
        expect((yield* issuer.metrics).registrations).toBe(registrations);
        expect(
          yield* recoveryActions(
            "Read the saved-client recovery",
            "no longer accepts the client Executor registered earlier",
          ),
        ).toEqual([1, 1, 0, 0]);
        yield* browser.checkpoint("Saved registered client rejected callback");
        yield* issuer.configure({ tokenError: null });
        yield* browser.use("Click Try again", (page) =>
          page.getByRole("link", { name: "Try again", exact: true }).click(),
        );
        yield* connectInDialog(reusedApp, "Second");
        yield* nameAccount("Second");
        yield* accounts("2 accounts");
        // The rejected registration was discarded, so the retry registered a new client.
        expect((yield* issuer.metrics).registrations).toBe(registrations + 1);

        // A client rejected moments after its registration will not work on a retry either.
        const freshApp = yield* deployRegistered;
        yield* issuer.configure({ tokenError: { status: 401, body: { error: "invalid_client" } } });
        yield* addAccount(freshApp, "Fresh");
        yield* browser.use("A rejected new client offers the fix prompt", (page) =>
          page
            .getByRole("button", { name: "Copy fix prompt", exact: true })
            .waitFor({ state: "visible" }),
        );
        expect(
          yield* recoveryActions(
            "Read the new-client recovery",
            "refused the client Executor registered moments ago",
          ),
        ).toEqual([1, 0, 0, 1]);
        yield* browser.checkpoint("New registered client rejected callback");
        yield* issuer.configure({ tokenError: null });
      }),
    ),
  );
});
