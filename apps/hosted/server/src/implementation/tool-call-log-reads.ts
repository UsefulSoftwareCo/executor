/**
 * Reads of the tool call log, for the dashboard and for agents through the Executor app. Every
 * query is scoped to the request's organization, and a member's to their own calls: a member who
 * names another member, another member's reference, run, session or agent finds nothing, exactly
 * as for an ID that does not exist. A reference from another organization is likewise not found.
 */
import { type App, AppId, Cursor, RequestInvalid, StorageError } from "@executor-js/sdk/core";
import { Clock, Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { SqlError, type Statement } from "effect/sql";
import { HostedApi } from "../contracts/api.ts";
import { CurrentUserId } from "../contracts/auth.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { CurrentOrganization, OrganizationForbidden } from "../contracts/organization.ts";
import {
  ToolCallId,
  ToolCallLogBusy,
  ToolCallSource,
  ToolCallStatus,
  toolCallCountLimit,
  toolCallFilterChoices,
  toolCallPage,
  type ToolCall,
  type ToolCallQuery,
  type ToolCallRange,
} from "../contracts/tool-call-log.ts";
import { currentOwner } from "./access.ts";
import { policyDatabase, visibleApps } from "./resource-policy.ts";
import { toolCallRetentionDays } from "./tool-call-log.ts";

const rangeMillis: Record<ToolCallRange, number> = {
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
};
const retentionMillis = toolCallRetentionDays * 24 * 60 * 60_000;

/**
 * How long one statement of a read may run. A search that matches few of an organization's many
 * calls reads every call in the range; past this it is stopped, and the page offers to try again
 * (`ToolCallLogBusy`). PGlite has no statement timer, so on self-host this bounds nothing: there
 * the count's limit and the filter lists' limits are what bound a read.
 */
const readTimeout = "5s";

/**
 * Who is reading: every call for owners and admins, only their own for members. A viewer without a
 * user may read none; browser sessions, API keys and OAuth grants all have one.
 */
const viewer = Effect.gen(function* () {
  const organization = yield* CurrentOrganization;
  const user = yield* CurrentUserId;
  if (user === undefined) return yield* new OrganizationForbidden();
  const member = organization.role === "member";
  return {
    organization: organization.organization,
    owner: organization.owner,
    user,
    member,
    own: member ? user : null,
  };
});

/**
 * Run a read in one transaction whose statements may each run at most `readTimeout`. A statement
 * the database stops is `ToolCallLogBusy`; any other database or decoding failure is a
 * `StorageError`.
 *
 * The transaction is repeatable read, so its statements see one snapshot: a page's rows and its
 * count agree. Under read committed each statement sees the calls committed when it starts, so a
 * call written between them was counted but not listed. It only reads, so it never fails to
 * serialize.
 */
const bounded = <A, R>(read: Effect.Effect<A, SqlError.SqlError | Schema.SchemaError, R>) =>
  Effect.gen(function* () {
    const sql = yield* policyDatabase;
    return yield* sql.withTransaction(
      sql`set transaction isolation level repeatable read`.pipe(
        Effect.andThen(sql`set local statement_timeout = '${sql.literal(readTimeout)}'`),
        Effect.andThen(read),
      ),
    );
  }).pipe(
    Effect.mapError((error) =>
      SqlError.isSqlError(error)
        ? Schema.is(SqlError.StatementTimeoutError)(error.reason)
          ? new ToolCallLogBusy()
          : new StorageError()
        : Schema.is(StorageError)(error)
          ? error
          : new StorageError(),
    ),
  );

/** A page position: the last row's start, to the microsecond, and its ID. */
const CursorParts = Schema.Struct({
  startedAt: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u),
  ),
  id: ToolCallId,
});
const cursorOf = (startedAt: string, id: string) => Cursor.make(`${startedAt}~${id}`);
const readCursor = (cursor: Cursor) => {
  const [startedAt, id, ...rest] = cursor.split("~");
  return rest.length === 0
    ? Schema.decodeUnknownOption(CursorParts)({ startedAt, id })
    : Option.none();
};

