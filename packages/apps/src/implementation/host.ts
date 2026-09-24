import { parseProviderError } from "./provider-error.ts";
import { OpenapiResponseError } from "../contracts/api-response-error.ts";
import { toPromise } from "./authoring.ts";
import type { WorkflowControls, WorkflowReads } from "../contracts/workflows.ts";
import {
  WorkflowFailure,
  WorkflowValue,
  HostedWorkflow,
  WorkflowReplay,
} from "../contracts/workflows.ts";
import { makeWorkflowContext, workflowSafe } from "./workflow-context.ts";
/** Framework-owned dispatch. Each inspect/call binds accounts and evaluates afresh. */
import { Cause, Effect, Match, Option, Redacted, Schema } from "effect";
import {
  captureTelemetry,
  invocationFetch,
  type InvocationTelemetry,
} from "@executor-js/telemetry";
import type { AccountSlots, BoundContext } from "../contracts/app.ts";
import {
  DeclaredProvider,
  DeclaredRequirements,
  ToolResultObservation,
  HostAccountsInvalid,
  HostDeclarationInvalid,
  HostOperationNotFound,
  HostOperationFailed,
  HostEvaluationFailed,
  HostInputInvalid,
  HostOutputInvalid,
  HostRequest,
  HostRequestInvalid,
  HostToolNotFound,
  HostToolBlocked,
  HostToolApprovalRequired,
  HostToolPolicyFailed,
  HostedTool,
  ResolvedAccounts,
  HostError,
  TrustedToolApproval,
  type AppHandler,
  type HostContext,
} from "../contracts/host.ts";
import { ManyAccounts, type AuthMethods, type Provider } from "../contracts/provider.ts";
import { JsonObject, JsonValue } from "../contracts/schema.ts";
import {
  approvalElicitation,
  ElicitationFailed,
  type ElicitationHandler,
} from "../contracts/elicitation.ts";
import { makeElicit } from "./elicitation.ts";
import { ApprovalDecision } from "../contracts/approval.ts";
import { importedJsonSchema } from "./schema.ts";
import { OperationToolPrefixes } from "../contracts/operations.ts";
import { dispatchWebhook } from "./webhooks.ts";
import { authorDatabase, unavailableStorage } from "./storage.ts";
import { isApp, toEffectApp } from "./app.ts";

function safe<A, E>(work: () => Effect.Effect<A, unknown>, failure: E): Effect.Effect<A, E> {
  return Effect.suspend(work).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.fail(failure),
    ),
  );
}

function jsonSchema(decoder: Schema.Decoder<unknown>) {
  const imported = importedJsonSchema(decoder);
  if (imported !== undefined) return Schema.decodeUnknownEffect(JsonObject)(imported);
  const document = Schema.toJsonSchemaDocument(decoder);
  return Schema.decodeUnknownEffect(JsonObject)({
    ...document.schema,
    $defs: document.definitions,
    $schema: "https://json-schema.org/draft/2020-12/schema",
  });
}

function providerDeclaration(provider: Provider<AuthMethods>) {
  return safe(
    () =>
      Effect.gen(function* () {
        const auth = new Map<string, unknown>();
        for (const [name, method] of Object.entries(provider.auth)) {
          switch (method._tag) {
            case "secrets":
              auth.set(name, {
                type: "secrets",
                label: method.label,
                fields: yield* jsonSchema(method.fields),
              });
              break;
            case "oauth2":
              auth.set(name, {
                type: "oauth2",
                ...method.config,
                response: yield* jsonSchema(method.response),
              });
              break;
          }
        }
        return yield* Schema.decodeUnknownEffect(DeclaredProvider)({
          name: provider.name,
          auth: Object.fromEntries(auth),
        });
      }),
    new HostDeclarationInvalid(),
  );
}

