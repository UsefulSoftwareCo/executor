/**
 * What a pull request's Worker sizes are compared with: the base of the bottom of its stack, at the
 * commit the pull request is built on.
 *
 *   node scripts/ci/worker-baseline.ts resolve [--main]      writes branch, commit, id, label, note
 *   node scripts/ci/worker-baseline.ts fetch <directory>      writes found and build
 *   node scripts/ci/worker-baseline.ts fallback <directory>   main's baseline and its sizes
 *   node scripts/ci/worker-baseline.ts above                  checks the layer above a `skip`
 *   node scripts/ci/worker-baseline.ts merged <file>          the pull requests a push merges
 *
 * The rule: nothing reaches main without having been compared with main. A pull request whose stack
 * ends on main (its base is main, or its base is the head of an open pull request whose stack ends on
 * main) is compared with main's sizes at the commit it applies to, as before. One whose stack ends on
 * another branch, such as a long-lived feature branch, is compared with that branch at its merge base
 * with the pull request, so it is charged for its own growth; the branch is charged for its total
 * once, against main, by its own pull request into main. The stack is read from GitHub the way the
 * E2E selection reads it: follow the base branch while it is the head of an open pull request in this
 * repository. A branch that cannot be read (deleted, or no merge base) falls back to main.
 *
 * `resolve` reads GITHUB_REPOSITORY, DEFAULT_BRANCH, BASE_REF and BASE_SHA (the pull request's base,
 * or for a push the commit before it) and HEAD_SHA, and writes to GITHUB_OUTPUT: `branch`, `commit`,
 * `id` (`<branch>@<commit>`, which the size gate's record holds, so a run compared with one baseline
 * is never reported for another) and `note` when it fell back to main. `--main` resolves main's
 * baseline whatever the stack ends on: the fallback when the branch's sizes cannot be had.
 *
 * `fetch` reads BASELINE_BRANCH and BASELINE_COMMIT and downloads the baseline's sizes into the
 * directory: for main, the `worker-uploads` artifact of main's CI run at that commit; for another
 * branch, the `worker-uploads-at-<commit>` artifact a pull request run recorded when it built that
 * commit's Workers. It writes `found` and, for another branch with nothing recorded, `build=true`:
 * the job then builds that commit's Workers itself, once per commit. Only sizes from a source this
 * repository's own code wrote are used: main's from main's push runs, a branch's from CI runs of
 * this repository's own branches, and only when the sizes name the commit they were built from.
 *
 * `above` checks a lower stack layer whose e2e block says `skip`: such a layer runs nothing, and
 * passes on the strength of the layer above, so that layer's run must have been computed with this
 * layer in its chain. It passes when an open pull request in this repository whose base is this
 * branch has a CI run on its current head whose record (the select job's `ci-tested-…` artifact)
 * says it was built on this layer's head, and compared its Worker sizes with the branch this
 * layer's stack ends on. The E2E selection always compares with main, whatever the chain, so the
 * base commit covers it. Otherwise it waits a few minutes, for a layer above whose run has not
 * recorded yet, and then fails, naming the pull request above and the commands that run it again.
 *
 * GitHub's API sometimes fails for a moment: each read is tried again a few times, and a stack that
 * still cannot be read is compared with main, with a notice.
 */
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
  enforce,
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

/** Runs `gh` once, for at most two minutes, and returns its exit code and what it printed. */
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
    // A stalled connection is no answer; it is not one of GitHub's brief failures, so not retried.
    Effect.timeout(limit),
    Effect.mapError((error) =>
      error._tag === "TimeoutError"
        ? new BaselineFailed({
            message: `gh ${args.join(" ")}: no answer within ${Duration.toSeconds(limit)} s`,
          })
        : new BaselineFailed({ message: `gh ${args.join(" ")}: ${String(error)}` }),
    ),
  );

/** Runs `gh` once and returns what it prints, or fails with what it said. */
const ghOnce = (args: ReadonlyArray<string>, limit?: Duration.Duration) =>
  Effect.gen(function* () {
    const { stdout, stderr, exitCode } = yield* ghRaw(args, limit);
    if (exitCode !== 0)
      return yield* new BaselineFailed({ message: `gh ${args.join(" ")}: ${stderr.trim()}` });
    return stdout.trim();
  });

