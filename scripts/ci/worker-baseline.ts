import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Cause,
  Clock,
  Config,
  Console,
  Duration,
  Effect,
  FileSystem,
  Option,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  type Lower,
  type Observation,
  type RecordFields,
  type RunSeen,
  type UpperSeen,
  type Verdict,
  decisionLine,
  enforcing,
  fails,
  guarded,
  summarySentence,
  judge,
  next,
  parseRecord,
} from "../../e2e/ci-skip-check.ts";

class BaselineFailed extends Schema.TaggedError<BaselineFailed>()("BaselineFailed", {
  message: Schema.String,
}) {}

const ghRaw = (args: ReadonlyArray<string>, limit: Duration.Duration = Duration.minutes(2)) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(ChildProcess.make("gh", args));
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, exitCode: Number(exitCode) };
  }).pipe(
    Effect.scoped,
    Effect.timeout(limit),
    Effect.mapError((error) =>
      error._tag === "TimeoutError"
        ? new BaselineFailed({
            message: `gh ${args.join(" ")}: no answer within ${Duration.toSeconds(limit)} s`,
          })
        : new BaselineFailed({ message: `gh ${args.join(" ")}: ${String(error)}` }),
    ),
  );

const ghOnce = (args: ReadonlyArray<string>, limit?: Duration.Duration) =>
  Effect.gen(function* () {
    const { stdout, stderr, exitCode } = yield* ghRaw(args, limit);
    if (exitCode !== 0)
      return yield* new BaselineFailed({ message: `gh ${args.join(" ")}: ${stderr.trim()}` });
    return stdout.trim();
  });

const transient =
  /HTTP (5\d\d|429)|secondary rate limit|timed? ?out|timeout|connection (reset|refused)|ECONNRESET|unexpected EOF|TLS handshake|temporar/i;

const retries = 3;

const retried = <A, R>(read: Effect.Effect<A, BaselineFailed, R>) =>
  Effect.gen(function* () {
    const first = yield* Config.Number("WORKER_BASELINE_RETRY_SECONDS").pipe(
      Config.withDefault(1),
      Effect.orDie,
    );
    return yield* read.pipe(
      Effect.retry({
        while: (failure) => transient.test(failure.message),
        schedule: Schedule.exponential(Duration.millis(first * 1000)),
        times: retries,
      }),
    );
  });

const gh = (args: ReadonlyArray<string>, limit?: Duration.Duration) => retried(ghOnce(args, limit));

const conditional = {
  etags: new Map<string, { readonly etag: string; readonly body: string }>(),
  requests: 0,
  unchanged: 0,
};
const ghConditional = (path: string, limit: Duration.Duration) =>
  retried(
    Effect.gen(function* () {
      const cached = conditional.etags.get(path);
      const { stdout, stderr, exitCode } = yield* ghRaw(
        [
          "api",
          "-i",
          ...(cached === undefined ? [] : ["-H", `If-None-Match: ${cached.etag}`]),
          path,
        ],
        limit,
      );
      const split = stdout.search(/\r?\n\r?\n/);
      const head = split === -1 ? stdout : stdout.slice(0, split);
      const body = split === -1 ? "" : stdout.slice(split).trim();
      if (cached !== undefined && /^HTTP\/[\d.]+ 304/.test(head)) {
        conditional.unchanged += 1;
        return cached.body;
      }
      conditional.requests += 1;
      if (exitCode !== 0)
        return yield* new BaselineFailed({ message: `gh api ${path}: ${stderr.trim()}` });
      const etag = head.match(/^etag: *(.+?)\s*$/im)?.[1];
      if (etag !== undefined) conditional.etags.set(path, { etag, body });
      return body;
    }),
  );

const OpenPullRequests = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ baseRefName: Schema.String, isCrossRepository: Schema.Boolean })),
);

