/**
 * A dashboard batch read served a stale skill catalog and refreshed it in the background. The
 * refresh renewed the app's OAuth account against a service that rotates refresh tokens. The
 * renewal must be saved even though the batch has already answered: otherwise the service has
 * replaced the only saved refresh token, and the account must reconnect.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { settleWebhookSources } from "../support/webhook-sources.ts";
import { scenarios } from "../test-plan.ts";
import { connectionsPath } from "../support/app-accounts.ts";

const AppProvider = Schema.Struct({ id: Schema.String });
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const BatchAnswer = Schema.Struct({ id: Schema.Number, status: Schema.Number });
const Read = Schema.Struct({
  service: Schema.Struct({
    refreshed: Schema.Boolean,
    authorization: Schema.NullOr(Schema.String),
  }),
});
/** Past the 10 s after which kept declarations are served stale and refreshed in the background. */
const catalogTurnsStale = "11 seconds";
/** How long the service takes to answer the background renewal after rotating the token. */
const slowAnswer = "3 seconds";

const backgroundRenewalAfterBatch = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    http = yield* HttpClient.HttpClient;
  const issuer = yield* oauthSetupIssuer;
  const organization = actors.organization.id;
  const prefix = `/api/organizations/${organization}`;
  // Tokens issued inside the host's 30-second renewal window renew on every use, and every
  // renewal replaces the refresh token the service accepts.
  yield* issuer.configure({
    refreshTokens: true,
    rotateRefreshTokens: true,
    replacedRefreshTokens: "refused",
    expiresIn: 20,
  });
  const name = `Rotating ${randomUUID().slice(0, 8)}`;
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name,
    files: [
      {
        path: "index.ts",
        content: `import { defineApp, defineProvider, oauth2, query, object, router } from "apps";
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: { oauth: oauth2({ discover: ${JSON.stringify(`${issuer.origin}/mcp`)} }) } });
export default defineApp({ user: { accounts: { service } } }, async ({ user: { accounts } }) => ({
  tools: router({
    read: query({ input: object({}) }, async ({ fetch }) => ({ service: await (await fetch(${JSON.stringify(`${issuer.origin}/resource`)}, { headers: { authorization: "Bearer " + accounts.service.fields.access_token } })).json() })),
  }),
  skills: [{ name: "service-guide", description: "Service guide", files: [{ path: "SKILL.md", content: "---\\nname: service-guide\\ndescription: Service guide\\n---\\n# Service" }] }],
}));`,
      },
      appsManifest,
    ],
  });
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
  const app = yield* body(AppProvider, deployed);
  const appPath = `${prefix}/apps/${app.id}`;
  const connection = yield* body(
    Resource,
    yield* api.request(actors.owner, "POST", connectionsPath(appPath, "user", "service"), {}),
  );
  const started = yield* api.request(
    actors.owner,
    "POST",
    `${prefix}/connections/${connection.id}/oauth/start`,
    { method: "oauth", label: "Synthetic rotating account" },
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
  const account = yield* body(Resource, completed);
  // Connecting from the app links the account, which sets it up as the app's webhook source in
  // the background. That resolves, and so renews, the new account. Let it finish first.
  yield* settleWebhookSources(actors.owner, appPath, (sources) =>
    sources.some((source) => source.account === account.id && source.status !== "pending"),
  );

  // The skill catalog is evaluated once and kept, then left to turn stale.
  const listed = yield* api.request(actors.owner, "GET", `${appPath}/skills`);
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  yield* Effect.sleep(catalogTurnsStale);

  // The service rotates the token for the background renewal and answers it slowly.
  yield* issuer.configure({ hold: "refresh-issued" });
  const before = yield* issuer.metrics;
  // The dashboard's batch read answers with the stale catalog and refreshes it in the background.
  const batch = yield* Effect.forkChild(
    api.request(actors.owner, "POST", "/api/dashboard/batch", {
      reads: [
        {
          id: 0,
          group: "skills",
          endpoint: "list",
          params: { organization, app: app.id },
          query: {},
        },
      ],
    }),
  );
  yield* issuer.metrics.pipe(
    Effect.flatMap((current) =>
      current.held > before.held
        ? Effect.void
        : Effect.fail(new Error("The background renewal did not reach the service")),
    ),
    Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 400 }),
  );
  const rotated = yield* issuer.metrics;
  expect(rotated.refreshesIssued - before.refreshesIssued).toBe(1);
  yield* Effect.sleep(slowAnswer);
  yield* issuer.configure({ hold: null });
  yield* issuer.release;
  const answered = yield* Fiber.join(batch);
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  expect(yield* body(BatchAnswer, answered)).toMatchObject({ id: 0, status: 200 });

  // The saved grant holds the rotated refresh token. A call may still wait for the background
  // renewal to save and use its token; the call after it renews from the saved grant. The service
  // refuses replaced refresh tokens, so neither call may present one.
  const read = api.request(actors.owner, "POST", `${appPath}/tools/call`, {
    tool: "read",
    input: {},
  });
  for (const attempt of ["first call", "second call"]) {
    const call = yield* read;
    expect(call.status, `${attempt}: ${JSON.stringify(call.body)}`).toBe(200);
    expect((yield* body(Read, call)).service.refreshed, attempt).toBe(true);
  }
  const after = yield* issuer.metrics;
  expect(after.refreshesIssued, "renewals after the rotation").toBeGreaterThan(
    rotated.refreshesIssued,
  );
  expect(after.refreshes - after.refreshesIssued, "refused refresh requests").toBe(
    before.refreshes - before.refreshesIssued,
  );
});

layer(HostedLive, { excludeTestServices: true })("OAuth background renewal", (it) => {
  it.effect(scenarios.oauthBackgroundRenewalAfterBatch.title, (context) =>
    withHostedCase(context, backgroundRenewalAfterBatch),
  );
});
