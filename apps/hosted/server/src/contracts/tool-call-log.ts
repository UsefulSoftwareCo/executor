/**
 * The tool call log: one row per app tool call a hosted caller starts, kept 30 days. It records
 * who called which tool and how the call ended; never its arguments, its result or any text the
 * app or a service replied with.
 */
import {
  App,
  AppId,
  Cursor,
  RequestInvalid,
  StorageError,
  ToolKind,
  ToolName,
} from "@executor-js/sdk/core";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { Context, Effect, Schema, SchemaAST } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { AuthenticationUnavailable } from "./auth.ts";
import { RequiredAction } from "./authorization.ts";
import {
  OrganizationForbidden,
  OrganizationReference,
  RequireOrganization,
} from "./organization.ts";

/**
 * A call's reference: what a caller quotes to an administrator. `call_` and 14 lowercase
 * Crockford base32 characters (70 random bits), minted in process when the call starts.
 */
export const ToolCallId = Schema.String.check(
  Schema.isPattern(/^call_[0-9a-hjkmnp-tv-z]{14}$/u),
).pipe(Schema.brand("ToolCallId"));
export type ToolCallId = typeof ToolCallId.Type;

/** Who started a call, as the log records it. */
export const ToolCallSource = Schema.Literals([
  "agent",
  "api-key",
  "dashboard",
  "schedule",
  "webhook",
  "workflow",
]);
export type ToolCallSource = typeof ToolCallSource.Type;

/**
 * What the request a call arrives on says about its caller. `sourceId` is the agent's grant (an
 * MCP or API OAuth grant, the row on the Connections tab) or the API key; the dashboard has none.
 * `session` is the MCP session the request named, `execution` the MCP execution it ran in.
 */
export interface ToolCallCaller {
  readonly source: ToolCallSource;
  readonly sourceId?: string | undefined;
  readonly session?: string | undefined;
  readonly execution?: string | undefined;
}

/**
 * The caller of the hosted API request being served, which its tool calls are logged under. Set by
 * the organization middleware for bearer and session requests; unset elsewhere.
 */
export const CurrentToolCallCaller = Context.Reference<ToolCallCaller | undefined>(
  "hosted/CurrentToolCallCaller",
  { defaultValue: () => undefined },
);

/** An error an endpoint declares, with its own reference added. */
export type ReferencedError<S extends Schema.Top> = Schema.Codec<
  S["Type"] & { readonly reference?: ToolCallId },
  S["Encoded"] & { readonly reference?: string },
  S["DecodingServices"],
  S["EncodingServices"]
>;
/** The parts of a declared error class that adding a field reads at runtime. */
interface DeclaredErrorClass {
  readonly identifier: string;
  readonly ast: SchemaAST.AST;
  readonly fields: Schema.Struct.Fields;
  readonly extend: (
    identifier: string,
  ) => (
    fields: Schema.Struct.Fields,
    annotations: { readonly httpApiStatus?: number; readonly description?: string },
  ) => unknown;
}
interface ReferencedClass {
  readonly make: (input: object, options: Schema.MakeOptions) => unknown;
}

/**
 * Declare an endpoint's errors with the failed tool call's reference as their own `reference`
 * field, beside the error's fields and never inside its message: what a caller quotes to an
 * administrator, who searches the tool call log with it. Each error keeps its tag, fields, status
 * and description, and decodes as an instance of its own class, so callers match it as before. Its
 * schema is named `<identifier>WithReference`, so the API document's other uses of the error stay
 * without the field.
 *
 * The endpoint encodes only instances of these subclasses: the plain error fails to encode, as a
 * defect. `withReference` makes any failure of the endpoint one, with the reference when the call
 * has a row in the log, and `referenced` applies it to everything a handler fails with.
 */
export const referencedErrors = <
  const Errors extends ReadonlyArray<Schema.Top & DeclaredErrorClass>,
