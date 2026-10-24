/**
 * Git client pieces for the apps CLI: push a directory's files to an app's remote, sending only
 * the blobs the remote lacks in batches under a push's size bound, and read stored files back.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { Effect, Schema, type Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as Git from "isomorphic-git";
// The fetch client: the Node one parses URLs with the deprecated url.parse, which Bun reports.
import http from "isomorphic-git/http/web";
import { SourceError, SourceFilePath } from "@executor-js/sdk/core";
import {
  buildTrees,
  commitObject,
  objectId,
  parseReport,
  pushObjects,
  type PackObject,
  type PushReport,
} from "./implementation/git-pack.ts";

export { objectId, packBlobBytes } from "./implementation/git-pack.ts";

/** One file of the commit to push. Its bytes are read only if the remote lacks its blob. */
export interface PushFile {
  readonly path: string;
  readonly object: string;
  readonly size: number;
  readonly read: Effect.Effect<Uint8Array, SourceError>;
}

/** Why a push did not move the branch. */
export class GitPushRefused extends Schema.TaggedError<GitPushRefused>()("GitPushRefused", {
  reason: Schema.Literals(["conflict", "refused", "transport"]),
  detail: Schema.String,
}) {}

const send =
  (url: string, authorization: string) => (body: Stream.Stream<Uint8Array, SourceError>) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client
        .execute(
          HttpClientRequest.post(`${url}/git-receive-pack`).pipe(
            HttpClientRequest.setHeaders({
              authorization,
              accept: "application/x-git-receive-pack-result",
            }),
            HttpClientRequest.bodyStream(body, {
              contentType: "application/x-git-receive-pack-request",
            }),
          ),
        )
        .pipe(Effect.mapError(() => new SourceError({ reason: "git" })));
      if (response.status !== 200)
        return yield* new SourceError({ reason: response.status === 413 ? "limit" : "git" });
      return new Uint8Array(
        yield* response.arrayBuffer.pipe(Effect.mapError(() => new SourceError({ reason: "git" }))),
      );
    }).pipe(
      Effect.scoped,
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.provide(FetchHttpClient.layer),
    );

/**
 * Push `files` as the complete tree of a commit on `main` after `expected`. Blobs in `present`,
 * the object IDs of the files the remote already has, are named but not sent.
 */
export const pushTree = (input: {
  readonly url: string;
  readonly authorization: string;
  readonly expected: string;
  readonly present: ReadonlySet<string>;
  readonly files: ReadonlyArray<PushFile>;
  readonly message: string;
}) =>
  Effect.gen(function* () {
    const { tree, trees } = buildTrees(input.files);
    const seconds = Math.floor(Date.now() / 1000);
    const bytes = commitObject({
      tree,
      parents: [input.expected],
      message: input.message,
      seconds,
    });
    const commit = objectId("commit", bytes);
    const blobs = new Map<string, PackObject>();
    for (const file of input.files)
      if (!input.present.has(file.object))
        blobs.set(file.object, {
          type: "blob",
          object: file.object,
          size: file.size,
          read: file.read,
        });
    const report: PushReport = yield* pushObjects({
      receive: send(input.url, input.authorization),
      ref: "refs/heads/main",
      expected: input.expected,
      commit: { type: "commit", object: commit, size: bytes.length, read: Effect.succeed(bytes) },
      trees: trees.map((entry) => ({
        type: "tree" as const,
        object: entry.object,
        size: entry.bytes.length,
        read: Effect.succeed(entry.bytes),
      })),
      blobs: [...blobs.values()].toSorted((left, right) => left.size - right.size),
      // Protected `__executor/` refs cannot be pushed; this one is deleted by the final push.
      staging: `refs/heads/executor-upload/${crypto.randomUUID()}`,
      seconds,
    }).pipe(
      Effect.mapError(
        (error) =>
          new GitPushRefused({
            reason: "transport",
            detail:
              error.reason === "limit"
                ? "The host refused a push as too large."
                : "The push did not complete.",
          }),
      ),
    );
    const result = report.refs.get("refs/heads/main");
    if (result === "ok") return { commit, sent: blobs.size };
    const reason = result === undefined ? "no report for main" : result.refused;
    return yield* new GitPushRefused({
      reason: /stale|non-fast-forward|fetch first|lock/iu.test(reason) ? "conflict" : "refused",
      detail: report.unpacked ? reason : `the host could not unpack the push (${reason})`,
    });
  });

