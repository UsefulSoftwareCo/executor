import { Effect, Option, Redacted, Schema } from "effect";
import { OAuthCallbackPath } from "@executor-js/local-server/contracts";
import { OAuthReturn } from "../contracts/oauth.ts";
import type { AccountId } from "@executor-js/sdk";

const returnKey = "executor.oauth.return";
export const oauthCallbackUrl = (location: URL) => {
  const url = new URL(location);
  url.hash = "";
  return Redacted.make(url.href);
};
export const readOAuthCallback = Effect.sync(() => {
  const url = new URL(window.location.href);
  if (url.pathname !== OAuthCallbackPath || !url.searchParams.has("state")) return undefined;
  window.history.replaceState(null, "", OAuthCallbackPath);
  return oauthCallbackUrl(url);
});
export const openOAuth = (
  authorizationUrl: string,
  returnTo: typeof OAuthReturn.Type | undefined,
) =>
  Effect.sync(() => {
    if (returnTo === undefined) window.sessionStorage.removeItem(returnKey);
    else window.sessionStorage.setItem(returnKey, JSON.stringify(returnTo));
    window.location.assign(authorizationUrl);
  });
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
    const { app, reconnect } = target.value;
    return {
      destination: {
        to: "/apps/$appId",
        params: { appId: app },
        search: { view: "accounts" },
      } as const,
      reconnect,
    };
  });
