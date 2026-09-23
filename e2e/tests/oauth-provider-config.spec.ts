import { createProfile } from "../support/profiles.ts";
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { scenarios } from "../test-plan.ts";

const SignIn = Schema.Struct({ authorizationUrl: Schema.String });

layer(HostedLive, { excludeTestServices: true })("OAuth declarations", (it) => {
  it.effect(scenarios.oauthProviderConfig.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const issuer = yield* oauthSetupIssuer;
        yield* issuer.configure({
          scopes: ["read", "write", "offline_access"],
          authMethods: ["client_secret_basic", "client_secret_post"],
        });
        const prefix = `/api/organizations/${actors.organization.id}`;
        const connect = (config: object) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `OAuth declaration ${randomUUID().slice(0, 8)}`,
              files: [
                {
                  path: "index.ts",
                  content: `import { defineApp, defineProvider, oauth2 } from "apps";
const service=defineProvider({name:"Declared OAuth",auth:{oauth:oauth2(${JSON.stringify(config)})}});
export default defineApp({accounts:{service}},async()=>({queries:{}}));`,
                },
              ],
            });
            expect(response.status).toBe(200);
            const app = yield* body(Resource, response);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
            );
            const profile = yield* createProfile(actors.owner, `${prefix}/apps/${app.id}`);
            const connection = yield* body(
              Resource,
              yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
                requirement: "service",
                profile: profile.id,
              }),
            );
            return `${prefix}/connections/${connection.id}/oauth/start`;
          });
        const path = yield* connect({
          discover: `${issuer.origin}/mcp`,
          scopes: ["read"],
          resource: null,
          tokenEndpointAuthMethod: "client_secret_post",
        });
        const response = yield* api.request(actors.owner, "POST", path, {
          method: "oauth",
          label: "Declared",
        });
        expect(response.status).toBe(200);
        const url = new URL((yield* body(SignIn, response)).authorizationUrl);
        expect(url.searchParams.get("scope")).toBe("read");
        expect(url.searchParams.has("resource")).toBe(false);
        expect((yield* issuer.metrics).lastRegistration).toEqual({
          scope: "read",
          method: "client_secret_post",
        });

        const emptyPath = yield* connect({
          discover: `${issuer.origin}/mcp`,
          scopes: [],
          resource: `${issuer.origin}/api`,
          tokenEndpointAuthMethod: "client_secret_basic",
        });
        const empty = new URL(
          (yield* body(
            SignIn,
            yield* api.request(actors.owner, "POST", emptyPath, {
              method: "oauth",
              label: "No scopes",
            }),
          )).authorizationUrl,
        );
        expect(empty.searchParams.has("scope")).toBe(false);
        expect(empty.searchParams.get("resource")).toBe(`${issuer.origin}/api`);

        yield* issuer.configure({ authMethods: ["client_secret_basic"] });
        const incompatible = yield* connect({
          discover: `${issuer.origin}/mcp`,
          tokenEndpointAuthMethod: "client_secret_post",
        });
        expect(
          (yield* api.request(actors.owner, "POST", incompatible, {
            method: "oauth",
            label: "Unsupported",
          })).status,
        ).toBe(422);
      }),
    ),
  );
});
