/** Scheduled reporting uses the stored owner's OAuth grant and clears a closed subject. */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, FileSystem, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { Actors, password } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { connectionsPath } from "../support/app-accounts.ts";
import {
  OperatorOAuthFixture,
  operatorOAuthFile,
  syntheticReportingClient,
} from "../support/operator-oauth.ts";
import { oauthSetupIssuer, oauthSetupIssuerOn } from "../support/oauth-setup-issuer.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import { completedReportingRun } from "../support/personal-data-reporting.ts";
import { scenarios } from "../test-plan.ts";

const reportingScopes = ["mail.read", "offline_access", "read:me"] as const;
const cloudReportingCron = "* * * * *";
const accountId = "e2e-reporting-user";
const updatedAccountId = "e2e-reporting-user-updated";
const closedNotice =
  "This account was closed by its service. Saved credentials and identity were removed.";

const App = Schema.Struct({ id: Schema.String });
const Redirect = Schema.Struct({ authorizationUrl: Schema.String, redirectUri: Schema.String });
const Health = Schema.Struct({
  info: Schema.NullOr(Schema.Unknown),
  personalDataStatus: Schema.optionalKey(Schema.Literal("account_closed")),
});
const Detail = Schema.Struct({ health: Health });
const Probe = Schema.Struct({ status: Schema.Number });
const ReportingMetrics = Schema.Struct({
  refreshes: Schema.Number,
  reportingIdentityRequests: Schema.Number,
  reportingRequests: Schema.Array(
    Schema.Struct({
      accounts: Schema.Array(Schema.Struct({ accountId: Schema.String, updatedAt: Schema.String })),
      refreshed: Schema.Boolean,
    }),
  ),
  resourceRequests: Schema.Struct({ GET: Schema.Number, POST: Schema.Number }),
});

const clientDefinition = (id: string, origin: string) => ({
  id,
  label: "Executor for Synthetic Reporting",
  server: {
    issuer: origin,
    authorizationUrl: `${origin}/authorize`,
    tokenUrl: `${origin}/token`,
  },
  tokenEndpointAuthMethod: "client_secret_basic",
  defaultScopes: reportingScopes,
  allowedScopes: reportingScopes,
  placement: { hosts: [new URL(origin).host] },
  personalDataReporting: {
    identityUrl: `${origin}/me`,
    reportUrl: `${origin}/report-accounts`,
    accountIdField: "accountId",
  },
});

const appSource = (
  origin: string,
) => `import { defineApp, defineProvider, oauth2, object, query, router } from "apps";
const service = defineProvider({
  name: "Synthetic Reporting",
  hosts: [${JSON.stringify(new URL(origin).host)}],
  auth: { oauth: oauth2({
    issuer: ${JSON.stringify(origin)},
    authorizationUrl: ${JSON.stringify(`${origin}/authorize`)},
    tokenUrl: ${JSON.stringify(`${origin}/token`)},
    scopes: ${JSON.stringify(reportingScopes)},
  }) },
  async health() { return {}; },
});
export default defineApp({ user: { accounts: { service } } }, {
  tools: router({ probe: query({ input: object({}) }, async ({ user: { accounts }, fetch, signal }) => {
    const response = await fetch(${JSON.stringify(`${origin}/resource`)}, {
      headers: accounts.service.headers(), signal,
    });
    return { status: response.status };
  }) }),
});`;

/** Follow only the authorization server's redirect; the callback itself is completed through the API. */
const consent = (http: HttpClient.HttpClient, authorizationUrl: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const response = yield* HttpClient.withScope(http).get(authorizationUrl);
      expect(response.status).toBe(302);
      const callbackUrl = response.headers.location;
      if (callbackUrl === undefined)
        return yield* Effect.die("The issuer did not return a callback");
      return callbackUrl;
    }),
  ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));

const waitForReporting = (
  issuer: Effect.Success<typeof oauthSetupIssuer>,
  count: number,
  identities: number,
) =>
  Effect.gen(function* () {
    const metrics = yield* issuer.metrics;
    if (metrics.reportingRequests.length < count || metrics.reportingIdentityRequests < identities)
      return yield* Effect.fail(
        new Error(
          `The scheduled reporting request has not finished (${JSON.stringify({ reports: metrics.reportingRequests.length, identities: metrics.reportingIdentityRequests, refreshes: metrics.refreshes })})`,
        ),
      );
    return yield* Schema.decodeUnknownEffect(ReportingMetrics)(metrics);
  }).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 150 }));

/** Run one scheduled job against Cloud's normal cron trigger. */
const fireCloudReportingCron = Effect.gen(function* () {
  const target = yield* Target;
  const http = yield* HttpClient.HttpClient;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const response = yield* http.get(
        `${target.metadata.origin}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent(cloudReportingCron)}`,
      );
      expect(response.status).toBeLessThan(400);
      yield* response.text;
    }),
  );
});

