import { useMemo, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { IntegrationSlug, type Connection, type Owner } from "@executor-js/sdk/shared";
import { connectionsAllAtom } from "@executor-js/react/api/atoms";
import { AddAccountModal } from "@executor-js/react/components/add-account-modal";
import { OAuthSignInButton } from "@executor-js/react/plugins/oauth-sign-in";
import type { AuthMethod } from "@executor-js/react/lib/auth-placements";

import { mcpServerAtom } from "./atoms";
import { authMethodsFromConfig } from "./auth-method-config";
import type { McpAuthMethod } from "../sdk/types";

// ---------------------------------------------------------------------------
// McpSignInButton — top-bar action on the integration detail page (v2).
//
// Reads the integration's declared auth methods; when one is `oauth2` it runs
// the OAuth flow to mint a connection through that method. "Connected" is
// derived from whether ANY owner already has a connection for this integration
// (the global owner toggle is retired, so the check merges both owners). The
// NEW connection's owner is a real create-target — chosen EXPLICITLY via the
// `owner` prop (default Workspace `org` on an org-scoped host, Local `org` on
// a non-org host like local), never read from an ambient owner.
// ---------------------------------------------------------------------------

export default function McpSignInButton(props: { integrationId: string; owner?: Owner }) {
  const slug = IntegrationSlug.make(props.integrationId);
  const targetOwner: Owner = props.owner ?? "org";
  const serverResult = useAtomValue(mcpServerAtom(slug));
  const connectionsResult = useAtomValue(connectionsAllAtom);
  const [modalOpen, setModalOpen] = useState(false);

  const server = AsyncResult.isSuccess(serverResult) ? serverResult.value : null;
  const remote = server !== null && server.config.transport === "remote" ? server.config : null;
  const oauthMethod =
    remote?.authenticationTemplate.find((method: McpAuthMethod) => method.kind === "oauth2") ??
    null;
  const connections: readonly Connection[] = AsyncResult.isSuccess(connectionsResult)
    ? connectionsResult.value
    : [];
  const hasConnection = connections.some(
    (connection: Connection) => connection.integration === slug,
  );

  // Projected through the plugin's ONE codec rather than assembled here: the
  // server's enterprise-managed declaration rides on this method, and a
  // hand-built copy silently dropped it — leaving this button offering
  // per-server consent for a server the organization manages.
  //
  // Carrying the declaration is the whole of this button's EMA support: the
  // route is decided inside `AddAccountModal` from the method, so a server
  // declared managed gets the work-identity connect here for exactly the same
  // reason it does from the connections list, with no second decision to keep
  // in step.
  const methods = useMemo<readonly AuthMethod[]>(
    () =>
      remote === null || oauthMethod === null
        ? []
        : authMethodsFromConfig([oauthMethod], remote.endpoint),
    [remote, oauthMethod],
  );
  const initialState = useMemo(
    () =>
      modalOpen && server && oauthMethod
        ? {
            key: `${String(slug)}:${targetOwner}:oauth`,
            owner: targetOwner,
            template: oauthMethod.slug,
            label: `${server.description || String(slug)} OAuth`,
          }
        : null,
    [modalOpen, oauthMethod, server, slug, targetOwner],
  );

  if (oauthMethod === null) return null;

  return (
    <>
      <OAuthSignInButton
        busy={false}
        error={null}
        isConnected={hasConnection}
        onSignIn={() => setModalOpen(true)}
        reconnectingLabel="Reconnecting…"
        signingInLabel="Signing in…"
      />
      {server ? (
        <AddAccountModal
          integration={slug}
          integrationName={server.description || String(slug)}
          methods={methods}
          open={modalOpen}
          onOpenChange={setModalOpen}
          initialState={initialState}
        />
      ) : null}
    </>
  );
}
