import { Effect, FileSystem, Path, Schema } from "effect";
import { UICaptures, UIObservations, UIStateReport } from "../state-model.ts";

/** Assemble directly captured states, retaining every uncaptured candidate with its reason. */
export const renderStateEvidence = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const input = path.join(directory, "ui-observations.json");
    if (!(yield* fs.exists(input))) return null;
    const signals = yield* fs
      .readFileString(input)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(UIObservations))));
    const capture = yield* fs
      .readFileString(path.join(directory, "ui-captures.json"))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(UICaptures))));
    const views = signals
      .filter((signal) => signal.view !== undefined)
      .toSorted((a, b) => a.at - b.at);
    const navigations = yield* fs
      .readFileString(path.join(directory, "navigation.json"))
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Array(Schema.Struct({ at: Schema.String }))),
          ),
        ),
      );
    const states = views.map((signal, index) => {
      if (signal.view === undefined) throw new Error("Missing observed view");
      const frame = capture.frames.find((frame) => frame.at === signal.at);
      if (!frame) throw new Error("Missing capture outcome");
      const next = Math.min(
        views[index + 1]?.at ?? frame.completedAt,
        ...navigations.map((event) => Date.parse(event.at)).filter((at) => at > signal.at),
      );
      const previous = views[index - 1]?.at ?? 0;
      const previousCapture = capture.frames.find((item) => item.at === previous)?.completedAt ?? 0;
      const before = signals.filter((event) => event.at > previous && event.at <= signal.at);
      const shifts = signals
        .filter(
          (event) =>
            event.at > previousCapture &&
            event.at <= frame.completedAt &&
            event.shift !== undefined,
        )
        .flatMap((event) => (event.shift ? [event.shift] : []));
      return {
        at: signal.at,
        durationMs: Math.max(0, next - signal.at),
        screenshot: frame.screenshot,
        captureStatus: frame.status,
        view: signal.view,
        triggers: signal.label,
        atoms: [
          ...new Set(before.filter((event) => event.kind === "atom").map((event) => event.label)),
        ],
        commits: before.filter((event) => event.kind === "commit").length,
        shifts,
      };
    });
    const report = yield* Schema.decodeUnknownEffect(UIStateReport)({
      version: 2,
      signals,
      capture,
      states,
    });
    yield* fs.writeFileString(
      path.join(directory, "ui-states.json"),
      JSON.stringify(report, null, 2),
    );
    return "ui-states.json";
  });
