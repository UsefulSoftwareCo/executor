/** Reporting fixtures control only the external issuer and the runner-owned product. */
import { expect } from "@effect/vitest";
import { Clock, Effect, FileSystem, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { Actors } from "./actors.ts";
import { Api, body, type Session } from "./api.ts";
import { appsManifest } from "./apps-release.ts";
import { connectionsPath } from "./app-accounts.ts";
import { Resource } from "./contracts.ts";
import { Telemetry } from "./evidence.ts";
import { oauthSetupIssuer, oauthSetupIssuerOn } from "./oauth-setup-issuer.ts";
import { serverControl } from "./server-control.ts";
import { Target } from "./platform.ts";
import {
  OperatorOAuthFixture,
  operatorOAuthFile,
  syntheticReportingClient,
} from "./operator-oauth.ts";

const scopes = ["mail.read", "offline_access", "read:me"];
const Redirect = Schema.Struct({ authorizationUrl: Schema.String, redirectUri: Schema.String });

/** A completed delivered span, rather than a delay, closes each scheduled run's observation. */
export const completedReportingRun = (since: number) =>
  Effect.flatMap(Telemetry, (telemetry) =>
    telemetry.search("sdk.personalDataReporting.run", {}),
  ).pipe(
    Effect.filterOrFail(
      (result) =>
        result.data.some(
          ({ span }) =>
            Date.parse(span.startTime) >= since &&
            span.tags["executor.personal_data_reporting.report_count"] !== undefined,
        ),
      () => new Error("The completed reporting run has not reached the collector"),
    ),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 150 }),
  );

