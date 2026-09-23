/** MinGit omits the CGI helper Executor uses for Git clone/push over HTTP. */
import { createHash } from "node:crypto";
import { Effect, FileSystem, Path, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const gitHash = "987381598c5cc4e7b6d7fb2c6b82e5d072dc47cce3d9d64ffb097352fee708c8";
const helperHash = "0a9ee3fe066386ecafed969c3cf3b55239283302ada9962eeceb83e77fa8cbfa";
// Upstream retained an older filename; its git.exe is byte-identical to the pinned MinGit 2.53.0.windows.4.
const archiveUrl =
  "https://github.com/git-for-windows/git/releases/download/v2.53.0.windows.4/mingw-w64-x86_64-git-2.52.0.1-1-any.pkg.tar.xz";
const archiveHash = "3bdf3b1059dfc740d2f28945767924b04363e52df43e6f9413ce00908c79bf77";
const helper = "mingw64/libexec/git-core/git-http-backend.exe";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

class WindowsGitFailed extends Schema.TaggedError<WindowsGitFailed>()("WindowsGitFailed", {
  stage: Schema.Literals(["architecture", "git-version", "archive", "extract", "helper"]),
}) {}

/** Add only the matching upstream helper, retaining the existing Git runtime and its DLLs. */
export const installWindowsGitHttpBackend = (stage: string) =>
  Effect.gen(function* () {
    if (process.platform !== "win32") return;
    if (process.arch !== "x64") return yield* new WindowsGitFailed({ stage: "architecture" });
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const git = path.join(stage, "node_modules/dugite/git");
    if (hash(yield* fs.readFile(path.join(git, "mingw64/bin/git.exe"))) !== gitHash)
      return yield* new WindowsGitFailed({ stage: "git-version" });
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const response = yield* client.get(archiveUrl);
    const bytes = new Uint8Array(yield* response.arrayBuffer);
    if (hash(bytes) !== archiveHash) return yield* new WindowsGitFailed({ stage: "archive" });
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "executor-windows-git-" });
    const archive = path.join(temporary, "git-package.tar.xz");
    yield* fs.writeFile(archive, bytes);
    const code = yield* processes.exitCode(
      // GNU tar reads drive-prefixed archive paths as remote hosts. Keep every path relative.
      ChildProcess.make("tar", ["-xf", path.basename(archive), helper], {
        cwd: temporary,
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
    if (code !== 0) return yield* new WindowsGitFailed({ stage: "extract" });
    const extracted = path.join(temporary, helper);
    if (hash(yield* fs.readFile(extracted)) !== helperHash)
      return yield* new WindowsGitFailed({ stage: "helper" });
    yield* fs.copyFile(extracted, path.join(git, helper));
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.scoped);
