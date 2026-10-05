import { folderSkillsEffect } from "./skill-files.ts";
import { AppSkills, SkillFile, SkillLoadFailed } from "../contracts/skills.ts";
import { accountProviderError, httpProviderError, parseProviderError } from "./provider-error.ts";
import { ResponseStatusError } from "../contracts/http.ts";
import { McpError } from "../contracts/mcp.ts";
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
import { Cause, Clock, Effect, Match, Option, Redacted, Schema } from "effect";
import {
  captureTelemetry,
  invocationFetch,
  type InvocationTelemetry,
} from "@executor-js/telemetry";
import type { AccountSlots, BoundContext } from "../contracts/app.ts";
import {
  DeclaredProvider,
  DeclaredRequirements,
  InvocationDeadline,
  ToolResultObservation,
  HostAccountsInvalid,
  HostDeclarationInvalid,
  HostOperationNotFound,
  HostKindMismatch,
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
  HostedRouter,
  HostedTool,
  HostedToolSummary,
  ResolvedAccounts,
  HostError,
  TrustedToolApproval,
  type AppHandler,
  type HostContext,
} from "../contracts/host.ts";
import {
  AccountCheckResult,
  ManyAccounts,
  type AuthMethods,
  type FieldExposure,
  type Provider,
} from "../contracts/provider.ts";
import { JsonValue } from "../contracts/schema.ts";
import {
  approvalElicitation,
  ElicitationFailed,
  type ElicitationHandler,
} from "../contracts/elicitation.ts";
import { makeElicit } from "./elicitation.ts";
import { inputInvalid } from "./input-problems.ts";
import { ApprovalDecision } from "../contracts/approval.ts";
import { jsonSchemaDocument } from "./schema.ts";
import { locate } from "./router.ts";
import { readCatalog, routerSkills } from "./router-catalog.ts";
import { dispatchWebhook } from "./webhooks.ts";
import { authorDatabase, unavailableStorage } from "./storage.ts";
import { parseDatabaseSchema } from "@executor-js/app-data/schema";
import { isApp, toEffectApp } from "./app.ts";
import { authorCache, unavailableCache } from "./cache.ts";
import type { HostCache } from "../contracts/cache.ts";
import {
  accountSecrets,
  boundFailureMessage,
  describeFailure,
  failureDetail,
} from "./failure-detail.ts";

/** Either catalog detail on the wire; summaries are descriptions without schemas. */
const WireCatalog = Schema.Struct({
  tools: Schema.Array(Schema.Union([HostedTool, HostedToolSummary])),
  routers: Schema.Array(HostedRouter),
});

function safe<A, E>(work: () => Effect.Effect<A, unknown>, failure: E): Effect.Effect<A, E> {
  return Effect.suspend(work).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.fail(failure),
    ),
  );
}

const evaluationSafe = <A>(work: Effect.Effect<A, unknown>, secrets: readonly string[]) =>
  work.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.interrupt;
      const error = Cause.squash(cause);
      const provider = parseProviderError(error);
      const skills = parseSkillLoadFailed(error);
      // An MCP server that cannot be reached is not an invalid app definition; keep its safe fields.
      const mcp = parseMcpError(error);
      return Effect.fail(
        Option.isSome(provider)
          ? provider.value
          : Option.isSome(skills)
            ? skills.value
            : Option.isSome(mcp)
              ? mcp.value
              : new HostEvaluationFailed(failureDetail(error, secrets)),
      );
    }),
  );

/** Name what the app declared wrongly; declarations bind no accounts. */
const declarationInvalid = (summary: string, cause?: unknown, secrets: readonly string[] = []) =>
  new HostDeclarationInvalid({
    source: "app",
    errorName: "HostDeclarationInvalid",
    message: boundFailureMessage(
      cause === undefined ? summary : `${summary}: ${describeFailure(cause)}`,
      secrets,
    ),
  });

