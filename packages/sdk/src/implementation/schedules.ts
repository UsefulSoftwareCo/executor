/** Persisted scheduling transitions. App code and external effects run only after a claim commits. */
import { Clock, Cron, Effect, Result, Schema, SchemaAST, type Crypto } from "effect";
import { ScheduleTiming } from "apps/contracts";
import type { Executor } from "../contracts/executor.ts";
import { Cursor, StorageError, RequestInvalid, type OwnerId } from "../contracts/shared.ts";
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
import { ScheduleObservation } from "../contracts/scheduler.ts";
import type { ScheduleDispatcher } from "../contracts/scheduler.ts";
import type { Credentials } from "../contracts/storage.ts";
import type { ExecutorDatabase } from "./storage.ts";
import { database, query, transaction } from "./database.ts";
import { lockApp } from "./apps.ts";
import { storedProfile } from "./profiles.ts";
import { makeToolApprovals } from "./tool-approvals.ts";

const terminal = (status: ScheduledRun["status"]) =>
  !["running", "ready", "awaiting-approval"].includes(status);
const diagnostic = (error: unknown) =>
  error instanceof Error && Schema.isSchema(error.constructor)
    ? (SchemaAST.resolveIdentifier(error.constructor.ast) ?? "ExecutionFailed")
    : "ExecutionFailed";
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
  tools: Pick<Executor["tools"], "list" | "call" | "resume">,
  credentials: Credentials,
  crypto: Crypto.Crypto,
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
  const definitions = (input: typeof ScheduleInputs.list.Type) =>
    Effect.gen(function* () {
      yield* apps.get(input);
      const saved = yield* query(() =>
        db.findMany("schedules", {
          where: (b) =>
            b.and(
              b("app", "=", input.app),
              input.profile === undefined
                ? b("profile", "is", null)
                : b("profile", "=", input.profile),
            ),
        }),
      );
      const settings = yield* parse(Schema.Array(ScheduleSettings), saved);
      const results: AppSchedule[] = [];
      let cursor: Cursor | undefined;
      do {
        const page = yield* tools.list({
          app: input.app,
          profile: input.profile,
          cursor,
        });
        for (const tool of page.items)
          for (const schedule of tool.schedules ?? []) {
            results.push({
              ...schedule,
              app: input.app,
              tool: tool.name,
              settings: settings.find((setting) => setting.name === schedule.name) ?? null,
            });
          }
        cursor = page.next;
      } while (cursor !== undefined);
      return results.sort((left, right) => left.name.localeCompare(right.name));
    });
  const definition = (input: typeof ScheduleInputs.runNow.Type) =>
    definitions(input).pipe(
      Effect.flatMap((items) => {
        const found = items.find((item) => item.name === input.name);
        return found === undefined ? Effect.fail(new ScheduleNotFound()) : Effect.succeed(found);
      }),
    );
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
          const settings = yield* readSettings(run.scheduleId);
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
          return {
            id: run.id,
            scheduleId: run.scheduleId,
            app: run.app,
            owner: run.owner,
            status,
            startedAt: run.startedAt,
            finishedAt,
          };
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
  const getApproval = (input: typeof ScheduleInputs.approval.Type) =>
    Effect.gen(function* () {
      const run = yield* readRun(input.run, input.owner);
      yield* apps.get({ app: run.app, owner: input.owner });
      if (run.status !== "awaiting-approval" || run.requestId === null)
        return yield* new ScheduleNotFound();
      const pending = yield* approvals
        .get(run.requestId, run.owner)
        .pipe(Effect.catchTag("ToolApprovalNotFound", () => new ScheduleNotFound()));
      return { run: publicRun(run), ...pending };
    });
  const operations = {
    definitions: (input: typeof ScheduleInputs.definitions.Type) => definitions(input),
    list: (input: typeof ScheduleInputs.list.Type) =>
      Effect.gen(function* () {
        yield* apps.get(input);
        const rows = yield* query(() =>
          db.findMany("schedules", {
            where: (b) =>
              b.and(
                b("app", "=", input.app),
                input.profile === undefined
                  ? b("profile", "is", null)
                  : b("profile", "=", input.profile),
              ),
          }),
        );
        return yield* parse(Schema.Array(ScheduleSettings), rows);
      }),
    configure: (input: typeof ScheduleInputs.configure.Type) =>
      Effect.gen(function* () {
        const parsed = yield* Schema.decodeUnknownEffect(ScheduleInputs.configure)(input).pipe(
          Effect.mapError(() => new RequestInvalid()),
        );
        const app = yield* apps.get(parsed);
        if (parsed.profile !== undefined) {
          const profile = yield* storedProfile(db, {
            app: app.id,
            profile: parsed.profile,
            owner: app.owner,
          });
          if (profile.subject !== parsed.actor) return yield* new ScheduleConflict();
        }
        const saved = yield* query(() =>
          db.findFirst("schedules", {
            where: (b) =>
              b.and(
                b("app", "=", app.id),
                b("name", "=", parsed.name),
                parsed.profile === undefined
                  ? b("profile", "is", null)
                  : b("profile", "=", parsed.profile),
              ),
          }),
        );
        // Pausing saved work never depends on evaluating broken app code or refreshing a revoked account.
        const timing =
          !parsed.enabled && saved !== null
            ? (yield* parse(ScheduleSettings, saved)).timing
            : (yield* definition(parsed)).timing;
        const nextAt = parsed.enabled ? yield* nextOccurrence(timing, yield* now) : null;
        const revision = yield* uuid;
        const settings = yield* transaction(db, () =>
          Effect.gen(function* () {
            yield* lockApp(db, { app: app.id });
            if (parsed.profile !== undefined) {
              const profile = yield* storedProfile(db, {
                app: app.id,
                profile: parsed.profile,
              });
              if (
                (parsed.enabled &&
                  (!profile.enabled ||
                    profile.status === "removing" ||
                    profile.status === "removed")) ||
                (parsed.expectedProfileRevision !== undefined &&
                  profile.revision !== parsed.expectedProfileRevision)
              )
                return yield* new ScheduleConflict();
            }
            const row = yield* query(() =>
              db.findFirst("schedules", {
                where: (b) =>
                  b.and(
                    b("app", "=", app.id),
                    b("name", "=", parsed.name),
                    parsed.profile === undefined
                      ? b("profile", "is", null)
                      : b("profile", "=", parsed.profile),
                  ),
              }),
            );
            if (row === null) {
              const created = ScheduleSettings.make({
                id: ScheduleId.make(`sch_${revision}`),
                app: app.id,
                profile: parsed.profile ?? null,
                owner: app.owner,
                name: parsed.name,
                actor: parsed.actor,
                timing,
                enabled: parsed.enabled,
                approvalMode: parsed.approvalMode ?? "automatic",
                nextAt,
                activeRun: null,
                revision,
              });
              yield* query(() => db.create("schedules", created));
              return created;
            } else {
              const previous = yield* parse(ScheduleSettings, row);
              yield* query(() =>
                db.updateMany("schedules", {
                  where: (b) =>
                    b.and(b("id", "=", previous.id), b("revision", "=", previous.revision)),
                  set: {
                    actor: parsed.actor,
                    timing,
                    enabled: parsed.enabled,
                    approvalMode: parsed.approvalMode ?? previous.approvalMode,
                    nextAt:
                      parsed.enabled &&
                      previous.enabled &&
                      Schema.toEquivalence(ScheduleTiming)(timing, previous.timing)
                        ? previous.nextAt
                        : nextAt,
                    revision,
                  },
                }),
              );
              const current = yield* readSettings(previous.id);
              if (current.revision !== revision) return yield* new ScheduleConflict();
              return current;
            }
          }),
        );
        return settings;
      }),
    runNow: (input: typeof ScheduleInputs.runNow.Type) =>
      Effect.gen(function* () {
        const declared = yield* definition(input);
        if (declared.settings === null) return yield* new ScheduleNotFound();
        if (!declared.settings.enabled || declared.settings.activeRun !== null)
          return yield* new ScheduleConflict();
        const { id, revision: expectedRevision } = declared.settings;
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
    runs: (input: typeof ScheduleInputs.runs.Type = {}) =>
      query(() =>
        db.findMany("scheduledRuns", {
          where: (b) =>
            b.and(
              input.owner === undefined ? true : b("owner", "=", input.owner),
              input.app === undefined ? true : b("app", "=", input.app),
              input.profile === undefined ? true : b("profile", "=", input.profile),
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
        return finish(run, result.reason === "expired" ? "expired" : "failed", result.reason);
    }
  };
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
          where: (b) => b.and(b("enabled", "=", true), b("activeRun", "is", null)),
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
                  const response = yield* tools.resume({
                    requestId,
                    owner: pending.owner,
                    response: { action: answer },
                  });
                  yield* complete(claim, response);
                }).pipe(
                  Effect.withErrorReporting,
                  Effect.catch((error) => finish(claim, "failed", diagnostic(error))),
                  Effect.onInterrupt(() => finish(claim, "interrupted", "Interrupted")),
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
        const activeProfiles = yield* query(() =>
          db.findMany("profiles", {
            select: ["id"],
            where: (b) =>
              b.and(
                b("enabled", "=", true),
                b("status", "!=", "removing"),
                b("status", "!=", "removed"),
              ),
          }),
        );
        const due = yield* query(() =>
          db.findMany("schedules", {
            limit: maxCandidates,
            where: (b) =>
              b.and(
                b("enabled", "=", true),
                b("activeRun", "is", null),
                b("nextAt", "<=", time),
                b.or(
                  b("profile", "is", null),
                  b(
                    "profile",
                    "in",
                    activeProfiles.map((item) => item.id),
                  ),
                ),
              ),
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
                const id = ScheduledRunId.make(`run_${yield* uuid}`);
                const claim = yield* transaction(db, () =>
                  Effect.gen(function* () {
                    yield* lockApp(db, { app: setting.app });
                    if (setting.profile !== null) {
                      const profile = yield* storedProfile(db, {
                        app: setting.app,
                        profile: setting.profile,
                      });
                      if (
                        !profile.enabled ||
                        profile.status === "removing" ||
                        profile.status === "removed"
                      )
                        return null;
                    }
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
                      profile: setting.profile,
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
                ).pipe(
                  Effect.catchTags({
                    AppNotFound: () => Effect.succeed(null),
                    ProfileNotFound: () => Effect.succeed(null),
                  }),
                );
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
                  const declared = yield* definition({
                    app: setting.app,
                    profile: setting.profile ?? undefined,
                    owner: setting.owner,
                    name: setting.name,
                  });
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
                    profile: setting.profile ?? undefined,
                    tool: declared.tool,
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
                    yield* query(() =>
                      db.updateMany("scheduledRuns", {
                        where: (b) => b.and(b("id", "=", claim.id), b("status", "=", "running")),
                        set: {
                          status: "awaiting-approval",
                          requestId: response.requestId,
                          expiresAt: new Date(response.expiresAt),
                        },
                      }),
                    );
                  }
                }).pipe(
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
  return { operations, dispatcher };
};
