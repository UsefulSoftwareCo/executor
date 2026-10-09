import { ProviderError } from "apps/contracts";
import { appProviderFailure } from "./provider-error.ts";
import { grantedDefinition } from "./provider.ts";
/** Snapshot the configured app, then execute with its selected credentials. */
import { type Crypto, Effect, Match, Option, Redacted, Result, Schema } from "effect";
import {
  type WorkflowHostControls,
  HostToolApprovalRequired,
  ToolResultObservation,
  type ResolvedAccounts,
} from "apps/contracts";
import { AccountRequired, AppNotFound, AppNotDeployed } from "../contracts/apps.ts";
import { DeploymentNotFound } from "../contracts/deployment.ts";
import type { ResourceLifecycle } from "../contracts/executor.ts";
import type { Executor } from "../contracts/executor.ts";
import type { Runtime } from "../contracts/runtime.ts";
import {
  Cursor,
  ToolName,
  Json,
  JsonObject,
  RequestInvalid,
  StorageError,
  type AccountId,
  type AppId,
  type DeploymentId,
} from "../contracts/shared.ts";
import { OAuthReconnectRequired } from "../contracts/oauth.ts";
import type { makeOAuth } from "./oauth.ts";
import {
  AppEvaluationFailed,
  appFailure,
  appFailureText,
  evaluationFailure,
  InputInvalid,
  operationMcpFailure,
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
  type ToolResumeResult,
  type Tool,
  type ToolSummary,
} from "../contracts/tools.ts";
import type { ExecutorDatabase } from "./storage.ts";
import { type Credentials, StoredApp, StoredDeployment } from "../contracts/storage.ts";
import { makeToolApprovals } from "./tool-approvals.ts";
import { storedDeployment } from "./apps.ts";
import { database, query, type Query } from "./database.ts";
import { storedProfile } from "./profiles.ts";
import { CurrentProfile, ProfileConflict } from "../contracts/profiles.ts";
import type { ProfileId } from "../contracts/shared.ts";
import { validateSelection } from "./selection.ts";
import type { Listings, ToolListing } from "./listings.ts";
import { ownsDatabase } from "../contracts/apps.ts";

/**
 * Resolve the app, pinned deployment, profile and account selection before invoking authored code.
 *
 * These reads deliberately run outside a transaction. A transaction costs two extra round trips and
 * pins a pooled server connection (a Hyperdrive origin connection in Cloud) for as long as the
 * caller takes between statements. On Postgres at READ COMMITTED it gave no cross-statement
 * snapshot anyway. On PGlite it was atomic with respect to writers, because a transaction reserves
 * the only connection; that atomicity is dropped on purpose. A write that lands between two reads
 * cannot widen access: every cross-read disagreement fails closed (AppNotDeployed,
 * DeploymentNotFound, ProfileConflict, AccountNotFound, AccountSelectionInvalid or
 * AccountRequired), and account credentials are resolved from the returned selection afterwards.
 */
