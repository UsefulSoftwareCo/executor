import { useEffect, useState } from "react";
import { Effect, Exit } from "effect";

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
} from "@executor-js/react/components/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@executor-js/react/components/alert";
import { Button } from "@executor-js/react/components/button";
import { FormErrorAlert } from "@executor-js/react/lib/integration-add";

import {
  listCustomToolSourcesEffect,
  removeCustomToolSourceEffect,
  syncCustomToolSourceEffect,
  type AppSourceRecord,
} from "./custom-tools-client";
import {
  sourceFailureLines,
  sourcePanelModel,
  syncNoticeFromResult,
  toolsCountLabel,
  type SyncNoticeModel,
} from "./source-panel-model";

const integrationsHref = (): string => {
  const match = window.location.pathname.match(/^(.*)\/integrations(?:\/.*)?$/);
  return `${match?.[1] ?? ""}/integrations`;
};

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly sources: readonly AppSourceRecord[] };

export default function CustomToolsAccountsPanel() {
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [syncingSlug, setSyncingSlug] = useState<string | null>(null);
  const [removingSlug, setRemovingSlug] = useState<string | null>(null);
  const [notice, setNotice] = useState<Record<string, SyncNoticeModel | undefined>>({});
  const [removeError, setRemoveError] = useState<string | null>(null);

  const loadSources = async () => {
    setLoadState({ status: "loading" });
    const exit = await Effect.runPromiseExit(listCustomToolSourcesEffect());
    if (Exit.isFailure(exit)) {
      setLoadState({ status: "error", message: "Failed to load custom tools sources." });
      return;
    }
    setLoadState({ status: "ready", sources: exit.value.sources });
  };

  useEffect(() => {
    let active = true;
    void (async () => {
      const exit = await Effect.runPromiseExit(listCustomToolSourcesEffect());
      if (!active) return;
      if (Exit.isFailure(exit)) {
        setLoadState({ status: "error", message: "Failed to load custom tools sources." });
        return;
      }
      setLoadState({ status: "ready", sources: exit.value.sources });
    })();
    return () => {
      active = false;
    };
  }, []);

  const syncSource = async (source: AppSourceRecord) => {
    setSyncingSlug(source.slug);
    setNotice((current) => ({ ...current, [source.slug]: undefined }));
    const beforeTools =
      source.status.type === "published" || source.status.type === "up-to-date"
        ? source.status.tools
        : [];
    const exit = await Effect.runPromiseExit(syncCustomToolSourceEffect(source.slug));
    if (Exit.isFailure(exit)) {
      setNotice((current) => ({
        ...current,
        [source.slug]: {
          status: "failed",
          message: "Sync failed.",
          added: [],
          removed: [],
          errors: ["Failed to sync custom tools source."],
        },
      }));
      setSyncingSlug(null);
      return;
    }
    setNotice((current) => ({
      ...current,
      [source.slug]: syncNoticeFromResult(exit.value, beforeTools),
    }));
    await loadSources();
    setSyncingSlug(null);
  };

  const removeSource = async (source: AppSourceRecord) => {
    setRemovingSlug(source.slug);
    setRemoveError(null);
    const exit = await Effect.runPromiseExit(removeCustomToolSourceEffect(source.slug));
    if (Exit.isFailure(exit)) {
      setRemoveError("Failed to remove custom tools source.");
      setRemovingSlug(null);
      return;
    }
    await loadSources();
    setRemovingSlug(null);
    window.location.assign(integrationsHref());
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      {loadState.status === "loading" && (
        <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
          Loading sources...
        </div>
      )}

      {loadState.status === "error" && (
        <Alert variant="destructive">
          <AlertTitle>Failed to load sources</AlertTitle>
          <AlertDescription>
            <div className="space-y-3">
              <p>{loadState.message}</p>
              <Button type="button" size="sm" variant="outline" onClick={() => void loadSources()}>
                Retry
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {loadState.status === "ready" && loadState.sources.length === 0 && (
        <div className="rounded-lg border border-border p-4">
          <p className="text-sm font-medium text-foreground">No custom tool sources</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Add a Git repository to publish tools into the Apps catalog.
          </p>
        </div>
      )}

      {loadState.status === "ready" &&
        loadState.sources.map((source) => (
          <SourceDetail
            key={source.slug}
            source={source}
            notice={notice[source.slug] ?? null}
            removeError={removeError}
            syncing={syncingSlug === source.slug}
            removing={removingSlug === source.slug}
            onSync={() => void syncSource(source)}
            onRemove={() => void removeSource(source)}
          />
        ))}
    </div>
  );
}

function SourceDetail(props: {
  readonly source: AppSourceRecord;
  readonly notice: SyncNoticeModel | null;
  readonly removeError: string | null;
  readonly syncing: boolean;
  readonly removing: boolean;
  readonly onSync: () => void;
  readonly onRemove: () => void;
}) {
  const { source, notice } = props;
  const model = sourcePanelModel(source);
  const failureLines = sourceFailureLines(source);
  const noticeHasDetails =
    notice !== null &&
    (notice.added.length > 0 ||
      notice.removed.length > 0 ||
      notice.errors.length > 0 ||
      notice.sourceRef !== undefined);
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card">
      <div className="flex items-start justify-between gap-4 border-b border-border p-4">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium text-foreground">{model.title}</h3>
          <p className="mt-1 truncate text-xs text-muted-foreground">{model.source}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button type="button" size="sm" onClick={props.onSync} loading={props.syncing}>
            Sync
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="border-destructive/30 text-destructive hover:bg-destructive/10"
                disabled={props.removing}
              >
                Remove
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>Remove {source.app}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes {toolsCountLabel(model.tools.length)} from the catalog. The source is
                  untouched and can be added again later.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={props.onRemove}>
                  {props.removing ? "Removing..." : "Remove source"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <div className="space-y-5 p-4">
        <div className="grid gap-3 text-sm sm:grid-cols-3">
          <Meta label="Status" value={model.status} />
          <Meta label="Source ref" value={model.sourceRef} mono />
          <Meta label="Tools" value={toolsCountLabel(model.tools.length)} />
        </div>

        {failureLines.length > 0 && (
          <Alert variant="destructive">
            <AlertTitle>Last sync failed</AlertTitle>
            <AlertDescription>
              <div className="space-y-1">
                {failureLines.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            </AlertDescription>
          </Alert>
        )}

        {notice && (
          <Alert variant={notice.status === "failed" ? "destructive" : "default"}>
            <AlertTitle>{notice.message}</AlertTitle>
            {noticeHasDetails && (
              <AlertDescription>
                <div className="space-y-1">
                  {notice.added.length > 0 && <p>Added: {notice.added.join(", ")}</p>}
                  {notice.removed.length > 0 && <p>Removed: {notice.removed.join(", ")}</p>}
                  {notice.errors.map((error) => (
                    <p key={error}>{error}</p>
                  ))}
                  {notice.sourceRef && (
                    <p className="font-mono text-xs text-muted-foreground">
                      Commit {notice.sourceRef}
                    </p>
                  )}
                </div>
              </AlertDescription>
            )}
          </Alert>
        )}

        {props.removeError && <FormErrorAlert message={props.removeError} />}
      </div>
    </div>
  );
}

function Meta(props: { readonly label: string; readonly value: string; readonly mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
        {props.label}
      </p>
      <p className={props.mono ? "mt-1 truncate font-mono text-xs" : "mt-1 truncate text-sm"}>
        {props.value}
      </p>
    </div>
  );
}
