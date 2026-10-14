/**
 * Import of a single-member Executor v1 workspace (`notes/v1-import.md`). The browser drives it:
 * preview, start, one request per item in dependency order, finish. The server checks the
 * caller's eligibility on every request.
 */
import { OrganizationId, RequireUser, type McpConnectionStore } from "@executor-js/hosted-server";
import type { Executor } from "@executor-js/sdk/core";
import { ApiError } from "@executor-js/utils/api-error";
import { Context, Effect, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import type { SqlClient } from "effect/sql";

/** A WorkOS organization id in Executor v1. */
export const V1OrganizationId = Schema.String.check(
  Schema.isPattern(/^org_[A-Za-z0-9]{1,64}$/u),
).pipe(Schema.brand("V1OrganizationId"));
export type V1OrganizationId = typeof V1OrganizationId.Type;

/** The v1 records an import moves. Organizations are created by `start`, not posted as items. */
export const V1ItemKind = Schema.Literals([
  "integration",
  "connection",
  "tool_policy",
  "toolkit",
  "artifact",
]);
export type V1ItemKind = typeof V1ItemKind.Type;
/** A v1 row's `row_id`, unique across v1 tenants. */
export const V1ItemId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(255),
  Schema.isPattern(/^[A-Za-z0-9_.:~-]+$/u),
);
export const V1ItemKey = Schema.Struct({ kind: V1ItemKind, id: V1ItemId });
export type V1ItemKey = typeof V1ItemKey.Type;

/**
 * What importing an item will do. `skipped` items have nothing to import, such as a policy v1
 * never applied; they are not failures and do not hold back the workspace. A `will_import` note
 * says what to know beforehand, such as an artifact that will need repair.
 */
export const V1ItemPlan = Schema.Union([
  Schema.Struct({ status: Schema.Literal("will_import"), note: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ status: Schema.Literal("unsupported"), reason: Schema.String }),
  Schema.Struct({ status: Schema.Literal("skipped"), reason: Schema.String }),
]);
export type V1ItemPlan = typeof V1ItemPlan.Type;
/**
 * What one item request did. `v2Id` names the app, account or MCP connection it created (for a
 * connection, the account it linked to its app);
 * `note` says what the user should know about it, such as a v1 tool name it dropped.
 * `needsRepair` marks an app imported as source without a deployment, which does not run until it
 * is fixed; its note says what to fix.
 */
export const V1ItemResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("imported"),
    v2Id: Schema.String,
    note: Schema.optionalKey(Schema.String),
    needsRepair: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.Struct({ status: Schema.Literal("failed"), reason: Schema.String }),
  Schema.Struct({ status: Schema.Literal("skipped"), reason: Schema.String }),
]);
export type V1ItemResult = typeof V1ItemResult.Type;

export const V1ImportItem = Schema.Struct({
  ...V1ItemKey.fields,
  /** What the user recognizes: the integration, connection, toolkit or artifact name, or the pattern. */
  label: Schema.String,
  /** The integration a connection, policy or artifact belongs to, by label. */
  context: Schema.NullOr(Schema.String),
  /** The host of the integration's address, for its logo. Never a path or query, which can hold keys. */
  host: Schema.NullOr(Schema.String),
  /** Items to post before this one. */
  dependsOn: Schema.Array(V1ItemKey),
  plan: V1ItemPlan,
  /** The last attempt, once the import has started. */
  result: Schema.NullOr(V1ItemResult),
});
export type V1ImportItem = typeof V1ImportItem.Type;

/** The organization an import writes into, once started. */
export const V1ImportTarget = Schema.Struct({
  id: OrganizationId,
  name: Schema.String,
  slug: Schema.NonEmptyString,
});
export const V1ImportPreview = Schema.Struct({
  organization: Schema.Struct({ id: V1OrganizationId, name: Schema.String }),
  /** Items in the order the browser posts them. */
  items: Schema.Array(V1ImportItem),
  target: Schema.NullOr(V1ImportTarget),
});
export type V1ImportPreview = typeof V1ImportPreview.Type;

/** Why an organization cannot be imported by this caller. */
export const V1Ineligibility = Schema.Literals([
  "not_member",
  "multiple_members",
  "paid",
  "no_verified_email",
]);
export const V1OrganizationChoice = Schema.Struct({
  id: V1OrganizationId,
  name: Schema.String,
  eligible: Schema.Boolean,
  reason: Schema.NullOr(V1Ineligibility),
  /** The v2 organization an earlier start chose. */
  target: Schema.NullOr(V1ImportTarget),
  /** The workspace's v1 dashboard once imported, for a way back. Null before, or without a v1 slug. */
  v1Url: Schema.NullOr(Schema.String),
});
export const V1ImportChoices = Schema.Struct({
  organizations: Schema.Array(V1OrganizationChoice),
  /** v2 organizations the caller owns and can import into. */
  owned: Schema.Array(V1ImportTarget),
});
export type V1ImportChoices = typeof V1ImportChoices.Type;

export const V1ImportStart = Schema.Struct({
  target: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("new") }),
    Schema.Struct({ kind: Schema.Literal("existing"), organization: OrganizationId }),
  ]),
});
export type V1ImportStart = typeof V1ImportStart.Type;

