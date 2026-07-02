// One synced playback head over BOTH of a run's real recordings — the
// terminal cast and the browser video — driven by the run's focus timeline
// (timeline.json). Where film.mp4 bakes the cuts into pixels, this player
// performs them live: the active act decides which recording is on screen,
// a synthetic window chrome floats above it (terminal title bar, or a
// browser URL bar fed by the timeline's nav track with a deep link into
// the Playwright trace), and the scrubber carries the distributed-trace
// markers so "what request fired at this moment" is one glance away.
//
// The master clock is WALL CLOCK: focus entries are wall-contiguous, so
// session-time t maps to exactly one act, and each recording's own clock
// is recovered through its anchor (timeline.anchors). No idle compression
// anywhere — cast time must equal wall time for the cuts to land.
import { useEffect, useMemo, useRef, useState } from "react";
import * as AsciinemaPlayer from "asciinema-player";
import "asciinema-player/dist/bundle/asciinema-player.css";

export interface SessionTimeline {
  anchors: { terminal?: number; browser?: number };
  focus: Array<{ at: number; window: "terminal" | "browser" }>;
  nav?: Array<{ at: number; url: string }>;
}

export interface SessionTraceRef {
  id: string;
  at: number;
  url: string;
  /** Request duration (ms) — recorded by the surfaces at run time. */
  ms?: number;
  status?: number;
  /** Which window made the request: terminal (MCP/CLI) or browser. */
  source?: "terminal" | "browser";
  /** Readable name when the URL says nothing (MCP tool / JSON-RPC method). */
  label?: string;
}

interface Act {
  window: "terminal" | "browser";
  /** Session seconds. */
  from: number;
  /** Session seconds; Infinity until media durations resolve the last act. */
  to: number;
}

type CastPlayer = AsciinemaPlayer.Player;

const fmt = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** The cast's own duration: timestamp of its last event (the file is local
 *  and line-delimited, cheaper and more deterministic than player events). */
const fetchCastDuration = async (url: string): Promise<number> => {
  const text = await fetch(url).then((r) => r.text());
  const last = text.trimEnd().split("\n").at(-1);
  if (!last || last.startsWith("{")) return 0;
  return (JSON.parse(last) as [number])[0] ?? 0;
};

