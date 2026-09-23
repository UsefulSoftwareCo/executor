/** Assertions read spans delivered to the collector, not internal instrumentation hooks. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { createProfile } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Setup diagnostics", (it) => {
  it.effect(scenarios.setupDiagnostics.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry;
        const issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const trace = (path: string) =>
          Effect.gen(function* () {
            const id = (yield* evidence.requests).at(-1)?.traceId;
            if (id === undefined) return yield* Effect.die("Missing request trace");
            return yield* telemetry.query(id).pipe(
              Effect.flatMap((result) =>
                result.data.some(
                  ({ span }) =>
                    span.operationName === "http.server POST" &&
                    span.tags["url.path"]?.endsWith(path),
                )
                  ? Effect.succeed(result)
                  : Effect.fail(new Error("Request trace has not arrived")),
              ),
              Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
            );
          });
        const assertPrivate = (value: unknown) => {
          const json = JSON.stringify(value);
          for (const marker of [
            "PRIVATE_SPEC_CONTENT",
            "PRIVATE_QUERY",
            "PRIVATE_PROVIDER_ERROR",
            "synthetic-client-secret",
          ])
            expect(json).not.toContain(marker);
        };
        const rejected = yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
          source: {
            kind: "openapi",
            name: `Diagnostic ${randomUUID().slice(0, 8)}`,
            url: `${issuer.origin}/invalid-openapi`,
          },
        });
        expect(rejected.status).toBe(422);
        const imported = yield* trace("/apps/import");
        expect(
          imported.data.find(({ span }) => span.operationName === "catalog.generate")?.span.tags,
        ).toMatchObject({ "catalog.stage": "generate", "catalog.error.reason": "openapi_version" });
        expect(
          imported.data.find(({ span }) => span.operationName === "catalog.document")?.span.tags,
        ).toMatchObject({ "http.response.status_code": "200" });
        assertPrivate(imported);
        yield* evidence.json("catalog-diagnostics.json", imported);

        const app = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
            source: {
              kind: "mcp",
              name: `OAuth diagnostics ${randomUUID().slice(0, 8)}`,
              url: `${issuer.origin}/mcp`,
              auth: { type: "auto" },
            },
          }),
        );
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
        for (const status of [400, 201] as const) {
          yield* issuer.configure({
            registrationStatus: status,
            malformedRegistration: status === 201,
          });
          const response = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/oauth/start`,
            {
              method: "oauth",
              label: "Synthetic diagnostic account",
            },
          );
          expect(response.status).toBe(422);
          const failed = yield* trace("/oauth/start");
          expect(
            failed.data.find(({ span }) => span.operationName === "oauth.register")?.span.tags,
          ).toMatchObject({
            "oauth.stage": "register",
            "oauth.error.code":
              status === 400 ? "OAUTH_RESPONSE_BODY_ERROR" : "OAUTH_INVALID_RESPONSE",
            ...(status === 400
              ? { "oauth.error.provider_code": "invalid_client_metadata" }
              : { "oauth.error.field": "client_id" }),
          });
          expect(
            failed.data.some(
              ({ span }) =>
                span.operationName === "oauth.request" &&
                span.tags["http.response.status_code"] === String(status),
            ),
          ).toBe(true);
          assertPrivate(failed);
          assertPrivate(response.body);
          yield* evidence.json(`oauth-${status}-diagnostics.json`, failed);
        }
      }),
    ),
  );
});
