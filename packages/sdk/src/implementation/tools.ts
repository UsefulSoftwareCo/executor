import {
  ProviderError,
  SkillLoadFailed,
  type HostedTool,
  type HostedToolSummary,
} from "apps/contracts";
import { appProviderFailure } from "./provider-error.ts";
/** Snapshot the configured app, then execute with its selected credentials. */
import { type Crypto, Effect, Match, Redacted, Result, Schema } from "effect";
import type { AppDatabases } from "@executor-js/app-data";
import { bindAppStorage } from "./app-database.ts";
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
  RequestInvalid,
  StorageError,
  type AppId,
  type DeploymentId,
} from "../contracts/shared.ts";
import type { makeOAuth } from "./oauth.ts";
import {
  AppEvaluationFailed,
  InputInvalid,
  ToolCallFailed,
  ToolNotFound,
  ToolBlocked,
  ToolApprovalRequired,
  ToolPolicyFailed,
  ToolElicitationFailed,
  ToolInvocation,
  ToolInputs,
  type ToolInvocationOptions,
  type ToolResumeResult,
} from "../contracts/tools.ts";
import type { ExecutorDatabase } from "./storage.ts";
import { type Credentials, StoredApp, StoredDeployment } from "../contracts/storage.ts";
import { makeToolApprovals } from "./tool-approvals.ts";
import { storedDeployment } from "./apps.ts";
import { database, query, transaction, type Query } from "./database.ts";
import { storedProfile } from "./profiles.ts";
import { CurrentProfile, ProfileConflict } from "../contracts/profiles.ts";
import type { ProfileId } from "../contracts/shared.ts";
import { validateSelection } from "./selection.ts";

