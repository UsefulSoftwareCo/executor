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
import { Base64 } from "effect/encoding";
import { FetchHttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { runAttemptUrl } from "../src/infrastructure/deploy-events.ts";
import {
  githubGet,
  lostRequest,
  makeDeployHistory,
  newestDeployStart,
} from "../src/infrastructure/deploy-history.ts";
import {
  installScripts,
  isDeployInput,
  readManifest,
  rootManifestChangeIsE2eOnly,
  scriptsNamingE2e,
  workspaceDirectories,
  type WorkspaceDirectory,
} from "../src/infrastructure/deploy-inputs.ts";

class DeployDecisionFailed extends Schema.TaggedError<DeployDecisionFailed>()(
  "DeployDecisionFailed",
  { message: Schema.String },
) {}

interface Decision {
  readonly deploy: boolean;
  readonly failed?: boolean;
  readonly reason: string;
  readonly base?: { readonly sha: string; readonly url: string };
  readonly matched: ReadonlyArray<string>;
  readonly changed: number;
  readonly e2eScriptsOnly?: boolean;
}
const deploy = (reason: string, fields: Partial<Decision> = {}): Decision => ({
  deploy: true,
  reason,
  matched: [],
  changed: 0,
  ...fields,
});

const RootManifest = Schema.Struct({ workspaces: Schema.optional(Schema.Array(Schema.String)) });
const PackageScripts = Schema.Struct({
  scripts: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const workspacesOf = (root: string, manifest: unknown) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { workspaces = [] } = yield* Schema.decodeUnknownEffect(RootManifest)(manifest);
    return yield* Effect.forEach(
      workspaceDirectories(workspaces),
      (workspace): Effect.Effect<WorkspaceDirectory, never, FileSystem.FileSystem> =>
        fs.readFileString(path.join(root, workspace.directory, "package.json")).pipe(
          Effect.map(readManifest),
          Effect.flatMap(Schema.decodeUnknownEffect(PackageScripts)),
          Effect.map(({ scripts = {} }) => installScripts.some((name) => name in scripts)),
          Effect.orElseSucceed(() => true),
          Effect.map((installs) => ({ ...workspace, installs })),
        ),
    );
  });

const Contents = Schema.Struct({ content: Schema.String, encoding: Schema.String });

const manifestAt = (repository: string, sha: string) =>
  githubGet(Contents, `repos/${repository}/contents/package.json?ref=${sha}`).pipe(
    Effect.flatMap(({ content, encoding }) =>
      Effect.gen(function* () {
        if (encoding !== "base64")
          return yield* new DeployDecisionFailed({
            message: `GitHub returned package.json at ${sha} encoded as ${encoding}`,
          });
        return yield* Effect.fromResult(Base64.decodeString(content.replace(/\s/g, "")));
      }),
    ),
  );

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
  const changed = (yield* git("diff", "-z", "--name-only", "--no-renames", base.sha, head))
    .split("\0")
    .filter((file) => file !== "");
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifest = yield* fs.readFileString(path.join(root, "package.json"));
  const parsed = readManifest(manifest);
  if (parsed === undefined)
    return yield* new DeployDecisionFailed({
      message:
        "the root package.json does not read faithfully (a duplicated key, a rewritten escape or a non-canonical number), so what Bun reads from it cannot be shown",
    });
  const naming = scriptsNamingE2e(manifest);
  if (naming.length > 0)
    return yield* new DeployDecisionFailed({
      message: `root scripts ${naming.join(", ")} name an e2e: script, so a change to one may change what a deploy runs`,
    });
  const e2eOnly =
    changed.includes("package.json") &&
    rootManifestChangeIsE2eOnly(yield* manifestAt(repository, base.sha), manifest);
  const workspaces = yield* workspacesOf(root, parsed);
  const matched = changed.filter(
    (file) => !(file === "package.json" && e2eOnly) && isDeployInput(file, workspaces),
  );
  return matched.length > 0 || changed.length === 0
    ? deploy(
        matched.length > 0
          ? "files a deploy may depend on changed since the last deploy"
          : "git lists no change since the last deploy, which a different commit should not have",
        { base, matched, changed: changed.length, e2eScriptsOnly: e2eOnly },
      )
    : ({
        deploy: false,
        reason: "every change since the last deploy lies in paths no deploy reads",
        base,
        matched,
        changed: changed.length,
        e2eScriptsOnly: e2eOnly,
      } satisfies Decision);
});

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
    ...(decision.e2eScriptsOnly === true
      ? [
          "",
          "The root `package.json` changed only in `e2e:*` scripts, which no deploy step runs, so it is not counted.",
        ]
      : []),
  ].join("\n");
};

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const decision = yield* decide.pipe(
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
