/** Shared native Git operations; the host owns process and temporary-index capabilities. */
import {
  SourceError,
  SourceFiles,
  Branch,
  GitCommit,
  GitObjectId,
  SourceCommit,
  SourceFilePath,
  inlineBytes,
  isPublicSourcePath,
  isUpload,
  publicFits,
  sourceFiles,
  sourceFits,
  sourceLimits,
  removedPaths,
  type RepositoryBackend,
  type SourceFile,
} from "@executor-js/sdk/core";
import { Effect, Schema, Semaphore, type Scope } from "effect";
import { protectGit } from "./protected-git.ts";

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
  /**
   * Run `git http-backend` with a CGI environment, streaming `body` to its input. Returns its
   * output as Git writes it: CGI headers, a blank line, then the response body. Neither side is
   * held in memory, so clones and pushes are not bounded by the host's buffers.
   */
  readonly httpBackend: (
    environment: Record<string, string>,
    body: ReadableStream<Uint8Array> | null,
  ) => Effect.Effect<ReadableStream<Uint8Array>, SourceError>;
}

const bytes = (text: string) => new TextEncoder().encode(text);
const concat = (left: Uint8Array, right: Uint8Array) => {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
};
const headerEnd = (output: Uint8Array) =>
  output.findIndex(
    (_, index) =>
      output[index] === 13 &&
      output[index + 1] === 10 &&
      output[index + 2] === 13 &&
      output[index + 3] === 10,
  );
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
        const ref = `refs/heads/${name}`;
        // The pattern also lists refs beneath it; only the exact name counts, never an expansion.
        const refs = yield* text([
          "--git-dir",
          repo,
          "for-each-ref",
          "--format=%(objectname) %(refname)",
          ref,
        ]);
        const line = refs.split("\n").find((entry) => entry.slice(41) === ref);
        if (line === undefined) return null;
        return yield* Schema.decodeUnknownEffect(SourceCommit)(line.slice(0, 40));
      }).pipe(
        Effect.mapError((error) =>
          Schema.is(SourceError)(error) ? error : new SourceError({ reason: "invalid-source" }),
        ),
      ),
    read: (id, ref) =>
      Effect.gen(function* () {
        const repo = yield* location(id);
        // Restrict revisions before passing them to Git; no option or revision-expression injection.
        // A commit is read as given. A branch is resolved once so the tree and the commit agree.
        const commit = Schema.is(SourceCommit)(ref)
          ? yield* Effect.gen(function* () {
              // A commit that is not in the repository is missing, not a Git failure.
              const found = yield* git(["--git-dir", repo, "cat-file", "-e", `${ref}^{commit}`]);
              if (found.code !== 0) return yield* new SourceError({ reason: "not-found" });
              return ref;
            })
          : yield* Effect.gen(function* () {
              const name = yield* Schema.decodeUnknownEffect(Branch)(ref);
              const revision = yield* git([
                "--git-dir",
                repo,
                "rev-parse",
                "--verify",
                "--quiet",
                `refs/heads/${name}^{commit}`,
              ]);
              if (revision.code === 1) return yield* new SourceError({ reason: "not-found" });
              if (revision.code !== 0) return yield* new SourceError({ reason: "git" });
              return yield* decode(revision.output).pipe(
                Effect.flatMap((value) =>
                  Schema.decodeUnknownEffect(SourceCommit)(value.trimEnd()),
                ),
              );
            });
        // One process lists every file with its size, so the budgets hold before any content is read.
        const tree = yield* text([
          "--git-dir",
          repo,
          "ls-tree",
          "-r",
          "-l",
          "-z",
          `${commit}^{commit}`,
        ]);
        const entries: Array<{ path: string; object: string; size: number }> = [];
        for (const entry of tree.split("\0").filter(Boolean)) {
          const match = /^(100644|100755) blob ([a-f0-9]{40}) +(\d+)\t([\s\S]+)$/.exec(entry);
          if (match?.[2] === undefined || match[3] === undefined || match[4] === undefined)
            return yield* new SourceError({ reason: "invalid-source" });
          const size = Number(match[3]);
          if (!Number.isSafeInteger(size)) return yield* new SourceError({ reason: "limit" });
          entries.push({ path: match[4], object: match[2], size });
        }
        const code = entries.filter((entry) => !isPublicSourcePath(entry.path));
        const served = entries.filter((entry) => isPublicSourcePath(entry.path));
        const codeBytes = code.reduce((sum, entry) => sum + entry.size, 0);
        if (
          !sourceFits(code.length, codeBytes) ||
          !publicFits(
            served.length,
            served.reduce((sum, entry) => sum + entry.size, 0),
            Math.max(0, ...served.map((entry) => entry.size)),
          )
        )
          return yield* new SourceError({ reason: "limit" });
        // Public files are inline while they fit beside the code, in path order.
        let remaining = sourceLimits.bytes - codeBytes;
        const candidates = new Set<string>();
        for (const entry of served.toSorted((a, b) => (a.path < b.path ? -1 : 1))) {
          if (entry.size > remaining) continue;
          remaining -= entry.size;
          candidates.add(entry.path);
        }
        const blobs = entries.filter(
          (entry) => !isPublicSourcePath(entry.path) || candidates.has(entry.path),
        );
        // And one process returns every held blob: `<object> blob <size>\n<content>\n` for each.
        const output =
          blobs.length === 0
            ? new Uint8Array()
            : yield* run(
                ["--git-dir", repo, "cat-file", "--batch"],
                bytes(blobs.map((blob) => `${blob.object}\n`).join("")),
              );
        const contents = new Map<string, string | undefined>();
        let offset = 0;
        for (const blob of blobs) {
          const header = `${blob.object} blob ${blob.size}\n`;
          const start = offset + header.length;
          if (
            new TextDecoder().decode(output.subarray(offset, start)) !== header ||
            output[start + blob.size] !== 10
          )
            return yield* new SourceError({ reason: "git" });
          const content = output.subarray(start, start + blob.size);
          contents.set(
            blob.path,
            isPublicSourcePath(blob.path)
              ? yield* decode(content).pipe(Effect.orElseSucceed(() => undefined))
              : yield* decode(content),
          );
          offset = start + blob.size + 1;
        }
        if (offset !== output.length) return yield* new SourceError({ reason: "git" });
        const files: SourceFile[] = entries.map((entry) => {
          const content = contents.get(entry.path);
          return content === undefined
            ? { path: entry.path, object: entry.object, size: entry.size }
            : { path: entry.path, content };
        });
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
          // Stored files keep a blob the basis revision already holds; they are not rewritten.
          const basis = input.basis ?? input.expected;
          const known = new Set<string>();
          if (files.some((file) => "object" in file && !isUpload(file))) {
            if (basis === null) return yield* new SourceError({ reason: "invalid-source" });
            const listed = yield* text([
              "--git-dir",
              repo,
              "ls-tree",
              "-r",
              "-z",
              `${yield* Schema.decodeUnknownEffect(SourceCommit)(basis)}^{tree}`,
            ]);
            for (const entry of listed.split("\0").filter(Boolean)) {
              const match = /^\d{6} blob ([a-f0-9]{40})\t/.exec(entry);
              if (match?.[1] !== undefined) known.add(match[1]);
            }
          }
          const write = (content: Uint8Array) =>
            text(["--git-dir", repo, "hash-object", "-w", "--stdin"], content);
          // The temporary index does not exist yet, so Git starts it empty.
          const entries: string[] = [];
          for (const file of files) {
            const oid = isUpload(file)
              ? yield* Effect.gen(function* () {
                  // One upload's bytes at a time; its object ID proves they are the listed file.
                  const written = yield* write(yield* file.read);
                  if (written !== file.object) return yield* new SourceError({ reason: "storage" });
                  return written;
                })
              : "object" in file
                ? known.has(file.object)
                  ? file.object
                  : yield* new SourceError({ reason: "invalid-source" })
                : yield* write(inlineBytes(file));
            entries.push(`100644 ${oid}\t${file.path}\0`);
          }
          // These repositories are bare and never checked out here, so the checkout guards for
          // NTFS and HFS names do not apply. Git for Windows would otherwise skip names such as
          // ones holding control characters, which the source contract and other hosts accept.
          yield* run(
            [
              "-c",
              "core.protectNTFS=false",
              "-c",
              "core.protectHFS=false",
              "--git-dir",
              repo,
              "update-index",
              "-z",
              "--index-info",
            ],
            bytes(entries.join("")),
            environment,
          );
          const tree = yield* text(["--git-dir", repo, "write-tree"], undefined, environment);
          // `update-index` skips a path it refuses, such as a `.git` segment, and still exits 0.
          // Refuse the save instead of committing a tree without that file.
          // Not `text`: it trims trailing whitespace, which a last path may end with.
          const listed = yield* run([
            "--git-dir",
            repo,
            "ls-tree",
            "-r",
            "-z",
            "--name-only",
            tree,
          ]);
          const written = new Set((yield* decode(listed)).split("\0"));
          if (files.some((file) => !written.has(file.path)))
            return yield* new SourceError({ reason: "invalid-source" });
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
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(SourceCommit)));
          // The ref moves only from `expected`, so its tree holds the files this save replaces.
          const previous =
            input.expected === null
              ? []
              : (yield* text([
                  "--git-dir",
                  repo,
                  "ls-tree",
                  "-r",
                  "-z",
                  "--name-only",
                  `${input.expected}^{tree}`,
                ])).split("\0");
          const updated = yield* git([
            "--git-dir",
            repo,
            "update-ref",
            `refs/heads/${input.branch}`,
            commit,
            input.expected === null ? "0".repeat(40) : input.expected,
          ]);
          if (updated.code !== 0) return yield* new SourceError({ reason: "conflict" });
          return { commit, removed: removedPaths(previous.filter(Boolean), files) };
        }),
      ).pipe(
        Effect.mapError((error) =>
          Schema.is(SourceError)(error) ? error : new SourceError({ reason: "git" }),
        ),
      ),
    blob: (id, object) =>
      Effect.gen(function* () {
        const oid = yield* Schema.decodeUnknownEffect(GitObjectId)(object).pipe(
          Effect.mapError(() => new SourceError({ reason: "invalid-source" })),
        );
        const result = yield* git(["--git-dir", yield* location(id), "cat-file", "blob", oid]);
        if (result.code !== 0) return yield* new SourceError({ reason: "not-found" });
        return result.output;
      }),
    file: (id, commit, path) =>
      Effect.gen(function* () {
        const revision = yield* Schema.decodeUnknownEffect(SourceCommit)(commit);
        const name = yield* Schema.decodeUnknownEffect(SourceFilePath)(path);
        // `<commit>:<path>` names one tree entry; a revision expression cannot be injected.
        const result = yield* git([
          "--git-dir",
          yield* location(id),
          "cat-file",
          "blob",
          `${revision}:${name}`,
        ]);
        if (result.code !== 0) return yield* new SourceError({ reason: "not-found" });
        return result.output;
      }).pipe(
        Effect.mapError((error) =>
          Schema.is(SourceError)(error) ? error : new SourceError({ reason: "invalid-source" }),
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
        const length = request.headers.get("content-length");
        const encoding = request.headers.get("content-encoding");
        const output = yield* host.httpBackend(
          {
            GIT_PROJECT_ROOT: directory,
            GIT_HTTP_EXPORT_ALL: "1",
            PATH_INFO: `/${id}.git${service}`,
            REQUEST_METHOD: request.method,
            QUERY_STRING: url.search.slice(1),
            CONTENT_TYPE: request.headers.get("content-type") ?? "",
            // Without a length, http-backend reads the body until it ends.
            ...(length === null ? {} : { CONTENT_LENGTH: length }),
            // Git compresses larger fetch requests; http-backend inflates them itself.
            ...(encoding === null ? {} : { HTTP_CONTENT_ENCODING: encoding }),
            REMOTE_USER: "executor",
            SERVER_PROTOCOL: "HTTP/1.1",
          },
          request.body,
        );
        // Read only the CGI headers; the body streams on to the client.
        const reader = output.getReader();
        let head = new Uint8Array();
        let separator = -1;
        while (separator < 0) {
          const next = yield* Effect.tryPromise({
            try: () => reader.read(),
            catch: () => new SourceError({ reason: "git" }),
          });
          if (next.done) return yield* new SourceError({ reason: "git" });
          head = concat(head, next.value);
          separator = headerEnd(head);
        }
        const headers = new Headers();
        let status = 200;
        const fields = yield* decode(head.slice(0, separator)).pipe(
          Effect.tapError(() => Effect.promise(() => reader.cancel().catch(() => undefined))),
        );
        for (const line of fields.split("\r\n")) {
          const colon = line.indexOf(":");
          if (colon < 1) continue;
          const name = line.slice(0, colon);
          const value = line.slice(colon + 1).trim();
          if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
          else headers.set(name, value);
        }
        const rest = head.slice(separator + 4);
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => {
            if (rest.length > 0) controller.enqueue(rest);
          },
          pull: async (controller) => {
            const next = await reader.read();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          },
          cancel: (reason) => reader.cancel(reason),
        });
        return new Response(body, { status, headers });
      }),
  });
};
