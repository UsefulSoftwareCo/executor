/**
 * Tool invocations resolve their selection without holding a database transaction. An open
 * transaction pins a pooled server connection (Hyperdrive in Cloud) until the caller's next
 * statement; under heavy concurrent load, those pins delayed every other request. The transaction
 * span count is the regression guard. The second half checks that calls running while the saved
 * selection changes keep succeeding, each return exactly one saved selection, and observe the
 * changes as they commit. A selection is one row, so that half cannot detect a torn read.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Ref, Schedule } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";

const source = `import { defineApp, defineProvider, secrets, object, string, query } from "apps";
const service = defineProvider({ name: "Snapshot fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ accounts: { workspaces: service.many() } }, async ctx => ({
  queries: { selected: query({ input: object({}) }, async () => ctx.accounts.workspaces.map(account => account.fields.token)) }
}));`;

layer(HostedLive, { excludeTestServices: true })("Invocation snapshot", (it) => {
  it.effect(scenarios.invocationSnapshotTransaction.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const accounts: string[] = [];
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Snapshot ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: source }],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(Resource, deployed);
        const path = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            expect((yield* api.request(actors.owner, "DELETE", path)).status).toBe(200);
            for (const account of accounts)
              expect(
                (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`))
                  .status,
              ).toBe(200);
          }).pipe(Effect.orDie),
        );

        const profile = yield* createProfile(actors.owner, path);
        for (const label of ["first", "second"]) {
          const pending = yield* api.request(actors.owner, "POST", `${path}/connections`, {
            requirement: "workspaces",
            profile: profile.id,
          });
          expect(pending.status).toBe(200);
          const connection = yield* body(Resource, pending);
          const saved = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/submit`,
            { method: "key", label: `Synthetic ${label}`, fields: { token: `token-${label}` } },
          );
          expect(saved.status).toBe(200);
          accounts.push((yield* body(Resource, saved)).id);
        }
        const [first, second] = accounts as [string, string];
        const call = api.request(actors.owner, "POST", `${path}/tools/call`, {
          profile: profile.id,
          tool: "queries.selected",
          input: {},
        });

        expect(
          (yield* selectProfileAccounts(actors.owner, path, profile.id, { workspaces: [first] }))
            .status,
        ).toBe(200);
        const called = yield* call;
        expect(called.status).toBe(200);
        expect(called.body).toEqual(["token-first"]);
        const request = (yield* evidence.requests).at(-1);
        if (request === undefined) return yield* Effect.die(new Error("Request evidence missing"));

        // The snapshot's reads must reach Motel before its transaction spans can be judged.
        const resolution = yield* telemetry.query(request.traceId).pipe(
          Effect.flatMap((result) => {
            const root = result.data.find(
              (entry) => entry.span.operationName === "sdk.invocation.snapshot",
            );
            const complete = result.data.some(
              (entry) => entry.span.tags["http.response.status_code"] === "200",
            );
            if (root === undefined || !complete)
              return Effect.fail(new Error("The completed server trace must reach Motel"));
            const byId = new Map(result.data.map(({ span }) => [span.spanId, span]));
            const under = (spanId: string | null) => {
              const visited = new Set<string>();
              let parent = spanId;
              while (parent !== null && !visited.has(parent)) {
                if (parent === root.span.spanId) return true;
                visited.add(parent);
                parent = byId.get(parent)?.parentSpanId ?? null;
              }
              return false;
            };
            const descendants = result.data.filter(({ span }) => under(span.parentSpanId));
            const reads = descendants.filter(({ span }) => span.operationName === "sql.execute");
            return reads.length === 0
              ? Effect.fail(new Error("SQL descendants must reach Motel"))
              : Effect.succeed({
                  reads: reads.length,
                  transactions: descendants.filter(({ span }) =>
                    ["sql.transaction", "storage.transaction"].includes(span.operationName),
                  ).length,
                });
          }),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
          Effect.timeout("25 seconds"),
        );
        yield* evidence.json("invocation-snapshot-spans.json", {
          traceId: request.traceId,
          ...resolution,
        });
        expect(
          resolution.transactions,
          "Resolving an invocation must not open a database transaction",
        ).toBe(0);

        // Start the calls only after the second selection commits, then keep flipping the
        // selection until the calls have observed both. Seeing the first selection again proves
        // the calls overlapped with the updates.
        expect(
          (yield* selectProfileAccounts(actors.owner, path, profile.id, { workspaces: [second] }))
            .status,
        ).toBe(200);
        const flipping = yield* Ref.make(true);
        const updates = yield* Ref.make<ReadonlyArray<{ status: number; at: number }>>([]);
        const calls = yield* Ref.make<
          ReadonlyArray<{ status: number; body: unknown; startedAt: number; endedAt: number }>
        >([]);
        const flipper = Effect.gen(function* () {
          const flipped = yield* Ref.get(updates);
          const workspaces = flipped.length % 2 === 0 ? [first] : [second];
          const response = yield* selectProfileAccounts(actors.owner, path, profile.id, {
            workspaces,
          });
          yield* Ref.update(updates, (all) => [
            ...all,
            { status: response.status, at: Date.now() },
          ]);
        }).pipe(Effect.repeat({ while: () => Ref.get(flipping) }));
        const observed = (all: ReadonlyArray<{ body: unknown }>) =>
          new Set(all.map((response) => JSON.stringify(response.body))).size;
        const caller = Effect.forEach(
          Array.from({ length: 4 }),
          () =>
            Effect.gen(function* () {
              const startedAt = Date.now();
              const response = yield* call;
              yield* Ref.update(calls, (all) => [
                ...all,
                { status: response.status, body: response.body, startedAt, endedAt: Date.now() },
              ]);
            }),
          { concurrency: 4 },
        ).pipe(
          Effect.repeat({
            until: () =>
              Ref.get(calls).pipe(Effect.map((all) => observed(all) >= 2 || all.length >= 80)),
          }),
          Effect.ensuring(Ref.set(flipping, false)),
        );
        yield* Effect.all([flipper, caller], { concurrency: 2 });
        const flips = yield* Ref.get(updates);
        const results = yield* Ref.get(calls);
        yield* evidence.json("concurrent-selection.json", { updates: flips, calls: results });
        expect(flips.every((update) => update.status === 200)).toBe(true);
        for (const response of results) {
          expect(response.status).toBe(200);
          expect([["token-first"], ["token-second"]]).toContainEqual(response.body);
        }
        expect(
          observed(results),
          "Calls running during the updates must observe both saved selections",
        ).toBe(2);

        // After the updates stop, the next call sees the last committed selection.
        expect(
          (yield* selectProfileAccounts(actors.owner, path, profile.id, { workspaces: [second] }))
            .status,
        ).toBe(200);
        const final = yield* call;
        expect(final.status).toBe(200);
        expect(final.body).toEqual(["token-second"]);
      }),
    ),
  );
});
