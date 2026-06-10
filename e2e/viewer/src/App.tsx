import React, { Suspense, useEffect, useState } from "react";

const TestSource = React.lazy(() => import("./TestSource"));
const TerminalCast = React.lazy(() => import("./TerminalCast"));

// ---------------------------------------------------------------------------
// The matrix (scenario × target health) plus a per-run artifact page. The
// test SOURCE is where correctness is reviewed; this site only answers "is
// everything green" and hands you the debugging artifacts (Playwright trace,
// session video, screenshots, failure output) for any run.
// ---------------------------------------------------------------------------

interface ManifestRun {
  scenario: string;
  target: string;
  slug: string;
  ok: boolean;
  durationMs?: number;
  endedAt?: number;
}

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

const useRoute = () => {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  return parts.length >= 2 ? { target: parts[0], slug: parts[1] } : null;
};

export const App = () => {
  const route = useRoute();
  return route ? <RunView target={route.target} slug={route.slug} /> : <Matrix />;
};

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

const Matrix = () => {
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
      <h1>Executor e2e — every scenario, on every deployment</h1>
      <p className="hint">
        Click a result for that run's artifacts (Playwright trace, video, screenshots, failure
        output). “—” = capability not on that target.
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
                        href={`#/${run.target}/${run.slug}`}
                      >
                        {run.ok ? "✓ passed" : "✗ FAILED"}
                        {run.durationMs != null && (
                          <span className="d"> {(run.durationMs / 1000).toFixed(1)}s</span>
                        )}
                      </a>
                    </td>
                  );
                }
                return (
                  <td key={target} className="dim">
                    {skipFor(scenario, target) ? "—" : "·"}
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
// viewer (trace.playwright.dev fetches the zip from this server, client-side).
// ---------------------------------------------------------------------------

const RunView = ({ target, slug }: { target: string; slug: string }) => {
  const base = `${target}/${slug}`;
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"media" | "source">("media");

  useEffect(() => {
    fetch(`${base}/result.json`)
      .then((r) => r.json())
      .then(setResult)
      .catch((e) => setError(String(e)));
  }, [base]);

  if (error) return <div className="page error-text">failed to load run: {error}</div>;
  if (!result) return <div className="page dim">loading…</div>;

  const has = (name: string) => result.artifacts.includes(name);
  const screenshots = result.artifacts.filter((a) => a.endsWith(".png")).sort();
  const video = has("session.mp4") ? "session.mp4" : has("session.webm") ? "session.webm" : null;
  const cast = has("terminal.cast") ? "terminal.cast" : null;
  const media = video ?? cast;
  const traceUrl = has("trace.zip")
    ? `https://trace.playwright.dev/?trace=${encodeURIComponent(
        new URL(`${base}/trace.zip`, window.location.href).toString(),
      )}`
    : null;

  return (
    <div className="page">
      <div className="topbar">
        <a href="#/">← all runs</a>
        <span>
          {traceUrl && (
            <a className="tool-link" href={traceUrl} target="_blank" rel="noreferrer">
              ⊙ open trace
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
      {media && has("test.ts") && (
        <div className="tabs">
          <button
            className={tab === "media" ? "tab active" : "tab"}
            onClick={() => setTab("media")}
          >
            ▶ {video ? "video" : "terminal"}
          </button>
          <button
            className={tab === "source" ? "tab active" : "tab"}
            onClick={() => setTab("source")}
          >
            {"</>"} test source
          </button>
        </div>
      )}
      {(!media || tab === "source") && has("test.ts") && (
        <Suspense fallback={<p className="dim">loading test source…</p>}>
          {!media && <h2 className="section">The test</h2>}
          <TestSource url={`${base}/test.ts`} />
        </Suspense>
      )}
      {cast && !video && tab === "media" && (
        <Suspense fallback={<p className="dim">loading recording…</p>}>
          <TerminalCast url={`${base}/${cast}`} />
        </Suspense>
      )}
      {video && tab === "media" && (
        <>
          {/* muted is required for browsers to honor autoplay */}
          <video
            className="hero-video"
            controls
            autoPlay
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
      {!media && !has("test.ts") && screenshots.length === 0 && (
        <p className="dim">
          No visual artifacts — this surface's source of truth is the test code and its assertions.
        </p>
      )}
    </div>
  );
};

const labelOf = (file: string): string =>
  file
    .replace(/\.png$/, "")
    .replace(/^\d+-/, "")
    .replace(/-/g, " ");
