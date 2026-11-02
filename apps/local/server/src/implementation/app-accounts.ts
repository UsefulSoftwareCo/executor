/**
 * The accounts linked to each local app's requirements, kept in `local_app_account_links`, and the
 * accounts every operation runs with: resolved by the same rules as hosted, app requirements from
 * the app links and user requirements from the user links. Local has one subject, so an app's user
 * links are its only ones, and the owner links in both scopes without an access policy.
 */
import {
  AccountChoiceUnsupported,
  AccountId,
  AccountNotFound,
  AccountProvisioned,
  AppId,
  StorageError,
  StorageHost,
  linkedRequirements,
  resolveLinkedAccounts,
  type Account,
  type AccountScope,
  type App,
  type AppAccounts,
  type AppAccountUse,
  type AppRequirements,
  type VersionId,
  type Executor,
  WebhookSourceConfig,
  type ResourceLifecycle,
} from "@executor-js/sdk/core";
import type { ProfileAppCopiesHost } from "@executor-js/app-management/data-steps";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import type { AppAccountLink, AppAccountRequirement } from "../contracts/dashboard.ts";
import { RequirementMismatch } from "../contracts/requirement-mismatch.ts";

/** The one local subject; background work and its user links run as it. */
export const localActor = "local";

const storage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError(() => new StorageError()));
const decode = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.Array(schema));
const sqlFailures = {
  SqlError: () => new StorageError(),
  SchemaError: () => new StorageError(),
} as const;
const LinkRow = Schema.Struct({
  requirement: Schema.NonEmptyString,
  account: AccountId,
  createdAt: Schema.Date,
});
const scopeOf = (subject: string | null): AccountScope => (subject === null ? "app" : "user");
/** The subject of a scope's links: none for app links, the local subject for user links. */
export const scopeSubject = (scope: AccountScope) => (scope === "app" ? null : localActor);
/**
 * Every statement on the links table names it to the executor's tracking, so live reads that
 * resolve accounts, such as the tool catalog, follow committed link changes from every surface.
 */
const linksTable = ["local_app_account_links"];
const readLinks = <A, E, R>(executor: Executor, effect: Effect.Effect<A, E, R>) =>
  executor[StorageHost].read(linksTable, effect);
const writeLinks = <A, E, R>(executor: Executor, effect: Effect.Effect<A, E, R>) =>
  executor[StorageHost].write(linksTable, effect);
const sameSubject = (sql: SqlClient.SqlClient, subject: string | null) =>
  subject === null ? sql`l.subject is null` : sql`l.subject = ${subject}`;

/** The app owner's accounts by ID, read only when some are needed. */
const ownerAccounts = (executor: Executor, app: App, needed: boolean) =>
  needed
    ? Effect.map(
        executor.accounts.list({ owner: app.owner }),
        (accounts) => new Map(accounts.map((account) => [account.id, account])),
      )
    : Effect.succeed(new Map<AccountId, Account>());

/** The app's links in one scope to its owner's accounts, oldest first per requirement. */
const linkRows = (
  sql: SqlClient.SqlClient,
  executor: Executor,
  app: App,
  subject: string | null,
  requirement?: string,
) =>
  readLinks(
    executor,
    sql`select l.requirement, l.account, l.created_at as "createdAt"
    from local_app_account_links l
    join executor_accounts a on a.id = l.account and a.owner = ${app.owner}
    where l.app = ${app.id} and ${sameSubject(sql, subject)}
      and ${requirement === undefined ? sql`true` : sql`l.requirement = ${requirement}`}
    order by l.created_at, l.account`,
  ).pipe(Effect.flatMap(decode(LinkRow)));

/**
 * The app's links in one scope, as the owner's accounts, oldest first. Accounts that are gone drop
 * out and nothing is substituted.
 */
