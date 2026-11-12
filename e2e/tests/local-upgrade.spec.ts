/**
 * Run the real `executor upgrade` from the directory layout each package manager installs into,
 * against a fake npm registry and fake package managers on PATH. The fakes record how they were
 * called and install an `executor` command that prints the version they were asked for, so the
 * scenario sees what the CLI ran and what it verified without touching this machine's installs.
 * A background server runs for part of it: the upgrade stops it before installing and starts it
 * on the new version, or on the old one when the install fails.
 *
 * A release executable is also run from the install script's layout, upgrading from a fake release
 * download: it checks the archive against SHA256SUMS, switches `current`, keeps the version it
 * replaced and rolls back to it, with its background server following each switch.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Config, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { scenarios } from "../test-plan.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { freePort } from "../support/ports.ts";
import {
  answersAsServer,
  crashServer,
  ServiceRegistration,
} from "../support/background-service.ts";
import { isScript } from "../support/local-entry.ts";
import { shadowInstall } from "../support/stand-in-package.ts";

const Call = Schema.fromJsonString(
  Schema.Struct({ name: Schema.String, args: Schema.Array(Schema.String) }),
);

/**
 * A package manager stand-in. It records its arguments, and with FAKE_PM_SERVER_LOG whether the
 * data directory had a registered server while it ran. Then, by FAKE_PM_MODE, it installs an
 * `executor` that only prints its version, one that cannot start, or (`cli`) one that runs the
 * checkout's CLI (FAKE_PM_CLI) as that version; or it fails as a registry error would.
 */
const fakePackageManager = `import { appendFileSync, chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [name, ...args] = process.argv.slice(2);
appendFileSync(process.env.FAKE_PM_LOG, JSON.stringify({ name, args }) + "\\n");
if (process.env.FAKE_PM_SERVER_LOG !== undefined)
  appendFileSync(process.env.FAKE_PM_SERVER_LOG, (existsSync(join(process.env.EXECUTOR_DATA_DIR, "server.json")) ? "registered" : "none") + "\\n");
const mode = process.env.FAKE_PM_MODE ?? "install";
if (mode === "fail") {
  console.error(name + " error: 503 Service Unavailable from the fake registry");
  process.exit(1);
}
const version = args.find((arg) => arg.startsWith("executor@")).slice("executor@".length);
console.log("installed executor@" + version + " with fake " + name);
const directory = process.env.FAKE_PM_BIN;
const node = JSON.stringify(process.execPath);
const cli = JSON.stringify(process.env.FAKE_PM_CLI ?? "");
if (process.platform === "win32") {
  writeFileSync(join(directory, "executor.cmd"), mode === "broken"
    ? "@echo off\\r\\necho Executor's native runtime is missing. 1>&2\\r\\nexit /b 1\\r\\n"
    : mode === "cli"
      ? "@echo off\\r\\nset EXECUTOR_BUILD_VERSION=" + version + "\\r\\n" + node + " " + cli + " %*\\r\\n"
      : "@echo off\\r\\necho executor v" + version + "\\r\\n");
} else {
  writeFileSync(join(directory, "executor"), mode === "broken"
    ? "#!/bin/sh\\necho \\"Executor's native runtime is missing.\\" >&2\\nexit 1\\n"
    : mode === "cli"
      ? "#!/bin/sh\\nEXECUTOR_BUILD_VERSION=" + version + " exec " + node + " " + cli + " \\"$@\\"\\n"
      : "#!/bin/sh\\necho \\"executor v" + version + "\\"\\n");
  chmodSync(join(directory, "executor"), 0o755);
}
`;

/**
 * A release executable in the install script's layout upgrades from a fake release download,
 * refuses an archive that does not match SHA256SUMS, and rolls back to the version it replaced.
 * The background server it runs stops for each switch and starts again on the version switched to.
 */
