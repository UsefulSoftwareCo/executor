/**
 * Before going live, the production deploy job runs `scripts/releases/apps-job.ts`, which waits
 * for the same run's `apps` job (it publishes the `apps` release or checks it is on npm unchanged)
 * and fails unless that job succeeded. These cases run it as a process against a local stand-in
 * for GitHub's jobs API that answers with the given states in order, repeating the last, and read
 * its exit code, output and the requests it made. Cases about time set the waiter's limits short
 * through `JOB_WAIT_LIMIT_SECONDS`, `JOB_WAIT_ATTEMPT_SECONDS` and `JOB_WAIT_POLL_SECONDS`. The
 * waiter's attempt is `GITHUB_RUN_ATTEMPT`, 1 unless a case says otherwise; every case sets it,
 * since a CI step has its own.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

type State = { readonly status: string; readonly conclusion: string | null };
/** A listed job; its `run_attempt` is the attempt the request asked for unless given. */
type Listed = {
  readonly id: number;
  readonly name: string;
  readonly run_attempt?: number;
  readonly started_at?: string;
  readonly completed_at?: string;
} & State;

/**
 * One answer of the jobs API: an HTTP status; the `apps` job's state (absent: not listed); explicit
 * pages, each with the total it claims; a stall, an answer that never sends its headers, or sends
 * them and never ends its body; a raw body, sent as given; or a slow answer, whose headers and
 * the rest of its body each come after a delay.
 */
type Answer =
  | { readonly status: number }
  | { readonly apps?: State }
  | {
      readonly pages: ReadonlyArray<{
        readonly total: number;
        readonly jobs: ReadonlyArray<Listed>;
      }>;
    }
  | { readonly stall: "headers" }
  | { readonly stall: "body"; readonly status: number }
  | {
      readonly raw: string;
      readonly status?: number;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | {
      readonly slow: {
        readonly headersMs: number;
        readonly bodyMs: number;
        readonly status: number;
        readonly body: string;
      };
    };

const run = "4242";
const repository = "example/executor-next";
const path = `/repos/${repository}/actions/runs/${run}/attempts/1/jobs?per_page=100`;

/**
 * A jobs API that answers `answers` in order to listings of the waiter's attempt (`attempt`, 1 by
 * default), and `other` to any other listing: another attempt's, or `filter=latest`. It records
 * each request's path and token.
 */
const jobsApi = (
  answers: ReadonlyArray<Answer>,
  options: { readonly attempt?: number; readonly other?: Answer } = {},
) => {
  const attempt = options.attempt ?? 1;
  const requests: Array<{ readonly path: string; readonly authorization: string | undefined }> = [];
  const times: Array<number> = [];
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();
  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
  };
  let listings = 0;
  const server = createServer((request, response) => {
    requests.push({ path: request.url ?? "", authorization: request.headers.authorization });
    times.push(Date.now());
    const page = Number(
      new URL(request.url ?? "/", "http://stand-in").searchParams.get("page") ?? 1,
    );
    const served = Number(/\/attempts\/(\d+)\/jobs/u.exec(request.url ?? "")?.[1] ?? 0);
    const own = served === attempt;
    // A later page belongs to the listing its first page started.
    if (own && page === 1) listings += 1;
    const answer = own
      ? answers[Math.min(listings - 1, answers.length - 1)]!
      : (options.other ?? { status: 404 });
    if ("stall" in answer) {
      if (answer.stall === "body") {
        response.writeHead(answer.status, { "content-type": "application/json" });
        response.write('{"total_count":');
      }
      return;
    }
    if ("raw" in answer) {
      response.writeHead(answer.status ?? 200, {
        "content-type": "application/json",
        ...answer.headers,
      });
      response.end(answer.raw);
      return;
    }
    if ("slow" in answer) {
      const { headersMs, bodyMs, status, body } = answer.slow;
      later(headersMs, () => {
        response.writeHead(status, { "content-type": "application/json" });
        response.write(body.slice(0, 1));
        later(bodyMs, () => response.end(body.slice(1)));
      });
      return;
    }
    if ("status" in answer) {
      response.writeHead(answer.status);
      response.end();
      return;
    }
    const listed =
      "pages" in answer
        ? answer.pages[page - 1]
        : {
            total: answer.apps === undefined ? 1 : 2,
            jobs: [
              { id: 1, name: "deploy", status: "in_progress", conclusion: null },
              ...(answer.apps === undefined ? [] : [{ id: 2, name: "apps", ...answer.apps }]),
            ],
          };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        total_count: listed?.total ?? 0,
        jobs: (listed?.jobs ?? []).map((job) => ({ run_attempt: served || 1, ...job })),
      }),
    );
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void>((resume) => {
        for (const timer of timers) clearTimeout(timer);
        for (const socket of sockets) socket.destroy();
        server.close(() => resume(Effect.void));
      }),
  ).pipe(
    Effect.as({
      url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      requests: () => requests,
      /** When the first request came, in milliseconds since the epoch. */
      firstAt: () => times[0] ?? Number.NaN,
      /** Seconds between each request and the one before it. */
      gaps: () => times.slice(1).map((at, index) => (at - times[index]!) / 1000),
    }),
  );
};

