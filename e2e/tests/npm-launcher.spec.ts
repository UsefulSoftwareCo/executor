import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createHash } from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { createServer } from "node:http";
import { Config, Deferred, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { localNpmRegistry } from "../support/npm-registry.ts";
import { connectionRefused, freePort } from "../support/ports.ts";

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.NonEmptyString,
    bin: Schema.Struct({ executor: Schema.Literal("bin.mjs") }),
    engines: Schema.Struct({ node: Schema.String }),
    runtimes: Schema.Record(Schema.String, Schema.String),
  }),
);

const target = `${process.platform}-${process.arch}`;
const executableName = process.platform === "win32" ? "executor.exe" : "executor";

const serve = (files: Map<string, Uint8Array>) =>
  Effect.gen(function* () {
    const requests = new Map<string, number>();
    const handler = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = decodeURIComponent(request.url.split("?")[0] ?? "/");
      requests.set(url, (requests.get(url) ?? 0) + 1);
      const body = files.get(url);
      return body === undefined
        ? HttpServerResponse.empty({ status: 404 })
        : HttpServerResponse.uint8Array(body);
    });
    const services = yield* Layer.build(
      HttpRouter.serve(HttpRouter.add("GET", "/*", handler), {
        disableLogger: true,
        disableListenLog: true,
      }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      ),
    );
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address)) return yield* Effect.die("The server must listen on TCP");
    return { port: server.address.port, requests };
  });

const scenario = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const launcherArchive = path.resolve(yield* Config.String("EXECUTOR_E2E_LAUNCHER_ARCHIVE"));
  const runtimeArchive = path.resolve(yield* Config.String("EXECUTOR_E2E_RUNTIME_ARCHIVE"));
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-npm-launcher-" });
  const home = path.join(root, "home");
  yield* fs.makeDirectory(home);

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
            env: { DO_NOT_TRACK: "1", HOME: home, USERPROFILE: home, ...env },
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
        ).pipe(Effect.timeout("150 seconds"));
        return { code: Number(code), stdout: stdout.trim(), stderr };
      }),
    );
  const unpack = Effect.fnUntraced(function* (archive: string, directory: string) {
    const staging = path.join(root, `unpack-${path.basename(directory)}`);
    yield* fs.makeDirectory(staging);
    yield* fs.copyFile(archive, path.join(staging, "package.tgz"));
    const result = yield* run("tar", ["-xzf", "package.tgz"], staging);
    expect(result.code, result.stderr).toBe(0);
    yield* fs.makeDirectory(path.dirname(directory), { recursive: true });
    yield* fs.rename(path.join(staging, "package"), directory);
    return directory;
  });
  const launcher = yield* unpack(launcherArchive, path.join(root, "node_modules", "executor"));
  const manifest = yield* fs
    .readFileString(path.join(launcher, "package.json"))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Manifest)));
  const runtimeBytes = yield* fs.readFile(runtimeArchive);
  expect(manifest.runtimes[target]).toBe(createHash("sha256").update(runtimeBytes).digest("hex"));
  const releaseFile = `/executor@${manifest.version}/executor-${manifest.version}-${target}.tgz`;
  const runtimes = path.join(home, ".executor", "v2", "launcher");
  const installed = path.join(runtimes, manifest.version);
  return {
    fs,
    path,
    processes,
    root,
    home,
    run,
    launcher,
    manifest,
    runtimeBytes,
    releaseFile,
    runtimes,
    installed,
  };
});

