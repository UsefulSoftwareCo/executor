import { requireLinkRemovalAs, requireRequirementAccessAs } from "./contributed-account-policy.ts";
/**
 * The accounts linked to an app's requirements and the accounts every operation runs with. A
 * member's user accounts for an app are their user links intersected with the accounts they may
 * use now; missing or revoked accounts drop out and nothing is substituted. App requirements use
 * the app links instead, for every caller, through app access alone. A plain requirement uses its
 * one link, and linking another replaces it; many() uses every one.
 */
import {
  AccountId,
  AccountNotFound,
  AppId,
  StorageError,
  StorageHost,
  invocationEntries,
  linkedRequirements,
  resolveLinkedAccounts,
  type AccountScope,
  type App,
  type AppAccounts,
  type AppRequirements,
  type VersionId,
  type Executor,
  type WebhookSourceConfig,
  WebhookSourceFields,
} from "@executor-js/sdk/core";
import { permitsAccounts, permittedTargets } from "@executor-js/authorization";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { CurrentUserId } from "../contracts/auth.ts";
import { CurrentPolicy } from "../contracts/authorization.ts";
import { RequirementMismatch } from "../contracts/app-accounts.ts";
import { OrganizationForbidden } from "../contracts/organization.ts";
import {
  AppAccountReads,
  LinkedAccount,
  linkedAccountJson,
  lockCurrentActor,
  policyDatabase,
  requireAccountOwnerAs,
  requireAppAccessAs,
  usableAppLinks,
  usableLinks,
  type ResourceAuthority,
} from "./resource-policy.ts";
import { userAccountIds } from "./authorization.ts";

const sqlFailures = {
  SqlError: () => new StorageError(),
  SchemaError: () => new StorageError(),
} as const;

export const linkedAccounts = (
  sql: SqlClient.SqlClient,
  input: { readonly subject: string; readonly apps: readonly AppId[] },
) =>
  Effect.gen(function* () {
    if (input.apps.length === 0) return [];
    const rows = yield* sql`select l.app, l.requirement, a.id, a.provider, a.label, a.description
      from ${usableLinks(sql, input)}
      order by l.app, l.created_at, a.id`;
    return yield* Schema.decodeUnknownEffect(Schema.Array(LinkedAccount))(rows);
  }).pipe(Effect.catchTags(sqlFailures));

export const appLinkedAccounts = (sql: SqlClient.SqlClient, apps: readonly AppId[]) =>
  Effect.gen(function* () {
    if (apps.length === 0) return [];
    const rows = yield* sql`select l.app, l.requirement, a.id, a.provider, a.label, a.description
      from ${usableAppLinks(sql, apps)}
      order by l.app, l.created_at, a.id`;
    return yield* Schema.decodeUnknownEffect(Schema.Array(LinkedAccount))(rows);
  }).pipe(Effect.catchTags(sqlFailures));

const AccountReadsRow = Schema.Struct({
  user: Schema.fromJsonString(AppAccountReads.fields.user),
  app: Schema.fromJsonString(AppAccountReads.fields.app),
});
export const appAccountReads = (
  sql: SqlClient.SqlClient,
  input: { readonly subject: string; readonly app: AppId },
) =>
  Effect.gen(function* () {
    const json = sql.literal(linkedAccountJson);
    const rows = yield* sql`select
      (select coalesce(json_agg(${json} order by l.created_at, a.id), '[]'::json)::text
        from ${usableLinks(sql, { subject: input.subject, apps: [input.app] })}) as "user",
      (select coalesce(json_agg(${json} order by l.created_at, a.id), '[]'::json)::text
        from ${usableAppLinks(sql, [input.app])}) as app`;
    const read = (yield* Schema.decodeUnknownEffect(Schema.Array(AccountReadsRow))(rows))[0];
    if (read === undefined) return yield* new StorageError();
    return read;
  }).pipe(Effect.catchTags(sqlFailures));

const permittedLinks = (linked: ReadonlyArray<LinkedAccount>) =>
  Effect.map(CurrentPolicy, (policy) =>
    linked.filter((account) => {
      const targets = permittedTargets(policy.tools, account.app);
      return targets === undefined || targets.accounts.has(account.id);
    }),
  );

export const callerLinkedAccounts = (apps: readonly AppId[]) =>
  Effect.gen(function* () {
    const subject = yield* CurrentUserId;
    if (subject === undefined) return yield* new OrganizationForbidden();
    return yield* permittedLinks(yield* linkedAccounts(yield* policyDatabase, { subject, apps }));
  });

export type CallerLinks = Effect.Effect<AppAccountReads, StorageError>;

