/** Native Git backend. All processes and temporary indexes belong to the calling Effect scope. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SourceFiles } from "@executor-js/sdk/core";
import { Effect, FileSystem, Path, Schema, Semaphore, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { protectGit } from "./implementation/protected-git.ts";
import {
  SourceError,
  Branch,
  GitCommit,
  Commit,
  sourceFiles,
  sourceFits,
  type RepositoryBackend,
} from "./contracts/repositories.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const concat = (left: Uint8Array, right: Uint8Array) => {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
};
const decode = (body: Uint8Array) =>
  Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(body),
    catch: () => new SourceError({ reason: "invalid-source" }),
  });

/** Execute without a shell. Git diagnostics can contain source or paths and are discarded. */
const git = (
  args: ReadonlyArray<string>,
  input?: Uint8Array,
  environment?: Record<string, string>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const process = yield* spawner.spawn(
        ChildProcess.make("git", ["-c", "core.hooksPath=/dev/null", ...args], {
          stdin: input === undefined ? "ignore" : Stream.succeed(input),
          stdout: "pipe",
          stderr: "ignore",
          extendEnv: true,
          env: {
            GIT_TERMINAL_PROMPT: "0",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            ...environment,
          },
        }),
      );
      const chunks: Uint8Array[] = [];
      let length = 0;
      yield* process.stdout.pipe(
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            chunks.push(chunk);
            length += chunk.length;
          }),
        ),
      );
      const output = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
      }
      return { code: Number(yield* process.exitCode), output };
    }),
  ).pipe(Effect.mapError(() => new SourceError({ reason: "git" })));
const run = (
  args: ReadonlyArray<string>,
  input?: Uint8Array,
  environment?: Record<string, string>,
) =>
  git(args, input, environment).pipe(
    Effect.flatMap((result) =>
      result.code === 0
        ? Effect.succeed(result.output)
        : Effect.fail(new SourceError({ reason: "git" })),
    ),
  );
const text = (
  args: ReadonlyArray<string>,
  input?: Uint8Array,
  environment?: Record<string, string>,
) =>
  run(args, input, environment).pipe(
    Effect.flatMap(decode),
    Effect.map((value) => value.trimEnd()),
  );

