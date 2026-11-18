/**
 * Check a pull request description's `e2e` block before pushing, as CI's `select` job will:
 *
 *   bun run e2e:check-description --file description.md
 *   bun run e2e:check-description -            (the description on stdin)
 *   bun run e2e:check-description --pr 4439    (an open pull request's description and base)
 *
 * It runs `node e2e/ci-selection.ts`, the program the `select` job runs, with the job's
 * environment, and a stand-in `gh` first on its PATH (e2e/check-description-gh.ts) that answers
 * that program's reads from this checkout instead of GitHub: the description from the file, stdin
 * or the pull request; the changed files from `git diff` of HEAD against the base (`--base`, the
 * pull request's base, or main), and main's files, each fetched from origin as it is now (or the
 * commit `--main` names, for a test). With `--pr` the checkout must hold the pull request's head
 * commit, and the pull request's head branch stands for this one. It prints the same messages,
 * minus the advice only CI can follow, exits with the same code, and on success prints the same
 * selection: the jobs, their scenario counts and the release lanes. It checks what is committed.
 * A `skip` cannot be checked before the layer above is open; with a file or stdin it says so and
 * passes. `--pull <number>` with a file names the open pull request the description is for, before
 * its new head is pushed: the layers above it are read from GitHub, as with `--pr`, so a `skip`
 * with none fails as CI fails it. `--base-commit <sha>` compares with a local commit instead of
 * fetching the base, for a stack layer whose base is a lower layer not pushed yet (`bun run
 * pr:check`). `--head-ref <branch>` names the branch the checked commit is the head of, for a
 * checkout of another layer, which is detached: the layers above are the open pull requests based
 * on that branch, as CI reads them. It needs the network: it fetches main and the base from origin, and `--pr` and
 * `--pull` read GitHub with `gh`.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

class CheckFailed extends Schema.TaggedError<CheckFailed>()("CheckFailed", {
  message: Schema.String,
}) {}

const usage =
  "Usage: bun run e2e:check-description (--file <description.md> [--pull <number>] | - | --pr <number>) [--base <branch>] [--base-commit <sha>] [--head-ref <branch>] [--main <ref>]";

/** Runs a command and returns what it prints, its error output and its exit code. */
const run = (command: string, args: ReadonlyArray<string>, stdin?: string) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make(command, args, stdin === undefined ? {} : { stdin: "pipe" }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, exitCode: Number(exitCode) };
  }).pipe(Effect.scoped);