/** Short limits for the cases about time: the whole wait, one request, and the pause between. */
type Limits = { readonly limit: number; readonly attempt: number; readonly poll: number };

/** `attempt` is what `GITHUB_RUN_ATTEMPT` is set to; `null` (or an empty value) leaves it unset. */
const wait = (api: string, limits?: Limits, attempt: number | string | null = 1) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["scripts/releases/apps-job.ts"], {
        env: {
          GITHUB_API_URL: api,
          GITHUB_REPOSITORY: repository,
          GITHUB_RUN_ID: run,
          GITHUB_RUN_ATTEMPT: attempt === null ? "" : String(attempt),
          GH_TOKEN: "synthetic-token",
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
    return { exitCode, log, seconds: (Date.now() - started) / 1000, endedAt: Date.now() };
  }).pipe(Effect.scoped);

/**
 * Seconds from the stand-in's first request to the waiter's exit: how long the wait itself took,
 * leaving out Node's start-up, which a busy machine can stretch.
 */
const waited = (result: { readonly endedAt: number }, api: { readonly firstAt: () => number }) =>
  (result.endedAt - api.firstAt()) / 1000;

const inProgress = { apps: { status: "in_progress", conclusion: null } };
const succeeded = { apps: { status: "completed", conclusion: "success" } };
/** Short polls inside a 20-second wait, for cases not about time: a request gets 5 s. */
const quick: Limits = { limit: 20, attempt: 5, poll: 0.5 };
/** The same with a one-second request limit, for the cases about a stalled or slow answer. */
const stalling: Limits = { limit: 20, attempt: 1, poll: 0.5 };

