/**
 * OAuth sign-in completes against an authorization server that, like some behind a firewall,
 * refuses requests without a User-Agent. Discovery names Executor; Workers send no User-Agent of
 * their own.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";
import { connectionsPath } from "../support/app-accounts.ts";

const App = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const Setup = Schema.Struct({ mode: Schema.String });
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });

layer(HostedLive, { excludeTestServices: true })("OAuth User-Agent", (it) => {
  it.effect(scenarios.oauthUserAgent.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          http = yield* HttpClient.HttpClient;
        const issuer = yield* oauthSetupIssuer;
        yield* issuer.configure({ requireUserAgent: true, scopes: ["read"] });
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `OAuth User-Agent ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, oauth2, router } from "apps";
const service=defineProvider({name:"Firewalled OAuth",auth:{oauth:oauth2(${JSON.stringify({
                discover: `${issuer.origin}/mcp`,
                scopes: ["read"],
                resource: null,
              })})}});
export default defineApp({user:{accounts:{service}}},async()=>({tools: router({})}));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );

        // Discovery reads the server's metadata and finds dynamic registration.
        const setup = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/providers/${app.requirements.accounts.service.provider}/oauth/oauth/setup`,
        );
        expect(setup.status, JSON.stringify(setup.body)).toBe(200);
        expect((yield* body(Setup, setup)).mode).toBe("automatic");

        // Sign-in registers a client, and the callback exchanges its code for tokens.
        const connection = yield* body(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            connectionsPath(`${prefix}/apps/${app.id}`, "user", "service"),
            {},
          ),
        );
        const started = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/oauth/start`,
          { method: "oauth", label: "Firewalled" },
        );
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const signIn = yield* body(SignIn, started);
        const callbackUrl = yield* Effect.scoped(
          Effect.gen(function* () {
            // The user's browser names itself.
            const consent = yield* HttpClient.withScope(http).get(signIn.authorizationUrl, {
              headers: { "user-agent": "Synthetic browser" },
            });
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
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        const account = yield* body(Resource, completed);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`)
            .pipe(Effect.orDie),
        );

        // Every request reached the server with a User-Agent, so none was refused. Executor names
        // itself on the metadata it fetches; the OAuth library names itself on what it sends.
        const metrics = yield* issuer.metrics;
        expect(metrics.registrations).toBe(1);
        expect(metrics.tokenExchanges).toBe(1);
        const sent = metrics.userAgents.filter(({ path }) => path !== "/authorize");
        for (const path of ["/register", "/token"])
          expect(sent.some((request) => request.path === path)).toBe(true);
        for (const request of sent) expect(request.userAgent, request.path).toBeTruthy();
        const discovery = sent.filter(
          ({ path }) => path === "/mcp" || path.startsWith("/.well-known/"),
        );
        expect(discovery.map(({ path }) => path)).toEqual(
          expect.arrayContaining([
            "/mcp",
            "/.well-known/oauth-protected-resource/mcp",
            "/.well-known/oauth-authorization-server",
          ]),
        );
        expect(new Set(discovery.map(({ userAgent }) => userAgent))).toEqual(new Set(["Executor"]));
      }),
    ),
  );
});
