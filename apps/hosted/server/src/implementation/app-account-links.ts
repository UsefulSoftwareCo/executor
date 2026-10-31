/**
 * The routes that link accounts to an app's requirements, in either scope. App links need edit
 * access to the app and, to link, use of the account; reading them needs use of the app. User links
 * are the caller's own: linking another person's account is never possible.
 */
import {
  AccountNotFound,
  StorageError,
  StorageHost,
  InteractiveHost,
  type Account,
  type AccountId,
  type AccountScope,
  type App,
  type AppId,
  type Executor,
  type OwnerId,
} from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { HttpApiBuilder } from "effect/http-api";
import { HostedApi } from "../contracts/api.ts";
import {
  RequirementMismatch,
  type AppAccountLink,
  type AppAccountRequirement,
  type LinkedAccountSignIn,
} from "../contracts/app-accounts.ts";
import { ApiAuthentication, Authentication, CurrentUserId } from "../contracts/auth.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { OrganizationForbidden } from "../contracts/organization.ts";
import { ScheduleWakeup } from "../contracts/schedules.ts";
import type { ConnectionDestination } from "../contracts/resource-access.ts";
import { appManagerOwner, currentOwner, usableApp } from "./access.ts";
import { canDeleteAccount, replacingAccounts } from "./interactive-retirement.ts";
import { connectAccount, connectionUrl } from "./accounts.ts";
import { accountOAuthRedirectUri } from "./auth.ts";
import { addLink, callerLinkedAccounts, lockedChange, removeLink } from "./app-accounts.ts";
import {
  policyDatabase,
  requireAccountAccess,
  requireCurrentAppAccess,
  visibleAccounts,
} from "./resource-policy.ts";

const caller = Effect.gen(function* () {
  const user = yield* CurrentUserId;
  if (user === undefined) return yield* new OrganizationForbidden();
  return user;
});

const LinkRecord = Schema.Struct({
  requirement: Schema.NonEmptyString,
  account: Schema.String,
  createdAt: Schema.Date,
});
type LinkRecord = typeof LinkRecord.Type;

/** A linked account's saved sign-in state, without its credentials fingerprint. */
const signIn = (executor: Executor, owner: OwnerId, account: AccountId) =>
  executor.accounts
    .signIn({ owner, account })
    .pipe(
      Effect.map((state): LinkedAccountSignIn =>
        state.state === "saved"
          ? { state: "saved", reconnectAt: state.reconnectAt }
          : { state: state.state },
      ),
    );

/**
 * Links with each account, its sign-in and its checks by this app, in the records' order. A link
 * whose account no longer exists, or belongs to another owner, is left out. Without `identity`, the
 * upstream identity the checks reported is left out.
 */
const linkViews = (
  executor: Executor,
  owner: OwnerId,
  app: AppId,
  records: ReadonlyArray<LinkRecord>,
  identity: boolean,
) =>
  Effect.gen(function* () {
    if (records.length === 0) return [];
    const accounts = new Map(
      (yield* executor.accounts.list({ owner })).map((account) => [account.id as string, account]),
    );
    const present = records.flatMap((record) => {
      const account = accounts.get(record.account);
      return account === undefined ? [] : [{ record, account }];
    });
    const health = new Map(
      (yield* executor.accounts.listHealth({
        owner,
        links: present.map(({ account }) => ({ app, account: account.id })),
      })).map((entry) => [entry.account, entry]),
    );
    const views = yield* Effect.forEach(
      present,
      ({ record, account }) => {
        const checks = health.get(account.id);
        return Effect.all([
          signIn(executor, owner, account.id),
          executor[InteractiveHost].binding({ owner, account: account.id }),
        ]).pipe(
          Effect.map(([state, binding]): AppAccountLink[] => [
            {
              requirement: record.requirement,
              account,
              createdAt: record.createdAt,
              signIn: state,
              canReconnect: binding === undefined,
              ...(checks === undefined
                ? {}
                : {
                    health: identity ? checks : { ...checks, info: null, infoCheckedAt: null },
                  }),
            },
          ]),
          // The account was removed since it was listed.
          Effect.catchTag("AccountNotFound", () => Effect.succeed([])),
        );
      },
      { concurrency: 8 },
    );
    return views.flat();
  });

/** The app's links in one scope, oldest first per requirement, optionally of one requirement. */
const linkRecords = (app: AppId, subject: string | null, requirement?: string) =>
  Effect.gen(function* () {
    const sql = yield* policyDatabase;
    return yield* sql`select l.requirement, l.account, l.created_at as "createdAt"
      from hosted_app_account_links l
      where l.app = ${app}
        and ${subject === null ? sql`l.subject is null` : sql`l.subject = ${subject}`}
        and ${requirement === undefined ? sql`true` : sql`l.requirement = ${requirement}`}
      order by l.requirement, l.created_at, l.account`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(LinkRecord))),
      Effect.mapError(() => new StorageError()),
    );
  });

