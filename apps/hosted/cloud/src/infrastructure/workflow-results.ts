/** Encrypt Workflows step and final results with the deployment's credential key. */
import * as Cloudflare from "alchemy/Cloudflare";
import {
  aesGcmCredentials,
  JsonObject,
  WorkflowFailure,
  WorkflowRunId,
} from "@executor-js/sdk/core";
import { Cause, Config, Effect, Exit, Option, Redacted, Result, Schema } from "effect";
import { Hex } from "effect/encoding";
import { cloudEncryptionKey } from "./secrets.ts";

const stepFailurePrefix = "ExecutorEncryptedWorkflowFailure(v1):";
const workflowFailurePrefix = "ExecutorEncryptedWorkflowRunFailure(v1):";
const FailurePayload = Schema.Struct({
  message: Schema.String,
  retryable: Schema.Boolean,
  kind: Schema.Literals(["fail", "die"]),
  failure: Schema.optionalKey(Schema.String),
});
const ValuePayload = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("value"), value: Schema.Unknown }),
  Schema.Struct({ kind: Schema.Literal("undefined") }),
]);
const WorkflowResultInput = Schema.Struct({
  __executorWorkflowResults: Schema.Literal(1),
  params: Schema.Unknown,
});
const engineFailure = () => new WorkflowFailure({ reason: "engine", retryable: false });
const encryptedInstancePrefix = "executor-wfr-v1-";

/** Enable only after every dispatcher runs the marker-aware revision. Fresh installs can enable immediately. */
export const workflowEncryptionEnabled = Config.Boolean("EXECUTOR_ENCRYPTED_WORKFLOW_STARTS").pipe(
  Config.withDefault(false),
  Effect.orDie,
);

/** The native instance identity fixes its result format independently of the returned value. */
export const encryptedWorkflowInstance = (run: string) => `${encryptedInstancePrefix}${run}`;
export const isEncryptedWorkflowInstance = (instance: string) =>
  instance.startsWith(encryptedInstancePrefix);

/** New instances carry their journal format in their native parameters. Old instances have none. */
export const encryptedWorkflowParams = <A>(params: A, enabled = true) =>
  enabled ? { __executorWorkflowResults: 1 as const, params } : params;

/** Keep markerless instances on their original step names and replay behavior. */
export const workflowResultInput = (input: unknown) =>
  Effect.gen(function* () {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      !Object.hasOwn(input, "__executorWorkflowResults")
    )
      return { mode: "legacy", params: input } as const;

    const decoded = yield* Schema.decodeUnknownEffect(WorkflowResultInput)(input).pipe(
      Effect.mapError(engineFailure),
      Effect.orDie,
    );
    return { mode: "encrypted", params: decoded.params } as const;
  });

const failureCiphertext = (error: unknown, prefix: string) => {
  if (!(error instanceof Error)) return Option.none<Uint8Array>();
  const marker = error.message.lastIndexOf(prefix);
  if (marker < 0) return Option.none<Uint8Array>();
  const encoded = error.message.slice(marker + prefix.length);
  if (!/^(?:[0-9a-f]{2})+$/i.test(encoded)) return Option.some(new Uint8Array());
  const decoded = Hex.decode(encoded);
  return Result.isSuccess(decoded) ? Option.some(decoded.success) : Option.some(new Uint8Array());
};

/** Resolve the existing key resource once; read its value inside every Worker invocation. */
export const workflowEncryptionKey = Effect.gen(function* () {
  const keyEffect = yield* cloudEncryptionKey;
  const context = yield* Effect.context<never>();
  return keyEffect.pipe(Effect.provideContext(context));
}).pipe(Effect.orDie);
export type WorkflowEncryptionKey = Effect.Success<typeof workflowEncryptionKey>;

