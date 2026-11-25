import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { ciRefusal, unnamedRefusal, updateSnapshotsVariable } from "../snapshot-updates.ts";

const checkout = process.cwd();

const runnerEnvironment = (directory: string) => ({
  PATH: process.env.PATH ?? "",
  ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
  EXECUTOR_E2E_RUN: directory,
  E2E_TARGET: "self-host",
  E2E_SUITE: "all",
  E2E_CLOUD_MODE: "managed",
  E2E_WORKERS: "1",
  E2E_TEST_NAME: "",
  NO_COLOR: "1",
});

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

type Launch = readonly [command: string, args: ReadonlyArray<string>];

const vitestMjs = (args: ReadonlyArray<string> = []): Launch => [
  "node",
  [`${checkout}/node_modules/vitest/vitest.mjs`, "run", "--config", "vitest.config.ts", ...args],
];

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

const startRunner = (args: ReadonlyArray<string>, env: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-snapshot-runner-" });
    const result = yield* run(
      "node",
      [path.join(checkout, "e2e/run.ts"), "--target", "self-host", ...args],
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
      expect(yield* updates(files, {})).toEqual(every("none"));
      expect(yield* updates(files, { [updateSnapshotsVariable]: "1" })).toEqual(every("all"));
      expect(yield* updates(files, { [updateSnapshotsVariable]: "1", CI: "true" })).toEqual(
        every(`threw: ${ciRefusal}`),
      );
      expect(
        yield* updates(files, { [updateSnapshotsVariable]: "1", GITHUB_ACTIONS: "true" }),
      ).toEqual(every(`threw: ${ciRefusal}`));
      expect(yield* updates(files, { CI: "true" }, ["run", "-u"])).toEqual(
        every(`threw: Vitest's update argument (true) refused: ${ciRefusal}`),
      );
      expect(yield* updates(files, { GITHUB_ACTIONS: "true" }, ["run", "--update=all"])).toEqual(
        every(`threw: Vitest's update argument ("all") refused: ${ciRefusal}`),
      );
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
        const unrecorded = `no snapshot is recorded, and this run records none.\nThe scenario produced:\n`;
        expect(result.output).toContain(
          `${unrecorded}${JSON.stringify(text).replace("\\n", "\n")}\n`,
        );
        expect(result.output).toContain(`${unrecorded}${text}\n`);
        expect(result.output).toContain("--update-snapshots");
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
        const unnamed = yield* startRunner(["--part", "1/1", "--update-snapshots"], outside);
        expect(unnamed.exitCode, unnamed.output).not.toBe(0);
        expect(unnamed.output).toContain(unnamedRefusal);
        expect(unnamed.startedRun).toBe(false);
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