/** Like `safe`, keeping the underlying failure in a declaration error. */
const declarationSafe = <A>(work: () => Effect.Effect<A, unknown>, summary: string) =>
  Effect.suspend(work).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.fail(declarationInvalid(summary, Cause.squash(cause))),
    ),
  );

/** Marked field names, sorted; unmarked providers declare nothing, keeping their identity. */
function declaredExposure(exposure: Readonly<Record<string, FieldExposure>> | undefined) {
  const named = (kind: FieldExposure) =>
    Object.entries(exposure ?? {})
      .filter(([, value]) => value === kind)
      .map(([field]) => field)
      .sort();
  const plain = named("plain");
  const raw = named("raw");
  return { ...(plain.length === 0 ? {} : { plain }), ...(raw.length === 0 ? {} : { raw }) };
}

function providerDeclaration(provider: Provider<AuthMethods>) {
  return declarationSafe(
    () =>
      Effect.gen(function* () {
        const auth = new Map<string, unknown>();
        for (const [name, method] of Object.entries(provider.auth)) {
          switch (method._tag) {
            case "secrets":
              auth.set(name, {
                type: "secrets",
                label: method.label,
                fields: yield* jsonSchemaDocument(method.fields),
                ...declaredExposure(method.exposure),
              });
              break;
            case "oauth2":
              auth.set(name, {
                type: "oauth2",
                ...method.config,
                response: yield* jsonSchemaDocument(method.response),
                ...declaredExposure(method.exposure),
              });
              break;
          }
        }
        return yield* Schema.decodeUnknownEffect(DeclaredProvider)({
          name: provider.name,
          auth: Object.fromEntries(auth),
          // Order and repetition carry no meaning, so neither changes the provider's identity.
          ...(provider.hosts === undefined ? {} : { hosts: [...new Set(provider.hosts)].sort() }),
        });
      }),
    `Account provider "${provider.name}" has an invalid declaration`,
  );
}

