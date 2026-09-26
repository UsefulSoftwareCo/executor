/** Git access to Cloudflare Artifacts through host-owned repository credentials. Loaded on first use. */
import { protectGit } from "./protected-git.ts";
import { Clock, Context, Effect, Exit, Redacted, Schema, Scope, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpMethod,
} from "effect/unstable/http";
import { captureTelemetry, pendingSpan, traceHeaders } from "@executor-js/telemetry";
import * as Git from "isomorphic-git";
import { Volume, createFsFromVolume } from "memfs";
import { SourceFiles } from "@executor-js/sdk/core";
import {
  AppCodeId,
  SourceError,
  Branch,
  GitCommit,
  Commit,
  sourceFiles,
  sourceFits,
  type RepositoryBackend,
} from "../contracts/repositories.ts";

import type { ArtifactsTokens } from "../contracts/artifacts-tokens.ts";

interface RepositoryAccess {
  readonly remote: URL;
  readonly token: Redacted.Redacted<string>;
  readonly refresh: Effect.Effect<Redacted.Redacted<string>, SourceError>;
}

// isomorphic-git also passes arrays for clone/push bodies, despite declaring only async iterators.
type GitRequest = Omit<Git.GitHttpRequest, "body"> & {
  readonly body?: Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
};

const remoteSchema = Schema.URLFromString.check(
  Schema.makeFilter(
    (url) =>
      url.protocol === "https:" &&
      url.hostname.endsWith(".artifacts.cloudflare.net") &&
      url.username === "" &&
      url.password === "",
  ),
);
const failures = new WeakMap<
  SourceError,
  {
    readonly type: string;
    readonly status?: number;
    readonly frames?: readonly string[];
    readonly categories?: readonly string[];
  }
>();
const failure = (cause?: unknown) => {
  if (Schema.is(SourceError)(cause)) return cause;
  const error = new SourceError({ reason: "git" });
  if (cause instanceof Git.Errors.HttpError)
    failures.set(error, { type: "HttpError", status: cause.data.statusCode });
  else if (cause instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(cause.name)) {
    const frames = (cause.stack ?? "")
      .split("\n")
      .slice(1)
      .filter((line) => /^\s+at [A-Za-z0-9_.$<>]+ \([^\s?]+\.js:\d+:\d+\)$/.test(line))
      .slice(0, 4);
    const categories = [
      "redirect",
      "signal",
      "header",
      "body",
      "url",
      "certificate",
      "request",
      "fetch",
      "i/o",
    ].filter((word) => cause.message.toLowerCase().includes(word));
    failures.set(error, { type: cause.name, frames, categories });
  }
  return error;
};
/** Only the requested missing branch is an empty workspace; object and transport failures stay errors. */
const branchFailure = (cause: unknown, ref: string): SourceError =>
  cause instanceof Git.Errors.NotFoundError && cause.data.what === ref
    ? new SourceError({ reason: "not-found" })
    : failure(cause);
const observeFailure = (error: SourceError) =>
  Effect.gen(function* () {
    const details = failures.get(error);
    yield* Effect.annotateCurrentSpan("source.error.reason", error.reason);
    if (details !== undefined) {
      yield* Effect.annotateCurrentSpan("source.error.type", details.type);
      if (details.status !== undefined)
        yield* Effect.annotateCurrentSpan("source.error.http_status", details.status);
    }
    yield* Effect.logWarning("Managed Git operation failed", {
      reason: error.reason,
      ...details,
    });
  });

/** Adapt one isomorphic-git call; sequencing and recovery remain in Effect. */
const gitCall = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: failure });

