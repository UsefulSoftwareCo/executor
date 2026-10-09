/**
 * A connection stores the failure of its latest sign-in in the error vocabulary of the release
 * that recorded it. A later release that removed one of that failure's reasons must still read
 * the request and let it sign in again; only the failure it cannot read is left out.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { Api, body, type Session } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { Target } from "../support/platform.ts";
import { createProfile } from "../support/profiles.ts";
import { serverControl } from "../support/server-control.ts";
import { appsManifest } from "../support/apps-release.ts";
import { scenarios } from "../test-plan.ts";

const Published = Schema.Struct({ app: Schema.Struct({ id: Schema.String }) });
const Link = Schema.Struct({ connection: Schema.String, url: Schema.String });
const Connection = Schema.Struct({
  state: Schema.Struct({
    status: Schema.String,
    failure: Schema.optional(
      Schema.Struct({ error: Schema.Struct({ _tag: Schema.String, reason: Schema.String }) }),
    ),
  }),
});
const Redirect = Schema.Struct({
  status: Schema.Literal("redirect"),
  authorizationUrl: Schema.String,
});

layer(TestLive, { excludeTestServices: true })("Legacy connection failure", (it) => {
  it.effect(scenarios.legacyConnectionFailure.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target;
        const session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const agent: Session = {
          ...session,
          send: (method, path, data, extra = {}) => {
            const { origin: _origin, ...rest } = extra;
            return session.send(method, path, data, { ...rest, ...headers });
          },
        };
        // The service refuses Executor's callback, so the first sign-in fails and is recorded.
        const issuer = yield* oauthSetupIssuer;
        yield* issuer.configure({
          registrationStatus: 400,
          registrationError: "invalid_redirect_uri",
        });
        const deployed = yield* api.request(agent, "POST", "/v1/apps/deploy", {
          owner: "local",
          name: "Retired failure",
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, oauth2, router } from "apps";
const service=defineProvider({name:"Retired service",auth:{oauth:oauth2({discover:${JSON.stringify(`${issuer.origin}/mcp`)}})}});
export default defineApp({accounts:{service}},async()=>({tools:router({})}));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const { app } = yield* body(Published, deployed);
        yield* Effect.addFinalizer(() =>
          serverControl("start").pipe(
            Effect.andThen(api.request(agent, "DELETE", `/v1/apps/${app.id}`)),
            Effect.orDie,
          ),
        );
        const profile = yield* createProfile(agent, `/v1/apps/${app.id}`, {
          owner: "local",
          subject: "local",
        });
        const link = yield* body(
          Link,
          yield* api.request(agent, "POST", "/account-connect/api/requests", {
            owner: "local",
            target: { app: app.id, profile: profile.id, requirement: "service" },
          }),
        );
        const start = api.request(session, "POST", "/account-connect/api/oauth/start", {
          connection: link.connection,
          token: new URLSearchParams(new URL(link.url).hash.slice(1)).get("token"),
          method: "oauth",
        });
        const read = api.request(agent, "GET", `/v1/account-connections/${link.connection}`);
        const refused = yield* start;
        expect(refused.status, JSON.stringify(refused.body)).toBe(422);
        expect((yield* body(Connection, yield* read)).state).toMatchObject({
          status: "pending",
          failure: { error: { _tag: "OAuthSetupFailed", reason: "client_not_approved" } },
        });

        // An earlier release recorded the failure under a reason this release has since removed.
        yield* legacyStorage([
          {
            sql: `UPDATE executor_account_connections
              SET state = CAST(jsonb_set(CAST(state AS jsonb), '{failure,error,reason}', '"discovery_unavailable"') AS json)
              WHERE id = $1`,
            params: [link.connection],
          },
        ]);
        yield* serverControl("start");

        // The request still reads; only the failure this release cannot describe is left out.
        const upgraded = yield* read;
        expect(upgraded.status, JSON.stringify(upgraded.body)).toBe(200);
        expect((yield* body(Connection, upgraded)).state).toEqual({ status: "pending" });

        // The service now accepts Executor, and the request starts the sign-in that replaces it.
        yield* issuer.configure({ registrationStatus: 201 });
        const restarted = yield* start;
        expect(restarted.status, JSON.stringify(restarted.body)).toBe(200);
        yield* body(Redirect, restarted);
        // Starting it cleared the unreadable failure from the stored request.
        const [stored] = yield* legacyStorage([
          {
            sql: `SELECT state->>'status' AS status, state->'failure' IS NOT NULL AS failed
              FROM executor_account_connections WHERE id = $1`,
            params: [link.connection],
          },
        ]);
        expect(stored).toEqual([{ status: "pending", failed: false }]);
      }),
    ),
  );
});