const standaloneUpgrade = (options: {
  readonly root: string;
  readonly entry: string;
  readonly version: string;
  readonly environment: (extra: Readonly<Record<string, string>>) => Record<string, string>;
  readonly downloads: Map<string, Uint8Array>;
  readonly registryUrl: string;
  /** What a background server needs in this scenario. */
  readonly serving: Readonly<Record<string, string>>;
  /** The checkout's CLI, which stands in for a release that runs a server. */
  readonly cli: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const evidence = yield* Evidence;
    const windows = process.platform === "win32";
    const executableName = windows ? "executor.exe" : "executor";
    const runtime = path.join(options.root, "home", ".executor", "v2", "runtime");
    const versions = path.join(runtime, "versions");
    yield* shadowInstall(options.entry, path.join(versions, options.version));
    const current = path.join(runtime, "current");
    yield* fs.symlink(path.join(versions, options.version), current);
    const exec = (
      command: string,
      args: ReadonlyArray<string>,
      settings: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> } = {},
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* processes.spawn(
            ChildProcess.make(command, args, {
              cwd: settings.cwd ?? options.root,
              extendEnv: false,
              env: options.environment({
                EXECUTOR_DOWNLOAD_URL: `${options.registryUrl}/download`,
                HOME: path.join(options.root, "home"),
                USERPROFILE: path.join(options.root, "home"),
                PATH: process.env.PATH ?? "",
                ...settings.env,
              }),
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
          ).pipe(Effect.timeout("150 seconds"));
          return { code: Number(code), stdout, stderr };
        }),
      );
    /**
     * Publish a release whose executable prints `reports`, with `listed` as its SHA256SUMS digest.
     * With `cli`, the executable runs the checkout's CLI as version `reports` instead.
     */
    const publish = (
      release: string,
      reports: string,
      settings: { readonly listed?: string; readonly cli?: boolean } = {},
    ) =>
      Effect.gen(function* () {
        const work = yield* fs.makeTempDirectoryScoped({ prefix: "executor-release-" });
        yield* fs.makeDirectory(path.join(work, "package"));
        yield* fs.writeFileString(
          path.join(work, "stub.mjs"),
          settings.cli === true
            ? [
                'import { spawnSync } from "node:child_process";',
                `const result = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(options.cli)}, ...process.argv.slice(2)], {`,
                '  stdio: "inherit",',
                `  env: { ...process.env, EXECUTOR_BUILD_VERSION: ${JSON.stringify(reports)} },`,
                "});",
                "process.exit(result.status ?? 1);",
                "",
              ].join("\n")
            : `console.log(${JSON.stringify(`executor v${reports}`)});\n`,
        );
        const built = yield* exec(
          "bun",
          ["build", "--compile", "stub.mjs", "--outfile", path.join("package", executableName)],
          { cwd: work },
        );
        expect(built.code, built.stderr).toBe(0);
        const file = `executor-${release}-${process.platform}-${process.arch}.tgz`;
        // Windows' own tar reads relative paths; Git's would read a drive letter as a host.
        const tar = windows
          ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
          : "tar";
        const packed = yield* exec(tar, ["-czf", file, "package"], { cwd: work });
        expect(packed.code, packed.stderr).toBe(0);
        const bytes = yield* fs.readFile(path.join(work, file));
        const digest = createHash("sha256").update(bytes).digest("hex");
        options.downloads.set(`executor@${release}/${file}`, bytes);
        options.downloads.set(
          `executor@${release}/SHA256SUMS`,
          new TextEncoder().encode(`${settings.listed ?? digest}  ./${file}\n`),
        );
      });
    const linked = (name: "current" | "previous") =>
      fs.readLink(path.join(runtime, name)).pipe(
        Effect.map((target) => path.basename(path.resolve(runtime, target))),
        Effect.orElseSucceed(() => undefined),
      );
    const previous = path.join(versions, options.version, executableName);
    /** What `executor service status` prints: the server's URL, version and process, or `stopped`. */
    const status = exec(previous, ["service", "status"], { env: options.serving }).pipe(
      Effect.map((result) => result.stdout.trim()),
    );

    // The background server runs from the version directory the upgrade replaces.
    const started = yield* exec(path.join(current, executableName), ["service", "start"], {
      env: options.serving,
    });
    expect(started.code, started.stderr).toBe(0);
    expect(yield* status).toContain(`(version ${options.version}, process`);

    // The command on PATH starts current/executor, which resolves to its version directory.
    yield* publish("2.999.0", "2.999.0", { cli: true });
    const upgraded = yield* exec(path.join(current, executableName), ["upgrade", "2.999.0"], {
      env: options.serving,
    });
    yield* evidence.json("standalone-upgrade.json", upgraded);
    expect(upgraded.code, upgraded.stderr).toBe(0);
    expect(upgraded.stdout).toContain(
      `Stopping the background Executor (v${options.version}) until the upgrade is done.`,
    );
    expect(upgraded.stdout).toContain(
      `Upgraded Executor from v${options.version} to v2.999.0. v${options.version} stays installed`,
    );
    expect(upgraded.stdout).toContain("Restarted the background Executor on v2.999.0.");
    expect(yield* linked("current")).toBe("2.999.0");
    expect(yield* linked("previous")).toBe(options.version);
    expect(yield* status).toContain("(version 2.999.0, process");
    const switched = yield* exec(path.join(current, executableName), ["--version"]);
    expect(switched.stdout.trim()).toBe("executor v2.999.0");

    // An archive that does not match SHA256SUMS is deleted and nothing changes, the running
    // server included.
    yield* publish("2.998.0", "2.998.0", { listed: "0".repeat(64) });
    const tampered = yield* exec(previous, ["upgrade", "2.998.0", "--yes"], {
      env: options.serving,
    });
    yield* evidence.json("standalone-checksum.json", tampered);
    expect(tampered.code).toBe(1);
    expect(tampered.stderr).toContain("does not match the SHA256SUMS of the v2.998.0 release");
    expect(tampered.stdout).not.toContain("Stopping the background Executor");
    expect(yield* fs.exists(path.join(versions, "2.998.0"))).toBe(false);
    expect(yield* linked("current")).toBe("2.999.0");

    // An archive whose executable does not report its version is removed.
    yield* publish("2.997.0", "2.0.0");
    const broken = yield* exec(previous, ["upgrade", "2.997.0", "--yes"], {
      env: options.serving,
    });
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain("did not start");
    expect(broken.stdout).not.toContain("Stopping the background Executor");
    expect(yield* fs.exists(path.join(versions, "2.997.0"))).toBe(false);
    expect(yield* linked("current")).toBe("2.999.0");
    expect(yield* status).toContain("(version 2.999.0, process");

    // Rollback returns to the version the upgrade replaced, and can be undone the same way. The
    // server follows it back.
    const rolledBack = yield* exec(previous, ["upgrade", "--rollback", "--yes"], {
      env: options.serving,
    });
    yield* evidence.json("standalone-rollback.json", rolledBack);
    expect(rolledBack.code, rolledBack.stderr).toBe(0);
    expect(rolledBack.stdout).toContain(
      "Stopping the background Executor (v2.999.0) until the upgrade is done.",
    );
    expect(rolledBack.stdout).toContain(`back to v${options.version}`);
    expect(rolledBack.stdout).toContain(
      `Restarted the background Executor on v${options.version}.`,
    );
    expect(yield* linked("current")).toBe(options.version);
    expect(yield* linked("previous")).toBe("2.999.0");
    expect(yield* status).toContain(`(version ${options.version}, process`);
    const restored = yield* exec(path.join(current, executableName), ["--version"]);
    expect(restored.stdout.trim()).toBe(`executor v${options.version}`);
  });

