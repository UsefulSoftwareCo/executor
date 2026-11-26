import { AppCodeId, GitCommit, SourceError, aesGcmCredentials } from "@executor-js/sdk/core";
import type { ArtifactsTokens } from "@executor-js/app-source/cloudflare";
import { currentTraceContext, type TraceContext } from "@executor-js/telemetry";
import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { ArtifactsCredentials } from "./artifacts-credentials-worker.ts";
import { cloudEncryptionKey } from "./secrets.ts";
import { sourceNamespace } from "../contracts/artifacts-namespace.ts";
import { providerFailureCode } from "../implementation/provider-failure.ts";
import { inJurisdiction } from "./jurisdiction.ts";

export const creation = Schema.Struct({
  repository: AppCodeId,
  namespace: Schema.NonEmptyString,
  token: Schema.RedactedFromValue(Schema.NonEmptyString),
});
export const credential = Schema.Struct({
  ...creation.fields,
  generation: Schema.NonEmptyString,
  expiresAt: Schema.Number.check(Schema.isFinite()),
});
export const envelope = Schema.Struct({ version: Schema.Literal(1), encrypted: Schema.Uint8Array });
export const unavailable = () => new SourceError({ reason: "git" });

export const cloudSourceNamespace = Effect.gen(function* () {
  const stage = yield* Effect.serviceOption(Stage).pipe(
    Effect.flatMap(
      Option.match({ onSome: Effect.succeed, onNone: () => Config.String("ALCHEMY_STAGE") }),
    ),
  );
  return sourceNamespace(stage);
});

interface Coordinator {
  readonly acquire: (
    id: string,
    rejectedGeneration: string | null,
    trace: TraceContext | undefined,
  ) => Effect.Effect<typeof envelope.Type, SourceError, RuntimeContext>;
  readonly history: (
    id: string,
    limit: number,
    trace: TraceContext | undefined,
  ) => Effect.Effect<
    ReadonlyArray<{ commit: string; author: string; message: string; timestamp: number }>,
    SourceError,
    RuntimeContext
  >;
  readonly resolve: (
    id: string,
    ref: string,
    trace: TraceContext | undefined,
  ) => Effect.Effect<{ commit: string; tree: string } | null, SourceError, RuntimeContext>;
  readonly tree: (
    id: string,
    tree: string,
    trace: TraceContext | undefined,
  ) => Effect.Effect<
    ReadonlyArray<{ path: string; mode: string; type: string; object: string }>,
    SourceError,
    RuntimeContext
  >;
  readonly blobs: (
    id: string,
    objects: ReadonlyArray<string>,
    mode: "sizes" | "bytes",
    budget: number,
    trace: TraceContext | undefined,
  ) => Effect.Effect<
    ReadonlyArray<{ object: string; size: number; bytes: Uint8Array | null }>,
    SourceError,
    RuntimeContext
  >;
  readonly file: (
    id: string,
    commit: string,
    path: string,
    trace: TraceContext | undefined,
  ) => Effect.Effect<Uint8Array | null, SourceError, RuntimeContext>;
  readonly create: (
    id: string,
    trace: TraceContext | undefined,
  ) => Effect.Effect<typeof envelope.Type | null, SourceError, RuntimeContext>;
  readonly alarm: () => Effect.Effect<void, never, RuntimeContext>;
}

export class ArtifactsTokenCoordinator extends Cloudflare.DurableObject<
  ArtifactsTokenCoordinator,
  Coordinator
>()("ArtifactsTokenCoordinator", { transferredFrom: "Api" }) {}

