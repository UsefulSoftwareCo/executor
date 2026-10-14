/** Browser-to-host operations bind identity and authentication outside authored app code. */
import { Schema, type Effect, type Stream } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { JsonValue } from "./schema.ts";

/**
 * Non-secret page context injected by the serving host. `accounts` names the account IDs the page
 * runs with, by requirement, when the app has requirements.
 */
export const UiContext = Schema.Struct({
  deployment: Schema.NonEmptyString,
  accounts: Schema.optional(
    Schema.Record(Schema.NonEmptyString, Schema.Array(Schema.NonEmptyString)),
  ),
});
/** A problem with one of the page's accounts, from stored state. Labels are the owner's own names. */
export type UiAccountProblem =
  | { readonly provider: string; readonly reason: "missing" | "removed" | "incompatible" }
  | {
      readonly provider: string;
      readonly account: string;
      readonly reason:
        | "credentials_rejected"
        | "forbidden"
        | "upstream_unavailable"
        | "check_failed";
    };
/** Account problems found when the page opened, with dashboard links that resolve them. */
export interface UiAccountNotice {
  readonly app: string;
  readonly problems: readonly UiAccountProblem[];
  /** The app's accounts in the dashboard. */
  readonly fix: string;
}
/** Retained browser bytes. Hosts authorize access before reading or rendering them. */
export interface AppUiFile {
  readonly body: Uint8Array;
  readonly contentType: string;
}
/** One byte range of a stored file, already within its size. */
export interface AppUiRange {
  readonly offset: number;
  readonly length: number;
}
/**
 * A public file the deployment's source served from `ui/public/`, which the host copied to its
 * own store. `etag` names its exact bytes. Hosts authorize access before reading it.
 */
export interface AppUiStoredFile {
  readonly contentType: string;
  readonly size: number;
  readonly etag: string;
  readonly read: (
    range: AppUiRange | undefined,
  ) => Effect.Effect<Stream.Stream<Uint8Array, UiFailed>, UiFailed>;
}
export type AppUiAsset = AppUiFile | AppUiStoredFile;
/** Requests name an operation on this app and the page's deployment, never another app or account. */
export const UiOperation = Schema.Struct({
  ...UiContext.fields,
  name: Schema.NonEmptyString,
  input: JsonValue,
});
/** The app session is absent or its parent login was revoked. */
export class UiUnauthorized extends Schema.TaggedError<UiUnauthorized>()(
  "UiUnauthorized",
  {},
  { httpApiStatus: 401 },
) {}
/** The request did not originate from the configured app. */
export class UiForbidden extends Schema.TaggedError<UiForbidden>()(
  "UiForbidden",
  {},
  { httpApiStatus: 403 },
) {}
/** The page should reload before starting another operation. */
export class UiDeploymentChanged extends Schema.TaggedError<UiDeploymentChanged>()(
  "UiDeploymentChanged",
  {},
  { httpApiStatus: 409 },
) {}
/** Safe app failure without account fields, author exceptions or upstream responses. */
export class UiFailed extends Schema.TaggedError<UiFailed>()(
  "UiFailed",
  {
    reason: Schema.Literals(["unavailable", "operation_failed", "account_required"]),
  },
  { httpApiStatus: 422 },
) {}
/** Every live stream carries heartbeats so the browser can detect a lost connection. */
export const UiSnapshot = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    value: JsonValue,
    trace: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({ type: Schema.Literal("failure"), error: UiFailed }),
  Schema.Struct({ type: Schema.Literal("heartbeat") }),
]);
const errors = [UiUnauthorized, UiForbidden, UiDeploymentChanged, UiFailed] as const;
/** Portable serving contract; the host authenticates and resolves the configured app. */
export const AppUiApi = HttpApi.make("app-ui").add(
  HttpApiGroup.make("ui")
    .add(
      HttpApiEndpoint.post("query", "/_executor/api/query", {
        payload: UiOperation,
        success: JsonValue,
        error: errors,
      }),
    )
    .add(
      HttpApiEndpoint.post("mutate", "/_executor/api/mutate", {
        payload: UiOperation,
        success: JsonValue,
        error: errors,
      }),
    )
    .add(
      HttpApiEndpoint.post("subscribe", "/_executor/api/subscribe", {
        payload: UiOperation,
        success: HttpApiSchema.StreamSse({ data: UiSnapshot, error: Schema.Union(errors) }),
        error: errors,
      }),
    ),
);
