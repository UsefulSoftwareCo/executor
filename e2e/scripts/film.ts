// Film a run: turn a chat-theater run's real recordings into ONE mp4 that
// plays like a screen recording of a developer tabbing between full-screen
// windows — terminal, browser, terminal. Both segments are the genuine
// recordings; the only editorial act is the cut, exactly like real tabbing.
//
//   bun scripts/film.ts runs/<target>/<slug>
//
// The cut list comes from the run's focus timeline (src/timeline.ts):
// surfaces mark focus as a side effect of acting — a Playwright step
// focuses the browser, a chat event focuses the terminal — so the
// operations themselves decide where the film cuts, for any number of
// hops. Runs without a timeline fall back to the narrator-line / largest-
// gap heuristic. The cast renders with NO idle compression so cast time
// equals video time. Output: film.mp4, registered in result.json — the
// viewer plays it as the session when present.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { readTimeline } from "../src/timeline";

const runDir = resolve(process.argv[2] ?? "");
const castPath = join(runDir, "terminal.cast");
const browserPath = join(runDir, "session.mp4");
if (!existsSync(castPath) || !existsSync(browserPath)) {
  console.error(`film: need terminal.cast + session.mp4 in ${runDir}`);
  process.exit(1);
}

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: "pipe" });
const probeSeconds = (file: string): number =>
  Number(
    execFileSync("ffprobe", [
      ...["-v", "quiet", "-show_entries", "format=duration"],
      ...["-of", "csv=p=0", file],
    ])
      .toString()
      .trim(),
  );

// ---------------------------------------------------------------------------
// Build the cut list: acts of { source, from, to } in each source's clock.
// ---------------------------------------------------------------------------

interface CastEvent {
  readonly at: number;
  readonly text: string;
}

const events: CastEvent[] = readFileSync(castPath, "utf8")
  .split("\n")
  .slice(1)
  .filter(Boolean)
  .map((line) => JSON.parse(line) as [number, string, string])
  .filter((event) => event[1] === "o")
  .map((event) => ({ at: event[0], text: event[2] }));

const castEnd = events.at(-1)?.at ?? 0;

interface Act {
  readonly source: "terminal" | "browser";
  readonly from: number;
  readonly to: number;
}

/** Acts from the focus timeline: each contiguous focus run becomes a cut of
 *  that window's recording, mapped via the recording-start anchors. */
const actsFromTimeline = (): Act[] | null => {
  const timeline = readTimeline(runDir);
  if (!timeline || timeline.focus.length < 2) return null;
  const terminalAnchor = timeline.anchors.terminal;
  const browserAnchor = timeline.anchors.browser;
  if (terminalAnchor === undefined || browserAnchor === undefined) return null;

  const browserEnd = probeSeconds(browserPath);
  const toMedia = (window: Act["source"], wallMs: number) =>
    Math.max(0, (wallMs - (window === "terminal" ? terminalAnchor : browserAnchor)) / 1000);

  const acts: Act[] = [];
  for (let i = 0; i < timeline.focus.length; i += 1) {
    const current = timeline.focus[i];
    if (!current) continue;
    const nextAt = timeline.focus[i + 1]?.at;
    const from = i === 0 && current.window === "terminal" ? 0 : toMedia(current.window, current.at);
    const mediaEnd = current.window === "terminal" ? castEnd : browserEnd;
    const to =
      nextAt === undefined ? mediaEnd : Math.min(toMedia(current.window, nextAt), mediaEnd);
    if (to - from > 0.5) acts.push({ source: current.window, from, to });
  }
  return acts.length >= 2 ? acts : null;
};

/** Fallback for runs without a timeline: one browser hop located by the
 *  narrator line, or the largest output gap in the cast. */
const actsFromHeuristic = (): Act[] => {
  const findHop = (): { start: number; end: number } => {
    const markerIndex = events.findIndex((event) => event.text.includes("in the browser"));
    if (markerIndex !== -1) {
      const start = events[markerIndex];
      const after = events
        .slice(markerIndex + 1)
        .find((event) => event.at > (start?.at ?? 0) + 1 && event.text.trim().length > 0);
      if (start && after) return { start: start.at + 0.8, end: after.at };
    }
    let best = { start: 0, end: 0 };
    for (let i = 1; i < events.length; i += 1) {
      const previous = events[i - 1];
      const current = events[i];
      if (previous && current && current.at - previous.at > best.end - best.start) {
        best = { start: previous.at, end: current.at };
      }
    }
    return best;
  };
  const hop = findHop();
  if (hop.end - hop.start < 2) {
    console.error(`film: no browser hop found in the cast (gap ${hop.end - hop.start}s)`);
    process.exit(1);
  }
  return [
    { source: "terminal", from: 0, to: hop.start },
    { source: "browser", from: 0, to: probeSeconds(browserPath) },
    { source: "terminal", from: hop.end, to: castEnd },
  ];
};

const acts = actsFromTimeline() ?? actsFromHeuristic();

// ---------------------------------------------------------------------------
// Render + cut + concatenate onto one canvas — full-screen cuts, like
// tabbing.
// ---------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), "e2e-film-"));
const castGif = join(work, "cast.gif");
const castVideo = join(work, "cast.mp4");

run("agg", [
  ...["--idle-time-limit", String(Math.ceil(castEnd) + 60)],
  ...["--font-size", "16"],
  castPath,
  castGif,
]);
run("ffmpeg", [
  ...["-y", "-i", castGif],
  // agg's gif can have odd dimensions; libx264 requires even.
  ...["-vf", "scale=ceil(iw/2)*2:ceil(ih/2)*2"],
  ...["-pix_fmt", "yuv420p", "-r", "24", castVideo],
]);

const FIT =
  "scale=1280:800:force_original_aspect_ratio=decrease,pad=1280:800:(ow-iw)/2:(oh-ih)/2:color=0x0b0b10,setsar=1,fps=24,format=yuv420p";

const filmPath = join(runDir, "film.mp4");
const inputIndex = { terminal: 0, browser: 1 } as const;
const filters = acts.map(
  (act, index) =>
    `[${inputIndex[act.source]}:v]trim=${act.from.toFixed(2)}:${act.to.toFixed(2)},setpts=PTS-STARTPTS,${FIT}[act${index}]`,
);
run("ffmpeg", [
  "-y",
  ...["-i", castVideo],
  ...["-i", browserPath],
  "-filter_complex",
  [
    ...filters,
    `${acts.map((_, index) => `[act${index}]`).join("")}concat=n=${acts.length}:v=1:a=0[out]`,
  ].join(";"),
  ...["-map", "[out]"],
  ...["-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-movflags", "+faststart"],
  filmPath,
]);
rmSync(work, { recursive: true, force: true });

// Register the film in the run's artifact list so the viewer offers it.
const resultPath = join(runDir, "result.json");
if (existsSync(resultPath)) {
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as { artifacts?: string[] };
  if (Array.isArray(result.artifacts) && !result.artifacts.includes("film.mp4")) {
    result.artifacts.push("film.mp4");
    writeFileSync(resultPath, JSON.stringify(result, null, 1));
  }
}

console.log(
  `film: ${filmPath}\n${acts
    .map(
      (act, index) =>
        `  act ${index + 1} ${act.source} ${act.from.toFixed(1)}–${act.to.toFixed(1)}s`,
    )
    .join("\n")}`,
);
