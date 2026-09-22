import { EmptyState, EmptyStatePanel } from "./empty-state.tsx";
import { useState, type ReactNode, type ComponentType } from "react";
import type { App, HostedWorkflow, WorkflowRun, WorkflowRunId } from "@executor-js/sdk";
import { Option } from "effect";
import type { WorkflowBindings } from "../../contracts/app-browser.ts";
import type { FailureProps } from "../../contracts/dashboard.ts";
import { QueryView, QueryResult, useQuery } from "./context.tsx";
import { WorkflowNamesLoading, WorkflowRunsLoading } from "./app-browser-loading.tsx";
import { Button } from "../components/button.tsx";

const statuses: Record<WorkflowRun["status"], string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  paused: "Paused",
  waitingForPause: "Pausing",
  complete: "Complete",
  errored: "Failed",
  terminated: "Terminated",
};
type WorkflowOutput = Extract<WorkflowRun, { status: "complete" }>["output"];

interface WorkflowActions {
  readonly start?: ((definition: HostedWorkflow, onStarted: () => void) => ReactNode) | undefined;
  readonly runAction?:
    | ((
        run: WorkflowRun,
        workflow: string | undefined,
        cursor: WorkflowRunId | undefined,
      ) => ReactNode)
    | undefined;
}
/** Runs remain the primary view and load independently of workflow descriptions. */
export function AppWorkflows<E>({
  app,
  bindings,
  Failure,
  enabled = true,
  start,
  runAction,
}: WorkflowActions & {
  readonly enabled?: boolean;
  readonly app: App;
  readonly bindings: WorkflowBindings<E>;
  readonly Failure: ComponentType<FailureProps<E>>;
}) {
  if (app.activeDeployment === null)
    return (
      <section aria-label="App workflows" className="min-h-full">
        <EmptyStatePanel title="No deployment yet">
          Deploy this app to use its workflows.
        </EmptyStatePanel>
      </section>
    );
  if (!enabled)
    return (
      <section aria-label="Workflow run history" className="p-5">
        <WorkflowRuns
          workflow={undefined}
          workflows={[]}
          bindings={bindings}
          Failure={Failure}
          runAction={runAction}
        />
      </section>
    );
  return (
    <WorkflowBrowser bindings={bindings} Failure={Failure} start={start} runAction={runAction} />
  );
}
function WorkflowBrowser<E>({
  bindings,
  Failure,
  start,
  runAction,
}: WorkflowActions & {
  readonly bindings: WorkflowBindings<E>;
  readonly Failure: ComponentType<FailureProps<E>>;
}) {
  const [workflow, setWorkflow] = useState<string>();
  const definitions = useQuery(bindings.workflows);
  const workflows = Option.isSome(definitions.data) ? definitions.data.value : [];
  const selected = workflows.find((item) => item.name === workflow);
  return (
    <section aria-label="App workflows" className="min-h-full">
      <div className="grid min-h-80 min-[900px]:grid-cols-[240px_minmax(0,1fr)]">
        <nav
          aria-label="Workflows"
          className="border-b p-3 min-[900px]:border-b-0 min-[900px]:border-r"
        >
          <button
            type="button"
            aria-current={workflow === undefined ? "true" : undefined}
            onClick={() => setWorkflow(undefined)}
            className="mb-2 w-full rounded-md px-3 py-2.5 text-left text-sm font-medium hover:bg-muted aria-[current=true]:bg-muted"
          >
            All runs
          </button>
          <QueryResult
            result={definitions.result}
            retry={definitions.refresh}
            Failure={Failure}
            pending={<WorkflowNamesLoading />}
          >
            {(items) =>
              items.length === 0 ? (
                <EmptyState size="compact" icon={null} title="No workflows">
                  This deployment has no workflows.
                </EmptyState>
              ) : (
                items.map((item) => (
                  <button
                    type="button"
                    key={item.name}
                    aria-current={workflow === item.name ? "true" : undefined}
                    onClick={() => setWorkflow(item.name)}
                    className="w-full rounded-md px-3 py-2.5 text-left hover:bg-muted aria-[current=true]:bg-muted"
                  >
                    <span className="block break-words text-sm font-medium">{item.name}</span>
                    {item.description && (
                      <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                        {item.description}
                      </span>
                    )}
                  </button>
                ))
              )
            }
          </QueryResult>
        </nav>
        <section aria-label="Workflow run history" className="min-w-0 p-5 min-[900px]:p-7">
          <div className="mb-6">
            <h3 className="text-lg font-semibold tracking-tight">{workflow ?? "Recent runs"}</h3>
            {selected?.description && (
              <p className="mt-1 text-sm text-muted-foreground">{selected.description}</p>
            )}
          </div>
          <WorkflowRuns
            key={workflow === undefined ? "all-workflows" : `workflow:${workflow}`}
            workflow={workflow}
            start={start}
            runAction={runAction}
            workflows={workflows}
            bindings={bindings}
            Failure={Failure}
          />
        </section>
      </div>
    </section>
  );
}
function WorkflowRuns<E>({
  workflow,
  workflows,
  bindings,
  Failure,
  start,
  runAction,
}: WorkflowActions & {
  readonly workflow: string | undefined;
  readonly workflows: readonly HostedWorkflow[];
  readonly bindings: WorkflowBindings<E>;
  readonly Failure: ComponentType<FailureProps<E>>;
}) {
  const [pages, setPages] = useState<readonly (WorkflowRunId | undefined)[]>([undefined]);
  const cursor = pages[pages.length - 1];
  const selected = workflows.find((item) => item.name === workflow);
  return (
    <>
      {selected && start?.(selected, () => setPages([undefined]))}
      <QueryView
        query={bindings.runs(workflow, cursor)}
        Failure={Failure}
        pending={<WorkflowRunsLoading />}
      >
        {(page) => (
          <>
            <RunList
              key={cursor ?? "first"}
              runs={page.items}
              workflows={workflows}
              action={(run) => runAction?.(run, workflow, cursor)}
            />
            {(pages.length > 1 || page.next !== undefined) && (
              <div className="mt-4 flex items-center justify-between gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pages.length === 1}
                  onClick={() => setPages(pages.slice(0, -1))}
                >
                  Newer runs
                </Button>
                <span className="text-xs text-muted-foreground">Page {pages.length}</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page.next === undefined}
                  onClick={() => {
                    if (page.next !== undefined) setPages([...pages, page.next]);
                  }}
                >
                  Older runs
                </Button>
              </div>
            )}
          </>
        )}
      </QueryView>
    </>
  );
}
function RunList({
  runs,
  workflows,
  action,
}: {
  readonly action: (run: WorkflowRun) => ReactNode;
  readonly runs: readonly WorkflowRun[];
  readonly workflows: readonly HostedWorkflow[];
}) {
  const [selected, setSelected] = useState<string>();
  if (runs.length === 0)
    return (
      <EmptyState title="No runs yet">
        Workflow runs will appear here after a workflow starts.
      </EmptyState>
    );
  return (
    <div>
      <div className="hidden grid-cols-[minmax(0,1fr)_100px_150px] gap-4 border-b px-3 pb-3 text-xs text-muted-foreground min-[640px]:grid">
        <span>Workflow</span>
        <span>Status</span>
        <span>Started</span>
      </div>
      <div className="divide-y border-b">
        {runs.map((run) => (
          <div key={run.id}>
            <button
              type="button"
              onClick={() => setSelected(selected === run.id ? undefined : run.id)}
              aria-expanded={selected === run.id}
              aria-label={`View ${run.workflow} run: ${statuses[run.status]}`}
              className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-3 py-4 text-left hover:bg-muted/40 aria-expanded:bg-muted/40 min-[640px]:grid-cols-[minmax(0,1fr)_100px_150px]"
            >
              <span className="min-w-0">
                <span className="block break-words text-sm font-medium">{run.workflow}</span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  {workflows.find((item) => item.name === run.workflow)?.description}
                </span>
              </span>
              <span
                className={`w-fit rounded-full px-2 py-1 text-[11px] font-medium ${run.status === "complete" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : run.status === "errored" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}
              >
                {statuses[run.status]}
              </span>
              <time
                className="col-span-2 text-xs text-muted-foreground min-[640px]:col-span-1"
                dateTime={run.createdAt}
                title={new Date(run.createdAt).toLocaleString()}
              >
                {new Date(run.createdAt).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </time>
            </button>
            {selected === run.id && (
              <section
                aria-label="Workflow run details"
                className="space-y-5 bg-muted/20 px-5 py-5"
              >
                {action(run)}
                {run.status === "complete" && (
                  <div>
                    <h4 className="mb-3 text-xs font-medium text-muted-foreground">Result</h4>
                    {run.output === null ? (
                      <p className="text-sm">Completed without a result.</p>
                    ) : (
                      <RunOutput value={run.output} />
                    )}
                  </div>
                )}
                {run.status === "errored" && (
                  <p className="text-sm text-destructive">Failure reason: {run.error}</p>
                )}
                {run.status !== "complete" && run.status !== "errored" && (
                  <p className="text-sm">{statuses[run.status]}</p>
                )}
              </section>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
/** Render returned values as readable fields without presenting code or inferred explanations. */
function RunOutput({ value }: { readonly value: WorkflowOutput }) {
  if (value === null) return <span className="text-muted-foreground">No value</span>;
  if (typeof value !== "object")
    return (
      <p className="whitespace-pre-wrap break-words text-sm">
        {typeof value === "boolean" ? (value ? "Yes" : "No") : String(value)}
      </p>
    );
  if (Array.isArray(value))
    return value.length === 0 ? (
      <p className="text-sm text-muted-foreground">No items</p>
    ) : (
      <ol className="space-y-3 pl-5 list-decimal text-sm">
        {value.map((item, index) => (
          <li key={index}>
            <RunOutput value={item} />
          </li>
        ))}
      </ol>
    );
  const fields = Object.entries(value);
  return fields.length === 0 ? (
    <p className="text-sm text-muted-foreground">No fields</p>
  ) : (
    <dl className="space-y-3">
      {fields.map(([name, item]) => (
        <div
          key={name}
          className="grid gap-1 min-[640px]:grid-cols-[140px_minmax(0,1fr)] min-[640px]:gap-4"
        >
          <dt className="break-words text-xs text-muted-foreground">{name}</dt>
          <dd className="min-w-0">
            <RunOutput value={item} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
