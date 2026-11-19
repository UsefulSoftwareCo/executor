/**
 * The runner starts Vitest without `CI` (e2e/sdk/suite.ts), and there Vitest writes a missing or
 * empty snapshot and passes. No Vitest run in e2e/ may write or update a snapshot unless asked
 * (e2e/snapshot-updates.ts). These cases import every config to read its `update`, run snapshot
 * cases in a scratch project under the runner's own config and the environment the runner gives
 * Vitest, start Vitest there with its own update argument in CI, and start `e2e/run.ts` to show
 * that asking is refused in CI and asked only for the scenarios `--test-name` names. That the runner's
 * `--update-snapshots` reaches the scenario worker is checked by a scenario in
 * failure-text.spec.ts.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { ciRefusal, unnamedRefusal, updateSnapshotsVariable } from "../snapshot-updates.ts";

const checkout = process.cwd();

/** The variables the runner passes the Vitest it starts (`runSuite`): never `CI`. */
const runnerEnvironment = (directory: string) => ({
  PATH: process.env.PATH ?? "",
  ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
  // e2e/vitest.config.ts reads these, as `runSuite` sets them.
  EXECUTOR_E2E_RUN: directory,
  E2E_TARGET: "self-host",
  E2E_SUITE: "all",
  E2E_CLOUD_MODE: "managed",
  E2E_WORKERS: "1",
  E2E_TEST_NAME: "",
  // Plain text to read diffs from, however this process was started.
  NO_COLOR: "1",
});

/** Runs a process to its end and returns its whole output and its exit code. */
const run = (
  command: string,
  args: ReadonlyArray<string>,
  options: { cwd: string; env: Record<string, string>; extendEnv: boolean },
) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(ChildProcess.make(command, args, options));
    const [output, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    return { output, exitCode: Number(exitCode) };
  }).pipe(Effect.scoped);

/** Every Vitest config in e2e/: `e2e/*.config.ts` and the nested `e2e/<folder>/vitest.config.ts`. */
const configFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: string[] = [];
  for (const name of (yield* fs.readDirectory("e2e")).toSorted()) {
    const file = path.join("e2e", name);
    if (name.endsWith(".config.ts")) files.push(file);
    else if (
      name !== "tests" &&
      (yield* fs.stat(file)).type === "Directory" &&
      (yield* fs.exists(path.join(file, "vitest.config.ts")))
    )
      files.push(path.join(file, "vitest.config.ts"));
  }
  return files;
});

/**
 * Each config's `test.update`, imported in a process with `env` and the arguments `args` after its
 * script, as Vitest is started, or the error importing it threw.
 */
const updates = (
  files: ReadonlyArray<string>,
  env: Record<string, string>,
  args: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-snapshot-configs-" });
    const program = `import { pathToFileURL } from "node:url";
const read = {};
for (const file of ${JSON.stringify(files)}) {
  try {
    read[file] = (await import(pathToFileURL(file).href)).default.test.update ?? "unset";
  } catch (error) {
    read[file] = "threw: " + error.message;
  }
}
console.log("UPDATES " + JSON.stringify(read));`;
    const script = `${directory}/read-updates.mjs`;
    yield* fs.writeFileString(script, program);
    const { output, exitCode } = yield* run("node", [script, ...args], {
      cwd: checkout,
      env: { ...runnerEnvironment(directory), ...env },
      extendEnv: false,
    });
    expect(exitCode, output).toBe(0);
    const line = output.split("\n").find((text) => text.startsWith("UPDATES "));
    if (line === undefined)
      return yield* Effect.die(new Error(`No updates were printed: ${output}`));
    return yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
    )(line.slice("UPDATES ".length));
  }).pipe(Effect.scoped);

const text = "The app threw SpecInvalid (server_url)\nreason: Server URLs must use HTTPS";
/** An empty inline snapshot, a file snapshot with no file, and an inline snapshot of other text. */
const cases = `import { expect, it } from "vitest";
const text = ${JSON.stringify(text)};
it("an empty inline snapshot", () => {
  expect(text).toMatchInlineSnapshot();
});
it("a missing snapshot file", async () => {
  await expect(text).toMatchFileSnapshot("./recorded/missing.txt");
});
it("a changed snapshot", () => {
  expect(text).toMatchInlineSnapshot(\`
    "The app threw SpecInvalid (server_url)
    reason: Server URLs may use HTTP"
  \`);
});
`;