function requirements(slots: AccountSlots, database?: typeof DeclaredRequirements.Type.database) {
  return Effect.gen(function* () {
    const accounts = new Map<string, DeclaredRequirements["accounts"][string]>();
    for (const [slot, selection] of Object.entries(slots)) {
      const provider = selection instanceof ManyAccounts ? selection.provider : selection;
      accounts.set(slot, {
        cardinality: selection instanceof ManyAccounts ? "many" : "one",
        definition: yield* providerDeclaration(provider),
        ...(provider.health === undefined ? {} : { health: true }),
      });
    }
    return yield* Schema.decodeUnknownEffect(DeclaredRequirements)({
      accounts: Object.fromEntries(accounts),
      capabilities: { skills: true, toolIndex: true, skillSources: true, scheduledTools: true },
      ...(database === undefined ? {} : { database }),
    }).pipe(
      Effect.mapError((cause) =>
        declarationInvalid("The app's account or database declarations are invalid", cause),
      ),
    );
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

/**
 * A provider without its hosts. The host sends each account's granted hosts, which can be narrower
 * than the app's declaration, so they are not part of matching an account to its slot.
 */
function withoutHosts({ hosts: _hosts, ...provider }: DeclaredProvider): JsonValue {
  return provider;
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
              canonical(withoutHosts(account.provider)) !==
                canonical(withoutHosts(requirement.definition)) ||
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

/**
 * The lifetime of an invocation's `ctx.fetch`: the invocation, then every app cache refresh it
 * handed to the host's background runner. Those refreshes outlive the reply, and loaders such as
 * remote skill and tool catalogs fetch with the author's `ctx.fetch`. The host ends them by draining
 * or cancelling its cache session. The signal aborts once the invocation has ended, by `signal` or
 * by its scope closing, and no refresh it started is still running.
 */
const fetchLifetime = (signal: AbortSignal, background: HostCache["background"]) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const controller = new AbortController();
      let refreshes = 0;
      let ended = false;
      const settle = () => {
        if (ended && refreshes === 0) controller.abort();
      };
      const end = () => {
        ended = true;
        settle();
      };
      signal.addEventListener("abort", end, { once: true });
      if (signal.aborted) end();
      const settled = Effect.sync(() => {
        refreshes -= 1;
        settle();
      });
      return {
        signal: controller.signal,
        close: () => {
          signal.removeEventListener("abort", end);
          end();
        },
        /** Counted from the hand-off, so a refresh that has not started yet keeps the fetch. */
        background: (task: Effect.Effect<void, unknown>) =>
          Effect.suspend(() => {
            refreshes += 1;
            return background(task.pipe(Effect.ensuring(settled))).pipe(
              Effect.onError(() => settled),
            );
          }),
      };
    }),
    (lifetime) => Effect.sync(lifetime.close),
  );

function dispatch(
  app: unknown,
  request: HostRequest,
  context: HostContext,
  signal: AbortSignal,
): Effect.Effect<JsonValue, HostError> {
  return Effect.scoped(
    Effect.gen(function* () {
      if (!isApp(app))
        return yield* Effect.fail(
          declarationInvalid("The app module's default export is not an app created by defineApp"),
        );
      const native = toEffectApp(app);
      const secrets = accountSecrets(context.accounts);
      const storageFailure = (error: unknown) =>
        Effect.fail(new HostOperationFailed(failureDetail(error, secrets)));
      const declared = yield* requirements(native.accounts, native.database?.schema);
      if (request.operation === "requirements") {
        if (native.database !== undefined)
          yield* parseDatabaseSchema(native.database.schema).pipe(
            Effect.catchTag("AppDatabaseError", (cause) =>
              Effect.fail(
                declarationInvalid("The app's account or database declarations are invalid", cause),
              ),
            ),
          );
        return yield* safe(
          () => Schema.decodeUnknownEffect(JsonValue)(declared),
          new HostDeclarationInvalid(),
        );
      }
      const lifetime = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (controller) => Effect.sync(() => controller.abort()),
      );
      const invocationSignal = AbortSignal.any([signal, lifetime.signal]);
      const deadline =
        context.deadline === undefined
          ? undefined
          : yield* safe(
              () => Schema.decodeUnknownEffect(InvocationDeadline)(context.deadline),
              new HostInputInvalid(),
            );
      const withinDeadline = <A, E>(work: Effect.Effect<A, E>) =>
        Effect.gen(function* () {
          if (deadline === undefined) return yield* work;
          const remaining = deadline - (yield* Clock.currentTimeMillis);
          if (remaining <= 0)
            return yield* new WorkflowFailure({ reason: "engine", retryable: true });
          const result = yield* work.pipe(
            Effect.timeout(remaining),
            Effect.catchTag("TimeoutError", () =>
              Effect.fail(new WorkflowFailure({ reason: "engine", retryable: true })),
            ),
          );
          // Also reject a body that blocked the event loop past its deadline before
          // the timer could run. This check remains inside the owning transaction.
          if ((yield* Clock.currentTimeMillis) >= deadline)
            return yield* new WorkflowFailure({ reason: "engine", retryable: true });
          return result;
        });
      if (request.operation === "account-check")
        return yield* checkAccount(
          native.accounts,
          declared,
          request.requirement,
          context,
          invocationSignal,
        ).pipe(withinDeadline);
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
      const files = yield* Schema.decodeUnknownEffect(Schema.Array(SkillFile))(
        context.files ?? [],
      ).pipe(Effect.mapError(() => new HostDeclarationInvalid()));
      // Counts cache commands, so a skill read can tell whether its loader used the app cache.
      let cacheCommands = 0;
      const hostCache = context.cache ?? unavailableCache;
      const fetching = yield* fetchLifetime(signal, hostCache.background);
      const bound = {
        cache: authorCache(
          {
            ...hostCache,
            transport: (command) => {
              cacheCommands += 1;
              return hostCache.transport(command);
            },
            background: fetching.background,
          },
          Redacted.value(context.accounts),
          invocationSignal,
          deadline,
        ),
        files,
        ...(yield* bindAccounts(native.accounts, declared, context).pipe(
          Effect.withSpan("app.accounts.bind"),
        )),
        workflows: workflowReads,
        signal: invocationSignal,
        fetch: yield* invocationFetch(fetching.signal),
        elicit: makeElicit(delivery, invocationSignal),
      };
      const definition = yield* evaluationSafe(native.evaluate(bound), secrets).pipe(
        Effect.withSpan("app.evaluate"),
      );
      if (request.operation === "skills") {
        const declared =
          definition.skills ??
          (yield* folderSkillsEffect({ files }).pipe(
            Effect.mapError(() => new HostDeclarationInvalid()),
          ));
        // Dynamic skills fail like evaluation and join the static catalog. Other operations never
        // call them. A repeated authored name fails the catalog check below.
        const source = definition.dynamicSkills;
        const before = cacheCommands;
        const dynamic =
          source === undefined
            ? []
            : yield* evaluationSafe(Effect.suspend(source.list), secrets).pipe(
                Effect.withSpan("app.skills.load"),
              );
        const cached = source !== undefined && cacheCommands > before;
        // Router skills never fail the read. An authored skill with a router skill's name
        // replaces that router's generated skill.
        const authored = new Set([...declared, ...dynamic].map((skill) => skill.name));
        const routed = (yield* routerSkills(definition.tools).pipe(
          Effect.withSpan("app.skills.routers"),
        )).filter((skill) => !authored.has(skill.name));
        const skills = yield* Schema.decodeUnknownEffect(AppSkills)([
          ...declared,
          ...dynamic,
          ...routed,
        ]).pipe(Effect.mapError(() => new HostDeclarationInvalid()));
        return request.sources === true
          ? { skills, dynamic: source !== undefined, cached }
          : skills;
      }
      if (request.operation === "workflows") {
        return yield* Effect.forEach(Object.entries(definition.workflows ?? {}), ([name, entry]) =>
          safe(
            () =>
              Effect.gen(function* () {
                return yield* Schema.decodeUnknownEffect(HostedWorkflow)({
                  name,
                  ...(entry.description === undefined ? {} : { description: entry.description }),
                  inputSchema: yield* jsonSchemaDocument(entry.input),
                  ...(entry.output === undefined
                    ? {}
                    : { outputSchema: yield* jsonSchemaDocument(entry.output) }),
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
                context: {
                  ...accounts,
                  cache: authorCache(
                    context.cache ?? unavailableCache,
                    Redacted.value(current.accounts),
                    signal,
                  ),
                  files,
                  fetch: yield* invocationFetch(signal),
                  signal,
                  runId: execution.runId,
                  stepId,
                  idempotencyKey: stepId,
                },
                // The resolved values, not the app's decoded fields, which may be `Redacted`.
                secrets: accountSecrets(current.accounts),
              };
            }),
          invocationSignal,
        );
        const output = yield* workflowSafe(entry.run(workflowContext, input), secrets);
        const outputSchema = entry.output;
        const decoded =
          outputSchema === undefined
            ? output
            : yield* safe(
                () => Schema.decodeUnknownEffect(outputSchema)(output),
                new WorkflowFailure({
                  reason: "output",
                  retryable: false,
                  message: "The workflow's result does not match its declared output schema.",
                }),
              );
        return yield* safe(
          () => Schema.decodeUnknownEffect(WorkflowValue)(decoded),
          new WorkflowFailure({
            reason: "output",
            retryable: false,
            message:
              "The workflow returned a value that is not JSON, such as undefined, or is larger than 1 MiB. Return null for no result.",
          }),
        );
      }
      if (request.operation === "inspect") {
        const summary = request.detail === "summary";
        const catalog = yield* readCatalog(definition.tools, {
          summary,
          secrets,
          ...(request.tools === undefined ? {} : { wanted: new Set(request.tools) }),
          ...(request.scheduled === true ? { scheduled: true } : {}),
          schedules: (name) =>
            Object.entries(definition.schedules ?? {})
              .filter(([, schedule]) => schedule.tool === name)
              .map(([name, { tool: _tool, ...schedule }]) => ({ name, ...schedule })),
        }).pipe(Effect.withSpan("app.catalog.read"));
        // Router errors are tagged classes; encoding keeps only their serialized safe fields.
        return yield* safe(
          () =>
            Schema.encodeEffect(WireCatalog)(catalog).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(JsonValue)),
            ),
          new HostDeclarationInvalid(),
        );
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
              files,
              cache: bound.cache,
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
            AppDatabaseError: storageFailure,
            DatabaseLimitExceeded: (error) => Effect.fail(error),
            AppStorageUnavailable: storageFailure,
            AppStorageError: storageFailure,
          }),
        );
      }
      const toolName = request.operation === "call" ? request.tool : request.name;
      const location = locate(definition.tools, toolName);
      const tool =
        location === undefined
          ? undefined
          : location.kind === "operation"
            ? location.operation
            : yield* evaluationSafe(location.source.resolve(location.name), secrets);
      if (tool === undefined)
        return yield* request.operation === "call"
          ? new HostToolNotFound()
          : new HostOperationNotFound();
      const requested =
        request.operation === "call"
          ? request.kind
          : request.operation === "query"
            ? "query"
            : "mutation";
      // The caller's kind chooses storage and the Cloudflare write mode before this runs. A call
      // without one is to a tool the host's catalog does not list; it runs with its own kind.
      if (requested !== undefined && tool.kind !== requested)
        return yield* new HostKindMismatch({ tool: toolName, requested, actual: tool.kind });
      const kind = tool.kind === "query" ? "query" : "mutate";
      const input = yield* Effect.suspend(() =>
        Schema.decodeUnknownEffect(tool.input)(request.input),
      ).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.fail(inputInvalid(Cause.squash(cause))),
        ),
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
            const fetch = yield* invocationFetch(fetching.signal);
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
                        ...(response.value.recovery === undefined
                          ? {}
                          : { recovery: response.value.recovery }),
                      })
                    : Option.isSome(failure)
                      ? failure.value
                      : new HostOperationFailed(failureDetail(error, secrets)),
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
      if (native.database === undefined) return yield* withinDeadline(execute());
      const storage = context.storage ?? unavailableStorage;
      return yield* storage[kind === "query" ? "read" : "mutate"](native.database.schema, (db) =>
        withinDeadline(
          replay === undefined
            ? execute(db)
            : db.once(replay.key, replay.fingerprint, () => execute(db)),
        ),
      ).pipe(
        Effect.catchTags({
          AppDatabaseError: storageFailure,
          DatabaseLimitExceeded: (error) => Effect.fail(error),
          AppStorageUnavailable: storageFailure,
          AppStorageError: storageFailure,
        }),
      );
    }),
  );
}