export function snapshot(
  db: Query,
  input: {
    app: AppId;
    deployment?: DeploymentId | undefined;
    profile?: ProfileId | undefined;
    expectedProfileRevision?: number | undefined;
  },
  savedAccounts?: import("../contracts/apps.ts").SelectedAccounts,
  savedProfileRevision?: number,
  cleanup = false,
) {
  return Effect.gen(function* () {
    const row = yield* query(() =>
      db.findFirst("apps", {
        join: (b) => b.deployment(),
        where: (b) => b("id", "=", input.app),
      }),
    );
    if (row === null) return yield* new AppNotFound({ app: input.app });
    const app = yield* Schema.decodeUnknownEffect(StoredApp)(row).pipe(
      Effect.mapError(() => new StorageError()),
    );
    const deploymentId = input.deployment ?? app.activeDeployment;
    if (deploymentId === null) return yield* new AppNotDeployed({ app: app.id });
    // Historical invocations retain their pinned deployment and its lineage check.
    const deployment =
      deploymentId !== app.activeDeployment
        ? yield* storedDeployment(db, app, deploymentId)
        : row.deployment === null
          ? yield* new DeploymentNotFound({ app: app.id, deployment: deploymentId })
          : yield* Schema.decodeUnknownEffect(StoredDeployment)(row.deployment).pipe(
              Effect.mapError(() => new StorageError()),
            );
    const profile =
      input.profile === undefined
        ? undefined
        : yield* storedProfile(db, {
            app: app.id,
            profile: input.profile,
            owner: app.owner,
          });
    if (profile !== undefined) {
      if (
        profile.status === "removed" ||
        ((!profile.enabled || profile.status === "removing") && !cleanup)
      )
        return yield* new ProfileConflict({
          profile: profile.id,
          reason: "inactive",
        });
      if (
        input.expectedProfileRevision !== undefined &&
        profile.revision !== input.expectedProfileRevision
      )
        return yield* new ProfileConflict({
          profile: profile.id,
          reason: "revision",
        });
    }
    const bindings = profile === undefined ? {} : (savedAccounts ?? profile.accounts);
    const validated = yield* validateSelection(db, app.id, deployment.requirements, bindings);
    const selections = yield* Effect.forEach(
      Object.keys(deployment.requirements.accounts),
      (slot) =>
        Effect.gen(function* () {
          const selected = validated.get(slot);
          if (selected === undefined)
            return yield* Effect.fail(
              new AccountRequired({ app: app.id, deployment: deployment.id, slot }),
            );
          return selected;
        }),
    );
    return {
      app,
      deployment,
      selections,
      profile:
        profile === undefined
          ? undefined
          : { ...profile, revision: savedProfileRevision ?? profile.revision },
      accounts: bindings,
    };
  });
}

/** Resolve current credentials without holding a database transaction open. */
export function resolve(
  state: Effect.Success<ReturnType<typeof snapshot>>,
  resolveAccount: ReturnType<typeof makeOAuth>["resolveSelected"],
  lifecycle?: ResourceLifecycle,
) {
  return Effect.gen(function* () {
    const selections = new Map<string, ResolvedAccounts[string]>();
    // An account selected for several slots is resolved once per invocation, in selection
    // order. A token renewed for one slot is the token every slot uses, even when it already
    // falls inside the refresh-ahead window, so one invocation never renews the same grant twice.
    const distinct = new Map<AccountId, Parameters<typeof resolveAccount>[0][number]>();
    for (const { required, accounts } of state.selections)
      for (const account of accounts)
        if (!distinct.has(account.id))
          distinct.set(account.id, { account, provider: required.definition });
    const selected = [...distinct.values()];
    // The profile's subject and its accounts are rechecked together, before any credential.
    const resolvedFields =
      state.profile !== undefined && lifecycle?.profileResolving
        ? yield* resolveAccount(
            selected,
            lifecycle.profileResolving(
              state.profile,
              selected.map(({ account }) => account),
            ),
          )
        : yield* resolveAccount(selected);
    const credentials = new Map(
      [...distinct.keys()].map((id, index) => [id, resolvedFields[index]] as const),
    );
    for (const { slot, required, accounts } of state.selections) {
      const resolved = yield* Effect.forEach(accounts, (account) =>
        Effect.gen(function* () {
          const fields = credentials.get(account.id);
          if (fields === undefined) return yield* new StorageError();
          return {
            id: account.id,
            provider: grantedDefinition(required.definition, account.allowedHosts),
            method: account.method,
            generation: account.credentialGeneration,
            fields: Redacted.value(fields),
          };
        }),
      );
      if (required.cardinality === "many") selections.set(slot, resolved);
      else {
        const account = resolved[0];
        if (account === undefined)
          return yield* Effect.fail(
            new AccountRequired({ app: state.app.id, deployment: state.deployment.id, slot }),
          );
        selections.set(slot, account);
      }
    }
    return {
      accounts: Redacted.make(Object.fromEntries(selections)),
    };
  }).pipe(Effect.provideService(CurrentProfile, state.profile));
}

/** Whether a profile's selected accounts can run its tools; recorded on the check's span. */
const accountsOutcome = (outcome: "ready" | "reconnect" | "account_required") =>
  Effect.annotateCurrentSpan("executor.accounts.outcome", outcome);

