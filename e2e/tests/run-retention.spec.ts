/**
 * Each `bun run e2e:*` run writes a run folder under the workspace's `.local/e2e`, and a starting
 * run removes older ones (`e2e/sdk/run-retention.ts`). These cases start `e2e/run.ts` in a fake
 * workspace, with a test name no scenario has, so the run stops right after it starts, and read
 * which folders remain. The size case calls `pruneRuns` in this process with a 6 MiB cap.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Schedule, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { randomBytes } from "node:crypto";
import { pruneRuns } from "../sdk/run-retention.ts";

const hour = 60 * 60_000;
const day = 24 * hour;
const mebibyte = 1024 ** 2;

/** A run folder name as `runSuite` writes it, started `ago` milliseconds before now. */
const runName = (ago: number, target: string, suffix: string | undefined) =>
  `${new Date(Date.now() - ago).toISOString().replaceAll(":", "-")}-${target}${suffix === undefined ? "" : `-${suffix}`}`;

/** No process has this PID: Linux caps PIDs at 2^22 and macOS at 99,999. */
const gonePid = 2 ** 30;

/**
 * What a run folder holds about its outcome. `passed` and `failed` are what `runSuite` records;
 * the rest have no recorded outcome: a run saved before it was recorded whose cases all passed
 * (`legacy`), one whose second target has no evidence (`missing-target`), one whose Vitest
 * report says `success: false` though every case passed (`vitest-failed`), one with no cases
 * (`empty`), an `evidence.json` cut short (`unreadable`), and none at all, as a crash leaves it.
 */
type Outcome =
  | "passed"
  | "failed"
  | "legacy"
  | "missing-target"
  | "vitest-failed"
  | "empty"
  | "unreadable"
  | "none";

const evidence = (outcome: Outcome) => {
  const diagnostics = (target: string) => `${target}/report/diagnostics/results.json`;
  const passedCase = { title: "a", target: "self-host", status: "passed" };
  const runs = [{ target: "self-host", diagnostics: diagnostics("self-host") }];
  switch (outcome) {
    case "passed":
    case "failed":
      return {
        runs,
        entries: [passedCase, { ...passedCase, title: "b", status: outcome }],
        plan: [],
        outcome,
      };
    case "missing-target":
      return {
        runs: [...runs, { target: "cloud", diagnostics: diagnostics("cloud") }],
        entries: [passedCase],
        plan: [],
      };
    case "empty":
      return { runs, entries: [], plan: [] };
    default:
      return { runs, entries: [passedCase], plan: [] };
  }
};

/** A git workspace with an empty `.local/e2e`, and a directory outside it. */
const workspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-run-retention-" });
  const repo = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  const runs = path.join(repo, ".local/e2e");
  yield* fs.makeDirectory(outside, { recursive: true });
  yield* fs.makeDirectory(repo, { recursive: true });
  // The run reads the commit it tests.
  for (const args of [
    ["init", "--quiet"],
    ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com"].concat([
      "commit",
      "--quiet",
      "--allow-empty",
      "--message",
      "start",
    ]),
  ])
    expect(yield* processes.exitCode(ChildProcess.make("git", args, { cwd: repo }))).toBe(0);
  return { root, repo, outside, runs };
});

type Workspace = Effect.Success<typeof workspace>;

/** A finished run folder in `runs` with the outcome files `runSuite` and Vitest write. */
const writeRun = (
  runs: string,
  name: string,
  outcome: Outcome,
  files: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(runs, name);
    const results = path.join(directory, "self-host/report/diagnostics/results.json");
    yield* fs.makeDirectory(path.dirname(results), { recursive: true });
    if (outcome === "unreadable")
      yield* fs.writeFileString(path.join(directory, "evidence.json"), '{"outcome": "pas');
    else if (outcome !== "none") {
      yield* fs.writeFileString(
        path.join(directory, "evidence.json"),
        JSON.stringify(evidence(outcome)),
      );
      yield* fs.writeFileString(
        results,
        JSON.stringify({ success: outcome !== "vitest-failed" && outcome !== "failed" }),
      );
    }
    for (const [file, text] of Object.entries(files))
      yield* fs.writeFileString(path.join(directory, file), text);
    return name;
  });