const bottoms = (repository: string, defaultBranch: string, base: string) =>
  Effect.gen(function* () {
    const ends = new Set<string>();
    const seen = new Set<string>();
    let frontier = [base];
    while (frontier.length > 0) {
      const next: Array<string> = [];
      for (const branch of frontier) {
        if (seen.has(branch)) continue;
        seen.add(branch);
        if (branch === defaultBranch) {
          ends.add(branch);
          continue;
        }
        const open = (yield* Schema.decodeUnknownEffect(OpenPullRequests)(
          yield* gh([
            "pr",
            "list",
            "--repo",
            repository,
            "--head",
            branch,
            "--state",
            "open",
            "--json",
            "baseRefName,isCrossRepository",
          ]),
        )).filter((pull) => !pull.isCrossRepository);
        if (open.length === 0) ends.add(branch);
        else next.push(...open.map((pull) => pull.baseRefName));
      }
      frontier = next;
    }
    return ends;
  });

const mergeBase = (repository: string, branch: string, head: string) =>
  gh([
    "api",
    `repos/${repository}/compare/${encodeURIComponent(branch)}...${head}`,
    "--jq",
    ".merge_base_commit.sha",
  ]);

const write = (lines: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const output = yield* Config.String("GITHUB_OUTPUT").pipe(Config.option);
    const text = Object.entries(lines)
      .map(([key, value]) => `${key}=${value}\n`)
      .join("");
    yield* Console.log(text.trim());
    if (Option.isSome(output)) yield* fs.writeFileString(output.value, text, { flag: "a" });
  });

const resolve = (forceMain: boolean) =>
  Effect.gen(function* () {
    const repository = yield* Config.String("GITHUB_REPOSITORY");
    const defaultBranch = yield* Config.String("DEFAULT_BRANCH");
    const baseRef = yield* Config.String("BASE_REF").pipe(Config.withDefault(""));
    const baseSha = yield* Config.String("BASE_SHA");
    const head = yield* Config.String("HEAD_SHA").pipe(Config.withDefault(""));
    const main = (note: string) =>
      baseRef === "" || baseRef === defaultBranch
        ? Effect.succeed({ branch: defaultBranch, commit: baseSha, note })
        : mergeBase(repository, defaultBranch, head).pipe(
            Effect.map((commit) => ({ branch: defaultBranch, commit, note })),
            Effect.catchTag("BaselineFailed", (failure) =>
              Effect.succeed({
                branch: defaultBranch,
                commit: "",
                note: `${note === "" ? "" : `${note}; `}the commit this applies to on ${defaultBranch} could not be read (${failure.message.split("\n")[0]}), so no change is shown`,
              }),
            ),
          );
    const chosen = yield* Effect.gen(function* () {
      if (forceMain || baseRef === "" || baseRef === defaultBranch) return yield* main("");
      const read = yield* bottoms(repository, defaultBranch, baseRef).pipe(Effect.option);
      if (Option.isNone(read))
        return yield* main(
          `the stack below ${baseRef} could not be read, so this compares with ${defaultBranch}`,
        );
      const ends = read.value;
      if (ends.has(defaultBranch) || ends.size !== 1) return yield* main("");
      const [branch] = [...ends];
      return yield* mergeBase(repository, branch!, head).pipe(
        Effect.map((commit) => ({ branch: branch!, commit, note: "" })),
        Effect.catchTag("BaselineFailed", (failure) =>
          main(
            `${branch} could not be read (${failure.message.split("\n")[0]}), so this compares with ${defaultBranch}`,
          ),
        ),
      );
    });
    if (chosen.commit !== "" && !/^[0-9a-f]{40}$/.test(chosen.commit))
      return yield* new BaselineFailed({
        message: `No baseline commit for ${chosen.branch}: ${JSON.stringify(chosen.commit)}`,
      });
    if (chosen.note !== "") yield* Console.log(`::notice title=Worker sizes::${chosen.note}.`);
    return chosen;
  });