/**
 * Run one slot's provider check against the single account the host supplied, without evaluating
 * the app. Failures are attributed to that account. HTTP status failures from `decodeJson` are
 * classified like other provider responses; anything else means the check
 * could not verify it, and carries the app's own error message with account secrets replaced.
 */
function checkAccount(
  slots: AccountSlots,
  declared: DeclaredRequirements,
  requirement: string,
  context: HostContext,
  signal: AbortSignal,
) {
  return Effect.gen(function* () {
    const selection = Object.hasOwn(slots, requirement) ? slots[requirement] : undefined;
    const slot = Object.hasOwn(declared.accounts, requirement)
      ? declared.accounts[requirement]
      : undefined;
    if (selection === undefined || slot === undefined) return yield* new HostAccountsInvalid();
    const provider = selection instanceof ManyAccounts ? selection.provider : selection;
    const health = provider.health;
    if (health === undefined) return yield* new HostOperationNotFound();
    const { accounts } = yield* bindAccounts(
      { [requirement]: provider },
      { accounts: { [requirement]: { ...slot, cardinality: "one" } } },
      context,
    ).pipe(Effect.withSpan("app.accounts.bind"));
    const account = accounts[requirement];
    if (account === undefined || !("id" in account)) return yield* new HostAccountsInvalid();
    const result = yield* Effect.suspend(() =>
      Effect.gen(function* () {
        return yield* health.run({ account, fetch: yield* invocationFetch(signal), signal });
      }),
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterrupts(cause)) return Effect.interrupt;
        const error = Cause.squash(cause);
        const status = Schema.decodeUnknownOption(ResponseStatusError)(error);
        const classified = Option.isSome(status)
          ? Option.fromNullishOr(httpProviderError(status.value.status))
          : parseProviderError(error);
        return Effect.fail(
          Option.isSome(classified)
            ? accountProviderError(classified.value, account.id)
            : new HostOperationFailed(failureDetail(error, accountSecrets(context.accounts))),
        );
      }),
      Effect.withSpan("app.account.check"),
    );
    return yield* safe(
      () =>
        Schema.decodeUnknownEffect(AccountCheckResult)(result ?? {}).pipe(
          Effect.flatMap(Schema.encodeEffect(AccountCheckResult)),
          Effect.flatMap(Schema.decodeUnknownEffect(JsonValue)),
        ),
      new HostOutputInvalid(),
    );
  });
}