function requirements(slots: AccountSlots, database?: typeof DeclaredRequirements.Type.database) {
  return Effect.gen(function* () {
    const accounts = new Map<string, DeclaredRequirements["accounts"][string]>();
    for (const [slot, selection] of Object.entries(slots)) {
      accounts.set(slot, {
        cardinality: selection instanceof ManyAccounts ? "many" : "one",
        definition: yield* providerDeclaration(
          selection instanceof ManyAccounts ? selection.provider : selection,
        ),
      });
    }
    return yield* Schema.decodeUnknownEffect(DeclaredRequirements)({
      accounts: Object.fromEntries(accounts),
      ...(database === undefined ? {} : { database }),
    }).pipe(Effect.mapError(() => new HostDeclarationInvalid()));
  });
}

// Key order has no meaning in provider declarations; array order remains significant.
function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function bindAccounts(
  slots: AccountSlots,
  declarations: DeclaredRequirements,
  context: HostContext,
) {
  return safe(
    () =>
      Effect.gen(function* () {
        const selected = yield* Schema.decodeUnknownEffect(ResolvedAccounts)(
          Redacted.value(context.accounts),
        );
        if (Object.keys(selected).some((slot) => !Object.hasOwn(slots, slot))) {
          return yield* Effect.fail(new HostAccountsInvalid());
        }
        const bound = new Map<string, BoundContext<AccountSlots>["accounts"][string]>();
        for (const [slot, selection] of Object.entries(slots)) {
          const requirement = declarations.accounts[slot];
          const supplied = Object.hasOwn(selected, slot) ? selected[slot] : undefined;
          if (requirement === undefined || supplied === undefined)
            return yield* Effect.fail(new HostAccountsInvalid());
          const provider = selection instanceof ManyAccounts ? selection.provider : selection;
          const many = selection instanceof ManyAccounts;
          if (many !== Array.isArray(supplied))
            return yield* Effect.fail(new HostAccountsInvalid());
          const accounts = Array.isArray(supplied) ? supplied : [supplied];
          const ids = new Set<string>();
          const values = [];
          for (const account of accounts) {
            if (ids.has(account.id)) return yield* Effect.fail(new HostAccountsInvalid());
            ids.add(account.id);
            if (
              canonical(account.provider) !== canonical(requirement.definition) ||
              !Object.hasOwn(provider.auth, account.method)
            )
              return yield* Effect.fail(new HostAccountsInvalid());
            const method = provider.auth[account.method];
            if (method === undefined) return yield* Effect.fail(new HostAccountsInvalid());
            const fields = yield* Schema.decodeUnknownEffect(
              method._tag === "secrets" ? method.fields : method.response,
            )(account.fields);
            values.push({ id: account.id, method: account.method, fields });
          }
          if (many) bound.set(slot, values);
          else {
            const account = values[0];
            if (account === undefined) return yield* Effect.fail(new HostAccountsInvalid());
            bound.set(slot, account);
          }
        }
        return { accounts: Object.fromEntries(bound) };
      }),
    new HostAccountsInvalid(),
  );
}

