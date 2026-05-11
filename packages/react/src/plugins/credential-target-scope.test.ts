import { describe, expect, it } from "@effect/vitest";
import { ScopeId } from "@executor-js/sdk";

import {
  credentialTargetScopeOptions,
  normalizeCredentialTargetScope,
} from "./credential-target-scope";

describe("credential target scope options", () => {
  it("offers personal and organization targets for a shared source scope", () => {
    const userScope = ScopeId.make("user");
    const orgScope = ScopeId.make("org");

    expect(
      credentialTargetScopeOptions({
        sourceScope: orgScope,
        userScope,
      }).map((option) => ({ scopeId: option.scopeId, label: option.label })),
    ).toEqual([
      { scopeId: userScope, label: "Personal" },
      { scopeId: orgScope, label: "Organization" },
    ]);
  });

  it("only offers personal credentials when the source is personal", () => {
    const userScope = ScopeId.make("user");

    expect(
      credentialTargetScopeOptions({
        sourceScope: userScope,
        userScope,
      }).map((option) => ({ scopeId: option.scopeId, label: option.label })),
    ).toEqual([{ scopeId: userScope, label: "Personal" }]);
  });

  it("falls back to the default target when the selected scope is no longer valid", () => {
    const userScope = ScopeId.make("user");
    const orgScope = ScopeId.make("org");
    const otherScope = ScopeId.make("other");
    const options = credentialTargetScopeOptions({
      sourceScope: orgScope,
      userScope,
    });

    expect(normalizeCredentialTargetScope(otherScope, options)).toBe(userScope);
    expect(normalizeCredentialTargetScope(orgScope, options)).toBe(orgScope);
  });
});
