/**
 * The artifact's stored picture, before its own row has arrived.
 *
 * ## Why this exists
 *
 * The detail page shows ONE loading surface, and the best version of that
 * surface is the artifact's own stored preview — the same markup the gallery
 * card is already drawing. But the preview reaches the detail page on the row
 * it is waiting for, so on the first paint after navigation it has nothing, and
 * the skeleton would start generic and switch to preview-backed a moment later.
 * That switch is precisely the churn the single-surface design exists to
 * remove, and it would be the most visible one of all, since it changes the
 * whole stage.
 *
 * A user arriving from the gallery, though, was just looking at that picture.
 * The list atom is in the registry with every summary in it, preview included.
 * So the page reads it from there and the skeleton is right on frame one.
 *
 * ## Why it peeks the registry instead of subscribing
 *
 * `useAtomValue(artifactsAtom)` would MOUNT the list on the detail page:
 * fetching it for a cold deep-link that never asked for a list, keeping it
 * alive for as long as the artifact is open, and re-rendering the page every
 * time it changed. None of that is wanted for what is a one-shot read of
 * something that either happens to be in memory or does not.
 *
 * `registry.getNodes()` is the honest way to ask "is this already here?": it
 * returns the nodes that exist, and never creates one. `registry.get(atom)`
 * would instantiate the node and run the query, which is the exact side effect
 * being avoided.
 *
 * Only a `valid` node is read. A `stale` one would re-run its query on access —
 * the TTL has lapsed, so `value()` rebuilds — and a speculative peek must not
 * be the thing that triggers a fetch. `uninitialized` has nothing to give.
 * Either way the caller falls back to the generic skeleton, which is the
 * correct answer for "no picture is known here".
 */

import { useContext } from "react";
import { RegistryContext } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import type { ArtifactId, ArtifactPreview } from "@executor-js/sdk/shared";

import { artifactsOptimisticAtom } from "./atoms";

/** The shape this reads off a cached list row — deliberately the minimum, so a
 *  change to the summary elsewhere cannot silently break the peek. */
type PreviewBearingRow = {
  readonly id: string;
  readonly preview?: ArtifactPreview | null;
};

const isPreviewBearingRow = (value: unknown): value is PreviewBearingRow =>
  typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string";

/**
 * The stored preview for `artifactId` if the artifacts list is already in
 * memory and settled, otherwise `null`.
 *
 * Not a hook's worth of state: this is read during render and is either
 * available synchronously or not at all. Once the artifact's own row arrives it
 * carries the authoritative preview, and the caller should prefer that — this
 * only covers the gap before it.
 */
export function useCachedArtifactPreview(artifactId: ArtifactId): ArtifactPreview | null {
  const registry = useContext(RegistryContext);
  const node = registry.getNodes().get(artifactsOptimisticAtom);
  if (!node || node.currentState() !== "valid") return null;

  const value: unknown = node.value();
  if (!AsyncResult.isSuccess(value as AsyncResult.AsyncResult<unknown, unknown>)) return null;

  const rows = (value as AsyncResult.Success<unknown, unknown>).value;
  if (!Array.isArray(rows)) return null;

  const row = rows.find(
    (candidate): candidate is PreviewBearingRow =>
      isPreviewBearingRow(candidate) && candidate.id === artifactId,
  );
  return row?.preview ?? null;
}