/** `ilike` text that matches `search` literally anywhere. */
const containing = (search: string) => `%${search.replace(/[\\%_]/gu, (char) => `\\${char}`)}%`;

const NullableString = Schema.NullOr(Schema.String);
const Millis = Schema.NullOr(Schema.Number);
const CallRow = Schema.Struct({
  id: ToolCallId,
  started_ms: Schema.Number,
  started_text: Schema.String,
  user_id: NullableString,
  user_name: NullableString,
  user_email: NullableString,
  user_image: NullableString,
  user_member: Schema.Boolean,
  source: ToolCallSource,
  source_id: NullableString,
  source_name: NullableString,
  source_icon: NullableString,
  connection_id: NullableString,
  connection_name: NullableString,
  session_id: NullableString,
  run_id: NullableString,
  app_id: AppId,
  app_name: Schema.String,
  version_id: NullableString,
  tool: NullableString,
  kind: Schema.NullOr(Schema.Literals(["query", "mutation"])),
  status: ToolCallStatus,
  error_type: NullableString,
  status_code: Schema.NullOr(Schema.Number),
  approval_id: NullableString,
  expires_ms: Millis,
  decided_by: NullableString,
  decided_by_name: NullableString,
  decided_email: NullableString,
  decided_image: NullableString,
  decided_member: Schema.Boolean,
  decided_ms: Millis,
  duration_ms: Schema.NullOr(Schema.Number),
  accounts: Schema.fromJsonString(
    Schema.Array(Schema.Struct({ id: NullableString, name: NullableString })),
  ),
});
type CallRow = typeof CallRow.Type;

const decided = (row: CallRow): "pending" | "approved" | "denied" | "expired" => {
  switch (row.status) {
    case "awaiting-approval":
      return "pending";
    case "denied":
      return "denied";
    case "expired":
      return "expired";
    default:
      return "approved";
  }
};

/** A call as this viewer may read it; `usable` holds the apps whose names a member may be told. */
const toCall = (row: CallRow, named: (app: AppId) => boolean): ToolCall => ({
  id: row.id,
  startedAt: new Date(row.started_ms),
  // A call with neither a user nor a copied name was the app's own, not a deleted member's.
  member:
    row.user_id === null && row.user_name === null
      ? null
      : {
          id: row.user_id,
          member: row.user_member,
          name: row.user_name,
          email: row.user_email,
          image: row.user_image,
        },
  source: { kind: row.source, id: row.source_id, name: row.source_name, icon: row.source_icon },
  connection:
    row.connection_id === null ? null : { id: row.connection_id, name: row.connection_name },
  session: row.session_id,
  run: null,
  app: { id: row.app_id, name: named(row.app_id) ? row.app_name : null },
  tool: row.tool,
  kind: row.kind,
  accounts: row.accounts,
  status: row.status,
  errorType: row.error_type,
  statusCode: row.status_code,
  approval:
    row.approval_id === null || row.expires_ms === null
      ? null
      : {
          decision: decided(row),
          expiresAt: new Date(row.expires_ms),
          decidedBy:
            row.decided_by === null && row.decided_by_name === null
              ? null
              : {
                  id: row.decided_by,
                  member: row.decided_member,
                  name: row.decided_by_name,
                  email: row.decided_email,
                  image: row.decided_image,
                },
          decidedAt: row.decided_ms === null ? null : new Date(row.decided_ms),
        },
  durationMs: row.duration_ms,
  version: row.version_id,
});

/**
 * The current records of the apps among `ids` that still exist and this viewer may use, as normal
 * app lists hold them. A member is told the names of these apps only; owners and admins are told
 * every app's name.
 */
const usableApps = (ids: ReadonlyArray<AppId>) =>
  Effect.gen(function* () {
    const unique = [...new Set(ids)];
    if (unique.length === 0) {
      const none: ReadonlyArray<App> = [];
      return none;
    }
    const executor = yield* Effect.flatten(HostedExecutor);
    return yield* visibleApps(
      yield* executor.apps.list({ owner: yield* currentOwner, ids: unique }),
    );
  });
