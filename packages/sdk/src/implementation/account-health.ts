/**
 * Account checks run by the apps that select an account. Each app's active deployment runs its
 * provider's check with the account's current credentials; results are kept per account and app.
 */
import { Clock, Effect, Match, Option, Redacted, Result, Schema } from "effect";
import { AccountInfo, HostOperationFailed, ProviderError } from "apps/contracts";
import { AccountCheckStatus, type AccountHealth } from "../contracts/account.ts";
import { SelectedAccounts, type App } from "../contracts/apps.ts";
import type { Executor } from "../contracts/executor.ts";
import { OAuthReconnectRequired, OAuthRenewalFailed } from "../contracts/oauth.ts";
import type { Runtime } from "../contracts/runtime.ts";
import {
  AccountId,
  JsonObject,
  StorageError,
  type AppId,
  type OwnerId,
} from "../contracts/shared.ts";
import { AppNotFound } from "../contracts/apps.ts";
import { type AccountCredential, invocationAccount, validateFields } from "./provider.ts";
import { StoredDeployment, type StoredAccount } from "../contracts/storage.ts";
import { storedAccount } from "./accounts.ts";
import { query, type Query } from "./database.ts";
import type { makeOAuth } from "./oauth.ts";
import type { FirstPartyOAuthClient } from "../contracts/oauth.ts";

/**
 * A check answers an interactive request, so the whole check, including credential renewal and
 * one retry, has a fixed limit. It leaves room for servers that are slow to start a session: in
 * production, one MCP connection in twenty takes over 2.5 seconds to list its tools. Self-host's
 * listener allows 30 seconds without a response.
 */
const checkMillis = 15_000;
/**
 * The app's own deadline, shared by its attempts, ends this long before the whole check. The
 * provider's `health` receives it as `deadline`, so a check such as `mcpHealth` can give up in time
 * to say why before the host stops waiting.
 */
const reportMillis = 1_000;

type OAuth = Pick<ReturnType<typeof makeOAuth>, "resolve" | "renewRejected">;
type ListApps = (input: {
  readonly account?: StoredAccount["id"];
  readonly owner?: OwnerId;
  readonly ids?: readonly AppId[];
}) => Effect.Effect<readonly App[], StorageError>;
type HealthAccount = Pick<StoredAccount, "id" | "provider" | "credentialGeneration">;
type CheckRow = {
  readonly account: string;
  readonly app: string;
  readonly deployment: string;
  readonly credentialGeneration: number;
  readonly status: string;
  readonly checkedAt: Date;
  readonly info: unknown;
  readonly infoCheckedAt: Date | null;
  readonly message: string | null;
};

/** The slot whose provider check covers this account in the app's active deployment. */
const checkedSlot = (app: App, account: Pick<HealthAccount, "provider">) =>
  Object.entries(app.requirements.accounts)
    .filter(([, required]) => required.provider === account.provider && required.health === true)
    .map(([slot, required]) => ({ slot, required }))
    .sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0))[0];

const sameFields = Schema.toEquivalence(JsonObject);
/** Unsaved credentials have no account yet; checks see this placeholder ID. */
const unsavedAccount = AccountId.make("acc_unsaved");
const decodeFields = (fields: Redacted.Redacted<unknown>) =>
  Schema.decodeUnknownEffect(JsonObject)(Redacted.value(fields)).pipe(
    Effect.mapError(() => new StorageError()),
  );

const statusOf = (error: unknown): AccountCheckStatus =>
  Schema.is(OAuthReconnectRequired)(error)
    ? "credentials_rejected"
    : Schema.is(OAuthRenewalFailed)(error)
      ? "upstream_unavailable"
      : Schema.is(ProviderError)(error)
        ? Match.value(error.reason).pipe(
            Match.when("unauthorized", () => "credentials_rejected" as const),
            Match.when("forbidden", () => "forbidden" as const),
            Match.when("unavailable", () => "upstream_unavailable" as const),
            Match.when("rate_limited", () => "upstream_unavailable" as const),
            Match.when("rejected", () => "check_failed" as const),
            Match.exhaustive,
          )
        : "check_failed";

