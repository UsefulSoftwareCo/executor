/** Account deletion revokes the provider grant through RFC 7009 without ever depending on it. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { createProfile } from "../support/profiles.ts";
import { oauthMcpAppFiles } from "../support/authored-templates.ts";
import { scenarios } from "../test-plan.ts";

const SignIn = Schema.Struct({ authorizationUrl: Schema.String });

layer(HostedLive, { excludeTestServices: true })("OAuth revocation", (it) => {
  it.effect(scenarios.oauthRevocation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry,
          http = yield* HttpClient.HttpClient;
        const issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        yield* issuer.configure({ refreshTokens: true, revocation: "recorded" });
        const name = `Revocation ${randomUUID().slice(0, 8)}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name,
          files: oauthMcpAppFiles(name, `${issuer.origin}/mcp`),
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(Resource, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );

        /** Connect one account through the real start, consent and callback boundaries. */
        const connect = (label: string) =>
          Effect.gen(function* () {
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
              { method: "oauth", label },
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
              `${prefix}/connections/${connection.id}/oauth/complete`,
              { callbackUrl },
            );
            expect(completed.status, JSON.stringify(completed.body)).toBe(200);
            return yield* body(Resource, completed);
          });

        /** Revocation runs after the response, so wait for the issuer to observe it. */
        const revocations = (count: number) =>
          issuer.metrics.pipe(
            Effect.map((metrics) => metrics.revocations),
            Effect.flatMap((calls) =>
              calls.length >= count
                ? Effect.succeed(calls)
                : Effect.fail(new Error("Revocation has not arrived")),
            ),
            Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
          );

        /** Delete through the public API and keep that request's trace ID. */
        const remove = (account: string) =>
          Effect.gen(function* () {
            expect(
              (yield* api.request(actors.owner, "GET", `${prefix}/accounts/${account}`)).status,
            ).toBe(200);
            const response = yield* api.request(
              actors.owner,
              "DELETE",
              `${prefix}/accounts/${account}`,
            );
            const trace = (yield* evidence.requests).at(-1)?.traceId;
            if (trace === undefined) return yield* Effect.die("Missing request trace");
            return { response, trace };
          });
        /** The delete request's delivered trace, once its revocation span has arrived. */
        const revocationTrace = (id: string) =>
          telemetry.query(id).pipe(
            Effect.flatMap((result) =>
              result.data.some(({ span }) => span.operationName === "oauth.revokeGrant")
                ? Effect.succeed(result)
                : Effect.fail(new Error("Revocation trace has not arrived")),
            ),
            Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
          );
        const assertPrivate = (value: unknown) => {
          const json = JSON.stringify(value);
          for (const secret of [
            // Issued refresh tokens are `synthetic-refresh-<uuid>`; renewed access tokens are
            // `synthetic-refreshed-token-<n>`.
            "synthetic-refresh",
            "synthetic-access-token",
            "synthetic-client-secret",
          ])
            expect(json).not.toContain(secret);
        };

        // A successful deletion revokes the refresh token with the grant's own client.
        const revoked = yield* connect("Revoked account");
        const deleted = yield* remove(revoked.id);
        expect(deleted.response.status, JSON.stringify(deleted.response.body)).toBe(200);
        // Hosted access checks refuse an account that no longer exists.
        expect(
          (yield* api.request(actors.owner, "GET", `${prefix}/accounts/${revoked.id}`)).status,
        ).toBe(403);
        expect(yield* revocations(1)).toEqual([
          { token: "refresh", hint: "refresh_token", clientAuthenticated: true },
        ]);
        const success = yield* revocationTrace(deleted.trace);
        expect(
          success.data.find(({ span }) => span.operationName === "oauth.revokeGrant")?.span.tags,
        ).toMatchObject({
          "oauth.revocation.outcome": "revoked",
          "oauth.revocation.token_type_hint": "refresh_token",
        });
        expect(
          success.data.find(({ span }) => span.operationName === "oauth.revoke")?.span.tags,
        ).toMatchObject({ "oauth.stage": "revoke" });
        assertPrivate(success);
        yield* evidence.json("revocation-trace.json", success);

        // A failing revocation endpoint never blocks or rolls back the deletion.
        yield* issuer.configure({ revocation: "failing" });
        const kept = yield* connect("Revocation fails");
        const removed = yield* remove(kept.id);
        expect(removed.response.status, JSON.stringify(removed.response.body)).toBe(200);
        expect(
          (yield* api.request(actors.owner, "GET", `${prefix}/accounts/${kept.id}`)).status,
        ).toBe(403);
        expect((yield* revocations(2))[1]).toEqual({
          token: "refresh",
          hint: "refresh_token",
          clientAuthenticated: true,
        });
        const failed = yield* revocationTrace(removed.trace);
        expect(
          failed.data.find(({ span }) => span.operationName === "oauth.revokeGrant")?.span.tags,
        ).toMatchObject({ "oauth.revocation.outcome": "failed" });
        expect(
          failed.data.find(({ span }) => span.operationName === "oauth.revoke")?.span.tags,
        ).toMatchObject({ "oauth.stage": "revoke", "http.response.status_code": "503" });
        assertPrivate(failed);
        yield* evidence.json("failed-revocation-trace.json", failed);
      }),
    ),
  );
});
