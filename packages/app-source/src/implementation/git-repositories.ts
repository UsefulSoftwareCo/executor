/** Shared native Git operations; the host owns process and temporary-index capabilities. */
import { SourceFiles } from "@executor-js/sdk/core";
import { Effect, Schema, Semaphore, type Scope } from "effect";
import { protectGit } from "./protected-git.ts";
import {
  SourceError,
  Branch,
  GitCommit,
  Commit,
  sourceFiles,
  sourceFits,
  type RepositoryBackend,
} from "../contracts/repositories.ts";

/** Trusted native capabilities. Application code never receives this port. */
export interface GitHost {
  readonly directory: string;
  readonly git: (
    args: readonly string[],
    input?: Uint8Array,
    environment?: Record<string, string>,
  ) => Effect.Effect<{ readonly code: number; readonly output: Uint8Array }, SourceError>;
  readonly createDirectory: (path: string) => Effect.Effect<void, SourceError>;
  readonly temporaryIndex: Effect.Effect<string, SourceError, Scope.Scope>;
}

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

/** Create a lazy native implementation over private bare repositories; users clone ordinary working copies. */
export const gitRepositories = (host: GitHost): RepositoryBackend => {
  const directory = host.directory;
  const git = host.git;
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

  // Git initialization rewrites config; serialize setup within this host while ref writes stay concurrent.
  const initialization = Semaphore.makeUnsafe(1);
  const location = (id: string) => Effect.succeed(`${directory}/${id}.git`);
  const create = (id: string) =>
    Effect.gen(function* () {
      const repo = yield* location(id);
      yield* host.createDirectory(repo);
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
      }).pipe(Effect.mapError(() => new SourceError({ reason: "git" }))),
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
      ),
    commit: (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* location(input.id);
          if (input.expected === null) yield* create(input.id);
          const files = yield* sourceFiles(input.files);
          const index = yield* host.temporaryIndex;
          const environment = {
            GIT_INDEX_FILE: index,
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
      }),
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
