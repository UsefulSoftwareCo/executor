/** Drive the real `executor apps` CLI against the managed local server. */
import { expect, layer } from "@effect/vitest";
import { Config, Effect, FileSystem, Option, Redacted, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { scenarios } from "../test-plan.ts";
import { Api } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { Evidence } from "../support/evidence.ts";

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
const Source = Schema.fromJsonString(
  Schema.Struct({ files: Schema.Array(Schema.Struct({ path: Schema.String })) }),
);

layer(TestLive, { excludeTestServices: true })("Local apps CLI", (it) => {
  it.effect(scenarios.localAppsCli.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          processes = yield* ChildProcessSpawner.ChildProcessSpawner,
          target = yield* Target,
          evidence = yield* Evidence,
          api = yield* Api;
        const packagedEntry = yield* Config.NonEmptyString("EXECUTOR_E2E_LOCAL_ENTRY").pipe(
          Config.option,
        );
        const [command, ...prefix] = Option.isSome(packagedEntry)
          ? [packagedEntry.value]
          : ["node", "apps/local/server/src/bin.ts"];
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "executor-apps-cli-" });
        const origin = target.metadata.origin;
        const run = (args: readonly string[], signedIn: boolean) =>
          evidence.step(
            `executor apps ${args.join(" ")}`,
            Effect.scoped(
              Effect.gen(function* () {
                const child = yield* processes.spawn(
                  ChildProcess.make(command ?? "node", [...prefix, "apps", ...args], {
                    extendEnv: false,
                    env: {
                      PATH: process.env.PATH ?? "",
                      HOME: home,
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

        const signedOut = yield* run(["list", "--host", origin], false);
        yield* evidence.json("signed-out.json", signedOut);
        expect(signedOut.code).toBe(1);
        expect(signedOut.stderr).toContain(
          "run executor apps login --host https://v2.executor.sh and pass the same --host",
        );
        expect(signedOut.stderr).toContain(
          "For a local server (default http://127.0.0.1:4312), set EXECUTOR_API_KEY",
        );

        const listed = yield* run(["skills", "--host", origin], true);
        yield* evidence.json("skills-list.json", listed);
        expect(listed.code, listed.stderr).toBe(0);
        const catalogs = yield* Schema.decodeUnknownEffect(Catalogs)(listed.stdout);
        expect(
          catalogs.catalogs.some(
            (catalog) =>
              catalog.app.slug === "executor" &&
              catalog.skills.some((skill) => skill.name === "app-authoring"),
          ),
        ).toBe(true);

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
          'import { defineApp } from "apps";\nimport { label } from "./lib/label.ts";\nexport default defineApp({ accounts: {} }, async () => ({ queries: {} }));\nvoid label;\n',
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
      }),
    ),
  );
});
