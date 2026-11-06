/** Drive the real `executor apps` CLI against the managed local server. */
import { expect, layer } from "@effect/vitest";
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Config, Effect, FileSystem, Layer, Option, Path, Redacted, Schema, Stream } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { scenarios } from "../test-plan.ts";
import { Api } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { Evidence } from "../support/evidence.ts";
import { Workspace, helloIndex, helloPackage } from "../support/app-authoring.ts";
import { appsVersion, declaredApps } from "../support/apps-release.ts";
import { localEntryCommand } from "../support/local-entry.ts";
import { throughPipe } from "../support/pipe-readers.ts";

const Catalogs = Schema.fromJsonString(
  Schema.Struct({
    catalogs: Schema.Array(
      Schema.Struct({
        app: Schema.Struct({ slug: Schema.String }),
        skills: Schema.Array(Schema.Struct({ name: Schema.String })),
      }),
    ),
  }),
);
const Document = Schema.fromJsonString(
  Schema.Struct({ content: Schema.String, files: Schema.Array(Schema.String) }),
);
const Created = Schema.fromJsonString(Schema.Struct({ id: Schema.String }));
const Release = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));
/** A failed command's stdout when a program reads it: the error as the CLI describes it. */
const Failure = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({
      code: Schema.String,
      status: Schema.optional(Schema.Number),
      message: Schema.String,
      recovery: Schema.optional(
        Schema.Struct({ action: Schema.String, instructions: Schema.String }),
      ),
      details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      update: Schema.optional(Schema.String),
    }),
  }),
);
const Rejected = Schema.Struct({ reason: Schema.String, paths: Schema.Array(Schema.String) });
const BuildDetails = Schema.Struct({
  stage: Schema.String,
  location: Schema.Struct({ file: Schema.String, line: Schema.Number }),
});
const Apps = Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }));
const Deployed = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});
const Source = Schema.fromJsonString(
  Schema.Struct({ files: Schema.Array(Schema.Struct({ path: Schema.String })) }),
);
/** A CLI commit prints its new revision and the files it removed, never the files it sent. */
const Committed = Schema.fromJsonString(
  Schema.Struct({
    revision: Workspace.fields.revision,
    removed: Schema.Struct({ count: Schema.Number, paths: Schema.Array(Schema.String) }),
  }),
);

/** The real CLI, run as a child process against the managed local server with its own home. */
const cli = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path,
    processes = yield* ChildProcessSpawner.ChildProcessSpawner,
    target = yield* Target,
    evidence = yield* Evidence;
  const packagedEntry = yield* Config.NonEmptyString("EXECUTOR_E2E_LOCAL_ENTRY").pipe(
    Config.option,
  );
  // The packaged entry is JavaScript; Windows cannot execute it directly. Commands may run from
  // another directory, so the entry is absolute.
  const entry = path.resolve(
    Option.isSome(packagedEntry) ? packagedEntry.value : "apps/local/server/src/bin.ts",
  );
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "executor-apps-cli-" });
  const origin = target.metadata.origin;
  const environment = (signedIn: boolean, extra: Record<string, string> = {}) => ({
    PATH: process.env.PATH ?? "",
    HOME: home,
    // Release scenarios never send product analytics, even from a build with a baked key.
    DO_NOT_TRACK: "1",
    ...(signedIn ? { EXECUTOR_API_KEY: Redacted.value(target.apiKey) } : {}),
    ...extra,
  });
  const run = (
    args: readonly string[],
    signedIn: boolean,
    cwd?: string,
    extra: Record<string, string> = {},
    slowReader = false,
  ) =>
    evidence.step(
      `executor apps ${args.join(" ")}`,
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* processes.spawn(
            ChildProcess.make(
              localEntryCommand(entry, ["apps", ...args]).command,
              localEntryCommand(entry, ["apps", ...args]).args,
              {
                cwd,
                extendEnv: false,
                env: environment(signedIn, extra),
                stdout: "pipe",
                stderr: "pipe",
                forceKillAfter: "3 seconds",
              },
            ),
          );
          // A slow reader takes nothing until the CLI exits or has waited a second for the
          // pipe, which holds 64 KiB.
          if (slowReader) yield* child.exitCode.pipe(Effect.timeoutOption("1 second"));
          const [code, stdout, stderr] = yield* Effect.all(
            [
              child.exitCode,
              child.stdout.pipe(Stream.decodeText(), Stream.mkString),
              child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            ],
            { concurrency: 3 },
          ).pipe(Effect.timeout("60 seconds"));
          return { code: Number(code), stdout, stderr };
        }),
      ),
    );
  const runTool = (name: string, command: string, args: readonly string[], cwd: string) =>
    evidence.step(
      name,
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* processes.spawn(
            ChildProcess.make(command, args, {
              cwd,
              extendEnv: false,
              env: {
                PATH: process.env.PATH ?? "",
                HOME: home,
                DO_NOT_TRACK: "1",
              },
              stdout: "pipe",
              stderr: "pipe",
              forceKillAfter: "3 seconds",
            }),
          );
          const [code, stdout, stderr] = yield* Effect.all(
            [
              child.exitCode,
              child.stdout.pipe(Stream.decodeText(), Stream.mkString),
              child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            ],
            { concurrency: 3 },
          ).pipe(Effect.timeout("60 seconds"));
          return { code: Number(code), stdout, stderr };
        }),
      ),
    );
  const writeOxlintConfig = (cwd: string) =>
    runTool(
      "Load appConfig from the built apps package",
      "node",
      [
        "--input-type=module",
        "--eval",
        'import { writeFile } from "node:fs/promises"; import { appConfig } from "apps/oxlint"; await writeFile(".oxlintrc.json", JSON.stringify(appConfig()));',
      ],
      cwd,
    );
  const oxlint = (name: string, cwd: string) =>
    runTool(
      name,
      path.resolve(process.cwd(), "node_modules/.bin/oxlint"),
      [
        "--threads=2",
        "--config",
        ".oxlintrc.json",
        "--no-ignore",
        "--format",
        "json",
        "index.ts",
        "src/index.ts",
        "ui/index.ts",
        "src/commonjs.cjs",
        "src/shadowed-module.cjs",
        "ui/commonjs.cjs",
        "helpers.ts",
        "operations.ts",
      ],
      cwd,
    );
  return { run, oxlint, writeOxlintConfig, origin, fs, path, entry, environment };
});