const named = (chosen: { branch: string; commit: string; note: string }) => ({
  branch: chosen.branch,
  commit: chosen.commit,
  id: `${chosen.branch}@${chosen.commit === "" ? "unread" : chosen.commit}`,
  label: chosen.commit === "" ? chosen.branch : `${chosen.branch} at ${chosen.commit.slice(0, 9)}`,
  note: chosen.note,
});

const releaseSteps = 5;

const CommitInfo = Schema.fromJsonString(
  Schema.Struct({
    message: Schema.String,
    author: Schema.NullOr(Schema.String),
    parents: Schema.Array(Schema.String),
    files: Schema.Array(
      Schema.Struct({ name: Schema.String, patch: Schema.NullOr(Schema.String) }),
    ),
  }),
);

const commitInfo = (repository: string, sha: string) =>
  gh([
    "api",
    `repos/${repository}/commits/${sha}`,
    "--jq",
    "{message: .commit.message, author: .author.login, parents: [.parents[].sha], files: [.files[] | {name: .filename, patch}]}",
  ]).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(CommitInfo)),
    Effect.option,
    Effect.map(Option.getOrUndefined),
  );

const changedLines = (patch: string) => {
  const changed: Array<{ line: string; above: ReadonlyArray<string> }> = [];
  const kept: Array<string> = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) kept.length = 0;
    else if (line.startsWith("-") || line.startsWith("+")) changed.push({ line, above: [...kept] });
    else kept.push(line.slice(1));
  }
  return changed;
};

const versionLine = /^[-+]\s*"version": "[^"]+",?$/;
const onlyVersion = (patch: string | null, inside?: string) => {
  if (patch === null) return false;
  const changed = changedLines(patch);
  return (
    changed.length === 2 &&
    changed[0]!.line.startsWith("-") &&
    changed[1]!.line.startsWith("+") &&
    changed.every(({ line }) => versionLine.test(line)) &&
    (inside === undefined || changed[0]!.above.slice(-2).join("\n").trim().startsWith(inside))
  );
};

const releaseFiles: Record<string, (patch: string | null) => boolean> = {
  "apps/cli/CHANGELOG.md": () => true,
  "apps/cli/package.json": (patch) => onlyVersion(patch),
  "bun.lock": (patch) => onlyVersion(patch, '"apps/cli": {'),
};
const releaseCommit = (info: typeof CommitInfo.Type) =>
  info.author === "github-actions[bot]" &&
  /^Release \S+ \[skip ci\]/.test(info.message) &&
  info.files.length > 0 &&
  info.files.every(
    (file) => Object.hasOwn(releaseFiles, file.name) && releaseFiles[file.name]!(file.patch),
  );

const Artifacts = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ expired: Schema.Boolean, run: Schema.NullOr(Schema.Number) })),
);

const RunSource = Schema.fromJsonString(
  Schema.Struct({
    path: Schema.String,
    event: Schema.String,
    repository: Schema.NullOr(Schema.String),
  }),
);

const builtFrom = "baseline-commit.txt";

