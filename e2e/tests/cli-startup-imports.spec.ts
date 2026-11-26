import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const lazy = [
  "apps/local/server/src/implementation/server-process.ts",
  "apps/local/server/src/implementation/launcher.ts",
  "apps/local/server/src/implementation/bootstrap.ts",
  "apps/local/server/src/implementation/service-settings.ts",
  "apps/local/server/src/implementation/pair.ts",
  "apps/local/server/src/implementation/upgrade.ts",
  "packages/app-management/src/implementation/tools-client.ts",
  "packages/app-management/src/implementation/paused-calls.ts",
];

const recorder = [
  'import { registerHooks } from "node:module";',
  'import { writeFileSync } from "node:fs";',
  "const loaded = [];",
  "registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });",
  'process.on("exit", () => writeFileSync(process.env.LOADED_MODULES, JSON.stringify(loaded)));',
  "",
].join("\n");

const Loaded = Schema.fromJsonString(Schema.Array(Schema.String));

const loadedBy = (args: ReadonlyArray<string>, preload: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = path.resolve(".");
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-cli-imports-" });
    const hooks = path.join(directory, "record.mjs");
    const list = path.join(directory, "loaded.json");
    yield* fs.writeFileString(hooks, recorder);
    const imports: Array<string> = [];
    for (const file of [hooks, ...preload.map((file) => path.join(root, file))])
      imports.push("--import", (yield* path.toFileUrl(file)).href);
    const child = yield* processes.spawn(
      ChildProcess.make(
        "node",
        [...imports, path.join(root, "apps/local/server/src/bin.ts"), ...args],
        {
          extendEnv: true,
          env: {
            LOADED_MODULES: list,
            DO_NOT_TRACK: "1",
            EXECUTOR_DATA_DIR: path.join(directory, "data"),
          },
        },
      ),
    );
    const [output, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    const urls = yield* Schema.decodeUnknownEffect(Loaded)(yield* fs.readFileString(list));
    const files: Array<string> = [];
    for (const url of urls)
      if (url.startsWith("file:"))
        files.push(
          path.relative(root, yield* path.fromFileUrl(new URL(url))).replaceAll("\\", "/"),
        );
    return { exitCode: Number(exitCode), output, files };
  }).pipe(Effect.scoped);

layer(NodeServices.layer)("CLI start-up imports", (it) => {
  it.effect("executor --help loads none of the modules a command loads when it runs", () =>
    Effect.gen(function* () {
      const help = yield* loadedBy(["--help"]);
      expect(help.exitCode, help.output).toBe(0);
      expect(help.files).toContain("apps/local/server/src/bin.ts");
      expect(help.files.filter((file) => lazy.includes(file))).toEqual([]);
    }),
  );

  it.effect("a module help should not load is reported when something loads it", () =>
    Effect.gen(function* () {
      const help = yield* loadedBy(["--help"], [lazy[0]!]);
      expect(help.exitCode, help.output).toBe(0);
      expect(help.files.filter((file) => lazy.includes(file))).toContain(lazy[0]);
    }),
  );
});
