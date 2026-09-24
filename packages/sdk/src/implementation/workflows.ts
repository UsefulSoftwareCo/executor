import type { ResourceLifecycle } from "../contracts/executor.ts";
/** Retained run identities pin code/accounts; the backend owns timers and checkpoint execution. */
import { Cause, Clock, Effect, Encoding, Redacted, Result, Schema, type Crypto } from "effect";
import {
  HostedWorkflow,
  WorkflowFailure,
  WorkflowRun,
  WorkflowRunId,
  WorkflowRunPage,
  WorkflowValue,
  type WorkflowHostControls,
} from "apps/contracts";
import { WorkflowHost, type WorkflowRuntime } from "../contracts/workflow-runtime.ts";
import {
  StartWorkflow,
  ListWorkflowRuns,
  WorkflowTarget,
  WorkflowApp,
} from "../contracts/workflows.ts";
import { SelectedAccounts } from "../contracts/apps.ts";
import { AppId, DeploymentId, OwnerId, StorageError, type Json } from "../contracts/shared.ts";
import type { Credentials } from "../contracts/storage.ts";
import type { Runtime } from "../contracts/runtime.ts";
import type { ExecutorDatabase } from "./storage.ts";
import type { AppDatabases } from "@executor-js/app-data";
import type { makeOAuth } from "./oauth.ts";
import { database, query, transaction } from "./database.ts";
import { storedProfile } from "./profiles.ts";
import { ProfileId } from "../contracts/shared.ts";
import { storedAccount } from "./accounts.ts";
import { storedApp } from "./apps.ts";
import { resolve, snapshot } from "./tools.ts";
import { bindAppStorage } from "./app-database.ts";

const StoredRun = Schema.Struct({
  id: WorkflowRunId,
  app: AppId,
  profile: Schema.NullOr(ProfileId),
  profileRevision: Schema.NullOr(Schema.Int),
  owner: OwnerId,
  key: Schema.String,
  deployment: DeploymentId,
  name: Schema.String,
  accounts: SelectedAccounts,
  status: Schema.Literals(["queued", "running", "complete", "errored", "terminated"]),
  failure: Schema.NullOr(WorkflowFailure.fields.reason),
  encrypted: Schema.RedactedFromValue(Schema.Uint8Array),
  createdAt: Schema.Date,
});
const Payload = Schema.Struct({
  input: WorkflowValue,
  request: WorkflowValue,
  output: Schema.optionalKey(WorkflowValue),
});
const terminal = (row: typeof StoredRun.Type) =>
  row.status === "complete" || row.status === "errored" || row.status === "terminated";
const unavailable = () => new WorkflowFailure({ reason: "unavailable", retryable: false });
const failure = (reason: WorkflowFailure["reason"], retryable = false) =>
  new WorkflowFailure({ reason, retryable });
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

