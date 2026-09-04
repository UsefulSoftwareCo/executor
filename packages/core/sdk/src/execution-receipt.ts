import { Effect, Schema } from "effect";

import { sha256Hex, type BlobStore } from "./blob";
import { StorageError } from "./fuma-runtime";

export const ExecutionId = Schema.String.check(
  Schema.isLengthBetween(6, 133),
  Schema.isPattern(/^exec_[A-Za-z0-9_-]+$/),
);
export type ExecutionId = typeof ExecutionId.Type;

export const ExecutionIdempotencyKey = Schema.String.check(Schema.isLengthBetween(1, 200));
export type ExecutionIdempotencyKey = typeof ExecutionIdempotencyKey.Type;

const Sha256 = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/));
export const ExecutionPauseSequence = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);

const ExecutionBase = {
  executionId: ExecutionId,
  idempotencyKey: ExecutionIdempotencyKey,
  requestHash: Sha256,
  startedAt: Schema.Number,
};

export const RunningExecution = Schema.Struct({
  ...ExecutionBase,
  status: Schema.Literal("running"),
});
export type RunningExecution = typeof RunningExecution.Type;

export const PausedExecutionReceipt = Schema.Struct({
  ...ExecutionBase,
  status: Schema.Literal("paused"),
  text: Schema.String,
  structured: Schema.Unknown,
  pauseSequence: ExecutionPauseSequence,
});
export type PausedExecutionReceipt = typeof PausedExecutionReceipt.Type;

export const CompletedExecutionReceipt = Schema.Struct({
  ...ExecutionBase,
  status: Schema.Literal("completed"),
  text: Schema.String,
  structured: Schema.Unknown,
  isError: Schema.Boolean,
  resultHash: Sha256,
  completedAt: Schema.Number,
});
export type CompletedExecutionReceipt = typeof CompletedExecutionReceipt.Type;

export const ExecutionReceipt = Schema.Union([PausedExecutionReceipt, CompletedExecutionReceipt]);
export type ExecutionReceipt = typeof ExecutionReceipt.Type;

export const StoredExecution = Schema.Union([
  RunningExecution,
  PausedExecutionReceipt,
  CompletedExecutionReceipt,
]);
export type StoredExecution = typeof StoredExecution.Type;

const ResumeReservationBase = {
  executionId: ExecutionId,
  pauseSequence: ExecutionPauseSequence,
  idempotencyKey: ExecutionIdempotencyKey,
  requestHash: Sha256,
  startedAt: Schema.Number,
};

export const RunningResumeReservation = Schema.Struct({
  ...ResumeReservationBase,
  status: Schema.Literal("running"),
});
export type RunningResumeReservation = typeof RunningResumeReservation.Type;

export const SettledResumeReservation = Schema.Struct({
  ...ResumeReservationBase,
  status: Schema.Literal("settled"),
  response: ExecutionReceipt,
  completedAt: Schema.Number,
});
export type SettledResumeReservation = typeof SettledResumeReservation.Type;

export const ResumeReservation = Schema.Union([RunningResumeReservation, SettledResumeReservation]);
export type ResumeReservation = typeof ResumeReservation.Type;

const encodeExecution = Schema.encodeUnknownEffect(Schema.fromJsonString(StoredExecution));
const decodeExecution = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredExecution));
const encodeResume = Schema.encodeUnknownEffect(Schema.fromJsonString(ResumeReservation));
const decodeResume = Schema.decodeUnknownEffect(Schema.fromJsonString(ResumeReservation));

const invalidStoredReceipt = (cause: unknown): StorageError =>
  new StorageError({ message: "Stored execution receipt is invalid", cause });

const executionKeyFor = (partition: string, idempotencyKey: string) =>
  sha256Hex(`${partition}\u0000${idempotencyKey}`).pipe(
    Effect.map((hash) => ExecutionId.make(`exec_${hash}`)),
  );

