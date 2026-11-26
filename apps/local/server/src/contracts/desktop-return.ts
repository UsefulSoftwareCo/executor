import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { AuthForbidden, PairingUnauthorized } from "./auth.ts";

export const desktopReturnHeader = "x-executor-desktop-return";

export const desktopReturnLimit = 16;
export const desktopReturnLifetimeMillis = 15 * 60_000;
export const desktopReturnWaitMillis = 20_000;

export const DesktopReturnState = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1024),
);

export const DesktopReturn = Schema.Struct({ url: Schema.RedactedFromValue(Schema.String) });
export type DesktopReturn = typeof DesktopReturn.Type;

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
