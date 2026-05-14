import { describe, expect, it } from "@effect/vitest";
import { ScopeId } from "@executor-js/sdk";

import { secretsForCredentialTarget } from "./secret-credential-scope";
import { secretValueInputType } from "./secret-input";

describe("secretsForCredentialTarget", () => {
  it("only exposes secrets owned by the target credential scope", () => {
    expect(
      secretsForCredentialTarget(
        [
          { id: "shared-token", scopeId: "org", name: "Shared token" },
          { id: "personal-token", scopeId: "user", name: "Personal token" },
        ],
        ScopeId.make("org"),
      ).map((secret) => secret.id),
    ).toEqual(["shared-token"]);
  });
});

describe("secretValueInputType", () => {
  it("uses password inputs until a value is revealed", () => {
    expect(secretValueInputType({ revealable: true, revealed: false })).toBe("password");
    expect(secretValueInputType({ revealable: false, revealed: false })).toBe("password");
    expect(secretValueInputType({ revealable: true, revealed: true })).toBe("text");
  });
});