export const V1ImportUnavailable = ApiError.define({
  tag: "V1ImportUnavailable",
  status: 503,
  message: "Importing from Executor v1 is unavailable. Try again later.",
});
export type V1ImportUnavailable = typeof V1ImportUnavailable.Type;
export const V1ImportNotEligible = ApiError.define({
  tag: "V1ImportNotEligible",
  status: 403,
  fields: { reason: V1Ineligibility },
  message: (error) =>
    error.reason === "multiple_members"
      ? "Only workspaces with one member can be imported for now."
      : error.reason === "paid"
        ? "Workspaces on a paid plan are moved by the Executor team. Contact support."
        : error.reason === "no_verified_email"
          ? "Verify your email address to import a workspace."
          : "You are not the member of this Executor v1 workspace.",
});
export type V1ImportNotEligible = typeof V1ImportNotEligible.Type;
export const V1ImportNotStarted = ApiError.define({
  tag: "V1ImportNotStarted",
  status: 409,
  message: "Start the import before importing its items.",
});
export type V1ImportNotStarted = typeof V1ImportNotStarted.Type;
export const V1ImportTargetForbidden = ApiError.define({
  tag: "V1ImportTargetForbidden",
  status: 403,
  message: "Import into an organization you own.",
});
export type V1ImportTargetForbidden = typeof V1ImportTargetForbidden.Type;
export const V1ImportItemNotFound = ApiError.define({
  tag: "V1ImportItemNotFound",
  status: 404,
  message: "This item is not in the Executor v1 workspace.",
});
export type V1ImportItemNotFound = typeof V1ImportItemNotFound.Type;
export const V1ImportDependencyPending = ApiError.define({
  tag: "V1ImportDependencyPending",
  status: 409,
  fields: { dependency: V1ItemKey },
  message: "Import this item's dependencies first.",
});
export type V1ImportDependencyPending = typeof V1ImportDependencyPending.Type;

export type V1ImportError = V1ImportUnavailable | V1ImportNotEligible;

/** The product database on the request's connection, shared with the executor's writes. */
export class V1ImportDatabase extends Context.Service<
  V1ImportDatabase,
  Effect.Effect<SqlClient.SqlClient, V1ImportUnavailable>
>()("cloud/V1ImportDatabase") {}
/** The request's executor and product database connection, which handlers resolve. */
export interface V1ImportRequest {
  readonly executor: Executor;
  /** The signed-in user's scoped MCP connections, which toolkits become. */
  readonly connections: McpConnectionStore;
  readonly sql: SqlClient.SqlClient;
  /** The signed-in v2 user. */
  readonly user: string;
}

export class V1Import extends Context.Service<
  V1Import,
  {
    /** The caller's v1 workspaces and the v2 organizations they could import into. */
    readonly choices: (
      request: V1ImportRequest,
    ) => Effect.Effect<V1ImportChoices, V1ImportUnavailable>;
    readonly preview: (
      request: V1ImportRequest,
      organization: V1OrganizationId,
    ) => Effect.Effect<V1ImportPreview, V1ImportError>;
    readonly start: (
      request: V1ImportRequest,
      organization: V1OrganizationId,
      input: V1ImportStart,
    ) => Effect.Effect<V1ImportPreview, V1ImportError | V1ImportTargetForbidden>;
    readonly item: (
      request: V1ImportRequest,
      organization: V1OrganizationId,
      item: V1ItemKey,
    ) => Effect.Effect<
      V1ItemResult,
      V1ImportError | V1ImportNotStarted | V1ImportItemNotFound | V1ImportDependencyPending
    >;
    readonly finish: (
      request: V1ImportRequest,
      organization: V1OrganizationId,
    ) => Effect.Effect<V1ImportPreview, V1ImportError | V1ImportNotStarted>;
  }
>()("cloud/V1Import") {}

const params = { organization: V1OrganizationId };
export const v1ImportGroup = HttpApiGroup.make("v1Import")
  .add(
    HttpApiEndpoint.get("choices", "/api/v1-import", {
      success: V1ImportChoices,
      error: V1ImportUnavailable,
    }),
  )
  .add(
    HttpApiEndpoint.get("preview", "/api/v1-import/:organization", {
      params,
      success: V1ImportPreview,
      error: [V1ImportUnavailable, V1ImportNotEligible],
    }),
  )
  .add(
    HttpApiEndpoint.post("start", "/api/v1-import/:organization/start", {
      params,
      payload: V1ImportStart,
      success: V1ImportPreview,
      error: [V1ImportUnavailable, V1ImportNotEligible, V1ImportTargetForbidden],
    }),
  )
  .add(
    HttpApiEndpoint.post("item", "/api/v1-import/:organization/items/:kind/:id", {
      params: { ...params, kind: V1ItemKind, id: V1ItemId },
      success: V1ItemResult,
      error: [
        V1ImportUnavailable,
        V1ImportNotEligible,
        V1ImportNotStarted,
        V1ImportItemNotFound,
        V1ImportDependencyPending,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("finish", "/api/v1-import/:organization/finish", {
      params,
      success: V1ImportPreview,
      error: [V1ImportUnavailable, V1ImportNotEligible, V1ImportNotStarted],
    }),
  )
  .middleware(RequireUser);
