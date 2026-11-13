/**
 * Before going live, the production deploy job runs `scripts/releases/apps-job.ts`, which waits
 * for the same run's `apps` job (it publishes the `apps` release or checks it is on npm unchanged)
 * and fails unless that job succeeded. These cases run it as a process against a local stand-in
 * for GitHub's jobs API that answers with the given states in order, repeating the last, and read
 * its exit code, output and the requests it made.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** One answer of the jobs API: an HTTP status, or the `apps` job's state (absent: not listed). */
type Answer =
  | { readonly status: number }
  | { readonly apps?: { readonly status: string; readonly conclusion: string | null } };

const run = "4242";
const repository = "example/executor-next";

/** A jobs API that answers `answers` in order and records each request's path and token. */
const jobsApi = (answers: ReadonlyArray<Answer>) => {
  const requests: Array<{ readonly path: string; readonly authorization: string | undefined }> = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url ?? "", authorization: request.headers.authorization });
    const answer = answers[Math.min(requests.length - 1, answers.length - 1)]!;
    if ("status" in answer) {
      response.writeHead(answer.status);
      response.end();
      return;
    }
    const jobs = [
      { name: "deploy", status: "in_progress", conclusion: null },
      ...(answer.apps === undefined ? [] : [{ name: "apps", ...answer.apps }]),
    ];
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ total_count: jobs.length, jobs }));
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

const wait = (api: string) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["scripts/releases/apps-job.ts"], {
        env: {
          GITHUB_API_URL: api,
          GITHUB_REPOSITORY: repository,
          GITHUB_RUN_ID: run,
          GH_TOKEN: "synthetic-token",
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

const inProgress = { apps: { status: "in_progress", conclusion: null } };
const succeeded = { apps: { status: "completed", conclusion: "success" } };

layer(NodeServices.layer)("deploy waits for the apps job", (it) => {
  it.effect("an apps job that succeeds after a while lets the deploy continue", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([inProgress, succeeded]);
      const result = yield* wait(api.url());
      expect(result.exitCode, result.log).toBe(0);
      expect(result.log).toContain("Waiting for the apps job: the apps job is in_progress");
      expect(result.log).toContain("The apps job succeeded");
      expect(api.requests()).toEqual([
        {
          path: `/repos/${repository}/actions/runs/${run}/jobs?filter=latest&per_page=100`,
          authorization: "Bearer synthetic-token",
        },
        {
          path: `/repos/${repository}/actions/runs/${run}/jobs?filter=latest&per_page=100`,
          authorization: "Bearer synthetic-token",
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("an apps job that already succeeded costs one request", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([succeeded]);
      const result = yield* wait(api.url());
      expect(result.exitCode, result.log).toBe(0);
      expect(api.requests()).toHaveLength(1);
      expect(result.seconds).toBeLessThan(10);
    }).pipe(Effect.scoped),
  );

  for (const conclusion of ["failure", "cancelled", "skipped", "timed_out"])
    it.effect(`an apps job that ended ${conclusion} stops the deploy at once`, () =>
      Effect.gen(function* () {
        const api = yield* jobsApi([{ apps: { status: "completed", conclusion } }]);
        const result = yield* wait(api.url());
        expect(result.exitCode).toBe(1);
        expect(result.log).toContain(
          `The apps job ended ${conclusion}, so npm may not serve this build's apps release; not deploying.`,
        );
        expect(api.requests()).toHaveLength(1);
        expect(result.seconds).toBeLessThan(10);
      }).pipe(Effect.scoped),
    );

  it.effect(
    "an apps job not listed yet, or an API error, is waited out, not taken as success",
    () =>
      Effect.gen(function* () {
        const api = yield* jobsApi([{}, { status: 502 }, succeeded]);
        const result = yield* wait(api.url());
        expect(result.exitCode, result.log).toBe(0);
        expect(result.log).toContain(`Waiting for the apps job: run ${run} lists no apps job yet`);
        expect(result.log).toContain("Waiting for the apps job: the jobs API answered 502");
        expect(api.requests()).toHaveLength(3);
      }).pipe(Effect.scoped),
  );
});
