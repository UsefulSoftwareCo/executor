/**
 * A data supervisor resets itself after the app Worker limit unloads its facet only when it has
 * nothing to lose. The run delays each reset's checks with its input open
 * (`EXECUTOR_TEST_SUPERVISOR_RESET_DELAY_MS`, e2e only), so other work for the app can be running
 * at them on purpose: a page's change socket, a call in its facet, or a call that has left the
 * facet and is waiting on its reply. With an app Worker limit of one, a call to app B unloads app A's facet
 * and starts A's delayed reset.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Redacted, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

/** Longer than the reset's delay (ten seconds), so the work is still running at its checks. */
const slow = 13_000;
const source = `import { defineApp, query, mutation, router, object, number } from "apps";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export default defineApp({}, {
  tools: router({
    count: query({ input: object({}), output: number() }, async ({ sql }) => sql.exec("SELECT n FROM counter").one().n),
    add: mutation({ input: object({}), output: number() }, async ({ sql }) => {
      sql.exec("UPDATE counter SET n = n + 1");
      return sql.exec("SELECT n FROM counter").one().n;
    }),
    // Writes, then stays in the facet past the reset's checks.
    slowAdd: mutation({ input: object({}), output: number() }, async ({ sql }) => {
      sql.exec("UPDATE counter SET n = n + 1");
      await pause(${slow});
      return sql.exec("SELECT n FROM counter").one().n;
    }),
  }),
});`;
const migration = {
  path: "migrations/0001_counter.sql",
  content: "CREATE TABLE counter (n INTEGER NOT NULL);\nINSERT INTO counter (n) VALUES (0);\n",
};
const Deployed = Schema.Struct({ app: Schema.Struct({ id: Schema.String }) });
const Answered = Schema.Struct({ status: Schema.Literal("completed"), value: Schema.Number });

/** Two apps with a database, and calls to them as the scenario's agent. */
const twoApps = Effect.gen(function* () {
  const api = yield* Api;
  const target = yield* Target;
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
        name: `Reset idle ${run} ${name}`,
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
        expect(response.status, `${tool}: ${JSON.stringify(response.body).slice(0, 400)}`).toBe(
          200,
        );
        return Effect.map(body(Answered, response), (answered) => answered.value);
      },
    );
  /** Load B's facet, which unloads A's and starts A's delayed reset. */
  const unloadA = call(b, "count", "query");
  return { a, call, unloadA, bearer, origin: target.metadata.origin };
});

layer(TestLive, { excludeTestServices: true })("App data reset idle", (it) => {
  it.effect(
    scenarios.appDataResetKeepsPage.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const { a, call, unloadA, bearer, origin } = yield* twoApps;
          const http = yield* HttpClient.HttpClient;
          expect(yield* call(a, "add", "mutation")).toBe(1);
          const values: Array<number> = [];
          const read = yield* http
            .execute(
              HttpClientRequest.post(`${origin}/v1/app-data/subscribe`).pipe(
                HttpClientRequest.setHeader("authorization", bearer),
                HttpClientRequest.bodyJsonUnsafe({ app: a, name: "count", input: {} }),
              ),
            )
            .pipe(
              Effect.flatMap((response) =>
                response.stream.pipe(
                  Stream.decodeText(),
                  Stream.map((text: string) =>
                    [...text.matchAll(/"value":(\d+)/g)].map((match) => Number(match[1])),
                  ),
                  Stream.flattenIterable,
                  Stream.tap((value) =>
                    Effect.gen(function* () {
                      values.push(value);
                      if (values.length > 1) return;
                      // With A's page open, unload A's facet, wait past its reset's checks, write.
                      yield* Effect.forkChild(
                        Effect.gen(function* () {
                          yield* unloadA;
                          yield* Effect.sleep("11 seconds");
                          yield* call(a, "add", "mutation");
                        }),
                      );
                    }),
                  ),
                  Stream.take(2),
                  Stream.runDrain,
                ),
              ),
              // A's write lands 11 s after the first value; the subscription's own re-read would
              // come at 15 s, so only the change signal delivers it in time.
              Effect.timeout("14 seconds"),
              Effect.scoped,
              Effect.result,
            );
          yield* Effect.logInfo(`APP_DATA_RESET_KEEPS_PAGE ${JSON.stringify(values)}`);
          expect(read._tag, `the page's stream delivered ${JSON.stringify(values)}`).toBe(
            "Success",
          );
          expect(values).toEqual([1, 2]);
        }),
      ),
    { timeout: 120_000 },
  );

  it.effect(
    scenarios.appDataResetKeepsCall.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const { a, call, unloadA } = yield* twoApps;
          expect(yield* call(a, "add", "mutation")).toBe(1);
          yield* unloadA;
          // In A's facet at its reset's checks, ten seconds from now, after its write.
          expect(yield* call(a, "slowAdd", "mutation"), "the slow write ran once").toBe(2);
          expect(yield* call(a, "count", "query"), "each write ran once").toBe(2);
        }),
      ),
    { timeout: 120_000 },
  );
  it.effect(
    scenarios.appDataResetKeepsLateCall.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const { a, call, unloadA } = yield* twoApps;
          expect(yield* call(a, "add", "mutation")).toBe(1);
          // The run holds every call's reply 15 s after it leaves the facet
          // (`EXECUTOR_TEST_SUPERVISOR_REPLY_DELAY_MS`), as a reply waits on its object's output
          // gate. B's call unloads A's facet; a write to A sent after that unload has run, left
          // the facet and is still waiting on its reply at A's reset's checks, ten seconds on.
          const other = yield* Effect.forkChild(unloadA);
          yield* Effect.sleep("2 seconds");
          expect(yield* call(a, "add", "mutation"), "the late write ran once").toBe(2);
          yield* Fiber.join(other);
          expect(yield* call(a, "count", "query"), "each write ran once").toBe(2);
        }),
      ),
    { timeout: 180_000 },
  );
});
