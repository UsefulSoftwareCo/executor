/** Private local app origins and dashboard-side authentication contracts. */
import { AppId } from "@executor-js/sdk";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { UiFailed, UiForbidden, UiUnauthorized } from "apps/ui/contracts";
import { AppSignInId } from "apps/ui/auth/contracts";
export { AppSignInId } from "apps/ui/auth/contracts";
/** A callback proof is private and short-lived, not a bookmark or app launch URL. */
export const AppSignInRedirect = Schema.Struct({ url: Schema.RedactedFromValue(Schema.String) });
/** An existing local login authorizes only an app-originated browser attempt. */
export const AppAuthenticationApi = HttpApi.make("app-authentication").add(
  HttpApiGroup.make("appAuthentication").add(
    HttpApiEndpoint.post("authorize", "/auth/apps/authorize", {
      payload: Schema.Struct({ request: AppSignInId }),
      success: AppSignInRedirect,
      error: [UiUnauthorized, UiForbidden, UiFailed],
    }),
  ),
);
/** DNS labels use the stable UUID, while SDK IDs retain their app_ prefix. */
export const appOrigin = (app: AppId, port: number) =>
  `http://${app.replace(/^app_/, "app-")}.localhost:${port}`;
/** Accept only generated local app hostnames, never arbitrary Host or forwarding headers. */
export const appFromHost = (host: string | undefined, port: number) => {
  const match = new RegExp(
    `^app-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\\.localhost:${port}$`,
  ).exec(host ?? "");
  return match?.[1] === undefined ? undefined : AppId.make(`app_${match[1]}`);
};
/** Port-specific name; cookies are host-only and never shared with the dashboard. */
export const appSessionCookie = (port: number) => `executor_app_${port}`;