const linkedAccountsOf = (
  sql: SqlClient.SqlClient,
  executor: Executor,
  app: App,
  subject: string | null,
) =>
  Effect.gen(function* () {
    const rows = yield* linkRows(sql, executor, app, subject);
    const accounts = yield* ownerAccounts(executor, app, rows.length > 0);
    return rows.flatMap((row) => {
      const account = accounts.get(row.account);
      return account === undefined
        ? []
        : [{ requirement: row.requirement, createdAt: row.createdAt, account }];
    });
  }).pipe(Effect.catchTags(sqlFailures));

/** The accounts of the app's owner linked to its user requirements, oldest link first. */
export const linkedAccounts = (sql: SqlClient.SqlClient, executor: Executor, app: App) =>
  Effect.map(linkedAccountsOf(sql, executor, app, localActor), (links) =>
    links.map((link) => link.account),
  );

/**
 * The app's links in one scope, oldest first per requirement, with each account and its checks by
 * this app. A link whose account is gone, or belongs to another owner, is left out.
 */
export const appAccountLinks = (
  sql: SqlClient.SqlClient,
  executor: Executor,
  app: App,
  scope: AccountScope,
): Effect.Effect<ReadonlyArray<AppAccountLink>, StorageError> =>
  Effect.gen(function* () {
    const links = yield* linkedAccountsOf(sql, executor, app, scopeSubject(scope));
    if (links.length === 0) return [];
    const health = new Map(
      (yield* executor.accounts.listHealth({
        links: links.map((link) => ({ app: app.id, account: link.account.id })),
      })).map((entry) => [entry.account, entry]),
    );
    return [...links]
      .sort((a, b) => a.requirement.localeCompare(b.requirement))
      .map((link) => {
        const checks = health.get(link.account.id);
        return { ...link, ...(checks === undefined ? {} : { health: checks }) };
      });
  });

const AnyLink = Schema.Struct({
  app: AppId,
  requirement: Schema.NonEmptyString,
  account: AccountId,
  subject: Schema.NullOr(Schema.String),
});
/** Every link in both scopes, oldest first, or those of one account. */
export const accountLinks = (sql: SqlClient.SqlClient, executor: Executor, account?: AccountId) =>
  readLinks(
    executor,
    account === undefined
      ? sql`select app, requirement, account, subject from local_app_account_links
        order by created_at, account`
      : sql`select app, requirement, account, subject from local_app_account_links
        where account = ${account} order by created_at, app`,
  ).pipe(Effect.flatMap(decode(AnyLink)), Effect.catchTags(sqlFailures));

/** The requirement in this scope of the app's active version, or `RequirementMismatch`. */
const scopedRequirement = (app: App, scope: AccountScope, requirement: string) => {
  const required = Object.hasOwn(app.requirements.accounts, requirement)
    ? app.requirements.accounts[requirement]
    : undefined;
  return required === undefined || required.scope !== scope
    ? Effect.fail(
        new RequirementMismatch({ app: app.id, requirement, scope, reason: "requirement" }),
      )
    : Effect.succeed(required);
};

/** Refuse a dashboard sign-in for a requirement the route's scope does not declare. */
export const requireScopedRequirement = (
  executor: Executor,
  input: { readonly app: AppId; readonly requirement: string; readonly scope: AccountScope },
) =>
  Effect.flatMap(executor.apps.get({ app: input.app }), (app) =>
    scopedRequirement(app, input.scope, input.requirement),
  );

/**
 * One requirement in one scope: its linked accounts, oldest first, then the app owner's other
 * accounts of its provider, which could be linked.
 */
