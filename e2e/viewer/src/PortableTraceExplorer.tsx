import { useMemo, useState } from "react";

import {
  formatTraceDuration,
  waterfallPosition,
  type PortableTraceExport,
  type PortableTraceSpan,
} from "./portable-traces";

interface TraceLedgerRef {
  readonly id: string;
  readonly url: string;
  readonly label?: string;
}

const displayPath = (value: string): string => value.replace(/^https?:\/\/[^/]+/, "") || value;

const SpanDetails = ({ span }: { span: PortableTraceSpan }) => {
  const tags = Object.entries(span.tags);
  return (
    <div className="portable-span-details">
      <div className="portable-detail-heading">
        <strong>{span.operationName}</strong>
        <span>{span.spanId}</span>
      </div>
      <dl>
        <dt>service</dt>
        <dd>{span.serviceName}</dd>
        {span.scopeName && (
          <>
            <dt>scope</dt>
            <dd>{span.scopeName}</dd>
          </>
        )}
        {span.kind && (
          <>
            <dt>kind</dt>
            <dd>{span.kind}</dd>
          </>
        )}
        <dt>duration</dt>
        <dd>{formatTraceDuration(span.durationMs)}</dd>
        <dt>status</dt>
        <dd className={span.status === "error" ? "error-text" : "ok-text"}>{span.status}</dd>
      </dl>
      {tags.length > 0 && (
        <div className="portable-detail-section">
          <h4>attributes</h4>
          <dl className="portable-tags">
            {tags.map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {span.warnings.length > 0 && (
        <div className="portable-detail-section">
          <h4>warnings</h4>
          <ul className="portable-warnings">
            {span.warnings.map((warning, index) => (
              <li key={`${warning}-${index}`}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      {span.events.length > 0 && (
        <div className="portable-detail-section">
          <h4>events</h4>
          <ul className="portable-events">
            {span.events.map((event, index) => (
              <li key={`${event.name}-${event.timestamp}-${index}`}>
                <strong>{event.name}</strong>
                <span>{event.timestamp || "timestamp unavailable"}</span>
                {Object.keys(event.attributes).length > 0 && (
                  <code>{JSON.stringify(event.attributes)}</code>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export const PortableTraceExplorer = ({
  exportData,
  ledger,
  selectedTraceId,
  onSelectTrace,
  liveMotelViewer,
}: {
  exportData: PortableTraceExport;
  ledger: ReadonlyArray<TraceLedgerRef>;
  selectedTraceId?: string;
  onSelectTrace: (traceId: string) => void;
  liveMotelViewer?: string;
}) => {
  const [selectedSpanId, setSelectedSpanId] = useState<string>();
  const ledgerById = useMemo(
    () => new Map(ledger.map((entry) => [entry.id, entry] as const)),
    [ledger],
  );
  const selectedEntry =
    exportData.traces.find((entry) => entry.traceId === selectedTraceId) ?? exportData.traces[0];
  const trace = selectedEntry?.data;
  const selectedSpan =
    trace?.spans.find((span) => span.spanId === selectedSpanId) ?? trace?.spans[0];

  if (!trace || !selectedEntry) {
    return (
      <section className="portable-traces">
        <h2 className="section">Portable distributed traces</h2>
        <p className="hint">The exporter produced no complete traces for this run.</p>
      </section>
    );
  }

  return (
    <section className="portable-traces" id={`trace-${selectedEntry.traceId}`}>
      <div className="portable-trace-title">
        <div>
          <h2 className="section">Portable distributed traces</h2>
          <p className="hint">
            Self-contained span trees captured before telemetry teardown. Select a span for its
            attributes, events, and warnings.
          </p>
        </div>
        {liveMotelViewer && (
          <a
            className="tool-link"
            href={`${liveMotelViewer}/trace/${selectedEntry.traceId}`}
            target="_blank"
            rel="noreferrer"
          >
            open live Motel
          </a>
        )}
      </div>

      <div className="portable-trace-grid">
        <nav className="portable-trace-list" aria-label="Exported traces">
          {exportData.traces.map((entry) => {
            const request = ledgerById.get(entry.traceId);
            const active = entry.traceId === selectedEntry.traceId;
            return (
              <button
                type="button"
                key={entry.traceId}
                className={active ? "active" : undefined}
                aria-pressed={active}
                aria-label={`Trace ${request?.label ?? displayPath(request?.url ?? entry.data.rootOperationName)}, ${formatTraceDuration(entry.data.durationMs)}, ${entry.data.spanCount} spans${entry.data.errorCount > 0 ? `, ${entry.data.errorCount} errors` : ""}`}
                onClick={() => {
                  setSelectedSpanId(undefined);
                  onSelectTrace(entry.traceId);
                }}
              >
                <span>
                  {request?.label ?? displayPath(request?.url ?? entry.data.rootOperationName)}
                </span>
                <small>
                  {formatTraceDuration(entry.data.durationMs)} · {entry.data.spanCount} spans
                  {entry.data.errorCount > 0 ? ` · ${entry.data.errorCount} errors` : ""}
                </small>
                <code>{entry.traceId.slice(0, 12)}</code>
              </button>
            );
          })}
        </nav>

        <div className="portable-waterfall">
          <header>
            <div>
              <strong>{trace.rootOperationName}</strong>
              <span>{trace.serviceName}</span>
            </div>
            <div className="portable-trace-summary">
              <span>{formatTraceDuration(trace.durationMs)}</span>
              <span>{trace.spanCount} spans</span>
              <span className={trace.errorCount > 0 ? "error-text" : "ok-text"}>
                {trace.errorCount > 0 ? `${trace.errorCount} errors` : "ok"}
              </span>
            </div>
          </header>

          {trace.warnings.length > 0 && (
            <ul className="portable-warnings trace-warnings">
              {trace.warnings.map((warning, index) => (
                <li key={`${warning}-${index}`}>{warning}</li>
              ))}
            </ul>
          )}

          <div className="portable-span-list" aria-label={`Spans for ${trace.rootOperationName}`}>
            {trace.spans.map((span) => {
              const position = waterfallPosition(trace, span);
              const active = span.spanId === selectedSpan?.spanId;
              return (
                <button
                  type="button"
                  key={span.spanId}
                  className={`${span.status}${active ? " active" : ""}`}
                  aria-pressed={active}
                  aria-label={`${span.operationName}, ${span.serviceName}, ${formatTraceDuration(span.durationMs)}, ${span.status}`}
                  onClick={() => setSelectedSpanId(span.spanId)}
                  title={`${span.operationName} (${formatTraceDuration(span.durationMs)})`}
                >
                  <span
                    className="portable-span-name"
                    style={{ paddingLeft: `${span.depth * 14}px` }}
                  >
                    <i>{span.status === "error" ? "!" : span.depth > 0 ? "↳" : "●"}</i>
                    <span>{span.operationName}</span>
                    <small>{span.serviceName}</small>
                  </span>
                  <span className="portable-span-track">
                    <i
                      className={span.status}
                      style={{ left: `${position.left}%`, width: `${position.width}%` }}
                    />
                  </span>
                  <span className="portable-span-duration">
                    {formatTraceDuration(span.durationMs)}
                  </span>
                </button>
              );
            })}
          </div>

          {selectedSpan && <SpanDetails span={selectedSpan} />}
        </div>
      </div>

      {(exportData.missing.length > 0 || exportData.invalidTraceIds.length > 0) && (
        <p className="portable-export-warning">
          Export incomplete: {exportData.missing.length} missing,{" "}
          {exportData.invalidTraceIds.length} invalid trace IDs.
        </p>
      )}
    </section>
  );
};

export default PortableTraceExplorer;