const fromMain = (
  directory: string,
  commit: string,
  name: string,
  title: string,
  what: string,
  builtFrom?: string,
) =>
  Effect.gen(function* () {
    const repository = yield* Config.String("GITHUB_REPOSITORY");
    const defaultBranch = yield* Config.String("DEFAULT_BRANCH");
    const fs = yield* FileSystem.FileSystem;
    const runAt = (sha: string) =>
      gh([
        "run",
        "list",
        "--repo",
        repository,
        "--workflow",
        "ci.yml",
        "--branch",
        defaultBranch,
        "--event",
        "push",
        "--commit",
        sha,
        "--json",
        "databaseId",
        "--jq",
        ".[0].databaseId // empty",
      ]).pipe(Effect.catchTag("BaselineFailed", () => Effect.succeed("")));
    const download = (run: string) =>
      gh(["run", "download", run, "--repo", repository, "--name", name, "--dir", directory]).pipe(
        Effect.as(true),
        Effect.catchTag("BaselineFailed", () => Effect.succeed(false)),
      );
    const fromCommit = (sha: string) =>
      Effect.gen(function* () {
        if (builtFrom === undefined) return true;
        const path = `${directory}/${builtFrom}`;
        const named = (yield* fs.exists(path)) ? (yield* fs.readFileString(path)).trim() : "";
        if (named === sha) return true;
        yield* fs.remove(directory, { recursive: true, force: true });
        yield* Console.log(
          `::notice title=${title}::The ${name} artifact of ${sha}'s run names ${named === "" ? "no commit" : named} as the one it was built from, so it is not used.`,
        );
        return false;
      }).pipe(Effect.catch(() => Effect.succeed(false)));
    const stepped: Array<string> = [];
    let at = commit;
    for (;;) {
      const run = yield* runAt(at);
      if (run !== "" && (yield* download(run))) {
        if (!(yield* fromCommit(at))) return { found: false, commit, stepped };
        if (stepped.length > 0)
          yield* Console.log(
            `::notice title=${title}::${defaultBranch}'s ${what} for ${commit} are those of ${at}, the nearest earlier commit with ${what}: ${stepped.length === 1 ? `${stepped[0]} is a release commit, which changes` : `${stepped.join(", ")} are release commits, which change`} no Worker.`,
          );
        return { found: true, commit: at, stepped };
      }
      const info = stepped.length < releaseSteps ? yield* commitInfo(repository, at) : undefined;
      if (info === undefined || !releaseCommit(info) || info.parents.length !== 1) break;
      stepped.push(at);
      at = info.parents[0]!;
    }
    return { found: false, commit, stepped };
  });

const fetch = (directory: string, branch: string, commit: string) =>
  Effect.gen(function* () {
    const repository = yield* Config.String("GITHUB_REPOSITORY");
    const defaultBranch = yield* Config.String("DEFAULT_BRANCH");
    const fs = yield* FileSystem.FileSystem;
    const download = (run: string, name: string) =>
      gh(["run", "download", run, "--repo", repository, "--name", name, "--dir", directory]).pipe(
        Effect.as(true),
        Effect.catchTag("BaselineFailed", () => Effect.succeed(false)),
      );
    if (branch === defaultBranch) {
      const found = yield* fromMain(directory, commit, "worker-uploads", "Worker sizes", "sizes");
      if (!found.found)
        yield* Console.log(
          `::notice title=Worker sizes::${defaultBranch}'s sizes for ${commit} are not available yet${found.stepped.length > 0 ? `, nor for the release commits before it (${found.stepped.join(", ")})` : ""}, so no change is shown.`,
        );
      return { found: found.found, build: false, commit: found.commit };
    }
    const name = `worker-uploads-at-${commit}`;
    const ownRun = (run: number) =>
      gh([
        "api",
        `repos/${repository}/actions/runs/${run}`,
        "--jq",
        "{path, event, repository: .head_repository.full_name}",
      ]).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(RunSource)),
        Effect.map(
          (source) =>
            source.path === ".github/workflows/ci.yml" &&
            source.event === "pull_request" &&
            source.repository === repository,
        ),
        Effect.catch(() => Effect.succeed(false)),
      );
    const fromCommit = Effect.gen(function* () {
      const path = `${directory}/${builtFrom}`;
      const built = (yield* fs.exists(path)) ? (yield* fs.readFileString(path)).trim() : "";
      if (built === commit) return true;
      yield* fs.remove(directory, { recursive: true, force: true });
      return false;
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    const recorded = yield* gh([
      "api",
      `repos/${repository}/actions/artifacts?name=${name}&per_page=20`,
      "--jq",
      "[.artifacts[] | {expired, run: .workflow_run.id}]",
    ]).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Artifacts)),
      Effect.catch(() => Effect.succeed([])),
    );
    for (const artifact of recorded)
      if (
        !artifact.expired &&
        artifact.run !== null &&
        (yield* ownRun(artifact.run)) &&
        (yield* download(String(artifact.run), name)) &&
        (yield* fromCommit)
      )
        return { found: true, build: false, commit };
    return { found: false, build: true, commit };
  });

