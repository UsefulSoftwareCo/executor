import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Fiber, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { fixtureRequest } from "../sdk/fixtures.ts";
import { connectionsPath, linkedAccountIds } from "../support/app-accounts.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const source = `import { defineApp, defineProvider, secrets, object, string, number, query, router } from "apps";
const service = defineProvider({ name: "Concurrent recheck fixture", auth: {
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

const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const Execution = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Unknown),
  }),
});

const parallel = 6;
const waitersForCertainty = 2;
const rounds = 6;

layer(HostedLive, { excludeTestServices: true })("Cloud concurrent recheck", (it) => {
  it.effect(
    scenarios.cloudMcpConcurrentRecheck.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            mcp = yield* McpClient,
            evidence = yield* Evidence,
            telemetry = yield* Telemetry;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const pat = yield* body(
            Token,
            yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
              name: "Concurrent recheck",
            }),
          );
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: pat.id })
              .pipe(Effect.orDie),
          );
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Concurrent recheck ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: source }, appsManifest],
          });
          expect(deployed.status).toBe(200);
          const app = yield* body(App, deployed);
          const path = `${prefix}/apps/${app.id}`;
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
          );
          const pending = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", connectionsPath(path, "user", "service"), {}),
          );
          const account = (yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${prefix}/connections/${pending.id}/submit`, {
              method: "key",
              label: "Synthetic",
              fields: { token: "synthetic-recheck" },
            }),
          )).id;
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.owner, "DELETE", `${prefix}/accounts/${account}`)
              .pipe(Effect.ignore),
          );
          yield* linkedAccountIds(actors.owner, path).pipe(
            Effect.filterOrFail((linked) => JSON.stringify(linked) === JSON.stringify([account])),
            Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
          );

          const client = yield* mcp.connect(pat.key, "concurrent-recheck", {
            organization: actors.organization.id,
          });
          const tool = `tools[${JSON.stringify(app.slug)}].token`;
          type Client = typeof client;
          const executeOn = (client: Client, operation: string, code: string) =>
            client
              .use(operation, (client, signal) =>
                client.callTool({ name: "execute", arguments: { code } }, undefined, {
                  signal,
                  timeout: 290_000,
                }),
              )
              .pipe(
                Effect.flatMap((result) =>
                  Schema.decodeUnknownEffect(Execution)(result.structuredContent),
                ),
                Effect.map(({ execution }) => execution),
              );
          const execute = (operation: string, code: string) => executeOn(client, operation, code);
          expect(yield* execute("Warm the session", `return await ${tool}({})`)).toEqual({
            ok: true,
            value: "synthetic-recheck",
          });

          const callsOf = (traceId: string, settled: boolean) =>
            telemetry.query(traceId).pipe(
              Effect.flatMap((trace) => {
                const byId = new Map(trace.data.map(({ span }) => [span.spanId, span]));
                const calls = new Map<
                  string,
                  {
                    ended: boolean;
                    batches: number;
                    keyReads: number;
                    keyReadsMs: number[];
                  }
                >();
                const of = (id: string) => {
                  const found = calls.get(id) ?? {
                    ended: false,
                    batches: 0,
                    keyReads: 0,
                    keyReadsMs: [],
                  };
                  calls.set(id, found);
                  return found;
                };
                for (const { span } of trace.data) {
                  if (span.operationName === "mcp.tool.call") of(span.spanId).ended = true;
                  if (span.operationName === "sql.pipeline" && span.parentSpanId !== null)
                    of(span.parentSpanId).batches++;
                  if (
                    span.operationName === "sql.execute" &&
                    String(span.tags["db.query.text"] ?? "").includes("from apikey where key")
                  ) {
                    const auth = byId.get(span.parentSpanId ?? "");
                    if (auth?.operationName === "auth.authenticate" && auth.parentSpanId !== null) {
                      const call = of(auth.parentSpanId);
                      call.keyReads++;
                      call.keyReadsMs.push(Math.round(span.durationMs));
                    }
                  }
                }
                const found = [...calls.values()].filter((call) => call.batches > 0 || call.ended);
                return !settled || found.filter((call) => call.ended).length === parallel + 1
                  ? Effect.succeed(found)
                  : Effect.fail(new Error(`${found.length} tool calls have reached the collector`));
              }),
              Effect.retry({ schedule: Schedule.spaced("1 second"), times: 40 }),
            );
          const target = yield* Target;
          if (target.fixtures === undefined || target.scenarioId === undefined)
            return yield* Effect.die(new Error("The scenario needs the runner's fixture control"));
          const fixtures = target.fixtures,
            scenarioId = target.scenarioId;
          const keyUse = (
            key: string,
            action: "age" | "hold" | "release" | "blocked",
            seconds?: number,
          ) =>
            fixtureRequest(fixtures, "/api-key-use", {
              id: scenarioId,
              key,
              action,
              ...(seconds === undefined ? {} : { seconds }),
            }).pipe(Effect.orDie);
          const blocked = (key: string) =>
            keyUse(key, "blocked").pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.Struct({ keyChecks: Schema.Number, others: Schema.Array(Schema.String) }),
                ),
              ),
              Effect.orDie,
            );
          const outcomes: Array<Record<string, unknown>> = [];
          yield* evidence.step(
            `${parallel} concurrent calls whose key checks contend all answer, on cold and warm pools`,
            Effect.gen(function* () {
              let roundKey = pat;
              let roundClient = client;
              for (let round = 0; round < rounds; round++) {
                const cold = round % 2 === 0;
                if (cold) {
                  const created = yield* body(
                    Token,
                    yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
                      name: `Concurrent recheck ${round}`,
                    }),
                  );
                  yield* Effect.addFinalizer(() =>
                    api
                      .request(actors.owner, "POST", "/api/auth/api-key/delete", {
                        keyId: created.id,
                      })
                      .pipe(Effect.ignore),
                  );
                  roundKey = created;
                  roundClient = yield* mcp.connect(created.key, `concurrent-recheck-${round}`, {
                    organization: actors.organization.id,
                  });
                }
                const started = yield* Clock.currentTimeMillis;
                yield* keyUse(roundKey.id, "age", 52);
                const { fiber, waiting, waiters } = yield* Effect.scoped(
                  Effect.gen(function* () {
                    yield* Effect.acquireRelease(keyUse(roundKey.id, "hold"), () =>
                      keyUse(roundKey.id, "release").pipe(Effect.ignore),
                    );
                    const fiber = yield* Effect.forkChild(
                      Effect.exit(
                        executeOn(
                          roundClient,
                          `Round ${round}: ${parallel} calls at once, ${cold ? "cold" : "warm"} pool`,
                          `await ${tool.replace(".token", ".slow")}({ ms: 10000 });
return await Promise.all(Array.from({ length: ${parallel} }, () => ${tool}({})));`,
                        ).pipe(Effect.timeout("45 seconds")),
                      ),
                    );
                    const seen = yield* blocked(roundKey.id).pipe(
                      Effect.filterOrFail((found) => found.keyChecks >= waitersForCertainty),
                      Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 600 }),
                      Effect.option,
                    );
                    const waiting = seen._tag === "Some" ? seen.value : yield* blocked(roundKey.id);
                    return { fiber, waiting: waiting.keyChecks, waiters: waiting.others };
                  }),
                );
                const result = yield* Fiber.join(fiber);
                const ms = (yield* Clock.currentTimeMillis) - started;
                const request = (yield* evidence.requests)
                  .filter((entry) => entry.path === "/mcp")
                  .at(-1);
                const answered = result._tag === "Success";
                const calls =
                  request === undefined
                    ? undefined
                    : yield* Effect.option(
                        callsOf(request.traceId, answered).pipe(
                          Effect.catch(() => callsOf(request.traceId, false)),
                        ),
                      );
                const objectId =
                  request === undefined
                    ? undefined
                    : yield* telemetry.query(request.traceId).pipe(
                        Effect.map((trace) =>
                          trace.data
                            .map(({ span }) => span.tags["executor.mcp.object_id"])
                            .find((id) => id !== undefined),
                        ),
                        Effect.orElseSucceed(() => undefined),
                      );
                outcomes.push({
                  round,
                  objectId,
                  cold,
                  ms,
                  waiting,
                  waiters,
                  calls: calls?._tag === "Some" ? calls.value : "unavailable",
                  reads:
                    calls?._tag === "Some"
                      ? calls.value.map((call) => call.keyReads)
                      : "unavailable",
                  outcome:
                    result._tag === "Success" ? JSON.stringify(result.value) : String(result.cause),
                });
                yield* evidence.json("concurrent-recheck-rounds.json", outcomes);
              }
              expect(
                outcomes
                  .filter((entry) => Number(entry.waiting) < waitersForCertainty)
                  .map((entry) => entry.round),
                `Rounds whose set-up failed: fewer than ${waitersForCertainty} key checks waited on the key row's lock at once within 30 seconds`,
              ).toEqual([]);
              expect(
                outcomes
                  .filter((entry) => String(entry.outcome).includes("TimeoutError"))
                  .map((entry) => entry.round),
                "Rounds whose execute did not answer within 45 seconds",
              ).toEqual([]);
              expect(
                outcomes
                  .filter(
                    (entry) =>
                      typeof entry.reads !== "object" ||
                      !(entry.reads as number[]).some((n) => n >= 2),
                  )
                  .map((entry) => entry.round),
                "Rounds in which no call read its key again",
              ).toEqual([]);
            }),
          );
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 600_000 },
  );
});
