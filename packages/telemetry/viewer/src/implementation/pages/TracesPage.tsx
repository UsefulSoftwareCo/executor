import { useMemo, useRef, Suspense } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AsyncResult } from "effect/reactivity";
import { TelemetryClient } from "../../contracts/client.ts";
import { pagedList } from "../../contracts/paging.ts";
import {
  PageHeader,
  RefreshListButton,
  LiveBadge,
  LoadingState,
  ErrorState,
  EmptyState,
  ListEnd,
  listCount,
  usePagedList,
} from "../components/shared.tsx";
import { formatDuration, formatRelativeTime, serviceColor } from "../format.ts";

const tracesQuery = (service: string | undefined, cursor?: string) =>
  TelemetryClient.query("telemetry", "traces", {
    query: { ...(service ? { service } : {}), ...(cursor ? { cursor } : {}), limit: 100 },
  });

const tracesList = (service: string | undefined) =>
  pagedList(
    tracesQuery(service),
    (cursor) => tracesQuery(service, cursor),
    (trace) => trace.traceId,
  );

export function TracesPage() {
  const [searchParams] = useSearchParams();
  const service = searchParams.get("service") || undefined;

  const list = useMemo(() => tracesList(service), [service]);

  return (
    <div className="flex flex-col h-full">
      <PageHeader title={service ? `Traces / ${service}` : "Traces"}>
        <Suspense fallback={null}>
          <RefreshListButton list={list} />
        </Suspense>
      </PageHeader>
      <Suspense fallback={<LoadingState message="Loading traces..." />}>
        <TraceTable list={list} />
      </Suspense>
    </div>
  );
}

const ROW_HEIGHT = 44;

function TraceTable({ list }: { list: ReturnType<typeof tracesList> }) {
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);

  const { state, loadMore, retry } = usePagedList(list);
  const result = state.first;
  const traces = state.rows;

  // oxlint-disable-next-line react/incompatible-library -- this build does not run the React Compiler
  const virtualizer = useVirtualizer({
    count: traces.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  if (AsyncResult.isInitial(result)) {
    return <LoadingState message="Loading traces..." />;
  }
  if (AsyncResult.isFailure(result)) {
    return <ErrorState message="Failed to load traces" detail={String(result.cause)} />;
  }
  if (traces.length === 0) {
    return <EmptyState title="No traces found" description="Waiting for telemetry data..." />;
  }

  const items = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();

  return (
    <div ref={scrollRef} className="flex-1 overflow-auto min-h-0">
      <div className="mx-auto max-w-7xl">
        <table className="w-full">
          <thead className="sticky top-0 bg-zinc-950 z-10">
            <tr className="text-left text-sm text-zinc-500">
              <th className="whitespace-nowrap pb-3 pl-6 pr-4 font-medium">
                Operation <span className="text-zinc-600 tabular-nums">({listCount(state)})</span>
              </th>
              <th className="whitespace-nowrap pb-3 px-4 font-medium">Service</th>
              <th className="whitespace-nowrap pb-3 px-4 font-medium text-right">Duration</th>
              <th className="whitespace-nowrap pb-3 px-4 font-medium text-right">Spans</th>
              <th className="whitespace-nowrap pb-3 px-4 font-medium text-right">Errors</th>
              <th className="whitespace-nowrap pb-3 pl-4 pr-6 font-medium text-right">Time</th>
            </tr>
          </thead>
          <tbody>
            {items.length > 0 && items[0]!.start > 0 && (
              <tr>
                <td colSpan={6} style={{ height: items[0]!.start }} />
              </tr>
            )}
            {items.map((virtual) => {
              const t = traces[virtual.index]!;
              return (
                <tr
                  key={t.traceId}
                  data-index={virtual.index}
                  className="border-t border-white/5 cursor-pointer hover:bg-white/[0.03]"
                  style={{ height: ROW_HEIGHT }}
                  onClick={() => navigate(`/trace/${t.traceId}`)}
                >
                  <td className="py-3 pl-6 pr-4">
                    <p className="text-sm text-zinc-200 font-medium">
                      {t.isRunning && (
                        <span className="inline-block mr-2">
                          <LiveBadge />
                        </span>
                      )}
                      {t.rootOperationName}
                    </p>
                  </td>
                  <td className="py-3 px-4">
                    <p className="text-sm" style={{ color: serviceColor(t.serviceName) }}>
                      {t.serviceName}
                    </p>
                  </td>
                  <td className="py-3 px-4 text-right tabular-nums">
                    <p className="text-sm text-zinc-300">{formatDuration(t.durationMs)}</p>
                  </td>
                  <td className="py-3 px-4 text-right tabular-nums">
                    <p className="text-sm text-zinc-500">{t.spanCount}</p>
                  </td>
                  <td className="py-3 px-4 text-right tabular-nums">
                    {t.errorCount > 0 ? (
                      <p className="text-sm text-red-400">{t.errorCount}</p>
                    ) : (
                      <p className="text-sm text-zinc-600">&mdash;</p>
                    )}
                  </td>
                  <td className="py-3 pl-4 pr-6 text-right">
                    <p className="text-sm text-zinc-500">{formatRelativeTime(t.startedAt)}</p>
                  </td>
                </tr>
              );
            })}
            {items.length > 0 && items[items.length - 1]!.end < totalHeight && (
              <tr>
                <td colSpan={6} style={{ height: totalHeight - items[items.length - 1]!.end }} />
              </tr>
            )}
          </tbody>
        </table>
        <ListEnd noun="traces" state={state} onLoadMore={loadMore} onRetry={retry} />
      </div>
    </div>
  );
}