const Pulls = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      number: Schema.Number,
      draft: Schema.Boolean,
      head: Schema.Struct({
        sha: Schema.String,
        repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
      }),
    }),
  ),
);

const HeadRuns = Schema.fromJsonString(
  Schema.Struct({
    workflow_runs: Schema.Array(
      Schema.Struct({
        id: Schema.Number,
        path: Schema.String,
        status: Schema.String,
        conclusion: Schema.NullOr(Schema.String),
        html_url: Schema.String,
        head_repository: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
      }),
    ),
  }),
);

const RunArtifacts = Schema.fromJsonString(
  Schema.Struct({
    total_count: Schema.Number,
    artifacts: Schema.Array(Schema.Struct({ id: Schema.Number, name: Schema.String })),
  }),
);

const RunJobs = Schema.fromJsonString(
  Schema.Struct({
    total_count: Schema.Number,
    jobs: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        status: Schema.String,
        conclusion: Schema.optional(Schema.NullOr(Schema.String)),
        steps: Schema.optional(
          Schema.Array(Schema.Struct({ name: Schema.String, status: Schema.String })),
        ),
      }),
    ),
  }),
);

const checkStep = "Check that the layer above was computed on this layer";

const containsLower = (
  lower: Lower,
  tested: string,
  limit: Duration.Duration,
  contained: Map<string, boolean>,
) =>
  Effect.gen(function* () {
    const known = contained.get(tested);
    if (known !== undefined) return known;
    const status = (yield* gh(
      [
        "api",
        `repos/${lower.repository}/compare/${lower.head}...${tested}?per_page=1`,
        "--jq",
        ".status",
      ],
      limit,
    )).trim();
    if (!["ahead", "identical", "behind", "diverged"].includes(status))
      return yield* new BaselineFailed({ message: `the compare answered ${status}` });
    const answer = status === "ahead" || status === "identical";
    contained.set(tested, answer);
    return answer;
  }).pipe(Effect.catchCause(() => Effect.succeed<boolean | undefined>(undefined)));

