import { describe, expect, it } from "@effect/vitest";
import { ConnectionId, ScopeId, SecretId } from "@executor-js/sdk";

import {
  effectiveSourceCredentialBinding,
  missingSourceCredentialLabels,
  type SourceCredentialBindingRef,
  type SourceCredentialSlot,
} from "./source-credential-status-core";

const userScope = ScopeId.make("user");
const orgScope = ScopeId.make("org");
const scopeRanks = new Map([
  [userScope, 0],
  [orgScope, 1],
]);

const slots: readonly SourceCredentialSlot[] = [
  { kind: "secret", slot: "header:authorization", label: "Authorization" },
  { kind: "connection", slot: "auth:oauth2:connection", label: "OAuth sign-in" },
];

const bindings = (scopeId: ScopeId): readonly SourceCredentialBindingRef[] => [
  {
    slot: "header:authorization",
    scopeId,
    value: {
      kind: "secret",
      secretId: SecretId.make(`${scopeId}-token`),
    },
  },
  {
    slot: "auth:oauth2:connection",
    scopeId,
    value: {
      kind: "connection",
      connectionId: ConnectionId.make(`${scopeId}-connection`),
    },
  },
];

describe("source credential status", () => {
  it("treats inherited source-scope credentials as satisfying a user target", () => {
    expect(
      missingSourceCredentialLabels({
        slots,
        bindings: bindings(orgScope),
        targetScope: userScope,
        scopeRanks,
        liveConnectionIds: [ConnectionId.make("org-connection")],
      }),
    ).toEqual([]);
  });

  it("does not let inner-scope credentials satisfy an outer target", () => {
    expect(
      missingSourceCredentialLabels({
        slots,
        bindings: bindings(userScope),
        targetScope: orgScope,
        scopeRanks,
      }),
    ).toEqual(["Authorization", "OAuth sign-in"]);
  });

  it("treats stale connection bindings as missing", () => {
    expect(
      missingSourceCredentialLabels({
        slots,
        bindings: bindings(userScope),
        targetScope: userScope,
        scopeRanks,
        liveConnectionIds: [],
      }),
    ).toEqual(["OAuth sign-in"]);
  });

  it("prefers the inner exact binding over inherited credentials", () => {
    const binding = effectiveSourceCredentialBinding(
      [...bindings(orgScope), ...bindings(userScope)],
      "header:authorization",
      userScope,
      scopeRanks,
    );

    expect(binding?.scopeId).toEqual(userScope);
  });
});
