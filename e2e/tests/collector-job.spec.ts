/**
 * Every release job that packages the CLI runtime starts beside the collector jobs and runs
 * `scripts/releases/collector-job.ts` before it fetches its target's collector build: it waits for
 * that target's `collector (<target>)` job and fails unless it succeeded. These cases run it as a
 * process against a local stand-in for GitHub's jobs API that answers with the given states in
 * order, repeating the last, and read its exit code, output and the requests it made.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

type State = { readonly status: string; readonly conclusion: string | null };

/**
 * One answer of the jobs API: an HTTP status with no body, a 200 with an empty body, the collector
 * jobs' states (absent: not listed), or the raw job list, which the stand-in serves 100 to a page
 * as GitHub does.
 */
type Answer =
  | { readonly status: number }
  | { readonly empty: true }
  | { readonly collectors: Record<string, State> }
  | {
      readonly jobs: ReadonlyArray<
        { readonly name: string; readonly run_attempt?: number } & State
      >;
    };

const run = "4243";
const repository = "example/executor-next";

/** A jobs API that answers `answers` in order and records each request's path and token. */
const jobsApi = (answers: ReadonlyArray<Answer>) => {
  const requests: Array<{ readonly path: string; readonly authorization: string | undefined }> = [];
  let listed = 0;
  const server = createServer((request, response) => {
    requests.push({ path: request.url ?? "", authorization: request.headers.authorization });
    const page = Number(
      new URL(request.url ?? "/", "http://stand-in").searchParams.get("page") ?? 1,
    );
    // A later page belongs to the same listing as the first.
    if (page === 1) listed += 1;
    const answer = answers[Math.min(listed - 1, answers.length - 1)]!;
    if ("status" in answer) {
      response.writeHead(answer.status);
      response.end();
      return;
    }
    if ("empty" in answer) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end();
      return;
    }
    const jobs =
      "jobs" in answer
        ? answer.jobs
        : [
            { name: "local (linux, x64)", status: "in_progress", conclusion: null },
            ...Object.entries(answer.collectors).map(([target, state]) => ({
              name: `collector (${target})`,
              ...state,
            })),
          ];
    response.writeHead(200, { "content-type": "application/json" });
    // GitHub gives every job an id; the waiter reads it to tell a list that changed between pages.
    const withIds = jobs.map((job, index) => ({ id: index + 1, run_attempt: 1, ...job }));
    response.end(
      JSON.stringify({
        total_count: withIds.length,
        jobs: withIds.slice((page - 1) * 100, page * 100),
      }),
    );
  });
  return Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  ).pipe(
    Effect.as({
      url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      requests: () => requests,
    }),
  );
};

/** The waiter for `target`, as attempt `attempt` of the run, with short limits if `limits`. */
const wait = (
  api: string,
  target: string,
  attempt = 1,
  limits?: { readonly limit: number; readonly attempt: number; readonly poll: number },
) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["scripts/releases/collector-job.ts"], {
        env: {
          GITHUB_API_URL: api,
          GITHUB_REPOSITORY: repository,
          GITHUB_RUN_ID: run,
          GH_TOKEN: "synthetic-token",
          TARGET: target,
          GITHUB_RUN_ATTEMPT: String(attempt),
          ...(limits === undefined
            ? {}
            : {
                JOB_WAIT_LIMIT_SECONDS: String(limits.limit),
                JOB_WAIT_ATTEMPT_SECONDS: String(limits.attempt),
                JOB_WAIT_POLL_SECONDS: String(limits.poll),
              }),
        },
        extendEnv: true,
      }),
    );
    const started = Date.now();
    const [log, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    return { exitCode, log, seconds: (Date.now() - started) / 1000 };
  }).pipe(Effect.scoped);

const inProgress: State = { status: "in_progress", conclusion: null };
const succeeded: State = { status: "completed", conclusion: "success" };

