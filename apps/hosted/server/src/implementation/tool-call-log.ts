import {
  AppProviderFailed,
  ToolCallFailed,
  ToolBlocked,
  ToolCallKindObserved,
  invocationAccounts,
  invocationEntries,
  type AppAccounts,
  type ApprovalRequestId,
  type AppId,
  type ToolCallResult,
  type ToolKind,
  type ToolName,
  type ToolResumeResult,
  type VersionId,
} from "@executor-js/sdk/core";
import {
  Cause,
  Clock,
  Context,
  Deferred,
  type Duration,
  Effect,
  ErrorReporter,
  Exit,
  Match,
  Option,
  Schema,
} from "effect";
import { SqlClient, SqlError } from "effect/sql";
import { CurrentUserId } from "../contracts/auth.ts";
import { HostedBackground } from "../contracts/executor.ts";
import { GroupDatabase } from "../contracts/groups.ts";
import { CurrentOrganization } from "../contracts/organization.ts";
import {
  ToolCallId,
  type ToolCallCaller,
  type ToolCallSource,
} from "../contracts/tool-call-log.ts";

export const toolCallRetentionDays = 30;
const awaitedWriteTimeout = "500 millis";
const backgroundWriteTimeout = "20 seconds";
const pruneBatch = 5000;
const pruneBatches = 20;

