import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import type { ArtifactStore, FileSet } from "./artifact-store";
import { scopeAddress } from "./scope-address";

// ---------------------------------------------------------------------------
// ArtifactStore conformance suite. Runs against the INTERFACE, not a specific
// backing — pass a factory that yields a fresh store. Any future backing
// (Cloudflare Artifacts) must pass this same suite. Covers: round-trip
// (write a file set, read it back identical), snapshot immutability (a second
// publish does not change the first snapshot's bytes), latest/log ordering.
// ---------------------------------------------------------------------------

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const fileSet = (entries: Record<string, string>): FileSet => new Map(Object.entries(entries));

export const artifactStoreConformance = (
  name: string,
  makeStore: () => Promise<ArtifactStore> | ArtifactStore,
): void => {
  describe(`ArtifactStore conformance: ${name}`, () => {
    it("round-trips a file set through a snapshot", async () => {
      const store = await makeStore();
      const scope = await run(store.forScope(scopeAddress("org", "s1")));
      const files = fileSet({
        "tools/a.ts": "export const a = 1;\n",
        "notes/x.md": "# x\n",
      });
      const meta = await run(scope.commit(files, "publish 1"));
      expect(meta.id).toBeTruthy();
      expect(meta.message).toBe("publish 1");

      const readBack = await run(scope.read(meta.id));
      expect(readBack.get("tools/a.ts")).toBe("export const a = 1;\n");
      expect(readBack.get("notes/x.md")).toBe("# x\n");

      const paths = await run(scope.list(meta.id));
      expect([...paths].sort()).toEqual(["notes/x.md", "tools/a.ts"]);

      const one = await run(scope.readFile(meta.id, "tools/a.ts"));
      expect(one).toBe("export const a = 1;\n");
      const missing = await run(scope.readFile(meta.id, "tools/missing.ts"));
      expect(missing).toBeNull();
    });

    it("keeps a snapshot immutable across a later publish", async () => {
      const store = await makeStore();
      const scope = await run(store.forScope(scopeAddress("org", "s2")));
      const first = await run(scope.commit(fileSet({ "tools/a.ts": "v1" }), "first"));
      const second = await run(
        scope.commit(fileSet({ "tools/a.ts": "v2", "tools/b.ts": "new" }), "second"),
      );

      expect(second.id).not.toBe(first.id);
      // The first snapshot still reads its original bytes.
      const firstFiles = await run(scope.read(first.id));
      expect(firstFiles.get("tools/a.ts")).toBe("v1");
      expect(firstFiles.has("tools/b.ts")).toBe(false);
      // The second snapshot has the new bytes.
      const secondFiles = await run(scope.read(second.id));
      expect(secondFiles.get("tools/a.ts")).toBe("v2");
      expect(secondFiles.get("tools/b.ts")).toBe("new");
    });

    it("tracks latest and logs newest-first", async () => {
      const store = await makeStore();
      const scope = await run(store.forScope(scopeAddress("org", "s3")));
      expect(await run(scope.latest())).toBeNull();

      const a = await run(scope.commit(fileSet({ "tools/a.ts": "1" }), "a"));
      const b = await run(scope.commit(fileSet({ "tools/a.ts": "2" }), "b"));

      const latest = await run(scope.latest());
      expect(latest?.id).toBe(b.id);

      const log = await run(scope.log());
      expect(log[0].id).toBe(b.id);
      expect(log[1].id).toBe(a.id);
      expect(log.map((m) => m.message)).toEqual(["b", "a"]);
    });

    it("isolates scopes", async () => {
      const store = await makeStore();
      const s1 = await run(store.forScope(scopeAddress("org", "iso-1")));
      const s2 = await run(store.forScope(scopeAddress("org", "iso-2")));
      await run(s1.commit(fileSet({ "tools/a.ts": "one" }), "one"));
      expect(await run(s2.latest())).toBeNull();
    });
  });
};
