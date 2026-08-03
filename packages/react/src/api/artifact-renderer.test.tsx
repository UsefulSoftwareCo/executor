import { describe, expect, it } from "@effect/vitest";

import { preloadArtifactRenderer, type ArtifactRendererLoader } from "./artifact-renderer";

/**
 * A loader that records how many times it was asked, and can be made to fail.
 *
 * The failure is a settled rejected promise rather than a thrown error, because
 * that is exactly what a bundler hands back for a chunk that could not be
 * fetched — the case this is here to pin.
 */
const countingLoader = (options?: { readonly fail?: boolean }) => {
  let calls = 0;
  const loader: ArtifactRendererLoader = async () => {
    calls += 1;
    if (options?.fail) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: simulating a bundler's failed dynamic import, which rejects with a plain Error
      throw new Error("chunk unavailable");
    }
    return { default: (() => null) as never };
  };
  return {
    loader,
    calls: () => calls,
  };
};

/**
 * Preloading the renderer chunk.
 *
 * This is what removes the second of the three loading states: the chunk is
 * fetched alongside the artifact's row rather than after it. The behaviour that
 * matters is not "does it import" — that is the bundler's job — but that it is
 * cheap enough to call from anywhere and never swallows a real failure
 * permanently.
 */
describe("preloadArtifactRenderer", () => {
  it("asks the loader once, however many times it is called", async () => {
    const { loader, calls } = countingLoader();

    preloadArtifactRenderer(loader);
    preloadArtifactRenderer(loader);
    preloadArtifactRenderer(loader);
    await Promise.resolve();

    // The dedupe is why this is safe to call on every render of every surface
    // that might lead to an artifact.
    expect(calls()).toBe(1);
  });

  it("does nothing for a host that registered no renderer", () => {
    // A host with no renderer shows an explanatory page instead; preloading
    // must not be the thing that crashes it.
    expect(() => preloadArtifactRenderer(null)).not.toThrow();
  });

  it("swallows a failed fetch rather than rejecting", async () => {
    const { loader } = countingLoader({ fail: true });

    // A speculative fetch has no caller to report to. An unhandled rejection
    // here would surface as a console error on a page the user never visited.
    expect(() => preloadArtifactRenderer(loader)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("lets a failed preload be attempted again", async () => {
    const { loader, calls } = countingLoader({ fail: true });

    preloadArtifactRenderer(loader);
    // Let the rejection settle and the latch be released.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    preloadArtifactRenderer(loader);

    // Otherwise a transient blip during a speculative fetch would mark the
    // loader done forever and the real open would never retry from here.
    expect(calls()).toBe(2);
  });

  it("keeps separate loaders separate", async () => {
    const first = countingLoader();
    const second = countingLoader();

    preloadArtifactRenderer(first.loader);
    preloadArtifactRenderer(second.loader);
    await Promise.resolve();

    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(1);
  });
});
