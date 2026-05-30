// ---------------------------------------------------------------------------
// DbService integration test
// ---------------------------------------------------------------------------
//
// Regression coverage for the pg/CloudflareSocket hang (see
// personal-notes/pg-cloudflare-sockets-dev.md). This test:
//
//   - Runs inside the Cloudflare Workers runtime via
//     @cloudflare/vitest-pool-workers
//   - Talks to a real Postgres (PGlite exposed over a TCP socket by
//     scripts/test-globalsetup.ts)
//   - Constructs DbService.Live across multiple independent Effect scopes,
//     the way api.ts does per request
//   - Performs real queries against the mirrored accounts/organizations
//     tables through drizzle
//
// With the old `pg` + `drizzle-orm/node-postgres` stack, the second scope's
// query would hang indefinitely because CloudflareSocket cannot be reused
// across request contexts and `Client.end()` never resolved. With
// postgres.js the test passes: each scope acquires its own socket and
// releases it cleanly.

import { describe, it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { DbService } from "./db";
import { makeUserStore } from "./user-store";

const program = <A, E>(body: Effect.Effect<A, E, DbService>) =>
  Effect.runPromise(
    body.pipe(Effect.provide(DbService.Live), Effect.scoped) as Effect.Effect<A, E, never>,
  );

describe("DbService", () => {
  it("executes a trivial query end-to-end", async () => {
    const result = await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        const rows = yield* Effect.promise(() => db.execute("select 1 as one"));
        return rows;
      }),
    );
    expect(
      Array.isArray(result) ? result[0] : (result as { rows: unknown[] }).rows[0],
    ).toBeDefined();
  });

  it("round-trips an account through the user store", async () => {
    const id = `user_${crypto.randomUUID()}`;
    const account = await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        const store = makeUserStore(db);
        return yield* Effect.promise(() => store.ensureAccount(id));
      }),
    );
    expect(account.id).toBe(id);
  });

  it("supports multiple sequential scopes (regression: pg socket reuse hang)", async () => {
    // With `pg`, the second scope's connect()/query would hang because the
    // CloudflareSocket from the first scope cannot be reused and Client.end()
    // never completes. postgres.js creates a fresh socket per scope.
    const idA = `user_${crypto.randomUUID()}`;
    const idB = `user_${crypto.randomUUID()}`;

    await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() => makeUserStore(db).ensureAccount(idA));
      }),
    );

    const fetched = await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        const store = makeUserStore(db);
        yield* Effect.promise(() => store.ensureAccount(idB));
        return yield* Effect.promise(() => store.getAccount(idA));
      }),
    );

    expect(fetched?.id).toBe(idA);
  }, 15_000);

  it("supports nested scopes within a single outer scope (regression: /api/scope pattern)", async () => {
    // Mirrors api.ts: an outer scope resolves the org, then an inner scope
    // (the HttpApi request handler) re-acquires DbService and queries again.
    const organizationId = `org_${crypto.randomUUID()}`;

    const outer = Layer.provide(
      Layer.effectDiscard(
        Effect.gen(function* () {
          const { db } = yield* DbService;
          yield* Effect.promise(() =>
            makeUserStore(db).upsertOrganization({ id: organizationId, name: "Acme" }),
          );
        }),
      ),
      DbService.Live,
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        // Outer "request" scope.
        yield* Effect.scoped(Layer.build(outer).pipe(Effect.asVoid));
        // Inner "handler" scope — fresh DbService.
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const { db } = yield* DbService;
            return yield* Effect.promise(() => makeUserStore(db).getOrganization(organizationId));
          }).pipe(Effect.provide(DbService.Live)),
        ) as Effect.Effect<{ id: string; name: string } | null, never, never>;
      }) as Effect.Effect<{ id: string; name: string } | null, never, never>,
    );

    expect(result?.id).toBe(organizationId);
    expect(result?.name).toBe("Acme");
  }, 15_000);
});