export const SessionPlayer = ({
  castUrl,
  videoUrl,
  timeline,
  traces,
  playwrightTraceUrl,
  motelViewer,
}: {
  castUrl: string;
  videoUrl: string;
  timeline: SessionTimeline;
  traces: SessionTraceRef[];
  playwrightTraceUrl: string | null;
  motelViewer: string;
}) => {
  const sessionStart = timeline.focus[0]?.at ?? 0;
  const terminalAnchor = timeline.anchors.terminal ?? sessionStart;
  const browserAnchor = timeline.anchors.browser ?? sessionStart;

  const castMount = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const castPlayer = useRef<CastPlayer | null>(null);
  // Session-time playhead the tick reads/writes without re-subscribing.
  const tRef = useRef(0);

  const [castDuration, setCastDuration] = useState<number | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);

  // Acts: each focus entry runs until the next one; the last runs until its
  // recording's end (anchored back into session time).
  const acts = useMemo<Act[]>(() => {
    const toSession = (wall: number) => (wall - sessionStart) / 1000;
    return timeline.focus.map((entry, index) => {
      const next = timeline.focus[index + 1];
      let to = Infinity;
      if (next) {
        to = toSession(next.at);
      } else if (entry.window === "terminal" && castDuration !== null) {
        to = toSession(terminalAnchor + castDuration * 1000);
      } else if (entry.window === "browser" && videoDuration !== null) {
        to = toSession(browserAnchor + videoDuration * 1000);
      }
      return { window: entry.window, from: toSession(entry.at), to };
    });
  }, [timeline, sessionStart, terminalAnchor, browserAnchor, castDuration, videoDuration]);

  const duration = acts.at(-1)?.to ?? 0;
  const ready = castDuration !== null && videoDuration !== null && Number.isFinite(duration);

  const actAt = (time: number): number => {
    for (let i = acts.length - 1; i >= 0; i -= 1) {
      const act = acts[i];
      if (act && time >= act.from - 0.001) return i;
    }
    return 0;
  };
  const activeAct = acts[actAt(t)];
  const activeWindow = activeAct?.window ?? "terminal";

  /** A recording's own clock for session-time `time`. */
  const mediaTime = (window: Act["window"], time: number): number =>
    Math.max(
      0,
      (sessionStart + time * 1000 - (window === "terminal" ? terminalAnchor : browserAnchor)) /
        1000,
    );

  // Mount the cast player once (no idle compression — sync needs real time).
  useEffect(() => {
    if (!castMount.current) return;
    const player = AsciinemaPlayer.create(castUrl, castMount.current, {
      autoPlay: false,
      controls: false,
      fit: "width",
      terminalFontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    });
    castPlayer.current = player;
    fetchCastDuration(castUrl).then(setCastDuration);
    return () => {
      castPlayer.current = null;
      player.dispose();
    };
  }, [castUrl]);

  // A cached mp4 can fire loadedmetadata before React attaches the handler;
  // poll until the element reports a duration so `ready` can't deadlock.
  useEffect(() => {
    const interval = setInterval(() => {
      const video = videoRef.current;
      if (video && video.readyState >= 1 && Number.isFinite(video.duration)) {
        setVideoDuration(video.duration);
        clearInterval(interval);
      }
    }, 150);
    return () => clearInterval(interval);
  }, [videoUrl]);

  /** Point both recordings at session-time `time`; play/pause to match. */
  const apply = async (time: number, play: boolean) => {
    const act = acts[actAt(time)];
    if (!act) return;
    const video = videoRef.current;
    const cast = castPlayer.current;
    if (act.window === "browser") {
      cast?.pause();
      if (video) {
        const target = Math.min(mediaTime("browser", time), (videoDuration ?? Infinity) - 0.05);
        if (Math.abs(video.currentTime - target) > 0.25) video.currentTime = target;
        if (play) await video.play().catch(() => {});
        else video.pause();
      }
    } else {
      videoRef.current?.pause();
      if (cast) {
        const target = Math.min(mediaTime("terminal", time), (castDuration ?? Infinity) - 0.05);
        const current = cast.getCurrentTime();
        const now = typeof current === "number" ? current : await current;
        if (Math.abs(now - target) > 0.25) await cast.seek(target);
        if (play) cast.play();
        else cast.pause();
      }
    }
  };

  // The tick: session time is read FROM the active recording (it is the
  // clock); crossing an act boundary swaps recordings.
  useEffect(() => {
    if (!playing || !ready) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      if (cancelled) return;
      const index = actAt(tRef.current);
      const act = acts[index];
      if (!act) return;
      let media: number;
      if (act.window === "browser") {
        media = videoRef.current?.currentTime ?? 0;
      } else {
        const current = castPlayer.current?.getCurrentTime() ?? 0;
        media = typeof current === "number" ? current : await current;
      }
      const wall = (act.window === "terminal" ? terminalAnchor : browserAnchor) + media * 1000;
      let next = Math.max(tRef.current, (wall - sessionStart) / 1000);
      if (next >= act.to - 0.05) {
        if (index === acts.length - 1) {
          setPlaying(false);
          next = duration;
        } else {
          next = act.to + 0.001;
          await apply(next, true);
        }
      }
      tRef.current = next;
      setT(next);
    }, 100);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, ready, acts]);

  const seekTo = async (time: number) => {
    const clamped = Math.min(Math.max(0, time), duration);
    tRef.current = clamped;
    setT(clamped);
    await apply(clamped, playing);
  };

  const toggle = async () => {
    const next = !playing;
    setPlaying(next);
    if (next && tRef.current >= duration - 0.1) {
      tRef.current = 0;
      setT(0);
    }
    await apply(tRef.current, next);
  };

  // Live URL: the last main-frame navigation at-or-before "now" (wall).
  const wallNow = sessionStart + t * 1000;
  const currentUrl =
    [...(timeline.nav ?? [])].reverse().find((entry) => entry.at <= wallNow + 250)?.url ?? "";

  // Trace markers in session time (only the ones inside the session).
  const traceMarks = useMemo(
    () =>
      traces
        .map((trace) => ({ ...trace, t: (trace.at - sessionStart) / 1000 }))
        .filter((trace) => trace.t >= 0),
    [traces, sessionStart],
  );
  // Duration bars are scaled to the slowest request — the question the rail
  // answers is "which of these was the slow one", not absolute ms.
  const slowest = Math.max(...traceMarks.map((mark) => mark.ms ?? 0), 1);

  // Keep the in-playback trace row visible in the rail.
  const railRef = useRef<HTMLDivElement>(null);
  const nowIndex = traceMarks.findLastIndex((mark) => mark.t <= t);
  useEffect(() => {
    if (!playing || nowIndex < 0) return;
    railRef.current
      ?.querySelectorAll(".trace-row")
      [nowIndex]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [nowIndex, playing]);

  return (
    <div className="player">
      <div className="player-split">
        <div className="player-main">
          {/* Synthetic window chrome — the recordings are chromeless, so the
              viewer restores what a developer would actually see: a terminal
              title bar, or a browser URL bar with the address the page is on. */}
          <div className={`chrome ${activeWindow}`}>
            <span className="lights">
              <i /> <i /> <i />
            </span>
            {activeWindow === "browser" ? (
              <>
                <span className="urlbar" title={currentUrl}>
                  <span className="lock">⌁</span>
                  {currentUrl.replace(/^https?:\/\//, "") || "about:blank"}
                </span>
                {playwrightTraceUrl && (
                  <a
                    className="chrome-link"
                    href={playwrightTraceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    ⊙ inspect in Playwright
                  </a>
                )}
              </>
            ) : (
              <span className="termtitle">terminal — agent chat</span>
            )}
          </div>

          {/* Both layers fill the same fixed-aspect stage; the inactive one
              hides with visibility (not display) so the cast keeps its
              measured size and the box never jumps at a cut. */}
          <div className="stage">
            <div
              className="layer"
              style={{
                visibility: activeWindow === "terminal" ? "visible" : "hidden",
              }}
            >
              <div ref={castMount} className="cast-stage" />
            </div>
            <div
              className="layer"
              style={{
                visibility: activeWindow === "browser" ? "visible" : "hidden",
              }}
            >
              <video
                ref={videoRef}
                src={videoUrl}
                muted
                playsInline
                preload="auto"
                onLoadedMetadata={(event) => setVideoDuration(event.currentTarget.duration)}
              />
            </div>
          </div>

          <div className="transport">
            <button className="playbtn" onClick={toggle} disabled={!ready}>
              {playing ? "⏸" : "▶"}
            </button>
            <div
              className="scrub"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                void seekTo(((event.clientX - rect.left) / rect.width) * duration);
              }}
            >
              {ready &&
                acts.map((act, index) => (
                  <span
                    key={index}
                    className={`seg ${act.window}`}
                    style={{
                      left: `${(act.from / duration) * 100}%`,
                      width: `${((act.to - act.from) / duration) * 100}%`,
                    }}
                    title={act.window}
                  />
                ))}
              {ready &&
                traceMarks.map((mark, index) => (
                  <span
                    key={`${mark.id}-${index}`}
                    className="tick"
                    style={{ left: `${(mark.t / duration) * 100}%` }}
                    title={`${mark.url.replace(/^https?:\/\/[^/]+/, "")} → trace ${mark.id.slice(0, 8)}`}
                  />
                ))}
              {ready && <span className="head" style={{ left: `${(t / duration) * 100}%` }} />}
            </div>
            <span className="clock">
              {fmt(t)} / {ready ? fmt(duration) : "…"}
            </span>
          </div>
        </div>

        {/* The trace rail: every API request the session made, beside the
            video it happened in, with a duration bar scaled to the slowest
            request — "why did that take so long" is answered at a glance.
            Rows seek the player; ids open motel's waterfall. */}
        {traceMarks.length > 0 && (
          <div className="trace-rail" ref={railRef}>
            <div className="rail-head">
              traces
              <span className="rail-sub">click = seek · id = waterfall</span>
            </div>
            {traceMarks.map((mark, index) => {
              const isNow = index === nowIndex;
              const slow = (mark.ms ?? 0) >= 1000;
              return (
                <div
                  key={`${mark.id}-${index}`}
                  className={`trace-row${isNow ? " now" : ""}`}
                  onClick={() => void seekTo(mark.t - 0.3)}
                  title={mark.url}
                >
                  <div className="trace-line">
                    <span className="trace-at">{fmt(mark.t)}</span>
                    {mark.source && (
                      <span className={`trace-src ${mark.source}`}>
                        {mark.source === "terminal" ? "⌨" : "⊕"}
                      </span>
                    )}
                    <span className="trace-path">
                      {mark.label ?? mark.url.replace(/^https?:\/\/[^/]+/, "")}
                    </span>
                    <span
                      className={`trace-ms${slow ? " slow" : ""}${
                        mark.status !== undefined && mark.status >= 400 ? " err" : ""
                      }`}
                    >
                      {mark.ms !== undefined ? `${mark.ms}ms` : "·"}
                    </span>
                  </div>
                  <div className="trace-meter">
                    <span
                      className={`trace-bar${slow ? " slow" : ""}`}
                      style={{
                        width: `${Math.max(((mark.ms ?? 0) / slowest) * 100, 1.5)}%`,
                      }}
                    />
                    <a
                      className="trace-id"
                      href={`${motelViewer}/trace/${mark.id}`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {mark.id.slice(0, 7)}
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default SessionPlayer;
