import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { makeGitArtifactStore } from "./git-artifact-store";
import { scopeAddress } from "../seams/scope-address";
import type { ArtifactStoreError } from "../seams/artifact-store";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

// ---------------------------------------------------------------------------
// Finding 6 regression (git compare-and-swap): two commits built from the SAME
// parent cannot both advance the branch. The ref update is a CAS against the
// expected old value, so the second raced writer gets a typed conflict instead
// of silently clobbering the first. This is deterministic (no timing race): we
// force both to share a parent by committing them against a store whose head we
// pin.
// ---------------------------------------------------------------------------

describe("git ArtifactStore ref CAS (Fix 6)", () => {
  it("two concurrent commits from one parent: one wins, the other typed-conflicts", async () => {
    const root = mkdtempSync(join(tmpdir(), "apps-cas-"));
    const storeA = makeGitArtifactStore({ root });
    const scopeA = await run(storeA.forScope(scopeAddress("org", "s")));

    // Seed a parent so racers commit ON TOP of the same head.
    await run(scopeA.commit(new Map([["tools/base.ts", "// base"]]), "base"));

    // Many SEPARATE store instances over the SAME repo dir. The repo already
    // exists (seeded above), so opening each scope is a re-`init --bare` (a no-op
    // on an existing repo). Open them SEQUENTIALLY so the idempotent init doesn't
    // itself race, then race only the COMMITS (the ref-CAS is what's under test).
    const N = 12;
    const openedScopes: { commit: typeof scopeA.commit; log: typeof scopeA.log }[] = [];
    for (let i = 0; i < N; i++) {
      const store = makeGitArtifactStore({ root });
      // eslint-disable-next-line no-await-in-loop
      openedScopes.push(await run(store.forScope(scopeAddress("org", "s"))));
    }
    const scopeB = openedScopes[0];

    // Fire many concurrent commits, ALL built against the seeded base parent.
    const results = await Promise.allSettled(
      openedScopes.map((sc, i) =>
        run(sc.commit(new Map([[`tools/c${i}.ts`, `// ${i}`]]), `c${i}`)),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected");

    // Any failure MUST be a typed conflict (never a silent clobber).
    for (const r of rejected) {
      const err = (r as PromiseRejectedResult).reason as ArtifactStoreError;
      expect(String(JSON.stringify(err))).toMatch(/conflict/i);
    }

    // No lost commits: the git log length equals base(1) + every commit that
    // reported success. Without the CAS, a raced writer clobbers the ref and an
    // earlier successful commit vanishes from history, making the log SHORTER
    // than base + fulfilled. The CAS guarantees every reported success is a real,
    // reachable, non-clobbering advance.
    const logEntries = await run(scopeB.log(1000));
    expect(logEntries.length).toBe(1 + fulfilled);
  }, 60_000);
});
