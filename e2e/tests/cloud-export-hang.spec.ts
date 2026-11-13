/**
 * A Cloud request never holds its database connections while it waits on a telemetry endpoint.
 * The scenario holds every export this local Cloud sends, as an export endpoint that hangs, and
 * runs an app's tool from the API and from the app's own page. While each call runs, the event's
 * connections are open: they carry its reads, and the scenario sees them. Each call answers as
 * before, and its connections close once its own work is done, long before the app telemetry it
 * forwards gives up on the endpoint (three seconds). A request that waited on that telemetry
 * before releasing its pool kept its connections open the whole three seconds. Each held call's
 * close report says that its telemetry wait reached its bound, and that it was the forwarder's
 * drain.
 *
 * Holding exports affects every scenario of the Cloud, so this one runs on a local Cloud of its
 * own (`cloud-export-hang` in e2e/ci-selection.ts).
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Redacted, Ref, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors, freshOwnerSession } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { cloudLocks } from "../support/cloud-locks.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { holdExports } from "../support/held-exports.ts";
import { Target } from "../support/platform.ts";
import { targetHosts } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";

/** `slow` answers after `ms` milliseconds, so its call's connections stay open long enough to see. */
const source = `import { defineApp, number, object, query, router } from "apps";
export default defineApp({}, async () => ({
  tools: router({
    slow: query({ input: object({ ms: number() }) }, async (_ctx, { ms }) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { waited: ms };
    }),
  }),
}));`;

/** How long the forwarded app telemetry waits for the endpoint before it gives up. */
const drainMs = 3_000;
/** How long each call's tool runs. */
const toolMs = 800;

const App = Schema.Struct({ id: Schema.String, activeVersion: Schema.String });
const Location = Schema.Struct({ status: Schema.Literal("ready"), url: Schema.String });
const Count = Schema.Array(Schema.Struct({ n: Schema.Number }));
const LogRecords = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        body: Schema.String,
        attributes: Schema.Record(Schema.String, Schema.Unknown),
      }),
    ),
  }),
);