layer(TestLive, { excludeTestServices: true })("Local upgrade", (it) => {
  it.effect(
    scenarios.localUpgrade.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem,
            path = yield* Path.Path,
            processes = yield* ChildProcessSpawner.ChildProcessSpawner,
            evidence = yield* Evidence;
          const packagedEntry = yield* Config.NonEmptyString("EXECUTOR_E2E_LOCAL_ENTRY").pipe(
            Config.option,
          );
          const entry = path.resolve(
            Option.isSome(packagedEntry) ? packagedEntry.value : "apps/local/server/src/bin.ts",
          );
          const windows = process.platform === "win32";
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-upgrade-" });
          const bin = path.join(root, "bin");
          const log = path.join(root, "calls.jsonl");
          yield* fs.makeDirectory(bin);
          yield* fs.writeFileString(path.join(bin, "fake-pm.mjs"), fakePackageManager);
          for (const name of ["npm", "pnpm", "bun", "yarn"]) {
            const script = path.join(bin, "fake-pm.mjs");
            if (windows)
              yield* fs.writeFileString(
                path.join(bin, `${name}.cmd`),
                `@"${process.execPath}" "${script}" ${name} %*\r\n`,
              );
            else {
              yield* fs.writeFileString(
                path.join(bin, name),
                `#!/bin/sh\nexec "${process.execPath}" "${script}" ${name} "$@"\n`,
              );
              yield* fs.chmod(path.join(bin, name), 0o755);
            }
          }
          /** The package manager calls since the last read. */
          const calls = Effect.gen(function* () {
            if (!(yield* fs.exists(log))) return [];
            const lines = (yield* fs.readFileString(log)).split("\n").filter(Boolean);
            yield* fs.remove(log);
            return yield* Effect.forEach(lines, (line) => Schema.decodeUnknownEffect(Call)(line));
          });

          // The registry's dist-tags and the Node range each release declares.
          let published: Record<string, string> = {};
          let nodeRange = ">=24.14.0";
          // Release downloads by tag. As on GitHub, each download redirects to the file's asset URL.
          const downloads = new Map<string, Uint8Array>();
          const services = yield* Layer.build(
            HttpRouter.serve(
              Layer.mergeAll(
                HttpRouter.add(
                  "GET",
                  "/-/package/executor/dist-tags",
                  Effect.suspend(() => HttpServerResponse.json(published)),
                ),
                HttpRouter.add(
                  "GET",
                  "/executor/:version",
                  Effect.gen(function* () {
                    const { version } = yield* HttpRouter.schemaPathParams(
                      Schema.Struct({ version: Schema.String }),
                    );
                    return yield* HttpServerResponse.json({
                      name: "executor",
                      version,
                      engines: { node: nodeRange },
                    });
                  }).pipe(Effect.orDie),
                ),
                HttpRouter.add(
                  "GET",
                  "/download/:tag/:file",
                  Effect.gen(function* () {
                    const { tag, file } = yield* HttpRouter.schemaPathParams(
                      Schema.Struct({ tag: Schema.String, file: Schema.String }),
                    );
                    return downloads.has(`${decodeURIComponent(tag)}/${file}`)
                      ? HttpServerResponse.redirect(`/assets/${tag}/${file}`, { status: 302 })
                      : HttpServerResponse.empty({ status: 404 });
                  }).pipe(Effect.orDie),
                ),
                HttpRouter.add(
                  "GET",
                  "/assets/:tag/:file",
                  Effect.gen(function* () {
                    const { tag, file } = yield* HttpRouter.schemaPathParams(
                      Schema.Struct({ tag: Schema.String, file: Schema.String }),
                    );
                    const bytes = downloads.get(`${decodeURIComponent(tag)}/${file}`);
                    return bytes === undefined
                      ? HttpServerResponse.empty({ status: 404 })
                      : HttpServerResponse.uint8Array(bytes);
                  }).pipe(Effect.orDie),
                ),
              ),
              { disableLogger: true, disableListenLog: true },
            ).pipe(
              Layer.provideMerge(
                NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }),
              ),
            ),
          );
          const registry = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
          if (!("port" in registry.address))
            return yield* Effect.die("Registry must listen on TCP");
          const registryUrl = `http://127.0.0.1:${registry.address.port}`;

          /**
           * A launcher at `location` that starts the CLI, as a package manager's install would: the
           * npm launcher, whose runtime for this version is already downloaded (the release
           * executable's directory), or a script that imports the source entry.
           */
          const installedAt = (location: string) =>
            Effect.gen(function* () {
              const directory = path.join(root, location);
              yield* fs.makeDirectory(directory, { recursive: true });
              const launcher = path.join(directory, "bin.mjs");
              if (isScript(entry)) {
                yield* fs.writeFileString(
                  launcher,
                  `await import(${JSON.stringify((yield* path.toFileUrl(entry)).href)});\n`,
                );
                return launcher;
              }
              yield* fs.copyFile(path.resolve("scripts/releases/npm-launcher.mjs"), launcher);
              yield* fs.writeFileString(
                path.join(directory, "package.json"),
                JSON.stringify({
                  name: "executor",
                  version: "2.0.0-beta.2",
                  type: "module",
                  // Never checked: the runtime below is already in place.
                  runtimes: { [`${process.platform}-${process.arch}`]: "0".repeat(64) },
                }),
              );
              const runtime = path.join(root, ".executor", "v2", "launcher", "2.0.0-beta.2");
              if (!(yield* fs.exists(runtime))) {
                yield* fs.makeDirectory(path.dirname(runtime), { recursive: true });
                yield* fs.symlink(path.dirname(entry), runtime);
              }
              return launcher;
            });
          const data = path.join(root, "data");
          const environment = (extra: Readonly<Record<string, string>>) => ({
            // Only the fake package managers and their installed `executor` are on PATH.
            PATH: bin,
            ...(windows
              ? {
                  SystemRoot: process.env.SystemRoot ?? "",
                  ComSpec: process.env.ComSpec ?? "",
                  PATHEXT: process.env.PATHEXT ?? "",
                  // The npm launcher keeps its runtimes in the home directory, as on macOS and Linux.
                  USERPROFILE: root,
                }
              : {}),
            HOME: root,
            // Release scenarios never send product analytics, even from a build with a baked key.
            DO_NOT_TRACK: "1",
            // A packaged CLI keeps its own release version; this one applies from source.
            EXECUTOR_BUILD_VERSION: "2.0.0-beta.2",
            EXECUTOR_NPM_REGISTRY: registryUrl,
            EXECUTOR_DATA_DIR: data,
            FAKE_PM_LOG: log,
            FAKE_PM_BIN: bin,
            ...extra,
          });
          const run = (
            launcher: string,
            args: ReadonlyArray<string>,
            extra: Readonly<Record<string, string>> = {},
          ) =>
            evidence.step(
              `executor ${args.join(" ")} (${path.relative(root, path.dirname(launcher))})`,
              Effect.scoped(
                Effect.gen(function* () {
                  const child = yield* processes.spawn(
                    ChildProcess.make(process.execPath, [launcher, ...args], {
                      cwd: root,
                      extendEnv: false,
                      env: environment(extra),
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
                    // An upgrade may stop and start the background server.
                  ).pipe(Effect.timeout("150 seconds"));
                  return { code: Number(code), stdout, stderr };
                }),
              ),
            );

          const npm = yield* installedAt("npm-prefix/lib/node_modules/executor");
          const printed = yield* run(npm, ["--version"]);
          const version = printed.stdout.trim().replace(/^executor v/u, "");
          const channel = version.includes("-beta.") ? "beta" : "latest";
          // Beta installs move to stable once it is newer, so the stable release is the target.
          published = { beta: "2.999.0-beta.1", latest: "2.999.0" };
          const upgraded = `Upgraded Executor from v${version} to v2.999.0.`;

          // npm installs the launcher globally; it downloads the native runtime when it first starts.
          const byNpm = yield* run(npm, ["upgrade"]);
          yield* evidence.json("npm.json", byNpm);
          expect(byNpm.code, byNpm.stderr).toBe(0);
          expect(byNpm.stdout).toContain("installed executor@2.999.0 with fake npm");
          expect(byNpm.stdout).toContain(upgraded);
          expect(yield* calls).toEqual([
            { name: "npm", args: ["install", "-g", "executor@2.999.0"] },
          ]);

          // Each global package manager is detected from where it installs packages.
          for (const [location, name, args] of [
            ["pnpm/global/5/.pnpm/executor@2.0.0/node_modules/executor", "pnpm", ["add", "-g"]],
            [".bun/install/global/node_modules/executor", "bun", ["add", "-g"]],
            [".config/yarn/global/node_modules/executor", "yarn", ["global", "add"]],
          ] as const) {
            const result = yield* run(yield* installedAt(location), ["upgrade"]);
            expect(result.code, result.stderr).toBe(0);
            expect(result.stdout).toContain(upgraded);
            expect(yield* calls).toEqual([{ name, args: [...args, "executor@2.999.0"] }]);
          }

          // --method overrides the detected package manager.
          const overridden = yield* run(npm, ["upgrade", "--method", "pnpm"]);
          expect(overridden.code, overridden.stderr).toBe(0);
          expect(yield* calls).toEqual([{ name: "pnpm", args: ["add", "-g", "executor@2.999.0"] }]);

          // One-shot runners fetch the release each time; the CLI prints the command instead.
          for (const [location, runner] of [
            [".npm/_npx/0a1b2c3d/node_modules/executor", "npx"],
            ["tmp/bunx-501-executor@beta/node_modules/executor", "bunx"],
            [
              "pnpm-cache/dlx/abc/1/node_modules/.pnpm/executor@2.0.0/node_modules/executor",
              "pnpm dlx",
            ],
          ] as const) {
            const result = yield* run(yield* installedAt(location), ["upgrade"]);
            yield* evidence.json(`${runner.replace(" ", "-")}.json`, result);
            expect(result.code, result.stderr).toBe(0);
            expect(result.stdout).toContain(`Run the release with: ${runner} executor@${channel}`);
            expect(yield* calls).toEqual([]);
          }

          // A location no package manager uses gets the exact commands, and nothing is installed.
          const unknown = yield* run(yield* installedAt("opt/tools/executor"), ["upgrade"]);
          yield* evidence.json("unknown.json", unknown);
          expect(unknown.code).toBe(1);
          expect(unknown.stderr).toContain(
            "Executor could not tell which package manager installed it",
          );
          for (const command of [
            "npm install -g executor@2.999.0",
            "pnpm add -g executor@2.999.0",
            "bun add -g executor@2.999.0",
            "yarn global add executor@2.999.0",
          ])
            expect(unknown.stderr).toContain(command);
          expect(yield* calls).toEqual([]);

          // A Node older than the release requires is refused before anything changes.
          nodeRange = ">=99.0.0";
          const oldNode = yield* run(npm, ["upgrade"]);
          yield* evidence.json("node-too-old.json", oldNode);
          expect(oldNode.code).toBe(1);
          expect(oldNode.stderr).toContain(
            `Executor v2.999.0 requires Node.js >=99.0.0, and this is Node.js v${process.versions.node}.`,
          );
          expect(oldNode.stderr).toContain("Nothing was changed.");
          expect(yield* calls).toEqual([]);
          nodeRange = ">=24.14.0";

          // A package manager failure is reported with what it printed.
          const failedInstall = yield* run(npm, ["upgrade"], { FAKE_PM_MODE: "fail" });
          yield* evidence.json("install-failed.json", failedInstall);
          expect(failedInstall.code).toBe(1);
          expect(failedInstall.stderr).toContain(
            "npm exited with code 1 and did not install Executor v2.999.0.",
          );
          expect(failedInstall.stderr).toContain("503 Service Unavailable from the fake registry");
          expect(failedInstall.stdout).not.toContain("Upgraded");

          // An installed command that cannot start fails the upgrade.
          const broken = yield* run(npm, ["upgrade"], { FAKE_PM_MODE: "broken" });
          yield* evidence.json("verify-failed.json", broken);
          expect(broken.code).toBe(1);
          expect(broken.stderr).toContain(
            "npm installed Executor v2.999.0, but `executor --version` failed with code 1",
          );
          expect(broken.stderr).toContain("Executor's native runtime is missing.");
          expect(broken.stdout).not.toContain("Upgraded");
          yield* calls;

          // A downgrade needs an explicit version and confirmation; without a terminal, --yes.
          const downgrade = yield* run(npm, ["upgrade", "2.0.0-beta.1"]);
          expect(downgrade.code).toBe(1);
          expect(downgrade.stderr).toContain(
            "To downgrade, run: executor upgrade 2.0.0-beta.1 --yes. Nothing was changed.",
          );
          expect(yield* calls).toEqual([]);
          const confirmed = yield* run(npm, ["upgrade", "2.0.0-beta.1", "--yes"]);
          expect(confirmed.code, confirmed.stderr).toBe(0);
          expect(confirmed.stdout).toContain(
            `Upgraded Executor from v${version} to v2.0.0-beta.1.`,
          );
          expect(yield* calls).toEqual([
            { name: "npm", args: ["install", "-g", "executor@2.0.0-beta.1"] },
          ]);

          // A background server for this data directory, which every scenario below stops.
          const port = yield* freePort;
          const serverLog = path.join(root, "server-seen.log");
          // The checkout's CLI compiles its Worker host when no prepared one exists, as in the
          // release workflow, which builds none.
          const workerBundle = path.resolve(".local/test-runtime/host.json");
          const prepared = yield* fs.exists(workerBundle);
          const serving = {
            // The installed `executor` comes first; Git and Node follow for the server.
            PATH: [bin, process.env.PATH ?? ""].join(windows ? ";" : ":"),
            EXECUTOR_ENVIRONMENT: "e2e",
            // Keys stay in keys.json so no run touches the machine's OS credential store.
            EXECUTOR_KEY_STORAGE: "file",
            ...(prepared ? { EXECUTOR_WORKER_BUNDLE: workerBundle } : {}),
            EXECUTOR_NO_UPDATE_CHECK: "1",
            EXECUTOR_PORT: String(port),
            FAKE_PM_CLI: path.resolve("apps/local/server/src/bin.ts"),
            FAKE_PM_SERVER_LOG: serverLog,
          };
          /** Whether a server was registered each time the package manager ran, since the last read. */
          const seen = Effect.gen(function* () {
            if (!(yield* fs.exists(serverLog))) return [];
            const lines = (yield* fs.readFileString(serverLog)).split("\n").filter(Boolean);
            yield* fs.remove(serverLog);
            return lines;
          });
          /** What `executor service status` prints: the server's URL, version and process, or `stopped`. */
          const status = run(npm, ["service", "status"], serving).pipe(
            Effect.map((result) => result.stdout.trim()),
          );
          const Registration = Schema.fromJsonString(ServiceRegistration);
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              yield* run(npm, ["service", "stop"], serving).pipe(Effect.ignore);
              // A server still answering as itself is ended with its collector and workerd; a
              // pid that does not may name another program by now.
              const left = yield* fs
                .readFileString(path.join(data, "server.json"))
                .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Registration)), Effect.option);
              if (Option.isSome(left) && (yield* answersAsServer(left.value)))
                yield* crashServer(left.value.pid);
            }),
          );
          // Startup deploys the bundled Executor app, which pins this checkout's apps release.
          const registryForApps = yield* Config.NonEmptyString("E2E_NPM_REGISTRY").pipe(
            Config.option,
          );
          if (Option.isSome(registryForApps)) {
            const saved = yield* run(
              npm,
              ["service", "set", "env", "EXECUTOR_NPM_REGISTRY", registryForApps.value],
              serving,
            );
            expect(saved.code, saved.stderr).toBe(0);
          }
          const started = yield* run(npm, ["service", "start"], serving);
          expect(started.code, started.stderr).toBe(0);
          expect(yield* status).toContain(`(version ${version}, process`);

          // The server stops before the package manager replaces its files, then the new
          // `executor service start` starts it on the new version.
          const restarted = yield* run(npm, ["upgrade"], { ...serving, FAKE_PM_MODE: "cli" });
          yield* evidence.json("running-server.json", restarted);
          expect(restarted.code, restarted.stderr).toBe(0);
          expect(restarted.stdout).toContain(
            `Stopping the background Executor (v${version}) until the upgrade is done.`,
          );
          expect(restarted.stdout).toContain(upgraded);
          expect(restarted.stdout).toContain("Restarted the background Executor on v2.999.0.");
          expect(yield* seen).toEqual(["none"]);
          expect(yield* status).toContain("(version 2.999.0, process");
          yield* calls;

          // A failed install starts the stopped server again, with this CLI.
          const failedRunning = yield* run(npm, ["upgrade"], { ...serving, FAKE_PM_MODE: "fail" });
          yield* evidence.json("running-server-install-failed.json", failedRunning);
          expect(failedRunning.code).toBe(1);
          expect(failedRunning.stdout).toContain(
            "Stopping the background Executor (v2.999.0) until the upgrade is done.",
          );
          expect(failedRunning.stderr).toContain(
            "npm exited with code 1 and did not install Executor v2.999.0.",
          );
          expect(yield* seen).toEqual(["none"]);
          expect(yield* status).toContain(`(version ${version}, process`);
          yield* calls;

          // A new version that does not start the server still upgrades, and says how to start it.
          const notRestarted = yield* run(npm, ["upgrade"], serving);
          yield* evidence.json("running-server-not-restarted.json", notRestarted);
          expect(notRestarted.code, notRestarted.stderr).toBe(0);
          expect(notRestarted.stdout).toContain(upgraded);
          expect(notRestarted.stderr).toContain(
            "The background Executor stopped for the upgrade and did not start again on v2.999.0.\nStart it with `executor service start`.",
          );
          expect(yield* status).toBe("stopped");
          yield* seen;
          yield* calls;

          // With no server registered, nothing is stopped or started.
          const stopped = yield* run(npm, ["upgrade"], serving);
          expect(stopped.code, stopped.stderr).toBe(0);
          expect(`${stopped.stdout}${stopped.stderr}`).not.toContain("background Executor");
          expect(yield* status).toBe("stopped");
          yield* seen;
          yield* calls;

          // Already current: the newest release on the channel is the installed one.
          published = { beta: version, latest: version };
          const current = yield* run(npm, ["upgrade"]);
          yield* evidence.json("already-current.json", current);
          expect(current.code, current.stderr).toBe(0);
          expect(current.stdout).toContain(
            `Executor v${version} is already the newest ${channel} release.`,
          );
          const same = yield* run(npm, ["upgrade", version]);
          expect(same.code, same.stderr).toBe(0);
          expect(same.stdout).toContain(`Executor v${version} is already installed.`);
          expect(yield* calls).toEqual([]);

          // Only the install script's layout keeps a previous version.
          const notStandalone = yield* run(npm, ["upgrade", "--rollback"]);
          expect(notStandalone.code).toBe(1);
          expect(notStandalone.stderr).toContain(
            "Only an install from the Executor install script",
          );

          if (isScript(entry)) return;
          yield* standaloneUpgrade({
            root,
            entry,
            version,
            environment,
            downloads,
            registryUrl,
            serving,
            cli: serving.FAKE_PM_CLI,
          });
        }),
      ),
    // Every command has its own timeout; several start and stop the background server.
    { timeout: 480_000 },
  );
});