export interface ExecutionReceiptStore {
  readonly reserve: (input: {
    readonly idempotencyKey: ExecutionIdempotencyKey;
    readonly requestHash: string;
    readonly startedAt: number;
  }) => Effect.Effect<
    | { readonly created: true; readonly execution: RunningExecution }
    | { readonly created: false; readonly execution: StoredExecution },
    StorageError
  >;
  readonly get: (executionId: ExecutionId) => Effect.Effect<StoredExecution | null, StorageError>;
  readonly put: (execution: StoredExecution) => Effect.Effect<void, StorageError>;
  readonly reserveResume: (input: RunningResumeReservation) => Effect.Effect<
    {
      readonly created: boolean;
      readonly reservation: ResumeReservation;
    },
    StorageError
  >;
  readonly getResume: (
    executionId: ExecutionId,
    pauseSequence: number,
  ) => Effect.Effect<ResumeReservation | null, StorageError>;
  readonly settleResume: (
    reservation: SettledResumeReservation,
  ) => Effect.Effect<void, StorageError>;
  readonly discardResume: (
    executionId: ExecutionId,
    pauseSequence: number,
  ) => Effect.Effect<void, StorageError>;
}

export const makeExecutionReceiptStore = (
  blobs: BlobStore,
  partition: string,
): ExecutionReceiptStore => {
  const executionNamespace = `${partition}/@execution`;
  const resumeNamespace = `${partition}/@execution-resume`;

  const readExecution = (executionId: ExecutionId) =>
    Effect.gen(function* () {
      const raw = yield* blobs.get(executionNamespace, executionId);
      if (raw === null) return null;
      return yield* decodeExecution(raw).pipe(Effect.mapError(invalidStoredReceipt));
    });

  const readResume = (executionId: ExecutionId, pauseSequence: number) =>
    Effect.gen(function* () {
      const raw = yield* blobs.get(resumeNamespace, `${executionId}:${pauseSequence}`);
      if (raw === null) return null;
      return yield* decodeResume(raw).pipe(Effect.mapError(invalidStoredReceipt));
    });

  return {
    reserve: (input) =>
      Effect.gen(function* () {
        const executionId = yield* executionKeyFor(partition, input.idempotencyKey);
        const candidate = RunningExecution.make({
          ...input,
          executionId,
          status: "running",
        });
        const encoded = yield* encodeExecution(candidate).pipe(
          Effect.mapError(invalidStoredReceipt),
        );
        const created = yield* blobs.putIfAbsent(executionNamespace, executionId, encoded);
        if (created) return { created: true as const, execution: candidate };
        const existing = yield* readExecution(executionId);
        if (existing === null) {
          return yield* new StorageError({
            message: "Execution reservation disappeared after creation conflict",
            cause: undefined,
          });
        }
        return { created: false as const, execution: existing };
      }),
    get: readExecution,
    put: (execution) =>
      Effect.gen(function* () {
        const existing = yield* readExecution(execution.executionId);
        if (existing?.status === "completed") return;
        const encoded = yield* encodeExecution(execution).pipe(
          Effect.mapError(invalidStoredReceipt),
        );
        yield* blobs.put(executionNamespace, execution.executionId, encoded);
      }),
    reserveResume: (input) =>
      Effect.gen(function* () {
        const key = `${input.executionId}:${input.pauseSequence}`;
        const encoded = yield* encodeResume(input).pipe(Effect.mapError(invalidStoredReceipt));
        const created = yield* blobs.putIfAbsent(resumeNamespace, key, encoded);
        if (created) return { created, reservation: input };
        const existing = yield* readResume(input.executionId, input.pauseSequence);
        if (existing === null) {
          return yield* new StorageError({
            message: "Resume reservation disappeared after creation conflict",
            cause: undefined,
          });
        }
        return { created, reservation: existing };
      }),
    getResume: readResume,
    settleResume: (reservation) =>
      encodeResume(reservation).pipe(
        Effect.mapError(invalidStoredReceipt),
        Effect.flatMap((encoded) =>
          blobs.put(
            resumeNamespace,
            `${reservation.executionId}:${reservation.pauseSequence}`,
            encoded,
          ),
        ),
      ),
    discardResume: (executionId, pauseSequence) =>
      blobs.delete(resumeNamespace, `${executionId}:${pauseSequence}`),
  };
};