export interface AppVersion {
  readonly app: AppId;
  readonly version: VersionId | null;
  readonly requirements: AppRequirements;
}
export const activeVersion = (app: App): AppVersion => ({
  app: app.id,
  version: app.activeVersion,
  requirements: app.requirements,
});
const callerRequirements = (version: AppVersion, links?: CallerLinks) =>
  Effect.gen(function* () {
    if (Object.keys(version.requirements.accounts).length === 0)
      return { appLinks: {}, userLinks: {} };
    const read =
      links ??
      Effect.gen(function* () {
        const subject = yield* CurrentUserId;
        if (subject === undefined) return yield* new OrganizationForbidden();
        return yield* appAccountReads(yield* policyDatabase, { subject, app: version.app });
      });
    const reads = yield* read;
    const own = (links: ReadonlyArray<LinkedAccount>) =>
      links
        .filter((link) => link.app === version.app)
        .map((link) => ({ requirement: link.requirement, account: link }));
    return {
      appLinks: linkedRequirements(version.requirements.accounts, "app", own(reads.app)),
      userLinks: linkedRequirements(
        version.requirements.accounts,
        "user",
        own(yield* permittedLinks(reads.user)),
      ),
    };
  });

export const versionAccounts = (version: AppVersion, links?: CallerLinks) =>
  Effect.gen(function* () {
    const resolved = yield* resolveLinkedAccounts({
      app: version.app,
      version: version.version,
      ...(yield* callerRequirements(version, links)),
    });
    const policy = yield* CurrentPolicy;
    if (!permitsAccounts(policy, version.app, userAccountIds(resolved)))
      return yield* new OrganizationForbidden();
    return resolved;
  });
export const stillLinked = (used: AppAccounts, current: AppAccounts) => {
  const now = new Map(invocationEntries(current));
  return invocationEntries(used).every(([slot, ids]) =>
    ids.every((id) => now.get(slot)?.includes(id)),
  );
};
export const callerAccounts = (app: App, links?: CallerLinks) =>
  versionAccounts(activeVersion(app), links);

export type WebhookSources = Pick<Executor["webhooks"], "link" | "unlink">;

const SourceRow = Schema.Struct({
  actor: WebhookSourceFields.fields.actor,
  status: WebhookSourceFields.fields.status,
});
export const accountSource = (
  sql: SqlClient.SqlClient,
  input: { readonly app: AppId; readonly account: AccountId },
) =>
  Effect.gen(function* () {
    const rows = yield* sql`select actor, status from executor_webhook_sources
      where app = ${input.app} and account = ${input.account}`;
    return (yield* Schema.decodeUnknownEffect(Schema.Array(SourceRow))(rows))[0];
  }).pipe(Effect.catchTags(sqlFailures));
const storage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError(() => new StorageError()));

const lockLinks = (sql: SqlClient.SqlClient, app: AppId) =>
  sql`select id from executor_apps where id = ${app} for no key update`.pipe(Effect.asVoid);

export const lockAppLinks = (sql: SqlClient.SqlClient, app: AppId) =>
  lockLinks(sql, app).pipe(Effect.catchTag("SqlError", () => new StorageError()));

/* Account requirements opt in to contributor authority; ordinary slots keep management. */
type LinkChangeAccess =
  | { readonly access: "manage" | "use"; readonly account?: AccountId }
  | { readonly access: "contribute"; readonly requirement: string; readonly account?: AccountId }
  | { readonly access: "remove"; readonly requirement: string; readonly account: AccountId };

/**
 * Run a link change in one transaction under the app's link lock, after checking the caller's
 * access again there. The request checked it before, but the transaction can wait for the lock
 * while the caller's role, the app's audience or the account's audience changes; this check reads
 * what committed meanwhile. The caller's membership row stays share-locked until the change
 * commits, so a role change or removal waits for it. `access` is the access the change needs to the
 * app; `account`, when set, the account the change links, which the caller must still be able to
 * use. The change gets the checked actor, for any further check of its own under the lock.
 */
export const lockedChange = <A, E, R>(
  executor: Executor,
  input: { readonly app: AppId } & LinkChangeAccess,
  change: (sql: SqlClient.SqlClient, actor: ResourceAuthority) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const sql = yield* policyDatabase;
    return yield* executor[StorageHost].transaction(
      Effect.gen(function* () {
        yield* lockAppLinks(sql, input.app);
        const actor = yield* lockCurrentActor;
        if (input.access === "remove") yield* requireLinkRemovalAs(sql, actor, input);
        else {
          if (input.access === "contribute")
            yield* requireRequirementAccessAs(actor, { ...input, scope: "app" });
          else yield* requireAppAccessAs(actor, input.app, input.access);
          if (input.account !== undefined)
            yield* requireAccountOwnerAs(actor, input.account);
        }
        return yield* change(sql, actor);
      }),
    );
  });

