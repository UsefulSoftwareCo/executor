import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import { toast } from "sonner";
import type { ArtifactId } from "@executor-js/sdk/shared";

import { trackEvent } from "../api/analytics";
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
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryActions,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryTitle,
  CardStackHeader,
} from "../components/card-stack";
import { ErrorState } from "../components/error-state";
import { PageContainer, PageHeader } from "../components/page";
import { isAsyncResultLoading } from "../lib/async-result";
import { useExecutorDocumentTitle } from "../lib/document-title";
import { formatRelativeTime } from "../lib/relative-time";
import { RenameArtifactDialog } from "./artifact-rename-dialog";

/** The wire row `artifacts.list` returns — no `code`, so the list stays cheap. */
interface ArtifactSummary {
  readonly id: ArtifactId;
  readonly title: string;
  readonly description: string | null;
  readonly updatedAt: number;
}

const LoadingState = () => (
  <div className="flex items-center gap-2 py-8">
    <div className="size-1.5 animate-pulse rounded-full bg-muted-foreground/30" />
    <p className="text-sm text-muted-foreground">Loading artifacts…</p>
  </div>
);

/**
 * Artifacts are never created here — a model makes them by calling `render-ui`
 * over MCP — so the empty state teaches that path rather than offering a button
 * that cannot exist.
 */
const EmptyState = () => (
  <CardStackEntry>
    <CardStackEntryContent>
      <CardStackEntryDescription className="whitespace-normal">
        No artifacts yet. Ask an agent to render a UI and it appears here, ready to reopen.
      </CardStackEntryDescription>
    </CardStackEntryContent>
  </CardStackEntry>
);

function ArtifactRow(props: {
  readonly artifact: ArtifactSummary;
  readonly onRename: (title: string) => void;
  readonly onRemove: () => void;
}) {
  const { artifact } = props;
  return (
    <CardStackEntry>
      <CardStackEntryContent>
        <CardStackEntryTitle>
          <Link
            to="/{-$orgSlug}/artifacts/$artifactId"
            params={{ artifactId: artifact.id }}
            aria-label={`Open artifact ${artifact.title}`}
            className="outline-none hover:underline focus-visible:underline"
            onClick={() => trackEvent("artifact_opened", { surface: "list" })}
          >
            {artifact.title}
          </Link>
        </CardStackEntryTitle>
        {artifact.description ? (
          <CardStackEntryDescription>{artifact.description}</CardStackEntryDescription>
        ) : null}
      </CardStackEntryContent>
      <CardStackEntryActions>
        <span className="hidden font-mono text-[11px] text-muted-foreground sm:block">
          {formatRelativeTime(artifact.updatedAt)}
        </span>
        <RenameArtifactDialog currentTitle={artifact.title} onRename={props.onRename} />
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/card-stack-entry:opacity-100 group-focus-within/card-stack-entry:opacity-100 data-[state=open]:opacity-100"
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
      </CardStackEntryActions>
    </CardStackEntry>
  );
}

export function ArtifactsPage() {
  useExecutorDocumentTitle("Artifacts");
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
    <PageContainer>
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
              <CardStack>
                <CardStackHeader>
                  Saved artifacts
                  {rows.length > 0 ? (
                    <span className="ml-2 font-mono text-[11px] font-normal tabular-nums text-muted-foreground">
                      {rows.length}
                    </span>
                  ) : null}
                </CardStackHeader>
                <CardStackContent>
                  {rows.length === 0 ? (
                    <EmptyState />
                  ) : (
                    rows.map((artifact) => (
                      <ArtifactRow
                        key={artifact.id}
                        artifact={artifact}
                        onRename={(title) => void handleRename(artifact.id, title)}
                        onRemove={() => void handleRemove(artifact.id)}
                      />
                    ))
                  )}
                </CardStackContent>
              </CardStack>
            );
          },
        })
      )}
    </PageContainer>
  );
}

export type { ArtifactSummary };