layer(HostedLive, { excludeTestServices: true })("Personal-data reporting", (it) => {
  it.effect(scenarios.personalDataReporting.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const browser = yield* Browser;
        const target = yield* Target;
        const fs = yield* FileSystem.FileSystem;
        const cloud = target.metadata.target === "cloud";
        let origin: string;
        let clientId: string;
        let clientSecret: string;
        let clientIdName: string;
        let clientSecretName: string;
        let definitionId: string;
        let issuer: Effect.Success<typeof oauthSetupIssuer>;

        if (cloud) {
          const operator = yield* fs
            .readFileString(`${target.directory}/${operatorOAuthFile}`)
            .pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(Schema.fromJsonString(OperatorOAuthFixture)),
              ),
            );
          issuer = yield* oauthSetupIssuerOn(operator.reportingPort);
          origin = `http://127.0.0.1:${operator.reportingPort}`;
          clientId = syntheticReportingClient.clientId;
          clientSecret = syntheticReportingClient.clientSecret;
          definitionId = syntheticReportingClient.id;
          clientIdName = "EXECUTOR_OAUTH_SYNTHETIC_CLOUD_REPORTING_CLIENT_ID";
          clientSecretName = "EXECUTOR_OAUTH_SYNTHETIC_CLOUD_REPORTING_CLIENT_SECRET";
        } else {
          issuer = yield* oauthSetupIssuer;
          origin = issuer.origin;
          clientId = "first-party-client";
          clientSecret = "first-party-secret";
          definitionId = "synthetic-mail";
          clientIdName = "EXECUTOR_OAUTH_SYNTHETIC_MAIL_CLIENT_ID";
          clientSecretName = "EXECUTOR_OAUTH_SYNTHETIC_MAIL_CLIENT_SECRET";
          yield* serverControl("stop");
          yield* serverControl("environment", 200, {
            EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: "true",
            EXECUTOR_TEST_OAUTH_CLIENT_DEFINITIONS: JSON.stringify([
              clientDefinition(definitionId, origin),
            ]),
            [clientIdName]: clientId,
            [clientSecretName]: clientSecret,
          });
        }

        yield* issuer.configure({
          registration: false,
          refreshTokens: true,
          expiresIn: 1,
          scopes: reportingScopes,
          resourceTokens: "issued",
          reportingAccountId: accountId,
          reportingAction: cloud ? "closed" : "updated",
          reportingIdentityFailureOn: cloud ? null : 2,
        });
        if (!cloud) yield* serverControl("start");

        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Personal data reporting",
          files: [{ path: "index.ts", content: appSource(origin) }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const appPath = `${prefix}/apps/${app.id}`;
        let savedAccount: string | undefined;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", appPath);
            if (savedAccount !== undefined)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${savedAccount}`);
          }).pipe(Effect.orDie),
        );

        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", connectionsPath(appPath, "user", "service"), {}),
        );
        const started = yield* body(
          Redirect,
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/oauth/start`,
            { method: "oauth", label: "Reporting" },
          ),
        );
        const requested =
          new URL(started.authorizationUrl).searchParams.get("scope")?.split(" ") ?? [];
        expect(requested).toEqual(expect.arrayContaining(["offline_access", "read:me"]));
        yield* issuer.allowClient({
          clientId,
          clientSecret,
          redirect: started.redirectUri,
        });
        const completed = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/oauth/complete`,
          { callbackUrl: yield* consent(yield* HttpClient.HttpClient, started.authorizationUrl) },
        );
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        savedAccount = (yield* body(Resource, completed)).id;

        const probe = () =>
          api.request(actors.owner, "POST", `${appPath}/tools/call`, {
            tool: "probe",
            kind: "query",
            input: {},
          });
        const connected = yield* body(Probe, yield* probe());
        expect(connected.status).toBe(200);
        const initialResources = (yield* issuer.metrics).resourceRequests.GET;

        if (cloud) {
          yield* fireCloudReportingCron;
          const metrics = yield* waitForReporting(issuer, 1, 1);
          expect(metrics.reportingRequests[0]?.accounts).toMatchObject([
            { accountId, updatedAt: expect.any(String) },
          ]);
          expect(metrics.reportingRequests[0]?.refreshed).toBe(true);
          expect(metrics.refreshes).toBeGreaterThan(0);
        } else {
          const firstRunStarted = yield* Clock.currentTimeMillis;
          yield* serverControl("restart");
          yield* completedReportingRun(firstRunStarted);
          yield* waitForReporting(issuer, 1, 2);
          // A failed identity refresh remains pending for a later run, even with Retry-After: 0.
          const resumedRunStarted = yield* Clock.currentTimeMillis;
          yield* serverControl("restart");
          yield* completedReportingRun(resumedRunStarted);
          const first = yield* waitForReporting(issuer, 1, 3);
          const firstUpdatedAt = first.reportingRequests[0]?.accounts[0]?.updatedAt;
          expect(firstUpdatedAt).toBeDefined();
          expect(first.reportingRequests[0]?.refreshed).toBe(true);
          // The restart resumes the persisted refresh without repeating the successful report.
          expect(first.reportingIdentityRequests).toBe(3);
          expect(first.reportingRequests).toHaveLength(1);

          yield* issuer.configure({
            reportingAccountId: updatedAccountId,
            reportingSubjectsByGrant: false,
            reportingAction: "updated",
            reportingIdentityFailureOn: null,
          });
          yield* serverControl("stop");
          yield* serverControl("clock/advance", 200, { milliseconds: 8 * 86_400_000 });
          const beforeSecondReport = new Date(
            (yield* Clock.currentTimeMillis) + 8 * 86_400_000,
          ).toISOString();
          yield* serverControl("start");
          yield* completedReportingRun(Date.parse(beforeSecondReport));
          const second = yield* waitForReporting(issuer, 2, 4);
          const secondUpdatedAt = second.reportingRequests[1]?.accounts[0]?.updatedAt;
          expect(second.reportingRequests[1]?.accounts).toMatchObject([
            { accountId, updatedAt: expect.any(String) },
          ]);
          expect(second.reportingRequests[1]?.refreshed).toBe(true);
          expect(Date.parse(secondUpdatedAt ?? "")).toBeGreaterThan(
            Date.parse(firstUpdatedAt ?? ""),
          );
          // The due report keeps the last retrieval time; it does not claim the data was fetched today.
          expect(Date.parse(secondUpdatedAt ?? "")).toBeLessThan(Date.parse(beforeSecondReport));

          yield* issuer.configure({ reportingAction: "closed" });
          yield* serverControl("stop");
          yield* serverControl("clock/advance", 200, { milliseconds: 8 * 86_400_000 });
          const beforeThirdReport = new Date(
            (yield* Clock.currentTimeMillis) + 16 * 86_400_000,
          ).toISOString();
          yield* serverControl("start");
          yield* completedReportingRun(Date.parse(beforeThirdReport));
          const third = yield* waitForReporting(issuer, 3, 4);
          const thirdUpdatedAt = third.reportingRequests[2]?.accounts[0]?.updatedAt;
          expect(third.reportingRequests[2]?.accounts).toMatchObject([
            { accountId: updatedAccountId, updatedAt: expect.any(String) },
          ]);
          expect(Date.parse(thirdUpdatedAt ?? "")).toBeGreaterThan(Date.parse(beforeSecondReport));
          expect(Date.parse(thirdUpdatedAt ?? "")).toBeLessThan(Date.parse(beforeThirdReport));
          expect(
            third.reportingRequests
              .slice(2)
              .flatMap((request) => request.accounts.map((account) => account.accountId)),
          ).toEqual([updatedAccountId]);

          // Advancing beyond the reporting cycles expires the owner's browser session.
          const signedIn = yield* api.request(actors.owner, "POST", "/api/auth/sign-in/email", {
            email: "owner@example.test",
            password,
          });
          expect(signedIn.status).toBe(200);
        }

        const closed = yield* body(
          Detail,
          yield* api.request(actors.owner, "GET", `${prefix}/accounts/${savedAccount}`),
        );
        expect(closed.health.personalDataStatus).toBe("account_closed");
        expect(closed.health.info).toBeNull();
        const afterClose = yield* probe();
        expect((yield* issuer.metrics).resourceRequests.GET).toBe(initialResources);
        expect(afterClose.status).not.toBe(200);

        yield* browser.login(actors.owner);
        yield* browser.use("Open the accounts list", (page) =>
          page
            .goto(`/org/${actors.organization.slug}/accounts`)
            .then(() => page.getByRole("button", { name: "Manage Closed account" }).waitFor()),
        );
        yield* browser.use("Open the closed account's health", (page) =>
          page
            .getByRole("button", { name: "Manage Closed account" })
            .click()
            .then(() => page.getByRole("menuitem", { name: "Check health" }).click()),
        );
        const notice = yield* browser.use("Read the owner-facing closure notice", (page) => {
          const notice = page.getByRole("status").filter({ hasText: closedNotice });
          return notice.waitFor().then(() => notice.innerText());
        });
        expect(notice).toContain(closedNotice);
      }),
    ),
  );
});
