import { useMemo, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import {
  AuthTemplateSlug,
  IntegrationSlug,
  type Connection,
  type Owner,
} from "@executor-js/sdk/shared";
import { connectionsAllAtom } from "@executor-js/react/api/atoms";
import { AddAccountModal } from "@executor-js/react/components/add-account-modal";
import { OAuthSignInButton } from "@executor-js/react/plugins/oauth-sign-in";
import type { AuthMethod } from "@executor-js/react/lib/auth-placements";

import { mcpServerAtom } from "./atoms";

const OAUTH_TEMPLATE = AuthTemplateSlug.make("oauth2");

// ---------------------------------------------------------------------------
// McpSignInButton — top-bar action on the integration detail page (v2).
//
// Reads the integration's auth template; for an `oauth2` server it runs the
// OAuth flow to mint a connection. "Connected" is derived from whether ANY
// owner already has a connection for this integration (the global owner toggle
// is retired, so the check merges both owners). The NEW connection's owner is a
// real create-target — chosen EXPLICITLY via the `owner` prop (default Workspace
// `org` on an org-scoped host, Local `org` on a non-org host like local),
// never read from an ambient owner.
// ---------------------------------------------------------------------------

export default function McpSignInButton(props: { sourceId: string; owner?: Owner }) {
  const slug = IntegrationSlug.make(props.sourceId);
  const targetOwner: Owner = props.owner ?? "org";
  const serverResult = useAtomValue(mcpServerAtom(slug));
  const connectionsResult = useAtomValue(connectionsAllAtom);
  const [modalOpen, setModalOpen] = useState(false);

  const server = AsyncResult.isSuccess(serverResult) ? serverResult.value : null;
  const remote = server !== null && server.config.transport === "remote" ? server.config : null;
  const isOAuth = remote !== null && remote.auth.kind === "oauth2";
  const connections: readonly Connection[] = AsyncResult.isSuccess(connectionsResult)
    ? connectionsResult.value
    : [];
  const hasConnection = connections.some(
    (connection: Connection) => connection.integration === slug,
  );

  const methods = useMemo<readonly AuthMethod[]>(
    () =>
      remote === null
        ? []
        : [
            {
              id: "oauth2",
              label: "OAuth",
              kind: "oauth",
              source: "spec",
              template: OAUTH_TEMPLATE,
              placements: [],
              oauth: { discoveryUrl: remote.endpoint, supportsDynamicRegistration: true },
            },
          ],
    [remote],
  );
  const initialState = useMemo(
    () =>
      modalOpen && server
        ? {
            key: `${String(slug)}:${targetOwner}:oauth`,
            owner: targetOwner,
            template: String(OAUTH_TEMPLATE),
            label: `${server.description || String(slug)} OAuth`,
          }
        : null,
    [modalOpen, server, slug, targetOwner],
  );

  if (!isOAuth) return null;

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
