import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Clock, Console, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

class PrCheckFailed extends Schema.TaggedError<PrCheckFailed>()("PrCheckFailed", {
  message: Schema.String,
}) {}

const usage =
  "Usage: bun run pr:check [--description <file>] [--only static|description|apps-version|release-notes]";

export const notChecked = [
  "the skip check of a layer whose block says skip (that the layer above's CI run was computed on this layer, scripts/ci/worker-baseline.ts above)",
  "site: the site build, its links, and the Cloud Workers' upload and start-up size budgets",
  "apps-package: the packed apps package and its scenarios",
  "tooling, tooling-release and tooling-cloud: the tooling suites and their scenarios",
  "self-host-native, collector-native and collector: native tests and the collector build",
  "every E2E scenario and release lane the selection names (local, self-host, scale, Cloud, Docker, CLI, desktop)",
  "line coverage, and the aggregate check and e2e jobs that judge every job's result",
];

const offline = (what: string, detail: string) =>
  new PrCheckFailed({
    message: `pr:check could not ${what}. It needs the network, and cannot check offline: it fetches main and the base from origin (an HTTPS remote needs git credentials), and reads the pull request, its stack and their descriptions with gh, signed in. ${detail.trim()}`,
  });

const run = (command: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make(command, args, { stdin: "ignore", extendEnv: true }),
    );
    const [output, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    return { output, exitCode: Number(exitCode) };
  }).pipe(Effect.scoped);

const read = (command: string, args: ReadonlyArray<string>) =>
  run(command, args).pipe(
    Effect.flatMap(({ output, exitCode }) =>
      exitCode === 0
        ? Effect.succeed(output.trim())
        : Effect.fail(
            new PrCheckFailed({
              message: `${command} ${args.join(" ")} exited ${exitCode}: ${output.trim()}`,
            }),
          ),
    ),
  );

const PullRequest = Schema.fromJsonString(
  Schema.Struct({
    number: Schema.Number,
    title: Schema.String,
    body: Schema.String,
    baseRefName: Schema.String,
  }),
);

const Stack = Schema.fromJsonString(
  Schema.Struct({
    trunk: Schema.String,
    branches: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        head: Schema.String,
        pr: Schema.optional(Schema.Struct({ number: Schema.Number, state: Schema.String })),
      }),
    ),
  }),
);

interface Outcome {
  readonly name: string;
  readonly passed: boolean;
  readonly seconds: number;
  readonly output: string;
}

const step = <R>(
  name: string,
  body: Effect.Effect<{ passed: boolean; output: string }, unknown, R>,
) =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis;
    const result = yield* body.pipe(
      Effect.catch((error) =>
        Effect.succeed({
          passed: false,
          output: error instanceof PrCheckFailed ? error.message : String(error),
        }),
      ),
    );
    const seconds = ((yield* Clock.currentTimeMillis) - start) / 1000;
    yield* Console.log(`${result.passed ? "pass" : "FAIL"}  ${name} (${seconds.toFixed(1)} s)`);
    return { name, seconds, ...result } satisfies Outcome;
  });

const command = (name: string, args: ReadonlyArray<string>) =>
  run(name, args).pipe(Effect.map(({ output, exitCode }) => ({ passed: exitCode === 0, output })));