/** What `gh` says when GitHub failed for a moment, rather than answered. */
const transient =
  /HTTP (5\d\d|429)|secondary rate limit|timed? ?out|timeout|connection (reset|refused)|ECONNRESET|unexpected EOF|TLS handshake|temporar/i;

/** How many times a read that failed for a moment is tried again: after one, two and four seconds. */
const retries = 3;

/** Tries `read` again after a failure that was GitHub's for a moment. */
const retried = <A, R>(read: Effect.Effect<A, BaselineFailed, R>) =>
  Effect.gen(function* () {
    // The first wait, in seconds; the spec shortens it.
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

/** Runs `gh`, again after a failure that was GitHub's for a moment, and returns what it prints. */
const gh = (args: ReadonlyArray<string>, limit?: Duration.Duration) => retried(ghOnce(args, limit));

/**
 * The REST reads the skip check repeats while it waits, made conditional on what each last
 * returned: GitHub answers 304 for one that has not changed, which does not count against the
 * token's rate limit. `requests` and `unchanged` count them for the step's log.
 */
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
      // gh exits 1 on a 304, with the status line on stdout.
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

/**
 * The branches a stack can end on, starting from `base`: follow each open pull request in this
 * repository whose head is the branch to its base, until a branch that is the head of none.
 */
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

/** The commit `head` and `branch` last shared, as GitHub's comparison names it. */
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
    /** Main's baseline: the base commit when the base is main or this is a push, else the merge base. */
    const main = (note: string) =>
      baseRef === "" || baseRef === defaultBranch
        ? Effect.succeed({ branch: defaultBranch, commit: baseSha, note })
        : mergeBase(repository, defaultBranch, head).pipe(
            Effect.map((commit) => ({ branch: defaultBranch, commit, note })),
            // No commit: no sizes are fetched, so no change is shown; the budgets still hold.
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
      // A stack that can end on main is compared with main.
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

/** The outputs that name a baseline. */
const named = (chosen: { branch: string; commit: string; note: string }) => ({
  branch: chosen.branch,
  commit: chosen.commit,
  id: `${chosen.branch}@${chosen.commit === "" ? "unread" : chosen.commit}`,
  label: chosen.commit === "" ? chosen.branch : `${chosen.branch} at ${chosen.commit.slice(0, 9)}`,
  note: chosen.note,
});

/** How many release commits `fetch` steps back over to find main's sizes: four betas a day. */
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

/** A commit's message, author, parents and changed files with their diffs, or none when unread. */
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

/** The lines a diff removes and adds, each with the lines above it in the file. */
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

/** A diff that changes one `"version"` line from one value to another and nothing else. */
const versionLine = /^[-+]\s*"version": "[^"]+",?$/;
const onlyVersion = (patch: string | null, inside?: string) => {
  if (patch === null) return false;
  const changed = changedLines(patch);
  return (
    changed.length === 2 &&
    changed[0]!.line.startsWith("-") &&
    changed[1]!.line.startsWith("+") &&
    changed.every(({ line }) => versionLine.test(line)) &&
    // In the lockfile, the version line of the CLI's own workspace entry, under its name.
    (inside === undefined || changed[0]!.above.slice(-2).join("\n").trim().startsWith(inside))
  );
};

/**
 * A commit the beta workflow makes to release the CLI: by github-actions[bot], titled `Release …
 * [skip ci]` (so it gets no CI run), and changing only the CLI's changelog, its version, and the
 * lockfile's record of that version, none of which any Cloud Worker reads. A lockfile diff that
 * changes anything else, such as a dependency, could change what a Worker bundles, so a commit
 * with one is not a release commit here.
 */
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

/** The workflow, event and head repository of a run, to tell whose code wrote its artifacts. */
const RunSource = Schema.fromJsonString(
  Schema.Struct({
    path: Schema.String,
    event: Schema.String,
    repository: Schema.NullOr(Schema.String),
  }),
);

/** The file a recorded baseline holds next to its sizes: the commit they were built from. */
const builtFrom = "baseline-commit.txt";

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
      // Main's own CI run at that commit. A release commit gets no run (`[skip ci]`), so its sizes
      // are those of the nearest earlier main commit that has them: a release commit changes no
      // Worker (`releaseCommit`). Only release commits are stepped over, at most `releaseSteps`.
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
          // Main's own runs, which run only main's code: a pull request's run can name main too.
          "--event",
          "push",
          "--commit",
          sha,
          "--json",
          "databaseId",
          "--jq",
          ".[0].databaseId // empty",
        ]).pipe(Effect.catchTag("BaselineFailed", () => Effect.succeed("")));
      const stepped: Array<string> = [];
      let at = commit;
      for (;;) {
        const run = yield* runAt(at);
        if (run !== "" && (yield* download(run, "worker-uploads"))) {
          if (stepped.length > 0)
            yield* Console.log(
              `::notice title=Worker sizes::${defaultBranch}'s sizes for ${commit} are those of ${at}, the nearest earlier commit with sizes: ${stepped.length === 1 ? `${stepped[0]} is a release commit, which changes` : `${stepped.join(", ")} are release commits, which change`} no Worker.`,
            );
          return { found: true, build: false, commit: at };
        }
        const info = stepped.length < releaseSteps ? yield* commitInfo(repository, at) : undefined;
        if (info === undefined || !releaseCommit(info) || info.parents.length !== 1) break;
        stepped.push(at);
        at = info.parents[0]!;
      }
      yield* Console.log(
        `::notice title=Worker sizes::${defaultBranch}'s sizes for ${commit} are not available yet${stepped.length > 0 ? `, nor for the release commits before it (${stepped.join(", ")})` : ""}, so no change is shown.`,
      );
      return { found: false, build: false, commit };
    }
    // A branch's sizes, as a CI run of this repository's own branches recorded them: a fork's run
    // runs the fork's code, which could write any sizes under any name.
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
    // The sizes name the commit they were built from; any others are not this commit's.
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
    artifacts: Schema.Array(Schema.Struct({ id: Schema.Number, name: Schema.String })),
  }),
);

