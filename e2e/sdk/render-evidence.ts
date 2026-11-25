import { Clock, Console, Effect, FileSystem, Path, Schema } from "effect";
import { collectEvidence, writeEvidenceReport } from "../evidence-reporter.ts";
import { combineEvidenceReports } from "../evidence-results.ts";
import { EvidenceReport, RunMetadata } from "../report-model.ts";
import { BrowserDriver } from "../support/browser.ts";
import { holdRun } from "./run-retention.ts";

export const renderSuiteEvidence = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const root = path.resolve(directory);
    yield* holdRun(root);
    const saved = yield* fs
      .readFileString(path.join(root, "evidence.json"))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(EvidenceReport))));
    const output = path.join(root, "report");
    yield* fs.makeDirectory(path.join(output, "targets"), { recursive: true });
    const reports = yield* Effect.forEach(saved.runs, ({ target }) =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const source = path.join(root, target);
        const metadata = yield* fs
          .readFileString(path.join(source, "run.json"))
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RunMetadata))));
        const entries = yield* collectEvidence(source).pipe(Effect.provide(BrowserDriver.layer));
        const report = { runs: [metadata], entries, plan: saved.plan };
        yield* writeEvidenceReport(path.join(source, "report"), report);
        const prefix = `targets/${target}`;
        yield* fs.copy(path.join(source, "report"), path.join(output, prefix), { overwrite: true });
        const ended = yield* Clock.currentTimeMillis;
        yield* Console.log(
          `${target}: evidence rendering ${((ended - started) / 1000).toFixed(1)}s`,
        );
        return { report, prefix };
      }),
    );
    yield* writeEvidenceReport(output, combineEvidenceReports(reports, saved.plan));
    yield* Console.log(`Test evidence: ${output}/index.html`);
  }).pipe(Effect.scoped);