export const appAccountRequirement = (
  sql: SqlClient.SqlClient,
  executor: Executor,
  input: { readonly app: AppId; readonly scope: AccountScope; readonly requirement: string },
) =>
  Effect.gen(function* () {
    const app = yield* executor.apps.get({ app: input.app });
    const required = yield* scopedRequirement(app, input.scope, input.requirement);
    const rows = yield* linkRows(
      sql,
      executor,
      app,
      scopeSubject(input.scope),
      input.requirement,
    ).pipe(Effect.catchTags(sqlFailures));
    const all = yield* executor.accounts.list({ owner: app.owner, provider: required.provider });
    const byId = new Map(all.map((account) => [account.id, account]));
    const linked = rows.flatMap((row) => {
      const account = byId.get(row.account);
      return account === undefined ? [] : [account];
    });
    const linkedIds = new Set(linked.map((account) => account.id));
    return {
      requirement: input.requirement,
      scope: input.scope,
      provider: required.provider,
      cardinality: required.cardinality,
      accounts: [
        ...linked.map((account) => ({ account, linked: true })),
        ...all
          .filter((account) => !linkedIds.has(account.id))
          .map((account) => ({ account, linked: false })),
      ],
    } satisfies AppAccountRequirement;
  });

/**
 * One version of an app and the requirements its code declares: the active one for new
 * operations, or a retained one an operation pins, such as reading an earlier skill.
 */
interface AppVersion {
  readonly app: App;
  readonly version: VersionId | null;
  readonly requirements: AppRequirements;
}
const activeVersion = (app: App): AppVersion => ({
  app,
  version: app.activeVersion,
  requirements: app.requirements,
});
/** The app at a retained version of its code lineage when pinned, else its active one. */
export const appVersion = (executor: Executor, app: App, version: VersionId | undefined) =>
  version === undefined || version === app.activeVersion
    ? Effect.succeed(activeVersion(app))
    : executor.apps.version({ app: app.id, version }).pipe(
        Effect.map((retained): AppVersion => ({
          app,
          version: retained.id,
          requirements: retained.requirements,
        })),
      );

/**
 * Each app requirement of the version with its app links, and each user requirement with its user
 * links; no read without requirements.
 */
export const versionRequirementAccounts = (
  sql: SqlClient.SqlClient,
  executor: Executor,
  version: AppVersion,
) =>
  Object.keys(version.requirements.accounts).length === 0
    ? Effect.succeed({ appLinks: {}, userLinks: {} })
    : Effect.all({
        app: linkedAccountsOf(sql, executor, version.app, null),
        user: linkedAccountsOf(sql, executor, version.app, localActor),
      }).pipe(
        Effect.map((links) => ({
          appLinks: linkedRequirements(version.requirements.accounts, "app", links.app),
          userLinks: linkedRequirements(version.requirements.accounts, "user", links.user),
        })),
      );

/** The accounts an operation runs with, for every requirement of the version. */
export const versionAccounts = (
  sql: SqlClient.SqlClient,
  executor: Executor,
  version: AppVersion,
) =>
  Effect.flatMap(versionRequirementAccounts(sql, executor, version), (accounts) =>
    resolveLinkedAccounts({ app: version.app.id, version: version.version, ...accounts }),
  );

/** The accounts an operation runs with, for every requirement of the app's active version. */
export const callerAccounts = (sql: SqlClient.SqlClient, executor: Executor, app: App) =>
  versionAccounts(sql, executor, activeVersion(app));

/**
 * Serve an SDK operation with the app's linked accounts, for the requirements of the
 * version its input pins. Callers never choose accounts: an input that names them fails with
 * `AccountChoiceUnsupported`.
 */
export const linkedOperation =
  (sql: SqlClient.SqlClient, executor: Executor) =>
  <
    I extends {
      readonly app: AppId;
      readonly version?: VersionId | undefined;
      readonly accounts?: AppAccounts | undefined;
    },
    Rest extends ReadonlyArray<unknown>,
    A,
    E,
    R,
  >(
    operation: (input: I, ...rest: Rest) => Effect.Effect<A, E, R>,
  ) =>
  (input: I, ...rest: Rest) =>
    Effect.gen(function* () {
      if (input.accounts !== undefined)
        return yield* new AccountChoiceUnsupported({ app: input.app });
      const app = yield* executor.apps.get({ app: input.app });
      const version = yield* appVersion(executor, app, input.version);
      const accounts = yield* versionAccounts(sql, executor, version);
      return yield* operation({ ...input, accounts }, ...rest);
    });

