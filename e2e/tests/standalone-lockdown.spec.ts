/**
 * A local process must not run its own code inside the release executable, which a macOS
 * Keychain item trusts by its signature, nor attach a debugger to it. Stock Bun reads overrides
 * for both from the environment and the working directory before the executable's first line
 * runs; the release is built on a Bun runtime that ignores them (scripts/releases/bun-runtime).
 * Each override here is one a local process could set. Set EXECUTOR_E2E_LOCAL_ENTRY to the
 * executable.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { freePort, holdPort } from "../support/ports.ts";
import { isScript } from "../support/local-entry.ts";

const Manifest = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));

it.live(
  "the release executable ignores Bun's environment and working-directory overrides, so no local process runs code in it or debugs it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const executable = path.resolve(yield* Config.String("EXECUTOR_E2E_LOCAL_ENTRY"));
        expect(isScript(executable), "EXECUTOR_E2E_LOCAL_ENTRY must be the executable").toBe(false);
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "executor-lockdown-" });
        const marker = path.join(cwd, "ran.txt");
        // Code a preload would run: it leaves a file behind.
        const payload = path.join(cwd, "payload.mjs");
        yield* fs.writeFileString(
          payload,
          `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`,
        );
        const { version } = yield* fs
          .readFileString(path.resolve("apps/cli/package.json"))
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Manifest)));
        const start = (env: Readonly<Record<string, string>>, args = ["--version"]) =>
          Effect.scoped(
            Effect.gen(function* () {
              const child = yield* processes.spawn(
                ChildProcess.make(executable, args, {
                  cwd,
                  env: { DO_NOT_TRACK: "1", EXECUTOR_NO_UPDATE_CHECK: "1", ...env },
                  extendEnv: true,
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
                { concurrency: "unbounded" },
              ).pipe(Effect.timeout("30 seconds"));
              return { code: Number(code), stdout: stdout.trim(), stderr: stderr.trim() };
            }),
          );
        /** Start with `env`; the executable answers as itself and nothing else runs. */
        const ignores = (label: string, env: Readonly<Record<string, string>>) =>
          Effect.gen(function* () {
            const result = yield* start(env);
            expect(result.code, `${label}: ${result.stderr}`).toBe(0);
            expect(result.stdout, label).toBe(`executor v${version}`);
            expect(result.stderr, label).toBe("");
            expect(yield* fs.exists(marker), label).toBe(false);
          });

        // BUN_BE_BUN would turn the executable into the bun CLI, which runs any script.
        yield* ignores("BUN_BE_BUN", { BUN_BE_BUN: "1" });
        // BUN_OPTIONS would add Bun flags: a preload, or a config file that names one.
        yield* fs.writeFileString(
          path.join(cwd, "preload.toml"),
          `preload = [${JSON.stringify(payload)}]\n`,
        );
        yield* ignores("BUN_OPTIONS --preload", { BUN_OPTIONS: `--preload ${payload}` });
        yield* ignores("BUN_OPTIONS --config", {
          BUN_OPTIONS: `--config ${path.join(cwd, "preload.toml")}`,
        });
        yield* ignores("BUN_INSPECT_PRELOAD", { BUN_INSPECT_PRELOAD: payload });
        // JavaScriptCore options; an unknown one stops stock Bun before it starts.
        yield* ignores("BUN_JSC_*", { BUN_JSC_dumpOptions: "1", BUN_JSC_notAnOption: "1" });
        // A debugger that waits for a client would stop the executable at its first line.
        const inspect = yield* freePort;
        yield* ignores("BUN_INSPECT", { BUN_INSPECT: `ws://127.0.0.1:${inspect}/x?wait=1` });
        // A debugger that dials out would hand the executable to whoever listens.
        let dialed = 0;
        const listener = yield* holdPort(0, (socket) => {
          dialed += 1;
          socket.destroy();
        });
        yield* ignores("BUN_INSPECT_CONNECT_TO", {
          BUN_INSPECT_CONNECT_TO: `tcp://127.0.0.1:${listener}`,
        });
        expect(dialed).toBe(0);
        // A working directory's bunfig.toml and .env are not read either.
        yield* fs.writeFileString(
          path.join(cwd, "bunfig.toml"),
          `preload = [${JSON.stringify(payload)}]\n`,
        );
        yield* ignores("bunfig.toml", {});
        // Read, this .env would make the executable believe npx started it.
        yield* fs.writeFileString(
          path.join(cwd, ".env"),
          "EXECUTOR_LAUNCHER=/cache/_npx/0a1b/node_modules/executor/bin.mjs\n",
        );
        const upgrade = yield* start(
          {
            EXECUTOR_DATA_DIR: path.join(cwd, "data"),
            EXECUTOR_NPM_REGISTRY: `http://127.0.0.1:${yield* freePort}`,
          },
          ["upgrade"],
        );
        expect(upgrade.stdout).not.toContain("runs through npx");
        expect(yield* fs.exists(marker)).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
