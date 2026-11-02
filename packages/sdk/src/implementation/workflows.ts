import { makeWorkflowInputs } from "./workflow-inputs.ts";
import { CurrentActor } from "../contracts/executor.ts";
/** Retained run identities pin code/accounts; the backend owns timers and checkpoint execution. */
import { Cause, Clock, Effect, Exit, Redacted, Result, Schema, type Crypto } from "effect";
import { Hex } from "effect/encoding";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import {
  HostedWorkflow,
  WorkflowFailure,
  WorkflowRun,
  WorkflowRunId,
  WorkflowRunFailure,
  WorkflowRunPage,
  WorkflowValue,
  maxFailureMessageLength,
  type WorkflowHostControls,
} from "apps/contracts";
import { workflowFailureDetail } from "../contracts/workflow-errors.ts";
import { WorkflowHost, type WorkflowRuntime } from "../contracts/workflow-runtime.ts";
import {
  StartWorkflow,
  ListWorkflowRuns,
  WorkflowTarget,
  WorkflowApp,
} from "../contracts/workflows.ts";
import { AccountScope, SelectedAccounts } from "../contracts/apps.ts";
import { AppId, VersionId, OwnerId, StorageError, type Json } from "../contracts/shared.ts";
import type { Credentials } from "../contracts/storage.ts";
import type { Runtime } from "../contracts/runtime.ts";
import type { ExecutorDatabase } from "./storage.ts";
import type { Executor } from "../contracts/executor.ts";
import type { makeOAuth } from "./oauth.ts";
import { database, query, transaction } from "./database.ts";
import { storedAccount } from "./accounts.ts";
import { storedApp, storedVersion } from "./apps.ts";
import { resolve, snapshot, type InvocationSnapshot } from "./tools.ts";
import { invocationScope, scopedSelection } from "./selection.ts";
import type { Declarations } from "./declarations.ts";
import { ownsDatabase } from "../contracts/apps.ts";

const StoredRun = Schema.Struct({
  id: WorkflowRunId,
  app: AppId,
  /** The subject the run started for; its steps are checked against this subject's access. */
  actor: Schema.NullOr(Schema.NonEmptyString),
  /** Whether the run started with a caller; its steps bind `ctx.user` only when it did. */
  scope: AccountScope,
  owner: OwnerId,
  key: Schema.String,
  version: VersionId,
  name: Schema.String,
  accounts: SelectedAccounts,
  status: Schema.Literals(["queued", "running", "complete", "errored", "terminated"]),
  failure: Schema.NullOr(WorkflowFailure.fields.reason),
  encrypted: Schema.RedactedFromValue(Schema.Uint8Array),
  createdAt: Schema.Date,
})
  // Storage keeps the column's former name.
  .pipe(Schema.encodeKeys({ version: "deployment" }));
const Payload = Schema.Struct({
  input: WorkflowValue,
  request: WorkflowValue,
  output: Schema.optionalKey(WorkflowValue),
  /** The failing step and app error; encrypted with the run's other authored values. */
  failure: Schema.optionalKey(WorkflowRunFailure),
});
const terminal = (row: typeof StoredRun.Type) =>
  row.status === "complete" || row.status === "errored" || row.status === "terminated";
const unavailable = () => new WorkflowFailure({ reason: "unavailable", retryable: false });
const failure = (reason: WorkflowFailure["reason"], retryable = false) =>
  new WorkflowFailure({ reason, retryable });
/** Only the caller's own key finds a start's run again; a start without one makes a new run. */
const repeatStart = (key: string | undefined) =>
  key === undefined
    ? "This start had no key, so starting again creates another run."
    : "Starting again with the same key and input returns this run.";
/** A start whose run is saved, but whose state Executor could not read back. */
const unconfirmedStart = (run: string, key: string | undefined) =>
  new WorkflowFailure({
    reason: "engine",
    retryable: false,
    message: `Run ${run} exists for this start, but Executor could not read it back, so its state is unknown. Get the run by its ID before starting another. ${repeatStart(key)}`,
  });
/** A start whose save may have committed, which Executor could not read back to confirm. */
const unknownStart = (key: string | undefined) =>
  new WorkflowFailure({
    reason: "engine",
    retryable: false,
    message:
      key === undefined
        ? "Executor could not confirm whether this start saved its run, so the run may exist. This start had no key: check ctx.workflows.list before starting again, because another start creates another run."
        : "Executor could not confirm whether this start saved its run, so the run may exist. Starting again with the same key and input returns the run if it was saved.",
  });