/** Parse a push report; exported for callers that send their own requests. */
export { parseReport };

/**
 * Read blobs of one commit through a shallow clone into a temporary directory, which is removed
 * afterwards. Returns each requested blob's bytes by object ID.
 */
export const readCommitBlobs = (input: {
  readonly url: string;
  readonly authorization: string;
  readonly commit: string;
  readonly objects: ReadonlyArray<string>;
  readonly write: (object: string, bytes: Uint8Array) => Effect.Effect<void, SourceError>;
}) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => fs.promises.mkdtemp(nodePath.join(os.tmpdir(), "executor-source-")),
      catch: () => new SourceError({ reason: "storage" }),
    }),
    (dir) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () =>
            Git.clone({
              fs,
              http,
              dir,
              url: input.url,
              ref: "main",
              singleBranch: true,
              depth: 1,
              noCheckout: true,
              noTags: true,
              headers: { authorization: input.authorization },
            }),
          catch: () => new SourceError({ reason: "git" }),
        });
        const head = yield* Effect.tryPromise({
          try: () => Git.resolveRef({ fs, dir, ref: "refs/remotes/origin/main" }),
          catch: () => new SourceError({ reason: "git" }),
        });
        // The working branch moved after the listing was read; read it again.
        if (head !== input.commit) return yield* new SourceError({ reason: "conflict" });
        for (const object of input.objects) {
          const { blob } = yield* Effect.tryPromise({
            try: () => Git.readBlob({ fs, dir, oid: object }),
            catch: () => new SourceError({ reason: "not-found" }),
          });
          yield* input.write(object, blob);
        }
      }),
    (dir) => Effect.promise(() => fs.promises.rm(dir, { recursive: true, force: true })),
  );

/** Read only the selected commit's files, including retained commits behind the working branch. */
export const readCommitFiles = (input: {
  readonly url: string;
  readonly authorization: string;
  readonly commit: string;
  readonly write: (path: SourceFilePath, bytes: Uint8Array) => Effect.Effect<void, SourceError>;
}) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => fs.promises.mkdtemp(nodePath.join(os.tmpdir(), "executor-publication-")),
      catch: () => new SourceError({ reason: "storage" }),
    }),
    (dir) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: async () => {
            await Git.init({ fs, dir, defaultBranch: "main" });
            await Git.addRemote({ fs, dir, remote: "origin", url: input.url });
            await Git.fetch({
              fs,
              http,
              dir,
              url: input.url,
              ref: input.commit,
              singleBranch: true,
              depth: 1,
              tags: false,
              headers: { authorization: input.authorization },
            });
          },
          catch: () => new SourceError({ reason: "git" }),
        });
        const paths = yield* Effect.tryPromise({
          try: () => Git.listFiles({ fs, dir, ref: input.commit }),
          catch: () => new SourceError({ reason: "git" }),
        });
        for (const file of paths) {
          const path = yield* Schema.decodeUnknownEffect(SourceFilePath)(file).pipe(
            Effect.mapError(() => new SourceError({ reason: "git" })),
          );
          const { blob } = yield* Effect.tryPromise({
            try: () => Git.readBlob({ fs, dir, oid: input.commit, filepath: path }),
            catch: () => new SourceError({ reason: "not-found" }),
          });
          yield* input.write(path, blob);
        }
      }),
    (dir) => Effect.promise(() => fs.promises.rm(dir, { recursive: true, force: true })),
  );
