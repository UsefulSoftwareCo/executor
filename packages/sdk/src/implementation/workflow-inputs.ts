import { makeWorkflowInputStore, type WorkflowInputRun } from "./workflow-input-store.ts";
/** Encrypted questions, one winning answer and durable wake receipts. Product access stays outside. */
import { Clock, Effect, Schema } from "effect";
import { prepareElicitation } from "apps/host";
import {
  WorkflowFailure,
  WorkflowInputId,
  type WorkflowInputCommand,
  type WorkflowRunId,
} from "apps/contracts";
import { CurrentActor } from "../contracts/executor.ts";
import { AppId, OwnerId, StorageError, RequestInvalid } from "../contracts/shared.ts";
import type { Credentials } from "../contracts/storage.ts";
import type { UpdateWorkflowInputEvidence } from "../contracts/workflow-inputs.ts";
import type { WorkflowRuntime } from "../contracts/workflow-runtime.ts";
import { query, transaction, type Query } from "./database.ts";

type Run = WorkflowInputRun;
const notFound = () => new WorkflowFailure({ reason: "not_found", retryable: false });
const inputFailure = () => new WorkflowFailure({ reason: "input", retryable: false });
const active = (run: Run) => run.status === "running" || run.status === "queued";

export const makeWorkflowInputs = (options: {
  readonly db: Query;
  readonly credentials: Credentials;
  readonly backend?: WorkflowRuntime;
  readonly readRun: (run: WorkflowRunId) => Effect.Effect<Run, WorkflowFailure | StorageError>;
  readonly authorize: (run: WorkflowRunId) => Effect.Effect<void, WorkflowFailure>;
  readonly reviewUrl?: (input: {
    readonly owner: OwnerId;
    readonly app: AppId;
    readonly id: WorkflowInputId;
  }) => string;
}) => {
  const { db } = options;
  const { find, payload, seal, view, lock, bound, settle } = makeWorkflowInputStore(options);
  type Row = NonNullable<Effect.Success<ReturnType<typeof find>>>;
  /** Event submission can repeat after a lost receipt. Its payload never contains an answer. */
  const wake = (row: Row) =>
    Effect.gen(function* () {
      if (!row.wakePending || options.backend?.signalInput === undefined) return;
      const run = yield* options.readRun(row.run);
      if (active(run)) yield* options.backend.signalInput(row.run, row.id);
      yield* query(() =>
        db.updateMany("workflowInputs", {
          where: (b) => b.and(b("id", "=", row.id), b("status", "=", row.status)),
          set: { wakePending: false },
        }),
      );
    });
  const deferredWake = (row: Row) => wake(row).pipe(Effect.catch(() => Effect.void));

  const command = (runId: WorkflowRunId, command: WorkflowInputCommand) =>
    Effect.gen(function* () {
      yield* options.authorize(runId);
      return yield* transaction(db, () =>
        Effect.gen(function* () {
          const run = yield* lock(runId);
          if (command.operation === "get") return yield* view(yield* bound(run, command.id), run);
          if (!active(run) || run.actor === null || options.backend?.signalInput === undefined)
            return yield* new WorkflowFailure({ reason: "unavailable", retryable: false });
          const id = yield* Schema.decodeUnknownEffect(WorkflowInputId)(
            `wfi_${command.stepId}`,
          ).pipe(Effect.mapError(inputFailure));
          const form = yield* prepareElicitation(command.request.form).pipe(
            Effect.mapError(inputFailure),
          );
          const request = { ...command.request, form: form.request };
          if (new TextEncoder().encode(JSON.stringify(request)).byteLength > 65536)
            return yield* inputFailure();
          const prior = yield* find(id);
          if (prior !== null) {
            const saved = yield* payload(prior);
            if (
              prior.run !== runId ||
              saved.name !== command.name ||
              JSON.stringify(saved.request) !== JSON.stringify(request)
            )
              return yield* new WorkflowFailure({ reason: "conflict", retryable: false });
            return yield* view(yield* settle(prior, run), run);
          }
          const now = yield* Clock.currentTimeMillis;
          const encrypted = yield* seal(id, { name: command.name, request });
          const row = {
            id,
            app: run.app,
            run: run.id,
            owner: run.owner,
            actor: run.actor,
            status: "pending",
            expiresAt: new Date(now + request.timeoutMs),
            wakePending: false,
            answeredBy: null,
            encrypted,
            createdAt: new Date(now),
          };
          yield* query(() => db.create("workflowInputs", row));
          return yield* view(row, run);
        }),
      );
    });
  const owned = (input: {
    readonly app: AppId;
    readonly id: WorkflowInputId;
    readonly owner?: OwnerId | undefined;
  }) =>
    Effect.gen(function* () {
      const row = yield* find(input.id);
      if (
        row === null ||
        row.app !== input.app ||
        (input.owner !== undefined && row.owner !== input.owner) ||
        row.actor !== (yield* CurrentActor)
      )
        return yield* notFound();
      yield* options.authorize(row.run);
      return row;
    });
  const get = (input: Parameters<typeof owned>[0]) =>
    Effect.gen(function* () {
      const row = yield* owned(input);
      return yield* transaction(db, () =>
        Effect.gen(function* () {
          const run = yield* lock(row.run);
          return yield* view(yield* bound(run, input.id), run);
        }),
      );
    });
  const answer = (input: Parameters<typeof owned>[0] & { readonly response: unknown }) =>
    Effect.gen(function* () {
      const row = yield* owned(input);
      const updated = yield* transaction(db, () =>
        Effect.gen(function* () {
          const run = yield* lock(row.run);
          const current = yield* bound(run, input.id);
          if (current.status !== "pending") return current;
          const saved = yield* payload(current);
          const form = yield* prepareElicitation(saved.request.form).pipe(
            Effect.mapError(inputFailure),
          );
          const response = yield* form.respond(input.response).pipe(Effect.mapError(inputFailure));
          const encrypted = yield* seal(WorkflowInputId.make(current.id), { ...saved, response });
          yield* query(() =>
            db.updateMany("workflowInputs", {
              where: (b) => b.and(b("id", "=", current.id), b("status", "=", "pending")),
              set: { status: "answered", encrypted, answeredBy: row.actor, wakePending: true },
            }),
          );
          return {
            ...current,
            status: "answered",
            encrypted,
            answeredBy: row.actor,
            wakePending: true,
          };
        }),
      );
      yield* deferredWake(updated);
      return yield* view(updated, yield* options.readRun(row.run));
    }).pipe(
      Effect.catchIf(
        (error) => error instanceof WorkflowFailure && error.reason === "input",
        () => Effect.fail(new RequestInvalid()),
      ),
    );
  const updateEvidence = (input: typeof UpdateWorkflowInputEvidence.Type) =>
    Effect.gen(function* () {
      const row = yield* owned(input);
      return yield* transaction(db, () =>
        Effect.gen(function* () {
          const run = yield* lock(row.run);
          const current = yield* bound(run, input.id);
          if (current.status !== "pending") return yield* view(current, run);
          const saved = yield* payload(current);
          const encrypted = yield* seal(input.id, { ...saved, evidence: input.evidence });
          yield* query(() =>
            db.updateMany("workflowInputs", {
              where: (b) => b.and(b("id", "=", current.id), b("status", "=", "pending")),
              set: { encrypted },
            }),
          );
          return yield* view({ ...current, encrypted }, run);
        }),
      );
    });
  const withdraw = (input: Parameters<typeof owned>[0]) =>
    Effect.gen(function* () {
      const row = yield* owned(input);
      const updated = yield* transaction(db, () =>
        Effect.gen(function* () {
          const run = yield* lock(row.run);
          const current = yield* bound(run, input.id);
          if (current.status !== "pending") return current;
          yield* query(() =>
            db.updateMany("workflowInputs", {
              where: (b) => b.and(b("id", "=", current.id), b("status", "=", "pending")),
              set: { status: "withdrawn", wakePending: true },
            }),
          );
          return { ...current, status: "withdrawn", wakePending: true };
        }),
      );
      yield* deferredWake(updated);
      return yield* view(updated, yield* options.readRun(row.run));
    });
  const list = (
    input: {
      readonly owner?: OwnerId | undefined;
      readonly app?: AppId | undefined;
      readonly pending?: boolean | undefined;
      readonly after?: WorkflowInputId | undefined;
    } = {},
  ) =>
    Effect.gen(function* () {
      const actor = yield* CurrentActor;
      if (actor === undefined) return { items: [] };
      const rows = yield* query(() =>
        db.findMany("workflowInputs", {
          where: (b) =>
            b.and(
              b("actor", "=", actor),
              ...(input.owner === undefined ? [] : [b("owner", "=", input.owner)]),
              ...(input.app === undefined ? [] : [b("app", "=", input.app)]),
              ...(input.pending ? [b("status", "=", "pending")] : []),
              ...(input.after === undefined ? [] : [b("id", ">", input.after)]),
            ),
          orderBy: ["id", "asc"],
          limit: 101,
        }),
      );
      const page = rows.slice(0, 100);
      const items = yield* Effect.forEach(page, (row) =>
        get({
          app: row.app,
          id: WorkflowInputId.make(row.id),
          ...(input.owner === undefined ? {} : { owner: input.owner }),
        }).pipe(
          Effect.map((value) => ({ _tag: "Some" as const, value })),
          Effect.catchIf(
            (error) =>
              error instanceof WorkflowFailure &&
              ["not_found", "credentials"].includes(error.reason),
            () => Effect.succeed({ _tag: "None" as const }),
          ),
        ),
      );
      const last = page.at(-1);
      return {
        items: items.flatMap((item) =>
          item._tag === "Some" && (!input.pending || item.value.status === "pending")
            ? [item.value]
            : [],
        ),
        ...(rows.length > 100 && last !== undefined ? { next: WorkflowInputId.make(last.id) } : {}),
      };
    });
  const close = (run: WorkflowRunId) =>
    query(() =>
      db.updateMany("workflowInputs", {
        where: (b) => b.and(b("run", "=", run), b("status", "=", "pending")),
        set: { status: "withdrawn", wakePending: false },
      }),
    ).pipe(Effect.asVoid);
  const reconcile = Effect.gen(function* () {
    let after: string | undefined;
    while (true) {
      const cursor = after;
      const rows = yield* query(() =>
        db.findMany("workflowInputs", {
          where: (b) =>
            b.and(
              b("wakePending", "=", true),
              ...(cursor === undefined ? [] : [b("id", ">", cursor)]),
            ),
          orderBy: ["id", "asc"],
          limit: 100,
        }),
      );
      yield* Effect.forEach(rows, deferredWake, { concurrency: 4, discard: true });
      if (rows.length < 100) return;
      after = rows.at(-1)?.id;
    }
  });
  return { command, get, answer, updateEvidence, withdraw, list, close, reconcile };
};
