import { describe, expect, it } from "@effect/vitest";

import { ARTIFACT_PREVIEW_FIGURES, artifactPreviewFigure } from "./artifact-preview";

/**
 * The schematic stands in for a screenshot the product does not have, so its
 * only real promise is that it is a pure function of the artifact's id: the
 * same artifact draws the same figure on every render, reload, and reorder.
 * A `Math.random` regression would break exactly that and nothing else, which
 * is why it is pinned here rather than left to a visual check.
 */
describe("artifactPreviewFigure", () => {
  it("returns the same figure for the same artifact", () => {
    const first = artifactPreviewFigure("art_5f3c9a12");
    const second = artifactPreviewFigure("art_5f3c9a12");
    expect(second).toBe(first);
  });

  it("only ever returns a known figure", () => {
    for (let index = 0; index < 200; index += 1) {
      expect(ARTIFACT_PREVIEW_FIGURES).toContain(artifactPreviewFigure(`art_${index}`));
    }
  });

  it("spreads ids across every figure rather than collapsing onto one", () => {
    const seen = new Set(
      Array.from({ length: 200 }, (_, index) => artifactPreviewFigure(`art_${index.toString(16)}`)),
    );
    expect(seen.size).toBe(ARTIFACT_PREVIEW_FIGURES.length);
  });

  it("distinguishes ids that differ only in their last character", () => {
    expect(artifactPreviewFigure("art_aaaaaaaa")).not.toBe(artifactPreviewFigure("art_aaaaaaab"));
  });

  it("survives an empty id instead of drawing nothing", () => {
    expect(ARTIFACT_PREVIEW_FIGURES).toContain(artifactPreviewFigure(""));
  });
});
