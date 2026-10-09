/**
 * The desktop app quits or crashes mid-renewal and starts again much later. The dashboard must
 * not ask for a new sign-in while the saved refresh token can still recover the grant.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, Fiber, Redacted, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { Target } from "../support/platform.ts";
import { createProfile } from "../support/profiles.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const Published = Schema.Struct({ app: Schema.Struct({ id: Schema.String }) });
const Link = Schema.Struct({ connection: Schema.String, url: Schema.String });
const Redirect = Schema.Struct({
  status: Schema.Literal("redirect"),
  authorizationUrl: Schema.String,
});
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  value: Schema.Struct({
    service: Schema.Struct({
      refreshed: Schema.Boolean,
      authorization: Schema.NullOr(Schema.String),
    }),
  }),
});
const Detail = Schema.Struct({
  account: Schema.Struct({ signIn: Schema.Struct({ state: Schema.String }) }),
});
/** Longer than the dashboard previously trusted an unsettled renewal. */
const restartedLater = 61_000;

layer(TestLive, { excludeTestServices: true })("Local OAuth renewal interruption", (it) => {
  it.effect(scenarios.localOAuthRenewalInterrupted.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          http = yield* HttpClient.HttpClient,
          session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const agent: Session = {
          ...session,
          send: (method, path, data, extra = {}) => {
            const { origin: _origin, ...rest } = extra;
            return session.send(method, path, data, { ...rest, ...headers });
          },
        };
        const issuer = yield* oauthSetupIssuer;
        yield* issuer.configure({
          refreshTokens: true,
          rotateRefreshTokens: true,
          replacedRefreshTokens: "refused",
          expiresIn: 20,
        });
        const name = `Rotating ${randomUUID().slice(0, 8)}`;
        const deployed = yield* api.request(agent, "POST", "/v1/apps/deploy", {
          owner: "local",
          name,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, oauth2, query, object, router } from "apps";
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: { oauth: oauth2({ discover: ${JSON.stringify(`${issuer.origin}/mcp`)} }) } });
export default defineApp({ accounts: { service } }, async ({ accounts }) => ({
  tools: router({
    read: query({ input: object({}) }, async ({ fetch }) => ({ service: await (await fetch(${JSON.stringify(`${issuer.origin}/resource`)}, { headers: { authorization: "Bearer " + accounts.service.fields.access_token } })).json() })),
  }),
}));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const { app } = yield* body(Published, deployed);
        let account: string | undefined;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(agent, "DELETE", `/v1/apps/${app.id}`);
            if (account !== undefined)
              yield* api.request(agent, "DELETE", `/v1/accounts/${account}`);
          }).pipe(Effect.orDie),
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
        const grant = {
          connection: link.connection,
          token: new URLSearchParams(new URL(link.url).hash.slice(1)).get("token"),
        };
        const started = yield* api.request(session, "POST", "/account-connect/api/oauth/start", {
          ...grant,
          method: "oauth",
          label: "Synthetic rotating account",
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        // The local callback is a loopback redirect, which registers as a native client.
        expect((yield* issuer.metrics).lastRegistration?.applicationType).toBe("native");
        const { authorizationUrl } = yield* body(Redirect, started);
        const callbackUrl = yield* Effect.scoped(
          Effect.gen(function* () {
            const consent = yield* HttpClient.withScope(http).get(authorizationUrl);
            expect(consent.status).toBe(302);
            const location = consent.headers.location;
            if (location === undefined)
              return yield* Effect.die("Issuer did not return a callback");
            return location;
          }),
        ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
        const completed = yield* api.request(
          session,
          "POST",
          "/account-connect/api/oauth/complete",
          { ...grant, callbackUrl },
        );
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        account = (yield* body(Resource, completed)).id;
        const accountPath = `/dashboard/api/accounts/${account}`;
        const signIn = api
          .request(agent, "GET", accountPath)
          .pipe(Effect.flatMap((response) => body(Detail, response)));

        const read = api.request(agent, "POST", "/v1/tools/call", {
          app: app.id,
          profile: profile.id,
          tool: "read",
          input: {},
        });
        const renewed = (response: { readonly status: number; readonly body: unknown }) =>
          Effect.gen(function* () {
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const result = yield* body(Completed, response);
            expect(result.value.service.refreshed).toBe(true);
            return result.value.service.authorization;
          });
        yield* renewed(yield* read);

        // The desktop app stops before the service processes a renewal it started while the
        // dashboard read the app's workflows.
        yield* issuer.configure({ hold: "refresh-unprocessed" });
        const before = yield* issuer.metrics;
        const interrupted = yield* Effect.forkChild(
          api
            .request(agent, "GET", `/v1/apps/${app.id}/workflows?profile=${profile.id}`)
            .pipe(Effect.exit),
        );
        yield* issuer.metrics.pipe(
          Effect.flatMap((current) =>
            current.held > before.held
              ? Effect.void
              : Effect.fail(new Error("The renewal has not reached the service")),
          ),
          Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 400 }),
        );
        yield* serverControl("kill");
        expect(Exit.isFailure(yield* Fiber.join(interrupted))).toBe(true);
        yield* issuer.configure({ hold: null });
        yield* issuer.release;
        // It is opened again a minute later.
        yield* serverControl("clock/advance", 200, { milliseconds: restartedLater });
        yield* serverControl("start");

        // The saved refresh token was never presented, so the account needs no new sign-in.
        expect((yield* signIn).account.signIn.state).toBe("saved");
        // The first renewal after the restart takes over the abandoned claim and renews from the
        // saved refresh token. Tokens this short-lived also renew on later use.
        yield* renewed(yield* read);
        expect((yield* issuer.metrics).refreshesIssued).toBeGreaterThan(before.refreshesIssued);
        expect((yield* signIn).account.signIn.state).toBe("saved");
      }),
    ),
  );
});
