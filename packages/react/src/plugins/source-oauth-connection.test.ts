import { describe, expect, it } from "@effect/vitest";
import { ConnectionId, ScopeId } from "@executor-js/sdk/shared";

import { sourceOAuthConnectionUiState } from "./source-oauth-connection";

describe("source OAuth connection UI state", () => {
  it("shows when the selected scope is using an inherited connection", () => {
    const personalScope = ScopeId.make("user_1");
    const organizationScope = ScopeId.make("org_1");
    const connectionId = ConnectionId.make("connection_1");

    expect(
      sourceOAuthConnectionUiState({
        bindings: [
          {
            slotKey: "auth:oauth2:connection",
            scopeId: organizationScope,
            value: { kind: "connection", connectionId },
          },
        ],
        connectionSlot: "auth:oauth2:connection",
        tokenScope: personalScope,
        scopeRanks: new Map([
          [personalScope, 0],
          [organizationScope, 1],
        ]),
        credentialScopeOptions: [
          {
            scopeId: personalScope,
            label: "Personal",
            description: "Saved only for your account.",
          },
          {
            scopeId: organizationScope,
            label: "Organization",
            description: "Shared with everyone who can use this source.",
          },
        ],
        connections: [{ id: connectionId }],
      }),
    ).toEqual({
      connectionId: null,
      isConnected: true,
      buttonIsConnected: false,
      statusLabel: "Using Organization connection",
      signInLabel: "Sign in personally",
    });
  });
});
