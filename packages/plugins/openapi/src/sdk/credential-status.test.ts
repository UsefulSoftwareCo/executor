import { describe, expect, it } from "@effect/vitest";
import { ConnectionId, ScopeId, SecretId } from "@executor-js/sdk";

import {
  effectiveBindingForScope,
  missingCredentialLabels,
  type BindingRowForCredentialStatus,
  type SourceForCredentialStatus,
} from "./credential-status";

const userScope = ScopeId.make("user");
const orgScope = ScopeId.make("org");
const scopeRanks = new Map([
  [userScope, 0],
  [orgScope, 1],
]);

const source: SourceForCredentialStatus = {
  config: {
    headers: {
      Authorization: { kind: "binding", slot: "header:authorization", prefix: "Bearer " },
    },
    oauth2: {
      securitySchemeName: "oauth2",
      flow: "clientCredentials",
      clientIdSlot: "oauth2:oauth2:client-id",
      clientSecretSlot: "oauth2:oauth2:client-secret",
      connectionSlot: "oauth2:oauth2:connection",
    },
  },
};

const authorizationCodeSource: SourceForCredentialStatus = {
  config: {
    oauth2: {
      securitySchemeName: "oauth2",
      flow: "authorizationCode",
      clientIdSlot: "oauth2:oauth2:client-id",
      clientSecretSlot: "oauth2:oauth2:client-secret",
      connectionSlot: "oauth2:oauth2:connection",
    },
  },
};

const bindings = (
  scopeId: ScopeId,
  slots: readonly string[],
): readonly BindingRowForCredentialStatus[] =>
  slots.map((slot) => ({
    slot,
    scopeId,
    value:
      slot === "oauth2:oauth2:connection"
        ? {
            kind: "connection",
            connectionId: ConnectionId.make(`${scopeId}-connection`),
          }
        : {
            kind: "secret",
            secretId: SecretId.make(`${scopeId}-${slot}`),
          },
  }));

const allSlots = [
  "header:authorization",
  "oauth2:oauth2:client-id",
  "oauth2:oauth2:client-secret",
  "oauth2:oauth2:connection",
] as const;

describe("OpenAPI credential status", () => {
  it("treats personal bindings as satisfying the user's credential status for an org source", () => {
    expect(
      missingCredentialLabels(source, bindings(userScope, allSlots), userScope, scopeRanks, {
        liveConnectionIds: [ConnectionId.make("user-connection")],
      }),
    ).toEqual([]);
  });

  it("falls back to shared org bindings when the user has no personal override", () => {
    expect(
      missingCredentialLabels(source, bindings(orgScope, allSlots), userScope, scopeRanks, {
        liveConnectionIds: [ConnectionId.make("org-connection")],
      }),
    ).toEqual([]);
  });

  it("treats a stale connection binding as missing OAuth credentials", () => {
    expect(
      missingCredentialLabels(source, bindings(userScope, allSlots), userScope, scopeRanks, {
        liveConnectionIds: [],
      }),
    ).toEqual(["OAuth client connection"]);
  });

  it("treats a live authorization-code connection as ready without source client credentials", () => {
    expect(
      missingCredentialLabels(
        authorizationCodeSource,
        bindings(userScope, ["oauth2:oauth2:connection"]),
        userScope,
        scopeRanks,
        {
          liveConnectionIds: [ConnectionId.make("user-connection")],
        },
      ),
    ).toEqual([]);
  });

  it("requires client credentials before starting authorization-code OAuth when no connection is bound", () => {
    expect(
      missingCredentialLabels(authorizationCodeSource, [], userScope, scopeRanks, {
        liveConnectionIds: [],
      }),
    ).toEqual(["Client ID", "Client Secret", "OAuth sign-in"]);
  });

  it("does not treat personal bindings as satisfying org-level credential status", () => {
    expect(
      missingCredentialLabels(source, bindings(userScope, allSlots), orgScope, scopeRanks),
    ).toEqual(["Authorization", "Client ID", "Client Secret", "OAuth client connection"]);
  });

  it("prefers the personal binding over a shared org binding", () => {
    const binding = effectiveBindingForScope(
      [
        ...bindings(orgScope, ["oauth2:oauth2:connection"]),
        ...bindings(userScope, ["oauth2:oauth2:connection"]),
      ],
      "oauth2:oauth2:connection",
      userScope,
      scopeRanks,
    );

    expect(binding?.scopeId).toEqual(userScope);
  });
});
