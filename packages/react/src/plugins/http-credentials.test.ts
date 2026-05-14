import { describe, expect, it } from "@effect/vitest";
import { ScopeId } from "@executor-js/sdk";

import {
  configuredCredentialMapFromRows,
  httpCredentialsValid,
  serializeHttpCredentials,
  serializeScopedHttpCredentials,
  type HttpCredentialsState,
} from "./http-credentials";

describe("http credential editor helpers", () => {
  it("serializes text and secret values for request previews", () => {
    const credentials: HttpCredentialsState = {
      headers: [
        { name: "Authorization", secretId: "api-token", prefix: "Bearer " },
        { name: "X-Static", secretId: null, literalValue: "static-value" },
      ],
      queryParams: [
        { name: "api-version", secretId: null, literalValue: "2024-01-01" },
        { name: "token", secretId: "query-token" },
      ],
    };

    expect(httpCredentialsValid(credentials)).toBe(true);
    expect(serializeHttpCredentials(credentials)).toEqual({
      headers: {
        Authorization: { secretId: "api-token", prefix: "Bearer " },
        "X-Static": "static-value",
      },
      queryParams: {
        "api-version": "2024-01-01",
        token: { secretId: "query-token" },
      },
    });
  });

  it("serializes scoped secret values without forcing text values into bindings", () => {
    const targetScope = ScopeId.make("org");
    const secretScope = ScopeId.make("user");

    expect(
      serializeScopedHttpCredentials(
        {
          headers: [
            {
              name: "Authorization",
              secretId: "api-token",
              prefix: "Bearer ",
              targetScope,
              secretScope,
            },
            { name: "X-Static", secretId: null, literalValue: "static-value" },
          ],
          queryParams: [{ name: "api-version", secretId: null, literalValue: "2024-01-01" }],
        },
        targetScope,
      ),
    ).toEqual({
      headers: {
        Authorization: {
          secretId: "api-token",
          prefix: "Bearer ",
          targetScope,
          secretScopeId: secretScope,
        },
        "X-Static": "static-value",
      },
      queryParams: {
        "api-version": "2024-01-01",
      },
    });
  });

  it("builds configured credential maps with bindings only for secret rows", () => {
    const targetScope = ScopeId.make("org");
    const secretScope = ScopeId.make("user");

    expect(
      configuredCredentialMapFromRows(
        [
          {
            name: "Authorization",
            secretId: "api-token",
            prefix: "Bearer ",
            targetScope,
            secretScope,
          },
          { name: "X-Static", secretId: null, literalValue: "static-value" },
          { name: "X-Deferred", secretId: null },
        ],
        targetScope,
        (name) => `header:${name.toLowerCase()}`,
      ),
    ).toEqual({
      values: {
        Authorization: {
          kind: "binding",
          slot: "header:authorization",
          prefix: "Bearer ",
        },
        "X-Static": "static-value",
        "X-Deferred": {
          kind: "binding",
          slot: "header:x-deferred",
        },
      },
      bindings: [
        {
          slot: "header:authorization",
          secretId: "api-token",
          scope: targetScope,
          secretScope,
        },
      ],
    });
  });
});
