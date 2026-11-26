import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { connectionsPath } from "../support/app-accounts.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { serverControl } from "../support/server-control.ts";
import { settleWebhookSources, sourcesAre } from "../support/webhook-sources.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";
import { appLinksFixture, keyProvider, okBody } from "../support/app-links.ts";
import { webhookSubscriptions } from "../support/webhook-sources.ts";

const AppProvider = Schema.Struct({ id: Schema.String });
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const SourceRow = Schema.Struct({
  status: Schema.String,
  failure: Schema.NullOr(Schema.String),
  retries: Schema.Number,
  lease: Schema.NullOr(Schema.String),
  lease_until: Schema.Number,
});
const tick = 5_000;
const quiet = tick + 1_500;

const productClock = Effect.sync(() => {
  let offset = 0;
  const productNow = Clock.currentTimeMillis.pipe(Effect.map((now) => now + offset));
  const advanceTo = (at: number) =>
    Effect.gen(function* () {
      const milliseconds = Math.ceil(at - (yield* productNow));
      expect(milliseconds, "The scenario moves the clock forward only").toBeGreaterThan(0);
      yield* serverControl("clock/advance", 200, { milliseconds });
      offset += milliseconds;
    });
  return { productNow, advanceTo };
});

const registeredSource = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    http = yield* HttpClient.HttpClient;
  const issuer = yield* oauthSetupIssuer;
  const prefix = `/api/organizations/${actors.organization.id}`;
  yield* issuer.configure({ refreshTokens: true, expiresIn: 20 });
  const name = `Retry backoff ${randomUUID().slice(0, 8)}`;
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name,
    files: [
      {
        path: "index.ts",
        content: `import { defineApp, defineProvider, oauth2, query, object, string, router } from "apps";
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: { oauth: oauth2({ discover: ${JSON.stringify(`${issuer.origin}/mcp`)} }) } });
const incoming = { account: { user: "service" }, config: object({ channel: string().optional() }), state: object({}),
  register: async () => ({}), unregister: async () => {}, handle: async () => Response.json({}) };
export default defineApp({ user: { accounts: { service } } }, async () => ({
  tools: router({ ready: query({ input: object({}) }, async (ctx) => ctx.user.accounts.service.id) }),
  webhooks: { incoming },
}));`,
      },
      appsManifest,
    ],
  });
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
  const app = yield* body(AppProvider, deployed);
  const path = `${prefix}/apps/${app.id}`;
  yield* Effect.addFinalizer(() => api.request(actors.owner, "DELETE", path).pipe(Effect.orDie));

  const signIn = (account?: string) =>
    Effect.gen(function* () {
      const connection = yield* body(
        Resource,
        yield* api.request(
          actors.owner,
          "POST",
          connectionsPath(path, "user", "service"),
          account === undefined ? {} : { account },
        ),
      );
      const started = yield* api.request(
        actors.owner,
        "POST",
        `${prefix}/connections/${connection.id}/oauth/start`,
        { method: "oauth", label: "Synthetic webhook source account" },
      );
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      const { authorizationUrl } = yield* body(SignIn, started);
      const callbackUrl = yield* Effect.scoped(
        Effect.gen(function* () {
          const consent = yield* HttpClient.withScope(http).get(authorizationUrl);
          expect(consent.status).toBe(302);
          const location = consent.headers.location;
          if (location === undefined) return yield* Effect.die("Issuer did not return a callback");
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
      return (yield* body(Resource, completed)).id;
    });

  const account = yield* signIn();
  yield* Effect.addFinalizer(() =>
    api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`).pipe(Effect.orDie),
  );
  yield* settleWebhookSources(
    actors.owner,
    path,
    sourcesAre({ [account]: { status: "ready", failure: null } }),
  );

  const { productNow, advanceTo } = yield* productClock;
  const configure = (channel: string) =>
    api
      .request(actors.owner, "PUT", `${path}/webhook-sources/${account}/config`, {
        config: { incoming: { channel } },
      })
      .pipe(
        Effect.tap((response) =>
          Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
        ),
      );
  return { app, path, account, issuer, signIn, productNow, advanceTo, configure };
});

const manualSetupSource = `import { defineApp, defineProvider, secrets, query, object, string, router } from "apps";
const team = ${keyProvider("Manual setup wait fixture")};
const inbound = { account: { app: "team" }, config: object({}), state: object({}),
  setup: { instructions: "Paste the callback URL into the provider's webhook settings.", signingSecret: "executor" },
  handle: async () => Response.json({ received: true }) };
export default defineApp({ app: { accounts: { team } } },
  async () => ({ tools: router({ ping: query({ input: object({}) }, async () => "pong") }), webhooks: { inbound } }));`;
const SetupStep = Schema.Struct({ step: Schema.Literal("configure"), revision: Schema.String });
const SetupResult = Schema.Struct({ id: Schema.String, status: Schema.String });

const sourceRow = (app: string, account: string) => ({
  sql: `select status, failure, retries, lease,
    (extract(epoch from lease_until) * 1000)::float8 as lease_until
    from executor_webhook_sources where app = $1 and account = $2`,
  params: [app, account],
});

const storedRow = <E, R>(read: Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, E, R>) =>
  Effect.gen(function* () {
    const [rows] = yield* read;
    yield* serverControl("start");
    expect(rows, "The source has one stored row").toHaveLength(1);
    return yield* Schema.decodeUnknownEffect(SourceRow)(rows?.[0]).pipe(Effect.orDie);
  });

const spansReach = <E, R>(spans: Effect.Effect<readonly unknown[], E, R>, count: number) =>
  spans.pipe(
    Effect.flatMap((found) =>
      found.length >= count
        ? Effect.succeed(found.length)
        : Effect.fail(new Error(`${found.length} of ${count} spans delivered`)),
    ),
    Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 150 }),
    Effect.orDie,
  );

layer(HostedLive, { excludeTestServices: true })("Webhook source retry backoff", (it) => {
  it.effect(
    scenarios.webhookSourceRetryBackoff.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const actors = yield* Actors,
            evidence = yield* Evidence,
            telemetry = yield* Telemetry;
          const { app, path, account, issuer, productNow, advanceTo, configure } =
            yield* registeredSource;
          const stored = storedRow(legacyStorage([sourceRow(app.id, account)]));
          const attempts = telemetry
            .spans(
              "sdk.webhooks.reconcileSource",
              { app: app.id },
              { "executor.account.id": account },
            )
            .pipe(Effect.orDie);
          const attemptsReach = (count: number) => spansReach(attempts, count);
          const refreshes = issuer.metrics.pipe(Effect.map((metrics) => metrics.refreshes));
          const attempt = <A, E, R>(count: number, change: Effect.Effect<A, E, R>) =>
            Effect.gen(function* () {
              const before = yield* refreshes;
              const from = yield* productNow;
              yield* change;
              yield* attemptsReach(count);
              const to = yield* productNow;
              expect(yield* attempts, "The change ran exactly one attempt").toHaveLength(count);
              return { from, to, requests: (yield* refreshes) - before };
            });
          const backedOff = (
            window: { readonly from: number; readonly to: number },
            retries: number,
            delay: number,
          ) =>
            Effect.gen(function* () {
              const row = yield* stored;
              expect(row).toMatchObject({
                status: "failed",
                failure: "registration",
                retries,
                lease: null,
              });
              expect(row.lease_until).toBeGreaterThanOrEqual(window.from + delay);
              expect(row.lease_until).toBeLessThanOrEqual(window.to + delay);
              yield* evidence.step(
                `Source failed ${retries} times in a row and retries ${delay / 1000}s later`,
                Effect.void,
              );
              return row;
            });
          const holdsAt = (at: number, count: number) =>
            Effect.gen(function* () {
              const requests = yield* refreshes;
              yield* advanceTo(at);
              yield* Effect.sleep(quiet);
              expect(yield* attempts, "No attempt ran before the retry was due").toHaveLength(
                count,
              );
              expect(yield* refreshes, "No token request before the retry was due").toBe(requests);
            });

          yield* issuer.configure({
            tokenError: {
              status: 403,
              body: { error: "unauthorized_client" },
            },
          });
          yield* advanceTo((yield* productNow) + 60_000);
          expect(yield* stored).toMatchObject({
            status: "ready",
            retries: 0,
            lease: null,
          });
          const initial = yield* attemptsReach(1);

          const first = yield* attempt(initial + 1, configure("first"));
          expect(first.requests, "The attempt asked the token endpoint").toBeGreaterThan(0);
          const perAttempt = first.requests;
          yield* settleWebhookSources(
            actors.owner,
            path,
            sourcesAre({
              [account]: { status: "failed", failure: "registration" },
            }),
          );
          const one = yield* backedOff(first, 1, 30_000);

          const second = yield* attempt(initial + 2, advanceTo(one.lease_until + 1));
          expect(second.requests).toBe(perAttempt);
          const two = yield* backedOff(second, 2, 60_000);
          yield* holdsAt(two.lease_until - 15_000, initial + 2);

          const third = yield* attempt(initial + 3, advanceTo(two.lease_until + 1));
          expect(third.requests).toBe(perAttempt);
          const three = yield* backedOff(third, 3, 120_000);
          yield* holdsAt(three.lease_until - 50_000, initial + 3);

          const reconfigured = yield* attempt(initial + 4, configure("second"));
          expect(reconfigured.to, "The new intent ran before the retry was due").toBeLessThan(
            three.lease_until,
          );
          expect(reconfigured.requests).toBe(perAttempt);
          const reset = yield* backedOff(reconfigured, 1, 30_000);

          yield* issuer.configure({ tokenError: null });
          const fixed = yield* attempt(initial + 5, configure("third"));
          expect(fixed.to, "Configuring ran before the retry was due").toBeLessThan(
            reset.lease_until,
          );
          expect(fixed.requests, "The account renewed").toBeGreaterThan(0);
          yield* settleWebhookSources(
            actors.owner,
            path,
            sourcesAre({ [account]: { status: "ready", failure: null } }),
          );
          expect(yield* stored).toMatchObject({
            status: "ready",
            failure: null,
            retries: 0,
            lease: null,
          });
        }),
      ),
    { timeout: 240_000 },
  );

  it.effect(
    scenarios.webhookSourceReconnectWait.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const actors = yield* Actors,
            evidence = yield* Evidence,
            telemetry = yield* Telemetry;
          const { app, path, account, issuer, signIn, productNow, advanceTo, configure } =
            yield* registeredSource;
          const stored = storedRow(legacyStorage([sourceRow(app.id, account)]));
          const checks = telemetry
            .spans("sdk.accounts.reconnectRequired", { app: app.id })
            .pipe(Effect.orDie);
          const check = (count: number, due: number) =>
            Effect.gen(function* () {
              const from = yield* productNow;
              yield* advanceTo(due + 1);
              yield* spansReach(checks, count);
              const to = yield* productNow;
              expect(yield* checks, "The due tick checked the accounts once").toHaveLength(count);
              return { from, to };
            });
          const waits = (
            window: { readonly from: number; readonly to: number },
            retries: number,
            delay: number,
          ) =>
            Effect.gen(function* () {
              const row = yield* stored;
              expect(row).toMatchObject({
                status: "needs-setup",
                failure: "accounts",
                retries,
                lease: null,
              });
              expect(row.lease_until).toBeGreaterThanOrEqual(window.from + delay);
              expect(row.lease_until).toBeLessThanOrEqual(window.to + delay);
              yield* evidence.step(
                `The account was found waiting ${retries} times; the next check is ${delay / 1000}s later`,
                Effect.void,
              );
              return row;
            });
          const holdsAt = (at: number, count: number) =>
            Effect.gen(function* () {
              yield* advanceTo(at);
              yield* Effect.sleep(quiet);
              expect(yield* checks, "No check ran before it was due").toHaveLength(count);
            });

          yield* issuer.configure({
            tokenError: { status: 400, body: { error: "invalid_grant" } },
          });
          yield* advanceTo((yield* productNow) + 60_000);
          const ended = yield* productNow;
          yield* configure("ended");
          yield* settleWebhookSources(
            actors.owner,
            path,
            sourcesAre({ [account]: { status: "needs-setup", failure: "accounts" } }),
          );
          const one = yield* waits({ from: ended, to: yield* productNow }, 1, 30_000);
          yield* issuer.configure({ tokenError: null });
          const refreshes = (yield* issuer.metrics).refreshes;
          const initial = (yield* checks).length;

          const two = yield* waits(yield* check(initial + 1, one.lease_until), 2, 60_000);
          yield* holdsAt(two.lease_until - 15_000, initial + 1);
          const three = yield* waits(yield* check(initial + 2, two.lease_until), 3, 120_000);
          yield* holdsAt(three.lease_until - 50_000, initial + 2);
          expect(
            (yield* issuer.metrics).refreshes,
            "A waiting source asks the token endpoint nothing",
          ).toBe(refreshes);

          expect(yield* signIn(account), "The sign-in reconnected the same account").toBe(account);
          yield* settleWebhookSources(
            actors.owner,
            path,
            sourcesAre({ [account]: { status: "ready", failure: null } }),
          );
          expect(
            yield* productNow,
            "The source resumed before its next check was due",
          ).toBeLessThan(three.lease_until);
          expect(yield* stored).toMatchObject({
            status: "ready",
            failure: null,
            retries: 0,
            lease: null,
          });
        }),
      ),
    { timeout: 240_000 },
  );

  it.effect(
    scenarios.webhookSourceSetupWait.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            evidence = yield* Evidence,
            telemetry = yield* Telemetry;
          const { prefix, app, path, connect } = yield* appLinksFixture([
            { path: "index.ts", content: manualSetupSource },
          ]);
          const { productNow, advanceTo } = yield* productClock;

          const linked = yield* productNow;
          const account = yield* connect(actors.owner, "app", "team", "manual-setup-key");
          yield* settleWebhookSources(
            actors.owner,
            path,
            sourcesAre({ [account]: { status: "needs-setup", failure: "configuration" } }),
          );
          const [subscription] = (yield* webhookSubscriptions(actors.owner, path)).filter(
            (row) => row.sourceAccount === account && row.status === "setup-required",
          );
          if (subscription === undefined)
            return yield* Effect.die(new Error("The manual webhook is missing"));
          const setupPath = `${prefix}/webhook-setup/${app.id}/${subscription.id}`;

          const stored = storedRow(legacyStorage([sourceRow(app.id, account)]));
          const attempts = telemetry
            .spans(
              "sdk.webhooks.reconcileSource",
              { app: app.id },
              { "executor.account.id": account },
            )
            .pipe(Effect.orDie);
          const waits = (
            window: { readonly from: number; readonly to: number },
            retries: number,
            delay: number,
          ) =>
            Effect.gen(function* () {
              const row = yield* stored;
              expect(row).toMatchObject({
                status: "needs-setup",
                failure: "configuration",
                retries,
                lease: null,
              });
              expect(row.lease_until).toBeGreaterThanOrEqual(window.from + delay);
              expect(row.lease_until).toBeLessThanOrEqual(window.to + delay);
              yield* evidence.step(
                `${retries} attempts found the setup unfinished; the next is ${delay / 1000}s later`,
                Effect.void,
              );
              return row;
            });

          const one = yield* waits({ from: linked, to: yield* productNow }, 1, 30_000);
          const initial = yield* spansReach(attempts, 1);

          const from = yield* productNow;
          yield* advanceTo(one.lease_until + 1);
          yield* spansReach(attempts, initial + 1);
          const two = yield* waits({ from, to: yield* productNow }, 2, 60_000);
          yield* advanceTo(two.lease_until - 15_000);
          yield* Effect.sleep(quiet);
          expect(yield* attempts, "No attempt ran before the next was due").toHaveLength(
            initial + 1,
          );

          const opened = yield* okBody(
            SetupStep,
            yield* api.request(actors.owner, "GET", setupPath),
          );
          expect(
            yield* okBody(
              SetupResult,
              yield* api.request(actors.owner, "POST", setupPath, {
                revision: opened.revision,
                state: {},
              }),
            ),
          ).toMatchObject({ id: subscription.id, status: "active" });
          yield* settleWebhookSources(
            actors.owner,
            path,
            sourcesAre({ [account]: { status: "ready", failure: null } }),
          );
          expect(yield* productNow, "The source ran before its next attempt was due").toBeLessThan(
            two.lease_until,
          );
          expect(yield* stored).toMatchObject({
            status: "ready",
            failure: null,
            retries: 0,
            lease: null,
          });
        }),
      ),
    { timeout: 240_000 },
  );
});
