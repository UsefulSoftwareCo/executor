import { ProviderError } from "apps/contracts";
import { appProviderFailure } from "./provider-error.ts";
import { invocationAccount } from "./provider.ts";
import type { FirstPartyOAuthClient } from "../contracts/oauth.ts";
/** Snapshot the configured app, then execute with the named accounts' credentials. */
import {
  Cause,
  Clock,
  type Crypto,
  Effect,
  ErrorReporter,
  Exit,
  Match,
  Option,
  Redacted,
  Result,
  Schema,
} from "effect";
import { recordedCause } from "@executor-js/telemetry/recorded-failure";
import {
  type WorkflowHostControls,
  HostToolApprovalRequired,
  ToolResultObservation,
  type HostAccount,
  type HostAccounts,
  type HostAccountSlots,
  scopedSlots,
} from "apps/contracts";
import {
  AccountRequired,
  AccountSelectionInvalid,
  AppNotFound,
  AppNotDeployed,
  invocationEntries,
  sameAccounts,
  type AccountScope,
  type AppAccounts,
  type SelectedAccounts,
} from "../contracts/apps.ts";
import { AccountNotFound } from "../contracts/account.ts";
import { VersionNotFound } from "../contracts/version.ts";
import {
  type AppAccountUse,
  CurrentActor,
  type Executor,
  type ResourceLifecycle,
} from "../contracts/executor.ts";
import {
  AppCodeEntered,
  CallFailureSources,
  runtimeFailures,
  type CallFailureSource,
  type Runtime,
} from "../contracts/runtime.ts";
import {
  Cursor,
  ToolName,
  Json,
  JsonObject,
  RequestInvalid,
  StorageError,
  CredentialsError,
  type AccountId,
  type AppId,
  type VersionId,
} from "../contracts/shared.ts";
import type { Account } from "../contracts/account.ts";
import { OAuthReconnectRequired } from "../contracts/oauth.ts";
import { GrantReadAhead, type GrantRow, type makeOAuth } from "./oauth.ts";
import {
  AppEvaluationFailed,
  type AppFailure,
  appFailure,
  appFailureText,
  type CallFailure,
  evaluationFailure,
  InputInvalid,
  AppProviderFailed,
  mayHaveWritten,
  operationMcpFailure,
  type RenewalFailure,
  ToolCallFailed,
  ToolNotFound,
  ToolKindMismatch,
  type ToolKind,
  ToolBlocked,
  ToolApprovalRequired,
  ToolPolicyFailed,
  ToolElicitationFailed,
  ToolInvocation,
  ToolInputs,
  type ToolInvocationOptions,
  type ToolListOptions,
  toolPageChars,
  type ToolResumeResult,
  type Tool,
  type ToolSummary,
  InvocationPrefetch,
  InvocationSelection,
  type PrefetchedInvocation,
  type PrefetchHost,
} from "../contracts/tools.ts";
import type { ExecutorDatabase } from "./storage.ts";
import type { ProviderDefinition } from "../contracts/provider.ts";
import {
  type Credentials,
  type StoredAccount,
  StoredApp,
  StoredVersion,
} from "../contracts/storage.ts";
import { makeToolApprovals } from "./tool-approvals.ts";
import { gotApp, storedVersion } from "./apps.ts";
import { database, query, type Query } from "./database.ts";
import type { OwnerId } from "../contracts/shared.ts";
import { invocationAccounts } from "./linked-accounts.ts";
import {
  accountAuthority,
  answered,
  chooseAccounts,
  scopedSelection,
  readSelectionAccounts,
  selectionAccountIds,
  type SelectionAccountsRead,
} from "./selection.ts";
import type { Listings, ToolListing } from "./listings.ts";
import { pageStart, pageTools } from "./tool-pages.ts";
import { ownsDatabase } from "../contracts/apps.ts";

/** The configured app with its active version, in one statement. */
const readApp = (db: Query, app: AppId) =>
  query(() =>
    db.findFirst("apps", {
      join: (b) => b.deployment(),
      where: (b) => b("id", "=", app),
    }),
  );

/**
 * The reads {@link snapshot} makes, made ahead and at once. The account read stands in only when it
 * named the accounts the call names; otherwise the snapshot reads again, in order. A read that
 * failed for storage stands in for nothing (see `answered`).
 */
interface SnapshotReads {
  readonly app: Result.Result<Effect.Success<ReturnType<typeof readApp>>, StorageError>;
  readonly accounts: SelectionAccountsRead;
}

/**
 * Resolve the app, pinned version and the named accounts before invoking authored code. The
 * snapshot keeps the current actor, so work it starts, such as a workflow, is checked against the
 * same subject later.
 *
 * These reads deliberately run outside a transaction. A transaction costs two extra round trips and
 * pins a pooled server connection (a Hyperdrive origin connection in Cloud) for as long as the
 * caller takes between statements. On Postgres at READ COMMITTED it gave no cross-statement
 * snapshot anyway. On PGlite it was atomic with respect to writers, because a transaction reserves
 * the only connection; that atomicity is dropped on purpose. A write that lands between two reads
 * cannot widen access: every cross-read disagreement fails closed (AppNotDeployed,
 * DeploymentNotFound, AccountNotFound, AccountSelectionInvalid or AccountRequired), and account
 * credentials are resolved from the returned selection afterwards.
 */
export function snapshot(
  db: Query,
  input: {
    app: AppId;
    version?: VersionId | undefined;
    accounts?: AppAccounts | undefined;
    /**
     * A selection background work captured, such as a workflow run's or a registration's, with
     * the scope it was captured in: without a caller it binds no `user`. Replaces `accounts`.
     */
    captured?: { readonly accounts: SelectedAccounts; readonly scope: AccountScope } | undefined;
    connecting?: string;
  },
  ahead?: SnapshotReads,
) {
  return Effect.gen(function* () {
    const row =
      ahead !== undefined && answered(ahead.app)
        ? yield* Effect.fromResult(ahead.app)
        : yield* readApp(db, input.app);
    if (row === null) return yield* new AppNotFound({ app: input.app });
    const app = yield* Schema.decodeUnknownEffect(StoredApp)(row).pipe(
      Effect.mapError(() => new StorageError()),
    );
    const versionId = input.version ?? app.activeVersion;
    if (versionId === null) return yield* new AppNotDeployed({ app: app.id });
    // Historical invocations retain their pinned version and its lineage check.
    const version =
      versionId !== app.activeVersion
        ? yield* storedVersion(db, app, versionId)
        : row.deployment === null
          ? yield* new VersionNotFound({ app: app.id, version: versionId })
          : yield* Schema.decodeUnknownEffect(StoredVersion)(row.deployment).pipe(
              Effect.mapError(() => new StorageError()),
            );
    const { scope, accounts, selections } = yield* chooseAccounts(
      db,
      app.id,
      version,
      input.captured === undefined
        ? input.accounts
        : scopedSelection(
            version.requirements.accounts,
            input.captured.accounts,
            input.captured.scope,
          ),
      ahead?.accounts,
      input.connecting,
    );
    return { app, version, scope, selections, accounts, actor: yield* CurrentActor };
  });
}

/**
 * The actor's app recheck run beside the snapshot's reads, before the call's own app and accounts
 * were read: the app, actor and accounts it ran for, and its outcome.
 */
export interface RecheckAhead {
  readonly app: { readonly id: AppId; readonly owner: OwnerId };
  readonly actor: string | undefined;
  readonly accounts: readonly Pick<Account, "id" | "owner">[];
  /**
   * Each app requirement's account it authorized by the app link; see
   * `ResourceLifecycle.appResolving`.
   */
  readonly appUses: readonly AppAccountUse[];
  readonly result: Exit.Exit<ReadonlySet<AccountId>, StorageError>;
}

/**
 * Which accounts resolving reads a grant for: per requirement of the app, whether its provider
 * signs in with something other than secrets, and per account, the same by the account's method
 * when its row was read. Opaque to the host, which keeps it beside the accounts it was made for.
 */
class GrantHint {
  readonly requirements: ReadonlyMap<string, boolean>;
  readonly accounts: ReadonlyMap<AccountId, boolean>;
  constructor(
    requirements: ReadonlyMap<string, boolean>,
    accounts: ReadonlyMap<AccountId, boolean>,
  ) {
    this.requirements = requirements;
    this.accounts = accounts;
  }
  static read(hint: unknown) {
    return hint instanceof GrantHint ? hint : undefined;
  }
}
/** Whether any of these sign-in types reads a grant; an unknown definition may. */
const readsGrant = (types: ReadonlyArray<string | undefined> | undefined) =>
  types === undefined || types.some((type) => type !== "secrets" && type !== "interactive");
