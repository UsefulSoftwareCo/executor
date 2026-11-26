import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Clock, Config, Console, Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { body, decide } from "./main-health-decide.ts";
import { ReadFailed, reads } from "./main-health-read.ts";

class WriteFailed extends Schema.TaggedError<WriteFailed>()("WriteFailed", {
  message: Schema.String,
}) {}

const Created = Schema.fromJsonString(
  Schema.Struct({ number: Schema.Int.check(Schema.isGreaterThan(0)) }),
);

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const label = yield* Config.String("LABEL");
  if (!/^[A-Za-z0-9._-]+$/u.test(label))
    return yield* new WriteFailed({
      message: "LABEL is letters, digits, dots, dashes and underscores.",
    });
  const title = yield* Config.String("TITLE");
  const repository = yield* Config.String("GITHUB_REPOSITORY");
  const server = yield* Config.String("GITHUB_SERVER_URL");
  const ci = {
    workflow: yield* Config.String("CI_WORKFLOW"),
    branch: yield* Config.String("CI_BRANCH"),
    event: yield* Config.String("CI_EVENT"),
  };
  const windows = {
    workflow: yield* Config.String("WINDOWS_WORKFLOW"),
    branch: yield* Config.String("WINDOWS_BRANCH"),
    event: yield* Config.String("WINDOWS_EVENT"),
    title: yield* Config.String("WINDOWS_TITLE"),
  };
  const beta = {
    workflow: yield* Config.String("BETA_WORKFLOW"),
    branch: yield* Config.String("BETA_BRANCH"),
    artifact: yield* Config.String("BETA_ARTIFACT"),
    events: (yield* Config.String("BETA_EVENTS")).split(" ").filter((event) => event !== ""),
  };
  const summary = yield* Config.String("GITHUB_STEP_SUMMARY").pipe(Config.withDefault(""));
  const temp = `${yield* Config.String("RUNNER_TEMP")}/main-health`;
  yield* fs.remove(temp, { recursive: true, force: true });
  yield* fs.makeDirectory(temp, { recursive: true });
  const marker = `<!-- main-issue: ${label} -->`;
  const read = reads({
    repository,
    server,
    label,
    marker,
    ci,
    windows,
    beta,
    now: yield* Clock.currentTimeMillis,
    temp,
  });

  const facts = { ci: yield* read.ci, windows: yield* read.windows, beta: yield* read.beta };
  const owned = yield* read.owned;

  const text = body(facts, {
    marker,
    repository: `${server}/${repository}`,
    ci: `${ci.workflow} on ${ci.branch}`,
    windows: `the Windows check (${windows.title} on ${windows.branch})`,
    betaWorkflow: beta.workflow,
    betaArtifact: beta.artifact,
  });
  if (summary !== "") yield* fs.writeFileString(summary, `${text}\n`, { flag: "a" });
  const outcome = decide(
    { ci: facts.ci.health, windows: facts.windows.health, beta: facts.beta.health },
    owned.length > 0,
  );

  const gh = (args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* processes.spawn(
        ChildProcess.make("gh", args, { stdout: "pipe", stderr: "pipe" }),
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
        return yield* new WriteFailed({
          message: `gh ${args.slice(0, 3).join(" ")} failed: ${stderr.trim()}`,
        });
      return stdout;
    }).pipe(Effect.scoped);
  let requests = 0;
  const send = (method: string, path: string, request: object) =>
    Effect.gen(function* () {
      const file = `${temp}/request-${requests++}.json`;
      yield* fs.writeFileString(file, JSON.stringify(request));
      return yield* gh(["api", "-X", method, `repos/${repository}/${path}`, "--input", file]);
    });
  const write = (number: number, state: "open" | "closed", reason?: "completed" | "not_planned") =>
    send("PATCH", `issues/${number}`, {
      title,
      body: text,
      state,
      ...(reason === undefined ? {} : { state_reason: reason }),
    });
  const same = (issue: { readonly title: string; readonly body: string }) =>
    issue.title === title && issue.body === text;

  yield* Console.log(
    `CI ${facts.ci.health}, Windows check ${facts.windows.health}, beta ${facts.beta.health}: ${outcome}.`,
  );
  if (outcome === "open") {
    if (!(yield* read.labelExists))
      yield* gh([
        "api",
        "-X",
        "POST",
        `repos/${repository}/labels`,
        "-f",
        `name=${label}`,
        "-f",
        "color=B60205",
        "-f",
        "description=Main needs a person (scripts/ci/main-health.ts)",
      ]);
    const created = yield* send("POST", "issues", { title, body: text, labels: [label] }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Created)),
    );
    yield* Console.log(`Opened #${created.number}.`);
  }
  if (outcome === "keep") {
    const [kept, ...others] = owned;
    if (same(kept!)) yield* Console.log(`#${kept!.number} already says this.`);
    else {
      yield* write(kept!.number, "open");
      yield* Console.log(`Wrote #${kept!.number}.`);
    }
    for (const other of others) {
      yield* write(other.number, "closed", "not_planned");
      yield* Console.log(
        `Closed #${other.number}: #${kept!.number} is the issue main-health.ts keeps.`,
      );
    }
  }
  if (outcome === "close")
    for (const issue of owned) {
      yield* write(issue.number, "closed", "completed");
      yield* Console.log(`Closed #${issue.number}: every source is known to be green or not held.`);
    }
  if (outcome === "rewrite")
    for (const issue of owned) {
      if (same(issue))
        yield* Console.log(
          `#${issue.number} already says this; nothing is opened or closed while a source is unknown.`,
        );
      else {
        yield* write(issue.number, "open");
        yield* Console.log(
          `Wrote #${issue.number}; nothing is opened or closed while a source is unknown.`,
        );
      }
    }
  if (outcome === "none")
    yield* Console.log(
      [facts.ci.health, facts.windows.health, facts.beta.health].includes("unknown")
        ? "Nothing is known to be red or held, and no issue is open: an unknown source opens none."
        : "Every source is known to be green or not held, and no issue is open.",
    );
});

NodeRuntime.runMain(
  program.pipe(
    Effect.catchTags({
      ReadFailed: (error: ReadFailed) =>
        Console.error(`::error::${error.message}`).pipe(
          Effect.andThen(Effect.sync(() => (process.exitCode = 1))),
        ),
      WriteFailed: (error: WriteFailed) =>
        Console.error(`::error::${error.message}`).pipe(
          Effect.andThen(Effect.sync(() => (process.exitCode = 1))),
        ),
    }),
    Effect.provide(NodeServices.layer),
  ),
);
