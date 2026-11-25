import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { strToU8, zipSync } from "fflate";

type State = { readonly status: string; readonly conclusion: string | null };

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
const started = "2026-11-24T10:00:00Z";
const ended = "2026-11-24T10:05:00Z";

const archive = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
const built = archive({ "executor-collector": "the collector\n", "lib/readme.txt": "beside it\n" });
const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

type Upload = {
  readonly id?: number;
  readonly created_at?: string;
  readonly size_in_bytes?: number;
  readonly expired?: boolean;
  readonly digest?: string | null;
};

type Listing = {
  readonly after?: number;
  readonly never?: true;
  readonly uploads?: ReadonlyArray<Upload>;
  readonly zip?: Uint8Array;
  readonly missingFirst?: number;
  readonly damagedFirst?: number;
  readonly redirect?: true;
};

const listen = (server: Server) =>
  Effect.acquireRelease(
    Effect.callback<string>((resume) => {
      server.listen(0, "127.0.0.1", () =>
        resume(Effect.succeed(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
      );
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );

const jobsApi = (answers: ReadonlyArray<Answer>, listing: Listing = {}) =>
  Effect.gen(function* () {
    const requests: Array<{ readonly path: string; readonly authorization: string | undefined }> =
      [];
    const artifactRequests: Array<string> = [];
    const downloads: Array<{ readonly path: string; readonly authorization: string | undefined }> =
      [];
    const zip = listing.zip ?? built;
    let listed = 0;
    const blob = createServer((request, response) => {
      downloads.push({ path: request.url ?? "", authorization: request.headers.authorization });
      response.writeHead(200, { "content-type": "application/zip" });
      response.end(zip);
    });
    const blobUrl = yield* listen(blob);
    const server = createServer((request, response) => {
      const address = new URL(request.url ?? "/", "http://stand-in");
      if (address.pathname.endsWith("/artifacts")) {
        artifactRequests.push(request.url ?? "");
        const name = address.searchParams.get("name") ?? "";
        const shown =
          listing.never !== true && artifactRequests.length > (listing.after ?? 0)
            ? (listing.uploads ?? [{}]).map((upload) => ({
                id: 77,
                name,
                size_in_bytes: zip.length,
                expired: false,
                digest: sha256(zip),
                created_at: "2026-11-24T10:04:59Z",
                ...upload,
              }))
            : [];
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ total_count: shown.length, artifacts: shown }));
        return;
      }
      if (/\/actions\/artifacts\/\d+\/zip$/u.test(address.pathname)) {
        downloads.push({ path: request.url ?? "", authorization: request.headers.authorization });
        const count = downloads.filter((download) => download.path.endsWith("/zip")).length;
        if (count <= (listing.missingFirst ?? 0)) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ message: "Not Found" }));
          return;
        }
        if (listing.redirect === true) {
          response.writeHead(302, { location: `${blobUrl}/blob/${count}?sig=signed` });
          response.end();
          return;
        }
        const body = Uint8Array.from(zip);
        if (count <= (listing.missingFirst ?? 0) + (listing.damagedFirst ?? 0))
          body[body.length - 1] = body[body.length - 1]! ^ 1;
        response.writeHead(200, { "content-type": "application/zip" });
        response.end(body);
        return;
      }
      requests.push({ path: request.url ?? "", authorization: request.headers.authorization });
      const page = Number(address.searchParams.get("page") ?? 1);
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
      const withIds = jobs.map((job, index) => ({
        id: index + 1,
        run_attempt: 1,
        started_at: started,
        completed_at: job.status === "completed" ? ended : null,
        ...job,
      }));
      response.end(
        JSON.stringify({
          total_count: withIds.length,
          jobs: withIds.slice((page - 1) * 100, page * 100),
        }),
      );
    });
    const url = yield* listen(server);
    return {
      url: () => url,
      requests: () => requests,
      artifactRequests: () => artifactRequests,
      downloads: () => downloads,
    };
  });