/**
 * `.local/e2e` holds, newest first: seven passed runs from the last 7 hours, the oldest with a
 * link to a directory outside; a run another process started 30 minutes ago; seven runs from 8-14 hours ago that did not pass or record no
 * outcome; a passed run whose name is hour 25 of a day in 2000; 4-day-old failed, killed and passed runs; a
 * 5-day-old run another process is writing, one with a marker that is not JSON and one whose
 * marker cannot be read; a 10-day-old run in the old name format; a link named like a run
 * pointing outside; and files that are not runs.
 */
const populated = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const input = yield* workspace;
  const { runs, outside } = input;
  yield* fs.makeDirectory(runs, { recursive: true });
  const run = (name: string, outcome: Outcome, files?: Record<string, string>) =>
    writeRun(runs, name, outcome, files);
  const passed = yield* Effect.forEach([1, 2, 3, 4, 5, 6, 7], (hours, index) =>
    run(runName(hours * hour, "self-host", `00000${index}`), "passed"),
  );
  const notPassed = yield* Effect.forEach(
    ["failed", "legacy", "missing-target", "vitest-failed", "empty", "unreadable", "none"] as const,
    (outcome, index) => run(runName((8 + index) * hour, "local", `f0000${index}`), outcome),
  );
  const invalidTime = yield* run("2000-01-01T25-00-00.000Z-local-bad000", "passed");
  // The oldest passed run, which goes, links to a directory outside the workspace.
  yield* fs.makeDirectory(path.join(outside, "linked-from-run"), { recursive: true });
  yield* fs.writeFileString(path.join(outside, "linked-from-run/keep.txt"), "outside\n");
  yield* fs.symlink(path.join(outside, "linked-from-run"), path.join(runs, passed[6]!, "link"));
  const marker = (pid: number) => ({
    [`in-progress-${pid}-abcdef.json`]: JSON.stringify({ pid }),
  });
  const writing = yield* run(runName(5 * day, "local", "aaaaaa"), "none", marker(process.pid));
  const writingNow = yield* run(runName(hour / 2, "local", "aaaaad"), "none", marker(process.pid));
  const garbled = yield* run(runName(5 * day, "local", "aaaaab"), "passed", {
    "in-progress-1-abcdef.json": "{",
  });
  // `process.kill(1.5, 0)` throws, as for a gone PID; a PID that is not a positive integer keeps it.
  const fractional = yield* run(runName(5 * day, "local", "aaaaae"), "passed", marker(1.5));
  // A marker naming a gone PID, which this process may not read: kept, as it cannot be checked.
  const denied = yield* run(runName(5 * day, "local", "aaaaac"), "passed", marker(gonePid));
  yield* fs.chmod(path.join(runs, denied, `in-progress-${gonePid}-abcdef.json`), 0o000);
  const killed = yield* run(runName(4 * day, "cloud", "bbbbbb"), "none", marker(gonePid));
  const oldFailed = yield* run(runName(4 * day, "local", "f00010"), "failed");
  const oldPassed = yield* run(runName(4 * day, "self-host", "cccccc"), "passed");
  const oldFormat = yield* run(runName(10 * day, "cloud", undefined), "passed");
  // A link named like a run, to a directory outside: neither is removed.
  yield* fs.makeDirectory(path.join(outside, "linked-as-run"), { recursive: true });
  yield* fs.writeFileString(path.join(outside, "linked-as-run/keep.txt"), "outside\n");
  const link = runName(8 * day, "self-host", "dddddd");
  yield* fs.symlink(path.join(outside, "linked-as-run"), path.join(runs, link));
  yield* fs.writeFileString(path.join(runs, "notes.txt"), "not a run\n");
  yield* fs.makeDirectory(path.join(runs, "scratch"));
  // Run-named folders elsewhere under `.local` are not run folders.
  const elsewhere = path.join(input.repo, ".local/other", runName(9 * day, "cloud", "eeeeee"));
  yield* fs.makeDirectory(elsewhere, { recursive: true });
  return {
    ...input,
    elsewhere,
    names: {
      passed,
      notPassed,
      invalidTime,
      writing,
      writingNow,
      garbled,
      fractional,
      denied,
      killed,
      oldFailed,
      oldPassed,
      oldFormat,
      link,
    },
  };
});

