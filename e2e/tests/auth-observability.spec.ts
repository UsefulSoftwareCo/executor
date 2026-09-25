import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Redacted, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Browser } from "../support/browser.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { HttpClient } from "effect/unstable/http";
import { Collector } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { Onboarding } from "../support/onboarding.ts";

const Logs = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      body: Schema.String,
      traceId: Schema.NullOr(Schema.String),
      spanId: Schema.NullOr(Schema.String),
      attributes: Schema.Record(Schema.String, Schema.String),
    }),
  ),
  meta: Schema.Struct({ truncated: Schema.Boolean }),
});

layer(TestLive, { excludeTestServices: true })("Auth observability", (it) => {
  it.effect(scenarios.authObservability.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const onboarding = yield* Onboarding;
        const telemetry = yield* Telemetry;
        const evidence = yield* Evidence;
        const fs = yield* FileSystem.FileSystem;
        const http = yield* HttpClient.HttpClient;
        const target = yield* Target;
        const collector = yield* fs
          .readFileString(`${target.directory}/data/diagnostics/collector.json`)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Collector))));
        yield* browser.omitNetworkTrace;
        for (const fixture of [
          { kind: "redirect", code: "none", stage: "callback_validation" },
          { kind: "missing_state", code: "state_not_found", stage: "callback_validation" },
          { kind: "cancel", code: "access_denied", stage: "callback_validation" },
          { kind: "unknown", code: "unrecognized_error", stage: "callback_validation" },
          { kind: "invalid_code", code: "invalid_code", stage: "token_exchange" },
          { kind: "profile_failure", code: "unable_to_get_user_info", stage: "user_info" },
          { kind: "success", code: "none", stage: "account_session" },
        ] as const) {
          const provider = fixture.kind === "invalid_code" ? "google" : "github";
          const traceId = randomUUID().replaceAll("-", "");
          if (fixture.kind === "success") {
            yield* browser.use("Correlate the browser OAuth return", (page) =>
              page
                .context()
                .setExtraHTTPHeaders({ traceparent: `00-${traceId}-1234567890abcdef-01` }),
            );
            yield* onboarding.socialSignIn("github");
            yield* browser.use("Clear trace headers", (page) =>
              page.context().setExtraHTTPHeaders({}),
            );
          } else if (fixture.kind === "redirect") {
            const status = yield* browser.use(
              "A POST callback only redirects to the GET callback",
              (page) =>
                page.request
                  .post(`${target.metadata.origin}/api/auth/callback/github`, {
                    maxRedirects: 0,
                    form: { state: "private-oauth-state", code: "private-invalid-code" },
                    headers: {
                      origin: target.metadata.origin,
                      traceparent: `00-${traceId}-1234567890abcdef-01`,
                    },
                  })
                  .then((response) => response.status()),
            );
            expect(status).toBe(302);
          } else {
            const started = yield* browser
              .use("Start OAuth through the public endpoint", (page) =>
                page.request
                  .post(`${target.metadata.origin}/api/auth/sign-in/social`, {
                    headers: { origin: target.metadata.origin },
                    data: { provider, callbackURL: "/login", errorCallbackURL: "/login" },
                  })
                  .then((response) =>
                    response.json().then((body: unknown) => ({ status: response.status(), body })),
                  ),
              )
              .pipe(
                Effect.flatMap((response) =>
                  response.status === 429
                    ? Effect.fail(new Error("Sign-in rate limit"))
                    : Effect.succeed(response),
                ),
                Effect.retry({
                  while: (error) => error.message === "Sign-in rate limit",
                  schedule: Schedule.spaced("10 seconds"),
                  times: 2,
                }),
              );
            expect(started.status).toBe(200);
            const authorization = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ url: Schema.RedactedFromValue(Schema.String) }),
            )(started.body);
            const status = yield* browser.use("Send a controlled provider callback", (page) => {
              const authorizationUrl = new URL(Redacted.value(authorization.url));
              const redirect = authorizationUrl.searchParams.get("redirect_uri");
              const state = authorizationUrl.searchParams.get("state");
              if (redirect === null || state === null)
                throw new Error("OAuth start did not return a callback and state");
              const callback = new URL(redirect);
              if (fixture.kind !== "missing_state") callback.searchParams.set("state", state);
              callback.searchParams.set("code", "private-invalid-code");
              callback.searchParams.set("error_description", "private-oauth-description");
              if (fixture.kind === "cancel") callback.searchParams.set("error", "access_denied");
              if (fixture.kind === "unknown")
                callback.searchParams.set("error", "private-provider-error");
              return page.request
                .get(callback.href, {
                  maxRedirects: 0,
                  headers: { traceparent: `00-${traceId}-1234567890abcdef-01` },
                })
                .then((response) => response.status());
            });
            expect(status).toBe(302);
          }
          const trace = yield* telemetry.query(traceId).pipe(
            Effect.flatMap((trace) =>
              trace.data.some(({ span }) => span.operationName === "auth.oauth.callback")
                ? Effect.succeed(trace)
                : Effect.fail(new Error("Missing auth callback telemetry")),
            ),
            Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 60 }),
          );
          const callback = trace.data.find(
            ({ span }) => span.operationName === "auth.oauth.callback",
          )?.span;
          expect(callback).toMatchObject({
            status: fixture.code === "none" ? "ok" : "error",
            tags: {
              "auth.provider": provider,
              "auth.outcome":
                fixture.kind === "success"
                  ? "success"
                  : fixture.kind === "redirect"
                    ? "unconfirmed"
                    : "failure",
              "auth.error_code": fixture.code,
              "auth.stage": fixture.stage,
              "auth.session_created": String(fixture.kind === "success"),
              "http.response.status_code": "302",
            },
          });
          const request = trace.data.find(
            ({ span }) => span.spanId === callback?.parentSpanId,
          )?.span;
          expect(request).toMatchObject({
            status: fixture.code === "none" ? "ok" : "error",
            tags: { "http.response.status_code": "302", "auth.error_code": fixture.code },
          });
          if (
            fixture.kind === "success" ||
            fixture.kind === "invalid_code" ||
            fixture.kind === "profile_failure"
          ) {
            const token = trace.data.find(
              ({ span }) => span.operationName === "auth.oauth.token_exchange",
            )?.span;
            expect(token?.status).toBe(fixture.kind === "invalid_code" ? "error" : "ok");
            expect(token?.parentSpanId).toBe(callback?.spanId);
            expect(token?.durationMs).toBeGreaterThanOrEqual(0);
            if (fixture.kind !== "invalid_code")
              expect(
                trace.data.some(
                  ({ span }) =>
                    span.operationName === "auth.oauth.user_info" &&
                    span.status === (fixture.kind === "success" ? "ok" : "error"),
                ),
              ).toBe(true);
          }
          const logs = yield* http.get(`${collector.url}/api/traces/${traceId}/logs`).pipe(
            Effect.flatMap((response) => response.json),
            Effect.flatMap(Schema.decodeUnknownEffect(Logs)),
            Effect.flatMap((logs) =>
              logs.data.some((log) => log.body === "auth.oauth.callback.completed")
                ? Effect.succeed(logs)
                : Effect.fail(new Error("Missing callback outcome log")),
            ),
            Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
          );
          expect(logs.meta.truncated).toBe(false);
          const outcomes = logs.data.filter((log) => log.body === "auth.oauth.callback.completed");
          expect(outcomes).toHaveLength(1);
          expect(outcomes[0]).toMatchObject({
            traceId,
            spanId: callback?.spanId,
            attributes: { "auth.error_code": fixture.code, "auth.provider": provider },
          });
          const serialized = JSON.stringify({ trace, logs });
          for (const marker of [
            "private-oauth-state",
            "private-oauth-description",
            "private-provider-error",
            "private-invalid-code",
          ])
            expect(serialized).not.toContain(marker);
          expect(serialized).not.toContain("url.query");
          expect(serialized).not.toContain("header.location");
          yield* evidence.json(`${fixture.kind}-trace.json`, { trace, logs });
        }
      }).pipe(Effect.provide(Onboarding.layer)),
    ),
  );
});
