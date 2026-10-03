import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Emulators } from "../support/emulators.ts";
import { appsManifest } from "../support/apps-release.ts";
import { nameConnectedAccount } from "../support/name-account.ts";
import { Profile, createProfile } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";

const Setup = Schema.Struct({
  mode: Schema.Literals(["automatic", "saved", "client-required"]),
  scopes: Schema.Array(Schema.String),
});
const AppProvider = Schema.Struct({
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });

/** Like real GitHub, these endpoints offer no automatic client registration. */
const source = (github: string, mismatch?: "authorization" | "token") => `
import { defineApp, defineProvider, oauth2, object, query, router } from "apps";
const service = defineProvider({ name: "GitHub", auth: { oauth: oauth2({
  authorizationUrl: ${JSON.stringify(`${github}/login/oauth/authorize${mismatch === "authorization" ? "?other=1" : ""}`)},
  tokenUrl: ${JSON.stringify(`${github}/login/oauth/access_token${mismatch === "token" ? "?other=1" : ""}`)},
  scopes: ["repo"],
  tokenEndpointAuthMethod: "client_secret_post",
}) } });
export default defineApp({ accounts: { service } }, async ({ accounts }) => ({
  tools: router({
    viewer: query({ input: object({}) }, async ({ fetch }) => {
      const response = await fetch(${JSON.stringify(`${github}/user`)}, {
        headers: { authorization: "Bearer " + accounts.service.fields.access_token },
      });
      if (!response.ok) throw new Error("GitHub returned " + response.status);
      const user = await response.json();
      return { login: user.login };
    }),
  }),
}));`;