/** Resolve one consistent app/deployment/account selection before invoking authored code. */
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
  return transaction(db, (tx) =>
    Effect.gen(function* () {
      const row = yield* query(() =>
        tx.findFirst("apps", {
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
          ? yield* storedDeployment(tx, app, deploymentId)
          : row.deployment === null
            ? yield* new DeploymentNotFound({ app: app.id, deployment: deploymentId })
            : yield* Schema.decodeUnknownEffect(StoredDeployment)(row.deployment).pipe(
                Effect.mapError(() => new StorageError()),
              );
      const profile =
        input.profile === undefined
          ? undefined
          : yield* storedProfile(tx, {
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
      const validated = yield* validateSelection(tx, app.id, deployment.requirements, bindings);
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
    }),
  );
}

/** Resolve current credentials without holding a database transaction open. */
export function resolve(
  state: Effect.Success<ReturnType<typeof snapshot>>,
  resolveAccount: ReturnType<typeof makeOAuth>["resolve"],
  lifecycle?: ResourceLifecycle,
) {
  return Effect.gen(function* () {
    if (state.profile !== undefined && lifecycle?.profileResolving)
      yield* lifecycle.profileResolving(state.profile);
    const selections = new Map<string, ResolvedAccounts[string]>();
    for (const { slot, required, accounts } of state.selections) {
      const resolved = yield* Effect.forEach(accounts, (account) =>
        resolveAccount(account, required.definition).pipe(
          Effect.map((fields) => ({
            id: account.id,
            provider: required.definition,
            method: account.method,
            fields: Redacted.value(fields),
          })),
        ),
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

type Snapshot = Effect.Success<ReturnType<typeof snapshot>>;

function invocation(state: Snapshot, tool: ToolName, input: Json) {
  return Schema.decodeUnknownEffect(ToolInvocation)({
    app: state.app.id,
    owner: state.app.owner,
    ...(state.profile === undefined
      ? {}
      : { profile: state.profile.id, profileRevision: state.profile.revision }),
    deployment: state.deployment.id,
    tool,
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

/** Keep a skill loader's safe fields; every other evaluation failure stays generic. */
export const evaluationFailure = (
  identity: { app: AppId; deployment: DeploymentId },
  error: unknown,
  reason = "App evaluation failed",
) =>
  new AppEvaluationFailed({
    app: identity.app,
    deployment: identity.deployment,
    reason,
    ...(Schema.is(SkillLoadFailed)(error)
      ? {
          skills: {
            reason: error.reason,
            ...(error.message ? { message: error.message } : {}),
            ...(error.status === undefined ? {} : { status: error.status }),
          },
        }
      : {}),
  });

const runtimeFailure = (
  identity: { app: AppId; deployment: DeploymentId; tool: ToolName },
  state: Snapshot,
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
      HostOperationFailed: () =>
        new ToolCallFailed({ ...identity, reason: "Operation execution failed" }),
      HostInputInvalid: () =>
        new InputInvalid({ ...identity, problems: ["Input did not match the tool schema"] }),
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
      HostEvaluationFailed: () =>
        new AppEvaluationFailed({ ...identity, reason: "App evaluation failed" }),
      SkillLoadFailed: (error) => evaluationFailure(identity, error),
      RuntimeBuildUnavailable: () =>
        new AppEvaluationFailed({ ...identity, reason: "App evaluation failed" }),
      RuntimeProtocolFailed: () =>
        new AppEvaluationFailed({ ...identity, reason: "App evaluation failed" }),
    }),
  );

/** Reduce a full description from a build that cannot omit schemas itself. */
const summarize = ({
  inputSchema: _input,
  outputSchema: _output,
  _meta,
  ...summary
}: HostedTool): HostedToolSummary => summary;

/** Live calls return completion or a durable approval request. Resume trusts the supplied SDK decision. */
export const makeTools = (
  storage: ExecutorDatabase,
  resolveAccount: ReturnType<typeof makeOAuth>["resolve"],
  runtime: Runtime,
  credentials: Credentials,
  crypto: Crypto.Crypto,
  appStorage?: AppDatabases,
  workflows?: (
    app: AppId,
    state?: Effect.Success<ReturnType<typeof snapshot>>,
  ) => WorkflowHostControls,
  lifecycle?: ResourceLifecycle,
) => {
  const db = database(storage);
  const approvals = makeToolApprovals(db, credentials, crypto, storage.reactivity.inTransaction);
  /** Evaluate the selected profile's live catalog. */
  const evaluate = <A, R>(
    input: Parameters<Executor["tools"]["index"]>[0],
    read: (
      options: Parameters<typeof runtime.index>[0],
      /** Earlier builds reject index and filtered inspection; they only describe every tool. */
      toolIndex: boolean,
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
      const value = yield* read(
        {
          app: state.app.id,
          build: state.deployment.build,
          ...context,
          ...(workflows === undefined ? {} : { workflowControls: workflows(state.app.id, state) }),
        },
        state.deployment.requirements.capabilities?.toolIndex === true,
      ).pipe(
        Effect.mapError((error) =>
          Schema.is(ProviderError)(error)
            ? appProviderFailure(state, error)
            : evaluationFailure({ app: state.app.id, deployment: state.deployment.id }, error),
        ),
      );
      const catalog = {
        deployment: state.deployment.id,
        ...(state.profile === undefined
          ? {}
          : {
              profile: state.profile.id,
              profileRevision: state.profile.revision,
            }),
      };
      return { state, catalog, value };
    });
  return {
    list: (input: Parameters<Executor["tools"]["list"]>[0]) =>
      Effect.gen(function* () {
        const {
          state,
          catalog,
          value: tools,
        } = yield* evaluate(input, (options) => runtime.inspect(options));
        const sorted = [...tools]
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .filter((tool) => input.cursor === undefined || tool.name > input.cursor);
        const selected = sorted.slice(0, input.limit ?? 2_000);
        const last = selected.at(-1);
        return {
          ...catalog,
          items: selected.map((tool) => ({
            ...tool,
            app: state.app.id,
            deployment: state.deployment.id,
            name: ToolName.make(tool.name),
          })),
          ...(last !== undefined && sorted.length > selected.length
            ? { next: Cursor.make(last.name) }
            : {}),
        };
      }).pipe(Effect.withSpan("sdk.tools.list")),
    index: (input: Parameters<Executor["tools"]["index"]>[0]) =>
      Effect.gen(function* () {
        const {
          state,
          catalog,
          value: tools,
        } = yield* evaluate(input, (options, toolIndex) =>
          toolIndex
            ? runtime.index(options)
            : runtime
                .inspect(options)
                .pipe(Effect.map((tools) => tools.map((tool) => summarize(tool)))),
        );
        return {
          ...catalog,
          items: [...tools]
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
            .map((tool) => ({
              ...tool,
              app: state.app.id,
              deployment: state.deployment.id,
              name: ToolName.make(tool.name),
            })),
        };
      }).pipe(Effect.withSpan("sdk.tools.index")),
    get: (input: Parameters<Executor["tools"]["get"]>[0]) =>
      Effect.gen(function* () {
        const { state, value: tools } = yield* evaluate(input, (options, toolIndex) =>
          runtime.inspect(toolIndex ? { ...options, tools: [input.tool] } : options),
        );
        const tool = tools.find((tool) => tool.name === input.tool);
        if (tool === undefined)
          return yield* new ToolNotFound({
            app: state.app.id,
            deployment: state.deployment.id,
            tool: input.tool,
          });
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
          "executor.tool.name": parsed.tool,
        });
        let toolError = false;
        const result = yield* runtime
          .call({
            app: state.app.id,
            ...(yield* bindAppStorage(appStorage, state.app.id)),
            ...(workflows === undefined
              ? {}
              : { workflowControls: workflows(state.app.id, state) }),
            build: state.deployment.build,
            database: state.deployment.requirements.database !== undefined,
            ...context,
            tool: parsed.tool,
            input: args,
            ...(options?.elicitation === undefined ? {} : { elicitation: options.elicitation }),
          })
          .pipe(
            Effect.provideService(ToolResultObservation, {
              failed: () => {
                toolError = true;
              },
            }),
            Effect.result,
          );
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
            yield* invocation(state, parsed.tool, result.failure.input),
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
                    invocation(state, saved.tool, saved.input).pipe(
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
                return yield* Effect.gen(function* () {
                  yield* Effect.annotateCurrentSpan({
                    "executor.app.id": saved.app,
                    "executor.deployment.id": saved.deployment,
                    "executor.build.id": checked.success.state.deployment.build,
                    "executor.tool.name": saved.tool,
                    "executor.approval.id": input.requestId,
                  });
                  const context = yield* resolve(
                    checked.success.state,
                    resolveAccount,
                    lifecycle,
                  ).pipe(Effect.withSpan("sdk.accounts.resolve"));
                  let toolError = false;
                  const value = yield* runtime
                    .call({
                      app: saved.app,
                      ...(yield* bindAppStorage(appStorage, saved.app)),
                      ...(workflows === undefined
                        ? {}
                        : { workflowControls: workflows(saved.app) }),
                      build: checked.success.state.deployment.build,
                      database:
                        checked.success.state.deployment.requirements.database !== undefined,
                      ...context,
                      tool: saved.tool,
                      input: originalInput,
                      approval: { tool: saved.tool, input: saved.input },
                      ...(options?.elicitation === undefined
                        ? {}
                        : { elicitation: options.elicitation }),
                    })
                    .pipe(
                      Effect.provideService(ToolResultObservation, {
                        failed: () => {
                          toolError = true;
                        },
                      }),
                    );
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