/** Compose lifecycle operations and private execution callbacks without acquiring resources. */
export const makeWorkflowRuns = (
  storage: ExecutorDatabase,
  runtime: Runtime,
  resolveAccount: ReturnType<typeof makeOAuth>["resolve"],
  credentials: Credentials,
  crypto: Crypto.Crypto,
  backend?: WorkflowRuntime,
  appStorage?: AppDatabases,
  lifecycle?: ResourceLifecycle,
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
        ...(row.profile === null ? {} : { profile: row.profile }),
        deployment: row.deployment,
        workflow: row.name,
        createdAt: row.createdAt.toISOString(),
        status: row.status,
        ...(row.status === "complete" ? { output: payload.output } : {}),
        ...(row.status === "errored" ? { error: row.failure } : {}),
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
          yield* query(() =>
            db.deleteMany("workflowAccounts", { where: (b) => b("run", "=", run) }),
          );
        }),
      ),
      "engine",
      true,
    );
  const context: WorkflowHost["context"] = (run) =>
    safe(
      Effect.gen(function* () {
        const row = yield* read(run);
        if (terminal(row))
          return yield* failure(row.status === "terminated" ? "terminated" : "conflict");
        const state = yield* snapshot(
          db,
          { app: row.app, deployment: row.deployment, profile: row.profile ?? undefined },
          row.accounts,
          row.profileRevision ?? undefined,
        );
        return {
          ...(yield* resolve(state, resolveAccount, lifecycle)),
          database: state.deployment.requirements.database !== undefined,
          ...(yield* bindAppStorage(appStorage, row.app)),
          workflowControls: controls(row.app, state),
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
        const state = yield* snapshot(
          db,
          { app: row.app, deployment: row.deployment, profile: row.profile ?? undefined },
          row.accounts,
          row.profileRevision ?? undefined,
        );
        const payload = yield* decrypt(row);
        if (row.status === "queued")
          yield* query(() =>
            db.updateMany("workflowRuns", {
              where: (b) => b.and(b("id", "=", run), b("status", "=", "queued")),
              set: { status: "running" },
            }),
          );
        return {
          runId: run,
          app: row.app,
          build: state.deployment.build,
          deployment: row.deployment,
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
            tool: `${input.kind === "query" ? "queries" : "mutations"}.${input.name}`,
            input: input.input,
            ...(input.kind === "mutation"
              ? {
                  replay: {
                    key: input.stepId,
                    fingerprint: Encoding.encodeHex(
                      yield* crypto.digest(
                        "SHA-256",
                        new TextEncoder().encode(
                          stable({
                            deployment: current.deployment,
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
            }),
          );
        return yield* Schema.decodeUnknownEffect(WorkflowValue)(result).pipe(
          Effect.mapError(() => failure("output")),
        );
      }),
      "execution",
      true,
    );
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
            },
          });
        }),
        "execution",
      ).pipe(Effect.result);
      if (Result.isFailure(result)) {
        if (result.failure.reason === "engine" && result.failure.retryable)
          return yield* result.failure;
        yield* finish(run, { ok: false, error: result.failure.reason });
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
        if (current.status === "queued") yield* backend.start(row.id);
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
  const start = (
    input: typeof StartWorkflow.Type,
    inherited?: Effect.Success<ReturnType<typeof snapshot>>,
  ) =>
    Effect.gen(function* () {
      if (backend === undefined) return yield* unavailable();
      yield* storedApp(db, { app: input.app });
      const id = WorkflowRunId.make(
        `wfr_${yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()))}`,
      );
      const key = input.key ?? id;
      const find = () =>
        query(() =>
          db.findFirst("workflowRuns", {
            where: (b) =>
              b.and(
                b("app", "=", input.app),
                b("key", "=", key),
                input.profile === undefined
                  ? b("profile", "is", null)
                  : b("profile", "=", input.profile),
              ),
          }),
        );
      let row = yield* find();
      if (row === null) {
        const state = inherited ?? (yield* snapshot(db, input));
        const bound = yield* resolve(state, resolveAccount, lifecycle);
        const parsed = yield* safe(
          runtime.workflow({
            app: input.app,
            build: state.deployment.build,
            ...bound,
            command: { operation: "workflow-validate", name: input.workflow, input: input.input },
          }),
          "input",
        );
        const encrypted = yield* credentials.encrypt(
          id,
          Redacted.make({ input: parsed, request: input.input }),
        );
        const createdAt = new Date(yield* Clock.currentTimeMillis);
        const saved = yield* transaction(db, () =>
          Effect.gen(function* () {
            yield* query(() =>
              db.updateMany("apps", {
                where: (b) => b("id", "=", state.app.id),
                set: { createdAt: state.app.createdAt },
              }),
            );
            if (state.profile !== undefined) {
              const profile = yield* storedProfile(db, {
                app: state.app.id,
                profile: state.profile.id,
              });
              if (inherited === undefined && profile.revision !== state.profile.revision)
                return yield* failure("conflict");
              if (!profile.enabled || profile.status === "removed" || profile.status === "removing")
                return yield* failure("conflict");
            }
            const currentApp = yield* storedApp(db, { app: state.app.id });
            if (
              inherited === undefined &&
              currentApp.activeDeployment !== state.app.activeDeployment
            )
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
                profile: input.profile ?? null,
                profileRevision: state.profile?.revision ?? null,
                key,
                deployment: state.deployment.id,
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
          }),
        ).pipe(Effect.result);
        row = yield* find();
        if (row === null) {
          if (Result.isFailure(saved)) return yield* saved.failure;
          return yield* new StorageError();
        }
      }
      const retained = yield* Schema.decodeUnknownEffect(StoredRun)(row).pipe(
        Effect.mapError(() => new StorageError()),
      );
      const payload = yield* decrypt(retained);
      if (retained.name !== input.workflow || stable(payload.request) !== stable(input.input))
        return yield* failure("conflict");
      yield* Effect.annotateCurrentSpan("executor.run.id", retained.id);
      if (!terminal(retained)) yield* backend.start(retained.id);
      return yield* view(yield* read(retained.id));
    }).pipe(Effect.withSpan("workflow.start", { attributes: { "executor.app.id": input.app } }));
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
          yield* query(() =>
            db.deleteMany("workflowAccounts", { where: (b) => b("run", "=", row.id) }),
          );
        }),
      );
      return yield* view(yield* read(row.id));
    });
  const list = (input: typeof ListWorkflowRuns.Type, onlyProfile?: ProfileId | null) =>
    Effect.gen(function* () {
      yield* storedApp(db, { app: input.app });
      const limit = input.limit ?? 20;
      const rows = yield* query(() =>
        db.findMany("workflowRuns", {
          where: (b) =>
            b.and(
              b("app", "=", input.app),
              ...(onlyProfile === null
                ? [b("profile", "is", null)]
                : onlyProfile !== undefined
                  ? [b("profile", "=", onlyProfile)]
                  : input.profile === undefined
                    ? []
                    : [b("profile", "=", input.profile)]),
              ...(input.workflow === undefined ? [] : [b("name", "=", input.workflow)]),
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
  function controls(
    app: AppId,
    inherited?: Effect.Success<ReturnType<typeof snapshot>>,
  ): WorkflowHostControls {
    const parse = <A, B>(
      schema: Schema.Decoder<A>,
      input: unknown,
      run: (input: A) => Effect.Effect<B, unknown>,
    ) => safe(Schema.decodeUnknownEffect(schema)(input).pipe(Effect.flatMap(run)), "execution");
    const within = (input: typeof WorkflowTarget.Type) =>
      Effect.gen(function* () {
        const row = yield* read(input.run, input.app);
        if (row.profile !== (inherited?.profile?.id ?? null)) return yield* failure("not_found");
      });
    return {
      start: (input) =>
        parse(
          StartWorkflow,
          {
            ...input,
            app,
            profile: inherited?.profile?.id,
          },
          (input) => start(input, inherited),
        ),
      get: (input) =>
        parse(WorkflowTarget, { ...input, app }, (input) =>
          within(input).pipe(Effect.andThen(get(input))),
        ),
      list: (input) =>
        parse(
          Schema.toType(ListWorkflowRuns),
          {
            ...input,
            app,
            profile: inherited?.profile?.id,
          },
          (input) => list(input, inherited?.profile?.id ?? null),
        ),
      terminate: (input) =>
        parse(WorkflowTarget, { ...input, app }, (input) =>
          within(input).pipe(Effect.andThen(terminate(input))),
        ),
    };
  }
  return {
    controls,
    definitions: (input: typeof WorkflowApp.Type) =>
      Effect.gen(function* () {
        const state = yield* snapshot(db, input);
        return yield* safe(
          runtime
            .workflow({
              app: input.app,
              build: state.deployment.build,
              ...(yield* resolve(state, resolveAccount, lifecycle)),
              command: { operation: "workflows" },
            })
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(HostedWorkflow)))),
          "execution",
        );
      }),
    runs: {
      start,
      get,
      terminate,
      list,
    },
    host: {
      get: (run) => safe(read(run).pipe(Effect.flatMap(view)), "engine", true),
      seed,
      context,
      invoke,
      execute,
      finish,
      reconcile: safe(
        Effect.gen(function* () {
          if (backend === undefined) return;
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
