import { describe, expect, it } from "@effect/vitest";
import { ScopeId, SecretId } from "@executor-js/sdk/shared";

import { httpCredentialsFromConfiguredCredentialBindings } from "./http-credentials";

describe("httpCredentialsFromConfiguredCredentialBindings", () => {
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
          slotKey: "header:authorization",
          scopeId: personalScope,
          value: {
            kind: "secret",
            secretId: SecretId.make("personal-api-token"),
            secretScopeId: organizationScope,
          },
        },
        {
          slotKey: "query_param:token",
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
        valueKind: "secret",
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
        valueKind: "text",
        literalValue: "literal-token",
      },
    ]);
  });
});
