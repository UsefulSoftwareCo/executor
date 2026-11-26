import { ProviderError } from "apps/contracts";
import { appProviderFailure } from "./provider-error.ts";
import { invocationAccount } from "./provider.ts";
import type { FirstPartyOAuthClient } from "../contracts/oauth.ts";
import {
  Cause,
  Clock,
  Effect,
  ErrorReporter,
  Exit,
  Match,
  Option,
  Redacted,
  Result,
  Schema,
} from "effect";
import type { HostCrypto } from "./host-crypto.ts";
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
  ToolCallKindObserved,
  type PrefetchedInvocation,
  type PrefetchHost,
  SearchablePrefetch,
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
import type { Listings, SearchableAhead, ToolListing } from "./listings.ts";
import { pageStart, pageTools } from "./tool-pages.ts";
import { ownsDatabase } from "../contracts/apps.ts";

const readApp = (db: Query, app: AppId) =>
  query(() =>
    db.findFirst("apps", {
      join: (b) => b.deployment(),
      where: (b) => b("id", "=", app),
    }),
  );

const readApps = (db: Query, apps: readonly AppId[]) =>
  apps.length === 0
    ? Effect.succeed([])
    : query(() =>
        db.findMany("apps", {
          join: (b) => b.deployment(),
          where: (b) => b("id", "in", apps),
        }),
      );

interface SnapshotReads {
  readonly app: Result.Result<Effect.Success<ReturnType<typeof readApp>>, StorageError>;
  readonly accounts: SelectionAccountsRead;
}

const snapshotReads = (
  db: Query,
  input: {
    readonly app: AppId;
    readonly accounts?: AppAccounts | undefined;
    readonly captured?: { readonly accounts: SelectedAccounts } | undefined;
  },
) => {
  const ids =
    input.captured !== undefined
      ? selectionAccountIds(input.captured.accounts)
      : input.accounts === undefined
        ? []
        : namedAccounts(input.accounts);
  return ids.length === 0
    ? Effect.succeed(undefined)
    : Effect.all(
        [Effect.result(readApp(db, input.app)), Effect.result(readSelectionAccounts(db, ids))],
        {
          concurrency: "unbounded",
        },
      ).pipe(Effect.map(([app, rows]): SnapshotReads => ({ app, accounts: { ids, rows } })));
};

export function snapshot(
  db: Query,
  input: {
    app: AppId;
    version?: VersionId | undefined;
    accounts?: AppAccounts | undefined;
    captured?: { readonly accounts: SelectedAccounts; readonly scope: AccountScope } | undefined;
  },
  readAhead?: SnapshotReads,
) {
  return Effect.gen(function* () {
    const ahead = readAhead ?? (yield* snapshotReads(db, input));
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
    );
    return { app, version, scope, selections, accounts, actor: yield* CurrentActor };
  });
}

export interface RecheckAhead {
  readonly app: { readonly id: AppId; readonly owner: OwnerId };
  readonly actor: string | undefined;
  readonly accounts: readonly Pick<Account, "id" | "owner">[];
  readonly appUses: readonly AppAccountUse[];
  readonly result: Exit.Exit<ReadonlySet<AccountId>, StorageError>;
}

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
const readsGrant = (types: ReadonlyArray<string | undefined> | undefined) =>
  types === undefined || types.some((type) => type !== "secrets");
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
const grantedAccounts = (accounts: AppAccounts, hint: GrantHint | undefined) => {
  const granted = new Set<AccountId>();
  for (const [slot, ids] of invocationEntries(accounts))
    for (const id of ids)
      if ((hint?.accounts.get(id) ?? hint?.requirements.get(slot)) !== false) granted.add(id);
  return [...granted];
};
const grantReadAhead = (ids: readonly AccountId[], rows: ReadonlyArray<GrantRow>) => {
  const byId = new Map<AccountId, GrantRow | null>(ids.map((id) => [id, null]));
  for (const row of rows) if (byId.has(row.id as AccountId)) byId.set(row.id as AccountId, row);
  return byId;
};
const namedAccounts = (accounts: AppAccounts) => [
  ...new Set(invocationEntries(accounts).flatMap(([, ids]) => ids)),
];
const scopeSplit = (accounts: AppAccounts) => ({
  user: [...new Set(Object.values(accounts.user ?? {}).flat())],
  appUses: Object.entries(accounts.app).flatMap(([requirement, ids]) =>
    ids.map((id) => ({ requirement, id })),
  ),
});
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