/** Starts a run in the workspace. It stops after starting: no scenario has the test name. */
const startRun = (input: Workspace, env: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make(
        "node",
        [
          path.resolve("e2e/run.ts"),
          "--target",
          "self-host",
          "--test-name",
          "^no scenario has this name$",
        ],
        {
          cwd: input.repo,
          // CI is set on the runners; an empty value prunes as on a workstation. The host slot
          // would wait for other runs on this machine.
          env: { CI: "", EXECUTOR_E2E_HOST_SLOTS: "off", ...env },
          extendEnv: true,
        },
      ),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    expect(stdout + stderr).toContain("No scheduled scenarios match");
    expect(exitCode).not.toBe(0);
    return `${stdout}${stderr}`;
  }).pipe(Effect.scoped);

const listing = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return (yield* fs.readDirectory(directory)).toSorted();
  });

/** Starts a run and returns the run folder it added and its output. */
const startAndFind = (input: Workspace, env?: Record<string, string>) =>
  Effect.gen(function* () {
    const before = yield* listing(input.runs);
    const output = yield* startRun(input, env);
    const added = (yield* listing(input.runs)).filter((name) => !before.includes(name));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+\.\d{3}Z-self-host-[0-9a-f]{6}$/);
    return { current: added[0]!, output, before };
  });

/** Writes `bytes` of random data, which takes that much space even on a compressing file system. */
const allocate = (file: string, bytes: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFile(file, randomBytes(Math.round(bytes)));
  });

