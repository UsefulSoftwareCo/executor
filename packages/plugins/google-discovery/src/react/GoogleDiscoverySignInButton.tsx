import { useCallback } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { connectionsAtom } from "@executor-js/react/api/atoms";
import { useScope, useUserScope } from "@executor-js/react/api/scope-context";
import { connectionWriteKeys, sourceWriteKeys } from "@executor-js/react/api/reactivity-keys";
import {
  OAuthSignInButton,
  oauthCallbackUrl,
  useOAuthPopupFlow,
  type OAuthCompletionPayload,
} from "@executor-js/react/plugins/oauth-sign-in";

import { googleDiscoverySourceAtom, updateGoogleDiscoverySource } from "./atoms";
import { GOOGLE_DISCOVERY_OAUTH_POPUP_NAME, googleDiscoveryOAuthStrategy } from "./oauth";

// ---------------------------------------------------------------------------
// GoogleDiscoverySignInButton — top-bar action on the source detail page.
//
// Drives the shared /scopes/:scopeId/oauth/{start,callback} surface with
// a Google-specific `authorization-code` strategy. On success rewrites
// the source's auth pointer to the freshly minted connection id. Works
// whether or not the previous Connection still exists — source-owned
// OAuth config is the source of truth.
// ---------------------------------------------------------------------------

const signInWriteKeys = [...sourceWriteKeys, ...connectionWriteKeys] as const;

export default function GoogleDiscoverySignInButton(props: { sourceId: string }) {
  const scopeId = useScope();
  const userScopeId = useUserScope();
  const sourceResult = useAtomValue(googleDiscoverySourceAtom(scopeId, props.sourceId));
  const connectionsResult = useAtomValue(connectionsAtom(scopeId));
  const doUpdate = useAtomSet(updateGoogleDiscoverySource, { mode: "promise" });
  const oauth = useOAuthPopupFlow({
    popupName: GOOGLE_DISCOVERY_OAUTH_POPUP_NAME,
    popupBlockedMessage: "OAuth popup was blocked",
    popupClosedMessage: "OAuth cancelled: popup was closed before completing the flow.",
  });

  const source =
    AsyncResult.isSuccess(sourceResult) && sourceResult.value ? sourceResult.value : null;
  const auth = source?.config.auth;
  const oauth2 = auth && auth.kind === "oauth2" ? auth : null;
  const connections = AsyncResult.isSuccess(connectionsResult) ? connectionsResult.value : null;
  const isConnected =
    oauth2 !== null &&
    connections !== null &&
    connections.some((c: { readonly id: string }) => c.id === oauth2.connectionId);

  const handleSignIn = useCallback(async () => {
    if (!oauth2 || !source) return;
    const scopes = [...oauth2.scopes];
    await oauth.start({
      payload: {
        endpoint: source.config.discoveryUrl,
        redirectUrl: oauthCallbackUrl(),
        connectionId: oauth2.connectionId,
        tokenScope: userScopeId,
        identityLabel: `${source.name.trim() || props.sourceId} OAuth`,
        strategy: googleDiscoveryOAuthStrategy({
          clientIdSecretId: oauth2.clientIdSecretId,
          clientSecretSecretId: oauth2.clientSecretSecretId,
          scopes,
        }),
        pluginId: "google-discovery",
      },
      onSuccess: async (result: OAuthCompletionPayload) => {
        await doUpdate({
          params: { scopeId, namespace: props.sourceId },
          payload: {
            auth: {
              kind: "oauth2",
              connectionId: result.connectionId,
              clientIdSecretId: oauth2.clientIdSecretId,
              clientSecretSecretId: oauth2.clientSecretSecretId,
              scopes,
            },
          },
          reactivityKeys: signInWriteKeys,
        });
      },
    });
  }, [oauth2, source, scopeId, props.sourceId, doUpdate, oauth, userScopeId]);

  if (!oauth2) return null;

  return (
    <OAuthSignInButton
      busy={oauth.busy}
      error={oauth.error}
      isConnected={isConnected}
      onSignIn={() => void handleSignIn()}
      reconnectingLabel="Reconnecting…"
      signingInLabel="Signing in…"
    />
  );
}