/**
 * Take the SDK's app lock before reading or writing the app's links. Webhook source changes take
 * the same lock, so a change and the source change it causes are serialized per app.
 */
const lockApp = (sql: SqlClient.SqlClient, app: AppId) =>
  sql`select id from executor_apps where id = ${app} for no key update`.pipe(Effect.asVoid);

/** Stop the app's webhook source for an account that no longer serves it. */
const unlinkSource = (executor: Executor, app: AppId, account: AccountId) =>
  executor.webhooks.unlink({ app, account }).pipe(
    Effect.catchTag("WebhookNotFound", () => Effect.void),
    storage,
  );

const SubjectRow = Schema.Struct({ subject: Schema.NullOr(Schema.String) });
/**
 * Bring the app's webhook source for an account in line with its links, as hosted does: with an app
 * link it is the app's own source, without an actor (an account also linked for the local user
 * serves as its app link only); otherwise with a user link it runs as the local subject; without
 * links it stops. It serves the webhooks of the requirements it is linked to in its scope.
 * `changed` names whose link was just added or removed, null for an app link: when that changes
 * the requirements the source serves, new intent is saved on it, so reconciliation registers or
 * removes the webhooks of the requirement linked or unlinked.
 */
const syncSource = (
  sql: SqlClient.SqlClient,
  executor: Executor,
  input: {
    readonly app: AppId;
    readonly account: AccountId;
    readonly config?: typeof WebhookSourceConfig.Type | undefined;
    readonly changed: string | null;
  },
) =>
  Effect.gen(function* () {
    const subjects = (yield* decode(SubjectRow)(
      yield* readLinks(
        executor,
        sql`select distinct subject from local_app_account_links
          where app = ${input.app} and account = ${input.account}`,
      ),
    )).map((row) => row.subject);
    const source = (yield* storage(executor.webhooks.sources({ app: input.app }))).find(
      (item) => item.account === input.account,
    );
    const config = input.config === undefined ? {} : { config: input.config };
    const live = source !== undefined && source.status !== "removing";
    if (subjects.includes(null)) {
      if (!live || source.actor !== null || input.changed === null)
        yield* storage(
          executor.webhooks.link({ app: input.app, account: input.account, ...config }),
        );
      return;
    }
    if (subjects.length > 0) {
      if (!live || source.actor !== localActor || input.changed === localActor)
        yield* storage(
          executor.webhooks.link({
            app: input.app,
            account: input.account,
            actor: localActor,
            ...config,
          }),
        );
      return;
    }
    if (live) yield* unlinkSource(executor, input.app, input.account);
  }).pipe(Effect.catchTags(sqlFailures));

/** One link: `subject` null for an app link, else the local subject. */
interface LinkKey {
  readonly app: AppId;
  readonly requirement: string;
  readonly account: AccountId;
  readonly subject: string | null;
}

/**
 * Remove one link, in the caller's transaction, under the app's lock, and bring the account's
 * webhook source in line. Returns whether a link was removed.
 */
const removeLink = (sql: SqlClient.SqlClient, executor: Executor, input: LinkKey) =>
  Effect.gen(function* () {
    yield* lockApp(sql, input.app);
    const deleted = yield* writeLinks(
      executor,
      sql`delete from local_app_account_links l
        where l.app = ${input.app} and l.requirement = ${input.requirement}
          and l.account = ${input.account} and ${sameSubject(sql, input.subject)}
        returning l.account`,
    );
    if (deleted.length === 0) return false;
    yield* syncSource(sql, executor, {
      app: input.app,
      account: input.account,
      changed: input.subject,
    });
    return true;
  }).pipe(Effect.catchTag("SqlError", () => new StorageError()));

