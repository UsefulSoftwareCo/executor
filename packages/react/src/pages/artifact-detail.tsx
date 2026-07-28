import { Suspense, useMemo } from "react";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { ClientOnly, useNavigate } from "@tanstack/react-router";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import { toast } from "sonner";
import type { ArtifactId } from "@executor-js/sdk/shared";

import { trackEvent } from "../api/analytics";
import { useArtifactRenderer } from "../api/artifact-renderer";
import { artifactAtom, removeArtifactOptimistic, renameArtifactOptimistic } from "../api/atoms";
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
import { Button } from "../components/button";
import { ErrorState } from "../components/error-state";
import { isAsyncResultLoading } from "../lib/async-result";
import { useExecutorDocumentTitle } from "../lib/document-title";
import { formatRelativeTime } from "../lib/relative-time";
import { RenameArtifactDialog } from "./artifact-rename-dialog";

/**
 * The artifact detail page — also the deep-link target `render-ui` hands to MCP
 * clients that cannot display MCP Apps, so it must work as a first landing URL.
 * Auth is handled by the surrounding console gate, exactly like /policies.
 */
export function ArtifactDetailPage(props: { readonly artifactId: ArtifactId }) {
  const artifact = useAtomValue(artifactAtom(props.artifactId));
  const refresh = useAtomRefresh(artifactAtom(props.artifactId));
  const doRename = useAtomSet(renameArtifactOptimistic, { mode: "promiseExit" });
  const doRemove = useAtomSet(removeArtifactOptimistic, { mode: "promiseExit" });
  const navigate = useNavigate();

  const title = AsyncResult.isSuccess(artifact) ? artifact.value.title : "Artifact";
  useExecutorDocumentTitle(title);

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

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isAsyncResultLoading(artifact) ? (
          <div className="flex items-center gap-2 p-6">
            <div className="size-1.5 animate-pulse rounded-full bg-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">Loading artifact…</p>
          </div>
        ) : (
          AsyncResult.match(artifact, {
            onInitial: () => (
              <div className="flex items-center gap-2 p-6">
                <div className="size-1.5 animate-pulse rounded-full bg-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">Loading artifact…</p>
              </div>
            ),
            // A deleted or foreign id lands here. The message says which of the
            // two it is as far as this viewer can tell, and offers the way back.
            onFailure: () => (
              <div className="p-6">
                <ErrorState
                  message="This artifact isn't available. It may have been deleted."
                  onRetry={refresh}
                />
              </div>
            ),
            onSuccess: ({ value }) => <ArtifactStage code={value.code} />,
          })
        )}
      </div>
    </div>
  );
}

/** The frame the stage occupies before the shell module has arrived. */
function ArtifactStagePlaceholder() {
  return (
    <div className="flex items-center gap-2 p-6">
      <div className="size-1.5 animate-pulse rounded-full bg-muted-foreground/30" />
      <p className="text-sm text-muted-foreground">Preparing the renderer…</p>
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
function ArtifactStage(props: { readonly code: string }) {
  const Renderer = useArtifactRenderer();
  // One host per mount: it holds no state, but a new identity each render would
  // retrigger the shell's host effects.
  const host = useMemo(() => createHttpShellHost(), []);

  if (!Renderer) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">
          This build can't render artifacts. Open it in the Executor app to view it.
        </p>
      </div>
    );
  }

  return (
    <ClientOnly fallback={<ArtifactStagePlaceholder />}>
      <Suspense fallback={<ArtifactStagePlaceholder />}>
        <Renderer code={props.code} host={host} />
      </Suspense>
    </ClientOnly>
  );
}