export const reconnectReported = (state: Effect.Success<ReturnType<typeof snapshot>>) =>
  appAccountReconnect(distinctSelection(state));

export const resolve = (
  state: Effect.Success<ReturnType<typeof snapshot>>,
  resolveAccount: ReturnType<typeof makeOAuth>["resolveSelected"],
  ahead?: RecheckAhead,
) =>
  resolveFor(state, resolveAccount, "run", ahead).pipe(
    Effect.catchTag("AccountUseRefused", () => Effect.fail(new StorageError())),
  );

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
    const selected = distinctSelection(state);
    const { user, app: appUses } = accountAuthority(state.selections);
    const app = { id: state.app.id, owner: state.app.owner };
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

const accountsOutcome = (outcome: "ready" | "reconnect" | "account_required") =>
  Effect.annotateCurrentSpan("executor.accounts.outcome", outcome);

export type InvocationSnapshot = Effect.Success<ReturnType<typeof snapshot>>;
type InvocationContext = Effect.Success<ReturnType<typeof resolve>>;
type SelectedAccount = HostAccountSlots[string];
const isMany = (
  value: SelectedAccount,
): value is Extract<SelectedAccount, ReadonlyArray<unknown>> => Array.isArray(value);
const sameFields = Schema.toEquivalence(JsonObject);

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

type CallError = Effect.Error<ReturnType<Runtime["call"] | Runtime["query"] | Runtime["mutate"]>>;

type Renewal = "renewed" | RenewalFailure;

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

const detailSource = ({ source }: { readonly source?: AppFailure["source"] }): CallFailureSource =>
  source === "service" ? "upstream" : source === "storage" ? "storage" : "app";

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

const observeFailure = (source: CallFailureSource) =>
  Effect.map(CallFailureSources, (observe) => observe?.(source));

const toolCallFailure =
  (
    identity: { app: AppId; version: VersionId; tool: ToolName },
    state: InvocationSnapshot,
    renewal: Renewal | undefined,
  ) =>
  (failure: CallError) =>
    failure._tag === "RuntimeProtocolFailed" && failure.notSent === true
      ? new ToolCallFailed({
          ...identity,
          reason:
            "Executor could not connect to the app runtime, so it did not send this tool call.",
          notSent: true,
        })
      : failure._tag === "RuntimeProtocolFailed" && failure.reason === "unloading"
        ? new ToolCallFailed({
            ...identity,
            reason:
              "The app's previous Worker did not finish unloading, so Executor did not send this tool call.",
            notSent: true,
          })
        : runtimeFailure(identity, state, renewal)(failure);
const notSentOnly = (failure: CallFailure) =>
  failure._tag === "ToolCallFailed" && failure.notSent === true;
const partlyRun = ({ app, version, tool }: ToolCallFailed) =>
  new ToolCallFailed({
    app,
    version,
    tool,
    reason:
      "Executor could not reach the app runtime to finish this tool call. An earlier step of the call reached the app, so the call may have partly run.",
  });
