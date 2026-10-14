/**
 * A standalone install: the release archive unpacked by the install script into
 * `<root>/versions/<version>/`, with `<root>/current` pointing at the version in use and
 * `<root>/previous` at the one before it. `<root>` is `~/.executor/v2/runtime` unless the person
 * chose another directory. A command on PATH starts `current/executor`, so switching `current`
 * switches every later start; a running process keeps the files it started from.
 *
 * Release archives come from the public release and are checked against its SHA256SUMS before
 * anything is unpacked.
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { createHash, randomUUID } from "node:crypto";
import { symlink } from "node:fs/promises";
import { Config, Duration, Effect, FileSystem, Option, Path, Stream } from "effect";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { UpgradeFailed } from "../contracts/startup.ts";

export interface StandaloneInstall {
  /** The directory holding `versions/`, `current` and `previous`. */
  readonly root: string;
  /** The version directory the running executable belongs to. */
  readonly version: string;
}

const executableName = (platform: string) => (platform === "win32" ? "executor.exe" : "executor");

/**
 * The standalone install that `executable` belongs to, or none when it was installed another way.
 * Launcher symlinks resolve to the version directory, so the real path shows the layout.
 */
export const standaloneInstall = (executable: string, platform: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const real = yield* fs.realPath(executable).pipe(Effect.orElseSucceed(() => executable));
    const directory = path.dirname(real);
    const versions = path.dirname(directory);
    const root = path.dirname(versions);
    return path.basename(real).toLowerCase() === executableName(platform) &&
      path.basename(versions) === "versions" &&
      path.basename(root) === "runtime"
      ? Option.some<StandaloneInstall>({ root, version: path.basename(directory) })
      : Option.none<StandaloneInstall>();
  });

/** The release archive for one platform: the platform's npm package, which holds the install. */
export const releaseArchive = (version: string, platform: string, arch: string) =>
  `executor-${version}-${platform}-${arch}.tgz`;

/**
 * Where release files are downloaded from: `<base>/executor@<version>/<file>`. Set
 * EXECUTOR_DOWNLOAD_URL to use a mirror of the public releases.
 */
export const downloadBase = Config.String("EXECUTOR_DOWNLOAD_URL").pipe(
  Config.withDefault("https://github.com/UsefulSoftwareCo/executor/releases/download"),
  Config.map((base) => base.replace(/\/+$/u, "")),
);

const failed = (reason: UpgradeFailed["reason"], message: string) =>
  new UpgradeFailed({ reason, message });

/** The SHA-256 a SHA256SUMS file lists for `file`, as `sha256sum` writes it. */
const listedDigest = (sums: string, file: string) => {
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](?:\.\/)?(.+)$/u.exec(line.trim());
    if (match !== null && match[2] === file) return match[1];
  }
  return undefined;
};

/** The version `current` or `previous` names, or none when it is missing or points elsewhere. */
export const linkedVersion = (root: string, name: "current" | "previous") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readLink(path.join(root, name)).pipe(
      Effect.map((target) => {
        const resolved = path.resolve(root, target);
        return path.dirname(resolved) === path.join(root, "versions")
          ? Option.some(path.basename(resolved))
          : Option.none<string>();
      }),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
  });

/**
 * Point `name` at `versions/<version>`. On macOS and Linux a new link replaces the old one in one
 * rename, so a start never finds it missing. Windows links directories with junctions, which
 * cannot be renamed over, so the old one is removed first.
 */
const link = (root: string, name: "current" | "previous", version: string, platform: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const destination = path.join(root, name);
    if (platform === "win32") {
      yield* fs.remove(destination, { force: true });
      yield* Effect.tryPromise(() =>
        symlink(path.join(root, "versions", version), destination, "junction"),
      );
      return;
    }
    const temporary = path.join(root, `.${name}-${randomUUID()}`);
    yield* fs.symlink(path.join("versions", version), temporary);
    yield* fs.rename(temporary, destination);
  });

/**
 * Make `version` current and remember the version it replaces as previous. Versions other than
 * these two are removed; one still running, which Windows keeps open, stays until a later switch.
 */
export const switchVersion = (install: StandaloneInstall, version: string, platform: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const current = yield* linkedVersion(install.root, "current");
    const replaced = Option.getOrElse(current, () => install.version);
    yield* link(install.root, "current", version, platform);
    if (replaced !== version) yield* link(install.root, "previous", replaced, platform);
    const keep = new Set([version, replaced]);
    const versions = path.join(install.root, "versions");
    for (const name of yield* fs.readDirectory(versions))
      if (!keep.has(name))
        yield* fs.remove(path.join(versions, name), { recursive: true }).pipe(Effect.ignore);
  }).pipe(
    Effect.mapError(() =>
      failed(
        "install-failed",
        `Executor could not switch ${install.root} to v${version}. Check that you can write to it, then run executor upgrade again.`,
      ),
    ),
  );

