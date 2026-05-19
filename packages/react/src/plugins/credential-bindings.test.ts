import { describe, expect, it } from "@effect/vitest";
import { ScopeId, SecretId } from "@executor-js/sdk/shared";

import {
  initialCredentialTargetScope,
  secretBackedValuesFromConfiguredCredentialBindings,
} from "./credential-bindings";

describe("credential binding editor helpers", () => {
  it("uses the first binding as the initial target scope", () => {
    const sourceScope = ScopeId.make("org_1");
    const personalScope = ScopeId.make("user_1");

    expect(
      initialCredentialTargetScope(sourceScope, [
        {
          slotKey: "header:authorization",
          scopeId: personalScope,
          value: {
            kind: "secret",
            secretId: SecretId.make("personal-api-token"),
          },
        },
      ]),
    ).toBe(personalScope);
    expect(initialCredentialTargetScope(sourceScope, [])).toBe(sourceScope);
  });

  it("hydrates configured credentials to secret-backed OAuth payload values", () => {
    expect(
      secretBackedValuesFromConfiguredCredentialBindings(
        {
          Authorization: {
            slot: "header:authorization",
            prefix: "Bearer ",
          },
          "X-Literal": "literal",
        },
        [
          {
            slotKey: "header:authorization",
            scopeId: ScopeId.make("user_1"),
            value: {
              kind: "secret",
              secretId: SecretId.make("api-token"),
            },
          },
        ],
      ),
    ).toEqual({
      Authorization: {
        secretId: "api-token",
        prefix: "Bearer ",
      },
      "X-Literal": "literal",
    });
  });
});
