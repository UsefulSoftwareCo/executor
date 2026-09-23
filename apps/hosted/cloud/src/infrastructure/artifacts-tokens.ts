/** One private coordinator per repository owns encrypted Artifacts credentials and refreshes. */
import { AppCodeId, aesGcmCredentials } from "@executor-js/sdk/core";
import { SourceError } from "@executor-js/app-source/contracts";
import type { ArtifactsTokens } from "@executor-js/app-source/cloudflare";
import {
  currentTraceContext,
  externalTrace,
  TraceContext,
  traceLinks,
} from "@executor-js/telemetry";
import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stage } from "alchemy/Stage";
import {
  Clock,
  Config,
  Effect,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import { cloudSecrets } from "./secrets.ts";
import { cloudTelemetry } from "./telemetry.ts";

const tokenLifetimeSeconds = 31_536_000;
const refreshBeforeExpiryMs = 5 * 60_000;
const creation = Schema.Struct({
  repository: AppCodeId,
  namespace: Schema.NonEmptyString,
  token: Schema.RedactedFromValue(Schema.NonEmptyString),
});
const credential = Schema.Struct({
  ...creation.fields,
  generation: Schema.NonEmptyString,
  expiresAt: Schema.Number.check(Schema.isFinite()),
});
const issued = Schema.Struct({
  id: Schema.NonEmptyString,
  plaintext: Schema.RedactedFromValue(Schema.NonEmptyString),
  scope: Schema.Literal("write"),
  expiresAt: Schema.String.check(Schema.makeFilter((value) => Number.isFinite(Date.parse(value)))),
});
const envelope = Schema.Struct({ version: Schema.Literal(1), encrypted: Schema.Uint8Array });
const pendingPreparation = Schema.Struct({
  repository: AppCodeId,
  trace: Schema.NullOr(TraceContext),
});
const unavailable = () => new SourceError({ reason: "git" });

/** Both the Git adapter and token coordinator use the stage's existing repository namespace. */
export const cloudSourceNamespace = Effect.gen(function* () {
  const stage = yield* Effect.serviceOption(Stage).pipe(
    Effect.flatMap(
      Option.match({ onSome: Effect.succeed, onNone: () => Config.String("ALCHEMY_STAGE") }),
    ),
  );
  return `executor-${stage}-apps`;
});

const makeArtifactsTokenCoordinator = Effect.gen(function* () {
  const namespace = yield* cloudSourceNamespace;
  const resource = yield* Cloudflare.Artifacts.Namespace("AppSources", { namespace });
  const binding = yield* Cloudflare.Artifacts.ReadWriteNamespace(resource);
  const secrets = yield* cloudSecrets;
  return Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const encryption = yield* aesGcmCredentials(yield* secrets.encryptionKey, crypto);
    const lock = yield* Semaphore.make(1);
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
              const repo = yield* Effect.acquireRelease(
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
      create: (id: string, trace: TraceContext | undefined) =>
        Effect.scoped(
          Effect.gen(function* () {
            const repository = yield* Schema.decodeUnknownEffect(AppCodeId)(id);
            const created = yield* Effect.acquireRelease(
              binding.create(repository, { setDefaultBranch: "main" }).pipe(
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
}).pipe(
  Effect.provide(Layer.mergeAll(Cloudflare.Artifacts.ReadWriteNamespaceBinding, cloudTelemetry)),
  Effect.orDie,
);

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

/** A private object per app code serializes refreshes across all Worker instances and callers. */
export class ArtifactsTokenCoordinator extends Cloudflare.DurableObject<
  ArtifactsTokenCoordinator,
  Effect.Success<Effect.Success<typeof makeArtifactsTokenCoordinator>>
>()("ArtifactsTokenCoordinator") {}

/** The deployed host owns the coordinator binding; no public endpoint exposes credentials. */
export const ArtifactsTokenCoordinatorLive = ArtifactsTokenCoordinator.make(
  makeArtifactsTokenCoordinator,
);

/** Decode encrypted internal RPC results back into redacted credentials inside the Git adapter. */
export const cloudArtifactsTokens = (
  coordinator: Cloudflare.DurableObject<ArtifactsTokenCoordinator>,
) =>
  Effect.gen(function* () {
    const namespace = yield* cloudSourceNamespace;
    const secrets = yield* cloudSecrets;
    // Git retries run in a Promise callback with telemetry only. Bind the host environment here
    // so decrypting the RPC envelope does not depend on the callback's ambient services.
    const environment = yield* Cloudflare.WorkerEnvironment;
    const encryption = () =>
      secrets.encryptionKey.pipe(
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
            .acquire(repository, rejectedGeneration, yield* currentTraceContext);
          const payload = yield* decrypt(repository, raw).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(credential)),
          );
          return { token: payload.token, generation: payload.generation };
        }).pipe(Effect.provide(RuntimeContext.phantom), Effect.mapError(unavailable)),
      create: (repository) =>
        Effect.gen(function* () {
          const raw = yield* coordinator
            .getByName(repository)
            .create(repository, yield* currentTraceContext);
          if (raw === null) return null;
          const payload = yield* decrypt(repository, raw).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(creation)),
          );
          return payload.token;
        }).pipe(Effect.provide(RuntimeContext.phantom), Effect.mapError(unavailable)),
    } satisfies ArtifactsTokens;
  }).pipe(Effect.orDie);

/** The API Worker owns the single coordinator namespace used by every source caller. */
export const cloudArtifactsTokensLive = ArtifactsTokenCoordinator.pipe(
  Effect.flatMap(cloudArtifactsTokens),
  Effect.provide(ArtifactsTokenCoordinatorLive),
);
