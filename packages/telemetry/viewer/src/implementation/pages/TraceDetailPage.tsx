import { useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type { LogItem } from "../../contracts/api.ts";

import { TelemetryClient } from "../../contracts/client.ts";
import { pagedList, type PagedListState } from "../../contracts/paging.ts";
import {
  ListEnd,
  listCount,
  usePagedList,
  useRestartList,
  PageContainer,
  RefreshButton,
  SeverityBadge,
  LiveBadge,
  TabButton,
  LoadingState,
  ErrorState,
  EmptyState,
} from "../components/shared.tsx";
import { formatDuration, formatTimestamp, serviceColor } from "../format.ts";
import { Waterfall } from "../components/Waterfall.tsx";
import { SpanDetailPanel } from "../components/SpanDetail.tsx";

export function TraceDetailPage() {
  const { traceId = "" } = useParams<{ traceId: string }>();

  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"waterfall" | "logs">("waterfall");

  const traceAtom = useMemo(
    () => TelemetryClient.query("telemetry", "trace", { params: { traceId } }),
    [traceId],
  );
  const logsList = useMemo(() => traceLogsList(traceId), [traceId]);

  const traceResult = useAtomValue(traceAtom);
  const logsPaging = usePagedList(logsList);
  const refreshTrace = useAtomRefresh(traceAtom);
  const restartLogs = useRestartList(logsList);
  // The trace and its logs are one view: Refresh reads both again, the logs from their first page.
  const refresh = () => {
    refreshTrace();
    restartLogs();
  };

  if (!traceId) return <EmptyState title="No trace ID" />;
  if (!AsyncResult.isSuccess(traceResult)) {
    if (AsyncResult.isFailure(traceResult)) return <ErrorState message="Trace not found" />;
    return <LoadingState message="Loading trace..." />;
  }

  const trace = traceResult.value.data;
  const logs = logsPaging.state.rows;
  const logsComplete = logsPaging.state.end.status === "complete";
  const selectedSpan = selectedSpanId
    ? (trace.spans.find((s) => s.spanId === selectedSpanId) ?? null)
    : null;
  const selectedSpanLogs = selectedSpanId ? logs.filter((l) => l.spanId === selectedSpanId) : [];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <PageContainer className="pt-4 pb-3 border-b border-white/5">
        <Link to="/traces" className="text-sm text-zinc-500 no-underline hover:text-zinc-300">
          &larr; Traces
        </Link>
        <div className="flex items-start gap-4 mt-1.5">
          <div className="min-w-0 flex-1">
            <h1
              className="text-base font-semibold text-zinc-100 text-balance truncate"
              title={trace.rootOperationName}
            >
              {trace.rootOperationName}
            </h1>
            <dl className="flex gap-x-5 gap-y-1 text-sm mt-1 items-center flex-wrap">
              <div className="flex items-center gap-1.5">
                <span
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: serviceColor(trace.serviceName) }}
                />
                <dt className="sr-only">Service</dt>
                <dd className="text-zinc-300">{trace.serviceName}</dd>
              </div>
              <div className="flex items-center gap-1.5">
                <dt className="text-zinc-600">Duration</dt>
                <dd className="text-zinc-300 tabular-nums">{formatDuration(trace.durationMs)}</dd>
              </div>
              <div className="flex items-center gap-1.5">
                <dt className="text-zinc-600">Spans</dt>
                <dd className="text-zinc-300 tabular-nums">{trace.spanCount.toLocaleString()}</dd>
              </div>
              {trace.errorCount > 0 && (
                <div className="flex items-center gap-1.5">
                  <dt className="text-zinc-600">Errors</dt>
                  <dd className="text-red-400 tabular-nums">{trace.errorCount}</dd>
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <dt className="text-zinc-600">Started</dt>
                <dd className="text-zinc-300 tabular-nums">{formatTimestamp(trace.startedAt)}</dd>
              </div>
              {trace.isRunning && <LiveBadge />}
            </dl>
          </div>
          <RefreshButton onRefresh={refresh} />
        </div>
      </PageContainer>

      {/* Tabs */}
      <PageContainer className="flex gap-1 py-2 border-b border-white/5">
        <TabButton active={activeTab === "waterfall"} onClick={() => setActiveTab("waterfall")}>
          Waterfall
        </TabButton>
        <TabButton active={activeTab === "logs"} onClick={() => setActiveTab("logs")}>
          Logs ({AsyncResult.isSuccess(logsPaging.state.first) ? listCount(logsPaging.state) : "…"})
        </TabButton>
      </PageContainer>

      {/* Body — full page width for the waterfall */}
      <div className="flex flex-1 overflow-hidden w-full">
        {activeTab === "waterfall" ? (
          <>
            <Waterfall
              spans={trace.spans}
              traceStartMs={trace.startedAt.getTime()}
              traceDurationMs={trace.durationMs}
              selectedSpanId={selectedSpanId}
              onSelectSpan={setSelectedSpanId}
              logs={logs}
              logsComplete={logsComplete}
            />
            {selectedSpan && (
              <SpanDetailPanel
                span={selectedSpan}
                logs={selectedSpanLogs}
                logsComplete={logsComplete}
                onClose={() => setSelectedSpanId(null)}
              />
            )}
          </>
        ) : (
          <TraceLogsView
            state={logsPaging.state}
            onLoadMore={logsPaging.loadMore}
            onRetry={logsPaging.retry}
            onSelectSpan={setSelectedSpanId}
          />
        )}
      </div>
    </div>
  );
}