layer(NodeServices.layer, { excludeTestServices: true })("e2e run folder retention", (it) => {
  it.effect(
    "a starting run keeps five passed runs, every run without a recorded pass, runs in progress, and links",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = yield* populated;
        const n = input.names;
        const { current, output } = yield* startAndFind(input);
        // The two oldest passed runs go, though newer than the seven without a recorded pass,
        // which stay. Past 3 days the failed, killed (its marker names a gone PID), passed and
        // old-format runs go; the runs whose markers name a live PID, are not JSON or cannot be
        // read stay. The folder whose name is not a real time stays.
        expect(yield* listing(input.runs)).toEqual(
          [
            current,
            ...n.passed.slice(0, 5),
            ...n.notPassed,
            n.invalidTime,
            n.writing,
            n.writingNow,
            n.garbled,
            n.fractional,
            n.denied,
            n.link,
            "notes.txt",
            "scratch",
          ].toSorted(),
        );
        expect(output).toMatch(/e2e: removed 6 old runs \(\d+ MB freed\) from /);
        // The started run's marker is gone once it ends, and it recorded no pass.
        expect(
          (yield* listing(path.join(input.runs, current))).filter((name) =>
            name.startsWith("in-progress-"),
          ),
        ).toEqual([]);
        // Nothing outside `.local/e2e`, nor any link's target, was touched.
        expect(yield* fs.readLink(path.join(input.runs, n.link))).toBe(
          path.join(input.outside, "linked-as-run"),
        );
        expect(yield* fs.readFileString(path.join(input.outside, "linked-as-run/keep.txt"))).toBe(
          "outside\n",
        );
        expect(yield* fs.readFileString(path.join(input.outside, "linked-from-run/keep.txt"))).toBe(
          "outside\n",
        );
        expect(yield* fs.exists(input.elsewhere)).toBe(true);
      }),
  );

  it.effect(
    "past the byte cap passed runs go before others, oldest first, counting blocks on disk once and not runs in progress",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = yield* populated;
        const n = input.names;
        const file = (name: string, file: string) => path.join(input.runs, name, "self-host", file);
        // 3 MiB in the newest passed run, linked three more times; 2 MiB in the next; 2 MiB in
        // the newest run that failed; 1.5 MiB in the run started 30 minutes ago, which is still
        // being written. A 10 GiB sparse file in the newest passed run holds no blocks.
        yield* allocate(file(n.passed[0]!, "trace.zip"), 3 * mebibyte);
        for (const copy of [1, 2, 3])
          yield* fs.link(file(n.passed[0]!, "trace.zip"), file(n.passed[0]!, `trace-${copy}.zip`));
        yield* allocate(file(n.passed[1]!, "trace.zip"), 2 * mebibyte);
        yield* allocate(file(n.notPassed[0]!, "trace.zip"), 2 * mebibyte);
        yield* allocate(file(n.writingNow, "trace.zip"), 1.5 * mebibyte);
        yield* fs.writeFileString(file(n.passed[0]!, "sparse.webm"), "");
        yield* fs.truncate(file(n.passed[0]!, "sparse.webm"), 10 * 1024 ** 3);
        yield* pruneRuns({ workspace: input.repo, current: "", keepBytes: 6 * mebibyte });
        // About 7 MiB counts. Passed runs go oldest first until 6 MiB or less remain: the fifth to
        // the second. The newest passed run stays, and so does the older 2 MiB run that failed.
        expect(yield* listing(input.runs)).toEqual(
          [
            n.passed[0]!,
            ...n.notPassed,
            n.invalidTime,
            n.writing,
            n.writingNow,
            n.garbled,
            n.fractional,
            n.denied,
            n.link,
            "notes.txt",
            "scratch",
          ].toSorted(),
        );
      }),
  );

  it.effect("in CI a starting run removes nothing", () =>
    Effect.gen(function* () {
      const input = yield* populated;
      const { current, output, before } = yield* startAndFind(input, { CI: "true" });
      expect(yield* listing(input.runs)).toEqual([...before, current].toSorted());
      expect(output).not.toContain("old runs");
    }),
  );

  for (const linked of [".local", ".local/e2e"])
    it.effect(`a starting run removes nothing when ${linked} is a link`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = yield* workspace;
        // The linked directory lives outside the workspace and holds a 4-day-old passed run.
        const target = path.join(input.outside, "linked");
        yield* fs.makeDirectory(path.join(target, linked === ".local" ? "e2e" : ""), {
          recursive: true,
        });
        yield* fs.makeDirectory(path.dirname(path.join(input.repo, linked)), { recursive: true });
        yield* fs.symlink(target, path.join(input.repo, linked));
        const old = yield* writeRun(input.runs, runName(4 * day, "local", "a00000"), "passed");
        const { current, output } = yield* startAndFind(input);
        expect(yield* listing(input.runs)).toEqual([current, old].toSorted());
        expect(output).toContain("is or is under a symbolic link");
      }),
    );

  it.effect("a render given its run through a link holds the run while it writes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const input = yield* workspace;
      yield* fs.makeDirectory(input.runs, { recursive: true });
      const name = yield* writeRun(input.runs, runName(5 * day, "local", "a00001"), "none");
      // The render blocks reading `evidence.json`, a pipe, until this test writes to it.
      const pipe = path.join(input.runs, name, "evidence.json");
      expect(yield* processes.exitCode(ChildProcess.make("mkfifo", [pipe]))).toBe(0);
      const alias = path.join(input.root, "alias");
      yield* fs.symlink(input.repo, alias);
      // Opening the pipe for reading and writing never blocks, so this always unblocks the render,
      // whether it is waiting or gone. It runs before the spawn's own finaliser, which kills it.
      const unblock = fs.writeFileString(pipe, "{}", { flag: "r+" }).pipe(Effect.ignore);
      const render = yield* processes.spawn(
        ChildProcess.make(
          "node",
          [path.resolve("e2e/render.ts"), "--directory", path.join(alias, ".local/e2e", name)],
          { cwd: input.repo, killSignal: "SIGKILL" },
        ),
      );
      yield* Effect.addFinalizer(() => unblock);
      const markers = listing(path.join(input.runs, name)).pipe(
        Effect.map((names) => names.filter((file) => file.startsWith("in-progress-"))),
      );
      yield* markers.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("50 millis"),
          until: (found) => found.length > 0,
        }),
        Effect.timeout("20 seconds"),
      );
      yield* startAndFind(input);
      expect(yield* listing(input.runs)).toContain(name);
      // Ending the render gives the marker up.
      yield* unblock;
      expect(yield* render.exitCode.pipe(Effect.timeout("20 seconds"))).not.toBe(0);
      expect(yield* markers).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
