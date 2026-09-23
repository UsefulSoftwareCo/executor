/** Native Git process and filesystem lifetime for Node and Bun hosts. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { SourceError, type RepositoryBackend } from "./contracts/repositories.ts";
import { gitRepositories } from "./implementation/git-repositories.ts";
export { limitedBody } from "./implementation/git-repositories.ts";

/** Execute without a shell. Git diagnostics can contain source or paths and are discarded. */
const git = (
  args: ReadonlyArray<string>,
  input?: Uint8Array,
  environment?: Record<string, string>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const process = yield* spawner.spawn(
        // Receive-pack adds a quarantine directory beneath the repository. Let
        // Git use Windows extended paths for those deeper object filenames.
        ChildProcess.make(
          "git",
          ["-c", "core.hooksPath=/dev/null", "-c", "core.longpaths=true", ...args],
          {
            stdin: input === undefined ? "ignore" : Stream.succeed(input),
            stdout: "pipe",
            stderr: "ignore",
            extendEnv: true,
            env: {
              GIT_TERMINAL_PROMPT: "0",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
              ...environment,
            },
          },
        ),
      );
      const chunks: Uint8Array[] = [];
      let length = 0;
      yield* process.stdout.pipe(
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            chunks.push(chunk);
            length += chunk.length;
          }),
        ),
      );
      const output = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
      }
      return { code: Number(yield* process.exitCode), output };
    }),
  ).pipe(Effect.mapError(() => new SourceError({ reason: "git" })));

/** Lazy repositories with scoped native processes and temporary indexes. */
export const nativeRepositories = (directory: string): RepositoryBackend => {
  const provide = Effect.provide(NodeServices.layer);
  return gitRepositories({
    directory,
    git: (args, input, environment) => git(args, input, environment).pipe(provide),
    createDirectory: (path) =>
      FileSystem.FileSystem.use((fs) =>
        fs.makeDirectory(path, { recursive: true, mode: 0o700 }),
      ).pipe(
        Effect.mapError(() => new SourceError({ reason: "git" })),
        provide,
      ),
    temporaryIndex: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return path.join(yield* fs.makeTempDirectoryScoped({ prefix: "executor-git-" }), "index");
    }).pipe(
      Effect.mapError(() => new SourceError({ reason: "git" })),
      provide,
    ),
  });
};
