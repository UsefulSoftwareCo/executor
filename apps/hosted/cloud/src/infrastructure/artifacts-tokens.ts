/** Repository credentials for Git callers; the ArtifactsCredentials Worker hosts the coordinator. */
import { AppCodeId, SourceError, aesGcmCredentials } from "@executor-js/sdk/core";
import type { ArtifactsTokens } from "@executor-js/app-source/cloudflare";
import { currentTraceContext, type TraceContext } from "@executor-js/telemetry";
import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { ArtifactsCredentials } from "./artifacts-credentials-worker.ts";
import { cloudEncryptionKey } from "./secrets.ts";
import { providerFailureCode } from "../implementation/provider-failure.ts";

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
/** Credentials cross the RPC boundary only encrypted with the stage's credential key. */
export const envelope = Schema.Struct({ version: Schema.Literal(1), encrypted: Schema.Uint8Array });
export const unavailable = () => new SourceError({ reason: "git" });

/** Both the Git adapter and token coordinator use the stage's existing repository namespace. */
export const cloudSourceNamespace = Effect.gen(function* () {
  const stage = yield* Effect.serviceOption(Stage).pipe(
    Effect.flatMap(
      Option.match({ onSome: Effect.succeed, onNone: () => Config.String("ALCHEMY_STAGE") }),
    ),
  );
  return `executor-${stage}-apps`;
});

interface Coordinator {
  /** Reuse the stored token unless it is near expiry or its generation was rejected. */
  readonly acquire: (
    id: string,
    rejectedGeneration: string | null,
    trace: TraceContext | undefined,
  ) => Effect.Effect<typeof envelope.Type, SourceError, RuntimeContext>;
  /** Create the repository; null means it already existed. */
  readonly create: (
    id: string,
    trace: TraceContext | undefined,
  ) => Effect.Effect<typeof envelope.Type | null, SourceError, RuntimeContext>;
  readonly alarm: () => Effect.Effect<void, never, RuntimeContext>;
}

/**
 * A private object per app code serializes refreshes across all Worker instances and callers.
 * The namespace, with every stored credential, moved here from the API Worker.
 */
export class ArtifactsTokenCoordinator extends Cloudflare.DurableObject<
  ArtifactsTokenCoordinator,
  Coordinator
>()("ArtifactsTokenCoordinator", { transferredFrom: "Api" }) {}

/** Decode encrypted internal RPC results back into redacted credentials inside the Git adapter. */
export const cloudArtifactsTokens = (
  coordinator: Cloudflare.DurableObject<ArtifactsTokenCoordinator>,
) =>
  Effect.gen(function* () {
    const namespace = yield* cloudSourceNamespace;
    const encryptionKey = yield* cloudEncryptionKey;
    // Git retries run in a Promise callback with telemetry only. Bind the host environment here
    // so decrypting the RPC envelope does not depend on the callback's ambient services.
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

/** Every source caller binds the single coordinator namespace across scripts. */
export const cloudArtifactsTokensLive = ArtifactsTokenCoordinator.from(ArtifactsCredentials).pipe(
  Effect.flatMap(cloudArtifactsTokens),
);
