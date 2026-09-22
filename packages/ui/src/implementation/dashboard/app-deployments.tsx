import { QueryResult, useQuery } from "./context.tsx";
import type { AppDeploymentsProps } from "../../contracts/dashboard.ts";
import { displayDate } from "../../contracts/dashboard.ts";
import { DeploymentSourceLoading } from "./app-loading.tsx";
import { SourceBrowser } from "./source-browser.tsx";
import { cn } from "../lib/utils.ts";

/** Deployment history and retained files occupy a full page; selection never changes the running app. */
export function AppDeployments<E>({
  app,
  deployments,
  deployment,
  onDeploymentChange,
  query,
  Failure,
  actions,
}: AppDeploymentsProps<E>) {
  const { result, refresh } = useQuery(query);
  const isActive = deployment === app.activeDeployment;
  return (
    <section aria-label="App deployments" className="flex min-h-0 flex-1 flex-col">
      <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)] max-[900px]:grid-cols-1 max-[900px]:grid-rows-[auto_minmax(0,1fr)]">
        <nav
          aria-label="Deployment history"
          className="min-h-0 overflow-auto border-r bg-muted/15 p-2 max-[900px]:max-h-48 max-[900px]:border-r-0 max-[900px]:border-b"
        >
          {deployments.map((item, index) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={item.id === deployment}
              onClick={() =>
                onDeploymentChange(item.id === app.activeDeployment ? undefined : item.id)
              }
              className={cn(
                "block w-full rounded-md px-3 py-3 text-left transition-colors hover:bg-muted focus-visible:outline-ring",
                item.id === deployment && "bg-muted",
              )}
            >
              <span className="flex items-center justify-between gap-3 text-sm font-medium">
                Version {deployments.length - index}
                {item.id === app.activeDeployment && (
                  <span className="rounded border px-1.5 py-0.5 text-[10px] font-normal">
                    Active
                  </span>
                )}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {displayDate(item.createdAt)}
              </span>
            </button>
          ))}
        </nav>
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-3 max-[740px]:px-4">
            <h3 className="text-sm font-medium">
              {isActive ? "Active deployment" : "Previous deployment"}
            </h3>
            {actions}
          </div>
          <QueryResult
            result={result}
            Failure={Failure}
            retry={refresh}
            pending={<DeploymentSourceLoading />}
          >
            {(source) => (
              <>
                <dl className="flex shrink-0 flex-wrap gap-x-8 gap-y-3 border-b px-5 py-3 text-xs max-[740px]:px-4">
                  <div className="flex items-center gap-2">
                    <dt className="text-muted-foreground">Deployed</dt>
                    <dd>{displayDate(source.createdAt)}</dd>
                  </div>
                  <div className="flex items-center gap-2">
                    <dt className="text-muted-foreground">Source</dt>
                    <dd>
                      {source.sourceCommit === null ? (
                        "Files"
                      ) : (
                        <code title={source.sourceCommit}>{source.sourceCommit.slice(0, 7)}</code>
                      )}
                    </dd>
                  </div>
                </dl>
                <SourceBrowser
                  files={source.files}
                  className="h-auto min-h-0 flex-1 rounded-none border-0"
                />
              </>
            )}
          </QueryResult>
        </div>
      </div>
    </section>
  );
}