layer(NodeServices.layer)("deploy waits for the apps job", (it) => {
  it.effect("an apps job that succeeds after a while lets the deploy continue", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([inProgress, succeeded]);
      const result = yield* wait(api.url());
      expect(result.exitCode, result.log).toBe(0);
      expect(result.log).toContain("Waiting for the apps job: the apps job is in_progress");
      expect(result.log).toContain("The apps job succeeded");
      expect(api.requests()).toEqual([
        { path, authorization: "Bearer synthetic-token" },
        { path, authorization: "Bearer synthetic-token" },
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

  it.effect("an answer whose headers never come costs one attempt, then the wait goes on", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([{ stall: "headers" }, succeeded]);
      const result = yield* wait(api.url(), stalling);
      expect(result.exitCode, result.log).toBe(0);
      expect(result.log).toContain(
        "Waiting for the apps job: the jobs API did not answer within 1 s",
      );
      // One slow answer on a busy machine can cost one more request.
      expect(api.requests().length).toBeGreaterThanOrEqual(2);
      expect(result.seconds).toBeLessThan(10);
    }).pipe(Effect.scoped),
  );

  for (const status of [200, 502])
    it.effect(
      `a ${status} answer whose body never ends costs one attempt, then the wait goes on`,
      () =>
        Effect.gen(function* () {
          const api = yield* jobsApi([{ stall: "body", status }, succeeded]);
          const result = yield* wait(api.url(), stalling);
          expect(result.exitCode, result.log).toBe(0);
          expect(result.log).toContain(
            "Waiting for the apps job: the jobs API did not answer within 1 s",
          );
          // One slow answer on a busy machine can cost one more request.
          expect(api.requests().length).toBeGreaterThanOrEqual(2);
          expect(result.seconds).toBeLessThan(10);
        }).pipe(Effect.scoped),
    );

  it.effect("an apps job still running at the deadline stops the deploy then, not later", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([inProgress]);
      const result = yield* wait(api.url(), { limit: 2, attempt: 5, poll: 0.5 });
      expect(result.exitCode).toBe(1);
      expect(result.log).toContain("The apps job did not finish within");
      expect(result.log).toContain("(the apps job is in_progress); not deploying.");
      // From the first request: the deadline counts from the waiter's start, not Node's.
      expect(waited(result, api)).toBeLessThan(4);
      // A watchdog on the whole process.
      expect(result.seconds).toBeLessThan(30);
    }).pipe(Effect.scoped),
  );

  it.effect("an apps job that never appears stops the deploy at the deadline", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([{}]);
      const result = yield* wait(api.url(), { limit: 2, attempt: 5, poll: 0.5 });
      expect(result.exitCode).toBe(1);
      expect(result.log).toContain(`(run ${run} lists no apps job yet); not deploying.`);
      // From the first request: the deadline counts from the waiter's start, not Node's.
      expect(waited(result, api)).toBeLessThan(4);
      // A watchdog on the whole process.
      expect(result.seconds).toBeLessThan(30);
    }).pipe(Effect.scoped),
  );

  it.effect("an apps job listed on the second page is found there", () =>
    Effect.gen(function* () {
      const others = Array.from({ length: 100 }, (_, index) => ({
        id: index + 10,
        name: `job ${index}`,
        status: "in_progress",
        conclusion: null,
      }));
      const api = yield* jobsApi([
        {
          pages: [
            { total: 101, jobs: others },
            {
              total: 101,
              jobs: [{ id: 1, name: "apps", status: "completed", conclusion: "success" }],
            },
          ],
        },
      ]);
      const result = yield* wait(api.url(), quick);
      expect(result.exitCode, result.log).toBe(0);
      expect(api.requests().map((request) => request.path)).toEqual([path, `${path}&page=2`]);
    }).pipe(Effect.scoped),
  );

  /** A first page of 100 jobs, and second pages that do not agree with it. */
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: index + 10,
    name: `job ${index}`,
    status: "in_progress",
    conclusion: null,
  }));
  const appsDone = { id: 1, name: "apps", status: "completed", conclusion: "success" };
  const changing: ReadonlyArray<Answer> = [
    // A job started while the list was read: the second page counts one more.
    {
      pages: [
        { total: 101, jobs: firstPage },
        {
          total: 102,
          jobs: [appsDone, { id: 2, name: "late", status: "queued", conclusion: null }],
        },
      ],
    },
    // The first page's last job moved to the second.
    {
      pages: [
        { total: 101, jobs: firstPage },
        { total: 101, jobs: [firstPage[99]!] },
      ],
    },
  ];

  it.effect("a job list that changes between its pages is read again at the next poll", () =>
    Effect.gen(function* () {
      for (const changed of changing) {
        const api = yield* jobsApi([changed, succeeded]);
        const result = yield* wait(api.url(), quick);
        expect(result.exitCode, result.log).toBe(0);
        expect(result.log).toContain(
          `Waiting for the apps job: run ${run}'s job list changed while it was read`,
        );
        expect(result.log).toContain("The apps job succeeded");
      }
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a job list that changes on every poll stops the deploy at the deadline, saying so",
    () =>
      Effect.gen(function* () {
        const api = yield* jobsApi([changing[0]!]);
        const result = yield* wait(api.url(), { limit: 3, attempt: 5, poll: 0.5 });
        expect(result.exitCode).toBe(1);
        expect(result.log).toContain(
          `(run ${run}'s job list changed while it was read); not deploying.`,
        );
        // From the first request: the deadline counts from the waiter's start, not Node's.
        expect(waited(result, api)).toBeLessThan(5);
        // A watchdog on the whole process.
        expect(result.seconds).toBeLessThan(30);
      }).pipe(Effect.scoped),
  );

  const duplicate: Answer = {
    pages: [
      {
        total: 2,
        jobs: [
          { id: 1, name: "apps", status: "completed", conclusion: "success" },
          { id: 2, name: "apps", status: "in_progress", conclusion: null },
        ],
      },
    ],
  };

  it.effect("two jobs named apps on one read, gone on the next, are not yet an answer", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([duplicate, succeeded]);
      const result = yield* wait(api.url(), quick);
      expect(result.exitCode, result.log).toBe(0);
      expect(result.log).toContain(`Waiting for the apps job: run ${run} lists 2 jobs named apps`);
      expect(api.requests()).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("a duplicate that clears between reads does not count against a later one", () =>
    Effect.gen(function* () {
      // Duplicate, one queued apps, duplicate again, then one successful apps: no two duplicates in
      // a row, so the wait goes on to the success.
      const api = yield* jobsApi([
        duplicate,
        { apps: { status: "queued", conclusion: null } },
        duplicate,
        succeeded,
      ]);
      const result = yield* wait(api.url(), quick);
      expect(result.exitCode, result.log).toBe(0);
      expect(api.requests()).toHaveLength(4);
    }).pipe(Effect.scoped),
  );

  it.effect("two jobs named apps on two reads in a row stop the deploy, naming them", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([duplicate]);
      const result = yield* wait(api.url(), quick);
      expect(result.exitCode).toBe(1);
      expect(result.log).toContain(
        `Run ${run} lists 2 jobs named apps in attempt 1 on two reads in a row; cannot tell which to wait for.`,
      );
      expect(api.requests()).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("a changing list between two duplicates does not clear them", () =>
    Effect.gen(function* () {
      // Duplicate, a list that changes while it is read, duplicate again: the changing read is not
      // a consistent one, so the two duplicates are on consecutive consistent reads.
      const api = yield* jobsApi([duplicate, changing[0]!, duplicate]);
      const result = yield* wait(api.url(), quick);
      expect(result.exitCode, result.log).toBe(1);
      expect(result.log).toContain(
        `Run ${run} lists 2 jobs named apps in attempt 1 on two reads in a row; cannot tell which to wait for.`,
      );
      // It fails on the second duplicate: one request, two for the changing list's pages, one.
      expect(api.requests()).toHaveLength(4);
    }).pipe(Effect.scoped),
  );

  it.effect("after re-run failed jobs, the apps job this attempt kept lets the deploy go on", () =>
    Effect.gen(function* () {
      // Run 43303911566's attempt 2 listed the apps job attempt 1 ran as a new record: a new id,
      // this attempt's number, and attempt 1's start and end times.
      const kept: Answer = {
        pages: [
          {
            total: 2,
            jobs: [
              {
                id: 131485573071,
                name: "deploy",
                run_attempt: 2,
                status: "in_progress",
                conclusion: null,
              },
              {
                id: 131485577515,
                name: "apps",
                run_attempt: 2,
                status: "completed",
                conclusion: "success",
                started_at: "2026-11-12T20:49:51Z",
                completed_at: "2026-11-12T20:50:28Z",
              },
            ],
          },
        ],
      };
      const api = yield* jobsApi([kept], { attempt: 2 });
      const result = yield* wait(api.url(), quick, 2);
      expect(result.exitCode, result.log).toBe(0);
      expect(api.requests().map((request) => request.path)).toEqual([
        `/repos/${repository}/actions/runs/${run}/attempts/2/jobs?per_page=100`,
      ]);
    }).pipe(Effect.scoped),
  );

  for (const [ending, exitCode] of [
    ["success", 0],
    ["failure", 1],
  ] as const)
    it.effect(
      `after re-run all jobs, the deploy follows the new apps job to ${ending}, not the earlier success`,
      () =>
        Effect.gen(function* () {
          // Attempt 1's record, as `filter=latest` would also show it, beside attempt 2's own.
          const earlier = { ...appsDone, run_attempt: 1 };
          const listing = (state: State): Answer => ({
            pages: [
              { total: 2, jobs: [earlier, { id: 3, name: "apps", run_attempt: 2, ...state }] },
            ],
          });
          const api = yield* jobsApi(
            [
              listing({ status: "queued", conclusion: null }),
              listing({ status: "completed", conclusion: ending }),
            ],
            { attempt: 2, other: { pages: [{ total: 1, jobs: [earlier] }] } },
          );
          const result = yield* wait(api.url(), quick, 2);
          expect(result.exitCode, result.log).toBe(exitCode);
          expect(result.log).toContain("Waiting for the apps job: the apps job is queued");
          if (exitCode === 1) expect(result.log).toContain("The apps job ended failure");
          expect(api.requests()).toHaveLength(2);
          for (const request of api.requests()) expect(request.path).toContain("/attempts/2/jobs");
        }).pipe(Effect.scoped),
    );

  it.effect("an earlier attempt's successful apps job alone never lets the deploy go on", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi(
        [{ pages: [{ total: 1, jobs: [{ ...appsDone, run_attempt: 1 }] }] }],
        { attempt: 2 },
      );
      const result = yield* wait(api.url(), { limit: 3, attempt: 5, poll: 0.5 }, 2);
      expect(result.exitCode).toBe(1);
      expect(result.log).toContain(
        `(run ${run} lists a job named apps from attempt 1, but none from this attempt, 2); not deploying.`,
      );
    }).pipe(Effect.scoped),
  );

  for (const status of [200, 502])
    it.effect(
      `a ${status} answer whose headers and body together take longer than one attempt is cut off`,
      () =>
        Effect.gen(function* () {
          // Each half alone fits in the one-second attempt; the whole answer does not.
          const body = JSON.stringify({
            total_count: 1,
            jobs: [
              { id: 2, name: "apps", run_attempt: 1, status: "completed", conclusion: "success" },
            ],
          });
          const api = yield* jobsApi([
            { slow: { headersMs: 650, bodyMs: 650, status, body } },
            succeeded,
          ]);
          const result = yield* wait(api.url(), stalling);
          expect(result.exitCode, result.log).toBe(0);
          expect(result.log).toContain(
            "Waiting for the apps job: the jobs API did not answer within 1 s",
          );
          // One slow answer on a busy machine can cost one more request.
          expect(api.requests().length).toBeGreaterThanOrEqual(2);
        }).pipe(Effect.scoped),
    );

  /** A two-second wait: long enough for a few polls, short enough for many cases. */
  const brief: Limits = { limit: 2, attempt: 5, poll: 0.5 };
  const appsJob = {
    id: 2,
    name: "apps",
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
  };
  const without = (field: string) =>
    Object.fromEntries(Object.entries(appsJob).filter(([key]) => key !== field));

  for (const [label, raw] of [
    ["malformed JSON", "{broken"],
    ["a missing total_count", JSON.stringify({ jobs: [appsJob] })],
    ...["id", "name", "status", "conclusion", "run_attempt"].map(
      (field) =>
        [
          `a job without ${field}`,
          JSON.stringify({ total_count: 1, jobs: [without(field)] }),
        ] as const,
    ),
  ] as const)
    it.effect(
      `an answer with ${label} is never success, and stops the deploy at the deadline`,
      () =>
        Effect.gen(function* () {
          const api = yield* jobsApi([{ raw }]);
          const result = yield* wait(api.url(), brief);
          expect(result.exitCode, result.log).toBe(1);
          expect(result.log).toContain("(the jobs API answered unreadably); not deploying.");
        }).pipe(Effect.scoped),
    );

  it.effect("a job whose name only resembles apps is not the apps job", () =>
    Effect.gen(function* () {
      for (const name of ["apps (x)", "Apps", " apps", "apps "]) {
        const api = yield* jobsApi([{ pages: [{ total: 1, jobs: [{ ...appsJob, name }] }] }]);
        const result = yield* wait(api.url(), brief);
        expect(result.exitCode, `${name}: ${result.log}`).toBe(1);
        expect(result.log, name).toContain(`(run ${run} lists no apps job yet); not deploying.`);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("a success conclusion on a job that has not completed is not yet an answer", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([{ apps: { status: "in_progress", conclusion: "success" } }]);
      const result = yield* wait(api.url(), brief);
      expect(result.exitCode, result.log).toBe(1);
      expect(result.log).toContain("(the apps job is in_progress); not deploying.");
    }).pipe(Effect.scoped),
  );

  for (const [conclusion, said] of [
    [null, "without a conclusion"],
    ["neutral", "neutral"],
  ] as const)
    it.effect(`a completed apps job with conclusion ${conclusion} stops the deploy at once`, () =>
      Effect.gen(function* () {
        const api = yield* jobsApi([{ apps: { status: "completed", conclusion } }]);
        const result = yield* wait(api.url(), quick);
        expect(result.exitCode).toBe(1);
        expect(result.log).toContain(
          `The apps job ended ${said}, so npm may not serve this build's apps release; not deploying.`,
        );
        expect(api.requests()).toHaveLength(1);
      }).pipe(Effect.scoped),
    );

  it.effect("a missing or invalid attempt stops the deploy before it asks GitHub", () =>
    Effect.gen(function* () {
      const notSet = "GITHUB_RUN_ATTEMPT is not set: this must run in a GitHub Actions step";
      const invalid = (value: string) =>
        `GITHUB_RUN_ATTEMPT must be a positive safe integer, not ${JSON.stringify(value)}`;
      for (const [attempt, said] of [
        [null, notSet],
        // An empty value counts as unset.
        ["", notSet],
        ["0", invalid("0")],
        ["1.5", invalid("1.5")],
        ["two", invalid("two")],
        // Past 2^53: it would be asked for as 9007199254740992.
        ["9007199254740993", invalid("9007199254740993")],
        // Converts to Infinity.
        ["9".repeat(400), invalid("9".repeat(400))],
      ] as const) {
        const api = yield* jobsApi([succeeded]);
        const result = yield* wait(api.url(), quick, attempt);
        expect(result.exitCode, `${attempt}: ${result.log}`).toBe(1);
        expect(result.log).toContain(said);
        expect(api.requests()).toHaveLength(0);
      }
    }).pipe(Effect.scoped),
  );

  const rateLimited = (headers: Record<string, string>): Answer => ({
    raw: JSON.stringify({ message: "API rate limit exceeded for installation ID 4242." }),
    status: 429,
    headers,
  });

  it.effect("a rate limit is waited out for as long as retry-after asks, naming it", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([rateLimited({ "retry-after": "2" }), succeeded]);
      const result = yield* wait(api.url(), quick);
      expect(result.exitCode, result.log).toBe(0);
      expect(result.log).toContain(
        "Waiting for the apps job: the jobs API answered 429: API rate limit exceeded for installation ID 4242.",
      );
      expect(api.requests()).toHaveLength(2);
      expect(api.gaps()[0]).toBeGreaterThanOrEqual(1.9);
    }).pipe(Effect.scoped),
  );

  it.effect("a retry-after shorter than the usual spacing does not shorten it", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([rateLimited({ "retry-after": "0" }), succeeded]);
      const result = yield* wait(api.url(), { limit: 20, attempt: 5, poll: 2 });
      expect(result.exitCode, result.log).toBe(0);
      expect(api.gaps()[0]).toBeGreaterThanOrEqual(1.9);
    }).pipe(Effect.scoped),
  );

  it.effect("a retry-after past the deadline ends the wait at the deadline, naming it", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([rateLimited({ "retry-after": "60" })]);
      const result = yield* wait(api.url(), { limit: 3, attempt: 5, poll: 0.5 });
      expect(result.exitCode).toBe(1);
      expect(result.log).toContain(
        "(the jobs API answered 429: API rate limit exceeded for installation ID 4242.); not deploying.",
      );
      // From the first request: the deadline counts from the waiter's start, not Node's.
      expect(waited(result, api)).toBeLessThan(5);
      // A watchdog on the whole process.
      expect(result.seconds).toBeLessThan(30);
    }).pipe(Effect.scoped),
  );

  it.effect("a permission the token lacks is named, and stops the deploy at the deadline", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([
        {
          raw: JSON.stringify({ message: "Resource not accessible by integration" }),
          status: 403,
        },
      ]);
      const result = yield* wait(api.url(), { limit: 2, attempt: 5, poll: 0.5 });
      expect(result.exitCode).toBe(1);
      expect(result.log).toContain(
        "(the jobs API answered 403: Resource not accessible by integration); not deploying.",
      );
    }).pipe(Effect.scoped),
  );

  // Answers that say nothing about the apps job: each is waited out and stops the deploy at the
  // deadline, never taken as success.
  for (const [ending, answer, reason] of [
    ["a 404", { status: 404 }, "the jobs API answered 404"],
    ["a 401", { status: 401 }, "the jobs API answered 401"],
    ["a 200 with an empty body", { raw: "" }, "the jobs API answered unreadably"],
  ] as const)
    it.effect(`${ending} on every read stops the deploy at the deadline`, () =>
      Effect.gen(function* () {
        const api = yield* jobsApi([answer]);
        const result = yield* wait(api.url(), { limit: 2, attempt: 5, poll: 0.5 });
        expect(result.exitCode, result.log).toBe(1);
        expect(result.log).toContain(`(${reason}); not deploying.`);
        expect(result.log).not.toContain("The apps job succeeded");
        expect(api.requests().length).toBeGreaterThanOrEqual(2);
        // A watchdog on the whole process.
        expect(result.seconds).toBeLessThan(30);
      }).pipe(Effect.scoped),
    );

  it.effect("the lateness message names the limit in force, not the default", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([inProgress]);
      const result = yield* wait(api.url(), { limit: 2, attempt: 5, poll: 0.5 });
      expect(result.exitCode).toBe(1);
      expect(result.log).toContain(
        "The apps job did not finish within 2 s (the apps job is in_progress); not deploying.",
      );
      expect(result.log).not.toContain("15 minutes");
    }).pipe(Effect.scoped),
  );

  it.effect("the deadline cuts off a request still waiting for its answer", () =>
    Effect.gen(function* () {
      // A 3 s wait whose one request may take 30 s and never gets an answer.
      const api = yield* jobsApi([{ stall: "headers" }]);
      const result = yield* wait(api.url(), { limit: 3, attempt: 30, poll: 0.5 });
      expect(result.exitCode).toBe(1);
      expect(result.log).toContain("The apps job did not finish within");
      // From the first request: the deadline counts from the waiter's start, not Node's.
      expect(waited(result, api)).toBeLessThan(5);
      // A watchdog on the whole process.
      expect(result.seconds).toBeLessThan(30);
      expect(api.requests()).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("a page that lists more jobs than its total is not an answer", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([
        {
          pages: [
            {
              total: 1,
              jobs: [
                { id: 1, name: "deploy", status: "in_progress", conclusion: null },
                { id: 2, name: "apps", status: "completed", conclusion: "success" },
              ],
            },
          ],
        },
      ]);
      const result = yield* wait(api.url(), { limit: 2, attempt: 5, poll: 0.5 });
      expect(result.exitCode, result.log).toBe(1);
      expect(result.log).toContain(
        `(run ${run}'s job list changed while it was read); not deploying.`,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a retry-after given as an HTTP-date is waited out until that time", () =>
    Effect.gen(function* () {
      const date = new Date(Date.now() + 5000).toUTCString();
      const api = yield* jobsApi([
        {
          raw: JSON.stringify({ message: "synthetic rate limit" }),
          status: 429,
          headers: { "retry-after": date },
        },
        succeeded,
      ]);
      const result = yield* wait(api.url(), { limit: 10, attempt: 5, poll: 0.2 });
      expect(result.exitCode, result.log).toBe(0);
      expect(api.requests()).toHaveLength(2);
      // The date has whole seconds, so the second request may come up to a second before `date`
      // was made; it must not come before the date itself.
      expect(api.firstAt() + api.gaps()[0]! * 1000).toBeGreaterThanOrEqual(Date.parse(date) - 100);
    }).pipe(Effect.scoped),
  );

  it.effect("a retry-after on a 403 is waited out as on a 429", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([
        {
          raw: JSON.stringify({ message: "synthetic secondary rate limit" }),
          status: 403,
          headers: { "retry-after": "2" },
        },
        succeeded,
      ]);
      const result = yield* wait(api.url(), { limit: 6, attempt: 5, poll: 0.2 });
      expect(result.exitCode, result.log).toBe(0);
      expect(api.gaps()[0]).toBeGreaterThanOrEqual(1.9);
    }).pipe(Effect.scoped),
  );

  it.effect("a retry-after too large for a 32-bit timer is still waited out, not cut short", () =>
    Effect.gen(function* () {
      // 2,147,484 s is just over 2^31 ms: a timer that took it as a 32-bit integer would wrap to
      // almost nothing and ask again at once.
      const api = yield* jobsApi([
        {
          raw: JSON.stringify({ message: "synthetic long rate limit" }),
          status: 429,
          headers: { "retry-after": "2147484" },
        },
        succeeded,
      ]);
      const result = yield* wait(api.url(), { limit: 2, attempt: 5, poll: 0.2 });
      expect(result.exitCode, result.log).toBe(1);
      expect(api.requests()).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  for (const value of ["-20000", "+2027"])
    it.effect(`a retry-after of ${value}, neither seconds nor an HTTP-date, is ignored`, () =>
      Effect.gen(function* () {
        // `Date.parse` reads both as years; the waiter must not sleep until then.
        const api = yield* jobsApi([
          {
            raw: JSON.stringify({ message: "synthetic rate limit" }),
            status: 429,
            headers: { "retry-after": value },
          },
          succeeded,
        ]);
        const result = yield* wait(api.url(), { limit: 10, attempt: 5, poll: 0.2 });
        expect(result.exitCode, result.log).toBe(0);
        expect(api.gaps()[0]).toBeLessThan(2);
      }).pipe(Effect.scoped),
    );

  it.effect("the API's message is named for any error status, not only 403 and 429", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([
        { raw: JSON.stringify({ message: "synthetic service outage" }), status: 502 },
        succeeded,
      ]);
      const result = yield* wait(api.url(), quick);
      expect(result.exitCode, result.log).toBe(0);
      expect(result.log).toContain(
        "Waiting for the apps job: the jobs API answered 502: synthetic service outage",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a second page with another total is refused even when the count adds up", () =>
    Effect.gen(function* () {
      // Page one: 100 jobs of 101. Page two: the 101st, but it says 102. Only the per-page total
      // check sees it; the final count agrees.
      const others = Array.from({ length: 100 }, (_, index) => ({
        id: index + 10,
        name: `other ${index}`,
        status: "completed",
        conclusion: "success",
      }));
      const api = yield* jobsApi([
        {
          pages: [
            { total: 101, jobs: others },
            {
              total: 102,
              jobs: [{ id: 1, name: "apps", status: "completed", conclusion: "success" }],
            },
          ],
        },
      ]);
      const result = yield* wait(api.url(), { limit: 2, attempt: 5, poll: 0.2 });
      expect(result.exitCode, result.log).toBe(1);
      expect(result.log).toContain(
        `(run ${run}'s job list changed while it was read); not deploying.`,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a limit that is not a positive number of seconds stops the deploy at once", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([succeeded]);
      const result = yield* wait(api.url(), { limit: 0, attempt: 1, poll: 1 });
      expect(result.exitCode).toBe(1);
      expect(result.log).toContain("JOB_WAIT_LIMIT_SECONDS must be a positive number of seconds");
      expect(api.requests()).toHaveLength(0);
    }).pipe(Effect.scoped),
  );
});
