import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useAtomMount, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { ClientOnly, useNavigate } from "@tanstack/react-router";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import { toast } from "sonner";
import type { ArtifactId } from "@executor-js/sdk/shared";

import { trackEvent } from "../api/analytics";
import { useArtifactRenderer, usePreloadArtifactRenderer } from "../api/artifact-renderer";
import {
  artifactAtom,
  artifactsOptimisticAtom,
  removeArtifactOptimistic,
  renameArtifactOptimistic,
} from "../api/atoms";
import { artifactWriteKeys } from "../api/reactivity-keys";
import { createHttpShellHost } from "../api/shell-host";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../components/alert-dialog";
import { ArtifactStageSkeleton } from "../components/artifact-stage-skeleton";
import { Button } from "../components/button";
import { ErrorState } from "../components/error-state";
import { isAsyncResultLoading } from "../lib/async-result";
import { useExecutorDocumentTitle } from "../lib/document-title";
import { formatRelativeTime } from "../lib/relative-time";
import { RenameArtifactDialog } from "./artifact-rename-dialog";

/**
 * The artifact detail page — also the deep-link target `create-artifact` hands to MCP
 * clients that cannot display MCP Apps, so it must work as a first landing URL.
 * Auth is handled by the surrounding console gate, exactly like /policies.
 */
export function ArtifactDetailPage(props: { readonly artifactId: ArtifactId }) {
  const artifact = useAtomValue(artifactAtom(props.artifactId));
  const refresh = useAtomRefresh(artifactAtom(props.artifactId));

  // Detail-page writes reduce over the gallery's optimistic surface. Keep that
  // surface mounted here so its rename/delete transition survives the route
  // handoff back to the gallery instead of exposing the list query's cached
  // pre-mutation value while its authoritative refresh is still in flight.
  useAtomMount(artifactsOptimisticAtom);
  const doRename = useAtomSet(renameArtifactOptimistic, { mode: "promiseExit" });
  const doRemove = useAtomSet(removeArtifactOptimistic, { mode: "promiseExit" });
  const navigate = useNavigate();

  // Start the renderer chunk now, in parallel with the row's own fetch, rather
  // than when the stage first renders — which is only after the row lands, and
  // is what used to serialize the two waits into two separate placeholders. A
  // warm session (arriving from the gallery, which preloads too) has it already.
  usePreloadArtifactRenderer();

  const title = AsyncResult.isSuccess(artifact) ? artifact.value.title : "Artifact";
  useExecutorDocumentTitle(title);

  /**
   * Re-read the row when the tab comes back to the foreground.
   *
   * An artifact is written by a MODEL, in another window, while this page sits
   * open — a user watching their dashboard asks the agent to add a column, then
   * looks back here. Navigation refetches, but nothing navigates in that story,
   * and the atom's 30s TTL only bounds staleness for a page that is being read
   * again. Returning attention to the tab is the moment the user expects to see
   * the new version, so that is when it is fetched; `refresh` re-runs the same
   * query the page already depends on, and the shell's iframe is keyed on the
   * source, so new code remounts it against a fresh document.
   */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    globalThis.window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      globalThis.window.removeEventListener("focus", onVisible);
    };
  }, [refresh]);

  const handleRename = async (nextTitle: string) => {
    const exit = await doRename({
      params: { artifactId: props.artifactId },
      payload: { title: nextTitle },
      reactivityKeys: artifactWriteKeys,
    });
    trackEvent("artifact_renamed", { success: Exit.isSuccess(exit) });
    if (Exit.isFailure(exit)) toast.error("Couldn't rename the artifact. Try again.");
  };

  const handleRemove = async () => {
    const exit = await doRemove({
      params: { artifactId: props.artifactId },
      reactivityKeys: artifactWriteKeys,
    });
    trackEvent("artifact_removed", { success: Exit.isSuccess(exit) });
    if (Exit.isFailure(exit)) {
      toast.error("Couldn't delete the artifact. Try again.");
      return;
    }
    // The row this page reads is gone; the list is the only sensible landing
    // place. `params` is omitted so the router keeps the active org slug.
    await navigate({ to: "/{-$orgSlug}/artifacts" });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border bg-background/95 px-4 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-1 shrink-0 text-muted-foreground"
            onClick={() => void navigate({ to: "/{-$orgSlug}/artifacts" })}
          >
            Artifacts
          </Button>
          <h1 className="truncate text-sm font-semibold text-foreground">{title}</h1>
          {AsyncResult.isSuccess(artifact) ? (
            <span className="hidden font-mono text-[11px] text-muted-foreground sm:block">
              {formatRelativeTime(artifact.value.updatedAt)}
            </span>
          ) : null}
        </div>
        {AsyncResult.isSuccess(artifact) ? (
          <div className="flex shrink-0 items-center gap-1">
            <RenameArtifactDialog
              currentTitle={artifact.value.title}
              onRename={(next) => void handleRename(next)}
              trigger={
                <Button type="button" variant="ghost" size="sm" className="text-muted-foreground">
                  Rename
                </Button>
              }
            />
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                >
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent size="sm">
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {artifact.value.title}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This removes the artifact for good. Agents will no longer find it by name.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={() => void handleRemove()}>
                    Delete Artifact
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        ) : null}
      </div>

      {/*
        The artifact's surface, and it is EXACTLY the room below the title bar —
        `overflow-hidden`, not `overflow-y-auto`.

        That one word is the page's half of fill mode. An artifact on this page
        is not a document embedded in a thread; it is the page, so it should
        behave like an app: its own header stays put and its own table scrolls
        underneath. Letting this container scroll instead would hand the artifact
        an unbounded height, and then no amount of `h-full` inside it can resolve
        to anything — which is exactly how a 143-row table used to push its
        "Projects" header, search box and filters off the top of the screen.

        The loading, error and empty paths still want ordinary flow, so they keep
        their own padding and simply do not fill.
      */}
      {/*
        ONE loading surface, from here to the rendered artifact.

        Fetching the row, downloading the renderer chunk, booting the shell and
        compiling the source are four internal boundaries, and this page used to
        show a different placeholder at three of them. They are executor's
        seams, not the user's, and crossing them was visible only as churn: three
        quick loading states in three different layouts. So the skeleton mounts
        with the route and stays until the artifact has actually painted, with
        every one of those boundaries crossed underneath it.

        `isAsyncResultLoading` and `onInitial` therefore collapse into the SAME
        surface the stage shows, rather than each having its own.
      */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {isAsyncResultLoading(artifact) ? (
          <ArtifactStageSkeleton />
        ) : (
          AsyncResult.match(artifact, {
            onInitial: () => <ArtifactStageSkeleton />,
            // A deleted or foreign id lands here. The message says which of the
            // two it is as far as this viewer can tell, and offers the way back.
            // An error REPLACES the skeleton rather than stacking on it: the
            // wait is over, and what it produced was an answer.
            onFailure: () => (
              <div className="p-6">
                <ErrorState
                  message="This artifact isn't available. It may have been deleted."
                  onRetry={refresh}
                />
              </div>
            ),
            onSuccess: ({ value }) => <ArtifactStage code={value.code} artifactId={value.id} />,
          })
        )}
      </div>
    </div>
  );
}