/**
 * Link one of the app owner's accounts to a requirement of the app's active version in the
 * link's scope, in the caller's transaction, under the app's lock. The requirement must be declared
 * in that scope and use the account's provider (`RequirementMismatch`). A plain requirement keeps
 * one link per scope: linking another account replaces it, as {@link removeLink} removes it; the
 * replaced account stays saved. many() keeps every one. `config` configures the webhook source the
 * first link creates. Linking again changes nothing. Returns whether a link changed.
 */
const addLink = (
  sql: SqlClient.SqlClient,
  executor: Executor,
  input: {
    readonly app: App;
    readonly requirement: string;
    readonly account: Account;
    readonly subject: string | null;
    readonly config?: typeof WebhookSourceConfig.Type | undefined;
  },
) =>
  Effect.gen(function* () {
    const { app, requirement, account, subject } = input;
    yield* lockApp(sql, app.id);
    const required = yield* scopedRequirement(app, scopeOf(subject), requirement);
    if (required.provider !== account.provider)
      return yield* new RequirementMismatch({
        app: app.id,
        requirement,
        scope: scopeOf(subject),
        reason: "provider",
      });
    const method = required.definition.auth[account.method];
    if (method?.type === "secrets" && method.provisioned === true)
      return yield* new AccountProvisioned({ provider: account.provider });
    const replaced =
      required.cardinality === "many"
        ? []
        : yield* decode(Schema.Struct({ account: AccountId }))(
            yield* readLinks(
              executor,
              sql`select l.account from local_app_account_links l
                where l.app = ${app.id} and l.requirement = ${requirement}
                  and ${sameSubject(sql, subject)} and l.account <> ${account.id}
                order by l.created_at, l.account`,
            ),
          );
    for (const previous of replaced) {
      const saved = yield* storage(executor.accounts.get({ account: previous.account }));
      const method = required.definition.auth[saved.method];
      if (method?.type === "secrets" && method.provisioned === true)
        return yield* new AccountProvisioned({ provider: saved.provider });
    }
    for (const previous of replaced)
      yield* removeLink(sql, executor, {
        app: app.id,
        requirement,
        account: previous.account,
        subject,
      });
    // Each link is dated when it is made, so links made in one transaction keep their order.
    const inserted = yield* writeLinks(
      executor,
      sql`insert into local_app_account_links
          (app, requirement, subject, account, created_at)
        values (${app.id}, ${requirement}, ${subject}, ${account.id}, clock_timestamp())
        on conflict do nothing returning account`,
    );
    if (inserted.length === 0) return replaced.length > 0;
    yield* syncSource(sql, executor, {
      app: app.id,
      account: account.id,
      config: input.config,
      changed: subject,
    });
    return true;
  }).pipe(Effect.catchTags(sqlFailures));

/**
 * Link one of the app owner's accounts to a requirement in a scope (see {@link addLink}), and
 * return the link with its checks. Wake webhook source reconciliation once it commits.
 */
export const linkAccount = (
  sql: SqlClient.SqlClient,
  executor: Executor,
  input: {
    readonly app: AppId;
    readonly scope: AccountScope;
    readonly requirement: string;
    readonly account: AccountId;
    readonly config?: typeof WebhookSourceConfig.Type;
  },
) =>
  Effect.gen(function* () {
    yield* executor[StorageHost].transaction(
      Effect.gen(function* () {
        // The lock is taken before the app is read, so its active version holds while linking.
        yield* lockApp(sql, input.app).pipe(Effect.catchTag("SqlError", () => new StorageError()));
        const app = yield* executor.apps.get({ app: input.app });
        const account = yield* executor.accounts.get({ owner: app.owner, account: input.account });
        return yield* addLink(sql, executor, {
          app,
          requirement: input.requirement,
          account,
          subject: scopeSubject(input.scope),
          config: input.config,
        });
      }),
    );
    const app = yield* executor.apps.get({ app: input.app });
    const link = (yield* appAccountLinks(sql, executor, app, input.scope)).find(
      (item) => item.requirement === input.requirement && item.account.id === input.account,
    );
    if (link === undefined) return yield* new AccountNotFound({ account: input.account });
    return link;
  });

