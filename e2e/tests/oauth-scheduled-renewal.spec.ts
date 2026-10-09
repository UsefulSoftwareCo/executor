/** Scheduled and approved calls renew a grant whose token the service refuses, as direct calls do. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { McpClient } from "../support/mcp-client.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { createProfile } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const Executed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Boolean, value: Schema.optional(Schema.Unknown) }),
});
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const SetupStatus = Schema.Struct({ status: Schema.String });
const Runs = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    status: Schema.String,
    failure: Schema.NullOr(Schema.String),
  }),
);
/** A run has finished once it is neither running nor waiting for its approval. */
const finished = (status: string) => status !== "running" && status !== "awaiting-approval";

layer(HostedLive, { excludeTestServices: true })("OAuth scheduled renewal", (it) => {
  it.effect(
    scenarios.oauthScheduledRenewal.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            http = yield* HttpClient.HttpClient,
            mcp = yield* McpClient;
          const issuer = yield* oauthSetupIssuer;
          const prefix = `/api/organizations/${actors.organization.id}`;
          // Salesforce issues a refresh token but no `expires_in`, so nothing renews it ahead of
          // time. Its API later answers the old token with 401.
          yield* issuer.configure({ refreshTokens: true, expiresIn: null });
          const name = `Scheduled renewal ${randomUUID().slice(0, 8)}`;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name,
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, defineProvider, oauth2, query, mutation, object, interval, router, ProviderError } from "apps";
import { always } from "apps/operations/approval";
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: { oauth: oauth2({ discover: ${JSON.stringify(`${issuer.origin}/mcp`)} }) } });
async function call(fetch, account, method) {
  const response = await fetch(${JSON.stringify(`${issuer.origin}/resource`)}, { method, headers: { authorization: "Bearer " + account.fields.access_token } });
  if (response.status === 401) throw new ProviderError({ reason: "unauthorized", status: 401, accountId: account.id });
  return await response.json();
}
export default defineApp({ accounts: { service } }, async ({ accounts }) => {
  const write = mutation({ input: object({}) }, async ({ fetch }) => call(fetch, accounts.service, "POST"));
  const reviewedWrite = mutation({ input: object({}), approval: always() }, async ({ fetch }) => call(fetch, accounts.service, "POST"));
  const reviewedRead = query({ input: object({}), approval: always() }, async ({ fetch }) => call(fetch, accounts.service, "GET"));
  return {
    tools: router({ reviewedRead, write, reviewedWrite }),
    schedules: {
      write: interval({ minutes: 1 }, write, {}),
      reviewedWrite: interval({ minutes: 1 }, reviewedWrite, {}),
    },
  };
});`,
              },
              appsManifest,
            ],
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const app = yield* body(App, deployed);
          const path = `${prefix}/apps/${app.id}`;
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
          );
          const profile = yield* createProfile(actors.owner, path);
          const connection = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${path}/connections`, {
              requirement: "service",
              profile: profile.id,
            }),
          );
          const started = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/oauth/start`,
            { method: "oauth", label: "Synthetic Salesforce-style account" },
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
          const account = yield* body(Resource, completed);
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`)
              .pipe(Effect.orDie),
          );
          yield* api.request(actors.owner, "GET", `${path}/profiles/${profile.id}`).pipe(
            Effect.flatMap((response) =>
              body(SetupStatus, response).pipe(
                Effect.flatMap((current) =>
                  current.status === "ready"
                    ? Effect.void
                    : Effect.fail(new Error(`Profile setup: ${JSON.stringify(response.body)}`)),
                ),
              ),
            ),
            Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
          );

          const runs = api
            .request(actors.owner, "GET", `${prefix}/scheduled-runs?app=${app.id}`)
            .pipe(Effect.flatMap((response) => body(Runs, response)));
          /**
           * Start one occurrence now and wait for the scheduler's worker, which has no signed-in
           * caller, to finish it. Automatic approval resumes an approval-gated call in the worker.
           */
          const runOnce = (schedule: string) =>
            Effect.gen(function* () {
              const seen = new Set((yield* runs).map((run) => run.id));
              const ran = yield* api.request(
                actors.owner,
                "POST",
                `${path}/schedules/${schedule}/run?profile=${profile.id}`,
              );
              expect(ran.status, JSON.stringify(ran.body)).toBe(200);
              return yield* runs.pipe(
                Effect.flatMap((rows) => {
                  const run = rows.find(
                    (row) => row.name === schedule && !seen.has(row.id) && finished(row.status),
                  );
                  return run === undefined
                    ? Effect.fail(new Error(`No finished ${schedule} run: ${JSON.stringify(rows)}`))
                    : Effect.succeed(run);
                }),
                Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
              );
            });
          /** Enable one schedule only while it is used, so no ordinary occurrence interleaves. */
          const withSchedule = <A, E, R>(schedule: string, work: Effect.Effect<A, E, R>) =>
            Effect.acquireUseRelease(
              api
                .request(actors.owner, "PATCH", `${path}/schedules/${schedule}`, {
                  profile: profile.id,
                  enabled: true,
                  approvalMode: "automatic",
                })
                .pipe(
                  Effect.tap((response) =>
                    Effect.sync(() =>
                      expect(response.status, JSON.stringify(response.body)).toBe(200),
                    ),
                  ),
                ),
              () => work,
              () =>
                api
                  .request(actors.owner, "PATCH", `${path}/schedules/${schedule}`, {
                    profile: profile.id,
                    enabled: false,
                  })
                  .pipe(Effect.orDie),
            );
          const refreshes = issuer.metrics.pipe(Effect.map((metrics) => metrics.refreshes));
          const requests = issuer.metrics.pipe(Effect.map((metrics) => metrics.resourceRequests));

          // A scheduled mutation meets a refused token in the worker, which has no signed-in
          // caller. The grant is renewed; the mutation is not repeated, and the next one succeeds.
          yield* withSchedule(
            "write",
            Effect.gen(function* () {
              expect(yield* runOnce("write")).toMatchObject({ status: "succeeded", failure: null });
              const before = yield* refreshes;
              const posts = (yield* requests).POST;
              yield* issuer.expireAccessTokens;
              expect(yield* runOnce("write")).toMatchObject({
                status: "failed",
                failure: "AppProviderFailed",
              });
              expect(
                yield* refreshes,
                "A scheduled call renews a refused grant without a signed-in caller",
              ).toBe(before + 1);
              expect((yield* requests).POST, "The refused mutation is not repeated").toBe(
                posts + 1,
              );
              expect(yield* runOnce("write")).toMatchObject({ status: "succeeded", failure: null });
              expect(yield* refreshes).toBe(before + 1);
              expect((yield* requests).POST).toBe(posts + 2);
            }),
          );

          // An approved mutation renews when it resumes, and is not repeated either.
          yield* withSchedule(
            "reviewedWrite",
            Effect.gen(function* () {
              const before = yield* refreshes;
              const posts = (yield* requests).POST;
              yield* issuer.expireAccessTokens;
              expect((yield* runOnce("reviewedWrite")).status).toBe("failed");
              expect(yield* refreshes, "A resumed call renews a refused grant").toBe(before + 1);
              expect((yield* requests).POST, "The refused mutation is not repeated").toBe(
                posts + 1,
              );
              expect(yield* runOnce("reviewedWrite")).toMatchObject({
                status: "succeeded",
                failure: null,
              });
              expect(yield* refreshes).toBe(before + 1);
              expect((yield* requests).POST).toBe(posts + 2);
            }),
          );

          // A query the owner approves in their MCP client renews on resume and repeats once.
          const created = yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Scheduled renewal MCP",
          });
          expect(created.status, JSON.stringify(created.body)).toBe(200);
          const token = yield* body(Token, created);
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: token.id })
              .pipe(Effect.orDie),
          );
          const client = yield* mcp.connect(token.key, "scheduled-renewal", {
            organization: actors.organization.id,
            mode: "native",
          });
          const before = yield* refreshes;
          const gets = (yield* requests).GET;
          yield* issuer.expireAccessTokens;
          const approved = yield* client.use(
            "Approve a query whose token is refused",
            (client, signal) =>
              client.callTool(
                {
                  name: "execute",
                  arguments: {
                    code: `return await tools[${JSON.stringify(app.slug)}].profiles[${JSON.stringify(profile.id)}].reviewedRead({});`,
                  },
                },
                undefined,
                { signal },
              ),
          );
          expect(yield* client.elicitationCount).toBe(1);
          expect(
            (yield* Schema.decodeUnknownEffect(Executed)(approved.structuredContent)).execution,
            "An approved query renews a refused grant when it resumes",
          ).toEqual({
            ok: true,
            value: {
              refreshed: true,
              authorization: `Bearer synthetic-refreshed-token-${before + 1}`,
            },
          });
          expect(yield* refreshes).toBe(before + 1);
          // The refused read and its one repetition with the renewed token.
          expect((yield* requests).GET).toBe(gets + 2);
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 120_000 },
  );
});
