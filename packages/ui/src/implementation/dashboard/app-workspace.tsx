import { AppWorkspaceLoading, SourceHistoryLoading } from "./app-loading.tsx";
import { AppSectionHeader, AppSectionTitle } from "./app-section-header.tsx";
/** Inspect agent-authored source and manage app deployments. */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { Option } from "effect";
import type { App } from "@executor-js/sdk";
import type { AppSourceView } from "@executor-js/app-management/contracts";
import type { AppAcknowledgement, AppManagementProps } from "../../contracts/app-management.ts";
import { QueryView, useDashboard } from "./context.tsx";
import { Button } from "../components/button.tsx";
import { Input } from "../components/input.tsx";
import { SourceBrowser } from "./source-browser.tsx";
import { CopyButton } from "./code.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover.tsx";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  GitBranchIcon,
  GitCommitIcon,
  ArrowLeft02Icon,
  ArrowDown01Icon,
  Clock01Icon,
} from "@hugeicons/core-free-icons";

/** Products supply metadata reconciliation and navigation; source authoring belongs to agents. */
export function AppWorkspace<E>({
  app,
  atoms,
  Failure,
  onApp,
  view,
}: AppManagementProps<E> & {
  readonly app: App;
  readonly onApp: AppAcknowledgement;
  readonly view: "source" | "history";
}) {
  return (
    <QueryView
      query={atoms.source(app.id)}
      Failure={Failure}
      pending={<AppWorkspaceLoading view={view} />}
    >
      {(source) => (
        <WorkspaceSource
          key={app.id}
          app={app}
          atoms={atoms}
          Failure={Failure}
          source={source}
          onApp={onApp}
          view={view}
        />
      )}
    </QueryView>
  );
}
function WorkspaceSource<E>({
  app,
  atoms,
  Failure,
  source,
  onApp,
  view,
}: AppManagementProps<E> & {
  readonly app: App;
  readonly source: typeof AppSourceView.Type;
  readonly onApp: AppAcknowledgement;
  readonly view: "source" | "history";
}) {
  const deployed = useAtomValue(atoms.deploy(app.id));
  const deploy = useAtomSet(atoms.deploy(app.id), { mode: "promise" });
  const pending = deployed.waiting;
  return (
    <div className="source-section flex min-h-0 flex-1 flex-col [--source-sidebar-width:16rem]">
      <div className="grid min-h-12 shrink-0 grid-cols-[var(--source-sidebar-width)_minmax(0,1fr)] border-b max-md:grid-cols-1">
        <AppSectionHeader className="min-h-0 justify-start gap-2 border-b-0 border-r text-muted-foreground max-md:border-r-0">
          <HugeiconsIcon icon={GitBranchIcon} size={15} aria-hidden />
          <span className="font-mono text-foreground">main</span>
          <code title={source.revision.commit}>{source.revision.commit.slice(0, 7)}</code>
          <AppSectionTitle className="truncate text-foreground">Working source</AppSectionTitle>
        </AppSectionHeader>
        <AppSectionHeader className="min-h-0 flex-wrap border-b-0 text-muted-foreground">
          <SourceHistoryLink app={app} atoms={atoms} Failure={Failure} />
          <div className="flex flex-wrap items-center gap-2">
            <CloneRepository source={source} />
            <Button
              size="sm"
              disabled={!source.canEdit || pending}
              onClick={() => {
                void deploy({
                  commit: source.revision.commit,
                  onApp,
                }).catch(() => {});
              }}
            >
              Deploy
            </Button>
          </div>
        </AppSectionHeader>
      </div>
      {AsyncResult.isFailure(deployed) && (
        <div className="shrink-0 p-3">
          {AsyncResult.isFailure(deployed) && <Failure cause={deployed.cause} />}
        </div>
      )}
      {AsyncResult.isSuccess(deployed) && (
        <p role="status" className="shrink-0 border-b px-4 py-2 text-xs text-muted-foreground">
          Deployed. New calls use this version.
        </p>
      )}
      {view === "history" ? (
        <SourceHistory app={app} atoms={atoms} Failure={Failure} />
      ) : (
        <div className="flex min-h-0 flex-1 overflow-auto max-[1100px]:flex-col">
          <SourceBrowser
            files={source.files}
            className="h-auto min-h-80 min-w-0 flex-1 rounded-none border-0"
          />
        </div>
      )}
    </div>
  );
}
function CloneRepository({ source }: { readonly source: typeof AppSourceView.Type }) {
  const cloneUrl = window.location.origin + source.gitPath;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          Clone
          <HugeiconsIcon icon={ArrowDown01Icon} size={13} aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Clone repository">
        <h2 className="text-sm font-medium">Clone</h2>
        <div className="mt-4 border-b pb-2 text-xs font-medium">
          {window.location.protocol === "https:" ? "HTTPS" : "HTTP"}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Input
            aria-label="Git clone URL"
            readOnly
            value={cloneUrl}
            onFocus={(event) => event.target.select()}
            className="min-w-0 font-mono text-xs"
          />
          <CopyButton code={cloneUrl} label="Copy clone URL" inline />
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          {source.canEdit
            ? "Clone to work locally. Push your changes, then deploy when you’re ready."
            : "Clone to read the files locally. Make a copy to change this app."}
        </p>
      </PopoverContent>
    </Popover>
  );
}
function SourceHistoryLink<E>({
  app,
  atoms,
}: AppManagementProps<E> & {
  readonly app: App;
}) {
  const { AppLink } = useDashboard();
  const history = AsyncResult.value(useAtomValue(atoms.history(app.id)));
  // The endpoint returns recent history, not an unbounded repository-wide count.
  const label = Option.isSome(history)
    ? `${history.value.length} recent ${history.value.length === 1 ? "commit" : "commits"}`
    : "History";
  return (
    <AppLink
      app={app.id}
      view="history"
      aria-label={Option.isSome(history) ? `History: ${label}` : "History"}
      className="inline-flex min-h-8 items-center gap-1.5 whitespace-nowrap hover:text-foreground hover:underline"
    >
      <HugeiconsIcon icon={Clock01Icon} size={14} aria-hidden />
      {label}
    </AppLink>
  );
}
function SourceHistory<E>({ app, atoms, Failure }: AppManagementProps<E> & { readonly app: App }) {
  const { AppLink } = useDashboard();
  return (
    <section
      aria-label="Source history"
      className="min-h-0 flex-1 overflow-auto p-7 max-[740px]:p-4"
    >
      <div className="mb-5 flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold">History</h2>
        <AppLink
          app={app.id}
          view="source"
          className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <HugeiconsIcon icon={ArrowLeft02Icon} size={14} aria-hidden />
          Back to files
        </AppLink>
      </div>
      <QueryView query={atoms.history(app.id)} Failure={Failure} pending={<SourceHistoryLoading />}>
        {(history) =>
          history.length === 0 ? (
            <p className="text-sm text-muted-foreground">No saved changes yet.</p>
          ) : (
            <ol className="divide-y overflow-hidden rounded-lg border">
              {history.map((entry) => (
                <li key={entry.commit} className="flex items-start gap-3 p-4">
                  <HugeiconsIcon
                    icon={GitCommitIcon}
                    size={18}
                    className="mt-0.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-medium">{entry.message}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {entry.author} · {new Date(entry.timestamp * 1000).toLocaleString()}
                    </p>
                  </div>
                  <code className="shrink-0 text-xs text-muted-foreground" title={entry.commit}>
                    {entry.commit.slice(0, 7)}
                  </code>
                </li>
              ))}
            </ol>
          )
        }
      </QueryView>
    </section>
  );
}
