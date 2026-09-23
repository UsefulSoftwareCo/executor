/** Bundle the official Node distribution matching the release build's pinned toolchain. */
import { createHash } from "node:crypto";
import { Effect, FileSystem, Path, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { nativePlatform } from "./config.ts";

class NodeRuntimeFailed extends Schema.TaggedError<NodeRuntimeFailed>()("NodeRuntimeFailed", {
  stage: Schema.Literals(["version", "checksum", "extract", "executable"]),
}) {}

/** Verify the upstream archive, then retain only Node's executable and complete license notices. */
export const installNodeRuntime = (runtime: string) =>
  Effect.gen(function* () {
    const target = nativePlatform(process.platform, process.arch);
    const version = process.version;
    if (!/^v24\.\d+\.\d+$/.test(version) || process.versions.electron !== undefined)
      return yield* new NodeRuntimeFailed({ stage: "version" });
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const windows = target.platform === "win32";
    const distribution = `node-${version}-${windows ? "win" : target.platform}-${target.arch}`;
    const archiveName = `${distribution}.${windows ? "zip" : "tar.gz"}`;
    const origin = `https://nodejs.org/dist/${version}`;
    const sums = yield* http
      .get(`${origin}/SHASUMS256.txt`)
      .pipe(Effect.flatMap((response) => response.text));
    const [expected, ...extra] = sums.split("\n").flatMap((line) => {
      const [digest, name] = line.trim().split(/\s+/);
      return name === archiveName && digest !== undefined && /^[a-f0-9]{64}$/.test(digest)
        ? [digest]
        : [];
    });
    if (expected === undefined || extra.length !== 0)
      return yield* new NodeRuntimeFailed({ stage: "checksum" });
    const response = yield* http.get(`${origin}/${archiveName}`);
    const bytes = new Uint8Array(yield* response.arrayBuffer);
    if (createHash("sha256").update(bytes).digest("hex") !== expected)
      return yield* new NodeRuntimeFailed({ stage: "checksum" });
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "executor-node-" });
    const archive = path.join(temporary, archiveName);
    yield* fs.writeFile(archive, bytes);
    // Windows ships bsdtar with ZIP support; Git Bash's GNU tar cannot read ZIPs.
    // Extract only the two distributed files, without npm's unused dependency tree.
    // Node's Windows env lookup is case-insensitive; ConfigProvider's copied record is not.
    const tar = windows
      ? path.join(
          yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(process.env.SystemRoot),
          "System32",
          "tar.exe",
        )
      : "tar";
    const sourceExecutable = windows ? "node.exe" : "bin/node";
    const extraction = ChildProcess.make(
      tar,
      ["-xf", archiveName, `${distribution}/${sourceExecutable}`, `${distribution}/LICENSE`],
      { cwd: temporary, stdout: "inherit", stderr: "inherit" },
    );
    if ((yield* processes.exitCode(extraction)) !== 0)
      return yield* new NodeRuntimeFailed({ stage: "extract" });
    const destination = path.join(runtime, "node");
    const executable = path.join(destination, windows ? "node.exe" : "node");
    yield* fs.makeDirectory(destination);
    yield* fs.copyFile(path.join(temporary, distribution, sourceExecutable), executable);
    yield* fs.copyFile(
      path.join(temporary, distribution, "LICENSE"),
      path.join(destination, "LICENSE"),
    );
    if ((yield* processes.string(ChildProcess.make(executable, ["--version"]))).trim() !== version)
      return yield* new NodeRuntimeFailed({ stage: "executable" });
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.scoped);
