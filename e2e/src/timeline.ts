// The run's focus timeline: which window the scenario was acting on, when.
//
// Focus is DERIVED, never declared — driving a Playwright page focuses the
// browser window; pushing a chat/terminal event focuses the terminal. The
// surfaces call markFocus as a side effect of normal operations, so any
// scenario gets a faithful "where was the developer looking" track for
// free, and scripts/film.ts can cut the session recordings exactly where
// the action moved. Anchors map wall-clock to each recording's own clock.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type TimelineWindow = "terminal" | "browser";

export interface Timeline {
  /** Wall-clock ms when each recording's clock started. */
  readonly anchors: { terminal?: number; browser?: number };
  /** Focus transitions (first event per contiguous run of a window). */
  readonly focus: Array<{ at: number; window: TimelineWindow }>;
  /** Main-frame navigations — lets the viewer render a live URL bar. */
  readonly nav?: Array<{ at: number; url: string }>;
}

const fileFor = (runDir: string) => join(runDir, "timeline.json");

const read = (runDir: string): Timeline => {
  const file = fileFor(runDir);
  if (!existsSync(file)) return { anchors: {}, focus: [] };
  return JSON.parse(readFileSync(file, "utf8")) as Timeline;
};

const write = (runDir: string, timeline: Timeline) =>
  writeFileSync(fileFor(runDir), JSON.stringify(timeline, null, 1));

/** Record that `window`'s recording clock starts now. */
export const markRecordingStart = (runDir: string, window: TimelineWindow): void => {
  const timeline = read(runDir);
  write(runDir, {
    ...timeline,
    anchors: { ...timeline.anchors, [window]: Date.now() },
  });
};

/** Record that the scenario is acting on `window` (deduped per run). */
export const markFocus = (runDir: string, window: TimelineWindow): void => {
  const timeline = read(runDir);
  if (timeline.focus.at(-1)?.window === window) return;
  timeline.focus.push({ at: Date.now(), window });
  write(runDir, timeline);
};

/** Record a main-frame navigation (deduped against the previous URL). */
export const markNavigation = (runDir: string, url: string): void => {
  const timeline = read(runDir);
  const nav = timeline.nav ?? [];
  if (nav.at(-1)?.url === url) return;
  write(runDir, { ...timeline, nav: [...nav, { at: Date.now(), url }] });
};

export const readTimeline = (runDir: string): Timeline | null =>
  existsSync(fileFor(runDir)) ? read(runDir) : null;

// ---------------------------------------------------------------------------
// Human dwells — pacing for a watchable recording, owned by the framework.
//
// A scenario should never hand-code `waitForTimeout` to make a film readable;
// that's the recording's concern, not the scenario's. A dwell ("beat") is a
// property of a focus transition: when a developer tabs from one tool to
// another, they linger a moment to take in where they landed. So the surfaces
// beat on focus changes (enterFocus) and at the end of a visible step, and the
// splice reads like a person moving between apps.
//
// Beats apply ONLY when filming (E2E_FILM, also implied by the desk's E2E_DESK)
// — fast verification/CI runs, where nobody is watching, pay nothing.
// ---------------------------------------------------------------------------

const FILM_BEAT_MS = 1500;

/** True when this run is producing a recording meant to be watched. */
export const isFilming = (): boolean =>
  process.env.E2E_FILM === "1" || process.env.E2E_DESK === "1";

/** Hold for the viewer — a no-op unless this run is being filmed. */
export const beat = async (ms: number = FILM_BEAT_MS): Promise<void> => {
  if (!isFilming()) return;
  await new Promise((tick) => setTimeout(tick, ms));
};

/**
 * Focus `window`, lingering a beat on the OUTGOING window first when this is a
 * real focus change and we're filming — "look before you tab away". The first
 * focus of a run never beats (nothing to linger on).
 */
export const enterFocus = async (
  runDir: string,
  window: TimelineWindow,
  ms?: number,
): Promise<void> => {
  const previous = read(runDir).focus.at(-1)?.window;
  if (previous !== undefined && previous !== window) await beat(ms);
  markFocus(runDir, window);
};
