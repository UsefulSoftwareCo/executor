import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const web = "apps/hosted/cloud/web";

const buildAs = (build: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make("bun", ["run", "build"], {
        cwd: path.resolve(web),
        env: { EXECUTOR_BUILD_VERSION: build, SENTRY_RELEASE: build },
        extendEnv: true,
      }),
    );
    const [output, exitCode] = yield* Effect.all(
      [
        Stream.merge(child.stdout, child.stderr).pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    expect(exitCode, output).toBe(0);
    const namingBuild = (directory: string) =>
      fs.readDirectory(directory, { recursive: true }).pipe(
        Effect.map((files) => files.filter((file) => file.endsWith(".js")).sort()),
        Effect.flatMap((files) =>
          Effect.filter(files, (file) =>
            fs
              .readFileString(path.join(directory, file))
              .pipe(Effect.map((text) => text.includes(build))),
          ),
        ),
      );
    const assets = path.resolve(web, "dist/client/assets");
    return {
      files: (yield* fs.readDirectory(assets)).filter((file) => file.endsWith(".js")).sort(),
      browserNamingBuild: yield* namingBuild(path.resolve(web, "dist/client")),
      serverNamingBuild: yield* namingBuild(path.resolve(web, "dist/server")),
    };
  }).pipe(Effect.scoped);

const buildWithout = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const noRepository = yield* fs.makeTempDirectoryScoped({ prefix: "executor-no-repository-" });
    const child = yield* processes.spawn(
      ChildProcess.make("bun", ["run", "build"], {
        cwd: path.resolve(web),
        env: { ...env, GIT_DIR: noRepository },
        extendEnv: true,
      }),
    );
    const [output, exitCode] = yield* Effect.all(
      [
        Stream.merge(child.stdout, child.stderr).pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (Number(exitCode) !== 0) return { exitCode: Number(exitCode), output, browser: "" };
    const assets = path.resolve(web, "dist/client/assets");
    const files = (yield* fs.readDirectory(assets)).filter((file) => file.endsWith(".js"));
    const texts = yield* Effect.forEach(files, (file) =>
      fs.readFileString(path.join(assets, file)),
    );
    return { exitCode: 0, output, browser: texts.join("\n") };
  }).pipe(Effect.scoped);

layer(NodeServices.layer, { excludeTestServices: true })("Dashboard file names", (it) => {
  it.effect(
    "the Cloud dashboard builds with the notes it is given, and with none when given none, without reading any git history, and refuses notes that do not decode",
    () =>
      Effect.gen(function* () {
        const notes = {
          notes: [
            {
              date: "2026-11-14",
              text: "Apps open from the sidebar in one click.",
              kind: "feature",
            },
            {
              date: "2026-11-03",
              text: "Members can leave an organization themselves.",
              kind: "fix",
            },
          ],
        };
        const given = yield* buildWithout({ EXECUTOR_CLOUD_RELEASE_NOTES: JSON.stringify(notes) });
        expect(given.exitCode, given.output).toBe(0);
        expect(notes.notes.map((note) => given.browser.includes(note.text))).toEqual([true, true]);
        const none = yield* buildWithout({});
        expect(none.exitCode, none.output).toBe(0);
        expect(notes.notes.map((note) => none.browser.includes(note.text))).toEqual([false, false]);
        const malformed = yield* buildWithout({
          EXECUTOR_CLOUD_RELEASE_NOTES: JSON.stringify({
            notes: [{ date: "yesterday", text: "" }],
          }),
        });
        expect(malformed.exitCode).not.toBe(0);
      }),
  );

  it.effect(
    "two Cloud dashboard builds that differ only in build id name every JS file alike",
    () =>
      Effect.gen(function* () {
        const first = yield* buildAs("file-names-check-build-1");
        const second = yield* buildAs("file-names-check-build-2");
        expect(first.files.length).toBeGreaterThan(0);
        expect(second.files).toEqual(first.files);
        expect(first.browserNamingBuild).toEqual([]);
        expect(second.browserNamingBuild).toEqual([]);
        expect(first.serverNamingBuild.length).toBeGreaterThan(0);
        expect(second.serverNamingBuild.length).toBeGreaterThan(0);
      }),
  );
});
