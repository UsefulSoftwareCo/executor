/** Browser navigation edge for limited connection grants, distinct from dashboard pairing. */
import { Effect, Option, Redacted, Schema } from "effect";
import { AccountConnectionId } from "@executor-js/sdk";
import { ConnectionGrant } from "@executor-js/local-server/account-connections";
import { OAuthCallbackPath } from "@executor-js/local-server/contracts";
import type { ConnectionEntry } from "../contracts/account-connections.ts";

const key = (id: string) => `executor.account-connect.${id}`;
const oauthKey = (state: string) => `executor.account-connect.oauth.${state}`;
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(ConnectionGrant));
/** Remove the grant fragment before rendering. Session storage only holds this limited grant, never submitted fields. */
export const readAccountConnection = Effect.sync((): ConnectionEntry | undefined => {
  const url = new URL(window.location.href);
  const match = /^\/account-connect\/([^/]+)$/.exec(url.pathname);
  if (match?.[1]) {
    const connection = Schema.decodeUnknownOption(AccountConnectionId)(match[1]);
    if (Option.isNone(connection)) return undefined;
    const token = new URLSearchParams(url.hash.slice(1)).get("token");
    window.history.replaceState(null, "", url.pathname);
    if (token !== null) {
      const grant = { connection: connection.value, token: Redacted.make(token) };
      sessionStorage.setItem(
        key(connection.value),
        Schema.encodeSync(Schema.fromJsonString(ConnectionGrant))(grant),
      );
      return grant;
    }
    const saved = sessionStorage.getItem(key(connection.value));
    return saved === null ? undefined : Option.getOrUndefined(decode(saved));
  }
  const state = url.searchParams.get("state");
  if (url.pathname !== OAuthCallbackPath || state === null) return undefined;
  const saved = sessionStorage.getItem(oauthKey(state));
  if (saved === null) return undefined;
  const grant = decode(saved);
  if (Option.isNone(grant)) return undefined;
  sessionStorage.removeItem(oauthKey(state));
  window.history.replaceState(null, "", `/account-connect/${grant.value.connection}`);
  return { ...grant.value, callbackUrl: Redacted.make(url.href) };
});
/** Match only this OAuth attempt on return, so ordinary dashboard sign-in cannot be intercepted. */
export const openConnectionOAuth = (authorizationUrl: string, grant: ConnectionGrant) =>
  Effect.sync(() => {
    const state = new URL(authorizationUrl).searchParams.get("state");
    if (state === null) throw new Error("OAuth authorization URL is missing state");
    sessionStorage.setItem(
      oauthKey(state),
      Schema.encodeSync(Schema.fromJsonString(ConnectionGrant))(grant),
    );
    window.location.assign(authorizationUrl);
  });