const unpacked = "packages/telemetry/dist/collector";

const wait = (
  api: string,
  target: string,
  attempt = 1,
  limits?: { readonly limit: number; readonly attempt: number; readonly poll: number },
  caller?: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "collector-job-" });
    const child = yield* processes.spawn(
      ChildProcess.make("node", [path.resolve("scripts/releases/collector-job.ts")], {
        cwd: directory,
        env: {
          GITHUB_API_URL: api,
          GITHUB_REPOSITORY: repository,
          GITHUB_RUN_ID: run,
          GH_TOKEN: "synthetic-token",
          TARGET: target,
          COLLECTOR_USE: "packaging",
          ...(caller === undefined ? {} : { CALLER: caller }),
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
    const begun = Date.now();
    const [log, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    const seconds = (Date.now() - begun) / 1000;
    const into = `${directory}/${unpacked}`;
    const files: Record<string, string> = {};
    if (yield* fs.exists(into))
      for (const file of yield* fs.readDirectory(into, { recursive: true }))
        if ((yield* fs.stat(`${into}/${file}`)).type === "File")
          files[file] = yield* fs.readFileString(`${into}/${file}`);
    return { exitCode, log, seconds, files };
  }).pipe(Effect.scoped);

const inProgress: State = { status: "in_progress", conclusion: null };
const succeeded: State = { status: "completed", conclusion: "success" };
const fetched = "The collector (linux-x64) job succeeded, and its build is fetched whole.";
const whole = { "executor-collector": "the collector\n", "lib/readme.txt": "beside it\n" };
const quick = { limit: 20, attempt: 5, poll: 0.2 };
const short = { limit: 2, attempt: 5, poll: 0.3 };

layer(NodeServices.layer)("packaging waits for its target's collector job", (it) => {
  it.effect("a collector job that succeeds after a while gives packaging its build, unpacked", () =>
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
      expect(result.log).toContain(fetched);
      expect(result.log).toContain(
        `Fetched artifact 77 (collector-linux-x64, ${built.length} bytes, SHA-256 as listed) into ${unpacked}: 2 files.`,
      );
      expect(result.files).toEqual(whole);
      expect(api.requests()).toHaveLength(2);
      expect(api.requests()[0]).toEqual({
        path: `/repos/${repository}/actions/runs/${run}/attempts/1/jobs?per_page=100`,
        authorization: "Bearer synthetic-token",
      });
      expect(api.artifactRequests()).toEqual([
        `/repos/${repository}/actions/runs/${run}/artifacts?name=collector-linux-x64&per_page=100`,
      ]);
      expect(api.downloads()).toEqual([
        {
          path: `/repos/${repository}/actions/artifacts/77/zip`,
          authorization: "Bearer synthetic-token",
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("a collector job that succeeded is not fetched until its build is listed", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([{ collectors: { "linux-x64": succeeded } }], { after: 2 });
      const result = yield* wait(api.url(), "linux-x64", 1, quick);
      expect(result.exitCode, result.log).toBe(0);
      expect(result.log).toContain(
        "Waiting for the collector (linux-x64) job: the collector (linux-x64) job succeeded, and run 4243 lists 0 usable artifacts named collector-linux-x64 uploaded since it started yet",
      );
      expect(result.log).toContain(fetched);
      expect(api.artifactRequests()).toHaveLength(3);
      expect(api.downloads()).toHaveLength(1);
      expect(result.files).toEqual(whole);
    }).pipe(Effect.scoped),
  );

  it.effect("a listed build the download cannot find yet is fetched once it can, not before", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([{ collectors: { "linux-x64": succeeded } }], {
        missingFirst: 2,
      });
      const result = yield* wait(api.url(), "linux-x64", 1, quick);
      expect(result.exitCode, result.log).toBe(0);
      expect(result.log).toContain(
        "Waiting for the collector (linux-x64) job: the artifact 77 download API answered 404: Not Found",
      );
      expect(api.downloads()).toHaveLength(3);
      expect(result.files).toEqual(whole);
    }).pipe(Effect.scoped),
  );

  it.effect("a download whose bytes do not match the listed SHA-256 is not unpacked", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([{ collectors: { "linux-x64": succeeded } }], {
        damagedFirst: 1,
      });
      const result = yield* wait(api.url(), "linux-x64", 1, quick);
      expect(result.exitCode, result.log).toBe(0);
      expect(result.log).toContain(
        `artifact 77 downloaded as ${built.length} bytes whose SHA-256 is not the one listed for its ${built.length} bytes`,
      );
      expect(api.downloads()).toHaveLength(2);
      expect(result.files).toEqual(whole);
    }).pipe(Effect.scoped),
  );

  it.effect("a download redirected to storage does not carry the token there", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([{ collectors: { "linux-x64": succeeded } }], {
        redirect: true,
      });
      const result = yield* wait(api.url(), "linux-x64", 1, quick);
      expect(result.exitCode, result.log).toBe(0);
      expect(api.downloads()).toEqual([
        {
          path: `/repos/${repository}/actions/artifacts/77/zip`,
          authorization: "Bearer synthetic-token",
        },
        { path: "/blob/1?sig=signed", authorization: undefined },
      ]);
      expect(result.files).toEqual(whole);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a build stamped after the job's recorded end, as the artifact service's clock may, is fetched",
    () =>
      Effect.gen(function* () {
        const api = yield* jobsApi([{ collectors: { "linux-x64": succeeded } }], {
          uploads: [{ created_at: "2026-11-24T10:05:03Z" }],
        });
        const result = yield* wait(api.url(), "linux-x64", 1, quick);
        expect(result.exitCode, result.log).toBe(0);
        expect(result.files).toEqual(whole);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "of two builds with the name, only the one uploaded since the job started is fetched",
    () =>
      Effect.gen(function* () {
        const api = yield* jobsApi([{ collectors: { "linux-x64": succeeded } }], {
          uploads: [{ id: 76, created_at: "2026-11-24T09:58:00Z" }, { id: 77 }],
        });
        const result = yield* wait(api.url(), "linux-x64", 1, quick);
        expect(result.exitCode, result.log).toBe(0);
        expect(api.downloads().map((download) => download.path)).toEqual([
          `/repos/${repository}/actions/artifacts/77/zip`,
        ]);
      }).pipe(Effect.scoped),
  );

  for (const [what, listing, count] of [
    ["never listed", { never: true }, 0],
    ["listed only expired", { uploads: [{ expired: true }] }, 0],
    ["listed only empty", { uploads: [{ size_in_bytes: 0 }] }, 0],
    ["listed without a digest", { uploads: [{ digest: null }] }, 0],
    [
      "listed only from before the job started",
      { uploads: [{ created_at: "2026-11-24T09:59:59Z" }] },
      0,
    ],
    ["listed twice since the job started", { uploads: [{ id: 77 }, { id: 78 }] }, 2],
  ] as const)
    it.effect(`a build ${what} stops packaging at the deadline, never fetching`, () =>
      Effect.gen(function* () {
        const api = yield* jobsApi([{ collectors: { "linux-x64": succeeded } }], listing);
        const result = yield* wait(api.url(), "linux-x64", 1, short);
        expect(result.exitCode, result.log).toBe(1);
        expect(result.log).toContain(
          `The collector (linux-x64) job did not finish within 2 s (the collector (linux-x64) job succeeded, and run 4243 lists ${count} usable artifacts named collector-linux-x64 uploaded since it started yet).`,
        );
        expect(result.log).not.toContain("fetched whole");
        expect(api.downloads()).toEqual([]);
        expect(result.files).toEqual({});
      }).pipe(Effect.scoped),
    );

  it.effect(
    "a download that stays missing stops packaging at the deadline, unpacking nothing",
    () =>
      Effect.gen(function* () {
        const api = yield* jobsApi([{ collectors: { "linux-x64": succeeded } }], {
          missingFirst: 1_000,
        });
        const result = yield* wait(api.url(), "linux-x64", 1, short);
        expect(result.exitCode, result.log).toBe(1);
        expect(result.log).toContain(
          "The collector (linux-x64) job did not finish within 2 s (the artifact 77 download API answered 404: Not Found).",
        );
        expect(result.files).toEqual({});
      }).pipe(Effect.scoped),
  );

  for (const [what, files] of [
    ["climbs out of its directory", { "../outside": "x" }],
    ["is an absolute path", { "/etc/outside": "x" }],
    ["holds a backslash", { "lib\\outside": "x" }],
  ] as const)
    it.effect(`a whole build with an entry that ${what} fails at once, writing nothing`, () =>
      Effect.gen(function* () {
        const zip = archive({ "executor-collector": "the collector\n", ...files });
        const api = yield* jobsApi([{ collectors: { "linux-x64": succeeded } }], { zip });
        const result = yield* wait(api.url(), "linux-x64", 1, quick);
        expect(result.exitCode, result.log).toBe(1);
        expect(result.log).toContain(
          `Artifact 77 (collector-linux-x64) matches its listed SHA-256 but is not a zip of plain relative paths, so it cannot be unpacked into ${unpacked}.`,
        );
        expect(api.downloads()).toHaveLength(1);
        expect(result.files).toEqual({});
        expect(result.seconds).toBeLessThan(10);
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
          `The collector (win32-x64) job ended ${conclusion}, so this job has no win32-x64 collector for its packaging; this failure follows from that one. Rerun the collector (win32-x64) job, then this one.`,
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

  it.effect("a called workflow's collector job is found under its caller's job name", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([
        {
          jobs: [
            { name: "checks / e2e-local (1/1)", ...inProgress },
            { name: "checks / collector (linux-x64)", ...inProgress },
          ],
        },
        { jobs: [{ name: "checks / collector (linux-x64)", ...succeeded }] },
      ]);
      const result = yield* wait(
        api.url(),
        "linux-x64",
        1,
        { limit: 10, attempt: 2, poll: 1 },
        "checks",
      );
      expect(result.exitCode, result.log).toBe(0);
      expect(api.requests()).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("a job named like the collector's under a caller and on its own stops packaging", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([
        {
          jobs: [
            { name: "collector (linux-x64)", ...succeeded },
            { name: "checks / collector (linux-x64)", ...succeeded },
          ],
        },
      ]);
      const result = yield* wait(api.url(), "linux-x64", 1, undefined, "checks");
      expect(result.exitCode).toBe(1);
      expect(result.log).toContain("cannot tell which to wait for");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "another caller's collector job is not this run's, nor one without a named caller",
    () =>
      Effect.gen(function* () {
        for (const caller of ["checks", undefined]) {
          const api = yield* jobsApi([
            { jobs: [{ name: "other-caller / collector (linux-x64)", ...succeeded }] },
          ]);
          const result = yield* wait(
            api.url(),
            "linux-x64",
            1,
            { limit: 2, attempt: 1, poll: 1 },
            caller,
          );
          expect(result.exitCode, String(caller)).toBe(1);
          expect(result.log).toContain("lists no collector (linux-x64) job yet");
        }
      }).pipe(Effect.scoped),
  );

  it.effect("a job whose name only ends like the collector's is not it", () =>
    Effect.gen(function* () {
      const api = yield* jobsApi([
        { jobs: [{ name: "checks /collector (linux-x64)", ...succeeded }] },
      ]);
      const result = yield* wait(api.url(), "linux-x64", 1, { limit: 2, attempt: 1, poll: 1 });
      expect(result.exitCode).toBe(1);
      expect(result.log).toContain("lists no collector (linux-x64) job yet");
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
        expect(result.log).not.toContain("fetched whole");
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
