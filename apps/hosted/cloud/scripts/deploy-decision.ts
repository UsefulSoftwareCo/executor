/**
 * Decide whether this Deploy run deploys, before anything builds. Many merges change only tests,
 * CI or notes, and every deploy replaces every production Worker, which resets the MCP session
 * Worker's Durable Objects. A push whose changes since the last deploy all lie in paths no deploy
 * reads (`src/infrastructure/deploy-inputs.ts`) skips the deploy job.
 *
 *   node apps/hosted/cloud/scripts/deploy-decision.ts
 *
 * It compares this commit with what production holds: the commit of the deploy job that started
 * last, of any run and attempt, as GitHub's Actions API records it (`newestDeployStart` in
 * `src/infrastructure/deploy-history.ts`). If that deploy step did not succeed, production may
 * hold any part of it, and this run deploys.
 *
 * Every doubt deploys: a manual dispatch (a changed repository variable or secret makes no
 * commit), a re-run of all jobs, a dispatch or re-run since the last deploy that was cancelled
 * before its deploy job started (`lostRequest`), no deploy GitHub can show, a rerun of the
 * deployed commit, a commit git cannot compare, or any failure of this script, which the summary
 * reports as a failure to decide. "Re-run failed jobs" keeps this job's earlier output, so it
 * deploys only if this job failed.
 *
 * Writes the decision, its base and the files that matched to the job summary, then `deploy=true`
 * or `deploy=false` and `base=<commit>` to `GITHUB_OUTPUT`, last: a run that fails before then
 * leaves no output, and the deploy job runs.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Cause,
  Config,
  Console,
  DateTime,
  Effect,
  FileSystem,
  Option,
  Path,
  Schema,
  Stream,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { runAttemptUrl } from "../src/infrastructure/deploy-events.ts";
import {
  lostRequest,
  makeDeployHistory,
  newestDeployStart,
} from "../src/infrastructure/deploy-history.ts";
import { isDeployInput, workspaceDirectories } from "../src/infrastructure/deploy-inputs.ts";

class DeployDecisionFailed extends Schema.TaggedError<DeployDecisionFailed>()(
  "DeployDecisionFailed",
  { message: Schema.String },
) {}

interface Decision {
  readonly deploy: boolean;
  /** The decision did not finish, so the run deploys. */
  readonly failed?: boolean;
  readonly reason: string;
  /** The last deployed commit and its run attempt, when the decision compared with one. */
  readonly base?: { readonly sha: string; readonly url: string };
  readonly matched: ReadonlyArray<string>;
  readonly changed: number;
}
const deploy = (reason: string, fields: Partial<Decision> = {}): Decision => ({
  deploy: true,
  reason,
  matched: [],
  changed: 0,
  ...fields,
});

const RootManifest = Schema.fromJsonString(
  Schema.Struct({ workspaces: Schema.optional(Schema.Array(Schema.String)) }),
);

/** The workspace patterns of the checkout at `root`. */
const workspacePatterns = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifest = yield* fs
      .readFileString(path.join(root, "package.json"))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(RootManifest)));
    return manifest.workspaces ?? [];
  });

/**
 * One git command's standard output. Any exit status but 0 fails, so a commit git does not hold
 * is a failure, which deploys, and never an empty list of changes.
 */
const git = (...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("git", args, { stdout: "pipe", stderr: "pipe" }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (Number(exitCode) !== 0)
      return yield* new DeployDecisionFailed({
        message: `git ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`,
      });
    return stdout;
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) =>
      error instanceof DeployDecisionFailed
        ? error
        : new DeployDecisionFailed({ message: `git ${args.join(" ")}: ${String(error)}` }),
    ),
  );