/**
 * Mounts the registered MCP-Apps shell around the artifact's stored source.
 *
 * The shell is supplied by the app composition root (see
 * `ArtifactRendererProvider`) because it depends on this package and cannot be
 * imported back into it. It arrives as a lazy loader rather than a component:
 * the shell is browser-only, so on an SSR host (cloud) this page must render a
 * placeholder frame server-side and hydrate the shell client-side. `ClientOnly`
 * holds the placeholder through the server pass and the first client render, so
 * the loader is only ever invoked in the browser and hydration never mismatches.
 *
 * A host that registers no renderer still gets a page that explains itself
 * instead of crashing.
 */
function ArtifactStage(props: { readonly code: string; readonly artifactId: string }) {
  const Renderer = useArtifactRenderer();
  // One host per mount: it holds no state, but a new identity each render would
  // retrigger the shell's host effects.
  const host = useMemo(() => createHttpShellHost(), []);

  /**
   * Whether the artifact has painted, and therefore whether the skeleton is
   * still up.
   *
   * A plain boolean, because the handoff is a HARD SWAP. There is no fade: the
   * skeleton is a blank block and the artifact is a full render, so
   * interpolating between them animates nothing anyone can read — it just
   * delays the content by the length of the transition and leaves an invisible
   * cover over the artifact for that whole time. One frame, one change.
   */
  const [rendered, setRendered] = useState(false);

  /**
   * The artifact has painted inside the frame.
   *
   * Reported by the shell, because nothing on this side can see it: the
   * artifact is two sandboxed documents down, and every signal the console can
   * observe on its own — the frame's `load`, the first size report — fires while
   * the shell is still booting and would reveal a blank frame. See `onRendered`
   * on `ArtifactRendererProps`.
   *
   * Idempotent: the shell latches the signal, and a second delivery is a no-op.
   */
  const handleRendered = useCallback(() => {
    setRendered(true);
  }, []);

  if (!Renderer) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">
          This build can't render artifacts. Open it in the Executor app to view it.
        </p>
      </div>
    );
  }

  /*
    The frame and the skeleton occupy the SAME box, stacked.

    The frame is mounted immediately and at full size — it is not gated on the
    skeleton going away — so the shell boots, the bridge connects and the source
    compiles while the skeleton is still up. The skeleton lies over it until the
    artifact paints, and is then removed in one step.

    That ordering is what preserves fill mode: the renderer measures its
    container to decide the frame's height, and that container has the page's
    full content area from the first commit. A skeleton that unmounted to "make
    room" would hand the renderer a container that changed size at the exact
    moment of the swap, which is the layout jump this is meant to avoid. The
    cover is absolutely positioned over that container for the same reason —
    it never participates in the layout the frame is measuring.

    `ClientOnly` and `Suspense` keep their fallbacks, but both are now the same
    skeleton the page was already showing — so a cold SSR pass, a hydration
    boundary and a chunk still in flight are all indistinguishable from the
    wait that preceded them.
  */
  const skeleton = <ArtifactStageSkeleton />;

  return (
    <div className="relative h-full">
      <div className="h-full">
        <ClientOnly fallback={skeleton}>
          <Suspense fallback={skeleton}>
            <Renderer
              code={props.code}
              artifactId={props.artifactId}
              host={host}
              onRendered={handleRendered}
            />
          </Suspense>
        </ClientOnly>
      </div>

      {rendered ? null : (
        <div
          data-testid="artifact-stage-cover"
          // Opaque for its whole life and gone the frame after the paint
          // signal: no transition, so there is never a moment where a
          // half-transparent cover sits between the user and a live artifact.
          className="pointer-events-none absolute inset-0 z-10 bg-background"
        >
          {skeleton}
        </div>
      )}
    </div>
  );
}
