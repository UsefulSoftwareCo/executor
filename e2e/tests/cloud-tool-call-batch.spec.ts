/**
 * A Cloud MCP session object sends a tool call's checks and reads in one socket write, on one
 * connection of its multiplexed pool: the bearer recheck in its own implicit transaction, then
 * every read in one read-only repeatable-read transaction queued in the same step, so no other
 * statement or transaction lands between them. Parallel calls each send their own batch. A write
 * that commits while a batch's reads wait is not seen by them, as if it had committed after the
 * call. A batch that cannot finish, because its connection was lost or one of its statements
 * failed, is discarded, and the call reads again on its own, in order. A batch that cannot get a
 * connection at all leaves the call to its token recheck, which fails it as unavailable (503), as
 * without batches.
 *
 * The scenario holds a table lock in the Cloud database to stop a batch partway through, so it
 * runs on its own local Cloud (`cloud-batch` in e2e/ci-selection.ts).
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { cloudLocks } from "../support/cloud-locks.ts";
import { App, Resource, type SpanQuery } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { connectionsPath, linkedAccountIds } from "../support/app-accounts.ts";
import { scenarios } from "../test-plan.ts";

/** `token` returns the account's token; `slow` does too, after `ms` milliseconds. */
const source = `import { defineApp, defineProvider, secrets, object, string, number, query, router } from "apps";
const service = defineProvider({ name: "Cloud batch fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ user: { accounts: { service } } }, async ctx => ({
  tools: router({
    token: query({ input: object({}), output: string() }, async () => ctx.user.accounts.service.fields.token),
    slow: query({ input: object({ ms: number() }), output: string() }, async (_ctx, { ms }) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ctx.user.accounts.service.fields.token;
    }),
  }),
}));`;

type Spans = (typeof SpanQuery.Type)["data"];
const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const Execution = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Unknown),
  }),
});
const Count = Schema.Array(Schema.Struct({ n: Schema.Number }));
const Pids = Schema.Array(Schema.Struct({ pid: Schema.Number }));
const Owner = Schema.Array(Schema.Struct({ owner: Schema.String }));

/** One MCP tool call of a trace: its batches and the statements made outside them. */
interface CallBatches {
  readonly batches: ReadonlyArray<{ readonly statements: number; readonly writes: number }>;
  readonly statements: number;
  readonly discarded: boolean;
  readonly texts: ReadonlyArray<string>;
}

/** Each MCP tool call in the trace, with the `sql.pipeline` spans and statements under it. */
const callsOf = (spans: Spans): ReadonlyArray<CallBatches> => {
  const byId = new Map(spans.map(({ span }) => [span.spanId, span]));
  const callOf = (spanId: string | null) => {
    const visited = new Set<string>();
    let current = spanId;
    while (current !== null && !visited.has(current)) {
      visited.add(current);
      const span = byId.get(current);
      if (span === undefined) return undefined;
      if (span.operationName.startsWith("runtime.")) return undefined;
      if (span.operationName === "mcp.tool.call") return span.spanId;
      current = span.parentSpanId;
    }
    return undefined;
  };
  return spans
    .filter(({ span }) => span.operationName === "mcp.tool.call")
    .map(({ span: call }) => {
      const under = spans.filter(({ span }) => callOf(span.parentSpanId) === call.spanId);
      return {
        batches: under
          .filter(({ span }) => span.operationName === "sql.pipeline")
          .map(({ span }) => ({
            statements: Number(span.tags["db.pipeline.statements"]),
            writes: Number(span.tags["db.pipeline.writes"]),
          })),
        statements: under.filter(({ span }) => span.operationName === "sql.execute").length,
        discarded: String(call.tags["executor.mcp.call.batch_discarded"]) === "true",
        texts: under
          .filter(({ span }) => span.operationName === "sql.execute")
          .map(
            ({ span }) =>
              `${span.startTime} ${String(span.tags["db.query.text"] ?? "")
                .replace(/\s+/g, " ")
                .slice(0, 90)} ${span.tags["error.type"] ?? ""}`,
          ),
      };
    });
};

