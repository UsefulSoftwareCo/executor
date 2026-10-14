/**
 * Private entry point for Artifacts token coordinators. A coordinator that wakes in a fresh isolate
 * loads and initializes only this Worker, not the API with its routes, auth and executor. It holds
 * the stage's only Artifacts binding, so it also lists commit history, which Git cannot fetch
 * without every file those commits hold.
 */
import { AppCodeId, SourceError, SourceFilePath, aesGcmCredentials } from "@executor-js/sdk/core";
import { externalTrace, TraceContext, traceLinks } from "@executor-js/telemetry";
import * as Cloudflare from "alchemy/Cloudflare";
import { Clock, Effect, Layer, Option, Redacted, Schedule, Schema, Semaphore } from "effect";
import { ArtifactsCredentials } from "./infrastructure/artifacts-credentials-worker.ts";
import {
  ArtifactsTokenCoordinator,
  cloudSourceNamespace,
  creation,
  credential,
  envelope,
  unavailable,
} from "./infrastructure/artifacts-tokens.ts";
import { cloudEncryptionKey } from "./infrastructure/secrets.ts";
import {
  cloudObservability,
  cloudTelemetry,
  telemetryBindings,
} from "./infrastructure/telemetry.ts";
import { providerFailureCode } from "./implementation/provider-failure.ts";

const tokenLifetimeSeconds = 31_536_000;
const refreshBeforeExpiryMs = 5 * 60_000;
const issued = Schema.Struct({
  id: Schema.NonEmptyString,
  plaintext: Schema.RedactedFromValue(Schema.NonEmptyString),
  scope: Schema.Literal("write"),
  expiresAt: Schema.String.check(Schema.makeFilter((value) => Number.isFinite(Date.parse(value)))),
});
/** The fields of the binding's commit metadata that history shows. */
const listedCommit = Schema.Struct({
  hash: Schema.String,
  message: Schema.String,
  author: Schema.Struct({ name: Schema.String }),
  authoredAt: Schema.Number,
});
/** A tree entry as the binding returns it. */
const treeEntry = Schema.Struct({
  name: Schema.String,
  mode: Schema.String,
  hash: Schema.String,
  type: Schema.String,
});
const commitTree = Schema.Struct({ hash: Schema.String, treeHash: Schema.String });
const objectId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
/** Blobs read at once: each is held only until its size, and bytes within budget, are taken. */
const blobReads = 4;
const pendingPreparation = Schema.Struct({
  repository: AppCodeId,
  trace: Schema.NullOr(TraceContext),
});

