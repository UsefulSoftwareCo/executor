/**
 * A stack push can start two CI runs on one head within a second, with the same payload; the
 * second waits for the first and then reports its result (`node e2e/ci-repeat.ts`). The first cases
 * run the program as a process with the job's environment, against a stub `gh` first on its PATH
 * that answers from recorded runs, artifacts and jobs. The last ones run the steps of `checks.yml`
 * that record what a run tests and report a repeated run's checks, as bash runs them in CI, and
 * read what a repeat skips.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  keyedBase,
  payloadFields,
  pullRequestReads,
  recordKey,
  workerGrowthBlock,
} from "../ci-key.ts";
import { gateEnvironment } from "../support/gate-environment.ts";

/**
 * A `gh` that answers from files beside it: this run (`run`), the head's runs (`runs`), each run's
 * artifacts and jobs (`artifacts-<id>`, `jobs-<id>`) and the pull request (`pull`). `fail` makes
 * every call fail. `--jq` is applied with jq, as gh does.
 */
const stubGh = `#!/bin/sh
dir=$(dirname "$0")
echo "$*" >> "$dir/calls"
if [ -f "$dir/fail" ]; then echo "gh: Server Error (HTTP 502)" >&2; exit 1; fi
path=""; filter=""
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) filter="$2"; shift 2 ;;
    api) shift ;;
    *) path="$1"; shift ;;
  esac
done
case "$path" in
  *"/workflows/"*"/runs?"*) file="$dir/runs" ;;
  *"/artifacts"*) id=$(echo "$path" | sed 's|.*/runs/||; s|/artifacts.*||'); file="$dir/artifacts-$id" ;;
  *"/jobs"*) id=$(echo "$path" | sed 's|.*/runs/||; s|/jobs.*||'); file="$dir/jobs-$id" ;;
  *"/pulls/"*) file="$dir/pull" ;;
  *) file="$dir/run" ;;
esac
if [ -n "$filter" ]; then exec jq -r "$filter" "$file"; else exec cat "$file"; fi
`;

const self = 200;
const head = "0193aee740e16d2b2f15a305e71455381d4667a5";
const base = "6c1f2a9d0b8e4c7f3a5d9e1b2c4f6a8d0e2b4c6f";
/** What this run's select recorded: its pull request, then a key of what it tests (e2e/ci-key.ts). */
const tested = "ci-tested-pr1-3d0f6c2b8a4e1f9d7c5b3a1e0f2d4c6b8a9e7f1d";
/** What this run's select read for the size gate, as the record the site job uploads. */
const sized = "ci-sized-pr1-7a1c3e5f9b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a";

interface Recorded {
  readonly id: number;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly sha?: string;
  /**
   * The records its select uploaded. By default the run tested what this one tests: it carries
   * this run's record, and the record select uploaded before the pull request was part of it.
   */
  readonly artifacts?: ReadonlyArray<string>;
  readonly attempt?: number;
  readonly select?: string | null;
  readonly site?: string | null;
  readonly check?: string | null;
  readonly e2e?: string | null;
}

const runOf = (input: Recorded) => ({
  id: input.id,
  html_url: `https://github.com/owner/repository/actions/runs/${input.id}`,
  status: input.status ?? "completed",
  conclusion: input.conclusion === undefined ? "success" : input.conclusion,
  event: "pull_request",
  head_sha: input.sha ?? head,
  workflow_id: 7,
  run_attempt: input.attempt ?? 1,
});

const jobsOf = (input: Pick<Recorded, "select" | "site" | "check" | "e2e">) => ({
  jobs: [
    { name: "supersede", conclusion: "success" },
    { name: "checks / select", conclusion: input.select === undefined ? "success" : input.select },
    { name: "checks / site", conclusion: input.site === undefined ? "success" : input.site },
    { name: "checks / check", conclusion: input.check === undefined ? "success" : input.check },
    { name: "checks / e2e", conclusion: input.e2e === undefined ? "success" : input.e2e },
  ],
});