layer(HostedLive, { excludeTestServices: true })("Cloud GitHub OAuth", (it) => {
  it.effect(scenarios.cloudGithubOAuth.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          browser = yield* Browser,
          emulators = yield* Emulators;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const identity = yield* emulators.identity("github");
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `GitHub ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: source(emulators.githubOrigin) }, appsManifest],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        const appPath = `${prefix}/apps/${app.id}`;
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", appPath);
            for (const account of accounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        const profile = yield* createProfile(actors.owner, appPath);
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.owner);
        const url = `/org/${actors.organization.slug}/apps/${app.id}?view=accounts&profile=${profile.id}`;
        yield* browser.use("Open the GitHub app's accounts", (page) => page.goto(url));
        yield* browser.use("Start a GitHub connection", (page) =>
          page.getByRole("button", { name: "Connect new account", exact: true }).click(),
        );
        yield* browser.use("Wait for OAuth setup to resolve", (page) =>
          page
            .getByRole("status", { name: "Preparing connection", exact: true })
            .waitFor({ state: "hidden" }),
        );
        expect(
          yield* browser.use("GitHub needs no client ID from the user", (page) =>
            page
              .getByRole("dialog")
              .getByRole("textbox", { name: "Client ID", exact: true })
              .count(),
          ),
        ).toBe(0);
        expect(
          yield* browser.use("GitHub needs no client secret from the user", (page) =>
            page.getByRole("dialog").getByLabel("Client secret", { exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("GitHub connects without client entry");
        yield* browser.use("Connect GitHub", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "Connect GitHub", exact: true })
            .click(),
        );
        yield* browser.use("Wait for GitHub consent", (page) =>
          page.getByRole("button").filter({ hasText: identity.email }).waitFor(),
        );
        const authorization = new URL(
          yield* browser.use("Inspect GitHub authorization", (page) =>
            page.evaluate(() => window.location.href),
          ),
        );
        expect(authorization.searchParams.has("scope")).toBe(false);
        yield* browser.use("Approve on the GitHub emulator", (page) =>
          page.getByRole("button").filter({ hasText: identity.email }).click(),
        );
        yield* browser.use("Keep the connected account's default name", nameConnectedAccount);
        const selected = yield* body(
          Profile,
          yield* api.request(actors.owner, "GET", `${appPath}/profiles/${profile.id}`),
        );
        const account = selected.accounts.service;
        expect(typeof account).toBe("string");
        if (typeof account === "string") accounts.push(account);
        const viewer = yield* body(
          Schema.Struct({ login: Schema.String }),
          yield* api.request(actors.owner, "POST", `${appPath}/tools/call`, {
            profile: profile.id,
            tool: "viewer",
            input: {},
          }),
        );
        expect(viewer.login).toBe(identity.login);
        const provider = yield* body(AppProvider, yield* api.request(actors.owner, "GET", appPath));
        const setup = () =>
          api
            .request(
              actors.owner,
              "GET",
              `${prefix}/providers/${provider.requirements.accounts.service.provider}/oauth/oauth/setup`,
            )
            .pipe(Effect.flatMap((response) => body(Setup, response)));
        // "saved" here would mean Cloud's client was stored as the organization's own.
        expect(yield* setup()).toMatchObject({ mode: "automatic", scopes: [] });

        // Explicit client input still wins, and only that successful sign-in saves an org client.
        const redirectUri = authorization.searchParams.get("redirect_uri");
        if (redirectUri === null) return yield* Effect.die("Missing OAuth callback");
        const manual = Redacted.value(yield* emulators.githubClient(redirectUri));
        expect(manual.client_id).not.toBe(authorization.searchParams.get("client_id"));
        const manualProfile = yield* createProfile(actors.owner, appPath);
        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${appPath}/connections`, {
            requirement: "service",
            profile: manualProfile.id,
          }),
        );
        const started = yield* body(
          SignIn,
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/oauth/start`,
            {
              method: "oauth",
              client: { clientId: manual.client_id, clientSecret: manual.client_secret },
            },
          ),
        );
        const manualAuthorization = new URL(started.authorizationUrl);
        expect(manualAuthorization.searchParams.get("client_id")).toBe(manual.client_id);
        expect(manualAuthorization.searchParams.get("scope")).toBe("repo");
        yield* browser.use("Authorize the organization's own GitHub app", (page) =>
          page.goto(started.authorizationUrl),
        );
        yield* browser.use("Approve the organization's app", (page) =>
          page.getByRole("button").filter({ hasText: identity.email }).click(),
        );
        yield* browser.use("Name the organization's connected account", nameConnectedAccount);
        const manualSelected = yield* body(
          Profile,
          yield* api.request(actors.owner, "GET", `${appPath}/profiles/${manualProfile.id}`),
        );
        const manualAccount = manualSelected.accounts.service;
        if (typeof manualAccount !== "string")
          return yield* Effect.die("No manual account connected");
        accounts.push(manualAccount);
        expect(yield* setup()).toMatchObject({ mode: "saved", scopes: ["repo"] });

        // A later automatic start uses the saved org app, not Cloud's shared app.
        const savedProfile = yield* createProfile(actors.owner, appPath);
        const savedConnection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${appPath}/connections`, {
            requirement: "service",
            profile: savedProfile.id,
          }),
        );
        const reused = yield* body(
          SignIn,
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${savedConnection.id}/oauth/start`,
            { method: "oauth" },
          ),
        );
        const reusedAuthorization = new URL(reused.authorizationUrl);
        expect(reusedAuthorization.searchParams.get("client_id")).toBe(manual.client_id);
        expect(reusedAuthorization.searchParams.get("scope")).toBe("repo");
      }).pipe(Effect.provide(Emulators.layer)),
    ),
  );
  it.effect(scenarios.cloudGithubOAuthEndpointBinding.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          emulators = yield* Emulators;
        const prefix = `/api/organizations/${actors.organization.id}`;
        for (const endpoint of ["authorization", "token"] as const) {
          const app = yield* body(
            App,
            yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `GitHub endpoint ${randomUUID().slice(0, 8)}`,
              files: [
                { path: "index.ts", content: source(emulators.githubOrigin, endpoint) },
                appsManifest,
              ],
            }),
          );
          const appPath = `${prefix}/apps/${app.id}`;
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", appPath).pipe(Effect.orDie),
          );
          const provider = yield* body(
            AppProvider,
            yield* api.request(actors.owner, "GET", appPath),
          );
          const setup = yield* body(
            Setup,
            yield* api.request(
              actors.owner,
              "GET",
              `${prefix}/providers/${provider.requirements.accounts.service.provider}/oauth/oauth/setup`,
            ),
          );
          expect(setup, `${endpoint} must match exactly`).toMatchObject({
            mode: "client-required",
            scopes: ["repo"],
          });
        }
      }).pipe(Effect.provide(Emulators.layer)),
    ),
  );
});
