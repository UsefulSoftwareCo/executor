import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { callPresentation, MayHaveWritten } from "./call-presentation.ts";
/** Shared contract primitives: IDs, ownership, JSON, pagination and write-only secrets. */
import { Schema } from "effect";
import { HttpApiMiddleware } from "effect/http-api";
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
const Id = <const P extends string>(prefix: Parameters<typeof Schema.brand<P>>[0]) =>
  Schema.String.pipe(
    Schema.check(Schema.isPattern(new RegExp(`^${prefix}_[\\s\\S]+$`, "u"))),
    Schema.brand<P>(prefix),
  );

/** Content-derived reference to a normalized provider definition, prefix `prv_`. */
export const ProviderId = Id("prv");

export type ProviderId = typeof ProviderId.Type;

/** Stable webhook subscription identity; its signing secret is stored separately. */
export const WebhookId = Id("whk");
export type WebhookId = typeof WebhookId.Type;

/**
 * Id of an App (see `apps.ts`), prefix `app_`. Tool signatures show schema descriptions, so the
 * description tells agents which value to pass.
 */
export const AppId = Id("app").annotate({
  description: "App ID, such as app_…, from the app's `id`. An app's slug or name is not accepted.",
});

export type AppId = typeof AppId.Type;

/** Shared code lineage behind configured apps; no separate CRUD API. */
export const AppCodeId = Id("code");

export type AppCodeId = typeof AppCodeId.Type;

/** Id of a Version (see `version.ts`), prefix `dpl_`. */
export const VersionId = Id("dpl");

export type VersionId = typeof VersionId.Type;

/**
 * Opaque reference to a version's retained compiled output — resolved
 * dependencies and runtime versions included. Not a CRUD entity.
 */
export const BuildId = Id("bld");

export type BuildId = typeof BuildId.Type;

/** A tool's name within an app's evaluated definition; a tool is addressed by app + version + name. */
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

/**
 * A database operation failed; driver details never cross the SDK boundary. With
 * `mayHaveWritten`, it failed after a tool call that may write reached the app's code.
 */
export const StorageError = UserFacingError.define({
  tag: "StorageError",
  status: 500,
  fields: { mayHaveWritten: MayHaveWritten },
  recorded: () => "Executor could not read or write its saved data.",
  presentation: callPresentation(() => ({
    title: "Executor storage unavailable",
    description: "Executor could not read or write its saved data.",
    recovery: {
      action:
        "Try again. If this continues, copy the fix prompt into your agent to check Executor’s storage.",
      instructions:
        "Check Executor’s storage availability and safe diagnostics for the failed operation. Restore the failing storage dependency or identify the required instance action. Do not change the integration’s authentication to work around an Executor storage failure. Do not delete stored data.",
    },
    retryable: true,
  })),
});
/** Parsed StorageError failure. */
export type StorageError = typeof StorageError.Type;

/**
 * Credential encryption or decryption failed; no secret values enter this error. With
 * `mayHaveWritten`, it failed after a tool call that may write reached the app's code.
 */
export const CredentialsError = UserFacingError.define({
  tag: "CredentialsError",
  status: 500,
  fields: { mayHaveWritten: MayHaveWritten },
  recorded: () => "Executor could not securely read or write the saved credentials.",
  presentation: callPresentation(() => ({
    title: "Saved credentials unavailable",
    description: "Executor could not securely read or write the saved credentials.",
    recovery: {
      action:
        "Try again. If this continues, copy the fix prompt into your agent to check Executor’s credential storage.",
      instructions:
        "Check Executor’s credential storage and encryption-key availability without exposing secret values. Restore access through the supported configuration. Do not overwrite credentials, rotate keys as a guess, or change integration code to mask an Executor storage failure.",
    },
    retryable: true,
  })),
});
/** Parsed CredentialsError failure. */
export type CredentialsError = typeof CredentialsError.Type;

/** The part of an HTTP request an operation's schema rejected. */
export const RequestPart = Schema.Literals(["path", "headers", "query", "body"]);
export type RequestPart = typeof RequestPart.Type;

/**
 * One place a request did not match its operation's schema: a JSON path into the rejected part,
 * such as `$.files`, and what the schema expects there. Executor's schemas state the expectation;
 * the submitted value is not repeated.
 */
export const RequestIssue = Schema.Struct({ path: Schema.String, expected: Schema.String });
export type RequestIssue = typeof RequestIssue.Type;

const requestInvalidDescription =
  "Executor could not accept this request's input. Check it against the operation's schema; submitted values are not repeated here.";

/**
 * Invalid SDK input; submitted fields are never included in the error. A request its operation's
 * schema rejected names the part and each place that did not match.
 */
export const RequestInvalid = UserFacingError.define({
  tag: "RequestInvalid",
  status: 400,
  fields: {
    part: Schema.optionalKey(RequestPart),
    issues: Schema.optionalKey(Schema.Array(RequestIssue)),
  },
  recorded: ({ part }) =>
    part === undefined
      ? requestInvalidDescription
      : `Executor rejected this request's ${part} because it does not match the operation's schema.`,
  presentation: ({ part, issues }) => ({
    title: "Request input not accepted",
    description:
      part === undefined || issues === undefined || issues.length === 0
        ? requestInvalidDescription
        : `Executor rejected this request's ${part} because it does not match the operation's schema: ${issues
            .map((issue) => `${issue.path}: ${issue.expected}`)
            .join("; ")}.`,
    recovery: {
      action: "Correct the input and send the request again.",
      instructions:
        "Read each listed path and what the operation's schema expects there, correct those values, and send the corrected request. Read the operation's input schema for the full shape. Sending the same input again fails the same way.",
    },
  }),
});
export type RequestInvalid = typeof RequestInvalid.Type;

/**
 * Answers a request its endpoint's schema rejects with `RequestInvalid`. Every product API applies
 * it to every endpoint, so each operation's published errors include that response.
 */
export class RequestRejection extends HttpApiMiddleware.Service<RequestRejection>()(
  "executor/RequestRejection",
  { error: RequestInvalid },
) {}

/** Opaque pending account setup identity; hosts enforce access separately. */
export const AccountConnectionId = Id("con");
export type AccountConnectionId = typeof AccountConnectionId.Type;

/** Durable identity of one tool call waiting for a trusted caller's decision. */
export const ApprovalRequestId = Id("apr");
export type ApprovalRequestId = typeof ApprovalRequestId.Type;
