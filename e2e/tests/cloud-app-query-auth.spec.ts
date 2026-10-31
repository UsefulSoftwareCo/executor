import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors, freshOwnerSession } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { targetHosts } from "../support/role-hosts.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({ id: Schema.String, activeVersion: Schema.String });
const Location = Schema.Struct({ status: Schema.Literal("ready"), url: Schema.String });
const Answer = Schema.fromJsonString(Schema.Struct({ answer: Schema.Int }));

layer(HostedLive, { excludeTestServices: true })("Cloud app query authorization", (it) => {
  it.effect(scenarios.cloudAppQueryAuth.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          client = yield* HttpClient.HttpClient,
          telemetry = yield* Telemetry,
          evidence = yield* Evidence;
        const session = yield* freshOwnerSession;
        const dashboard = targetHosts(yield* Target).browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const app = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Query authorization ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, query, object, router } from "apps";
export default defineApp({}, async () => ({ tools: router({
  hello: query({ input: object({}) }, async () => ({ answer: 42 })),
}) }));`,
              },
              { path: "ui/index.html", content: "<!doctype html><title>Query</title><p>Query</p>" },
              appsManifest,
            ],
          }),
        );
        yield* Effect.addFinalizer(() =>
          api.request(actors.admin, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const location = yield* body(
          Location,
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/ui`),
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
        for (let redirects = 0; redirects < 6; redirects++) {
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
          if (origin === appOrigin && response.status === 200) {
            opened = true;
            break;
          }
          expect(response.status).toBe(302);
          expect(response.location).toBeDefined();
          url = new URL(response.location!, url).href;
        }
        expect(opened).toBe(true);
        const query = (trace: string) =>
          HttpClientRequest.post(`${appOrigin}/_executor/api/query`).pipe(
            HttpClientRequest.setHeaders({
              origin: appOrigin,
              cookie: [...appCookies].map(([name, value]) => `${name}=${value}`).join("; "),
              traceparent: `00-${trace}-${trace.slice(0, 16)}-01`,
              "sec-fetch-site": "same-origin",
            }),
            HttpClientRequest.bodyJson({ version: app.activeVersion, name: "hello", input: {} }),
            Effect.flatMap(send),
            Effect.provideService(HttpClient.TracerPropagationEnabled, false),
          );
        for (const label of ["first", "warm"]) {
          const trace = randomUUID().replaceAll("-", "");
          const response = yield* query(trace);
          expect(response.status).toBe(200);
          expect(yield* Schema.decodeUnknownEffect(Answer)(response.text)).toEqual({ answer: 42 });
          const spans = yield* telemetry.query(trace).pipe(
            Effect.flatMap((result) =>
              result.data.some(({ span }) => span.operationName === "runtime.cloud.query") &&
              result.data.filter(({ span }) => span.operationName === "auth.sql.timing").length >= 3
                ? Effect.succeed(result.data)
                : Effect.fail(new Error("The completed app query trace has not reached Motel")),
            ),
            Effect.retry({ schedule: Schedule.spaced("1 second"), times: 40 }),
          );
          const auth = spans
            .filter(({ span }) => span.operationName === "auth.sql.timing")
            .map(({ span }) => ({
              kind: span.tags["db.query.kind"],
              table: span.tags["db.collection.name"],
            }));
          yield* evidence.json(`${label}-authorization-reads.json`, auth);
          expect(auth).toHaveLength(3);
          expect(auth.every(({ kind }) => kind === "SelectQueryNode")).toBe(true);
        }
        const signedOut = yield* api.request(session, "POST", "/api/auth/sign-out", {});
        expect(signedOut.status).toBe(200);
        expect((yield* query(randomUUID().replaceAll("-", ""))).status).toBe(401);
      }),
    ),
  );
});