layer(HostedLive, { excludeTestServices: true })("Cloud export hang", (it) => {
  it.effect(
    scenarios.cloudExportHang.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            evidence = yield* Evidence,
            telemetry = yield* Telemetry,
            client = yield* HttpClient.HttpClient,
            locks = yield* cloudLocks;
          const session = yield* freshOwnerSession;
          const dashboard = targetHosts(yield* Target).browser;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const app = yield* body(
            App,
            yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `Export hang ${randomUUID().slice(0, 8)}`,
              files: [
                { path: "index.ts", content: source },
                { path: "ui/index.html", content: "<!doctype html><title>Hang</title><p>Hang</p>" },
                appsManifest,
              ],
            }),
          );
          const path = `${prefix}/apps/${app.id}`;
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
          );

          // The app's page: follow its sign-in to a session on the app's origin, as a browser does.
          const location = yield* body(
            Location,
            yield* api.request(actors.owner, "GET", `${path}/ui`),
          );
          const appOrigin = new URL(location.url).origin;
          const dashboardCookies = Redacted.value(yield* session.cookies)
            .map(({ name, value }) => `${name}=${value}`)
            .join("; ");
          const appCookies = new Map<string, string>();
          const send = (request: HttpClientRequest.HttpClientRequest) =>
            Effect.scoped(
              client.execute(request).pipe(
                Effect.flatMap((response) =>
                  response.text.pipe(
                    Effect.map((text) => ({
                      status: response.status,
                      location: response.headers.location,
                      cookies: response.cookies,
                      text,
                    })),
                  ),
                ),
              ),
            ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
          let url = location.url;
          let opened = false;
          for (let redirects = 0; redirects < 6 && !opened; redirects++) {
            const origin = new URL(url).origin;
            expect([appOrigin, dashboard]).toContain(origin);
            const response = yield* send(
              HttpClientRequest.get(url).pipe(
                HttpClientRequest.setHeaders({
                  accept: "text/html",
                  "sec-fetch-mode": "navigate",
                  cookie:
                    origin === dashboard
                      ? dashboardCookies
                      : [...appCookies].map(([name, value]) => `${name}=${value}`).join("; "),
                }),
              ),
            );
            if (origin === appOrigin)
              for (const cookie of Object.values(response.cookies.cookies))
                appCookies.set(cookie.name, cookie.valueEncoded);
            if (origin === appOrigin && response.status === 200) opened = true;
            else {
              expect(response.status).toBe(302);
              url = new URL(response.location!, url).href;
            }
          }
          expect(opened, "The app's page opened").toBe(true);

          /** The Worker events' own database connections, apart from session objects' pools. */
          const eventConnections = locks
            .run({
              sql: "select count(*)::int as n from pg_stat_activity where application_name = 'executor event'",
            })
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Count)),
              Effect.map((rows) => rows[0]?.n ?? 0),
              Effect.orDie,
            );
          const fromApi = api
            .request(actors.owner, "POST", `${path}/tools/call`, {
              tool: "slow",
              kind: "query",
              input: { ms: toolMs },
            })
            .pipe(Effect.map((response) => response.status));
          const fromPage = HttpClientRequest.post(`${appOrigin}/_executor/api/query`).pipe(
            HttpClientRequest.setHeaders({
              origin: appOrigin,
              cookie: [...appCookies].map(([name, value]) => `${name}=${value}`).join("; "),
              "sec-fetch-site": "same-origin",
            }),
            HttpClientRequest.bodyJson({
              version: app.activeVersion,
              name: "slow",
              input: { ms: toolMs },
            }),
            Effect.flatMap(send),
            Effect.map((response) => response.status),
          );
          /**
           * Make one call; return how long it took to answer, the most event connections open while
           * it ran, and how long its connections took to close after its answer.
           */
          const call = (label: string, request: Effect.Effect<number, unknown>) =>
            evidence.step(
              label,
              Effect.gen(function* () {
                const most = yield* Ref.make(0);
                const watching = yield* Effect.forkChild(
                  eventConnections.pipe(
                    Effect.flatMap((open) => Ref.update(most, (seen) => Math.max(seen, open))),
                    Effect.repeat(Schedule.spaced("25 millis")),
                  ),
                );
                const started = performance.now();
                const status = yield* request.pipe(Effect.orDie);
                const answeredMs = performance.now() - started;
                yield* Fiber.interrupt(watching);
                expect(status, label).toBe(200);
                const answered = performance.now();
                yield* eventConnections.pipe(
                  Effect.filterOrFail(
                    (open) => open === 0,
                    () => new Error("The event's connections are still open"),
                  ),
                  Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 400 }),
                );
                return {
                  answeredMs,
                  openWhileRunning: yield* Ref.get(most),
                  releasedMs: performance.now() - answered,
                };
              }),
            );

          const warm = [
            yield* call("A call from the API while exports are answered", fromApi),
            yield* call("A call from the app's page while exports are answered", fromPage),
          ];
          const held = yield* Effect.scoped(
            Effect.gen(function* () {
              yield* holdExports;
              const calls = [];
              for (const n of [1, 2]) {
                calls.push({
                  from: "api",
                  ...(yield* call(`Call ${n} from the API while the endpoint hangs`, fromApi)),
                });
                calls.push({
                  from: "page",
                  ...(yield* call(
                    `Call ${n} from the app's page while the endpoint hangs`,
                    fromPage,
                  )),
                });
              }
              // The endpoint stays hung past the forwarder's bound, so every held call's drain
              // reaches it before the endpoint answers again.
              yield* Effect.sleep(drainMs);
              return calls;
            }),
          );
          yield* evidence.json("cloud-export-hang.json", { warm, held });
          // Each held call waited out its forwarder's bound, and its close report, exported once the
          // endpoint answers again, says so. A close runs after its request's span has ended, so
          // its report carries no trace; this Cloud serves only this scenario, so every report on
          // its collector is one of these calls'.
          const reports = yield* telemetry.logsWholeEnvironment("executor.request.close").pipe(
            Effect.map((logs) =>
              Schema.decodeUnknownSync(LogRecords)(logs).data.filter(
                (record) => record.body === "executor.request.close",
              ),
            ),
            Effect.filterOrFail(
              (records) => records.length >= held.length,
              () => new Error("The held calls' close reports have not reached Motel"),
            ),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
          );
          yield* evidence.json(
            "close-reports.json",
            reports.map((record) => record.attributes),
          );
          const forwarderBounded = reports.filter(
            (record) =>
              String(record.attributes["executor.close.bounded"]).includes("telemetry") &&
              String(record.attributes["executor.close.telemetry_bounded"]).includes("forwarder"),
          );
          expect(
            forwarderBounded.length,
            "Each held call's report says its forwarder's drain reached its bound",
          ).toBeGreaterThanOrEqual(held.length);
          for (const timing of [...warm, ...held])
            expect(
              timing.openWhileRunning,
              "The call's event connections were seen open",
            ).toBeGreaterThan(0);
          for (const timing of held) {
            expect(timing.answeredMs, `A ${timing.from} call answers as before`).toBeLessThan(
              toolMs + drainMs,
            );
            expect(
              timing.releasedMs,
              `A ${timing.from} call's connections close before its telemetry gives up`,
            ).toBeLessThan(drainMs / 2);
          }
        }),
      ),
    { timeout: 180_000 },
  );
});
