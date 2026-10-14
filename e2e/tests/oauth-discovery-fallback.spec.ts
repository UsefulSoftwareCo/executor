/** Path-based discovery consults the server origin only when the path publishes no metadata. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
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
const Failure = Schema.Struct({
  _tag: Schema.Literal("OAuthSetupFailed"),
  reason: Schema.String,
});
const pathMetadata = "/.well-known/oauth-authorization-server/v1/mcp";
const pathOpenId = "/v1/mcp/.well-known/openid-configuration";
const originMetadata = "/.well-known/oauth-authorization-server";

layer(HostedLive, { excludeTestServices: true })("OAuth discovery fallback", (it) => {
  it.effect(scenarios.oauthDiscoveryFallback.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Path discovery",
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, oauth2, router } from "apps";
const service=defineProvider({name:"Path service",auth:{oauth:oauth2({discover:${JSON.stringify(issuer.origin + "/v1/mcp")}})}});
export default defineApp({user: { accounts:{service} }},async()=>({tools: router({})}));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const setupPath = `${prefix}/providers/${app.requirements.accounts.service.provider}/oauth/oauth/setup`;
        const requestedDuring = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            const before = (yield* issuer.metrics).discoveryRequests.length;
            const result = yield* effect;
            return {
              result,
              requested: (yield* issuer.metrics).discoveryRequests.slice(before),
            };
          });

        // Served path metadata is authoritative: a mismatched issuer or unusable document
        // fails setup instead of silently switching to the origin's issuer.
        for (const pathDiscovery of ["issuer-mismatch", "invalid-metadata"] as const) {
          yield* issuer.configure({ pathDiscovery });
          const { result: response, requested } = yield* requestedDuring(
            api.request(actors.owner, "GET", setupPath),
          );
          expect(response.status, `${pathDiscovery} path metadata fails setup`).toBe(422);
          expect((yield* body(Failure, response)).reason).toBe("discovery_invalid");
          expect(requested, `${pathDiscovery} path metadata was served`).toContain(pathMetadata);
          expect(requested, `${pathDiscovery} does not consult the origin`).not.toContain(
            originMetadata,
          );
        }

        // Atlassian's shape: the path-inserted URL is missing and the appended OpenID path
        // refuses the request, so the origin's metadata is the authorization server.
        yield* issuer.configure({ pathDiscovery: "atlassian" });
        const { result: setup, requested } = yield* requestedDuring(
          api.request(actors.owner, "GET", setupPath),
        );
        expect(setup.status, "Missing path metadata falls back to the origin").toBe(200);
        expect((yield* body(Setup, setup)).mode).toBe("automatic");
        expect(requested).toEqual([pathMetadata, pathOpenId, originMetadata]);

        const connection = yield* body(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            connectionsPath(`${prefix}/apps/${app.id}`, "user", "service"),
            {},
          ),
        );
        const start = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/oauth/start`,
          { method: "oauth", label: "Path discovery account" },
        );
        expect(start.status, "Sign-in uses the origin issuer").toBe(200);
        const signIn = new URL(
          (yield* body(Schema.Struct({ authorizationUrl: Schema.String }), start)).authorizationUrl,
        );
        expect(signIn.origin + signIn.pathname).toBe(`${issuer.origin}/authorize`);
        expect((yield* issuer.metrics).registrations).toBe(1);
        yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/cancel`,
          {},
        );
      }),
    ),
  );
});
