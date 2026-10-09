/**
 * Run pending data steps in order against a SQL journal. A pass walks a step's items in ID order,
 * records each outcome and a cursor as it goes, so an interrupted pass resumes after the last
 * recorded item. Items are handled one at a time and must be safe to handle again. When a pass
 * ends with retry outcomes, the next run starts another pass over only those items; a step is
 * complete once a pass has none. Later steps wait for earlier ones, as schema migrations do.
 *
 * Background runs back off between retry passes: each retrying pass records when the next may
 * start, doubling with the pass number up to an hour. Startup runs retry at the next start.
 */
import { Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import {
  DataStepUnavailable,
  dataStepLogPrefix,
  type DataStep,
  type DataStepJournal,
  type DataStepMode,
  type DataStepSummary,
} from "../contracts/data-steps.ts";

/** Create both journal tables. Each product records this once among its schema migrations. */
export const createDataStepJournal = (journal: DataStepJournal) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // One row per step run: `apply`, or `report:<label>` for each separately labelled report.
    yield* sql`create table if not exists ${sql(`${journal}_data_steps`)} (
      name text not null,
      run text not null,
      mode text not null check (mode in ('report', 'apply')),
      pass integer not null default 1,
      cursor text,
      lease_until timestamp with time zone,
      retry_at timestamp with time zone,
      started_at timestamp with time zone not null default now(),
      completed_at timestamp with time zone,
      primary key (name, run)
    )`;
    // The latest outcome of each item in a run. IDs only; no names or content.
    yield* sql`create table if not exists ${sql(`${journal}_data_step_items`)} (
      name text not null,
      run text not null,
      item text not null,
      owner text not null,
      outcome text not null,
      pass integer not null,
      primary key (name, run, item)
    )`;
  });

export interface DataStepRunOptions {
  readonly journal: DataStepJournal;
  readonly mode: DataStepMode;
  /**
   * Report runs with the same label share one record and resume from its cursor, including across
   * processes and deploys. Cloud keeps one label across deploys; startup labels each start.
   */
  readonly report: string;
  /**
   * Startup holds the host exclusively, so it resumes a run whose lease an earlier crashed process
   * left behind. Background runs only take an expired or released lease.
   */
  readonly exclusive: boolean;
  /** Epoch milliseconds after which no further item starts. Omit to run until done. */
  readonly deadline?: number;
}

/** The wait before a background run's next retry pass: 30 seconds after pass 1, then doubling. */
const retryBaseSeconds = 30;
/** However often a step keeps failing, a background run retries it at least hourly. */
const retryCapSeconds = 60 * 60;
const retryDelaySeconds = (pass: number) =>
  Math.min(retryCapSeconds, retryBaseSeconds * 2 ** (pass - 1));

const Claim = Schema.Array(
  Schema.Struct({ pass: Schema.Int, cursor: Schema.NullOr(Schema.String) }),
);
const Completed = Schema.Array(Schema.Struct({ completed: Schema.Boolean }));
const Unclaimed = Schema.Array(
  Schema.Struct({ completed: Schema.Boolean, retryAt: Schema.NullOr(Schema.String) }),
);
const Retry = Schema.Array(Schema.Struct({ retryAt: Schema.String }));
const Items = Schema.Array(Schema.Struct({ item: Schema.String }));
const Counts = Schema.Array(
  Schema.Struct({ owner: Schema.String, outcome: Schema.String, count: Schema.Number }),
);

/**
 * Advance every pending step, in order. Returns `pending` when a step still has work, because the
 * deadline passed, another process holds its lease, or its last pass left items to retry.
 */
