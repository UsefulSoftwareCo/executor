import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Option, Path, Schedule, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { randomBytes } from "node:crypto";
import { keepAllMarker, pruneRuns, shrunkMarker } from "../sdk/run-retention.ts";

const hour = 60 * 60_000;
const day = 24 * hour;
const mebibyte = 1024 ** 2;

const runName = (ago: number, target: string, suffix: string | undefined) =>
  `${new Date(Date.now() - ago).toISOString().replaceAll(":", "-")}-${target}${suffix === undefined ? "" : `-${suffix}`}`;

const gonePid = 2 ** 30;

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
    const [, day, hours, minutes, seconds] =
      /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}\.\d{3})Z/.exec(name) ?? [];
    const started = Date.parse(`${day}T${hours}:${minutes}:${seconds}Z`);
    if (Number.isFinite(started) && outcome !== "none" && outcome !== "unreadable") {
      const ended = new Date(Math.min(started + 60_000, Date.now()));
      yield* fs.utimes(path.join(directory, "evidence.json"), ended, ended);
    }
    return name;
  });

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
  const fractional = yield* run(runName(5 * day, "local", "aaaaae"), "passed", marker(1.5));
  const denied = yield* run(runName(5 * day, "local", "aaaaac"), "passed", marker(gonePid));
  yield* fs.chmod(path.join(runs, denied, `in-progress-${gonePid}-abcdef.json`), 0o000);
  const killed = yield* run(runName(4 * day, "cloud", "bbbbbb"), "none", marker(gonePid));
  const oldFailed = yield* run(runName(4 * day, "local", "f00010"), "failed");
  const oldPassed = yield* run(runName(4 * day, "self-host", "cccccc"), "passed");
  const oldFormat = yield* run(runName(10 * day, "cloud", undefined), "passed");
  yield* fs.makeDirectory(path.join(outside, "linked-as-run"), { recursive: true });
  yield* fs.writeFileString(path.join(outside, "linked-as-run/keep.txt"), "outside\n");
  const link = runName(8 * day, "self-host", "dddddd");
  yield* fs.symlink(path.join(outside, "linked-as-run"), path.join(runs, link));
  yield* fs.writeFileString(path.join(runs, "notes.txt"), "not a run\n");
  yield* fs.makeDirectory(path.join(runs, "scratch"));
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

const startAndFind = (input: Workspace, env?: Record<string, string>) =>
  Effect.gen(function* () {
    const before = yield* listing(input.runs);
    const output = yield* startRun(input, env);
    const added = (yield* listing(input.runs)).filter((name) => !before.includes(name));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+\.\d{3}Z-self-host-[0-9a-f]{6}$/);
    return { current: added[0]!, output, before };
  });

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
        expect(
          (yield* listing(path.join(input.runs, current))).filter((name) =>
            name.startsWith("in-progress-"),
          ),
        ).toEqual([]);
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
        yield* allocate(file(n.passed[0]!, "trace.zip"), 3 * mebibyte);
        for (const copy of [1, 2, 3])
          yield* fs.link(file(n.passed[0]!, "trace.zip"), file(n.passed[0]!, `trace-${copy}.zip`));
        yield* allocate(file(n.passed[1]!, "trace.zip"), 2 * mebibyte);
        yield* allocate(file(n.notPassed[0]!, "trace.zip"), 2 * mebibyte);
        yield* allocate(file(n.writingNow, "trace.zip"), 1.5 * mebibyte);
        yield* fs.writeFileString(file(n.passed[0]!, "sparse.webm"), "");
        yield* fs.truncate(file(n.passed[0]!, "sparse.webm"), 10 * 1024 ** 3);
        yield* pruneRuns({ workspace: input.repo, current: "", keepBytes: 6 * mebibyte });
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
      const pipe = path.join(input.runs, name, "evidence.json");
      expect(yield* processes.exitCode(ChildProcess.make("mkfifo", [pipe]))).toBe(0);
      const alias = path.join(input.root, "alias");
      yield* fs.symlink(input.repo, alias);
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
      yield* unblock;
      expect(yield* render.exitCode.pipe(Effect.timeout("20 seconds"))).not.toBe(0);
      expect(yield* markers).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