/** The {@link GrantHint} for an app's accounts, from its version and any account rows read. */
const grantHint = (
  app: Effect.Success<ReturnType<typeof gotApp>>,
  accounts: AppAccounts | undefined,
  rows: ReadonlyArray<{ readonly id: AccountId; readonly method: string }>,
) => {
  const requirements = new Map<string, boolean>();
  for (const [slot, required] of Object.entries(app.requirements.accounts))
    requirements.set(
      slot,
      readsGrant(Object.values(required.definition.auth ?? {}).map((entry) => entry.type)),
    );
  const methods = new Map(rows.map((row) => [row.id, row.method]));
  const grants = new Map<AccountId, boolean>();
  for (const [slot, ids] of accounts === undefined ? [] : invocationEntries(accounts)) {
    const auth = app.requirements.accounts[slot]?.definition.auth;
    for (const id of ids) {
      const method = methods.get(id);
      const types =
        auth === undefined
          ? undefined
          : method === undefined
            ? Object.values(auth).map((entry) => entry.type)
            : [auth[method]?.type];
      grants.set(id, grants.get(id) === true || readsGrant(types));
    }
  }
  return new GrantHint(requirements, grants);
};
/**
 * The accounts whose grants a batch reads: those the hint says hold one, by account or else by
 * requirement; every account without a hint.
 */
const grantedAccounts = (accounts: AppAccounts, hint: GrantHint | undefined) => {
  const granted = new Set<AccountId>();
  for (const [slot, ids] of invocationEntries(accounts))
    for (const id of ids)
      if ((hint?.accounts.get(id) ?? hint?.requirements.get(slot)) !== false) granted.add(id);
  return [...granted];
};
/** Each account's grant row as read in the batch; taken once, by the account's first read. */
const grantReadAhead = (ids: readonly AccountId[], rows: ReadonlyArray<GrantRow>) => {
  const byId = new Map<AccountId, GrantRow | null>(ids.map((id) => [id, null]));
  for (const row of rows) if (byId.has(row.id as AccountId)) byId.set(row.id as AccountId, row);
  return byId;
};
/** The distinct accounts an operation names. */
const namedAccounts = (accounts: AppAccounts) => [
  ...new Set(invocationEntries(accounts).flatMap(([, ids]) => ids)),
];
/**
 * The accounts an operation names for user requirements, which the actor's use authorizes, and
 * each app requirement's account, which the app link for that requirement authorizes. An
 * account named in both scopes is in both.
 */
const scopeSplit = (accounts: AppAccounts) => ({
  user: [...new Set(Object.values(accounts.user ?? {}).flat())],
  appUses: Object.entries(accounts.app).flatMap(([requirement, ids]) =>
    ids.map((id) => ({ requirement, id })),
  ),
});
/**
 * The recheck ran for exactly this app, actor and these uses, each account under the same owner:
 * the same accounts by the actor's use, and the same accounts for the same app requirements by the
 * app link (`appUses`).
 */
const recheckedFor = (
  ahead: RecheckAhead,
  state: InvocationSnapshot,
  accounts: readonly Pick<Account, "id" | "owner">[],
  appUses: readonly AppAccountUse[],
) => {
  const same = (
    checked: ReadonlyArray<readonly [string, Pick<Account, "id" | "owner">]>,
    used: ReadonlyArray<readonly [string, Pick<Account, "id" | "owner">]>,
  ) => {
    const owners = new Map(checked.map(([use, account]) => [use, account.owner]));
    return (
      owners.size === checked.length &&
      owners.size === new Set(used.map(([use]) => use)).size &&
      used.every(([use, account]) => owners.get(use) === account.owner)
    );
  };
  const byId = (list: readonly Pick<Account, "id" | "owner">[]) =>
    list.map((account) => [account.id, account] as const);
  const byUse = (list: readonly AppAccountUse[]) =>
    list.map(
      ({ requirement, account }) => [JSON.stringify([requirement, account.id]), account] as const,
    );
  return (
    ahead.app.id === state.app.id &&
    ahead.app.owner === state.app.owner &&
    ahead.actor === state.actor &&
    same(byId(ahead.accounts), byId(accounts)) &&
    same(byUse(ahead.appUses), byUse(appUses))
  );
};

/**
 * Each account an invocation selects, once, in selection order, with every use it makes of it: by
 * the actor's use where a user requirement uses it, and by the app link for each app
 * requirement it fills. Each use is authorized on its own.
 */
const distinctSelection = (state: Effect.Success<ReturnType<typeof snapshot>>) => {
  const distinct = new Map<
    AccountId,
    {
      readonly account: StoredAccount;
      readonly provider: ProviderDefinition;
      readonly user: boolean;
      readonly appUses: readonly string[];
    }
  >();
  for (const { slot, required, accounts } of state.selections)
    for (const account of accounts) {
      const seen = distinct.get(account.id);
      const user = required.scope === "user" || seen?.user === true;
      const appUses = [...(seen?.appUses ?? []), ...(required.scope === "app" ? [slot] : [])];
      distinct.set(account.id, { account, provider: required.definition, user, appUses });
    }
  return [...distinct.values()];
};

/**
 * A reconnect an account the app uses as its own needs, named by its app requirement: the caller
 * did not link it and cannot reconnect it, someone who can edit the app must. An account the caller
 * also uses for a user requirement is theirs to reconnect.
 */
const appAccountReconnect =
  (selection: ReturnType<typeof distinctSelection>) =>
  <E>(error: E): E | OAuthReconnectRequired => {
    if (!Schema.is(OAuthReconnectRequired)(error) || error.appRequirement !== undefined)
      return error;
    const used = selection.find(({ account }) => account.id === error.account);
    const requirement = used === undefined || used.user ? undefined : used.appUses[0];
    return requirement === undefined
      ? error
      : new OAuthReconnectRequired({
          account: error.account,
          ...(error.reason === undefined ? {} : { reason: error.reason }),
          ...(error.cause === undefined ? {} : { cause: error.cause }),
          appRequirement: requirement,
        });
  };

/**
 * Resolve current credentials, to run the app, without holding a database transaction open. It
 * rechecks the actor's app access. `ahead` stands in for the app recheck only when it succeeded,
 * for the app, actor and accounts this state holds. A refused account use is a `StorageError`.
 */
export const resolve = (
  state: Effect.Success<ReturnType<typeof snapshot>>,
  resolveAccount: ReturnType<typeof makeOAuth>["resolveSelected"],
  ahead?: RecheckAhead,
) =>
  resolveFor(state, resolveAccount, "run", ahead).pipe(
    Effect.catchTag("AccountUseRefused", () => Effect.fail(new StorageError())),
  );

/**
 * Resolve current credentials only to remove what the app registered, as `resolve` does without
 * app access. A refused account use stays `AccountUseRefused`: it lasts until access changes, so
 * the removal waits for a person instead of retrying.
 */
export const resolveRemoval = (
  state: Effect.Success<ReturnType<typeof snapshot>>,
  resolveAccount: ReturnType<typeof makeOAuth>["resolveSelected"],
) => resolveFor(state, resolveAccount, "removal");

function resolveFor(
  state: Effect.Success<ReturnType<typeof snapshot>>,
  resolveAccount: ReturnType<typeof makeOAuth>["resolveSelected"],
  use: "run" | "removal",
  ahead?: RecheckAhead,
) {
  return Effect.gen(function* () {
    const selections: Record<AccountScope, Record<string, HostAccountSlots[string]>> = {
      app: {},
      user: {},
    };
    // An account selected for several slots is resolved once per invocation, in selection
    // order. A token renewed for one slot is the token every slot uses, even when it already
    // falls inside the refresh-ahead window, so one invocation never renews the same grant twice.
    const selected = distinctSelection(state);
    const { user, app: appUses } = accountAuthority(state.selections);
    const app = { id: state.app.id, owner: state.app.owner };
    // The actor's app access and its accounts are rechecked together, before any credential.
    const resolvedFields = yield* (
      use === "run" &&
      ahead !== undefined &&
      Exit.isSuccess(ahead.result) &&
      recheckedFor(ahead, state, user, appUses)
        ? resolveAccount({ kind: "run", app }, selected, ahead.result)
        : resolveAccount({ kind: use, app }, selected)
    ).pipe(Effect.mapError(appAccountReconnect(selected)));
    const credentials = new Map(
      selected.map(({ account }, index) => [account.id, resolvedFields[index]] as const),
    );
    for (const { slot, required, accounts } of state.selections) {
      const resolved = yield* Effect.forEach(accounts, (account) =>
        Effect.gen(function* () {
          const bind = credentials.get(account.id);
          if (bind === undefined) return yield* new StorageError();
          return bind(required.definition);
        }),
      );
      if (required.cardinality === "many") selections[required.scope][slot] = resolved;
      else {
        const account = resolved[0];
        if (account === undefined)
          return yield* Effect.fail(
            new AccountRequired({
              app: state.app.id,
              version: state.version.id,
              slot,
              scope: required.scope,
            }),
          );
        selections[required.scope][slot] = account;
      }
    }
    // Work without a caller binds no user accounts, so its context has no `user`.
    const accounts: HostAccounts =
      state.scope === "app"
        ? { app: selections.app }
        : { app: selections.app, user: selections.user };
    return {
      accounts: Redacted.make(accounts),
      ...(state.scope === "user" && state.actor !== undefined ? { caller: state.actor } : {}),
    };
  });
}

