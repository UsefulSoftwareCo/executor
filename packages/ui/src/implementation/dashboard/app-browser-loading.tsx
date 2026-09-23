import { Skeleton } from "../components/skeleton.tsx";

/** The same horizontal skill navigation becomes a vertical list on desktop. */
export function SkillBrowserLoading() {
  return (
    <div
      role="status"
      aria-label="Loading skills"
      className="grid min-h-80 min-[900px]:grid-cols-[240px_minmax(0,1fr)]"
    >
      <div
        aria-hidden
        className="flex gap-1 overflow-hidden border-b p-3 min-[900px]:block min-[900px]:border-b-0 min-[900px]:border-r"
      >
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="shrink-0 rounded-md px-3 py-2.5 min-[900px]:w-full">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="mt-1 hidden h-10 w-full min-[900px]:block" />
          </div>
        ))}
      </div>
      <div aria-hidden className="min-w-0 px-5 py-5 min-[900px]:px-10">
        <div className="max-w-3xl">
          <div className="mb-6 flex min-h-9 items-center justify-between gap-3 border-b pb-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-8 w-20" />
          </div>
          <Skeleton className="mb-5 mt-2 h-6 w-2/3" />
          <div className="space-y-3">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-5/6" />
          </div>
          <Skeleton className="mb-4 mt-7 h-5 w-1/3" />
          <div className="space-y-3">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-4/5" />
            <Skeleton className="h-3.5 w-3/4" />
          </div>
        </div>
      </div>
      <span className="sr-only">Loading skills…</span>
    </div>
  );
}

/** Workflow rows reserve the same names, descriptions, status pills, and timestamps as real runs. */
export function WorkflowRunsLoading() {
  return (
    <div role="status" aria-label="Loading workflow runs">
      <div
        aria-hidden
        className="hidden grid-cols-[minmax(0,1fr)_100px_150px] gap-4 border-b px-3 pb-3 text-xs text-muted-foreground min-[640px]:grid"
      >
        <span>Workflow</span>
        <span>Status</span>
        <span>Started</span>
      </div>
      <div aria-hidden className="divide-y border-b">
        {Array.from({ length: 4 }, (_, i) => (
          <div
            key={i}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-3 py-4 min-[640px]:grid-cols-[minmax(0,1fr)_100px_150px]"
          >
            <div>
              <Skeleton className="h-5 w-36 max-w-full" />
              <Skeleton className="mt-1 h-5 w-64 max-w-full" />
            </div>
            <Skeleton className="h-6 w-16 rounded-full" />
            <Skeleton className="col-span-2 h-4 w-32 min-[640px]:col-span-1" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading workflow runs…</span>
    </div>
  );
}

/** Match workflow selection rows while their independent description read is pending. */
export function WorkflowNamesLoading() {
  return (
    <div role="status" aria-label="Loading workflow descriptions">
      {Array.from({ length: 4 }, (_, i) => (
        <div aria-hidden key={i} className="px-3 py-2.5">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="mt-1 h-10 w-full" />
        </div>
      ))}
      <span className="sr-only">Loading workflow descriptions…</span>
    </div>
  );
}

/** Match the complete workflow page before app metadata resolves. */
export function WorkflowBrowserLoading() {
  return (
    <section
      role="status"
      aria-label="Loading workflows"
      className="grid min-h-80 min-[900px]:grid-cols-[240px_minmax(0,1fr)]"
    >
      <div className="border-b p-3 min-[900px]:border-b-0 min-[900px]:border-r">
        <div aria-hidden className="mb-2 px-3 py-2.5">
          <Skeleton className="h-5 w-16" />
        </div>
        <WorkflowNamesLoading />
      </div>
      <div className="min-w-0 p-5 min-[900px]:p-7">
        <div aria-hidden className="mb-6">
          <Skeleton className="h-7 w-32" />
        </div>
        <WorkflowRunsLoading />
      </div>
    </section>
  );
}