/**
 * Unlink an account from a requirement in a scope (see {@link removeLink}). The account stays
 * saved. Wake webhook source reconciliation once it commits.
 */
export const unlinkAccount = (
  sql: SqlClient.SqlClient,
  executor: Executor,
  input: {
    readonly app: AppId;
    readonly scope: AccountScope;
    readonly requirement: string;
    readonly account: AccountId;
  },
) =>
  executor[StorageHost].transaction(
    Effect.gen(function* () {
      yield* executor.apps.get({ app: input.app });
      const removed = yield* removeLink(sql, executor, {
        app: input.app,
        requirement: input.requirement,
        account: input.account,
        subject: scopeSubject(input.scope),
      });
      if (!removed) return yield* new AccountNotFound({ account: input.account });
      return { requirement: input.requirement, account: input.account };
    }),
  );

/** The apps an account is linked to for every call, which must unlink it before it is deleted. */
export const appLinkApps = (sql: SqlClient.SqlClient, executor: Executor, account: AccountId) =>
  readLinks(
    executor,
    sql`select distinct app from local_app_account_links
      where account = ${account} and subject is null order by app`,
  ).pipe(
    Effect.flatMap(decode(Schema.Struct({ app: AppId }))),
    Effect.map((rows) => rows.map((row) => row.app)),
    Effect.catchTags(sqlFailures),
  );

/**
 * Local's part of data step `10_profile_app_copies`: a copy has its app's owner, and links each
 * account of the profiles it replaces to the requirement they selected it for, in their order, as
 * the local subject's user links. Accounts that are gone, or no longer the copy owner's, are
 * skipped. Links are saved as step `2_app_account_links` saves the app's own, without reading the
 * copy's requirements: a copy saved undeployed declares none until it is deployed, and its links
 * must wait for that, not be dropped. Runs resolve links only for the requirements a version
 * declares in their scope.
 */
export const localAppCopies = (
  sql: SqlClient.SqlClient,
  executor: Executor,
): ProfileAppCopiesHost["appCopies"] => ({
  copy: ({ from, id, name, save }) =>
    executor.apps.copyAs({ from: from.id, owner: from.owner, name, id, save }),
  link: ({ app, links, webhookConfig }) => {
    const config = Schema.decodeUnknownOption(WebhookSourceConfig)(webhookConfig);
    return executor[StorageHost].transaction(
      Effect.gen(function* () {
        yield* lockApp(sql, app);
        for (const { requirement, account } of links) {
          // Each link is dated when it is made, so the plan's order is kept.
          const inserted = yield* writeLinks(
            executor,
            sql`insert into local_app_account_links
                (app, requirement, subject, account, created_at)
              select ${app}, ${requirement}, ${localActor}, a.id, clock_timestamp()
                from executor_accounts a
                join executor_apps copy on copy.id = ${app} and copy.owner = a.owner
                where a.id = ${account}
              on conflict do nothing returning account`,
          );
          if (inserted.length === 0) continue;
          yield* syncSource(sql, executor, {
            app,
            account,
            changed: localActor,
            ...(config._tag === "Some" ? { config: config.value } : {}),
          });
        }
      }).pipe(Effect.catchTag("SqlError", () => new StorageError())),
    );
  },
});

/** The IDs of the user accounts, and of the app accounts that pass `linked`. */
const passing = (
  accounts: readonly Pick<Account, "id">[],
  uses: readonly AppAccountUse[],
  linked: (use: AppAccountUse) => boolean,
) => {
  // An account used by both scopes must pass both checks: refused for any requirement, refused.
  const refused = new Set(uses.filter((use) => !linked(use)).map((use) => use.account.id));
  return new Set(
    [...accounts.map((account) => account.id), ...uses.map((use) => use.account.id)].filter(
      (id) => !refused.has(id),
    ),
  );
};