/** Create a lazy native implementation over private bare repositories; users clone ordinary working copies. */
export const nativeRepositories = (directory: string): RepositoryBackend => {
  // Git initialization rewrites config; serialize setup within this host while ref writes stay concurrent.
  const initialization = Semaphore.makeUnsafe(1);
  const location = (id: string) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      return path.resolve(directory, `${id}.git`);
    });
  const provide = Effect.provide(NodeServices.layer);
  const create = (id: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* location(id);
      yield* fs.makeDirectory(repo, { recursive: true, mode: 0o700 });
      yield* run([
        "init",
        "--bare",
        "--object-format=sha1",
        "--initial-branch=main",
        "--template=",
        repo,
      ]);
      yield* run(["--git-dir", repo, "config", "http.receivepack", "true"]);
      yield* run(["--git-dir", repo, "config", "gc.auto", "0"]);
    }).pipe(
      initialization.withPermits(1),
      Effect.mapError(() => new SourceError({ reason: "git" })),
      provide,
    );
  return protectGit({
    history: (id) =>
      Effect.gen(function* () {
        const output = yield* text([
          "--git-dir",
          yield* location(id),
          "log",
          "-50",
          "--format=%H%x00%an%x00%at%x00%s",
          "refs/heads/main",
        ]);
        const rows = output
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [commit, author, timestamp, message] = line.split("\0");
            return { commit, author, timestamp: Number(timestamp), message };
          });
        return yield* Schema.decodeUnknownEffect(Schema.Array(GitCommit))(rows);
      }).pipe(
        Effect.mapError(() => new SourceError({ reason: "git" })),
        provide,
      ),
    create,
    head: (id, branch) =>
      Effect.gen(function* () {
        const name = yield* Schema.decodeUnknownEffect(Branch)(branch);
        const repo = yield* location(id);
        const result = yield* git([
          "--git-dir",
          repo,
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${name}`,
        ]);
        if (result.code === 1) return null;
        if (result.code !== 0) return yield* new SourceError({ reason: "git" });
        return yield* text(["--git-dir", repo, "rev-parse", `refs/heads/${name}`]).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Commit)),
        );
      }).pipe(
        Effect.mapError((error) =>
          Schema.is(SourceError)(error) ? error : new SourceError({ reason: "invalid-source" }),
        ),
        provide,
      ),
    read: (id, ref) =>
      Effect.gen(function* () {
        const repo = yield* location(id);
        // Restrict revisions before passing them to rev-parse; no option or revision-expression injection.
        const resolved = Schema.is(Commit)(ref)
          ? ref
          : `refs/heads/${yield* Schema.decodeUnknownEffect(Branch)(ref)}`;
        const revision = yield* git([
          "--git-dir",
          repo,
          "rev-parse",
          "--verify",
          "--quiet",
          `${resolved}^{commit}`,
        ]);
        if (revision.code === 1 && !Schema.is(Commit)(ref))
          return yield* new SourceError({ reason: "not-found" });
        if (revision.code !== 0) return yield* new SourceError({ reason: "git" });
        const commit = yield* decode(revision.output).pipe(
          Effect.flatMap((value) => Schema.decodeUnknownEffect(Commit)(value.trimEnd())),
        );
        const tree = yield* text(["--git-dir", repo, "ls-tree", "-rz", commit]);
        const files: Array<{ path: string; content: string }> = [];
        let total = 0;
        for (const entry of tree.split("\0").filter(Boolean)) {
          const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
          if (match?.[2] === undefined || match[3] === undefined)
            return yield* new SourceError({ reason: "invalid-source" });
          const size = Number(yield* text(["--git-dir", repo, "cat-file", "-s", match[2]]));
          total += size;
          if (!Number.isSafeInteger(size) || size < 0 || !sourceFits(files.length + 1, total))
            return yield* new SourceError({ reason: "limit" });
          files.push({
            path: match[3],
            content: yield* run(["--git-dir", repo, "cat-file", "blob", match[2]]).pipe(
              Effect.flatMap(decode),
            ),
          });
        }
        return {
          commit,
          files: yield* sourceFiles(yield* Schema.decodeUnknownEffect(SourceFiles)(files)),
        };
      }).pipe(
        Effect.mapError((error) =>
          Schema.is(SourceError)(error) ? error : new SourceError({ reason: "invalid-source" }),
        ),
        provide,
      ),
    commit: (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const repo = yield* location(input.id);
          if (input.expected === null) yield* create(input.id);
          const files = yield* sourceFiles(input.files);
          const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "executor-git-" });
          const environment = {
            GIT_INDEX_FILE: path.join(temporary, "index"),
            GIT_AUTHOR_NAME: "Executor",
            GIT_AUTHOR_EMAIL: "apps@executor.local",
            GIT_COMMITTER_NAME: "Executor",
            GIT_COMMITTER_EMAIL: "apps@executor.local",
          };
          yield* run(["--git-dir", repo, "read-tree", "--empty"], undefined, environment);
          const entries: string[] = [];
          for (const file of files) {
            const oid = yield* text(
              ["--git-dir", repo, "hash-object", "-w", "--stdin"],
              bytes(file.content),
            );
            entries.push(`100644 ${oid}\t${file.path}\0`);
          }
          yield* run(
            ["--git-dir", repo, "update-index", "-z", "--index-info"],
            bytes(entries.join("")),
            environment,
          );
          const tree = yield* text(["--git-dir", repo, "write-tree"], undefined, environment);
          const commit = yield* text(
            [
              "--git-dir",
              repo,
              "commit-tree",
              tree,
              ...(input.expected === null ? [] : ["-p", input.expected]),
            ],
            bytes(input.message),
            environment,
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Commit)));
          const updated = yield* git([
            "--git-dir",
            repo,
            "update-ref",
            `refs/heads/${input.branch}`,
            commit,
            input.expected === null ? "0".repeat(40) : input.expected,
          ]);
          if (updated.code !== 0) return yield* new SourceError({ reason: "conflict" });
          return commit;
        }),
      ).pipe(
        Effect.mapError((error) =>
          Schema.is(SourceError)(error) ? error : new SourceError({ reason: "git" }),
        ),
        provide,
      ),
    request: (id, request) =>
      Effect.gen(function* () {
        const url = new URL(request.url);
        const service = url.pathname.endsWith("/info/refs")
          ? "/info/refs"
          : url.pathname.endsWith("/git-upload-pack")
            ? "/git-upload-pack"
            : url.pathname.endsWith("/git-receive-pack")
              ? "/git-receive-pack"
              : null;
        if (service === null) return new Response(null, { status: 404 });
        const input = yield* Effect.tryPromise({
          try: () => limitedBody(request),
          catch: () => new SourceError({ reason: "limit" }),
        });
        const output = yield* run(["http-backend"], input, {
          GIT_PROJECT_ROOT: directory,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: `/${id}.git${service}`,
          REQUEST_METHOD: request.method,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers.get("content-type") ?? "",
          CONTENT_LENGTH: String(input.length),
          REMOTE_USER: "executor",
          SERVER_PROTOCOL: "HTTP/1.1",
        });
        const separator = output.findIndex(
          (_, index) =>
            output[index] === 13 &&
            output[index + 1] === 10 &&
            output[index + 2] === 13 &&
            output[index + 3] === 10,
        );
        if (separator < 0) return yield* new SourceError({ reason: "git" });
        const headers = new Headers();
        let status = 200;
        for (const line of (yield* decode(output.slice(0, separator))).split("\r\n")) {
          const colon = line.indexOf(":");
          if (colon < 1) continue;
          const name = line.slice(0, colon);
          const value = line.slice(colon + 1).trim();
          if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
          else headers.set(name, value);
        }
        return new Response(output.slice(separator + 4), { status, headers });
      }).pipe(provide),
  });
};

/** Bound Git HTTP requests before passing them to the native CGI backend. */
export async function limitedBody(request: Request): Promise<Uint8Array> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  let output = new Uint8Array();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return output;
      if (output.length + part.value.length > 32 * 1024 * 1024)
        throw new Error("Git request too large");
      output = concat(output, part.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
