import { describe, expect, it } from "@effect/vitest";
import { ScopeId } from "@executor-js/sdk/shared";

import {
  secretsForCredentialTarget,
  secretScopeOptionsForCredentialTarget,
} from "./secret-credential-scope";
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

  it("exposes outer-scope secrets for personal credential overrides", () => {
    expect(
      secretsForCredentialTarget(
        [
          { id: "shared-token", scopeId: "org", name: "Shared token" },
          { id: "personal-token", scopeId: "user", name: "Personal token" },
        ],
        ScopeId.make("user"),
        [{ id: ScopeId.make("user") }, { id: ScopeId.make("org") }],
      ).map((secret) => secret.id),
    ).toEqual(["shared-token", "personal-token"]);
  });

  it("does not expose inner-scope secrets for organization default credentials", () => {
    expect(
      secretsForCredentialTarget(
        [
          { id: "shared-token", scopeId: "org", name: "Shared token" },
          { id: "personal-token", scopeId: "user", name: "Personal token" },
        ],
        ScopeId.make("org"),
        [{ id: ScopeId.make("user") }, { id: ScopeId.make("org") }],
      ).map((secret) => secret.id),
    ).toEqual(["shared-token"]);
  });
});

describe("secretScopeOptionsForCredentialTarget", () => {
  const userScope = ScopeId.make("user");
  const orgScope = ScopeId.make("org");
  const options = [
    {
      scopeId: userScope,
      label: "Personal",
      description: "Saved only for your account.",
    },
    {
      scopeId: orgScope,
      label: "Organization",
      description: "Shared with everyone who can use this source.",
    },
  ];
  const scopeStack = [{ id: userScope }, { id: orgScope }];

  it("lets personal credential creation target personal or outer scopes", () => {
    expect(
      secretScopeOptionsForCredentialTarget(options, userScope, scopeStack).map(
        (option) => option.label,
      ),
    ).toEqual(["Personal", "Organization"]);
  });

  it("does not let organization credential creation target inner scopes", () => {
    expect(
      secretScopeOptionsForCredentialTarget(options, orgScope, scopeStack).map(
        (option) => option.label,
      ),
    ).toEqual(["Organization"]);
  });
});

describe("secretValueInputType", () => {
  it("uses password inputs until a value is revealed", () => {
    expect(secretValueInputType({ revealable: true, revealed: false })).toBe("password");
    expect(secretValueInputType({ revealable: false, revealed: false })).toBe("password");
    expect(secretValueInputType({ revealable: true, revealed: true })).toBe("text");
  });
});