const look = (
  lower: Lower,
  scratch: string,
  records: Map<number, RecordFields>,
  limits: { readonly read: Duration.Duration; readonly look: Duration.Duration },
  contained: Map<string, boolean>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repository = lower.repository;
    const read = <S extends Schema.Top>(schema: S, path: string) =>
      Effect.flatMap(ghConditional(path, limits.read), (body) =>
        Schema.decodeUnknownEffect(schema)(body).pipe(
          Effect.mapError(
            (error) => new BaselineFailed({ message: `${path}: ${String(error).split("\n")[0]}` }),
          ),
        ),
      );
    const jobsOf = (run: number, names: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const jobs: Array<(typeof RunJobs.Type)["jobs"][number]> = [];
        for (let page = 1; ; page += 1) {
          const listed = yield* read(
            RunJobs,
            `repos/${repository}/actions/runs/${run}/jobs?per_page=100&page=${page}`,
          );
          jobs.push(...listed.jobs);
          if (
            names.every((name) => jobs.some((job) => job.name === name)) ||
            listed.jobs.length === 0 ||
            jobs.length >= listed.total_count
          )
            return jobs;
        }
      });
    const pulls = (yield* read(
      Pulls,
      `repos/${repository}/pulls?base=${encodeURIComponent(lower.ref)}&state=open&per_page=100`,
    )).filter((pull) => pull.head.repo?.full_name === repository);
    const uppers = yield* Effect.forEach(pulls, (pull) =>
      Effect.gen(function* () {
        const { workflow_runs: all } = yield* read(
          HeadRuns,
          `repos/${repository}/actions/runs?event=pull_request&head_sha=${pull.head.sha}&per_page=50`,
        );
        const ci = all
          .filter(
            (run) =>
              run.path === ".github/workflows/ci.yml" &&
              run.head_repository?.full_name === repository,
          )
          .toSorted((a, b) => b.id - a.id);
        const runs = ci.filter((run) => run.conclusion !== "cancelled");
        const seen: Array<RunSeen> = [];
        const cancelled = ci[0];
        if (runs.length === 0 && cancelled !== undefined)
          seen.push({
            id: cancelled.id,
            url: cancelled.html_url,
            selectDone: true,
            waitingAbove: false,
            cancelled: true,
          });
        for (const run of runs.slice(0, 10)) {
          const artifacts: Array<(typeof RunArtifacts.Type)["artifacts"][number]> = [];
          for (let page = 1; ; page += 1) {
            const listed = yield* read(
              RunArtifacts,
              `repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100&page=${page}`,
            );
            artifacts.push(...listed.artifacts);
            if (listed.artifacts.length === 0 || artifacts.length >= listed.total_count) break;
          }
          const newest = artifacts
            .filter((artifact) => artifact.name.startsWith(`ci-tested-pr${pull.number}-`))
            .toSorted((a, b) => b.id - a.id)[0];
          if (newest !== undefined && !records.has(newest.id)) {
            const directory = `${scratch}/${newest.id}`;
            yield* fs.remove(directory, { recursive: true, force: true });
            yield* gh(
              [
                "run",
                "download",
                String(run.id),
                "--repo",
                repository,
                "--name",
                newest.name,
                "--dir",
                directory,
              ],
              limits.read,
            );
            records.set(newest.id, parseRecord(yield* fs.readFileString(`${directory}/record`)));
          }
          const record = newest === undefined ? undefined : records.get(newest.id);
          if (record !== undefined) {
            const gates =
              lower.ready && !pull.draft && (record.gate === "full" || record.gate === "narrowed")
                ? yield* jobsOf(run.id, ["checks / check", "checks / e2e"]).pipe(
                    Effect.map((jobs) => {
                      const state = (name: string) => {
                        const job = jobs.find((candidate) => candidate.name === name);
                        if (job === undefined)
                          return run.status === "completed" ? "missing" : undefined;
                        return job.status === "completed"
                          ? (job.conclusion ?? "unknown")
                          : job.status;
                      };
                      return { check: state("checks / check"), e2e: state("checks / e2e") };
                    }),
                  )
                : undefined;
            seen.push({
              id: run.id,
              url: run.html_url,
              record,
              selectDone: true,
              waitingAbove: false,
              contains:
                record.tested === undefined || record.base === lower.head
                  ? undefined
                  : yield* containsLower(lower, record.tested, limits.read, contained),
              gates,
            });
            continue;
          }
          if (run.status === "completed") {
            seen.push({ id: run.id, url: run.html_url, selectDone: true, waitingAbove: false });
            continue;
          }
          const select = (yield* jobsOf(run.id, ["checks / select"])).find(
            (job) => job.name === "checks / select",
          );
          seen.push({
            id: run.id,
            url: run.html_url,
            selectDone: select?.status === "completed",
            waitingAbove:
              select?.steps?.some(
                (step) => step.name === checkStep && step.status === "in_progress",
              ) ?? false,
          });
        }
        return {
          pull: pull.number,
          head: pull.head.sha,
          draft: pull.draft,
          runs: seen,
        } satisfies UpperSeen;
      }),
    );
    return { _tag: "Read", uppers } as Observation;
  }).pipe(
    Effect.timeoutOrElse({
      duration: limits.look,
      orElse: () =>
        Effect.fail(
          new BaselineFailed({
            message: `the look got no answer within ${Duration.toSeconds(limits.look)} s`,
          }),
        ),
    }),
    Effect.catchCause((cause) =>
      Effect.succeed({
        _tag: "Unread",
        why: String(Cause.squash(cause)).split("\n")[0]!,
      } as Observation),
    ),
  );