/** Managed repository credentials remain behind the host-owned token coordinator. */
export const cloudflareRepositories = (
  tokens: ArtifactsTokens,
  settings: { readonly accountId: string; readonly namespace: string },
): RepositoryBackend => {
  const remote = (id: AppCodeId) =>
    Schema.decodeUnknownEffect(remoteSchema)(
      `https://${settings.accountId}.artifacts.cloudflare.net/git/${settings.namespace}/${id}.git`,
    ).pipe(Effect.mapError(failure));
  const access = (id: AppCodeId): Effect.Effect<RepositoryAccess, SourceError> =>
    Effect.gen(function* () {
      const credential = yield* tokens.acquire(id, null);
      return {
        remote: yield* remote(id),
        token: credential.token,
        refresh: tokens.acquire(id, credential.generation).pipe(Effect.map((value) => value.token)),
      };
    });
  const create = (id: AppCodeId) =>
    Effect.gen(function* () {
      const token = yield* tokens.create(id);
      if (token === null) return null;
      return {
        remote: yield* remote(id),
        token,
        refresh: tokens.acquire(id, null).pipe(Effect.map((value) => value.token)),
      };
    });
  // Artifacts rejects invalid/expired/revoked credentials with this exact 403 body.
  // Other denials and provider failures retain their original semantics and push reconciliation.
  const authenticatedRequest = (value: RepositoryAccess, http: HttpClient.HttpClient) => {
    let token = value.token;
    let refreshed = false;
    const scoped = HttpClient.withScope(http);
    return (request: HttpClientRequest.HttpClientRequest) =>
      Effect.gen(function* () {
        const send = Effect.gen(function* () {
          const scope = yield* Scope.fork(yield* Scope.Scope);
          const response = yield* scoped
            .execute(HttpClientRequest.bearerToken(request, token))
            .pipe(
              Scope.provide(scope),
              Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
              // Keep the safe route-only spans below; default HTTP spans include repository URLs.
              Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
              Effect.mapError(failure),
            );
          return { response, scope };
        });
        let { response, scope } = yield* send;
        if (!refreshed) {
          const denial =
            response.status === 403
              ? new Uint8Array(yield* response.arrayBuffer.pipe(Effect.mapError(failure)))
              : undefined;
          const rejected =
            response.status === 401 ||
            (denial !== undefined &&
              new TextDecoder().decode(denial) === "Invalid or expired token");
          if (rejected) {
            refreshed = true;
            yield* Scope.close(scope, Exit.void);
            token = yield* value.refresh.pipe(
              Effect.withSpan("source.repository.token.refresh", {
                attributes: { "source.token.rejected_status": response.status },
              }),
            );
            ({ response, scope } = yield* send);
          } else if (denial !== undefined) {
            // Inspection consumed the body; preserve every byte of an unrelated denial.
            yield* Scope.close(scope, Exit.void);
            return { response, body: Stream.succeed(denial) };
          }
        }
        return {
          response,
          body: response.stream.pipe(
            Stream.catch((error) =>
              error.reason instanceof HttpClientError.EmptyBodyError
                ? Stream.empty
                : Stream.fail(failure(error)),
            ),
            Stream.onExit((exit) => Scope.close(scope, exit)),
          ),
        };
      });
  };
  const client = (
    value: RepositoryAccess,
    http: HttpClient.HttpClient,
    signal: AbortSignal,
    context: Context.Context<Scope.Scope>,
  ): Git.HttpClient => {
    const remote = value.remote;
    const send = authenticatedRequest(value, http);
    const run = Effect.runPromiseWith(context);
    return {
      request: (request: GitRequest) =>
        run(
          Effect.gen(function* () {
            const url = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(request.url).pipe(
              Effect.mapError(failure),
            );
            if (url.origin !== remote.origin || !url.pathname.startsWith(`${remote.pathname}/`))
              return yield* failure(new Error("Unexpected Git destination"));
            const chunks: Uint8Array[] = [];
            let size = 0;
            if (request.body !== undefined) {
              const stream =
                Symbol.asyncIterator in request.body
                  ? Stream.fromAsyncIterable(request.body, failure)
                  : Stream.fromIterable(request.body);
              yield* stream.pipe(
                Stream.runForEach((chunk) =>
                  Effect.gen(function* () {
                    size += chunk.length;
                    if (size > 32 * 1024 * 1024)
                      return yield* failure(new Error("Git request too large"));
                    chunks.push(chunk);
                  }),
                ),
              );
            }
            const body = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
              body.set(chunk, offset);
              offset += chunk.length;
            }
            const method = request.method ?? "GET";
            if (!HttpMethod.isHttpMethod(method)) return yield* failure();
            const { response, responseBody, headersSpan } = yield* Effect.gen(function* () {
              const headersSpan = yield* Effect.currentSpan;
              const propagation = yield* traceHeaders;
              const outgoing = HttpClientRequest.make(method)(url, {
                headers: { ...request.headers, ...propagation },
              });
              const { response, body: responseBody } = yield* send(
                request.body === undefined
                  ? outgoing
                  : HttpClientRequest.bodyUint8Array(
                      outgoing,
                      body,
                      outgoing.headers["content-type"],
                    ),
              );
              yield* Effect.annotateCurrentSpan("http.response.status_code", response.status);
              return { response, responseBody, headersSpan };
            }).pipe(
              Effect.withSpan("source.git.http.headers", {
                kind: "client",
                attributes: {
                  "http.request.method": request.method ?? "GET",
                  "source.git.route": url.pathname.endsWith("/info/refs")
                    ? "refs"
                    : url.pathname.endsWith("/git-upload-pack")
                      ? "read-pack"
                      : "write-pack",
                },
              }),
            );
            const stream = Stream.unwrap(
              Effect.gen(function* () {
                const observed = yield* pendingSpan("source.git.http.body", {
                  parent: headersSpan,
                });
                let total = 0;
                return responseBody.pipe(
                  Stream.tap((chunk) =>
                    Effect.gen(function* () {
                      total += chunk.length;
                      if (total > 32 * 1024 * 1024)
                        return yield* failure(new Error("Git repository too large"));
                    }),
                  ),
                  Stream.onExit((exit) =>
                    Effect.gen(function* () {
                      observed.span.attribute("source.git.response.bytes", total);
                      yield* observed.finish(exit);
                    }),
                  ),
                );
              }),
            );
            const incoming = Stream.toAsyncIterableWith(stream, context)[Symbol.asyncIterator]();
            return {
              url: response.url,
              statusCode: response.status,
              // Effect exposes the status code; HTTP reason phrases are optional on the wire.
              statusMessage: "",
              headers: response.headers,
              body: {
                ...incoming,
                [Symbol.asyncIterator]() {
                  return this;
                },
              },
            };
          }),
          { signal },
        ),
    };
  };
  const withGit = <A>(
    name: string,
    value: RepositoryAccess,
    work: (http: Git.HttpClient) => Effect.Effect<A, SourceError>,
  ) =>
    Effect.gen(function* () {
      const telemetry = yield* captureTelemetry;
      const scope = yield* Scope.Scope;
      const context = Context.add(telemetry.context, Scope.Scope, scope);
      const controller = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (controller) => Effect.sync(() => controller.abort()),
      );
      const http = yield* HttpClient.HttpClient;
      return yield* work(client(value, http, controller.signal, context));
    }).pipe(Effect.withSpan(name), Effect.scoped, Effect.provide(FetchHttpClient.layer));
  const session = (credentials: ReturnType<typeof access>) =>
    credentials.pipe(
      Effect.map((access) => ({ ...access, fs: createFsFromVolume(new Volume()), dir: "/repo" })),
    );
  return protectGit({
    history: (id) =>
      Effect.gen(function* () {
        const value = yield* session(access(id));
        const rows = yield* withGit("source.git.history", value, (http) =>
          Effect.gen(function* () {
            const options = { fs: value.fs, dir: value.dir };
            yield* gitCall(() =>
              Git.clone({
                ...options,
                http,
                url: value.remote.href,
                ref: "main",
                singleBranch: true,
                noCheckout: true,
                noTags: true,
                depth: 50,
              }),
            );
            return (yield* gitCall(() => Git.log({ ...options, ref: "main", depth: 50 }))).map(
              (entry) => ({
                commit: entry.oid,
                author: entry.commit.author.name,
                message: entry.commit.message.trim(),
                timestamp: entry.commit.author.timestamp,
              }),
            );
          }),
        );
        return yield* Schema.decodeUnknownEffect(Schema.Array(GitCommit))(rows);
      }).pipe(Effect.mapError(failure)),
    create: (id) => create(id).pipe(Effect.asVoid),
    head: (id, branch) =>
      Effect.gen(function* () {
        const name = yield* Schema.decodeUnknownEffect(Branch)(branch);
        const value = yield* access(id);
        const refs = yield* withGit("source.git.refs", value, (http) =>
          gitCall(() =>
            Git.listServerRefs({
              http,
              url: value.remote.href,
              prefix: `refs/heads/${name}`,
            }),
          ),
        );
        const ref = refs.find((ref) => ref.ref === `refs/heads/${name}`);
        return ref === undefined ? null : yield* Schema.decodeUnknownEffect(Commit)(ref.oid);
      }).pipe(Effect.mapError(failure)),
    read: (id, ref) =>
      Effect.gen(function* () {
        if (!Schema.is(Commit)(ref) && !Schema.is(Branch)(ref))
          return yield* new SourceError({ reason: "invalid-source" });
        const value = yield* session(access(id));
        const options = { fs: value.fs, dir: value.dir };
        const requested = Schema.is(Commit)(ref) ? ref : `refs/heads/${ref}`;
        // Request only this snapshot, including when its SHA is no longer a branch tip.
        yield* withGit("source.git.clone", value, (http) =>
          Effect.tryPromise({
            try: () =>
              Git.clone({
                ...options,
                http,
                url: value.remote.href,
                ref: requested,
                noCheckout: true,
                singleBranch: true,
                depth: 1,
                noTags: true,
              }),
            catch: (cause) =>
              Schema.is(Commit)(ref) ? failure(cause) : branchFailure(cause, requested),
          }),
        );
        const result = yield* Effect.gen(function* () {
          const commit = Schema.is(Commit)(ref)
            ? ref
            : yield* Effect.tryPromise({
                try: () => Git.resolveRef({ ...options, ref: `refs/remotes/origin/${ref}` }),
                // An empty repository makes clone succeed without writing a remote branch.
                catch: (cause) => branchFailure(cause, `refs/remotes/origin/${ref}`),
              });
          const files: Array<{ path: string; content: string }> = [];
          let total = 0;
          const walk = (oid: string, prefix: string): Effect.Effect<void, SourceError> =>
            Effect.gen(function* () {
              const tree = yield* gitCall(() => Git.readTree({ ...options, oid }));
              for (const entry of tree.tree) {
                if (entry.type === "tree") {
                  yield* walk(entry.oid, `${prefix}${entry.path}/`);
                  continue;
                }
                if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755"))
                  return yield* new SourceError({ reason: "invalid-source" });
                const blob = yield* gitCall(() => Git.readBlob({ ...options, oid: entry.oid }));
                total += blob.blob.length;
                if (!sourceFits(files.length + 1, total))
                  return yield* new SourceError({ reason: "limit" });
                const content = yield* Effect.try({
                  try: () => new TextDecoder("utf-8", { fatal: true }).decode(blob.blob),
                  catch: failure,
                });
                files.push({
                  path: prefix + entry.path,
                  content,
                });
              }
            });
          yield* walk(commit, "");
          return { commit, files };
        }).pipe(Effect.withSpan("source.git.tree"));
        return {
          commit: yield* Schema.decodeUnknownEffect(Commit)(result.commit),
          files: yield* sourceFiles(yield* Schema.decodeUnknownEffect(SourceFiles)(result.files)),
        };
      }).pipe(Effect.mapError(failure), Effect.tapError(observeFailure)),
    commit: (input) =>
      Effect.gen(function* () {
        const files = yield* sourceFiles(input.files);
        const credentials =
          input.expected === null
            ? create(input.id).pipe(
                Effect.flatMap((created) =>
                  created === null ? access(input.id) : Effect.succeed(created),
                ),
              )
            : access(input.id);
        const value = yield* session(credentials);
        return yield* withGit("source.git.commit", value, (http) =>
          Effect.gen(function* () {
            const options = { fs: value.fs, dir: value.dir };
            if (input.expected === null) {
              yield* gitCall(() => Git.init({ ...options, defaultBranch: input.branch }));
              yield* gitCall(() =>
                Git.addRemote({ ...options, remote: "origin", url: value.remote.href }),
              );
            } else
              yield* gitCall(() =>
                Git.clone({
                  ...options,
                  http,
                  url: value.remote.href,
                  noCheckout: true,
                  ref: input.branch,
                  singleBranch: true,
                  depth: 1,
                  noTags: true,
                }),
              );
            const writeTree = (prefix: string): Effect.Effect<string, SourceError> =>
              Effect.gen(function* () {
                const entries: Git.TreeEntry[] = [];
                const directories = new Set<string>();
                for (const file of files) {
                  if (!file.path.startsWith(prefix)) continue;
                  const rest = file.path.slice(prefix.length);
                  const slash = rest.indexOf("/");
                  if (slash >= 0) {
                    directories.add(rest.slice(0, slash));
                    continue;
                  }
                  entries.push({
                    mode: "100644",
                    path: rest,
                    type: "blob",
                    oid: yield* gitCall(() =>
                      Git.writeBlob({
                        ...options,
                        blob: new TextEncoder().encode(file.content),
                      }),
                    ),
                  });
                }
                for (const directory of directories)
                  entries.push({
                    mode: "040000",
                    path: directory,
                    type: "tree",
                    oid: yield* writeTree(`${prefix}${directory}/`),
                  });
                return yield* gitCall(() => Git.writeTree({ ...options, tree: entries }));
              });
            const author = {
              name: "Executor",
              email: "apps@executor.local",
              timestamp: Math.floor((yield* Clock.currentTimeMillis) / 1000),
              timezoneOffset: 0,
            };
            const tree = yield* writeTree("");
            const commit = yield* gitCall(() =>
              Git.writeCommit({
                ...options,
                commit: {
                  tree,
                  parent: input.expected === null ? [] : [input.expected],
                  author,
                  committer: author,
                  message: input.message,
                },
              }),
            );
            yield* gitCall(() =>
              Git.writeRef({
                ...options,
                ref: `refs/heads/${input.branch}`,
                value: commit,
                force: true,
              }),
            );
            yield* gitCall(() =>
              Git.push({
                ...options,
                http,
                url: value.remote.href,
                ref: input.branch,
                remoteRef: input.branch,
                onPrePush: ({ remoteRef }) => {
                  if (remoteRef.oid !== (input.expected ?? "0".repeat(40)))
                    throw new SourceError({ reason: "conflict" });
                  return true;
                },
              }),
            ).pipe(
              Effect.flatMap((result) => (result.ok ? Effect.void : Effect.fail(failure()))),
              Effect.catch((cause) =>
                Effect.gen(function* () {
                  if (cause.reason === "conflict") return yield* cause;
                  // A rejected push or lost acknowledgment has several protocol error shapes.
                  // Reconcile the actual ref: our commit succeeded, another writer won,
                  // or the expected ref still holds and the original failure must surface.
                  const ref = `refs/heads/${input.branch}`;
                  const refs = yield* gitCall(() =>
                    Git.listServerRefs({ http, url: value.remote.href, prefix: ref }),
                  );
                  const current = refs.find((entry) => entry.ref === ref)?.oid ?? null;
                  if (current === commit) return;
                  if (current !== input.expected)
                    return yield* new SourceError({ reason: "conflict" });
                  return yield* cause;
                }),
              ),
            );
            return commit;
          }),
        ).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Commit)),
          Effect.mapError(failure),
          Effect.tapError(observeFailure),
        );
      }),
    request: (id, request) =>
      Effect.gen(function* () {
        const url = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(request.url).pipe(
          Effect.mapError(failure),
        );
        const suffix = url.pathname.endsWith("/info/refs")
          ? "/info/refs"
          : url.pathname.endsWith("/git-upload-pack")
            ? "/git-upload-pack"
            : url.pathname.endsWith("/git-receive-pack")
              ? "/git-receive-pack"
              : null;
        if (suffix === null) return new Response(null, { status: 404 });
        const value = yield* access(id);
        const headers: Record<string, string> = {};
        for (const name of ["content-type", "git-protocol", "content-encoding"]) {
          const header = request.headers.get(name);
          if (header !== null) headers[name] = header;
        }
        const body = yield* Effect.gen(function* () {
          const stream = request.body;
          if (stream === null) return undefined;
          const chunks: Uint8Array[] = [];
          let length = 0;
          yield* Stream.fromReadableStream({ evaluate: () => stream, onError: failure }).pipe(
            Stream.runForEach((chunk) =>
              Effect.gen(function* () {
                length += chunk.length;
                if (length > 32 * 1024 * 1024) return yield* new SourceError({ reason: "limit" });
                chunks.push(chunk);
              }),
            ),
          );
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          return bytes;
        });
        if (!HttpMethod.isHttpMethod(request.method)) return yield* failure();
        const outgoing = HttpClientRequest.make(request.method)(
          value.remote.href + suffix + url.search,
          {
            headers,
          },
        );
        const http = yield* HttpClient.HttpClient;
        // The native response owns the scope after handoff; headers alone must not close its body.
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const scope = yield* Scope.make();
            return yield* restore(
              Effect.gen(function* () {
                const { response, body: responseBody } = yield* authenticatedRequest(
                  value,
                  http,
                )(
                  body === undefined
                    ? outgoing
                    : HttpClientRequest.bodyUint8Array(
                        outgoing,
                        body,
                        outgoing.headers["content-type"],
                      ),
                ).pipe(Scope.provide(scope));
                if (response.status >= 300 && response.status < 400) return yield* failure();
                if (
                  request.method === "HEAD" ||
                  response.status === 204 ||
                  response.status === 205
                ) {
                  yield* Scope.close(scope, Exit.void);
                  return new Response(null, { status: response.status, headers: response.headers });
                }
                const stream = yield* Stream.toReadableStreamEffect(
                  responseBody.pipe(Stream.onExit((exit) => Scope.close(scope, exit))),
                );
                return new Response(stream, { status: response.status, headers: response.headers });
              }),
            ).pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))));
          }),
        );
      }).pipe(Effect.provide(FetchHttpClient.layer)),
  });
};