>(
  errors: Errors,
) => {
  // An error listed twice gets one subclass, so the API document names it once.
  const built = new Map<Schema.Top, ReferencedClass & Schema.Top>();
  const pairs = errors.map((error) => {
    const known = built.get(error);
    if (known !== undefined) return { error, referenced: known };
    const status = SchemaAST.resolveAt<number>("httpApiStatus")(error.ast);
    const description = SchemaAST.resolveAt<string>("description")(error.ast);
    // The API document describes an error from its encoded struct, whose annotations `extend`
    // does not carry over; the subclass's gets the error's own.
    const documented = SchemaAST.resolveAt<string>("description")(Schema.toEncoded(error).ast);
    const extended = error.extend(`${error.identifier}WithReference`)(
      { reference: Schema.optionalKey(ToolCallId) },
      {
        ...(status === undefined ? {} : { httpApiStatus: status }),
        ...(description === undefined ? {} : { description }),
      },
    );
    if (!Schema.isSchema(extended)) throw new Error(`${error.identifier} cannot add a reference`);
    const annotated =
      documented === undefined
        ? extended
        : extended.pipe(Schema.annotateEncoded({ description: documented }));
    // SAFETY: `extend` builds a schema-backed subclass of the error's class with the same fields,
    // tag, status and description, plus an optional `reference` decoded as a ToolCallId; annotating
    // its encoded side keeps its declaration and `make`. Its instances are instances of the error's
    // class; `make` and the encoded form gain only that field. `extend`'s precise type needs the
    // subclass's own `Self`, which a generic list cannot name, hence the cast.
    const referenced = annotated as unknown as ReferencedClass & Schema.Top;
    built.set(error, referenced);
    return { error, referenced };
  });
  const withReference = <E>(error: E, reference: ToolCallId | undefined): E => {
    const pair = pairs.find((candidate) => Schema.is(candidate.error)(error));
    if (pair === undefined || typeof error !== "object" || error === null) return error;
    // An error that already carries a reference keeps it.
    const kept = Schema.is(pair.referenced)(error) && reference === undefined;
    if (kept) return error;
    // The error's own fields, read by name: a spread would drop `cause`, which an error instance
    // holds as a non-enumerable property, as `Error` does.
    const fields = Object.fromEntries(
      Object.keys(pair.error.fields).flatMap((field) =>
        Object.hasOwn(error, field) ? [[field, Reflect.get(error, field)]] : [],
      ),
    );
    // SAFETY: the subclass's instances are instances of the error's own class, `E`. The fields
    // come from an instance of that class, so they are not checked again.
    return pair.referenced.make(
      { ...fields, ...(reference === undefined ? {} : { reference }) },
      { disableChecks: true },
    ) as E;
  };
  return {
    // SAFETY: each member is the subclass built above for the error at the same position.
    errors: pairs.map(({ referenced }) => referenced) as unknown as {
      readonly [Key in keyof Errors]: ReferencedError<Errors[Key]>;
    },
    withReference,
    /** Make every failure of a handler one the endpoint encodes, keeping any reference it has. */
    referenced: <A, E, R>(handler: Effect.Effect<A, E, R>) =>
      Effect.mapError(handler, (error) => withReference(error, undefined)),
  };
};

/** How a call ended, or that it waits for approval. A lapsed approval reads as `expired`. */
export const ToolCallStatus = Schema.Literals([
  "awaiting-approval",
  "succeeded",
  "failed",
  "denied",
  "expired",
]);
export type ToolCallStatus = typeof ToolCallStatus.Type;
/** The period a list covers, ending now. Rows are kept 30 days. */
export const ToolCallRange = Schema.Literals(["24h", "7d", "30d"]);
export type ToolCallRange = typeof ToolCallRange.Type;
/** The most rows a list counts; a larger total is reported as at least this many. */
export const toolCallCountLimit = 10_000;
/** The most choices each of the filter menu's lists holds. */
export const toolCallFilterChoices = 200;
/** Rows one page holds when the caller gives no limit, and the most it may ask for. */
export const toolCallPage = { default: 50, maximum: 200 } as const;

