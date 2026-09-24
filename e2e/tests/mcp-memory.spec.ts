/** Reproduce real MCP session memory pressure with small requests and bounded concurrency. */
import { expect, layer } from "@effect/vitest";
import { Clock, Console, Effect, Exit, Schema, Scope } from "effect";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { openMcpSubscription } from "../support/mcp-memory.ts";
import { scenarios } from "../test-plan.ts";

const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });

layer(HostedLive, { excludeTestServices: true })("MCP memory", (it) => {
  for (const probe of [
    {
      title: scenarios.mcpMemory.title,
      hosts: 64,
      perHost: 2,
      rounds: 20,
      reconnectStreams: 1,
      concurrency: 4,
      beforeSeconds: 180,
      afterSeconds: 180,
    },
    {
      title: scenarios.mcpMemoryShared.title,
      hosts: 1,
      perHost: 128,
      rounds: 256,
      reconnectStreams: 1,
      concurrency: 4,
      beforeSeconds: 180,
      afterSeconds: 180,
    },
    {
      title: scenarios.mcpMemoryBurst.title,
      hosts: 1,
      perHost: 4,
      rounds: 128,
      reconnectStreams: 16,
      concurrency: 16,
      beforeSeconds: 30,
      afterSeconds: 180,
    },
  ]) {
    it.effect(
      probe.title,
      (context) =>
        withHostedCase(
          context,
          Effect.gen(function* () {
            const api = yield* Api,
              actors = yield* Actors,
              evidence = yield* Evidence;
            yield* evidence.json("workload.json", probe);
            const keys: string[] = [];
            yield* Effect.addFinalizer(() =>
              Effect.forEach(
                keys,
                (keyId) => api.request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId }),
                { concurrency: 2, discard: true },
              ).pipe(Effect.orDie),
            );
            const tokens = yield* Effect.forEach(
              Array.from({ length: probe.hosts }, (_, index) => index),
              (index) =>
                Effect.gen(function* () {
                  const response = yield* api.request(
                    actors.owner,
                    "POST",
                    "/api/auth/api-key/create",
                    {
                      name: `Memory probe ${index}`,
                    },
                  );
                  expect(response.status).toBe(200);
                  const token = yield* body(Token, response);
                  keys.push(token.id);
                  return token.key;
                }),
              { concurrency: 2 },
            );
            let nextId = 0;
            const disconnected: number[] = [];
            const phase = (name: string, hosts: number, perHost: number, seconds: number) =>
              evidence.step(
                name,
                Effect.scoped(
                  Effect.gen(function* () {
                    const opened = yield* Effect.forEach(
                      tokens
                        .slice(0, hosts)
                        .flatMap((token) =>
                          Array.from({ length: perHost }, () => ({ token, id: nextId++ })),
                        ),
                      (input) =>
                        openMcpSubscription({ ...input, organization: actors.organization.id }),
                      { concurrency: probe.concurrency },
                    );
                    yield* evidence.json(`${name}-opened.json`, yield* Effect.all(opened));
                    const deadline = (yield* Clock.currentTimeMillis) + seconds * 1000;
                    while ((yield* Clock.currentTimeMillis) < deadline) {
                      yield* Effect.sleep("10 seconds");
                      const state = yield* Effect.all(opened);
                      const failed = state.filter((stream) => stream.outcome !== "open");
                      yield* Console.log(
                        `MCP memory ${name}: ${state.length} streams, ${failed.length} ended`,
                      );
                      yield* evidence.json(`${name}-latest.json`, state);
                      for (const stream of failed) {
                        if (!disconnected.includes(stream.id)) disconnected.push(stream.id);
                      }
                    }
                  }),
                ),
              );
            yield* phase("before-reconnects", probe.hosts, probe.perHost, probe.beforeSeconds);
            for (let round = 0; round < probe.rounds; round++) {
              const scope = yield* Scope.fork(yield* Effect.scope);
              const opened = yield* Effect.forEach(
                tokens.flatMap((token) =>
                  Array.from({ length: probe.reconnectStreams }, () => token),
                ),
                (token) =>
                  openMcpSubscription({
                    token,
                    organization: actors.organization.id,
                    id: nextId++,
                  }),
                { concurrency: probe.concurrency },
              ).pipe(Scope.provide(scope));
              yield* evidence.json(`reconnect-${round}.json`, yield* Effect.all(opened));
              yield* Scope.close(scope, Exit.void);
              yield* Console.log(
                `MCP memory reconnect round ${round + 1}: ${opened.length} streams closed`,
              );
            }
            yield* phase("after-reconnects", probe.hosts, probe.perHost, probe.afterSeconds);
            // Keep the stage alive after the final client cancellation so native
            // invocation outcomes can be collected before SDK teardown. The client
            // assertion alone does not establish absence of a resource reset.
            yield* evidence.step("observe-final-cancellations", Effect.sleep("35 seconds"));
            expect(disconnected, "MCP subscriptions must remain connected").toEqual([]);
          }),
        ),
      { timeout: 1_200_000 },
    );
  }
});
