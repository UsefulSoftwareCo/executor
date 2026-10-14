/** Persisted scheduling transitions. App code and external effects run only after a claim commits. */
import { Clock, Cron, Effect, Option, Result, Schema, SchemaAST, type Crypto } from "effect";
import { ScheduleTiming } from "apps/contracts";
import { CurrentActor, type Executor, type ResourceLifecycle } from "../contracts/executor.ts";
import { AccountRequired } from "../contracts/apps.ts";
import {
  StorageError,
  RequestInvalid,
  type AccountId,
  type AppId,
  type OwnerId,
} from "../contracts/shared.ts";
import { OAuthReconnectRequired } from "../contracts/oauth.ts";
import {
  AppSchedule,
  ScheduleInputs,
  ScheduleSettings,
  ScheduleId,
  ScheduledRun,
  ScheduledRunId,
  StoredScheduledRun,
  ScheduleNotFound,
  ScheduleConflict,
  ScheduleInvalid,
} from "../contracts/schedules.ts";
import { InvocationRun } from "../contracts/runtime.ts";
import { ScheduleObservation } from "../contracts/scheduler.ts";
import type { ScheduleDispatcher } from "../contracts/scheduler.ts";
import type { Credentials } from "../contracts/storage.ts";
import type { ExecutorDatabase } from "./storage.ts";
import { database, query, transaction } from "./database.ts";
import { lockApp } from "./apps.ts";
import { backgroundAccounts } from "./background-accounts.ts";
import { makeToolApprovals } from "./tool-approvals.ts";
import type { makeTools } from "./tools.ts";

/** Why an enabled schedule skips its occurrences until the owner acts. */
type Waiting = { readonly reconnectAccount: AccountId } | { readonly accountRequired: string };
const terminal = (status: ScheduledRun["status"]) =>
  !["running", "ready", "awaiting-approval"].includes(status);
const diagnostic = (error: unknown) =>
  error instanceof Error && Schema.isSchema(error.constructor)
    ? (SchemaAST.resolveIdentifier(error.constructor.ast) ?? "ExecutionFailed")
    : "ExecutionFailed";
const sameTiming = Schema.toEquivalence(ScheduleTiming);
const nextOccurrence = (timing: ScheduleTiming, after: Date) =>
  Effect.try({
    try: () => {
      if (timing.kind === "interval") {
        const next = new Date(after.getTime() + timing.milliseconds);
        if (!Number.isFinite(next.getTime())) throw new Error("Invalid future date");
        return next;
      }
      const cron = Cron.parse(timing.calendar.expression, timing.calendar.timezone);
      if (Result.isFailure(cron)) throw cron.failure;
      return Cron.next(cron.success, after);
    },
    catch: () => new ScheduleInvalid(),
  });

