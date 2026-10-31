/** A pending connection keeps working when the person chooses another sign-in method. */
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import {
  interactiveAccountBackend,
  interactiveAccountSource,
  interactiveBackendKey,
} from "../support/interactive-account-backend.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Resume interactive accounts", (it) => {
  it.effect(scenarios.interactiveAccountResume.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const backend = yield* interactiveAccountBackend,
          issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Resumed sign-in ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: interactiveAccountSource(
                backend.origin,
                false,
                false,
                undefined,
                issuer.origin,
              ),
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(Resource, deployed),
          path = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.asVoid, Effect.orDie),
        );
        const pending = (scope = "user", slot = "identity") =>
          api
            .request(actors.owner, "POST", `${path}/accounts/${scope}/${slot}/connections`, {})
            .pipe(Effect.flatMap((r) => body(Resource, r)));
        const cp = (id: string) => `${prefix}/connections/${id}`;
        const start = (id: string, method: string) =>
          api.request(actors.owner, "POST", `${cp(id)}/interactive/start`, { method });
        const key = yield* pending("app", "backend");
        expect(
          (yield* api.request(actors.owner, "POST", `${cp(key.id)}/submit`, {
            method: "key",
            fields: { token: interactiveBackendKey },
          })).status,
        ).toBe(200);
        for (const [oldMethod, nextMethod] of [
          ["failure", "failure"],
          ["expired", "expired"],
          ["device", "paste"],
        ] as const) {
          const connection = yield* pending();
          const previous = yield* start(connection.id, oldMethod);
          expect(previous.status).toBe(200);
          if (oldMethod === "failure") {
            expect(
              (yield* api.request(actors.owner, "GET", `${cp(connection.id)}/interactive/status`))
                .body,
            ).toMatchObject({ state: "failed" });
            // Cancellation failure is advisory and must not prevent a new attempt.
            yield* backend.refuseCancellation(true);
          }
          const before = (yield* backend.calls).filter((c) => c.step === "cancel").length;
          const restarted = yield* start(connection.id, nextMethod);
          expect(restarted.status, JSON.stringify(restarted.body)).toBe(200);
          expect(restarted.body).not.toEqual(previous.body);
          expect((yield* backend.calls).filter((c) => c.step === "cancel")).toHaveLength(
            before + 1,
          );
          expect((yield* api.request(actors.owner, "GET", cp(connection.id))).body).toMatchObject({
            state: { status: "pending" },
          });
          expect(JSON.stringify(restarted.body)).not.toContain("private-session-");
          yield* backend.refuseCancellation(false);
          expect(
            (yield* api.request(actors.owner, "POST", `${cp(connection.id)}/interactive/cancel`))
              .status,
          ).toBe(200);
          expect((yield* api.request(actors.owner, "GET", cp(connection.id))).body).toMatchObject({
            state: { status: "cancelled" },
          });
        }
        // Switching methods invalidates an in-flight poll without letting its result overwrite the new attempt.
        const polling = yield* pending();
        expect((yield* start(polling.id, "device")).status).toBe(200);
        const held = yield* backend.holdStatus;
        yield* Effect.addFinalizer(() => held.release);
        const status = yield* Effect.forkChild(
          api.request(actors.owner, "GET", `${cp(polling.id)}/interactive/status`),
        );
        yield* held.started;
        expect((yield* start(polling.id, "paste")).status).toBe(200);
        yield* held.release;
        expect((yield* Fiber.join(status)).status).toBe(422);
        expect(
          (yield* api.request(actors.owner, "POST", `${cp(polling.id)}/interactive/cancel`)).status,
        ).toBe(200);
        const secrets = yield* pending();
        expect((yield* start(secrets.id, "device")).status).toBe(200);
        const beforeSecrets = (yield* backend.calls).filter((c) => c.step === "cancel").length;
        const submitted = yield* api.request(actors.owner, "POST", `${cp(secrets.id)}/submit`, {
          method: "manual",
          fields: { token: "synthetic-manual-key" },
        });
        expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
        expect(submitted.body).toMatchObject({ method: "manual" });
        expect((yield* api.request(actors.owner, "GET", cp(secrets.id))).body).toMatchObject({
          state: { status: "completed" },
        });
        expect((yield* backend.calls).filter((c) => c.step === "cancel")).toHaveLength(
          beforeSecrets + 1,
        );
        const oauth = yield* pending();
        expect((yield* start(oauth.id, "device")).status).toBe(200);
        const beforeOAuth = (yield* backend.calls).filter((c) => c.step === "cancel").length;
        const redirected = yield* api.request(actors.owner, "POST", `${cp(oauth.id)}/oauth/start`, {
          method: "browser",
        });
        expect(redirected.status, JSON.stringify(redirected.body)).toBe(200);
        const redirect = yield* body(
          Schema.Struct({ status: Schema.Literal("redirect"), authorizationUrl: Schema.String }),
          redirected,
        );
        expect(new URL(redirect.authorizationUrl).origin).toBe(issuer.origin);
        expect((yield* backend.calls).filter((c) => c.step === "cancel")).toHaveLength(
          beforeOAuth + 1,
        );
        expect((yield* api.request(actors.owner, "GET", cp(oauth.id))).body).toMatchObject({
          state: { status: "pending" },
        });
      }),
    ),
  );
});
