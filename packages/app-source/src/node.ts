import * as NodeServices from "@effect/platform-node/NodeServices";
import { join } from "node:path";
import { Effect, Exit, FileSystem, Path, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as PlatformError from "effect/PlatformError";
import { SourceError, type RepositoryBackend } from "@executor-js/sdk/core";
import { gitRepositories } from "./implementation/git-repositories.ts";

export interface NativeGit {
  readonly executable: string;
  readonly environment: Readonly<Record<string, string>>;
}

export const systemGit: NativeGit = { executable: "git", environment: {} };

export const bundledGit = (directory: string): NativeGit =>
  process.platform === "win32"
    ? {
        executable: join(directory, "cmd", "git.exe"),
        environment: { GIT_EXEC_PATH: join(directory, "mingw64", "libexec", "git-core") },
      }
    : {
        executable: join(directory, "bin", "git"),
        environment: {
          GIT_EXEC_PATH: join(directory, "libexec", "git-core"),
          GIT_TEMPLATE_DIR: join(directory, "share", "git-core", "templates"),
          ...(process.platform === "linux" ? { PREFIX: directory } : {}),
        },
      };

const run = (
  git: NativeGit,
  args: ReadonlyArray<string>,
  input?: Uint8Array,
  environment?: Record<string, string>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const process = yield* spawner.spawn(
        ChildProcess.make(
          git.executable,
          ["-c", "core.hooksPath=/dev/null", "-c", "core.longpaths=true", ...args],
          {
            stdin: input === undefined ? "ignore" : Stream.succeed(input),
            stdout: "pipe",
            stderr: "ignore",
            extendEnv: true,
            env: { ...gitEnvironment, ...git.environment, ...environment },
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

const gitEnvironment = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

const httpBackend = (
  git: NativeGit,
  environment: Record<string, string>,
  body: ReadableStream<Uint8Array> | null,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Scope.make();
    const process = yield* spawner
      .spawn(
        ChildProcess.make(
          git.executable,
          ["-c", "core.hooksPath=/dev/null", "-c", "core.longpaths=true", "http-backend"],
          {
            stdin:
              body === null
                ? "ignore"
                : Stream.fromReadableStream({
                    evaluate: () => body,
                    onError: (cause) =>
                      PlatformError.systemError({
                        _tag: "Unknown",
                        module: "Stream",
                        method: "read",
                        description: "The Git request body failed",
                        cause,
                      }),
                  }),
            stdout: "pipe",
            stderr: "ignore",
            extendEnv: true,
            env: { ...gitEnvironment, ...git.environment, ...environment },
          },
        ),
      )
      .pipe(
        Scope.provide(scope),
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
      );
    return yield* Stream.toReadableStreamEffect(
      process.stdout.pipe(Stream.onExit((exit) => Scope.close(scope, exit))),
    );
  }).pipe(Effect.mapError(() => new SourceError({ reason: "git" })));

export const nativeRepositories = (directory: string, git: NativeGit): RepositoryBackend => {
  const provide = Effect.provide(NodeServices.layer);
  return gitRepositories({
    directory,
    git: (args, input, environment) => run(git, args, input, environment).pipe(provide),
    httpBackend: (environment, body) => httpBackend(git, environment, body).pipe(provide),
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