layer(TestLive, { excludeTestServices: true })("Local apps CLI", (it) => {
  it.effect(scenarios.localAppsCli.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          evidence = yield* Evidence,
          api = yield* Api;
        const { run, origin, fs } = yield* cli;

        const signedOut = yield* run(["list", "--host", origin], false);
        yield* evidence.json("signed-out.json", signedOut);
        expect(signedOut.code).toBe(1);
        expect(signedOut.stderr).toContain(
          "run executor apps login --host https://api.executor.sh and pass the same --host",
        );
        expect(signedOut.stderr).toContain(
          "Without --host or EXECUTOR_HOST, commands use the local background Executor; for a local server at --host, set EXECUTOR_API_KEY to its API key.",
        );

        const listed = yield* run(["skills", "--host", origin], true);
        yield* evidence.json("skills-list.json", listed);
        expect(listed.code, listed.stderr).toBe(0);
        const catalogs = yield* Schema.decodeUnknownEffect(Catalogs)(listed.stdout);
        expect(
          catalogs.catalogs
            .find((catalog) => catalog.app.slug === "executor")
            ?.skills.map((skill) => skill.name)
            .toSorted(),
        ).toEqual(["app-authoring", "code-mode", "executor"]);

        // Agents read the entry skill first; it links to the authoring guide.
        const entry = yield* run(
          ["skills", "--host", origin, "--app", "executor", "--name", "executor"],
          true,
        );
        expect(entry.code, entry.stderr).toBe(0);
        const entryDocument = yield* Schema.decodeUnknownEffect(Document)(entry.stdout);
        expect(entryDocument.content).toContain("# Executor");
        expect(entryDocument.content).toContain("`app-authoring`");
        expect(entryDocument.files).toContain("feedback.md");

        const guide = yield* run(
          ["skills", "--host", origin, "--app", "executor", "--name", "app-authoring"],
          true,
        );
        expect(guide.code, guide.stderr).toBe(0);
        const document = yield* Schema.decodeUnknownEffect(Document)(guide.stdout);
        expect(document.content).toContain("# Build an Executor app");
        expect(document.files).toContain("ui.md");

        const topic = yield* run(
          [
            "skills",
            "--host",
            origin,
            "--app",
            "executor",
            "--name",
            "app-authoring",
            "--file",
            "ui.md",
          ],
          true,
        );
        expect(topic.code, topic.stderr).toBe(0);
        expect((yield* Schema.decodeUnknownEffect(Document)(topic.stdout)).content).toContain(
          "withOptimisticUpdate",
        );

        const missingName = yield* run(["skills", "--host", origin, "--file", "ui.md"], true);
        expect(missingName.code).toBe(1);
        expect(missingName.stderr).toContain("Pass --name with --file.");

        const unknownApp = yield* run(
          ["skills", "--host", origin, "--app", "missing-app-slug"],
          true,
        );
        expect(unknownApp.code).toBe(1);
        expect(unknownApp.stderr).toContain("No visible app has slug or ID missing-app-slug.");

        // A source directory is read recursively, without dependency or Git folders.
        const source = yield* fs.makeTempDirectoryScoped({ prefix: "executor-apps-source-" });
        yield* fs.makeDirectory(`${source}/lib`);
        yield* fs.makeDirectory(`${source}/node_modules/ignored`, { recursive: true });
        yield* fs.makeDirectory(`${source}/.git`);
        yield* fs.writeFileString(
          `${source}/index.ts`,
          'import { defineApp, router } from "apps";\nimport { label } from "./lib/label.ts";\nexport default defineApp({}, async () => ({ tools: router({}) }));\nvoid label;\n',
        );
        yield* fs.writeFileString(`${source}/lib/label.ts`, 'export const label = "cli";\n');
        yield* fs.writeFileString(`${source}/node_modules/ignored/index.js`, "ignored\n");
        yield* fs.writeFileString(`${source}/.git/HEAD`, "ref: refs/heads/main\n");
        const created = yield* run(
          ["create", "--host", origin, "--name", "CLI directory source", "--files", source],
          true,
        );
        expect(created.code, created.stderr).toBe(0);
        const app = yield* Schema.decodeUnknownEffect(Created)(created.stdout);
        const session = yield* api.session();
        yield* Effect.addFinalizer(() =>
          session
            .send("DELETE", `/v1/apps/${app.id}`, undefined, {
              authorization: `Bearer ${Redacted.value(target.apiKey)}`,
            })
            .pipe(Effect.orDie),
        );
        const read = yield* run(["source", "--host", origin, "--app", app.id], true);
        expect(read.code, read.stderr).toBe(0);
        expect(
          (yield* Schema.decodeUnknownEffect(Source)(read.stdout)).files
            .map((file) => file.path)
            .sort(),
        ).toEqual(["index.ts", "lib/label.ts"]);
        // The directory declares no apps release, so deploying it is refused with the one to add.
        const directory = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Workspace))(
          read.stdout,
        );
        const refused = yield* run(
          ["deploy", "--host", origin, "--app", app.id, "--commit", directory.revision.commit],
          true,
        );
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain(
          `Add "apps": "${appsVersion}" to package.json dependencies.`,
        );

        // Committing the current directory prints the new revision, which the next read reports,
        // and that it removed no file: the skipped dependency and Git folders were never saved.
        yield* fs.writeFileString(`${source}/lib/label.ts`, 'export const label = "edited";\n');
        const committed = yield* run(
          [
            "commit",
            "--host",
            origin,
            "--app",
            app.id,
            "--files",
            ".",
            "--expected",
            directory.revision.commit,
            "--message",
            "Edit the label",
          ],
          true,
          source,
        );
        yield* evidence.json("commit.json", committed);
        expect(committed.code, committed.stderr).toBe(0);
        const saved = yield* Schema.decodeUnknownEffect(Committed)(committed.stdout, {
          onExcessProperty: "error",
        });
        expect(saved.revision.code).toBe(directory.revision.code);
        expect(saved.revision.commit).not.toBe(directory.revision.commit);
        expect(saved.removed).toEqual({ count: 0, paths: [] });
        const edited = yield* run(["source", "--host", origin, "--app", app.id], true);
        expect(edited.code, edited.stderr).toBe(0);
        const after = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Workspace))(
          edited.stdout,
        );
        expect(after.revision).toEqual(saved.revision);
        expect(after.files.find((file) => file.path === "lib/label.ts")?.content).toBe(
          'export const label = "edited";\n',
        );
      }),
    ),
  );
  it.effect(scenarios.localAppsCliPipedOutput.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          evidence = yield* Evidence,
          api = yield* Api;
        const { run, origin, fs, entry, environment } = yield* cli;
        const session = yield* api.session();
        // About 2 MiB, thirty times what a pipe holds; numbered lines show where a cut fell.
        const notes = Array.from(
          { length: 40_000 },
          (_, line) => `line ${line} ${"x".repeat(40)}\n`,
        ).join("");
        const source = yield* fs.makeTempDirectoryScoped({ prefix: "executor-apps-piped-" });
        yield* fs.writeFileString(`${source}/index.ts`, helloIndex);
        yield* fs.writeFileString(`${source}/package.json`, `${helloPackage(appsVersion)}\n`);
        yield* fs.writeFileString(`${source}/notes.txt`, notes);
        const created = yield* run(
          ["create", "--host", origin, "--name", "CLI piped source", "--files", source],
          true,
        );
        expect(created.code, created.stderr).toBe(0);
        const app = yield* Schema.decodeUnknownEffect(Created)(created.stdout);
        yield* Effect.addFinalizer(() =>
          session
            .send("DELETE", `/v1/apps/${app.id}`, undefined, {
              authorization: `Bearer ${Redacted.value(target.apiKey)}`,
            })
            .pipe(Effect.orDie),
        );

        // The release executable's output stopped at the 65,536 bytes the pipe took first, with
        // exit code 0, and a program parsing it read JSON cut mid-string.
        const read = yield* run(
          ["source", "--host", origin, "--app", app.id],
          true,
          undefined,
          {},
          true,
        );
        const printed = Buffer.byteLength(read.stdout);
        yield* evidence.json("piped-source.json", {
          code: read.code,
          stdoutBytes: printed,
          stderr: read.stderr,
        });
        expect(read.code, read.stderr).toBe(0);
        expect(printed).toBeGreaterThan(notes.length);
        const files = (yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Deployed))(
          read.stdout,
        )).files;
        expect(files.find((file) => file.path === "notes.txt")?.content).toBe(notes);

        // A reader that closes the pipe early, as `| head -c 100` does, ends the command quietly.
        // An unhandled EPIPE failed it with exit code 1 and a stack trace.
        const head = yield* throughPipe(
          { mode: "head", bytes: 100 },
          localEntryCommand(entry, ["apps", "source", "--host", origin, "--app", app.id]),
          environment(true),
        );
        yield* evidence.json("head-c-100.json", head);
        expect(head.read).toBeGreaterThanOrEqual(100);
        expect(head.stderr).toBe("");
        expect(head.code).toBe(0);
        expect(head.millisecondsAfterClose).toBeLessThan(5_000);
      }),
    ),
  );
  it.effect(scenarios.localAppsCliRelease.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          evidence = yield* Evidence,
          api = yield* Api;
        const { run, oxlint, writeOxlintConfig, origin, fs, path } = yield* cli;
        const session = yield* api.session();
        // The host reports the exact apps release; the CLI holds no version of its own.
        const framework = yield* run(["framework", "--host", origin], true);
        expect(framework.code, framework.stderr).toBe(0);
        const { version } = yield* Schema.decodeUnknownEffect(Release)(framework.stdout);
        expect(version).toBe(appsVersion);

        // Create requires the source, and its help names the command that prints the version.
        const withoutFiles = yield* run(["create", "--host", origin, "--name", "No files"], true);
        yield* evidence.json("create-without-files.json", withoutFiles);
        expect(withoutFiles.code).toBe(1);
        expect(withoutFiles.stderr).toContain("Missing required flag: --files");
        expect(withoutFiles.stdout).toContain(
          "a package.json whose dependencies.apps is the version executor apps framework prints",
        );

        // deploy.md's CLI flow: index.ts and a package.json pinning that version, then create,
        // read the first commit and deploy it.
        const hello = yield* fs.makeTempDirectoryScoped({ prefix: "executor-apps-hello-" });
        yield* fs.writeFileString(`${hello}/index.ts`, helloIndex);
        yield* fs.writeFileString(`${hello}/package.json`, `${helloPackage(version)}\n`);
        const checked = yield* run(["check", "--files", "."], false, hello);
        expect(checked.code, checked.stderr).toBe(0);
        expect(JSON.parse(checked.stdout)).toMatchObject({ ok: true, files: 2, issues: [] });

        // An exact pin stays as tested. Offline check does not compare it with this host or rewrite it.
        const testedPin = "0.0.1-beta.90";
        yield* fs.writeFileString(`${hello}/package.json`, `${helloPackage(testedPin)}\n`);
        const preserved = yield* run(["check", "--files", "."], false, hello);
        expect(preserved.code, preserved.stderr).toBe(0);
        expect(yield* fs.readFileString(`${hello}/package.json`)).toContain(testedPin);

        const rangePin = `^${testedPin}`;
        yield* fs.writeFileString(`${hello}/package.json`, `${helloPackage(rangePin)}\n`);
        const range = yield* run(["check", "--files", "."], false, hello);
        expect(range.code).toBe(1);
        expect(range.stderr).toBe("");
        expect(JSON.parse(range.stdout)).toMatchObject({
          ok: false,
          issues: [
            { code: "framework-pin", message: "dependencies.apps must be an exact version" },
          ],
        });
        expect(yield* fs.readFileString(`${hello}/package.json`)).toContain(rangePin);

        yield* fs.writeFileString(`${hello}/package.json`, `${helloPackage(version)}\n`);

        // The shared config loads the published package by specifier, checks only the root entry,
        // and permits browser HTTP under ui/.
        const localRoot = yield* fs.makeTempDirectoryScoped({
          directory: process.cwd() + "/.local",
          prefix: "executor-apps-oxlint-",
        });
        yield* fs.makeDirectory(`${localRoot}/node_modules`);
        yield* fs.symlink(
          path.resolve(process.cwd(), "packages/apps/dist"),
          `${localRoot}/node_modules/apps`,
        );
        yield* fs.writeFileString(`${localRoot}/index.ts`, helloIndex);
        yield* fs.makeDirectory(`${localRoot}/src`);
        yield* fs.writeFileString(
          `${localRoot}/src/index.ts`,
          `import { object, query } from "apps";
import defaultHelper from "../helpers.ts";
import * as helpers from "../helpers.ts";
const { mutation: dtoMutation, write: dtoWrite } = await import("../helpers.ts");
const { write: unrelated } = helpers;
defaultHelper(); dtoMutation({}); dtoWrite({}); unrelated({});
export const helper = (fetch: (url: string) => unknown) => fetch("https://example.test");
export const request = (ctx: { fetch: (url: string) => unknown }) => { const { fetch: send } = ctx; return send("https://example.test"); };
export const readDto = query({ input: object({}) }, (_ctx, dto: { accounts: string[] }) => dto.accounts);
`,
        );
        yield* fs.makeDirectory(`${localRoot}/ui`);
        yield* fs.writeFileString(
          `${localRoot}/ui/index.ts`,
          'void fetch("https://example.test");\n',
        );
        yield* fs.writeFileString(
          `${localRoot}/src/commonjs.cjs`,
          'const helper = "server";\nvoid helper;\n',
        );
        yield* fs.writeFileString(
          `${localRoot}/src/shadowed-module.cjs`,
          'function ordinaryHelper(module) { return module.require("ordinary-helper"); }\nvoid ordinaryHelper;\n',
        );
        yield* fs.writeFileString(
          `${localRoot}/ui/commonjs.cjs`,
          'const helper = "browser";\nvoid helper;\n',
        );
        yield* fs.writeFileString(`${localRoot}/package.json`, `${helloPackage(version)}\n`);
        yield* fs.writeFileString(
          `${localRoot}/helpers.ts`,
          `const dto = { mutation: () => null, write: () => null };
export const { mutation, write } = dto;
let ordinary;
ordinary = write;
export default ordinary;
`,
        );
        yield* fs.writeFileString(
          `${localRoot}/operations.ts`,
          `import { mutation as write, decodeJson } from "apps";
export const approved = write({ approval: undefined }, async (ctx) => {
  const response = await ctx.fetch("https://example.test");
  return decodeJson(response, {});
});
`,
        );
        const config = yield* writeOxlintConfig(localRoot);
        expect(config.code, config.stderr).toBe(0);
        const accepted = yield* oxlint("Oxlint accepts app, nested, and browser source", localRoot);
        yield* evidence.json("oxlint-valid.json", accepted);
        expect(accepted.code, accepted.stderr).toBe(0);

        // CommonJS loader globals are rejected in server and browser helpers. A local `module`
        // parameter remains legal, and the ordinary ESM helper controls above stay valid.
        yield* fs.writeFileString(
          `${localRoot}/src/commonjs.cjs`,
          'const direct = require("apps");\nconst loaded = module.require("apps");\nconst alias = module;\nalias.require("apps");\nvoid [direct, loaded];\n',
        );
        yield* fs.writeFileString(
          `${localRoot}/ui/commonjs.cjs`,
          'module.require("browser-helper");\n',
        );
        const commonJsRejected = yield* oxlint(
          "Oxlint rejects CommonJS server and UI helpers",
          localRoot,
        );
        yield* evidence.json("oxlint-commonjs.json", commonJsRejected);
        expect(commonJsRejected.code).toBe(1);
        expect(commonJsRejected.stderr).toBe("");
        const commonJsDiagnostics = JSON.parse(commonJsRejected.stdout).diagnostics;
        const serverCommonJs = commonJsDiagnostics.filter(
          (diagnostic: { filename: string }) => diagnostic.filename === "src/commonjs.cjs",
        );
        const uiCommonJs = commonJsDiagnostics.filter(
          (diagnostic: { filename: string }) => diagnostic.filename === "ui/commonjs.cjs",
        );
        expect(serverCommonJs).toHaveLength(3);
        expect(uiCommonJs).toHaveLength(1);
        expect(
          [...serverCommonJs, ...uiCommonJs].every(
            (diagnostic: { code: string }) => diagnostic.code === "eslint(no-restricted-globals)",
          ),
        ).toBe(true);
        expect(
          commonJsDiagnostics.some(
            (diagnostic: { filename: string }) => diagnostic.filename === "src/shadowed-module.cjs",
          ),
        ).toBe(false);
        yield* fs.writeFileString(
          `${localRoot}/src/commonjs.cjs`,
          'const helper = "server";\nvoid helper;\n',
        );
        yield* fs.writeFileString(
          `${localRoot}/ui/commonjs.cjs`,
          'const helper = "browser";\nvoid helper;\n',
        );

        yield* fs.writeFileString(
          `${localRoot}/index.ts`,
          `import { defineApp, mutation, object, router, type QueryContext } from "apps";
import { Effect } from "effect";
const direct = mutation({ input: object({}) }, async () => null);
let requirements;
requirements = { accounts: {} };
const legacy = defineApp(requirements, { tools: router({}) });
const readLegacy = (ctx: QueryContext<{}>) => { let old; old = ctx; return old.accounts; };
const host = globalThis;
host.fetch("https://example.test");
export const app = defineApp({}, { tools: router({ direct }) });
void [Effect, legacy, readLegacy];
`,
        );
        const rejected = yield* oxlint("Oxlint reports app-authoring violations", localRoot);
        yield* evidence.json("oxlint-invalid.json", rejected);
        expect(rejected.code).toBe(1);
        expect(rejected.stdout).toContain("Use `export default defineApp(...)` directly");
        expect(rejected.stdout).toContain("Every `mutation` must explicitly declare");
        const mutationDiagnostics = JSON.parse(rejected.stdout).diagnostics.filter(
          (diagnostic: { code: string }) => diagnostic.code === "executor-apps(mutation-approval)",
        );
        expect(mutationDiagnostics).toHaveLength(1);
        expect(rejected.stdout).toContain(
          "Legacy top-level `accounts` requirements are unsupported",
        );
        expect(rejected.stdout).toContain(
          "Read accounts through `ctx.user.accounts` or `ctx.app.accounts`",
        );
        expect(rejected.stdout).toContain("this fetch comes from a global object");
        expect(rejected.stdout).toContain(
          "CommonJS loaders, Effect and the Executor SDK are unsupported in app source.",
        );

        const helperBindings = [
          {
            name: "default import",
            helper: 'export { mutation as default } from "apps";\n',
            consumer: 'import write from "./operations.ts";\n',
          },
          {
            name: "local dynamic import",
            helper: 'export { mutation as write } from "apps";\n',
            consumer: 'const { write } = await import("./operations.ts");\n',
          },
          {
            name: "destructured namespace export",
            helper: 'import * as api from "apps"; export const { mutation: write } = api;\n',
            consumer: 'import { write } from "./operations.ts";\n',
          },
          {
            name: "late-assigned export",
            helper:
              'import { mutation } from "apps"; let write; write = mutation; export { write };\n',
            consumer: 'import { write } from "./operations.ts";\n',
          },
          {
            name: "multi-declarator export",
            helper: 'import { mutation } from "apps"; export const marker = 1, write = mutation;\n',
            consumer: 'import { write } from "./operations.ts";\n',
          },
          {
            name: "local late assignment",
            helper: 'import { mutation } from "apps"; let write; write = mutation;\n',
            consumer: 'import { write } from "./operations.ts";\n',
          },
        ];
        for (const { name, helper, consumer } of helperBindings) {
          yield* fs.writeFileString(`${localRoot}/operations.ts`, helper);
          for (const approval of ["", "approval: undefined, "]) {
            yield* fs.writeFileString(
              `${localRoot}/index.ts`,
              `import { defineApp, object, router } from "apps";\n${consumer}const change = write({ ${approval}input: object({}) }, async () => null);\nexport default defineApp({}, { tools: router({ change }) });\n`,
            );
            const helperRejected = yield* oxlint(
              `Oxlint rejects ${name} even with ${approval ? "approval" : "no approval"}`,
              localRoot,
            );
            yield* evidence.json(
              `oxlint-${name.replaceAll(" ", "-")}-${approval ? "approved" : "unapproved"}.json`,
              helperRejected,
            );
            expect(helperRejected.code).toBe(1);
            expect(helperRejected.stderr).toBe("");
            const helperDiagnostics = JSON.parse(helperRejected.stdout).diagnostics;
            expect(helperDiagnostics).toHaveLength(1);
            expect(helperDiagnostics[0].code).toBe("executor-apps(plain-framework-bindings)");
            expect(helperDiagnostics[0].filename).toBe("operations.ts");
            expect(helperDiagnostics[0].message).toContain("Use named imports from `apps`");
          }
        }
        const contextTypeBarrels = [
          {
            name: "context type re-export",
            helper: 'export type { QueryContext } from "apps";\n',
            consumer: 'import type { QueryContext } from "./operations.ts";\n',
            use: "const read = (ctx: QueryContext<{}>) => ctx.accounts; void read;",
          },
          {
            name: "context type alias export",
            helper:
              'import type { QueryContext as Query, MutationContext as Mutation } from "apps"; export type { Query, Mutation };\n',
            consumer: 'import type { Query, Mutation } from "./operations.ts";\n',
            use: "const read = (ctx: Query<{}>) => ctx.accounts; const write = (ctx: Mutation<{}>) => ctx.accounts; void [read, write];",
          },
        ];
        for (const { name, helper, consumer, use } of contextTypeBarrels) {
          yield* fs.writeFileString(`${localRoot}/operations.ts`, helper);
          yield* fs.writeFileString(
            `${localRoot}/index.ts`,
            `import { defineApp, router } from "apps";\n${consumer}${use}\nexport default defineApp({}, { tools: router({}) });\n`,
          );
          const typeBarrelRejected = yield* oxlint(`Oxlint rejects ${name}`, localRoot);
          yield* evidence.json(`oxlint-${name.replaceAll(" ", "-")}.json`, typeBarrelRejected);
          expect(typeBarrelRejected.code).toBe(1);
          expect(typeBarrelRejected.stderr).toBe("");
          const diagnostics = JSON.parse(typeBarrelRejected.stdout).diagnostics;
          expect(diagnostics).toHaveLength(1);
          expect(diagnostics[0].code).toBe("executor-apps(plain-framework-bindings)");
          expect(diagnostics[0].filename).toBe("operations.ts");
        }

        const created = yield* run(
          ["create", "--host", origin, "--name", "CLI hello", "--files", hello],
          true,
        );
        expect(created.code, created.stderr).toBe(0);
        const app = yield* Schema.decodeUnknownEffect(Created)(created.stdout);
        yield* Effect.addFinalizer(() =>
          session
            .send("DELETE", `/v1/apps/${app.id}`, undefined, {
              authorization: `Bearer ${Redacted.value(target.apiKey)}`,
            })
            .pipe(Effect.orDie),
        );
        const source = yield* run(["source", "--host", origin, "--app", app.id], true);
        expect(source.code, source.stderr).toBe(0);
        const workspace = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Workspace))(
          source.stdout,
        );
        expect(declaredApps(workspace.files)).toBe(appsVersion);
        const deployed = yield* run(
          ["deploy", "--host", origin, "--app", app.id, "--commit", workspace.revision.commit],
          true,
        );
        expect(deployed.code, deployed.stderr).toBe(0);

        // The host-managed Executor app is generated with the same pinned release.
        const inventory = yield* session.send("GET", "/v1/apps", undefined, {
          authorization: `Bearer ${Redacted.value(target.apiKey)}`,
        });
        const executorApp = (yield* Schema.decodeUnknownEffect(Apps)(inventory.body)).find(
          (app) => app.name === "Executor",
        );
        expect(executorApp, "the local Executor app").toBeDefined();
        const executorSource = yield* session.send(
          "GET",
          `/v1/apps/${executorApp?.id ?? ""}/source`,
          undefined,
          { authorization: `Bearer ${Redacted.value(target.apiKey)}` },
        );
        expect(executorSource.status).toBe(200);
        expect(
          declaredApps((yield* Schema.decodeUnknownEffect(Deployed)(executorSource.body)).files),
        ).toBe(appsVersion);
      }),
    ),
  );
  it.effect(scenarios.localAppsCliFailures.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          evidence = yield* Evidence,
          api = yield* Api;
        const { run, origin, fs } = yield* cli;
        const session = yield* api.session();
        const remove = (id: string) =>
          Effect.addFinalizer(() =>
            session
              .send("DELETE", `/v1/apps/${id}`, undefined, {
                authorization: `Bearer ${Redacted.value(target.apiKey)}`,
              })
              .pipe(Effect.orDie),
          );
        const listedNames = Effect.gen(function* () {
          // EXECUTOR_HOST stands in for --host.
          const listed = yield* run(["list"], true, undefined, { EXECUTOR_HOST: origin });
          expect(listed.code, listed.stderr).toBe(0);
          return (yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Apps))(
            listed.stdout,
          )).map((app) => app.name);
        });

        // --files also takes a JSON list of files.
        const listFile = `${yield* fs.makeTempDirectoryScoped({ prefix: "executor-apps-json-" })}/files.json`;
        yield* fs.writeFileString(
          listFile,
          JSON.stringify([
            { path: "index.ts", content: helloIndex },
            { path: "package.json", content: helloPackage(appsVersion) },
          ]),
        );
        const created = yield* run(
          ["create", "--host", origin, "--name", "CLI JSON source", "--files", listFile],
          true,
        );
        expect(created.code, created.stderr).toBe(0);
        const app = yield* Schema.decodeUnknownEffect(Created)(created.stdout);
        yield* remove(app.id);
        const read = yield* run(["source", "--host", origin, "--app", app.id], true);
        const first = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Workspace))(
          read.stdout,
        );

        // A failed build reports its stage and source location.
        const failing = yield* fs.makeTempDirectoryScoped({ prefix: "executor-apps-failing-" });
        yield* fs.writeFileString(
          `${failing}/index.ts`,
          helloIndex.replace(
            'from "apps";\n',
            'from "apps";\n\nthrow new Error("Synthetic declaration failure");\n',
          ),
        );
        yield* fs.writeFileString(`${failing}/package.json`, helloPackage(appsVersion));
        const saved = yield* run(
          [
            "commit",
            "--host",
            origin,
            "--app",
            app.id,
            "--files",
            failing,
            "--expected",
            first.revision.commit,
            "--message",
            "Fail while declaring",
          ],
          true,
        );
        expect(saved.code, saved.stderr).toBe(0);
        const commit = (yield* Schema.decodeUnknownEffect(Committed)(saved.stdout)).revision.commit;
        const build = yield* run(
          ["deploy", "--host", origin, "--app", app.id, "--commit", commit],
          true,
        );
        yield* evidence.json("failed-build.json", build);
        expect(build.code).toBe(1);
        expect(build.stderr).toContain("Code: VersionBuildFailed (HTTP 422)");
        expect(build.stderr).toContain("Synthetic declaration failure");
        const failed = (yield* Schema.decodeUnknownEffect(Failure)(build.stdout)).error;
        expect(failed.code).toBe("VersionBuildFailed");
        expect(failed.status).toBe(422);
        expect(failed.message).toContain("Synthetic declaration failure");
        const details = yield* Schema.decodeUnknownEffect(BuildDetails)(failed.details);
        expect(details).toMatchObject({
          stage: "declaration",
          location: { file: "index.ts", line: 3 },
        });

        // The build saved a newer commit, so a save against the first one is stale. A host error
        // keeps its code, status, message and fields, on stderr and as JSON on stdout.
        const stale = yield* run(
          [
            "commit",
            "--host",
            origin,
            "--app",
            app.id,
            "--files",
            listFile,
            "--expected",
            first.revision.commit,
            "--message",
            "Stale edit",
          ],
          true,
        );
        yield* evidence.json("stale-commit.json", stale);
        expect(stale.code).toBe(1);
        expect(stale.stderr).toContain("Code: SourceError (HTTP 409)");
        expect(stale.stderr).toContain("The app's source changed since it was read.");
        const conflict = (yield* Schema.decodeUnknownEffect(Failure)(stale.stdout)).error;
        expect(conflict).toMatchObject({
          code: "SourceError",
          status: 409,
          details: { reason: "conflict" },
        });

        // Source over Executor's limits, or not UTF-8 text, is refused before anything is uploaded.
        const refused = (name: string, directory: string) =>
          Effect.gen(function* () {
            const result = yield* run(
              ["create", "--host", origin, "--name", name, "--files", directory],
              true,
            );
            yield* evidence.json(`${name}.json`, result);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain("Nothing was uploaded.");
            expect(result.stderr).toContain("Code: SourceRejected");
            const error = (yield* Schema.decodeUnknownEffect(Failure)(result.stdout)).error;
            expect(error.code).toBe("SourceRejected");
            return {
              stderr: result.stderr,
              ...(yield* Schema.decodeUnknownEffect(Rejected)(error.details)),
            };
          });
        const many = yield* fs.makeTempDirectoryScoped({ prefix: "executor-apps-many-" });
        yield* fs.writeFileString(`${many}/index.ts`, helloIndex);
        yield* Effect.forEach(
          Array.from({ length: 4096 }, (_, index) => index),
          (index) =>
            fs.writeFileString(`${many}/file-${index}.ts`, `export const value = ${index};\n`),
          { concurrency: 64 },
        );
        const tooMany = yield* refused("too-many-files", many);
        expect(tooMany.reason).toBe("files");
        expect(tooMany.stderr).toContain(
          "The source has 4,097 files; Executor accepts at most 4,096.",
        );

        const large = yield* fs.makeTempDirectoryScoped({ prefix: "executor-apps-large-" });
        yield* fs.writeFileString(`${large}/index.ts`, helloIndex);
        yield* fs.writeFileString(`${large}/large.txt`, "x".repeat(17 * 1024 * 1024));
        const tooLarge = yield* refused("too-many-bytes", large);
        expect(tooLarge.reason).toBe("bytes");
        expect(tooLarge.paths[0]).toBe("large.txt");
        expect(tooLarge.stderr).toContain("Executor accepts at most 16 MiB (16,777,216 bytes)");

        const checkedLarge = yield* run(["check", "--files", large], false, large);
        yield* evidence.json("check-too-many-bytes.json", checkedLarge);
        expect(checkedLarge.code).toBe(1);
        expect(checkedLarge.stderr).toBe("");
        expect(JSON.parse(checkedLarge.stdout).issues[0].message).toContain(
          "Executor accepts at most 16 MiB (16,777,216 bytes)",
        );

        const binary = yield* fs.makeTempDirectoryScoped({ prefix: "executor-apps-binary-" });
        yield* fs.makeDirectory(`${binary}/assets`, { recursive: true });
        yield* fs.writeFileString(`${binary}/index.ts`, helloIndex);
        yield* fs.writeFile(
          `${binary}/assets/logo.png`,
          Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]),
        );
        const notText = yield* refused("binary-files", binary);
        expect(notText.reason).toBe("binary");
        expect(notText.paths).toEqual(["assets/logo.png"]);
        expect(notText.stderr).toContain("1 file is not: assets/logo.png");

        const names = yield* listedNames;
        expect(names).toContain("CLI JSON source");
        for (const name of ["too-many-files", "too-many-bytes", "binary-files"])
          expect(names).not.toContain(name);

        // A host that does not answer is named as such, with what to check.
        const unreachable = yield* run(["list", "--host", "http://127.0.0.1:9"], true);
        expect(unreachable.code).toBe(1);
        expect(unreachable.stderr).toContain("Code: HostUnreachable");
        expect((yield* Schema.decodeUnknownEffect(Failure)(unreachable.stdout)).error.code).toBe(
          "HostUnreachable",
        );

        // A failed command from a CLI older than the published release says so, on stderr and
        // in the JSON error. A current CLI, or a registry that does not answer, adds nothing.
        // A packaged CLI keeps its own release version, so the registry answers relative to it.
        const environment = (registryUrl: string) => ({
          EXECUTOR_BUILD_VERSION: "2.0.0-beta.2",
          EXECUTOR_NPM_REGISTRY: registryUrl,
        });
        const printed = yield* run(["--version"], false, undefined, environment(""));
        const version = printed.stdout.trim().replace(/^executor v/u, "");
        let published: Record<string, string> = { beta: "2.999.0-beta.1", latest: "2.999.0" };
        const services = yield* Layer.build(
          HttpRouter.serve(
            HttpRouter.add(
              "GET",
              "/-/package/executor/dist-tags",
              Effect.suspend(() => HttpServerResponse.json(published)),
            ),
            { disableLogger: true, disableListenLog: true },
          ).pipe(
            Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
          ),
        );
        const registry = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
        if (!("port" in registry.address)) return yield* Effect.die("Registry must listen on TCP");
        const local = `http://127.0.0.1:${registry.address.port}`;
        const failsWith = (registryUrl: string) =>
          run(["list", "--host", "http://127.0.0.1:9"], true, undefined, environment(registryUrl));
        const outdated = yield* failsWith(local);
        yield* evidence.json("outdated-cli.json", outdated);
        const update = `This CLI (v${version}) is out of date; the latest is v2.999.0. Run: executor upgrade`;
        expect(outdated.code).toBe(1);
        expect(outdated.stderr).toContain("Code: HostUnreachable");
        expect(outdated.stderr).toContain(update);
        expect((yield* Schema.decodeUnknownEffect(Failure)(outdated.stdout)).error.update).toBe(
          update,
        );
        published = { beta: version, latest: version };
        const current = yield* failsWith(local);
        expect(current.code).toBe(1);
        expect(current.stderr).not.toContain("out of date");
        expect(
          (yield* Schema.decodeUnknownEffect(Failure)(current.stdout)).error.update,
        ).toBeUndefined();
        const silent = yield* failsWith("http://127.0.0.1:9");
        expect(silent.code).toBe(1);
        expect(silent.stderr).toContain("Code: HostUnreachable");
        expect(silent.stderr).not.toContain("out of date");
      }),
    ),
  );
});