function dispatch(
  app: unknown,
  request: HostRequest,
  context: HostContext,
  signal: AbortSignal,
): Effect.Effect<JsonValue, HostError> {
  return Effect.scoped(
    Effect.gen(function* () {
      if (!isApp(app)) return yield* Effect.fail(new HostDeclarationInvalid());
      const native = toEffectApp(app);
      const declared = yield* requirements(native.accounts, native.database?.schema);
      if (request.operation === "requirements")
        return yield* safe(
          () => Schema.decodeUnknownEffect(JsonValue)(declared),
          new HostDeclarationInvalid(),
        );
      const lifetime = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (controller) => Effect.sync(() => controller.abort()),
      );
      const invocationSignal = AbortSignal.any([signal, lifetime.signal]);
      let running: InvocationTelemetry | undefined;
      let transactionOpen = false;
      const delivery: ElicitationHandler = (request, signal) =>
        Effect.suspend(() =>
          transactionOpen
            ? Effect.fail(new ElicitationFailed({ reason: "transaction" }))
            : running !== undefined && context.elicitation !== undefined
              ? context
                  .elicitation(request, signal)
                  .pipe(
                    Effect.withSpan("app.tool.elicitation"),
                    Effect.provideContext(running.context),
                  )
              : Effect.fail(new ElicitationFailed({ reason: "unavailable" })),
        );
      const unavailableWorkflow = () =>
        Effect.fail(new WorkflowFailure({ reason: "unavailable", retryable: false }));
      const workflowControls: WorkflowControls = {
        start: toPromise(
          (input) =>
            context.workflowControls === undefined
              ? unavailableWorkflow()
              : context.workflowControls.start(input),
          invocationSignal,
        ),
        get: toPromise(
          (input) =>
            context.workflowControls === undefined
              ? unavailableWorkflow()
              : context.workflowControls.get(input),
          invocationSignal,
        ),
        list: toPromise(
          (input) =>
            context.workflowControls === undefined
              ? unavailableWorkflow()
              : context.workflowControls.list(input),
          invocationSignal,
        ),
        terminate: toPromise(
          (input) =>
            context.workflowControls === undefined
              ? unavailableWorkflow()
              : context.workflowControls.terminate(input),
          invocationSignal,
        ),
      };
      const workflowReads: WorkflowReads = {
        get: workflowControls.get,
        list: workflowControls.list,
      };
      const bound = {
        ...(yield* bindAccounts(native.accounts, declared, context).pipe(
          Effect.withSpan("app.accounts.bind"),
        )),
        workflows: workflowReads,
        signal: invocationSignal,
        fetch: yield* invocationFetch(invocationSignal),
        elicit: makeElicit(delivery, invocationSignal),
      };
      const definition = yield* native.evaluate(bound).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.interrupt;
          const provider = parseProviderError(Cause.squash(cause));
          return Effect.fail(Option.isSome(provider) ? provider.value : new HostEvaluationFailed());
        }),
        Effect.withSpan("app.evaluate"),
      );
      if (request.operation === "workflows") {
        return yield* Effect.forEach(Object.entries(definition.workflows ?? {}), ([name, entry]) =>
          safe(
            () =>
              Effect.gen(function* () {
                return yield* Schema.decodeUnknownEffect(HostedWorkflow)({
                  name,
                  ...(entry.description === undefined ? {} : { description: entry.description }),
                  inputSchema: yield* jsonSchema(entry.input),
                  ...(entry.output === undefined
                    ? {}
                    : { outputSchema: yield* jsonSchema(entry.output) }),
                });
              }),
            new HostDeclarationInvalid(),
          ),
        );
      }
      if (request.operation === "workflow-validate" || request.operation === "workflow-run") {
        const entry =
          definition.workflows !== undefined && Object.hasOwn(definition.workflows, request.name)
            ? definition.workflows[request.name]
            : undefined;
        if (entry === undefined)
          return yield* new WorkflowFailure({ reason: "not_found", retryable: false });
        const input = yield* safe(
          () => Schema.decodeUnknownEffect(entry.input)(request.input),
          new WorkflowFailure({ reason: "input", retryable: false }),
        );
        if (request.operation === "workflow-validate")
          return yield* safe(
            () => Schema.decodeUnknownEffect(WorkflowValue)(input),
            new WorkflowFailure({ reason: "input", retryable: false }),
          );
        const execution = context.workflow;
        if (execution === undefined)
          return yield* new WorkflowFailure({ reason: "unavailable", retryable: false });
        const workflowContext = yield* makeWorkflowContext(
          execution,
          definition,
          (stepId, signal) =>
            Effect.gen(function* () {
              const current = yield* execution.resolve();
              const accounts = yield* safe(
                () => bindAccounts(native.accounts, declared, current),
                new WorkflowFailure({ reason: "credentials", retryable: false }),
              );
              return {
                ...accounts,
                fetch: yield* invocationFetch(signal),
                signal,
                runId: execution.runId,
                stepId,
                idempotencyKey: stepId,
              };
            }),
          invocationSignal,
        );
        const output = yield* workflowSafe(entry.run(workflowContext, input));
        const outputSchema = entry.output;
        const decoded =
          outputSchema === undefined
            ? output
            : yield* safe(
                () => Schema.decodeUnknownEffect(outputSchema)(output),
                new WorkflowFailure({ reason: "output", retryable: false }),
              );
        return yield* safe(
          () => Schema.decodeUnknownEffect(WorkflowValue)(decoded),
          new WorkflowFailure({ reason: "output", retryable: false }),
        );
      }
      if (request.operation === "inspect") {
        const metadata: HostedTool[] = [];
        for (const [prefix, readOnly, catalog] of [
          [OperationToolPrefixes.query, true, definition.queries],
          [OperationToolPrefixes.mutate, false, definition.mutations],
        ] as const) {
          for (const [name, operation] of Object.entries(catalog ?? {})) {
            metadata.push(
              yield* safe(
                () =>
                  Effect.gen(function* () {
                    return yield* Schema.decodeUnknownEffect(HostedTool)({
                      name: `${prefix}${name}`,
                      schedules: Object.entries(definition.schedules ?? {})
                        .filter(([, schedule]) => schedule.tool === `${prefix}${name}`)
                        .map(([name, { tool: _tool, ...schedule }]) => ({ name, ...schedule })),
                      description:
                        operation.description ?? `${readOnly ? "Query" : "Mutate"} ${name}`,
                      ...(operation.title === undefined ? {} : { title: operation.title }),
                      inputSchema: yield* jsonSchema(operation.input),
                      ...(operation.output === undefined
                        ? operation.outputSchema === undefined
                          ? {}
                          : { outputSchema: operation.outputSchema }
                        : { outputSchema: yield* jsonSchema(operation.output) }),
                      readOnly,
                      annotations: { ...operation.annotations, readOnlyHint: readOnly },
                      ...(operation._meta === undefined ? {} : { _meta: operation._meta }),
                    });
                  }),
                new HostDeclarationInvalid(),
              ),
            );
          }
        }
        return metadata;
      }
      if (
        request.operation === "webhook-complete" ||
        request.operation === "webhook-validate" ||
        request.operation === "webhooks" ||
        request.operation === "webhook-register" ||
        request.operation === "webhook-handle" ||
        request.operation === "webhook-unregister"
      ) {
        const executeWebhook = (db?: import("@executor-js/app-data/contracts").DatabaseSession) =>
          dispatchWebhook(
            definition,
            request,
            {
              accounts: bound.accounts,
              workflows: workflowControls,
              signal: bound.signal,
              fetch: bound.fetch,
              ...(db === undefined || native.database === undefined
                ? {}
                : {
                    db: authorDatabase(native.database.tables, db, invocationSignal, true),
                  }),
            },
            Redacted.value(context.accounts),
          );
        if (
          native.database === undefined ||
          !["webhook-register", "webhook-handle", "webhook-unregister"].includes(request.operation)
        )
          return yield* executeWebhook();
        const storage = context.storage ?? unavailableStorage;
        return yield* storage.mutate(native.database.schema, executeWebhook).pipe(
          Effect.catchTags({
            AppDatabaseError: () => Effect.fail(new HostOperationFailed()),
            AppStorageUnavailable: () => Effect.fail(new HostOperationFailed()),
            AppStorageError: () => Effect.fail(new HostOperationFailed()),
          }),
        );
      }
      const kind =
        request.operation === "call"
          ? request.tool.startsWith(OperationToolPrefixes.query)
            ? "query"
            : request.tool.startsWith(OperationToolPrefixes.mutate)
              ? "mutate"
              : undefined
          : request.operation;
      if (kind === undefined) return yield* new HostToolNotFound();
      const name =
        request.operation === "call"
          ? request.tool.slice(OperationToolPrefixes[kind].length)
          : request.name;
      const toolName = `${OperationToolPrefixes[kind]}${name}`;
      const catalog = kind === "query" ? definition.queries : definition.mutations;
      const tool =
        catalog !== undefined && Object.hasOwn(catalog, name) ? catalog[name] : undefined;
      if (tool === undefined)
        return yield* request.operation === "call"
          ? new HostToolNotFound()
          : new HostOperationNotFound();
      const input = yield* safe(
        () => Schema.decodeUnknownEffect(tool.input)(request.input),
        new HostInputInvalid(),
      );
      if (context.approval !== undefined) {
        const approved = yield* safe(
          () => Schema.decodeUnknownEffect(TrustedToolApproval)(context.approval),
          new HostInputInvalid(),
        );
        const decoded = yield* safe(
          () => Schema.decodeUnknownEffect(JsonValue)(input),
          new HostInputInvalid(),
        );
        if (
          approved.tool !== toolName ||
          !Schema.toEquivalence(JsonValue)(approved.input, decoded)
        ) {
          return yield* new HostInputInvalid();
        }
      } else if (tool.approval !== undefined) {
        const approval = tool.approval;
        const decision = yield* safe(
          () =>
            approval({ toolName, toolInput: input, signal: invocationSignal }).pipe(
              Effect.withSpan("app.tool.approval", {
                attributes: { "executor.tool.name": toolName },
              }),
              Effect.flatMap(Schema.decodeUnknownEffect(ApprovalDecision)),
            ),
          new HostToolPolicyFailed(),
        );
        yield* Match.value(decision).pipe(
          Match.when("approved", () => Effect.void),
          Match.when("denied", () => Effect.fail(new HostToolBlocked())),
          Match.when("user-approval", () =>
            safe(() => Schema.decodeUnknownEffect(JsonValue)(input), new HostInputInvalid()).pipe(
              Effect.flatMap((input) =>
                Effect.fail(
                  new HostToolApprovalRequired({
                    input,
                    elicitation: approvalElicitation(toolName, input),
                  }),
                ),
              ),
            ),
          ),
          Match.exhaustive,
        );
      }
      const execute = (db?: import("@executor-js/app-data/contracts").DatabaseSession) =>
        Effect.gen(function* () {
          transactionOpen = db !== undefined;
          const output = yield* Effect.gen(function* () {
            running = yield* captureTelemetry;
            const fetch = yield* invocationFetch(invocationSignal);
            return yield* tool.run(
              {
                ...bound,
                fetch,
                workflows: kind === "mutate" ? workflowControls : workflowReads,
                ...(db === undefined || native.database === undefined
                  ? {}
                  : {
                      db: authorDatabase(
                        native.database.tables,
                        db,
                        invocationSignal,
                        kind === "mutate",
                      ),
                    }),
              },
              input,
            );
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                running = undefined;
              }),
            ),
            Effect.catchCause((cause) => {
              if (Cause.hasInterrupts(cause)) return Effect.interrupt;
              const error = Cause.squash(cause);
              const provider = parseProviderError(error);
              const response = Schema.decodeUnknownOption(OpenapiResponseError)(error);
              const failure = Schema.decodeUnknownOption(ElicitationFailed)(error);
              return Effect.fail(
                Option.isSome(provider)
                  ? provider.value
                  : Option.isSome(response)
                    ? new OpenapiResponseError({
                        code: response.value.code,
                        status: response.value.status,
                        message: response.value.message,
                      })
                    : Option.isSome(failure)
                      ? failure.value
                      : new HostOperationFailed(),
              );
            }),
            Effect.withSpan("app.operation.execute", {
              attributes: { "executor.tool.name": toolName, "executor.operation": kind },
            }),
          );
          const outputSchema = tool.output;
          const decoded =
            outputSchema === undefined
              ? output
              : yield* safe(
                  () => Schema.decodeUnknownEffect(outputSchema)(output),
                  new HostOutputInvalid(),
                );
          return yield* safe(
            () => Schema.decodeUnknownEffect(JsonValue)(decoded),
            new HostOutputInvalid(),
          );
        });
      const replay =
        context.replay === undefined
          ? undefined
          : yield* safe(
              () => Schema.decodeUnknownEffect(WorkflowReplay)(context.replay),
              new HostInputInvalid(),
            );
      if (replay !== undefined && kind !== "mutate") return yield* new HostInputInvalid();
      if (native.database === undefined) return yield* execute();
      const storage = context.storage ?? unavailableStorage;
      return yield* storage[kind === "query" ? "read" : "mutate"](native.database.schema, (db) =>
        replay === undefined
          ? execute(db)
          : db.once(replay.key, replay.fingerprint, () => execute(db)),
      ).pipe(
        Effect.catchTags({
          AppDatabaseError: () => Effect.fail(new HostOperationFailed()),
          AppStorageUnavailable: () => Effect.fail(new HostOperationFailed()),
          AppStorageError: () => Effect.fail(new HostOperationFailed()),
        }),
      );
    }),
  );
}