const bulky = {
  "local/coverage/0123456789abcdef/lcov.info": "TN:\n",
  "local/data/diagnostics/motel.sqlite": "db",
  "local/scenarios/0123456789abcdef0123456789abcdef/data/executor.pglite/base": "db",
  "local/scenarios/0123456789abcdef0123456789abcdef/engines-abc/data/state": "db",
  "cloud/data/diagnostics/motel-1/motel/data.sqlite": "db",
};
const lasting = {
  "local/scenarios/0123456789abcdef0123456789abcdef/server.log": "log\n",
  "local/scenarios/0123456789abcdef0123456789abcdef/scenario.json": "{}",
  "local/scenarios/0123456789abcdef0123456789abcdef/engines-abc/server.log": "log\n",
  "local/report/evidence/abc/result.json": "{}",
  "local/report/evidence/abc/trace.zip": "zip",
  "local/report/evidence/abc/raw.webm": "webm",
  "local/report/evidence/abc/checkpoint-1.png": "png",
  "cloud/cloud.log": "log\n",
};

const shrinkable = (runs: string, ago: number, outcome: "passed" | "failed", suffix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const name = runName(ago, "local", suffix);
    const directory = path.join(runs, name);
    for (const [file, text] of Object.entries({ ...bulky, ...lasting })) {
      yield* fs.makeDirectory(path.dirname(path.join(directory, file)), { recursive: true });
      yield* fs.writeFileString(path.join(directory, file), text);
    }
    yield* writeRun(runs, name, outcome);
    const ended = new Date(Date.now() - ago + 60_000);
    yield* fs.utimes(path.join(directory, "evidence.json"), ended, ended);
    return name;
  });

const holds = (runs: string, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const has = (file: string) => fs.exists(path.join(runs, name, file));
    const bulk: Array<string> = [];
    for (const file of Object.keys(bulky)) if (yield* has(file)) bulk.push(file);
    const kept: Array<string> = [];
    for (const file of Object.keys(lasting)) if (yield* has(file)) kept.push(file);
    return {
      bulk,
      lasting: kept.length === Object.keys(lasting).length,
      marker: yield* has(shrunkMarker),
    };
  });
const whole = { bulk: Object.keys(bulky), lasting: true, marker: false };
const shrunk = { bulk: [], lasting: true, marker: true };

