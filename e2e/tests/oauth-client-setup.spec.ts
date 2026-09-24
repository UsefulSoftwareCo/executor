import { createProfile } from "../support/profiles.ts";
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, SessionClients, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withCase, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { e2eClientMetadataUrl, oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { Target } from "../support/platform.ts";
import { holdQuery } from "../support/query-transition.ts";
import { scenarios } from "../test-plan.ts";

const AppProvider = Schema.Struct({
  ...App.fields,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const Setup = Schema.Struct({ mode: Schema.Literals(["automatic", "saved", "client-required"]) });
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });

const deploy = (name: string, issuer: string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: `${name} ${randomUUID().slice(0, 8)}`,
      files: [
        {
          path: "index.ts",
          content: `import { defineApp, defineProvider, oauth2 } from "apps";
const service=defineProvider({name:${JSON.stringify(name)},auth:{oauth:oauth2({discover:${JSON.stringify(issuer + "/mcp")}})}});
export default defineApp({accounts:{service}},async()=>({queries:{}}));`,
        },
      ],
    });
    expect(response.status).toBe(200);
    const app = yield* body(AppProvider, response);
    yield* Effect.addFinalizer(() =>
      api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
    );
    return app;
  });

layer(HostedLive, { excludeTestServices: true })("OAuth client setup", (it) => {
  it.effect(scenarios.oauthClientMetadata.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const origin = (yield* Target).metadata.origin;
        const anonymous = yield* (yield* SessionClients).session();
        const metadata = yield* anonymous.send("GET", "/api/oauth/client-id-metadata/default.json");
        expect(metadata.status).toBe(200);
        expect(metadata.body).toMatchObject({
          client_id: `${origin}/api/oauth/client-id-metadata/default.json`,
          client_name: "Executor",
          redirect_uris: [
            `http://account-picker.localhost:${new URL(origin).port}/api/oauth/callback?tenant=fixture`,
          ],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        });
      }),
    ),
  );

  it.effect(scenarios.oauthClientMetadataConnect.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          http = yield* HttpClient.HttpClient;
        const issuer = yield* oauthSetupIssuer;
        yield* issuer.configure({
          registration: false,
          clientIdMetadata: true,
          authMethods: ["none"],
        });
        const prefix = `/api/organizations/${actors.organization.id}`;
        const app = yield* deploy("Metadata fixture", issuer.origin);

        yield* browser.login(actors.owner);
        yield* browser.use("Open the app's accounts", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
        );
        yield* browser.use("Start adding an account", (page) =>
          page.getByRole("button", { name: "Add Metadata fixture account", exact: true }).click(),
        );
        yield* browser.use("Connect is enabled once setup resolves", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "Connect Metadata fixture", exact: true, disabled: false })
            .waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("No client ID is requested", (page) =>
            page.getByRole("textbox", { name: "Client ID", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Connect is enabled without a client ID");

        const profile = yield* createProfile(actors.owner, `${prefix}/apps/${app.id}`);
        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
            requirement: "service",
            profile: profile.id,
          }),
        );
        const started = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/oauth/start`,
          { method: "oauth", label: "Metadata account" },
        );
        expect(started.status).toBe(200);
        const { authorizationUrl } = yield* body(SignIn, started);
        expect(new URL(authorizationUrl).searchParams.get("client_id")).toBe(e2eClientMetadataUrl);
        const callbackUrl = yield* Effect.scoped(
          Effect.gen(function* () {
            const consent = yield* HttpClient.withScope(http).get(authorizationUrl);
            expect(consent.status).toBe(302);
            const location = consent.headers.location;
            if (location === undefined)
              return yield* Effect.die("Issuer did not return a callback");
            return location;
          }),
        ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
        const completed = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/oauth/complete`,
          { callbackUrl },
        );
        const metrics = yield* issuer.metrics;
        expect(completed.status, JSON.stringify(metrics.tokenChecks)).toBe(200);
        const account = yield* body(Resource, completed);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`)
            .pipe(Effect.orDie),
        );
        expect(metrics.tokenChecks).toHaveProperty("publicClient", true);
        expect(metrics.registrations).toBe(0);

        const document = yield* api.request(
          actors.owner,
          "GET",
          "/api/oauth/client-id-metadata/default.json",
        );
        expect(
          (yield* body(Schema.Struct({ redirect_uris: Schema.Array(Schema.String) }), document))
            .redirect_uris,
        ).toContain(metrics.lastRedirect);
      }),
    ),
  );

  it.effect(scenarios.oauthClientSetup.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const app = yield* deploy("Setup fixture", issuer.origin);
        const setupPath = (provider: string) => `${prefix}/providers/${provider}/oauth/oauth/setup`;
        const provider = app.requirements.accounts.service.provider;
        const inspect = (target: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "GET", setupPath(target));
            expect(response.status).toBe(200);
            expect(
              Object.keys(yield* body(Schema.Record(Schema.String, Schema.Unknown), response)),
            ).toEqual(["mode", "scopes", "grant", "tokenEndpointAuthMethod"]);
            return yield* body(Setup, response);
          });
        expect((yield* inspect(provider)).mode).toBe("automatic");
        expect((yield* issuer.metrics).registrations).toBe(0);
        expect((yield* api.request(actors.member, "GET", setupPath(provider))).status).toBe(403);
        const start = (target: typeof AppProvider.Type) =>
          Effect.gen(function* () {
            const profile = yield* createProfile(actors.owner, `${prefix}/apps/${target.id}`);
            const connection = yield* body(
              Resource,
              yield* api.request(actors.owner, "POST", `${prefix}/apps/${target.id}/connections`, {
                requirement: "service",
                profile: profile.id,
              }),
            );
            return yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/oauth/start`,
              { method: "oauth", label: "Synthetic setup account" },
            );
          });
        expect((yield* start(app)).status).toBe(200);
        expect((yield* issuer.metrics).registrations).toBe(1);
        yield* issuer.configure({ registration: false });
        expect((yield* inspect(provider)).mode).toBe("saved");
        expect((yield* issuer.metrics).registrations).toBe(1);
        yield* issuer.configure({ scopes: ["write"] });
        expect((yield* inspect(provider)).mode).toBe("client-required");
        yield* issuer.configure({ scopes: ["read"] });
        const expired = yield* deploy("Expired setup fixture", issuer.origin);
        yield* issuer.configure({ registration: true, expiresAt: 1 });
        expect((yield* start(expired)).status).toBe(200);
        yield* issuer.configure({ registration: false });
        expect((yield* inspect(expired.requirements.accounts.service.provider)).mode).toBe(
          "client-required",
        );
        yield* issuer.configure({ discovery: "unavailable" });
        expect((yield* api.request(actors.owner, "GET", setupPath(provider))).status).toBe(422);
        yield* issuer.configure({ discovery: "available" });
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.owner);
        const check = yield* holdQuery(
          [actors.organization.id, actors.organization.slug].map(
            (id) => `/api/organizations/${id}/providers/${provider}/oauth/oauth/setup`,
          ),
          "continue",
        );
        yield* browser.use("Open the app with its setup check held", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
        );
        yield* check.requested;
        yield* browser.use("Open the name form before setup resolves", (page) =>
          page.getByRole("button", { name: "Add Setup fixture account", exact: true }).click(),
        );
        yield* browser.use("A draft remains editable during the setup check", (page) =>
          page.getByRole("textbox", { name: "Account name", exact: true }).fill("Preserved name"),
        );
        expect(
          yield* browser.use("Unknown setup cannot start sign-in", (page) =>
            page
              .getByRole("dialog")
              .getByRole("button", { name: "Connect Setup fixture", exact: true })
              .count(),
          ),
        ).toBe(0);
        expect(
          yield* browser.use("Unknown setup does not guess client entry", (page) =>
            page.getByRole("textbox", { name: "Client ID", exact: true }).count(),
          ),
        ).toBe(0);
        yield* issuer.configure({ discovery: "unavailable" });
        yield* check.release;
        yield* browser.use("Failed discovery offers retry", (page) =>
          page
            .getByRole("alert")
            .getByText("The connected service’s sign-in is unavailable", { exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("OAuth setup check failed without guessing");
        yield* issuer.configure({ discovery: "available" });
        yield* browser.use("Retry the real setup endpoint", (page) =>
          page.getByRole("dialog").getByRole("button", { name: "Try again", exact: true }).click(),
        );
        yield* browser.use("Retry clears the setup error", (page) =>
          page.getByRole("alert").waitFor({ state: "hidden" }),
        );
        yield* browser.use("Wait for the setup check to resolve", (page) =>
          page
            .getByRole("status", { name: "Preparing connection", exact: true })
            .waitFor({ state: "hidden" }),
        );
        expect(
          yield* browser.use("Automatic setup enables Connect", (page) =>
            page
              .getByRole("dialog")
              .getByRole("button", { name: "Connect Setup fixture", exact: true })
              .isEnabled(),
          ),
        ).toBe(true);
        expect(
          yield* browser.use("Retry preserves the typed name", (page) =>
            page.getByRole("textbox", { name: "Account name", exact: true }).inputValue(),
          ),
        ).toBe("Preserved name");
        expect(
          yield* browser.use("Automatic setup has no manual-client option", (page) =>
            page.getByRole("button", { name: "Use your own OAuth client", exact: true }).count(),
          ),
        ).toBe(0);
        const cached = yield* issuer.metrics;
        yield* browser.use("Close the form", (page) =>
          page.getByRole("button", { name: "Close", exact: true }).click(),
        );
        yield* browser.use("Reopen with the cached setup result", (page) =>
          page.getByRole("button", { name: "Add Setup fixture account", exact: true }).click(),
        );
        yield* browser.use("The reopened form is ready", (page) =>
          page
            .getByRole("textbox", { name: "Account name", exact: true })
            .waitFor({ state: "visible" }),
        );
        expect((yield* issuer.metrics).discoveries).toBe(cached.discoveries);
        expect((yield* issuer.metrics).registrations).toBe(2);
        yield* browser.checkpoint("Automatic client setup from cached metadata");
      }),
    ),
  );
});