const errorStatus = Match.type<HostError>().pipe(
  Match.tagsExhaustive({
    ProviderError: () => 502,
    OpenapiResponseError: () => 502,
    WorkflowFailure: () => 422,
    HostRequestInvalid: () => 400,
    HostAccountsInvalid: () => 422,
    HostInputInvalid: () => 422,
    HostOperationNotFound: () => 404,
    HostToolNotFound: () => 404,
    HostToolBlocked: () => 403,
    HostToolApprovalRequired: () => 409,
    HostToolPolicyFailed: () => 500,
    HostOperationFailed: () => 500,
    HostDeclarationInvalid: () => 500,
    HostEvaluationFailed: () => 500,
    HostOutputInvalid: () => 500,
    ElicitationFailed: () => 422,
  }),
);

/** Construct a lazy native handler; requirements never evaluate the app factory. */
export const createAppHandler =
  (app: unknown): AppHandler =>
  (request, context) =>
    Effect.gen(function* () {
      if (request.method !== "POST") return yield* Effect.fail(new HostRequestInvalid());
      const input = yield* Effect.tryPromise({
        try: () => request.json(),
        catch: () => new HostRequestInvalid(),
      });
      const command = yield* Schema.decodeUnknownEffect(HostRequest)(input, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(() => new HostRequestInvalid()));
      yield* Effect.annotateCurrentSpan({
        "executor.operation": command.operation,
        ...(command.operation === "call" ? { "executor.tool.name": command.tool } : {}),
      });
      let toolError = false;
      const value = yield* dispatch(app, command, context, request.signal).pipe(
        Effect.provideService(ToolResultObservation, {
          failed: () => {
            toolError = true;
          },
        }),
        Effect.withSpan(`app.${command.operation}`),
      );
      if (toolError)
        yield* Effect.annotateCurrentSpan({
          "executor.outcome": "failed",
          "error.type": "McpToolError",
        });
      return Response.json({ ok: true, value, ...(toolError ? { toolError: true } : {}) });
    }).pipe(
      Effect.catch((error) =>
        Schema.encodeEffect(HostError)(error).pipe(
          Effect.map((encoded) =>
            Response.json({ ok: false, error: encoded }, { status: errorStatus(error) }),
          ),
          Effect.orDie,
        ),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logError(cause).pipe(
              Effect.as(
                Response.json(
                  { ok: false, error: { _tag: "HostDeclarationInvalid" } },
                  { status: 500 },
                ),
              ),
            ),
      ),
    );
