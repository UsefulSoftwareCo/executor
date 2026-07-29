import { describe, expect, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ArtifactStageSkeleton } from "./artifact-stage-skeleton";

/**
 * The stage's loading surface is ONE blank block, and that is the whole
 * contract.
 *
 * It reads like a test of nothing, and that is the point: every previous
 * version of this surface composed something — three captioned states, then
 * hairline header-and-rows geometry, then the artifact's own stored preview
 * scaled up to fill the stage. Each was an attempt to predict a layout that is
 * arbitrary user code, and each one resolved into something else, so the eye
 * tracked the pieces that moved.
 *
 * A plain block cannot be wrong about a layout it makes no claim about. These
 * assertions are what stops the next well-meaning improvement from putting the
 * guessing back, since composing more into the skeleton breaks no type and
 * throws nothing — it just quietly makes the handoff worse again.
 */
describe("ArtifactStageSkeleton", () => {
  const markup = renderToStaticMarkup(<ArtifactStageSkeleton />);

  it("is a single element with nothing inside it", () => {
    // No children of any kind: no preview markup, no header bar, no rows.
    expect(markup).toMatch(/^<div [^>]*><\/div>$/);
  });

  it("says nothing", () => {
    // The captions this replaced, and anything else: a skeleton IS the message.
    expect(markup.replace(/<[^>]*>/g, "")).toBe("");
  });

  it("fills the stage rather than sizing to content of its own", () => {
    // The frame it hands over to occupies the same box. Sizing to anything else
    // is the layout jump at the moment of the swap.
    expect(markup).toContain("h-full");
    expect(markup).toContain("w-full");
  });

  it("pulses, so it reads as waiting rather than as an empty page", () => {
    expect(markup).toContain("animate-pulse");
  });

  it("is inert and unannounced", () => {
    // It takes no hit-tests over the frame booting behind it, and a screen
    // reader gets `aria-busy` instead of a description of a grey rectangle.
    expect(markup).toContain("pointer-events-none");
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('aria-hidden="true"');
  });

  it("takes no artifact data at all", () => {
    // The stored-preview path is gone, not merely unused: the component has no
    // way to be handed a picture to wait against, so it cannot drift back into
    // rendering one.
    expect(ArtifactStageSkeleton.length).toBeLessThanOrEqual(1);
    expect(renderToStaticMarkup(<ArtifactStageSkeleton />)).toBe(markup);
  });
});
