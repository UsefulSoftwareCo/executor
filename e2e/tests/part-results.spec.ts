/**
 * The release workflow runs the installed CLI suite and the desktop crash recovery scenarios in
 * parts. Vitest passes a part whose filter matched nothing, so each part records what it ran
 * (`e2e/part-results.ts record`), and the archives job requires each platform's parts to have run
 * their suite exactly once (`compare`). These cases run the script as the workflow does.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { scenariosForSuite } from "../test-plan.ts";

const script = "e2e/part-results.ts";
const pattern = "^(?!.*Claude Code connects)";
const plan = scenariosForSuite("all");
const cliTitles = plan
  .filter(
    (scenario) =>
      scenario.targets.local.status === "scheduled" && new RegExp(pattern).test(scenario.title),
  )
  .map((scenario) => scenario.title);
const recoveryTitles = plan
  .filter((scenario) => scenario.file === "desktop-recovery.spec.ts")
  .map((scenario) => scenario.title);
const parts = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    platform: "linux",
    arch: "x64",
    part: `${index + 1}/${count}`,
  }));
const matrices = {
  CLI_MATRIX: JSON.stringify({ include: parts(2) }),
  RECOVERY_MATRIX: JSON.stringify({ include: parts(3) }),
  NOTARIZED_RECOVERY_MATRIX: JSON.stringify({ include: [] }),
  CLI_SUITE_PATTERN: pattern,
};

const node = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(ChildProcess.make("node", args, { env, extendEnv: true }));
    const [log, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    return { exitCode, log };
  }).pipe(Effect.scoped);

/** Titles split into `count` parts, in order. */
const split = (titles: ReadonlyArray<string>, count: number) =>
  Array.from({ length: count }, (_, index) =>
    titles.filter((_, position) => position % count === index),
  );

/** Lay out recorded parts as actions/download-artifact does and run the comparison. */
const compare = (recorded: Record<string, ReadonlyArray<string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-parts-" });
    for (const [artifact, titles] of Object.entries(recorded)) {
      yield* fs.makeDirectory(path.join(directory, artifact));
      yield* fs.writeFileString(
        path.join(directory, artifact, "titles.json"),
        JSON.stringify(titles),
      );
    }
    return yield* node([script, "compare", directory], matrices);
  }).pipe(Effect.scoped);

const complete = () => {
  const recorded: Record<string, ReadonlyArray<string>> = {};
  split(cliTitles, 2).forEach((titles, index) => {
    recorded[`parts-cli-${index + 1}-linux-x64`] = titles;
  });
  split(recoveryTitles, 3).forEach((titles, index) => {
    recorded[`parts-recovery-${index + 1}-linux-x64`] = titles;
  });
  return recorded;
};

layer(NodeServices.layer, { excludeTestServices: true })("release part results", (it) => {
  it.effect("a part whose report ran no scenario fails, and one that ran some records them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-part-report-" });
      const report = (statuses: ReadonlyArray<[string, string]>) =>
        JSON.stringify({
          testResults: [
            { assertionResults: statuses.map(([title, status]) => ({ title, status })) },
          ],
        });
      const empty = path.join(directory, "empty.json");
      yield* fs.writeFileString(empty, report([["filtered out", "skipped"]]));
      const none = yield* node([script, "record", empty, path.join(directory, "none.json")]);
      expect(none.exitCode).toBe(1);
      expect(none.log).toContain("ran no scenario: this part's filter matched nothing.");

      const ran = path.join(directory, "ran.json");
      yield* fs.writeFileString(
        ran,
        report([
          ["passes", "passed"],
          ["fails", "failed"],
          ["filtered out", "skipped"],
        ]),
      );
      const out = path.join(directory, "titles.json");
      const recorded = yield* node([script, "record", ran, out]);
      expect(recorded.exitCode, recorded.log).toBe(0);
      expect(JSON.parse(yield* fs.readFileString(out))).toEqual(["passes", "fails"]);
    }).pipe(Effect.scoped),
  );

  it.effect("parts that ran their suite once pass; a dropped, repeated or missing part fails", () =>
    Effect.gen(function* () {
      const whole = yield* compare(complete());
      expect(whole.exitCode, whole.log).toBe(0);
      expect(whole.log).toContain(`cli on linux-x64: ${cliTitles.length} scenarios in 2 parts`);
      expect(whole.log).toContain(
        `recovery on linux-x64: ${recoveryTitles.length} scenarios in 3 parts`,
      );

      const [first, ...rest] = complete()["parts-recovery-1-linux-x64"]!;
      const dropped = yield* compare({ ...complete(), "parts-recovery-1-linux-x64": rest });
      expect(dropped.exitCode).toBe(1);
      expect(dropped.log).toContain(`recovery on linux-x64 did not run "${first}" in any part.`);

      const repeated = complete();
      repeated["parts-cli-2-linux-x64"] = [...repeated["parts-cli-2-linux-x64"]!, cliTitles[0]!];
      const twice = yield* compare(repeated);
      expect(twice.exitCode).toBe(1);
      expect(twice.log).toContain(`cli on linux-x64 ran "${cliTitles[0]}" in more than one part.`);

      const { "parts-cli-1-linux-x64": _, ...withoutPart } = complete();
      const missing = yield* compare(withoutPart);
      expect(missing.exitCode).toBe(1);
      expect(missing.log).toContain(
        "Missing parts-cli-1-linux-x64: part 1/2 of cli on linux-x64 recorded nothing.",
      );

      const extra = yield* compare({ ...complete(), "parts-cli-3-linux-x64": [] });
      expect(extra.exitCode).toBe(1);
      expect(extra.log).toContain("Unexpected artifact parts-cli-3-linux-x64.");
    }).pipe(Effect.scoped),
  );
});
