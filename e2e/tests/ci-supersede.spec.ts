/**
 * CI's `supersede` job runs `node e2e/ci-supersede.ts` to cancel a pull request's runs on heads it
 * has left. These cases run it as a process with the job's environment. A stub `gh` first on its
 * PATH answers its reads of the pull request and the runs, and logs each call.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * A `gh` that answers from files beside it: the pull request (`pull`), this run (`run`) and the
 * pull request's runs (`runs`). A cancel succeeds unless `cancel-<id>` holds an error to print.
 */
const stubGh = `#!/bin/sh
dir=$(dirname "$0")
echo "$*" >> "$dir/calls"
case "$*" in
  *"/pulls/"*) exec cat "$dir/pull" ;;
  *"/workflows/"*"/runs?"*) exec cat "$dir/runs" ;;
  *"/cancel")
    id=$(echo "$*" | sed 's|.*/runs/||; s|/cancel||')
    if [ -f "$dir/cancel-$id" ]; then cat "$dir/cancel-$id" >&2; exit 1; fi
    exit 0 ;;
  *) exec cat "$dir/run" ;;
esac
`;

const self = 100;
const head = "0193aee740e16d2b2f15a305e71455381d4667a5";
const older = "2ef6ecc4a0c9b09dbb766143499dfefb515f1347";

const run = (input: {
  readonly id: number;
  readonly sha?: string;
  readonly status?: string;
  readonly pullRequests?: ReadonlyArray<number>;
}) => ({
  id: input.id,
  html_url: `https://github.com/owner/repository/actions/runs/${input.id}`,
  status: input.status ?? "in_progress",
  head_sha: input.sha ?? older,
  workflow_id: 7,
  pull_requests: (input.pullRequests ?? [1]).map((number) => ({ number })),
});

const supersede = (input: {
  readonly current?: string;
  readonly runs: ReadonlyArray<ReturnType<typeof run>>;
  readonly cancelErrors?: Readonly<Record<number, string>>;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-ci-supersede-" });
    const bin = path.join(directory, "bin");
    yield* fs.makeDirectory(bin);
    yield* fs.writeFileString(path.join(bin, "gh"), stubGh);
    yield* fs.chmod(path.join(bin, "gh"), 0o755);
    yield* fs.writeFileString(path.join(bin, "calls"), "");
    yield* fs.writeFileString(
      path.join(bin, "pull"),
      JSON.stringify({ head: { sha: input.current ?? head, ref: "stack/layer-2" } }),
    );
    yield* fs.writeFileString(path.join(bin, "run"), JSON.stringify(run({ id: self, sha: head })));
    yield* fs.writeFileString(
      path.join(bin, "runs"),
      JSON.stringify({ workflow_runs: input.runs }),
    );
    for (const [id, error] of Object.entries(input.cancelErrors ?? {}))
      yield* fs.writeFileString(path.join(bin, `cancel-${id}`), error);
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["e2e/ci-supersede.ts"], {
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          CI_PULL_REQUEST: "1",
          CI_HEAD_SHA: head,
          GITHUB_REPOSITORY: "owner/repository",
          GITHUB_RUN_ID: String(self),
        },
        extendEnv: true,
      }),
    );
    const [log, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    const calls = (yield* fs.readFileString(path.join(bin, "calls")))
      .split("\n")
      .filter((line) => line.length > 0);
    const cancelled = calls
      .filter((call) => call.endsWith("/cancel"))
      .map((call) => Number(call.replace(/.*\/runs\/(\d+)\/cancel$/, "$1")));
    return { exitCode, log, calls, cancelled };
  }).pipe(Effect.scoped);

layer(NodeServices.layer)("CI supersede", (it) => {
  it.effect(
    "a run on the current head cancels the pull request's unfinished runs on older heads",
    () =>
      Effect.gen(function* () {
        const result = yield* supersede({
          runs: [
            run({ id: self, sha: head }),
            run({ id: 90, status: "in_progress" }),
            run({ id: 91, status: "queued" }),
            run({ id: 92, status: "pending" }),
            run({ id: 80, status: "completed" }),
          ],
        });
        expect(result.exitCode, result.log).toBe(0);
        expect(result.cancelled).toEqual([90, 91, 92]);
        expect(result.log).toContain(
          `Cancelled https://github.com/owner/repository/actions/runs/90, which tests ${older}.`,
        );
        expect(result.calls.find((call) => call.includes("/workflows/"))).toContain(
          "branch=stack%2Flayer-2",
        );
      }),
  );

  it.effect("another run on the same head is left to report its own result", () =>
    Effect.gen(function* () {
      // A stack push can start two runs on one head; cancelling either leaves failing checks.
      const result = yield* supersede({
        runs: [
          run({ id: self, sha: head }),
          run({ id: 99, sha: head }),
          run({ id: 101, sha: head }),
        ],
      });
      expect(result.exitCode, result.log).toBe(0);
      expect(result.cancelled).toEqual([]);
      expect(result.log).toContain("No run of this pull request tests an older head.");
    }),
  );

  it.effect("another pull request's runs on the same branch are left alone", () =>
    Effect.gen(function* () {
      const result = yield* supersede({
        runs: [run({ id: 90, pullRequests: [2] }), run({ id: 91, pullRequests: [] })],
      });
      expect(result.exitCode, result.log).toBe(0);
      expect(result.cancelled).toEqual([]);
    }),
  );

  it.effect("a run whose head the pull request has left cancels nothing", () =>
    Effect.gen(function* () {
      // The newer head's run may have started first; this late run must not cancel it.
      const result = yield* supersede({ current: older, runs: [run({ id: 90, sha: older })] });
      expect(result.exitCode, result.log).toBe(0);
      expect(result.cancelled).toEqual([]);
      expect(result.calls.some((call) => call.includes("/runs"))).toBe(false);
      expect(result.log).toContain(`the pull request's head is now ${older}`);
    }),
  );

  it.effect("a run that finished before its cancel is not an error, and other refusals are", () =>
    Effect.gen(function* () {
      const finished = yield* supersede({
        runs: [run({ id: 90 }), run({ id: 91 })],
        cancelErrors: { 90: "gh: Cannot cancel a workflow run that is completed. (HTTP 409)" },
      });
      expect(finished.exitCode, finished.log).toBe(0);
      expect(finished.cancelled).toEqual([90, 91]);
      expect(finished.log).toContain("runs/90 finished before it could be cancelled.");
      expect(finished.log).toContain(
        "Cancelled https://github.com/owner/repository/actions/runs/91",
      );
      const refused = yield* supersede({
        runs: [run({ id: 90 })],
        cancelErrors: { 90: "gh: Resource not accessible by integration (HTTP 403)" },
      });
      expect(refused.exitCode).toBe(1);
      expect(refused.log).toContain("HTTP 403");
    }),
  );
});
