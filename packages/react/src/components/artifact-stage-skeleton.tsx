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
// ## Why it is one blank block
//
// A skeleton IS the message. "Preparing the renderer…" told the user about
// executor's build system; "Loading artifact…" narrated something they had just
// asked for and could already see happening. Per design.md, in-progress states
// are carried by the shape of what is arriving, not by a caption.
//
// And the shape that is arriving is the whole stage. An artifact is not a card
// or a form with a knowable silhouette — it is arbitrary code that fills the
// viewport, so any composed placeholder (a header bar, some rows, or the
// artifact's own stored preview scaled up) is a guess that resolves into
// something else. Guessing wrong is worse than not guessing: the eye tracks the
// pieces that moved. One block over the region the artifact will occupy makes
// no claim it can break, and the swap is then a single change instead of a
// dozen small ones.
// ---------------------------------------------------------------------------

import { cn } from "../lib/utils";
import { Skeleton } from "./skeleton";

/**
 * What the stage shows while an artifact is on its way.
 *
 * One component for the whole wait, deliberately: the page mounts it the moment
 * the route renders and unmounts it only once the artifact has painted, so
 * there is no point at which a different placeholder can appear.
 *
 * Sized `h-full w-full` rather than to any content of its own, so it holds
 * exactly the box the artifact frame is about to fill and the handoff moves
 * nothing.
 */
export function ArtifactStageSkeleton(props: { readonly className?: string }) {
  return (
    <Skeleton
      data-slot="artifact-stage-skeleton"
      // `aria-busy` rather than a live region: the page's title bar already
      // names the artifact, and a screen reader gains nothing from a
      // description of a grey rectangle.
      aria-busy="true"
      aria-hidden="true"
      className={cn("pointer-events-none h-full w-full select-none", props.className)}
    />
  );
}
