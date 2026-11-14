/**
 * The local server builds with the same compiler as self-host, in its app runtime. A deploy from
 * the real CLI that reaches a file over the compile limit fails with the file, its size and the
 * limit, and the app keeps no version.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, Queue, Redacted, Schema, Stream } from "effect";
import { randomUUID } from "node:crypto";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { Evidence } from "../support/evidence.ts";
import { helloIndex, helloPackage } from "../support/app-authoring.ts";
import { appsVersion, withApps } from "../support/apps-release.ts";
import { holdingRegistry } from "../support/holding-registry.ts";
import { startLocalProduct } from "../support/local-workflow-engines.ts";
import { stalledPackage } from "../support/npm-registry.ts";
import { localEntryCommand } from "../support/local-entry.ts";

const Created = Schema.fromJsonString(Schema.Struct({ id: Schema.String }));
const Failure = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({
      code: Schema.String,
      status: Schema.optional(Schema.Number),
      message: Schema.String,
      details: Schema.optional(
        Schema.Struct({ stage: Schema.String, location: Schema.Struct({ file: Schema.String }) }),
      ),
    }),
  }),
);
const Stored = Schema.Struct({ activeVersion: Schema.NullOr(Schema.String) });
const oversized = 2_000_001;

layer(TestLive, { excludeTestServices: true })("Local compiled file limit", (it) => {
  it.effect(scenarios.localCompiledFileLimit.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          path = yield* Path.Path,
          processes = yield* ChildProcessSpawner.ChildProcessSpawner,
          target = yield* Target,
          evidence = yield* Evidence,
          api = yield* Api;
        const entry = path.resolve("apps/local/server/src/bin.ts");
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "executor-compiled-limit-" });
        const origin = target.metadata.origin;
        const run = (args: ReadonlyArray<string>) =>
          evidence.step(
            `executor apps ${args.join(" ")}`,
            Effect.scoped(
              Effect.gen(function* () {
                const command = localEntryCommand(entry, ["apps", ...args, "--host", origin]);
                const child = yield* processes.spawn(
                  ChildProcess.make(command.command, command.args, {
                    extendEnv: false,
                    env: {
                      PATH: process.env.PATH ?? "",
                      HOME: home,
                      DO_NOT_TRACK: "1",
                      EXECUTOR_API_KEY: Redacted.value(target.apiKey),
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

        const source = yield* fs.makeTempDirectoryScoped({ prefix: "executor-compiled-source-" });
        yield* fs.writeFileString(`${source}/index.ts`, helloIndex);
        yield* fs.writeFileString(`${source}/package.json`, helloPackage(appsVersion));
        const created = yield* run(["create", "--name", "Compiled file limit", "--files", source]);
        expect(created.code, created.stderr).toBe(0);
        const app = yield* Schema.decodeUnknownEffect(Created)(created.stdout);
        const session = yield* api.session();
        const authorization = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        yield* Effect.addFinalizer(() =>
          session.send("DELETE", `/v1/apps/${app.id}`, undefined, authorization).pipe(Effect.orDie),
        );

        // One byte over the limit: the module the app imports is refused before it compiles.
        const head = 'export const filler = "';
        const tail = '";\n';
        yield* fs.writeFileString(
          `${source}/filler.ts`,
          `${head}${"x".repeat(oversized - head.length - tail.length)}${tail}`,
        );
        yield* fs.writeFileString(
          `${source}/index.ts`,
          `import { filler } from "./filler.ts";\n${helloIndex}\nvoid filler;\n`,
        );
        const deployed = yield* run(["deploy", "--app", app.id, "--files", source]);
        yield* evidence.json("over-the-limit.json", deployed);
        expect(deployed.code).toBe(1);
        const message =
          "filler.ts is 2,000,001 bytes; a JavaScript or TypeScript file the build compiles can be at most 2,000,000 bytes (2 MB).";
        expect(deployed.stderr).toContain("Code: VersionBuildFailed (HTTP 422)");
        expect(deployed.stderr).toContain(message);
        const failed = (yield* Schema.decodeUnknownEffect(Failure)(deployed.stdout)).error;
        expect(failed).toMatchObject({
          code: "VersionBuildFailed",
          status: 422,
          details: { stage: "source", location: { file: "filler.ts" } },
        });
        expect(failed.message).toContain(message);

        // The app keeps no version: none is active and the server lists none.
        const stored = yield* body(
          Stored,
          yield* session.send("GET", `/v1/apps/${app.id}`, undefined, authorization),
        );
        expect(stored.activeVersion).toBeNull();
        const versions = yield* session.send(
          "GET",
          `/v1/apps/${app.id}/versions`,
          undefined,
          authorization,
        );
        expect(versions.status).toBe(200);
        expect(yield* body(Schema.Array(Schema.Unknown), versions)).toEqual([]);
      }),
    ),
  );
});

/**
 * No import of the oversized module is resolved before the refusal. The module imports a declared
 * package whose registry metadata never arrives: a build that resolved that import would ask the
 * registry for the package and wait on it. This does not show that the file was not parsed (a
 * parse need not resolve imports); `compiledFileLimitResponsive` checks that no compile work held
 * the runtime's thread.
 */
layer(TestLive, { excludeTestServices: true })("Local compiled file limit imports", (it) => {
  it.effect(scenarios.localCompiledFileLimitImports.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence;
        const holding = yield* holdingRegistry;
        const local = yield* startLocalProduct({ EXECUTOR_NPM_REGISTRY: holding.origin });
        const importLine = `import stalled from "${stalledPackage}";\nexport const marker = stalled;\n`;
        const head = 'export const filler = "';
        const tail = '";\n';
        const filler = `${importLine}${head}${"x".repeat(oversized - importLine.length - head.length - tail.length)}${tail}`;
        expect(new TextEncoder().encode(filler).length).toBe(oversized);
        const deployed = yield* local
          .request("POST", "/v1/apps/deploy", {
            owner: "compiled-file-limit-e2e",
            name: `Before compiling ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `import { marker } from "./filler.ts";\n${helloIndex}\nvoid marker;\n`,
              },
              { path: "filler.ts", content: filler },
              {
                path: "package.json",
                content: JSON.stringify({
                  type: "module",
                  dependencies: withApps({ [stalledPackage]: "1.0.0" }),
                }),
              },
            ],
          })
          .pipe(Effect.timeout("60 seconds"));
        yield* evidence.json("before-compiling.json", deployed);
        expect(deployed.status, deployed.text).toBe(422);
        expect(deployed.text).toContain(
          "filler.ts is 2,000,001 bytes; a JavaScript or TypeScript file the build compiles can be at most 2,000,000 bytes (2 MB).",
        );
        // Nothing asked the registry for the package the oversized module imports.
        expect(yield* Queue.size(holding.arrived)).toBe(0);
      }),
    ),
  );
});
