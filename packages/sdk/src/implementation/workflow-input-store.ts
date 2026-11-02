/** Persistence and encryption for durable questions; callers own authorization and transactions. */
import { Clock, Effect, Redacted, Schema } from "effect";
import {
  WorkflowFailure,
  WorkflowInput,
  WorkflowInputId,
  WorkflowInputRequest,
  WorkflowInputEvidence,
  ElicitationResponse,
  type WorkflowRunId,
} from "apps/contracts";
import { AppId, OwnerId, StorageError, JsonObject } from "../contracts/shared.ts";
import type { Credentials } from "../contracts/storage.ts";
import { query, type Query } from "./database.ts";
export type WorkflowInputRun = {
  readonly id: WorkflowRunId;
  readonly app: AppId;
  readonly owner: OwnerId;
  readonly actor: string | null;
  readonly name: string;
  readonly status: string;
  readonly createdAt: Date;
};
const Payload = Schema.Struct({
  name: Schema.String,
  request: WorkflowInputRequest,
  response: Schema.optionalKey(ElicitationResponse),
  evidence: Schema.optionalKey(WorkflowInputEvidence),
});
const notFound = () => new WorkflowFailure({ reason: "not_found", retryable: false });
const active = (run: WorkflowInputRun) => run.status === "running" || run.status === "queued";
export const makeWorkflowInputStore = (options: {
  readonly db: Query;
  readonly credentials: Credentials;
  readonly readRun: (
    run: WorkflowRunId,
  ) => Effect.Effect<WorkflowInputRun, WorkflowFailure | StorageError>;
  readonly reviewUrl?: (input: {
    readonly owner: OwnerId;
    readonly app: AppId;
    readonly id: WorkflowInputId;
  }) => string;
}) => {
  const { db, credentials } = options;
  const find = (id: WorkflowInputId) =>
    query(() =>
      db.findFirst("workflowInputs", {
        where: (b) => b("id", "=", id),
      }),
    );
  type Row = NonNullable<Effect.Success<ReturnType<typeof find>>>;
  const payload = (row: Row) =>
    credentials.decrypt(WorkflowInputId.make(row.id), Redacted.make(row.encrypted)).pipe(
      Effect.flatMap((value) => Schema.decodeUnknownEffect(Payload)(Redacted.value(value))),
      Effect.mapError(() => new StorageError()),
    );
  const seal = (id: WorkflowInputId, value: typeof Payload.Type) =>
    Schema.encodeEffect(Schema.toCodecJson(Payload))(value).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(JsonObject)),
      Effect.mapError(() => new StorageError()),
      Effect.flatMap((value) => credentials.encrypt(id, Redacted.make(value))),
    );
  const view = (row: Row, run: WorkflowInputRun) =>
    Effect.gen(function* () {
      const data = yield* payload(row);
      return WorkflowInput.make({
        id: WorkflowInputId.make(row.id),
        app: row.app,
        run: row.run,
        workflow: run.name,
        name: data.name,
        status: Schema.decodeUnknownSync(WorkflowInput.fields.status)(row.status),
        expiresAt: row.expiresAt.getTime(),
        form: data.request.form,
        evidence: data.evidence ?? data.request.evidence ?? [],
        links: data.request.links ?? [],
        ...(data.response === undefined ? {} : { response: data.response }),
        ...(options.reviewUrl === undefined
          ? {}
          : {
              reviewUrl: options.reviewUrl({
                owner: row.owner,
                app: row.app,
                id: WorkflowInputId.make(row.id),
              }),
            }),
      });
    });
  /** The parent lock serializes question creation/answers with run completion and termination. */
  const lock = (run: WorkflowRunId) =>
    Effect.gen(function* () {
      const before = yield* options.readRun(run);
      yield* query(() =>
        db.updateMany("workflowRuns", {
          where: (b) => b("id", "=", run),
          set: { createdAt: before.createdAt },
        }),
      );
      return yield* options.readRun(run);
    });
  const settle = (row: Row, run: WorkflowInputRun) =>
    Effect.gen(function* () {
      if (row.status !== "pending") return row;
      const now = yield* Clock.currentTimeMillis;
      const status = !active(run)
        ? "withdrawn"
        : now >= row.expiresAt.getTime()
          ? "expired"
          : undefined;
      if (status === undefined) return row;
      yield* query(() =>
        db.updateMany("workflowInputs", {
          where: (b) => b.and(b("id", "=", row.id), b("status", "=", "pending")),
          set: { status, wakePending: active(run) },
        }),
      );
      return { ...row, status, wakePending: active(run) };
    });
  const bound = (run: WorkflowInputRun, id: WorkflowInputId) =>
    Effect.gen(function* () {
      const row = yield* find(id);
      if (row === null || row.run !== run.id || row.app !== run.app || row.owner !== run.owner)
        return yield* notFound();
      return yield* settle(row, run);
    });
  return { find, payload, seal, view, lock, bound, settle };
};
