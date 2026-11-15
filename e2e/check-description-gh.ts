/**
 * The `gh` that e2e/check-description.ts puts first on e2e/ci-selection.ts's PATH. It answers each
 * read the selection makes from GitHub with the same text from this checkout, and refuses any
 * other call, so a new read in the selection fails here loudly instead of being answered wrong.
 *
 * - `api repos/<r>/pulls/<n> --jq '.body // ""'`: the description being checked.
 * - `pr list ... --base <branch> ...`: the real `gh` for a pull request given with --pr; otherwise
 *   none, as for a branch with no pull request above it.
 * - `api repos/<r>/compare/<main>...<head> --jq ...`: each file changed on HEAD since main, and a
 *   renamed file's old name.
 * - `api --paginate repos/<r>/pulls/<n>/files --jq '.[].filename'`: the files changed on HEAD
 *   since the base, a renamed file by its new name and a deleted one by its old.
 * - `api repos/<r>/contents/<file>?ref=<main> -H 'Accept: application/vnd.github.raw+json'`: the
 *   file on main.
 * - `api repos/<r>/contents/<directory>?ref=<main> --jq '.[] | "\(.sha) \(.name)"'` (or `.path`):
 *   the directory's files on main with their blob IDs.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, FileSystem, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const args = process.argv.slice(2);
const env = (name: string) => process.env[name] ?? "";

/** Runs a command and returns what it prints, failing the stand-in with its error output. */
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

/** `git diff --name-status` of `from...HEAD`, as `[status, path, renamed-to?]` rows. */
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
  // GitHub lists at most 3,000 of a pull request's files, and 300 of a comparison's.
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
  // The file's text as GitHub serves it raw; a trailing newline more changes no reading of it.
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
