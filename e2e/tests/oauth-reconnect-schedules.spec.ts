/** A schedule whose account must reconnect waits for it, instead of failing every occurrence. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { createProfile } from "../support/profiles.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const AppProvider = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const SetupStatus = Schema.Struct({ status: Schema.String });
const Settings = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    enabled: Schema.Boolean,
    nextAt: Schema.NullOr(Schema.String),
    activeRun: Schema.NullOr(Schema.String),
    revision: Schema.String,
    reconnectAccount: Schema.optional(Schema.String),
  }),
);
const Runs = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    status: Schema.String,
    failure: Schema.NullOr(Schema.String),
  }),
);
const Failure = Schema.Struct({ _tag: Schema.String });
/** More than the schedule's one-minute interval, so each restart makes it due once. */
const occurrence = 61_000;

layer(HostedLive, { excludeTestServices: true })("OAuth reconnect schedules", (it) => {
  it.effect(
    scenarios.oauthReconnectSchedules.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            browser = yield* Browser,
            evidence = yield* Evidence,
            telemetry = yield* Telemetry,
            http = yield* HttpClient.HttpClient;
          const issuer = yield* oauthSetupIssuer;
          const prefix = `/api/organizations/${actors.organization.id}`;
          // Tokens issued inside the host's renewal window renew on every use.
          yield* issuer.configure({ refreshTokens: true, expiresIn: 20 });
          const name = `Reconnect schedule ${randomUUID().slice(0, 8)}`;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name,
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, defineProvider, oauth2, mutation, object, interval, router, type MutationContext } from "apps";
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: { oauth: oauth2({ discover: ${JSON.stringify(`${issuer.origin}/mcp`)} }) } });
const requirements = { accounts: { service } };
const work = mutation({ input: object({}) }, async (ctx: MutationContext<typeof requirements>) => {
  const response = await ctx.fetch(${JSON.stringify(`${issuer.origin}/resource`)}, { method: "POST", headers: { authorization: "Bearer " + ctx.accounts.service.fields.access_token } });
  return await response.json();
});
export default defineApp(requirements, async () => ({
  tools: router({ work }),
  schedules: { work: interval({ minutes: 1 }, work, {}) },
}));`,
              },
              appsManifest,
            ],
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const app = yield* body(AppProvider, deployed);
          const provider = app.requirements.accounts.service.provider;
          const path = `${prefix}/apps/${app.id}`;
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
          );
          const profile = yield* createProfile(actors.owner, path);

          /**
           * Delivered spans of one operation whose status or outcome is known, each with the
           * delivered spans above it up to its trace's root. A request's root is the test client's
           * span, which is exported when the case ends. The dispatcher's checks run in the
           * background, outside any request, so their whole trace is the product's own; wait until
           * one such check arrives with its root.
           */
          const background = (
            path: ReadonlyArray<{ operationName: string; parentSpanId: string | null }>,
          ) =>
            path.at(-1)?.parentSpanId === null &&
            !/^(GET|POST|PUT|PATCH|DELETE) /.test(path.at(-1)?.operationName ?? "");
          /** Every background check runs in a dispatcher pass, as Cloud's coordinator runs it. */
          const expectDispatchRoots = (
            found: ReadonlyArray<{
              path: ReadonlyArray<{ operationName: string; parentSpanId: string | null }>;
            }>,
          ) =>
            expect(
              found
                .filter(({ path }) => background(path))
                .map(({ path }) => path.at(-1)?.operationName),
              "A background check's trace is rooted in its dispatcher pass",
            ).toEqual(found.filter(({ path }) => background(path)).map(() => "schedule.dispatch"));
          const dispatcherChecks = (
            operation: string,
            attributes: Record<string, string>,
            outcome: string,
          ) =>
            telemetry.search(operation, attributes).pipe(
              Effect.map((found) =>
                found.data.filter(
                  ({ span }) => span.status === "error" || span.tags[outcome] !== undefined,
                ),
              ),
              Effect.flatMap((found) =>
                Effect.forEach(found, (check) =>
                  telemetry.query(check.traceId).pipe(
                    Effect.map((trace) => {
                      const byId = new Map(
                        trace.data
                          .filter(({ span }) => !span.operationName.startsWith("[missing parent"))
                          .map(({ span }) => [span.spanId, span]),
                      );
                      const path = [];
                      for (
                        let span = byId.get(check.span.spanId);
                        span !== undefined;
                        span = span.parentSpanId === null ? undefined : byId.get(span.parentSpanId)
                      )
                        path.push(span);
                      return { check, path };
                    }),
                  ),
                ),
              ),
              Effect.flatMap((found) =>
                found.some(({ path }) => background(path))
                  ? Effect.succeed(found)
                  : Effect.fail(new Error(`The dispatcher's ${operation} check has not arrived`)),
              ),
              Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
            );

          // Before its account is selected, the profile's setup fails on its accounts and waits.
          // Each retry first checks the profile's accounts; a required account that is not
          // selected yet is an expected state the owner resolves, recorded as the check's outcome:
          // neither the check nor any span above it is an error.
          yield* api.request(actors.owner, "GET", `${path}/profiles/${profile.id}`).pipe(
            Effect.flatMap((response) => body(SetupStatus, response)),
            Effect.flatMap((current) =>
              current.status === "needs-setup"
                ? Effect.void
                : Effect.fail(new Error(`Profile setup is ${current.status}`)),
            ),
            Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
          );
          // Setup retries 30 seconds after it failed.
          yield* serverControl("stop");
          yield* serverControl("clock/advance", 200, { milliseconds: 31_000 });
          yield* serverControl("start");
          const unselected = yield* dispatcherChecks(
            "sdk.accounts.reconnectRequired",
            { "executor.app.id": app.id, "executor.profile.id": profile.id },
            "executor.accounts.outcome",
          );
          for (const { check, path } of unselected) {
            expect(
              check.span.status,
              "A required account that is not selected yet is not a failed check",
            ).not.toBe("error");
            expect(check.span.tags).toMatchObject({
              "executor.app.id": app.id,
              "executor.profile.id": profile.id,
              "executor.accounts.outcome": "account_required",
            });
            expect(
              path.filter((span) => span.status === "error").map((span) => span.operationName),
              "No span above the check marks the missing account as an error",
            ).toEqual([]);
          }
          expectDispatchRoots(unselected);
          yield* evidence.json(
            "account-required-checks.json",
            unselected.map(({ path }) => path),
          );

          /** Complete the issuer's consent for a connection, creating or reconnecting the account. */
          const signIn = (connection: string) =>
            Effect.gen(function* () {
              const started = yield* api.request(
                actors.owner,
                "POST",
                `${prefix}/connections/${connection}/oauth/start`,
                { method: "oauth", label: "Synthetic scheduled account" },
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
          const connection = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${path}/connections`, {
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
          yield* api.request(actors.owner, "GET", `${path}/profiles/${profile.id}`).pipe(
            Effect.flatMap((response) => body(SetupStatus, response)),
            Effect.flatMap((current) =>
              current.status === "ready"
                ? Effect.void
                : Effect.fail(new Error(`Profile setup is ${current.status}`)),
            ),
            Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
          );

          const settings = api
            .request(actors.owner, "GET", `${path}/schedules?profile=${profile.id}`)
            .pipe(
              Effect.flatMap((response) => body(Settings, response)),
              Effect.map((rows) => rows.find((row) => row.name === "work")),
            );
          const runs = api
            .request(actors.owner, "GET", `${prefix}/scheduled-runs?app=${app.id}`)
            .pipe(Effect.flatMap((response) => body(Runs, response)));
          /** Wait until the scheduler records a run with this outcome. */
          const runWith = (status: string, count: number) =>
            runs.pipe(
              Effect.flatMap((rows) =>
                rows.filter((row) => row.status === status).length >= count
                  ? Effect.succeed(rows)
                  : Effect.fail(new Error(`No ${status} run yet: ${JSON.stringify(rows)}`)),
              ),
              Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
            );
          /** Let one occurrence fall due while the product is stopped, then start it again. */
          const nextOccurrence = Effect.gen(function* () {
            yield* serverControl("stop");
            yield* serverControl("clock/advance", 200, { milliseconds: occurrence });
            yield* serverControl("start");
          });

          const enabled = yield* api.request(actors.owner, "PATCH", `${path}/schedules/work`, {
            profile: profile.id,
            enabled: true,
          });
          expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
          const started = yield* api.request(
            actors.owner,
            "POST",
            `${path}/schedules/work/run?profile=${profile.id}`,
          );
          expect(started.status, JSON.stringify(started.body)).toBe(200);
          yield* runWith("succeeded", 1);

          // The service ends the grant; the next use of the account marks it for reconnecting.
          yield* issuer.configure({
            tokenError: { status: 400, body: { error: "invalid_grant" } },
          });
          const ended = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
            profile: profile.id,
            tool: "work",
            kind: "mutation",
            input: {},
          });
          expect(ended.status, JSON.stringify(ended.body)).toBe(409);
          expect((yield* body(Failure, ended))._tag).toBe("OAuthReconnectRequired");
          yield* issuer.configure({ tokenError: null });
          const refreshes = (yield* issuer.metrics).refreshes;
          const posts = (yield* issuer.metrics).resourceRequests.POST;
          const before = yield* settings;
          if (before?.nextAt == null) return yield* Effect.die("The schedule has no next run");

          // A due occurrence is skipped: no run, no token request, no call to the service. The
          // schedule stays enabled and shows the account it waits on.
          yield* nextOccurrence;
          const waiting = yield* settings.pipe(
            Effect.flatMap((current) =>
              current !== undefined &&
              current.activeRun === null &&
              current.nextAt !== null &&
              current.nextAt !== before.nextAt
                ? Effect.succeed(current)
                : Effect.fail(new Error(`The occurrence has not been handled`)),
            ),
            Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
          );
          expect(waiting).toMatchObject({ enabled: true, reconnectAccount: account.id });
          // The skip consumes the occurrence as a claim does. A dispatch that scanned the same due
          // occurrence cannot claim it later, even once the account has reconnected.
          expect(
            waiting.revision,
            "A skipped occurrence can no longer be claimed with its scanned revision",
          ).not.toBe(before.revision);
          expect(
            (yield* runs).filter((row) => row.status !== "succeeded"),
            "An occurrence waiting for a reconnect records no failed run",
          ).toEqual([]);
          expect((yield* issuer.metrics).refreshes).toBe(refreshes);
          expect((yield* issuer.metrics).resourceRequests.POST).toBe(posts);
          // Before claiming the occurrence, the dispatcher checked the account's stored grant and
          // found it must reconnect; the schedule list runs the same check. That is an expected
          // account state the owner resolves, recorded as the check's outcome: neither a check nor
          // any span above it is an error.
          const checks = yield* dispatcherChecks(
            "oauth.usable",
            { "oauth.provider.id": provider },
            "oauth.usable.outcome",
          );
          for (const { check, path } of checks) {
            expect(check.span.status, "A grant that must reconnect is not a failed check").not.toBe(
              "error",
            );
            expect(check.span.tags).toMatchObject({
              "oauth.provider.id": provider,
              "oauth.usable.outcome": "reconnect",
              "oauth.reconnect.reason": "grant_unusable",
            });
            expect(
              path.filter((span) => span.status === "error").map((span) => span.operationName),
              "No span above the check marks the reconnect state as an error",
            ).toEqual([]);
          }
          expectDispatchRoots(checks);
          yield* evidence.json(
            "waiting-for-reconnect-checks.json",
            checks.map(({ path }) => path),
          );
          // The schedule's discovery reports the same account state to the owner.
          const definitions = yield* api.request(
            actors.owner,
            "GET",
            `${path}/schedules/definitions?profile=${profile.id}`,
          );
          expect(definitions.status, JSON.stringify(definitions.body)).toBe(409);
          expect((yield* body(Failure, definitions))._tag).toBe("OAuthReconnectRequired");

          // The owner's schedule tab shows why the schedule does not run.
          yield* browser.login(actors.owner);
          yield* browser.use("Open the schedule waiting for a reconnect", (page) =>
            page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=schedules`),
          );
          yield* browser.use("The schedule shows it is waiting for a reconnect", (page) =>
            page.getByText("Waiting for reconnect", { exact: true }).waitFor(),
          );
          const screenshot = yield* browser.use("Capture the waiting schedule", (page) =>
            page.screenshot(),
          );
          yield* evidence.attach("schedule-waiting-for-reconnect.png", "image/png", screenshot);

          // Reconnecting the same account resumes the schedule without re-enabling it.
          const reconnect = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${path}/connections`, {
              requirement: "service",
              profile: profile.id,
              account: account.id,
            }),
          );
          expect((yield* signIn(reconnect.id)).id).toBe(account.id);
          const resumed = yield* settings;
          expect(resumed?.enabled).toBe(true);
          expect(resumed?.reconnectAccount).toBeUndefined();
          yield* nextOccurrence;
          yield* runWith("succeeded", 2);
          expect((yield* issuer.metrics).resourceRequests.POST).toBe(posts + 1);
          expect(
            (yield* runs).filter((row) => row.status !== "succeeded"),
            "No occurrence failed while the account was reconnecting",
          ).toEqual([]);

          // A genuine failure on the same path is still an error: the token endpoint is down, so
          // the occurrence's run cannot renew the grant and fails without ending it.
          yield* issuer.configure({ tokenError: { status: 503, body: {} } });
          yield* nextOccurrence;
          yield* runWith("failed", 1);
          const unavailable = yield* telemetry
            .search("oauth.resolve", {
              "oauth.provider.id": provider,
              "oauth.renewal.outcome": "service_unavailable",
            })
            .pipe(
              Effect.flatMap((found) =>
                found.data.length > 0
                  ? Effect.succeed(found.data)
                  : Effect.fail(new Error("The failed renewal has not arrived")),
              ),
              Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
            );
          expect(
            unavailable.map(({ span }) => span.status),
            "A renewal the service could not answer is a failed span",
          ).toEqual(unavailable.map(() => "error"));
          yield* issuer.configure({ tokenError: null });
        }),
      ),
    { timeout: 120_000 },
  );
});
