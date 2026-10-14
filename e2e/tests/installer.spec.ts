/**
 * The install scripts the docs serve (apps/docs/public/install.sh and install.ps1) install the
 * release archive for this machine from a release download, as the public release serves it:
 * they check it against SHA256SUMS, unpack it into the versions directory, point `current` at it
 * and put a command on PATH. A second install keeps the first as `previous`, and an archive that
 * does not match SHA256SUMS installs nothing. Set EXECUTOR_E2E_RUNTIME_ARCHIVE to the platform's
 * npm archive, which is the release archive.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Config, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const Manifest = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));

it.live(
  "the install scripts install the checked release archive for this machine, keep the previous version and refuse an archive that does not match SHA256SUMS",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const windows = process.platform === "win32";
        const archive = path.resolve(yield* Config.String("EXECUTOR_E2E_RUNTIME_ARCHIVE"));
        const { version } = yield* fs
          .readFileString(path.resolve("apps/cli/package.json"))
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Manifest)));
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-installer-" });
        const home = path.join(root, "home");
        yield* fs.makeDirectory(home);
        const executableName = windows ? "executor.exe" : "executor";

        // Release downloads by tag, and npm's dist-tags, as the public services serve them.
        const downloads = new Map<string, Uint8Array>();
        let tags: Record<string, string> = { latest: "1.9.9", beta: version };
        const services = yield* Layer.build(
          HttpRouter.serve(
            Layer.mergeAll(
              HttpRouter.add(
                "GET",
                "/-/package/executor/dist-tags",
                Effect.suspend(() => HttpServerResponse.json(tags)),
              ),
              HttpRouter.add(
                "GET",
                "/download/:tag/:file",
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
            Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
          ),
        );
        const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
        if (!("port" in server.address)) return yield* Effect.die("The server must listen on TCP");
        const origin = `http://127.0.0.1:${server.address.port}`;

        const exec = (
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
              ).pipe(Effect.timeout("180 seconds"));
              return { code: Number(code), stdout: stdout.trim(), stderr: stderr.trim() };
            }),
          );
        // A shell under Rosetta reports x64 on Apple silicon, where the script installs the native
        // build; this process's own archive serves under that name.
        const translated =
          process.platform === "darwin" && process.arch === "x64"
            ? (yield* exec("sysctl", ["-n", "sysctl.proc_translated"], root)).stdout === "1"
            : false;
        const arch = translated ? "arm64" : process.arch;
        /** Serve `bytes` as `release`'s archive, listed in SHA256SUMS with `listed` or its digest. */
        const publish = (release: string, bytes: Uint8Array, listed?: string) => {
          const file = `executor-${release}-${process.platform}-${arch}.tgz`;
          const digest = createHash("sha256").update(bytes).digest("hex");
          downloads.set(`executor@${release}/${file}`, bytes);
          downloads.set(
            `executor@${release}/SHA256SUMS`,
            new TextEncoder().encode(`${listed ?? digest}  ./${file}\n`),
          );
        };
        const runtime = path.join(home, ".executor", "v2", "runtime");
        const install = (args: ReadonlyArray<string>) =>
          exec(
            windows ? "powershell" : "sh",
            windows
              ? [
                  "-NoProfile",
                  "-ExecutionPolicy",
                  "Bypass",
                  "-File",
                  path.resolve("apps/docs/public/install.ps1"),
                  ...args,
                ]
              : [path.resolve("apps/docs/public/install.sh"), ...args],
            root,
            {
              HOME: home,
              USERPROFILE: home,
              EXECUTOR_DOWNLOAD_URL: `${origin}/download`,
              EXECUTOR_NPM_REGISTRY: origin,
              // The test leaves this machine's user PATH alone.
              EXECUTOR_NO_MODIFY_PATH: "1",
            },
          );
        const linked = (name: "current" | "previous") =>
          fs.readLink(path.join(runtime, name)).pipe(
            Effect.map((target) => path.basename(path.resolve(runtime, target))),
            Effect.orElseSucceed(() => undefined),
          );
        /** The command a terminal starts: ~/.local/bin/executor, or current\executor.exe. */
        const command = windows
          ? path.join(runtime, "current", executableName)
          : path.join(home, ".local", "bin", "executor");

        // Without a version the script installs the newest Executor 2 release: npm's `latest`
        // still names Executor 1, so the beta.
        publish(version, yield* fs.readFile(archive));
        const first = yield* install([]);
        expect(first.code, first.stderr).toBe(0);
        expect(first.stdout).toContain(`Installed Executor ${version}`);
        expect(yield* linked("current")).toBe(version);
        expect(yield* linked("previous")).toBeUndefined();
        const started = yield* exec(command, ["--version"], root, {
          HOME: home,
          USERPROFILE: home,
        });
        expect(started.stdout).toBe(`executor v${version}`);

        // An archive that does not match SHA256SUMS installs nothing.
        publish("2.998.0", yield* fs.readFile(archive), "0".repeat(64));
        const tampered = yield* install(["2.998.0"]);
        expect(tampered.code).toBe(1);
        expect(tampered.stderr).toContain("does not match the release's SHA256SUMS");
        expect(yield* fs.exists(path.join(runtime, "versions", "2.998.0"))).toBe(false);
        expect(yield* linked("current")).toBe(version);

        // A newer release replaces it as current and keeps it as previous. Its archive holds an
        // executable that reports the new version.
        const work = path.join(root, "release");
        yield* fs.makeDirectory(path.join(work, "package"), { recursive: true });
        yield* fs.writeFileString(
          path.join(work, "stub.mjs"),
          'console.log("executor v2.999.0");\n',
        );
        const built = yield* exec(
          "bun",
          ["build", "--compile", "stub.mjs", "--outfile", path.join("package", executableName)],
          work,
        );
        expect(built.code, built.stderr).toBe(0);
        const tar = windows
          ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
          : "tar";
        const packed = yield* exec(tar, ["-czf", "next.tgz", "package"], work);
        expect(packed.code, packed.stderr).toBe(0);
        publish("2.999.0", yield* fs.readFile(path.join(work, "next.tgz")));
        tags = { latest: "2.999.0", beta: version };
        const second = yield* install([]);
        expect(second.code, second.stderr).toBe(0);
        expect(second.stdout).toContain(`Executor ${version} stays installed`);
        expect(yield* linked("current")).toBe("2.999.0");
        expect(yield* linked("previous")).toBe(version);
        const upgraded = yield* exec(command, ["--version"], root, {
          HOME: home,
          USERPROFILE: home,
        });
        expect(upgraded.stdout).toBe("executor v2.999.0");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