/** Whether an invocation's accounts can run its tools; recorded on the check's span. */
const accountsOutcome = (outcome: "ready" | "reconnect" | "account_required") =>
  Effect.annotateCurrentSpan("executor.accounts.outcome", outcome);

/** One resolved invocation: app, pinned version, actor and account selection. */
export type InvocationSnapshot = Effect.Success<ReturnType<typeof snapshot>>;
type InvocationContext = Effect.Success<ReturnType<typeof resolve>>;
type SelectedAccount = HostAccountSlots[string];
const isMany = (
  value: SelectedAccount,
): value is Extract<SelectedAccount, ReadonlyArray<unknown>> => Array.isArray(value);
const sameFields = Schema.toEquivalence(JsonObject);

/**
 * The service refused one of this invocation's accounts: the app reported an `unauthorized`
 * provider failure attributed to a selected account. Renew that account once, or read a renewal
 * another call already made, and return the invocation's accounts with its new credentials.
 *
 * Returns undefined when there is nothing new to try: the failure is not an attributed
 * authentication refusal, or the account cannot be renewed, such as a secrets account or a grant
 * without a refresh token. A renewal the service refuses with `invalid_grant` fails with
 * `OAuthReconnectRequired`, as any resolve does.
 */
const renewRefused = (
  oauth: Pick<ReturnType<typeof makeOAuth>, "renewRejected">,
  clients: ReadonlyMap<string, FirstPartyOAuthClient>,
  state: InvocationSnapshot,
  context: InvocationContext,
  error: unknown,
) =>
  Effect.gen(function* () {
    if (
      !Schema.is(ProviderError)(error) ||
      error.reason !== "unauthorized" ||
      error.accountId === undefined
    )
      return undefined;
    const { accountId } = error;
    const selection = distinctSelection(state);
    const selected = selection.find(({ account }) => account.id === accountId);
    if (selected === undefined) return undefined;
    const accounts = Redacted.value(context.accounts);
    const used = scopedSlots(accounts)
      .flatMap(([, value]) => (isMany(value) ? value : [value]))
      .find((account) => account.id === accountId);
    if (used === undefined) return undefined;
    // Renewal authorizes the account and, once it settles, every account of the invocation and
    // the app for the current actor, as `resolve` does: they all run the app's code again.
    const usedFields = used.fields;
    const renewed = yield* oauth
      .renewRejected(
        { kind: "run", app: state.app },
        selected.account,
        selected.provider,
        usedFields,
        selection,
      )
      .pipe(Effect.mapError(appAccountReconnect(selection)));
    if (sameFields(Redacted.value(renewed.fields), usedFields)) return undefined;
    yield* Effect.annotateCurrentSpan("executor.account.credentials_renewed", accountId);
    // Rebuilt from the renewed credential itself, so whether it is managed is whatever the
    // credential now is, even if a reconnect replaced it during this invocation.
    const definitions = new Map(
      state.selections.map(({ slot, required }) => [slot, required.definition] as const),
    );
    const replace =
      (slot: string) =>
      (account: HostAccount): HostAccount => {
        const definition = definitions.get(slot);
        return account.id === accountId && definition !== undefined
          ? invocationAccount(selected.account, definition, renewed, clients)
          : account;
      };
    const replaceScope = (slots: HostAccountSlots) =>
      Object.fromEntries(
        Object.entries(slots).map(([slot, value]) => [
          slot,
          isMany(value) ? value.map(replace(slot)) : replace(slot)(value),
        ]),
      );
    const renewedAccounts: HostAccounts =
      accounts.user === undefined
        ? { app: replaceScope(accounts.app) }
        : { app: replaceScope(accounts.app), user: replaceScope(accounts.user) };
    return { ...context, accounts: Redacted.make(renewedAccounts) } satisfies InvocationContext;
  });

function invocation(
  state: InvocationSnapshot,
  tool: ToolName,
  kind: ToolKind | undefined,
  input: Json,
) {
  return Schema.decodeUnknownEffect(ToolInvocation)({
    app: state.app.id,
    owner: state.app.owner,
    version: state.version.id,
    tool,
    ...(kind === undefined ? {} : { kind }),
    input,
    accounts: (() => {
      const scopes: Record<AccountScope, Record<string, unknown>> = { app: {}, user: {} };
      for (const { slot, required, accounts } of state.selections) {
        const identities = accounts.map(({ id, owner, provider, method }) => ({
          id,
          owner,
          provider,
          method,
        }));
        scopes[required.scope][slot] = required.cardinality === "many" ? identities : identities[0];
      }
      return state.scope === "app" ? { app: scopes.app } : scopes;
    })(),
  }).pipe(Effect.mapError(() => new StorageError()));
}

/**
 * Check failures that are answers: the saved call's app, version or accounts are now missing
 * or different. Anything else, such as storage failing, answers nothing.
 */
const isContextChange = Schema.is(
  Schema.Union([
    AppNotFound,
    AppNotDeployed,
    VersionNotFound,
    AccountNotFound,
    AccountSelectionInvalid,
    AccountRequired,
  ]),
);

/** A failure the app runtime reports for a call. */
type CallError = Effect.Error<ReturnType<Runtime["call"] | Runtime["query"] | Runtime["mutate"]>>;

/**
 * What renewing a refused account's credentials after a call that may write came to: the call is
 * never repeated, so its failure reports the renewal.
 */
type Renewal = "renewed" | RenewalFailure;

/** The typed error of a failed call. */
const runtimeFailure = (
  identity: { app: AppId; version: VersionId; tool: ToolName },
  state: InvocationSnapshot,
  renewal: Renewal | undefined,
) =>
  Match.type<CallError>().pipe(
    Match.tagsExhaustive({
      ProviderError: (error) => appProviderFailure(state, error, renewal),
      OpenapiResponseError: ({ code, status, message, recovery }) =>
        new ToolCallFailed({
          ...identity,
          reason: message,
          response: { code, status, message, ...(recovery === undefined ? {} : { recovery }) },
        }),
      WorkflowFailure: () =>
        new ToolCallFailed({ ...identity, reason: "Workflow operation failed" }),
      ElicitationFailed: ({ reason }) => new ToolElicitationFailed({ ...identity, reason }),
      HostToolNotFound: () => new ToolNotFound(identity),
      HostOperationNotFound: () => new ToolNotFound(identity),
      HostKindMismatch: ({ requested, actual }) =>
        new ToolKindMismatch({ ...identity, requested, actual }),
      HostOperationFailed: (error) =>
        Option.match(appFailure(error), {
          onNone: () => new ToolCallFailed({ ...identity, reason: "Operation execution failed" }),
          onSome: (failure) =>
            new ToolCallFailed({ ...identity, reason: appFailureText(failure), failure }),
        }),
      DatabaseLimitExceeded: (error) => {
        const failure = {
          source: "storage" as const,
          errorName: error._tag,
          code: error.limit,
          message: error.message,
        };
        return new ToolCallFailed({ ...identity, reason: appFailureText(failure), failure });
      },
      HostInputInvalid: ({ problems }) =>
        new InputInvalid({
          ...identity,
          problems:
            problems === undefined || problems.length === 0
              ? ["Input did not match the tool schema"]
              : problems,
        }),
      HostToolBlocked: () => new ToolBlocked(identity),
      HostToolApprovalRequired: () => new ToolApprovalRequired(identity),
      HostToolPolicyFailed: () => new ToolPolicyFailed(identity),
      HostOutputInvalid: () => new ToolCallFailed({ ...identity, reason: "Tool execution failed" }),
      HostRequestInvalid: (error) => evaluationFailure(identity, error),
      HostAccountsInvalid: (error) => evaluationFailure(identity, error),
      // Also how the app's framework reports an unexpected failure anywhere in its handling of
      // the call, including after the handler returned, so it is not reported as a failure to
      // load the app's tools.
      HostDeclarationInvalid: () =>
        new ToolCallFailed({
          ...identity,
          reason:
            "Executor did not receive a usable result from this tool call. The app’s framework reported an invalid declaration or an unexpected failure while handling it.",
        }),
      HostEvaluationFailed: (error) => evaluationFailure(identity, error),
      SkillLoadFailed: (error) => evaluationFailure(identity, error),
      McpError: (error) => operationMcpFailure(identity, error),
      RuntimeBuildUnavailable: (error) => evaluationFailure(identity, error),
      // The runtime's reply to the call was lost or unusable, which can happen after the tool ran,
      // so it is not reported as a failure to load the app's tools. The kind is matched from the
      // runtime's error, which the app's isolate can produce, so it is not claimed: a size failure
      // stays a likely cause.
      RuntimeProtocolFailed: ({ reason }) =>
        reason === "too-large"
          ? new ToolCallFailed({
              ...identity,
              reason: "Executor did not receive this tool call's result.",
              rpcLimitMatched: true,
            })
          : new ToolCallFailed({
              ...identity,
              reason: `Executor did not receive a usable result from this tool call. ${
                reason === undefined
                  ? "The runtime did not report why."
                  : reason === "unrecognized"
                    ? "The runtime did not recognize why."
                    : `The runtime’s error matches this cause, which Executor has not confirmed: ${runtimeFailures[reason]}.`
              }`,
            }),
      RuntimeProtocolUnsupported: (error) => evaluationFailure(identity, error, error.message),
    }),
  );