/** Read the captured key effect inside this workflow invocation. */
export const workflowResults = (run: string, keyEffect: WorkflowEncryptionKey) =>
  Effect.gen(function* () {
    const credentials = yield* keyEffect.pipe(
      Effect.flatMap((key) => aesGcmCredentials(key, crypto)),
      Effect.mapError(engineFailure),
    );

    const purpose = (item: string) => WorkflowRunId.make(`executor-workflow-v1:${run}:${item}`);
    const seal = (item: string, value: unknown) =>
      Schema.decodeUnknownEffect(JsonObject)(value).pipe(
        Effect.mapError(engineFailure),
        Effect.flatMap((payload) =>
          credentials
            .encrypt(purpose(item), Redacted.make(payload))
            .pipe(Effect.mapError(engineFailure)),
        ),
      );
    const open = (item: string, value: unknown) =>
      Effect.gen(function* () {
        if (!(value instanceof Uint8Array)) return yield* Effect.fail(engineFailure());
        const decrypted = yield* credentials
          .decrypt(purpose(item), Redacted.make(Uint8Array.from(value)))
          .pipe(Effect.mapError(engineFailure));
        return Redacted.value(decrypted);
      });

    const occurrences = new Map<string, number>();
    const active = new Set<string>();
    const stepIdentity = (name: string) => {
      const occurrence = occurrences.get(name) ?? 0;
      occurrences.set(name, occurrence + 1);
      const identity = JSON.stringify([name, occurrence]);
      return Effect.tryPromise({
        try: async () => {
          const digest = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(JSON.stringify([run, name, occurrence])),
          );
          return {
            identity,
            storedName: `executor-workflow-v1-${Hex.encode(new Uint8Array(digest))}`,
          };
        },
        catch: engineFailure,
      });
    };

    return {
      withStep: <A, E, R>(name: string, work: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(
          Effect.suspend(() => {
            if (active.has(name)) return Effect.fail(engineFailure());
            active.add(name);
            return Effect.void;
          }),
          () => work,
          () => Effect.sync(() => active.delete(name)),
        ),
      sealStepValue: (identity: string, value: unknown) =>
        seal(
          `step:${identity}`,
          value === undefined ? { kind: "undefined" } : { kind: "value", value },
        ),
      openStepValue: (identity: string, value: unknown) =>
        open(`step:${identity}`, value).pipe(
          Effect.flatMap((payload) =>
            Schema.decodeUnknownEffect(ValuePayload)(payload).pipe(
              Effect.map((decoded) => (decoded.kind === "undefined" ? undefined : decoded.value)),
              Effect.mapError(engineFailure),
            ),
          ),
        ),
      sealStepFailure: (identity: string, value: typeof FailurePayload.Type) =>
        seal(`step:${identity}`, value).pipe(
          Effect.map((ciphertext) => `${stepFailurePrefix}${Hex.encode(ciphertext)}`),
        ),
      openStepFailure: (identity: string, error: unknown) => {
        const ciphertext = failureCiphertext(error, stepFailurePrefix);
        if (Option.isNone(ciphertext)) return Effect.succeed(Option.none());
        if (ciphertext.value.length === 0) return Effect.fail(engineFailure());
        return open(`step:${identity}`, ciphertext.value).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(FailurePayload)),
          Effect.map(Option.some),
          Effect.mapError(engineFailure),
        );
      },
      sealWorkflowOutput: (value: unknown) =>
        seal(
          "final-output",
          value === undefined ? { kind: "undefined" } : { kind: "value", value },
        ),
      openWorkflowOutput: (value: unknown) =>
        open("final-output", value).pipe(
          Effect.flatMap((payload) =>
            Schema.decodeUnknownEffect(ValuePayload)(payload).pipe(
              Effect.map((decoded) => (decoded.kind === "undefined" ? undefined : decoded.value)),
              Effect.mapError(engineFailure),
            ),
          ),
        ),
      sealWorkflowFailure: (message: string, retryable: boolean) =>
        seal("final-failure", { message, retryable }).pipe(
          Effect.map((ciphertext) => `${workflowFailurePrefix}${Hex.encode(ciphertext)}`),
        ),
      openWorkflowFailure: (error: unknown) => {
        const ciphertext = failureCiphertext(error, workflowFailurePrefix);
        if (Option.isNone(ciphertext)) return Effect.succeed(Option.none());
        if (ciphertext.value.length === 0) return Effect.fail(engineFailure());
        return open("final-failure", ciphertext.value).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({ message: Schema.String, retryable: Schema.Boolean }),
            ),
          ),
          Effect.map(Option.some),
          Effect.mapError(engineFailure),
        );
      },
      stepIdentity,
      storedStepName: (name: string) =>
        stepIdentity(name).pipe(Effect.map(({ storedName }) => storedName)),
    };
  });

