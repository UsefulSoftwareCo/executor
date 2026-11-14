import { Config, Console, Effect, FileSystem, Option, Path, Schema } from "effect";
import { createHash } from "node:crypto";
import { EvidenceEntry, RunMetadata, type EvidenceReport } from "./report-model.ts";
import {
  crashMarginMs,
  RuntimeCrashes,
  runtimeCrashesFile,
  runtimeCrashNote,
  runtimeCrashNotesFor,
} from "./support/runtime-crashes.ts";

const TestResults = Schema.Struct({
  testResults: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      assertionResults: Schema.Array(
        Schema.Struct({
          title: Schema.String,
          status: Schema.String,
          duration: Schema.optionalKey(Schema.NullOr(Schema.Number)),
          failureMessages: Schema.Array(Schema.String),
        }),
      ),
    }),
  ),
});

/** Read saved case results without launching a browser, encoding media or generating HTML. */
export const readEvidence = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const base = path.join(directory, "report/evidence");
    const names = (yield* fs.exists(base)) ? yield* fs.readDirectory(base) : [];
    const entries = yield* Effect.forEach(names, (name) =>
      Effect.gen(function* () {
        const file = path.join(base, name, "result.json");
        if (!(yield* fs.exists(file))) return [];
        const entry = yield* fs.readFileString(file).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.fromJsonString(
                EvidenceEntry.check(
                  Schema.makeFilter((entry) => entry.id === name, {
                    message: "Evidence identity must match its case directory",
                  }),
                ),
              ),
            ),
          ),
        );
        return [entry];
      }),
    ).pipe(Effect.map((entries) => entries.flat()));
    // Scope exit cannot know about later cleanup failures or native hook timeouts.
    // Vitest is authoritative when present; interactive SDK sessions have no report.
    const diagnostics = path.join(directory, "report/diagnostics/results.json");
    if (!(yield* fs.exists(diagnostics))) return yield* withRuntimeCrashNotes(directory, entries);
    const results = yield* fs
      .readFileString(diagnostics)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(TestResults))));
    const run = yield* fs
      .readFileString(path.join(directory, "run.json"))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RunMetadata))));
    const reconciled = new Map(entries.map((entry) => [`${entry.file}:${entry.title}`, entry]));
    for (const file of results.testResults) {
      for (const test of file.assertionResults) {
        const name = path.basename(file.name);
        const key = `${name}:${test.title}`;
        const recorded = reconciled.get(key);
        if (recorded === undefined && test.status !== "failed") continue;
        reconciled.set(key, {
          ...(recorded ?? {
            id: createHash("sha256")
              .update(`${run.target}:${file.name}:${test.title}`)
              .digest("hex")
              .slice(0, 16),
            title: test.title,
            file: name,
            target: run.target,
            annotations: [],
            attachments: [],
          }),
          status: test.status,
          duration: test.duration ?? recorded?.duration ?? 0,
          errors: [...new Set([...(recorded?.errors ?? []), ...test.failureMessages])],
        });
      }
    }
    return yield* withRuntimeCrashNotes(directory, [...reconciled.values()]);
  });

/**
 * Add, to each failed case that ran while one of local Cloud's runtimes had crashed, a line naming
 * the crash (`support/runtime-crashes.ts`), so the failure does not read as the case's own.
 */
const withRuntimeCrashNotes = (
  directory: string,
  entries: ReadonlyArray<typeof EvidenceEntry.Type>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const file = path.join(directory, runtimeCrashesFile);
    if (!(yield* fs.exists(file))) return entries;
    const crashes = yield* fs
      .readFileString(file)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeCrashes))));
    return entries.map((entry) => {
      const added = runtimeCrashNotesFor(entry, crashes);
      return added.length === 0
        ? entry
        : {
            ...entry,
            errors: [...added, ...entry.errors.filter((error) => !added.includes(error))],
          };
    });
  });

/** Combine target reports with links relative to their shared manifest or rendered report. */
export const combineEvidenceReports = (
  reports: ReadonlyArray<{ readonly report: EvidenceReport; readonly prefix: string }>,
  plan: EvidenceReport["plan"],
): EvidenceReport => ({
  plan,
  runs: reports.flatMap(({ report, prefix }) =>
    report.runs.map((run) => ({ ...run, diagnostics: `${prefix}/${run.diagnostics}` })),
  ),
  entries: reports.flatMap(({ report, prefix }) =>
    report.entries.map((entry) => ({
      ...entry,
      attachments: entry.attachments.map((item) => ({ ...item, href: `${prefix}/${item.href}` })),
    })),
  ),
});

/**
 * Print each of local Cloud's runtime crashes in `directory` and the failed cases caught in it, in
 * the job log and, in CI, the job's summary, where the count sits beside the run's other totals. A
 * run without a crash prints nothing.
 */
export const reportRuntimeCrashes = (
  directory: string,
  entries: ReadonlyArray<typeof EvidenceEntry.Type>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const file = path.join(directory, runtimeCrashesFile);
    if (!(yield* fs.exists(file))) return;
    const crashes = yield* fs
      .readFileString(file)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeCrashes))));
    if (crashes.length === 0) return;
    const lines = crashes.map((crash) => {
      const caught = entries
        .filter((entry) => runtimeCrashNotesFor(entry, [crash]).length > 0)
        .map((entry) => `${entry.file} > ${entry.title}`);
      return `${runtimeCrashNote(crash).replace(" while this case ran", "")} Failed cases in or within ${crashMarginMs / 1000} s of it: ${caught.length === 0 ? "none" : caught.join("; ")}.`;
    });
    for (const line of lines) yield* Console.log(line);
    const summary = yield* Config.String("GITHUB_STEP_SUMMARY").pipe(Config.option);
    if (Option.isSome(summary))
      yield* fs.writeFileString(
        summary.value,
        `Local Cloud runtime crashes: ${crashes.length}\n\n${lines.map((line) => `- ${line}`).join("\n")}\n`,
        { flag: "a" },
      );
  });
