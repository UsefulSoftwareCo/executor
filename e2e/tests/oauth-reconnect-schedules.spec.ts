import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import {
  linkAccount,
  linkedAccountIds,
  unlinkAccount,
  connectionsPath,
} from "../support/app-accounts.ts";
import { serverControl } from "../support/server-control.ts";
import { settleWebhookSources } from "../support/webhook-sources.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const AppProvider = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const Settings = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    enabled: Schema.Boolean,
    nextAt: Schema.NullOr(Schema.String),
    activeRun: Schema.NullOr(Schema.String),
    revision: Schema.String,
    reconnectAccount: Schema.optional(Schema.String),
    accountRequired: Schema.optional(Schema.String),
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
            http = yield* HttpClient.HttpClient;
          const issuer = yield* oauthSetupIssuer;
          const prefix = `/api/organizations/${actors.organization.id}`;
          yield* issuer.configure({ refreshTokens: true, expiresIn: 20 });
          const name = `Reconnect schedule ${randomUUID().slice(0, 8)}`;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name,
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, defineProvider, oauth2, mutation, object, userInterval, router, type MutationContext } from "apps";
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: { oauth: oauth2({ discover: ${JSON.stringify(`${issuer.origin}/mcp`)} }) } });
const requirements = { user: { accounts: { service } } };
const work = mutation({ input: object({}) }, async (ctx: MutationContext<typeof requirements>) => {
  const response = await ctx.fetch(${JSON.stringify(`${issuer.origin}/resource`)}, { method: "POST", headers: { authorization: "Bearer " + ctx.user.accounts.service.fields.access_token } });
  return await response.json();
});
export default defineApp(requirements, async () => ({
  tools: router({ work }),
  schedules: { work: userInterval({ minutes: 1 }, work, {}) },
}));`,
              },
              appsManifest,
            ],
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const app = yield* body(AppProvider, deployed);
          const path = `${prefix}/apps/${app.id}`;
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
          );

          const signIn = (connection: string, label = "Synthetic scheduled account") =>
            Effect.gen(function* () {
              const started = yield* api.request(
                actors.owner,
                "POST",
                `${prefix}/connections/${connection}/oauth/start`,
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
                `${prefix}/connections/${connection}/oauth/complete`,
                { callbackUrl },
              );
              expect(completed.status, JSON.stringify(completed.body)).toBe(200);
              return yield* body(Resource, completed);
            });
          const connect = (label?: string) =>
            Effect.gen(function* () {
              const connection = yield* body(
                Resource,
                yield* api.request(
                  actors.owner,
                  "POST",
                  connectionsPath(path, "user", "service"),
                  {},
                ),
              );
              const account = yield* signIn(connection.id, label);
              yield* Effect.addFinalizer(() =>
                api
                  .request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`)
                  .pipe(Effect.orDie),
              );
              yield* settleWebhookSources(actors.owner, path, (sources) =>
                sources.some(
                  (source) => source.account === account.id && source.status !== "pending",
                ),
              );
              return account;
            });
          const account = yield* connect();

          const settings = api.request(actors.owner, "GET", `${path}/schedules`).pipe(
            Effect.flatMap((response) => body(Settings, response)),
            Effect.map((rows) => rows.find((row) => row.name === "work")),
          );
          const runs = api
            .request(actors.owner, "GET", `${prefix}/scheduled-runs?app=${app.id}`)
            .pipe(Effect.flatMap((response) => body(Runs, response)));
          const runWith = (status: string, count: number) =>
            runs.pipe(
              Effect.flatMap((rows) =>
                rows.filter((row) => row.status === status).length >= count
                  ? Effect.succeed(rows)
                  : Effect.fail(new Error(`No ${status} run yet: ${JSON.stringify(rows)}`)),
              ),
              Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
            );
          const nextOccurrence = Effect.gen(function* () {
            yield* serverControl("stop");
            yield* serverControl("clock/advance", 200, { milliseconds: occurrence });
            yield* serverControl("start");
          });

          const enabled = yield* api.request(actors.owner, "PATCH", `${path}/schedules/work`, {
            enabled: true,
          });
          expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
          const started = yield* api.request(actors.owner, "POST", `${path}/schedules/work/run`);
          expect(started.status, JSON.stringify(started.body)).toBe(200);
          yield* runWith("succeeded", 1);

          const other = yield* connect("Synthetic second scheduled account");
          expect(yield* linkedAccountIds(actors.owner, path)).toEqual([other.id]);
          expect(
            (yield* api.request(actors.owner, "GET", `${prefix}/accounts/${account.id}`)).status,
          ).toBe(200);
          expect((yield* settings)?.accountRequired).toBeUndefined();
          yield* unlinkAccount(actors.owner, path, "service", other.id);
          const unlinked = yield* settings;
          if (unlinked?.nextAt == null) return yield* Effect.die("The schedule has no next run");
          expect(unlinked).toMatchObject({ enabled: true, accountRequired: "service" });
          const unlinkedPosts = (yield* issuer.metrics).resourceRequests.POST;
          yield* nextOccurrence;
          yield* settings.pipe(
            Effect.flatMap((current) =>
              current !== undefined &&
              current.activeRun === null &&
              current.nextAt !== null &&
              current.nextAt !== unlinked.nextAt
                ? Effect.succeed(current)
                : Effect.fail(new Error(`The occurrence has not been handled`)),
            ),
            Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
          );
          expect(
            (yield* runs).map((row) => row.status),
            "An occurrence without a linked account records no run",
          ).toEqual(["succeeded"]);
          expect((yield* issuer.metrics).resourceRequests.POST).toBe(unlinkedPosts);
          yield* linkAccount(actors.owner, path, "service", account.id);
          expect((yield* settings)?.accountRequired).toBeUndefined();
          expect(
            (yield* api.request(actors.owner, "GET", `${prefix}/accounts/${other.id}`)).status,
          ).toBe(200);

          yield* issuer.configure({
            tokenError: { status: 400, body: { error: "invalid_grant" } },
          });
          const ended = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
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
          const definitions = yield* api.request(
            actors.owner,
            "GET",
            `${path}/schedules/definitions`,
          );
          expect(definitions.status, JSON.stringify(definitions.body)).toBe(409);
          expect((yield* body(Failure, definitions))._tag).toBe("OAuthReconnectRequired");

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

          const reconnect = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", connectionsPath(path, "user", "service"), {
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

          yield* issuer.configure({ tokenError: { status: 503, body: {} } });
          yield* nextOccurrence;
          yield* runWith("failed", 1);
          yield* issuer.configure({ tokenError: null });
        }),
      ),
    { timeout: 120_000 },
  );
});
