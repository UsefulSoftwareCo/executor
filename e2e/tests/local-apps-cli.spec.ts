/** Drive the real `executor apps` CLI against the managed local server. */
import { expect, layer } from "@effect/vitest";
import { Config, Effect, FileSystem, Option, Path, Redacted, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { scenarios } from "../test-plan.ts";
import { Api } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { Evidence } from "../support/evidence.ts";
import { Workspace, helloIndex, helloPackage } from "../support/app-authoring.ts";
import { appsVersion, declaredApps } from "../support/apps-release.ts";

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
const Apps = Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }));
const Deployed = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});
const Source = Schema.fromJsonString(
  Schema.Struct({ files: Schema.Array(Schema.Struct({ path: Schema.String })) }),
);
/** A CLI commit prints only its new revision, never the files it sent. */
const Committed = Schema.fromJsonString(Schema.Struct({ revision: Workspace.fields.revision }));

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
  const run = (args: readonly string[], signedIn: boolean, cwd?: string) =>
    evidence.step(
      `executor apps ${args.join(" ")}`,
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* processes.spawn(
            ChildProcess.make("node", [entry, "apps", ...args], {
              cwd,
              extendEnv: false,
              env: {
                PATH: process.env.PATH ?? "",
                HOME: home,
                // Release scenarios never send product analytics, even from a build with a baked key.
                DO_NOT_TRACK: "1",
                ...(signedIn ? { EXECUTOR_API_KEY: Redacted.value(target.apiKey) } : {}),
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
  return { run, origin, fs };
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
          "For a local server (default http://127.0.0.1:4312), set EXECUTOR_API_KEY",
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
          'import { defineApp, router } from "apps";\nimport { label } from "./lib/label.ts";\nexport default defineApp({ accounts: {} }, async () => ({ tools: router({}) }));\nvoid label;\n',
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

        // Committing the current directory prints only the new revision, which the next read reports.
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
  it.effect(scenarios.localAppsCliRelease.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          evidence = yield* Evidence,
          api = yield* Api;
        const { run, origin, fs } = yield* cli;
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
});
