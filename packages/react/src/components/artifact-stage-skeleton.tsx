// ---------------------------------------------------------------------------
// The one loading surface an artifact has.
//
// ## The problem this replaces
//
// Opening an artifact used to walk through THREE placeholders in a row, each
// with its own layout, each visible for a few hundred milliseconds:
//
//   1. "Loading artifact…"        — the row being fetched, as small corner text
//   2. "Preparing the renderer…"  — the lazy chunk arriving, a different corner
//   3. "Preparing interactive UI" — the shell booting, a card in the middle
//
// Nothing about that sequence is informative. The three stages are executor's
// own internal boundaries — an HTTP request, a code-split point, an iframe
// handshake — and a person opening a saved dashboard has no use for any of
// them. What they produced was churn: three different things flashing in three
// different places before the content arrived. Three quick loading states are
// more jarring than one longer one, because each transition is a fresh demand
// on the eye.
//
// So there is now exactly one surface, held from the instant the route renders
// until the artifact has actually painted, and it never changes shape while it
// waits. Every internal boundary happens underneath it, unseen.
//
// ## Why it has no words
//
// A skeleton IS the message. "Preparing the renderer…" told the user about
// executor's build system; "Loading artifact…" narrated something they had just
// asked for and could already see happening. Per design.md, in-progress states
// are carried by the shape of what is arriving, not by a caption — and this one
// can do better than a generic shape, because the artifact's own picture is
// usually already stored.
//
// ## Two skeletons, one silhouette
//
//   - PREVIEW-BACKED. The gallery already draws each card from a stored
//     `preview`: sanitized markup of the artifact really rendering. Scaled up to
//     fill the stage it is the best loading state available — the artifact's own
//     layout, in its own proportions, so what fades in is what was already
//     there. This is the same trick `ArtifactPreview` plays on the card, at the
//     other end of the scale.
//
//   - GENERIC. For an artifact with no stored preview (first open after
//     creation), hairline blocks in the grayscale ramp: a header bar, a couple
//     of rows. Deliberately abstract — a placeholder that imitated a specific
//     layout would be guessing about a layout it has not seen.
//
// Both pulse at the same slow rate and occupy the whole stage, so the switch
// between them across two different artifacts is not itself a visible change of
// idiom.
//
// ## Why the markup is inserted directly
//
// Identical reasoning to `./artifact-preview`, which is where the argument is
// written out in full: what is inserted is our own sandboxed server render,
// already reduced by `sanitizeArtifactPreviewMarkup` to an allowlist of inert
// elements and attributes — no script, no style element, no image, no frame, no
// handler, no external reference of any kind. An iframe would buy security
// against a threat this markup does not carry, and would cost the console's
// stylesheet, which is the only reason the preview looks like anything at all.
// The wrapper adds containment on top: `pointer-events-none`, `aria-hidden`,
// `[contain:strict]`, `overflow-hidden`.
// ---------------------------------------------------------------------------

import { useLayoutEffect, useRef, useState } from "react";
import type { ArtifactPreview as ArtifactPreviewValue } from "@executor-js/sdk/shared";

import { cn } from "../lib/utils";

/**
 * The width the stored markup was laid out at.
 *
 * Must match `LAYOUT_WIDTH` in `./artifact-preview` — it is a property of the
 * markup, not of either surface that draws it: the smoke render produced it at
 * the width `.artifact-root` frames an artifact at (1100px max, less padding).
 * Scaling from any other number would letterbox or crop it.
 */
const LAYOUT_WIDTH = 880;

/**
 * What the stage shows while an artifact is on its way.
 *
 * One component for the whole wait, deliberately: the page mounts it the moment
 * the route renders and unmounts it only once the artifact has painted, so
 * there is no point at which a different placeholder can appear.
 */
export function ArtifactStageSkeleton(props: {
  /** The artifact's stored gallery preview, when the row (or the list cache)
   *  has one. Its markup becomes the skeleton. */
  readonly preview?: ArtifactPreviewValue | null;
  readonly className?: string;
}) {
  const kind = artifactStageSkeletonKind(props.preview);

  return (
    <div
      data-slot="artifact-stage-skeleton"
      data-skeleton-kind={kind}
      // `aria-busy` rather than a live region: the page's title bar already
      // names the artifact, and a screen reader gains nothing from a
      // description of grey rectangles.
      aria-busy="true"
      aria-hidden="true"
      className={cn(
        "pointer-events-none relative h-full w-full select-none overflow-hidden bg-background",
        props.className,
      )}
    >
      {kind === "layout" && props.preview ? (
        <LayoutSkeleton markup={props.preview.markup} />
      ) : (
        <GenericSkeleton />
      )}
    </div>
  );
}

