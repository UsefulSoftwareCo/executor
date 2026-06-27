import React, { Suspense, useEffect, useState } from "react";

import type { EvidencePublicationMetadata } from "../../src/published-artifacts";
import type { ManifestArtifact, ManifestRun } from "../../src/viewer/manifest";
import PublicationBanner, { parsePublicationMetadata } from "./PublicationBanner";
import type { SessionTimeline } from "./SessionPlayer";
import {
  liveMotelViewerFromSearch,
  parsePortableTraceExport,
  type PortableTraceExport,
} from "./portable-traces";

const TestSource = React.lazy(() => import("./TestSource"));
const TerminalCast = React.lazy(() => import("./TerminalCast"));
const SessionPlayer = React.lazy(() => import("./SessionPlayer"));
const PortableTraceExplorer = React.lazy(() => import("./PortableTraceExplorer"));

// ---------------------------------------------------------------------------
// The matrix (scenario × target health) plus a per-run artifact page. The
// test SOURCE is where correctness is reviewed; this site only answers "is
// everything green" and hands you the debugging artifacts (Playwright trace,
// session video, screenshots, failure output) for any run.
// ---------------------------------------------------------------------------

interface Manifest {
  generatedAt: number;
  runs: ManifestRun[];
  skips: Array<{ scenario: string; target: string; missing: string[] }>;
}

interface RunResult {
  scenario: string;
  target: string;
  ok: boolean;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  error?: string;
  artifacts: string[];
}

export const runRoute = (target: string, slug: string): string =>
  `#/run/${encodeURIComponent(target)}/${encodeURIComponent(slug)}`;

const decodedRoutePart = (value: string | undefined) => {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
};

const useRoute = () => {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const routeParts = parts[0] === "run" ? parts.slice(1) : parts;
  const target = decodedRoutePart(routeParts[0]);
  const slug = decodedRoutePart(routeParts[1]);
  return target && slug ? { target, slug } : null;
};

export const App = () => {
  const route = useRoute();
  const [publication, setPublication] = useState<EvidencePublicationMetadata | null>();
  useEffect(() => {
    fetch("publication.json")
      .then((response) => (response.ok ? response.json() : null))
      .then((value) => setPublication(parsePublicationMetadata(value)))
      .catch(() => setPublication(null));
  }, []);
  return route ? (
    <RunView target={route.target} slug={route.slug} publication={publication} />
  ) : (
    <Matrix publication={publication} />
  );
};

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