layer(HostedLive, { excludeTestServices: true })("Cloud tool call batch", (it) => {
  it.effect(
    scenarios.cloudMcpCallBatch.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            mcp = yield* McpClient,
            evidence = yield* Evidence,
            telemetry = yield* Telemetry,
            locks = yield* cloudLocks;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const pat = yield* body(
            Token,
            yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
              name: "Cloud batch",
            }),
          );
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: pat.id })
              .pipe(Effect.orDie),
          );
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Cloud batch ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: source }, appsManifest],
          });
          expect(deployed.status).toBe(200);
          const app = yield* body(App, deployed);
          const path = `${prefix}/apps/${app.id}`;
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
          );
          // Connecting from the app links the account for the owner.
          const pending = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", connectionsPath(path, "user", "service"), {}),
          );
          const account = (yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${prefix}/connections/${pending.id}/submit`, {
              method: "key",
              label: "Synthetic",
              fields: { token: "synthetic-batch" },
            }),
          )).id;
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.owner, "DELETE", `${prefix}/accounts/${account}`)
              .pipe(Effect.ignore),
          );

          const client = yield* mcp.connect(pat.key, "cloud-batch", {
            organization: actors.organization.id,
          });
          const tool = (name: string) => `tools[${JSON.stringify(app.slug)}].${name}`;
          /** Run `code` in one execute; return its result. */
          const execute = (operation: string, code: string) =>
            client
              .use(operation, (client, signal) =>
                client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
              )
              .pipe(
                Effect.flatMap((result) =>
                  Schema.decodeUnknownEffect(Execution)(result.structuredContent),
                ),
                Effect.map(({ execution }) => execution),
              );
          /** Run `code` in one execute; return its result and the trace's tool calls. */
          const run = (operation: string, code: string, calls: number) =>
            Effect.gen(function* () {
              const result = yield* client.use(operation, (client, signal) =>
                client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
              );
              const { execution } = yield* Schema.decodeUnknownEffect(Execution)(
                result.structuredContent,
              );
              const request = (yield* evidence.requests)
                .filter((request) => request.path === "/mcp")
                .at(-1);
              if (request === undefined) return yield* Effect.die("MCP request evidence missing");
              const made = yield* telemetry.query(request.traceId).pipe(
                Effect.flatMap((trace) => {
                  const complete = trace.data.some(
                    (entry) => entry.span.tags["http.response.status_code"] === "200",
                  );
                  const found = callsOf(trace.data);
                  return complete &&
                    found.length === calls &&
                    found.every((call) => call.statements > 0)
                    ? Effect.succeed({
                        found,
                        objectId: trace.data
                          .map(({ span }) => span.tags["executor.mcp.object_id"])
                          .find((id) => id !== undefined),
                      })
                    : Effect.fail(new Error("The tool calls' spans have not all reached Motel"));
                }),
                Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
              );
              return { execution, calls: made.found, objectId: String(made.objectId) };
            });
          const token = `return await ${tool("token")}({})`;
          // A call reads the caller's links to the app live, so the link is settled first: the
          // owner's links read back as exactly the connected account.
          const settling: Array<ReadonlyArray<string>> = [];
          yield* Effect.gen(function* () {
            for (;;) {
              const linked = yield* linkedAccountIds(actors.owner, path);
              settling.push(linked);
              if (JSON.stringify(linked) === JSON.stringify([account])) return;
              yield* Effect.sleep("100 millis");
            }
          }).pipe(
            Effect.timeout("30 seconds"),
            // `json` serializes when it is built, so it is built once the loop has ended.
            Effect.ensuring(
              Effect.suspend(() => evidence.json("cloud-batch-settled.json", settling)),
            ),
          );
          // The session's first call reads the links, then sends its reads with them; every later
          // call sends one batch.
          const cold = yield* run("The session's first call", token, 1);
          expect(cold.calls[0]?.batches.length, "The session's first call").toBe(2);
          const warm = yield* run("Warm the session", token, 1);
          const owner = `executor mcp ${warm.objectId}`.slice(0, 63);

          yield* evidence.step(
            "A warm call's checks and reads leave in one socket write, alone and beside parallel calls",
            Effect.gen(function* () {
              expect(warm.execution).toEqual({ ok: true, value: "synthetic-batch" });
              const [alone] = warm.calls;
              // Recheck, BEGIN, app, access check with the links, accounts, app recheck, COMMIT.
              expect(alone?.batches).toEqual([{ statements: 7, writes: 1 }]);
              expect(alone?.statements, "Every statement of the call was in its batch").toBe(5);
              const parallel = yield* run(
                "Five calls in parallel",
                `return await Promise.all([0, 1, 2, 3, 4].map(() => ${tool("token")}({})))`,
                5,
              );
              yield* evidence.json("cloud-batch-parallel.json", parallel.calls);
              expect(parallel.execution).toEqual({
                ok: true,
                value: Array(5).fill("synthetic-batch"),
              });
              for (const call of parallel.calls) {
                expect(call.batches).toEqual([{ statements: 7, writes: 1 }]);
                expect(call.statements).toBe(5);
              }
            }),
          );

          // Counts the PAT's checks, so the scenario knows when the first call of an execute has run
          // its batch: the request's own checks (the gateway's and the session object's) come
          // first, then one per call. A check writes the key's last use only when the stored one
          // is a minute old, so the trigger also clears it on the counted key: every check writes,
          // and counts.
          yield* Effect.forEach(
            [
              "create table if not exists e2e_batch_rechecks (key_id text primary key, n int not null)",
              `create or replace function e2e_batch_count() returns trigger language plpgsql as $$
                begin
                  update e2e_batch_rechecks set n = n + 1 where key_id = new.id;
                  if found then new."lastRequest" := null; end if;
                  return new;
                end $$`,
              `create or replace trigger e2e_batch_count before update on apikey
                for each row execute function e2e_batch_count()`,
            ],
            (sql) => locks.run({ sql }),
            { discard: true },
          );
          const rechecks = locks
            .run({ sql: "select n from e2e_batch_rechecks where key_id = $1", params: [pat.id] })
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Count)), Effect.orDie);
          const resetRechecks = locks.run({
            sql: `insert into e2e_batch_rechecks (key_id, n) values ($1, 0)
              on conflict (key_id) do update set n = 0`,
            params: [pat.id],
          });
          // The warm calls recorded the key's use. Clear it before the count starts, so this
          // update is not counted.
          yield* locks.run({
            sql: `update apikey set "lastRequest" = null where id = $1`,
            params: [pat.id],
          });
          yield* resetRechecks;
          yield* run("Count a request's own checks", token, 1);
          const perRequest = ((yield* rechecks)[0]?.n ?? 0) - 1;
          expect(perRequest, "The request's own checks").toBeGreaterThan(0);
          /** The object's backends waiting for the scenario's lock on the accounts table. */
          const blocked = locks
            .run({
              sql: `select pid from pg_stat_activity where application_name = $1
                and query ilike '%executor_accounts%' and cardinality(pg_blocking_pids(pid)) > 0`,
              params: [owner],
            })
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Pids)), Effect.orDie);
          /**
           * Run a slow call, then a call whose batch the accounts table's lock stops after its
           * snapshot began; `meanwhile` runs inside the lock's transaction, and `stopped` once the
           * batch waits, before the lock is released.
           */
          const stopped = (
            label: string,
            meanwhile: Effect.Effect<unknown>,
            whileBlocked: (pids: ReadonlyArray<number>) => Effect.Effect<unknown>,
          ) =>
            Effect.gen(function* () {
              yield* resetRechecks;
              const fiber = yield* Effect.forkChild(
                run(
                  label,
                  `const first = await ${tool("slow")}({ ms: 4000 });
return [first, await ${tool("token")}({})];`,
                  2,
                ),
              );
              // The first call's batch has run once its own check follows the request's.
              yield* rechecks.pipe(
                Effect.filterOrFail((rows) => (rows[0]?.n ?? 0) >= perRequest + 1),
                Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 200 }),
              );
              yield* locks.hold({ sql: "lock table executor_accounts in access exclusive mode" });
              yield* meanwhile;
              const waiting = yield* blocked.pipe(
                Effect.filterOrFail((rows) => rows.length > 0),
                Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
              );
              yield* whileBlocked(waiting.map((row) => row.pid));
              yield* locks.release;
              return yield* Fiber.join(fiber);
            });

          yield* evidence.step(
            "A write that commits while a batch's reads wait is not seen by them",
            Effect.gen(function* () {
              const [{ owner: accountOwner } = { owner: "" }] = yield* locks
                .run({
                  sql: "select owner from executor_accounts where id = $1",
                  params: [account],
                })
                .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Owner)), Effect.orDie);
              // Moving the account to another owner refuses every call that reads it afterwards.
              const moved = yield* stopped(
                "Move the account while a batch waits",
                locks.hold({
                  sql: "update executor_accounts set owner = 'synthetic-elsewhere' where id = $1",
                  params: [account],
                }),
                () => Effect.void,
              );
              yield* evidence.json("cloud-batch-snapshot.json", moved);
              expect(
                moved.execution,
                "The waiting batch read the account as it was when its snapshot began",
              ).toEqual({ ok: true, value: ["synthetic-batch", "synthetic-batch"] });
              expect(moved.calls[1]?.batches.length).toBe(1);
              const after = yield* execute("Call after the move", token);
              yield* evidence.json("cloud-batch-moved.json", after);
              expect(after.ok, "The next call reads the moved account").toBe(false);
              yield* locks.run({
                sql: "update executor_accounts set owner = $2 where id = $1",
                params: [account, accountOwner],
              });
              // Calls read the account again once it is back.
              const returned: Array<typeof Execution.Type.execution> = [];
              for (let attempt = 1; returned.at(-1)?.ok !== true; attempt++) {
                expect(attempt, JSON.stringify(returned)).toBeLessThan(6);
                returned.push(yield* execute("Call after the account returns", token));
              }
              yield* evidence.json("cloud-batch-returned.json", returned);
              expect(returned.at(-1)).toEqual({ ok: true, value: "synthetic-batch" });
            }),
          );

          yield* evidence.step(
            "A batch whose connection is lost, or whose statement fails, is read again in order",
            Effect.gen(function* () {
              for (const [label, signal] of [
                ["terminated", "pg_terminate_backend"],
                ["cancelled", "pg_cancel_backend"],
              ] as const) {
                const made = yield* stopped(`Batch ${label} while it waits`, Effect.void, (pids) =>
                  locks.run({
                    sql: `select ${signal}(pid) from unnest($1::int[]) as pid`,
                    params: [`{${pids.join(",")}}`],
                  }),
                );
                yield* evidence.json(`cloud-batch-${label}.json`, made);
                expect(made.execution, label).toEqual({
                  ok: true,
                  value: ["synthetic-batch", "synthetic-batch"],
                });
                const call = made.calls[1];
                expect(call?.batches.length, label).toBe(1);
                expect(call?.discarded, `${label}: the batch's reads were discarded`).toBe(true);
                // The recheck and four reads in the batch, then the reads again on their own.
                expect(call?.statements, label).toBeGreaterThan(6);
              }
            }),
          );

          yield* evidence.step(
            "A call whose batch cannot connect is refused as unavailable, as on main",
            Effect.gen(function* () {
              yield* resetRechecks;
              const fiber = yield* Effect.forkChild(
                execute(
                  "A call whose batch cannot connect",
                  `const first = await ${tool("slow")}({ ms: 4000 });
try {
  return [first, await ${tool("token")}({})];
} catch (error) {
  return [first, String(error?.message ?? error)];
}`,
                ),
              );
              yield* rechecks.pipe(
                Effect.filterOrFail((rows) => (rows[0]?.n ?? 0) >= perRequest + 1),
                Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 200 }),
              );
              // While the first call waits on its app: no new connection to the database, and the
              // object's own connections closed, so the second call's batch has none to borrow.
              const refused = yield* Effect.scoped(
                Effect.gen(function* () {
                  yield* locks.refuseConnections;
                  yield* locks.hold({
                    sql: "select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1",
                    params: [owner],
                  });
                  yield* locks.release;
                  return yield* Fiber.join(fiber);
                }),
              );
              yield* evidence.json("cloud-batch-unavailable.json", refused);
              expect(refused.ok, JSON.stringify(refused)).toBe(true);
              // The token recheck could not run, so the call is refused as unavailable (503), as
              // on main, not failed by the batch's own connection error.
              const [first, failure] = yield* Schema.decodeUnknownEffect(
                Schema.Tuple([
                  Schema.String,
                  Schema.fromJsonString(
                    Schema.Struct({ code: Schema.String, status: Schema.Number }),
                  ),
                ]),
              )(refused.value);
              expect(first).toBe("synthetic-batch");
              expect(failure).toEqual({ code: "AuthenticationUnavailable", status: 503 });
              expect(yield* execute("Call once connections return", token)).toEqual({
                ok: true,
                value: "synthetic-batch",
              });
            }),
          );
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 180_000 },
  );
});
