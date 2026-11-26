import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { connectionsPath } from "../support/app-accounts.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const google = "https://accounts.google.com/o/oauth2/v2/auth";

layer(HostedLive, { excludeTestServices: true })("Google renewable grant", (it) => {
  it.effect(scenarios.oauthGoogleRenewableGrant.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const signIn = (config: object) =>
          Effect.gen(function* () {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `Google sign-in ${randomUUID().slice(0, 8)}`,
              files: [
                {
                  path: "index.ts",
                  content: `import { defineApp, defineProvider, oauth2, router } from "apps";
const service=defineProvider({name:"Calendar",auth:{oauth:oauth2(${JSON.stringify({
                    tokenUrl: "https://oauth2.googleapis.com/token",
                    scopes: ["https://www.googleapis.com/auth/calendar"],
                    tokenEndpointAuthMethod: "client_secret_post",
                    ...config,
                  })})}});
export default defineApp({user: { accounts:{service} }},async()=>({tools: router({})}));`,
                },
                appsManifest,
              ],
            });
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const app = yield* body(Resource, deployed);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
            );
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
              {
                method: "oauth",
                label: "Calendar",
                client: {
                  clientId: "synthetic-google-client",
                  clientSecret: "synthetic-google-secret",
                },
              },
            );
            expect(started.status, JSON.stringify(started.body)).toBe(200);
            const url = new URL((yield* body(SignIn, started)).authorizationUrl);
            expect(url.searchParams.get("client_id")).toBe("synthetic-google-client");
            return url;
          });
        const sent = (url: URL) => ({
          access_type: url.searchParams.getAll("access_type"),
          prompt: url.searchParams.getAll("prompt"),
        });

        const plain = yield* signIn({ authorizationUrl: google });
        expect(`${plain.origin}${plain.pathname}`).toBe(google);
        expect(sent(plain)).toEqual({ access_type: ["offline"], prompt: ["consent"] });

        expect(
          sent(
            yield* signIn({
              authorizationUrl: google,
              authorizationParams: { prompt: "select_account consent" },
            }),
          ),
        ).toEqual({ access_type: ["offline"], prompt: ["select_account consent"] });
        expect(sent(yield* signIn({ authorizationUrl: `${google}?access_type=online` }))).toEqual({
          access_type: ["online"],
          prompt: ["consent"],
        });

        expect(
          sent(
            yield* signIn({
              authorizationUrl: "https://accounts.google.com.example.test/o/oauth2/v2/auth",
              tokenUrl: "https://accounts.google.com.example.test/token",
            }),
          ),
        ).toEqual({ access_type: [], prompt: [] });
      }),
    ),
  );
});