layer(NodeServices.layer, { excludeTestServices: true })("e2e run folder shrinking", (it) => {
  it.effect(
    "the newest passed run stays whole, older passed runs and day-old failed runs lose only their bulk and say so",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { repo, runs } = yield* workspace;
        yield* fs.makeDirectory(runs, { recursive: true });
        const newestPassed = yield* shrinkable(runs, 2 * hour, "passed", "a00001");
        const olderPassed = yield* shrinkable(runs, 3 * hour, "passed", "a00002");
        const freshFailed = yield* shrinkable(runs, 23 * hour, "failed", "a00003");
        const dayOldFailed = yield* shrinkable(runs, 26 * hour, "failed", "a00004");
        const start = Date.now();
        yield* pruneRuns({ workspace: repo, current: "" });
        expect(yield* holds(runs, newestPassed)).toEqual(whole);
        expect(yield* holds(runs, freshFailed)).toEqual(whole);
        expect(yield* holds(runs, olderPassed)).toEqual(shrunk);
        expect(yield* holds(runs, dayOldFailed)).toEqual(shrunk);
        const record = JSON.parse(
          yield* fs.readFileString(path.join(runs, dayOldFailed, shrunkMarker)),
        ) as { shrunkAt: string; reason: string; removed: Array<string> };
        expect(record.removed.sort()).toEqual([
          "cloud/data",
          "local/coverage",
          "local/data",
          "local/scenarios/0123456789abcdef0123456789abcdef/data",
          "local/scenarios/0123456789abcdef0123456789abcdef/engines-abc/data",
        ]);
        expect(record.reason).toMatch(/24 hours/);
        expect(Date.parse(record.shrunkAt)).toBeGreaterThanOrEqual(start - 1000);
        const before = yield* fs.readFileString(path.join(runs, olderPassed, shrunkMarker));
        yield* pruneRuns({ workspace: repo, current: "" });
        expect(yield* fs.readFileString(path.join(runs, olderPassed, shrunkMarker))).toBe(before);
      }).pipe(Effect.scoped),
  );

  it.effect("keep-all-runs stops removal and shrinking", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { repo, runs } = yield* workspace;
      yield* fs.makeDirectory(runs, { recursive: true });
      yield* shrinkable(runs, 2 * hour, "passed", "b00001");
      const older = yield* shrinkable(runs, 3 * hour, "passed", "b00002");
      const aged = yield* shrinkable(runs, 5 * day, "failed", "b00003");
      yield* fs.writeFileString(path.join(runs, keepAllMarker), "");
      yield* pruneRuns({ workspace: repo, current: "" });
      expect(yield* holds(runs, older)).toEqual(whole);
      expect(yield* holds(runs, aged)).toEqual(whole);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a run in progress is not shrunk, and a bulk folder that is a link is not followed",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { repo, runs, outside } = yield* workspace;
        yield* fs.makeDirectory(runs, { recursive: true });
        yield* shrinkable(runs, 1 * hour, "passed", "c00001");
        const writing = yield* shrinkable(runs, 30 * hour, "failed", "c00002");
        yield* fs.writeFileString(
          path.join(runs, writing, `in-progress-${process.pid}-abcdef.json`),
          JSON.stringify({ pid: process.pid }),
        );
        const linked = yield* shrinkable(runs, 3 * hour, "passed", "c00003");
        yield* fs.makeDirectory(path.join(outside, "data"));
        yield* fs.writeFileString(path.join(outside, "data/keep.txt"), "outside\n");
        const scenario = path.join(
          runs,
          linked,
          "local/scenarios/fedcba9876543210fedcba9876543210",
        );
        yield* fs.makeDirectory(scenario, { recursive: true });
        yield* fs.symlink(path.join(outside, "data"), path.join(scenario, "data"));
        yield* pruneRuns({ workspace: repo, current: "" });
        expect(yield* holds(runs, writing)).toEqual(whole);
        expect(yield* holds(runs, linked)).toEqual(shrunk);
        expect(yield* fs.exists(path.join(outside, "data/keep.txt"))).toBe(true);
        expect(Option.isSome(yield* Effect.option(fs.readLink(path.join(scenario, "data"))))).toBe(
          true,
        );
      }).pipe(Effect.scoped),
  );

  const series = (runs: string, newestAgo: number) =>
    Effect.forEach([6, 5, 4, 3, 2, 1, 0], (step) =>
      shrinkable(runs, newestAgo + step * 2 * 60_000 + 60_000, "passed", `5e0${step}00`),
    );
  const evidence = "local/report/evidence/abc/lookups.json";

  it.effect(
    "a series of quick passed runs read together keeps every run whole while it is recent",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { repo, runs } = yield* workspace;
        yield* fs.makeDirectory(runs, { recursive: true });
        const names = yield* series(runs, 15 * 60_000);
        for (const name of names) yield* fs.writeFileString(path.join(runs, name, evidence), "{}");
        yield* pruneRuns({ workspace: repo, current: "" });
        for (const name of names) {
          expect(yield* holds(runs, name), name).toEqual(whole);
          expect(yield* fs.exists(path.join(runs, name, evidence)), name).toBe(true);
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "once the series is two hours old, the count takes passed runs past the newest five and the rest shrink",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { repo, runs } = yield* workspace;
        yield* fs.makeDirectory(runs, { recursive: true });
        const names = yield* series(runs, 3 * hour);
        yield* pruneRuns({ workspace: repo, current: "" });
        const left = (yield* fs.readDirectory(runs)).sort();
        expect(left).toEqual(names.slice(2).sort());
        expect(yield* holds(runs, names[6]!)).toEqual(whole);
        for (const name of names.slice(2, 6))
          expect(yield* holds(runs, name), name).toEqual(shrunk);
      }).pipe(Effect.scoped),
  );

  it.effect("past the byte cap even recent runs go, oldest first, to protect the disk", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { repo, runs } = yield* workspace;
      yield* fs.makeDirectory(runs, { recursive: true });
      const names = yield* Effect.forEach([4, 3, 2, 1], (step) =>
        writeRun(runs, runName(step * 5 * 60_000, "local", `ca0${step}00`), "passed", {
          "big.bin": "x".repeat(2 * mebibyte),
        }),
      );
      yield* pruneRuns({ workspace: repo, current: "", keepBytes: 5 * mebibyte });
      expect((yield* fs.readDirectory(runs)).sort()).toEqual(names.slice(2).sort());
      expect(yield* fs.exists(path.join(runs, names[3]!, "big.bin"))).toBe(true);
    }).pipe(Effect.scoped),
  );
});