/** A directory holding the stub `gh`, its answers and its call log. */
const stub = Effect.fn(function* (answers: Record<string, unknown>, fail = false) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-ci-repeat-" });
  const bin = path.join(directory, "bin");
  yield* fs.makeDirectory(bin);
  yield* fs.writeFileString(path.join(bin, "gh"), stubGh);
  yield* fs.chmod(path.join(bin, "gh"), 0o755);
  yield* fs.writeFileString(path.join(bin, "calls"), "");
  if (fail) yield* fs.writeFileString(path.join(bin, "fail"), "");
  for (const [name, value] of Object.entries(answers))
    yield* fs.writeFileString(
      path.join(bin, name),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  const calls = fs
    .readFileString(path.join(bin, "calls"))
    .pipe(Effect.map((text) => text.split("\n").filter((line) => line.length > 0)));
  return { directory, bin, calls };
});

/** Runs a command with the stub first on PATH; returns its combined output and exit code. */
const spawn = Effect.fn(function* (
  command: string,
  args: ReadonlyArray<string>,
  bin: string,
  env: Record<string, string>,
  cwd?: string,
) {
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* processes.spawn(
    ChildProcess.make(command, args, {
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, ...env },
      extendEnv: true,
      ...(cwd === undefined ? {} : { cwd }),
    }),
  );
  const [log, exitCode] = yield* Effect.all(
    [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
    { concurrency: "unbounded" },
  );
  return { log, exitCode: Number(exitCode) };
});

const outputsOf = (text: string) =>
  Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );

const repeat = (input: {
  readonly runs: ReadonlyArray<Recorded>;
  readonly attempt?: number;
  readonly fail?: boolean;
  readonly sized?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const all: ReadonlyArray<Recorded> = [
      { id: self, status: "in_progress", conclusion: null },
      ...input.runs,
    ];
    const answers: Record<string, unknown> = {
      run: runOf(all[0]!),
      runs: { workflow_runs: all.map(runOf) },
    };
    for (const run of all) {
      answers[`artifacts-${run.id}`] = {
        artifacts: (run.artifacts ?? [`ci-tested-${base}`, tested, sized]).map((name) => ({
          name,
        })),
      };
      answers[`jobs-${run.id}`] = jobsOf(run);
    }
    const { directory, bin, calls } = yield* stub(answers, input.fail === true);
    const output = path.join(directory, "output");
    yield* fs.writeFileString(output, "");
    const result = yield* spawn("node", ["e2e/ci-repeat.ts"], bin, {
      CI_HEAD_SHA: head,
      CI_BASE_SHA: base,
      CI_TESTED: tested,
      CI_SIZED: input.sized ?? sized,
      GITHUB_REPOSITORY: "owner/repository",
      GITHUB_RUN_ID: String(self),
      GITHUB_RUN_ATTEMPT: String(input.attempt ?? 1),
      GITHUB_OUTPUT: output,
    });
    return {
      ...result,
      outputs: outputsOf(yield* fs.readFileString(output)),
      calls: yield* calls,
    };
  }).pipe(Effect.scoped);

/** The text of one job of `checks.yml`, up to the next job. */
const jobOf = (text: string, name: string) => {
  const start = text.indexOf(`\n  ${name}:\n`);
  expect(start, name).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[a-z0-9-]+:\n/);
  return end === -1 ? rest : rest.slice(0, end + 1);
};

/** The script of the step named `name` in `job`, as bash runs it, and the names of its env. */
const scriptOf = (job: string, name: string) => {
  const step = job.indexOf(`      - name: ${name}\n`);
  expect(step, name).toBeGreaterThan(-1);
  const lines = job.slice(step).split("\n");
  const start = lines.findIndex((line) => line === "        run: |");
  expect(start, `${name} has a run block`).toBeGreaterThan(0);
  const body: Array<string> = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
};

const checks = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(".github/workflows/checks.yml");
});

/**
 * Runs the record step of `select` in a repository whose HEAD holds `file`, for `pull`, with the
 * keys the select step wrote.
 */
