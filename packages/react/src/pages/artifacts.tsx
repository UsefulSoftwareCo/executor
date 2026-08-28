import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import { toast } from "sonner";
import type { ArtifactId, ArtifactPreview as ArtifactPreviewValue } from "@executor-js/sdk/shared";

import { trackEvent } from "../api/analytics";
import { usePreloadArtifactRenderer } from "../api/artifact-renderer";
import {
  artifactsOptimisticAtom,
  removeArtifactOptimistic,
  renameArtifactOptimistic,
} from "../api/atoms";
import { artifactWriteKeys } from "../api/reactivity-keys";
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
import { ArtifactPreview } from "../components/artifact-preview";
import { ErrorState } from "../components/error-state";
import { PageContainer, PageHeader } from "../components/page";
import { EmptyState as PageEmptyState } from "../components/empty-state";
import { Skeleton } from "../components/skeleton";
import { isAsyncResultLoading } from "../lib/async-result";
import { useExecutorDocumentTitle } from "../lib/document-title";
import { formatRelativeTime } from "../lib/relative-time";
import { RenameArtifactDialog } from "./artifact-rename-dialog";

/** The wire row `artifacts.list` returns — no `code`, so the list stays cheap.
 *  The preview is the exception: the gallery is what draws it. */
interface ArtifactSummary {
  readonly id: ArtifactId;
  readonly title: string;
  readonly description: string | null;
  readonly preview: ArtifactPreviewValue | null;
  readonly updatedAt: number;
}

const LoadingState = () => (
  <section>
    <Skeleton className="mb-3 h-4 w-32" />
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="overflow-hidden rounded-lg border border-border bg-card">
          <Skeleton className="aspect-[16/10] rounded-none" />
          <div className="space-y-2 px-4 py-3">
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-1/4" />
          </div>
        </div>
      ))}
    </div>
  </section>
);

/**
 * Artifacts are never created here — a model makes them by calling `create-artifact`
 * over MCP — so the empty state teaches that path rather than offering a button
 * that cannot exist.
 */
const EmptyState = () => (
  <PageEmptyState
    className="py-10"
    title="No saved artifacts"
    description="Ask an agent to render a UI and it will appear here, ready to reopen."
  />
);

/**
 * One artifact, as a gallery card.
 *
 * The whole card is the link — the preview is the biggest, most obvious target,
 * and a title-only hit area would waste it. The row actions therefore cannot be
 * nested inside it (a button inside an anchor is invalid, and the click would
 * navigate through them), so the link is a full-bleed overlay and the actions
 * sit above it on the z-axis. That keeps one accessible name for the card and
 * one focus stop, with the actions as their own stops after it.
 */