it.live(
  "the npm launcher downloads and checks its runtime once, starts it through every entry point, passes on its exit code and signals, and refuses a download that does not match",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {
          fs,
          path,
          processes,
          root,
          home,
          run,
          launcher,
          manifest,
          runtimeBytes,
          releaseFile,
          runtimes,
          installed,
        } = yield* scenario;
        const oldNode = yield* Config.NonEmptyString("EXECUTOR_E2E_OLD_NODE").pipe(Config.option);
        const files = new Map([[releaseFile, runtimeBytes]]);
        const releases = yield* serve(files);
        const download = { EXECUTOR_DOWNLOAD_URL: `http://127.0.0.1:${releases.port}/` };
        const entry = path.join(launcher, "bin.mjs");

        const day = 24 * 60 * 60 * 1000;
        const now = Date.now();
        for (const [name, age] of [
          ["2.0.0-beta.1", 2 * day],
          ["2.0.0-beta.2", day],
          [".download-1-abandoned", 2 * day],
        ] as const) {
          yield* fs.makeDirectory(path.join(runtimes, name), { recursive: true });
          const time = new Date(now - age);
          yield* fs.utimes(path.join(runtimes, name), time, time);
        }

        const first = yield* run(
          Option.getOrElse(oldNode, () => process.execPath),
          [entry, "--version"],
          root,
          download,
        );
        expect(first.code, first.stderr).toBe(0);
        expect(first.stdout).toBe(`executor v${manifest.version}`);
        expect(first.stderr).toContain(
          `Downloading Executor ${manifest.version} for ${process.platform}-${process.arch}`,
        );
        expect(releases.requests.get(releaseFile)).toBe(1);
        expect(
          yield* fs.exists(
            path.join(installed, process.platform === "win32" ? "executor.exe" : "executor"),
          ),
        ).toBe(true);
        expect((yield* fs.readDirectory(runtimes)).sort()).toEqual(
          ["2.0.0-beta.2", manifest.version].sort(),
        );

        for (const file of ["bin.mjs", "bin/executor"]) {
          const script = path.join(launcher, file);
          const viaNode = yield* run(process.execPath, [script, "--version"], root, download);
          expect(viaNode.code, viaNode.stderr).toBe(0);
          expect(viaNode.stdout).toBe(`executor v${manifest.version}`);
          if (process.platform !== "win32") {
            const viaShebang = yield* run(script, ["--version"], root, download);
            expect(viaShebang.code, viaShebang.stderr).toBe(0);
            expect(viaShebang.stdout).toBe(`executor v${manifest.version}`);
          }
        }
        if (Option.isSome(oldNode)) {
          const old = yield* run(oldNode.value, ["--version"], root);
          expect(manifest.engines.node).toBe(`>=${old.stdout.replace(/^v/u, "")}`);
        }
        expect(releases.requests.get(releaseFile)).toBe(1);

        const executable = path.join(installed, executableName);
        const direct = yield* run(executable, ["web"], root);
        const launched = yield* run(process.execPath, [entry, "web"], root);
        expect(direct.code).toBe(1);
        expect(launched.code).toBe(direct.code);
        expect(launched.stderr).toBe(direct.stderr);

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
                    HOME: home,
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
          expect(Number(stopped)).toBe(130);
          expect(yield* fs.exists(path.join(root, "data", "server.json"))).toBe(false);
          const status = yield* run(executable, ["service", "status"], root, {
            EXECUTOR_DATA_DIR: path.join(root, "data"),
          });
          expect(status.code, status.stderr).toBe(0);
          expect(status.stdout).toBe("stopped");
          expect(yield* connectionRefused(port)).toBe(true);
        }

        yield* fs.remove(installed, { recursive: true });
        files.set(releaseFile, new Uint8Array([...runtimeBytes.subarray(0, 1024), 0]));
        const tampered = yield* run(process.execPath, [entry, "--version"], root, download);
        expect(tampered.code).toBe(1);
        expect(tampered.stderr).toContain("does not match the SHA-256 this package records");
        expect(tampered.stderr).toContain("Nothing was installed.");
        expect(yield* fs.exists(installed)).toBe(false);
        expect((yield* fs.readDirectory(runtimes)).filter((name) => name.startsWith("."))).toEqual(
          [],
        );

        files.delete(releaseFile);
        const missing = yield* run(process.execPath, [entry, "--version"], root, download);
        expect(missing.code).toBe(1);
        expect(missing.stderr).toContain(
          `could not download its runtime from http://127.0.0.1:${releases.port}${releaseFile}: HTTP 404`,
        );
        expect(missing.stderr).toContain("EXECUTOR_DOWNLOAD_URL");
        expect(yield* fs.exists(installed)).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);

