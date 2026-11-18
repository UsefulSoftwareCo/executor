/**
 * Requests that reach an app's data supervisor as it resets itself are sent once more and run
 * once. The run holds a supervisor's incoming requests for a moment before it resets
 * (`EXECUTOR_TEST_SUPERVISOR_RESET_HOLD_MS`, e2e only), so a request sent then is accepted but
 * cannot start, and the reset meets it every time. With an app Worker limit of one, a call to app
 * B unloads app A's facet and starts A's held reset; what is sent to A during the hold meets it:
 * a write, a change subscription, and the cache traffic of listing A's tools.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schedule, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

// Its definition writes the app cache: listing its tools runs it in the app's Worker, outside the
// data facet, so that cache traffic goes to the app's data supervisor on its own.
const source = `import { defineApp, query, mutation, router, object, number } from "apps";
export default defineApp({}, async (ctx) => {
  await ctx.cache.write([{ key: "listed", value: Date.now() }], "1 minute");
  return {
    tools: router({
      count: query({ input: object({}), output: number() }, async ({ sql }) => sql.exec("SELECT n FROM counter").one().n),
      add: mutation({ input: object({}), output: number() }, async ({ sql }) => {
        sql.exec("UPDATE counter SET n = n + 1");
        return sql.exec("SELECT n FROM counter").one().n;
      }),
    }),
  };
});`;
const migration = {
  path: "migrations/0001_counter.sql",
  content: "CREATE TABLE counter (n INTEGER NOT NULL);\nINSERT INTO counter (n) VALUES (0);\n",
};
const Deployed = Schema.Struct({ app: Schema.Struct({ id: Schema.String }) });
const Counted = Schema.Struct({ status: Schema.Literal("completed"), value: Schema.Number });

layer(TestLive, { excludeTestServices: true })("App data reset resend", (it) => {
  it.effect(
    scenarios.appDataResetResend.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api;
          const target = yield* Target;
          const telemetry = yield* Telemetry;
          const http = yield* HttpClient.HttpClient;
          const session = yield* api.session();
          const bearer = `Bearer ${Redacted.value(target.apiKey)}`;
          const agent: Session = {
            ...session,
            send: (method, path, data, headers = {}) => {
              const { origin: _origin, ...rest } = headers;
              return session.send(method, path, data, { ...rest, authorization: bearer });
            },
          };
          const run = randomUUID().slice(0, 6);
          const deploy = (name: string) =>
            Effect.flatMap(
              api.request(agent, "POST", "/v1/apps/deploy", {
                owner: "local",
                name: `Resend ${run} ${name}`,
                files: [{ path: "index.ts", content: source }, appsManifest, migration],
              }),
              (response) => {
                expect(response.status, JSON.stringify(response.body).slice(0, 800)).toBe(200);
                return Effect.map(body(Deployed, response), (deployed) => deployed.app.id);
              },
            );
          const a = yield* deploy("a");
          const b = yield* deploy("b");
          for (const app of [a, b])
            yield* Effect.addFinalizer(() =>
              api.request(agent, "DELETE", `/v1/apps/${app}`).pipe(Effect.ignore),
            );
          const call = (app: string, tool: string, kind: "query" | "mutation") =>
            Effect.flatMap(
              api.request(agent, "POST", "/v1/tools/call", { app, tool, kind, input: {} }),
              (response) => {
                expect(
                  response.status,
                  `${tool}: ${JSON.stringify(response.body).slice(0, 400)}`,
                ).toBe(200);
                return Effect.map(body(Counted, response), (counted) => counted.value);
              },
            );
          const resentSpans = telemetry.spans(
            "runtime.workerd.call",
            { app: a },
            { "executor.runtime.resent": "true" },
          );

          // 1. A call: A's facet loads, B's call unloads it and starts A's held reset, and the
          // next call to A arrives during the hold.
          expect(yield* call(a, "add", "mutation")).toBe(1);
          yield* call(b, "count", "query");
          expect(yield* call(a, "add", "mutation"), "the resent write ran once").toBe(2);
          const resent = yield* resentSpans.pipe(
            Effect.flatMap((spans) =>
              spans.length > 0 ? Effect.succeed(spans) : Effect.fail("No resent call reported yet"),
            ),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
          );
          expect(resent.length, "exactly one call met the reset").toBe(1);
          expect(yield* call(a, "count", "query"), "each write ran once").toBe(2);

          // 2. A change subscription opened during A's held reset still delivers A's changes.
          yield* call(b, "count", "query");
          const values: Array<number> = [];
          const request = HttpClientRequest.post(
            `${target.metadata.origin}/v1/app-data/subscribe`,
          ).pipe(
            HttpClientRequest.setHeader("authorization", bearer),
            HttpClientRequest.bodyJsonUnsafe({ app: a, name: "count", input: {} }),
          );
          const response = yield* http.execute(request);
          expect(response.status, "the subscription opens").toBe(200);
          const read = yield* response.stream.pipe(
            Stream.decodeText(),
            Stream.map((text: string) =>
              [...text.matchAll(/"value":(\d+)/g)].map((match) => Number(match[1])),
            ),
            Stream.flattenIterable,
            Stream.tap((value) =>
              Effect.gen(function* () {
                values.push(value);
                // The first value is the current count; a write after it must arrive as a change.
                if (values.length === 1) yield* Effect.forkChild(call(a, "add", "mutation"));
              }),
            ),
            Stream.take(2),
            Stream.runDrain,
            // The first value comes as the 10 s hold ends; the subscription's own re-read would
            // come 15 s after it, so only the change signal delivers the second value in time.
            Effect.timeout("14 seconds"),
            Effect.scoped,
            Effect.result,
          );
          yield* Effect.logInfo(
            `APP_DATA_RESET_RESEND ${JSON.stringify({ resent: resent.length, values })}`,
          );
          expect(read._tag, `the subscription delivered ${JSON.stringify(values)}`).toBe("Success");
          expect(values).toEqual([2, 3]);

          // 3. Listing A's tools during A's held reset: its definition's cache write meets the
          // reset and is sent again. Give the closed subscription's socket time to close first.
          yield* Effect.sleep("2 seconds");
          yield* call(b, "count", "query");
          const index = yield* api.request(agent, "GET", `/v1/tools/index?app=${a}`);
          expect(index.status, JSON.stringify(index.body).slice(0, 600)).toBe(200);
        }),
      ),
    { timeout: 180_000 },
  );
});