/**
 * Which skeleton an artifact gets.
 *
 * Exported so the choice is testable as a pure function rather than only
 * through a rendered tree — "a stored preview beats the generic blocks, and an
 * empty one is not a stored preview" is the contract, and it is the part that
 * would silently regress into always-generic without anything failing.
 *
 * Mirrors `artifactPreviewKind` in `./artifact-preview` on purpose: the card and
 * the stage must never disagree about whether an artifact has a picture, or the
 * gallery would show one and the open would fall back to blocks.
 */
export const artifactStageSkeletonKind = (
  preview: ArtifactPreviewValue | null | undefined,
): "layout" | "generic" => (preview && preview.markup !== "" ? "layout" : "generic");

/**
 * The artifact's own stored render, scaled up to fill the stage.
 *
 * The scale is MEASURED rather than written as a constant, for the same reason
 * the card measures it: the stage is whatever room the window has left after
 * the sidebar and the title bar, which no fixed divisor can predict. Container
 * query units cannot express it either — `scale()` takes a unitless number and
 * `calc(100cqw / 880)` is a length, so the browser drops the whole transform and
 * renders the markup at 1:1.
 *
 * Scaled from the TOP-CENTER, not the top-left as the card does: the stage is
 * wide enough that a left-anchored artifact would sit against one edge with a
 * band of empty background beside it, whereas the artifact itself is centered
 * by `.artifact-root`'s `margin-inline: auto`. Centering here is what makes the
 * cross-fade land on the same pixels.
 */
function LayoutSkeleton(props: { readonly markup: string }) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState<number | null>(null);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => {
      const width = frame.clientWidth;
      // Never scale UP past 1: the markup was laid out at a desktop width, and
      // a wider stage should show it at its true size centered, exactly as the
      // real artifact will be, rather than a magnified version of it.
      if (width > 0) setScale(Math.min(1, width / LAYOUT_WIDTH));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={frameRef}
      data-slot="artifact-stage-skeleton-layout"
      className="absolute inset-0 overflow-hidden [contain:strict]"
    >
      <div
        className="mx-auto motion-safe:animate-pulse"
        style={{
          width: LAYOUT_WIDTH,
          transform: `scale(${scale ?? 0})`,
          transformOrigin: "top center",
          // The framing the shell gives an artifact, so the skeleton sits where
          // the artifact will and the swap moves nothing.
          padding: 24,
          // Hidden until measured: a frame at 1:1 would flash the markup at full
          // size for one paint before the first measurement lands.
          visibility: scale === null ? "hidden" : "visible",
          // The stored markup is the artifact's LOADING composition — its own
          // skeletons and empty frames. Holding it just under full contrast
          // keeps it reading as a placeholder rather than as content that failed
          // to fill in.
          opacity: 0.55,
        }}
        // eslint-disable-next-line react/no-danger -- allowlist-sanitized SSR output; see the module header and `./artifact-preview`
        dangerouslySetInnerHTML={{ __html: props.markup }}
      />
    </div>
  );
}

/**
 * The fallback, for an artifact opened before it has ever stored a preview.
 *
 * Hairline geometry in the grayscale ramp, laid out the way `.artifact-root`
 * lays out a real artifact — same max width, same 24px padding, a heading block
 * over a body region — so an artifact's FIRST open still resolves into place
 * rather than jumping. Abstract on purpose: this is the case where nothing is
 * known about the layout, and a placeholder that mimicked a table would be
 * lying about what it knows.
 */
function GenericSkeleton() {
  return (
    <div
      data-slot="artifact-stage-skeleton-generic"
      className="mx-auto flex h-full w-full max-w-[1100px] flex-col gap-4 p-6 motion-safe:animate-pulse"
    >
      {/* The header every artifact has: a title, and a control or two. */}
      <div className="flex shrink-0 items-center justify-between gap-4">
        <div className="h-5 w-48 rounded-md bg-muted-foreground/15" />
        <div className="flex items-center gap-2">
          <div className="h-4 w-16 rounded-md bg-muted-foreground/10" />
          <div className="h-4 w-10 rounded-md bg-muted-foreground/10" />
        </div>
      </div>

      {/* The body: one bounded region, hairline-framed, the shape almost every
          artifact resolves into whether it fills with rows, tiles or a plot. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 rounded-lg border border-border p-4">
        <div className="h-3 w-32 shrink-0 rounded bg-muted-foreground/12" />
        <div className="flex min-h-0 flex-1 flex-col gap-2.5">
          {[92, 78, 85, 64, 71, 58].map((width, index) => (
            <div
              key={width}
              className="h-3 shrink-0 rounded bg-muted-foreground/10"
              style={{
                width: `${width}%`,
                // A gentle stagger so the pulse reads as one surface breathing
                // rather than six independent blinks.
                animationDelay: `${index * 90}ms`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
