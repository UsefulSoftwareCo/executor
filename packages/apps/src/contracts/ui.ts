/** Browser-to-host operations bind identity and authentication outside authored app code. */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { JsonValue } from "./schema.ts";

/** Non-secret page context injected by the serving host. */
export const UiContext = Schema.Struct({ deployment: Schema.NonEmptyString });
/** Retained browser bytes. Hosts authorize access before reading or rendering them. */
export interface AppUiAsset {
  readonly body: Uint8Array;
  readonly contentType: string;
}
/** Requests name an operation on this app and the page's deployment, never another app or account. */
export const UiOperation = Schema.Struct({
  deployment: Schema.NonEmptyString,
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
