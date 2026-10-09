/** Browser navigation only. No OAuth code, client secret, or token is persisted here. */
import { Effect, Option, Redacted, Schema } from "effect";
import { OAuthCallbackPath } from "@executor-js/local-server/contracts";
import { OAuthReturn } from "../contracts/oauth.ts";
import type { AccountId } from "@executor-js/sdk";

const returnKey = "executor.oauth.return";
/**
 * The callback as the service's redirect delivered it. A fragment never reaches a server, and
 * some services append one (Facebook adds `#_=_`), so the browser drops it here, as the hosted
 * callback does. Completion still rejects any callback URL that carries a fragment.
 */
export const oauthCallbackUrl = (location: URL) => {
  const url = new URL(location);
  url.hash = "";
  return Redacted.make(url.href);
};
/** Remove callback parameters before rendering or making further requests. */
export const readOAuthCallback = Effect.sync(() => {
  const url = new URL(window.location.href);
  if (url.pathname !== OAuthCallbackPath || !url.searchParams.has("state")) return undefined;
  window.history.replaceState(null, "", OAuthCallbackPath);
  return oauthCallbackUrl(url);
});
/** Remember only the app page to resume after provider consent. */
export const openOAuth = (
  authorizationUrl: string,
  returnTo: typeof OAuthReturn.Type | undefined,
) =>
  Effect.sync(() => {
    if (returnTo === undefined) window.sessionStorage.removeItem(returnKey);
    else window.sessionStorage.setItem(returnKey, JSON.stringify(returnTo));
    window.location.assign(authorizationUrl);
  });
/** Return to the app whose account the sign-in filled. A reconnect keeps its name. */
export const oauthDestination = (account: AccountId) =>
  Effect.sync(() => {
    const saved = window.sessionStorage.getItem(returnKey);
    window.sessionStorage.removeItem(returnKey);
    const target =
      saved === null
        ? Option.none()
        : Schema.decodeUnknownOption(Schema.fromJsonString(OAuthReturn))(saved);
    if (Option.isNone(target))
      return { destination: { to: "/accounts", search: { account } } as const, reconnect: false };
    const { app, profile, reconnect } = target.value;
    return {
      destination: {
        to: "/apps/$appId",
        params: { appId: app },
        search: { view: "accounts", profile },
      } as const,
      reconnect,
    };
  });
