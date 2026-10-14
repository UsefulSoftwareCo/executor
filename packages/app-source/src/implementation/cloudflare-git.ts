/** Git access to Cloudflare Artifacts through host-owned repository credentials. Loaded on first use. */
import { protectGit } from "./protected-git.ts";
import { Clock, Context, Effect, Exit, Redacted, Schema, Scope, Stream } from "effect";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpMethod,
} from "effect/http";
import { captureTelemetry, pendingSpan, traceHeaders } from "@executor-js/telemetry";
import * as Git from "isomorphic-git";
import {
  AppCodeId,
  SourceError,
  SourceFiles,
  Branch,
  GitObjectId,
  SourceCommit,
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

import type { ArtifactsTokens } from "../contracts/artifacts-tokens.ts";
import { buildTrees, commitObject, objectId, pushObjects, type PackObject } from "./git-pack.ts";

/** Blobs one coordinator call reads, so each call's storage operations stay well inside a Worker's. */
const blobsPerCall = 500;

/**
 * Git responses this adapter reads into memory are ref advertisements and push reports, never
 * packs of files; one larger than this is refused as `limit`.
 */
const responseBytes = 32 * 1024 * 1024;

/** History lists as many recent commits as native hosts' `git log -50`. */
const historyCommits = 50;

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
/** Artifacts refused the repository token; the failure records it, and Git never sees it. */
const rejectedToken = (status: number) => {
  const error = new SourceError({ reason: "git" });
  failures.set(error, { type: "RejectedToken", status });
  return error;
};
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
  // A rejected token is replaced once per access. A streamed body cannot be sent twice, so its
  // request fails as retryable after the refresh; the next request uses the new token. A rejection
  // is never passed on: Git reports a 401 as the caller's own sign-in failing, and this token is
  // the host's, not the caller's.
  const authenticatedRequest = (
    value: RepositoryAccess,
    http: HttpClient.HttpClient,
    body: "replayable" | "streamed" = "replayable",
  ) => {
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
        for (;;) {
          const { response, scope } = yield* send;
          const denial =
            response.status === 403
              ? new Uint8Array(yield* response.arrayBuffer.pipe(Effect.mapError(failure)))
              : undefined;
          const rejected =
            response.status === 401 ||
            (denial !== undefined &&
              new TextDecoder().decode(denial) === "Invalid or expired token");
          if (rejected) {
            yield* Scope.close(scope, Exit.void);
            if (refreshed) return yield* rejectedToken(response.status);
            refreshed = true;
            token = yield* value.refresh.pipe(
              Effect.withSpan("source.repository.token.refresh", {
                attributes: { "source.token.rejected_status": response.status },
              }),
            );
            if (body === "streamed") return yield* rejectedToken(response.status);
            continue;
          }
          if (denial !== undefined) {
            // Inspection consumed the body; preserve every byte of an unrelated denial.
            yield* Scope.close(scope, Exit.void);
            return { response, body: Stream.succeed(denial) };
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
        }
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
            // isomorphic-git sends packs built from a source already within `sourceLimits`.
            // The body is kept so a request rejected for an expired token can be sent again.
            const chunks: Uint8Array[] = [];
            let size = 0;
            if (request.body !== undefined) {
              const stream =
                Symbol.asyncIterator in request.body
                  ? Stream.fromAsyncIterable(request.body, failure)
                  : Stream.fromIterable(request.body);
              yield* stream.pipe(
                Stream.runForEach((chunk) =>
                  Effect.sync(() => {
                    size += chunk.length;
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
                      if (total > responseBytes) return yield* new SourceError({ reason: "limit" });
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
  return protectGit({
    // Commit metadata from the Artifacts binding. Git would have to fetch every file of every
    // listed commit, so history size, not the current source, would bound the listing.
    history: (id) =>
      tokens
        .history(id, historyCommits)
        .pipe(Effect.withSpan("source.git.history"), Effect.tapError(observeFailure)),
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
        return ref === undefined ? null : yield* Schema.decodeUnknownEffect(SourceCommit)(ref.oid);
      }).pipe(Effect.mapError(failure)),
    // Reads walk the commit's trees through the binding and read only the blobs they return or
    // size; no pack of the commit is fetched, so public files never all sit in the isolate.
    read: (id, ref) =>
      Effect.gen(function* () {
        if (!Schema.is(SourceCommit)(ref) && !Schema.is(Branch)(ref))
          return yield* new SourceError({ reason: "invalid-source" });
        const resolved = yield* tokens.resolve(id, ref);
        if (resolved === null) return yield* new SourceError({ reason: "not-found" });
        const entries = yield* tokens.tree(id, resolved.tree);
        for (const entry of entries)
          if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755"))
            return yield* new SourceError({ reason: "invalid-source" });
        const code = entries.filter((entry) => !isPublicSourcePath(entry.path));
        const served = entries
          .filter((entry) => isPublicSourcePath(entry.path))
          .toSorted((a, b) => (a.path < b.path ? -1 : 1));
        if (!sourceFits(code.length, 0)) return yield* new SourceError({ reason: "limit" });
        const chunks = <A>(items: ReadonlyArray<A>) =>
          Array.from({ length: Math.ceil(items.length / blobsPerCall) }, (_, index) =>
            items.slice(index * blobsPerCall, (index + 1) * blobsPerCall),
          );
        const read = (objects: ReadonlyArray<string>, mode: "sizes" | "bytes", budget: number) =>
          Effect.forEach(chunks(objects), (chunk) => tokens.blobs(id, chunk, mode, budget)).pipe(
            Effect.map((pages) => pages.flat()),
          );
        const codeBlobs = yield* read(
          code.map((entry) => entry.object),
          "bytes",
          sourceLimits.bytes,
        );
        const codeBytes = codeBlobs.reduce((sum, blob) => sum + blob.size, 0);
        if (!sourceFits(code.length, codeBytes) || codeBlobs.some((blob) => blob.bytes === null))
          return yield* new SourceError({ reason: "limit" });
        const sizes = yield* read(
          served.map((entry) => entry.object),
          "sizes",
          0,
        );
        if (
          !publicFits(
            served.length,
            sizes.reduce((sum, blob) => sum + blob.size, 0),
            Math.max(0, ...sizes.map((blob) => blob.size)),
          )
        )
          return yield* new SourceError({ reason: "limit" });
        // Public files are inline while they fit beside the code, in path order.
        let remaining = sourceLimits.bytes - codeBytes;
        const candidates: string[] = [];
        served.forEach((entry, index) => {
          const size = sizes[index]?.size ?? Number.POSITIVE_INFINITY;
          if (size > remaining) return;
          remaining -= size;
          candidates.push(entry.object);
        });
        const inline = new Map(
          (yield* read([...new Set(candidates)], "bytes", sourceLimits.bytes)).map((blob) => [
            blob.object,
            blob.bytes,
          ]),
        );
        const utf8 = (bytes: Uint8Array) =>
          Effect.try({
            try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            catch: () => new SourceError({ reason: "invalid-source" }),
          });
        const files: SourceFile[] = [];
        for (const [index, entry] of code.entries()) {
          const bytes = codeBlobs[index]?.bytes;
          if (bytes === null || bytes === undefined)
            return yield* new SourceError({ reason: "git" });
          files.push({ path: entry.path, content: yield* utf8(bytes) });
        }
        for (const [index, entry] of served.entries()) {
          const size = sizes[index]?.size ?? 0;
          const bytes = candidates.includes(entry.object) ? inline.get(entry.object) : undefined;
          const content =
            bytes === null || bytes === undefined
              ? undefined
              : yield* utf8(bytes).pipe(Effect.orElseSucceed(() => undefined));
          files.push(
            content === undefined
              ? { path: entry.path, object: entry.object, size }
              : { path: entry.path, content },
          );
        }
        return {
          commit: yield* Schema.decodeUnknownEffect(SourceCommit)(resolved.commit),
          files: yield* sourceFiles(yield* Schema.decodeUnknownEffect(SourceFiles)(files)),
        };
      }).pipe(
        Effect.mapError(failure),
        Effect.withSpan("source.git.read"),
        Effect.tapError(observeFailure),
      ),
    blob: (id, object) =>
      Effect.gen(function* () {
        const oid = yield* Schema.decodeUnknownEffect(GitObjectId)(object);
        const [blob] = yield* tokens.blobs(id, [oid], "bytes", Number.POSITIVE_INFINITY);
        if (blob?.bytes === null || blob?.bytes === undefined)
          return yield* new SourceError({ reason: "not-found" });
        return blob.bytes;
      }).pipe(
        Effect.mapError(failure),
        Effect.withSpan("source.git.blob"),
        Effect.tapError(observeFailure),
      ),
    file: (id, commit, path) =>
      Effect.gen(function* () {
        const bytes = yield* tokens.file(id, commit, path);
        if (bytes === null) return yield* new SourceError({ reason: "not-found" });
        return bytes;
      }).pipe(
        Effect.mapError(failure),
        Effect.withSpan("source.git.file"),
        Effect.tapError(observeFailure),
      ),
    // Saves push only the objects they write. Unchanged files are named by their blob and stay
    // on the server, so a save never fetches the commit it replaces.
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
        const value = yield* credentials;
        const listing = (commit: string) =>
          Effect.gen(function* () {
            const resolved = yield* tokens.resolve(input.id, commit);
            if (resolved === null) return yield* new SourceError({ reason: "conflict" });
            return yield* tokens.tree(input.id, resolved.tree);
          });
        // The push moves the branch only from `expected`, so its tree holds the files this save
        // replaces, and the blobs a stored file may keep.
        const previous = input.expected === null ? [] : yield* listing(input.expected);
        const basis = input.basis ?? input.expected;
        const known = new Set(
          (basis === input.expected ? previous : basis === null ? [] : yield* listing(basis)).map(
            (entry) => entry.object,
          ),
        );
        const blobs = new Map<string, PackObject>();
        const entries: Array<{ path: string; object: string }> = [];
        for (const file of files) {
          if (isUpload(file)) {
            blobs.set(file.object, {
              type: "blob",
              object: file.object,
              size: file.size,
              read: file.read,
            });
            entries.push({ path: file.path, object: file.object });
          } else if ("object" in file) {
            if (!known.has(file.object))
              return yield* new SourceError({ reason: "invalid-source" });
            entries.push({ path: file.path, object: file.object });
          } else {
            const bytes = inlineBytes(file);
            const object = objectId("blob", bytes);
            blobs.set(object, {
              type: "blob",
              object,
              size: bytes.length,
              read: Effect.succeed(bytes),
            });
            entries.push({ path: file.path, object });
          }
        }
        const { tree, trees } = buildTrees(entries);
        const seconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const commitBytes = commitObject({
          tree,
          parents: input.expected === null ? [] : [input.expected],
          message: input.message,
          seconds,
        });
        const commit = objectId("commit", commitBytes);
        const ref = `refs/heads/${input.branch}`;
        const http = yield* HttpClient.HttpClient;
        const send = authenticatedRequest(value, http);
        // A cheap advertisement first, so a rejected token is replaced before a pack streams.
        yield* send(
          HttpClientRequest.get(`${value.remote.href}/info/refs?service=git-receive-pack`),
        ).pipe(
          Effect.flatMap(({ response, body }) =>
            response.status === 200
              ? Stream.runDrain(body)
              : Effect.fail(new SourceError({ reason: "git" })),
          ),
          Effect.scoped,
        );
        const receive = (body: Stream.Stream<Uint8Array, SourceError>) =>
          send(
            HttpClientRequest.post(`${value.remote.href}/git-receive-pack`).pipe(
              HttpClientRequest.setHeader("accept", "application/x-git-receive-pack-result"),
              HttpClientRequest.bodyStream(body, {
                contentType: "application/x-git-receive-pack-request",
              }),
            ),
          ).pipe(
            Effect.flatMap(({ response, body }) =>
              response.status === 200
                ? Stream.runCollect(body).pipe(
                    Effect.map((chunks) => {
                      const out = new Uint8Array(
                        chunks.reduce((size, chunk) => size + chunk.length, 0),
                      );
                      let offset = 0;
                      for (const chunk of chunks) {
                        out.set(chunk, offset);
                        offset += chunk.length;
                      }
                      return out;
                    }),
                  )
                : Effect.fail(new SourceError({ reason: "git" })),
            ),
            Effect.scoped,
            Effect.withSpan("source.git.push"),
          );
        const report = yield* pushObjects({
          receive,
          ref,
          expected: input.expected,
          commit: {
            type: "commit",
            object: commit,
            size: commitBytes.length,
            read: Effect.succeed(commitBytes),
          },
          trees: trees.map((entry) => ({
            type: "tree" as const,
            object: entry.object,
            size: entry.bytes.length,
            read: Effect.succeed(entry.bytes),
          })),
          blobs: [...blobs.values()],
          staging: `refs/heads/__executor/uploads/${crypto.randomUUID()}`,
          seconds,
        }).pipe(Effect.result);
        if (report._tag === "Failure" || report.success.refs.get(ref) !== "ok") {
          // A refused push or a lost report has several shapes. Reconcile the actual ref: our
          // commit landed, another writer won, or the expected ref holds and the failure stands.
          const current = yield* tokens.resolve(input.id, input.branch);
          if (current?.commit === commit)
            return {
              commit: yield* Schema.decodeUnknownEffect(SourceCommit)(commit),
              removed: removedPaths(
                previous.map((entry) => entry.path),
                files,
              ),
            };
          if ((current?.commit ?? null) !== input.expected)
            return yield* new SourceError({ reason: "conflict" });
          return yield* report._tag === "Failure"
            ? report.failure
            : new SourceError({ reason: "git" });
        }
        return {
          commit: yield* Schema.decodeUnknownEffect(SourceCommit)(commit),
          removed: removedPaths(
            previous.map((entry) => entry.path),
            files,
          ),
        };
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.mapError(failure),
        Effect.withSpan("source.git.commit"),
        Effect.tapError(observeFailure),
      ),
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
        // The body streams through, so a push is bounded by Artifacts, not by Worker memory.
        const body = request.body;
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
                  body === null ? "replayable" : "streamed",
                )(
                  body === null
                    ? outgoing
                    : HttpClientRequest.setBody(
                        outgoing,
                        HttpBody.raw(body, { contentType: outgoing.headers["content-type"] }),
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
      }).pipe(Effect.provide(FetchHttpClient.layer), Effect.tapError(observeFailure)),
  });
};
