/**
 * Tool invocations resolve their linked accounts once per call. Calls running while an account is
 * linked and unlinked keep succeeding, each use exactly one committed set of linked accounts, and
 * observe the changes as they commit. A link is one row, so this cannot detect a torn read.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Ref } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import {
  connectionsPath,
  linkAccount,
  linkedAccountIds,
  requirementPath,
  unlinkAccount,
} from "../support/app-accounts.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const source = `import { defineApp, defineProvider, secrets, object, string, query, router } from "apps";
const service = defineProvider({ name: "Snapshot fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ user: { accounts: { workspaces: service.many() } } }, async ctx => ({
  tools: router({
    selected: query({ input: object({}) }, async () => ctx.user.accounts.workspaces.map(account => account.fields.token)),
  })
}));`;

layer(HostedLive, { excludeTestServices: true })("Invocation snapshot", (it) => {
  it.effect(scenarios.invocationSnapshotTransaction.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const accounts: string[] = [];
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Snapshot ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: source }, appsManifest],
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

        // Connecting from the app links each account to it.
        for (const label of ["first", "second"]) {
          const pending = yield* api.request(
            actors.owner,
            "POST",
            connectionsPath(path, "user", "workspaces"),
            {},
          );
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
        // With no choice, the account array uses every account linked when the call resolves.
        const call = api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "selected",
          kind: "query",
          input: {},
        });

        yield* unlinkAccount(actors.owner, path, "workspaces", second);
        const called = yield* call;
        expect(called.status).toBe(200);
        expect(called.body).toEqual(["token-first"]);

        // Start the calls only after linking the second account commits, then keep unlinking and
        // linking it until the calls have observed both sets. Seeing the first set again proves
        // the calls overlapped with the updates.
        yield* linkAccount(actors.owner, path, "workspaces", second);
        const flipping = yield* Ref.make(true);
        const updates = yield* Ref.make<ReadonlyArray<{ status: number; at: number }>>([]);
        const calls = yield* Ref.make<
          ReadonlyArray<{ status: number; body: unknown; startedAt: number; endedAt: number }>
        >([]);
        const flipper = Effect.gen(function* () {
          const flipped = yield* Ref.get(updates);
          const response = yield* api.request(
            actors.owner,
            flipped.length % 2 === 0 ? "DELETE" : "PUT",
            `${requirementPath(path, "user", "workspaces")}/${second}`,
          );
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
        yield* evidence.json("concurrent-links.json", { updates: flips, calls: results });
        expect(flips.every((update) => update.status === 200)).toBe(true);
        for (const response of results) {
          expect(response.status).toBe(200);
          expect([["token-first"], ["token-first", "token-second"]]).toContainEqual(response.body);
        }
        expect(
          observed(results),
          "Calls running during the updates must observe both committed sets of links",
        ).toBe(2);

        // After the updates stop, the next call sees the last committed links. Linking is
        // idempotent, so the second account is linked whichever update came last.
        yield* linkAccount(actors.owner, path, "workspaces", second);
        yield* unlinkAccount(actors.owner, path, "workspaces", first);
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([second]);
        const final = yield* call;
        expect(final.status).toBe(200);
        expect(final.body).toEqual(["token-second"]);
      }),
    ),
  );
});