const Results = Schema.fromJsonString(
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

/** How `runCases` starts Vitest on the scratch project: a command and its arguments. */
type Launch = readonly [command: string, args: ReadonlyArray<string>];

/** `node node_modules/vitest/vitest.mjs run`, as the runner starts it, with `args` after. */
const vitestMjs = (args: ReadonlyArray<string> = []): Launch => [
  "node",
  [`${checkout}/node_modules/vitest/vitest.mjs`, "run", "--config", "vitest.config.ts", ...args],
];

/**
 * A scratch project whose config takes `update` from the runner's own config (e2e/vitest.config.ts)
 * and whose setup adds the runner's note to an unrecorded snapshot's failure. `launch` starts Vitest
 * on its cases with the runner's environment and `env`, and returns what it printed, each case's
 * status, and the cases file and recorded file afterwards. Its package.json runs the same Vitest as
 * `bun run cases`, as the repository's own scripts do.
 */
const runCases = (env: Record<string, string>, launch: Launch = vitestMjs()) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const project = yield* fs.makeTempDirectoryScoped({ prefix: "executor-snapshot-cases-" });
    yield* fs.symlink(path.join(checkout, "node_modules"), path.join(project, "node_modules"));
    yield* fs.writeFileString(
      path.join(project, "vitest.config.ts"),
      `import { defineConfig } from "vitest/config";
import runner from ${JSON.stringify(path.join(checkout, "e2e/vitest.config.ts"))};
export default defineConfig({
  test: {
    update: runner.test?.update,
    include: ["cases.spec.ts"],
    setupFiles: ["./setup.ts"],
    reporters: ["verbose", ["json", { outputFile: "results.json" }]],
  },
});
`,
    );
    yield* fs.writeFileString(
      path.join(project, "setup.ts"),
      `import { installSnapshotFailures } from ${JSON.stringify(path.join(checkout, "e2e/support/snapshot-failures.ts"))};
installSnapshotFailures();
`,
    );
    yield* fs.writeFileString(
      path.join(project, "package.json"),
      JSON.stringify({ private: true, scripts: { cases: "vitest run --config vitest.config.ts" } }),
    );
    const casesFile = path.join(project, "cases.spec.ts");
    yield* fs.writeFileString(casesFile, cases);
    const runDirectory = path.join(project, "run");
    yield* fs.makeDirectory(runDirectory);
    const { output, exitCode } = yield* run(launch[0], launch[1], {
      cwd: project,
      env: { ...runnerEnvironment(runDirectory), ...env },
      extendEnv: false,
    });
    const resultsFile = path.join(project, "results.json");
    const statuses = (yield* fs.exists(resultsFile))
      ? Object.fromEntries(
          (yield* fs
            .readFileString(resultsFile)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Results)))).testResults
            .flatMap((file) => file.assertionResults)
            .map((result) => [result.title, result.status]),
        )
      : {};
    const recordedFile = path.join(project, "recorded/missing.txt");
    return {
      output,
      exitCode,
      statuses,
      written: yield* fs.readFileString(casesFile),
      recorded: (yield* fs.exists(recordedFile))
        ? yield* fs.readFileString(recordedFile)
        : undefined,
      // Runs the same, now recorded, cases again without asking.
      again: Effect.gen(function* () {
        const again = yield* run(...vitestMjs(), {
          cwd: project,
          env: runnerEnvironment(runDirectory),
          extendEnv: false,
        });
        return { ...again, written: yield* fs.readFileString(casesFile) };
      }),
    };
  });

/** Starts `e2e/run.ts` in an empty directory, and returns its output and whether it made `.local`. */
const startRunner = (args: ReadonlyArray<string>, env: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-snapshot-runner-" });
    const result = yield* run(
      "node",
      [path.join(checkout, "e2e/run.ts"), "--target", "self-host", ...args],
      // The host slot would wait for other runs on this machine.
      {
        cwd: directory,
        env: { EXECUTOR_E2E_HOST_SLOTS: "off", NO_COLOR: "1", ...env },
        extendEnv: true,
      },
    );
    return { ...result, startedRun: yield* fs.exists(path.join(directory, ".local")) };
  }).pipe(Effect.scoped);