const record = (input: {
  readonly pull: number;
  readonly file: string;
  readonly base?: string;
  /** The pull request's base branch: main by default. */
  readonly baseRef?: string;
  readonly selection?: string;
  readonly workerGrowth?: string;
  /** The size gate's baseline (scripts/ci/worker-baseline.ts's `id`). */
  readonly baseline?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const script = scriptOf(jobOf(yield* checks, "select"), "Record what this run tests");
    const { directory, bin } = yield* stub({});
    const repository = path.join(directory, "checkout");
    yield* fs.makeDirectory(repository);
    yield* fs.writeFileString(path.join(repository, "file"), input.file);
    // The step runs e2e/ci-key.ts from the checkout.
    yield* fs.symlink(path.resolve("e2e"), path.join(repository, "e2e"));
    const git = (...args: ReadonlyArray<string>) =>
      spawn(
        "git",
        ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.test", ...args],
        bin,
        {},
        repository,
      );
    yield* git("init", "-q");
    yield* git("add", "-A");
    yield* git("commit", "-q", "-m", "Merge");
    const output = path.join(directory, "output");
    yield* fs.writeFileString(output, "");
    const result = yield* spawn(
      "bash",
      ["-e", "-c", script],
      bin,
      {
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: "owner/repository",
        PULL: String(input.pull),
        ACTION: "synchronize",
        HEAD_SHA: head,
        BASE_SHA: input.base ?? base,
        BASE_REF: input.baseRef ?? "main",
        DEFAULT_BRANCH: "main",
        SELECTION: input.selection ?? "a".repeat(64),
        WORKER_GROWTH: input.workerGrowth ?? "b".repeat(64),
        BASELINE: input.baseline ?? `main@${base}`,
      },
      repository,
    );
    expect(result.exitCode, result.log).toBe(0);
    const tree = (yield* git("rev-parse", "HEAD^{tree}")).log.trim();
    const written = outputsOf(yield* fs.readFileString(output));
    return { name: written.name ?? "", sized: written.sized ?? "", log: result.log, tree };
  }).pipe(Effect.scoped);

/** Runs `check`'s or `e2e`'s report step, as a repeat of run 199 whose jobs are now `now`. */
const report = (input: {
  readonly job: "check" | "e2e";
  readonly now: Pick<Recorded, "select" | "check" | "e2e">;
  readonly ownSelect?: string;
}) =>
  Effect.gen(function* () {
    const step =
      input.job === "check"
        ? "Require every static check to pass"
        : "Require every selected E2E job to pass";
    const text = yield* checks;
    const job = jobOf(text, input.job);
    const script = scriptOf(job, step);
    const { bin } = yield* stub({ "jobs-199": jobsOf(input.now) });
    // A repeat's needs: its own select, and every other job skipped, as a repeat skips them.
    const needed = job
      .match(/^ {4}needs:\s*\[([^\]]*)\]/m)![1]!
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    const needs = Object.fromEntries(
      needed.map((name) => [
        name,
        {
          result: name === "select" ? (input.ownSelect ?? "success") : "skipped",
          outputs: name === "select" ? { "repeat-of": "199" } : {},
        },
      ]),
    );
    return yield* spawn("bash", ["-e", "-c", script], bin, {
      ...gateEnvironment(text, input.job, step, needs),
      GITHUB_REPOSITORY: "owner/repository",
      GITHUB_RUN_ID: String(self),
      // What the select of an older version passed on: the result when select ran.
      REPEAT_RESULT: "failure",
    });
  }).pipe(Effect.scoped);

