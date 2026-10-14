/**
 * `10_profile_app_copies` creates the app copies SDK storage 4.0.13 planned when it removed
 * profiles. A member whose profiles of one app used different accounts for a plain requirement kept
 * the app for one account set; each other set gets a copy of the app, with the same owner, source
 * and access, named after its profile: "GitHub ticker (Personal)". The copy links that set's
 * accounts for the member only and resumes the profile's schedules, which waited paused under the
 * copy's reserved ID. Its database starts empty: app data is kept per app, not per profile.
 *
 * Each plan is one item and safe to handle again: a copy that already has its reserved ID is not
 * made twice, links already made are kept, and each schedule is resumed at most once: the plan
 * drops a schedule from `enable` in the transaction that resumes it, or once its resume is refused,
 * so a later pass neither postpones a resumed schedule's next run nor undoes a member's pause of
 * it. A plan is marked copied only once its links are saved and each schedule was resumed or
 * refused; any other failure leaves it pending for a later pass. A copy whose deployment no longer builds is saved
 * undeployed, its schedules still paused, so a build failure never holds later steps; its links
 * are saved all the same, for when it is deployed. When the app was removed before its copy, the
 * schedules that waited for the copy are removed with their history, as removing the app would
 * have.
 */
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

/** One planned copy, as 4.0.13 wrote it. */
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

/** What a host does for a copy beyond the SDK: who may use it, and the member's links. */
export interface ProfileAppCopiesHost {
  readonly executor: Executor;
  readonly appCopies: {
    /**
     * Copy `from` under `id`, owned and shared exactly as `from` is: the same owner, and in hosted
     * the same audience and groups, never wider. `save` keeps the source undeployed.
     */
    readonly copy: (input: {
      readonly from: App;
      readonly id: AppId;
      readonly name: string;
      readonly save: boolean;
    }) => Effect.Effect<App, unknown, SqlClient.SqlClient>;
    /**
     * Link each account to its requirement on the copy for `subject` in this order, oldest first,
     * as their profiles selected them, skipping accounts that are gone and a subject that no longer
     * exists. Links are saved whether or not the copy is deployed, as the host's own profile
     * conversion saves them: a copy saved undeployed, which declares no requirements yet, keeps
     * them for when it is deployed. The first link of an account makes it a webhook source with
     * `webhookConfig`. Linking again changes nothing.
     */
    readonly link: (input: {
      readonly app: AppId;
      readonly subject: string;
      readonly links: ReadonlyArray<{ readonly requirement: string; readonly account: AccountId }>;
      readonly webhookConfig: Json;
    }) => Effect.Effect<void, StorageError, SqlClient.SqlClient>;
  };
}

export const profileAppCopiesStepName = "10_profile_app_copies";

/** App names are at most 120 characters; the profile part is kept short enough to read. */
const nameLimit = 120;
const copyName = (app: string, label: string, attempt: number) => {
  const suffix = ` (${label.slice(0, 40).trim()})${attempt === 1 ? "" : ` ${attempt}`}`;
  return `${app.slice(0, nameLimit - suffix.length).trimEnd()}${suffix}`;
};
/** Names already taken get a number; a long run of taken names is not worth walking. */
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
  error._tag === "DeploymentBuildFailed";

/** The plan's copy under the first free name. */
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

/**
 * A resume that failed reading or writing saved state, not because the schedule cannot run: a
 * later pass tries it again.
 */
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
    // A copy made by an earlier pass is finished even when its app was removed since.
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
    // A copy an earlier pass saved undeployed is still undeployed when that pass left work to retry.
    let outcome =
      Option.isSome(existing) && existing.value.activeDeployment === null
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
    // Resuming evaluates the copy with the member's accounts. One the evaluation refuses, such as
    // for a missing account or an undeployed copy, stays paused for its member to resume; each
    // refusal is logged by schedule and failure. A failure of storage says nothing about the
    // schedule: it fails the item, which leaves the plan pending, and a later pass resumes the
    // schedules still in `enable`. Each schedule leaves `enable` once handled: in the resume's own
    // transaction, so a resume that commits is never made again, or after a refusal, which wrote
    // nothing.
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
/**
 * The plan's accounts in its order, each with the requirements its enabled profiles selected it
 * for: a plain requirement of the app's active deployment only its first existing account, as
 * SDK 4.0.13 read the account set, and a many() one every account.
 */
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

/** Outcome of an item that a later pass handles again, such as unavailable storage. */
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
          // Every failure is retried: a copy is never given up on. The tag says why it waits.
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