const readLower = Effect.gen(function* () {
  return {
    repository: yield* Config.String("GITHUB_REPOSITORY"),
    ref: yield* Config.String("HEAD_REF"),
    head: yield* Config.String("HEAD_SHA"),
    bottom: yield* Config.String("BASELINE_BRANCH"),
    runId: yield* Config.String("GITHUB_RUN_ID").pipe(Config.withDefault("<run-id>")),
    ready: (yield* Config.String("LOWER_DRAFT").pipe(Config.withDefault(""))) !== "true",
  } satisfies Lower;
});

const decide = (lower: Lower) =>
  Effect.gen(function* () {
    const scratch = `${yield* Config.String("RUNNER_TEMP").pipe(Config.withDefault("/tmp"))}/ci-above`;
    const scale = yield* Config.Number("SKIP_ABOVE_TIME_SCALE").pipe(Config.withDefault(1));
    const limits = {
      read: Duration.millis(Math.max(1000, 20_000 * scale)),
      look: Duration.millis(Math.max(2000, 60_000 * scale)),
    };
    const records = new Map<number, RecordFields>();
    const contained = new Map<string, boolean>();
    const start = yield* Clock.currentTimeMillis;
    let previous: Verdict | undefined;
    let waited = 0;
    for (let polls = 0; ; polls += 1) {
      const verdict = judge(
        yield* look(lower, scratch, records, limits, contained),
        lower,
        previous,
      );
      if (
        verdict._tag === "Wait" &&
        verdict.why !== (previous?._tag === "Wait" ? previous.why : "")
      )
        yield* Console.log(`Waiting: ${verdict.why}.`);
      previous = verdict;
      const elapsed = scale === 1 ? ((yield* Clock.currentTimeMillis) - start) / 1000 : waited;
      const step = next(verdict, lower, elapsed, polls);
      if (step._tag === "Done") return step.decision;
      waited += step.after;
      yield* Effect.sleep(Duration.millis(step.after * 1000 * scale));
    }
  });

const above = Effect.gen(function* () {
  const enforce = enforcing({
    ready: (yield* Config.String("LOWER_DRAFT").pipe(Config.withDefault(""))) !== "true",
  });
  const outcome = yield* guarded(Effect.flatMap(readLower, decide), enforce);
  yield* Console.log(decisionLine(outcome, enforce));
  const report = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const summary = yield* Config.String("GITHUB_STEP_SUMMARY").pipe(Config.option);
    if (Option.isSome(summary))
      yield* fs.writeFileString(summary.value, `${summarySentence(outcome, enforce)}\n`, {
        flag: "a",
      });
    if (outcome._tag === "Decided" && outcome.decision.oldFormat)
      yield* Console.log(`::notice title=Skip check::${outcome.decision.message}`);
    yield* write({ decision: outcome._tag === "Error" ? "error" : outcome.decision.decision });
    const limit = yield* gh(
      [
        "api",
        "rate_limit",
        "--jq",
        '.resources | "core \\(.core.used) used of \\(.core.limit), \\(.core.remaining) left; graphql \\(.graphql.used) used of \\(.graphql.limit)"',
      ],
      Duration.seconds(20),
    ).pipe(Effect.catch(() => Effect.succeed("unread")));
    yield* Console.log(
      `GitHub API: this check made ${conditional.requests} counted requests and ${conditional.unchanged} unchanged (free) ones; the token's rate limit: ${limit}.`,
    );
  });
  yield* enforce
    ? report
    : report.pipe(
        Effect.catchCause((cause) =>
          Console.log(
            `The skip check's report could not be written (${String(Cause.squash(cause)).split("\n")[0]}); it passes while observing.`,
          ),
        ),
      );
  if (fails(outcome, enforce))
    return yield* new BaselineFailed({
      message: outcome._tag === "Error" ? outcome.why : outcome.decision.message,
    });
});

const MergedPulls = Schema.fromJsonString(Schema.Array(Schema.Number));

