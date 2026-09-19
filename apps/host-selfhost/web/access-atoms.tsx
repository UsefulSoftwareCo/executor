import { AccessApiClient } from "./access-client";

// ---------------------------------------------------------------------------
// Self-host connected-clients atoms — the signed-in user's MCP OAuth clients
// and browser sessions. API keys reuse the shared account atoms.
// ---------------------------------------------------------------------------

// Local reactivity key: this list only matters within this client.
const CONNECTED_CLIENTS_KEY = "self-host:connected-clients";

export const connectedClientsAtom = AccessApiClient.query("access", "listConnectedClients", {
  reactivityKeys: [CONNECTED_CLIENTS_KEY],
});

export const revokeOAuthClient = AccessApiClient.mutation("access", "revokeOAuthClient");
export const revokeSession = AccessApiClient.mutation("access", "revokeSession");

/** Mutations that change the list pass these at the call site. */
export const connectedClientsWriteKeys = [CONNECTED_CLIENTS_KEY] as const;