/** Compose settings and lifecycle over ordinary app discovery, calls and persisted SDK approvals. */
export const makeSchedules = (
  storage: ExecutorDatabase,
  apps: Pick<Executor["apps"], "get">,
  tools: Pick<Executor["tools"], "call" | "resume"> &
    Pick<ReturnType<typeof makeTools>, "scheduled" | "accountNeedingReconnect">,
  credentials: Credentials,
  crypto: Crypto.Crypto,
  lifecycle: ResourceLifecycle | undefined,
) => {
  const db = database(storage);
  const approvals = makeToolApprovals(db, credentials, crypto, storage.reactivity.inTransaction);
  const now = Effect.map(Clock.currentTimeMillis, (value) => new Date(value));
  const uuid = crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()));
  const parse = <A>(schema: Schema.Decoder<A>, value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => new StorageError()));
  const readSettings = (id: ScheduleId, owner?: OwnerId) =>
    Effect.gen(function* () {
      const row = yield* query(() =>
        db.findFirst("schedules", {
          where: (b) =>
            b.and(b("id", "=", id), owner === undefined ? true : b("owner", "=", owner)),
        }),
      );
      if (row === null) return yield* new ScheduleNotFound();
      return yield* parse(ScheduleSettings, row);
    });
  const readRun = (id: ScheduledRunId, owner?: OwnerId) =>
    Effect.gen(function* () {
      const row = yield* query(() =>
        db.findFirst("scheduledRuns", {
          where: (b) =>
            b.and(b("id", "=", id), owner === undefined ? true : b("owner", "=", owner)),
        }),
      );
      if (row === null) return yield* new ScheduleNotFound();
      return yield* parse(StoredScheduledRun, row);
    });
  const publicRun = (run: StoredScheduledRun) => ScheduledRun.make(run);
  /**
   * The accounts a schedule runs with now: the app links, and for a member's copy its actor's user
   * links. An app schedule has no actor and runs without a caller.
   */
  const accountsFor = (setting: Pick<ScheduleSettings, "app" | "actor">) =>
    backgroundAccounts(db, lifecycle, {
      app: setting.app,
      actor: setting.actor ?? undefined,
    }).pipe(Effect.provideService(CurrentActor, setting.actor ?? undefined));
  /**
   * What a schedule waits on: a plain requirement its actor links no account for, or a stored
   * grant that must reconnect. Any other problem is left to the run, which reports it.
   */
  const waitingOn = (setting: ScheduleSettings) =>
    accountsFor(setting).pipe(
      Effect.flatMap((accounts) => tools.accountNeedingReconnect({ app: setting.app, accounts })),
      Effect.map((account): Waiting | undefined =>
        account === undefined ? undefined : { reconnectAccount: account },
      ),
      Effect.catchIf(Schema.is(AccountRequired), (error) =>
        Effect.succeed<Waiting | undefined>({ accountRequired: error.slot }),
      ),
      Effect.catch((error) =>
        Schema.is(StorageError)(error) ? Effect.fail(error) : Effect.succeed(undefined),
      ),
      Effect.provideService(CurrentActor, setting.actor ?? undefined),
    );
  const savedFor = (app: AppId) =>
    query(() => db.findMany("schedules", { where: (b) => b("app", "=", app) })).pipe(
      Effect.flatMap((rows) => parse(Schema.Array(ScheduleSettings), rows)),
    );
  const definitions = (input: typeof ScheduleInputs.definitions.Type) =>
    Effect.gen(function* () {
      yield* apps.get(input);
      const settings = yield* savedFor(input.app);
      const declared = yield* tools.scheduled({ app: input.app, accounts: input.accounts });
      const results: AppSchedule[] = declared.items.map((schedule) => ({
        ...schedule,
        app: input.app,
        // An app declaration has one schedule; a user declaration, the actor's copy.
        settings:
          settings.find(
            (setting) =>
              setting.name === schedule.name &&
              (schedule.scope === "app"
                ? setting.actor === null
                : setting.actor !== null && setting.actor === input.actor),
          ) ?? null,
      }));
      return results.sort((left, right) => left.name.localeCompare(right.name));
    });
  /**
   * A declaration evaluated with the accounts its runs use. A schedule without an actor is the app
   * schedule of an app declaration; one with an actor, a copy of a user declaration. A declaration
   * of the other scope is not this schedule's.
   */
  const definition = (input: {
    readonly app: AppId;
    readonly name: string;
    readonly actor: string | null;
  }) =>
    Effect.gen(function* () {
      const accounts = yield* accountsFor(input);
      const declared = yield* tools
        .scheduled({ app: input.app, accounts })
        .pipe(Effect.provideService(CurrentActor, input.actor ?? undefined));
      const found = declared.items.find(
        (item) => item.name === input.name && (item.scope === "app") === (input.actor === null),
      );
      if (found === undefined) return yield* new ScheduleNotFound();
      return found;
    });
  /** The actor's copy of a user declaration, or without an actor the app schedule, or null. */
  const findOwn = (input: {
    readonly app: AppId;
    readonly name: string;
    readonly actor: string | null;
  }) =>
    query(() =>
      db.findFirst("schedules", {
        where: (b) =>
          b.and(
            b("app", "=", input.app),
            b("name", "=", input.name),
            input.actor === null ? b("actor", "is", null) : b("actor", "=", input.actor),
          ),
      }),
    ).pipe(
      Effect.flatMap((row) => (row === null ? Effect.succeed(null) : parse(ScheduleSettings, row))),
    );
  /** One copy of a declaration of the app. */
  const readCopy = (input: {
    readonly app: AppId;
    readonly name: string;
    readonly copy: ScheduleId;
  }) =>
    Effect.gen(function* () {
      const row = yield* query(() =>
        db.findFirst("schedules", {
          where: (b) =>
            b.and(b("id", "=", input.copy), b("app", "=", input.app), b("name", "=", input.name)),
        }),
      );
      if (row === null) return yield* new ScheduleNotFound();
      return yield* parse(ScheduleSettings, row);
    });
  const finish = (
    run: StoredScheduledRun,
    status: ScheduledRun["status"],
    failure: string | null = null,
  ) =>
    transaction(db, () =>
      Effect.gen(function* () {
        const finishedAt = yield* now;
        yield* query(() =>
          db.updateMany("scheduledRuns", {
            where: (b) =>
              b.and(
                b("id", "=", run.id),
                b("status", "=", run.status),
                b("revision", "=", run.revision),
              ),
            set: { status, finishedAt, failure },
          }),
        );
        if (terminal(status)) {
          const current = yield* readRun(run.id);
          if (current.revision !== run.revision || current.status !== status) return;
          const completed = {
            id: run.id,
            scheduleId: run.scheduleId,
            app: run.app,
            owner: run.owner,
            status,
            startedAt: run.startedAt,
            finishedAt,
          };
          const saved = yield* query(() =>
            db.findFirst("schedules", { where: (b) => b("id", "=", run.scheduleId) }),
          );
          // An activation removed this schedule while the run was in flight. Its history goes
          // with it, as it did for the schedule's earlier runs.
          if (saved === null) {
            yield* query(() =>
              db.deleteMany("scheduledRuns", {
                where: (b) => b.and(b("id", "=", run.id), b("revision", "=", run.revision)),
              }),
            );
            return completed;
          }
          const settings = yield* parse(ScheduleSettings, saved);
          const nextAt =
            settings.nextAt !== null && settings.nextAt <= finishedAt && settings.enabled
              ? yield* nextOccurrence(settings.timing, finishedAt).pipe(
                  Effect.mapError(() => new StorageError()),
                )
              : settings.nextAt;
          // Reconcile timing only if configuration did not change while finishing.
          yield* query(() =>
            db.updateMany("schedules", {
              where: (b) =>
                b.and(
                  b("id", "=", run.scheduleId),
                  b("activeRun", "=", run.id),
                  b("revision", "=", settings.revision),
                ),
              set: { nextAt },
            }),
          );
          yield* query(() =>
            db.updateMany("schedules", {
              where: (b) => b.and(b("id", "=", run.scheduleId), b("activeRun", "=", run.id)),
              set: { activeRun: null },
            }),
          );
          return completed;
        }
      }),
    ).pipe(
      Effect.flatMap((completed) =>
        completed === undefined
          ? Effect.void
          : Effect.annotateCurrentSpan({
              "executor.run.id": run.id,
              "executor.schedule.id": run.scheduleId,
              "executor.app.id": run.app,
              "executor.outcome":
                status === "succeeded"
                  ? "completed"
                  : status === "cancelled"
                    ? "cancelled"
                    : "failed",
              ...(failure === null ? {} : { "error.type": failure }),
            }).pipe(
              Effect.andThen(
                Effect.flatMap(ScheduleObservation, (observer) => observer.completed(completed)),
              ),
            ),
      ),
      Effect.catchTag("ScheduleNotFound", () => Effect.void),
    );
  /**
   * Delete a copy and its run history, in the caller's transaction. A waiting approval would run a
   * call nobody schedules any more, so it is withdrawn. A running mutation finishes; finish then
   * removes its record.
   */
  const deleteCopy = (id: ScheduleId) =>
    Effect.gen(function* () {
      const runs = yield* query(() =>
        db.findMany("scheduledRuns", {
          where: (b) => b.and(b("scheduleId", "=", id), b("status", "!=", "running")),
        }),
      ).pipe(Effect.flatMap((rows) => parse(Schema.Array(StoredScheduledRun), rows)));
      for (const run of runs)
        if (run.requestId !== null && !terminal(run.status)) {
          const requestId = run.requestId;
          yield* query(() =>
            db.deleteMany("toolApprovals", {
              where: (b) => b.and(b("id", "=", requestId), b("status", "=", "pending")),
            }),
          );
        }
      yield* query(() =>
        db.deleteMany("scheduledRuns", {
          where: (b) => b.and(b("scheduleId", "=", id), b("status", "!=", "running")),
        }),
      );
      yield* query(() => db.deleteMany("schedules", { where: (b) => b("id", "=", id) }));
    });
  /**
   * Bring saved settings to the active deployment's declarations: delete those of every schedule
   * it no longer declares, with their run history, and give each schedule whose timing changed the
   * new timing and its next occurrence. Declarations can depend on accounts, so each schedule is
   * checked against the app evaluated as its own actor, with the accounts its runs use; schedules
   * that resolve the same accounts share one evaluation. Only a successful evaluation changes
   * anything: a schedule whose app is broken, or whose actor links no account or one that cannot
   * be used, keeps its settings.
   */
  const reconcile = (app: AppId) =>
    Effect.gen(function* () {
      /** A failed resolution or evaluation keeps the schedule; a storage failure stops the cleanup. */
      const unlessEvaluated = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.map(Option.some),
          Effect.catch((error) =>
            Schema.is(StorageError)(error) ? Effect.fail(error) : Effect.succeed(Option.none<A>()),
          ),
        );
      const evaluations = new Map<
        string,
        Option.Option<Effect.Success<ReturnType<typeof tools.scheduled>>>
      >();
      const checked = yield* Effect.forEach(yield* savedFor(app), (setting) =>
        Effect.gen(function* () {
          const accounts = yield* unlessEvaluated(accountsFor(setting));
          if (Option.isNone(accounts)) return undefined;
          // The evaluation also checks the actor's access, so it is shared only by one actor.
          const key = JSON.stringify([
            setting.actor,
            Object.entries(accounts.value).toSorted(([left], [right]) => left.localeCompare(right)),
          ]);
          const declared =
            evaluations.get(key) ??
            (yield* unlessEvaluated(
              tools
                .scheduled({ app, accounts: accounts.value })
                .pipe(Effect.provideService(CurrentActor, setting.actor ?? undefined)),
            ));
          evaluations.set(key, declared);
          if (Option.isNone(declared)) return undefined;
          // A declaration that changed scope no longer declares this schedule.
          const found = declared.value.items.find(
            (schedule) =>
              schedule.name === setting.name &&
              (schedule.scope === "app") === (setting.actor === null),
          );
          if (found !== undefined && sameTiming(found.timing, setting.timing)) return undefined;
          return { setting, deployment: declared.value.deployment, timing: found?.timing };
        }),
      );
      const changed = checked.filter((item) => item !== undefined);
      if (changed.length === 0) return;
      yield* transaction(db, () =>
        Effect.gen(function* () {
          const locked = yield* lockApp(db, { app });
          for (const { setting, deployment, timing } of changed) {
            // A later activation reconciles against its own declarations, and a schedule
            // configured or claimed since it was evaluated is checked again by the next one.
            if (locked.activeDeployment !== deployment) continue;
            const current = yield* query(() =>
              db.findFirst("schedules", {
                where: (b) => b.and(b("id", "=", setting.id), b("revision", "=", setting.revision)),
              }),
            );
            if (current === null) continue;
            if (timing !== undefined) {
              // An enabled schedule's next occurrence follows the new timing; an invalid timing
              // keeps it, and the run path pauses the schedule. A running occurrence keeps its
              // claim, so only an idle schedule consumes the scanned revision as a claim does: a
              // dispatch holding the earlier due snapshot cannot run on the old timing.
              const nextAt = setting.enabled
                ? Option.getOrElse(
                    yield* nextOccurrence(timing, yield* now).pipe(Effect.option),
                    () => setting.nextAt,
                  )
                : setting.nextAt;
              const revision = setting.activeRun === null ? yield* uuid : setting.revision;
              yield* query(() =>
                db.updateMany("schedules", {
                  where: (b) =>
                    b.and(b("id", "=", setting.id), b("revision", "=", setting.revision)),
                  set: { timing, nextAt, revision },
                }),
              );
              continue;
            }
            yield* deleteCopy(setting.id);
          }
        }),
      );
    }).pipe(Effect.withSpan("sdk.schedules.reconcile", { attributes: { "executor.app.id": app } }));
  const getApproval = (input: typeof ScheduleInputs.approval.Type) =>
    Effect.gen(function* () {
      const run = yield* readRun(input.run, input.owner);
      yield* apps.get({ app: run.app, owner: input.owner });
      if (run.status !== "awaiting-approval" || run.requestId === null)
        return yield* new ScheduleNotFound();
      const { invocation, expiresAt } = yield* approvals
        .get(run.requestId, run.owner)
        .pipe(Effect.catchTag("ToolApprovalNotFound", () => new ScheduleNotFound()));
      return { run: publicRun(run), invocation, expiresAt };
    });
  /** Save a copy's new state, unless it changed since it was read. */
  const save = (
    previous: ScheduleSettings,
    next: {
      readonly enabled: boolean;
      readonly approvalMode?: ScheduleSettings["approvalMode"] | undefined;
      readonly timing: ScheduleSettings["timing"];
      readonly nextAt: Date | null;
      readonly revision: string;
    },
  ) =>
    Effect.gen(function* () {
      yield* query(() =>
        db.updateMany("schedules", {
          where: (b) => b.and(b("id", "=", previous.id), b("revision", "=", previous.revision)),
          set: {
            timing: next.timing,
            enabled: next.enabled,
            approvalMode: next.approvalMode ?? previous.approvalMode,
            nextAt:
              next.enabled && previous.enabled && sameTiming(next.timing, previous.timing)
                ? previous.nextAt
                : next.nextAt,
            revision: next.revision,
          },
        }),
      );
      const current = yield* readSettings(previous.id);
      if (current.revision !== next.revision) return yield* new ScheduleConflict();
      return current;
    });
  const operations = {
    definitions: (input: typeof ScheduleInputs.definitions.Type) => definitions(input),
    list: (input: typeof ScheduleInputs.list.Type) =>
      Effect.gen(function* () {
        yield* apps.get(input);
        const settings = yield* savedFor(input.app);
        // Enabled schedules report what they wait on, so the owner sees why none run.
        return yield* Effect.forEach(settings, (setting) =>
          setting.enabled
            ? waitingOn(setting).pipe(
                Effect.map((waiting) =>
                  waiting === undefined ? setting : { ...setting, ...waiting },
                ),
              )
            : Effect.succeed(setting),
        );
      }),
    configure: (input: typeof ScheduleInputs.configure.Type) =>
      Effect.gen(function* () {
        const parsed = yield* Schema.decodeUnknownEffect(ScheduleInputs.configure)(input).pipe(
          Effect.mapError(() => new RequestInvalid()),
        );
        const app = yield* apps.get(parsed);
        const target = { app: app.id, name: parsed.name, actor: parsed.actor ?? null };
        const saved = yield* findOwn(target);
        // Pausing saved work never depends on evaluating broken app code or refreshing a revoked account.
        const timing =
          !parsed.enabled && saved !== null ? saved.timing : (yield* definition(target)).timing;
        const nextAt = parsed.enabled ? yield* nextOccurrence(timing, yield* now) : null;
        const revision = yield* uuid;
        return yield* transaction(db, () =>
          Effect.gen(function* () {
            yield* lockApp(db, { app: app.id });
            const previous = yield* findOwn(target);
            if (previous === null) {
              const created = ScheduleSettings.make({
                id: ScheduleId.make(`sch_${revision}`),
                app: app.id,
                owner: app.owner,
                name: parsed.name,
                actor: target.actor,
                timing,
                enabled: parsed.enabled,
                approvalMode: parsed.approvalMode ?? "automatic",
                nextAt,
                activeRun: null,
                revision,
              });
              yield* query(() => db.create("schedules", created));
              return created;
            }
            return yield* save(previous, { ...parsed, timing, nextAt, revision });
          }),
        );
      }),
    copy: (input: typeof ScheduleInputs.copy.Type) =>
      Effect.gen(function* () {
        const app = yield* apps.get(input);
        const found = yield* findOwn({
          app: app.id,
          name: input.name,
          actor: input.actor ?? null,
        });
        if (found === null) return yield* new ScheduleNotFound();
        return found;
      }),
    update: (input: typeof ScheduleInputs.update.Type) =>
      Effect.gen(function* () {
        const parsed = yield* Schema.decodeUnknownEffect(ScheduleInputs.update)(input).pipe(
          Effect.mapError(() => new RequestInvalid()),
        );
        yield* apps.get(parsed);
        const saved = yield* readCopy(parsed);
        const timing = parsed.enabled ? (yield* definition(saved)).timing : saved.timing;
        const nextAt = parsed.enabled ? yield* nextOccurrence(timing, yield* now) : null;
        const revision = yield* uuid;
        return yield* transaction(db, () =>
          Effect.gen(function* () {
            yield* lockApp(db, { app: saved.app });
            return yield* save(yield* readCopy(parsed), { ...parsed, timing, nextAt, revision });
          }),
        );
      }),
    runNow: (input: typeof ScheduleInputs.runNow.Type) =>
      Effect.gen(function* () {
        yield* apps.get(input);
        const settings = yield* readCopy(input);
        // The app must still declare it for the accounts a run uses.
        yield* definition(settings);
        if (!settings.enabled || settings.activeRun !== null) return yield* new ScheduleConflict();
        const { id, revision: expectedRevision } = settings;
        const nextAt = yield* now;
        const revision = yield* uuid;
        return yield* transaction(db, () =>
          Effect.gen(function* () {
            yield* query(() =>
              db.updateMany("schedules", {
                where: (b) =>
                  b.and(
                    b("id", "=", id),
                    b("activeRun", "is", null),
                    b("enabled", "=", true),
                    b("revision", "=", expectedRevision),
                  ),
                set: { nextAt, revision },
              }),
            );
            const current = yield* readSettings(id, input.owner);
            if (current.revision !== revision) return yield* new ScheduleConflict();
            return current;
          }),
        );
      }),
    remove: (input: typeof ScheduleInputs.remove.Type) =>
      Effect.gen(function* () {
        yield* apps.get(input);
        return yield* transaction(db, () =>
          Effect.gen(function* () {
            // Serialized with dispatch's approval handoff, which also holds the app lock.
            yield* lockApp(db, { app: input.app });
            const saved = yield* readCopy(input);
            yield* deleteCopy(saved.id);
            return saved;
          }),
        );
      }),
    runs: (input: typeof ScheduleInputs.runs.Type = {}) =>
      query(() =>
        db.findMany("scheduledRuns", {
          where: (b) =>
            b.and(
              input.owner === undefined ? true : b("owner", "=", input.owner),
              input.app === undefined ? true : b("app", "=", input.app),
              input.pending === true ? b("status", "=", "awaiting-approval") : true,
            ),
          orderBy: ["startedAt", "desc"],
        }),
      ).pipe(Effect.flatMap((rows) => parse(Schema.Array(ScheduledRun), rows))),
    approval: getApproval,
    answer: (input: typeof ScheduleInputs.answer.Type) =>
      Effect.gen(function* () {
        const pending = yield* getApproval(input);
        yield* query(() =>
          db.updateMany("scheduledRuns", {
            where: (b) => b.and(b("id", "=", input.run), b("status", "=", "awaiting-approval")),
            set: { status: "ready", answer: input.action },
          }),
        );
        const current = yield* readRun(pending.run.id, input.owner);
        if (current.status !== "ready" || current.answer !== input.action)
          return yield* new ScheduleConflict();
        return publicRun(current);
      }),
  };
  const complete = (
    run: StoredScheduledRun,
    result: Awaited<Effect.Success<ReturnType<typeof tools.resume>>>,
  ) => {
    switch (result.status) {
      case "completed":
        return result.toolError === true
          ? finish(run, "failed", "McpToolError")
          : finish(run, "succeeded");
      case "denied":
        return finish(run, "denied");
      case "cancelled":
        return finish(run, "cancelled");
      case "already-consumed":
        return finish(run, "interrupted", "AlreadyConsumed");
      case "failed":
        // A resumed call that failed records its own error, as a live call's failure does.
        return result.reason === "execution-failed"
          ? finish(run, "failed", diagnostic(result.error))
          : finish(run, result.reason === "expired" ? "expired" : "failed", result.reason);
    }
  };
  // Retire only the scanned occurrence. A concurrent configuration or claim owns
  // its newer revision and must not be paused by stale dispatch work.
  const retireMissingTarget = (setting: ScheduleSettings) =>
    query(() =>
      db.updateMany("schedules", {
        where: (b) =>
          b.and(
            b("id", "=", setting.id),
            b("revision", "=", setting.revision),
            b("activeRun", "is", null),
          ),
        set: { enabled: false, nextAt: null },
      }),
    ).pipe(Effect.as(null));
  const dispatcher: ScheduleDispatcher = {
    recover: (runner) =>
      Effect.gen(function* () {
        const rows = yield* query(() =>
          db.findMany("scheduledRuns", {
            where: (b) => b.and(b("runner", "=", runner), b("status", "=", "running")),
          }),
        );
        const runs = yield* parse(Schema.Array(StoredScheduledRun), rows);
        for (const run of runs) yield* finish(run, "interrupted", "RunnerStopped");
      }),
    nextWake: Effect.gen(function* () {
      const settings = yield* query(() =>
        db.findFirst("schedules", {
          where: (b) =>
            b.and(b("enabled", "=", true), b("activeRun", "is", null), b("nextAt", "is not", null)),
          orderBy: ["nextAt", "asc"],
        }),
      );
      const pending = yield* query(() =>
        db.findFirst("scheduledRuns", {
          where: (b) => b("status", "=", "awaiting-approval"),
          orderBy: ["expiresAt", "asc"],
        }),
      );
      const ready = yield* query(() =>
        db.findFirst("scheduledRuns", { where: (b) => b("status", "=", "ready") }),
      );
      if (ready !== null) return yield* now;
      const dates = [settings?.nextAt, pending?.expiresAt].filter(
        (date): date is Date => date instanceof Date,
      );
      return dates.length === 0 ? null : new Date(Math.min(...dates.map((date) => date.getTime())));
    }),
    tick: ({ runner, authorize, execute, maxCandidates }) =>
      Effect.gen(function* () {
        const time = yield* now;
        const waiting = yield* query(() =>
          db.findMany("scheduledRuns", {
            limit: maxCandidates,
            orderBy: ["startedAt", "asc"],
            where: (b) =>
              b.or(
                b("status", "=", "ready"),
                b.and(b("status", "=", "awaiting-approval"), b("expiresAt", "<=", time)),
              ),
          }),
        ).pipe(Effect.flatMap((rows) => parse(Schema.Array(StoredScheduledRun), rows)));
        yield* Effect.forEach(
          waiting,
          (pending) =>
            execute(
              Effect.gen(function* () {
                if (pending.expiresAt !== null && pending.expiresAt <= time) {
                  yield* finish(pending, "expired", "ApprovalExpired");
                  return;
                }
                if (pending.requestId === null || pending.answer === null) return;
                const requestId = pending.requestId;
                const answer = pending.answer;
                const revision = yield* uuid;
                const claim = yield* transaction(db, () =>
                  Effect.gen(function* () {
                    yield* query(() =>
                      db.updateMany("scheduledRuns", {
                        where: (b) => b.and(b("id", "=", pending.id), b("status", "=", "ready")),
                        set: { status: "running", runner, revision },
                      }),
                    );
                    const current = yield* readRun(pending.id);
                    return current.status === "running" && current.revision === revision
                      ? current
                      : null;
                  }),
                );
                if (claim === null) return;
                yield* Effect.gen(function* () {
                  const settings = yield* readSettings(claim.scheduleId);
                  yield* authorize({ ...settings, phase: "resume" });
                  const response = yield* tools
                    .resume({
                      requestId,
                      owner: pending.owner,
                      response: { action: answer },
                    })
                    .pipe(Effect.provideService(CurrentActor, settings.actor ?? undefined));
                  yield* complete(claim, response);
                }).pipe(
                  Effect.withErrorReporting,
                  Effect.catch((error) => finish(claim, "failed", diagnostic(error))),
                  Effect.onInterrupt(() => finish(claim, "interrupted", "Interrupted")),
                  Effect.provideService(InvocationRun, claim.id),
                  Effect.withSpan("schedule.run", {
                    attributes: {
                      "executor.run.id": claim.id,
                      "executor.schedule.id": claim.scheduleId,
                      "executor.app.id": claim.app,
                      "executor.attempt.id": globalThis.crypto.randomUUID(),
                      "executor.schedule.lateness_ms": Math.max(
                        0,
                        time.getTime() - claim.scheduledAt.getTime(),
                      ),
                    },
                  }),
                );
              }).pipe(Effect.catchTag("ScheduleNotFound", () => Effect.void)),
            ),
          { concurrency: "unbounded" },
        );
        const due = yield* query(() =>
          db.findMany("schedules", {
            limit: maxCandidates,
            where: (b) =>
              b.and(b("enabled", "=", true), b("activeRun", "is", null), b("nextAt", "<=", time)),
            orderBy: ["nextAt", "asc"],
          }),
        ).pipe(Effect.flatMap((rows) => parse(Schema.Array(ScheduleSettings), rows)));
        yield* Effect.forEach(
          due,
          (setting) =>
            execute(
              Effect.gen(function* () {
                if (setting.nextAt === null) return yield* new StorageError();
                const scheduledAt = setting.nextAt;
                // A run cannot use an account whose sign-in must reconnect, or run without an
                // account its actor has not linked. Skip the occurrence without recording a run or
                // contacting the service; the owner sees why on the schedule, and the first
                // occurrence after reconnecting or linking runs as usual.
                const waiting = yield* waitingOn(setting);
                if (waiting !== undefined) {
                  // Invalid timing is left to the run path, which pauses the schedule.
                  const following = yield* nextOccurrence(setting.timing, time).pipe(Effect.option);
                  if (Option.isSome(following)) {
                    const revision = yield* uuid;
                    yield* query(() =>
                      db.updateMany("schedules", {
                        where: (b) =>
                          b.and(
                            b("id", "=", setting.id),
                            b("revision", "=", setting.revision),
                            b("activeRun", "is", null),
                            b("enabled", "=", true),
                          ),
                        // Consume the scanned revision as a claim does. Another dispatch holding
                        // the same due snapshot must not run the skipped occurrence once the
                        // account reconnects.
                        set: { nextAt: following.value, revision },
                      }),
                    ).pipe(
                      Effect.withSpan("schedule.skip", {
                        attributes: {
                          "executor.schedule.id": setting.id,
                          "executor.app.id": setting.app,
                          ...("reconnectAccount" in waiting
                            ? {
                                "executor.account.id": waiting.reconnectAccount,
                                "executor.outcome": "waiting_for_reconnect",
                              }
                            : {
                                "executor.account.requirement": waiting.accountRequired,
                                "executor.outcome": "waiting_for_account",
                              }),
                        },
                      }),
                    );
                    return;
                  }
                }
                const id = ScheduledRunId.make(`run_${yield* uuid}`);
                const claim = yield* transaction(db, () =>
                  Effect.gen(function* () {
                    yield* lockApp(db, { app: setting.app });
                    yield* query(() =>
                      db.updateMany("schedules", {
                        where: (b) =>
                          b.and(
                            b("id", "=", setting.id),
                            b("revision", "=", setting.revision),
                            b("activeRun", "is", null),
                            b("enabled", "=", true),
                          ),
                        // Consume the scanned revision even after this run finishes, so another
                        // dispatch holding the same due snapshot cannot claim it a second time.
                        set: { activeRun: id, revision: id },
                      }),
                    );
                    const current = yield* readSettings(setting.id);
                    if (current.activeRun !== id) return null;
                    const run = StoredScheduledRun.make({
                      id,
                      scheduleId: setting.id,
                      app: setting.app,
                      owner: setting.owner,
                      name: setting.name,
                      status: "running",
                      scheduledAt,
                      startedAt: time,
                      finishedAt: null,
                      requestId: null,
                      expiresAt: null,
                      failure: null,
                      runner,
                      revision: id,
                      answer: null,
                    });
                    yield* query(() => db.create("scheduledRuns", run));
                    return run;
                  }),
                ).pipe(Effect.catchTags({ AppNotFound: () => retireMissingTarget(setting) }));
                if (claim === null) return;
                yield* Effect.gen(function* () {
                  const nextKnownAt = yield* nextOccurrence(setting.timing, yield* now);
                  yield* query(() =>
                    db.updateMany("schedules", {
                      where: (b) =>
                        b.and(
                          b("id", "=", setting.id),
                          b("activeRun", "=", claim.id),
                          b("revision", "=", claim.id),
                        ),
                      set: { nextAt: nextKnownAt },
                    }),
                  );
                  yield* authorize({ ...setting, phase: "start" });
                  const accounts = yield* accountsFor(setting);
                  const declared = yield* definition(setting);
                  const nextAt = yield* nextOccurrence(declared.timing, yield* now);
                  yield* query(() =>
                    db.updateMany("schedules", {
                      where: (b) =>
                        b.and(
                          b("id", "=", setting.id),
                          b("activeRun", "=", claim.id),
                          b("revision", "=", claim.id),
                        ),
                      set: { nextAt, timing: declared.timing },
                    }),
                  );
                  const response = yield* tools.call({
                    app: setting.app,
                    accounts,
                    tool: declared.tool,
                    // Schedules only target mutations; defineApp checks this.
                    kind: "mutation",
                    input: declared.input,
                  });
                  if (response.status === "completed") {
                    yield* response.toolError === true
                      ? finish(claim, "failed", "McpToolError")
                      : finish(claim, "succeeded");
                    return;
                  }
                  if (setting.approvalMode === "automatic") {
                    yield* authorize({ ...setting, phase: "resume" });
                    yield* complete(
                      claim,
                      yield* tools.resume({
                        requestId: response.requestId,
                        owner: setting.owner,
                        response: { action: "accept" },
                      }),
                    );
                  } else {
                    // Serialized with reconcile by the app lock: a schedule removed while this
                    // run started never leaves an approval waiting for review.
                    const waiting = yield* transaction(db, () =>
                      Effect.gen(function* () {
                        yield* lockApp(db, { app: setting.app });
                        const saved = yield* query(() =>
                          db.findFirst("schedules", {
                            select: ["id"],
                            where: (b) =>
                              b.and(b("id", "=", setting.id), b("activeRun", "=", claim.id)),
                          }),
                        );
                        if (saved === null) return false;
                        yield* query(() =>
                          db.updateMany("scheduledRuns", {
                            where: (b) =>
                              b.and(b("id", "=", claim.id), b("status", "=", "running")),
                            set: {
                              status: "awaiting-approval",
                              requestId: response.requestId,
                              expiresAt: new Date(response.expiresAt),
                            },
                          }),
                        );
                        return true;
                      }),
                    );
                    if (!waiting)
                      yield* complete(
                        claim,
                        yield* tools.resume({
                          requestId: response.requestId,
                          owner: setting.owner,
                          response: { action: "decline" },
                        }),
                      );
                  }
                }).pipe(
                  // The account's sign-in ended during this run. That is an account state the
                  // owner resolves by reconnecting, not a fault to report; later occurrences are
                  // skipped until then.
                  Effect.catchIf(Schema.is(OAuthReconnectRequired), () =>
                    Effect.annotateCurrentSpan(
                      "executor.schedule.skip_reason",
                      "account_reconnect",
                    ).pipe(Effect.andThen(finish(claim, "failed", "OAuthReconnectRequired"))),
                  ),
                  Effect.withErrorReporting,
                  Effect.catch((error) =>
                    Effect.gen(function* () {
                      // Removed/invalid declarations require an explicit re-enable. Other
                      // failures leave the next ordinary occurrence, with no automatic retry.
                      yield* query(() =>
                        db.updateMany("schedules", {
                          where: (b) =>
                            b.and(
                              b("id", "=", setting.id),
                              b("activeRun", "=", claim.id),
                              b("revision", "=", claim.id),
                              Schema.is(ScheduleNotFound)(error) ||
                                Schema.is(ScheduleInvalid)(error)
                                ? true
                                : b("nextAt", "<=", time),
                            ),
                          set: { enabled: false, nextAt: null },
                        }),
                      );
                      yield* finish(claim, "failed", diagnostic(error));
                    }),
                  ),
                  Effect.onInterrupt(() => finish(claim, "interrupted", "Interrupted")),
                  // Every account the run resolves is checked against the saved actor; an app
                  // schedule has none and runs with the app's accounts.
                  Effect.provideService(CurrentActor, setting.actor ?? undefined),
                  Effect.provideService(InvocationRun, claim.id),
                  Effect.withSpan("schedule.run", {
                    attributes: {
                      "executor.run.id": claim.id,
                      "executor.schedule.id": claim.scheduleId,
                      "executor.app.id": claim.app,
                      "executor.attempt.id": globalThis.crypto.randomUUID(),
                      "executor.schedule.lateness_ms": Math.max(
                        0,
                        time.getTime() - claim.scheduledAt.getTime(),
                      ),
                    },
                  }),
                );
              }).pipe(Effect.catchTag("ScheduleNotFound", () => Effect.void)),
            ),
          { concurrency: "unbounded" },
        );
      }),
  };
  /** Reconcile the app's schedules after an activation. */
  return { operations, dispatcher, activated: reconcile };
};
