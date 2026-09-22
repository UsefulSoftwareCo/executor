/** Shared contract primitives: IDs, ownership, JSON, pagination and write-only secrets. */
import { Schema } from "effect";
export { AccountId, HttpUrl } from "apps/contracts";

/**
 * Everything a tool consumes or produces crosses the boundary as a JSON
 * value, never a live JS object.
 */
export const Json = Schema.Json;

export type Json = Schema.Json;

/** A JSON object, used for fields and serialized schema declarations. */
export const JsonObject = Schema.Record(Schema.String, Json);

export type JsonObject = typeof JsonObject.Type;

/**
 * IDs with typed prefixes; id families and raw strings cannot mix.
 * Brands are only obtainable by parsing through these schemas (or from
 * returned rows), never by casting.
 */
const Id = <const P extends string>(prefix: P) =>
  Schema.String.pipe(
    Schema.check(Schema.isStartsWith(`${prefix}_`), Schema.isMinLength(prefix.length + 2)),
    Schema.brand(prefix),
  );

/** Content-derived reference to a normalized provider definition, prefix `prv_`. */
export const ProviderId = Id("prv");

export type ProviderId = typeof ProviderId.Type;

/** Stable webhook subscription identity; its signing secret is stored separately. */
export const WebhookId = Id("whk");
export type WebhookId = typeof WebhookId.Type;

/** Id of an App (see `apps.ts`), prefix `app_`. */
export const AppId = Id("app");
/** Saved execution bindings for an app; independent of its deployment. */
export const ProfileId = Id("ins");
export type ProfileId = typeof ProfileId.Type;

export type AppId = typeof AppId.Type;

/** Shared code lineage behind configured apps; no separate CRUD API. */
export const AppCodeId = Id("code");

export type AppCodeId = typeof AppCodeId.Type;

/** Id of a Deployment (see `deployment.ts`), prefix `dpl_`. */
export const DeploymentId = Id("dpl");

export type DeploymentId = typeof DeploymentId.Type;

/**
 * Opaque reference to a deployment's retained compiled output — resolved
 * dependencies and runtime versions included. Not a CRUD entity.
 */
export const BuildId = Id("bld");

export type BuildId = typeof BuildId.Type;

/** A tool's name within an app's evaluated definition; a tool is addressed by app + deployment + name. */
export const ToolName = Schema.NonEmptyString.pipe(Schema.brand("ToolName"));

export type ToolName = typeof ToolName.Type;

/**
 * App-defined owner of a resource: any non-empty external identifier — a
 * product's user, org, group or service id. Opaque data with no core
 * permission meaning: core stores it and answers owner-constrained
 * lookups, while visibility, sharing and hierarchy stay product decisions.
 * Cross-owner references are valid (a user-owned app may use an account
 * shared by an organization) and imply no inherited access. Nothing is registered
 * SDK-side, and no prefix is required.
 */
export const OwnerId = Schema.NonEmptyString.pipe(Schema.brand("OwnerId"));

export type OwnerId = typeof OwnerId.Type;

/** Opaque paging position minted by a list response; only meaningful to the endpoint that issued it. */
export const Cursor = Schema.NonEmptyString.pipe(Schema.brand("Cursor"));

export type Cursor = typeof Cursor.Type;

/** Page size for list endpoints: an integer between 1 and 2,000, string-encoded in query params. */
export const PageLimit = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 2_000 })),
);

export type PageLimit = typeof PageLimit.Type;

/** The requested operation has no implementation in this scaffold. */
export class NotImplemented extends Schema.TaggedError<NotImplemented>()(
  "NotImplemented",
  { operation: Schema.String },
  {
    httpApiStatus: 501,
    description: "This operation has not been implemented.",
  },
) {}

/** A database operation failed; driver details never cross the SDK boundary. */
export class StorageError extends Schema.TaggedError<StorageError>()(
  "StorageError",
  {},
  {
    httpApiStatus: 500,
  },
) {}

/** Credential encryption or decryption failed; no secret values enter this error. */
export class CredentialsError extends Schema.TaggedError<CredentialsError>()(
  "CredentialsError",
  {},
  {
    httpApiStatus: 500,
  },
) {}

/** Invalid SDK input; submitted fields are never included in the error. */
export class RequestInvalid extends Schema.TaggedError<RequestInvalid>()(
  "RequestInvalid",
  {},
  {
    httpApiStatus: 400,
  },
) {}

/** Opaque pending account setup identity; hosts enforce access separately. */
export const AccountConnectionId = Id("con");
export type AccountConnectionId = typeof AccountConnectionId.Type;

/** Durable identity of one tool call waiting for a trusted caller's decision. */
export const ApprovalRequestId = Id("apr");
export type ApprovalRequestId = typeof ApprovalRequestId.Type;
