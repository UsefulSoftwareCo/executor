import {
  AccountId,
  AppId,
  Json,
  OwnerId,
  ScheduleId,
  StorageError,
  StorageHost,
  type App,
  type Executor,
} from "@executor-js/sdk/core";
import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { DataStep, DataStepMode } from "../contracts/data-steps.ts";

const Plan = Schema.Struct({
  id: AppId,
  app: AppId,
  owner: OwnerId,
  subject: Schema.String,
  label: Schema.String,
  accounts: Schema.Array(AccountId),
  webhookConfig: Json,
  enable: Schema.Array(ScheduleId),
});
type Plan = typeof Plan.Type;

export interface ProfileAppCopiesHost {
  readonly executor: Executor;
  readonly appCopies: {
    readonly copy: (input: {
      readonly from: App;
      readonly id: AppId;
      readonly name: string;
      readonly save: boolean;
    }) => Effect.Effect<App, unknown, SqlClient.SqlClient>;
    readonly link: (input: {
      readonly app: AppId;
      readonly subject: string;
      readonly links: ReadonlyArray<{ readonly requirement: string; readonly account: AccountId }>;
      readonly webhookConfig: Json;
    }) => Effect.Effect<void, StorageError, SqlClient.SqlClient>;
  };
}

export const profileAppCopiesStepName = "10_profile_app_copies";

const nameLimit = 120;
const copyName = (app: string, label: string, attempt: number) => {
  const suffix = ` (${label.slice(0, 40).trim()})${attempt === 1 ? "" : ` ${attempt}`}`;
  return `${app.slice(0, nameLimit - suffix.length).trimEnd()}${suffix}`;
};
const attempts = 50;

const taken = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  (error._tag === "AppNameTaken" || error._tag === "AppSlugTaken");
const buildFailed = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "VersionBuildFailed";

const copyApp = (host: ProfileAppCopiesHost, from: App, plan: Plan, save: boolean) =>
  Effect.gen(function* () {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const result = yield* host.appCopies
        .copy({ from, id: plan.id, name: copyName(from.name, plan.label, attempt), save })
        .pipe(Effect.result);
      if (result._tag === "Success") return result.success;
      if (!taken(result.failure)) return yield* Effect.fail(result.failure);
    }
    return yield* Effect.fail({ _tag: "AppNameTaken" as const });
  });

const ScheduleName = Schema.Array(Schema.Struct({ name: Schema.String }));

const transient = (error: { readonly _tag: string }) =>
  error._tag === "StorageError" || error._tag === "CredentialsError";

const handle = (host: ProfileAppCopiesHost, plan: Plan, mode: DataStepMode) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const find = (app: AppId) =>
      host.executor.apps.get({ app }).pipe(
        Effect.map(Option.some),
        Effect.catchTag("AppNotFound", () => Effect.succeed(Option.none<App>())),
      );
    const existing = yield* find(plan.id);
    const original = Option.isSome(existing) ? Option.none<App>() : yield* find(plan.app);
    if (Option.isNone(existing) && Option.isNone(original)) {
      if (mode === "apply")
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`delete from executor_scheduled_runs where app = ${plan.id}`;
            yield* sql`delete from executor_schedules where app = ${plan.id}`;
            yield* sql`update executor_profile_app_copies set status = 'cancelled'
              where id = ${plan.id}`;
          }),
        );
      return "app-removed";
    }
    if (mode === "report") return Option.isSome(existing) ? "copy-exists" : "copy";
    let outcome =
      Option.isSome(existing) && existing.value.activeVersion === null
        ? "copied-undeployed"
        : "copied";
    if (Option.isSome(original)) {
      const deployed = yield* copyApp(host, original.value, plan, false).pipe(Effect.result);
      if (deployed._tag === "Failure") {
        if (!buildFailed(deployed.failure)) return yield* Effect.fail(deployed.failure);
        yield* copyApp(host, original.value, plan, true);
        outcome = "copied-undeployed";
      }
    }
    yield* host.appCopies.link({
      app: plan.id,
      subject: plan.subject,
      links: yield* planLinks(plan),
      webhookConfig: plan.webhookConfig,
    });
    const handled = (copy: ScheduleId) =>
      sql`update executor_profile_app_copies set enable = coalesce((
          select json_agg(e.id order by e.ord)
            from json_array_elements_text(enable::json) with ordinality e(id, ord)
            where e.id <> ${copy}
        ), '[]'::json) where id = ${plan.id}`.pipe(Effect.mapError(() => new StorageError()));
    const refused: Array<{ readonly schedule: ScheduleId; readonly failure: string }> = [];
    for (const copy of plan.enable) {
      const [schedule] = yield* sql`select name from executor_schedules
        where id = ${copy} and app = ${plan.id}`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ScheduleName)),
      );
      if (schedule === undefined) continue;
      const resumed = yield* host.executor[StorageHost]
        .transaction(
          host.executor.schedules
            .update({ app: plan.id, name: schedule.name, copy, enabled: true })
            .pipe(Effect.tap(() => handled(copy))),
        )
        .pipe(Effect.result);
      if (resumed._tag === "Success") continue;
      if (transient(resumed.failure)) return yield* Effect.fail(resumed.failure);
      yield* handled(copy);
      refused.push({ schedule: copy, failure: resumed.failure._tag });
    }
    if (refused.length > 0) {
      yield* Effect.logWarning("Profile app copy left schedules paused", {
        plan: plan.id,
        refused,
      });
      if (outcome === "copied") outcome = "copied-paused";
    }
    yield* sql`update executor_profile_app_copies set status = 'copied' where id = ${plan.id}`;
    return outcome;
  });