/**
 * Why a check failed: the message of an error the app's check threw, the answer of a service that
 * refused it without a recognized reason, or, once the app's deadline passed, that it ran out of
 * time. The host reports an app that outlasts its deadline as an engine failure, so the time is what
 * tells. Other failures keep their causes private.
 */
const messageOf = (error: unknown, late: boolean): string | undefined => {
  if (Schema.is(HostOperationFailed)(error) && error.message !== undefined && error.message !== "")
    return error.message;
  if (Schema.is(ProviderError)(error) && error.reason === "rejected") {
    const stated =
      error.upstream === undefined
        ? ""
        : `: ${error.upstream.code}${error.upstream.message === undefined ? "" : ` (${error.upstream.message})`}`;
    return `${error.status === undefined ? "The service refused the check" : `The service answered HTTP ${error.status}`}${stated}.`;
  }
  return late ? `The check did not finish within ${checkMillis / 1_000} seconds.` : undefined;
};

export const makeAccountHealth = (
  db: Query,
  runtime: Runtime,
  oauth: OAuth,
  clients: ReadonlyMap<string, FirstPartyOAuthClient>,
  listApps: ListApps,
) => {
  /** One account's health from the apps that select it and its recorded checks. */
  const project = (account: HealthAccount, apps: readonly App[], rows: readonly CheckRow[]) =>
    Effect.gen(function* () {
      const latest = rows
        .filter((row) => row.info !== null && row.infoCheckedAt !== null)
        .sort((a, b) => (b.infoCheckedAt?.getTime() ?? 0) - (a.infoCheckedAt?.getTime() ?? 0))[0];
      const info =
        latest === undefined ? Option.none() : Schema.decodeUnknownOption(AccountInfo)(latest.info);
      return {
        account: account.id,
        info: Option.getOrNull(info),
        infoCheckedAt: Option.isSome(info) ? (latest?.infoCheckedAt ?? null) : null,
        apps: yield* Effect.forEach(apps, (app) =>
          Effect.gen(function* () {
            const row = rows.find((item) => item.app === app.id);
            const check =
              row === undefined
                ? null
                : {
                    status: yield* Schema.decodeUnknownEffect(AccountCheckStatus)(row.status).pipe(
                      Effect.mapError(() => new StorageError()),
                    ),
                    checkedAt: row.checkedAt,
                    current:
                      row.deployment === app.activeDeployment &&
                      row.credentialGeneration === account.credentialGeneration,
                    ...(row.message === null ? {} : { message: row.message }),
                  };
            return { app: app.id, checkable: checkedSlot(app, account) !== undefined, check };
          }),
        ),
      } satisfies AccountHealth;
    });

  const report = (account: StoredAccount) =>
    Effect.gen(function* () {
      // Apps are found by the profiles that select the account; their owner can differ from the
      // account's, as in local, where apps belong to the host and accounts to its user.
      const apps = yield* listApps({ account: account.id });
      const rows = yield* query(() =>
        db.findMany("accountChecks", { where: (b) => b("account", "=", account.id) }),
      );
      return yield* project(account, apps, rows);
    });

  /**
   * Every account's health with a fixed number of reads, for account lists. An owner filter
   * limits the accounts, profiles and apps read to that owner, as for a hosted organization.
   */
  const listHealth = (input: NonNullable<Parameters<Executor["accounts"]["listHealth"]>[0]> = {}) =>
    Effect.gen(function* () {
      const accounts = yield* query(() =>
        db.findMany("accounts", {
          select: ["id", "provider", "credentialGeneration"],
          where: (b) => (input.owner === undefined ? true : b("owner", "=", input.owner)),
          orderBy: ["id", "asc"],
        }),
      );
      if (accounts.length === 0) return [];
      const ids = accounts.map((account) => account.id);
      const rows = yield* query(() =>
        db.findMany("accountChecks", { where: (b) => b("account", "in", ids) }),
      );
      const profiles = yield* query(() =>
        db.findMany("profiles", {
          select: ["app", "accounts"],
          where: (b) =>
            b.and(
              input.owner === undefined ? true : b("owner", "=", input.owner),
              b("status", "!=", "removed"),
            ),
        }),
      );
      const apps = yield* listApps(input.owner === undefined ? {} : { owner: input.owner });
      const selections = profiles.map((profile) => ({
        app: profile.app,
        accounts: new Set(
          Object.values(
            Option.getOrElse(
              Schema.decodeUnknownOption(SelectedAccounts)(profile.accounts),
              () => ({}),
            ),
          ).flatMap((selection) => (typeof selection === "string" ? [selection] : selection)),
        ),
      }));
      return yield* Effect.forEach(accounts, (account) =>
        project(
          account,
          apps.filter((app) =>
            selections.some(
              (selection) => selection.app === app.id && selection.accounts.has(account.id),
            ),
          ),
          rows.filter((row) => row.account === account.id),
        ),
      );
    }).pipe(Effect.withSpan("sdk.accounts.listHealth"));

  /** Run one app's check and record it, unless a check that started later already finished. */
  const checkApp = (app: App, account: StoredAccount) =>
    Effect.gen(function* () {
      const target = checkedSlot(app, account);
      if (target === undefined || app.activeDeployment === null) return;
      const deploymentId = app.activeDeployment;
      const row = yield* query(() =>
        db.findFirst("deployments", { where: (b) => b("id", "=", deploymentId) }),
      );
      if (row === null) return;
      const deployment = yield* Schema.decodeUnknownEffect(StoredDeployment)(row).pipe(
        Effect.mapError(() => new StorageError()),
      );
      const startedAt = yield* Clock.currentTimeMillis;
      const deadline = startedAt + checkMillis - reportMillis;
      const definition = target.required.definition;
      // Each attempt binds the credential as resolved, so whether it is managed is read with its
      // values, even if a reconnect replaced it since this check read the account.
      const attempt = (credential: AccountCredential) =>
        runtime.checkAccount({
          app: app.id,
          build: deployment.build,
          requirement: target.slot,
          deadline,
          accounts: Redacted.make({
            [target.slot]: invocationAccount(account, definition, credential, clients),
          }),
        });
      const outcome = yield* Effect.gen(function* () {
        const credential = yield* oauth.resolve(account, definition);
        const first = yield* attempt(credential).pipe(Effect.result);
        if (Result.isSuccess(first)) return first.success;
        const refused = first.failure;
        if (!Schema.is(ProviderError)(refused) || refused.reason !== "unauthorized")
          return yield* Effect.fail(refused);
        // Renew once when the service refused the credentials, as tool calls do. Secrets accounts
        // and grants without a refresh token return the same fields, so there is nothing to retry.
        const fields = Redacted.value(credential.fields);
        const renewed = yield* oauth.renewRejected(account, definition, fields);
        if (sameFields(Redacted.value(renewed.fields), fields)) return yield* Effect.fail(refused);
        return yield* attempt(renewed);
      }).pipe(Effect.timeout(checkMillis), Effect.result);
      const late = (yield* Clock.currentTimeMillis) >= deadline;
      // Authorization and storage failures belong to the caller, not the account.
      if (Result.isFailure(outcome) && Schema.is(StorageError)(outcome.failure))
        return yield* Effect.fail(outcome.failure);
      const status = Result.isSuccess(outcome) ? "healthy" : statusOf(outcome.failure);
      const reported = Result.isSuccess(outcome) ? outcome.success.accountInfo : undefined;
      const info =
        reported === undefined
          ? undefined
          : yield* Schema.encodeEffect(AccountInfo)(reported).pipe(
              Effect.mapError(() => new StorageError()),
            );
      const checkedAt = new Date(startedAt);
      const state = {
        deployment: deployment.id,
        credentialGeneration: account.credentialGeneration,
        status,
        checkedAt,
        message: Result.isSuccess(outcome) ? null : (messageOf(outcome.failure, late) ?? null),
        ...(info === undefined ? {} : { info, infoCheckedAt: checkedAt }),
      };
      const existing = yield* query(() =>
        db.findFirst("accountChecks", {
          where: (b) => b.and(b("account", "=", account.id), b("app", "=", app.id)),
        }),
      );
      if (existing !== null && existing.checkedAt.getTime() > startedAt) return;
      yield* query(() =>
        db.upsert("accountChecks", {
          where: (b) => b.and(b("account", "=", account.id), b("app", "=", app.id)),
          create: { id: `${account.id}:${app.id}`, account: account.id, app: app.id, ...state },
          update: state,
        }),
      );
      yield* Effect.annotateCurrentSpan({
        "executor.account.check.status": status,
      });
    }).pipe(
      Effect.withSpan("sdk.accounts.checkApp", {
        attributes: { "executor.app.id": app.id, "executor.account.id": account.id },
      }),
    );

  /**
   * Check credentials that are not saved yet, with the app's check for their provider, so a form
   * can confirm them before saving. Nothing is recorded. Null when the app defines no check.
   */
  const checkCredentials = (input: Parameters<Executor["apps"]["checkCredentials"]>[0]) =>
    Effect.gen(function* () {
      const [app] = yield* listApps({
        ids: [input.app],
        ...(input.owner === undefined ? {} : { owner: input.owner }),
      });
      if (app === undefined) return yield* new AppNotFound({ app: input.app });
      const target = checkedSlot(app, { provider: input.provider });
      const deploymentId = app.activeDeployment;
      if (target === undefined || deploymentId === null) return null;
      const fields = yield* validateFields(
        input.provider,
        target.required.definition,
        input.method,
        input.fields,
      ).pipe(Effect.flatMap(decodeFields));
      const row = yield* query(() =>
        db.findFirst("deployments", { where: (b) => b("id", "=", deploymentId) }),
      );
      if (row === null) return null;
      const deployment = yield* Schema.decodeUnknownEffect(StoredDeployment)(row).pipe(
        Effect.mapError(() => new StorageError()),
      );
      const deadline = (yield* Clock.currentTimeMillis) + checkMillis - reportMillis;
      const outcome = yield* runtime
        .checkAccount({
          app: app.id,
          build: deployment.build,
          requirement: target.slot,
          deadline,
          accounts: Redacted.make({
            [target.slot]: {
              id: unsavedAccount,
              provider: target.required.definition,
              method: input.method,
              generation: 0,
              fields,
            },
          }),
        })
        .pipe(Effect.timeout(checkMillis), Effect.result);
      const late = (yield* Clock.currentTimeMillis) >= deadline;
      if (Result.isFailure(outcome) && Schema.is(StorageError)(outcome.failure))
        return yield* Effect.fail(outcome.failure);
      if (Result.isSuccess(outcome))
        return { status: "healthy" as const, info: outcome.success.accountInfo ?? null };
      const message = messageOf(outcome.failure, late);
      return {
        status: statusOf(outcome.failure),
        info: null,
        ...(message === undefined ? {} : { message }),
      };
    }).pipe(Effect.withSpan("sdk.accounts.checkCredentials"));

  return {
    checkCredentials,
    listHealth,
    health: (input: Parameters<Executor["accounts"]["health"]>[0]) =>
      storedAccount(db, input.account, input.owner).pipe(
        Effect.flatMap(report),
        Effect.withSpan("sdk.accounts.health"),
      ),
    check: (input: Parameters<Executor["accounts"]["check"]>[0]) =>
      Effect.gen(function* () {
        const account = yield* storedAccount(db, input.account, input.owner);
        const only = input.apps === undefined ? undefined : new Set<AppId>(input.apps);
        const apps = (yield* listApps({ account: account.id })).filter(
          (app) => only === undefined || only.has(app.id),
        );
        yield* Effect.forEach(apps, (app) => checkApp(app, account), {
          concurrency: 4,
          discard: true,
        });
        return yield* report(account);
      }).pipe(Effect.withSpan("sdk.accounts.check")),
  };
};
