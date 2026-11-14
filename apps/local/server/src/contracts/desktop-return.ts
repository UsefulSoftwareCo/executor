/**
 * OAuth returns for Executor desktop. The desktop opens a provider's consent page in the system
 * browser, and the provider sends that browser back to this server's callback. For a state the
 * desktop said it expects, the server keeps the callback for the desktop and asks the person to
 * return to the app, which loads the callback in its own window with its own session. Callbacks
 * for any other state, including every OAuth a browser starts, complete in the browser as before.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { AuthForbidden, PairingUnauthorized } from "./auth.ts";

/** The desktop sends this header when it loads a kept callback, so the callback completes. */
export const desktopReturnHeader = "x-executor-desktop-return";

/** At most this many expected states and kept callbacks; the oldest goes first. */
export const desktopReturnLimit = 16;
/** An expected state, or a kept callback, is forgotten after this long. */
export const desktopReturnLifetimeMillis = 15 * 60_000;
/** How long one `next` request waits for a callback before it answers with none. */
export const desktopReturnWaitMillis = 20_000;

/** The `state` parameter of an OAuth authorization the desktop opened in the browser. */
export const DesktopReturnState = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1024),
);

/** A provider callback for an expected state. It holds an authorization code: never log it. */
export const DesktopReturn = Schema.Struct({ url: Schema.RedactedFromValue(Schema.String) });
export type DesktopReturn = typeof DesktopReturn.Type;

/** Programmatic routes: a local credential as the bearer, and no browser Origin. */
export const DesktopReturnApi = HttpApi.make("desktop-return").add(
  HttpApiGroup.make("desktopReturns")
    .add(
      HttpApiEndpoint.post("expect", "/api/desktop/oauth-returns", {
        payload: Schema.Struct({ state: DesktopReturnState }),
        error: [AuthForbidden, PairingUnauthorized],
      }),
    )
    .add(
      HttpApiEndpoint.get("next", "/api/desktop/oauth-returns", {
        success: Schema.Struct({ returns: Schema.Array(DesktopReturn) }),
        error: [AuthForbidden, PairingUnauthorized],
      }),
    ),
);
