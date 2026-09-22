import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { Target } from "../support/platform.ts";
import { TestLive, withCase } from "../support/case.ts";
import { clientCredentialsIssuer, machineClient } from "../support/client-credentials-issuer.ts";

const Published = Schema.Struct({
  app: Schema.Struct({
    id: Schema.String,
    requirements: Schema.Struct({
      accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
    }),
  }),
});
const Link = Schema.Struct({ connection: Schema.String, url: Schema.String });
const Setup = Schema.Struct({
  mode: Schema.Literal("client-required"),
  grant: Schema.Literal("client_credentials"),
  tokenEndpointAuthMethod: Schema.Literal("client_secret_basic"),
  scopes: Schema.Array(Schema.String),
});
const Completed = Schema.Struct({
  state: Schema.Struct({
    status: Schema.Literal("completed"),
    account: Schema.Struct({ id: Schema.String, label: Schema.String }),
  }),
});

layer(TestLive, { excludeTestServices: true })("Local OAuth", (it) => {
  it.effect(scenarios.localOAuth.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          target = yield* Target;
        const issuer = yield* clientCredentialsIssuer;
        const session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const deployed = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: "Local machine form",
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, defineProvider, oauth2 } from "apps";
const service=defineProvider({name:"Local reporting",auth:{machine:oauth2({grant:"client_credentials",tokenUrl:${JSON.stringify(issuer.origin + "/token")},scopes:["reports:read"],tokenEndpointAuthMethod:"client_secret_basic"})}});
export default defineApp({accounts:{service}},async()=>({queries:{}}));`,
              },
            ],
          },
          headers,
        );
        expect(deployed.status).toBe(200);
        const { app } = yield* body(Published, deployed);
        let saved: string | undefined;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* session.send("DELETE", `/v1/apps/${app.id}`, undefined, headers);
            if (saved !== undefined)
              yield* session.send("DELETE", `/v1/accounts/${saved}`, undefined, headers);
          }).pipe(Effect.orDie),
        );
        const input = { provider: app.requirements.accounts.service.provider, method: "machine" };
        expect(
          (yield* api.request(session, "POST", "/dashboard/api/accounts/oauth/setup", input))
            .status,
        ).toBe(401);
        const setup = yield* body(
          Setup,
          yield* api.request(
            session,
            "POST",
            "/dashboard/api/accounts/oauth/setup",
            input,
            headers,
          ),
        );
        expect(setup.scopes).toEqual(["reports:read"]);
        const issued = yield* session.send(
          "POST",
          "/account-connect/api/requests",
          { owner: "local", target: { app: app.id, requirement: "service" } },
          headers,
        );
        expect(issued.status).toBe(200);
        const link = yield* body(Link, issued);
        const token = new URLSearchParams(new URL(link.url).hash.slice(1)).get("token");
        expect(token).not.toBeNull();
        expect(
          (yield* api.request(session, "POST", "/account-connect/api/oauth/setup", {
            connection: link.connection,
            token: "invalid",
            method: "machine",
          })).status,
        ).toBe(401);
        expect(
          yield* body(
            Setup,
            yield* api.request(session, "POST", "/account-connect/api/oauth/setup", {
              connection: link.connection,
              token,
              method: "machine",
            }),
          ),
        ).toEqual(setup);
        expect((yield* issuer.metrics).requests).toBe(0);
        yield* browser.omitNetworkTrace;
        yield* browser.use("Open the limited local connection link", (page) => page.goto(link.url));
        yield* browser.use("Local forms use the declared client requirements", (page) =>
          page
            .getByLabel("Client secret", { exact: true })
            .waitFor({ state: "visible" })
            .then(() =>
              Promise.all([
                page.getByRole("combobox").count(),
                page.getByRole("button", { name: "Copy redirect URL" }).count(),
              ]),
            )
            .then((counts) => {
              expect(counts).toEqual([0, 0]);
            })
            .then(() => page.getByLabel("Account name", { exact: true }).fill("Local reports"))
            .then(() => page.getByLabel("Client ID", { exact: true }).fill(machineClient.clientId))
            .then(() =>
              page.getByLabel("Client secret", { exact: true }).fill(machineClient.clientSecret),
            )
            .then(() =>
              page.getByRole("button", { name: "Connect Local reporting", exact: true }).click(),
            )
            .then(() =>
              page
                .getByRole("heading", { name: "Account connected", exact: true })
                .waitFor({ state: "visible" }),
            ),
        );
        const completed = yield* body(
          Completed,
          yield* session.send(
            "GET",
            `/v1/account-connections/${link.connection}`,
            undefined,
            headers,
          ),
        );
        saved = completed.state.account.id;
        expect(completed.state.account.label).toBe("Local reports");
        expect((yield* issuer.metrics).generation).toBe(1);
        yield* browser.checkpoint("Local client-credentials connection completed");
      }),
    ),
  );
});