/** Whether this viewer may be told an app's name: owners and admins always, members if usable. */
const namedFor = (member: boolean, usable: ReadonlyArray<App>) => {
  const ids = new Set(usable.map((app) => app.id));
  return (app: AppId) => !member || ids.has(app);
};

const listCalls = (query: ToolCallQuery) =>
  Effect.gen(function* () {
    const access = yield* viewer;
    const sql = yield* policyDatabase;
    const now = yield* Clock.currentTimeMillis;
    const nowText = new Date(now).toISOString();
    const limit = query.limit ?? toolCallPage.default;
    const search = query.search?.trim() ?? "";
    // Text that is exactly a reference finds that call alone, whatever else the query names.
    const reference = Schema.is(ToolCallId)(search) ? search : null;
    const cursor =
      query.cursor === undefined ? undefined : Option.getOrUndefined(readCursor(query.cursor));
    if (query.cursor !== undefined && cursor === undefined)
      return yield* new RequestInvalid({ part: "query" });
    // An approval past its deadline is expired, though only the prune job marks the row.
    const status = sql`(case when c.status = 'awaiting-approval'
      and c.approval_expires_at <= ${nowText}::timestamptz then 'expired' else c.status end)`;
    const since = new Date(now - rangeMillis[query.range ?? "7d"]).toISOString();
    // Calls past the retention are gone, whether or not the prune has deleted them yet.
    const kept = new Date(now - retentionMillis).toISOString();
    const pattern = reference === null && search !== "" ? containing(search) : null;
    const scope: Statement.Fragment = sql`c.organization_id = ${access.organization}
      and (${access.own}::text is null or c.user_id = ${access.own})
      and c.started_at >= ${kept}::timestamptz`;
    // An account is shown, and found, only for the member it belonged to when the call was made.
    // Rows from before shared accounts were removed have no owner, so they are named to nobody.
    const shown = sql`(a.owner_id = ${access.user})`;
    // A member is told an app's name only while they may use the app, so their search finds calls
    // by the names of those apps alone: a match on any other would tell them the name.
    const named =
      pattern === null || !access.member
        ? null
        : yield* bounded(
            sql`select distinct c.app_id as id from hosted_tool_calls c
              where ${scope} and c.started_at >= ${since}::timestamptz
                and c.app_name ilike ${pattern}`.pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: AppId }))),
              ),
            ),
          ).pipe(
            Effect.flatMap((rows) => usableApps(rows.map((row) => row.id))),
            Effect.map((apps) => JSON.stringify(apps.map((app) => app.id))),
          );
    const appNamed: Statement.Fragment =
      named === null
        ? sql`c.app_name ilike ${pattern}`
        : sql`(c.app_name ilike ${pattern}
            and c.app_id in (select jsonb_array_elements_text(${named}::jsonb)))`;
    const matching: Statement.Fragment =
      reference !== null
        ? sql`${scope} and c.id = ${reference}`
        : sql`${scope}
          and c.started_at >= ${since}::timestamptz
          and (${query.member ?? null}::text is null or c.user_id = ${query.member ?? null})
          and (${query.app ?? null}::text is null or c.app_id = ${query.app ?? null})
          and (${query.tool ?? null}::text is null or c.tool = ${query.tool ?? null})
          and (${query.status ?? null}::text is null or ${status} = ${query.status ?? null})
          and (${query.source ?? null}::text is null or c.source = ${query.source ?? null})
          and (${query.agent ?? null}::text is null or c.source_id = ${query.agent ?? null})
          and (${query.connection ?? null}::text is null
            or c.connection_id = ${query.connection ?? null})
          and (${query.session ?? null}::text is null or c.session_id = ${query.session ?? null})
          and (${query.run ?? null}::text is null or c.run_id = ${query.run ?? null})
          and (${pattern}::text is null
            or c.tool ilike ${pattern} or ${appNamed}
            or c.user_name ilike ${pattern} or c.source_name ilike ${pattern}
            or exists (select 1 from hosted_tool_call_accounts a
              where a.call_id = c.id and ${shown} and a.account_name ilike ${pattern}))`;
    const after: Statement.Fragment =
      cursor === undefined
        ? sql`true`
        : sql`(c.started_at, c.id) < (${cursor.startedAt}::timestamptz, ${cursor.id})`;
    const read = Effect.gen(function* () {
      const rows = yield* sql`select c.id,
          (extract(epoch from c.started_at) * 1000)::float8 as started_ms,
          to_char(c.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as started_text,
          c.user_id, c.user_name, case when um.id is null then null else u.email end as user_email,
          case when um.id is null then null else u.image end as user_image,
          um.id is not null as user_member,
          c.source, c.source_id, c.source_name,
          (select oc.icon from "mcpGrant" g join "oauthClient" oc on oc."clientId" = g."clientId"
            where c.source = 'agent' and g.id = c.source_id) as source_icon,
          c.connection_id, c.connection_name,
          c.session_id, c.run_id,
          c.app_id, c.app_name, c.version_id, c.tool, c.kind, ${status} as status,
          c.error_type, c.status_code, c.approval_id,
          (extract(epoch from c.approval_expires_at) * 1000)::float8 as expires_ms,
          c.decided_by, c.decided_by_name,
          case when dm.id is null then null else d.email end as decided_email,
          case when dm.id is null then null else d.image end as decided_image,
          dm.id is not null as decided_member,
          (extract(epoch from coalesce(c.decided_at,
            case when ${status} = 'expired' then c.approval_expires_at end)) * 1000)::float8
            as decided_ms,
          c.duration_ms,
          coalesce((select json_agg(json_build_object(
                'id', case when ${shown} then a.account_id end,
                'name', case when ${shown} then a.account_name end)
              order by ${shown} desc, case when ${shown} then a.account_name end)
            from hosted_tool_call_accounts a where a.call_id = c.id), '[]'::json)::text as accounts
        from hosted_tool_calls c
        left join "user" u on u.id = c.user_id
        left join member um on um."organizationId" = c.organization_id and um."userId" = c.user_id
        left join "user" d on d.id = c.decided_by
        left join member dm on dm."organizationId" = c.organization_id and dm."userId" = c.decided_by
        where ${matching} and ${after}
        order by c.started_at desc, c.id desc
        limit ${limit + 1}`;
      const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(CallRow))(rows);
      const page = decoded.slice(0, limit);
      // How many calls of each of the page's runs this viewer may see, in one grouped read.
      const runIds = [...new Set(page.flatMap((row) => (row.run_id === null ? [] : [row.run_id])))];
      const runs =
        runIds.length === 0
          ? []
          : yield* sql`select run_id as id, count(*)::int as calls from hosted_tool_calls
              where organization_id = ${access.organization} and ${sql.in("run_id", runIds)}
                and (${access.own}::text is null or user_id = ${access.own})
                and started_at >= ${kept}::timestamptz
              group by run_id`.pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.Array(Schema.Struct({ id: Schema.String, calls: Schema.Number })),
                ),
              ),
            );
      // The count reads at most one row past the limit, so its cost is bounded however many match.
      const counted = yield* sql`select count(*)::int as count from (
          select 1 from hosted_tool_calls c where ${matching} limit ${toolCallCountLimit + 1}) t`;
      const { count } = yield* Schema.decodeUnknownEffect(Schema.Struct({ count: Schema.Number }))(
        counted[0],
      );
      return { decoded, page, runs, count };
    });
    const { decoded, page, runs, count } = yield* bounded(read);
    const last = page.at(-1);
    const usable = yield* usableApps(page.map((row) => row.app_id));
    const told = namedFor(access.member, usable);
    const runCalls = new Map(runs.map((run) => [run.id, run.calls]));
    return {
      items: page.map((row) => ({
        ...toCall(row, told),
        run: row.run_id === null ? null : { id: row.run_id, calls: runCalls.get(row.run_id) ?? 1 },
      })),
      ...(decoded.length > limit && last !== undefined
        ? { next: cursorOf(last.started_text, last.id) }
        : {}),
      total: Math.min(count, toolCallCountLimit),
      totalCapped: count > toolCallCountLimit,
      apps: usable,
    };
  });