export interface LinkKey {
  readonly app: AppId;
  readonly requirement: string;
  readonly account: AccountId;
  readonly subject: string | null;
}
const scopeOf = (subject: string | null): AccountScope => (subject === null ? "app" : "user");
const sameSubject = (sql: SqlClient.SqlClient, subject: string | null) =>
  subject === null ? sql`subject is null` : sql`subject = ${subject}`;

const SubjectRow = Schema.Struct({ subject: Schema.NullOr(Schema.String) });
const syncSource = (
  sql: SqlClient.SqlClient,
  webhooks: WebhookSources,
  input: {
    readonly app: AppId;
    readonly account: AccountId;
    readonly actor?: string | undefined;
    readonly config?: typeof WebhookSourceConfig.Type | undefined;
    readonly changed: string | null;
  },
) =>
  Effect.gen(function* () {
    const subjects = (yield* Schema.decodeUnknownEffect(Schema.Array(SubjectRow))(
      yield* sql`select subject from hosted_app_account_links
        where app = ${input.app} and account = ${input.account}
        group by subject order by min(created_at), subject`,
    )).map((row) => row.subject);
    const source = yield* accountSource(sql, input);
    const config = input.config === undefined ? {} : { config: input.config };
    if (subjects.includes(null)) {
      if (
        source === undefined ||
        source.actor !== null ||
        source.status === "removing" ||
        input.changed === null
      )
        yield* storage(webhooks.link({ app: input.app, account: input.account, ...config }));
      return;
    }
    const members = subjects.filter((subject) => subject !== null);
    const live = source !== undefined && source.status !== "removing";
    if (live && source.actor !== null && members.includes(source.actor)) {
      if (input.changed === source.actor)
        yield* storage(
          webhooks.link({ app: input.app, account: input.account, actor: source.actor }),
        );
      return;
    }
    if (input.actor !== undefined && members.includes(input.actor) && !live)
      return yield* storage(
        webhooks.link({ app: input.app, account: input.account, actor: input.actor, ...config }),
      );
    for (const subject of members) {
      const usable = yield* linkedAccounts(sql, { subject, apps: [input.app] });
      if (usable.some((account) => account.id === input.account))
        return yield* storage(
          webhooks.link({ app: input.app, account: input.account, actor: subject }),
        );
    }
    if (source !== undefined && source.status !== "removing")
      yield* webhooks.unlink({ app: input.app, account: input.account }).pipe(
        Effect.catchTag("WebhookNotFound", () => Effect.void),
        storage,
      );
  }).pipe(Effect.catchTags(sqlFailures));

const RequiredRow = Schema.Struct({
  scope: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(Schema.String),
  cardinality: Schema.NullOr(Schema.String),
  accountProvider: Schema.NullOr(Schema.String),
});
const AccountRow = Schema.Struct({ account: AccountId });

export const removeLink = (sql: SqlClient.SqlClient, webhooks: WebhookSources, input: LinkKey) =>
  Effect.gen(function* () {
    yield* lockLinks(sql, input.app);
    const deleted = yield* sql`delete from hosted_app_account_links
      where app = ${input.app} and requirement = ${input.requirement}
        and account = ${input.account} and ${sameSubject(sql, input.subject)}
      returning account`;
    if (deleted.length === 0) return false;
    yield* syncSource(sql, webhooks, {
      app: input.app,
      account: input.account,
      changed: input.subject,
    });
    return true;
  }).pipe(Effect.catchTag("SqlError", () => new StorageError()));

