/**
 * The release workflow splits the installed CLI suite and the desktop crash recovery scenarios into
 * parts on separate runners. Vitest passes a part whose name filter matched nothing, so each part
 * records the scenarios it ran, and the archives job requires the parts of each platform to have
 * run every scenario of their suite exactly once.
 *
 * Usage:
 *   `node e2e/part-results.ts record <results.json> <file>` writes the titles of the scenarios a
 *   Vitest JSON report says ran (passed or failed) to `<file>`, and fails when there are none.
 *   `node e2e/part-results.ts compare <directory>` reads the recorded parts as
 *   actions/download-artifact lays them out, one `parts-<suite>-<part>-<platform>-<arch>`
 *   directory each holding `titles.json`, with the matrices from CLI_MATRIX, RECOVERY_MATRIX and
 *   NOTARIZED_RECOVERY_MATRIX and the CLI suite's `--test-name` from CLI_SUITE_PATTERN.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, FileSystem, Path, Schema } from "effect";
import { scenariosForSuite } from "./test-plan.ts";

class PartResultsFailed extends Schema.TaggedError<PartResultsFailed>()("PartResultsFailed", {
  message: Schema.String,
}) {}

const Report = Schema.fromJsonString(
  Schema.Struct({
    testResults: Schema.Array(
      Schema.Struct({
        assertionResults: Schema.Array(
          Schema.Struct({ title: Schema.String, status: Schema.String }),
        ),
      }),
    ),
  }),
);
const Titles = Schema.fromJsonString(Schema.Array(Schema.String));
const Part = Schema.Struct({
  platform: Schema.String,
  arch: Schema.String,
  part: Schema.String,
});
const Matrix = Schema.fromJsonString(Schema.Struct({ include: Schema.Array(Part) }));

const record = (report: string, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const results = yield* Schema.decodeUnknownEffect(Report)(yield* fs.readFileString(report));
    const ran = results.testResults
      .flatMap((suite) => suite.assertionResults)
      .filter((test) => test.status === "passed" || test.status === "failed")
      .map((test) => test.title);
    if (ran.length === 0)
      return yield* new PartResultsFailed({
        message: `${report} ran no scenario: this part's filter matched nothing.`,
      });
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, JSON.stringify(ran));
    yield* Console.log(`This part ran ${ran.length} scenarios.`);
  });

const matrix = (variable: string) =>
  Effect.gen(function* () {
    const text = yield* Config.String(variable);
    return (yield* Schema.decodeUnknownEffect(Matrix)(text).pipe(
      Effect.mapError(() => new PartResultsFailed({ message: `${variable} is not a matrix.` })),
    )).include;
  });

const compare = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pattern = new RegExp(yield* Config.String("CLI_SUITE_PATTERN"));
    const plan = scenariosForSuite("all");
    const suites = {
      cli: {
        parts: yield* matrix("CLI_MATRIX"),
        titles: plan
          .filter(
            (scenario) =>
              scenario.targets.local.status === "scheduled" && pattern.test(scenario.title),
          )
          .map((scenario) => scenario.title),
      },
      recovery: {
        parts: [
          ...(yield* matrix("RECOVERY_MATRIX")),
          ...(yield* matrix("NOTARIZED_RECOVERY_MATRIX")),
        ],
        titles: plan
          .filter((scenario) => scenario.file === "desktop-recovery.spec.ts")
          .map((scenario) => scenario.title),
      },
    };
    const present = (yield* fs.exists(directory)) ? yield* fs.readDirectory(directory) : [];
    const problems: Array<string> = [];
    const expected = new Set<string>();
    for (const [suite, { parts, titles }] of Object.entries(suites)) {
      const platforms = [...new Set(parts.map((part) => `${part.platform}-${part.arch}`))];
      for (const platform of platforms) {
        const ran: Array<string> = [];
        for (const part of parts.filter((part) => `${part.platform}-${part.arch}` === platform)) {
          const name = `parts-${suite}-${part.part.split("/")[0]}-${platform}`;
          expected.add(name);
          const file = path.join(directory, name, "titles.json");
          if (!(yield* fs.exists(file))) {
            problems.push(
              `Missing ${name}: part ${part.part} of ${suite} on ${platform} recorded nothing.`,
            );
            continue;
          }
          ran.push(...(yield* Schema.decodeUnknownEffect(Titles)(yield* fs.readFileString(file))));
        }
        const twice = ran.filter((title, index) => ran.indexOf(title) !== index);
        const missed = titles.filter((title) => !ran.includes(title));
        const extra = ran.filter((title) => !titles.includes(title));
        for (const title of new Set(twice))
          problems.push(`${suite} on ${platform} ran "${title}" in more than one part.`);
        for (const title of missed)
          problems.push(`${suite} on ${platform} did not run "${title}" in any part.`);
        for (const title of new Set(extra))
          problems.push(
            `${suite} on ${platform} ran "${title}", which its suite does not schedule.`,
          );
        yield* Console.log(
          `${suite} on ${platform}: ${ran.length} scenarios in ${parts.filter((part) => `${part.platform}-${part.arch}` === platform).length} parts, of ${titles.length}.`,
        );
      }
    }
    for (const name of present.toSorted())
      if (!expected.has(name)) problems.push(`Unexpected artifact ${name}.`);
    if (problems.length > 0) return yield* new PartResultsFailed({ message: problems.join("\n") });
    yield* Console.log("Every part ran, and the parts of each platform ran their suite once.");
  });

NodeRuntime.runMain(
  Effect.gen(function* () {
    const [command, ...args] = process.argv.slice(2);
    if (command === "record" && args.length === 2) return yield* record(args[0]!, args[1]!);
    if (command === "compare" && args.length === 1) return yield* compare(args[0]!);
    return yield* new PartResultsFailed({
      message: "Usage: part-results.ts record <results.json> <file> | compare <directory>",
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);
