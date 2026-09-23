/** Git access to Cloudflare Artifacts through host-owned repository credentials. */
import { protectGit } from "./implementation/protected-git.ts";
import { Context, Effect, Exit, Redacted, Schema, Scope, Stream } from "effect";
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
} from "./contracts/repositories.ts";

import type { ArtifactsTokens } from "./contracts/artifacts-tokens.ts";
export type { ArtifactsToken, ArtifactsTokens } from "./contracts/artifacts-tokens.ts";

interface RepositoryAccess {
  readonly remote: string;
  readonly token: Redacted.Redacted<string>;
  readonly refresh: Effect.Effect<Redacted.Redacted<string>, SourceError>;
}

const remoteSchema = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname.endsWith(".artifacts.cloudflare.net") &&
        url.username === "" &&
        url.password === ""
      );
    } catch {
      return false;
    }
  }),
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
  const authenticatedFetch = (value: RepositoryAccess) => {
    let token = value.token;
    let refreshed = false;
    return (url: URL | string, init: RequestInit) =>
      Effect.gen(function* () {
        // The Git bridge supplies its operation's signal so streamed bodies share its lifetime.
        const send = Effect.tryPromise({
          try: (signal) =>
            fetch(url, {
              ...init,
              signal: init.signal ?? signal,
              redirect: "manual",
              headers: { ...init.headers, authorization: `Bearer ${Redacted.value(token)}` },
            }),
          catch: failure,
        });
        const response = yield* send;
        if (refreshed) return response;
        const rejected =
          response.status === 401 ||
          (response.status === 403 &&
            (yield* Effect.tryPromise({
              try: () => response.clone().text(),
              catch: failure,
            })) === "Invalid or expired token");
        if (!rejected) return response;
        refreshed = true;
        yield* Effect.tryPromise({
          try: async () => {
            await response.body?.cancel();
          },
          catch: failure,
        });
        token = yield* value.refresh.pipe(
          Effect.withSpan("source.repository.token.refresh", {
            attributes: { "source.token.rejected_status": response.status },
          }),
        );
        return yield* send;
      });
  };
  const client = (
    value: RepositoryAccess,
    signal: AbortSignal,
    context: Context.Context<Scope.Scope>,
  ): Git.HttpClient => {
    const remote = value.remote;
    const fetchWithToken = authenticatedFetch(value);
    return {
      request: async (request) => {
        const url = new URL(request.url);
        if (
          url.origin !== new URL(remote).origin ||
          !url.pathname.startsWith(`${new URL(remote).pathname}/`)
        )
          throw new Error("Unexpected Git destination");
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (request.body !== undefined)
          for await (const chunk of request.body) {
            size += chunk.length;
            if (size > 32 * 1024 * 1024) throw new Error("Git request too large");
            chunks.push(chunk);
          }
        const body = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.length;
        }
        const run = Effect.runPromiseWith(context);
        const { response, headersSpan } = await run(
          Effect.gen(function* () {
            const headersSpan = yield* Effect.currentSpan;
            const propagation = yield* traceHeaders;
            const response = yield* fetchWithToken(url, {
              method: request.method ?? "GET",
              headers: { ...request.headers, ...propagation },
              ...(request.body === undefined ? {} : { body }),
              redirect: "manual",
              signal,
            });
            yield* Effect.annotateCurrentSpan("http.response.status_code", response.status);
            return { response, headersSpan };
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
          ),
          { signal },
        );
        const stream = async function* () {
          if (response.body === null) return;
          const observed = await run(pendingSpan("source.git.http.body", { parent: headersSpan }));
          const reader = response.body.getReader();
          let total = 0;
          let exit: Exit.Exit<unknown, unknown> = Exit.void;
          let cleanupFailure: SourceError | undefined;
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              total += next.value.length;
              if (total > 32 * 1024 * 1024) throw new Error("Git repository too large");
              yield next.value;
            }
          } catch (error) {
            exit = Exit.fail(failure(error));
            throw error;
          } finally {
            observed.span.attribute("source.git.response.bytes", total);
            try {
              await reader.cancel();
            } catch (error) {
              cleanupFailure = failure(error);
              exit = Exit.fail(cleanupFailure);
            } finally {
              reader.releaseLock();
              await run(observed.finish(exit));
            }
          }
          if (cleanupFailure !== undefined) throw cleanupFailure;
        };
        return {
          url: response.url,
          statusCode: response.status,
          statusMessage: response.statusText,
          headers: (() => {
            const headers: Record<string, string> = {};
            response.headers.forEach((value, key) => {
              headers[key] = value;
            });
            return headers;
          })(),
          body: stream(),
        };
      },
    };
  };
  const withGit = <A>(
    name: string,
    value: RepositoryAccess,
    work: (http: Git.HttpClient) => Promise<A>,
  ) =>
    Effect.gen(function* () {
      const telemetry = yield* captureTelemetry;
      const scope = yield* Scope.Scope;
      const context = Context.add(telemetry.context, Scope.Scope, scope);
      return yield* Effect.tryPromise({
        try: (signal) => work(client(value, signal, context)),
        catch: failure,
      });
    }).pipe(Effect.withSpan(name), Effect.scoped);
  const session = (credentials: ReturnType<typeof access>) =>
    credentials.pipe(
      Effect.map((access) => ({ ...access, fs: createFsFromVolume(new Volume()), dir: "/repo" })),
    );
  return protectGit({
    history: (id) =>
      Effect.gen(function* () {
        const value = yield* session(access(id));
        const rows = yield* withGit("source.git.history", value, async (http) => {
          const options = { fs: value.fs, dir: value.dir };
          await Git.clone({
            ...options,
            http,
            url: value.remote,
            ref: "main",
            singleBranch: true,
            noCheckout: true,
            noTags: true,
            depth: 50,
          });
          return (await Git.log({ ...options, ref: "main", depth: 50 })).map((entry) => ({
            commit: entry.oid,
            author: entry.commit.author.name,
            message: entry.commit.message.trim(),
            timestamp: entry.commit.author.timestamp,
          }));
        });
        return yield* Schema.decodeUnknownEffect(Schema.Array(GitCommit))(rows);
      }).pipe(Effect.mapError(failure)),
    create: (id) => create(id).pipe(Effect.asVoid),
    head: (id, branch) =>
      Effect.gen(function* () {
        const name = yield* Schema.decodeUnknownEffect(Branch)(branch);
        const value = yield* access(id);
        const refs = yield* withGit("source.git.refs", value, (http) =>
          Git.listServerRefs({
            http,
            url: value.remote,
            prefix: `refs/heads/${name}`,
          }),
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
          Git.clone({
            ...options,
            http,
            url: value.remote,
            ref: requested,
            noCheckout: true,
            singleBranch: true,
            depth: 1,
            noTags: true,
          }).catch((cause) => {
            throw Schema.is(Commit)(ref) ? failure(cause) : branchFailure(cause, requested);
          }),
        );
        const result = yield* Effect.tryPromise({
          try: async () => {
            const commit = Schema.is(Commit)(ref)
              ? ref
              : await Git.resolveRef({ ...options, ref: `refs/remotes/origin/${ref}` }).catch(
                  (cause) => {
                    // An empty repository makes clone succeed without writing a remote branch.
                    throw branchFailure(cause, `refs/remotes/origin/${ref}`);
                  },
                );
            const files: Array<{ path: string; content: string }> = [];
            let total = 0;
            const walk = async (oid: string, prefix: string): Promise<void> => {
              const tree = await Git.readTree({ ...options, oid });
              for (const entry of tree.tree) {
                if (entry.type === "tree") {
                  await walk(entry.oid, `${prefix}${entry.path}/`);
                  continue;
                }
                if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755"))
                  throw new SourceError({ reason: "invalid-source" });
                const blob = await Git.readBlob({ ...options, oid: entry.oid });
                total += blob.blob.length;
                if (!sourceFits(files.length + 1, total))
                  throw new SourceError({ reason: "limit" });
                files.push({
                  path: prefix + entry.path,
                  content: new TextDecoder("utf-8", { fatal: true }).decode(blob.blob),
                });
              }
            };
            await walk(commit, "");
            return { commit, files };
          },
          catch: failure,
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
        return yield* withGit("source.git.commit", value, async (http) => {
          const options = { fs: value.fs, dir: value.dir };
          if (input.expected === null) {
            await Git.init({ ...options, defaultBranch: input.branch });
            await Git.addRemote({ ...options, remote: "origin", url: value.remote });
          } else
            await Git.clone({
              ...options,
              http,
              url: value.remote,
              noCheckout: true,
              ref: input.branch,
              singleBranch: true,
              depth: 1,
              noTags: true,
            });
          const writeTree = async (prefix: string): Promise<string> => {
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
                oid: await Git.writeBlob({
                  ...options,
                  blob: new TextEncoder().encode(file.content),
                }),
              });
            }
            for (const directory of directories)
              entries.push({
                mode: "040000",
                path: directory,
                type: "tree",
                oid: await writeTree(`${prefix}${directory}/`),
              });
            return Git.writeTree({ ...options, tree: entries });
          };
          const author = {
            name: "Executor",
            email: "apps@executor.local",
            timestamp: Math.floor(Date.now() / 1000),
            timezoneOffset: 0,
          };
          const commit = await Git.writeCommit({
            ...options,
            commit: {
              tree: await writeTree(""),
              parent: input.expected === null ? [] : [input.expected],
              author,
              committer: author,
              message: input.message,
            },
          });
          await Git.writeRef({
            ...options,
            ref: `refs/heads/${input.branch}`,
            value: commit,
            force: true,
          });
          try {
            const result = await Git.push({
              ...options,
              http,
              url: value.remote,
              ref: input.branch,
              remoteRef: input.branch,
              onPrePush: ({ remoteRef }) => {
                if (remoteRef.oid !== (input.expected ?? "0".repeat(40)))
                  throw new SourceError({ reason: "conflict" });
                return true;
              },
            });
            if (!result.ok) throw new SourceError({ reason: "git" });
          } catch (cause) {
            if (Schema.is(SourceError)(cause) && cause.reason === "conflict") throw cause;
            // A rejected push or lost acknowledgment has several protocol error shapes.
            // Reconcile the actual ref: our commit succeeded, another writer won,
            // or the expected ref still holds and the original failure must surface.
            const ref = `refs/heads/${input.branch}`;
            const refs = await Git.listServerRefs({ http, url: value.remote, prefix: ref });
            const current = refs.find((entry) => entry.ref === ref)?.oid ?? null;
            if (current === commit) return commit;
            if (current !== input.expected) throw new SourceError({ reason: "conflict" });
            throw cause;
          }
          return commit;
        }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Commit)),
          Effect.mapError(failure),
          Effect.tapError(observeFailure),
        );
      }),
    request: (id, request) =>
      Effect.gen(function* () {
        const url = new URL(request.url);
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
        const response = yield* authenticatedFetch(value)(value.remote + suffix + url.search, {
          method: request.method,
          headers,
          ...(body === undefined ? {} : { body }),
        });
        if (response.status >= 300 && response.status < 400) {
          yield* Effect.tryPromise({
            try: async () => {
              await response.body?.cancel();
            },
            catch: failure,
          });
          return yield* failure();
        }
        return response;
      }).pipe(Effect.scoped),
  });
};
