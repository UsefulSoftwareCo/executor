/** E2E fixture for two operator OAuth registrations reporting the same external subject. */
import { expect } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { Telemetry } from "./evidence.ts";
import { oauthSetupIssuer } from "./oauth-setup-issuer.ts";

export const reportingClientScopes = ["mail.read", "offline_access", "read:me"] as const;
export const reportingRegistrations = ["one", "two"] as const;

const endpoint = (origin: string, path: string, registration: string) =>
  `${origin}/${path}?registration=${registration}`;

export const reportingClientDefinition = (
  origin: string,
  registration: (typeof reportingRegistrations)[number],
) => ({
  id: `synthetic-reporting-${registration}`,
  label: `Executor for Synthetic Reporting ${registration}`,
  server: {
    issuer: origin,
    authorizationUrl: endpoint(origin, "authorize", registration),
    tokenUrl: endpoint(origin, "token", registration),
  },
  tokenEndpointAuthMethod: "client_secret_basic",
  defaultScopes: reportingClientScopes,
  allowedScopes: reportingClientScopes,
  placement: { hosts: [new URL(origin).host] },
  personalDataReporting: {
    identityUrl: endpoint(origin, "me", registration),
    reportUrl: endpoint(origin, "report-accounts", registration),
    accountIdField: "accountId",
  },
});

export const reportingClientAppSource = (
  origin: string,
  registration: (typeof reportingRegistrations)[number],
) => {
  const host = JSON.stringify(new URL(origin).host);
  const provider = (registration: (typeof reportingRegistrations)[number]) => `
const ${registration} = defineProvider({
  name: "Synthetic Reporting ${registration}",
  hosts: [${host}],
  auth: { oauth: oauth2({
    issuer: ${JSON.stringify(origin)},
    authorizationUrl: ${JSON.stringify(endpoint(origin, "authorize", registration))},
    tokenUrl: ${JSON.stringify(endpoint(origin, "token", registration))},
    scopes: ${JSON.stringify(reportingClientScopes)},
  }) },
  async health() { return {}; },
});`;
  const probe = (registration: (typeof reportingRegistrations)[number]) => `
    probe: query(
      { input: object({}) },
      async ({ user: { accounts }, fetch, signal }) => {
        const response = await fetch(${JSON.stringify(`${origin}/resource`)}, {
          headers: accounts.${registration}.headers(),
          signal,
        });
        return { status: response.status };
      },
    ),`;
  return `import { defineApp, defineProvider, oauth2, object, query, router } from "apps";
${provider(registration)}

export default defineApp({ user: { accounts: { ${registration} } } }, {
  tools: router({${probe(registration)}
  }),
});`;
};

export const ReportingClientRedirect = Schema.Struct({
  authorizationUrl: Schema.String,
  redirectUri: Schema.String,
});
export const ReportingClientProbe = Schema.Struct({ status: Schema.Number });
export const ReportingClientHealth = Schema.Struct({
  info: Schema.NullOr(Schema.Unknown),
  personalDataStatus: Schema.optionalKey(Schema.Literal("account_closed")),
});
export const ReportingClientAccountDetail = Schema.Struct({ health: ReportingClientHealth });

const ReportingMetrics = Schema.Struct({
  reportingRequests: Schema.Array(
    Schema.Struct({
      registration: Schema.String,
      reporterSubject: Schema.String,
      refreshed: Schema.Boolean,
      accounts: Schema.Array(Schema.Struct({ accountId: Schema.String, updatedAt: Schema.String })),
    }),
  ),
});

export const reportingClientConsent = (http: HttpClient.HttpClient, authorizationUrl: string) =>
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

export const waitForReportingClientRequests = (
  issuer: Effect.Success<typeof oauthSetupIssuer>,
  count: number,
) =>
  Effect.gen(function* () {
    const metrics = yield* issuer.metrics;
    if (metrics.reportingRequests.length < count)
      return yield* Effect.fail(new Error("Both OAuth registrations have not reported yet"));
    return yield* Schema.decodeUnknownEffect(ReportingMetrics)(metrics);
  }).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 150 }));

export const waitForReportingClientRun = (since: number) =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;
    const found = yield* telemetry.search("sdk.personalDataReporting.run", {});
    const run = found.data.find(
      ({ span }) =>
        Date.parse(span.startTime) >= since &&
        span.tags["executor.personal_data_reporting.report_count"] !== undefined,
    );
    if (run === undefined)
      return yield* Effect.fail(new Error("The reporting run span has not arrived"));
    return run.traceId;
  }).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 150 }));