export const migrateToolCallLog = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists hosted_tool_calls (
    id text primary key,
    organization_id text not null references organization(id) on delete cascade,
    user_id text references "user"(id) on delete set null,
    user_name text,
    source text not null check (source in ('agent', 'api-key', 'dashboard', 'schedule', 'webhook', 'workflow')),
    source_id text,
    source_name text,
    connection_id text,
    connection_name text,
    session_id text,
    run_id text,
    app_id text not null,
    app_name text not null,
    version_id text,
    tool text,
    kind text check (kind in ('query', 'mutation')),
    status text not null check (status in ('awaiting-approval', 'succeeded', 'failed', 'denied', 'expired')),
    error_type text,
    status_code integer,
    approval_id text,
    approval_expires_at timestamptz,
    decided_by text references "user"(id) on delete set null,
    decided_by_name text,
    decided_at timestamptz,
    started_at timestamptz not null,
    duration_ms integer,
    trace_id text,
    check ((approval_id is null) = (approval_expires_at is null))
  )`;
  yield* sql`create index if not exists hosted_tool_calls_organization_started
    on hosted_tool_calls (organization_id, started_at desc)`;
  yield* sql`create index if not exists hosted_tool_calls_user_started
    on hosted_tool_calls (user_id, started_at desc) where user_id is not null`;
  yield* sql`create index if not exists hosted_tool_calls_tool_started
    on hosted_tool_calls (organization_id, app_id, tool, started_at desc)`;
  yield* sql`create index if not exists hosted_tool_calls_source_started
    on hosted_tool_calls (organization_id, source_id, started_at desc) where source_id is not null`;
  yield* sql`create index if not exists hosted_tool_calls_connection_started
    on hosted_tool_calls (organization_id, connection_id, started_at desc) where connection_id is not null`;
  yield* sql`create index if not exists hosted_tool_calls_run
    on hosted_tool_calls (organization_id, run_id) where run_id is not null`;
  yield* sql`create index if not exists hosted_tool_calls_session_started
    on hosted_tool_calls (organization_id, session_id, started_at desc) where session_id is not null`;
  yield* sql`create index if not exists hosted_tool_calls_approval
    on hosted_tool_calls (organization_id, approval_id) where approval_id is not null`;
  yield* sql`create index if not exists hosted_tool_calls_awaiting
    on hosted_tool_calls (approval_expires_at) where status = 'awaiting-approval'`;
  yield* sql`create index if not exists hosted_tool_calls_decided_by
    on hosted_tool_calls (decided_by) where decided_by is not null`;
  yield* sql`create index if not exists hosted_tool_calls_started
    on hosted_tool_calls (started_at)`;
  yield* sql`create table if not exists hosted_tool_call_accounts (
    call_id text not null references hosted_tool_calls(id) on delete cascade,
    account_id text not null,
    account_name text not null,
    shared boolean not null,
    owner_id text,
    primary key (call_id, account_id),
    check (shared = (owner_id is null))
  )`;
});

const referenceAlphabet = "0123456789abcdefghjkmnpqrstvwxyz";
export const mintToolCallId = Effect.sync(() => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(14));
  let id = "call_";
  for (const byte of bytes) id += referenceAlphabet[byte & 31];
  return ToolCallId.make(id);
});

interface CallDetails {
  version?: VersionId | undefined;
  kind?: ToolKind | undefined;
  accounts?: AppAccounts | undefined;
}
const LoggedCallDetails = Context.Reference<CallDetails | undefined>("hosted/LoggedCallDetails", {
  defaultValue: () => undefined,
});
export const recordCallDetails = (details: CallDetails) =>
  Effect.map(LoggedCallDetails, (current) => {
    if (current !== undefined) Object.assign(current, details);
  });

interface Ending {
  readonly status: "awaiting-approval" | "succeeded" | "failed" | "denied" | "expired";
  readonly errorType?: string | undefined;
  readonly statusCode?: number | undefined;
}

const ErrorTag = Schema.Struct({
  _tag: Schema.String.check(Schema.isPattern(/^[A-Z][A-Za-z0-9]{0,79}$/u)),
});
const serviceStatus = (error: unknown): number | undefined => {
  const status = Schema.is(AppProviderFailed)(error)
    ? error.status
    : Schema.is(ToolCallFailed)(error)
      ? (error.response?.status ?? error.mcp?.status)
      : undefined;
  return status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
};
const failed = (error: unknown): Ending => ({
  status: Schema.is(ToolBlocked)(error) ? "denied" : "failed",
  errorType: Schema.is(ErrorTag)(error) ? error._tag : "UnrecognizedFailure",
  statusCode: serviceStatus(error),
});
const endedWith = (cause: Cause.Cause<unknown>): Ending => {
  if (Cause.hasInterrupts(cause)) return { status: "failed", errorType: "Interrupted" };
  const error = Cause.findErrorOption(cause);
  return Option.isSome(error) ? failed(error.value) : { status: "failed", errorType: "Defect" };
};
const completed = (result: { readonly toolError?: true | undefined }): Ending =>
  result.toolError === true
    ? { status: "failed", errorType: "McpToolError" }
    : { status: "succeeded" };

const outage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause);
  return Option.isSome(error) && SqlError.isSqlError(error.value) && error.value.isRetryable;
};
const reportFailure = (cause: Cause.Cause<unknown>, message: string) =>
  Cause.hasInterrupts(cause)
    ? Effect.void
    : (outage(cause) ? Effect.void : ErrorReporter.report(cause)).pipe(
        Effect.andThen(Effect.logWarning(message, cause)),
      );

const reported =
  (timeout: Duration.Input, what: "write" | "read" = "write") =>
  <A, E, R>(statement: Effect.Effect<A, E, R>) =>
    statement.pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.logWarning(`The tool call log ${what} timed out`).pipe(Effect.as(undefined)),
      }),
      Effect.catchCause((cause) =>
        reportFailure(cause, `The tool call log ${what} failed`).pipe(Effect.as(undefined)),
      ),
      Effect.withSpan(`product.tool_call_log.${what}`),
    );

const detached = <R>(write: Effect.Effect<void, never, R>) =>
  Effect.gen(function* () {
    const work = write.pipe(Effect.provideContext(yield* Effect.context<R>()));
    const background = yield* HostedBackground;
    if (background === undefined || !(yield* background(work))) yield* work;
  });

const awaited =
  (what: "write" | "read" = "write") =>
  <A, E, R>(statement: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const background = yield* HostedBackground;
      const result = yield* Deferred.make<A | undefined>();
      const work = statement.pipe(
        reported(backgroundWriteTimeout, what),
        Effect.flatMap((value) => Deferred.succeed(result, value)),
        Effect.asVoid,
        Effect.provideContext(yield* Effect.context<R>()),
      );
      if (background === undefined || !(yield* background(work)))
        return yield* statement.pipe(reported(awaitedWriteTimeout, what));
      return yield* Deferred.await(result).pipe(
        Effect.timeoutOrElse({
          duration: awaitedWriteTimeout,
          orElse: () =>
            Effect.logWarning(`The tool call log ${what} outlasted its caller's wait`).pipe(
              Effect.as(undefined),
            ),
        }),
      );
    });

