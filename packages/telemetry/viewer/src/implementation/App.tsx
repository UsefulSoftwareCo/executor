import { Suspense, useMemo } from "react";
import { NavLink, Route, Routes, Navigate } from "react-router-dom";
import { useAtomValue, useAtomMount } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { TelemetryClient } from "../contracts/client.ts";
import { PageContainer } from "./components/shared.tsx";
import { TracesPage } from "./pages/TracesPage.tsx";
import { TraceDetailPage } from "./pages/TraceDetailPage.tsx";
import { LogsPage } from "./pages/LogsPage.tsx";

function RuntimeMount() {
  useAtomMount(TelemetryClient.runtime);
  return null;
}

const navLinkCls = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1.5 rounded-md text-sm no-underline ${
    isActive ? "text-zinc-100 bg-white/10" : "text-zinc-400 hover:text-zinc-200 hover:bg-white/5"
  }`;

export function App() {
  return (
    <div className="flex flex-col h-full">
      <RuntimeMount />
      <header className="border-b border-white/5 shrink-0">
        <PageContainer className="flex items-center gap-6 py-3">
          <NavLink to="/" className="text-accent font-semibold text-sm no-underline tracking-tight">
            Executor telemetry
          </NavLink>
          <nav className="flex gap-1" role="list">
            <NavLink to="/traces" className={navLinkCls}>
              Traces
            </NavLink>
            <NavLink to="/logs" className={navLinkCls}>
              Logs
            </NavLink>
          </nav>
          <Suspense fallback={null}>
            <ServicePills />
          </Suspense>
        </PageContainer>
      </header>
      <div className="flex-1 overflow-auto">
        <Suspense
          fallback={
            <div className="flex items-center justify-center p-16 text-zinc-500 text-sm">
              Loading...
            </div>
          }
        >
          <Routes>
            <Route path="/" element={<Navigate to="/traces" replace />} />
            <Route path="/traces" element={<TracesPage />} />
            <Route path="/trace/:traceId" element={<TraceDetailPage />} />
            <Route path="/logs" element={<LogsPage />} />
          </Routes>
        </Suspense>
      </div>
    </div>
  );
}

function ServicePills() {
  const servicesAtom = useMemo(() => TelemetryClient.query("telemetry", "services", {}), []);
  const result = useAtomValue(servicesAtom);
  if (!AsyncResult.isSuccess(result)) return null;
  const services = result.value.data;
  if (services.length === 0) return null;

  return (
    <div className="flex gap-2 flex-wrap ml-auto">
      {services.map((s) => (
        <NavLink
          key={s}
          to={`/traces?service=${encodeURIComponent(s)}`}
          className="text-sm px-2.5 py-1 rounded-full border border-white/10 text-zinc-400 no-underline hover:text-zinc-200 hover:border-white/20"
        >
          {s}
        </NavLink>
      ))}
    </div>
  );
}
