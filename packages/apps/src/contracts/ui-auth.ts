/* oxlint-disable no-control-regex -- control characters in paths are rejected on purpose */
/** Browser authentication protocol. Identity and session storage belong to the host. */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { UiFailed, UiForbidden, UiUnauthorized } from "./ui.ts";

/** Opaque correlation ID; possession alone does not authorize an app session. */
export const AppSignInId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(
  Schema.brand("AppSignInId"),
);
export type AppSignInId = typeof AppSignInId.Type;
/** Authentication proofs are redacted at the HTTP boundary. */
export const AppSignInCode = Schema.RedactedFromValue(
  Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
);
/** A path on the current app origin, including its query and fragment; never a redirect to another host or host-owned route. */
export const AppReturnPath = Schema.String.check(
  Schema.isMaxLength(8192),
  Schema.makeFilter((value) => {
    if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(value))
      return false;
    try {
      const url = new URL(value, "https://app.invalid");
      return (
        url.origin === "https://app.invalid" &&
        !/^\/(?:_executor|dashboard|auth|v1|mcp)(?:\/|$)/.test(decodeURIComponent(url.pathname))
      );
    } catch {
      return false;
    }
  }),
).pipe(Schema.brand("AppReturnPath"));
export type AppReturnPath = typeof AppReturnPath.Type;
/** The trusted callback exchanges an authorization code bound to a browser attempt. */
export const AppSignInCallback = Schema.Struct({ request: AppSignInId, code: AppSignInCode });
/** Host-owned endpoints on every app origin, independent of the product's login mechanism. */
export const AppSignInApi = HttpApi.make("app-sign-in").add(
  HttpApiGroup.make("appSignIn")
    .add(
      HttpApiEndpoint.post("start", "/_executor/auth/start", {
        payload: Schema.Struct({ returnTo: AppReturnPath }),
        success: Schema.Struct({ url: Schema.String }),
        error: [UiForbidden, UiFailed],
      }),
    )
    .add(
      HttpApiEndpoint.post("complete", "/_executor/auth/complete", {
        payload: AppSignInCallback,
        success: Schema.Struct({ returnTo: AppReturnPath }),
        error: [UiUnauthorized, UiForbidden, UiFailed],
      }),
    ),
);
