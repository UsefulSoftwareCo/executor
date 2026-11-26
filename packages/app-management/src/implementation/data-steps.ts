import { Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import {
  DataStepProgressUnrecorded,
  DataStepUnavailable,
  dataStepLogPrefix,
  dataStepPaused,
  type DataStep,
  type DataStepJournal,
  type DataStepMode,
  type DataStepRun,
  type DataStepSummary,
} from "../contracts/data-steps.ts";

export const createDataStepJournal = (journal: DataStepJournal) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
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
  readonly report: string;
  readonly exclusive: boolean;
  readonly deadline?: number;
}

const retryBaseSeconds = 30;
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
const Held = Schema.Array(Schema.Struct({ held: Schema.Boolean }));
const Count = Schema.Array(Schema.Struct({ count: Schema.Number }));
const Items = Schema.Array(Schema.Struct({ item: Schema.String }));
const Outcomes = Schema.Array(Schema.Struct({ outcome: Schema.String }));
const Counts = Schema.Array(
  Schema.Struct({ owner: Schema.String, outcome: Schema.String, count: Schema.Number }),
);

export const runDataSteps = <R>(
  steps: ReadonlyArray<DataStep<R>>,
  options: DataStepRunOptions,
): Effect.Effect<DataStepRun, DataStepUnavailable, R | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journal = sql(`${options.journal}_data_steps`);
    const outcomes = sql(`${options.journal}_data_step_items`);
    const report = `report:${options.report}`;
    let attempted = 0;
    let failed = 0;

    const advance = (step: DataStep<R>) =>
      Effect.gen(function* () {
        const applyRun = step.applyRun ?? "apply";
        const run = options.mode === "apply" ? applyRun : report;
        const completed = (candidate: string) =>
          sql`select completed_at is not null as completed from ${journal}
            where name = ${step.name} and run = ${candidate}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Completed)),
            Effect.map((rows) => rows[0]?.completed === true),
          );
        if (
          options.mode === "report" &&
          step.reportsAfterApply !== true &&
          (yield* completed(applyRun))
        )
          return "complete" as const;
        yield* sql`insert into ${journal} (name, run, mode)
          values (${step.name}, ${run}, ${options.mode}) on conflict do nothing`;
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
        const revisit =
          pass === 1 ? undefined : new Set((yield* retryItems).map((row) => row.item));
        const held = sql`select coalesce(retry_at > now(), false) as held from ${journal}
          where name = ${step.name} and run = ${run}`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Held)),
          Effect.map((rows) => rows[0]?.held === true),
        );
        const exhausted =
          step.exhausted !== undefined && pass >= step.exhausted.passes
            ? step.exhausted.outcomes
            : undefined;
        for (const item of items) {
          if (revisit !== undefined && !revisit.has(item.id)) continue;
          if (cursor !== null && item.id <= cursor) continue;
          const stop =
            (options.deadline !== undefined &&
              (yield* Clock.currentTimeMillis) >= options.deadline) ||
            (step.more !== undefined && !(yield* step.more)) ||
            (!options.exclusive && (yield* held));
          if (stop) {
            yield* release;
            yield* Effect.annotateCurrentSpan("data_step.status", "pending");
            return "pending" as const;
          }
          const previous = (yield* sql`select item.outcome from ${outcomes} item
            join ${journal} run on run.name = item.name and run.run = item.run
            where item.name = ${step.name} and item.item = ${item.id}
              and (item.run = ${run} or (${options.mode === "apply"} and run.mode = 'apply'))
            order by item.run = ${run} desc, run.started_at desc limit 1`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Outcomes)),
          ))[0]?.outcome;
          const record = (progress: string) =>
            options.mode !== "apply" || !step.retry.includes(progress)
              ? Effect.die(`Data step ${step.name} recorded ${progress} outside an apply retry`)
              : sql`insert into ${outcomes} (name, run, item, owner, outcome, pass)
                  values (${step.name}, ${run}, ${item.id}, ${item.owner}, ${progress}, ${pass})
                  on conflict (name, run, item) do update set outcome = excluded.outcome, pass = excluded.pass`.pipe(
                  Effect.asVoid,
                  Effect.mapError(() => new DataStepProgressUnrecorded()),
                );
          const count = (counted: ReadonlyArray<string>) =>
            sql`select count(*)::integer as count from ${outcomes}
              where name = ${step.name} and run = ${run} and ${sql.in("outcome", [...counted])}`.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Count)),
              Effect.map((rows) => rows[0]?.count ?? 0),
              Effect.mapError(() => new DataStepUnavailable({ step: step.name })),
            );
          const handled = yield* item.run(options.mode, { previous, record, count });
          if (handled === dataStepPaused) {
            yield* release;
            yield* Effect.annotateCurrentSpan("data_step.status", "pending");
            return "pending" as const;
          }
          const outcome = exhausted?.[handled] ?? handled;
          if (outcome !== handled)
            yield* Effect.logWarning("Data step item gave up retrying", {
              step: step.name,
              item: item.id,
              pass,
              outcome: handled,
            });
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
          attempted += 1;
          if (step.retry.includes(outcome) && !step.expected?.includes(outcome)) failed += 1;
        }

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
              retry_at = greatest(retry_at, now() + make_interval(secs => ${retryDelaySeconds(pass)}))
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
        Effect.tapCause((cause) => Effect.logError("Data step unavailable", step.name, cause)),
        Effect.mapError(() => new DataStepUnavailable({ step: step.name })),
        Effect.withSpan("data_step.advance", {
          attributes: { "data_step.name": step.name, "data_step.mode": options.mode },
        }),
      );

    for (const step of steps)
      if ((yield* advance(step)) === "pending") return { status: "pending", attempted, failed };
    return { status: "complete", attempted, failed };
  });
