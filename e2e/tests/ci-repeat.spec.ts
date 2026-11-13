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
/** What this run's select recorded: its pull request, then a hash of its merge tree and description. */
const tested = "ci-tested-pr1-3d0f6c2b8a4e1f9d7c5b3a1e0f2d4c6b8a9e7f1d";

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
  readonly select?: string | null;
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
});

const jobsOf = (input: Pick<Recorded, "select" | "check" | "e2e">) => ({
  jobs: [
    { name: "supersede", conclusion: "success" },
    { name: "checks / select", conclusion: input.select === undefined ? "success" : input.select },
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
        artifacts: (run.artifacts ?? [`ci-tested-${base}`, tested]).map((name) => ({ name })),
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

/** Runs the record step of `select` in a repository whose HEAD holds `tree`, for `pull`. */
const record = (input: {
  readonly pull: number;
  readonly description: string;
  readonly file: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const script = scriptOf(jobOf(yield* checks, "select"), "Record what this run tests");
    const { directory, bin } = yield* stub({
      pull: { number: input.pull, body: input.description },
    });
    const repository = path.join(directory, "checkout");
    yield* fs.makeDirectory(repository);
    yield* fs.writeFileString(path.join(repository, "file"), input.file);
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
        BASE_SHA: base,
      },
      repository,
    );
    expect(result.exitCode, result.log).toBe(0);
    return { name: outputsOf(yield* fs.readFileString(output)).name ?? "", log: result.log };
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
    const script = scriptOf(jobOf(yield* checks, input.job), step);
    const { bin } = yield* stub({ "jobs-199": jobsOf(input.now) });
    return yield* spawn("bash", ["-e", "-c", script], bin, {
      GITHUB_REPOSITORY: "owner/repository",
      GITHUB_RUN_ID: String(self),
      GH_TOKEN: "synthetic-token",
      REPEAT_OF: "199",
      // What the select of an older version passed on: the result when select ran.
      REPEAT_RESULT: "failure",
      NEEDS: JSON.stringify({ select: { result: input.ownSelect ?? "success", outputs: {} } }),
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
        "This run repeats https://github.com/owner/repository/actions/runs/199, which tested the same pull request, merge tree and description: check success, e2e success.",
      );
      expect(passed.calls.find((call) => call.includes("/workflows/"))).toContain(
        `head_sha=${head}`,
      );
      // A failure of a required check is repeated as it was: a repeat never turns red green.
      const failed = yield* repeat({
        runs: [{ id: 199, conclusion: "failure", e2e: "failure" }],
      });
      expect(failed.outputs).toEqual({ of: "199", check: "success", e2e: "failure" });
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
        // Another pull request opened from the same branch onto the same base: its description
        // asked for other suites, or carried a deployed-stage line this one lacks.
        "another pull request": [
          {
            id: 199,
            artifacts: [
              `ci-tested-${base}`,
              "ci-tested-pr99-3d0f6c2b8a4e1f9d7c5b3a1e0f2d4c6b8a9e7f1d",
            ],
          },
        ],
        // Another merge tree or description: the record's hash differs.
        "another record": [
          { id: 199, artifacts: ["ci-tested-pr1-0000000000000000000000000000000000000000"] },
        ],
        "no record": [{ id: 199, artifacts: [] }],
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

  it.effect("the record names the pull request and hashes the merge tree and description", () =>
    Effect.gen(function* () {
      const first = yield* record({ pull: 1, description: "```e2e\nnone\n```", file: "one" });
      expect(first.name).toMatch(/^ci-tested-pr1-[0-9a-f]{40}$/);
      expect(first.log).toContain("pull request 1");
      // The same pull request, tree and description give the same record.
      expect((yield* record({ pull: 1, description: "```e2e\nnone\n```", file: "one" })).name).toBe(
        first.name,
      );
      // Any one of them changed gives another.
      const others = [
        yield* record({ pull: 99, description: "```e2e\nnone\n```", file: "one" }),
        yield* record({ pull: 1, description: "```e2e\ngroups.spec.ts\n```", file: "one" }),
        yield* record({ pull: 1, description: "```e2e\nnone\n```", file: "two" }),
      ];
      for (const other of others) expect(other.name).not.toBe(first.name);
      expect(others[0]!.name).toMatch(/^ci-tested-pr99-/);
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
      expect(select).toContain("        run: node e2e/ci-repeat.ts\n");
      // A re-run of the select job replaces its record rather than failing on the name.
      expect(select).toContain("          overwrite: true\n");
      // The selection does not run, so every E2E job's selection output is empty.
      expect(select).toContain(
        "      - name: Choose the E2E scenarios\n        if: steps.repeat.outputs.of == ''\n",
      );
      for (const job of [
        "static",
        "site",
        "apps-package",
        "tooling",
        "tooling-cloud",
        "self-host-native",
        "apps-version",
      ])
        expect(jobOf(text, job), job).toMatch(
          /\n {4}if: .*needs\.select\.outputs\.skip != 'true' && needs\.select\.outputs\.repeat-of == ''\n/,
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
        const run = (results: Record<string, string>) =>
          spawn("bash", ["-e", "-c", script], bin, {
            REPEAT_OF: "",
            NEEDS: JSON.stringify(
              Object.fromEntries(
                needs.map((name) => [name, { result: results[name] ?? "success", outputs: {} }]),
              ),
            ),
          });
        expect((yield* run({})).exitCode).toBe(0);
        // A job that failed, was cancelled, or was skipped by mistake fails the check.
        for (const name of ["tooling", "tooling-cloud", "collector-native"])
          for (const result of ["failure", "cancelled", "skipped"]) {
            const failed = yield* run({ [name]: result });
            expect(failed.exitCode, `${name} ${result}`).toBe(1);
            expect(failed.log, `${name} ${result}`).toContain(`::error::${name}: ${result}`);
          }
      }).pipe(Effect.scoped),
  );
});