export type WorkflowResults = Effect.Success<ReturnType<typeof workflowResults>>;

/**
 * Cloudflare sees only ciphertext in its durable journal. The per-invocation sequence keeps
 * repeated step names separate while keeping their hashed journal names stable on replay.
 */
export const encryptedWorkflowTask = <A, R>(input: {
  readonly results: WorkflowResults;
  readonly name: string;
  readonly options?: {
    readonly retries?: {
      readonly limit: number;
      readonly delay: string | number;
      readonly backoff?: "constant" | "linear" | "exponential";
    };
    readonly timeout?: string | number;
  };
  readonly work: () => Effect.Effect<A, unknown, R>;
  readonly encodeFailure: (error: unknown) => string;
  readonly isRetryable: (error: unknown) => boolean;
  readonly restoreFailure: (payload: typeof FailurePayload.Type) => unknown;
}): Effect.Effect<A, unknown, R | Cloudflare.Workflows.WorkflowStep> =>
  input.results.withStep(
    input.name,
    Effect.gen(function* () {
      const step = yield* Cloudflare.Workflows.WorkflowStep;
      const { identity, storedName } = yield* input.results.stepIdentity(input.name);
      let lastCause: Cause.Cause<unknown> | undefined;
      const persisted = yield* Effect.exit(
        step.do({
          name: storedName,
          ...input.options,
          effect: Effect.suspend(() =>
            input.work().pipe(
              Effect.flatMap((value) =>
                input.results.sealStepValue(identity, value).pipe(Effect.orDie),
              ),
              Effect.catchCause((cause) => {
                if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
                lastCause = cause;
                const error = Cause.squash(cause);
                const retryable =
                  cause.reasons.length > 0 &&
                  cause.reasons.every(
                    (reason) => Cause.isFailReason(reason) && input.isRetryable(reason.error),
                  );
                const payload = {
                  message: input.encodeFailure(error),
                  retryable,
                  kind: retryable ? ("fail" as const) : ("die" as const),
                  ...(typeof error === "object" &&
                  error !== null &&
                  "failure" in error &&
                  typeof error.failure === "string"
                    ? { failure: error.failure }
                    : {}),
                };
                return input.results.sealStepFailure(identity, payload).pipe(
                  Effect.orDie,
                  Effect.flatMap((encrypted) =>
                    retryable
                      ? Effect.fail(new Error(encrypted))
                      : Effect.die(new Error(encrypted)),
                  ),
                );
              }),
            ),
          ),
        }),
      );

      if (Exit.isSuccess(persisted))
        return (yield* input.results.openStepValue(identity, persisted.value)) as A;
      if (Cause.hasInterrupts(persisted.cause)) return yield* Effect.failCause(persisted.cause);
      const failure = yield* input.results.openStepFailure(identity, Cause.squash(persisted.cause));
      if (Option.isNone(failure)) return yield* Effect.failCause(persisted.cause);
      if (lastCause !== undefined) return yield* Effect.failCause(lastCause);
      const restored = input.restoreFailure(failure.value);
      return yield* failure.value.kind === "fail" ? Effect.fail(restored) : Effect.die(restored);
    }),
  );

/** Encrypt the Workflow's terminal value or error before the engine records it. */
export const encryptedWorkflowResult = <A, R>(input: {
  readonly results: WorkflowResults;
  readonly work: Effect.Effect<A, unknown, R>;
  readonly encodeFailure: (error: unknown) => string;
  readonly isRetryable: (error: unknown) => boolean;
}): Effect.Effect<Uint8Array, never, R> =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(input.work);
    if (Exit.isSuccess(exit)) return yield* input.results.sealWorkflowOutput(exit.value);
    if (Cause.hasInterrupts(exit.cause)) return yield* Effect.failCause(exit.cause);
    const error = Cause.squash(exit.cause);
    const message = input.encodeFailure(error);
    const marker = yield* input.results.sealWorkflowFailure(message, input.isRetryable(error));
    return yield* Effect.die(new Error(marker));
  }).pipe(Effect.orDie);