export const callFailure =
  (read: boolean, enteredApp: boolean, entries: number) =>
  (failure: CallFailure): CallFailure =>
    read || !enteredApp || (entries === 1 && notSentOnly(failure))
      ? failure
      : Match.value(failure).pipe(
          Match.tagsExhaustive({
            ToolCallFailed: (failure) =>
              mayHaveWritten(ToolCallFailed, notSentOnly(failure) ? partlyRun(failure) : failure),
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

export const appEntries = (onEntered: () => void, earlier = 0) => {
  let entries = earlier;
  return {
    entered: () => {
      entries += 1;
      onEntered();
    },
    callFailure: (read: boolean, enteredApp: boolean) => callFailure(read, enteredApp, entries),
  };
};

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

const summarizeTool = ({
  inputSchema: _input,
  outputSchema: _output,
  _meta,
  ...summary
}: Tool): ToolSummary => summary;

export const makeTools = (
  storage: ExecutorDatabase,
  oauth: Pick<ReturnType<typeof makeOAuth>, "resolveSelected" | "renewRejected" | "usableAll">,
  clients: ReadonlyMap<string, FirstPartyOAuthClient>,
  runtime: Runtime,
  credentials: Credentials,
  crypto: HostCrypto,
  listings: Listings,
  workflows?: (state: InvocationSnapshot) => WorkflowHostControls,
  lifecycle?: ResourceLifecycle,
) => {
  const db = database(storage);
  const resolveAccount = oauth.resolveSelected;
  const approvals = makeToolApprovals(db, credentials, crypto, storage.reactivity.inTransaction);
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
  const catalogFailure = (
    state: InvocationSnapshot,
    error: Effect.Error<ReturnType<typeof runtime.index>>,
    renewal?: Renewal,
  ) =>
    Schema.is(ProviderError)(error)
      ? appProviderFailure(state, error, renewal)
      : evaluationFailure({ app: state.app.id, version: state.version.id }, error);
  const failCatalog = (
    state: InvocationSnapshot,
    error: Effect.Error<ReturnType<typeof runtime.index>>,
    renewal?: Renewal,
  ) =>
    observeFailure(failureSource(error)).pipe(
      Effect.andThen(Effect.fail(catalogFailure(state, error, renewal))),
    );
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
  const inspectTool = (state: InvocationSnapshot, name: ToolName, context: InvocationContext) =>
    runtime.inspect(
      state.version.requirements.capabilities?.toolIndex === true
        ? { ...inspection(state, context), tools: [name] }
        : inspection(state, context),
    );
  const found =
    (state: InvocationSnapshot, name: ToolName) =>
    ({ tools, routers }: Effect.Success<ReturnType<typeof runtime.inspect>>) =>
      Effect.gen(function* () {
        const tool = tools.find((tool) => tool.name === name);
        if (tool !== undefined) return tool;
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
  const describe = (state: InvocationSnapshot, context: InvocationContext, name: ToolName) =>
    inspectRenewing(state, context, (context) => inspectTool(state, name, context)).pipe(
      Effect.flatMap(found(state, name)),
    );
  const catalogKind = (state: InvocationSnapshot, context: InvocationContext, name: ToolName) =>
    inspectTool(state, name, context).pipe(
      Effect.catch((error) =>
        renewOnce(state, context, error).pipe(
          Effect.flatMap((renewal) => failCatalog(state, error, renewal)),
        ),
      ),
      Effect.flatMap(found(state, name)),
    );
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
  const invocationReads = (
    selection: {
      readonly app: AppId;
      readonly owner: OwnerId;
      readonly accounts: AppAccounts;
    },
    grantsOf: readonly AccountId[] = [],
  ) => {
    const ids = namedAccounts(selection.accounts);
    const app = { id: selection.app, owner: selection.owner };
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
  const prefetchInvocation: PrefetchHost["invocation"] = (selection) => {
    const known = selection.known;
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
  interface SearchableEntry {
    readonly target: {
      readonly app: AppId;
      readonly version: VersionId;
      readonly accounts: AppAccounts;
    };
    readonly actor: string | undefined;
    readonly state: InvocationSnapshot;
    readonly ahead: SearchableAhead;
  }
  class SearchableReads {
    readonly entries: Map<AppId, SearchableEntry>;
    constructor(entries: Map<AppId, SearchableEntry>) {
      this.entries = entries;
    }
    take(input: {
      readonly app: AppId;
      readonly version?: VersionId | undefined;
      readonly accounts?: AppAccounts | undefined;
    }) {
      const entry = this.entries.get(input.app);
      if (
        entry === undefined ||
        input.version !== entry.target.version ||
        input.accounts === undefined ||
        !sameAccounts(entry.target.accounts, input.accounts)
      )
        return undefined;
      this.entries.delete(input.app);
      return entry;
    }
  }
  const prefetchSearchable: PrefetchHost["searchable"] = ({ owner, targets }) =>
    Effect.gen(function* () {
      const actor = yield* CurrentActor;
      const [apps, accounts] = yield* Effect.all(
        [
          readApps(db, [...new Set(targets.map((target) => target.app))]),
          readSelectionAccounts(db, [
            ...new Set(targets.flatMap((target) => namedAccounts(target.accounts))),
          ]),
        ],
        { concurrency: "unbounded" },
      );
      const states = yield* Effect.forEach(targets, (target) => {
        const ids = new Set(namedAccounts(target.accounts));
        const reads: SnapshotReads = {
          app: Result.succeed(apps.find((row) => row.id === target.app) ?? null),
          accounts: {
            ids: [...ids],
            rows: Result.succeed(accounts.filter((row) => ids.has(row.id))),
          },
        };
        return snapshot(db, target, reads).pipe(
          Effect.withSpan("sdk.invocation.snapshot"),
          Effect.option,
          Effect.map(Option.filter((state) => state.app.owner === owner)),
          Effect.map(Option.map((state) => ({ target, state }))),
        );
      }).pipe(Effect.map((found) => found.flatMap(Option.toArray)));
      const aheads = yield* listings.searchablePrefetch(
        owner,
        states.map(({ state }) => state),
      );
      const entries = new Map<AppId, SearchableEntry>();
      states.forEach(({ target, state }, index) => {
        const ahead = aheads[index];
        if (ahead === undefined || entries.has(target.app)) return;
        entries.set(target.app, { target, actor, state, ahead });
      });
      return { owner, value: new SearchableReads(entries) };
    }).pipe(
      Effect.catchCause(() => Effect.succeed({ owner, value: undefined })),
      Effect.withSpan("sdk.tools.searchable.prefetch", {
        attributes: { "executor.prefetch.targets": targets.length },
      }),
    );
  const searchableAhead = (input: {
    readonly app: AppId;
    readonly version?: VersionId | undefined;
    readonly accounts?: AppAccounts | undefined;
  }) =>
    Effect.gen(function* () {
      const prefetched = yield* SearchablePrefetch;
      if (prefetched === undefined || !(prefetched.value instanceof SearchableReads))
        return undefined;
      const entry = prefetched.value.take(input);
      if (
        entry === undefined ||
        entry.state.app.owner !== prefetched.owner ||
        entry.actor !== (yield* CurrentActor)
      )
        return undefined;
      return entry;
    });
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
  const evaluate = <A, R>(
    input: Parameters<Executor["tools"]["index"]>[0],
    read: (
      options: Parameters<typeof runtime.index>[0],
      toolIndex: boolean,
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
  const listingOf = (state: InvocationSnapshot) => (context: InvocationContext) =>
    inspectRenewing(state, context, (context) => runtime.inspect(inspection(state, context))).pipe(
      Effect.map(toListing(state)),
    );
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
  const declaredReadOf = (state: InvocationSnapshot, name: ToolName, kind: ToolKind | undefined) =>
    kind === "query"
      ? listings.kept(state).pipe(
          Effect.orElseSucceed(() => Effect.succeed<ToolListing | undefined>(undefined)),
          Effect.flatMap((kept) =>
            Effect.cached(
              kept.pipe(
                Effect.map(
                  (listing) =>
                    listing?.items.some((tool) => tool.name === name && tool.readOnly === true) ===
                    true,
                ),
                Effect.tap((declared) =>
                  Effect.annotateCurrentSpan("executor.tool.read_declared", declared),
                ),
              ),
            ),
          ),
        )
      : Effect.succeed(Effect.succeed(false));
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
    prefetchSearchable,
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
    list: (input: Parameters<Executor["tools"]["list"]>[0], options?: ToolListOptions) =>
      Effect.gen(function* () {
        const state = yield* listed(input);
        const listing = yield* listings.read(state, listingOf(state), options);
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
    searchable: (
      input: Omit<Parameters<Executor["tools"]["list"]>[0], "cursor" | "limit">,
      options?: ToolListOptions,
    ) =>
      Effect.gen(function* () {
        const ahead = yield* searchableAhead(input);
        const state =
          ahead === undefined
            ? yield* listed(input)
            : yield* Effect.as(
                Effect.annotateCurrentSpan({
                  "executor.app.id": ahead.state.app.id,
                  "executor.deployment.id": ahead.state.version.id,
                  "executor.build.id": ahead.state.version.build,
                }),
                ahead.state,
              );
        const found = yield* listings.searchable(state, listingOf(state), options, ahead?.ahead);
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
    scheduled: (input: Parameters<Executor["tools"]["list"]>[0]) =>
      Effect.gen(function* () {
        const {
          version,
          value: { tools },
        } = yield* evaluate(input, (options, _toolIndex, scheduled) =>
          runtime.inspect(scheduled ? { ...options, scheduled: true } : options),
        );
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
        let enteredApp = false;
        const appCode = appEntries(() => {
          enteredApp = true;
        });
        const named = parsed.kind;
        const read = yield* readOf(state, parsed.tool, named);
        const declaredRead = yield* declaredReadOf(state, parsed.tool, named);
        return yield* Effect.gen(function* () {
          const kind = yield* kindOf(state, context, parsed.tool, named);
          if (kind !== undefined) (yield* ToolCallKindObserved)?.(kind);
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
          if (Schema.is(HostToolApprovalRequired)(result.failure)) {
            return yield* approvals.save(
              yield* invocation(state, parsed.tool, named, result.failure.input),
              args,
              options?.issuer,
            );
          }
          yield* observeFailure(failureSource(result.failure));
          return yield* Effect.fail(toolCallFailure(identity, state, renewal)(result.failure));
        }).pipe(
          Effect.catch((failure) =>
            failure._tag === "OAuthReconnectRequired" ||
            failure._tag === "OAuthRenewalFailed" ||
            failure._tag === "AccountRequired" ||
            !enteredApp
              ? Effect.fail(failure)
              : Effect.flatMap(Effect.all([read, declaredRead]), ([read, declared]) =>
                  Effect.fail(appCode.callFailure(read || declared, enteredApp)(failure)),
                ),
          ),
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
                  let enteredApp = false;
                  const appCode = appEntries(() => {
                    enteredApp = true;
                  }, 1);
                  const read = yield* readOf(state, saved.tool, saved.kind);
                  const declaredRead = yield* declaredReadOf(state, saved.tool, saved.kind);
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
                    const { result, renewal } = yield* executeRenewing(
                      state,
                      context,
                      read,
                      execute,
                    );
                    if (Result.isFailure(result)) {
                      yield* observeFailure(failureSource(result.failure));
                      return yield* Effect.fail(
                        toolCallFailure(
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
                        : Effect.flatMap(Effect.all([read, declaredRead]), ([read, declared]) =>
                            Effect.fail(appCode.callFailure(read || declared, enteredApp)(failure)),
                          ),
                    ),
                    Effect.provideService(AppCodeEntered, appCode),
                  );
                }).pipe(
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
