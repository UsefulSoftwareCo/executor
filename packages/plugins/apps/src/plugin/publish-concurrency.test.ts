import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { makeSelfHostAppsRuntime } from "./self-host-runtime";
import { makeInMemoryAppsStore, makeTestResolver } from "../testing";
import { scopeAddress } from "../seams/scope-address";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

// ---------------------------------------------------------------------------
// Finding 6 regression: concurrent publishes to one scope must not race the git
// ref update or the descriptor-pointer write. They serialize (both succeed in
// sequence) or one gets a typed conflict; afterwards the committed HEAD and the
// stored descriptor pointer always AGREE. Before the fix the ref update had no
// expected-old-value (last-writer-wins clobber) and the pointer write raced.
//
// Uses the REAL git-backed artifact store (the git-CAS is the mechanism under
// test) via `inMemory: false`.
// ---------------------------------------------------------------------------

const toolFiles = (tag: string): ReadonlyMap<string, string> =>
  new Map<string, string>([
    [
      "tools/echo.ts",
      `import { defineTool } from "executor:app";
import { z } from "zod";
export default defineTool({
  description: "echo ${tag}",
  input: z.object({}),
  async handler(){ return { tag: "${tag}" }; },
});`,
    ],
  ]);

describe("concurrent publishes to one scope (Fix 6)", () => {
  it("serialize with head and descriptor pointer always in agreement", async () => {
    const store = makeInMemoryAppsStore();
    const resolver = makeTestResolver({});
    const host = makeSelfHostAppsRuntime({
      dataDir: mkdtempSync(join(tmpdir(), "apps-pubrace-")),
      store,
      resolver,
      // Real git-backed artifact store: exercise the ref compare-and-swap.
      inMemory: false,
    });
    const { runtime } = host;

    // Fire many concurrent publishes to the SAME scope.
    const N = 8;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_v, i) =>
        run(runtime.publish({ scope: "s", files: toolFiles(`v${i}`) })),
      ),
    );

    // Every publish either succeeded or failed with a typed conflict; none
    // clobbered another silently.
    const succeeded = results.filter((r) => r.status === "fulfilled");
    expect(succeeded.length).toBeGreaterThan(0);
    for (const r of results) {
      if (r.status === "rejected") {
        // A conflict is the only acceptable failure mode.
        expect(String(r.reason)).toMatch(/conflict/i);
      }
    }

    // HEAD and the descriptor pointer AGREE: the store's current descriptor's
    // snapshotId equals the artifact store's latest committed snapshot.
    const latest = await run(
      runtime.deps.artifactStore
        .forScope(scopeAddress("org", "s"))
        .pipe(Effect.flatMap((s) => s.latest())),
    );
    expect(latest).not.toBeNull();
    const pointer = await run(runtime.getDescriptor("s"));
    expect(pointer).not.toBeNull();
    expect(pointer!.snapshotId).toBe(latest!.id);

    await host.close();
  }, 60_000);
});
