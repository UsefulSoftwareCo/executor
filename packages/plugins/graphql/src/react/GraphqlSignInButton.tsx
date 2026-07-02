import { useState } from "react";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  type Connection,
  type AuthTemplateSlug as AuthTemplateSlugType,
} from "@executor-js/sdk/shared";
import { OAuthSignInButton, useOAuthPopupFlow } from "@executor-js/react/plugins/oauth-sign-in";
import {
  ConnectionOwnerDropdown,
  useConnectionOwner,
} from "@executor-js/react/plugins/connection-owner";
import { useOwnerDisplay } from "@executor-js/react/api/owner-display";

import { graphqlConnectionName } from "./defaults";

// v2 OAuth sign-in. `oauth.start` runs a registered OAuth client for one
// integration + template, minting an owner-scoped connection (the redirect is
// driven through the popup; `state` correlates it). There is no per-source
// connection slot or `oauthConnectionId` anymore — the connection is owned by
// the chosen owner and identified by (owner, integration, name).
const GRAPHQL_OAUTH_CLIENT = "graphql-oauth";

export default function GraphqlSignInButton(props: {
  readonly slug: IntegrationSlug;
  readonly template: AuthTemplateSlugType;
  readonly displayName: string;
  readonly existing: readonly Connection[];
}) {
  const { connectionOwner, setConnectionOwner, connectionOwnerOptions } = useConnectionOwner();
  const oauth = useOAuthPopupFlow({
    popupName: "graphql-oauth",
    startErrorMessage: "Failed to start OAuth",
  });
  const ownerDisplay = useOwnerDisplay();
  const [connectedOwner, setConnectedOwner] = useState<string | null>(null);

  const existingForOwner = props.existing.find(
    (connection) => connection.owner === connectionOwner && connection.template === props.template,
  );
  const isConnected = existingForOwner !== undefined || connectedOwner === connectionOwner;

  const handleSignIn = (): void => {
    setConnectedOwner(null);
    void oauth.start({
      payload: {
        client: OAuthClientSlug.make(GRAPHQL_OAUTH_CLIENT),
        // GraphQL manages its own client per owner — the app and connection
        // share one owner.
        clientOwner: connectionOwner,
        owner: connectionOwner,
        name: graphqlConnectionName(String(props.slug), connectionOwner),
        integration: IntegrationSlug.make(String(props.slug)),
        template: AuthTemplateSlug.make(String(props.template)),
        identityLabel: `${props.displayName} OAuth`,
      },
      onSuccess: (payload: { readonly connection: ConnectionName }) => {
        // Touch the minted connection name to satisfy the success contract; the
        // connection list re-reads via reactivity keys after the flow completes.
        void payload.connection;
        setConnectedOwner(connectionOwner);
      },
    });
  };

  return (
    <div className="space-y-2">
      {isConnected && (
        <p className="text-xs text-foreground">
          Connected in {ownerDisplay.label(connectionOwner)}
          {existingForOwner?.identityLabel ? ` as ${existingForOwner.identityLabel}` : ""}.
        </p>
      )}
      <ConnectionOwnerDropdown
        value={connectionOwner}
        options={connectionOwnerOptions}
        onChange={(owner) => {
          setConnectionOwner(owner);
          setConnectedOwner(null);
        }}
        label="Connection saved to"
        help="Choose who can use the OAuth connection."
      />
      <OAuthSignInButton
        busy={oauth.busy}
        error={oauth.error}
        isConnected={isConnected}
        onSignIn={handleSignIn}
      />
    </div>
  );
}
