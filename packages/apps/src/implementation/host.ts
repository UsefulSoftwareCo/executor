import { accountCheckOutput } from "./account-status-output.ts";
import { folderSkillsEffect } from "./skill-files.ts";
import { AppSkills, SkillFile } from "../contracts/skills.ts";
import { parseProviderError } from "./provider-error.ts";
import { classifyAccountCheck } from "./account-check-errors.ts";
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
import { dispatchConnect } from "./connect.ts";

/** Framework-owned dispatch. Each inspect/call binds accounts and evaluates afresh. */
import { Cause, Clock, Effect, Match, Option, Redacted, Schema } from "effect";
import { captureTelemetry, owned, type InvocationTelemetry } from "@executor-js/telemetry";
import { appInvocationFetch } from "./network.ts";
import type { AccountSlots, BoundAccounts, ScopedSlots } from "../contracts/app.ts";
import type { AppIcons } from "../contracts/icons.ts";
import {
  DeclaredProvider,
  DeclaredRequirements,
  type DeclaredAccountSlots,
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
  HostedSharedCatalog,
  HostedTool,
  HostedToolSummary,
  ResolvedAccounts,
  type ResolvedAccountSlots,
  HostError,
  TrustedToolApproval,
  type AppHandler,
  type HostContext,
} from "../contracts/host.ts";
import {
  ManyAccounts,
  type AuthMethods,
  type FieldExposure,
  type Provider,
} from "../contracts/provider.ts";
import { JsonValue } from "../contracts/schema.ts";
import { normalizePlacements, type Placement } from "../contracts/placement.ts";
import { withPlacements } from "./placement.ts";
import {
  approvalElicitation,
  ElicitationFailed,
  type ElicitationHandler,
} from "../contracts/elicitation.ts";
import { makeElicit } from "./elicitation.ts";
import { timedInvocation, workflowControlSpan } from "./invocation-timing.ts";
import { inputInvalid } from "./input-problems.ts";
import { ApprovalDecision } from "../contracts/approval.ts";
import { jsonSchemaDocument } from "./schema.ts";
import { locate } from "./router.ts";
import { readCatalog, routerSkills } from "./router-catalog.ts";
import { shareCatalog } from "../contracts/shared-catalog.ts";
import { dispatchWebhook } from "./webhooks.ts";
import { declaredEvents, makeEmitter } from "./events.ts";
import type { AppEvent, EmittedEvent } from "../contracts/events.ts";
import { authorSql, hasMigrations, migrate, noDatabase, type StepReplay } from "./sql.ts";
import { isApp, toEffectApp } from "./app.ts";
import { authorCache, unavailableCache } from "./cache.ts";
import type { HostCache } from "../contracts/cache.ts";
import {
  accountSecrets,
  boundFailureMessage,
  describeFailure,
  failureDetail,
  leavingProviderError,
  parseMcpError,
  parseSkillLoadFailed,
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
      const mcp = parseMcpError(error, secrets);
      return Effect.fail(
        Option.isSome(provider)
          ? leavingProviderError(provider.value, secrets, "discover")
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

/** Placements in a stable order; a method without them declares nothing, keeping its identity. */
function declaredPlacements(request: readonly Placement[] | undefined) {
  return request === undefined || request.length === 0
    ? {}
    : { request: normalizePlacements(request) };
}

function providerDeclaration(provider: Provider<AuthMethods>) {
  return declarationSafe(
    () =>
      Effect.gen(function* () {
        const auth = new Map<string, unknown>();
        for (const [name, method] of Object.entries(provider.auth)) {
          switch (method._tag) {
            case "interactive":
              auth.set(name, { type: "interactive", label: method.label, plain: ["ref"] });
              break;
            case "secrets":
              auth.set(name, {
                type: "secrets",
                ...(method.provisioned === true ? { provisioned: true } : {}),
                label: method.label,
                fields: yield* jsonSchemaDocument(method.fields),
                ...declaredExposure(method.exposure),
                ...declaredPlacements(method.request),
              });
              break;
            case "oauth2":
              auth.set(name, {
                type: "oauth2",
                ...method.config,
                response: yield* jsonSchemaDocument(method.response),
                ...declaredExposure(method.exposure),
                ...declaredPlacements(method.request),
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

function declaredSlots(slots: AccountSlots, checks: readonly string[] | undefined) {
  return Effect.gen(function* () {
    const accounts = new Map<string, DeclaredAccountSlots[string]>();
    for (const [slot, selection] of Object.entries(slots)) {
      const provider = selection instanceof ManyAccounts ? selection.provider : selection;
      const hostAcquisition = Object.entries(provider.auth)
        .filter(([, method]) => method._tag === "interactive" && method.acquisition === "host")
        .map(([method]) => method)
        .sort();
      accounts.set(slot, {
        cardinality: selection instanceof ManyAccounts ? "many" : "one",
        definition: yield* providerDeclaration(provider),
        ...(provider.health === undefined ? {} : { health: true }),
        ...(hostAcquisition.length === 0 ? {} : { hostAcquisition }),
        ...((checks?.includes(slot) ??
        Object.values(provider.auth).some(
          (method) => method._tag === "interactive" && method.acquisition !== "host",
        ))
          ? { interactiveHealth: true }
          : {}),
      });
    }
    return Object.fromEntries(accounts);
  });
}

function requirements(
  slots: ScopedSlots,
  sql: boolean,
  events: Readonly<Record<string, AppEvent>> | undefined,
  icons: AppIcons | undefined,
  checks: readonly string[] | undefined,
) {
  return Effect.gen(function* () {
    return yield* Schema.decodeUnknownEffect(DeclaredRequirements)({
      accounts: {
        app: yield* declaredSlots(slots.app, checks),
        user: yield* declaredSlots(slots.user, checks),
      },
      capabilities: {
        skills: true,
        toolIndex: true,
        skillSources: true,
        scheduledTools: true,
        sharedDefinitions: true,
      },
      ...(sql ? { sql: true } : {}),
      ...(events === undefined || Object.keys(events).length === 0
        ? {}
        : {
            events: yield* declarationSafe(
              () => declaredEvents(events),
              "The app's event declarations are invalid",
            ),
          }),
      ...(icons === undefined ? {} : { icons }),
    }).pipe(
      Effect.mapError((cause) =>
        declarationInvalid("The app's account declarations are invalid", cause),
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
 * A provider without its hosts and placements. The host sends each account's granted hosts and
 * placements, which can differ from the app's declaration, so they are not part of matching an
 * account to its slot.
 */
function withoutGrants({ hosts: _hosts, ...provider }: DeclaredProvider): JsonValue {
  return {
    ...provider,
    auth: Object.fromEntries(
      Object.entries(provider.auth).map(([name, { request: _request, ...method }]) => [
        name,
        method,
      ]),
    ),
  };
}

type BoundSlots = BoundAccounts<AccountSlots>;

/** Bind one scope's supplied accounts to its declared slots. Every slot must be supplied. */
function bindScope(
  slots: AccountSlots,
  declarations: DeclaredAccountSlots,
  selected: ResolvedAccountSlots,
  connecting?: string,
) {
  return Effect.gen(function* () {
    if (Object.keys(selected).some((slot) => !Object.hasOwn(slots, slot))) {
      return yield* Effect.fail(new HostAccountsInvalid());
    }
    const bound = new Map<string, BoundSlots[string]>();
    for (const [slot, selection] of Object.entries(slots)) {
      const requirement = Object.hasOwn(declarations, slot) ? declarations[slot] : undefined;
      const supplied = Object.hasOwn(selected, slot) ? selected[slot] : undefined;
      if (supplied === undefined && connecting !== undefined) continue;
      if (requirement === undefined || supplied === undefined)
        return yield* Effect.fail(new HostAccountsInvalid());
      const provider = selection instanceof ManyAccounts ? selection.provider : selection;
      const many = selection instanceof ManyAccounts;
      if (many !== Array.isArray(supplied)) return yield* Effect.fail(new HostAccountsInvalid());
      const accounts = Array.isArray(supplied) ? supplied : [supplied];
      const ids = new Set<string>();
      const values = [];
      for (const account of accounts) {
        if (ids.has(account.id)) return yield* Effect.fail(new HostAccountsInvalid());
        ids.add(account.id);
        if (
          canonical(withoutGrants(account.provider)) !==
            canonical(withoutGrants(requirement.definition)) ||
          !Object.hasOwn(provider.auth, account.method)
        )
          return yield* Effect.fail(new HostAccountsInvalid());
        const method = provider.auth[account.method];
        if (method === undefined) return yield* Effect.fail(new HostAccountsInvalid());
        const fields = yield* Schema.decodeUnknownEffect(
          method._tag === "interactive"
            ? Schema.Struct({ ref: Schema.String })
            : method._tag === "secrets"
              ? method.fields
              : method.response,
        )(account.fields);
        const granted = Object.hasOwn(account.provider.auth, account.method)
          ? account.provider.auth[account.method]?.request
          : undefined;
        values.push(withPlacements({ id: account.id, method: account.method, fields }, granted));
      }
      if (many) bound.set(slot, values);
      else {
        const account = values[0];
        if (account === undefined) return yield* Effect.fail(new HostAccountsInvalid());
        bound.set(slot, account);
      }
    }
    return Object.fromEntries(bound);
  });
}

/**
 * Bind an invocation's accounts by scope: `ctx.app.accounts` always, and `ctx.user.accounts` when
 * the host supplies a caller or a user-account scope. App-only work has neither.
 */
function bindAccounts(
  slots: ScopedSlots,
  declarations: DeclaredRequirements,
  context: HostContext,
  connecting?: string,
) {
  return safe(
    () =>
      Effect.gen(function* () {
        const selected = yield* Schema.decodeUnknownEffect(ResolvedAccounts)(
          Redacted.value(context.accounts),
        );
        const app = yield* bindScope(
          slots.app,
          declarations.accounts.app,
          selected.app,
          connecting,
        );
        if (selected.user === undefined && context.caller === undefined)
          return { app: { accounts: app } };
        const user = yield* bindScope(
          slots.user,
          declarations.accounts.user,
          selected.user ?? {},
          connecting,
        );
        const id =
          context.caller === undefined
            ? undefined
            : yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(context.caller);
        return { app: { accounts: app }, user: { id, accounts: user } };
      }),
    new HostAccountsInvalid(),
  );
}

/** The bound accounts events may be attributed to by default: the caller's, never the app's. */
const userAccountIds = (bound: { readonly user?: { readonly accounts: BoundSlots } }) =>
  Object.values(bound.user?.accounts ?? {}).flatMap((selected) =>
    (Array.isArray(selected) ? selected : [selected]).map(
      (account: { readonly id: string }) => account.id,
    ),
  );

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
  /** Events this invocation emits. The handler sends them only when it succeeds. */
  emitted: EmittedEvent[],
): Effect.Effect<JsonValue, HostError> {
  return Effect.scoped(
    Effect.gen(function* () {
      if (!isApp(app))
        return yield* Effect.fail(
          declarationInvalid("The app module's default export is not an app created by defineApp"),
        );
      const native = toEffectApp(app);
      const secrets = accountSecrets(context.accounts);
      // The build's migrations, not a flag, decide whether the app has a database.
      const ownsSql = hasMigrations(context.files ?? []);
      const declared = yield* requirements(
        native.accounts,
        ownsSql,
        native.events,
        native.icons,
        native.connectChecks,
      );
      if (request.operation === "connect") {
        const selected = native.accounts.app[request.slot] ?? native.accounts.user[request.slot];
        const provider = selected instanceof ManyAccounts ? selected.provider : selected;
        if (
          provider === undefined ||
          !Object.hasOwn(provider.auth, request.input.method) ||
          provider.auth[request.input.method]?._tag !== "interactive"
        )
          return yield* new HostInputInvalid();
      }
      if (request.operation === "requirements")
        return yield* safe(
          () => Schema.decodeUnknownEffect(JsonValue)(declared),
          new HostDeclarationInvalid(),
        );
      if (request.operation === "migrate") {
        if (!ownsSql) return yield* new HostOperationNotFound();
        const storage = context.storage;
        if (storage === undefined)
          return yield* new HostOperationFailed(
            failureDetail(new Error("This host gave the app no SQL storage."), secrets),
          );
        const sources = yield* Schema.decodeUnknownEffect(Schema.Array(SkillFile))(
          context.files ?? [],
        ).pipe(Effect.mapError(() => new HostDeclarationInvalid()));
        const applied = yield* migrate(storage, sources).pipe(
          Effect.mapError((error) => new HostOperationFailed(failureDetail(error, secrets))),
          Effect.withSpan("app.sql.migrate"),
        );
        return yield* safe(
          () => Schema.decodeUnknownEffect(JsonValue)(applied),
          new HostOutputInvalid(),
        );
      }
      const lifetime = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (controller) => Effect.sync(() => controller.abort()),
      );
      const invocationSignal = AbortSignal.any([signal, lifetime.signal]);
      /** One invocation's `ctx.sql`. Without migrations it explains that the app has no database. */
      const storage = context.storage;
      const sqlSession = (step?: StepReplay) =>
        !ownsSql
          ? Effect.succeed({ reader: noDatabase, writer: noDatabase })
          : storage === undefined
            ? Effect.fail(
                new HostOperationFailed(
                  failureDetail(new Error("This host gave the app no SQL storage."), secrets),
                ),
              )
            : Effect.acquireRelease(
                Effect.sync(() =>
                  authorSql(storage, {
                    signal: invocationSignal,
                    emitted,
                    ...(step === undefined ? {} : { step }),
                  }),
                ),
                (session) => Effect.sync(session.close),
              );
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
          deadline,
        ).pipe(withinDeadline);
      let running: InvocationTelemetry | undefined;
      // SQL transactions are synchronous, so a handler can never wait for input inside one.
      const delivery: ElicitationHandler = (request, signal) =>
        Effect.suspend(() =>
          running !== undefined && context.elicitation !== undefined
            ? context.elicitation(request, signal).pipe(
                // Delivering the question and waiting for its answer is the person's time.
                owned("person", "app.tool.elicitation"),
                Effect.provideContext(running.context),
              )
            : Effect.fail(new ElicitationFailed({ reason: "unavailable" })),
        );
      const unavailableWorkflow = () =>
        Effect.fail(new WorkflowFailure({ reason: "unavailable", retryable: false }));
      // Authored code calls these as Promises; they run in this invocation's telemetry, so their
      // spans join its trace and its timing.
      const telemetry = yield* captureTelemetry;
      const control = <A, E>(operation: string, work: Effect.Effect<A, E>) =>
        work.pipe(
          owned("executor", workflowControlSpan, {
            attributes: { "executor.workflow.operation": operation },
          }),
        );
      const workflowControls: WorkflowControls = {
        start: toPromise(
          (input) =>
            control(
              "start",
              context.workflowControls === undefined
                ? unavailableWorkflow()
                : context.workflowControls.start(input),
            ),
          invocationSignal,
          telemetry.context,
        ),
        get: toPromise(
          (input) =>
            control(
              "get",
              context.workflowControls === undefined
                ? unavailableWorkflow()
                : context.workflowControls.get(input),
            ),
          invocationSignal,
          telemetry.context,
        ),
        list: toPromise(
          (input) =>
            control(
              "list",
              context.workflowControls === undefined
                ? unavailableWorkflow()
                : context.workflowControls.list(input),
            ),
          invocationSignal,
          telemetry.context,
        ),
        terminate: toPromise(
          (input) =>
            control(
              "terminate",
              context.workflowControls === undefined
                ? unavailableWorkflow()
                : context.workflowControls.terminate(input),
            ),
          invocationSignal,
          telemetry.context,
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
          telemetry.context,
          deadline,
        ),
        files,
        ...(yield* bindAccounts(
          native.accounts,
          declared,
          context,
          request.operation === "connect" ? request.slot : undefined,
        ).pipe(Effect.withSpan("app.accounts.bind"))),
        workflows: workflowReads,
        signal: invocationSignal,
        fetch: yield* appInvocationFetch(fetching.signal),
        elicit: makeElicit(delivery, invocationSignal, telemetry.context),
      };
      // Every bound account may be named; only the caller's count when an emit names none.
      const attributable = userAccountIds(bound);
      const accountIds = [
        ...Object.values(bound.app.accounts).flatMap((selected) =>
          (Array.isArray(selected) ? selected : [selected]).map(
            (account: { readonly id: string }) => account.id,
          ),
        ),
        ...attributable,
      ];
      const emitter = (sourceAccount?: string) =>
        makeEmitter({
          events: native.events ?? {},
          accounts: accountIds,
          attributable,
          ...(sourceAccount === undefined ? {} : { sourceAccount }),
          emitted,
        });
      const definition = yield* evaluationSafe(native.evaluate(bound), secrets).pipe(
        Effect.withSpan("app.evaluate"),
      );
      if (request.operation === "connect") {
        const session = yield* sqlSession();
        const connect = dispatchConnect(definition.connect, request, {
          ...bound,
          sql: session.writer,
        });
        const classified =
          request.step === "check"
            ? connect.pipe(classifyAccountCheck(context))
            : connect.pipe(
                Effect.mapError((error) =>
                  Schema.is(HostOperationNotFound)(error) ||
                  Schema.is(HostInputInvalid)(error) ||
                  Schema.is(HostOutputInvalid)(error) ||
                  Schema.is(HostOperationFailed)(error)
                    ? error
                    : new HostOperationFailed(failureDetail(error, secrets)),
                ),
              );
        const result = yield* classified.pipe(withinDeadline);
        return request.step === "check" && result !== null
          ? yield* accountCheckOutput(result, context, request.input.ref)
          : result;
      }
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
                // A run keeps its initiating caller; each step refreshes only the accounts.
                () =>
                  bindAccounts(native.accounts, declared, {
                    ...current,
                    ...(context.caller === undefined ? {} : { caller: context.caller }),
                  }),
                new WorkflowFailure({ reason: "credentials", retryable: false }),
              );
              return {
                context: {
                  ...accounts,
                  cache: authorCache(
                    context.cache ?? unavailableCache,
                    Redacted.value(current.accounts),
                    signal,
                    (yield* captureTelemetry).context,
                  ),
                  files,
                  fetch: yield* appInvocationFetch(signal),
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
        const { tools, routers } = catalog;
        // Router errors are tagged classes; encoding keeps only their serialized safe fields. A
        // shared catalog writes each definition and each distinct `$defs` once, however many tools
        // reach them. Only a full read describes its tools with schemas, which `every` checks.
        return yield* safe(
          () =>
            (request.definitions === "shared" &&
            !summary &&
            tools.every((tool): tool is HostedTool => "inputSchema" in tool)
              ? Schema.encodeEffect(HostedSharedCatalog)(shareCatalog({ tools, routers }))
              : Schema.encodeEffect(WireCatalog)(catalog)
            ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(JsonValue))),
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
        // Lifecycle hooks get `ctx.sql` with no surrounding transaction: registration can wait on a
        // provider that calls this app back before it answers.
        const session = yield* sqlSession();
        return yield* dispatchWebhook(
          definition,
          request,
          {
            files,
            cache: bound.cache,
            app: bound.app,
            ...(bound.user === undefined ? {} : { user: bound.user }),
            workflows: workflowControls,
            signal: bound.signal,
            fetch: bound.fetch,
            sql: session.writer,
            events: emitter("sourceAccount" in request ? request.sourceAccount : undefined),
          },
          native.accounts,
        );
      }
      const toolName = request.operation === "call" ? request.tool : request.name;
      const location = locate(definition.tools, toolName);
      const tool =
        location === undefined
          ? undefined
          : location.kind === "operation"
            ? location.operation
            : yield* evaluationSafe(location.source.resolve(location.name), secrets).pipe(
                Effect.withSpan("app.tool.resolve"),
              );
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
            : Effect.fail(inputInvalid(Cause.squash(cause), request.input)),
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
      const replay =
        context.replay === undefined
          ? undefined
          : yield* safe(
              () => Schema.decodeUnknownEffect(WorkflowReplay)(context.replay),
              new HostInputInvalid(),
            );
      if (replay !== undefined && kind !== "mutate") return yield* new HostInputInvalid();
      // A replayed workflow step records its receipt inside its one SQL transaction.
      const session = yield* sqlSession(replay);
      const execute = () =>
        Effect.gen(function* () {
          const output = yield* Effect.gen(function* () {
            running = yield* captureTelemetry;
            const fetch = yield* appInvocationFetch(fetching.signal);
            return yield* tool.run(
              {
                ...bound,
                fetch,
                workflows: kind === "mutate" ? workflowControls : workflowReads,
                sql: kind === "mutate" ? session.writer : session.reader,
                ...(kind === "mutate" ? { events: emitter() } : {}),
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
              // An MCP server's failure is not the app's own error; keep its server's answer.
              const mcp = parseMcpError(error, secrets);
              const failure = Schema.decodeUnknownOption(ElicitationFailed)(error);
              // A router found, while running it, that its source no longer has the tool.
              const removed = Schema.is(HostToolNotFound)(error)
                ? request.operation === "call"
                  ? new HostToolNotFound()
                  : new HostOperationNotFound()
                : undefined;
              return Effect.fail(
                removed !== undefined
                  ? removed
                  : Option.isSome(provider)
                    ? leavingProviderError(provider.value, secrets, "call")
                    : Option.isSome(response)
                      ? new OpenapiResponseError({
                          code: response.value.code,
                          status: response.value.status,
                          message: response.value.message,
                          ...(response.value.recovery === undefined
                            ? {}
                            : { recovery: response.value.recovery }),
                        })
                      : Option.isSome(mcp)
                        ? mcp.value
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
      return yield* withinDeadline(execute());
    }),
  );
}

/**
 * Run one slot's provider check against the single account the host supplied, without evaluating
 * the app. Failures are attributed to that account. HTTP status failures from `decodeJson` are
 * classified like other provider responses; anything else means the check
 * could not verify it, and carries the app's own error message with account secrets replaced.
 * The check receives the invocation's deadline, after which the host stops waiting for it.
 */
function checkAccount(
  slots: ScopedSlots,
  declared: DeclaredRequirements,
  requirement: string,
  context: HostContext,
  signal: AbortSignal,
  deadline: number | undefined,
) {
  return Effect.gen(function* () {
    // A requirement name is unique across scopes; the host supplies the account in its scope.
    const scope = Object.hasOwn(slots.app, requirement)
      ? "app"
      : Object.hasOwn(slots.user, requirement)
        ? "user"
        : undefined;
    if (scope === undefined) return yield* new HostAccountsInvalid();
    const selection = slots[scope][requirement];
    const slot = Object.hasOwn(declared.accounts[scope], requirement)
      ? declared.accounts[scope][requirement]
      : undefined;
    if (selection === undefined || slot === undefined) return yield* new HostAccountsInvalid();
    const provider = selection instanceof ManyAccounts ? selection.provider : selection;
    const health = provider.health;
    if (health === undefined) return yield* new HostOperationNotFound();
    const accounts = yield* safe(
      () =>
        Effect.gen(function* () {
          const selected = yield* Schema.decodeUnknownEffect(ResolvedAccounts)(
            Redacted.value(context.accounts),
          );
          const supplied = selected[scope];
          if (supplied === undefined) return yield* new HostAccountsInvalid();
          return yield* bindScope(
            { [requirement]: provider },
            { [requirement]: { ...slot, cardinality: "one" } },
            supplied,
          );
        }),
      new HostAccountsInvalid(),
    ).pipe(Effect.withSpan("app.accounts.bind"));
    const account = accounts[requirement];
    if (account === undefined || !("id" in account)) return yield* new HostAccountsInvalid();
    const result = yield* Effect.suspend(() =>
      Effect.gen(function* () {
        return yield* health.run({
          account,
          fetch: yield* appInvocationFetch(signal),
          signal,
          ...(deadline === undefined ? {} : { deadline }),
        });
      }),
    ).pipe(classifyAccountCheck(context, account.id), Effect.withSpan("app.account.check"));
    return yield* safe(
      () =>
        accountCheckOutput(result ?? {}, context).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(JsonValue)),
        ),
      new HostOutputInvalid(),
    );
  });
}

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
      // oxlint-disable-next-line executor/authored-code-through-adapter -- the host's Request
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
      const emitted: EmittedEvent[] = [];
      const value = yield* dispatch(app, command, context, request.signal, emitted).pipe(
        Effect.provideService(ToolResultObservation, {
          failed: () => {
            toolError = true;
          },
        }),
        // Name what failed on the span; the bounded message stays in the reply only. The host
        // records an app's own error names and codes as `unrecognized` (telemetry `app-records`).
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
        // Tool operations time themselves, dividing their time by who owned the work in progress.
        // Other operations do not.
        command.operation === "call" ||
          command.operation === "query" ||
          command.operation === "mutate"
          ? timedInvocation(command.operation)
          : Effect.withSpan(`app.${command.operation}`),
      );
      if (toolError)
        yield* Effect.annotateCurrentSpan({
          "executor.outcome": "failed",
          "error.type": "McpToolError",
        });
      return Response.json({
        ok: true,
        value,
        ...(toolError ? { toolError: true } : {}),
        ...(emitted.length === 0 ? {} : { events: emitted }),
      });
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
          : // The cause can carry any text the app threw; its caller receives that, not the log.
            Effect.logError("The app's request failed unexpectedly").pipe(
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
