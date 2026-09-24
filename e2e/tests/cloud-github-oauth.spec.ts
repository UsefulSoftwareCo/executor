import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Emulators } from "../support/emulators.ts";
import { Profile, createProfile } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";

const Setup = Schema.Struct({ mode: Schema.Literals(["automatic", "saved", "client-required"]) });

/** Like real GitHub, these endpoints offer no automatic client registration. */
const source = (github: string) => `
import { defineApp, defineProvider, oauth2, object, query } from "apps";
const service = defineProvider({ name: "GitHub", auth: { oauth: oauth2({
  authorizationUrl: ${JSON.stringify(`${github}/login/oauth/authorize`)},
  tokenUrl: ${JSON.stringify(`${github}/login/oauth/access_token`)},
  scopes: ["repo"],
  tokenEndpointAuthMethod: "client_secret_post",
}) } });
export default defineApp({ accounts: { service } }, {
  queries: {
    viewer: query({ input: object({}) }, async (ctx) => {
      const response = await fetch(${JSON.stringify(`${github}/user`)}, {
        headers: { authorization: "Bearer " + ctx.accounts.service.fields.access_token },
      });
      if (!response.ok) throw new Error("GitHub returned " + response.status);
      const user = await response.json();
      return { login: user.login };
    }),
  },
});`;

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
          files: [{ path: "index.ts", content: source(emulators.githubOrigin) }],
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
          page.getByRole("button", { name: "Add GitHub account", exact: true }).click(),
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
        yield* browser.use("Approve on the GitHub emulator", (page) =>
          page.getByRole("button").filter({ hasText: identity.email }).click(),
        );
        yield* browser.use("Return to the app's accounts", (page) =>
          page
            .getByRole("region", { name: "GitHub", exact: true })
            .getByRole("link", { name: "Default", exact: true })
            .waitFor({ state: "visible" }),
        );
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
            tool: "queries.viewer",
            input: {},
          }),
        );
        expect(viewer.login).toBe(identity.login);
        const provider = yield* body(
          Schema.Struct({
            requirements: Schema.Struct({
              accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
            }),
          }),
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
        // "saved" here would mean Cloud's client was stored as the organization's own.
        expect(setup.mode).toBe("automatic");
      }).pipe(Effect.provide(Emulators.layer)),
    ),
  );
});