const PlanLink = Schema.Struct({ requirement: Schema.NonEmptyString, account: AccountId });
const planLinks = (plan: Plan) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const selected = yield* sql`select distinct selected.requirement, selected.account from (
        select b.key as requirement, a.id as account,
          row_number() over (partition by i.id, b.key order by e.ord) as position,
          case when d.requirements is null then jsonb_typeof(b.value) = 'string'
            else d.requirements::jsonb -> 'accounts' -> b.key ->> 'cardinality' = 'one' end
            as plain
        from executor_profile_app_copies c
        cross join lateral jsonb_array_elements_text(c.profiles::jsonb) listed(id)
        join executor_installations i on i.id = listed.id
        left join executor_apps app on app.id = c.app
        left join executor_deployments d on d.id = app.active_deployment
        cross join lateral jsonb_each(i.accounts::jsonb) b
        cross join lateral jsonb_array_elements_text(case jsonb_typeof(b.value)
            when 'array' then b.value
            when 'string' then jsonb_build_array(b.value)
            else '[]'::jsonb end) with ordinality e(account, ord)
        join executor_accounts a on a.id = e.account
        where c.id = ${plan.id} and i.enabled and i.status not in ('removing', 'removed')
      ) selected where selected.plain is not true or selected.position = 1`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(PlanLink))),
    );
    return plan.accounts.flatMap((account) =>
      selected
        .filter((link) => link.account === account)
        .sort((a, b) => a.requirement.localeCompare(b.requirement)),
    );
  });

const Plans = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    app: Schema.String,
    owner: Schema.String,
    subject: Schema.String,
    label: Schema.String,
    accounts: Schema.Unknown,
    webhookConfig: Schema.Unknown,
    enable: Schema.Unknown,
  }),
);

const retry = "retry";

export const profileAppCopiesStep = (
  host: ProfileAppCopiesHost,
  name: string,
): DataStep<SqlClient.SqlClient> => ({
  name,
  retry: [retry],
  items: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`select id, app, owner, subject, label, accounts,
        webhook_config as "webhookConfig", enable
      from executor_profile_app_copies where status = 'pending' order by id`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Plans)),
    );
    return rows.map((row) => ({
      id: row.id,
      owner: row.owner,
      run: (mode: DataStepMode) =>
        Schema.decodeUnknownEffect(Plan)(row).pipe(
          Effect.flatMap((plan) => handle(host, plan, mode)),
          Effect.catch((error) =>
            Effect.logWarning("Profile app copy retries", {
              plan: row.id,
              failure:
                typeof error === "object" && error !== null && "_tag" in error
                  ? String(error._tag)
                  : "unknown",
            }).pipe(Effect.as(retry)),
          ),
        ),
    }));
  }),
});