const decide = Effect.gen(function* () {
  const event = yield* Config.NonEmptyString("GITHUB_EVENT_NAME");
  const head = yield* Config.NonEmptyString("GITHUB_SHA");
  const repository = yield* Config.NonEmptyString("GITHUB_REPOSITORY");
  const runId = yield* Config.Int("GITHUB_RUN_ID");
  const attempt = yield* Config.Int("GITHUB_RUN_ATTEMPT");
  if (event !== "push")
    return deploy(
      `this run was started by ${event}, and a manual run always deploys: a changed repository variable or secret makes no commit`,
    );
  if (attempt !== 1)
    return deploy(
      `this is attempt ${attempt} of the run, and re-running this job always deploys: someone may have changed a variable or secret`,
    );
  const history = yield* makeDeployHistory(repository);
  const now = yield* DateTime.now;
  const last = yield* newestDeployStart(history, now, runId);
  if (last === undefined) return deploy("GitHub records no deploy job that started");
  const base = {
    sha: last.run.head_sha,
    url: runAttemptUrl(repository, last.run.id, last.number),
  };
  if (!last.succeeded)
    return deploy(
      `the deploy that started last, of \`${base.sha}\`, did not succeed (its deploy step is ${last.state}), so production may hold any part of it`,
      { base },
    );
  const lost = yield* lostRequest(history, last, now, runId);
  if (lost !== undefined)
    return deploy(
      `a ${lost.kind} of Deploy since the last deploy started ([run ${lost.run.id}, attempt ${lost.number}](${runAttemptUrl(repository, lost.run.id, lost.number)})) never started its deploy job, most likely cancelled while it waited, so this run deploys what it asked for`,
      { base },
    );
  if (base.sha === head)
    return deploy("this commit is the one deployed last, and running it again deploys it again", {
      base,
    });
  const root = (yield* git("rev-parse", "--show-toplevel")).trim();
  // NUL-separated, so git writes every path as it is rather than quoting unusual ones. Without
  // rename detection a moved file is listed at both its old and its new path.
  const changed = (yield* git("diff", "-z", "--name-only", "--no-renames", base.sha, head))
    .split("\0")
    .filter((file) => file !== "");
  const workspaces = workspaceDirectories(yield* workspacePatterns(root));
  const matched = changed.filter((file) => isDeployInput(file, workspaces));
  return matched.length > 0 || changed.length === 0
    ? deploy(
        matched.length > 0
          ? "files a deploy may depend on changed since the last deploy"
          : "git lists no change since the last deploy, which a different commit should not have",
        { base, matched, changed: changed.length },
      )
    : ({
        deploy: false,
        reason: "every change since the last deploy lies in paths no deploy reads",
        base,
        matched,
        changed: changed.length,
      } satisfies Decision);
});

/** The job summary: the decision, its base, and the files that matched or how many did not. */
const summaryOf = (decision: Decision) => {
  const shown = 50;
  const heading = decision.failed
    ? "Could not decide, so deploying"
    : decision.deploy
      ? "Deploying"
      : "Skipped";
  return [
    "## Deploy decision",
    "",
    `**${heading}:** ${decision.reason}.`,
    "",
    ...(decision.base === undefined
      ? []
      : [
          `Base: \`${decision.base.sha}\`, the commit of the deploy that started last ([its run](${decision.base.url})).`,
          "",
        ]),
    ...(decision.changed === 0
      ? []
      : decision.matched.length === 0
        ? [
            `None of the ${decision.changed} changed files is a deploy input: each lies in a path no deploy reads (apps/hosted/cloud/src/infrastructure/deploy-inputs.ts).`,
          ]
        : [
            `${decision.matched.length} of the ${decision.changed} changed files may be deploy inputs:`,
            "",
            ...decision.matched.slice(0, shown).map((file) => `- \`${file}\``),
            ...(decision.matched.length > shown
              ? [`- and ${decision.matched.length - shown} more`]
              : []),
          ]),
  ].join("\n");
};

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const decision = yield* decide.pipe(
    // Any failure deploys: a skipped deploy must never rest on a decision that did not finish. It
    // is reported as a failure to decide, so a gate that stopped working does not pass unnoticed.
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const first = Cause.pretty(cause).split("\n")[0] ?? "unknown failure";
        yield* Console.log(`::warning title=Deploy decision failed::${first}`);
        return { ...deploy(first), failed: true } satisfies Decision;
      }),
    ),
  );
  const summary = summaryOf(decision);
  yield* Console.log(summary);
  const stepSummary = yield* Config.NonEmptyString("GITHUB_STEP_SUMMARY").pipe(Config.option);
  if (Option.isSome(stepSummary))
    yield* fs.writeFileString(stepSummary.value, `${summary}\n`, { flag: "a" });
  // The output comes last: if anything before it fails, the step fails with no output, and the
  // deploy job runs.
  const output = yield* Config.NonEmptyString("GITHUB_OUTPUT").pipe(Config.option);
  if (Option.isSome(output))
    yield* fs.writeFileString(
      output.value,
      `deploy=${decision.deploy}\nbase=${decision.base?.sha ?? ""}\n`,
      { flag: "a" },
    );
});

NodeRuntime.runMain(
  program.pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(NodeServices.layer)),
);