const makeArtifactsTokenCoordinator = Effect.gen(function* () {
  const namespace = yield* cloudSourceNamespace;
  const resource = yield* Cloudflare.Artifacts.Namespace("AppSources", { namespace });
  const binding = yield* Cloudflare.Artifacts.ReadWriteNamespace(resource);
  const encryptionKey = yield* cloudEncryptionKey;
  return Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const encryption = yield* aesGcmCredentials(yield* encryptionKey, crypto);
    const lock = yield* Semaphore.make(1);
    const open = (repository: AppCodeId) =>
      Effect.acquireRelease(
        binding.get(repository).pipe(
          Effect.retry({
            while: (error) =>
              error.message ===
              `Repository "${repository}" is currently being created. The repository is not yet available. Retry after 5 seconds.`,
            schedule: Schedule.spaced("5 seconds"),
            times: 2,
          }),
          Effect.withSpan("source.repository.open"),
        ),
        (repo) => disposeRpc(repo.raw),
      );
    const acquire = (repository: AppCodeId, rejectedGeneration: string | null) =>
      lock
        .withPermits(1)(
          Effect.scoped(
            Effect.gen(function* () {
              if (rejectedGeneration !== null)
                yield* Effect.annotateCurrentSpan(
                  "source.token.rejected_generation",
                  rejectedGeneration,
                );
              const now = yield* Clock.currentTimeMillis;
              const stored = yield* state.storage.get<unknown>("credential");
              if (stored !== undefined) {
                const saved = yield* Schema.decodeUnknownEffect(envelope)(stored);
                const decoded = yield* encryption.decrypt(
                  repository,
                  Redacted.make(saved.encrypted),
                );
                const token = yield* Schema.decodeUnknownEffect(credential)(
                  Redacted.value(decoded),
                );
                if (token.repository !== repository || token.namespace !== namespace)
                  return yield* unavailable();
                if (
                  token.expiresAt > now + refreshBeforeExpiryMs &&
                  token.generation !== rejectedGeneration
                ) {
                  yield* Effect.annotateCurrentSpan("source.token.reused", true);
                  yield* Effect.annotateCurrentSpan("source.token.generation", token.generation);
                  return saved;
                }
              }
              const repo = yield* open(repository);
              const result = yield* Effect.acquireRelease(
                repo
                  .createToken("write", tokenLifetimeSeconds)
                  .pipe(Effect.withSpan("source.repository.token")),
                (result) => disposeRpc(result),
              );
              // RPC properties are read while the provider handle is alive; no plaintext is logged or stored.
              const minted = yield* Effect.tryPromise({
                try: async () => ({
                  id: await result.id,
                  plaintext: await result.plaintext,
                  scope: await result.scope,
                  expiresAt: await result.expiresAt,
                }),
                catch: unavailable,
              }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(issued)));
              const expiresAt = Date.parse(minted.expiresAt);
              if (expiresAt <= now + refreshBeforeExpiryMs) return yield* unavailable();
              const payload = yield* Schema.encodeEffect(credential)({
                repository,
                namespace,
                token: minted.plaintext,
                generation: minted.id,
                expiresAt,
              });
              const encrypted = yield* encryption.encrypt(repository, Redacted.make(payload));
              const saved = { version: 1 as const, encrypted };
              yield* state.storage.put("credential", saved);
              yield* Effect.annotateCurrentSpan("source.token.reused", false);
              yield* Effect.annotateCurrentSpan("source.token.generation", minted.id);
              yield* Effect.annotateCurrentSpan(
                "source.token.lifetime_seconds",
                tokenLifetimeSeconds,
              );
              return saved;
            }),
          ),
        )
        .pipe(Effect.mapError(unavailable), Effect.withSpan("source.repository.token.acquire"));
    return {
      acquire: (id: string, rejectedGeneration: string | null, trace: TraceContext | undefined) =>
        Schema.decodeUnknownEffect(AppCodeId)(id).pipe(
          Effect.flatMap((repository) =>
            Schema.decodeUnknownEffect(Schema.NullOr(Schema.NonEmptyString))(
              rejectedGeneration,
            ).pipe(Effect.flatMap((rejected) => acquire(repository, rejected))),
          ),
          Effect.withSpan("source.repository.credentials", {
            parent: Option.getOrUndefined(externalTrace(trace)),
          }),
          Effect.mapError(unavailable),
        ),
      history: (id: string, limit: number, trace: TraceContext | undefined) =>
        Effect.scoped(
          Effect.gen(function* () {
            const repository = yield* Schema.decodeUnknownEffect(AppCodeId)(id);
            const repo = yield* open(repository);
            // Commit metadata only, newest first along main's first-parent chain. An unresolved
            // ref lists nothing, as a repository with no commits has no history.
            const commits = yield* Effect.tryPromise({
              try: () => repo.raw.log({ ref: "main", limit }),
              catch: unavailable,
            }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(listedCommit))));
            yield* Effect.annotateCurrentSpan("source.history.commits", commits.length);
            return commits.map((entry) => ({
              commit: entry.hash,
              author: entry.author.name,
              message: entry.message.trim(),
              timestamp: entry.authoredAt,
            }));
          }),
        ).pipe(
          Effect.mapError(unavailable),
          Effect.withSpan("source.repository.history", {
            parent: Option.getOrUndefined(externalTrace(trace)),
          }),
        ),
      resolve: (id: string, ref: string, trace: TraceContext | undefined) =>
        Effect.scoped(
          Effect.gen(function* () {
            const repository = yield* Schema.decodeUnknownEffect(AppCodeId)(id);
            const repo = yield* open(repository);
            // A commit is read as given; a branch resolves to its head along the first-parent log.
            const found = Schema.is(objectId)(ref)
              ? yield* Effect.tryPromise({
                  try: () => repo.raw.readCommit(ref),
                  catch: unavailable,
                }).pipe(Effect.map((commit) => (commit === null ? [] : [commit])))
              : yield* Effect.tryPromise({
                  try: () => repo.raw.log({ ref, limit: 1 }),
                  catch: unavailable,
                });
            const [head] = yield* Schema.decodeUnknownEffect(Schema.Array(commitTree))(found);
            return head === undefined ? null : { commit: head.hash, tree: head.treeHash };
          }),
        ).pipe(
          Effect.mapError(unavailable),
          Effect.withSpan("source.repository.resolve", {
            parent: Option.getOrUndefined(externalTrace(trace)),
          }),
        ),
      tree: (id: string, root: string, trace: TraceContext | undefined) =>
        Effect.scoped(
          Effect.gen(function* () {
            const repository = yield* Schema.decodeUnknownEffect(AppCodeId)(id);
            const repo = yield* open(repository);
            const files: Array<{ path: string; mode: string; type: string; object: string }> = [];
            const walk = (hash: string, prefix: string): Effect.Effect<void, SourceError> =>
              Effect.gen(function* () {
                const entries = yield* Effect.tryPromise({
                  try: () => repo.raw.readTree(hash),
                  catch: unavailable,
                }).pipe(
                  Effect.flatMap(
                    Schema.decodeUnknownEffect(Schema.NullOr(Schema.Array(treeEntry))),
                  ),
                  Effect.mapError(unavailable),
                );
                if (entries === null) return yield* unavailable();
                for (const entry of entries) {
                  if (entry.type === "tree") yield* walk(entry.hash, `${prefix}${entry.name}/`);
                  else
                    files.push({
                      path: `${prefix}${entry.name}`,
                      mode: entry.mode,
                      type: entry.type,
                      object: entry.hash,
                    });
                }
              });
            yield* walk(yield* Schema.decodeUnknownEffect(objectId)(root), "");
            yield* Effect.annotateCurrentSpan("source.tree.files", files.length);
            return files;
          }),
        ).pipe(
          Effect.mapError(unavailable),
          Effect.withSpan("source.repository.tree", {
            parent: Option.getOrUndefined(externalTrace(trace)),
          }),
        ),
      blobs: (
        id: string,
        objects: ReadonlyArray<string>,
        mode: "sizes" | "bytes",
        budget: number,
        trace: TraceContext | undefined,
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            const repository = yield* Schema.decodeUnknownEffect(AppCodeId)(id);
            const ids = yield* Schema.decodeUnknownEffect(Schema.Array(objectId))(objects);
            const repo = yield* open(repository);
            // Each blob is held only while its size, and its bytes when asked for, are taken.
            let total = 0;
            return yield* Effect.forEach(
              ids,
              (object) =>
                Effect.tryPromise({
                  try: async () => {
                    const blob = await repo.raw.readBlob(object);
                    if (blob === null) return null;
                    total += blob.size;
                    if (mode === "sizes" || total > budget)
                      return { object, size: blob.size, bytes: null };
                    return {
                      object,
                      size: blob.size,
                      bytes: new Uint8Array(await blob.arrayBuffer()),
                    };
                  },
                  catch: unavailable,
                }).pipe(
                  Effect.flatMap((entry) =>
                    entry === null ? Effect.fail(unavailable()) : Effect.succeed(entry),
                  ),
                ),
              { concurrency: blobReads },
            );
          }),
        ).pipe(
          Effect.mapError(unavailable),
          Effect.withSpan("source.repository.blobs", {
            attributes: { "source.blobs.count": objects.length },
            parent: Option.getOrUndefined(externalTrace(trace)),
          }),
        ),
      file: (id: string, commit: string, path: string, trace: TraceContext | undefined) =>
        Effect.scoped(
          Effect.gen(function* () {
            const repository = yield* Schema.decodeUnknownEffect(AppCodeId)(id);
            const ref = yield* Schema.decodeUnknownEffect(objectId)(commit);
            const name = yield* Schema.decodeUnknownEffect(SourceFilePath)(path);
            const repo = yield* open(repository);
            return yield* Effect.tryPromise({
              try: async () => {
                const blob = await repo.raw.readFile({ ref, path: name });
                return blob === null ? null : new Uint8Array(await blob.arrayBuffer());
              },
              catch: unavailable,
            });
          }),
        ).pipe(
          Effect.mapError(unavailable),
          Effect.withSpan("source.repository.file", {
            parent: Option.getOrUndefined(externalTrace(trace)),
          }),
        ),
      create: (id: string, trace: TraceContext | undefined) =>
        Effect.scoped(
          Effect.gen(function* () {
            const repository = yield* Schema.decodeUnknownEffect(AppCodeId)(id);
            const created = yield* Effect.acquireRelease(
              binding.create(repository, { setDefaultBranch: "main" }).pipe(
                Effect.tapError((error) =>
                  Effect.annotateCurrentSpan(
                    "source.repository.create.failure",
                    providerFailureCode(error),
                  ),
                ),
                // Creation is keyed by the same immutable repository ID. If an
                // internal provider failure committed before its reply failed,
                // ALREADY_EXISTS below reconciles the existing repository.
                Effect.retry({
                  while: (error) => providerFailureCode(error) === "internal",
                  schedule: Schedule.exponential("1 second"),
                  times: 2,
                }),
                Effect.withSpan("source.repository.create"),
                Effect.catchTag("ArtifactsError", (error) =>
                  Option.isSome(
                    Schema.decodeUnknownOption(
                      Schema.Struct({ code: Schema.Literal("ALREADY_EXISTS") }),
                    )(error.cause),
                  )
                    ? Effect.succeed(null)
                    : Effect.fail(error),
                ),
              ),
              (created) => disposeRpc(created),
            );
            if (created === null) return null;
            const token = yield* Effect.tryPromise({
              try: async () => created.token,
              catch: unavailable,
            }).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(Schema.RedactedFromValue(Schema.NonEmptyString)),
              ),
              Effect.withSpan("source.repository.initial-token.read"),
            );
            const payload = yield* Schema.encodeEffect(creation)({ repository, namespace, token });
            const encrypted = yield* encryption.encrypt(repository, Redacted.make(payload));
            // A separate durable alarm owns issuance and its telemetry, even after this RPC returns.
            yield* state.storage.put("prepare", {
              repository,
              trace: Option.getOrNull(Schema.decodeUnknownOption(TraceContext)(trace)),
            });
            yield* state.storage.setAlarm(yield* Clock.currentTimeMillis);
            return { version: 1 as const, encrypted };
          }),
        ).pipe(
          Effect.mapError(unavailable),
          Effect.withSpan("source.repository.initialize", {
            parent: Option.getOrUndefined(externalTrace(trace)),
          }),
        ),
      alarm: () =>
        Effect.gen(function* () {
          const raw = yield* state.storage.get<unknown>("prepare");
          if (raw === undefined) return;
          const pending = yield* Schema.decodeUnknownEffect(pendingPreparation)(raw);
          yield* acquire(pending.repository, null).pipe(
            Effect.withSpan("source.repository.token.prepare", {
              root: true,
              links: traceLinks(pending.trace, "repository-creation"),
            }),
          );
          yield* state.storage.delete("prepare");
        }).pipe(
          Effect.mapError(unavailable),
          Effect.tapError(() =>
            Effect.logError("Artifacts token preparation failed; the alarm will retry"),
          ),
          Effect.orDie,
        ),
    };
  }).pipe(Effect.orDie);
}).pipe(Effect.provide(Cloudflare.Artifacts.ReadWriteNamespaceBinding), Effect.orDie);

/** Dispose provider RPC handles without retaining them in the credential store. */
const disposeRpc = (value: unknown) =>
  Effect.sync(() => {
    if (
      value !== null &&
      (typeof value === "object" || typeof value === "function") &&
      Symbol.dispose in value
    ) {
      const dispose = value[Symbol.dispose];
      if (typeof dispose === "function") dispose.call(value);
    }
  });

export default ArtifactsCredentials.make(
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url };
    return {
      main: import.meta.url,
      ...(yield* cloudObservability),
      workersDev: false,
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
      env: yield* telemetryBindings,
    };
  }),
  Effect.succeed({}).pipe(
    Effect.provide(
      Layer.mergeAll(ArtifactsTokenCoordinator.make(makeArtifactsTokenCoordinator), cloudTelemetry),
    ),
  ),
);
