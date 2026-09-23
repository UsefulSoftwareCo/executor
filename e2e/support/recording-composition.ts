/** Select footage by driver-call order, including repeated switches between the same windows. */
import { Effect, FileSystem, Path, Schema } from "effect";
import { BrowserDriver } from "./browser.ts";
import { driver } from "./platform.ts";
import { RecordingTimeline } from "./recording-focus.ts";
import { probeRecording, runFFmpeg } from "./recording.ts";
import { firstTerminalOutput } from "./terminal-recording.ts";

type Activity = (typeof RecordingTimeline.Type)["activities"][number];
const focusSpans = (activities: ReadonlyArray<Activity>) => {
  const spans: { window: string; startedAtMs: number; endedAtMs: number; operations: string[] }[] =
    [];
  for (const activity of activities) {
    const previous = spans.at(-1);
    if (previous?.window === activity.window) {
      previous.endedAtMs = Math.max(previous.endedAtMs, activity.endedAtMs);
      previous.operations.push(activity.label);
    } else spans.push({ ...activity, operations: [activity.label] });
  }
  return spans.map((span, index) => {
    const next = spans[index + 1]?.startedAtMs ?? Infinity;
    // Include a still-running operation when focus returns to its window.
    const activeUntil = activities
      .filter(
        (activity) =>
          activity.window === span.window &&
          activity.startedAtMs < next &&
          activity.endedAtMs >= span.startedAtMs,
      )
      .reduce((end, activity) => Math.max(end, activity.endedAtMs), span.endedAtMs);
    // A newer call wins, even if an earlier operation is still waiting for a response.
    return { ...span, endedAtMs: Math.min(activeUntil + 300, next) };
  });
};
/** Export one film from the recorded focus timeline. Originals and measured timings stay intact. */
export const renderFocusedRecording = (directory: string, origin: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path,
        browser = yield* BrowserDriver;
      const timeline = yield* fs
        .readFileString(path.join(directory, "recording-timeline.json"))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RecordingTimeline))));
      if (timeline.activities.length === 0) return null;
      const temporary = yield* fs.makeTempDirectoryScoped({ directory, prefix: "composition-" });
      const width = 1440,
        height = 1032,
        barHeight = 72;
      const page = yield* Effect.acquireRelease(
        driver("create recording headings", () =>
          browser.newPage({ viewport: { width, height: barHeight }, deviceScaleFactor: 1 }),
        ),
        (page) => driver("close recording headings", () => page.close()).pipe(Effect.orDie),
      );
      yield* driver("window heading template", () =>
        page.setContent(
          `<style>body{margin:0;background:#202124;color:#f1f3f4;font:28px Arial,sans-serif;height:72px;display:flex;align-items:center;gap:24px;padding:0 24px;box-sizing:border-box}strong{font-size:23px;white-space:nowrap}span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}</style><strong></strong><span></span>`,
        ),
      );
      const sources = yield* Effect.forEach(timeline.windows, (window) =>
        Effect.gen(function* () {
          const source = path.join(directory, window.file);
          const media = yield* probeRecording(source);
          const contentStartMs =
            window.kind === "terminal"
              ? yield* firstTerminalOutput(source.replace(/\.mp4$/, ".termctrl"))
              : null;
          const heading = path.join(temporary, `${window.id}.png`);
          if (window.kind === "terminal") {
            yield* driver("name recorded window", () =>
              page.locator("strong").evaluate((element, text) => {
                element.textContent = text;
              }, window.title),
            );
            yield* driver("show recording target", () =>
              page.locator("span").evaluate((element, text) => {
                element.textContent = text;
              }, origin),
            );
            yield* driver("capture window heading", () => page.screenshot({ path: heading }));
          }
          return { window, media, source, heading, contentStartMs };
        }),
      );
      const clips = yield* Effect.forEach(focusSpans(timeline.activities), (span, index) =>
        Effect.gen(function* () {
          const source = sources.find((source) => source.window.id === span.window);
          if (!source) return yield* Effect.die(new Error("Focus refers to an unrecorded window"));
          const { window, media } = source;
          let start = Math.max(0, (span.startedAtMs - window.startedAtMs) / 1000);
          let end = Math.max(start, (span.endedAtMs - window.startedAtMs) / 1000);
          if (window.kind === "terminal") {
            const contentStart =
              source.contentStartMs === null ? null : source.contentStartMs / 1000;
            if (contentStart !== null && contentStart < end)
              start = Math.max(start, contentStart - 0.1);
            else end = Math.min(end, start + 0.6); // A genuinely blank focused terminal remains visible briefly.
          }
          // A stopped process can still be inspected. Its window retains the final captured frame.
          start = Math.min(start, Math.max(0, media.duration - 0.2));
          end = Math.min(media.duration, Math.max(start + 0.2, end));
          const hold = Math.max(0, (window.kind === "terminal" ? 3 : 0.6) - (end - start));
          const clip = `clip-${index}.mp4`;
          const scale =
            window.kind === "terminal"
              ? `scale=${width}:${height - barHeight}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih+${barHeight})/2:color=0x202124`
              : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x202124`;
          const filter = `[0:v]setpts=PTS-STARTPTS,${scale},setsar=1,fps=25,tpad=stop_mode=clone:stop_duration=${hold},format=yuv420p[content]`;
          yield* runFFmpeg([
            "-ss",
            String(start),
            "-t",
            String(end - start),
            "-i",
            source.source,
            ...(window.kind === "terminal" ? ["-i", source.heading] : []),
            "-filter_complex_threads",
            "1",
            "-filter_complex",
            filter + (window.kind === "terminal" ? ";[content][1:v]overlay=0:0[out]" : ""),
            "-map",
            window.kind === "terminal" ? "[out]" : "[content]",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-threads",
            "2",
            path.join(temporary, clip),
          ]);
          return {
            file: clip,
            window: window.id,
            kind: window.kind,
            source: window.file,
            startedAtMs: span.startedAtMs,
            endedAtMs: span.endedAtMs,
            operations: span.operations,
            startSeconds: start,
            endSeconds: end,
            holdSeconds: hold,
          };
        }),
      );
      const concatenation = path.join(temporary, "clips.txt");
      yield* fs.writeFileString(
        concatenation,
        clips.map((clip) => `file '${clip.file}'`).join("\n"),
      );
      yield* runFFmpeg([
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatenation,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        path.join(directory, "sequence.mp4"),
      ]);
      yield* runFFmpeg([
        "-ss",
        "0.2",
        "-i",
        path.join(directory, "sequence.mp4"),
        "-frames:v",
        "1",
        path.join(directory, "sequence-poster.png"),
      ]);
      yield* fs.writeFileString(
        path.join(directory, "recording-edit.json"),
        JSON.stringify(
          {
            description:
              "Window focus follows driver calls. Idle tails and blank terminal startup are trimmed. Test durations remain unchanged.",
            clips,
          },
          null,
          2,
        ),
      );
      return {
        video: "sequence.mp4",
        poster: "sequence-poster.png",
        edit: "recording-edit.json",
        windows: timeline.windows,
      };
    }),
  );