/** The source a failure from the app's framework names: its code, a service or its storage. */
const detailSource = ({ source }: { readonly source?: AppFailure["source"] }): CallFailureSource =>
  source === "service" ? "upstream" : source === "storage" ? "storage" : "app";

/**
 * What a runtime's failure of a call names as its cause (`CallFailureSource`), read before
 * `runtimeFailure` turns it into the caller's error, which can no longer tell them apart: a lost
 * reply and the app's own exception are both `ToolCallFailed`.
 */
const failureSource = Match.type<CallError>().pipe(
  Match.withReturnType<CallFailureSource>(),
  Match.tagsExhaustive({
    ProviderError: () => "upstream",
    OpenapiResponseError: () => "upstream",
    McpError: () => "upstream",
    SkillLoadFailed: () => "upstream",
    HostOperationFailed: detailSource,
    HostEvaluationFailed: detailSource,
    HostDeclarationInvalid: detailSource,
    HostToolNotFound: () => "app",
    HostOperationNotFound: () => "app",
    HostKindMismatch: () => "app",
    HostInputInvalid: () => "app",
    HostOutputInvalid: () => "app",
    WorkflowFailure: ({ reason }) =>
      reason === "engine" || reason === "unavailable"
        ? "runtime"
        : reason === "approval"
          ? "approval"
          : reason === "credentials"
            ? "other"
            : "app",
    DatabaseLimitExceeded: () => "storage",
    HostToolBlocked: () => "approval",
    HostToolApprovalRequired: () => "approval",
    HostToolPolicyFailed: () => "approval",
    RuntimeProtocolFailed: () => "runtime",
    RuntimeBuildUnavailable: () => "runtime",
    RuntimeProtocolUnsupported: () => "runtime",
    HostRequestInvalid: () => "runtime",
    HostAccountsInvalid: () => "other",
    ElicitationFailed: () => "other",
  }),
);

/** Tell the caller's observer, if any, what a call failed with (`CallFailureSources`). */
const observeFailure = (source: CallFailureSource) =>
  Effect.map(CallFailureSources, (observe) => observe?.(source));

/**
 * The error a failed call reports to its caller, such as an agent. A call that may write, a
 * mutation or a call that names no kind, may already have made its change once the host handed any of
 * its work to the app's code, or may still make it, whatever failed: the app's factory, account
 * hooks, approval policy and handler all run there, and every failure reported from there passes
 * through code the app controls, its name and fields included. So does a failure of Executor's own
 * work after the hand-off, such as saving an approval request. Its error records that, so it leads
 * with Executor's instruction not to repeat the call and is never offered as a retry. That includes
 * a refusal, such as invalid input or a denied approval, which the app's reply reports. A failure
 * before the host handed over any work, and every failure of a call the app confirms only reads
 * (`confirmedRead`), keep their own classification. A query only its upstream calls one, such as
 * an MCP tool with `readOnlyHint`, may write like any other call.
 */
const callFailure =
  (read: boolean, enteredApp: boolean) =>
  (failure: CallFailure): CallFailure =>
    read || !enteredApp
      ? failure
      : Match.value(failure).pipe(
          Match.tagsExhaustive({
            ToolCallFailed: (failure) => mayHaveWritten(ToolCallFailed, failure),
            AppProviderFailed: (failure) => mayHaveWritten(AppProviderFailed, failure),
            AppEvaluationFailed: (failure) => mayHaveWritten(AppEvaluationFailed, failure),
            ToolElicitationFailed: (failure) => mayHaveWritten(ToolElicitationFailed, failure),
            ToolNotFound: (failure) => mayHaveWritten(ToolNotFound, failure),
            ToolKindMismatch: (failure) => mayHaveWritten(ToolKindMismatch, failure),
            InputInvalid: (failure) => mayHaveWritten(InputInvalid, failure),
            ToolBlocked: (failure) => mayHaveWritten(ToolBlocked, failure),
            ToolApprovalRequired: (failure) => mayHaveWritten(ToolApprovalRequired, failure),
            ToolPolicyFailed: (failure) => mayHaveWritten(ToolPolicyFailed, failure),
            StorageError: (failure) => mayHaveWritten(StorageError, failure),
            CredentialsError: (failure) => mayHaveWritten(CredentialsError, failure),
          }),
        );

/**
 * Report a defect that a call's failure replaces for its caller: the host's error reporter, such as
 * Sentry, captures it, and the call's span records it as the tracer records a defect it ends with.
 */
const reportDefect = (cause: Cause.Cause<unknown>) =>
  Effect.gen(function* () {
    yield* ErrorReporter.report(cause);
    const span = yield* Effect.option(Effect.currentSpan);
    if (Option.isNone(span)) return;
    const time = yield* Clock.currentTimeNanos;
    for (const error of Cause.prettyErrors(recordedCause(cause), { includeCauseInStack: true }))
      span.value.event("exception", time, {
        "exception.type": error.name,
        "exception.message": error.message,
        "exception.stacktrace": error.stack ?? "No stack trace available",
      });
  });

/** A listed tool without its schemas. */
const summarizeTool = ({
  inputSchema: _input,
  outputSchema: _output,
  _meta,
  ...summary
}: Tool): ToolSummary => summary;

