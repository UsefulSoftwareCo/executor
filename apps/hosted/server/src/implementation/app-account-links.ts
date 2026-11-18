/**
 * The routes that link accounts to an app's requirements, in either scope. App links need edit
 * access to the app and, to link, the caller's own account, or for an administrator one already
 * linked for everyone that no member but its owner would come to edit (see
 * `appLinkableAccountsAs`); unlinking needs edit access or ownership of the account; reading them
 * needs use of the app. User links are the caller's own: linking another person's account is never
 * possible.
 */
import {
  AccountNotFound,
  StorageError,
  StorageHost,
  type Account,
  type AccountId,
  type AccountScope,
  type App,
  type AppId,
  type Executor,
  type OwnerId,
} from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HostedApi } from "../contracts/api.ts";
import {
  RequirementMismatch,
  type AppAccountLink,
  type AppAccountRequirement,
  type LinkedAccountSignIn,
} from "../contracts/app-accounts.ts";
import { BearerAuthentication, SessionAuthentication, CurrentUserId } from "../contracts/auth.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { OrganizationForbidden } from "../contracts/organization.ts";
import { ScheduleWakeup } from "../contracts/schedules.ts";
import { appManagerOwner, currentOwner, usableApp } from "./access.ts";
import { connectAccount, connectionUrl } from "./accounts.ts";
import { accountOAuthRedirectUri } from "./auth.ts";
import {
  addLink,
  callerLinkedAccounts,
  lockedChange,
  removeLink,
  removeAppLinksOf,
  appLinkApps,
} from "./app-accounts.ts";
import {
  appLinkableAccounts,
  currentResourceAuthority,
  ownedAccountIds,
  policyDatabase,
  requireAccountOwner,
  requireAccountOwnerAs,
  requireAppLinkableAs,
  requireCurrentAppAccess,
  visibleAccounts,
} from "./resource-policy.ts";
import { audited } from "./security-audit.ts";

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
        return signIn(executor, owner, account.id).pipe(
          Effect.map((state): AppAccountLink[] => [
            {
              requirement: record.requirement,
              account,
              createdAt: record.createdAt,
              signIn: state,
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
    // App requirements also take accounts an administrator may reuse from another app's link.
    const candidates = yield* scope === "app"
      ? appLinkableAccounts(app.id, all)
      : visibleAccounts(all);
    const usable = candidates.filter((account) => !linkedIds.has(account.id));
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
    readonly auth: SessionAuthentication["Service"];
    readonly api: BearerAuthentication["Service"];
  },
  scope: AccountScope,
  params: { readonly app: AppId; readonly requirement: string },
  payload: { readonly account?: AccountId | undefined },
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

/**
 * Links change webhook sources, whose reconciliation is woken once the change commits. Editing the
 * app is what links its app accounts; linking also needs use of the account. Each change checks
 * that access again under the app's link lock (see `lockedChange`).
 */
export const hostedAppAccountHandlers = HttpApiBuilder.group(HostedApi, "appAccounts", (handlers) =>
  Effect.gen(function* () {
    const services = { auth: yield* SessionAuthentication, api: yield* BearerAuthentication };
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
          // The caller's own account, or one an administrator reuses from another app's link.
          const checked = yield* requireAppLinkableAs(
            yield* currentResourceAuthority,
            params.app,
            params.account,
          );
          yield* executor.accounts.get({ owner, account: params.account });
          const result = yield* lockedChange(
            executor,
            { app: params.app, access: "manage", reuse: checked === "app_link" },
            (sql, actor) =>
              Effect.gen(function* () {
                // Checked again under the lock, holding what a reuse relies on until commit.
                const authority = yield* requireAppLinkableAs(
                  actor,
                  params.app,
                  params.account,
                  true,
                );
                const changed = yield* addLink(sql, executor.webhooks, {
                  app: params.app,
                  requirement: params.requirement,
                  account: params.account,
                  subject: null,
                  linkedBy: user,
                });
                return { changed, authority };
              }),
          );
          if (result.changed) yield* wake;
          return result;
        }).pipe(
          audited(
            "app_account.link",
            { kind: "account", id: () => params.account },
            { app: params.app },
            ({ changed, authority }) => ({ authority, changed: String(changed) }),
          ),
          Effect.andThen(
            Effect.gen(function* () {
              const owner = yield* currentOwner;
              const executor = yield* Effect.flatten(HostedExecutor);
              return yield* savedLink(
                executor,
                owner,
                params.app,
                null,
                params.requirement,
                params.account,
              );
            }),
          ),
        ),
      )
      .handle("appUnlink", ({ params }) =>
        Effect.gen(function* () {
          // Unlinking needs edit access to the app, not use of the account: an editor can stop the
          // app using an account they cannot use. An account's owner may also stop any app using
          // it, since an administrator may have linked it to one they cannot edit.
          const owns = (yield* ownedAccountIds(
            [params.account],
            yield* currentResourceAuthority,
          )).has(params.account);
          const owner = owns ? yield* currentOwner : yield* appManagerOwner(params.app);
          const executor = yield* Effect.flatten(HostedExecutor);
          // An owner must already have a link here; do not disclose whether arbitrary apps exist.
          if (
            owns &&
            !(yield* appLinkApps(yield* policyDatabase, params.account)).includes(params.app)
          )
            return yield* new OrganizationForbidden();
          yield* executor.apps.get({ owner, app: params.app });
          const { removed, authority } = yield* lockedChange(
            executor,
            { app: params.app, access: "unlink", account: params.account },
            (sql, actor) =>
              Effect.gen(function* () {
                const authority = (yield* ownedAccountIds([params.account], actor)).has(
                  params.account,
                )
                  ? "owner"
                  : "app_manager";
                const removed = yield* removeLink(sql, executor.webhooks, {
                  app: params.app,
                  requirement: params.requirement,
                  account: params.account,
                  subject: null,
                });
                return { removed, authority };
              }),
          );
          if (!removed) return yield* new AccountNotFound({ account: params.account });
          yield* wake;
          return {
            authority,
            unlinked: { requirement: params.requirement, account: params.account },
          };
        }).pipe(
          audited(
            "app_account.unlink",
            { kind: "account", id: () => params.account },
            { app: params.app },
            ({ authority }) => ({ authority }),
          ),
          Effect.map(({ unlinked }) => unlinked),
        ),
      )
      .handle("appUnlinkOwned", ({ params }) =>
        Effect.gen(function* () {
          yield* requireAccountOwner(params.account);
          const executor = yield* Effect.flatten(HostedExecutor);
          yield* lockedChange(
            executor,
            { app: params.app, access: "unlink", account: params.account },
            (sql, actor) =>
              Effect.gen(function* () {
                yield* requireAccountOwnerAs(actor, params.account);
                if (!(yield* appLinkApps(sql, params.account)).includes(params.app))
                  return yield* new OrganizationForbidden();
                yield* removeAppLinksOf(executor, sql, params.account, params.app);
              }),
          );
          yield* wake;
          return { app: params.app, account: params.account };
        }).pipe(
          audited(
            "app_account.unlink",
            { kind: "account", id: () => params.account },
            { app: params.app },
            () => ({ authority: "owner" }),
          ),
        ),
      )
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
          yield* requireAccountOwner(params.account);
          yield* executor.accounts.get({ owner, account: params.account });
          const changed = yield* lockedChange(
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
      .handle("userUnlink", ({ params }) =>
        Effect.gen(function* () {
          const user = yield* caller;
          const owner = yield* currentOwner;
          const executor = yield* Effect.flatten(HostedExecutor);
          // Unlinking needs no current access, so a member can clean up after losing it.
          yield* executor.apps.get({ owner, app: params.app });
          const sql = yield* policyDatabase;
          const removed = yield* executor[StorageHost].transaction(
            removeLink(sql, executor.webhooks, {
              app: params.app,
              requirement: params.requirement,
              account: params.account,
              subject: user,
            }),
          );
          if (!removed) return yield* new AccountNotFound({ account: params.account });
          yield* wake;
          return { requirement: params.requirement, account: params.account };
        }),
      )
      .handle("userConnect", ({ params, payload }) => connect(services, "user", params, payload));
  }),
);