export const cloudArtifactsTokens = (
  coordinator: Cloudflare.DurableObject<ArtifactsTokenCoordinator>,
) =>
  Effect.gen(function* () {
    const namespace = yield* cloudSourceNamespace;
    const encryptionKey = yield* cloudEncryptionKey;
    const environment = yield* Cloudflare.WorkerEnvironment;
    const encryption = () =>
      encryptionKey.pipe(
        Effect.provideService(Cloudflare.WorkerEnvironment, environment),
        Effect.flatMap((key) => aesGcmCredentials(key, crypto)),
      );
    const decrypt = (repository: AppCodeId, input: unknown) =>
      Effect.gen(function* () {
        const saved = yield* Schema.decodeUnknownEffect(envelope)(input);
        const decrypted = yield* (yield* encryption()).decrypt(
          repository,
          Redacted.make(saved.encrypted),
        );
        const payload = yield* Schema.decodeUnknownEffect(creation)(Redacted.value(decrypted));
        if (payload.repository !== repository || payload.namespace !== namespace)
          return yield* unavailable();
        return Redacted.value(decrypted);
      });
    return {
      acquire: (repository, rejectedGeneration) =>
        Effect.gen(function* () {
          const raw = yield* coordinator
            .getByName(repository)
            .acquire(repository, rejectedGeneration, yield* currentTraceContext)
            .pipe(
              Effect.tapError((error) =>
                Effect.annotateCurrentSpan(
                  "source.repository.rpc.failure",
                  providerFailureCode(error),
                ),
              ),
              Effect.withSpan("source.repository.credentials.rpc"),
            );
          const payload = yield* decrypt(repository, raw).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(credential)),
          );
          return { token: payload.token, generation: payload.generation };
        }).pipe(Effect.provide(RuntimeContext.phantom), Effect.mapError(unavailable)),
      history: (repository, limit) =>
        Effect.gen(function* () {
          const rows = yield* coordinator
            .getByName(repository)
            .history(repository, limit, yield* currentTraceContext)
            .pipe(
              Effect.tapError((error) =>
                Effect.annotateCurrentSpan(
                  "source.repository.rpc.failure",
                  providerFailureCode(error),
                ),
              ),
              Effect.withSpan("source.repository.history.rpc"),
            );
          return yield* Schema.decodeUnknownEffect(Schema.Array(GitCommit))(rows);
        }).pipe(Effect.provide(RuntimeContext.phantom), Effect.mapError(unavailable)),
      resolve: (repository, ref) =>
        Effect.gen(function* () {
          return yield* coordinator
            .getByName(repository)
            .resolve(repository, ref, yield* currentTraceContext)
            .pipe(Effect.withSpan("source.repository.resolve.rpc"));
        }).pipe(Effect.provide(RuntimeContext.phantom), Effect.mapError(unavailable)),
      tree: (repository, tree) =>
        Effect.gen(function* () {
          return yield* coordinator
            .getByName(repository)
            .tree(repository, tree, yield* currentTraceContext)
            .pipe(Effect.withSpan("source.repository.tree.rpc"));
        }).pipe(Effect.provide(RuntimeContext.phantom), Effect.mapError(unavailable)),
      blobs: (repository, objects, mode, budget) =>
        Effect.gen(function* () {
          return yield* coordinator
            .getByName(repository)
            .blobs(repository, objects, mode, budget, yield* currentTraceContext)
            .pipe(Effect.withSpan("source.repository.blobs.rpc"));
        }).pipe(Effect.provide(RuntimeContext.phantom), Effect.mapError(unavailable)),
      file: (repository, commit, path) =>
        Effect.gen(function* () {
          return yield* coordinator
            .getByName(repository)
            .file(repository, commit, path, yield* currentTraceContext)
            .pipe(Effect.withSpan("source.repository.file.rpc"));
        }).pipe(Effect.provide(RuntimeContext.phantom), Effect.mapError(unavailable)),
      create: (repository) =>
        Effect.gen(function* () {
          const raw = yield* coordinator
            .getByName(repository)
            .create(repository, yield* currentTraceContext)
            .pipe(
              Effect.tapError((error) =>
                Effect.annotateCurrentSpan(
                  "source.repository.rpc.failure",
                  providerFailureCode(error),
                ),
              ),
              Effect.withSpan("source.repository.initialize.rpc"),
            );
          if (raw === null) return null;
          const payload = yield* decrypt(repository, raw).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(creation)),
          );
          return payload.token;
        }).pipe(Effect.provide(RuntimeContext.phantom), Effect.mapError(unavailable)),
    } satisfies ArtifactsTokens;
  }).pipe(Effect.orDie);

export const cloudArtifactsTokensLive = inJurisdiction(
  ArtifactsTokenCoordinator.from(ArtifactsCredentials),
).pipe(Effect.flatMap(cloudArtifactsTokens));