const checkout = (directory: string, commit: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (yield* fs.exists(directory))
      yield* read("git", ["-C", directory, "checkout", "--quiet", "--detach", commit]);
    else yield* read("git", ["worktree", "add", "--quiet", "--detach", directory, commit]);
  });

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const descriptionFile = option("--description");
  const only = option("--only");
  const known = ["static", "description", "apps-version", "release-notes"];
  if (
    args.length !== [descriptionFile, only].filter((given) => given !== undefined).length * 2 ||
    descriptionFile === "" ||
    (only !== undefined && !known.includes(only))
  )
    return yield* new PrCheckFailed({ message: usage });

  const branch = yield* read("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const viewed =
    branch === "HEAD"
      ? undefined
      : yield* run("gh", ["pr", "view", "--json", "number,title,body,baseRefName"]);
  if (
    viewed !== undefined &&
    viewed.exitCode !== 0 &&
    !/no pull requests found/i.test(viewed.output)
  )
    return yield* offline(`read ${branch}'s pull request with gh`, viewed.output);
  const pullRequest =
    viewed !== undefined && viewed.exitCode === 0
      ? yield* Schema.decodeUnknownEffect(PullRequest)(viewed.output)
      : undefined;
  if (pullRequest === undefined && descriptionFile === undefined)
    return yield* new PrCheckFailed({
      message: `${branch === "HEAD" ? "HEAD is detached" : `No open pull request for ${branch}`}, so there is no description to check. Write it to a file and run: bun run pr:check --description <file>`,
    });
  const baseBranch = pullRequest?.baseRefName ?? "main";
  yield* read("git", [
    "fetch",
    "--quiet",
    "--refmap=",
    "origin",
    "+refs/heads/main:refs/pr-check/main",
    `+refs/heads/${baseBranch}:refs/pr-check/base`,
  ]).pipe(
    Effect.catchTag("PrCheckFailed", (error) =>
      Effect.fail(offline(`fetch main and ${baseBranch} from origin`, error.message)),
    ),
  );
  const main = yield* read("git", ["rev-parse", "refs/pr-check/main"]);
  const meets = yield* read("git", ["merge-base", "HEAD", main]);
  const layerBase = yield* read("git", ["merge-base", "HEAD", "refs/pr-check/base"]);

  const work = path.resolve(".local", "pr-check");
  yield* fs.makeDirectory(work, { recursive: true });
  const description = path.join(work, "description.md");
  const body = pullRequest?.body ?? (yield* fs.readFileString(descriptionFile!));
  yield* fs.writeFileString(description, body);
  yield* Console.log(
    `Checking ${branch} at ${(yield* read("git", ["rev-parse", "--short", "HEAD"])).trim()} against main at ${main.slice(0, 9)}${pullRequest === undefined ? `, with the description in ${descriptionFile}` : `, with #${pullRequest.number}'s description`}.`,
  );

  const otherLayers = Effect.gen(function* () {
    if (branch === "HEAD") return { passed: true, output: "" };
    const stack = yield* run("gh", ["stack", "view", "--json"]);
    if (stack.exitCode === 2) return { passed: true, output: "" };
    if (stack.exitCode !== 0)
      return {
        passed: false,
        output: `Could not read this branch's stack with gh stack view (exit ${stack.exitCode}), so its other layers are not checked: ${stack.output.trim()}`,
      };
    const { trunk, branches } = yield* Schema.decodeUnknownEffect(Stack)(stack.output);
    let passed = true;
    let output = "";
    for (const [index, layer] of branches.entries()) {
      if (layer.pr?.state !== "OPEN" || layer.name === branch) continue;
      const number = layer.pr.number;
      const tip = (entry: { readonly name: string; readonly head: string }) =>
        run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${entry.name}^{commit}`]).pipe(
          Effect.map(({ output, exitCode }) => (exitCode === 0 ? output.trim() : entry.head)),
        );
      const head = yield* tip(layer);
      const below = index === 0 ? undefined : yield* tip(branches[index - 1]!);
      const directory = path.join(work, "layers", String(number));
      yield* checkout(directory, head);
      const body = path.join(work, `layer-${number}.md`);
      const viewedBody = yield* run("gh", [
        "pr",
        "view",
        String(number),
        "--json",
        "body",
        "--jq",
        ".body",
      ]);
      if (viewedBody.exitCode !== 0)
        return yield* offline(`read #${number}'s description with gh`, viewedBody.output);
      yield* fs.writeFileString(body, viewedBody.output);
      const checked = yield* run("sh", [
        "-c",
        'cd "$1" && shift && exec node e2e/check-description.ts "$@"',
        "sh",
        directory,
        "--file",
        body,
        "--pull",
        String(number),
        "--head-ref",
        layer.name,
        ...(below === undefined ? ["--base", trunk] : ["--base-commit", below]),
      ]);
      passed &&= checked.exitCode === 0;
      yield* Console.log(
        `      description: #${number} (${layer.name}) at ${head.slice(0, 9)}, another layer of the stack, ${checked.exitCode === 0 ? "passed" : "FAILED"}`,
      );
      output += `\n--- #${number} (${layer.name}) ${checked.exitCode === 0 ? "passed" : "FAILED"}\n${checked.output}`;
    }
    return { passed, output };
  });

  const releaseNotes = Effect.gen(function* () {
    const checked = yield* run("node", [
      "scripts/releases/release-notes.ts",
      "--check",
      layerBase,
      "--title",
      pullRequest?.title ?? "Pull request title",
    ]);
    const inDescription = /^Release-note:[ \t]*(?!none\s*$)\S/imu.test(body);
    const inCommits = /^Release-note accepted:/mu.test(checked.output);
    const lost =
      inDescription && !inCommits
        ? "\nThe description has a Release-note: line that no commit message on the branch has. The squashed commit's body is the commits' messages, not the description, so the release would not list it: put the line in a commit message too (AGENTS.md, Release notes)."
        : "";
    return { passed: checked.exitCode === 0 && lost === "", output: `${checked.output}${lost}` };
  });

  const apps = Effect.gen(function* () {
    const mainCheckout = path.join(work, "main");
    const lockCheckout = path.join(work, "meets-main");
    yield* checkout(mainCheckout, main);
    yield* checkout(lockCheckout, meets);
    const steps = ["base-build", "lockfile", "bump", "protocols"];
    let output = "";
    for (const name of steps) {
      const result = yield* run("scripts/ci/apps-version.sh", [name, mainCheckout, lockCheckout]);
      output += `--- ${name}\n${result.output}`;
      if (result.exitCode !== 0) return { passed: false, output };
    }
    return { passed: true, output };
  });

  const outcomes = yield* Effect.all(
    (
      [
        ["static", step("static (bun run check)", command("bun", ["run", "check"]))],
        [
          "description",
          step(
            "description",
            Effect.gen(function* () {
              const own = yield* run("node", [
                "e2e/check-description.ts",
                "--file",
                description,
                "--base",
                baseBranch,
                ...(pullRequest === undefined ? [] : ["--pull", String(pullRequest.number)]),
              ]);
              const others = yield* otherLayers;
              return {
                passed: own.exitCode === 0 && others.passed,
                output: `${own.output}${others.output === "" ? "" : `\nThe stack's other layers:${others.output}`}`,
              };
            }),
          ),
        ],
        ["apps-version", step("apps-version (bun.lock, apps version bump, host protocols)", apps)],
        ["release-notes", step("release-notes", releaseNotes)],
      ] as const
    )
      .filter(([name]) => only === undefined || name === only)
      .map(([, check]) => check),
    { concurrency: "unbounded" },
  );
  const failed = outcomes.filter((outcome) => !outcome.passed);
  for (const outcome of failed)
    yield* Console.log(`\n=== ${outcome.name} failed:\n${outcome.output.trimEnd()}`);
  yield* Console.log(
    `\nNot checked here; CI runs these after the push:\n${[
      ...(only === undefined
        ? []
        : known.filter((name) => name !== only).map((name) => `${name} (left out by --only)`)),
      ...notChecked,
    ]
      .map((gate) => `- ${gate}`)
      .join("\n")}`,
  );
  if (failed.length > 0) {
    yield* Console.log(`\n${failed.length} of ${outcomes.length} checks failed.`);
    process.exitCode = 1;
  } else
    yield* Console.log(
      `\nAll ${outcomes.length} checks here passed; the gates above are not checked here.`,
    );
});

NodeRuntime.runMain(
  program.pipe(
    Effect.catchTag("PrCheckFailed", (error) =>
      Console.error(error.message).pipe(Effect.andThen(Effect.sync(() => (process.exitCode = 2)))),
    ),
    Effect.provide(NodeServices.layer),
  ),
);
