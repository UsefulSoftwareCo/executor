/**
 * The `apps` package staged by `bun run e2e:prepare`: what an author can import from it, read with
 * TypeScript 5.9's compiler API, and whether app source type-checks against it the way the
 * app-authoring skill tells an agent to check it, with the checkout's TypeScript 7 `tsc`. Nothing
 * from the package is executed.
 */
import ts from "typescript-5";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    exports: Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Struct({ types: Schema.String })]),
    ),
  }),
);

class AppsPackageUnreadable extends Schema.TaggedError<AppsPackageUnreadable>()(
  "AppsPackageUnreadable",
  { reason: Schema.String },
) {}

class TypeCheckUnreadable extends Schema.TaggedError<TypeCheckUnreadable>()("TypeCheckUnreadable", {
  exitCode: Schema.Number,
  output: Schema.String,
}) {}

/** One `tsc` diagnostic. `file` and `line` are absent for an option or configuration error. */
export interface TypeProblem {
  readonly file?: string;
  readonly line?: number;
  readonly code: number;
  readonly message: string;
}

// `tsc --pretty false` prints `file(line,column): error TS1234: message`, or `error TS1234:
// message` without a location, and indents the lines that continue a message.
const diagnosticLine = /^(?:(.+)\((\d+),\d+\): )?error TS(\d+): (.*)$/;

/** Unpack the staged archive into `directory` and return the package's root. */
const unpack = Effect.fn(function* (directory: string) {
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const archive = path.resolve(".local/test-runtime/apps.tgz");
  // A relative archive path: GNU tar on Windows reads a drive letter as a remote host.
  const code = yield* processes.exitCode(
    ChildProcess.make("tar", ["-xzf", path.basename(archive), "-C", directory], {
      cwd: path.dirname(archive),
    }),
  );
  if (code !== 0)
    return yield* new AppsPackageUnreadable({
      reason: "Run bun run e2e:prepare to stage the apps package first.",
    });
  return path.join(directory, "package");
});

/** Exported names by module specifier, such as `apps` or `apps/mcp`. */
export const appsPackageExports = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* unpack(
    yield* fs.makeTempDirectoryScoped({ prefix: "executor-apps-package-" }),
  );
  const manifest = yield* Schema.decodeUnknownEffect(Manifest)(
    yield* fs.readFileString(path.join(root, "package.json")),
  );
  const modules = Object.entries(manifest.exports).flatMap(([key, value]) =>
    typeof value === "string"
      ? []
      : [
          {
            module: key === "." ? "apps" : `apps/${key.slice(2)}`,
            file: path.join(root, value.types),
          },
        ],
  );
  const program = ts.createProgram(
    modules.map(({ file }) => file),
    {
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
  );
  const checker = program.getTypeChecker();
  const exports = new Map<string, readonly string[]>();
  for (const { module, file } of modules) {
    const source = program.getSourceFile(file);
    const symbol = source === undefined ? undefined : checker.getSymbolAtLocation(source);
    if (symbol === undefined)
      return yield* new AppsPackageUnreadable({ reason: `${module} has no declaration file` });
    exports.set(
      module,
      checker.getExportsOfModule(symbol).map((exported) => exported.name),
    );
  }
  return exports;
});

/**
 * Compiler diagnostics for app source checked as deploy.md tells an agent to: `tsc --noEmit
 * --strict --skipLibCheck --module nodenext --moduleResolution nodenext --target es2022 index.ts`
 * with the staged package installed. Empty means the source type-checks.
 */
export const strictTypeProblems = Effect.fn(function* (
  files: readonly { readonly path: string; readonly content: string }[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Under the checkout, so the package's own dependencies such as `effect` resolve as installed.
  const directory = yield* fs.makeTempDirectoryScoped({
    directory: path.resolve(".local"),
    prefix: "executor-app-types-",
  });
  yield* fs.makeDirectory(path.join(directory, "node_modules"));
  yield* fs.rename(
    yield* unpack(path.join(directory, "node_modules")),
    path.join(directory, "node_modules", "apps"),
  );
  for (const file of files) {
    yield* fs.makeDirectory(path.dirname(path.join(directory, file.path)), { recursive: true });
    yield* fs.writeFileString(path.join(directory, file.path), file.content);
  }
  // The checkout's tsconfig.json is an ancestor of the directory. With files named, tsc fails on
  // it with TS5112 and checks nothing, so `--ignoreConfig` leaves deploy.md's flags as the whole
  // configuration, as in an app directory without one.
  const child = yield* processes.spawn(
    ChildProcess.make(
      "node",
      [
        path.resolve("node_modules/typescript/bin/tsc"),
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--module",
        "nodenext",
        "--moduleResolution",
        "nodenext",
        "--target",
        "es2022",
        "--pretty",
        "false",
        "index.ts",
      ],
      { cwd: directory },
    ),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  const problems: TypeProblem[] = [];
  const unreadable = () =>
    new TypeCheckUnreadable({ exitCode, output: `${stdout}${stderr}`.trim() });
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const [, file, row, code, message] = diagnosticLine.exec(line) ?? [];
    if (code === undefined || message === undefined) {
      const previous = problems.at(-1);
      if (previous === undefined || !/^\s/.test(line)) return yield* unreadable();
      problems[problems.length - 1] = { ...previous, message: `${previous.message}\n${line}` };
      continue;
    }
    problems.push({
      ...(file === undefined ? {} : { file, line: Number(row) }),
      code: Number(code),
      message,
    });
  }
  // A clean run exits 0 with no diagnostics; anything else must explain its exit status.
  if (stderr.trim() !== "" || (exitCode === 0) !== (problems.length === 0))
    return yield* unreadable();
  return problems;
});