/** Run `executor --version` from a version directory. */
const reportedVersion = (executable: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(executable, ["--version"], {
          extendEnv: true,
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const [code, stdout] = yield* Effect.all(
        [child.exitCode, child.stdout.pipe(Stream.decodeText(), Stream.mkString)],
        { concurrency: "unbounded" },
      ).pipe(Effect.timeout(Duration.seconds(60)));
      return Number(code) === 0 ? stdout.trim() : undefined;
    }),
  ).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Download `version`'s archive for this platform, check it against the release's SHA256SUMS,
 * unpack it into `versions/<version>` and check that its executable reports that version. Nothing
 * outside `versions/` changes, and a failed step leaves no version directory behind.
 */
export const installVersion = (
  install: StandaloneInstall,
  version: string,
  platform: string,
  arch: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.filterStatusOk,
        HttpClient.followRedirects(5),
      );
      const base = `${yield* downloadBase}/executor@${version}`;
      const file = releaseArchive(version, platform, arch);
      const unavailable = (what: string) =>
        failed(
          "download-failed",
          `Executor could not download ${what} from ${base}. Check your connection or EXECUTOR_DOWNLOAD_URL, then try again. Nothing was changed.`,
        );
      const sums = yield* client.get(`${base}/SHA256SUMS`).pipe(
        Effect.flatMap((response) => response.text),
        Effect.timeout(Duration.seconds(30)),
        Effect.mapError(() => unavailable("SHA256SUMS")),
      );
      const expected = listedDigest(sums, file);
      if (expected === undefined)
        return yield* failed(
          "download-failed",
          `The v${version} release lists no ${file}, so it has no build for ${platform}/${arch}. Nothing was changed.`,
        );
      const versions = path.join(install.root, "versions");
      yield* fs.makeDirectory(versions, { recursive: true });
      // Partial files stay beside the versions they would join, on the same volume.
      const work = yield* fs.makeTempDirectoryScoped({
        directory: install.root,
        prefix: ".download-",
      });
      const archive = path.join(work, file);
      const hash = createHash("sha256");
      yield* client.get(`${base}/${file}`).pipe(
        Effect.flatMap((response) =>
          response.stream.pipe(
            Stream.tap((bytes) =>
              Effect.sync(() => {
                hash.update(bytes);
              }),
            ),
            Stream.run(fs.sink(archive)),
          ),
        ),
        Effect.mapError(() => unavailable(file)),
      );
      const actual = hash.digest("hex");
      if (actual !== expected)
        return yield* failed(
          "checksum-mismatch",
          `The downloaded ${file} does not match the SHA256SUMS of the v${version} release (expected ${expected}, got ${actual}). It was deleted and nothing was changed.`,
        );
      // npm archives hold one package/ directory. Windows' own tar reads a relative path; Git's
      // GNU tar would read a drive letter as a host name.
      const unpacked = path.join(work, "package");
      const tar =
        platform === "win32"
          ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
          : "tar";
      const code = yield* spawner
        .exitCode(ChildProcess.make(tar, ["-xzf", file], { cwd: work, stdout: "ignore" }))
        .pipe(Effect.orElseSucceed(() => -1));
      if (Number(code) !== 0)
        return yield* failed(
          "install-failed",
          `Executor could not unpack ${file} with tar. Nothing was changed.`,
        );
      const destination = path.join(versions, version);
      yield* fs.remove(destination, { recursive: true, force: true });
      yield* fs.rename(unpacked, destination);
      const reported = yield* reportedVersion(path.join(destination, executableName(platform)));
      if (reported !== `executor v${version}`) {
        yield* fs.remove(destination, { recursive: true, force: true }).pipe(Effect.ignore);
        return yield* failed(
          "verify-failed",
          `The downloaded Executor v${version} did not start${reported === undefined ? "" : ` (it reported "${reported}")`}. It was removed and nothing was changed.`,
        );
      }
      return destination;
    }),
  ).pipe(
    Effect.catchTag("PlatformError", () =>
      Effect.fail(
        failed(
          "install-failed",
          `Executor could not write to ${install.root}. Check that you can write to it, then run executor upgrade again. Nothing was changed.`,
        ),
      ),
    ),
    // The body is read before the client's connections close with this layer.
    Effect.provide(NodeHttpClient.layerNodeHttp),
  );
