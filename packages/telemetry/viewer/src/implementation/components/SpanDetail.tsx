import { Fragment } from "react";
import { formatDuration, formatTimestamp, serviceColor } from "../format.ts";
import { Section, SeverityBadge, StatusBadge, ServiceBadge } from "./shared.tsx";
import type { TraceSpanItem } from "../../contracts/api.ts";

interface Props {
  span: TraceSpanItem;
  logs: ReadonlyArray<{ id: string; timestamp: Date; severityText: string; body: string }>;
  /** False while the trace has log pages that are not loaded, so `logs` may be missing some. */
  logsComplete: boolean;
  onClose: () => void;
}

export function SpanDetailPanel({ span, logs, logsComplete, onClose }: Props) {
  const tags = Object.entries(span.tags);

  return (
    <div className="w-[440px] min-w-80 border-l border-white/5 overflow-auto bg-zinc-900/50 shrink-0">
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-zinc-100 truncate" title={span.operationName}>
          {span.operationName}
        </p>
        <button
          className="bg-transparent border-none text-zinc-500 cursor-pointer text-sm px-2 py-1 rounded hover:text-zinc-300 hover:bg-white/5 shrink-0"
          onClick={onClose}
        >
          &times;
        </button>
      </div>

      {/* Overview */}
      <Section title="Overview">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-zinc-500 font-medium">Service</dt>
          <dd>
            <ServiceBadge name={span.serviceName} color={serviceColor(span.serviceName)} />
          </dd>

          <dt className="text-zinc-500 font-medium">Status</dt>
          <dd>
            <StatusBadge status={span.status} isRunning={span.isRunning} />
          </dd>

          <dt className="text-zinc-500 font-medium">Duration</dt>
          <dd className="tabular-nums text-zinc-300">{formatDuration(span.durationMs)}</dd>

          <dt className="text-zinc-500 font-medium">Started</dt>
          <dd className="tabular-nums text-zinc-300">{formatTimestamp(span.startTime)}</dd>

          {span.kind && (
            <>
              <dt className="text-zinc-500 font-medium">Kind</dt>
              <dd className="text-zinc-300">{span.kind}</dd>
            </>
          )}
          {span.scopeName && (
            <>
              <dt className="text-zinc-500 font-medium">Scope</dt>
              <dd className="text-zinc-300">{span.scopeName}</dd>
            </>
          )}

          <dt className="text-zinc-500 font-medium">Span ID</dt>
          <dd className="text-zinc-400 text-sm tabular-nums break-all">{span.spanId}</dd>

          {span.parentSpanId && (
            <>
              <dt className="text-zinc-500 font-medium">Parent</dt>
              <dd className="text-zinc-400 text-sm tabular-nums break-all">{span.parentSpanId}</dd>
            </>
          )}
        </dl>
      </Section>

      {span.warnings.length > 0 && (
        <Section title="Warnings">
          {span.warnings.map((w) => (
            <p key={w} className="text-amber-400 text-sm mb-1">
              {w}
            </p>
          ))}
        </Section>
      )}

      {tags.length > 0 && (
        <Section title={`Attributes (${tags.length})`}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {tags.map(([k, v]) => (
              <Fragment key={k}>
                <dt className="text-zinc-500 truncate max-w-32">{k}</dt>
                <dd className="text-zinc-300 break-all">{v}</dd>
              </Fragment>
            ))}
          </dl>
        </Section>
      )}

      {span.events.length > 0 && (
        <Section title={`Events (${span.events.length})`}>
          {span.events.map((evt) => (
            <div
              key={`${evt.timestamp.getTime()}-${evt.name}`}
              className="py-2 border-b border-white/5 last:border-0"
            >
              <p className="text-sm font-medium text-zinc-200">{evt.name}</p>
              <p className="text-sm text-zinc-500 tabular-nums">{formatTimestamp(evt.timestamp)}</p>
              {Object.entries(evt.attributes).length > 0 && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm mt-1.5">
                  {Object.entries(evt.attributes).map(([k, v]) => (
                    <Fragment key={k}>
                      <dt className="text-zinc-500">{k}</dt>
                      <dd className="text-zinc-300 break-all">{v}</dd>
                    </Fragment>
                  ))}
                </dl>
              )}
            </div>
          ))}
        </Section>
      )}

      {(logs.length > 0 || !logsComplete) && (
        <Section
          title={logsComplete ? `Logs (${logs.length})` : `Logs (${logs.length} loaded so far)`}
        >
          {!logsComplete && (
            <p className="text-sm text-zinc-500 mb-2">
              This trace has more logs than are loaded. Load more on the Logs tab.
            </p>
          )}
          <div className="space-y-2">
            {logs.map((log) => (
              <div key={log.id}>
                <div className="flex items-center gap-2">
                  <span className="text-sm tabular-nums text-zinc-500">
                    {formatTimestamp(log.timestamp)}
                  </span>
                  <SeverityBadge severity={log.severityText} />
                </div>
                <p className="text-sm whitespace-pre-wrap break-words text-zinc-300 mt-0.5">
                  {log.body}
                </p>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
