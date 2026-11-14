/**
 * The evidence of a release job's failed scenarios, laid out as CI's e2e jobs lay out theirs, so
 * `ci-evidence.ts --scenario` fetches one scenario's folder from the run without the job's whole
 * diagnostics archive: `<run>/<target>/report/evidence/<id>/` with a `result.json` (title, file,
 * target, status, errors) beside the scenario's files. Only failed scenarios are copied, and
 * nothing is written when none failed, so the upload step that follows has nothing to send.
 *
 * Usage:
 *   `node e2e/release-evidence.ts e2e <dest> <root>` copies, from runs of `e2e/run.ts` under
 *   `<root>` (`.local/e2e`), each failed scenario's evidence folder with its server's and CLI's
 *   logs and a background server's diagnostics inside it, and the run's `evidence.json`,
 *   `run.json` and Vitest report.
 *   `node e2e/release-evidence.ts vitest <dest> <target> <failures> <results.json>...` writes a
 *   folder for each failed test of the Vitest JSON reports, holding its `result.json` and the
 *   desktop failure folders under `<failures>` that name the test (`e2e/support/desktop.ts`).
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createHash } from "node:crypto";
import { Console, Effect, FileSystem, Path, Schema } from "effect";

class EvidenceFailed extends Schema.TaggedError<EvidenceFailed>()("EvidenceFailed", {
  message: Schema.String,
}) {}

const Result = Schema.fromJsonString(Schema.Struct({ status: Schema.optional(Schema.String) }));
const Scenario = Schema.fromJsonString(
  Schema.Struct({
    directory: Schema.optional(Schema.String),
    title: Schema.optional(Schema.String),
  }),
);
const Report = Schema.fromJsonString(
  Schema.Struct({
    testResults: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        assertionResults: Schema.Array(
          Schema.Struct({
            title: Schema.String,
            status: Schema.String,
            duration: Schema.optional(Schema.NullOr(Schema.Number)),
            failureMessages: Schema.optional(Schema.Array(Schema.String)),
          }),
        ),
      }),
    ),
  }),
);

const failed = (status: string | undefined) =>
  status !== undefined && !["passed", "skipped", "pending", "todo"].includes(status);

/** Copy `from` to `to` when it exists, as a file or a whole directory. */
const copyIfPresent = (from: string, to: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(from))) return false;
    yield* fs.makeDirectory(path.dirname(to), { recursive: true });
    yield* fs.copy(from, to);
    return true;
  });

/** Failed scenarios of `e2e/run.ts` runs: `<root>/<run>/<target>/report/evidence/<id>/`. */
const fromRuns = (dest: string, root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let copied = 0;
    if (!(yield* fs.exists(root))) return copied;
    for (const run of yield* fs.readDirectory(root)) {
      const runDir = path.join(root, run);
      if ((yield* fs.stat(runDir)).type !== "Directory") continue;
      for (const target of yield* fs.readDirectory(runDir)) {
        if ((yield* fs.stat(path.join(runDir, target))).type !== "Directory") continue;
        const evidence = path.join(runDir, target, "report", "evidence");
        if (!(yield* fs.exists(evidence))) continue;
        let any = false;
        for (const id of yield* fs.readDirectory(evidence)) {
          const folder = path.join(evidence, id);
          const result = path.join(folder, "result.json");
          if (!(yield* fs.exists(result))) continue;
          const { status } = yield* Schema.decodeUnknownEffect(Result)(
            yield* fs.readFileString(result),
          ).pipe(Effect.orElseSucceed(() => ({ status: "unknown" })));
          if (!failed(status)) continue;
          const out = path.join(dest, run, target, "report", "evidence", id);
          yield* copyIfPresent(folder, out);
          // The scenario's own server, CLI and background server, which ran outside the folder.
          const scenario = yield* fs
            .readFileString(path.join(folder, "scenario.json"))
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Scenario)), Effect.option);
          const directory =
            scenario._tag === "Some" && scenario.value.directory !== undefined
              ? path.join(
                  runDir,
                  target,
                  "scenarios",
                  path.basename(scenario.value.directory.replaceAll("\\", "/")),
                )
              : undefined;
          if (directory !== undefined) {
            yield* copyIfPresent(path.join(directory, "server.log"), path.join(out, "server.log"));
            yield* copyIfPresent(path.join(directory, "cli.log"), path.join(out, "cli.log"));
            yield* copyIfPresent(
              path.join(directory, "background-service", "data", "diagnostics"),
              path.join(out, "background-service-diagnostics"),
            );
          }
          copied += 1;
          any = true;
        }
        if (!any) continue;
        yield* copyIfPresent(
          path.join(runDir, "evidence.json"),
          path.join(dest, run, "evidence.json"),
        );
        yield* copyIfPresent(
          path.join(runDir, target, "run.json"),
          path.join(dest, run, target, "run.json"),
        );
        yield* copyIfPresent(
          path.join(runDir, target, "report", "diagnostics", "results.json"),
          path.join(dest, run, target, "report", "diagnostics", "results.json"),
        );
      }
    }
    return copied;
  });

/** Failed tests of plain Vitest runs, with the desktop failure folders that name them. */
const fromReports = (
  dest: string,
  target: string,
  failures: string,
  reports: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const desktop: Array<{ folder: string; title: string }> = [];
    if (yield* fs.exists(failures))
      for (const name of yield* fs.readDirectory(failures)) {
        const scenario = yield* fs
          .readFileString(path.join(failures, name, "scenario.json"))
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Scenario)), Effect.option);
        if (scenario._tag === "Some" && scenario.value.title !== undefined)
          desktop.push({ folder: path.join(failures, name), title: scenario.value.title });
      }
    let copied = 0;
    for (const report of reports) {
      if (!(yield* fs.exists(report))) continue;
      const results = yield* Schema.decodeUnknownEffect(Report)(yield* fs.readFileString(report));
      for (const suite of results.testResults)
        for (const test of suite.assertionResults) {
          if (!failed(test.status)) continue;
          const file = path.relative(process.cwd(), suite.name).split(path.sep).join("/");
          const id = createHash("sha256")
            .update(`${file}\n${test.title}`)
            .digest("hex")
            .slice(0, 16);
          const out = path.join(dest, "release", target, "report", "evidence", id);
          yield* fs.makeDirectory(out, { recursive: true });
          yield* fs.writeFileString(
            path.join(out, "result.json"),
            JSON.stringify(
              {
                id,
                title: test.title,
                file,
                target,
                status: test.status,
                duration: test.duration ?? undefined,
                errors: test.failureMessages ?? [],
              },
              null,
              2,
            ),
          );
          for (const [index, match] of desktop
            .filter((entry) => entry.title === test.title)
            .entries())
            yield* fs.copy(match.folder, path.join(out, `desktop-${index + 1}`));
          copied += 1;
        }
    }
    return copied;
  });

NodeRuntime.runMain(
  Effect.gen(function* () {
    const [mode, dest, ...rest] = process.argv.slice(2);
    const copied =
      mode === "e2e" && dest !== undefined && rest.length === 1
        ? yield* fromRuns(dest, rest[0]!)
        : mode === "vitest" && dest !== undefined && rest.length >= 3
          ? yield* fromReports(dest, rest[0]!, rest[1]!, rest.slice(2))
          : yield* new EvidenceFailed({
              message:
                "Usage: release-evidence.ts e2e <dest> <root> | vitest <dest> <target> <failures> <results.json>...",
            });
    yield* Console.log(
      `Evidence for ${copied} failed scenario${copied === 1 ? "" : "s"} in ${dest}.`,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
