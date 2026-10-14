/**
 * Stored OAuth clients belong to the organization and the authorization server they sign in at,
 * not to one app's provider definition. Two apps whose providers describe the same server, one by
 * discovery and one by declared endpoints and issuer, are offered and sign in with one client an
 * administrator registered once. An app whose provider declares endpoints without an issuer signs
 * in at its token endpoint's server, which is another one: it is not offered that client and
 * cannot name it.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { oauthMcpAppFiles } from "../support/authored-templates.ts";
import { withApps } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { scenarios } from "../test-plan.ts";
import { connectionsPath } from "../support/app-accounts.ts";

const DeployedApp = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const Options = Schema.Struct({
  mode: Schema.Literals(["automatic", "client-required"]),
  issuer: Schema.String,
  clients: Schema.Array(
    Schema.Struct({ id: Schema.String, clientId: Schema.String, issuer: Schema.String }),
  ),
});
const Directory = Schema.Struct({
  clients: Schema.Array(
    Schema.Struct({
      client: Schema.Struct({
        id: Schema.String,
        clientId: Schema.String,
        issuer: Schema.NullOr(Schema.String),
      }),
    }),
  ),
  services: Schema.Array(
    Schema.Struct({
      issuer: Schema.String,
      providers: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
    }),
  ),
});
const Registered = Schema.Struct({
  client: Schema.Struct({ id: Schema.String, issuer: Schema.String }),
});
const Redirect = Schema.Struct({
  status: Schema.Literal("redirect"),
  authorizationUrl: Schema.String,
  redirectUri: Schema.String,
});
const Tagged = Schema.Struct({ _tag: Schema.String });

/** Synthetic client details the loopback service accepts once allowed. */
const sharedClient = {
  clientId: "synthetic-shared-issuer-client",
  clientSecret: "synthetic-shared-issuer-secret",
};

/** An app whose provider declares the service's endpoints, and its issuer when given. */
const declaredAppFiles = (name: string, origin: string, issuer: string | undefined) => [
  {
    path: "index.ts",
    content: `import { defineApp, defineProvider, oauth2, router } from "apps";

const service = defineProvider({
  name: ${JSON.stringify(name)},
  hosts: ${JSON.stringify([new URL(origin).host])},
  auth: {
    oauth: oauth2(${JSON.stringify({
      authorizationUrl: `${origin}/authorize`,
      tokenUrl: `${origin}/token`,
      scopes: [],
      ...(issuer === undefined ? {} : { issuer }),
    })}),
  },
});

export default defineApp({ user: { accounts: { service } } }, async () => ({ tools: router({}) }));
`,
  },
  {
    path: "package.json",
    content: JSON.stringify({
      name: "issuer-client-fixture",
      private: true,
      type: "module",
      dependencies: withApps({}),
    }),
  },
];