const git = (...args: ReadonlyArray<string>) =>
  run("git", args).pipe(
    Effect.flatMap(({ stdout, stderr, exitCode }) =>
      exitCode === 0
        ? Effect.succeed(stdout.trim())
        : Effect.fail(
            new CheckFailed({ message: `git ${args.join(" ")} failed: ${stderr.trim()}` }),
          ),
    ),
  );

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : (args[index + 1] ?? "");
  };
  const file = option("--file");
  const pr = option("--pr");
  const pull = option("--pull");
  const baseCommit = option("--base-commit");
  const givenHeadRef = option("--head-ref");
  const stdin = args.includes("-");
  if (
    [file, pr].filter((given) => given !== undefined).length + (stdin ? 1 : 0) !== 1 ||
    file === "" ||
    pr === "" ||
    (pull !== undefined && (file === undefined || !/^\d+$/.test(pull))) ||
    baseCommit === "" ||
    givenHeadRef === ""
  )
    return yield* new CheckFailed({ message: usage });

  const ghPath = (yield* run("sh", ["-c", "command -v gh"])).stdout.trim();
  const repository =
    process.env["GITHUB_REPOSITORY"] ??
    /github\.com[:/]([^/]+\/[^/.]+)/.exec(yield* git("remote", "get-url", "origin"))?.[1];
  if (repository === undefined)
    return yield* new CheckFailed({
      message: "Cannot tell the repository from the origin remote; set GITHUB_REPOSITORY.",
    });

  if (pull !== undefined && ghPath === "")
    return yield* new CheckFailed({
      message: "--pull reads the layers above the pull request with gh, which is not on PATH.",
    });

  let description: string;
  let baseBranch = option("--base") ?? "main";
  let headRef = givenHeadRef ?? (yield* git("rev-parse", "--abbrev-ref", "HEAD"));
  // A detached checkout is the head of no branch, and no pull request is based on `HEAD`: a skip
  // would be checked against no layer above.
  if (pull !== undefined && headRef === "HEAD")
    return yield* new CheckFailed({
      message: `--pull ${pull} checks a detached checkout, which names no branch: give the pull request's branch with --head-ref, so the layers above it are found.`,
    });
  const head = yield* git("rev-parse", "HEAD");
  if (pr !== undefined) {
    if (ghPath === "")
      return yield* new CheckFailed({
        message: "--pr reads the pull request with gh, which is not on PATH.",
      });
    const viewed = yield* run(ghPath, [
      "pr",
      "view",
      pr,
      "--repo",
      repository,
      "--json",
      "body,baseRefName,headRefName,headRefOid",
    ]);
    if (viewed.exitCode !== 0)
      return yield* new CheckFailed({
        message: `gh pr view ${pr} failed: ${viewed.stderr.trim()}`,
      });
    const read = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          body: Schema.String,
          baseRefName: Schema.String,
          headRefName: Schema.String,
          headRefOid: Schema.String,
        }),
      ),
    )(viewed.stdout);
    // The changed files come from this checkout, so it must hold the pull request's head.
    if (head !== read.headRefOid)
      return yield* new CheckFailed({
        message: `This checkout's HEAD is ${head}, but pull request ${pr}'s head is ${read.headRefOid}, so its changed files would not be the pull request's. Check out that commit first: git fetch origin ${read.headRefName} && git checkout --detach ${read.headRefOid}`,
      });
    description = read.body;
    baseBranch = option("--base") ?? read.baseRefName;
    headRef = read.headRefName;
  } else description = yield* fs.readFileString(stdin ? "/dev/stdin" : file!);

  // Main and the base as the remote has them, fetched into refs of this check's own, or the
  // commit `--main` names (which also stands for the base unless `--base` names a ref).
  const given = option("--main");
  const main = given ?? "refs/check-description/main";
  const base =
    baseCommit ??
    (given === undefined ? "refs/check-description/base" : (option("--base") ?? given));
  if (given === undefined) {
    const fetched = yield* run("git", [
      "fetch",
      "--quiet",
      "origin",
      "+refs/heads/main:refs/check-description/main",
      ...(baseCommit === undefined
        ? [`+refs/heads/${baseBranch}:refs/check-description/base`]
        : []),
    ]);
    if (fetched.exitCode !== 0)
      return yield* new CheckFailed({
        message: `Could not fetch main and ${baseBranch} from origin, which the check compares with as CI does. It needs the network and read access to origin (an HTTPS remote needs git credentials); it cannot check offline: ${fetched.stderr.trim()}`,
      });
  }
  yield* Console.error(
    `Checking against main at ${yield* git("rev-parse", "--short", `${main}^{commit}`)} and the base ${given === undefined ? baseBranch : base} at ${yield* git("rev-parse", "--short", `${base}^{commit}`)}${given === undefined ? ", as origin has them" : ""}, for HEAD ${head.slice(0, 9)}.`,
  );

  const here = path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)));
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-check-description-" });
  const bin = path.join(directory, "bin");
  yield* fs.makeDirectory(bin);
  yield* fs.writeFileString(path.join(directory, "description.md"), description);
  yield* fs.writeFileString(
    path.join(bin, "gh"),
    `#!/bin/sh\nexec node ${JSON.stringify(path.join(here, "check-description-gh.ts"))} "$@"\n`,
  );
  yield* fs.chmod(path.join(bin, "gh"), 0o755);
  const outputs = path.join(directory, "outputs");
  yield* fs.writeFileString(outputs, "");
  yield* fs.writeFileString(path.join(directory, "summary"), "");
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* processes.spawn(
    ChildProcess.make("node", [path.join(here, "ci-selection.ts")], {
      stdout: "inherit",
      stderr: "inherit",
      extendEnv: true,
      env: {
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        E2E_PULL_REQUEST: pr ?? pull ?? "0",
        E2E_HEAD_REF: headRef,
        E2E_DEFAULT_BRANCH: "main",
        E2E_COMPARE_BASE: "main",
        E2E_COMPARE_HEAD: head,
        E2E_LOCAL_CHECK: "1",
        // Run from inside a CI job, the selection would refuse local mode (e2e/ci-selection.ts).
        GITHUB_ACTIONS: "",
        // A draft is complete as it is: nothing will edit it while this waits.
        E2E_DESCRIPTION_WAIT_SECONDS: "0",
        GITHUB_REPOSITORY: repository,
        GITHUB_RUN_ID: "<run id>",
        GITHUB_OUTPUT: outputs,
        GITHUB_STEP_SUMMARY: path.join(directory, "summary"),
        CHECK_DESCRIPTION_FILE: path.join(directory, "description.md"),
        CHECK_DESCRIPTION_BASE: base,
        CHECK_DESCRIPTION_MAIN: main,
        CHECK_DESCRIPTION_GH: pr === undefined && pull === undefined ? "" : ghPath,
      },
    }),
  );
  process.exitCode = Number(yield* child.exitCode);
}).pipe(Effect.scoped);

NodeRuntime.runMain(
  program.pipe(
    Effect.catchTag("CheckFailed", (error) =>
      Console.error(error.message).pipe(Effect.andThen(Effect.sync(() => (process.exitCode = 2)))),
    ),
    Effect.provide(NodeServices.layer),
  ),
);
