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

export const ToolCallId = Schema.String.check(
  Schema.isPattern(/^call_[0-9a-hjkmnp-tv-z]{14}$/u),
).pipe(Schema.brand("ToolCallId"));
export type ToolCallId = typeof ToolCallId.Type;

export const ToolCallSource = Schema.Literals([
  "agent",
  "api-key",
  "dashboard",
  "schedule",
  "webhook",
  "workflow",
]);
export type ToolCallSource = typeof ToolCallSource.Type;

export interface ToolCallCaller {
  readonly source: ToolCallSource;
  readonly sourceId?: string | undefined;
  readonly session?: string | undefined;
  readonly execution?: string | undefined;
}

export const CurrentToolCallCaller = Context.Reference<ToolCallCaller | undefined>(
  "hosted/CurrentToolCallCaller",
  { defaultValue: () => undefined },
);

export type ReferencedError<S extends Schema.Top> = Schema.Codec<
  S["Type"] & { readonly reference?: ToolCallId },
  S["Encoded"] & { readonly reference?: string },
  S["DecodingServices"],
  S["EncodingServices"]
>;
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

export const referencedErrors = <
  const Errors extends ReadonlyArray<Schema.Top & DeclaredErrorClass>,
>(
  errors: Errors,
) => {
  const built = new Map<Schema.Top, ReferencedClass & Schema.Top>();
  const pairs = errors.map((error) => {
    const known = built.get(error);
    if (known !== undefined) return { error, referenced: known };
    const status = SchemaAST.resolveAt<number>("httpApiStatus")(error.ast);
    const description = SchemaAST.resolveAt<string>("description")(error.ast);
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
    const referenced = annotated as unknown as ReferencedClass & Schema.Top;
    built.set(error, referenced);
    return { error, referenced };
  });
  const withReference = <E>(error: E, reference: ToolCallId | undefined): E => {
    const pair = pairs.find((candidate) => Schema.is(candidate.error)(error));
    if (pair === undefined || typeof error !== "object" || error === null) return error;
    const kept = Schema.is(pair.referenced)(error) && reference === undefined;
    if (kept) return error;
    const fields = Object.fromEntries(
      Object.keys(pair.error.fields).flatMap((field) =>
        Object.hasOwn(error, field) ? [[field, Reflect.get(error, field)]] : [],
      ),
    );
    return pair.referenced.make(
      { ...fields, ...(reference === undefined ? {} : { reference }) },
      { disableChecks: true },
    ) as E;
  };
  return {
    errors: pairs.map(({ referenced }) => referenced) as unknown as {
      readonly [Key in keyof Errors]: ReferencedError<Errors[Key]>;
    },
    withReference,
    referenced: <A, E, R>(handler: Effect.Effect<A, E, R>) =>
      Effect.mapError(handler, (error) => withReference(error, undefined)),
  };
};

export const ToolCallStatus = Schema.Literals([
  "awaiting-approval",
  "succeeded",
  "failed",
  "denied",
  "expired",
]);
export type ToolCallStatus = typeof ToolCallStatus.Type;
export const ToolCallRange = Schema.Literals(["24h", "7d", "30d"]);
export type ToolCallRange = typeof ToolCallRange.Type;
export const toolCallCountLimit = 10_000;
export const toolCallFilterChoices = 200;
export const toolCallPage = { default: 50, maximum: 200 } as const;

const Text = Schema.NonEmptyString.check(Schema.isMaxLength(256));
export const ToolCallQuery = Schema.Struct({
  range: Schema.optional(ToolCallRange),
  member: Schema.optional(Text),
  app: Schema.optional(AppId),
  tool: Schema.optional(ToolName),
  status: Schema.optional(ToolCallStatus),
  source: Schema.optional(ToolCallSource),
  agent: Schema.optional(Text),
  connection: Schema.optional(Text),
  session: Schema.optional(Text),
  run: Schema.optional(Text),
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

export const ToolCallPerson = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  member: Schema.Boolean,
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  image: Schema.NullOr(Schema.String),
});
export const ToolCall = Schema.Struct({
  id: ToolCallId,
  startedAt: Schema.Date,
  member: Schema.NullOr(ToolCallPerson),
  source: Schema.Struct({
    kind: ToolCallSource,
    id: Schema.NullOr(Schema.String),
    name: Schema.NullOr(Schema.String),
    icon: Schema.NullOr(Schema.String),
  }),
  connection: Schema.NullOr(
    Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) }),
  ),
  session: Schema.NullOr(Schema.String),
  run: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      calls: Schema.Int,
    }),
  ),
  app: Schema.Struct({
    id: AppId,
    name: Schema.NullOr(Schema.String),
  }),
  tool: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(ToolKind),
  accounts: Schema.Array(
    Schema.Struct({
      id: Schema.NullOr(Schema.String),
      name: Schema.NullOr(Schema.String),
    }),
  ),
  status: ToolCallStatus,
  errorType: Schema.NullOr(Schema.String),
  statusCode: Schema.NullOr(Schema.Int),
  approval: Schema.NullOr(
    Schema.Struct({
      decision: Schema.Literals(["pending", "approved", "denied", "expired"]),
      expiresAt: Schema.Date,
      decidedBy: Schema.NullOr(ToolCallPerson),
      decidedAt: Schema.NullOr(Schema.Date),
    }),
  ),
  durationMs: Schema.NullOr(Schema.Int),
  version: Schema.NullOr(Schema.String),
});
export type ToolCall = typeof ToolCall.Type;
export const ToolCallPage = Schema.Struct({
  items: Schema.Array(ToolCall),
  next: Schema.optional(Cursor),
  total: Schema.Int,
  totalCapped: Schema.Boolean,
  apps: Schema.Array(App),
});
export type ToolCallPage = typeof ToolCallPage.Type;
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
      icon: Schema.NullOr(Schema.String),
    }),
  ),
  connections: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) }),
  ),
  appRecords: Schema.Array(App),
});
export type ToolCallFilters = typeof ToolCallFilters.Type;

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
