import { openThroughBrowser } from "../support/in-app-navigation.ts";
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { holdQuery } from "../support/query-transition.ts";
import { oauthRecoveryIssuer, recoveryClients } from "../support/oauth-recovery-issuer.ts";
import {
  accountNameField,
  accountNamePrompt,
  dismissAccountName,
  nameAccountDialog,
  nameConnectedAccount,
} from "../support/name-account.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const App = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});

layer(HostedLive, { excludeTestServices: true })("OAuth storyboard", (it) => {
  it.effect(scenarios.oauthConnectStoryboard.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          target = yield* Target,
          evidence = yield* Evidence;
        const issuer = yield* oauthRecoveryIssuer(target.metadata.origin, true);
        const prefix = `/api/organizations/${actors.organization.id}`;
        const paths = (suffix: string) =>
          [actors.organization.id, actors.organization.slug].map(
            (organization) => `/api/organizations/${organization}${suffix}`,
          );
        const frames: Array<{ number: number; label: string }> = [];
        const capture = (label: string) =>
          Effect.gen(function* () {
            const number = frames.length + 1;
            frames.push({ number, label });
            yield* browser.checkpoint(`${String(number).padStart(2, "0")}-${label}`);
          });
        yield* Effect.addFinalizer(() =>
          evidence.json("oauth-frame-manifest.json", {
            target: "self-host",
            viewport: "1440x960",
            provider: "synthetic loopback issuer",
            controlledNetworkHolds: true,
            frames,
          }),
        );
        const deploy = (name: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `${name} ${randomUUID().slice(0, 8)}`,
              files: [
                {
                  path: "index.ts",
                  content: `import { defineApp, defineProvider, oauth2, router } from "apps";
const service=defineProvider({name:${JSON.stringify(name)},auth:{oauth:oauth2({discover:${JSON.stringify(issuer.origin)},scopes:["reports:read","offline_access"]})}});
export default defineApp({accounts:{service}},async()=>({tools: router({})}));`,
                },
                appsManifest,
              ],
            });
            expect(response.status).toBe(200);
            const app = yield* body(App, response);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
            );
            return app;
          });
        const app = yield* deploy("Sample service");
        const appUrl = `/org/${actors.organization.slug}/apps/${app.id}?view=accounts`;
        const setupPaths = paths(
          `/providers/${app.requirements.accounts.service.provider}/oauth/oauth/setup`,
        );
        const ready = (name: string) =>
          browser.use(`Wait for ${name}`, (page) =>
            page.getByRole("button", { name, exact: true }).waitFor({ state: "visible" }),
          );
        const click = (name: string) =>
          browser.use(`Click ${name}`, (page) =>
            page.getByRole("button", { name, exact: true }).click(),
          );
        const heading = (name: string) =>
          browser.use(`Wait for ${name}`, (page) =>
            page.getByRole("heading", { name, exact: true }).waitFor({ state: "visible" }),
          );
        const link = (name: string) =>
          browser.use(`Follow ${name}`, (page) =>
            page.getByRole("link", { name, exact: true }).click(),
          );
        const actionSize = (role: "status" | "alert" | "button" | "group", name?: string) =>
          Effect.gen(function* () {
            const bounds = yield* browser.use("Measure the stable connection action", (page) => {
              const dialog = page.getByRole("dialog");
              const action = dialog.getByRole(
                role,
                name === undefined ? {} : { name, exact: true },
              );
              // A max-width transition can have several identical bounds before it
              // reaches the viewport width. Wait for the transition, not that plateau.
              return dialog
                .evaluate((element) =>
                  Promise.allSettled(
                    element.getAnimations().map((animation) => animation.finished),
                  ),
                )
                .then(() => action.scrollIntoViewIfNeeded())
                .then(() => action.boundingBox());
            });
            if (bounds === null)
              return yield* Effect.die(new Error("Connection action must be visible"));
            return { width: bounds.width, height: bounds.height };
          });
        const connectionLayout = () =>
          browser.use("Measure the stable connection dialog", (page) => {
            const dialog = page.getByRole("dialog");
            return dialog
              .evaluate((element) =>
                Promise.allSettled(element.getAnimations().map((animation) => animation.finished)),
              )
              .then(() => dialog.scrollIntoViewIfNeeded())
              .then(() =>
                dialog.boundingBox().then((dialog) => {
                  if (dialog === null) throw new Error("The connection dialog must be visible");
                  return { dialog };
                }),
              );
          });
        const startPattern = /\/connections\/[^/]+\/oauth\/start$/;
        const completePattern = /\/connections\/[^/]+\/oauth\/complete$/;
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.owner);
        yield* browser.use("Use a stable dark viewport", (page) =>
          page.emulateMedia({ colorScheme: "dark" }),
        );
        const loading = yield* holdQuery(paths(`/apps/${app.id}`), "continue");
        const setup = yield* holdQuery(setupPaths, "continue");
        yield* openThroughBrowser("Enter the app", appUrl);
        yield* loading.requested;
        yield* capture("App-loading");
        yield* loading.release;
        yield* ready("Connect new account");
        yield* capture("Account-entry");
        yield* click("Connect new account");
        expect(
          yield* browser.use("The connection form does not ask for an account name", (page) =>
            page.getByRole("dialog").getByLabel("Account name", { exact: true }).count(),
          ),
        ).toBe(0);
        expect(
          yield* browser.use("Setup uses a skeleton in the Connect action", (page) =>
            page.getByRole("status", { name: "Preparing connection", exact: true }).count(),
          ),
        ).toBe(1);
        expect(
          yield* browser.use("Setup has no separate loading message", (page) =>
            page.getByText("Checking connection options…", { exact: true }).count(),
          ),
        ).toBe(0);
        const loadingSize = yield* actionSize("status", "Preparing connection");
        const loadingLayout = yield* connectionLayout();
        yield* capture("Connection-before-setup");
        yield* browser.use("Show the first connection form on mobile", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        const mobileLoadingSize = yield* actionSize("status", "Preparing connection");
        const mobileLoadingLayout = yield* connectionLayout();
        yield* browser.checkpoint("Connection-before-setup-mobile");
        yield* browser.use("Restore desktop for connection setup", (page) =>
          page.setViewportSize({ width: 1440, height: 960 }),
        );
        yield* setup.requested;
        yield* browser.use("Wait for setup pending", (page) =>
          page.getByRole("status", { name: "Preparing connection", exact: true }).waitFor(),
        );
        yield* capture("Checking-connection-options");
        yield* issuer.configure({ discoveryFails: true });
        yield* setup.release;
        yield* browser.use("Wait for setup failure", (page) =>
          page
            .getByText("The connected service’s sign-in is unavailable", { exact: true })
            .waitFor(),
        );
        const failedLayout = yield* connectionLayout();
        expect(failedLayout.dialog.width).toEqual(loadingLayout.dialog.width);
        const failedActionSize = yield* actionSize("alert");
        expect(failedActionSize.height).toBeGreaterThan(loadingSize.height);
        yield* capture("Setup-failed-with-retry");
        yield* browser.use("Show setup recovery on mobile", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        const mobileFailedLayout = yield* connectionLayout();
        expect(mobileFailedLayout.dialog.width).toEqual(mobileLoadingLayout.dialog.width);
        const mobileFailedActionSize = yield* actionSize("alert");
        expect(mobileFailedActionSize.height).toBeGreaterThan(mobileLoadingSize.height);
        yield* browser.checkpoint("Setup-failed-mobile");
        yield* browser.use("Restore desktop for setup retry", (page) =>
          page.setViewportSize({ width: 1440, height: 960 }),
        );
        yield* issuer.configure({ discoveryFails: false });
        const retry = yield* holdQuery(setupPaths, "continue");
        yield* click("Try again");
        yield* retry.requested;
        yield* browser.use("Retry keeps the explanation and blocks repeat requests", (page) =>
          page
            .getByRole("status", { name: "Checking connection", exact: true })
            .waitFor()
            .then(() => page.getByRole("button", { name: "Checking…", exact: true }).isDisabled())
            .then((disabled) => expect(disabled).toBe(true)),
        );
        expect(yield* actionSize("alert")).toEqual(failedActionSize);
        expect(yield* connectionLayout()).toEqual(failedLayout);
        yield* capture("Setup-retrying");
        yield* browser.use("Show retry without collapsing the mobile card", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        expect(yield* actionSize("alert")).toEqual(mobileFailedActionSize);
        expect(yield* connectionLayout()).toEqual(mobileFailedLayout);
        yield* browser.checkpoint("Setup-retrying-mobile");
        yield* browser.use("Restore desktop during retry", (page) =>
          page.setViewportSize({ width: 1440, height: 960 }),
        );
        yield* retry.release;
        yield* browser.use("Wait for automatic setup", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "Connect Sample service", exact: true })
            .waitFor()
            .then(() => page.getByRole("alert").waitFor({ state: "hidden" })),
        );
        expect(yield* connectionLayout()).toEqual(loadingLayout);
        expect(yield* actionSize("group", "Connection options")).toEqual(loadingSize);
        expect((yield* actionSize("button", "Connect Sample service")).width).toEqual(
          failedActionSize.width,
        );
        yield* browser.use("Check the ready action on mobile", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        expect(yield* connectionLayout()).toEqual(mobileLoadingLayout);
        expect(yield* actionSize("group", "Connection options")).toEqual(mobileLoadingSize);
        expect((yield* actionSize("button", "Connect Sample service")).width).toEqual(
          mobileFailedActionSize.width,
        );
        yield* browser.checkpoint("Automatic-OAuth-ready-mobile");
        yield* browser.use("Restore desktop after checking action sizes", (page) =>
          page.setViewportSize({ width: 1440, height: 960 }),
        );
        yield* capture("Automatic-OAuth-ready");
        yield* browser.use("Expand required permissions", (page) =>
          page.getByText("Advanced", { exact: true }).click(),
        );
        yield* capture("Required-permissions-expanded");
        expect(
          yield* browser.use("Connect is ready without naming the account", (page) =>
            page
              .getByRole("dialog")
              .getByRole("button", { name: "Connect Sample service", exact: true })
              .isEnabled(),
          ),
        ).toBe(true);
        const failedStart = yield* holdQuery(startPattern, "fail", { method: "POST" });
        yield* click("Connect Sample service");
        yield* failedStart.requested;
        yield* ready("Preparing sign-in…");
        yield* capture("Preparing-sign-in");
        yield* failedStart.release;
        yield* browser.use("Wait for start failure", (page) =>
          page.getByRole("dialog").getByRole("alert").waitFor(),
        );
        yield* capture("Sign-in-start-failed");
        // A page with a pending navigation cannot be inspected, so it reports the action itself.
        const actionLabels: string[] = [];
        yield* browser.use("Record the Connect action until the page leaves", (page) => {
          page.on("console", (message) => {
            if (message.text().startsWith("oauth-action:"))
              actionLabels.push(message.text().slice("oauth-action:".length));
          });
          return page
            .getByRole("dialog")
            .getByRole("group", { name: "Connection options" })
            .evaluate((group) => {
              new MutationObserver(() =>
                console.log(`oauth-action:${group.querySelector("button")?.textContent ?? ""}`),
              ).observe(group, { childList: true, subtree: true, characterData: true });
            });
        });
        const authorization = yield* holdQuery(["/authorize"], "continue");
        yield* click("Connect Sample service");
        yield* authorization.requested;
        yield* authorization.release;
        yield* heading("Connect Sample service");
        yield* ready("Allow access");
        // Once sign-in starts, the action stays busy until the provider page replaces it.
        const departing = actionLabels.indexOf("Preparing sign-in…");
        expect(departing, "the action showed sign-in progress").toBeGreaterThanOrEqual(0);
        expect(new Set(actionLabels.slice(departing))).toEqual(new Set(["Preparing sign-in…"]));
        yield* capture("Provider-consent");
        const completion = yield* holdQuery(completePattern, "continue", { method: "POST" });
        yield* issuer.configure({ tokenFails: true });
        yield* click("Allow access");
        yield* completion.requested;
        yield* heading("Connecting account…");
        yield* capture("Completing-OAuth-callback");
        yield* browser.use("Show callback progress on mobile", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        yield* browser.checkpoint("Callback-loading-mobile");
        yield* browser.use("Restore the callback desktop viewport", (page) =>
          page.setViewportSize({ width: 1440, height: 960 }),
        );
        yield* completion.release;
        yield* heading("Account not connected");
        yield* capture("Callback-failed-with-retry");
        yield* browser.use("Show callback recovery on mobile", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        yield* browser.checkpoint("Callback-failed-mobile");
        yield* browser.use("Restore desktop for retry", (page) =>
          page.setViewportSize({ width: 1440, height: 960 }),
        );
        yield* issuer.configure({ tokenFails: false });
        yield* link("Try again");
        yield* ready("Connect Sample service");
        expect(
          yield* browser.use("OAuth retry reopens the shared connection dialog", (page) =>
            page.getByRole("dialog").count(),
          ),
        ).toBe(1);
        yield* browser.use("Retry stays on the app with its existing connection", (page) =>
          page.waitForURL(
            (url) =>
              url.pathname === `/org/${actors.organization.slug}/apps/${app.id}` &&
              url.searchParams.get("view") === "accounts" &&
              url.searchParams.has("connection"),
          ),
        );
        yield* capture("Connection-retry-dialog");
        yield* click("Connect Sample service");
        yield* ready("Allow access");
        yield* click("Allow access");
        yield* heading("Name this account");
        expect(
          yield* browser.use("The connected account starts with the default name", (page) =>
            accountNamePrompt(page).then(() => accountNameField(page).inputValue()),
          ),
        ).toBe("Default");
        yield* capture("Name-connected-account");
        yield* browser.use("Name the connected account", (page) =>
          nameConnectedAccount(page, "Work reports"),
        );
        yield* browser.use("Wait for the saved account", (page) =>
          page.getByRole("radio", { name: "Work reports", exact: true, checked: true }).waitFor(),
        );
        yield* capture("Account-connected");
        yield* click("Connect new account");
        yield* ready("Connect Sample service");
        expect(
          yield* browser.use("Replacement does not ask for an account name", (page) =>
            page.getByRole("dialog").getByLabel("Account name", { exact: true }).count(),
          ),
        ).toBe(0);
        yield* capture("Replace-account-entry");
        yield* browser.use("Open saved-client options", (page) =>
          page.getByText("Advanced", { exact: true }).click(),
        );
        yield* browser.use("Wait for the saved OAuth client", (page) =>
          page.getByText("Using a saved client", { exact: true }).waitFor(),
        );
        yield* capture("New-account-with-saved-client");
        yield* click("Change OAuth client");
        yield* capture("Manual-client-dialog");
        yield* click("Close");
        const accountId = (yield* body(
          Schema.Struct({
            accounts: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
          }),
          yield* api.request(actors.owner, "GET", `${prefix}/inventory`),
        )).accounts.find((account) => account.label === "Work reports")?.id;
        if (accountId === undefined) return yield* Effect.die("The saved account is missing");
        const [profile] = yield* body(
          Schema.Array(Schema.Struct({ id: Schema.String })),
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/profiles`),
        );
        if (profile === undefined) return yield* Effect.die("The connected profile is missing");
        // Credentials are replaced only through an app that selects the account.
        const onAccount = (url: URL) =>
          url.pathname === `/org/${actors.organization.slug}/apps/${app.id}` &&
          url.searchParams.get("view") === "accounts" &&
          url.searchParams.get("profile") === profile.id;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/accounts/${accountId}`).pipe(Effect.orDie),
        );
        const reconnectAccount = () =>
          Effect.flatMap(
            api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
              requirement: "service",
              profile: profile.id,
              account: accountId,
            }),
            (response) => body(Resource, response),
          );
        const reconnect = yield* reconnectAccount();
        // There is no reconnect outside an app.
        expect(
          (yield* api.request(actors.owner, "POST", `${prefix}/accounts/${accountId}/connections`))
            .status,
        ).toBe(404);
        const connectionUrl = `/org/${actors.organization.slug}/connections/${reconnect.id}`;
        const connectionLoading = yield* holdQuery(
          paths(`/connections/${reconnect.id}`),
          "continue",
        );
        yield* openThroughBrowser("Open a reconnect link", connectionUrl);
        yield* connectionLoading.requested;
        expect(
          yield* browser.use("Connection links load in a modal", (page) =>
            page.getByRole("dialog").count(),
          ),
        ).toBe(1);
        yield* capture("Connection-link-loading");
        yield* connectionLoading.release;
        yield* ready("Reconnect Sample service");
        yield* browser.use("A reconnect link opens over its app's accounts", (page) =>
          page.waitForURL(
            (url) => onAccount(url) && url.searchParams.get("connection") === reconnect.id,
          ),
        );
        yield* browser.use("Refresh preserves the connection modal", (page) => page.reload());
        yield* ready("Reconnect Sample service");
        expect(
          yield* browser.use("The refreshed modal remains open", (page) =>
            page.getByRole("dialog").count(),
          ),
        ).toBe(1);
        yield* browser.use("Close the direct-link modal", (page) =>
          page.getByRole("dialog").press("Escape"),
        );
        yield* browser.use("Closing a reconnect link stays on the app's accounts", (page) =>
          page.waitForURL((url) => onAccount(url) && !url.searchParams.has("connection")),
        );
        expect(
          yield* browser.use("The app's accounts have no remaining modal", (page) =>
            page.getByRole("dialog").count(),
          ),
        ).toBe(0);
        yield* browser.use("Reopen the same connection link", (page) => page.goto(connectionUrl));
        yield* ready("Reconnect Sample service");
        yield* browser.use("Open saved-client reconnect options", (page) =>
          page.getByText("Advanced", { exact: true }).click(),
        );
        yield* browser.use("Wait for saved-client setup", (page) =>
          page.getByText("Using a saved client", { exact: true }).waitFor(),
        );
        yield* capture("Reconnect-saved-client");
        yield* click("Change OAuth client");
        yield* capture("Manual-client-details");
        yield* browser.use("Show the form on mobile", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        yield* capture("Manual-client-mobile");
        yield* browser.use("Restore desktop and enter a rejected client", (page) =>
          page
            .setViewportSize({ width: 1440, height: 960 })
            .then(() =>
              page.getByLabel("Client ID", { exact: true }).fill(recoveryClients.original.clientId),
            )
            .then(() => page.getByLabel("Client secret", { exact: true }).fill("wrong-secret")),
        );
        yield* capture("Manual-client-ready");
        yield* click("Reconnect Sample service");
        yield* ready("Allow access");
        yield* click("Allow access");
        yield* browser.use("Wait for invalid-client recovery", (page) =>
          page.getByRole("link", { name: "Update client details", exact: true }).waitFor(),
        );
        yield* capture("Rejected-client-callback");
        yield* link("Update client details");
        yield* ready("Reconnect Sample service");
        expect(
          yield* browser.use("Client recovery reopens the same modal", (page) =>
            page.getByRole("dialog").getByLabel("Client ID", { exact: true }).count(),
          ),
        ).toBe(1);
        yield* capture("Update-client-details");
        yield* browser.use("Supply the valid replacement", (page) =>
          page
            .getByLabel("Client ID", { exact: true })
            .fill(recoveryClients.replacement.clientId)
            .then(() =>
              page
                .getByLabel("Client secret", { exact: true })
                .fill(recoveryClients.replacement.clientSecret),
            ),
        );
        yield* click("Reconnect Sample service");
        yield* ready("Allow access");
        yield* click("Allow access");
        yield* browser.use("Wait for reconnect success", (page) =>
          page
            .waitForURL((url) => onAccount(url) && !url.searchParams.has("connection"))
            .then(() =>
              page.getByRole("button", { name: "Manage Work reports", exact: true }).waitFor(),
            ),
        );
        yield* capture("Reconnect-completed");
        yield* browser.use("Revisit the completed link", (page) => page.goto(connectionUrl));
        yield* browser.use("Completed links are explicit", (page) =>
          page.getByRole("dialog").getByText("Account connected.", { exact: true }).waitFor(),
        );
        yield* capture("Completed-connection-link");
        const cancelled = yield* reconnectAccount();
        yield* browser.use("Open a cancellable attempt", (page) =>
          page.goto(`/org/${actors.organization.slug}/connections/${cancelled.id}`),
        );
        yield* ready("Reconnect Sample service");
        yield* click("Reconnect Sample service");
        yield* ready("Cancel");
        yield* click("Cancel");
        yield* heading("Connection cancelled");
        yield* capture("Connection-cancelled");
        yield* browser.use("Open a callback without pending sign-in", (page) =>
          page.goto("/oauth/callback"),
        );
        yield* heading("Account not connected");
        yield* capture("Expired-or-other-tab");
        yield* issuer.configure({ registration: false });
        const manual = yield* deploy("Manual service");
        yield* browser.use("Open a provider without automatic registration", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${manual.id}?view=accounts`),
        );
        yield* click("Connect new account");
        yield* browser.use("Wait for mandatory manual setup", (page) =>
          page.getByLabel("Client secret", { exact: true }).waitFor(),
        );
        yield* capture("Client-required-first-connection");
        yield* evidence.json("oauth-protocol-observations.json", yield* issuer.observations);
        expect(frames.length).toBe(31);
      }),
    ),
  );

  it.effect(scenarios.oauthNameAfterConnect.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          target = yield* Target;
        const issuer = yield* oauthRecoveryIssuer(target.metadata.origin, true);
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Naming ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, oauth2, router } from "apps";
const service=defineProvider({name:"Sample service",auth:{oauth:oauth2({discover:${JSON.stringify(issuer.origin)},scopes:["reports:read"]})}});
export default defineApp({accounts:{service}},async()=>({tools:router({})}));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`);
            for (const account of accounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        const label = (account: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(
              actors.owner,
              "GET",
              `${prefix}/accounts/${account}`,
            );
            expect(response.status).toBe(200);
            return (yield* body(
              Schema.Struct({ account: Schema.Struct({ label: Schema.String }) }),
              response,
            )).account.label;
          });
        const appPath = `/org/${actors.organization.slug}/apps/${app.id}`;
        /** Connect from the app's Accounts tab and return with the naming dialog open. */
        const connect = () =>
          Effect.gen(function* () {
            yield* browser.use("Connect a new account from the list", (page) =>
              page.getByRole("button", { name: "Connect new account", exact: true }).click(),
            );
            yield* browser.use("Start sign-in without naming the account", (page) =>
              page
                .getByRole("dialog")
                .getByRole("button", { name: "Connect Sample service", exact: true })
                .click(),
            );
            const completed = yield* browser.use("Allow access and complete sign-in", (page) =>
              Promise.all([
                page.waitForResponse(
                  (response) =>
                    response.request().method() === "POST" &&
                    /\/connections\/[^/]+\/oauth\/complete$/.test(new URL(response.url()).pathname),
                ),
                page.getByRole("button", { name: "Allow access", exact: true }).click(),
              ]).then(([response]) => response.json() as Promise<unknown>),
            );
            const account = (yield* Schema.decodeUnknownEffect(
              Schema.Struct({ id: Schema.String }),
            )(completed)).id;
            accounts.push(account);
            // The prompt belongs to the dashboard layout, not to a URL the app has to carry.
            const search = yield* browser.use("Return to the app to name the account", (page) =>
              page
                .waitForURL(
                  (url) => url.pathname === appPath && url.searchParams.get("view") === "accounts",
                )
                .then(() => accountNamePrompt(page))
                .then(() => new URL(page.url()).searchParams),
            );
            expect(search.has("rename")).toBe(false);
            return account;
          });
        const prefilled = () =>
          browser.use("Read the prefilled account name", (page) =>
            accountNameField(page).inputValue(),
          );
        const dismissed = () =>
          browser.use("The naming dialog leaves the app's accounts in place", (page) =>
            nameAccountDialog(page)
              .count()
              .then((count) => ({ count, url: new URL(page.url()) })),
          );
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.owner);
        yield* browser.use("Open the app's accounts", (page) =>
          page.goto(`${appPath}?view=accounts`),
        );

        const first = yield* connect();
        expect(yield* prefilled()).toBe("Default");
        yield* browser.checkpoint("Name a new OAuth account");
        yield* browser.use("Close the dialog without saving", (page) => dismissAccountName(page));
        const afterClose = yield* dismissed();
        expect(afterClose.count).toBe(0);
        expect(afterClose.url.pathname).toBe(appPath);
        expect(afterClose.url.searchParams.get("view")).toBe("accounts");
        yield* browser.use("The account keeps its default name in the app", (page) =>
          page.getByRole("radio", { name: "Default", exact: true }).waitFor(),
        );
        expect(yield* label(first)).toBe("Default");

        const second = yield* connect();
        expect(second).not.toBe(first);
        expect(yield* prefilled()).toBe("Default 2");
        yield* browser.use("Name the second account", (page) =>
          nameConnectedAccount(page, "Work reports"),
        );
        const afterSave = yield* dismissed();
        expect(afterSave.count).toBe(0);
        expect(afterSave.url.pathname).toBe(appPath);
        yield* browser.use("The app shows the saved name", (page) =>
          page.getByRole("radio", { name: "Work reports", exact: true }).waitFor(),
        );
        expect(yield* label(second)).toBe("Work reports");
        expect(yield* label(first)).toBe("Default");
        yield* browser.checkpoint("Named OAuth account in the app");

        // Credentials are replaced from the app that selects the account, through its menu.
        yield* browser.use("Open the selected account's menu", (page) =>
          page.getByRole("button", { name: "Manage Work reports", exact: true }).click(),
        );
        yield* browser.use("Choose Reconnect", (page) =>
          page.getByRole("menuitem", { name: "Reconnect", exact: true }).click(),
        );
        yield* browser.use("Reconnect the named account", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "Reconnect Sample service", exact: true })
            .click(),
        );
        const reconnected = yield* browser.use("Allow access again", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === "POST" &&
                /\/connections\/[^/]+\/oauth\/complete$/.test(new URL(response.url()).pathname),
            ),
            page.getByRole("button", { name: "Allow access", exact: true }).click(),
          ]).then(([response]) => response.json() as Promise<unknown>),
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(reconnected)).id,
        ).toBe(second);
        yield* browser.use("A reconnect returns to the app's accounts", (page) =>
          page
            .waitForURL(
              (url) => url.pathname === appPath && url.searchParams.get("view") === "accounts",
            )
            .then(() =>
              page.getByRole("button", { name: "Manage Work reports", exact: true }).waitFor(),
            ),
        );
        expect(
          yield* browser.use("A reconnect does not ask for a name", (page) =>
            nameAccountDialog(page).count(),
          ),
        ).toBe(0);
        expect(yield* label(second)).toBe("Work reports");
        yield* browser.checkpoint("Reconnected account keeps its name");
        // The Accounts page manages saved accounts but never takes credentials.
        yield* browser.use("Open the account's menu on Accounts", (page) =>
          page
            .goto(`/org/${actors.organization.slug}/accounts`)
            .then(() =>
              page.getByRole("button", { name: "Manage Work reports", exact: true }).click(),
            )
            .then(() =>
              page.getByRole("menuitem", { name: "Edit details", exact: true }).waitFor(),
            ),
        );
        expect(
          yield* browser.use("Accounts offers no reconnect", (page) =>
            page.getByRole("menuitem", { name: /^(Reconnect|Update credentials)$/ }).count(),
          ),
        ).toBe(0);
      }),
    ),
  );
});