const Text = Schema.NonEmptyString.check(Schema.isMaxLength(256));
/** What the log lists, and of which calls. Every filter narrows; none widens what a member sees. */
export const ToolCallQuery = Schema.Struct({
  /** `7d` when omitted. */
  range: Schema.optional(ToolCallRange),
  /** A member's user ID. */
  member: Schema.optional(Text),
  app: Schema.optional(AppId),
  tool: Schema.optional(ToolName),
  status: Schema.optional(ToolCallStatus),
  source: Schema.optional(ToolCallSource),
  /** The agent's grant or the API key that made the call. */
  agent: Schema.optional(Text),
  connection: Schema.optional(Text),
  session: Schema.optional(Text),
  run: Schema.optional(Text),
  /**
   * Words matched in the tool, app, member, agent and account names. Text that is exactly a call
   * reference finds that call alone, whatever the other filters and the range.
   */
  search: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: toolCallPage.maximum }),
    ),
  ),
});
export type ToolCallQuery = typeof ToolCallQuery.Type;

/**
 * A user as the log names them: the name copied when it was written, and their email and picture
 * while they are a member of the organization. Someone who has left, or was deleted, has neither.
 */
export const ToolCallPerson = Schema.Struct({
  /** Null once the user is deleted. */
  id: Schema.NullOr(Schema.String),
  /** Whether they are a member of the organization now. */
  member: Schema.Boolean,
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  image: Schema.NullOr(Schema.String),
});
/** One logged call. Arguments, results and any text an app or service replied with are never kept. */
export const ToolCall = Schema.Struct({
  id: ToolCallId,
  startedAt: Schema.Date,
  /** Who the call ran as; null when the app ran it on its own, such as a schedule or webhook. */
  member: Schema.NullOr(ToolCallPerson),
  source: Schema.Struct({
    kind: ToolCallSource,
    /** The agent's grant or the API key; null for the dashboard. */
    id: Schema.NullOr(Schema.String),
    /** The agent's client or the key's name when the call was made. */
    name: Schema.NullOr(Schema.String),
    /**
     * The logo URL the agent's client registered (`logo_uri`), read through its grant; null for
     * other sources and once the grant is gone. Self-declared like the name.
     */
    icon: Schema.NullOr(Schema.String),
  }),
  connection: Schema.NullOr(
    Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) }),
  ),
  /** The MCP session the call arrived on. */
  session: Schema.NullOr(Schema.String),
  /** The MCP execution that made it: one `execute` program or one `call` batch. */
  run: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      /** Calls in the run that this viewer may see, this one included. */
      calls: Schema.Int,
    }),
  ),
  app: Schema.Struct({
    id: AppId,
    /**
     * The app's name when the call was made. Null for a member who can no longer use the app: an
     * app's name is shown only to people who may use it, and to owners and admins.
     */
    name: Schema.NullOr(Schema.String),
  }),
  /**
   * The tool's name as the caller asked for it. Null when the app has no such tool: the name was
   * then only the caller's own text.
   */
  tool: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(ToolKind),
  /**
   * The accounts the call ran with. An account is named only to the member it belongs to; to
   * everyone else, owners and admins included, it is an account with no ID or name.
   */
  accounts: Schema.Array(
    Schema.Struct({
      id: Schema.NullOr(Schema.String),
      name: Schema.NullOr(Schema.String),
    }),
  ),
  status: ToolCallStatus,
  /** Executor's name for the failure, such as `ToolCallFailed`; never the failure's text. */
  errorType: Schema.NullOr(Schema.String),
  /** The service's HTTP status, when the failure named one. */
  statusCode: Schema.NullOr(Schema.Int),
  /** Null for a call that never asked for approval. */
  approval: Schema.NullOr(
    Schema.Struct({
      decision: Schema.Literals(["pending", "approved", "denied", "expired"]),
      expiresAt: Schema.Date,
      /** Who answered; null while pending and for a lapsed request. */
      decidedBy: Schema.NullOr(ToolCallPerson),
      decidedAt: Schema.NullOr(Schema.Date),
    }),
  ),
  /** Running time, a resumed call's included; null if it was not recorded. */
  durationMs: Schema.NullOr(Schema.Int),
  version: Schema.NullOr(Schema.String),
});
export type ToolCall = typeof ToolCall.Type;
/**
 * One page, newest first. `total` counts every call the query matches, up to
 * `toolCallCountLimit`; `totalCapped` says there are more. `apps` are the current records of the
 * page's apps that still exist, for their icons; a call names its app by the name it had.
 */