export const runDataSteps = <R>(steps: ReadonlyArray<DataStep<R>>, options: DataStepRunOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journal = sql(`${options.journal}_data_steps`);
    const outcomes = sql(`${options.journal}_data_step_items`);
    const run = options.mode === "apply" ? "apply" : `report:${options.report}`;

    const advance = (step: DataStep<R>) =>
      Effect.gen(function* () {
        const completed = (candidate: string) =>
          sql`select completed_at is not null as completed from ${journal}
            where name = ${step.name} and run = ${candidate}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Completed)),
            Effect.map((rows) => rows[0]?.completed === true),
          );
        // An applied step has nothing left to report, unless its report checks the applied result.
        if (
          options.mode === "report" &&
          step.reportsAfterApply !== true &&
          (yield* completed("apply"))
        )
          return "complete" as const;
        yield* sql`insert into ${journal} (name, run, mode)
          values (${step.name}, ${run}, ${options.mode}) on conflict do nothing`;
        // A background run waits for the lease and, before a retry pass, for its backoff.
        const claimed = yield* sql`update ${journal} set lease_until = now() + interval '15 minutes'
          where name = ${step.name} and run = ${run} and completed_at is null
          and (${options.exclusive} or ((lease_until is null or lease_until < now())
            and (retry_at is null or retry_at <= now())))
          returning pass, cursor`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Claim)));
        const claim = claimed[0];
        if (claim === undefined) {
          const [state] = yield* sql`select completed_at is not null as completed,
            case when retry_at > now() then to_json(retry_at) #>> '{}' end as "retryAt"
            from ${journal} where name = ${step.name} and run = ${run}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Unclaimed)),
          );
          if (state?.completed === true) {
            yield* Effect.annotateCurrentSpan("data_step.status", "complete");
            return "complete" as const;
          }
          yield* Effect.annotateCurrentSpan(
            state?.retryAt === null || state?.retryAt === undefined
              ? { "data_step.status": "leased" }
              : { "data_step.status": "waiting", "data_step.retry_at": state.retryAt },
          );
          return "pending" as const;
        }
        const release = sql`update ${journal} set lease_until = null
          where name = ${step.name} and run = ${run}`;
        const pass = claim.pass;
        let cursor = claim.cursor;

        const items = (yield* step.items).toSorted((left, right) =>
          left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
        );
        const retryItems = sql`select item from ${outcomes} where name = ${step.name}
          and run = ${run} and ${sql.in("outcome", [...step.retry])}`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Items)),
        );
        // Later passes revisit only the items the previous pass left to retry.
        const revisit =
          pass === 1 ? undefined : new Set((yield* retryItems).map((row) => row.item));
        for (const item of items) {
          if (revisit !== undefined && !revisit.has(item.id)) continue;
          if (cursor !== null && item.id <= cursor) continue;
          if (
            options.deadline !== undefined &&
            (yield* Clock.currentTimeMillis) >= options.deadline
          ) {
            yield* release;
            yield* Effect.annotateCurrentSpan("data_step.status", "pending");
            return "pending" as const;
          }
          const outcome = yield* item.run(options.mode);
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`insert into ${outcomes} (name, run, item, owner, outcome, pass)
                values (${step.name}, ${run}, ${item.id}, ${item.owner}, ${outcome}, ${pass})
                on conflict (name, run, item) do update set outcome = excluded.outcome, pass = excluded.pass`;
              yield* sql`update ${journal} set cursor = ${item.id}
                where name = ${step.name} and run = ${run}`;
            }),
          );
          cursor = item.id;
        }

        // Items removed since an earlier pass cannot be retried; they no longer need the step.
        const present = new Set(items.map((item) => item.id));
        const removed = (yield* retryItems).filter((row) => !present.has(row.item));
        if (removed.length > 0)
          yield* sql`update ${outcomes} set outcome = 'removed', pass = ${pass}
            where name = ${step.name} and run = ${run} and ${sql.in(
              "item",
              removed.map((row) => row.item),
            )}`;
        const counts = yield* sql`select owner, outcome, count(*)::integer as count from ${outcomes}
          where name = ${step.name} and run = ${run} group by owner, outcome order by owner, outcome`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Counts)),
        );
        const retrying = counts.some((row) => step.retry.includes(row.outcome));
        const retryAt = retrying
          ? (yield* sql`update ${journal} set pass = ${pass + 1}, cursor = null, lease_until = null,
              retry_at = now() + make_interval(secs => ${retryDelaySeconds(pass)})
              where name = ${step.name} and run = ${run}
              returning to_json(retry_at) #>> '{}' as "retryAt"`.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Retry)),
            ))[0]?.retryAt
          : undefined;
        if (!retrying)
          yield* sql`update ${journal} set completed_at = now(), lease_until = null, retry_at = null
            where name = ${step.name} and run = ${run}`;
        const totals: Record<string, number> = {};
        const owners: Record<string, Record<string, number>> = {};
        for (const row of counts) {
          totals[row.outcome] = (totals[row.outcome] ?? 0) + row.count;
          owners[row.owner] = { ...owners[row.owner], [row.outcome]: row.count };
        }
        const summary: DataStepSummary = {
          step: step.name,
          mode: options.mode,
          run,
          pass,
          status: retrying ? "retrying" : "complete",
          ...(retryAt === undefined ? {} : { retryAt }),
          outcomes: totals,
          owners,
        };
        yield* Effect.annotateCurrentSpan("data_step.status", summary.status);
        yield* Effect.log(`${dataStepLogPrefix}${JSON.stringify(summary)}`);
        return retrying ? ("pending" as const) : ("complete" as const);
      }).pipe(
        // The cause can carry driver detail, so it stays in host logs; callers see the step.
        Effect.tapCause((cause) => Effect.logError("Data step unavailable", step.name, cause)),
        Effect.mapError(() => new DataStepUnavailable({ step: step.name })),
        Effect.withSpan("data_step.advance", {
          attributes: { "data_step.name": step.name, "data_step.mode": options.mode },
        }),
      );

    for (const step of steps) if ((yield* advance(step)) === "pending") return "pending" as const;
    return "complete" as const;
  });
