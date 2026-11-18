/**
 * A data supervisor's reset after one unload is not undone by a later unload. One app is used
 * with three account selections, and each selection's data Worker is held and unloaded on its
 * own by the app Worker limit (two here). The run delays each reset's checks with the input open
 * (`EXECUTOR_TEST_SUPERVISOR_RESET_DELAY_MS`, e2e only). The first selection's unload decides to
 * reset; a call of the third selection then starts and stays in the facet; an unload of the
 * second selection comes while it runs and finds nothing to unload. The first unload's reset must
 * still see the call that arrived after it, and leave it to finish: it is never sent again. The
 * call is a read, because a write arms the supervisor's alarm every second, and each alarm would
 * also hold the reset off and hide what this checks.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Redacted, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { Telemetry } from "../support/evidence.ts";
import { connectLocalAccount } from "../support/app-accounts.ts";
import { appsManifest, databaseFiles } from "../support/apps-release.ts";
import { TestLive, withCase } from "../support/case.ts";
import { linkLocal } from "../support/local-links.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

/**
 * Longer than the reset's delay (25 s), so the call is still in the facet at its checks, and short
 * enough that a call cut off and sent again still answers within the client's 60 s.
 */
const slow = 30_000;
const busyApp = (
  name: string,
) => `import { defineApp, defineProvider, secrets, object, string, number, query, mutation, router } from "apps";
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: {
  key: secrets({ label: "Key", fields: object({ token: string() }) })
} });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export default defineApp({ user: { accounts: { service } } }, {
  tools: router({
    count: query({ input: object({}), output: number() }, async ({ sql }) => sql.exec("SELECT count(*) AS n FROM t").one().n),
    add: mutation({ input: object({}), output: number() }, async ({ sql }) => {
      sql.exec("INSERT INTO t (x) VALUES (1)");
      return sql.exec("SELECT count(*) AS n FROM t").one().n;
    }),
    // Reads, and stays in the facet past the reset's checks.
    slowCount: query({ input: object({}), output: number() }, async ({ sql }) => {
      await pause(${slow});
      return sql.exec("SELECT count(*) AS n FROM t").one().n;
    }),
  }),
});`;
const otherApp = `import { defineApp, query, router, object, number } from "apps";
export default defineApp({}, { tools: router({ ping: query({ input: object({}), output: number() }, async () => 1) }) });`;
const Deployed = Schema.Struct({ app: Schema.Struct({ id: Schema.String }) });
const Answered = Schema.Struct({ status: Schema.Literal("completed"), value: Schema.Number });
const SourceStatus = Schema.Struct({ account: Schema.String, status: Schema.String });

layer(TestLive, { excludeTestServices: true })("App data reset selections", (it) => {
  it.effect(
    scenarios.appDataResetSelections.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api;
          const target = yield* Target;
          const telemetry = yield* Telemetry;
          const session = yield* api.session();
          const agent: Session = {
            ...session,
            send: (method, path, data, headers = {}) => {
              const { origin: _origin, ...rest } = headers;
              return session.send(method, path, data, {
                ...rest,
                authorization: `Bearer ${Redacted.value(target.apiKey)}`,
              });
            },
          };
          const run = randomUUID().slice(0, 6);
          const deploy = (name: string, files: ReadonlyArray<{ path: string; content: string }>) =>
            Effect.flatMap(
              api.request(agent, "POST", "/v1/apps/deploy", { owner: "local", name, files }),
              (response) => {
                expect(response.status, JSON.stringify(response.body).slice(0, 800)).toBe(200);
                return Effect.map(body(Deployed, response), (deployed) => deployed.app.id);
              },
            );
          const name = `Reset selections ${run}`;
          const busy = yield* deploy(name, [
            { path: "index.ts", content: busyApp(name) },
            appsManifest,
            ...databaseFiles(true),
            { path: "migrations/0002_t.sql", content: "CREATE TABLE t (x INTEGER NOT NULL);\n" },
          ]);
          const others: string[] = [];
          for (const index of [1, 2, 3])
            others.push(
              yield* deploy(`${name} other ${index}`, [
                { path: "index.ts", content: otherApp },
                appsManifest,
              ]),
            );
          const accounts: string[] = [];
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              for (const app of [busy, ...others])
                yield* api.request(agent, "DELETE", `/v1/apps/${app}`);
              for (const account of accounts)
                yield* api.request(agent, "DELETE", `/v1/accounts/${account}`);
            }).pipe(Effect.ignore),
          );
          // Linking an account sets it up as the app's webhook source, which calls the app in the
          // background; wait until that is done, so it does not change which Workers were used last.
          const settled = (account: string) =>
            api.request(agent, "GET", `/v1/apps/${busy}/webhook-sources`).pipe(
              Effect.flatMap((response) => body(Schema.Array(SourceStatus), response)),
              Effect.map((sources) => sources.find((source) => source.account === account)?.status),
              Effect.flatMap((status) =>
                status !== undefined && status !== "pending"
                  ? Effect.void
                  : Effect.fail(new Error("Webhook source setup has not finished")),
              ),
              Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
            );
          for (const index of [1, 2, 3]) {
            const connected = yield* connectLocalAccount(agent, {
              app: busy,
              requirement: "service",
              method: "key",
              label: `${name} ${index}`,
              fields: { token: `synthetic-selections-${index}` },
            });
            accounts.push(connected.id);
            yield* settled(connected.id);
          }
          const select = (index: number) =>
            linkLocal(agent, busy, "service", accounts[index - 1]!).pipe(
              Effect.provideService(Api, api),
              Effect.andThen(settled(accounts[index - 1]!)),
            );
          const call = (app: string, tool: string, kind: "query" | "mutation") =>
            Effect.flatMap(
              api.request(agent, "POST", "/v1/tools/call", { app, tool, kind, input: {} }),
              (response) => {
                expect(
                  response.status,
                  `${tool}: ${JSON.stringify(response.body).slice(0, 400)}`,
                ).toBe(200);
                return Effect.map(body(Answered, response), (answered) => answered.value);
              },
            );

          // Selection 1 writes; two other apps' calls then make the limit unload its data
          // Worker, and that unload decides to reset (its checks run 25 s later).
          yield* select(1);
          expect(yield* call(busy, "add", "mutation")).toBe(1);
          yield* call(others[0]!, "ping", "query");
          yield* call(others[1]!, "ping", "query");
          // Selection 2 writes, and its data Worker is left idle.
          yield* select(2);
          expect(yield* call(busy, "add", "mutation")).toBe(2);
          // Selection 3's read starts and stays in the facet.
          yield* select(3);
          const late = yield* Effect.forkChild(call(busy, "slowCount", "query"));
          yield* Effect.sleep("3 seconds");
          // Another app's call makes the limit unload selection 2, while the write runs.
          yield* call(others[2]!, "ping", "query");
          expect(yield* Fiber.join(late), "the third selection's read answered").toBe(2);
          expect(yield* call(busy, "count", "query"), "each write ran once").toBe(2);
          // No call of the app met a reset: the read was never cut off and sent again.
          yield* Effect.sleep("3 seconds");
          const resent = yield* telemetry.spans(
            "runtime.workerd.call",
            { app: busy },
            { "executor.runtime.resent": "true" },
          );
          expect(resent.length, "calls of the app that met a reset").toBe(0);
        }),
      ),
    { timeout: 240_000 },
  );
});