export const addLink = (
  sql: SqlClient.SqlClient,
  webhooks: WebhookSources,
  input: LinkKey & {
    readonly linkedBy: string;
    readonly config?: typeof WebhookSourceConfig.Type | undefined;
  },
) =>
  Effect.gen(function* () {
    yield* lockLinks(sql, input.app);
    const scope = scopeOf(input.subject);
    const rows = yield* sql`select
        d.requirements::jsonb -> 'accounts' -> ${input.requirement} ->> 'scope' as scope,
        d.requirements::jsonb -> 'accounts' -> ${input.requirement} ->> 'provider' as provider,
        d.requirements::jsonb -> 'accounts' -> ${input.requirement} ->> 'cardinality' as cardinality,
        a.provider as "accountProvider"
      from executor_apps app
      left join executor_deployments d on d.id = app.active_deployment
      left join executor_accounts a on a.id = ${input.account} and a.owner = app.owner
      where app.id = ${input.app}`;
    const required = (yield* Schema.decodeUnknownEffect(Schema.Array(RequiredRow))(rows))[0];
    const refuse = (reason: RequirementMismatch["reason"]) =>
      new RequirementMismatch({ app: input.app, requirement: input.requirement, scope, reason });
    if (required === undefined) return yield* new StorageError();
    if (required.accountProvider === null)
      return yield* new AccountNotFound({ account: input.account });
    if (required.provider === null || (required.scope ?? "user") !== scope)
      return yield* refuse("requirement");
    if (required.provider !== required.accountProvider) return yield* refuse("provider");
    const replaced =
      required.cardinality === "many"
        ? []
        : yield* Schema.decodeUnknownEffect(Schema.Array(AccountRow))(
            yield* sql`select account from hosted_app_account_links
              where app = ${input.app} and requirement = ${input.requirement}
                and ${sameSubject(sql, input.subject)} and account <> ${input.account}
              order by created_at, account`,
          );
    for (const { account } of replaced) yield* removeLink(sql, webhooks, { ...input, account });
    const inserted = yield* sql`insert into hosted_app_account_links
        (app, requirement, subject, account, linked_by, created_at)
      values (${input.app}, ${input.requirement}, ${input.subject}, ${input.account},
        ${input.linkedBy}, clock_timestamp())
      on conflict do nothing returning account`;
    if (inserted.length === 0) return replaced.length > 0;
    yield* syncSource(sql, webhooks, {
      app: input.app,
      account: input.account,
      actor: input.subject ?? undefined,
      config: input.config,
      changed: input.subject,
    });
    return true;
  }).pipe(Effect.catchTags(sqlFailures));

export const sourceActorLost = (
  sql: SqlClient.SqlClient,
  webhooks: WebhookSources,
  input: { readonly app: AppId; readonly account: AccountId; readonly actor: string },
) =>
  Effect.gen(function* () {
    yield* lockLinks(sql, input.app);
    const source = yield* accountSource(sql, input);
    if (source === undefined || source.actor !== input.actor || source.status === "removing")
      return;
    const own = yield* linkedAccounts(sql, { subject: input.actor, apps: [input.app] });
    if (own.some((account) => account.id === input.account)) return;
    const subjects = (yield* Schema.decodeUnknownEffect(Schema.Array(SubjectRow))(
      yield* sql`select subject from hosted_app_account_links
        where app = ${input.app} and account = ${input.account} and subject is not null
          and subject <> ${input.actor}
        group by subject order by min(created_at), subject`,
    )).flatMap((row) => (row.subject === null ? [] : [row.subject]));
    for (const subject of subjects) {
      const usable = yield* linkedAccounts(sql, { subject, apps: [input.app] });
      if (usable.some((account) => account.id === input.account))
        return yield* storage(
          webhooks.link({ app: input.app, account: input.account, actor: subject }),
        );
    }
    yield* webhooks.unlink({ app: input.app, account: input.account }).pipe(
      Effect.catchTag("WebhookNotFound", () => Effect.void),
      storage,
    );
  }).pipe(Effect.catchTags(sqlFailures));

/** The apps an account is linked to for everyone, which must unlink it before it can be deleted. */
const AppLinkRow = Schema.Struct({ app: AppId, requirement: Schema.String });
export const removeAppLinksOf = (
  executor: Executor,
  sql: SqlClient.SqlClient,
  account: AccountId,
) =>
  executor[StorageHost].transaction(
    Effect.gen(function* () {
      const rows = yield* Schema.decodeUnknownEffect(Schema.Array(AppLinkRow))(
        yield* sql`select distinct app, requirement from hosted_app_account_links
          where account = ${account} and subject is null order by app, requirement`,
      );
      let removed = false;
      for (const row of rows)
        if (yield* removeLink(sql, executor.webhooks, { ...row, account, subject: null }))
          removed = true;
      return removed;
    }).pipe(Effect.catchTags(sqlFailures)),
  );

/** The apps an account is linked to for everyone, which must unlink it before it can be deleted. */
export const appLinkApps = (sql: SqlClient.SqlClient, account: AccountId, normalOnly = false) =>
  Effect.gen(function* () {
    const rows = yield* normalOnly
      ? sql`select distinct l.app from hosted_app_account_links l
      join executor_apps a on a.id = l.app
      left join executor_deployments d on d.id = a.active_deployment
      where l.account = ${account} and l.subject is null
        and not coalesce(
          d.requirements::jsonb -> 'accounts' -> l.requirement ->> 'scope' = 'app'
          and d.requirements::jsonb -> 'accounts' -> l.requirement ->> 'contributed' = 'true', false)
      order by l.app`
      : sql`select distinct app from hosted_app_account_links where account = ${account} and subject is null order by app`;
    return (yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ app: AppId })))(
      rows,
    )).map((row) => row.app);
  }).pipe(Effect.catchTags(sqlFailures));