/** Rebuild only the allowlisted skill loader fields from an author-visible rejection. */
const parseSkillLoadFailed = (error: unknown): Option.Option<SkillLoadFailed> =>
  Schema.decodeUnknownOption(SkillLoadFailed)(error).pipe(
    Option.map(
      ({ reason, message, status }) =>
        new SkillLoadFailed({
          reason,
          ...(message ? { message } : {}),
          ...(status === undefined ? {} : { status }),
        }),
    ),
  );

const parseMcpError = (error: unknown): Option.Option<McpError> =>
  Schema.decodeUnknownOption(McpError)(error).pipe(
    Option.map(
      ({ phase, reason, status, initialized, fallback }) =>
        new McpError({
          phase,
          reason,
          ...(status === undefined ? {} : { status }),
          ...(initialized === undefined ? {} : { initialized }),
          ...(fallback === undefined ? {} : { fallback }),
        }),
    ),
  );

const errorStatus = Match.type<HostError>().pipe(
  Match.tagsExhaustive({
    ProviderError: () => 502,
    McpError: () => 502,
    SkillLoadFailed: () => 502,
    OpenapiResponseError: () => 502,
    WorkflowFailure: () => 422,
    HostRequestInvalid: () => 400,
    HostAccountsInvalid: () => 422,
    HostInputInvalid: () => 422,
    HostOperationNotFound: () => 404,
    HostKindMismatch: () => 409,
    HostToolNotFound: () => 404,
    HostToolBlocked: () => 403,
    HostToolApprovalRequired: () => 409,
    HostToolPolicyFailed: () => 500,
    HostOperationFailed: () => 500,
    DatabaseLimitExceeded: () => 422,
    DatabaseFieldReserved: () => 422,
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
        // Name what failed on the span; the bounded message stays in the reply only.
        Effect.tapError((error) =>
          (error._tag === "HostEvaluationFailed" ||
            error._tag === "HostOperationFailed" ||
            error._tag === "HostDeclarationInvalid") &&
          error.errorName !== undefined
            ? Effect.annotateCurrentSpan({
                "error.type": error.errorName,
                ...(error.source === undefined ? {} : { "executor.failure.source": error.source }),
                ...(error.code === undefined ? {} : { "executor.failure.code": error.code }),
              })
            : Effect.void,
        ),
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
              Effect.andThen(
                Schema.encodeEffect(HostError)(
                  declarationInvalid(
                    "The app failed while it was loaded",
                    Cause.squash(cause),
                    accountSecrets(context.accounts),
                  ),
                ),
              ),
              Effect.map((error) => Response.json({ ok: false, error }, { status: 500 })),
              Effect.orDie,
            ),
      ),
    );