layer(NodeServices.layer, { excludeTestServices: true })("e2e snapshot updates", (it) => {
  it.effect("every Vitest config in e2e/ records snapshots only when asked, and never in CI", () =>
    Effect.gen(function* () {
      const files = yield* configFiles;
      expect(files).toContain("e2e/vitest.config.ts");
      expect(files).toContain("e2e/failure-text/vitest.config.ts");
      expect(files.length).toBeGreaterThan(60);
      const every = (value: string) => Object.fromEntries(files.map((file) => [file, value]));
      // Without asking, a config sets `update: snapshotUpdate()` (e2e/snapshot-updates.ts).
      expect(yield* updates(files, {})).toEqual(every("none"));
      expect(yield* updates(files, { [updateSnapshotsVariable]: "1" })).toEqual(every("all"));
      expect(yield* updates(files, { [updateSnapshotsVariable]: "1", CI: "true" })).toEqual(
        every(`threw: ${ciRefusal}`),
      );
      expect(
        yield* updates(files, { [updateSnapshotsVariable]: "1", GITHUB_ACTIONS: "true" }),
      ).toEqual(every(`threw: ${ciRefusal}`));
      // Vitest's own -u overrides `update`: refused in CI, by every config, before a case runs.
      expect(yield* updates(files, { CI: "true" }, ["run", "-u"])).toEqual(
        every(`threw: Vitest's update argument (true) refused: ${ciRefusal}`),
      );
      expect(yield* updates(files, { GITHUB_ACTIONS: "true" }, ["run", "--update=all"])).toEqual(
        every(`threw: Vitest's update argument ("all") refused: ${ciRefusal}`),
      );
      // Outside CI, asking Vitest itself is a person's choice; in CI, writing none is allowed.
      expect(yield* updates(files, {}, ["run", "-u"])).toEqual(every("none"));
      expect(yield* updates(files, { CI: "true" }, ["run", "--update=none"])).toEqual(
        every("none"),
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "under the runner's config a missing, empty or changed snapshot fails and nothing is written",
    () =>
      Effect.gen(function* () {
        const result = yield* runCases({});
        expect(result.exitCode, result.output).not.toBe(0);
        expect(result.statuses).toEqual({
          "an empty inline snapshot": "failed",
          "a missing snapshot file": "failed",
          "a changed snapshot": "failed",
        });
        expect(result.written).toBe(cases);
        expect(result.recorded).toBeUndefined();
        expect(result.output).not.toMatch(/Snapshots\s+\d+ (?:written|updated)/u);
        // An unrecorded snapshot's failure shows the value the scenario produced.
        const unrecorded = `no snapshot is recorded, and this run records none.\nThe scenario produced:\n`;
        expect(result.output).toContain(
          `${unrecorded}${JSON.stringify(text).replace("\\n", "\n")}\n`,
        );
        expect(result.output).toContain(`${unrecorded}${text}\n`);
        expect(result.output).toContain("--update-snapshots");
        // A changed one shows its diff.
        expect(result.output).toContain('- reason: Server URLs may use HTTP"');
        expect(result.output).toContain('+ reason: Server URLs must use HTTPS"');
      }).pipe(Effect.scoped),
    60_000,
  );

  it.effect(
    "asked outside CI, the runner's config records each snapshot, which then passes",
    () =>
      Effect.gen(function* () {
        const result = yield* runCases({ [updateSnapshotsVariable]: "1" });
        expect(result.exitCode, result.output).toBe(0);
        expect(Object.values(result.statuses)).toEqual(["passed", "passed", "passed"]);
        expect(result.recorded).toBe(text);
        expect(result.written).not.toBe(cases);
        expect(result.written).not.toContain("may use HTTP");
        expect(result.written).not.toContain("toMatchInlineSnapshot()");
        // What it recorded is what a run that does not ask then checks, writing nothing.
        const again = yield* result.again;
        expect(again.exitCode, again.output).toBe(0);
        expect(again.written).toBe(result.written);
      }).pipe(Effect.scoped),
    60_000,
  );

  it.effect(
    "asked in CI, Vitest refuses to start and nothing is written",
    () =>
      Effect.gen(function* () {
        const result = yield* runCases({ [updateSnapshotsVariable]: "1", CI: "true" });
        expect(result.exitCode).not.toBe(0);
        expect(result.output).toContain(ciRefusal);
        expect(result.statuses).toEqual({});
        expect(result.written).toBe(cases);
        expect(result.recorded).toBeUndefined();
      }).pipe(Effect.scoped),
    60_000,
  );

  it.effect(
    "the runner refuses --update-snapshots in CI, and without --test-name, before a run starts",
    () =>
      Effect.gen(function* () {
        for (const env of [
          { CI: "true", GITHUB_ACTIONS: "" },
          { CI: "", GITHUB_ACTIONS: "true" },
        ]) {
          const refused = yield* startRunner(
            ["--test-name", "^a title$", "--update-snapshots"],
            env,
          );
          expect(refused.exitCode, refused.output).not.toBe(0);
          expect(refused.output).toContain(`--update-snapshots refused: ${ciRefusal}`);
          expect(refused.startedRun).toBe(false);
        }
        const unnamed = yield* startRunner(["--update-snapshots"], { CI: "", GITHUB_ACTIONS: "" });
        expect(unnamed.exitCode, unnamed.output).not.toBe(0);
        expect(unnamed.output).toContain(
          "--update-snapshots records only the scenarios --test-name names",
        );
        expect(unnamed.startedRun).toBe(false);
        // Only spaces name no scenario either: as a pattern they match nearly every title.
        const blank = yield* startRunner(["--test-name", " ", "--update-snapshots"], {
          CI: "",
          GITHUB_ACTIONS: "",
        });
        expect(blank.exitCode, blank.output).not.toBe(0);
        expect(blank.output).toContain(unnamedRefusal);
        expect(blank.startedRun).toBe(false);
      }),
    60_000,
  );

  it.effect(
    "in CI, Vitest's own update argument is refused however Vitest is started, and nothing is written",
    () =>
      Effect.gen(function* () {
        // Every spelling Vitest 5.0.1's parser reads as an update; `--update false` reads as all.
        const spellings = [
          ["-u"],
          ["--update"],
          ["--update=all"],
          ["--update", "new"],
          ["--update", "false"],
          ["--update=true"],
          ["-u=all"],
          ["--testNamePattern", "snapshot", "-u"],
        ];
        const launches: ReadonlyArray<readonly [string, Launch]> = [
          ...spellings.map((args) => [args.join(" "), vitestMjs(args)] as const),
          ["bun run cases -u", ["bun", ["run", "cases", "-u"]]],
          [
            "bunx vitest -u",
            ["bunx", ["--no-install", "vitest", "run", "--config", "vitest.config.ts", "-u"]],
          ],
        ];
        const results = yield* Effect.forEach(
          launches,
          ([label, launch]) =>
            runCases({ CI: "true" }, launch).pipe(
              Effect.map((result) => ({ label, ...result })),
              Effect.scoped,
            ),
          { concurrency: 4 },
        );
        for (const result of results) {
          expect(result.exitCode, `${result.label}\n${result.output}`).not.toBe(0);
          expect(result.output, result.label).toContain(`refused: ${ciRefusal}`);
          expect(result.statuses, result.label).toEqual({});
          expect(result.written, result.label).toBe(cases);
          expect(result.recorded, result.label).toBeUndefined();
        }
      }),
    120_000,
  );

  it.effect(
    "the runner checks --update-snapshots' --test-name before --part, and refuses --part with it",
    () =>
      Effect.gen(function* () {
        const outside = { CI: "", GITHUB_ACTIONS: "" };
        // An empty --test-name is refused before --part makes it a pattern naming every scenario.
        const unnamed = yield* startRunner(["--part", "1/1", "--update-snapshots"], outside);
        expect(unnamed.exitCode, unnamed.output).not.toBe(0);
        expect(unnamed.output).toContain(unnamedRefusal);
        expect(unnamed.startedRun).toBe(false);
        // With one, a part is CI's share of a run, where nothing is recorded: refused too.
        const named = yield* startRunner(
          [
            "--test-name",
            "^Only the runner's --update-snapshots lets the scenario worker write snapshots$",
            "--part",
            "1/1",
            "--update-snapshots",
          ],
          outside,
        );
        expect(named.exitCode, named.output).not.toBe(0);
        expect(named.output).toContain(
          "--update-snapshots records the scenarios --test-name names, not a part of a run",
        );
        expect(named.startedRun).toBe(false);
      }),
    60_000,
  );
});
