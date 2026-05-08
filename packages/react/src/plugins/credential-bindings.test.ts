import { describe, expect, it } from "@effect/vitest";
import { ScopeId, SecretId } from "@executor-js/sdk";

import {
  httpCredentialsFromConfiguredCredentialBindings,
  initialCredentialTargetScope,
  secretBackedValuesFromConfiguredCredentialBindings,
} from "./credential-bindings";

describe("credential binding editor helpers", () => {
  it("hydrates configured credentials with binding and secret scopes", () => {
    const personalScope = ScopeId.make("user_1");
    const organizationScope = ScopeId.make("org_1");

    const credentials = httpCredentialsFromConfiguredCredentialBindings({
      headers: {
        Authorization: {
          slot: "header:authorization",
          prefix: "Bearer ",
        },
      },
      queryParams: {
        token: {
          slot: "query_param:token",
        },
      },
      bindings: [
        {
          slot: "header:authorization",
          scopeId: personalScope,
          value: {
            kind: "secret",
            secretId: SecretId.make("personal-api-token"),
            secretScopeId: organizationScope,
          },
        },
        {
          slot: "query_param:token",
          scopeId: organizationScope,
          value: {
            kind: "text",
            text: "literal-token",
          },
        },
      ],
    });

    expect(credentials.headers).toEqual([
      {
        name: "Authorization",
        secretId: "personal-api-token",
        prefix: "Bearer ",
        presetKey: "bearer",
        targetScope: personalScope,
        secretScope: organizationScope,
      },
    ]);
    expect(credentials.queryParams).toEqual([
      {
        name: "token",
        secretId: null,
        literalValue: "literal-token",
      },
    ]);
  });

  it("uses the first binding as the initial target scope", () => {
    const sourceScope = ScopeId.make("org_1");
    const personalScope = ScopeId.make("user_1");

    expect(
      initialCredentialTargetScope(sourceScope, [
        {
          slot: "header:authorization",
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
            slot: "header:authorization",
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