/**
 * The caller's user links to an app whose accounts they may still use and their grant permits,
 * oldest first per requirement.
 */
const userLinkRecords = (app: AppId, requirement?: string) =>
  Effect.gen(function* () {
    const subject = yield* caller;
    const usable = new Set(
      (yield* callerLinkedAccounts([app])).map((link) => `${link.requirement}\u0000${link.id}`),
    );
    return (yield* linkRecords(app, subject, requirement)).filter((record) =>
      usable.has(`${record.requirement}\u0000${record.account}`),
    );
  });

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

/**
 * One requirement: its linked accounts, oldest first, then the other accounts of its provider the
 * caller can use, which they could link.
 */
const requirementView = (
  executor: Executor,
  owner: OwnerId,
  app: App,
  scope: AccountScope,
  requirement: string,
  linked: ReadonlyArray<LinkRecord>,
) =>
  Effect.gen(function* () {
    const required = yield* scopedRequirement(app, scope, requirement);
    const all = yield* executor.accounts.list({ owner, provider: required.provider });
    const byId = new Map(all.map((account) => [account.id as string, account]));
    const linkedAccounts = linked.flatMap((record) => {
      const account = byId.get(record.account);
      return account === undefined ? [] : [account];
    });
    const linkedIds = new Set(linkedAccounts.map((account) => account.id));
    const candidates = (yield* visibleAccounts(all)).filter(
      (account) => !linkedIds.has(account.id),
    );
    const usable = (yield* Effect.forEach(
      candidates,
      (account) =>
        executor[InteractiveHost]
          .binding({ owner, account: account.id })
          .pipe(
            Effect.map((binding) =>
              binding === undefined || binding.app === app.id ? [account] : [],
            ),
          ),
      { concurrency: 8 },
    )).flat();
    return {
      requirement,
      scope,
      provider: required.provider,
      cardinality: required.cardinality,
      accounts: [
        ...linkedAccounts.map((account: Account) => ({ account, linked: true })),
        ...usable.map((account: Account) => ({ account, linked: false })),
      ],
    } satisfies AppAccountRequirement;
  });

const wake = Effect.flatten(ScheduleWakeup);

/** The link a route just made, as the scope's list shows it. */
const savedLink = (
  executor: Executor,
  owner: OwnerId,
  app: AppId,
  subject: string | null,
  requirement: string,
  account: AccountId,
) =>
  Effect.gen(function* () {
    const records = (yield* linkRecords(app, subject, requirement)).filter(
      (record) => record.account === account,
    );
    const [view] = yield* linkViews(executor, owner, app, records, true);
    if (view === undefined) return yield* new AccountNotFound({ account });
    return view;
  });

const connect = (
  services: {
    readonly auth: Authentication["Service"];
    readonly api: ApiAuthentication["Service"];
  },
  scope: AccountScope,
  params: { readonly app: AppId; readonly requirement: string },
  payload: {
    readonly destination?: typeof ConnectionDestination.Type | undefined;
    readonly account?: AccountId | undefined;
  },
) =>
  Effect.gen(function* () {
    const owner = yield* currentOwner;
    const connection = yield* connectAccount(owner, {
      app: params.app,
      requirement: params.requirement,
      scope,
      ...payload,
    });
    return {
      ...connection,
      url: yield* connectionUrl(services.auth, services.api, connection.id),
      redirectUri: accountOAuthRedirectUri(services.auth),
    };
  });

/** Retire app-owned credentials before deleting their links, keeping a failed remove reversible. */
const unlink = (
  scope: AccountScope,
  params: { readonly app: AppId; readonly requirement: string; readonly account: AccountId },
) =>
  Effect.gen(function* () {
    const owner = yield* scope === "app" ? appManagerOwner(params.app) : currentOwner;
    const executor = yield* Effect.flatten(HostedExecutor);
    yield* executor.apps.get({ owner, app: params.app });
    const subject = scope === "app" ? null : yield* caller;
    const records = yield* linkRecords(params.app, subject, params.requirement);
    if (!records.some((row) => row.account === params.account))
      return yield* new AccountNotFound({ account: params.account });
    const binding = yield* executor[InteractiveHost].binding({ owner, account: params.account });
    const interactive = binding?.app === params.app && (yield* canDeleteAccount(params.account));
    const remove = (sql: SqlClient.SqlClient) =>
      Effect.gen(function* () {
        const removed = yield* removeLink(sql, executor.webhooks, { ...params, subject });
        if (!removed) return yield* new AccountNotFound({ account: params.account });
      });
    // Unlinking your own link needs no current access, so a member can clean up after losing it.
    const change =
      scope === "app"
        ? lockedChange(executor, { app: params.app, access: "manage" }, remove)
        : Effect.flatMap(policyDatabase, (sql) => executor[StorageHost].transaction(remove(sql)));
    yield* executor[InteractiveHost].retire(
      { owner, accounts: interactive ? [params.account] : [] },
      change,
    );
    yield* wake;
    return { requirement: params.requirement, account: params.account };
  });