export const ToolCallPage = Schema.Struct({
  items: Schema.Array(ToolCall),
  next: Schema.optional(Cursor),
  total: Schema.Int,
  totalCapped: Schema.Boolean,
  apps: Schema.Array(App),
});
export type ToolCallPage = typeof ToolCallPage.Type;
/**
 * What the filter menu offers in a range: the members, apps and agents with calls this viewer may
 * see, each named as its latest call names it, with the current records of the apps the viewer may
 * use, for their icons. Each list holds at most `toolCallFilterChoices`, the most recently called
 * first. A member is not told the name of an app they can no longer use.
 */
export const ToolCallFilters = Schema.Struct({
  members: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.NullOr(Schema.String),
      email: Schema.NullOr(Schema.String),
      image: Schema.NullOr(Schema.String),
    }),
  ),
  apps: Schema.Array(Schema.Struct({ id: AppId, name: Schema.NullOr(Schema.String) })),
  agents: Schema.Array(
    Schema.Struct({
      source: ToolCallSource,
      id: Schema.String,
      name: Schema.NullOr(Schema.String),
      /** As the call's `source.icon`. */
      icon: Schema.NullOr(Schema.String),
    }),
  ),
  connections: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) }),
  ),
  appRecords: Schema.Array(App),
});
export type ToolCallFilters = typeof ToolCallFilters.Type;

/**
 * A read of the log took longer than it may, as a search that matches few of many calls can. It is
 * stopped rather than left to hold up the organization's other work; trying again may finish, and
 * a narrower range, filter or search reads less.
 */
export const ToolCallLogBusy = UserFacingError.define({
  tag: "ToolCallLogBusy",
  status: 503,
  title: "Tool calls took too long to read",
  description: "Executor stopped reading the tool call log because it took too long.",
  recovery: {
    action: "Try again, or narrow the time range, filters or search.",
    instructions:
      "Read the tool call log again with a shorter range, a filter such as the app or member, or a more specific search. Do not retry in a loop.",
  },
  retryable: true,
});
export type ToolCallLogBusy = typeof ToolCallLogBusy.Type;

const path = "/api/organizations/:organization/tool-calls";
const organization = { organization: OrganizationReference };
const errors = [
  AuthenticationUnavailable,
  OrganizationForbidden,
  StorageError,
  ToolCallLogBusy,
] as const;
/**
 * The organization's tool call log, read by the dashboard and, through the Executor app, by agents.
 * Owners and admins see every call; members see only their own, whatever they filter by. Browser
 * sessions and bearer credentials with the `read` action are accepted, as on other read routes.
 */
export const HostedToolCalls = HttpApiGroup.make("toolCalls")
  .add(
    HttpApiEndpoint.get("list", path, {
      params: organization,
      query: ToolCallQuery,
      success: ToolCallPage,
      error: [...errors, RequestInvalid],
    })
      .annotate(RequiredAction, "read")
      .annotate(
        OpenApi.Description,
        "List the organization's logged tool calls, newest first. Owners and admins see every call; members see only their own. A search that is exactly a call reference returns that call alone. Each call has its start time (startedAt), running time (durationMs), status, app, tool and the agent or key that made it (source).",
      ),
  )
  .add(
    HttpApiEndpoint.get("filters", `${path}/filters`, {
      params: organization,
      query: Schema.Struct({ range: Schema.optional(ToolCallRange) }),
      success: ToolCallFilters,
      error: errors,
    })
      .annotate(RequiredAction, "read")
      .annotate(
        OpenApi.Description,
        "The members, apps, agents and connections with logged calls in the range that the caller may see: every member's for owners and admins, only their own for members.",
      ),
  )
  .middleware(RequireOrganization);
