import { useMemo, useState, Suspense } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { TelemetryClient } from "../../contracts/client.ts";
import {
  PageContainer,
  RefreshButton,
  SeverityBadge,
  SearchInput,
  FilterPill,
  LoadingState,
  ErrorState,
  EmptyState,
} from "../components/shared.tsx";
import { formatTimestamp, serviceColor } from "../format.ts";

const SEVERITIES = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"] as const;

const logsQuery = (service: string | undefined, severity: string | undefined, body: string) =>
  TelemetryClient.query("telemetry", "logs", {
    query: {
      ...(service ? { service } : {}),
      ...(severity ? { severity } : {}),
      ...(body ? { body } : {}),
      limit: 200,
    },
  });

export function LogsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const service = searchParams.get("service") || undefined;
  const severity = searchParams.get("severity") || undefined;
  const [bodySearch, setBodySearch] = useState(searchParams.get("body") || "");

  const logsAtom = useMemo(
    () => logsQuery(service, severity, bodySearch),
    [service, severity, bodySearch],
  );

  const toggleSeverity = (sev: string) => {
    const p = new URLSearchParams(searchParams);
    if (severity === sev) p.delete("severity");
    else p.set("severity", sev);
    setSearchParams(p);
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const p = new URLSearchParams(searchParams);
    if (bodySearch) p.set("body", bodySearch);
    else p.delete("body");
    setSearchParams(p);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="border-b border-white/5 shrink-0">
        <PageContainer className="flex items-center gap-3 py-3">
          <form onSubmit={handleSearch} className="contents">
            <SearchInput
              value={bodySearch}
              onChange={setBodySearch}
              placeholder="Search log body..."
            />
          </form>
          <div className="flex gap-1">
            {SEVERITIES.map((sev) => (
              <FilterPill key={sev} active={severity === sev} onClick={() => toggleSeverity(sev)}>
                {sev}
              </FilterPill>
            ))}
          </div>
          <div className="ml-auto">
            <Suspense fallback={null}>
              <RefreshButton atom={logsAtom} />
            </Suspense>
          </div>
        </PageContainer>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-7xl">
          <Suspense fallback={<LoadingState message="Loading logs..." />}>
            <LogTable atom={logsAtom} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}

function LogTable({ atom }: { atom: ReturnType<typeof logsQuery> }) {
  const result = useAtomValue(atom);

  if (!AsyncResult.isSuccess(result)) {
    if (AsyncResult.isFailure(result)) return <ErrorState message="Failed to load logs" />;
    return <LoadingState message="Loading logs..." />;
  }

  const logs = result.value.data;
  if (!logs.length) return <EmptyState title="No logs found" />;

  return (
    <table className="w-full">
      <thead>
        <tr className="text-left text-sm text-zinc-500 sticky top-0 bg-zinc-950">
          <th className="whitespace-nowrap pb-2 pt-3 pl-6 pr-4 font-medium w-[7rem]">Time</th>
          <th className="whitespace-nowrap pb-2 pt-3 px-4 font-medium w-16">Level</th>
          <th className="whitespace-nowrap pb-2 pt-3 px-4 font-medium w-28">Service</th>
          <th className="whitespace-nowrap pb-2 pt-3 pl-4 pr-6 font-medium">Body</th>
        </tr>
      </thead>
      <tbody>
        {logs.map((log) => (
          <tr key={log.id} className="border-t border-white/5 hover:bg-white/[0.03]">
            <td className="py-2 pl-6 pr-4 text-sm tabular-nums text-zinc-500 align-top whitespace-nowrap">
              {formatTimestamp(log.timestamp)}
            </td>
            <td className="py-2 px-4 align-top">
              <SeverityBadge severity={log.severityText} />
            </td>
            <td
              className="py-2 px-4 text-sm align-top whitespace-nowrap"
              style={{ color: serviceColor(log.serviceName) }}
            >
              {log.serviceName}
            </td>
            <td className="py-2 pl-4 pr-6 text-sm text-zinc-300 whitespace-pre-wrap break-words align-top">
              {log.traceId ? (
                <Link
                  to={`/trace/${log.traceId}`}
                  className="text-inherit no-underline hover:text-accent"
                >
                  {log.body}
                </Link>
              ) : (
                log.body
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
