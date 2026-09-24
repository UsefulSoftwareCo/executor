/** Exercise the real registration, encrypted attempt, callback and account-save boundaries. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { createProfile, Profile } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";

const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const SetupFailure = Schema.Struct({
  _tag: Schema.Literal("OAuthSetupFailed"),
  reason: Schema.String,
  callbackUrl: Schema.optional(Schema.String),
});

layer(HostedLive, { excludeTestServices: true })("OAuth compatibility", (it) => {
  it.effect(scenarios.oauthCompatibility.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          http = yield* HttpClient.HttpClient;
        const issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const valid = {
          registrationStatus: 201,
          registrationError: "invalid_client_metadata",
          omitSecretExpiry: false,
          malformedRegistration: false,
          scopes: ["read"],
          includeIdToken: false,
          idTokenAlgorithms: ["ES256"],
          invalidNonce: false,
          setupFailure: undefined,
          completionFailure: undefined,
        } as const;
        const cases: ReadonlyArray<{
          readonly name: string;
          readonly registrationStatus: 200 | 201 | 400;
          readonly registrationError: "invalid_client_metadata" | "invalid_redirect_uri";
          readonly omitSecretExpiry: boolean;
          readonly malformedRegistration: boolean;
          readonly scopes: readonly string[];
          readonly includeIdToken: boolean;
          readonly idTokenAlgorithms: readonly string[];
          readonly invalidNonce: boolean;
          /** The 422 reason when setup must stop before sign-in. */
          readonly setupFailure: string | undefined;
          /** The 400 reason when completion must fail after the token exchange. */
          readonly completionFailure: string | undefined;
        }> = [
          { ...valid, name: "HTTP 200", registrationStatus: 200 },
          { ...valid, name: "Secret without expiry, HTTP 201", omitSecretExpiry: true },
          {
            ...valid,
            name: "Secret without expiry, HTTP 200",
            registrationStatus: 200,
            omitSecretExpiry: true,
          },
          { ...valid, name: "ES256 OIDC", scopes: ["openid", "read"], includeIdToken: true },
          // Executor does not use the ID token, so a service may omit it after `openid`.
          { ...valid, name: "OpenID without ID token", scopes: ["openid", "read"] },
          {
            ...valid,
            name: "Unadvertised algorithm",
            scopes: ["openid", "read"],
            includeIdToken: true,
            idTokenAlgorithms: ["RS256"],
            completionFailure: "incompatible_response",
          },
          {
            ...valid,
            name: "Wrong nonce",
            scopes: ["openid", "read"],
            includeIdToken: true,
            invalidNonce: true,
            completionFailure: "incompatible_response",
          },
          {
            ...valid,
            name: "Malformed HTTP 200",
            registrationStatus: 200,
            malformedRegistration: true,
            setupFailure: "incompatible_response",
          },
          {
            ...valid,
            name: "Rejected registration",
            registrationStatus: 400,
            setupFailure: "registration_rejected",
          },
          {
            ...valid,
            name: "Unapproved redirect URI",
            registrationStatus: 400,
            registrationError: "invalid_redirect_uri",
            setupFailure: "client_not_approved",
          },
        ];
        for (const scenario of cases) {
          yield* issuer.configure(scenario);
          const imported = yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
            source: {
              kind: "mcp",
              name: `${scenario.name} ${randomUUID().slice(0, 8)}`,
              url: `${issuer.origin}/mcp`,
              auth: { type: "auto" },
            },
          });
          expect(imported.status).toBe(200);
          const app = yield* body(Resource, imported);
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
          const started = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/oauth/start`,
            {
              method: "oauth",
              label: "Synthetic compatibility account",
            },
          );
          if (scenario.setupFailure !== undefined) {
            expect(started.status, scenario.name).toBe(422);
            const failure = yield* body(SetupFailure, started);
            expect(failure.reason, scenario.name).toBe(scenario.setupFailure);
            // Registration failures name Executor's callback so the user can request approval.
            expect(
              failure.callbackUrl === undefined ? undefined : new URL(failure.callbackUrl).pathname,
              scenario.name,
            ).toBe("/api/oauth/callback");
            expect(JSON.stringify(started.body)).not.toContain("PRIVATE_PROVIDER_ERROR");
            expect(JSON.stringify(started.body)).not.toContain("PRIVATE_QUERY");
            continue;
          }
          expect(started.status, scenario.name).toBe(200);
          const { authorizationUrl } = yield* body(SignIn, started);
          if (scenario.scopes.includes("openid"))
            expect(
              new URL(authorizationUrl).searchParams.get("nonce"),
              scenario.name,
            ).not.toBeNull();
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
          const tampered = new URL(callbackUrl);
          tampered.searchParams.set("state", "wrong-state");
          const exchanges = (yield* issuer.metrics).tokenExchanges;
          expect(
            (yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/oauth/complete`,
              {
                callbackUrl: tampered.href,
              },
            )).status,
          ).toBe(400);
          expect((yield* issuer.metrics).tokenExchanges).toBe(exchanges);
          const completed = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/oauth/complete`,
            { callbackUrl },
          );
          const failure = yield* body(
            Schema.Struct({
              _tag: Schema.optional(Schema.String),
              reason: Schema.optional(Schema.String),
            }),
            completed,
          );
          expect(
            completed.status,
            `${scenario.name}: ${JSON.stringify(failure)}, checks=${JSON.stringify((yield* issuer.metrics).tokenChecks)}`,
          ).toBe(scenario.completionFailure === undefined ? 200 : 400);
          if (scenario.completionFailure !== undefined)
            expect(failure, scenario.name).toMatchObject({
              _tag: "OAuthCompletionFailed",
              reason: scenario.completionFailure,
            });
          expect((yield* issuer.metrics).tokenExchanges).toBe(exchanges + 1);
          const selected = yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/apps/${app.id}/profiles/${profile.id}`,
          );
          if (scenario.completionFailure === undefined) {
            const account = yield* body(Resource, completed);
            yield* Effect.addFinalizer(() =>
              api
                .request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`)
                .pipe(Effect.orDie),
            );
            expect(selected.body).toMatchObject({ accounts: { service: [account.id] } });
            expect(
              (yield* api.request(actors.owner, "GET", `${prefix}/connections/${connection.id}`))
                .body,
            ).toMatchObject({ state: { status: "completed", account: { id: account.id } } });
          } else {
            expect((yield* body(Profile, selected)).accounts).toEqual(profile.accounts);
            expect(
              (yield* api.request(actors.owner, "GET", `${prefix}/connections/${connection.id}`))
                .body,
            ).toMatchObject({ state: { status: "pending" } });
          }
        }
      }),
    ),
  );
});
