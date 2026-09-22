/** Browser navigation only. No OAuth code, client secret, or token is persisted here. */
import { Effect, Option, Redacted, Schema } from "effect";
import { OAuthCallbackPath } from "@executor-js/local-server/contracts";
import { OAuthReturn, type OAuthAppReturn } from "../contracts/oauth.ts";
import type { AccountId, AccountConnectionId } from "@executor-js/sdk";

const returnKey = "executor.oauth.return";
/** Remove callback parameters before rendering or making further requests. */
export const readOAuthCallback = Effect.sync(() => {
  const url = new URL(window.location.href);
  if (url.pathname !== OAuthCallbackPath || !url.searchParams.has("state")) return undefined;
  window.history.replaceState(null, "", OAuthCallbackPath);
  return Redacted.make(url.href);
});
/** Remember only the account-selection page to resume after provider consent. */
export const openOAuth = (
  authorizationUrl: string,
  connection: AccountConnectionId,
  account?: AccountId,
  returnTo?: Omit<typeof OAuthAppReturn.Type, "connection">,
) =>
  Effect.sync(() => {
    const current = new URL(window.location.href);
    const target = Schema.decodeUnknownOption(OAuthReturn)(
      account === undefined
        ? {
            connection,
            app: current.searchParams.get("app"),
            slot: current.searchParams.get("slot"),
            profile: current.searchParams.get("profile") ?? undefined,
            ...returnTo,
          }
        : { connection, account },
    );
    if (Option.isSome(target))
      window.sessionStorage.setItem(returnKey, JSON.stringify(target.value));
    else window.sessionStorage.removeItem(returnKey);
    window.location.assign(authorizationUrl);
  });
/** Return to setup with a saved account candidate; setup still validates provider compatibility. */
export const oauthDestination = (account: AccountId) =>
  Effect.sync(() => {
    const saved = window.sessionStorage.getItem(returnKey);
    window.sessionStorage.removeItem(returnKey);
    const target =
      saved === null
        ? Option.none()
        : Schema.decodeUnknownOption(Schema.fromJsonString(OAuthReturn))(saved);
    return Option.isSome(target) && "app" in target.value
      ? ({
          to: "/apps/$appId/setup",
          params: { appId: target.value.app },
          search: {
            selected: account,
            slot: target.value.slot,
            ...(target.value.profile === undefined ? {} : { profile: target.value.profile }),
          },
        } as const)
      : ({ to: "/accounts/$accountId", params: { accountId: account } } as const);
  });