/**
 * Links change webhook sources, whose reconciliation is woken once the change commits. Editing the
 * app is what links its app accounts; linking also needs use of the account. Each change checks
 * that access again under the app's link lock (see `lockedChange`).
 */
export const hostedAppAccountHandlers = HttpApiBuilder.group(HostedApi, "appAccounts", (handlers) =>
  Effect.gen(function* () {
    const services = { auth: yield* Authentication, api: yield* ApiAuthentication };
    return handlers
      .handle("appList", ({ params }) =>
        Effect.gen(function* () {
          const owner = yield* currentOwner;
          const executor = yield* Effect.flatten(HostedExecutor);
          // Reading needs use of the app, or edit access to it, which links its app accounts.
          const { access } = yield* requireCurrentAppAccess(params.app, "read");
          yield* executor.apps.get({ owner, app: params.app });
          const records = yield* linkRecords(params.app, null);
          // Members who cannot edit the app see which account fills each requirement and whether it
          // works, not the upstream identity behind it.
          return yield* linkViews(executor, owner, params.app, records, access.canManage);
        }),
      )
      .handle("appGet", ({ params }) =>
        Effect.gen(function* () {
          const owner = yield* appManagerOwner(params.app);
          const executor = yield* Effect.flatten(HostedExecutor);
          const app = yield* executor.apps.get({ owner, app: params.app });
          const linked = yield* linkRecords(params.app, null, params.requirement);
          return yield* requirementView(executor, owner, app, "app", params.requirement, linked);
        }),
      )
      .handle("appLink", ({ params }) =>
        Effect.gen(function* () {
          const user = yield* caller;
          const owner = yield* appManagerOwner(params.app);
          const executor = yield* Effect.flatten(HostedExecutor);
          yield* executor.apps.get({ owner, app: params.app });
          yield* requireAccountAccess(params.account, "use");
          yield* executor.accounts.get({ owner, account: params.account });
          const changed = yield* replacingAccounts(
            executor,
            {
              app: params.app,
              requirement: params.requirement,
              subject: null,
              account: params.account,
            },
            lockedChange(
              executor,
              { app: params.app, access: "manage", account: params.account },
              (sql) =>
                addLink(sql, executor.webhooks, {
                  app: params.app,
                  requirement: params.requirement,
                  account: params.account,
                  subject: null,
                  linkedBy: user,
                }),
            ),
          );
          if (changed) yield* wake;
          return yield* savedLink(
            executor,
            owner,
            params.app,
            null,
            params.requirement,
            params.account,
          );
        }),
      )
      .handle("appUnlink", ({ params }) => unlink("app", params))
      .handle("appConnect", ({ params, payload }) => connect(services, "app", params, payload))
      .handle("userList", ({ params }) =>
        Effect.gen(function* () {
          const owner = yield* currentOwner;
          const executor = yield* Effect.flatten(HostedExecutor);
          yield* usableApp(executor, owner, params.app);
          const records = yield* userLinkRecords(params.app);
          return yield* linkViews(executor, owner, params.app, records, true);
        }),
      )
      .handle("userGet", ({ params }) =>
        Effect.gen(function* () {
          const owner = yield* currentOwner;
          const executor = yield* Effect.flatten(HostedExecutor);
          const app = yield* usableApp(executor, owner, params.app);
          const linked = yield* userLinkRecords(params.app, params.requirement);
          return yield* requirementView(executor, owner, app, "user", params.requirement, linked);
        }),
      )
      .handle("userLink", ({ params }) =>
        Effect.gen(function* () {
          const user = yield* caller;
          const owner = yield* currentOwner;
          const executor = yield* Effect.flatten(HostedExecutor);
          yield* usableApp(executor, owner, params.app);
          yield* requireAccountAccess(params.account, "use");
          yield* executor.accounts.get({ owner, account: params.account });
          const changed = yield* replacingAccounts(
            executor,
            {
              app: params.app,
              requirement: params.requirement,
              subject: user,
              account: params.account,
            },
            lockedChange(
              executor,
              { app: params.app, access: "use", account: params.account },
              (sql) =>
                addLink(sql, executor.webhooks, {
                  app: params.app,
                  requirement: params.requirement,
                  account: params.account,
                  subject: user,
                  linkedBy: user,
                }),
            ),
          );
          if (changed) yield* wake;
          return yield* savedLink(
            executor,
            owner,
            params.app,
            user,
            params.requirement,
            params.account,
          );
        }),
      )
      .handle("userUnlink", ({ params }) => unlink("user", params))
      .handle("userConnect", ({ params, payload }) => connect(services, "user", params, payload));
  }),
);