const RunJobs = Schema.fromJsonString(
  Schema.Struct({
    jobs: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        status: Schema.String,
        steps: Schema.optional(
          Schema.Array(Schema.Struct({ name: Schema.String, status: Schema.String })),
        ),
      }),
    ),
  }),
);

/** The select job's step that runs this check, by its name in checks.yml. */
const checkStep = "Check that the layer above was computed on this layer";

/**
 * One look at the pull requests above `lower`: this repository's open pull requests based on its
 * branch, and their CI runs on their current heads. A record is downloaded once per artifact.
 */
const look = (
  lower: Lower,
  scratch: string,
  records: Map<number, RecordFields>,
  limits: { readonly read: Duration.Duration; readonly look: Duration.Duration },
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
    // A fork's pull request, and a fork's run on the same commit, run the fork's code, which could
    // write any record: only this repository's count.
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
        // CI's runs, not another workflow's; a cancelled run may have recorded and then stopped.
        const runs = all
          .filter(
            (run) =>
              run.path === ".github/workflows/ci.yml" &&
              run.head_repository?.full_name === repository &&
              run.conclusion !== "cancelled",
          )
          .toSorted((a, b) => b.id - a.id);
        const seen: Array<RunSeen> = [];
        // Every run on the head is read, since any one with a fitting record passes; the ten newest
        // cover a stack's duplicates and re-runs.
        for (const run of runs.slice(0, 10)) {
          const { artifacts } = yield* read(
            RunArtifacts,
            `repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`,
          );
          // Its own record: a re-run that chose differently uploads a second one, and the newest
          // is what the run's latest attempt chose.
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
            seen.push({
              id: run.id,
              url: run.html_url,
              record,
              selectDone: true,
              waitingAbove: false,
            });
            continue;
          }
          if (run.status === "completed") {
            seen.push({ id: run.id, url: run.html_url, selectDone: true, waitingAbove: false });
            continue;
          }
          const select = (yield* read(
            RunJobs,
            `repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`,
          )).jobs.find((job) => job.name === "checks / select");
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
        return { pull: pull.number, head: pull.head.sha, runs: seen } satisfies UpperSeen;
      }),
    );
    return { _tag: "Read", uppers } as Observation;
  }).pipe(
    // However many reads a look makes, it ends in time for the next.
    Effect.timeoutOrElse({
      duration: limits.look,
      orElse: () =>
        Effect.fail(
          new BaselineFailed({
            message: `the look got no answer within ${Duration.toSeconds(limits.look)} s`,
          }),
        ),
    }),
    // Not reading is not an answer: the check looks again until its deadline.
    Effect.catchCause((cause) =>
      Effect.succeed({
        _tag: "Unread",
        why: String(Cause.squash(cause)).split("\n")[0]!,
      } as Observation),
    ),
  );

