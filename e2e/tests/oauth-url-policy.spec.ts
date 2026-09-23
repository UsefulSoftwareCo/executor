import { createProfile } from "../support/profiles.ts";
/** Real hosted account setup, including host config parsing and the SDK's URL policy. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { App, Resource } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";

layer(HostedLive, { excludeTestServices: true })("OAuth URL policy", (it) => {
  it.effect(scenarios.oauthUrlPolicy.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const target = yield* Target;
        const prefix = `/api/organizations/${actors.organization.id}`;
        for (const [origin, status] of [
          ["https://oauth.example.test", 200],
          ["http://oauth.internal:8080", 200],
          ["http://oauth.internal:8081", 422],
        ] as const) {
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `OAuth URL policy ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `
import { defineApp, defineProvider, oauth2 } from "apps";
const service = defineProvider({ name: "URL policy fixture", auth: {
  oauth: oauth2({ authorizationUrl: ${JSON.stringify(origin + "/authorize")}, tokenUrl: ${JSON.stringify(origin + "/token")}, scopes: ["read"] })
} });
export default defineApp({ accounts: { service } }, async () => ({  queries: {} }));`,
              },
            ],
          });
          expect(deployed.status).toBe(200);
          const app = yield* body(App, deployed);
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`)
              .pipe(Effect.asVoid, Effect.orDie),
          );
          const profile = yield* createProfile(actors.owner, `${prefix}/apps/${app.id}`);
          const opened = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/apps/${app.id}/connections`,
            { requirement: "service", profile: profile.id },
          );
          expect(opened.status).toBe(200);
          const connection = yield* body(Resource, opened);
          const started = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/oauth/start`,
            {
              method: "oauth",
              label: "Default",
              client: { clientId: "synthetic-policy-client", tokenEndpointAuthMethod: "none" },
            },
          );
          expect(started.status).toBe(status);
          if (status === 200) {
            const result = yield* body(
              Schema.Struct({ authorizationUrl: Schema.String, redirectUri: Schema.String }),
              started,
            );
            const callback = `http://account-picker.localhost:${new URL(target.metadata.origin).port}/api/oauth/callback?tenant=fixture`;
            expect(result.redirectUri).toBe(callback);
            const authorization = new URL(result.authorizationUrl);
            expect(authorization.origin).toBe(origin);
            expect(authorization.searchParams.get("redirect_uri")).toBe(callback);
            expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
          } else {
            const failure = yield* body(Schema.Struct({ reason: Schema.String }), started);
            expect(failure.reason).toBe("discovery_blocked");
          }
        }
      }),
    ),
  );
});
