import { createProfile } from "../support/profiles.ts";
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { Target } from "../support/platform.ts";
import { TestLive, withCase } from "../support/case.ts";
import { clientCredentialsIssuer, machineClient } from "../support/client-credentials-issuer.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { accessBeforeConnect, formOrder } from "../support/oauth-client-form.ts";
import { nameAccountDialog } from "../support/name-account.ts";
import { appsManifest } from "../support/apps-release.ts";

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
/** A pending request whose latest sign-in failed, as an agent reads it. */
const Failed = Schema.Struct({
  state: Schema.Struct({
    status: Schema.Literal("pending"),
    failure: Schema.Struct({
      at: Schema.String,
      error: Schema.Struct({
        _tag: Schema.String,
        reason: Schema.String,
        message: Schema.String,
        cause: Schema.Struct({
          stage: Schema.String,
          status: Schema.Number,
          providerError: Schema.String,
        }),
        serviceError: Schema.Struct({ error: Schema.String, description: Schema.String }),
      }),
    }),
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
            name: "Local machine form",
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, defineProvider, oauth2, router } from "apps";
const service=defineProvider({name:"Local reporting",auth:{machine:oauth2({grant:"client_credentials",tokenUrl:${JSON.stringify(issuer.origin + "/token")},scopes:["reports:read"],tokenEndpointAuthMethod:"client_secret_basic"})}});
export default defineApp({accounts:{service}},async()=>({tools: router({})}));`,
              },
              appsManifest,
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
        const profile = yield* createProfile(
          agent,
          `/v1/apps/${app.id}`,
          { owner: "local", subject: "local" },
          headers,
        );
        const issued = yield* session.send(
          "POST",
          "/account-connect/api/requests",
          { owner: "local", target: { app: app.id, profile: profile.id, requirement: "service" } },
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
        expect(completed.state.account.label).toBe("Default");
        // The limited connection page sits outside the dashboard, so nothing asks for a name.
        expect(
          yield* browser.use("The connection link does not ask for a name", (page) =>
            nameAccountDialog(page).count(),
          ),
        ).toBe(0);
        expect((yield* issuer.metrics).generation).toBe(1);
        yield* browser.checkpoint("Local client-credentials connection completed");
        // A saved client the service no longer accepts, as after a rotated secret, opens
        // client entry with that error's own explanation. No registration was attempted and
        // the method has no redirect URL, so neither is mentioned.
        yield* issuer.configure({ rejected: true });
        const rotated = yield* body(
          Link,
          yield* session.send(
            "POST",
            "/account-connect/api/requests",
            {
              owner: "local",
              target: { app: app.id, profile: profile.id, requirement: "service" },
            },
            headers,
          ),
        );
        yield* browser.use("Connect again with the saved client", (page) =>
          page
            .goto(rotated.url)
            .then(() =>
              page.getByRole("button", { name: "Connect Local reporting", exact: true }).waitFor(),
            )
            .then(() =>
              page
                .getByLabel("Client ID", { exact: true })
                .count()
                .then((fields) => expect(fields).toBe(0)),
            )
            .then(() =>
              page.getByRole("button", { name: "Connect Local reporting", exact: true }).click(),
            )
            .then(() => page.getByLabel("Client secret", { exact: true }).waitFor()),
        );
        const notAccepted = yield* browser.use("Read the rejected saved client", (page) =>
          Promise.all([
            page.getByRole("alert", { name: "OAuth client not accepted", exact: true }).innerText(),
            page.getByRole("button", { name: "Copy redirect URL" }).count(),
            page.getByText("enter its client ID", { exact: false }).count(),
            formOrder({
              notice: page.getByRole("alert", { name: "OAuth client not accepted", exact: true }),
              clientId: page.getByLabel("Client ID", { exact: true }),
              clientSecret: page.getByLabel("Client secret", { exact: true }),
              connect: page.getByRole("button", { name: "Connect Local reporting", exact: true }),
            }),
          ]),
        );
        expect(notAccepted[0]).toContain(
          "The client ID, secret or authentication method doesn’t match what the service expects. Check the client in the service’s developer settings, then enter its current details.",
        );
        expect(notAccepted[0]).toContain("Service response: invalid_client");
        expect(notAccepted[0]).not.toContain("registration");
        expect(notAccepted.slice(1)).toEqual([
          0,
          0,
          ["notice", "clientId", "clientSecret", "connect"],
        ]);
        yield* browser.checkpoint("Local-OAuth-saved-client-rejected");
        yield* issuer.configure({ rejected: false });
        const discovery = yield* oauthSetupIssuer;
        yield* discovery.configure({ discovery: "missing" });
        const discoveryDeployment = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: "Local connection error",
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, defineProvider, oauth2, router } from "apps";
const service=defineProvider({name:"Sample service",auth:{oauth:oauth2({discover:${JSON.stringify(discovery.origin + "/mcp")}})}});
export default defineApp({accounts:{service}},async()=>({tools: router({})}));`,
              },
              appsManifest,
            ],
          },
          headers,
        );
        expect(discoveryDeployment.status).toBe(200);
        const { app: discoveryApp } = yield* body(Published, discoveryDeployment);
        yield* Effect.addFinalizer(() =>
          session
            .send("DELETE", `/v1/apps/${discoveryApp.id}`, undefined, headers)
            .pipe(Effect.orDie),
        );
        const discoveryProfile = yield* createProfile(
          agent,
          `/v1/apps/${discoveryApp.id}`,
          { owner: "local", subject: "local" },
          headers,
        );
        const discoveryRequest = yield* session.send(
          "POST",
          "/account-connect/api/requests",
          {
            owner: "local",
            target: {
              app: discoveryApp.id,
              profile: discoveryProfile.id,
              requirement: "service",
            },
          },
          headers,
        );
        expect(discoveryRequest.status).toBe(200);
        const discoveryLink = yield* body(Link, discoveryRequest);
        yield* browser.use("Open a failing limited connection link", (page) =>
          page
            .goto(discoveryLink.url)
            .then(() =>
              page
                .getByRole("alert")
                .getByText("OAuth settings not found", { exact: true })
                .waitFor(),
            ),
        );
        const explanation = yield* browser.use("Local uses the shared cause and recovery", (page) =>
          page.getByRole("alert", { name: "OAuth settings not found", exact: true }).innerText(),
        );
        expect(explanation).toContain(
          "This app uses OAuth, but its server doesn’t say how to sign in.",
        );
        expect(explanation).toContain("Check the app’s server URL and sign-in method.");
        expect(explanation).toContain("OAuthSetupFailed");
        expect(explanation).not.toContain("No account credentials were changed");
        expect(
          yield* browser.use("Configuration failures do not offer retry", (page) =>
            page.getByRole("button", { name: "Try again", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Local-OAuth-missing-settings-card");
        const fixPrompt = yield* browser.use("Copy the local integration fix prompt", (page) =>
          page
            .context()
            .grantPermissions(["clipboard-read", "clipboard-write"])
            .then(() => page.getByRole("button", { name: "Copy fix prompt", exact: true }).click())
            .then(() => page.evaluate(() => navigator.clipboard.readText())),
        );
        expect(fixPrompt).toContain("OAuthSetupFailed");
        expect(fixPrompt).toContain("provider definition");
        expect(fixPrompt).toContain("Verify the failed operation");
        expect(fixPrompt).not.toContain(discoveryLink.url);

        // The service publishes its settings but refuses to register Executor's callback URL.
        const refusal = "Redirect URIs must be on a host this service has approved";
        yield* discovery.configure({
          discovery: "available",
          registrationStatus: 400,
          registrationError: "invalid_redirect_uri",
          registrationErrorDescription: refusal,
        });
        yield* browser.use("Reload the link and start sign-in", (page) =>
          page
            .reload()
            .then(() =>
              page.getByRole("button", { name: "Connect Sample service", exact: true }).click(),
            )
            .then(() =>
              page
                .getByRole("alert")
                .getByText("Callback URL refused during registration", { exact: true })
                .waitFor(),
            ),
        );
        const steps =
          "Create an OAuth app there with this redirect URL, then enter its client ID and secret.";
        const refused = yield* browser.use("The page shows the service’s own error", (page) =>
          page
            .getByRole("alert", { name: "Callback URL refused during registration", exact: true })
            .innerText(),
        );
        // Local says once what happened and what to do, in the reason's own words, as the
        // hosted dialog does.
        expect(refused).toContain(
          "This service doesn’t accept Executor’s callback URL. Create an OAuth app there with this redirect URL and enter its client ID and secret, or ask the service to allow it.",
        );
        expect(refused).toContain(`Service response: invalid_redirect_uri: ${refusal}`);
        expect(refused).not.toContain("OAuthSetupFailed");
        const refusedForm = yield* browser.use("Read the refused form top to bottom", (page) =>
          Promise.all([
            formOrder({
              heading: page.getByRole("heading", { name: "Connect Sample service", exact: true }),
              notice: page.getByRole("alert", {
                name: "Callback URL refused during registration",
                exact: true,
              }),
              redirect: page.getByRole("button", { name: "Copy redirect URL", exact: true }),
              clientId: page.getByLabel("Client ID", { exact: true }),
              clientSecret: page.getByLabel("Client secret", { exact: true }),
              access: page.locator("[data-credential-access]"),
              connect: page.getByRole("button", { name: "Connect Sample service", exact: true }),
            }),
            accessBeforeConnect(page.locator("main")),
            page.getByText("Create an OAuth app", { exact: false }).count(),
            page.getByText("enter its client ID", { exact: false }).count(),
            // The failure's recovery replaces the form's helper line.
            page.getByText("Use an OAuth app in", { exact: false }).count(),
          ]),
        );
        expect(refusedForm).toEqual([
          ["heading", "notice", "redirect", "clientId", "clientSecret", "access", "connect"],
          true,
          1,
          1,
          0,
        ]);
        yield* browser.checkpoint("Local-OAuth-registration-refused-card");
        // The agent that issued the link reads the same failure from the request.
        const failed = yield* body(
          Failed,
          yield* session.send(
            "GET",
            `/v1/account-connections/${discoveryLink.connection}`,
            undefined,
            headers,
          ),
        );
        expect(failed.state.failure.error).toMatchObject({
          _tag: "OAuthSetupFailed",
          reason: "client_not_approved",
          cause: { stage: "register", status: 400, providerError: "invalid_redirect_uri" },
          serviceError: { error: "invalid_redirect_uri", description: refusal },
        });
        expect(failed.state.failure.error.message).not.toContain(refusal);

        // Without registration, the link asks for a client and nothing has failed.
        yield* discovery.configure({ registration: false, registrationStatus: 201 });
        yield* browser.use("Reload the link for a service without registration", (page) =>
          page.reload().then(() => page.getByLabel("Client secret", { exact: true }).waitFor()),
        );
        const required = yield* browser.use("Read the client-required page", (page) =>
          Promise.all([
            page.getByRole("alert").count(),
            formOrder({
              heading: page.getByRole("heading", { name: "Connect Sample service", exact: true }),
              guidance: page.getByText(
                `Executor can’t set up sign-in for Sample service automatically. ${steps}`,
                { exact: true },
              ),
              redirect: page.getByRole("button", { name: "Copy redirect URL", exact: true }),
              clientId: page.getByLabel("Client ID", { exact: true }),
              clientSecret: page.getByLabel("Client secret", { exact: true }),
              access: page.locator("[data-credential-access]"),
              connect: page.getByRole("button", { name: "Connect Sample service", exact: true }),
            }),
            accessBeforeConnect(page.locator("main")),
          ]),
        );
        expect(required).toEqual([
          0,
          ["heading", "guidance", "redirect", "clientId", "clientSecret", "access", "connect"],
          true,
        ]);
        yield* browser.checkpoint("Local-OAuth-client-required");

        // A sign-in that fails after the service's page: its token endpoint answers with a long
        // HTML rate-limit page and no Retry-After. The page returns to the link and says so under
        // the heading.
        const limited = "Service rate limit reached";
        yield* discovery.configure({
          registration: true,
          tokenError: {
            status: 429,
            page: () =>
              `<!DOCTYPE html><html><head><title>429 Too Many Requests</title></head><body>` +
              `<h1>Too many requests</h1><p>${"Slow down and try again later. ".repeat(24)}</p>` +
              `</body></html>`,
          },
        });
        yield* browser.use("Sign in until the token request fails", (page) =>
          page
            .reload()
            .then(() =>
              page.getByRole("button", { name: "Connect Sample service", exact: true }).click(),
            )
            .then(() => page.getByRole("alert", { name: limited, exact: true }).waitFor()),
        );
        const completion = yield* browser.use("Read the completion failure", (page) => {
          const notice = page.getByRole("alert", { name: limited, exact: true });
          return Promise.all([
            notice.innerText(),
            notice
              .getByText("Service response:", { exact: false })
              .boundingBox()
              .then((bounds) => bounds?.height),
            formOrder({
              heading: page.getByRole("heading", { name: "Connect Sample service", exact: true }),
              notice,
              access: page.locator("[data-credential-access]"),
              connect: page.getByRole("button", { name: "Connect Sample service", exact: true }),
            }),
          ]);
        });
        expect(completion[0]).toContain(
          "The service asked Executor to wait before sending more sign-in requests. Start the connection again shortly.",
        );
        expect(completion[0]).not.toContain("couldn’t reach");
        expect(completion[0]).toContain(
          "Service response: 429 Too Many Requests Too many requests Slow down and try again later.",
        );
        expect(completion[0]).not.toContain("OAuthCompletionFailed");
        // A long response stops after four lines until shown in full; Copy keeps the whole text.
        expect(completion[1]).toBeLessThanOrEqual(84);
        expect(completion[2]).toEqual(["heading", "notice", "access", "connect"]);
        yield* browser.checkpoint("Local-OAuth-completion-failed");
        const expanded = yield* browser.use("Show the full service response", (page) => {
          const notice = page.getByRole("alert", { name: limited, exact: true });
          return notice
            .getByRole("button", { name: "Show full service response", exact: true })
            .click()
            .then(() => notice.getByText("Service response:", { exact: false }).boundingBox())
            .then((bounds) => bounds?.height);
        });
        expect(expanded).toBeGreaterThan(84);
      }),
    ),
  );
});