const stable = (value: Json): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const safe = <A>(
  work: Effect.Effect<A, unknown>,
  reason: WorkflowFailure["reason"],
  retryable = false,
): Effect.Effect<A, WorkflowFailure> =>
  work.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.interrupt;
      const error = Cause.squash(cause);
      return Effect.fail(Schema.is(WorkflowFailure)(error) ? error : failure(reason, retryable));
    }),
  );

/**
 * Hand a committed queued run to the native engine. The run row is already durable, so a transient
 * engine failure leaves it queued for the next status read or the reconciliation job to dispatch,
 * and the caller still receives the run it created. Reports whether the engine accepted it.
 */
const dispatch = (backend: WorkflowRuntime, run: WorkflowRunId) =>
  backend.start(run).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => error.reason === "engine" && error.retryable,
      () =>
        Effect.annotateCurrentSpan("executor.workflow.dispatch", "deferred").pipe(
          Effect.andThen(
            Effect.logWarning("Workflow dispatch deferred to reconciliation", { run }),
          ),
          Effect.as(false),
        ),
    ),
  );

/** Compose lifecycle operations and private execution callbacks without acquiring resources. */
export const makeWorkflowRuns = (
  storage: ExecutorDatabase,
  runtime: Runtime,
  resolveAccount: ReturnType<typeof makeOAuth>["resolveSelected"],
  credentials: Credentials,
  crypto: Crypto.Crypto,
  declarations: Declarations,
  backend?: WorkflowRuntime,
  reviewUrl?: import("../contracts/executor.ts").ExecutorInputs["workflowInputUrl"],
) => {
  const db = database(storage);
  const read = (run: WorkflowRunId, app?: AppId) =>
    Effect.gen(function* () {
      const row = yield* query(() =>
        db.findFirst("workflowRuns", {
          where: (b) =>
            app === undefined ? b("id", "=", run) : b.and(b("id", "=", run), b("app", "=", app)),
        }),
      );
      if (row === null) return yield* failure("not_found");
      return yield* Schema.decodeUnknownEffect(StoredRun)(row).pipe(
        Effect.mapError(() => new StorageError()),
      );
    });
  const decrypt = (row: typeof StoredRun.Type) =>
    credentials.decrypt(row.id, row.encrypted).pipe(
      Effect.flatMap((value) => Schema.decodeUnknownEffect(Payload)(Redacted.value(value))),
      Effect.mapError(() => failure("engine")),
    );
  const view = (row: typeof StoredRun.Type) =>
    Effect.gen(function* () {
      const payload = yield* decrypt(row);
      return yield* Schema.decodeUnknownEffect(WorkflowRun)({
        id: row.id,
        app: row.app,
        version: row.version,
        workflow: row.name,
        createdAt: row.createdAt.toISOString(),
        status: row.status,
        ...(row.status === "complete" ? { output: payload.output } : {}),
        ...(row.status === "errored"
          ? {
              error: row.failure,
              ...(payload.failure === undefined ? {} : { failure: payload.failure }),
            }
          : {}),
      }).pipe(Effect.mapError(() => failure("engine")));
    });
  const finish: WorkflowHost["finish"] = (run, result) =>
    safe(
      transaction(db, () =>
        Effect.gen(function* () {
          const row = yield* read(run);
          if (terminal(row)) return;
          const payload = yield* decrypt(row);
          const encrypted = yield* credentials.encrypt(
            row.id,
            Redacted.make({
              input: payload.input,
              request: payload.request,
              ...(result.ok ? { output: result.output } : {}),
              ...(!result.ok && result.detail !== undefined ? { failure: result.detail } : {}),
            }),
          );
          yield* query(() =>
            db.updateMany("workflowRuns", {
              where: (b) =>
                b.and(
                  b("id", "=", run),
                  b.or(b("status", "=", "queued"), b("status", "=", "running")),
                ),
              set: {
                status: result.ok ? "complete" : "errored",
                failure: result.ok ? null : result.error,
                encrypted,
              },
            }),
          );
          yield* inputs.close(run);
          yield* query(() =>
            db.deleteMany("workflowAccounts", { where: (b) => b("run", "=", run) }),
          );
        }),
      ),
      "engine",
      true,
    );
  /** The run's captured version, scope and accounts, checked against the actor it started for. */
  const captured = (row: typeof StoredRun.Type) =>
    snapshot(db, {
      app: row.app,
      version: row.version,
      captured: { accounts: row.accounts, scope: row.scope },
    }).pipe(Effect.provideService(CurrentActor, row.actor ?? undefined));
  const context: WorkflowHost["context"] = (run) =>
    safe(
      Effect.gen(function* () {
        const row = yield* read(run);
        if (terminal(row))
          return yield* failure(row.status === "terminated" ? "terminated" : "conflict");
        const state = yield* captured(row);
        return {
          ...(yield* resolve(state, resolveAccount).pipe(
            Effect.provideService(CurrentActor, state.actor),
          )),
          hostApi: declarations.hostApi(state.version),
          database: ownsDatabase(state.version.requirements),
          workflowControls: controls(state),
        };
      }),
      "credentials",
    );
  const seed: WorkflowHost["seed"] = (run) =>
    safe(
      Effect.gen(function* () {
        const row = yield* read(run);
        if (row.status === "terminated" || row.status === "errored")
          return yield* failure(row.status === "terminated" ? "terminated" : "conflict");
        const state = yield* captured(row);
        const payload = yield* decrypt(row);
        if (row.status === "queued")
          yield* query(() =>
            db.updateMany("workflowRuns", {
              where: (b) => b.and(b("id", "=", run), b("status", "=", "queued")),
              set: { status: "running" },
            }),
          );
        const hostApi = declarations.hostApi(state.version);
        return {
          runId: run,
          app: row.app,
          build: state.version.build,
          ...(hostApi === undefined ? {} : { hostApi }),
          version: row.version,
          name: row.name,
          input: payload.input,
        };
      }),
      "engine",
      true,
    );
  const invoke: WorkflowHost["invoke"] = (run, input) =>
    safe(
      Effect.gen(function* () {
        const deadline = (yield* Clock.currentTimeMillis) + input.timeout;
        const current = yield* seed(run);
        const bound = yield* context(run);
        const result = yield* runtime
          .call({
            app: current.app,
            build: current.build,
            ...bound,
            deadline,
            tool: input.name,
            kind: input.kind,
            input: input.input,
            ...(input.kind === "mutation"
              ? {
                  replay: {
                    key: input.stepId,
                    fingerprint: Hex.encode(
                      yield* crypto.digest(
                        "SHA-256",
                        new TextEncoder().encode(
                          stable({
                            version: current.version,
                            name: input.name,
                            input: input.input,
                          }),
                        ),
                      ),
                    ),
                  },
                }
              : {}),
          })
          .pipe(
            Effect.catchTags({
              HostToolApprovalRequired: () => Effect.fail(failure("approval")),
              HostToolBlocked: () => Effect.fail(failure("approval")),
              HostInputInvalid: () => Effect.fail(failure("input")),
              HostToolNotFound: () => Effect.fail(failure("operation")),
              HostKindMismatch: () => Effect.fail(failure("operation")),
              HostOperationFailed: ({ errorName, message }) =>
                Effect.fail(
                  new WorkflowFailure({
                    reason: "execution",
                    retryable: true,
                    ...(errorName === undefined ? {} : { errorName }),
                    ...(message.length === 0 ? {} : { message }),
                  }),
                ),
              // The same step exceeds the same budget again, so retrying it cannot succeed.
              DatabaseLimitExceeded: (error) =>
                Effect.fail(
                  new WorkflowFailure({
                    reason: "execution",
                    retryable: false,
                    errorName: error._tag,
                    message: error.message,
                  }),
                ),
            }),
          );
        return yield* Schema.decodeUnknownEffect(WorkflowValue)(result).pipe(
          Effect.mapError(() => failure("output")),
        );
      }),
      "execution",
      true,
    );
  const inputs = makeWorkflowInputs({
    db,
    credentials,
    readRun: read,
    authorize: (run) =>
      safe(read(run).pipe(Effect.flatMap(captured), Effect.asVoid), "credentials"),
    ...(backend === undefined ? {} : { backend }),
    ...(reviewUrl === undefined ? {} : { reviewUrl }),
  });
  const input: WorkflowHost["input"] = (run, command) =>
    safe(inputs.command(run, command), "execution");
  const execute: WorkflowHost["execute"] = (run, driver) =>
    Effect.gen(function* () {
      const existing = yield* safe(read(run), "engine", true);
      if (existing.status === "complete") {
        const result = yield* decrypt(existing);
        return yield* Schema.decodeUnknownEffect(WorkflowValue)(result.output).pipe(
          Effect.mapError(() => failure("engine")),
        );
      }
      const result = yield* safe(
        Effect.gen(function* () {
          const current = yield* seed(run);
          yield* Effect.annotateCurrentSpan({
            "executor.app.id": current.app,
            "executor.build.id": current.build,
            "executor.workflow.name": current.name,
          });
          const bound = yield* context(run);
          return yield* runtime.workflow({
            app: current.app,
            build: current.build,
            ...bound,
            command: { operation: "workflow-run", name: current.name, input: current.input },
            workflow: {
              runId: run,
              driver,
              resolve: () => context(run),
              invoke: (input) => invoke(run, input),
              input: (command) => input(run, command),
            },
          });
        }),
        "execution",
      ).pipe(Effect.result);
      if (Result.isFailure(result)) {
        if (result.failure.reason === "engine" && result.failure.retryable)
          return yield* result.failure;
        const detail = workflowFailureDetail(result.failure);
        yield* finish(run, {
          ok: false,
          error: result.failure.reason,
          ...(detail === undefined ? {} : { detail }),
        });
        return yield* result.failure;
      }
      yield* finish(run, { ok: true, output: result.success });
      return result.success;
    }).pipe(Effect.withSpan("workflow.run", { attributes: { "executor.run.id": run } }));
  const reconcile = (row: typeof StoredRun.Type) =>
    Effect.gen(function* () {
      if (terminal(row)) return yield* view(row);
      if (backend === undefined) return yield* unavailable();
      let state = yield* backend.status(row.id);
      if (row.status === "queued" && state.status === "missing") {
        // The durable enqueue can commit before caller cancellation interrupts
        // native dispatch. A status read reconciles that gap without waiting for cron.
        const current = yield* read(row.id);
        if (terminal(current)) return yield* view(current);
        if (current.status === "queued" && !(yield* dispatch(backend, row.id)))
          return yield* view(current);
        state = yield* backend.status(row.id);
      }
      if (state.status === "complete") {
        yield* finish(row.id, { ok: true, output: state.output });
        return yield* view(yield* read(row.id));
      }
      if (state.status === "errored" || (state.status === "missing" && row.status !== "queued")) {
        yield* finish(row.id, { ok: false, error: "engine" });
        return yield* view(yield* read(row.id));
      }
      if (state.status === "terminated") {
        yield* transaction(db, () =>
          Effect.gen(function* () {
            yield* query(() =>
              db.updateMany("workflowRuns", {
                where: (b) =>
                  b.and(
                    b("id", "=", row.id),
                    b.or(b("status", "=", "queued"), b("status", "=", "running")),
                  ),
                set: { status: "terminated" },
              }),
            );
            yield* query(() =>
              db.deleteMany("workflowAccounts", { where: (b) => b("run", "=", row.id) }),
            );
          }),
        );
        return yield* view(yield* read(row.id));
      }
      const current = yield* view(row);
      return yield* Schema.decodeUnknownEffect(WorkflowRun)({
        ...current,
        status: state.status === "missing" ? "queued" : state.status,
      }).pipe(Effect.mapError(() => failure("engine")));
    });
  const get = (input: typeof WorkflowTarget.Type) =>
    Effect.gen(function* () {
      yield* storedApp(db, { app: input.app });
      return yield* reconcile(yield* read(input.run, input.app));
    });
  const start = (input: typeof StartWorkflow.Type, inherited?: InvocationSnapshot) =>
    Effect.gen(function* () {
      if (backend === undefined) return yield* unavailable();
      yield* storedApp(db, { app: input.app });
      const id = WorkflowRunId.make(
        `wfr_${yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()))}`,
      );
      const key = input.key ?? id;
      const actor = inherited === undefined ? yield* CurrentActor : inherited.actor;
      // A key is the caller's within one scope: a run started without a caller never answers a
      // start with one, nor the reverse, even for the same actor.
      const scope = inherited === undefined ? invocationScope(input.accounts) : inherited.scope;
      const find = () =>
        query(() =>
          db.findFirst("workflowRuns", {
            where: (b) =>
              b.and(
                b("app", "=", input.app),
                b("key", "=", key),
                actor === undefined ? b("actor", "is", null) : b("actor", "=", actor),
                b("scope", "=", scope),
              ),
          }),
        );
      let row = yield* find();
      if (row === null) {
        const state = inherited ?? (yield* snapshot(db, input));
        const bound = yield* resolve(state, resolveAccount).pipe(
          Effect.provideService(CurrentActor, actor),
        );
        const parsed = yield* safe(
          runtime
            .workflow({
              app: input.app,
              build: state.version.build,
              hostApi: declarations.hostApi(state.version),
              ...bound,
              command: { operation: "workflow-validate", name: input.workflow, input: input.input },
            })
            .pipe(
              // The app rejects input with its own WorkflowFailure. A build that could not load or
              // answer is the host's failure, not the caller's input.
              Effect.catchTags({
                RuntimeBuildUnavailable: () => Effect.fail(failure("engine", true)),
                RuntimeProtocolFailed: () => Effect.fail(failure("engine", true)),
              }),
            ),
          "input",
        );
        const encrypted = yield* credentials.encrypt(
          id,
          Redacted.make({ input: parsed, request: input.input }),
        );
        const createdAt = new Date(yield* Clock.currentTimeMillis);
        // Set once every statement has run. A failure after it comes from the commit, which may
        // have applied even though its answer was an error or never arrived.
        let committing = false;
        const settled = yield* transaction(db, () =>
          Effect.gen(function* () {
            yield* query(() =>
              db.updateMany("apps", {
                where: (b) => b("id", "=", state.app.id),
                set: { createdAt: state.app.createdAt },
              }),
            );
            const currentApp = yield* storedApp(db, { app: state.app.id });
            if (inherited === undefined && currentApp.activeVersion !== state.app.activeVersion)
              return yield* failure("conflict");
            const accountIds = [...new Set(Object.values(state.accounts).flat())].sort();
            for (const account of accountIds) {
              const saved = yield* storedAccount(db, account);
              yield* query(() =>
                db.updateMany("accounts", {
                  where: (b) => b("id", "=", account),
                  set: { createdAt: saved.createdAt },
                }),
              );
              yield* storedAccount(db, account);
            }
            yield* query(() =>
              db.create("workflowRuns", {
                id,
                app: input.app,
                owner: state.app.owner,
                actor: actor ?? null,
                scope: state.scope,
                key,
                deployment: state.version.id,
                name: input.workflow,
                accounts: state.accounts,
                status: "queued",
                failure: null,
                encrypted,
                createdAt,
              }),
            );
            const accounts = new Set(Object.values(state.accounts).flat());
            for (const account of accounts)
              yield* query(() =>
                db.create("workflowAccounts", { id: `${id}:${account}`, run: id, account }),
              );
            committing = true;
          }),
        ).pipe(Effect.exit);
        // The SQL client reports a failed commit as a defect, so the whole cause is settled here.
        // Cancellation, and a defect before the commit, end the start as they would anywhere.
        if (
          Exit.isFailure(settled) &&
          (Cause.hasInterrupts(settled.cause) || (!committing && !Cause.hasFails(settled.cause)))
        )
          return yield* Effect.failCause(settled.cause);
        // Run `id` is saved, and a saved queued run is dispatched later even if this call stops.
        if (Exit.isSuccess(settled)) yield* Effect.annotateCurrentSpan("executor.run.id", id);
        // Only a read decides what the start saved: a failed transaction may still have committed,
        // or lost a race to a start with the same key.
        const found = yield* find().pipe(
          Effect.result,
          Effect.withSpan("workflow.start.read-back"),
        );
        if (Exit.isSuccess(settled)) {
          if (Result.isFailure(found) || found.success === null)
            return yield* unconfirmedStart(id, input.key);
          row = found.success;
        } else if (committing) {
          // A commit that failed or timed out may still have applied. Not finding the run proves
          // nothing either: the commit may land after this read.
          if (Result.isFailure(found) || found.success === null)
            return yield* unknownStart(input.key);
          row = found.success;
        } else {
          // A failure before the commit rolled the transaction back.
          const error = Cause.findError(settled.cause);
          if (Result.isFailure(error)) return yield* Effect.failCause(settled.cause);
          if (Result.isFailure(found))
            return yield* Schema.is(WorkflowFailure)(error.success)
              ? error.success
              : unknownStart(input.key);
          if (found.success === null) return yield* error.success;
          row = found.success;
        }
      }
      const saved = row;
      return yield* Effect.gen(function* () {
        const retained = yield* Schema.decodeUnknownEffect(StoredRun)(saved).pipe(
          Effect.mapError(() => new StorageError()),
        );
        const payload = yield* decrypt(retained);
        if (retained.name !== input.workflow || stable(payload.request) !== stable(input.input))
          return yield* failure("conflict");
        yield* Effect.annotateCurrentSpan("executor.run.id", retained.id);
        if (!terminal(retained)) yield* dispatch(backend, retained.id);
        return yield* view(yield* read(retained.id));
      }).pipe(
        // The run is saved, and a saved queued run is dispatched later even if this call stops, so
        // a failure from here on must not read as a start that did not happen.
        Effect.catchIf(
          (error) => !(Schema.is(WorkflowFailure)(error) && error.reason === "conflict"),
          () => Effect.fail(unconfirmedStart(String(saved.id), input.key)),
        ),
      );
    }).pipe(
      Effect.tapError((error) =>
        Effect.annotateCurrentSpan(
          "executor.workflow.failure.reason",
          Schema.is(WorkflowFailure)(error) ? error.reason : error._tag,
        ),
      ),
      Effect.withSpan("workflow.start", { attributes: { "executor.app.id": input.app } }),
    );
  const terminate = (input: typeof WorkflowTarget.Type) =>
    Effect.gen(function* () {
      yield* storedApp(db, { app: input.app });
      const row = yield* read(input.run, input.app);
      if (row.status === "complete" || row.status === "errored") return yield* view(row);
      if (backend === undefined) return yield* unavailable();
      yield* backend.terminate(row.id);
      yield* transaction(db, () =>
        Effect.gen(function* () {
          yield* query(() =>
            db.updateMany("workflowRuns", {
              where: (b) =>
                b.and(
                  b("id", "=", row.id),
                  b.or(b("status", "=", "queued"), b("status", "=", "running")),
                ),
              set: { status: "terminated" },
            }),
          );
          yield* inputs.close(row.id);
          yield* query(() =>
            db.deleteMany("workflowAccounts", { where: (b) => b("run", "=", row.id) }),
          );
        }),
      );
      return yield* view(yield* read(row.id));
    });
  /** `actor` limits the page to one actor's runs; null to runs started without one. */
  const list = (input: typeof ListWorkflowRuns.Type, actor?: string | null) =>
    Effect.gen(function* () {
      yield* storedApp(db, { app: input.app });
      const limit = input.limit ?? 20;
      const rows = yield* query(() =>
        db.findMany("workflowRuns", {
          where: (b) =>
            b.and(
              b("app", "=", input.app),
              ...(actor === undefined
                ? []
                : [actor === null ? b("actor", "is", null) : b("actor", "=", actor)]),
              ...(input.workflow === undefined ? [] : [b("name", "=", input.workflow)]),
              ...(input.key === undefined ? [] : [b("key", "=", input.key)]),
              ...(input.cursor === undefined ? [] : [b("id", ">", input.cursor)]),
            ),
          orderBy: ["id", "asc"],
          limit: limit + 1,
        }),
      );
      const page = yield* Schema.decodeUnknownEffect(Schema.Array(StoredRun))(
        rows.slice(0, limit),
      ).pipe(Effect.mapError(() => new StorageError()));
      const items = yield* Effect.forEach(page, reconcile, {
        concurrency: 4,
      });
      const last = page.at(-1);
      return WorkflowRunPage.make({
        items,
        ...(rows.length > limit && last !== undefined ? { next: last.id } : {}),
      });
    }).pipe(Effect.withSpan("sdk.workflows.list"));
  /** The snapshot's actor is the boundary: controls never widen to another actor's runs. */
  function controls(inherited: InvocationSnapshot): WorkflowHostControls {
    const app = inherited.app.id;
    const actor = inherited.actor ?? null;
    const parse = <A, B>(
      schema: Schema.Decoder<A>,
      input: unknown,
      run: (input: A) => Effect.Effect<B, unknown>,
    ) =>
      Schema.decodeUnknownEffect(schema)(input).pipe(
        Effect.flatMap(run),
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.interrupt;
          const error = Cause.squash(cause);
          if (Schema.is(WorkflowFailure)(error)) return Effect.fail(error);
          // Executor's own errors carry curated text the app's code can act on.
          return Effect.fail(
            UserFacingError.is(error)
              ? new WorkflowFailure({
                  reason: "execution",
                  retryable: error.retryable,
                  errorName: error._tag.slice(0, 128),
                  message: error.message.slice(0, maxFailureMessageLength),
                })
              : failure("execution"),
          );
        }),
      );
    const within = (input: typeof WorkflowTarget.Type) =>
      Effect.gen(function* () {
        const row = yield* read(input.run, input.app);
        if (row.actor !== actor) return yield* failure("not_found");
      });
    return {
      start: (input) =>
        parse(
          StartWorkflow,
          {
            ...input,
            app,
            accounts: scopedSelection(
              inherited.version.requirements.accounts,
              inherited.accounts,
              inherited.scope,
            ),
          },
          (input) => start(input, inherited),
        ),
      get: (input) =>
        parse(WorkflowTarget, { ...input, app }, (input) =>
          within(input).pipe(Effect.andThen(get(input))),
        ),
      list: (input) =>
        parse(Schema.toType(ListWorkflowRuns), { ...input, app }, (input) => list(input, actor)),
      terminate: (input) =>
        parse(WorkflowTarget, { ...input, app }, (input) =>
          within(input).pipe(Effect.andThen(terminate(input))),
        ),
    };
  }
  return {
    controls,
    inputs: {
      get: inputs.get,
      answer: inputs.answer,
      updateEvidence: inputs.updateEvidence,
      withdraw: inputs.withdraw,
      list: inputs.list,
    },
    definitions: (input: typeof WorkflowApp.Type) =>
      Effect.gen(function* () {
        const state = yield* snapshot(db, input);
        const value = yield* declarations.read("workflows", state, (context) =>
          safe(
            runtime.workflow({
              app: input.app,
              build: state.version.build,
              hostApi: declarations.hostApi(state.version),
              ...context,
              command: { operation: "workflows" },
            }),
            "execution",
          ),
        );
        return yield* safe(
          Schema.decodeUnknownEffect(Schema.Array(HostedWorkflow))(value),
          "execution",
        );
      }).pipe(Effect.withSpan("sdk.workflows.definitions")),
    runs: {
      start,
      get,
      terminate,
      list,
      pinned: (input: Parameters<Executor["apps"]["workflowRuns"]["pinned"]>[0]) =>
        Effect.gen(function* () {
          const app = yield* storedApp(db, { app: input.app, owner: input.owner });
          const row = yield* read(input.run, input.app);
          if (input.owner !== undefined && row.owner !== input.owner)
            return yield* failure("not_found");
          // Each account keeps the scope its requirement had when the run started, whatever later
          // versions declare.
          const version = yield* storedVersion(db, app, row.version).pipe(
            Effect.catchTags({
              VersionNotFound: () => failure("not_found"),
              AppNotDeployed: () => failure("not_found"),
            }),
          );
          return {
            accounts: scopedSelection(version.requirements.accounts, row.accounts, row.scope),
            actor: row.actor,
          };
        }),
    },
    host: {
      get: (run) => safe(read(run).pipe(Effect.flatMap(view)), "engine", true),
      seed,
      context,
      invoke,
      input,
      execute,
      finish,
      reconcile: safe(
        Effect.gen(function* () {
          if (backend === undefined) return;
          yield* inputs.reconcile;
          let cursor: WorkflowRunId | undefined;
          while (true) {
            const after = cursor;
            const pending = yield* query(() =>
              db.findMany("workflowRuns", {
                where: (b) =>
                  b.and(
                    b.or(b("status", "=", "queued"), b("status", "=", "running")),
                    ...(after === undefined ? [] : [b("id", ">", after)]),
                  ),
                orderBy: ["id", "asc"],
                limit: 100,
              }),
            );
            yield* Effect.forEach(
              pending,
              (row) =>
                safe(
                  Effect.gen(function* () {
                    if (row.status === "queued") yield* backend.start(row.id);
                    yield* get({ app: row.app, run: row.id });
                  }),
                  "engine",
                  true,
                ).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("Workflow reconciliation failed", {
                      run: row.id,
                      reason: error.reason,
                    }),
                  ),
                ),
              { concurrency: 4, discard: true },
            );
            cursor = pending.at(-1)?.id;
            if (pending.length < 100 || cursor === undefined) break;
          }
        }),
        "engine",
        true,
      ),
    } satisfies WorkflowHost,
  };
};
