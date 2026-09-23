/** Effect report generation consumes case artifacts after Vitest has closed every test scope. */
import { Clock, Effect, FileSystem, Path, Schema } from "effect";
import { EvidenceEntry, type EvidenceReport } from "./report-model.ts";
import { renderRecording } from "./support/recording.ts";
import { renderFocusedRecording } from "./support/recording-composition.ts";
import { renderRecordingFilmstrip } from "./support/recording-previews.ts";
import { renderStateEvidence } from "./support/state-evidence.ts";
import { renderTerminalRecording, terminalCaptureType } from "./support/terminal-recording.ts";

/** Render the React evidence UI and its portable machine-readable manifest. */
export const writeEvidenceReport = (directory: string, report: EvidenceReport) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const template = yield* fs.readFileString(path.resolve("e2e/viewer/index.html"));
    yield* fs.makeDirectory(path.join(directory, "assets"), { recursive: true });
    for (const file of ["main.js", "main.css"])
      yield* fs.copyFile(
        path.resolve(".local/e2e-viewer", file),
        path.join(directory, "assets", file),
      );
    if (!template.includes("EVIDENCE_DATA"))
      return yield* Effect.die(new Error("Evidence template marker missing"));
    yield* fs.writeFileString(
      path.join(directory, "index.html"),
      template.replace("EVIDENCE_DATA", () => JSON.stringify(report).replaceAll("<", "\\u003c")),
    );
    yield* fs.writeFileString(
      path.join(directory, "evidence.json"),
      JSON.stringify(report, null, 2),
    );
  });
/** Convert raw recordings and build the evidence manifest without a parallel test lifecycle. */
export const collectEvidence = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const base = path.join(directory, "report/evidence");
    if (!(yield* fs.exists(base))) return [];
    return yield* Effect.forEach(yield* fs.readDirectory(base), (name) =>
      Effect.gen(function* () {
        const folder = path.join(base, name);
        if (!(yield* fs.exists(path.join(folder, "result.json")))) return [];
        const entry = yield* fs
          .readFileString(path.join(folder, "result.json"))
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(EvidenceEntry))));
        const processingStarted = yield* Clock.currentTimeMillis;
        const captures = entry.attachments.filter(
          (item) => item.contentType === terminalCaptureType,
        );
        for (const capture of captures)
          yield* renderTerminalRecording(path.join(directory, "report", capture.href));
        const raw = entry.attachments.find((item) => item.contentType === "video/webm");
        if (raw)
          yield* renderRecording(
            path.join(folder, "raw.webm"),
            path.join(folder, "navigation.json"),
            folder,
          );
        if (
          !captures.length &&
          !entry.attachments.some((item) => item.contentType.startsWith("video/"))
        )
          return [entry];
        const run = yield* fs
          .readFileString(path.join(directory, "run.json"))
          .pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.fromJsonString(Schema.Struct({ origin: Schema.String })),
              ),
            ),
          );
        const joined = yield* renderFocusedRecording(folder, entry.origin ?? run.origin);
        if (!joined) return [entry];
        const filmstrip = yield* renderRecordingFilmstrip(folder, joined.video);
        const states = yield* renderStateEvidence(folder);
        const processingEnded = yield* Clock.currentTimeMillis;
        yield* fs.writeFileString(
          path.join(folder, "evidence-processing.json"),
          JSON.stringify(
            {
              durationMs: processingEnded - processingStarted,
              startedAt: new Date(processingStarted).toISOString(),
              finishedAt: new Date(processingEnded).toISOString(),
              includedInTestDuration: false,
            },
            null,
            2,
          ),
        );
        return [
          {
            ...entry,
            attachments: [
              ...(states === null
                ? []
                : [
                    {
                      name: "Observed UI states",
                      contentType: "application/json",
                      href: `evidence/${name}/${states}`,
                    },
                  ]),
              {
                name: "Test recording",
                contentType: "video/mp4",
                href: `evidence/${name}/${joined.video}`,
              },
              {
                name: "Recording poster",
                contentType: "image/png",
                href: `evidence/${name}/${joined.poster}`,
              },
              {
                name: "Recording filmstrip",
                contentType: "image/jpeg",
                href: `evidence/${name}/${filmstrip}`,
              },
              {
                name: "Recording edit",
                contentType: "application/json",
                href: `evidence/${name}/${joined.edit}`,
              },
              {
                name: "Evidence processing",
                contentType: "application/json",
                href: `evidence/${name}/evidence-processing.json`,
              },
              ...joined.windows.map((window) => ({
                name: `Original ${window.title} recording`,
                contentType: "video/mp4",
                href: `evidence/${name}/${window.file}`,
              })),
              ...entry.attachments.filter((item) => !item.contentType.startsWith("video/")),
            ],
          },
        ];
      }),
    ).pipe(Effect.map((entries) => entries.flat()));
  });
