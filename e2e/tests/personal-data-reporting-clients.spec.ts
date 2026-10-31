/** Two operator OAuth registrations keep their personal-data reporting state separate. */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect } from "effect";
import { HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { connectionsPath } from "../support/app-accounts.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Telemetry } from "../support/evidence.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import {
  ReportingClientAccountDetail,
  ReportingClientProbe,
  ReportingClientRedirect,
  reportingClientAppSource,
  reportingClientConsent,
  reportingClientDefinition,
  reportingClientScopes,
  reportingRegistrations,
  waitForReportingClientRequests,
  waitForReportingClientRun,
} from "../support/personal-data-reporting-clients.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })(
  "Personal-data reporting client isolation",
  (it) => {
    it.effect(scenarios.personalDataClientIsolation.title, (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const target = yield* Target;
          expect(target.metadata.target).not.toBe("cloud");
          const api = yield* Api;
          const actors = yield* Actors;
          const http = yield* HttpClient.HttpClient;
          const issuer = yield* oauthSetupIssuer;
          const origin = issuer.origin;
          const suffix = randomUUID().replaceAll("-", "");
          const accountId = `e2e-reporting-client-${suffix}`;
          const identityProfile = {
            name: `Reporting privacy marker ${suffix}`,
            email: `reporting-${suffix}@example.test`,
          };
          const clients = {
            one: {
              id: "synthetic-reporting-one",
              clientId: `synthetic-client-one-${suffix}`,
              clientSecret: `synthetic-secret-one-${suffix}`,
            },
            two: {
              id: "synthetic-reporting-two",
              clientId: `synthetic-client-two-${suffix}`,
              clientSecret: `synthetic-secret-two-${suffix}`,
            },
          };

          yield* issuer.configure({
            registration: false,
            refreshTokens: true,
            scopes: reportingClientScopes,
            resourceTokens: "issued",
            reportingAccountId: accountId,
            reportingIdentityProfile: identityProfile,
            reportingSubjectsByGrant: true,
            reportingAction: "none",
            reportingActionsByRegistration: { one: "closed", two: "none" },
          });
          yield* serverControl("stop");
          yield* serverControl("environment", 200, {
            EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: "true",
            EXECUTOR_TEST_OAUTH_CLIENT_DEFINITIONS: JSON.stringify(
              reportingRegistrations.map((registration) =>
                reportingClientDefinition(origin, registration),
              ),
            ),
            EXECUTOR_OAUTH_SYNTHETIC_REPORTING_ONE_CLIENT_ID: clients.one.clientId,
            EXECUTOR_OAUTH_SYNTHETIC_REPORTING_ONE_CLIENT_SECRET: clients.one.clientSecret,
            EXECUTOR_OAUTH_SYNTHETIC_REPORTING_TWO_CLIENT_ID: clients.two.clientId,
            EXECUTOR_OAUTH_SYNTHETIC_REPORTING_TWO_CLIENT_SECRET: clients.two.clientSecret,
          });
          yield* serverControl("start");

          const prefix = `/api/organizations/${actors.organization.id}`;
          const appPaths = new Map<(typeof reportingRegistrations)[number], string>();
          const savedAccounts: string[] = [];
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              for (const appPath of appPaths.values())
                yield* api.request(actors.owner, "DELETE", appPath);
              for (const account of savedAccounts)
                yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
            }).pipe(Effect.orDie),
          );
          for (const registration of reportingRegistrations) {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `Personal-data reporting ${registration}`,
              files: [
                { path: "index.ts", content: reportingClientAppSource(origin, registration) },
                appsManifest,
              ],
            });
            expect(deployed.status).toBe(200);
            const app = yield* body(Resource, deployed);
            appPaths.set(registration, `${prefix}/apps/${app.id}`);
          }

          const connect = (registration: (typeof reportingRegistrations)[number]) =>
            Effect.gen(function* () {
              const client = clients[registration];
              const appPath = appPaths.get(registration)!;
              const connection = yield* body(
                Resource,
                yield* api.request(
                  actors.owner,
                  "POST",
                  connectionsPath(appPath, "user", registration),
                  {},
                ),
              );
              const started = yield* body(
                ReportingClientRedirect,
                yield* api.request(
                  actors.owner,
                  "POST",
                  `${prefix}/connections/${connection.id}/oauth/start`,
                  { method: "oauth", label: `Reporting ${registration}` },
                ),
              );
              const authorization = new URL(started.authorizationUrl);
              expect(authorization.searchParams.get("client_id")).toBe(client.clientId);
              expect(authorization.searchParams.get("scope")?.split(" ")).toEqual(
                expect.arrayContaining(["offline_access", "read:me"]),
              );
              yield* issuer.allowClient({
                clientId: client.clientId,
                clientSecret: client.clientSecret,
                redirect: started.redirectUri,
              });
              const completed = yield* api.request(
                actors.owner,
                "POST",
                `${prefix}/connections/${connection.id}/oauth/complete`,
                { callbackUrl: yield* reportingClientConsent(http, started.authorizationUrl) },
              );
              expect(completed.status).toBe(200);
              const account = (yield* body(Resource, completed)).id;
              savedAccounts.push(account);
              return account;
            });

          const accountOne = yield* connect("one");
          const accountTwo = yield* connect("two");
          const probe = (registration: (typeof reportingRegistrations)[number]) =>
            api.request(actors.owner, "POST", `${appPaths.get(registration)!}/tools/call`, {
              tool: "probe",
              kind: "query",
              input: {},
            });
          expect((yield* body(ReportingClientProbe, yield* probe("one"))).status).toBe(200);
          expect((yield* body(ReportingClientProbe, yield* probe("two"))).status).toBe(200);

          const since = yield* Clock.currentTimeMillis;
          yield* serverControl("restart");
          const metrics = yield* waitForReportingClientRequests(issuer, 2);
          const traceId = yield* waitForReportingClientRun(since);
          expect(metrics.reportingRequests).toHaveLength(2);
          const reports = metrics.reportingRequests.toSorted((a, b) =>
            a.registration.localeCompare(b.registration),
          );
          expect(reports.map((report) => report.registration)).toEqual(["one", "two"]);
          for (const report of reports) {
            expect(report.reporterSubject).toBe(accountId);
            expect(report.accounts).toMatchObject([{ accountId, updatedAt: expect.any(String) }]);
          }

          const closed = yield* body(
            ReportingClientAccountDetail,
            yield* api.request(actors.owner, "GET", `${prefix}/accounts/${accountOne}`),
          );
          expect(closed.health.personalDataStatus).toBe("account_closed");
          expect(closed.health.info).toBeNull();
          const surviving = yield* body(
            ReportingClientAccountDetail,
            yield* api.request(actors.owner, "GET", `${prefix}/accounts/${accountTwo}`),
          );
          expect(surviving.health.personalDataStatus).not.toBe("account_closed");
          expect((yield* probe("one")).status).not.toBe(200);
          expect((yield* body(ReportingClientProbe, yield* probe("two"))).status).toBe(200);

          const telemetry = yield* Telemetry;
          const [trace, logs] = yield* Effect.all([
            telemetry.query(traceId),
            Effect.forEach([accountId, identityProfile.name, identityProfile.email], (value) =>
              telemetry.logs(traceId, value),
            ),
          ]);
          const serialized = JSON.stringify({ trace, logs });
          expect(serialized).not.toContain(accountId);
          expect(serialized).not.toContain(identityProfile.name);
          expect(serialized).not.toContain(identityProfile.email);
          expect(serialized).not.toContain(clients.one.clientSecret);
          expect(serialized).not.toContain(clients.two.clientSecret);
          expect(serialized).not.toMatch(/Bearer\s+synthetic-(?:access|refreshed|refresh)-/u);
        }),
      ),
    );
  },
);