const logDatabase = Effect.flatten(GroupDatabase);
const timestamp = (millis: number) => new Date(millis).toISOString();
const traceId = Effect.currentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => undefined),
);

const accountIds = (accounts: AppAccounts | undefined) =>
  JSON.stringify([
    ...new Set(
      (accounts === undefined ? [] : invocationEntries(accounts)).flatMap(([, ids]) => ids),
    ),
  ]);

interface CallRow {
  readonly id: ToolCallId;
  readonly caller: ToolCallCaller;
  readonly app: AppId;
  readonly tool: ToolName;
  readonly details: CallDetails;
  readonly ending: Ending;
  readonly approval?: { readonly id: ApprovalRequestId; readonly expiresAt: number } | undefined;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly traceId: string | undefined;
}

const nameLength = 200;

const recordedTool = (row: CallRow) =>
  row.ending.errorType === "ToolNotFound" ? null : row.tool.slice(0, nameLength);

const insertCall = (row: CallRow) =>
  Effect.gen(function* () {
    const sql = yield* logDatabase;
    const organization = yield* CurrentOrganization;
    const user = yield* CurrentUserId;
    const source: ToolCallSource = row.caller.source;
    const sourceId = row.caller.sourceId ?? null;
    const grant = source === "agent" ? sourceId : null;
    const rows = yield* sql`with app as (
        select id, name from executor_apps where id = ${row.app} and owner = ${organization.owner}
      ), inserted as (
        insert into hosted_tool_calls (id, organization_id, user_id, user_name, source, source_id,
          source_name, connection_id, connection_name, session_id, run_id, app_id, app_name,
          version_id, tool, kind, status, error_type, status_code, approval_id,
          approval_expires_at, started_at, duration_ms, trace_id)
        select ${row.id}, ${organization.organization}, ${user ?? null}::text,
          (select left(u.name, ${nameLength}) from "user" u where u.id = ${user ?? null}::text),
          ${source}, ${sourceId}::text,
          case ${source}::text
            when 'agent' then (select left(c.name, ${nameLength}) from "mcpGrant" g
              join "oauthClient" c on c."clientId" = g."clientId" where g.id = ${grant}::text)
            when 'api-key' then (select left(k.name, ${nameLength}) from apikey k
              where k.id = ${sourceId}::text)
          end,
          (select g.connection from "mcpGrant" g where g.id = ${grant}::text),
          (select left(mc.name, ${nameLength}) from "mcpGrant" g
            join "mcpConnection" mc on mc.id = g.connection
            where g.id = ${grant}::text),
          ${row.caller.session ?? null}::text, ${row.caller.execution ?? null}::text,
          app.id, left(app.name, ${nameLength}), ${row.details.version ?? null}::text,
          ${recordedTool(row)}::text,
          ${row.details.kind ?? null}::text, ${row.ending.status}, ${row.ending.errorType ?? null}::text,
          ${row.ending.statusCode ?? null}::integer, ${row.approval?.id ?? null}::text,
          ${row.approval === undefined ? null : timestamp(row.approval.expiresAt)}::timestamptz,
          ${timestamp(row.startedAt)}::timestamptz, ${row.durationMs}::integer, ${row.traceId ?? null}::text
        from app
        returning id
      ), accounts as (
        insert into hosted_tool_call_accounts (call_id, account_id, account_name, shared, owner_id)
        select inserted.id, a.id, left(a.label, ${nameLength}), false, h.personal_user_id
        from inserted
        join executor_accounts a
          on a.id in (select jsonb_array_elements_text(${accountIds(row.details.accounts)}::jsonb))
        join hosted_account_access h on h.account_id = a.id and h.organization_id = ${organization.organization}
          and h.kind = 'personal'
      )
      select id from inserted`;
    return rows.length > 0 ? row.id : undefined;
  });