layer(NodeServices.layer)("CI repeat", (it) => {
  it.effect("the second run of one push on one head reports the first run's result", () =>
    Effect.gen(function* () {
      // PR #4212's head got runs 43421907477 and 43421907459 in the same second; the second
      // waited for the first, then tested the same merge again for 38 runner-minutes.
      const passed = yield* repeat({ runs: [{ id: 199 }] });
      expect(passed.exitCode, passed.log).toBe(0);
      expect(passed.outputs).toEqual({ of: "199", check: "success", e2e: "success" });
      expect(passed.log).toContain(
        "This run repeats https://github.com/owner/repository/actions/runs/199, which tested the same pull request, merge tree, base and selection: check success, e2e success.",
      );
      expect(passed.calls.find((call) => call.includes("/workflows/"))).toContain(
        `head_sha=${head}`,
      );
      // A failure is not handed on: it is tested again (see "only a pass is handed on").
      const failed = yield* repeat({
        runs: [{ id: 199, conclusion: "failure", e2e: "failure" }],
      });
      expect(failed.outputs).toEqual({});
    }),
  );

  it.effect("only a pass is handed on: a failed, cancelled or unfinished run is tested again", () =>
    Effect.gen(function* () {
      const cases = {
        // 61f7d027c, 16 Nov: the hosted emulator timed out in one of two runs on one head.
        "a failed e2e": { id: 199, conclusion: "failure", e2e: "failure" },
        "a failed check": { id: 199, conclusion: "failure", check: "failure" },
        "a cancelled run": { id: 199, conclusion: "cancelled" },
        "a run that has not finished": { id: 199, status: "in_progress", conclusion: null },
      } satisfies Record<string, Recorded>;
      for (const [name, run] of Object.entries(cases)) {
        const result = yield* repeat({ runs: [run] });
        expect(result.exitCode, `${name}: ${result.log}`).toBe(0);
        expect(result.outputs, name).toEqual({});
        expect(result.log, name).toContain("tests in full");
      }
      const failed = yield* repeat({
        runs: [{ id: 199, conclusion: "failure", e2e: "failure" }],
      });
      expect(failed.log).toContain(
        "but its checks failed (check: success, e2e: failure), and only a pass is handed on: a failure is tested again; this run tests in full.",
      );
      // A pass still is.
      expect((yield* repeat({ runs: [{ id: 199 }] })).outputs.of).toBe("199");
    }),
  );

  /**
   * Two recorded runs of one head, as each select logged its key's parts. #4575's two runs at
   * fe692429f (16 Nov, 07:42Z) came from one stack push: the lower layer moved from db8e4293f to
   * b574b0acc, which the head already held, so the merge tree and selection were the same. #4574,
   * a pull request into main, ran on main at 9cbea0adc and later at 82eda7c59.
   */
  const recorded = {
    upper: {
      baseRef: "ci/worker-baseline",
      runs: [
        { id: 43825677200, base: "db8e4293ff1e423b597d479f20fc1830ea70191b" },
        { id: 43825680125, base: "b574b0acc36d4a64e3f6947ebec32b94e1dbae32" },
      ],
      tree: "f10586856cc6168620d95ea2cbbd6fe9f7ea2d04",
      selection: "37f62186dfaffccc8d3c2965b2d9846bf4475edf2232461e7269cc7863706740",
      workerGrowth: "5b4e0070baf99cd56167f27d96265a3e8e840ecb8cfd4e5a3dea48d9d318c7cb",
    },
    intoMain: {
      baseRef: "main",
      runs: [
        { id: 43797130175, base: "9cbea0adc2607de7d6fbabcaa35171d7171b0de8" },
        { id: 43817608300, base: "82eda7c5980da377625cab1c06eea354f744f10c" },
      ],
      // Held to one tree, so the base is the only difference.
      tree: "c855daf2f83193a10fb116cb79139d405ef65138",
      selection: "4accd01b1c0cf0fad749bc11b7e476b915136e964a55266c9c9e2d7afc44c0d1",
      workerGrowth: "5b4e0070baf99cd56167f27d96265a3e8e840ecb8cfd4e5a3dea48d9d318c7cb",
    },
  };

  it.effect(
    "a stack push that moves the lower layer under an unchanged tree gives the upper's two runs one key",
    () =>
      Effect.gen(function* () {
        const { baseRef, runs, tree, selection, workerGrowth } = recorded.upper;
        // Main's key before this change: the base commit in every key, so two keys.
        const before = runs.map((run) => recordKey(tree, run.base, selection, workerGrowth));
        expect(new Set(before).size).toBe(2);
        // Now: an upper layer's key holds no base commit, so one key.
        const now = runs.map((run) =>
          recordKey(tree, keyedBase(baseRef, "main", run.base), selection, workerGrowth),
        );
        expect(new Set(now).size).toBe(1);
        // And so does the workflow's own record step, for both the tested and the sized record.
        const [first, second] = yield* Effect.forEach(runs, (run) =>
          record({ pull: 4575, file: "the same tree", base: run.base, baseRef }),
        );
        expect(first!.name).toBe(second!.name);
        expect(first!.sized).toBe(second!.sized);
        // The record itself still names each run's real base, which a skip layer below reads.
        expect(first!.log).toContain(`base ${runs[0]!.base}`);
      }),
  );

  it.effect(
    "a pull request into main whose base moved, or a run that selects or compares otherwise, keeps its own key",
    () =>
      Effect.gen(function* () {
        const { baseRef, runs, tree, selection, workerGrowth } = recorded.intoMain;
        const keys = runs.map((run) =>
          recordKey(tree, keyedBase(baseRef, "main", run.base), selection, workerGrowth),
        );
        expect(new Set(keys).size).toBe(2);
        const [first, second] = yield* Effect.forEach(runs, (run) =>
          record({ pull: 4574, file: "the same tree", base: run.base, baseRef }),
        );
        expect(first!.name).not.toBe(second!.name);
        expect(first!.sized).not.toBe(second!.sized);
        // An upper layer whose base change altered the selection, or its size baseline, keeps two.
        const upper = recorded.upper;
        const [selected, other] = yield* Effect.forEach([upper.selection, "c".repeat(64)], (each) =>
          record({ pull: 4575, file: "the same tree", baseRef: upper.baseRef, selection: each }),
        );
        expect(selected!.name).not.toBe(other!.name);
        const [compared, elsewhere] = yield* Effect.forEach(
          ["effect-apps@" + "5".repeat(40), "main@" + "6".repeat(40)],
          (baseline) =>
            record({ pull: 4575, file: "the same tree", baseRef: upper.baseRef, baseline }),
        );
        expect(compared!.name).toBe(elsewhere!.name);
        expect(compared!.sized).not.toBe(elsewhere!.sized);
        // Retargeted onto main, the same head is keyed with its base again.
        expect(keyedBase("main", "main", runs[0]!.base)).toBe(runs[0]!.base);
        expect(keyedBase(upper.baseRef, "main", runs[0]!.base)).toBe("stacked");
      }),
  );

  it.effect("the newest finished run of the same record is the one repeated", () =>
    Effect.gen(function* () {
      const result = yield* repeat({
        runs: [
          { id: 150, check: "failure", conclusion: "failure" },
          { id: 180, artifacts: ["ci-tested-pr1-0000000000000000000000000000000000000000"] },
          { id: 170 },
        ],
      });
      expect(result.outputs.of).toBe("170");
    }),
  );

  it.effect("a run that did not test the same thing, or did not decide, tests in full", () =>
    Effect.gen(function* () {
      const cases = {
        // Another pull request opened from the same branch onto the same base.
        "another pull request": [
          {
            id: 199,
            artifacts: [
              `ci-tested-${base}`,
              "ci-tested-pr99-3d0f6c2b8a4e1f9d7c5b3a1e0f2d4c6b8a9e7f1d",
            ],
          },
        ],
        // Another merge tree, base or selection: the record's key differs.
        "another record": [
          { id: 199, artifacts: ["ci-tested-pr1-0000000000000000000000000000000000000000"] },
        ],
        "no record": [{ id: 199, artifacts: [] }],
        // A record whose name only starts or ends like this run's is another record.
        "a longer record name": [{ id: 199, artifacts: [`${tested}0`, sized] }],
        "a shorter record name": [{ id: 199, artifacts: [tested.slice(0, -1), sized] }],
        // A run cancelled after its required checks passed: its other jobs may not have run, and
        // a repeat would report it green.
        "a cancelled run whose required checks passed": [{ id: 199, conclusion: "cancelled" }],
        "still running": [{ id: 199, status: "in_progress", conclusion: null }],
        cancelled: [{ id: 199, conclusion: "cancelled", check: "cancelled", e2e: "cancelled" }],
        "another head": [{ id: 199, sha: "2ef6ecc4a0c9b09dbb766143499dfefb515f1347" }],
        // A lower stack layer skipped its checks: the repeat must decide for itself.
        "checks that skipped": [{ id: 199, check: "skipped", e2e: "skipped" }],
        // Select failed (a missing e2e block, a missing deployed-stage line, the host protocols):
        // this run reads the description as it is now.
        "a select that failed": [
          { id: 199, conclusion: "failure", select: "failure", check: "failure", e2e: "failure" },
        ],
        // A job outside the required checks failed (apps-version): a repeat's skipped job would
        // be the newer check on the commit and hide it, so this run tests and shows it again.
        "a run that failed while its required checks passed": [{ id: 199, conclusion: "failure" }],
        nothing: [],
      } satisfies Record<string, ReadonlyArray<Recorded>>;
      for (const [name, runs] of Object.entries(cases)) {
        const result = yield* repeat({ runs });
        expect(result.exitCode, `${name}: ${result.log}`).toBe(0);
        expect(result.outputs, name).toEqual({});
        expect(result.log, name).toContain("tests in full");
      }
    }),
  );

  it.effect("a re-run tests in full, and so does a run that cannot read", () =>
    Effect.gen(function* () {
      const rerun = yield* repeat({ runs: [{ id: 199 }], attempt: 2 });
      expect(rerun.outputs).toEqual({});
      expect(rerun.calls).toEqual([]);
      expect(rerun.log).toContain("This is attempt 2 of the run: a re-run tests in full.");
      const unreadable = yield* repeat({ runs: [{ id: 199 }], fail: true });
      expect(unreadable.exitCode, unreadable.log).toBe(0);
      expect(unreadable.outputs).toEqual({});
      expect(unreadable.log).toContain("it tests in full");
    }),
  );

  it.effect(
    "the record names the pull request and keys its merge tree, base and what select chose and read",
    () =>
      Effect.gen(function* () {
        const first = yield* record({ pull: 1, file: "one" });
        expect(first.name).toBe(
          `ci-tested-pr1-${recordKey(first.tree, base, "a".repeat(64), "b".repeat(64))}`,
        );
        expect(first.sized).toBe(
          `ci-sized-pr1-${recordKey(first.tree, base, "sized", "b".repeat(64), `main@${base}`)}`,
        );
        expect(first.log).toContain("pull request 1");
        // The same inputs give the same record.
        expect((yield* record({ pull: 1, file: "one" })).name).toBe(first.name);
        // Any one of them changed gives another.
        const others = {
          pull: yield* record({ pull: 99, file: "one" }),
          tree: yield* record({ pull: 1, file: "two" }),
          base: yield* record({ pull: 1, file: "one", base: "1".repeat(40) }),
          selection: yield* record({ pull: 1, file: "one", selection: "c".repeat(64) }),
          workerGrowth: yield* record({ pull: 1, file: "one", workerGrowth: "d".repeat(64) }),
        };
        for (const [name, other] of Object.entries(others))
          expect(other.name, name).not.toBe(first.name);
        expect(others.pull.name).toMatch(/^ci-tested-pr99-/);
        // The size gate's record follows only what it reads.
        expect(others.selection.sized).toBe(first.sized);
        expect(others.workerGrowth.sized).not.toBe(first.sized);
        // Compared with another baseline, the size gate's record differs, so a run checked against
        // effect-apps is never reported for one that would be checked against main.
        const branch = yield* record({
          pull: 1,
          file: "one",
          baseline: `effect-apps@${"5".repeat(40)}`,
        });
        expect(branch.name).toBe(first.name);
        expect(branch.sized).not.toBe(first.sized);
      }),
  );

  it.effect(
    "a run is repeated only from a first attempt whose size gate read what this run's select read",
    () =>
      Effect.gen(function* () {
        const cases = {
          // Its jobs may have read a later description than its select did.
          "a run that was run again": { runs: [{ id: 199, attempt: 2 }] },
          // Its size gate decided on other worker-growth blocks.
          "another size-gate read": {
            runs: [
              {
                id: 199,
                artifacts: [tested, "ci-sized-pr1-0000000000000000000000000000000000000000"],
              },
            ],
          },
          "no size-gate record": { runs: [{ id: 199, artifacts: [tested] }] },
          "this run recorded no size-gate read": { runs: [{ id: 199 }], sized: "" },
        } satisfies Record<string, { runs: ReadonlyArray<Recorded>; sized?: string }>;
        for (const [name, input] of Object.entries(cases)) {
          const result = yield* repeat(input);
          expect(result.exitCode, `${name}: ${result.log}`).toBe(0);
          expect(result.outputs, name).toEqual({});
          expect(result.log, name).toContain("tests in full");
        }
        // A run whose size gate did not run (a repeat itself, which checked it) needs no record.
        const repeated = yield* repeat({
          runs: [{ id: 199, site: "skipped", artifacts: [tested] }],
        });
        expect(repeated.outputs.of).toBe("199");
      }),
  );

  it.effect(
    "everything a run reads from the pull request is in the key or listed with why it need not be",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const text = yield* checks;
        const selection = yield* fs.readFileString("e2e/ci-selection.ts");
        const listed = (file: string, read: string) =>
          pullRequestReads.some(
            ({ where }) =>
              where.startsWith(`${file}: `) && read.startsWith(where.slice(file.length + 2)),
          );
        // Every read the selection makes of the pull request and main.
        const routes = [...selection.matchAll(/`repos\/\$\{[^}]+\}\/([^`?]+)/g)].map(
          (match) => match[1]!,
        );
        expect(routes.length).toBeGreaterThan(5);
        expect(routes.filter((route) => !listed("e2e/ci-selection.ts", route))).toEqual([]);
        // Every gh pr command the selection runs.
        expect(selection).toMatch(/"pr",\s*"list"/);
        for (const [command] of selection.matchAll(/"pr",\s*"[a-z]+"/g))
          expect(listed("e2e/ci-selection.ts", command.replace(/,\s*/, ", ")), command).toBe(true);
        // Every step of the workflows that reads the pull request through the API or gh pr.
        const workflows = yield* fs.readDirectory(".github/workflows");
        for (const name of workflows) {
          const workflow = yield* fs.readFileString(`.github/workflows/${name}`);
          for (const match of workflow.matchAll(
            /^ {6}- name: (.+)\n(?:(?! {6}- ).*\n)*?.*(?:pulls\/\$|gh pr (?:view|list))/gm,
          ))
            expect(listed(`.github/workflows/${name}`, match[1]!), `${name}: ${match[1]}`).toBe(
              true,
            );
          // Every field of the event payload's pull request a workflow uses is listed.
          for (const [, field] of workflow.matchAll(
            /github\.event\.pull_request\.([a-z_]+(?:\.[a-z_]+)*)/g,
          ))
            expect(Object.keys(payloadFields), `${name}: ${field}`).toContain(field);
        }
        // Nothing reads the whole event payload, which holds every field of the pull request.
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const grep = yield* processes.spawn(
          ChildProcess.make("git", [
            "grep",
            "-l",
            "-E",
            "GITHUB_EVENT_PATH|github[.]event_path",
            "--",
            ".github",
            "e2e",
            "scripts",
            "apps/hosted/cloud/scripts",
          ]),
        );
        const payloadReaders = (yield* grep.stdout.pipe(Stream.decodeText(), Stream.mkString))
          .split("\n")
          .filter(
            (file) =>
              file !== "" && file !== "e2e/ci-key.ts" && file !== "e2e/tests/ci-repeat.spec.ts",
          );
        expect(payloadReaders).toEqual([]);
        expect(text).toContain("      - name: Read the pull request's description\n");
        // The size gate and the key read worker-growth blocks with one expression.
        expect(yield* fs.readFileString("apps/hosted/cloud/scripts/worker-sizes.ts")).toContain(
          `/${workerGrowthBlock.source}/${workerGrowthBlock.flags}`,
        );
      }),
  );

  it.effect("a repeat's check and e2e read the repeated run's result as it is now", () =>
    Effect.gen(function* () {
      for (const job of ["check", "e2e"] as const) {
        // The repeated run was re-run and passed after this run's select: re-running this run's
        // failed jobs now passes.
        const now = yield* report({ job, now: {} });
        expect(now.exitCode, `${job}: ${now.log}`).toBe(0);
        expect(now.log, job).toContain("This run repeats run 199");
        // It fails while the repeated run's result fails, and says how to test again.
        const failed = yield* report({ job, now: { [job]: "failure" } });
        expect(failed.exitCode, job).toBe(1);
        expect(failed.log, job).toContain(
          `re-run run 199 and then this run's failed jobs, or test this run in full with: gh run rerun ${self}`,
        );
        // A select of the repeated run that fails now fails it too, and so does this run's own.
        expect((yield* report({ job, now: { select: "failure" } })).exitCode, job).toBe(1);
        expect((yield* report({ job, now: {}, ownSelect: "failure" })).exitCode, job).toBe(1);
      }
    }),
  );

  it.effect("a repeat skips the work, and the required checks still run", () =>
    Effect.gen(function* () {
      const text = yield* checks;
      const select = jobOf(text, "select");
      expect(select).toContain("      repeat-of: ${{ steps.repeat.outputs.of }}\n");
      expect(select).toContain("          name: ${{ steps.tested.outputs.name }}\n");
      expect(select).toContain("          CI_TESTED: ${{ steps.tested.outputs.name }}\n");
      expect(select).toContain("          CI_SIZED: ${{ steps.tested.outputs.sized }}\n");
      expect(select).toContain("        run: node e2e/ci-repeat.ts\n");
      // A re-run of the select job replaces its record rather than failing on the name.
      expect(select).toContain("          overwrite: true\n");
      // The selection runs first: what it chose is in the record the repeat check compares.
      const order = [
        "Choose the E2E scenarios",
        "Record what this run tests",
        "Find a finished run",
      ].map((step) => select.indexOf(`      - name: ${step}`));
      expect(order.every((index) => index > -1)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      // A repeat hands no selection on: every output select writes is empty for it. Skip also
      // waits for the check of the layer above (worker-sizes.spec.ts).
      const outputs = [...select.matchAll(/^ {6}([a-z-]+): \$\{\{ (.*) \}\}$/gm)];
      expect(outputs.length).toBeGreaterThan(10);
      for (const [, name, value] of outputs)
        if (value!.includes("steps.select.outputs"))
          expect(value, name).toBe(
            `steps.repeat.outputs.of == ''${name === "skip" ? " && steps.above.outcome == 'success'" : ""} && steps.select.outputs.${name} || ''`,
          );
      // The site job records what its size gate read.
      expect(jobOf(text, "site")).toContain("      - name: Record what the size gate reads\n");
      for (const job of [
        "static",
        "site",
        "apps-package",
        "tooling",
        "tooling-cloud",
        "collector-native",
        "self-host-native",
        "apps-version",
      ])
        expect(jobOf(text, job), job).toMatch(
          /\n {4}if: .*needs\.select\.outputs\.skip != 'true' && needs\.select\.outputs\.repeat-of == ''( && [^\n]*)?\n/,
        );
      for (const job of ["check", "e2e"])
        expect(jobOf(text, job), job).toContain(
          "    if: ${{ always() && needs.select.outputs.skip != 'true' }}\n",
        );
    }),
  );

  it.effect(
    "check fails when any job it stands for did not pass, the tooling and collector jobs included",
    () =>
      Effect.gen(function* () {
        const job = jobOf(yield* checks, "check");
        const needs = [
          "select",
          "static",
          "site",
          "apps-package",
          "tooling",
          "tooling-cloud",
          "collector-native",
        ];
        expect(job).toContain(`    needs: [${needs.join(", ")}]\n`);
        const script = scriptOf(job, "Require every static check to pass");
        const { bin } = yield* stub({});
        const run = (results: Record<string, string>, collector: string | null = "true") =>
          Effect.gen(function* () {
            return yield* spawn(
              "bash",
              ["-e", "-c", script],
              bin,
              gateEnvironment(
                yield* checks,
                "check",
                "Require every static check to pass",
                Object.fromEntries(
                  needs.map((name) => [
                    name,
                    {
                      result: results[name] ?? "success",
                      outputs: name === "select" && collector !== null ? { collector } : {},
                    },
                  ]),
                ),
              ),
            );
          });
        expect((yield* run({})).exitCode).toBe(0);
        // A job that failed, was cancelled, or was skipped by mistake fails the check. Select says
        // a collector input changed here, so collector-native's skip is a mistake too.
        for (const name of ["tooling", "tooling-cloud", "collector-native"])
          for (const result of ["failure", "cancelled", "skipped"]) {
            const failed = yield* run({ [name]: result });
            expect(failed.exitCode, `${name} ${result}`).toBe(1);
            expect(failed.log, `${name} ${result}`).toContain(`::error::${name}: ${result}`);
          }
        // collector-native skipped because select said no collector input changed passes; failed
        // or cancelled still fails, and so does any other job's skip. A select that wrote no
        // answer at all has not said the job is not needed.
        expect((yield* run({ "collector-native": "skipped" }, "false")).exitCode).toBe(0);
        for (const result of ["failure", "cancelled"])
          expect((yield* run({ "collector-native": result }, "false")).exitCode, result).toBe(1);
        expect((yield* run({ tooling: "skipped" }, "false")).exitCode).toBe(1);
        expect((yield* run({ "collector-native": "skipped" }, "")).exitCode).toBe(1);
        expect((yield* run({ "collector-native": "skipped" }, null)).exitCode).toBe(1);
      }).pipe(Effect.scoped),
  );
});