const Matrix = ({
  publication,
}: {
  readonly publication: EvidencePublicationMetadata | null | undefined;
}) => {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch("manifest.json")
      .then((r) => r.json())
      .then(setManifest)
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="page error-text">failed to load manifest.json: {error}</div>;
  if (!manifest) return <div className="page dim">loading…</div>;

  const targets = [...new Set(manifest.runs.map((r) => r.target))].sort();
  const scenarios = [
    ...new Set([...manifest.runs, ...manifest.skips].map((r) => r.scenario)),
  ].sort();
  const runFor = (scenario: string, target: string) =>
    manifest.runs
      .filter((r) => r.scenario === scenario && r.target === target)
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
  const skipFor = (scenario: string, target: string) =>
    manifest.skips.find((s) => s.scenario === scenario && s.target === target);

  return (
    <div className="page">
      <PublicationBanner metadata={publication} />
      <h1>Executor e2e: every scenario, on every deployment</h1>
      <p className="hint">
        Click a result for that run's artifacts (Playwright trace, video, screenshots, failure
        output). "n/a" means the capability is unavailable on that target.
      </p>
      <table>
        <thead>
          <tr>
            <th>scenario</th>
            {targets.map((t) => (
              <th key={t}>{t}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {scenarios.map((scenario) => (
            <tr key={scenario}>
              <td>{scenario}</td>
              {targets.map((target) => {
                const run = runFor(scenario, target);
                if (run) {
                  return (
                    <td key={target}>
                      <a
                        className={`watch ${run.ok ? "ok" : "no"}`}
                        href={runRoute(run.target, run.slug)}
                      >
                        {run.ok ? "✓ passed" : "✗ FAILED"}
                        {run.durationMs != null && (
                          <span className="d"> {(run.durationMs / 1000).toFixed(1)}s</span>
                        )}
                        {run.portableTraceCount != null && run.portableTraceCount > 0 && (
                          <span className="d"> · {run.portableTraceCount} traces</span>
                        )}
                        {run.portableTraceMissing != null && run.portableTraceMissing > 0 && (
                          <span className="d"> · {run.portableTraceMissing} missing</span>
                        )}
                      </a>
                    </td>
                  );
                }
                return (
                  <td key={target} className="dim">
                    {skipFor(scenario, target) ? "n/a" : "·"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="stamp">generated {new Date(manifest.generatedAt).toLocaleString()}</p>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Run page: status + error + artifacts. The trace opens in Playwright's own
// viewer, SELF-HOSTED at /trace-viewer (copied out of playwright-core by
// rebuild-viewer.ts). trace.playwright.dev would work on localhost but not
// over tailscale: it's HTTPS, this server is HTTP, and browsers block the
// mixed-content fetch of trace.zip. Same-origin avoids all of it.
// ---------------------------------------------------------------------------

interface RunTraceRef {
  id: string;
  at: number;
  url: string;
  ms?: number;
  status?: number;
  source?: "terminal" | "browser";
  label?: string;
}

type RunTab = "session" | "browser" | "terminal" | "source";

const artifactUrl = (base: string, name: string): string => `${base}/${encodeURIComponent(name)}`;

export const ArtifactNavigation = ({
  base,
  artifacts,
}: {
  readonly base: string;
  readonly artifacts: ReadonlyArray<ManifestArtifact>;
}) => {
  if (artifacts.length === 0) return null;
  return (
    <section className="artifact-navigation" aria-labelledby="artifact-navigation-title">
      <h2 className="section" id="artifact-navigation-title">
        Persisted evidence
      </h2>
      <ul>
        {artifacts.map((artifact) => (
          <li key={artifact.name}>
            <a href={artifactUrl(base, artifact.name)} target="_blank" rel="noreferrer">
              <span>{artifact.label ?? artifact.name}</span>
              <code>{artifact.name}</code>
              <small>{artifact.kind}</small>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
};

const RunView = ({
  target,
  slug,
  publication,
}: {
  target: string;
  slug: string;
  publication: EvidencePublicationMetadata | null | undefined;
}) => {
  const base = `${encodeURIComponent(target)}/${encodeURIComponent(slug)}`;
  const [result, setResult] = useState<RunResult | null>(null);
  const [manifestRun, setManifestRun] = useState<ManifestRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<RunTab | null>(null);
  const [traces, setTraces] = useState<RunTraceRef[]>([]);
  const [timeline, setTimeline] = useState<SessionTimeline | null>(null);
  const [portableTraces, setPortableTraces] = useState<PortableTraceExport | null>(null);
  const [selectedTraceId, setSelectedTraceId] = useState<string>();
  const liveMotelViewer = liveMotelViewerFromSearch(window.location.search);
  const portableTraceIds = new Set(portableTraces?.traces.map((entry) => entry.traceId) ?? []);

  useEffect(() => {
    setPortableTraces(null);
    setSelectedTraceId(undefined);
    setManifestRun(null);
    fetch(`${base}/result.json`)
      .then((r) => r.json())
      .then(setResult)
      .catch((e) => setError(String(e)));
    fetch(`${base}/traces.json`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setTraces)
      .catch(() => setTraces([]));
    fetch(`${base}/timeline.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setTimeline)
      .catch(() => setTimeline(null));
    fetch(`${base}/otel-traces.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((value) => setPortableTraces(parsePortableTraceExport(value)))
      .catch(() => setPortableTraces(null));
    fetch("manifest.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((manifest: Manifest | null) =>
        setManifestRun(
          manifest?.runs.find((run) => run.target === target && run.slug === slug) ?? null,
        ),
      )
      .catch(() => setManifestRun(null));
  }, [base, slug, target]);

  if (error) return <div className="page error-text">failed to load run: {error}</div>;
  if (!result) return <div className="page dim">loading…</div>;

  const has = (name: string) => result.artifacts.includes(name);
  const screenshots = result.artifacts.filter((a) => a.endsWith(".png")).sort();
  const video = has("session.mp4") ? "session.mp4" : has("session.webm") ? "session.webm" : null;
  const film = has("film.mp4") ? "film.mp4" : null;
  const cast = has("terminal.cast") ? "terminal.cast" : null;
  const traceUrl = has("trace.zip")
    ? new URL(
        `trace-viewer/index.html?trace=${encodeURIComponent(
          new URL(`${base}/trace.zip`, window.location.href).toString(),
        )}`,
        window.location.href,
      ).toString()
    : null;
  // The live two-recording player needs both recordings AND a focus
  // timeline whose clocks are anchored. Anything less falls back to
  // film.mp4 (pre-rendered cuts) or the single recording.
  const playable = Boolean(
    cast &&
    video &&
    timeline &&
    timeline.focus.length >= 2 &&
    timeline.anchors.terminal !== undefined &&
    timeline.anchors.browser !== undefined,
  );

  const tabs: Array<{ id: RunTab; label: string; available: boolean }> = [
    { id: "session", label: "▶ session", available: playable || Boolean(film) },
    { id: "browser", label: "browser", available: Boolean(video) },
    { id: "terminal", label: "terminal", available: Boolean(cast) },
    { id: "source", label: "</> test source", available: has("test.ts") },
  ];
  const available = tabs.filter((entry) => entry.available);
  const active: RunTab | undefined = tab ?? available[0]?.id;

  return (
    <div className="page">
      <PublicationBanner metadata={publication} />
      <div className="topbar">
        <a href="#/">← all runs</a>
        <span>
          {traceUrl && (
            <a className="tool-link" href={traceUrl} target="_blank" rel="noreferrer">
              ⊙ open trace
            </a>
          )}
          {portableTraces && (
            <a
              className="tool-link"
              href={`${base}/otel-traces.json`}
              target="_blank"
              rel="noreferrer"
            >
              portable traces
            </a>
          )}
          <a className="tool-link" href={`${base}/result.json`} target="_blank" rel="noreferrer">
            result.json
          </a>
        </span>
      </div>
      <h1 className={result.ok ? "ok-text" : "error-text"}>
        {result.ok ? "✓ PASSED" : "✗ FAILED"} · {result.scenario}
      </h1>
      <p className="hint">
        {result.target} · {(result.durationMs / 1000).toFixed(1)}s ·{" "}
        {new Date(result.endedAt).toLocaleString()}
      </p>
      {result.error && <pre className="errbox">{result.error}</pre>}
      <ArtifactNavigation base={base} artifacts={manifestRun?.artifacts ?? []} />

      {available.length > 1 && (
        <div className="tabs">
          {available.map((entry) => (
            <button
              type="button"
              key={entry.id}
              className={active === entry.id ? "tab active" : "tab"}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}

      {active === "session" &&
        (playable && cast && video && timeline ? (
          <Suspense fallback={<p className="dim">loading session player…</p>}>
            <SessionPlayer
              castUrl={`${base}/${cast}`}
              videoUrl={`${base}/${video}`}
              timeline={timeline}
              traces={traces}
              playwrightTraceUrl={traceUrl}
              liveMotelViewer={liveMotelViewer}
              {...(portableTraceIds.size > 0
                ? { onInspectTrace: setSelectedTraceId, inspectableTraceIds: portableTraceIds }
                : {})}
            />
          </Suspense>
        ) : (
          film && (
            <video
              className="hero-video"
              controls
              autoPlay
              muted
              playsInline
              preload="auto"
              src={`${base}/${film}`}
            />
          )
        ))}

      {active === "browser" && video && (
        <>
          <video
            className="hero-video"
            controls
            muted
            playsInline
            preload="auto"
            src={`${base}/${video}`}
          />
          {screenshots.length > 0 && (
            <div className="shots">
              {screenshots.map((shot) => (
                <a key={shot} href={`${base}/${shot}`} target="_blank" rel="noreferrer">
                  <figure>
                    <img loading="lazy" src={`${base}/${shot}`} alt={shot} />
                    <figcaption className={shot === "failure.png" ? "error-text" : undefined}>
                      {labelOf(shot)}
                    </figcaption>
                  </figure>
                </a>
              ))}
            </div>
          )}
        </>
      )}

      {active === "terminal" && cast && (
        <Suspense fallback={<p className="dim">loading recording…</p>}>
          <TerminalCast url={`${base}/${cast}`} />
        </Suspense>
      )}

      {active === "source" && has("test.ts") && (
        <Suspense fallback={<p className="dim">loading test source…</p>}>
          <TestSource
            url={`${base}/test.ts`}
            {...(has("test-source-metadata.json")
              ? { metadataUrl: `${base}/test-source-metadata.json` }
              : {})}
          />
        </Suspense>
      )}

      {!active && screenshots.length === 0 && (
        <p className="dim">
          No visual artifacts. This surface's source of truth is the test code and its assertions.
        </p>
      )}

      {portableTraces && (
        <Suspense fallback={<p className="dim">loading portable traces…</p>}>
          <PortableTraceExplorer
            exportData={portableTraces}
            ledger={traces}
            selectedTraceId={selectedTraceId}
            onSelectTrace={setSelectedTraceId}
            liveMotelViewer={liveMotelViewer}
          />
        </Suspense>
      )}

      {/* Runs without a portable export retain the request ledger. A live
          Motel link appears only when the viewer was opened with ?motel=. */}
      {!portableTraces && active !== "session" && traces.length > 0 && (
        <>
          <h2 className="section">Distributed traces</h2>
          <p className="hint">
            The request ledger is available, but this run has no self-contained span export.
          </p>
          <table>
            <thead>
              <tr>
                <th>when</th>
                <th>request</th>
                <th>trace</th>
              </tr>
            </thead>
            <tbody>
              {traces.map((trace, index) => (
                <tr key={`${trace.id}-${index}`}>
                  <td className="dim">
                    {result.startedAt
                      ? `${((trace.at - result.startedAt) / 1000).toFixed(1)}s`
                      : new Date(trace.at).toLocaleTimeString()}
                  </td>
                  <td className="dim">{trace.url.replace(/^https?:\/\/[^/]+/, "")}</td>
                  <td>
                    {liveMotelViewer ? (
                      <a
                        className="tool-link"
                        href={`${liveMotelViewer}/trace/${trace.id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {trace.id.slice(0, 8)}…
                      </a>
                    ) : (
                      <code>{trace.id.slice(0, 8)}…</code>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
};

const labelOf = (file: string): string =>
  file
    .replace(/\.png$/, "")
    .replace(/^\d+-/, "")
    .replace(/-/g, " ");