layer(NodeServices.layer)("packaging waits for its target's collector job", (it) => {
  it.effect("a collector job that succeeds after a while lets packaging fetch its build", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([
        { collectors: { "linux-x64": inProgress } },
        { collectors: { "linux-x64": succeeded } },
      ]);
      const result = yield* wait(api.url(), "linux-x64");
      expect(result.exitCode, result.log).toBe(0);
      expect(result.log).toContain(
        "Waiting for the collector (linux-x64) job: the collector (linux-x64) job is in_progress",
      );
      expect(result.log).toContain("The collector (linux-x64) job succeeded; fetching its build.");
      expect(api.requests()).toHaveLength(2);
      expect(api.requests()[0]).toEqual({
        path: `/repos/${repository}/actions/runs/${run}/attempts/1/jobs?per_page=100`,
        authorization: "Bearer synthetic-token",
      });
    }).pipe(Effect.scoped),
  );

  for (const conclusion of ["failure", "cancelled", "skipped", "timed_out"])
    it.effect(`a collector job that ended ${conclusion} stops packaging at once`, () =>
      Effect.gen(function* () {
        const api = yield* jobsApi([
          { collectors: { "win32-x64": { status: "completed", conclusion } } },
        ]);
        const result = yield* wait(api.url(), "win32-x64");
        expect(result.exitCode).toBe(1);
        expect(result.log).toContain(
          `The collector (win32-x64) job ended ${conclusion}, so this run has no win32-x64 collector to package.`,
        );
        expect(api.requests()).toHaveLength(1);
        expect(result.seconds).toBeLessThan(10);
      }).pipe(Effect.scoped),
    );

  it.effect("another target's collector job does not decide this target's packaging", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([
        {
          collectors: {
            "win32-x64": { status: "completed", conclusion: "failure" },
            "darwin-x64": inProgress,
            "linux-x64": succeeded,
          },
        },
      ]);
      const result = yield* wait(api.url(), "linux-x64");
      expect(result.exitCode, result.log).toBe(0);
      expect(api.requests()).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("a collector job listed on the second page of the run's jobs is found there", () =>
    Effect.gen(function* () {
      const others = Array.from({ length: 100 }, (_, index) => ({
        name: `recovery (linux, x64, ${index})`,
        ...inProgress,
      }));
      const api = yield* jobsApi([
        { jobs: [...others, { name: "collector (linux-arm64)", ...succeeded }] },
      ]);
      const result = yield* wait(api.url(), "linux-arm64");
      expect(result.exitCode, result.log).toBe(0);
      expect(api.requests().map((request) => request.path)).toEqual([
        `/repos/${repository}/actions/runs/${run}/attempts/1/jobs?per_page=100`,
        `/repos/${repository}/actions/runs/${run}/attempts/1/jobs?per_page=100&page=2`,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("two jobs with the collector job's name on two reads in a row stop packaging", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([
        {
          jobs: [
            { name: "collector (linux-x64)", ...succeeded },
            { name: "collector (linux-x64)", ...inProgress },
          ],
        },
      ]);
      const result = yield* wait(api.url(), "linux-x64");
      expect(result.exitCode).toBe(1);
      expect(result.log).toContain(
        `Run ${run} lists 2 jobs named collector (linux-x64) in attempt 1 on two reads in a row; cannot tell which to wait for.`,
      );
      expect(api.requests()).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("an earlier attempt's successful collector job never lets packaging go on", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([
        { jobs: [{ name: "collector (linux-x64)", run_attempt: 1, ...succeeded }] },
      ]);
      const result = yield* wait(api.url(), "linux-x64", 2, { limit: 2, attempt: 1, poll: 0.5 });
      expect(result.exitCode, result.log).toBe(1);
      expect(result.log).toContain(
        `(run ${run} lists a job named collector (linux-x64) from attempt 1, but none from this attempt, 2)`,
      );
      expect(api.requests().every((request) => request.path.includes("/attempts/2/jobs"))).toBe(
        true,
      );
    }).pipe(Effect.scoped),
  );

  // Answers that say nothing about the collector job: each is waited out and stops packaging at
  // the deadline, never taken as success.
  for (const [ending, answer, reason] of [
    ["a 404", { status: 404 }, "the jobs API answered 404"],
    ["a 401", { status: 401 }, "the jobs API answered 401"],
    ["a 200 with an empty body", { empty: true }, "the jobs API answered unreadably"],
  ] as const)
    it.effect(`${ending} on every read stops packaging at the deadline`, () =>
      Effect.gen(function* () {
        const api = yield* jobsApi([answer]);
        const result = yield* wait(api.url(), "linux-x64", 1, { limit: 2, attempt: 5, poll: 0.5 });
        expect(result.exitCode, result.log).toBe(1);
        expect(result.log).toContain(
          `The collector (linux-x64) job did not finish within 2 s (${reason}).`,
        );
        expect(result.log).not.toContain("succeeded; fetching its build");
        expect(api.requests().length).toBeGreaterThanOrEqual(2);
        expect(result.seconds).toBeLessThan(30);
      }).pipe(Effect.scoped),
    );

  it.effect("the lateness message names the limit in force, not the default", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([{ collectors: { "linux-x64": inProgress } }]);
      const result = yield* wait(api.url(), "linux-x64", 1, { limit: 2, attempt: 5, poll: 0.5 });
      expect(result.exitCode).toBe(1);
      expect(result.log).toContain(
        "The collector (linux-x64) job did not finish within 2 s (the collector (linux-x64) job is in_progress).",
      );
      expect(result.log).not.toContain("25 minutes");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a collector job not listed yet, or an API error, is waited out, not taken as success",
    () =>
      Effect.gen(function* () {
        const api = yield* jobsApi([
          { collectors: {} },
          { status: 502 },
          { collectors: { "darwin-arm64": succeeded } },
        ]);
        const result = yield* wait(api.url(), "darwin-arm64");
        expect(result.exitCode, result.log).toBe(0);
        expect(result.log).toContain(
          `Waiting for the collector (darwin-arm64) job: run ${run} lists no collector (darwin-arm64) job yet`,
        );
        expect(result.log).toContain(
          "Waiting for the collector (darwin-arm64) job: the jobs API answered 502",
        );
        expect(api.requests()).toHaveLength(3);
      }).pipe(Effect.scoped),
  );
});
