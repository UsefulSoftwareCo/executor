/** Account cache scopes survive token renewal and start empty after a reconnect. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { createProfile } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const App = Schema.Struct({ id: Schema.String });
const SetupStatus = Schema.Struct({ status: Schema.String });
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const Cached = Schema.Struct({ value: Schema.String, tokenChecked: Schema.Boolean });

layer(HostedLive, { excludeTestServices: true })("OAuth cache scope", (it) => {
  it.effect(scenarios.oauthCacheScope.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          http = yield* HttpClient.HttpClient;
        const issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        // Tokens issued inside the host's 30-second renewal window renew on the next use.
        yield* issuer.configure({ refreshTokens: true, expiresIn: 20 });
        const name = `Cache scope ${randomUUID().slice(0, 8)}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, oauth2, query, object, string, router } from "apps";
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: { oauth: oauth2({ discover: ${JSON.stringify(`${issuer.origin}/mcp`)} }) } });
export default defineApp({ accounts: { service } }, async ({ accounts, cache }) => ({
  tools: router({
    cached: query({ input: object({}) }, async ({ fetch }) => {
      // Present the current token so every call exercises the renewal the host performed.
      const checked = await fetch(${JSON.stringify(`${issuer.origin}/resource`)}, { headers: { authorization: "Bearer " + accounts.service.fields.access_token } });
      const value = await cache.forAccount(accounts.service).get({ key: "catalog", schema: string(), freshFor: "1 hour", load: async () => crypto.randomUUID() });
      return { value, tokenChecked: checked.ok };
    }),
  }),
}));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );

        /** Complete the issuer's sign-in for a connection and return the saved account. */
        const signIn = (connection: string) =>
          Effect.gen(function* () {
            const started = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection}/oauth/start`,
              { method: "oauth", label: "Synthetic cache scope" },
            );
            expect(started.status, JSON.stringify(started.body)).toBe(200);
            const { authorizationUrl } = yield* body(SignIn, started);
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
              actors.owner,
              "POST",
              `${prefix}/connections/${connection}/oauth/complete`,
              { callbackUrl },
            );
            expect(completed.status, JSON.stringify(completed.body)).toBe(200);
            return yield* body(Resource, completed);
          });

        const profile = yield* createProfile(actors.owner, `${prefix}/apps/${app.id}`);
        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
            requirement: "service",
            profile: profile.id,
          }),
        );
        const account = yield* signIn(connection.id);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`)
            .pipe(Effect.orDie),
        );
        // Background profile setup resolves the account; let it finish before counting renewals.
        yield* api
          .request(actors.owner, "GET", `${prefix}/apps/${app.id}/profiles/${profile.id}`)
          .pipe(
            Effect.flatMap((response) => body(SetupStatus, response)),
            Effect.flatMap((current) =>
              current.status !== "pending"
                ? Effect.void
                : Effect.fail(new Error("Profile setup has not finished")),
            ),
            Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
          );

        const refreshes = issuer.metrics.pipe(Effect.map((metrics) => metrics.refreshes));
        const call = Effect.gen(function* () {
          const response = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/apps/${app.id}/tools/call`,
            { profile: profile.id, tool: "cached", input: {} },
          );
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          const result = yield* body(Cached, response);
          expect(result.tokenChecked).toBe(true);
          return result.value;
        });

        const before = yield* refreshes;
        const first = yield* call;
        const renewedOnce = yield* refreshes;
        expect(renewedOnce).toBeGreaterThan(before);

        // Each call renews the short-lived token. The account's cached value stays.
        expect(yield* call).toBe(first);
        expect(yield* call).toBe(first);
        expect(yield* refreshes).toBeGreaterThan(renewedOnce);

        // Reconnecting may sign in as someone else upstream, so the account starts a new scope.
        const reconnect = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
            requirement: "service",
            profile: profile.id,
            account: account.id,
          }),
        );
        expect((yield* signIn(reconnect.id)).id).toBe(account.id);
        const afterReconnect = yield* call;
        expect(afterReconnect).not.toBe(first);
        expect(yield* call).toBe(afterReconnect);
      }),
    ),
  );
});