const merged = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repository = yield* Config.String("GITHUB_REPOSITORY");
    const before = yield* Config.String("BEFORE_SHA");
    const head = yield* Config.String("HEAD_SHA");
    const read = Effect.gen(function* () {
      const commits = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Array(Schema.String)),
      )(
        yield* gh([
          "api",
          `repos/${repository}/compare/${before}...${head}`,
          "--jq",
          "[.commits[].sha]",
        ]),
      );
      const numbers = new Set<number>();
      const alone: Array<string> = [];
      for (const commit of commits) {
        const pulls = yield* Schema.decodeUnknownEffect(MergedPulls)(
          yield* gh([
            "api",
            `repos/${repository}/commits/${commit}/pulls`,
            "--jq",
            "[.[] | select(.merged_at != null) | .number]",
          ]),
        );
        if (pulls.length === 0) alone.push(commit.slice(0, 9));
        for (const pull of pulls) numbers.add(pull);
      }
      const bodies = yield* Effect.forEach(
        [...numbers].toSorted((a, b) => a - b),
        (number) =>
          gh(["api", `repos/${repository}/pulls/${number}`, "--jq", '.body // ""']).pipe(
            Effect.map((body) => ({ number, body })),
          ),
      );
      return { bodies, alone };
    });
    const found = yield* read.pipe(Effect.option);
    if (Option.isNone(found)) {
      yield* Console.log(
        `::notice title=Worker sizes::The pull requests this push merges could not be read, so its growth is reported and not checked against their allowances.`,
      );
      return yield* write({ read: "false" });
    }
    const { bodies, alone } = found.value;
    if (alone.length > 0)
      yield* Console.log(
        `::notice title=Worker sizes::${alone.join(", ")} ${alone.length === 1 ? "is a commit" : "are commits"} no pull request merged, so ${alone.length === 1 ? "it allows" : "they allow"} no growth.`,
      );
    yield* fs.writeFileString(file, JSON.stringify(bodies));
    return yield* write({
      read: "true",
      file,
      pulls: bodies.map((pull) => `#${pull.number}`).join(", "),
    });
  });

NodeRuntime.runMain(
  Effect.gen(function* () {
    const [command, ...args] = process.argv.slice(2);
    if (command === "resolve") return yield* write(named(yield* resolve(args.includes("--main"))));
    if (command === "fetch" && args[0] !== undefined) {
      const branch = yield* Config.String("BASELINE_BRANCH");
      const result = yield* fetch(args[0], branch, yield* Config.String("BASELINE_COMMIT"));
      return yield* write({
        found: String(result.found),
        build: String(result.build),
        label: `${branch} at ${result.commit.slice(0, 9)}`,
      });
    }
    if (command === "fallback" && args[0] !== undefined) {
      const chosen = yield* resolve(true);
      const result = yield* fetch(args[0], chosen.branch, chosen.commit);
      return yield* write({
        ...named(chosen),
        found: String(result.found),
        label: `${chosen.branch} at ${result.commit.slice(0, 9)}`,
      });
    }
    if (command === "above") return yield* above;
    if (command === "merged" && args[0] !== undefined) return yield* merged(args[0]);
    if (command === "fetch-build" && args[0] !== undefined) {
      const commit = yield* Config.String("BASE_SHA");
      const found = yield* fromMain(
        args[0],
        commit,
        "worker-build",
        "Worker start-up",
        "built Workers",
        "built-from.txt",
      );
      if (!found.found)
        yield* Console.log(
          `::notice title=Worker start-up::No build of ${commit}${found.stepped.length > 0 ? ` or the release commits before it` : ""} is recorded, so this push's start-up is recorded alone.`,
        );
      return yield* write({ found: String(found.found), commit: found.found ? found.commit : "" });
    }
    return yield* new BaselineFailed({
      message:
        "Usage: node scripts/ci/worker-baseline.ts resolve [--main] | fetch <directory> | fallback <directory> | above | merged <file> | fetch-build <directory>",
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);