function ArtifactCard(props: {
  readonly artifact: ArtifactSummary;
  readonly onRename: (title: string) => void;
  readonly onRemove: () => void;
}) {
  const { artifact } = props;
  return (
    <div
      data-slot="artifact-card"
      className="group/artifact-card relative isolate flex flex-col overflow-hidden rounded-lg border border-border bg-card transition-colors duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] focus-within:border-input hover:border-input"
    >
      {/* 16:10 preview, on its own plane, separated by the same hairline the
          rest of the console uses. */}
      <div className="relative aspect-[16/10] overflow-hidden border-b border-border bg-muted/40">
        <ArtifactPreview artifactId={artifact.id} preview={artifact.preview} />
      </div>

      <div className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <h3 className="truncate text-sm font-medium text-foreground">
          <Link
            to="/{-$orgSlug}/artifacts/$artifactId"
            params={{ artifactId: artifact.id }}
            aria-label={`Open artifact ${artifact.title}`}
            className="outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline"
            onClick={() => trackEvent("artifact_opened", { surface: "list" })}
          >
            {artifact.title}
          </Link>
        </h3>
        {artifact.description ? (
          <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {artifact.description}
          </p>
        ) : null}
        <span className="mt-1 font-mono text-[11px] text-muted-foreground">
          {formatRelativeTime(artifact.updatedAt)}
        </span>
      </div>

      {/* Above the link overlay, so these stay clickable. Revealed on hover or
          focus, and pinned open while their own dialog is. */}
      <div className="absolute right-2 top-2 z-10 flex items-center gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/artifact-card:opacity-100 has-[[data-state=open]]:opacity-100">
        <RenameArtifactDialog
          currentTitle={artifact.title}
          onRename={props.onRename}
          trigger={
            <Button
              type="button"
              variant="secondary"
              size="xs"
              className="bg-card text-muted-foreground hover:text-foreground"
            >
              Rename
            </Button>
          }
        />
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              className="bg-card text-muted-foreground hover:text-destructive"
            >
              Delete
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {artifact.title}?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes the artifact for good. Agents will no longer find it by name.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={props.onRemove}>
                Delete Artifact
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}

export function ArtifactsPage() {
  useExecutorDocumentTitle("Artifacts");
  // Opening a card is the only thing this page is for, and the renderer chunk is
  // the slowest part of doing so. Fetching it while the user is still choosing
  // means the detail page never has to wait for it — the renderer's own
  // placeholder simply stops existing for anyone arriving from here.
  usePreloadArtifactRenderer();
  const artifacts = useAtomValue(artifactsOptimisticAtom);
  const refreshArtifacts = useAtomRefresh(artifactsOptimisticAtom);
  const doRename = useAtomSet(renameArtifactOptimistic, { mode: "promiseExit" });
  const doRemove = useAtomSet(removeArtifactOptimistic, { mode: "promiseExit" });

  const handleRename = async (artifactId: ArtifactId, title: string) => {
    const exit = await doRename({
      params: { artifactId },
      payload: { title },
      reactivityKeys: artifactWriteKeys,
    });
    trackEvent("artifact_renamed", { success: Exit.isSuccess(exit) });
    if (Exit.isFailure(exit)) toast.error("Couldn't rename the artifact. Try again.");
  };

  const handleRemove = async (artifactId: ArtifactId) => {
    const exit = await doRemove({
      params: { artifactId },
      reactivityKeys: artifactWriteKeys,
    });
    trackEvent("artifact_removed", { success: Exit.isSuccess(exit) });
    if (Exit.isFailure(exit)) toast.error("Couldn't delete the artifact. Try again.");
  };

  return (
    // Wider than the settings column: three preview cards need the room, and
    // this page is a gallery rather than a form.
    <PageContainer variant="wide">
      <PageHeader
        title="Artifacts"
        description="Interactive components your agents generated. Ask an agent to render a UI and it is saved here — reopen it any time, or have the agent bring it back by name."
      />

      {isAsyncResultLoading(artifacts) ? (
        <LoadingState />
      ) : (
        AsyncResult.match(artifacts, {
          onInitial: () => <LoadingState />,
          onFailure: () => (
            <ErrorState message="Failed to load artifacts" onRetry={refreshArtifacts} />
          ),
          onSuccess: ({ value }) => {
            // Most-recently-updated first: an artifact just generated by an
            // agent is the one the user is most likely coming here to open.
            const rows = [...value].sort((a, b) => b.updatedAt - a.updatedAt);
            return (
              <section>
                <h2 className="mb-3 flex items-center font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  Saved artifacts
                  {rows.length > 0 ? (
                    <span className="ml-2 font-normal tabular-nums">{rows.length}</span>
                  ) : null}
                </h2>
                {rows.length === 0 ? (
                  <EmptyState />
                ) : (
                  <div
                    data-slot="artifact-grid"
                    className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
                  >
                    {rows.map((artifact) => (
                      <ArtifactCard
                        key={artifact.id}
                        artifact={artifact}
                        onRename={(title) => void handleRename(artifact.id, title)}
                        onRemove={() => void handleRemove(artifact.id)}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          },
        })
      )}
    </PageContainer>
  );
}

export type { ArtifactSummary };
