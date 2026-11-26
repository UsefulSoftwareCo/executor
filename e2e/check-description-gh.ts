import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, FileSystem, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const args = process.argv.slice(2);
const env = (name: string) => process.env[name] ?? "";

const run = (command: string, commandArgs: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(ChildProcess.make(command, commandArgs));
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (Number(exitCode) !== 0) {
      yield* Console.error(stderr.trim());
      return yield* Effect.die(`${command} ${commandArgs.join(" ")} failed`);
    }
    return stdout;
  }).pipe(Effect.scoped);

const changes = (from: string) =>
  run("git", ["diff", "--name-status", "-M", `${from}...HEAD`]).pipe(
    Effect.map((text) =>
      text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.split("\t")),
    ),
  );

const refuse = Effect.gen(function* () {
  yield* Console.error(
    `e2e/check-description.ts does not know how to answer \`gh ${args.join(" ")}\`, a read e2e/ci-selection.ts makes. Teach e2e/check-description-gh.ts to answer it from the checkout.`,
  );
  process.exitCode = 3;
});

const answer = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = args.find((arg) => arg.startsWith("repos/"));
  const jq = args.includes("--jq") ? (args[args.indexOf("--jq") + 1] ?? "") : "";
  const main = env("CHECK_DESCRIPTION_MAIN");
  if (args[0] === "pr" && args[1] === "list") {
    const real = env("CHECK_DESCRIPTION_GH");
    if (real !== "") yield* Console.log((yield* run(real, args)).trimEnd());
    return;
  }
  if (args[0] !== "api" || path === undefined) return yield* refuse;
  const route = path.replace(/^repos\/[^/]+\/[^/]+\//, "");
  if (/^pulls\/[^/]+$/.test(route) && jq === '.body // ""')
    return yield* Console.log(yield* fs.readFileString(env("CHECK_DESCRIPTION_FILE")));
  if (/^pulls\/[^/]+\/files$/.test(route) && jq === ".[].filename")
    return yield* Console.log(
      (yield* changes(env("CHECK_DESCRIPTION_BASE")))
        .slice(0, 3000)
        .map(([status, from, to]) => (status!.startsWith("R") ? to : from))
        .join("\n"),
    );
  if (/^compare\/[^/]+\.\.\.[^/]+$/.test(route))
    return yield* Console.log(
      (yield* changes(main))
        .slice(0, 300)
        .flatMap(([status, from, to]) => (status!.startsWith("R") ? [to!, from!] : [from!]))
        .join("\n"),
    );
  if (!route.startsWith("contents/")) return yield* refuse;
  const target = route.slice("contents/".length).replace(/\?.*$/, "");
  if (args.includes("-H"))
    return yield* Console.log(yield* run("git", ["show", `${main}:${target}`]));
  const field =
    jq === '.[] | "\\(.sha) \\(.name)"'
      ? "name"
      : jq === '.[] | "\\(.sha) \\(.path)"'
        ? "path"
        : "";
  if (field === "") return yield* refuse;
  const rows = (yield* run("git", ["ls-tree", main, `${target}/`]))
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((line) => {
      const [meta, file] = line.split("\t");
      const [, type, sha] = meta!.split(" ");
      return type === "blob" ? [`${sha} ${field === "name" ? file!.split("/").at(-1) : file}`] : [];
    });
  yield* Console.log(rows.join("\n"));
});

NodeRuntime.runMain(answer.pipe(Effect.provide(NodeServices.layer)));
