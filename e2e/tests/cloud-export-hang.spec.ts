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
import { holdExports, receivedSpans, refuseExports, watchTrace } from "../support/held-exports.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Target } from "../support/platform.ts";
import { targetHosts } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";

const source = `import { defineApp, number, object, query, router } from "apps";
export default defineApp({}, async () => ({
  tools: router({
    slow: query({ input: object({ ms: number() }) }, async (_ctx, { ms }) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { waited: ms };
    }),
  }),
}));`;

const drainMs = 3_000;
const toolMs = 800;

const App = Schema.Struct({ id: Schema.String, slug: Schema.String, activeVersion: Schema.String });
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

          const pat = yield* body(
            Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String }),
            yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
              name: "Export hang",
            }),
          );
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: pat.id })
              .pipe(Effect.orDie),
          );
          const mcpClient = yield* (yield* McpClient).connect(pat.key, "export-hang", {
            organization: actors.organization.id,
          });
          const program = `return await tools[${JSON.stringify(app.slug)}].slow({ ms: 0 })`;
          const execute = (label: string) =>
            Effect.gen(function* () {
              const started = performance.now();
              const result = yield* mcpClient.use(label, (client, signal) =>
                client.callTool({ name: "execute", arguments: { code: program } }, undefined, {
                  signal,
                }),
              );
              const tookMs = performance.now() - started;
              expect(result.structuredContent, label).toMatchObject({
                status: "completed",
                execution: { ok: true },
              });
              const trace = (yield* evidence.requests)
                .filter((request) => request.path === "/mcp")
                .at(-1)?.traceId;
              if (trace === undefined) return yield* Effect.die("MCP request evidence missing");
              return { tookMs, trace };
            });
          yield* watchTrace("*");
          const answered = [
            yield* execute("A program while exports are answered"),
            yield* execute("Another program while exports are answered"),
          ];
          const normalMs = Math.max(...answered.map(({ tookMs }) => tookMs));
          const hung = yield* Effect.scoped(
            Effect.gen(function* () {
              yield* holdExports;
              return [
                yield* execute("A program while the endpoint hangs"),
                yield* execute("Another program while the endpoint hangs"),
              ];
            }),
          );
          for (const { trace } of [...answered, ...hung])
            yield* telemetry.query(trace).pipe(
              Effect.filterOrFail(
                (found) => found.data.some(({ span }) => span.operationName === "mcp.tool.call"),
                () => new Error("The program's spans have not reached the collector"),
              ),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
            );
          const received = yield* receivedSpans("*");
          yield* evidence.json("cloud-export-hang-mcp.json", { answered, hung, received });
          for (const { tookMs } of hung)
            expect(tookMs, "The result does not wait for the export's retries").toBeLessThan(
              normalMs + 2_000,
            );
          expect(received.spans, "The collector counted the programs' spans").toBeGreaterThan(0);
          expect(received.duplicated, "No span was exported twice").toBe(0);

          const exportBudgetMs = 27_000;
          const arrives = <R>(label: string, trouble: Effect.Effect<void, never, R>) =>
            Effect.gen(function* () {
              const run = yield* Effect.scoped(
                Effect.gen(function* () {
                  yield* trouble;
                  const answered = yield* execute(label);
                  return { ...answered, at: performance.now() };
                }),
              );
              yield* telemetry.query(run.trace).pipe(
                Effect.filterOrFail(
                  (found) => found.data.some(({ span }) => span.operationName === "mcp.tool.call"),
                  () => new Error("The program's spans have not reached the collector"),
                ),
                Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 80 }),
              );
              return { tookMs: run.tookMs, arrivedMs: performance.now() - run.at };
            });
          const afterHang = yield* arrives(
            "A program while the endpoint hangs for twelve seconds",
            Effect.andThen(
              holdExports,
              Effect.addFinalizer(() => Effect.sleep("12 seconds")),
            ),
          );
          const afterRetryAfter = yield* arrives(
            "A program while the collector asks for a 30 s Retry-After",
            Effect.andThen(
              refuseExports(30),
              Effect.addFinalizer(() => Effect.sleep("3 seconds")),
            ),
          );
          yield* evidence.json("cloud-export-hang-budget.json", { afterHang, afterRetryAfter });
          for (const timing of [afterHang, afterRetryAfter]) {
            expect(timing.arrivedMs, "The spans arrive within the export's budget").toBeLessThan(
              exportBudgetMs + 500,
            );
            expect(timing.tookMs, "The result does not wait for the export").toBeLessThan(
              normalMs + 2_000,
            );
          }

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
              yield* Effect.sleep(drainMs * 2);
              return calls;
            }),
          );
          yield* evidence.json("cloud-export-hang.json", { warm, held });
          const reports = yield* telemetry.logsWholeEnvironment("executor.request.close").pipe(
            Effect.map((logs) =>
              Schema.decodeUnknownSync(LogRecords)(logs).data.filter(
                (record) => record.body === "executor.request.close",
              ),
            ),
            Effect.filterOrFail(
              (records) => records.length >= held.length,
              () => new Error("The held calls' close reports have not reached the collector"),
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
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 240_000 },
  );
});