export const reportingCase = Effect.gen(function* () {
  const api = yield* Api;
  const actors = yield* Actors;
  const http = yield* HttpClient.HttpClient;
  const target = yield* Target;
  const cloud = target.metadata.target === "cloud";
  const operator = cloud
    ? yield* (yield* FileSystem.FileSystem)
        .readFileString(`${target.directory}/${operatorOAuthFile}`)
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(OperatorOAuthFixture))),
        )
    : undefined;
  const issuer =
    operator === undefined
      ? yield* oauthSetupIssuer
      : yield* oauthSetupIssuerOn(operator.reportingPort);
  const origin = issuer.origin;
  const clientId = cloud ? syntheticReportingClient.clientId : "first-party-client";
  const clientSecret = cloud ? syntheticReportingClient.clientSecret : "first-party-secret";
  yield* issuer.configure({
    registration: false,
    refreshTokens: true,
    scopes,
    resourceTokens: "issued",
    reportingAccountId: "reporting-cycle-subject",
    reportingSubjectsByGrant: true,
    reportingAction: "none",
  });
  if (!cloud) {
    yield* serverControl("stop");
    yield* serverControl("environment", 200, {
      EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: "true",
      EXECUTOR_TEST_OAUTH_CLIENT_DEFINITIONS: JSON.stringify([
        {
          id: "synthetic-mail",
          label: "Executor for Synthetic Reporting",
          server: {
            issuer: origin,
            authorizationUrl: `${origin}/authorize`,
            tokenUrl: `${origin}/token`,
          },
          tokenEndpointAuthMethod: "client_secret_basic",
          defaultScopes: scopes,
          allowedScopes: scopes,
          placement: { hosts: [new URL(origin).host] },
          personalDataReporting: {
            identityUrl: `${origin}/me`,
            reportUrl: `${origin}/report-accounts`,
            accountIdField: "accountId",
          },
        },
      ]),
      EXECUTOR_OAUTH_SYNTHETIC_MAIL_CLIENT_ID: "first-party-client",
      EXECUTOR_OAUTH_SYNTHETIC_MAIL_CLIENT_SECRET: "first-party-secret",
    });
    yield* serverControl("start");
  }
  const prefix = `/api/organizations/${actors.organization.id}`;
  const files = [
    {
      path: "index.ts",
      content: `import { defineApp, defineProvider, oauth2 } from "apps";
const service = defineProvider({ name: "Synthetic Reporting", hosts: [${JSON.stringify(new URL(origin).host)}],
  auth: { oauth: oauth2({ issuer: ${JSON.stringify(origin)}, authorizationUrl: ${JSON.stringify(`${origin}/authorize`)}, tokenUrl: ${JSON.stringify(`${origin}/token`)}, scopes: ${JSON.stringify(scopes)} }) },
  async health({ account, fetch, signal }) {
    const response = await fetch(${JSON.stringify(`${origin}/me`)}, { headers: account.headers(), signal });
    const profile = await response.json();
    return { accountInfo: { externalId: profile.accountId, displayName: "Synthetic reporting identity" } };
  },
});
export default defineApp({ user: { accounts: { service } } }, {});`,
    },
    appsManifest,
  ];
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name: "Reporting cadence",
    files,
  });
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
  const app = yield* body(Resource, deployed);
  const appPath = `${prefix}/apps/${app.id}`;
  const access = yield* body(
    Schema.Struct({ revision: Schema.String }),
    yield* api.request(actors.owner, "GET", `${appPath}/access`),
  );
  expect(
    (yield* api.request(actors.owner, "PATCH", `${appPath}/access`, {
      revision: access.revision,
      audience: { kind: "everyone" },
    })).status,
  ).toBe(200);
  const savedAccounts = new Map<string, { session: Session; prefix: string }>();
  const apps = [{ session: actors.owner, path: appPath }];
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      for (const app of apps) yield* api.request(app.session, "DELETE", app.path);
      for (const [account, context] of savedAccounts)
        yield* api.request(context.session, "DELETE", `${context.prefix}/accounts/${account}`);
    }).pipe(Effect.orDie),
  );
  const connect = (
    account?: string,
    session: Session = actors.owner,
    target = { prefix, appPath },
  ) =>
    Effect.gen(function* () {
      const { prefix, appPath } = target;
      const connection = yield* body(
        Resource,
        yield* api.request(
          session,
          "POST",
          connectionsPath(appPath, "user", "service"),
          account === undefined ? {} : { account },
        ),
      );
      const started = yield* body(
        Redirect,
        yield* api.request(session, "POST", `${prefix}/connections/${connection.id}/oauth/start`, {
          method: "oauth",
          label: "Reporting",
        }),
      );
      yield* issuer.allowClient({
        clientId,
        clientSecret,
        redirect: started.redirectUri,
      });
      const callbackUrl = yield* Effect.scoped(
        Effect.gen(function* () {
          const response = yield* HttpClient.withScope(http).get(started.authorizationUrl);
          expect(response.status).toBe(302);
          if (response.headers.location === undefined) return yield* Effect.die("Missing callback");
          return response.headers.location;
        }),
      ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
      const response = yield* api.request(
        session,
        "POST",
        `${prefix}/connections/${connection.id}/oauth/complete`,
        { callbackUrl },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const result = yield* body(Resource, response);
      savedAccounts.set(result.id, { session, prefix });
      return result.id;
    });
  const connectInOrganization = (organization: string, session: Session) =>
    Effect.gen(function* () {
      const prefix = `/api/organizations/${organization}`;
      const response = yield* api.request(session, "POST", `${prefix}/apps/deploy`, {
        name: "Tenant reporting",
        files,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const app = yield* body(Resource, response);
      const appPath = `${prefix}/apps/${app.id}`;
      apps.push({ session, path: appPath });
      return yield* connect(undefined, session, { prefix, appPath });
    });
  const account = yield* connect();
  const run = Effect.gen(function* () {
    const since = yield* Clock.currentTimeMillis;
    if (cloud)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const response = yield* http.get(
            `${target.metadata.origin}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("* * * * *")}`,
          );
          expect(response.status).toBeLessThan(400);
          yield* response.text;
        }),
      );
    else yield* serverControl("restart");
    yield* completedReportingRun(since);
    return yield* issuer.metrics;
  });
  return {
    issuer,
    account,
    connect,
    connectInOrganization,
    run,
    api,
    owner: actors.owner,
    peer: actors.admin,
    prefix,
    accountPath: `${prefix}/accounts/${account}`,
  };
});