layer(HostedLive, { excludeTestServices: true })("OAuth clients by issuer", (it) => {
  it.effect(scenarios.oauthClientSharedIssuer.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          http = yield* HttpClient.HttpClient;
        const issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        // Only registered clients can sign in: the service offers no registration.
        yield* issuer.configure({ registration: false, tokenError: null });
        const suffix = randomUUID().slice(0, 8);

        const deploy = (name: string, files: ReadonlyArray<{ path: string; content: string }>) =>
          Effect.gen(function* () {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name,
              files,
            });
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const app = yield* body(DeployedApp, deployed);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
            );
            return { id: app.id, name, provider: app.requirements.accounts.service.provider };
          });
        // Two definitions of one server: discovered, and declared with the issuer it publishes.
        const discovered = yield* deploy(
          `Discovered ${suffix}`,
          oauthMcpAppFiles(`Discovered ${suffix}`, `${issuer.origin}/mcp`),
        );
        const declared = yield* deploy(
          `Declared ${suffix}`,
          declaredAppFiles(`Declared ${suffix}`, issuer.origin, issuer.origin),
        );
        // Endpoints without an issuer: the server is named by its token endpoint.
        const elsewhere = yield* deploy(
          `Elsewhere ${suffix}`,
          declaredAppFiles(`Elsewhere ${suffix}`, issuer.origin, undefined),
        );
        expect(new Set([discovered.provider, declared.provider, elsewhere.provider]).size).toBe(3);

        // The client manager lists servers, each with the apps that sign in there.
        const directory = yield* body(
          Directory,
          yield* api.request(actors.admin, "GET", `${prefix}/oauth-clients`),
        );
        const service = (server: string) =>
          directory.services
            .find((entry) => entry.issuer === server)
            ?.providers.map((provider) => provider.id)
            .toSorted();
        expect(service(issuer.origin)).toEqual([discovered.provider, declared.provider].toSorted());
        expect(service(`${issuer.origin}/token`)).toEqual([elsewhere.provider]);

        // One client, registered once for the server.
        const registered = yield* api.request(actors.admin, "POST", `${prefix}/oauth-clients`, {
          issuer: issuer.origin,
          ...sharedClient,
        });
        expect(registered.status, JSON.stringify(registered.body)).toBe(200);
        const client = (yield* body(Registered, registered)).client;
        expect(client.issuer).toBe(issuer.origin);
        // The same details for the same server are one client.
        const again = yield* api.request(actors.admin, "POST", `${prefix}/oauth-clients`, {
          issuer: issuer.origin,
          ...sharedClient,
        });
        expect(again.status).toBe(409);
        expect((yield* body(Tagged, again))._tag).toBe("OAuthClientExists");

        const options = (provider: string) =>
          api
            .request(actors.owner, "GET", `${prefix}/providers/${provider}/oauth/oauth/setup`)
            .pipe(Effect.flatMap((response) => body(Options, response)));
        const offered = [{ id: client.id, clientId: sharedClient.clientId, issuer: issuer.origin }];
        expect(yield* options(discovered.provider)).toMatchObject({
          issuer: issuer.origin,
          clients: offered,
        });
        expect(yield* options(declared.provider)).toMatchObject({
          issuer: issuer.origin,
          clients: offered,
        });
        // Another server's sign-in is not offered the client.
        expect(yield* options(elsewhere.provider)).toMatchObject({
          issuer: `${issuer.origin}/token`,
          clients: [],
        });

        const connection = (app: string) =>
          Effect.gen(function* () {
            return (yield* body(
              Resource,
              yield* api.request(
                actors.owner,
                "POST",
                connectionsPath(`${prefix}/apps/${app}`, "user", "service"),
                {},
              ),
            )).id;
          });
        const start = (id: string) =>
          api.request(actors.owner, "POST", `${prefix}/connections/${id}/oauth/start`, {
            method: "oauth",
            client: { id: client.id },
          });
        const consent = (authorizationUrl: string) =>
          Effect.scoped(
            Effect.gen(function* () {
              const response = yield* HttpClient.withScope(http).get(authorizationUrl);
              expect(response.status).toBe(302);
              const location = response.headers.location;
              if (location === undefined)
                return yield* Effect.die("Issuer did not return a callback");
              return location;
            }),
          ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));

        // Naming the client for the other server's app is refused as not found.
        const refused = yield* start(yield* connection(elsewhere.id));
        expect(refused.status, JSON.stringify(refused.body)).toBe(404);
        expect((yield* body(Tagged, refused))._tag).toBe("OAuthClientNotFound");

        // Both apps of the server sign in with the one client.
        for (const app of [discovered, declared]) {
          const id = yield* connection(app.id);
          const redirect = yield* body(Redirect, yield* start(id));
          yield* issuer.allowClient({ ...sharedClient, redirect: redirect.redirectUri });
          const completed = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${id}/oauth/complete`,
            { callbackUrl: yield* consent(redirect.authorizationUrl) },
          );
          expect(completed.status, `${app.name}: ${JSON.stringify(completed.body)}`).toBe(200);
        }
        // Still one stored client.
        const after = yield* body(
          Directory,
          yield* api.request(actors.admin, "GET", `${prefix}/oauth-clients`),
        );
        expect(
          after.clients.filter((entry) => entry.client.clientId === sharedClient.clientId),
        ).toEqual([
          { client: { id: client.id, clientId: sharedClient.clientId, issuer: issuer.origin } },
        ]);

        // The client manager names the client by the apps that sign in at its server, and
        // registering picks a server, each listed with its apps.
        const browser = yield* Browser;
        const host = new URL(issuer.origin).host;
        const sharedName = [declared.name, discovered.name].toSorted().join(", ");
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.admin);
        yield* browser.use("Open accounts as an administrator", (page) =>
          page.goto(`/org/${actors.organization.slug}/accounts`),
        );
        yield* browser.use("Open the OAuth client manager", (page) =>
          page.getByRole("button", { name: "OAuth clients", exact: true }).click(),
        );
        yield* browser.use("The client is listed under both apps of its server", (page) =>
          page
            .getByRole("list", { name: "OAuth clients" })
            .getByRole("listitem")
            .filter({ hasText: sharedClient.clientId })
            .getByText(sharedName, { exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("OAuth clients by authorization server");
        yield* browser.use("Pick a server to register a client for", (page) =>
          page
            .getByRole("dialog", { name: "OAuth clients" })
            .getByRole("button", { name: "Register client", exact: true })
            .click()
            .then(() =>
              page
                .getByRole("form", { name: "Register OAuth client" })
                .getByRole("combobox", { name: "Service", exact: true })
                .click(),
            )
            .then(() =>
              page
                .getByRole("option", { name: `${sharedName} · ${host}`, exact: true })
                .waitFor({ state: "visible" }),
            )
            .then(() =>
              page
                .getByRole("option", { name: `${elsewhere.name} · ${host}/token`, exact: true })
                .waitFor({ state: "visible" }),
            ),
        );
        yield* browser.checkpoint("Register a client for an authorization server");
        yield* browser.use("Choose the shared server", (page) =>
          page.getByRole("option", { name: `${sharedName} · ${host}`, exact: true }).click(),
        );
        yield* browser.use("The form says every app of the server can use it", (page) =>
          page
            .getByRole("form", { name: "Register OAuth client" })
            .getByText(
              `Signs in at ${host}. Every app that signs in there can use it: ${sharedName}.`,
            )
            .waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("Registering for a shared authorization server");
      }),
    ),
  );
});
