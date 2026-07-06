import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import type { ScopeDb } from "./scope-db";

// ---------------------------------------------------------------------------
// ScopeDb conformance suite. Runs against the interface. Covers: scope
// isolation (a write in scope A is invisible in scope B), per-table version
// bumps on write, and tagged-template parameters.
// ---------------------------------------------------------------------------

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

export const scopeDbConformance = (
  name: string,
  makeDb: () => Promise<ScopeDb> | ScopeDb,
): void => {
  describe(`ScopeDb conformance: ${name}`, () => {
    it("isolates data between scopes", async () => {
      const db = await makeDb();
      const a = await run(db.forScope("scope-a"));
      const b = await run(db.forScope("scope-b"));
      await run(a.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)"));
      await run(a.exec("INSERT INTO items (name) VALUES ('a-only')"));
      await run(b.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)"));

      const aRows = await run(a.exec<{ name: string }>("SELECT name FROM items"));
      const bRows = await run(b.exec<{ name: string }>("SELECT name FROM items"));
      expect(aRows.map((r) => r.name)).toEqual(["a-only"]);
      expect(bRows).toEqual([]);
      await run(db.close());
    });

    it("bumps a table's version on each write", async () => {
      const db = await makeDb();
      const s = await run(db.forScope("ver"));
      await run(s.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)"));
      const afterCreate = await run(s.tableVersion("t"));
      expect(afterCreate).toBeGreaterThanOrEqual(1);

      await run(s.exec("INSERT INTO t (id) VALUES (1)"));
      const afterInsert = await run(s.tableVersion("t"));
      expect(afterInsert).toBe(afterCreate + 1);

      await run(s.exec("UPDATE t SET id = 2 WHERE id = 1"));
      const afterUpdate = await run(s.tableVersion("t"));
      expect(afterUpdate).toBe(afterInsert + 1);

      // Reads do not bump.
      await run(s.exec("SELECT * FROM t"));
      expect(await run(s.tableVersion("t"))).toBe(afterUpdate);
      await run(db.close());
    });

    it("supports the author-facing tagged-template sql with parameters", async () => {
      const db = await makeDb();
      const s = await run(db.forScope("tpl"));
      await run(s.exec("CREATE TABLE issues (repo TEXT, title TEXT)"));
      const repo = "acme/app";
      const title = "Bug";
      await run(s.sql`INSERT INTO issues (repo, title) VALUES (${repo}, ${title})`);
      const rows = await run(
        s.sql<{ repo: string; title: string }>`SELECT * FROM issues WHERE repo = ${repo}`,
      );
      expect(rows).toEqual([{ repo: "acme/app", title: "Bug" }]);
      await run(db.close());
    });
  });
};
