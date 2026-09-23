/** Effect post-processing adds readable URL chrome without changing the tested page. */
import { Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { BrowserDriver } from "./browser.ts";
import { driver } from "./platform.ts";

const Navigation = Schema.Array(
  Schema.Struct({ url: Schema.String, elapsedMs: Schema.Number, page: Schema.Int }),
);
const Probe = Schema.Struct({
  streams: Schema.Array(Schema.Struct({ width: Schema.Number, height: Schema.Number })),
  format: Schema.Struct({ duration: Schema.String }),
});
/** Inspect the dimensions and duration of an actual captured video. */
export const probeRecording = (input: string) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const details = yield* processes
      .string(
        ChildProcess.make("ffprobe", [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=width,height:format=duration",
          "-of",
          "json",
          input,
        ]),
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Probe))));
    const stream = details.streams[0],
      duration = Number(details.format.duration);
    if (!stream || !Number.isFinite(duration) || duration <= 0)
      return yield* Effect.die(new Error("Recording has no video stream"));
    return { ...stream, duration };
  });
/** Run an owned ffmpeg export and reject unsuccessful output. */
export const runFFmpeg = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const code = yield* processes.exitCode(
      ChildProcess.make("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
        stderr: "inherit",
        forceKillAfter: "5 seconds",
      }),
    );
    if (code !== 0) return yield* Effect.die(new Error("Recording export failed"));
  });
/** Own a rendering page and ffmpeg processes within a scope. No Promise orchestration. */
export const renderRecording = (input: string, navigationPath: string, directory: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path,
        browser = yield* BrowserDriver;
      const navigation = yield* fs
        .readFileString(navigationPath)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Navigation))));
      const stream = yield* probeRecording(input),
        duration = stream.duration;
      const events = [
        { url: "about:blank", elapsedMs: 0 },
        ...navigation.filter((entry) => entry.page === 0),
      ].filter((entry) => entry.elapsedMs < duration * 1000);
      const page = yield* Effect.acquireRelease(
        driver("render address bar", () =>
          browser.newPage({ viewport: { width: stream.width, height: 72 }, deviceScaleFactor: 1 }),
        ),
        (page) => driver("close recording renderer", () => page.close()).pipe(Effect.orDie),
      );
      yield* driver("address bar template", () =>
        page.setContent(
          `<style>body{margin:0;background:#202124;color:#f1f3f4;font-family:Arial,sans-serif;display:flex;align-items:center;gap:24px;height:72px;padding:0 24px;box-sizing:border-box}.dots{display:flex;gap:9px}.dots i{width:13px;height:13px;border-radius:50%;background:#888}.address{height:48px;background:#303134;border:1px solid #555;border-radius:8px;display:flex;align-items:center;padding:0 20px;flex:1;min-width:0;font-size:28px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}</style><div class="dots"><i></i><i></i><i></i></div><div class="address"></div>`,
        ),
      );
      const images = yield* Effect.forEach(events, (event, index) =>
        Effect.gen(function* () {
          yield* driver("render recorded URL", () =>
            page.locator(".address").evaluate((element, text) => {
              element.textContent = text;
            }, event.url),
          );
          const image = path.join(directory, `address-${index}.png`);
          yield* driver("capture address bar", () => page.screenshot({ path: image }));
          return image;
        }),
      );
      const filters = [
        "[0:v]pad=iw:ih+72:0:72:color=0x202124[v0]",
        ...events.map(
          (event, index) =>
            `[v${index}][${index + 1}:v]overlay=0:0:enable='gte(t,${event.elapsedMs / 1000})*lt(t,${(events[index + 1]?.elapsedMs ?? duration * 1000) / 1000})'[v${index + 1}]`,
        ),
      ];
      const video = path.join(directory, "recording.mp4"),
        poster = path.join(directory, "poster.png");
      yield* runFFmpeg([
        "-i",
        input,
        ...images.flatMap((image) => ["-loop", "1", "-i", image]),
        "-filter_complex_threads",
        "1",
        "-filter_complex",
        filters.join(";"),
        "-map",
        `[v${events.length}]`,
        "-t",
        String(duration),
        "-r",
        "25",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-threads",
        "2",
        video,
      ]);
      yield* runFFmpeg([
        "-ss",
        String(Math.max(0, duration - 0.2)),
        "-i",
        video,
        "-frames:v",
        "1",
        poster,
      ]);
      return { video, poster };
    }),
  );
