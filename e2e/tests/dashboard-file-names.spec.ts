/**
 * A deploy serves only the current build's browser files, so a page still running the previous
 * build cannot load a file the deploy renamed. Two Cloud dashboard builds that differ only in their
 * build id must name every browser file the same. Only the server bundle carries the id; the
 * document hands it to the browser. Each build sets `SENTRY_RELEASE` as a deploy does, so the
 * Sentry plugin runs; without an auth token it uploads nothing.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const web = "apps/hosted/cloud/web";

/** Builds the Cloud dashboard as `build` and reads which of its files name the build. */
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

layer(NodeServices.layer, { excludeTestServices: true })("Dashboard file names", (it) => {
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
        // The server still names the build in the document, where the browser reads it.
        expect(first.serverNamingBuild.length).toBeGreaterThan(0);
        expect(second.serverNamingBuild.length).toBeGreaterThan(0);
      }),
  );
});
