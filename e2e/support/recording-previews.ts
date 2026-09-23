import { Effect, Path } from "effect";
import { probeRecording, runFFmpeg } from "./recording.ts";

/** Export an eight-frame overview of the final edit, outside test execution. */
export const renderRecordingFilmstrip = (directory: string, video: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const source = path.join(directory, video);
    const media = yield* probeRecording(source);
    const filmstrip = "recording-filmstrip.jpg";
    yield* runFFmpeg([
      "-i",
      source,
      "-vf",
      `fps=${8 / media.duration}:start_time=0:round=up,scale=240:135:force_original_aspect_ratio=increase,crop=240:135,tile=8x1`,
      "-frames:v",
      "1",
      "-q:v",
      "3",
      path.join(directory, filmstrip),
    ]);
    return filmstrip;
  });