const traceLogsQuery = (traceId: string, cursor?: string) =>
  TelemetryClient.query("telemetry", "traceLogs", {
    params: { traceId },
    query: { ...(cursor ? { cursor } : {}), limit: 200 },
  });

const traceLogsList = (traceId: string) =>
  pagedList(
    traceLogsQuery(traceId),
    (cursor) => traceLogsQuery(traceId, cursor),
    (log) => log.id,
  );

function TraceLogsView<E>({
  state,
  onLoadMore,
  onRetry,
  onSelectSpan,
}: {
  state: PagedListState<LogItem, E>;
  onLoadMore: () => void;
  onRetry: () => void;
  onSelectSpan: (id: string | null) => void;
}) {
  if (AsyncResult.isFailure(state.first)) {
    return (
      <div className="flex-1">
        <ErrorState message="Failed to load this trace's logs" />
      </div>
    );
  }
  if (!AsyncResult.isSuccess(state.first)) {
    return (
      <div className="flex-1">
        <LoadingState message="Loading logs..." />
      </div>
    );
  }
  const logs = state.rows;
  if (logs.length === 0) {
    return (
      <div className="flex-1">
        <EmptyState title="No logs for this trace" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <table className="w-full">
        <thead>
          <tr className="text-left text-sm text-zinc-500 sticky top-0 bg-zinc-950">
            <th className="whitespace-nowrap pb-2 pt-3 pl-6 pr-4 font-medium w-[7rem]">Time</th>
            <th className="whitespace-nowrap pb-2 pt-3 px-4 font-medium w-16">Level</th>
            <th className="whitespace-nowrap pb-2 pt-3 pl-4 pr-6 font-medium">Body</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => (
            <tr
              key={log.id}
              className={`border-t border-white/5 ${log.spanId ? "cursor-pointer hover:bg-white/[0.03]" : ""}`}
              onClick={() => log.spanId && onSelectSpan(log.spanId)}
            >
              <td className="py-1.5 pl-6 pr-4 text-sm tabular-nums text-zinc-500 align-top">
                {formatTimestamp(log.timestamp)}
              </td>
              <td className="py-1.5 px-4 align-top">
                <SeverityBadge severity={log.severityText} />
              </td>
              <td className="py-1.5 pl-4 pr-6 text-sm whitespace-pre-wrap break-words text-zinc-300">
                {log.body}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ListEnd noun="logs" state={state} onLoadMore={onLoadMore} onRetry={onRetry} />
    </div>
  );
}