/** One resolved invocation: app, pinned deployment, optional profile and account selection. */
export type InvocationSnapshot = Effect.Success<ReturnType<typeof snapshot>>;
type InvocationContext = Effect.Success<ReturnType<typeof resolve>>;
type SelectedAccount = ResolvedAccounts[string];
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
  renewRejected: ReturnType<typeof makeOAuth>["renewRejected"],
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
    const selected = state.selections
      .flatMap(({ required, accounts }) =>
        accounts.map((account) => ({ account, definition: required.definition })),
      )
      .find(({ account }) => account.id === accountId);
    if (selected === undefined) return undefined;
    const accounts = Redacted.value(context.accounts);
    const used = Object.values(accounts)
      .flatMap((value) => (isMany(value) ? value : [value]))
      .find((account) => account.id === accountId);
    if (used === undefined) return undefined;
    // Renewal authorizes the account for the profile's subject, as `resolve` does. A scheduled
    // call has no signed-in caller to fall back on.
    const renewed = yield* renewRejected(selected.account, selected.definition, used.fields).pipe(
      Effect.provideService(CurrentProfile, state.profile),
      Effect.flatMap((fields) =>
        Schema.decodeUnknownEffect(JsonObject)(Redacted.value(fields)).pipe(
          Effect.mapError(() => new StorageError()),
        ),
      ),
    );
    if (sameFields(renewed, used.fields)) return undefined;
    yield* Effect.annotateCurrentSpan("executor.account.credentials_renewed", accountId);
    const replace = <A extends { readonly id: AccountId; readonly fields: JsonObject }>(
      account: A,
    ): A => (account.id === accountId ? { ...account, fields: renewed } : account);
    return {
      accounts: Redacted.make(
        Object.fromEntries(
          Object.entries(accounts).map(([slot, value]) => [
            slot,
            isMany(value) ? value.map(replace) : replace(value),
          ]),
        ),
      ),
    } satisfies InvocationContext;
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
    ...(state.profile === undefined
      ? {}
      : { profile: state.profile.id, profileRevision: state.profile.revision }),
    deployment: state.deployment.id,
    tool,
    ...(kind === undefined ? {} : { kind }),
    input,
    accounts: Object.fromEntries(
      state.selections.map(({ slot, required, accounts }) => {
        const identities = accounts.map(({ id, owner, provider, method }) => ({
          id,
          owner,
          provider,
          method,
        }));
        return [slot, required.cardinality === "many" ? identities : identities[0]];
      }),
    ),
  }).pipe(Effect.mapError(() => new StorageError()));
}

