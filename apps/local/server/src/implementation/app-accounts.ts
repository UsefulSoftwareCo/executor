import {
  AccountChoiceUnsupported,
  AccountId,
  AccountNotFound,
  AccountProvisioned,
  AppId,
  isProvisionedMethod,
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
export const scopeSubject = (scope: AccountScope) => (scope === "app" ? null : localActor);
const linksTable = ["local_app_account_links"];
const readLinks = <A, E, R>(executor: Executor, effect: Effect.Effect<A, E, R>) =>
  executor[StorageHost].read(linksTable, effect);
const writeLinks = <A, E, R>(executor: Executor, effect: Effect.Effect<A, E, R>) =>
  executor[StorageHost].write(linksTable, effect);
const sameSubject = (sql: SqlClient.SqlClient, subject: string | null) =>
  subject === null ? sql`l.subject is null` : sql`l.subject = ${subject}`;

const ownerAccounts = (executor: Executor, app: App, needed: boolean) =>
  needed
    ? Effect.map(
        executor.accounts.list({ owner: app.owner }),
        (accounts) => new Map(accounts.map((account) => [account.id, account])),
      )
    : Effect.succeed(new Map<AccountId, Account>());

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

export const linkedAccounts = (sql: SqlClient.SqlClient, executor: Executor, app: App) =>
  Effect.map(linkedAccountsOf(sql, executor, app, localActor), (links) =>
    links.map((link) => link.account),
  );

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
export const accountLinks = (sql: SqlClient.SqlClient, executor: Executor, account?: AccountId) =>
  readLinks(
    executor,
    account === undefined
      ? sql`select app, requirement, account, subject from local_app_account_links
        order by created_at, account`
      : sql`select app, requirement, account, subject from local_app_account_links
        where account = ${account} order by created_at, app`,
  ).pipe(Effect.flatMap(decode(AnyLink)), Effect.catchTags(sqlFailures));

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

export const requireScopedRequirement = (
  executor: Executor,
  input: { readonly app: AppId; readonly requirement: string; readonly scope: AccountScope },
) =>
  Effect.flatMap(executor.apps.get({ app: input.app }), (app) =>
    scopedRequirement(app, input.scope, input.requirement),
  );

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
          .filter(
            (account) =>
              !linkedIds.has(account.id) &&
              !isProvisionedMethod(required.definition, account.method),
          )
          .map((account) => ({ account, linked: false })),
      ],
    } satisfies AppAccountRequirement;
  });

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

export const versionAccounts = (
  sql: SqlClient.SqlClient,
  executor: Executor,
  version: AppVersion,
) =>
  Effect.flatMap(versionRequirementAccounts(sql, executor, version), (accounts) =>
    resolveLinkedAccounts({ app: version.app.id, version: version.version, ...accounts }),
  );

export const callerAccounts = (sql: SqlClient.SqlClient, executor: Executor, app: App) =>
  versionAccounts(sql, executor, activeVersion(app));

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

const lockApp = (sql: SqlClient.SqlClient, app: AppId) =>
  sql`select id from executor_apps where id = ${app} for no key update`.pipe(Effect.asVoid);

const unlinkSource = (executor: Executor, app: AppId, account: AccountId) =>
  executor.webhooks.unlink({ app, account }).pipe(
    Effect.catchTag("WebhookNotFound", () => Effect.void),
    storage,
  );

const SubjectRow = Schema.Struct({ subject: Schema.NullOr(Schema.String) });
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

interface LinkKey {
  readonly app: AppId;
  readonly requirement: string;
  readonly account: AccountId;
  readonly subject: string | null;
}

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

const passing = (
  accounts: readonly Pick<Account, "id">[],
  uses: readonly AppAccountUse[],
  linked: (use: AppAccountUse) => boolean,
) => {
  const refused = new Set(uses.filter((use) => !linked(use)).map((use) => use.account.id));
  return new Set(
    [...accounts.map((account) => account.id), ...uses.map((use) => use.account.id)].filter(
      (id) => !refused.has(id),
    ),
  );
};

export const localResourceLifecycle = (
  executor: Effect.Effect<Executor>,
  sql: SqlClient.SqlClient,
): ResourceLifecycle => {
  const appResolving: ResourceLifecycle["appResolving"] = (app, accounts, appUses) =>
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
    }).pipe(Effect.catchTags(sqlFailures));
  return {
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
    sourceActorLost: (input) =>
      Effect.flatMap(executor, (sdk) => unlinkSource(sdk, input.app, input.account)),
    appResolving,
    appsResolving: (owner, apps) =>
      Effect.forEach(apps, (app) =>
        Effect.result(appResolving({ id: app.id, owner }, app.accounts, app.appUses)),
      ),
    removalResolving: (app, accounts, appUses) =>
      Effect.succeed(passing(accounts, appUses, (use) => use.account.owner === app.owner)),
    accountsResolving: (accounts) => Effect.succeed(new Set(accounts.map((account) => account.id))),
    connectionCompleting: () => Effect.void,
    appCreated: () => Effect.void,
    appRemoving: () => Effect.void,
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
    accountRemoving: (account) =>
      Effect.flatMap(executor, (sdk) => appLinkApps(sql, sdk, account.id)).pipe(
        Effect.flatMap((apps) => (apps.length > 0 ? new StorageError() : Effect.void)),
      ),
  };
};