/** Live calls return completion or a durable approval request. Resume trusts the supplied SDK decision. */
export const makeTools = (
  storage: ExecutorDatabase,
  oauth: Pick<ReturnType<typeof makeOAuth>, "resolveSelected" | "renewRejected" | "usableAll">,
  clients: ReadonlyMap<string, FirstPartyOAuthClient>,
  runtime: Runtime,
  credentials: Credentials,
  crypto: Crypto.Crypto,
  listings: Listings,
  workflows?: (state: InvocationSnapshot) => WorkflowHostControls,
  lifecycle?: ResourceLifecycle,
) => {
  const db = database(storage);
  const resolveAccount = oauth.resolveSelected;
  const approvals = makeToolApprovals(db, credentials, crypto, storage.reactivity.inTransaction);
  /** Renew an account the service refused without repeating what it refused; undefined when none was. */
  const renewOnce = (state: InvocationSnapshot, context: InvocationContext, error: unknown) =>
    renewRefused(oauth, clients, state, context, error).pipe(
      Effect.result,
      Effect.map((renewed): Renewal | undefined =>
        Result.isFailure(renewed)
          ? renewed.failure
          : renewed.success === undefined
            ? undefined
            : "renewed",
      ),
    );
  /** The typed error of a catalog evaluation, with the renewal of an account it refused. */
  const catalogFailure = (
    state: InvocationSnapshot,
    error: Effect.Error<ReturnType<typeof runtime.index>>,
    renewal?: Renewal,
  ) =>
    Schema.is(ProviderError)(error)
      ? appProviderFailure(state, error, renewal)
      : evaluationFailure({ app: state.app.id, version: state.version.id }, error);
  /** Fail with a catalog evaluation's typed error, telling the caller's observer its source. */
  const failCatalog = (
    state: InvocationSnapshot,
    error: Effect.Error<ReturnType<typeof runtime.index>>,
    renewal?: Renewal,
  ) =>
    observeFailure(failureSource(error)).pipe(
      Effect.andThen(Effect.fail(catalogFailure(state, error, renewal))),
    );
  /**
   * Run a tool, live or approved, and renew an account the service refuses. A 401 means the
   * service did not perform the refused request, but an earlier request in the same call may
   * already have made changes. A call the app confirms only reads (`read`, see `confirmedRead`) is
   * repeated once with the renewed credentials, and a failed renewal is its failure. A call that may
   * write is never repeated: the renewal, renewed or failed, comes after the call was dispatched, so
   * it is reported with the call's failure rather than in its place.
   */
  const executeRenewing = <A, E, R, R2>(
    state: InvocationSnapshot,
    context: InvocationContext,
    read: Effect.Effect<boolean, never, R2>,
    execute: (context: InvocationContext) => Effect.Effect<Result.Result<A, E>, never, R>,
  ) =>
    Effect.gen(function* () {
      const result = yield* execute(context);
      if (Result.isSuccess(result)) return { result };
      if (yield* read) {
        const renewed = yield* renewRefused(oauth, clients, state, context, result.failure);
        if (renewed === undefined) return { result };
        yield* Effect.annotateCurrentSpan("executor.tool.retry", "credentials_renewed");
        return { result: yield* execute(renewed) };
      }
      const renewal = yield* renewOnce(state, context, result.failure);
      return { result, renewal };
    });
  /**
   * Runtime options that evaluate one invocation's catalog with its resolved accounts. Every
   * inspection of a build that can share its definitions asks for them: the catalog is the same
   * either way, only smaller to send. Index reads list no schemas and ignore it.
   */
  const inspection = (state: InvocationSnapshot, context: InvocationContext) => ({
    app: state.app.id,
    build: state.version.build,
    hostApi: listings.hostApi(state.version),
    ...context,
    ...(workflows === undefined ? {} : { workflowControls: workflows(state) }),
    ...(state.version.requirements.capabilities?.sharedDefinitions === true
      ? { definitions: "shared" as const }
      : {}),
  });
  /**
   * Evaluate a catalog and renew an account the service refuses while it is evaluated. Inspection
   * only reads, so it is repeated once with the renewed credentials. Every catalog read, including
   * the tool listing that MCP discovery serves, goes through here.
   */
  const inspectRenewing = <A, R>(
    state: InvocationSnapshot,
    context: InvocationContext,
    inspect: (
      context: InvocationContext,
    ) => Effect.Effect<A, Effect.Error<ReturnType<typeof runtime.index>>, R>,
  ) =>
    inspect(context).pipe(
      Effect.catch((error) =>
        renewRefused(oauth, clients, state, context, error).pipe(
          Effect.flatMap((renewed) =>
            renewed === undefined
              ? failCatalog(state, error)
              : inspect(renewed).pipe(Effect.catch((error) => failCatalog(state, error))),
          ),
        ),
      ),
    );
  /** Read the live catalog of a resolved invocation, renewing an account the service refuses. */
  const readCatalog = <A, R>(
    state: InvocationSnapshot,
    context: InvocationContext,
    read: (
      options: Parameters<typeof runtime.index>[0],
      toolIndex: boolean,
      scheduledTools: boolean,
    ) => Effect.Effect<A, Effect.Error<ReturnType<typeof runtime.index>>, R>,
  ) =>
    inspectRenewing(state, context, (context) =>
      read(
        inspection(state, context),
        state.version.requirements.capabilities?.toolIndex === true,
        state.version.requirements.capabilities?.scheduledTools === true,
      ),
    );
  /** Inspect the live catalog for one tool, or all of it on builds without a tool index. */
  const inspectTool = (state: InvocationSnapshot, name: ToolName, context: InvocationContext) =>
    runtime.inspect(
      state.version.requirements.capabilities?.toolIndex === true
        ? { ...inspection(state, context), tools: [name] }
        : inspection(state, context),
    );
  /** The named tool of an evaluated catalog; ToolNotFound when it is absent. */
  const found =
    (state: InvocationSnapshot, name: ToolName) =>
    ({ tools, routers }: Effect.Success<ReturnType<typeof runtime.inspect>>) =>
      Effect.gen(function* () {
        const tool = tools.find((tool) => tool.name === name);
        if (tool !== undefined) return tool;
        // A tool under a router that could not be read fails with that router's error.
        const failed = routers.find(
          (router) => router.error !== undefined && name.startsWith(`${router.path}.`),
        )?.error;
        if (failed !== undefined)
          return yield* Schema.is(ProviderError)(failed)
            ? appProviderFailure(state, failed)
            : evaluationFailure({ app: state.app.id, version: state.version.id }, failed);
        return yield* new ToolNotFound({
          app: state.app.id,
          version: state.version.id,
          tool: name,
        });
      });
  /** Describe one tool of the live catalog; ToolNotFound when it is absent. */
  const describe = (state: InvocationSnapshot, context: InvocationContext, name: ToolName) =>
    inspectRenewing(state, context, (context) => inspectTool(state, name, context)).pipe(
      Effect.flatMap(found(state, name)),
    );
  /**
   * The kind of a call that names none, from the live catalog. Evaluating the catalog runs the
   * app's code, which may write before it fails, and the call may write, so the catalog is
   * evaluated once: a refused account is renewed, and the failure reports that renewal, as a call
   * that may write does.
   */
  const catalogKind = (state: InvocationSnapshot, context: InvocationContext, name: ToolName) =>
    inspectTool(state, name, context).pipe(
      Effect.catch((error) =>
        renewOnce(state, context, error).pipe(
          Effect.flatMap((renewal) => failCatalog(state, error, renewal)),
        ),
      ),
      Effect.flatMap(found(state, name)),
    );
  /**
   * The caller's kind, or the kept listing's for a caller that did not name one, so the call of an
   * app with a database loads only its data facet, not the app's Worker too. Only the first call of
   * an invocation state with no kept listing evaluates it, and an aged listing is not refreshed for
   * this. That evaluation uses the accounts the call resolved, so the call renews a grant once. A
   * tool the listing does not name, such as one a dynamic source resolves on demand or one added
   * since the listing was evaluated, is described live from one evaluation of the catalog; one the catalog does not list either is
   * called without a kind: the app applies the tool's own kind and storage opens for writing.
   */
  const kindOf = (
    state: InvocationSnapshot,
    context: InvocationContext,
    name: ToolName,
    kind: ToolKind | undefined,
  ) =>
    kind === undefined
      ? listings
          .read(state, callListingOf(state), {
            refreshStale: false,
            followChanges: false,
            resolved: context,
          })
          .pipe(
            Effect.map((listing) => listing.items.find((tool) => tool.name === name)),
            // A listing that did not finish says nothing about the tool.
            Effect.catchTag("ToolListingTimedOut", () => Effect.succeed(undefined)),
            Effect.flatMap((listed) =>
              listed === undefined ? catalogKind(state, context, name) : Effect.succeed(listed),
            ),
            Effect.map((tool): ToolKind | undefined =>
              tool.readOnly === true ? "query" : "mutation",
            ),
            Effect.catchTag("ToolNotFound", () => Effect.succeed(undefined)),
            Effect.withSpan("sdk.tools.kind"),
          )
      : Effect.succeed(kind);
  /**
   * With the accounts the host's check resolved ({@link InvocationSelection}), make the call's
   * reads of the app and those accounts, and the actor's app recheck, at once. The host's check has
   * finished, so each read still follows it. The snapshot uses a read only where the call's own
   * reads agree with what it was made for, and the recheck only when it ran for the app, actor and
   * accounts the call runs with; failures are reported in the snapshot's order. A recheck after the
   * reads would come before the grant reads anyway, so running it beside them leaves nothing older
   * when the app starts. Without a matching selection nothing is read ahead.
   */
  const invocationReads = (
    selection: {
      readonly app: AppId;
      readonly owner: OwnerId;
      readonly accounts: AppAccounts;
    },
    /** Accounts whose grant rows to read too, for a host that sends them in the same batch. */
    grantsOf: readonly AccountId[] = [],
  ) => {
    const ids = namedAccounts(selection.accounts);
    const app = { id: selection.app, owner: selection.owner };
    // The host resolved them under the app's owner; `resolve` uses the recheck only if they match.
    const split = scopeSplit(selection.accounts);
    const accounts = split.user.map((id) => ({ id, owner: selection.owner }));
    const appUses = split.appUses.map(({ requirement, id }) => ({
      requirement,
      account: { id, owner: selection.owner },
    }));
    const slots: {
      app?: SnapshotReads["app"];
      rows?: SelectionAccountsRead["rows"];
      recheck?: Pick<RecheckAhead, "actor" | "result">;
      grants?: Result.Result<ReadonlyArray<GrantRow>, StorageError>;
    } = {};
    const leaves: Array<Effect.Effect<void>> = [
      Effect.result(readApp(db, selection.app)).pipe(
        Effect.map((read) => {
          slots.app = read;
        }),
      ),
      Effect.result(readSelectionAccounts(db, ids)).pipe(
        Effect.map((rows) => {
          slots.rows = rows;
        }),
      ),
    ];
    if (lifecycle !== undefined)
      leaves.push(
        Effect.gen(function* () {
          // The actor it ran as; `resolve` uses the outcome only for the same actor.
          const actor = yield* CurrentActor;
          const result = yield* Effect.exit(
            lifecycle
              .appResolving(app, accounts, appUses)
              .pipe(Effect.withSpan("sdk.accounts.recheck")),
          );
          slots.recheck = { actor, result };
        }),
      );
    if (grantsOf.length > 0)
      leaves.push(
        Effect.result(
          query(() => db.findMany("oauthGrants", { where: (b) => b("id", "in", grantsOf) })),
        ).pipe(
          Effect.map((grants) => {
            slots.grants = grants;
          }),
        ),
      );
    return {
      leaves,
      slots,
      take: () => {
        if (slots.app === undefined || slots.rows === undefined) return undefined;
        return {
          reads: { app: slots.app, accounts: { ids, rows: slots.rows } } satisfies SnapshotReads,
          recheck:
            slots.recheck === undefined
              ? undefined
              : ({ app, accounts, appUses, ...slots.recheck } satisfies RecheckAhead),
          grants:
            slots.grants === undefined || Result.isFailure(slots.grants)
              ? undefined
              : { ids: grantsOf, rows: slots.grants.success },
        };
      },
      /** Whether any read failed in storage: a batch that did is not used at all. */
      failed: () =>
        (
          [slots.app, slots.rows, slots.grants] as ReadonlyArray<
            Result.Result<unknown, { readonly _tag: string }> | undefined
          >
        ).some(
          (read) =>
            read !== undefined && Result.isFailure(read) && read.failure._tag === "StorageError",
        ) ||
        (slots.recheck !== undefined && Exit.isFailure(slots.recheck.result)),
    };
  };
  type InvocationReads = NonNullable<ReturnType<ReturnType<typeof invocationReads>["take"]>>;
  /**
   * {@link PrefetchHost}: what `apps.get` and the reads above return, read by the host in one batch
   * with its own checks. The hint says which of the app's requirements and accounts resolve
   * through a grant (see {@link GrantHint}), so the next batch reads only those grants. A stale
   * hint costs a grant read in the resolve loop, in the call's own order, never a different answer.
   */
  const prefetchInvocation: PrefetchHost["invocation"] = (selection) => {
    const known = selection.known;
    // Grants of accounts the hint says hold none are not read; the resolve loop reads any it needs.
    const reads =
      known === undefined
        ? undefined
        : invocationReads(
            { app: selection.app, owner: selection.owner, accounts: known.accounts },
            grantedAccounts(known.accounts, GrantHint.read(known.hint)),
          );
    const slots: { app?: SnapshotReads["app"] } = reads?.slots ?? {};
    const leaves: ReadonlyArray<Effect.Effect<void>> = reads?.leaves ?? [
      Effect.result(readApp(db, selection.app)).pipe(
        Effect.map((app) => {
          slots.app = app;
        }),
      ),
    ];
    // What `apps.get` returns for the row: it reads the app under its owner only.
    const asGot = (row: Effect.Success<ReturnType<typeof readApp>>) =>
      Effect.gen(function* () {
        if (row === null || row.owner !== selection.owner)
          return yield* new AppNotFound({ app: selection.app });
        return yield* gotApp(row);
      });
    const take = Effect.gen(function* () {
      const app =
        slots.app === undefined
          ? undefined
          : Result.isFailure(slots.app)
            ? Result.fail(slots.app.failure)
            : yield* Effect.result(asGot(slots.app.success));
      const value = reads === undefined || reads.failed() ? undefined : reads.take();
      return {
        app,
        invocation:
          known === undefined || value === undefined
            ? undefined
            : { app: selection.app, owner: selection.owner, accounts: known.accounts, value },
        hint:
          app === undefined || Result.isFailure(app)
            ? undefined
            : grantHint(
                app.success,
                known?.accounts,
                reads?.slots.rows !== undefined && Result.isSuccess(reads.slots.rows)
                  ? reads.slots.rows.success
                  : [],
              ),
        failed:
          reads?.failed() ??
          (slots.app !== undefined &&
            Result.isFailure(slots.app) &&
            slots.app.failure._tag === "StorageError"),
      } satisfies PrefetchedInvocation;
    });
    return { leaves, take };
  };
  // A prefetch answers one call: it is provided around the whole host call, so a later call in
  // that scope (none today) must read live rather than reuse reads that may be seconds old.
  const consumedPrefetches = new WeakSet<object>();
  const readAhead = (input: { readonly app: AppId; readonly accounts?: AppAccounts | undefined }) =>
    Effect.gen(function* () {
      const selection = yield* InvocationSelection;
      if (
        selection === undefined ||
        selection.app !== input.app ||
        input.accounts === undefined ||
        !sameAccounts(selection.accounts, input.accounts)
      )
        return undefined;
      // Made by the host in one batch with its checks, for exactly this selection.
      const prefetched = yield* InvocationPrefetch;
      if (
        prefetched !== undefined &&
        !consumedPrefetches.has(prefetched) &&
        prefetched.app === selection.app &&
        prefetched.owner === selection.owner &&
        sameAccounts(prefetched.accounts, selection.accounts)
      ) {
        consumedPrefetches.add(prefetched);
        return prefetched.value as InvocationReads;
      }
      const reads = invocationReads(selection);
      yield* Effect.all(reads.leaves, { concurrency: "unbounded", discard: true });
      return reads.take();
    });
  /** Evaluate the live catalog with the named accounts. */
  const evaluate = <A, R>(
    input: Parameters<Executor["tools"]["index"]>[0],
    read: (
      options: Parameters<typeof runtime.index>[0],
      /** Earlier builds reject index and filtered inspection; they only describe every tool. */
      toolIndex: boolean,
      /** Earlier builds reject scheduled inspection; they only describe every tool. */
      scheduledTools: boolean,
    ) => Effect.Effect<A, Effect.Error<ReturnType<typeof runtime.index>>, R>,
  ) =>
    Effect.gen(function* () {
      const state = yield* snapshot(db, input).pipe(Effect.withSpan("sdk.invocation.snapshot"));
      const context = yield* resolve(state, resolveAccount).pipe(
        Effect.withSpan("sdk.accounts.resolve"),
      );
      yield* Effect.annotateCurrentSpan({
        "executor.app.id": state.app.id,
        "executor.deployment.id": state.version.id,
        "executor.build.id": state.version.build,
      });
      return { version: state.version.id, value: yield* readCatalog(state, context, read) };
    });
  /** The invocation state a listing is read for, annotated on the caller's span. */
  const listed = (input: Parameters<typeof snapshot>[1]) =>
    Effect.gen(function* () {
      const state = yield* snapshot(db, input).pipe(Effect.withSpan("sdk.invocation.snapshot"));
      yield* Effect.annotateCurrentSpan({
        "executor.app.id": state.app.id,
        "executor.deployment.id": state.version.id,
        "executor.build.id": state.version.build,
      });
      return state;
    });
  /** Evaluate every tool of the catalog with schemas, sorted by name, for the listing store. */
  /** A catalog's tools as the listing store keeps them, sorted by name. */
  const toListing =
    (state: InvocationSnapshot) =>
    ({ tools, routers }: Effect.Success<ReturnType<typeof runtime.inspect>>): ToolListing => ({
      catalog: {
        version: state.version.id,
        accounts: scopedSelection(state.version.requirements.accounts, state.accounts, state.scope),
      },
      routers,
      items: [...tools]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((tool) => ({
          ...tool,
          app: state.app.id,
          version: state.version.id,
          name: ToolName.make(tool.name),
        })),
    });
  /** Evaluate every tool of the catalog with schemas, sorted by name, for the listing store. */
  const listingOf = (state: InvocationSnapshot) => (context: InvocationContext) =>
    inspectRenewing(state, context, (context) => runtime.inspect(inspection(state, context))).pipe(
      Effect.map(toListing(state)),
    );
  /**
   * Whether the app confirms that a tool only reads: its kept listing names the tool a query of a
   * kind the app's code or the tool's protocol fixes (`kindConfirmed`), not one only an upstream
   * claims, such as an MCP server's `readOnlyHint`. Only a call named a query and confirmed here
   * keeps a read's advice to repeat it after it fails, and only such a call is repeated with renewed
   * credentials. The caller's kind is its own claim and confirms nothing. It comes only from a
   * listing already kept (`listings.kept`): evaluating the catalog after a call failed would run
   * the app's code again, and its writes, only to word the failure. The listing kept in this
   * process is taken before the call hands over its work, since a cache change the call makes
   * forgets it; it is checked, and one kept beyond this process is read, only once the call failed
   * after the hand-off. A tool the kept listing does not confirm, or no kept listing, is not
   * confirmed.
   */
  const readOf = (state: InvocationSnapshot, name: ToolName, kind: ToolKind | undefined) =>
    kind === "query"
      ? listings.kept(state).pipe(
          Effect.orElseSucceed(() => Effect.succeed<ToolListing | undefined>(undefined)),
          Effect.flatMap((kept) =>
            Effect.cached(
              kept.pipe(
                Effect.map(
                  (listing) =>
                    listing?.items.some(
                      (tool) =>
                        tool.name === name && tool.readOnly === true && tool.kindConfirmed === true,
                    ) === true,
                ),
                Effect.tap((confirmed) =>
                  Effect.annotateCurrentSpan("executor.tool.read_confirmed", confirmed),
                ),
                Effect.withSpan("sdk.tools.read_confirmed"),
              ),
            ),
          ),
        )
      : Effect.succeed(Effect.succeed(false));
  /**
   * The listing a call that names no kind evaluates when none is kept. Evaluating the catalog runs
   * the app's code, which may write before it fails, and the call may write, so it is evaluated
   * once: a refused account is renewed, and the failure reports that renewal, as a call that may
   * write does.
   */
  const callListingOf = (state: InvocationSnapshot) => (context: InvocationContext) =>
    runtime.inspect(inspection(state, context)).pipe(
      Effect.catch((error) =>
        renewOnce(state, context, error).pipe(
          Effect.flatMap((renewal) => failCatalog(state, error, renewal)),
        ),
      ),
      Effect.map(toListing(state)),
    );
  return {
    prefetchInvocation,
    /**
     * The first of these accounts whose saved sign-in must reconnect before the app's tools can
     * run with them; undefined when every account can supply credentials. Reads stored state only:
     * it never renews a grant or evaluates the app.
     *
     * An account that must reconnect, or a required account that is not named, is an expected
     * account state the owner resolves, not a fault of this check. It is recorded as the span's
     * `executor.accounts.outcome`; a missing account fails the caller only after the span.
     */
    accountNeedingReconnect: (input: { app: AppId; accounts: AppAccounts }) =>
      Effect.gen(function* () {
        const state = yield* snapshot(db, input);
        const usable = yield* oauth
          .usableAll(
            state.selections.flatMap(({ required, accounts }) =>
              accounts.map((account) => ({ account, provider: required.definition })),
            ),
          )
          .pipe(Effect.result);
        if (Result.isFailure(usable)) {
          if (!Schema.is(OAuthReconnectRequired)(usable.failure))
            return yield* Effect.fail(usable.failure);
          yield* accountsOutcome("reconnect");
          return usable.failure.account;
        }
        yield* accountsOutcome("ready");
        return undefined;
      }).pipe(
        Effect.catchIf(Schema.is(AccountRequired), (missing) =>
          accountsOutcome("account_required").pipe(Effect.as(missing)),
        ),
        Effect.withSpan("sdk.accounts.reconnectRequired", {
          attributes: { "executor.app.id": input.app },
        }),
        Effect.flatMap((found) =>
          Schema.is(AccountRequired)(found) ? Effect.fail(found) : Effect.succeed(found),
        ),
      ),
    /**
     * Page through the app's evaluated catalog. The whole listing is evaluated once and, with a
     * listing store, reused across pages and requests for identical inputs. A page ends at its
     * limit and, unless the caller asks for unbounded pages, before the tool that would take its
     * JSON past `toolPageChars`.
     */
    list: (input: Parameters<Executor["tools"]["list"]>[0], options?: ToolListOptions) =>
      Effect.gen(function* () {
        const state = yield* listed(input);
        const listing = yield* listings.read(state, listingOf(state), options);
        // Pages share the listing's item objects, so a caller can recognise a kept listing.
        const start = pageStart(listing, input.cursor);
        const selected = yield* pageTools(
          listing,
          start,
          input.limit ?? 2_000,
          options?.unboundedPages === true ? undefined : toolPageChars,
        );
        const last = selected.at(-1);
        return {
          ...listing.catalog,
          routers: listing.routers,
          items: selected,
          ...(last !== undefined && listing.items.length > start + selected.length
            ? { next: Cursor.make(last.name) }
            : {}),
        };
      }).pipe(Effect.withSpan("sdk.tools.list")),
    /** Keep the target's current listing as search rows; see `Listings.searchable`. */
    searchable: (
      input: Omit<Parameters<Executor["tools"]["list"]>[0], "cursor" | "limit">,
      options?: ToolListOptions,
    ) =>
      Effect.gen(function* () {
        const state = yield* listed(input);
        const found = yield* listings.searchable(state, listingOf(state), options);
        return {
          listing: found.listing,
          version: state.version.id,
          accounts: scopedSelection(
            state.version.requirements.accounts,
            state.accounts,
            state.scope,
          ),
          routers: found.routers.filter((router) => router.error !== undefined),
          ...(found.stale === undefined ? {} : { stale: found.stale }),
        };
      }).pipe(Effect.withSpan("sdk.tools.searchable")),
    /**
     * Describe the declared operations that have schedules. Current builds skip dynamic
     * tool discovery, which can compile a large catalog in the shared app runtime.
     */
    scheduled: (input: Parameters<Executor["tools"]["list"]>[0]) =>
      Effect.gen(function* () {
        const {
          version,
          value: { tools },
        } = yield* evaluate(input, (options, _toolIndex, scheduled) =>
          runtime.inspect(scheduled ? { ...options, scheduled: true } : options),
        );
        // Callers that act on the result can require that this version is still active.
        return {
          version,
          items: tools.flatMap((tool) =>
            (tool.schedules ?? []).map((schedule) => ({
              ...schedule,
              tool: ToolName.make(tool.name),
            })),
          ),
        };
      }).pipe(Effect.withSpan("sdk.tools.scheduled")),
    /**
     * The catalog without schemas, read from the same kept listing as `list`, so browsing an app
     * evaluates it no more often than MCP discovery does.
     */
    index: (input: Parameters<Executor["tools"]["index"]>[0]) =>
      Effect.gen(function* () {
        const state = yield* listed(input);
        const listing = yield* listings.read(state, listingOf(state));
        return {
          ...listing.catalog,
          routers: listing.routers,
          items: listing.items.map(summarizeTool),
        };
      }).pipe(Effect.withSpan("sdk.tools.index")),
    /**
     * One tool's schemas from the kept listing. A tool the listing does not name, such as one a
     * dynamic source resolves on demand or one added since the listing was evaluated, is described
     * live; a tool under a router the listing could not read fails with that router's error.
     */
    get: (input: Parameters<Executor["tools"]["get"]>[0]) =>
      Effect.gen(function* () {
        const state = yield* listed(input);
        const listing = yield* listings.read(state, listingOf(state));
        const kept = listing.items.find((tool) => tool.name === input.tool);
        if (kept !== undefined) {
          yield* Effect.annotateCurrentSpan("executor.tools.source", "listing");
          return kept;
        }
        const failed = listing.routers.find(
          (router) => router.error !== undefined && input.tool.startsWith(`${router.path}.`),
        )?.error;
        if (failed !== undefined)
          return yield* Schema.is(ProviderError)(failed)
            ? appProviderFailure(state, failed)
            : evaluationFailure({ app: state.app.id, version: state.version.id }, failed);
        yield* Effect.annotateCurrentSpan("executor.tools.source", "live");
        const context = yield* resolve(state, resolveAccount).pipe(
          Effect.withSpan("sdk.accounts.resolve"),
        );
        const tool = yield* describe(state, context, input.tool);
        return {
          ...tool,
          app: state.app.id,
          version: state.version.id,
          name: ToolName.make(tool.name),
        };
      }).pipe(Effect.withSpan("sdk.tools.get")),
    call: (input: Parameters<Executor["tools"]["call"]>[0], options?: ToolInvocationOptions) =>
      Effect.gen(function* () {
        if (yield* storage.reactivity.inTransaction) return yield* new RequestInvalid();
        const parsed = yield* Schema.decodeUnknownEffect(ToolInputs.call)(input).pipe(
          Effect.mapError(() => new RequestInvalid()),
        );
        // Round-trip before any async lookup: later caller mutations cannot change the dispatched or saved arguments.
        const args = yield* Schema.encodeEffect(Schema.fromJsonString(Json))(
          parsed.input === undefined ? {} : parsed.input,
        ).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Json))),
          Effect.mapError(() => new RequestInvalid()),
        );
        const { ahead, state } = yield* Effect.gen(function* () {
          const ahead = yield* readAhead(parsed);
          const state = yield* snapshot(db, parsed, ahead?.reads);
          return { ahead, state };
        }).pipe(Effect.withSpan("sdk.invocation.snapshot"));
        // Grant rows read in the batch, for accounts this state holds, stand in for each grant's
        // first read; other accounts read theirs in the resolve loop.
        const held = new Set(selectionAccountIds(state.accounts));
        const grants =
          ahead?.grants !== undefined && ahead.grants.ids.every((id) => held.has(id))
            ? grantReadAhead(ahead.grants.ids, ahead.grants.rows)
            : undefined;
        const context = yield* resolve(state, resolveAccount, ahead?.recheck).pipe(
          Effect.withSpan("sdk.accounts.resolve"),
          Effect.provideService(GrantReadAhead, grants),
        );
        const identity = { app: state.app.id, version: state.version.id, tool: parsed.tool };
        yield* Effect.annotateCurrentSpan({
          "executor.app.id": state.app.id,
          "executor.deployment.id": state.version.id,
          "executor.build.id": state.version.build,
        });
        // Set by the host when it hands this call's work to the app's code: catalog reads for its
        // kind, and the call itself.
        let enteredApp = false;
        const appCode = {
          entered: () => {
            enteredApp = true;
          },
        };
        // The caller's kind, confirmed by the app for a query (`confirmedRead`), decides how a
        // failure is reported and whether a refused call is repeated. For a call that names none,
        // the catalog only names the kind it is dispatched with: reading the catalog ran the app's
        // code, so the call's outcome stays unknown.
        const named = parsed.kind;
        const read = yield* readOf(state, parsed.tool, named);
        // Every failure from here, the app's or Executor's own, passes through `callFailure` once.
        return yield* Effect.gen(function* () {
          const kind = yield* kindOf(state, context, parsed.tool, named);
          let toolError = false;
          const execute = (context: InvocationContext) =>
            Effect.suspend(() => {
              toolError = false;
              return runtime.call({
                app: state.app.id,
                ...(workflows === undefined ? {} : { workflowControls: workflows(state) }),
                build: state.version.build,
                hostApi: listings.hostApi(state.version),
                database: ownsDatabase(state.version.requirements),
                ...context,
                tool: parsed.tool,
                ...(kind === undefined ? {} : { kind }),
                input: args,
                ...(options?.elicitation === undefined ? {} : { elicitation: options.elicitation }),
              });
            }).pipe(
              Effect.provideService(ToolResultObservation, {
                failed: () => {
                  toolError = true;
                },
              }),
              Effect.result,
            );
          const { result, renewal } = yield* executeRenewing(state, context, read, execute);
          // The tool is named once the app has answered for it: a name it lacks is the caller's text.
          if (
            Result.isSuccess(result) ||
            (result.failure._tag !== "HostToolNotFound" &&
              result.failure._tag !== "HostOperationNotFound")
          )
            yield* Effect.annotateCurrentSpan("executor.tool.name", parsed.tool);
          if (Result.isSuccess(result)) {
            if (toolError)
              yield* Effect.annotateCurrentSpan({
                "executor.outcome": "failed",
                "error.type": "McpToolError",
              });
            return {
              status: "completed" as const,
              value: result.success,
              ...(toolError ? { toolError: true as const } : {}),
            };
          }
          // The app reports the decoded input it asks approval for; its prompt is not used.
          if (Schema.is(HostToolApprovalRequired)(result.failure)) {
            // The request saves the caller's kind, so its pending response and its resumption
            // treat a call that named none as one that may write.
            return yield* approvals.save(
              yield* invocation(state, parsed.tool, named, result.failure.input),
              args,
              options?.issuer,
            );
          }
          yield* observeFailure(failureSource(result.failure));
          return yield* Effect.fail(runtimeFailure(identity, state, renewal)(result.failure));
        }).pipe(
          Effect.catch((failure) =>
            // Only a confirmed read's renewal fails a call itself (`executeRenewing`), and a
            // confirmed read keeps its classification. A missing account is the host's finding
            // while it resolves accounts, before any of the app's code runs for it.
            failure._tag === "OAuthReconnectRequired" ||
            failure._tag === "OAuthRenewalFailed" ||
            failure._tag === "AccountRequired" ||
            !enteredApp
              ? Effect.fail(failure)
              : Effect.flatMap(read, (read) => Effect.fail(callFailure(read, enteredApp)(failure))),
          ),
          // A defect after the hand-off, such as in Executor's own code, does not establish what
          // the app's code did either. A call that may write reports it as a failure that records
          // the write, and the defect is still reported as one. Interruption is unchanged.
          Effect.catchCause((cause) =>
            !enteredApp || !Cause.hasDies(cause) || Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.flatMap(read, (read) =>
                  read
                    ? Effect.failCause(cause)
                    : reportDefect(cause).pipe(
                        Effect.andThen(observeFailure("runtime")),
                        Effect.andThen(
                          Effect.fail(
                            new ToolCallFailed({
                              ...identity,
                              reason: "Executor failed unexpectedly while handling this tool call.",
                              mayHaveWritten: true,
                            }),
                          ),
                        ),
                      ),
                ),
          ),
          Effect.provideService(AppCodeEntered, appCode),
        );
      }).pipe(Effect.withSpan("sdk.tools.call")),
    pruneApprovals: (input: Parameters<Executor["tools"]["pruneApprovals"]>[0] = {}) =>
      Schema.decodeUnknownEffect(ToolInputs.pruneApprovals)(input)
        .pipe(
          Effect.mapError(() => new RequestInvalid()),
          Effect.flatMap(({ owner }) => approvals.prune(owner)),
        )
        .pipe(Effect.withSpan("sdk.tools.pruneApprovals")),
    approval: (input: Parameters<Executor["tools"]["approval"]>[0]) =>
      approvals.get(input.requestId, input.owner).pipe(Effect.withSpan("sdk.tools.approval")),
    resume: (input: Parameters<Executor["tools"]["resume"]>[0], options?: ToolInvocationOptions) =>
      Schema.decodeUnknownEffect(ToolInputs.resume)(input, { onExcessProperty: "error" })
        .pipe(
          Effect.mapError(() => new RequestInvalid()),
          Effect.flatMap((input) =>
            approvals.resume(input, options?.issuer, (saved, originalInput) =>
              Effect.gen(function* () {
                // The saved identities name the accounts; their credentials are resolved again.
                const checked = yield* snapshot(db, {
                  app: saved.app,
                  version: saved.version,
                  accounts: invocationAccounts(saved),
                }).pipe(
                  Effect.withSpan("sdk.invocation.snapshot"),
                  Effect.flatMap((state) =>
                    invocation(state, saved.tool, saved.kind, saved.input).pipe(
                      Effect.map((current) => ({ state, current })),
                    ),
                  ),
                  Effect.result,
                );
                // A failed read shows nothing about the context: only an answer that differs does.
                if (Result.isFailure(checked) && !isContextChange(checked.failure)) {
                  yield* Effect.annotateCurrentSpan({
                    "executor.outcome": "failed",
                    "error.type": checked.failure._tag,
                  });
                  return {
                    status: "failed",
                    requestId: input.requestId,
                    reason: "execution-failed",
                    error: checked.failure,
                    context: "unconfirmed",
                  } satisfies ToolResumeResult;
                }
                if (
                  Result.isFailure(checked) ||
                  !Schema.toEquivalence(ToolInvocation)(saved, checked.success.current)
                ) {
                  return {
                    status: "failed",
                    requestId: input.requestId,
                    reason: "context-changed",
                  } satisfies ToolResumeResult;
                }
                const { state } = checked.success;
                return yield* Effect.gen(function* () {
                  yield* Effect.annotateCurrentSpan({
                    "executor.app.id": saved.app,
                    "executor.deployment.id": saved.version,
                    "executor.build.id": state.version.build,
                    "executor.tool.name": saved.tool,
                    "executor.approval.id": input.requestId,
                  });
                  const context = yield* resolve(state, resolveAccount).pipe(
                    Effect.withSpan("sdk.accounts.resolve"),
                  );
                  // Set by the host when it hands this call's work to the app's code, as for a call.
                  let enteredApp = false;
                  // As for a call, the saved (caller's) kind counts as a read only when the app
                  // confirms it.
                  const read = yield* readOf(state, saved.tool, saved.kind);
                  // As for a call, every failure from here passes through `callFailure` once, so a
                  // resumed call that may write reports what it failed with as possibly written.
                  return yield* Effect.gen(function* () {
                    const kind = yield* kindOf(state, context, saved.tool, saved.kind);
                    let toolError = false;
                    const execute = (context: InvocationContext) =>
                      Effect.suspend(() => {
                        toolError = false;
                        return runtime.call({
                          app: saved.app,
                          ...(workflows === undefined
                            ? {}
                            : { workflowControls: workflows(state) }),
                          build: state.version.build,
                          hostApi: listings.hostApi(state.version),
                          database: ownsDatabase(state.version.requirements),
                          ...context,
                          tool: saved.tool,
                          ...(kind === undefined ? {} : { kind }),
                          input: originalInput,
                          approval: { tool: saved.tool, input: saved.input },
                          ...(options?.elicitation === undefined
                            ? {}
                            : { elicitation: options.elicitation }),
                        });
                      }).pipe(
                        Effect.provideService(ToolResultObservation, {
                          failed: () => {
                            toolError = true;
                          },
                        }),
                        Effect.result,
                      );
                    // As for a call, the saved (caller's) kind, confirmed by the app, decides whether
                    // a refused call is repeated; the catalog's only sets the dispatched kind.
                    const { result, renewal } = yield* executeRenewing(
                      state,
                      context,
                      read,
                      execute,
                    );
                    if (Result.isFailure(result)) {
                      yield* observeFailure(failureSource(result.failure));
                      return yield* Effect.fail(
                        runtimeFailure(
                          { app: saved.app, version: saved.version, tool: saved.tool },
                          state,
                          renewal,
                        )(result.failure),
                      );
                    }
                    const value = result.success;
                    if (toolError)
                      yield* Effect.annotateCurrentSpan({
                        "executor.outcome": "failed",
                        "error.type": "McpToolError",
                      });
                    return {
                      status: "completed" as const,
                      value,
                      ...(toolError ? { toolError: true as const } : {}),
                    };
                  }).pipe(
                    Effect.catch((failure) =>
                      failure._tag === "OAuthReconnectRequired" ||
                      failure._tag === "OAuthRenewalFailed" ||
                      failure._tag === "AccountRequired" ||
                      !enteredApp
                        ? Effect.fail(failure)
                        : Effect.flatMap(read, (read) =>
                            Effect.fail(callFailure(read, enteredApp)(failure)),
                          ),
                    ),
                    Effect.provideService(AppCodeEntered, {
                      entered: () => {
                        enteredApp = true;
                      },
                    }),
                  );
                }).pipe(
                  // The request is consumed, so its caller receives the call's own failure.
                  Effect.catch((error) =>
                    Effect.succeed({
                      status: "failed" as const,
                      requestId: input.requestId,
                      reason: "execution-failed" as const,
                      error,
                    } satisfies ToolResumeResult),
                  ),
                );
              }),
            ),
          ),
        )
        .pipe(Effect.withSpan("sdk.tools.resume")),
  };
};