const runtimeFailure = (
  identity: { app: AppId; deployment: DeploymentId; tool: ToolName },
  state: InvocationSnapshot,
) =>
  Match.type<
    Effect.Error<ReturnType<Runtime["call"] | Runtime["query"] | Runtime["mutate"]>>
  >().pipe(
    Match.tagsExhaustive({
      ProviderError: (error) => appProviderFailure(state, error),
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
      HostRequestInvalid: () =>
        new AppEvaluationFailed({ ...identity, reason: "App evaluation failed" }),
      HostAccountsInvalid: () =>
        new AppEvaluationFailed({ ...identity, reason: "App evaluation failed" }),
      HostDeclarationInvalid: () =>
        new AppEvaluationFailed({ ...identity, reason: "App evaluation failed" }),
      HostEvaluationFailed: (error) => evaluationFailure(identity, error),
      SkillLoadFailed: (error) => evaluationFailure(identity, error),
      McpError: (error) => operationMcpFailure(identity, error),
      RuntimeBuildUnavailable: () =>
        new AppEvaluationFailed({ ...identity, reason: "App evaluation failed" }),
      RuntimeProtocolFailed: () =>
        new AppEvaluationFailed({ ...identity, reason: "App evaluation failed" }),
      RuntimeProtocolUnsupported: (error) =>
        new AppEvaluationFailed({ ...identity, reason: error.message }),
    }),
  );

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
  oauth: Pick<ReturnType<typeof makeOAuth>, "resolveSelected" | "renewRejected" | "usable">,
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
  /**
   * Run a tool, live or approved, and renew an account the service refuses. A 401 means the
   * service did not perform the refused request, but an earlier request in the same call may
   * already have made changes. A query only reads, so it is repeated once with the renewed
   * credentials; a mutation is never repeated and fails, noting that access was renewed.
   */
  const executeRenewing = <A, E, R>(
    state: InvocationSnapshot,
    context: InvocationContext,
    kind: ToolKind | undefined,
    execute: (context: InvocationContext) => Effect.Effect<Result.Result<A, E>, never, R>,
  ) =>
    Effect.gen(function* () {
      const result = yield* execute(context);
      if (Result.isSuccess(result)) return result;
      const refused = result.failure;
      const renewed = yield* renewRefused(oauth.renewRejected, state, context, refused);
      if (renewed === undefined) return result;
      if (kind === "query") {
        yield* Effect.annotateCurrentSpan("executor.tool.retry", "credentials_renewed");
        return yield* execute(renewed);
      }
      if (Schema.is(ProviderError)(refused))
        return yield* Effect.fail(appProviderFailure(state, refused, true));
      return result;
    });
  /** Runtime options that evaluate one invocation's catalog with its resolved accounts. */
  const inspection = (state: InvocationSnapshot, context: InvocationContext) => ({
    app: state.app.id,
    build: state.deployment.build,
    ...context,
    ...(workflows === undefined ? {} : { workflowControls: workflows(state) }),
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
  ) => {
    const failure = (error: Effect.Error<ReturnType<typeof runtime.index>>) =>
      Schema.is(ProviderError)(error)
        ? appProviderFailure(state, error)
        : evaluationFailure({ app: state.app.id, deployment: state.deployment.id }, error);
    return inspect(context).pipe(
      Effect.catch((error) =>
        renewRefused(oauth.renewRejected, state, context, error).pipe(
          Effect.flatMap((renewed) =>
            renewed === undefined
              ? Effect.fail(failure(error))
              : inspect(renewed).pipe(Effect.mapError(failure)),
          ),
        ),
      ),
    );
  };
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
        state.deployment.requirements.capabilities?.toolIndex === true,
        state.deployment.requirements.capabilities?.scheduledTools === true,
      ),
    );
  /** Describe one tool of the live catalog; ToolNotFound when it is absent. */
  const describe = (state: InvocationSnapshot, context: InvocationContext, name: ToolName) =>
    readCatalog(state, context, (options, toolIndex) =>
      runtime.inspect(toolIndex ? { ...options, tools: [name] } : options),
    ).pipe(
      Effect.flatMap(({ tools, routers }) =>
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
              : evaluationFailure({ app: state.app.id, deployment: state.deployment.id }, failed);
          return yield* new ToolNotFound({
            app: state.app.id,
            deployment: state.deployment.id,
            tool: name,
          });
        }),
      ),
    );
  /**
   * The caller's kind, or the catalog's for a caller that did not name one. A tool the catalog
   * does not list, such as one a dynamic source resolves on demand, is called without a kind:
   * the app applies the tool's own kind and storage opens for writing.
   */
  const kindOf = (
    state: InvocationSnapshot,
    context: InvocationContext,
    name: ToolName,
    kind: ToolKind | undefined,
  ) =>
    kind === undefined
      ? describe(state, context, name).pipe(
          Effect.map((tool): ToolKind | undefined =>
            tool.readOnly === true ? "query" : "mutation",
          ),
          Effect.catchTag("ToolNotFound", () => Effect.succeed(undefined)),
          Effect.withSpan("sdk.tools.kind"),
        )
      : Effect.succeed(kind);
  /** Evaluate the selected profile's live catalog. */
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
      const context = yield* resolve(state, resolveAccount, lifecycle).pipe(
        Effect.withSpan("sdk.accounts.resolve"),
      );
      yield* Effect.annotateCurrentSpan({
        "executor.app.id": state.app.id,
        "executor.deployment.id": state.deployment.id,
        "executor.build.id": state.deployment.build,
      });
      return { deployment: state.deployment.id, value: yield* readCatalog(state, context, read) };
    });
  /** The invocation state a listing is read for, annotated on the caller's span. */
  const listed = (input: Parameters<typeof snapshot>[1]) =>
    Effect.gen(function* () {
      const state = yield* snapshot(db, input).pipe(Effect.withSpan("sdk.invocation.snapshot"));
      yield* Effect.annotateCurrentSpan({
        "executor.app.id": state.app.id,
        "executor.deployment.id": state.deployment.id,
        "executor.build.id": state.deployment.build,
      });
      return state;
    });
  /** Evaluate every tool of the catalog with schemas, sorted by name, for the listing store. */
  const listingOf = (state: InvocationSnapshot) => (context: InvocationContext) =>
    inspectRenewing(state, context, (context) => runtime.inspect(inspection(state, context))).pipe(
      Effect.map(({ tools, routers }): ToolListing => ({
        catalog: {
          deployment: state.deployment.id,
          ...(state.profile === undefined
            ? {}
            : { profile: state.profile.id, profileRevision: state.profile.revision }),
        },
        routers,
        items: [...tools]
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .map((tool) => ({
            ...tool,
            app: state.app.id,
            deployment: state.deployment.id,
            name: ToolName.make(tool.name),
          })),
      })),
    );
  return {
    /**
     * The first account selected by this profile whose saved sign-in must reconnect before the
     * profile's tools can run; undefined when every account can supply credentials. Reads stored
     * state only: it never renews a grant or evaluates the app.
     *
     * An account that must reconnect, or a required account that is not selected yet, is an
     * expected account state the owner resolves, not a fault of this check. It is recorded as the
     * span's `executor.accounts.outcome`; a missing account fails the caller only after the span.
     */
    accountNeedingReconnect: (input: { app: AppId; profile: ProfileId }) =>
      Effect.gen(function* () {
        const state = yield* snapshot(db, input);
        for (const { required, accounts } of state.selections)
          for (const account of accounts) {
            const usable = yield* oauth.usable(account, required.definition).pipe(Effect.result);
            if (Result.isFailure(usable)) {
              if (!Schema.is(OAuthReconnectRequired)(usable.failure))
                return yield* Effect.fail(usable.failure);
              yield* accountsOutcome("reconnect");
              return account.id;
            }
          }
        yield* accountsOutcome("ready");
        return undefined;
      }).pipe(
        Effect.catchIf(Schema.is(AccountRequired), (missing) =>
          accountsOutcome("account_required").pipe(Effect.as(missing)),
        ),
        Effect.withSpan("sdk.accounts.reconnectRequired", {
          attributes: { "executor.app.id": input.app, "executor.profile.id": input.profile },
        }),
        Effect.flatMap((found) =>
          Schema.is(AccountRequired)(found) ? Effect.fail(found) : Effect.succeed(found),
        ),
      ),
    /**
     * Page through the app's evaluated catalog. The whole listing is evaluated once and, with a
     * listing store, reused across pages and requests for identical inputs.
     */
    list: (input: Parameters<Executor["tools"]["list"]>[0], options?: ToolListOptions) =>
      Effect.gen(function* () {
        const state = yield* listed(input);
        const listing = yield* listings.read(state, listingOf(state), options);
        // Pages share the listing's item objects, so a caller can recognise a kept listing.
        const cursor: string | undefined = input.cursor;
        const after =
          cursor === undefined ? listing.items : listing.items.filter((tool) => tool.name > cursor);
        const selected = after.slice(0, input.limit ?? 2_000);
        const last = selected.at(-1);
        return {
          ...listing.catalog,
          routers: listing.routers,
          items: selected,
          ...(last !== undefined && after.length > selected.length
            ? { next: Cursor.make(last.name) }
            : {}),
        };
      }).pipe(Effect.withSpan("sdk.tools.list")),
    /**
     * Describe the declared operations that have schedules. Current builds skip dynamic
     * tool discovery, which can compile a large catalog in the shared app runtime.
     */
    scheduled: (input: Parameters<Executor["tools"]["list"]>[0]) =>
      Effect.gen(function* () {
        const {
          deployment,
          value: { tools },
        } = yield* evaluate(input, (options, _toolIndex, scheduled) =>
          runtime.inspect(scheduled ? { ...options, scheduled: true } : options),
        );
        // Callers that act on the result can require that this deployment is still active.
        return {
          deployment,
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
            : evaluationFailure({ app: state.app.id, deployment: state.deployment.id }, failed);
        yield* Effect.annotateCurrentSpan("executor.tools.source", "live");
        const context = yield* resolve(state, resolveAccount, lifecycle).pipe(
          Effect.withSpan("sdk.accounts.resolve"),
        );
        const tool = yield* describe(state, context, input.tool);
        return {
          ...tool,
          app: state.app.id,
          deployment: state.deployment.id,
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
        const state = yield* snapshot(db, parsed).pipe(Effect.withSpan("sdk.invocation.snapshot"));
        const context = yield* resolve(state, resolveAccount, lifecycle).pipe(
          Effect.withSpan("sdk.accounts.resolve"),
        );
        const identity = { app: state.app.id, deployment: state.deployment.id, tool: parsed.tool };
        yield* Effect.annotateCurrentSpan({
          "executor.app.id": state.app.id,
          "executor.deployment.id": state.deployment.id,
          "executor.build.id": state.deployment.build,
        });
        const kind = yield* kindOf(state, context, parsed.tool, parsed.kind);
        let toolError = false;
        const execute = (context: InvocationContext) =>
          Effect.suspend(() => {
            toolError = false;
            return runtime.call({
              app: state.app.id,
              ...(workflows === undefined ? {} : { workflowControls: workflows(state) }),
              build: state.deployment.build,
              database: ownsDatabase(state.deployment.requirements),
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
        const result = yield* executeRenewing(state, context, kind, execute);
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
        if (Schema.is(HostToolApprovalRequired)(result.failure)) {
          return yield* approvals.save(
            yield* invocation(state, parsed.tool, kind, result.failure.input),
            args,
            result.failure.elicitation,
          );
        }
        return yield* Effect.fail(runtimeFailure(identity, state)(result.failure));
      }).pipe(Effect.withSpan("sdk.tools.call")),
    pruneApprovals: (input: Parameters<Executor["tools"]["pruneApprovals"]>[0] = {}) =>
      Schema.decodeUnknownEffect(ToolInputs.pruneApprovals)(input)
        .pipe(
          Effect.mapError(() => new RequestInvalid()),
          Effect.flatMap(({ owner }) => approvals.prune(owner)),
        )
        .pipe(Effect.withSpan("sdk.tools.pruneApprovals")),
    resume: (input: Parameters<Executor["tools"]["resume"]>[0], options?: ToolInvocationOptions) =>
      Schema.decodeUnknownEffect(ToolInputs.resume)(input, { onExcessProperty: "error" })
        .pipe(
          Effect.mapError(() => new RequestInvalid()),
          Effect.flatMap((input) =>
            approvals.resume(input, (saved, originalInput) =>
              Effect.gen(function* () {
                const checked = yield* snapshot(db, {
                  app: saved.app,
                  deployment: saved.deployment,
                  profile: saved.profile,
                  expectedProfileRevision: saved.profileRevision,
                }).pipe(
                  Effect.withSpan("sdk.invocation.snapshot"),
                  Effect.flatMap((state) =>
                    invocation(state, saved.tool, saved.kind, saved.input).pipe(
                      Effect.map((current) => ({ state, current })),
                    ),
                  ),
                  Effect.result,
                );
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
                    "executor.deployment.id": saved.deployment,
                    "executor.build.id": state.deployment.build,
                    "executor.tool.name": saved.tool,
                    "executor.approval.id": input.requestId,
                  });
                  const context = yield* resolve(state, resolveAccount, lifecycle).pipe(
                    Effect.withSpan("sdk.accounts.resolve"),
                  );
                  const kind = yield* kindOf(state, context, saved.tool, saved.kind);
                  let toolError = false;
                  const execute = (context: InvocationContext) =>
                    Effect.suspend(() => {
                      toolError = false;
                      return runtime.call({
                        app: saved.app,
                        ...(workflows === undefined ? {} : { workflowControls: workflows(state) }),
                        build: state.deployment.build,
                        database: ownsDatabase(state.deployment.requirements),
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
                  const result = yield* executeRenewing(state, context, kind, execute);
                  if (Result.isFailure(result)) return yield* Effect.fail(result.failure);
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
                  Effect.catch(() =>
                    Effect.succeed({
                      status: "failed" as const,
                      requestId: input.requestId,
                      reason: "execution-failed" as const,
                    }),
                  ),
                );
              }),
            ),
          ),
        )
        .pipe(Effect.withSpan("sdk.tools.resume")),
  };
};