it.live(
  "bun add -g and bun update -g keep a working executor, while a background Executor runs and the registry still lists a deprecated runtime version",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, path, root, run, launcher, manifest, runtimeBytes, releaseFile, runtimes } =
          yield* scenario;
        const launcherBytes = yield* fs.readFile(
          path.resolve(yield* Config.String("EXECUTOR_E2E_LAUNCHER_ARCHIVE")),
        );
        const next = manifest.version.includes("-")
          ? `${manifest.version}.1`
          : manifest.version.replace(/\d+$/u, (patch) => String(Number(patch) + 1));
        const repack = path.join(root, "repack");
        yield* fs.makeDirectory(repack);
        yield* fs.copy(launcher, path.join(repack, "package"));
        const nextManifest = path.join(repack, "package", "package.json");
        yield* fs.writeFileString(
          nextManifest,
          (yield* fs.readFileString(nextManifest)).replace(
            `"version": "${manifest.version}"`,
            `"version": "${next}"`,
          ),
        );
        const packed = yield* run("tar", ["-czf", "next.tgz", "package"], repack);
        expect(packed.code, packed.stderr).toBe(0);
        const nextBytes = yield* fs.readFile(path.join(repack, "next.tgz"));
        const nextReleaseFile = `/executor@${next}/executor-${next}-${target}.tgz`;

        const runtimeVersion = `${manifest.version}-${target}`;
        const integrity = (bytes: Uint8Array) =>
          `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
        const files = new Map<string, Uint8Array>([
          [releaseFile, runtimeBytes],
          [nextReleaseFile, runtimeBytes],
          [`/executor/-/executor-${manifest.version}.tgz`, launcherBytes],
          [`/executor/-/executor-${next}.tgz`, nextBytes],
          [`/executor/-/executor-${runtimeVersion}.tgz`, runtimeBytes],
        ]);
        const server = yield* serve(files);
        const base = `http://127.0.0.1:${server.port}`;
        const launcherEntry = (version: string, bytes: Uint8Array) => ({
          name: "executor",
          version,
          bin: manifest.bin,
          engines: manifest.engines,
          dist: {
            tarball: `${base}/executor/-/executor-${version}.tgz`,
            integrity: integrity(bytes),
          },
        });
        const publish = (versions: Record<string, unknown>, beta: string) =>
          files.set(
            "/executor",
            new TextEncoder().encode(
              JSON.stringify({
                name: "executor",
                "dist-tags": { latest: "1.6.11", beta },
                versions: {
                  ...versions,
                  [runtimeVersion]: {
                    name: "executor",
                    version: runtimeVersion,
                    os: [process.platform],
                    cpu: [process.arch],
                    deprecated: "A platform runtime published in error; install executor@beta.",
                    dist: {
                      tarball: `${base}/executor/-/executor-${runtimeVersion}.tgz`,
                      integrity: integrity(runtimeBytes),
                    },
                  },
                },
              }),
            ),
          );
        publish(
          { [manifest.version]: launcherEntry(manifest.version, launcherBytes) },
          manifest.version,
        );

        const registry = yield* localNpmRegistry;
        const port = yield* freePort;
        const environment = {
          BUN_INSTALL: path.join(root, "bun"),
          BUN_INSTALL_CACHE_DIR: path.join(root, "bun-cache"),
          NPM_CONFIG_REGISTRY: `${base}/`,
          EXECUTOR_DOWNLOAD_URL: `${base}/`,
          EXECUTOR_DATA_DIR: path.join(root, "data"),
          EXECUTOR_PORT: String(port),
          EXECUTOR_KEY_STORAGE: "file",
          EXECUTOR_NO_UPDATE_CHECK: "1",
          EXECUTOR_NPM_REGISTRY: registry.url,
        };
        const global = path.join(root, "bun", "install", "global");
        const entry = path.join(global, "node_modules", "executor", "bin.mjs");
        const executor = (args: ReadonlyArray<string>) =>
          run(process.execPath, [entry, ...args], root, environment);
        const started = Effect.gen(function* () {
          const result = yield* executor(["--version"]);
          expect(result.code, result.stderr).toBe(0);
          expect(result.stdout).toBe(`executor v${manifest.version}`);
          if (process.platform !== "win32") {
            const shim = yield* run(
              path.join(root, "bun", "bin", "executor"),
              ["--version"],
              root,
              environment,
            );
            expect(shim.code, shim.stderr).toBe(0);
            expect(shim.stdout).toBe(`executor v${manifest.version}`);
          }
        });
        const installedVersion = fs
          .readFileString(path.join(global, "node_modules", "executor", "package.json"))
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Manifest)),
            Effect.map((installed) => installed.version),
          );

        const added = yield* run("bun", ["add", "-g", "executor@beta"], root, environment);
        expect(added.code, added.stderr).toBe(0);
        expect(yield* installedVersion).toBe(manifest.version);
        yield* started;
        const unchanged = yield* run("bun", ["update", "-g"], root, environment);
        expect(unchanged.code, unchanged.stderr).toBe(0);
        expect(yield* installedVersion).toBe(manifest.version);
        yield* started;
        expect(server.requests.get(releaseFile)).toBe(1);

        yield* Effect.addFinalizer(() => executor(["service", "stop"]).pipe(Effect.ignore));
        const service = yield* executor(["service", "start"]);
        expect(service.code, service.stderr).toBe(0);
        publish(
          {
            [manifest.version]: launcherEntry(manifest.version, launcherBytes),
            [next]: launcherEntry(next, nextBytes),
          },
          next,
        );
        const updated = yield* run("bun", ["update", "-g"], root, environment);
        expect(updated.code, updated.stderr).toBe(0);
        expect(yield* installedVersion).toBe(next);
        yield* started;
        expect(server.requests.get(nextReleaseFile)).toBe(1);
        expect((yield* fs.readDirectory(runtimes)).sort()).toEqual([manifest.version, next].sort());
        const status = yield* executor(["service", "status"]);
        expect(status.code, status.stderr).toBe(0);
        expect(status.stdout).toContain(`(version ${manifest.version},`);
        const stopped = yield* executor(["service", "stop"]);
        expect(stopped.code, stopped.stderr).toBe(0);
      }),
    ).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);
