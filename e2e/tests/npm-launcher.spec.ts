/**
 * The `executor` npm package is a launcher: it starts the executable from the platform package npm
 * installs as an optional dependency, passes signals on and exits as the executable exits.
 *
 * Package managers create a command shim from the launcher's declared bin path. Executor 1 declared
 * `bin/executor`; Executor 2 declares `bin.mjs`. An upgrade that replaces the package without
 * relinking, such as `bun add executor@beta` run inside Bun's global directory, leaves the old shim
 * starting `bin/executor`, so the launcher must keep that path working. The launcher needs no
 * particular Node: set EXECUTOR_E2E_OLD_NODE to the oldest Node its package.json accepts to start
 * it there too.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Deferred, Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FetchHttpClient } from "effect/http";
import { localNpmRegistry } from "../support/npm-registry.ts";
import { freePort } from "../support/ports.ts";

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.NonEmptyString,
    bin: Schema.Struct({ executor: Schema.Literal("bin.mjs") }),
    engines: Schema.Struct({ node: Schema.String }),
  }),
);

it.live(
  "the npm launcher starts the platform executable through every entry point, passes on its exit code and signals, and explains a missing platform package",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const launcherArchive = path.resolve(yield* Config.String("EXECUTOR_E2E_LAUNCHER_ARCHIVE"));
        const runtimeArchive = path.resolve(yield* Config.String("EXECUTOR_E2E_RUNTIME_ARCHIVE"));
        const oldNode = yield* Config.NonEmptyString("EXECUTOR_E2E_OLD_NODE").pipe(Config.option);
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-npm-launcher-" });
        const modules = path.join(root, "node_modules");
        yield* fs.makeDirectory(modules);

        const run = (
          command: string,
          args: ReadonlyArray<string>,
          cwd: string,
          env: Readonly<Record<string, string>> = {},
        ) =>
          Effect.scoped(
            Effect.gen(function* () {
              const child = yield* processes.spawn(
                ChildProcess.make(command, args, {
                  cwd,
                  // Release scenarios never send product analytics, even from a build with a baked key.
                  env: { DO_NOT_TRACK: "1", ...env },
                  extendEnv: true,
                  stdout: "pipe",
                  stderr: "pipe",
                }),
              );
              const [code, stdout, stderr] = yield* Effect.all(
                [
                  child.exitCode,
                  child.stdout.pipe(Stream.decodeText(), Stream.mkString),
                  child.stderr.pipe(Stream.decodeText(), Stream.mkString),
                ],
                { concurrency: "unbounded" },
              ).pipe(Effect.timeout("60 seconds"));
              return { code: Number(code), stdout: stdout.trim(), stderr };
            }),
          );
        // Unpack as npm lays out an install: each archive's package/ becomes node_modules/<name>.
        const unpack = Effect.fnUntraced(function* (archive: string, name: string) {
          const staging = path.join(root, `unpack-${name}`);
          yield* fs.makeDirectory(staging);
          yield* fs.copyFile(archive, path.join(staging, "package.tgz"));
          // A relative archive path: GNU tar on Windows reads a drive letter as a remote host.
          const result = yield* run("tar", ["-xzf", "package.tgz"], staging);
          expect(result.code, result.stderr).toBe(0);
          yield* fs.rename(path.join(staging, "package"), path.join(modules, name));
          return path.join(modules, name);
        });

        const launcher = yield* unpack(launcherArchive, "executor");
        // The launcher's optional dependency alias for this machine's native runtime.
        const platformPackage = `executor-${process.platform}-${process.arch}`;
        const runtime = yield* unpack(runtimeArchive, platformPackage);
        const manifest = yield* fs
          .readFileString(path.join(launcher, "package.json"))
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Manifest)));
        const entry = path.join(launcher, "bin.mjs");
        const executable = path.join(
          runtime,
          process.platform === "win32" ? "executor.exe" : "executor",
        );

        for (const file of ["bin.mjs", "bin/executor"]) {
          const script = path.join(launcher, file);
          // Windows shims (npm's .cmd and .ps1, Bun's .exe) start the entry with Node.
          const viaNode = yield* run(process.execPath, [script, "--version"], root);
          expect(viaNode.code, viaNode.stderr).toBe(0);
          expect(viaNode.stdout).toBe(`executor v${manifest.version}`);
          // Unix shims are symlinks to the entry, started through its shebang.
          if (process.platform !== "win32") {
            const viaShebang = yield* run(script, ["--version"], root);
            expect(viaShebang.code, viaShebang.stderr).toBe(0);
            expect(viaShebang.stdout).toBe(`executor v${manifest.version}`);
          }
        }
        if (Option.isSome(oldNode)) {
          const old = yield* run(oldNode.value, ["--version"], root);
          expect(manifest.engines.node).toBe(`>=${old.stdout.replace(/^v/u, "")}`);
          const viaOldNode = yield* run(oldNode.value, [entry, "--version"], root);
          expect(viaOldNode.code, viaOldNode.stderr).toBe(0);
          expect(viaOldNode.stdout).toBe(`executor v${manifest.version}`);
        }

        // A failing command exits with the executable's code and message.
        const direct = yield* run(executable, ["web"], root);
        const launched = yield* run(process.execPath, [entry, "web"], root);
        expect(direct.code).toBe(1);
        expect(launched.code).toBe(direct.code);
        expect(launched.stderr).toBe(direct.stderr);

        // A service manager's SIGTERM reaches the server, which stops cleanly with the launcher.
        if (process.platform !== "win32") {
          const registry = yield* localNpmRegistry;
          const port = yield* freePort;
          const stopped = yield* Effect.scoped(
            Effect.gen(function* () {
              const child = yield* processes.spawn(
                ChildProcess.make(process.execPath, [entry, "serve"], {
                  cwd: root,
                  env: {
                    DO_NOT_TRACK: "1",
                    EXECUTOR_DATA_DIR: path.join(root, "data"),
                    EXECUTOR_PORT: String(port),
                    EXECUTOR_KEY_STORAGE: "file",
                    EXECUTOR_NO_UPDATE_CHECK: "1",
                    EXECUTOR_NPM_REGISTRY: registry.url,
                  },
                  extendEnv: true,
                  stdout: "pipe",
                  stderr: "pipe",
                  forceKillAfter: "20 seconds",
                }),
              );
              const ready = yield* Deferred.make<void>();
              yield* Stream.merge(child.stdout, child.stderr).pipe(
                Stream.decodeText(),
                Stream.splitLines,
                Stream.runForEach((line) =>
                  line === `Executor: http://127.0.0.1:${port}`
                    ? Deferred.succeed(ready, undefined)
                    : Effect.void,
                ),
                Effect.forkScoped,
              );
              yield* Deferred.await(ready).pipe(Effect.timeout("90 seconds"));
              yield* child.kill({ killSignal: "SIGTERM" });
              return yield* child.exitCode.pipe(Effect.timeout("20 seconds"));
            }),
          );
          // The server ran its own shutdown, which ends an interrupted program with 130, and the
          // launcher exited with it. Nothing listens on its port any more.
          expect(Number(stopped)).toBe(130);
          const answered = yield* run(executable, ["pair"], root, {
            EXECUTOR_DATA_DIR: path.join(root, "data"),
            EXECUTOR_PORT: String(port),
          });
          expect(answered.code).toBe(1);
          expect(answered.stderr).toContain(`No server answered on 127.0.0.1:${port}`);
        }

        // npm skips optional dependencies with --omit=optional; the launcher says how to fix it.
        yield* fs.remove(runtime, { recursive: true });
        const missing = yield* run(process.execPath, [entry, "--version"], root);
        expect(missing.code).toBe(1);
        expect(missing.stderr).toContain(`${platformPackage} is not installed`);
        expect(missing.stderr).toContain(
          `npm i -g executor${manifest.version.includes("-beta.") ? "@beta" : ""} --include=optional`,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);