const Choice = Schema.Struct({ id: Schema.String, name: NullableString });
const listFilters = (range: ToolCallRange | undefined) =>
  Effect.gen(function* () {
    const access = yield* viewer;
    const sql = yield* policyDatabase;
    const now = yield* Clock.currentTimeMillis;
    const since = new Date(now - rangeMillis[range ?? "7d"]).toISOString();
    const visible: Statement.Fragment = sql`c.organization_id = ${access.organization}
      and (${access.own}::text is null or c.user_id = ${access.own})
      and c.started_at >= ${since}::timestamptz`;
    // Each choice is named as its latest call names it; each list holds the most recently called.
    const read = Effect.gen(function* () {
      const members = yield* sql`select c.user_id as id,
          (array_agg(c.user_name order by c.started_at desc))[1] as name,
          max(case when m.id is null then null else u.email end) as email,
          max(case when m.id is null then null else u.image end) as image
        from hosted_tool_calls c left join "user" u on u.id = c.user_id
        left join member m on m."organizationId" = c.organization_id and m."userId" = c.user_id
        where ${visible} and c.user_id is not null
        group by c.user_id order by max(c.started_at) desc limit ${toolCallFilterChoices}`;
      const apps = yield* sql`select c.app_id as id,
          (array_agg(c.app_name order by c.started_at desc))[1] as name
        from hosted_tool_calls c where ${visible}
        group by c.app_id order by max(c.started_at) desc limit ${toolCallFilterChoices}`;
      // The logo is the client's own, read now: the log copies only its name.
      const agents = yield* sql`select a.source, a.id, a.name,
          (select oc.icon from "mcpGrant" g join "oauthClient" oc on oc."clientId" = g."clientId"
            where a.source = 'agent' and g.id = a.id) as icon
        from (select c.source, c.source_id as id,
            (array_agg(c.source_name order by c.started_at desc))[1] as name,
            max(c.started_at) as latest
          from hosted_tool_calls c where ${visible} and c.source_id is not null
          group by c.source, c.source_id order by max(c.started_at) desc
          limit ${toolCallFilterChoices}) a
        order by a.latest desc`;
      const connections = yield* sql`select c.connection_id as id,
          (array_agg(c.connection_name order by c.started_at desc))[1] as name
        from hosted_tool_calls c where ${visible} and c.connection_id is not null
        group by c.connection_id order by max(c.started_at) desc limit ${toolCallFilterChoices}`;
      return {
        members: yield* Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({ ...Choice.fields, email: NullableString, image: NullableString }),
          ),
        )(members),
        apps: yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ id: AppId, name: Schema.String })),
        )(apps),
        agents: yield* Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({ ...Choice.fields, source: ToolCallSource, icon: NullableString }),
          ),
        )(agents),
        connections: yield* Schema.decodeUnknownEffect(Schema.Array(Choice))(connections),
      };
    });
    const choices = yield* bounded(read);
    const usable = yield* usableApps(choices.apps.map(({ id }) => id));
    const named = namedFor(access.member, usable);
    const byName = (left: string | null, right: string | null) =>
      (left ?? "￿").localeCompare(right ?? "￿");
    return {
      members: [...choices.members].sort((a, b) => byName(a.name, b.name)),
      apps: choices.apps
        .map((app) => ({ id: app.id, name: named(app.id) ? app.name : null }))
        .sort((a, b) => byName(a.name, b.name)),
      agents: [...choices.agents].sort((a, b) => byName(a.name, b.name)),
      connections: [...choices.connections].sort((a, b) => byName(a.name, b.name)),
      appRecords: usable,
    };
  });

/** The tool call log's read API. */
export const hostedToolCallHandlers = HttpApiBuilder.group(HostedApi, "toolCalls", (handlers) =>
  handlers
    .handle("list", ({ query }) => listCalls(query))
    .handle("filters", ({ query }) => listFilters(query.range)),
);