export interface LoggedCall<A, E> {
  readonly exit: Exit.Exit<A, E>;
  readonly reference: ToolCallId | undefined;
}

export const loggedToolCall = <E, R>(
  caller: ToolCallCaller | undefined,
  call: { readonly app: AppId; readonly tool: ToolName; readonly kind?: ToolKind | undefined },
  approvals: boolean,
  work: Effect.Effect<ToolCallResult, E, R>,
) =>
  Effect.gen(function* () {
    if (caller === undefined) {
      yield* Effect.logError("A tool call has no caller to log it under");
      const unlogged: LoggedCall<ToolCallResult, E> = {
        exit: yield* Effect.exit(work),
        reference: undefined,
      };
      return unlogged;
    }
    const id = yield* mintToolCallId;
    const startedAt = yield* Clock.currentTimeMillis;
    const details: CallDetails = { kind: call.kind };
    let reference: ToolCallId | undefined;
    const exit = yield* work.pipe(
      Effect.provideService(LoggedCallDetails, details),
      Effect.provideService(ToolCallKindObserved, (kind) => {
        details.kind = kind;
      }),
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const durationMs = Math.max(0, (yield* Clock.currentTimeMillis) - startedAt);
          const row = rowOf(exit, approvals, {
            id,
            caller,
            app: call.app,
            tool: call.tool,
            details,
            startedAt,
            durationMs,
            traceId: yield* traceId,
          });
          const interrupted = Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause);
          if (interrupted || row.ending.status === "succeeded")
            return yield* detached(
              insertCall(row).pipe(reported(backgroundWriteTimeout), Effect.asVoid),
            );
          reference = yield* insertCall(row).pipe(awaited());
        }),
      ),
      Effect.exit,
    );
    const logged: LoggedCall<ToolCallResult, E> = { exit, reference };
    return logged;
  });

const rowOf = <E>(
  exit: Exit.Exit<ToolCallResult, E>,
  approvals: boolean,
  base: Omit<CallRow, "ending" | "approval">,
): CallRow => {
  if (Exit.isFailure(exit)) return { ...base, ending: endedWith(exit.cause) };
  const result = exit.value;
  if (result.status === "completed") return { ...base, ending: completed(result) };
  const details = {
    ...base.details,
    version: result.invocation.version,
    kind: result.invocation.kind ?? base.details.kind,
    accounts: invocationAccounts(result.invocation),
  };
  return approvals
    ? {
        ...base,
        details,
        ending: { status: "awaiting-approval" },
        approval: { id: result.requestId, expiresAt: result.expiresAt },
      }
    : { ...base, details, ending: { status: "failed", errorType: "ToolApprovalRequired" } };
};

const resumedEnding = (result: ToolResumeResult): Ending | undefined =>
  Match.value(result).pipe(
    Match.when({ status: "completed" }, completed),
    Match.when({ status: "denied" }, (): Ending => ({ status: "denied" })),
    Match.when({ status: "cancelled" }, (): Ending => ({ status: "denied" })),
    Match.when({ status: "already-consumed" }, () => undefined),
    Match.when({ status: "failed", reason: "expired" }, (): Ending => ({ status: "expired" })),
    Match.when({ status: "failed", reason: "context-changed" }, (): Ending => ({
      status: "failed",
      errorType: "ApprovalUnavailable",
    })),
    Match.when({ status: "failed", reason: "execution-failed" }, ({ error }) => failed(error)),
    Match.exhaustive,
  );