/**
 * The check of the layer above a skip layer (e2e/ci-skip-check.ts): it looks, waits within the
 * bounds, logs one decision line and a summary sentence, and fails only when enforcing.
 */
const decide = Effect.gen(function* () {
  const lower: Lower = {
    repository: yield* Config.String("GITHUB_REPOSITORY"),
    ref: yield* Config.String("HEAD_REF"),
    head: yield* Config.String("HEAD_SHA"),
    bottom: yield* Config.String("BASELINE_BRANCH"),
    runId: yield* Config.String("GITHUB_RUN_ID").pipe(Config.withDefault("<run-id>")),
  };
  const scratch = `${yield* Config.String("RUNNER_TEMP").pipe(Config.withDefault("/tmp"))}/ci-above`;
  // Seconds of the clock per second of the rule. The spec runs the waits faster, and then counts
  // only the waits, since its stand-in reads take longer than the waits it shortens.
  const scale = yield* Config.Number("SKIP_ABOVE_TIME_SCALE").pipe(Config.withDefault(1));
  // Each read, download included, gets 20 seconds and each look a minute: a stalled connection
  // is no answer, and cannot hold the step past its deadline.
  const limits = {
    read: Duration.millis(Math.max(1000, 20_000 * scale)),
    look: Duration.millis(Math.max(2000, 60_000 * scale)),
  };
  const records = new Map<number, RecordFields>();
  const start = yield* Clock.currentTimeMillis;
  let previous: Verdict | undefined;
  let waited = 0;
  for (let polls = 0; ; polls += 1) {
    const verdict = judge(yield* look(lower, scratch, records, limits), lower, previous);
    if (verdict._tag === "Wait" && verdict.why !== (previous?._tag === "Wait" ? previous.why : ""))
      yield* Console.log(`Waiting: ${verdict.why}.`);
    previous = verdict;
    const elapsed = scale === 1 ? ((yield* Clock.currentTimeMillis) - start) / 1000 : waited;
    const step = next(verdict, lower, elapsed, polls);
    if (step._tag === "Done") return step.decision;
    waited += step.after;
    yield* Effect.sleep(Duration.millis(step.after * 1000 * scale));
  }
});

/**
 * The check of the layer above a skip layer (e2e/ci-skip-check.ts): it looks, waits within the
 * bounds, logs one decision line and a summary sentence, and fails only when enforcing. While
 * observing nothing in it can fail the step, a defect included: that is logged as `error`.
 */
const above = Effect.gen(function* () {
  const outcome = yield* guarded(decide, enforce);
  yield* Console.log(decisionLine(outcome));
  const report = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const summary = yield* Config.String("GITHUB_STEP_SUMMARY").pipe(Config.option);
    if (Option.isSome(summary))
      yield* fs.writeFileString(summary.value, `${summarySentence(outcome)}\n`, { flag: "a" });
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

/**
 * The descriptions of the pull requests a push to main merges, for the size gate on main
 * (worker-sizes.ts `--merged`): the merged pull requests of each commit between BEFORE_SHA and
 * HEAD_SHA. Writes them to `file` as JSON and `pulls` (#1, #2) to the step's outputs. If GitHub
 * cannot be read it writes no file and says so: not knowing the allowances is not growth, so the
 * gate then only reports. A commit no pull request merged allows nothing, with a notice.
 */
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
    // The branch's sizes could not be had: compare with main's, never skip the comparison.
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
    return yield* new BaselineFailed({
      message:
        "Usage: node scripts/ci/worker-baseline.ts resolve [--main] | fetch <directory> | fallback <directory> | above | merged <file>",
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);
