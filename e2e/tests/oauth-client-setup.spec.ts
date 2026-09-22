import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { holdQuery } from "../support/query-transition.ts";
import { scenarios } from "../test-plan.ts";

const AppProvider = Schema.Struct({
  ...App.fields,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const Setup = Schema.Struct({ mode: Schema.Literals(["automatic", "saved", "client-required"]) });

layer(HostedLive, { excludeTestServices: true })("OAuth client setup", (it) => {
  it.effect(scenarios.oauthClientSetup.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deploy = (name: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `${name} ${randomUUID().slice(0, 8)}`,
              files: [
                {
                  path: "index.ts",
                  content: `import { defineApp, defineProvider, oauth2 } from "apps";
const service=defineProvider({name:${JSON.stringify(name)},auth:{oauth:oauth2({discover:${JSON.stringify(issuer.origin + "/mcp")}})}});
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
        const app = yield* deploy("Setup fixture");
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
            const connection = yield* body(
              Resource,
              yield* api.request(actors.owner, "POST", `${prefix}/apps/${target.id}/connections`, {
                requirement: "service",
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
        const expired = yield* deploy("Expired setup fixture");
        yield* issuer.configure({ registration: true, expiresAt: 1 });
        expect((yield* start(expired)).status).toBe(200);
        yield* issuer.configure({ registration: false });
        expect((yield* inspect(expired.requirements.accounts.service.provider)).mode).toBe(
          "client-required",
        );
        yield* issuer.configure({ discoveryFails: true });
        expect((yield* api.request(actors.owner, "GET", setupPath(provider))).status).toBe(422);
        yield* issuer.configure({ discoveryFails: false });
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
        yield* issuer.configure({ discoveryFails: true });
        yield* check.release;
        yield* browser.use("Failed discovery offers retry", (page) =>
          page
            .getByRole("alert")
            .getByText("Couldn’t prepare sign-in.", { exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("OAuth setup check failed without guessing");
        yield* issuer.configure({ discoveryFails: false });
        yield* browser.use("Retry the real setup endpoint", (page) =>
          page.getByRole("dialog").getByRole("button", { name: "Retry", exact: true }).click(),
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
