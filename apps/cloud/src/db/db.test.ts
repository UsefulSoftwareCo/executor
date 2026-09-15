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
import { isValidOrgSlug } from "@executor-js/api";

import { DbService } from "./db";
import { makeUserStore } from "../auth/user-store";

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
            makeUserStore(db).upsertOrganization({
              id: organizationId,
              name: "Acme",
              updatedAt: new Date(),
            }),
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

describe("upsertOrganization · slug is minted at insert", () => {
  const upsert = (org: { id: string; name: string; updatedAt?: Date }) =>
    program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        return yield* Effect.promise(() =>
          makeUserStore(db).upsertOrganization({
            updatedAt: new Date(),
            ...org,
          }),
        );
      }),
    );

  it("mints a valid slug on insert", async () => {
    const org = await upsert({
      id: `org_${crypto.randomUUID()}`,
      name: "Slug Mint Co",
    });
    expect(org.slug, "a new org row is born with a slug").toBeTruthy();
    expect(isValidOrgSlug(org.slug), "the minted slug fits the URL grammar").toBe(true);
  });

  it("keeps the slug stable across renames (conflict updates name only)", async () => {
    const id = `org_${crypto.randomUUID()}`;
    const created = await upsert({ id, name: "Original Name" });
    const renamed = await upsert({ id, name: "Renamed Org" });
    expect(renamed.slug, "the slug survives a rename").toBe(created.slug);
    expect(renamed.name, "the name is refreshed on conflict").toBe("Renamed Org");
  });

  it("refuses a name stamped earlier than the one it holds, and never renames a deleted org", async () => {
    const id = `org_${crypto.randomUUID()}`;
    const t1 = new Date("2026-01-01T00:00:00.000Z");
    const t2 = new Date("2026-01-02T00:00:00.000Z");
    const t3 = new Date("2026-01-03T00:00:00.000Z");
    await upsert({ id, name: "Original Name", updatedAt: t2 });
    // A payload fetched before the rename landed (a login that stalled).
    const stale = await upsert({ id, name: "Stale Name", updatedAt: t1 });
    expect(stale.name, "an older name never reverts a newer one").toBe("Original Name");
    const replay = await upsert({ id, name: "Replayed Name", updatedAt: t2 });
    expect(replay.name, "the same instant is accepted, so replays converge").toBe("Replayed Name");
    await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() => makeUserStore(db).deleteOrganizationCascade(id, t3));
      }),
    );
    const afterDelete = await upsert({
      id,
      name: "Resurrected Name",
      updatedAt: t3,
    });
    expect(afterDelete.deletedAt, "a deleted org stays deleted").toEqual(t3);
    expect(afterDelete.name, "and keeps its last name").toBe("Replayed Name");
  });

  it("discriminates same-name collisions into distinct slugs", async () => {
    // Same name → same slug base; the second insert collides on the unique
    // index and gets a discriminated slug.
    const name = `Collide ${crypto.randomUUID().slice(0, 8)}`;
    const a = await upsert({ id: `org_${crypto.randomUUID()}`, name });
    const b = await upsert({ id: `org_${crypto.randomUUID()}`, name });
    expect(a.slug).not.toBe(b.slug);
    expect(isValidOrgSlug(a.slug) && isValidOrgSlug(b.slug), "both slugs are valid").toBe(true);
  });
});