/**
 * Background work resolves the local subject's accounts from its user links, and the app's from its
 * app links. Local has no other product authority: every linked account it resolves is usable, and
 * an app account is authorized by its current app link to the requirement. An account connected
 * from an app is linked to its requirement in the scope the requirement has, replacing as linking
 * does.
 */
export const localResourceLifecycle = (
  executor: Effect.Effect<Executor>,
  sql: SqlClient.SqlClient,
): ResourceLifecycle => ({
  userLinks: (input) =>
    Effect.gen(function* () {
      const sdk = yield* executor;
      const app = yield* storage(sdk.apps.get({ app: input.app }));
      return (yield* linkedAccountsOf(sql, sdk, app, localActor)).map((link) => ({
        requirement: link.requirement,
        account: link.account.id,
      }));
    }),
  appLinks: (input) =>
    Effect.gen(function* () {
      const sdk = yield* executor;
      const app = yield* storage(sdk.apps.get({ app: input.app }));
      return (yield* linkedAccountsOf(sql, sdk, app, null)).map((link) => ({
        requirement: link.requirement,
        account: link.account.id,
      }));
    }),
  // Nobody else links the account, so a source the app no longer uses stops.
  sourceActorLost: (input) =>
    Effect.flatMap(executor, (sdk) => unlinkSource(sdk, input.app, input.account)),
  // The local subject may use every account it resolves. An app requirement's account must still
  // be the app owner's and linked to the app for that requirement: unlinking refuses it at once.
  appResolving: (app, accounts, appUses) =>
    Effect.gen(function* () {
      if (appUses.length === 0) return passing(accounts, [], () => true);
      const sdk = yield* executor;
      const rows = yield* decode(
        Schema.Struct({ requirement: Schema.NonEmptyString, account: AccountId }),
      )(
        yield* readLinks(
          sdk,
          sql`select requirement, account from local_app_account_links
            where app = ${app.id} and subject is null and ${sql.in(
              "account",
              appUses.map((use) => use.account.id),
            )}`,
        ),
      );
      const current = new Set(rows.map((row) => `${row.requirement}\u0000${row.account}`));
      return passing(
        accounts,
        appUses,
        (use) =>
          use.account.owner === app.owner &&
          current.has(`${use.requirement}\u0000${use.account.id}`),
      );
    }).pipe(Effect.catchTags(sqlFailures)),
  // Removing what the app registered needs no current app link: unlinking is what removes its
  // registrations. An app account passes while it is the app owner's, so the app could have linked
  // it.
  removalResolving: (app, accounts, appUses) =>
    Effect.succeed(passing(accounts, appUses, (use) => use.account.owner === app.owner)),
  accountsResolving: (accounts) => Effect.succeed(new Set(accounts.map((account) => account.id))),
  connectionCompleting: () => Effect.void,
  appCreated: () => Effect.void,
  appRemoving: () => Effect.void,
  // The owner links in both scopes. The SDK has checked, under the app's lock, that the
  // requirement still has the scope the connection was started for.
  appAccountConnected: (input) =>
    Effect.gen(function* () {
      const sdk = yield* executor;
      const app = yield* storage(sdk.apps.get({ app: input.app }));
      yield* addLink(sql, sdk, {
        app,
        requirement: input.requirement,
        account: input.account,
        subject: scopeSubject(input.scope),
      }).pipe(
        Effect.mapError((error) =>
          Schema.is(AccountProvisioned)(error) ? error : new StorageError(),
        ),
      );
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(AccountProvisioned)(error) ? error : new StorageError(),
      ),
    ),
  accountCreated: () => Effect.void,
  // An app link is used by its app for every call; the route refuses with the apps that link it,
  // and this refuses an app link made since. Its user links are removed with it.
  accountRemoving: (account) =>
    Effect.flatMap(executor, (sdk) => appLinkApps(sql, sdk, account.id)).pipe(
      Effect.flatMap((apps) => (apps.length > 0 ? new StorageError() : Effect.void)),
    ),
});
