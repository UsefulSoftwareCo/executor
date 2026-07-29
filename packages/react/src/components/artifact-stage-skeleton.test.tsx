import { describe, expect, it } from "@effect/vitest";

import { artifactStageSkeletonKind } from "./artifact-stage-skeleton";
import { artifactPreviewKind } from "./artifact-preview";

/**
 * Which skeleton the stage draws.
 *
 * The stage's whole promise is that ONE surface covers the open, and the best
 * version of that surface is the artifact's own stored render. This decides
 * whether it gets one, and it is the part that would degrade silently: falling
 * back to the generic blocks for an artifact that HAS a preview breaks nothing
 * and throws nothing, it just quietly makes every open worse.
 */
describe("artifactStageSkeletonKind", () => {
  it("waits against the artifact's own stored render when there is one", () => {
    expect(artifactStageSkeletonKind({ kind: "layout", markup: "<div>x</div>" })).toBe("layout");
  });

  it("falls back to the generic skeleton when nothing is stored", () => {
    expect(artifactStageSkeletonKind(null)).toBe("generic");
    expect(artifactStageSkeletonKind(undefined)).toBe("generic");
  });

  it("treats an empty preview as nothing stored", () => {
    expect(artifactStageSkeletonKind({ kind: "layout", markup: "" })).toBe("generic");
  });
});

/**
 * The card and the stage must never disagree about whether an artifact has a
 * picture.
 *
 * They are two separate functions over the same column, in two files, and they
 * are what a user sees a fraction of a second apart — the gallery card, then the
 * loading stage it opens into. If one said "layout" and the other "generic", a
 * click would replace the artifact's own thumbnail with grey blocks, which is
 * precisely the jarring swap this work exists to remove.
 *
 * Pinned as a shared property rather than duplicated expectations, so a change
 * to either side's threshold fails here rather than being discovered by eye.
 */
describe("the card and the stage agree", () => {
  const cases = [
    { kind: "layout", markup: "<div>rendered</div>" },
    { kind: "layout", markup: "" },
    null,
    undefined,
  ] as const;

  it.each(cases)("draws the same class of picture for %j", (preview) => {
    const card = artifactPreviewKind(preview);
    const stage = artifactStageSkeletonKind(preview);
    // The two vocabularies differ by one word — the card's fallback is a
    // deliberate figure ("schematic"), the stage's is anonymous blocks
    // ("generic") — but the DECISION they encode is the same one.
    expect(stage === "layout").toBe(card === "layout");
  });
});
