import { describe, expect, it } from "@effect/vitest";

import { ScopeId } from "@executor-js/sdk/shared";

import {
  findMissingSecretCredentialBindings,
  secretCredentialBindingsSubmitError,
  type PendingSecretCredentialBinding,
} from "./secret-binding-validation";

const binding = (secretId: string, secretScope: string): PendingSecretCredentialBinding => ({
  slot: "header:authorization",
  secretId,
  scope: ScopeId.make(secretScope),
  secretScope: ScopeId.make(secretScope),
});

describe("OpenAPI secret binding validation", () => {
  it("keeps bindings whose secret exists in the selected credential scope", () => {
    const missing = findMissingSecretCredentialBindings(
      [binding("cloudflare-api-authorization", "mulroy-cloud")],
      [{ id: "cloudflare-api-authorization", scopeId: "mulroy-cloud" }],
    );

    expect(missing).toEqual([]);
  });

  it("returns a submit-blocking error when a selected secret no longer exists", () => {
    const message = secretCredentialBindingsSubmitError(
      [binding("cloudflare-dmmulroy-api-authorization", "mulroy-cloud")],
      [{ id: "cloudflare-api-authorization-dmmulroy", scopeId: "mulroy-cloud" }],
    );

    expect(message).toContain("cloudflare-dmmulroy-api-authorization");
    expect(message).toContain("before adding the source");
  });

  it("requires the secret to exist in the same credential scope", () => {
    const staleOrgBinding = binding("api-token", "mulroy-cloud");
    const missing = findMissingSecretCredentialBindings(
      [staleOrgBinding],
      [{ id: "api-token", scopeId: "user-dmmulroy" }],
    );

    expect(missing).toEqual([staleOrgBinding]);
  });
});
