import React, { useEffect, useMemo, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types mirroring e2e/src/schema.ts (the run.json contract).
// ---------------------------------------------------------------------------

type Evidence =
  | { kind: "screenshot"; path: string; label?: string }
  | { kind: "video"; path: string; startMs?: number; endMs?: number }
  | { kind: "termFrames"; frames: Array<{ t: number; text: string }> }
  | { kind: "json"; label?: string; data: unknown }
  | { kind: "ledger"; service: string; entries: unknown[] };

interface Assertion {
  kind: string;
  actual: unknown;
  expected: unknown;
  ok: boolean;
  label?: string;
}

type Turn = {
  t: number;
  role: "user" | "assistant" | "auth" | "tool" | "step" | "assert" | "error";
  kind?: string;
  phase?: string;
  text?: string;
  surface?: string;
  call?: { name: string; args: unknown };
  result?: unknown;
  ok?: boolean;
  durationMs?: number;
  assertion?: Assertion;
  evidence?: Evidence[];
};

interface Run {
  scenario: string;
  target: string;
  ok: boolean;
  durationMs?: number;
  error?: string;
  meta: Record<string, unknown>;
  turns: Turn[];
}

interface Manifest {
  generatedAt: number;
  runs: Array<{
    scenario: string;
    target: string;
    slug: string;
    ok: boolean;
    durationMs?: number;
    endedAt?: number;
  }>;
  skips: Array<{ scenario: string; target: string; missing: string[] }>;
}

// ---------------------------------------------------------------------------
// Tiny hash router: "#/" → matrix, "#/<target>/<slug>" → run.
// ---------------------------------------------------------------------------

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
// Matrix: scenario rows × target columns.
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
  const latestFor = (scenario: string) =>
    manifest.runs
      .filter((r) => r.scenario === scenario)
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];

  return (
    <div className="page">
      <h1>Executor e2e — every scenario, on every deployment</h1>
      <p className="hint">
        Rows are scenarios, columns are deployments. <b>Click any result to watch that run</b> —
        video, screenshots, steps and assertions. “—” = capability not on that target.
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
          {scenarios.map((scenario) => {
            const latest = latestFor(scenario);
            return (
              <tr key={scenario}>
                <td>
                  {latest ? (
                    <a className="scn" href={`#/${latest.target}/${latest.slug}`}>
                      {scenario}
                    </a>
                  ) : (
                    scenario
                  )}
                </td>
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
                          <span className="play"> ▶ watch</span>
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
            );
          })}
        </tbody>
      </table>
      <p className="stamp">generated {new Date(manifest.generatedAt).toLocaleString()}</p>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Run view: hero video + transcript. Step clips seek the hero video.
// ---------------------------------------------------------------------------

const RunView = ({ target, slug }: { target: string; slug: string }) => {
  const base = `${target}/${slug}`;
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [visible, setVisible] = useState<number>(Infinity);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    fetch(`${base}/run.json`)
      .then((r) => r.json())
      .then(setRun)
      .catch((e) => setError(String(e)));
  }, [base]);

  // Replay mode: reveal turns one by one with role-appropriate pacing.
  useEffect(() => {
    if (!replaying || !run) return;
    let i = 0;
    let cancelled = false;
    const delays: Record<string, number> = {
      user: 700,
      assistant: 1200,
      auth: 500,
      tool: 900,
      step: 1100,
      assert: 500,
      error: 600,
    };
    const tick = () => {
      if (cancelled) return;
      i += 1;
      setVisible(i);
      if (i < run.turns.length) {
        setTimeout(tick, delays[run.turns[i - 1]?.role ?? "step"] ?? 700);
      } else {
        setReplaying(false);
      }
    };
    setVisible(0);
    setTimeout(tick, 400);
    return () => {
      cancelled = true;
    };
  }, [replaying, run]);

  const heroVideo = useMemo(() => {
    if (!run) return undefined;
    for (let i = run.turns.length - 1; i >= 0; i--) {
      const ev = run.turns[i].evidence?.find(
        (e): e is Extract<Evidence, { kind: "video" }> => e.kind === "video" && e.startMs == null,
      );
      if (ev) return ev.path;
    }
    return undefined;
  }, [run]);

  const seekTo = (ms: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = ms / 1000;
    void video.play();
    video.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  if (error) return <div className="page error-text">failed to load run: {error}</div>;
  if (!run) return <div className="page dim">loading…</div>;

  return (
    <div className="page">
      <div className="topbar">
        <a href="#/">← all runs</a>
        <button
          className="replay-btn"
          onClick={() => {
            if (replaying) {
              setReplaying(false);
              setVisible(Infinity);
            } else {
              setReplaying(true);
            }
          }}
        >
          {replaying ? "■ show all" : "▶ replay"}
        </button>
      </div>
      <h1 className={run.ok ? "ok-text" : "error-text"}>
        {run.ok ? "✓ PASSED" : "✗ FAILED"} · {run.scenario}
      </h1>
      <p className="hint">
        {run.target} · {((run.durationMs ?? 0) / 1000).toFixed(1)}s
        {typeof run.meta.baseUrl === "string" ? ` · ${run.meta.baseUrl}` : ""}
      </p>
      {heroVideo && (
        <div className="hero">
          <video ref={videoRef} controls preload="metadata" src={`${base}/${heroVideo}`} />
          <p className="dim small">
            The full session recording — “▶” buttons on steps jump to that moment.
          </p>
        </div>
      )}
      <div className="chat">
        {run.turns.map((turn, i) => (
          <div key={i} className={`row ${i < visible ? "in" : "hidden"}`}>
            <TurnView
              turn={turn}
              base={base}
              onSeek={seekTo}
              animate={replaying && i === visible - 1}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Turn + evidence renderers.
// ---------------------------------------------------------------------------

const TurnView = ({
  turn,
  base,
  onSeek,
  animate,
}: {
  turn: Turn;
  base: string;
  onSeek: (ms: number) => void;
  animate: boolean;
}) => {
  switch (turn.role) {
    case "user":
      return <div className="u">{turn.text}</div>;
    case "assistant":
      return <div className="a">{animate ? <Typewriter text={turn.text ?? ""} /> : turn.text}</div>;
    case "auth":
      return (
        <div className="au">
          {turn.phase === "connected" ? "🔓" : "🔐"} {turn.text}
        </div>
      );
    case "tool":
      return (
        <div className="t">
          <span className="srf">{turn.surface}</span>🔧 <b>{turn.call?.name}</b>{" "}
          {turn.ok ? "✓" : "✗"}{" "}
          <span className="g">
            → {String(turn.text ?? "").slice(0, 110)}
            {turn.durationMs != null && ` · ${turn.durationMs}ms`}
          </span>
          <details>
            <summary>args + result</summary>
            <pre>{JSON.stringify({ args: turn.call?.args, result: turn.result }, null, 2)}</pre>
          </details>
          <EvidenceList evidence={turn.evidence} base={base} onSeek={onSeek} />
        </div>
      );
    case "step":
      return (
        <div className="st">
          <span className="srf">{turn.surface}</span>
          <span className="lbl">{turn.text}</span>
          <EvidenceList evidence={turn.evidence} base={base} onSeek={onSeek} />
        </div>
      );
    case "assert": {
      const a = turn.assertion;
      if (!a) return null;
      return (
        <div className={`x ${a.ok ? "ok" : "no"}`}>
          {a.ok ? "✅" : "❌"} expect({JSON.stringify(a.actual)}).{a.kind}(
          {JSON.stringify(a.expected)}){a.label ? ` — ${a.label}` : ""}
        </div>
      );
    }
    case "error":
      return (
        <div className="e">
          💥 {turn.text}
          <EvidenceList evidence={turn.evidence} base={base} onSeek={onSeek} />
        </div>
      );
    default:
      return null;
  }
};

const EvidenceList = ({
  evidence,
  base,
  onSeek,
}: {
  evidence?: Evidence[];
  base: string;
  onSeek: (ms: number) => void;
}) => (
  <>
    {(evidence ?? []).map((ev, i) => {
      if (ev.kind === "screenshot") {
        return (
          <a key={i} href={`${base}/${ev.path}`} target="_blank" rel="noreferrer">
            <img loading="lazy" src={`${base}/${ev.path}`} alt={ev.label ?? ""} />
          </a>
        );
      }
      if (ev.kind === "video" && ev.startMs != null) {
        return (
          <button key={i} className="clip" onClick={() => onSeek(ev.startMs!)}>
            ▶ {(ev.startMs / 1000).toFixed(1)}s
          </button>
        );
      }
      if (ev.kind === "video") {
        return null; // the hero video renders it
      }
      if (ev.kind === "termFrames") {
        return <TermFrames key={i} frames={ev.frames} />;
      }
      if (ev.kind === "json") {
        return (
          <details key={i}>
            <summary>{ev.label ?? "data"}</summary>
            <pre>{JSON.stringify(ev.data, null, 2)}</pre>
          </details>
        );
      }
      if (ev.kind === "ledger") {
        return (
          <div key={i} className="ledger">
            <b>{ev.service} emulator saw:</b>
            {ev.entries.map((entry, j) => (
              <div key={j} className="le">
                {typeof entry === "string" ? entry : JSON.stringify(entry)}
              </div>
            ))}
          </div>
        );
      }
      return null;
    })}
  </>
);

/** Animated terminal pane: plays the captured screen frames like a cast. */
const TermFrames = ({ frames }: { frames: Array<{ t: number; text: string }> }) => {
  const [index, setIndex] = useState(frames.length - 1);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    if (index >= frames.length - 1) {
      setPlaying(false);
      return;
    }
    const gap = Math.min(Math.max(frames[index + 1].t - frames[index].t, 80), 700);
    const id = setTimeout(() => setIndex((v) => v + 1), gap);
    return () => clearTimeout(id);
  }, [playing, index, frames]);

  return (
    <div>
      <pre className="term">{frames[index]?.text ?? ""}</pre>
      <button
        className="clip"
        onClick={() => {
          setIndex(0);
          setPlaying(true);
        }}
      >
        ▶ replay terminal ({frames.length} frames)
      </button>
    </div>
  );
};

const Typewriter = ({ text }: { text: string }) => {
  const [count, setCount] = useState(0);
  useEffect(() => {
    setCount(0);
    const id = setInterval(() => {
      setCount((value) => {
        if (value >= text.length) {
          clearInterval(id);
          return value;
        }
        return value + 2;
      });
    }, 24);
    return () => clearInterval(id);
  }, [text]);
  return (
    <span>
      {text.slice(0, count)}
      {count < text.length && <span className="cur" />}
    </span>
  );
};