export const dashboardRunReference = (requestId: ApprovalRequestId) =>
  Effect.gen(function* () {
    const organization = yield* CurrentOrganization;
    const user = (yield* CurrentUserId) ?? null;
    const sql = yield* logDatabase;
    const rows = yield* sql`select id from hosted_tool_calls
      where organization_id = ${organization.organization} and approval_id = ${requestId}
        and source = 'dashboard' and user_id = ${user}::text and status <> 'succeeded'`;
    return Option.getOrUndefined(
      Schema.decodeUnknownOption(Schema.Struct({ id: ToolCallId }))(rows[0]),
    )?.id;
  }).pipe(awaited("read"));

const updateResumed = (requestId: ApprovalRequestId, ending: Ending, startedAt: number) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const organization = yield* CurrentOrganization;
    const sql = yield* logDatabase;
    const user = yield* CurrentUserId;
    const answered = ending.status !== "expired";
    const ran = ending.status === "succeeded" || ending.status === "failed";
    const rows = yield* sql`update hosted_tool_calls set
        status = ${ending.status}, error_type = ${ending.errorType ?? null}::text,
        status_code = ${ending.statusCode ?? null}::integer,
        decided_by = ${answered ? (user ?? null) : null}::text,
        decided_by_name = (select left(u.name, ${nameLength}) from "user" u
          where u.id = ${answered ? (user ?? null) : null}::text),
        decided_at = ${answered ? timestamp(startedAt) : null}::timestamptz,
        duration_ms = coalesce(duration_ms, 0) + ${ran ? Math.max(0, now - startedAt) : 0}::integer
      where organization_id = ${organization.organization} and approval_id = ${requestId}
        and (status = 'awaiting-approval'
          or (status = 'expired' and ${ending.status}::text <> 'expired'))
      returning id`;
    return Option.getOrUndefined(
      Schema.decodeUnknownOption(Schema.Struct({ id: ToolCallId }))(rows[0]),
    )?.id;
  });

export const loggedToolResume = <E, R>(
  requestId: ApprovalRequestId,
  work: Effect.Effect<ToolResumeResult, E, R>,
) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const exit = yield* Effect.exit(work);
    const ending = Exit.isSuccess(exit) ? resumedEnding(exit.value) : undefined;
    let reference: ToolCallId | undefined;
    if (ending !== undefined) {
      const update = updateResumed(requestId, ending, startedAt);
      const retried = detached(update.pipe(reported(backgroundWriteTimeout), Effect.asVoid));
      if (ending.status === "succeeded")
        yield* detached(
          update.pipe(Effect.retry({ times: 1 }), reported(backgroundWriteTimeout), Effect.asVoid),
        );
      else {
        reference = yield* update.pipe(awaited());
        if (reference === undefined) yield* retried;
      }
    }
    const logged: LoggedCall<ToolResumeResult, E> = { exit, reference };
    return logged;
  });

export const pruneToolCallLog = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`update hosted_tool_calls set status = 'expired', decided_at = approval_expires_at
    where status = 'awaiting-approval' and approval_expires_at <= now()`;
  for (let batch = 0; batch < pruneBatches; batch++) {
    const rows = yield* sql`with gone as (
        delete from hosted_tool_calls where id in (
          select id from hosted_tool_calls
          where started_at < now() - make_interval(days => ${toolCallRetentionDays})
          limit ${pruneBatch})
        returning 1)
      select count(*)::int as count from gone`;
    const { count } = yield* Schema.decodeUnknownEffect(Schema.Struct({ count: Schema.Number }))(
      rows[0],
    );
    if (count < pruneBatch) break;
  }
}).pipe(Effect.withSpan("product.tool_call_log.prune"));
