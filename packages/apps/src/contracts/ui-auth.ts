/* oxlint-disable no-control-regex -- control characters in paths are rejected on purpose */
/** Browser authentication protocol. Identity and session storage belong to the host. */
import { Schema } from "effect";

/** Opaque correlation ID; possession alone does not authorize an app session. */
export const AppSignInId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)).pipe(
  Schema.brand("AppSignInId"),
);
export type AppSignInId = typeof AppSignInId.Type;
/** Authentication proofs are redacted at the HTTP boundary. */
export const AppSignInCode = Schema.RedactedFromValue(
  Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
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
/** Callback query on the app origin. The code is single-use and works only with its attempt's cookie. */
export const AppSignInCallback = Schema.Struct({ request: AppSignInId, code: AppSignInCode });
/** Host-owned callback path on every app origin. */
export const appSignInCallbackPath = "/_executor/auth/callback";
/** Why the product could not authorize an attempt; the dashboard explains it without retrying. */
export const AppSignInFailure = Schema.Literals(["ended", "forbidden", "unavailable"]);
export type AppSignInFailure = typeof AppSignInFailure.Type;
