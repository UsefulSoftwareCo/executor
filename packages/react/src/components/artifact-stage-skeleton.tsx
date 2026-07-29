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

import type { ArtifactPreview as ArtifactPreviewValue } from "@executor-js/sdk/shared";

import { cn } from "../lib/utils";

/**
 * The artifact's own framing, mirrored exactly.
 *
 * These are `.artifact-root` from the shell's `theme.css` — `max-width: 1100px`,
 * `margin-inline: auto`, `padding: 24px` (16px under 640px) — and they are
 * duplicated here deliberately rather than shared, because the two live in
 * different documents: the real one is inside a sandboxed iframe two hops down
 * and its stylesheet cannot reach the console.
 *
 * They must stay in step. The whole value of a preview-backed skeleton is that
 * the artifact resolves into the SAME PIXELS the skeleton was holding, and a
 * disagreement here is exactly a horizontal jump at the moment of handoff.
 */
const ARTIFACT_ROOT_FRAMING = "mx-auto w-full max-w-[1100px] p-4 sm:p-6";

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
 * The artifact's own stored render, at the size the artifact itself will be.
 *
 * NOT scaled — and that is the difference between this and the gallery card,
 * which is the same markup under the opposite constraint. The card has to
 * squeeze a desktop layout into a 300px tile, so it lays the markup out at a
 * fixed width and transforms it down. The stage has the artifact's real room,
 * so there is nothing to squeeze: the markup is a server render with no
 * intrinsic width, and given `.artifact-root`'s own framing it simply lays
 * itself out at exactly the width the real artifact is about to occupy.
 *
 * That is what makes the handoff invisible rather than merely quick. A scaled
 * skeleton would be the right picture at the wrong size, and the swap would
 * show every element sliding a few pixels into place — which reads as a jump
 * even when it is fast.
 */
function LayoutSkeleton(props: { readonly markup: string }) {
  return (
    <div
      data-slot="artifact-stage-skeleton-layout"
      className="absolute inset-0 overflow-hidden [contain:content]"
    >
      <div
        className={cn(ARTIFACT_ROOT_FRAMING, "motion-safe:animate-pulse")}
        style={{
          // The stored markup is the artifact's LOADING composition — its own
          // skeletons and empty frames, captured before data arrived, or its
          // settled render from a previous visit. Held under full contrast so it
          // reads as a placeholder rather than as content that failed to fill
          // in, and so the artifact arriving is a step UP in presence.
          opacity: 0.4,
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
      className={cn(ARTIFACT_ROOT_FRAMING, "flex h-full flex-col gap-4 motion-safe:animate-pulse")}
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
          artifact resolves into whether it fills with rows, tiles or a plot.

          Its rows are DISTRIBUTED down the region rather than stacked at the
          top. An artifact given the whole viewport fills it, so a placeholder
          that bunched six bars under the header and left the rest empty would
          be promising the wrong shape — and the empty band below them is the
          most visible thing on the screen while it waits. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 rounded-lg border border-border p-4">
        <div className="h-3 w-32 shrink-0 rounded bg-muted-foreground/12" />
        <div className="flex min-h-0 flex-1 flex-col justify-between gap-3 pb-1">
          {[92, 78, 85, 64, 71, 58, 80, 67].map((width, index) => (
            <div
              key={width}
              className="h-3 shrink-0 rounded bg-muted-foreground/10"
              style={{
                width: `${width}%`,
                // A gentle stagger so the pulse reads as one surface breathing
                // rather than eight independent blinks.
                animationDelay: `${index * 90}ms`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
