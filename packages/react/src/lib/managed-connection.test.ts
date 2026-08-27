import { describe, expect, it } from "@effect/vitest";
import {
  AuthTemplateSlug,
  ConnectionAddress,
  ConnectionName,
  IntegrationSlug,
  ProviderKey,
  type Connection,
  type HealthCheckResult,
} from "@executor-js/sdk/shared";

import { connectionRowPolicy } from "./managed-connection";

const connection = (overrides: Partial<Connection> = {}): Connection => ({
  owner: "org",
  integration: IntegrationSlug.make("linear_mcp"),
  name: ConnectionName.make("main"),
  template: AuthTemplateSlug.make("oauth2"),
  provider: ProviderKey.make("default"),
  address: ConnectionAddress.make("linear_mcp.org.main"),
  ...overrides,
});

const health = (overrides: Partial<HealthCheckResult> = {}): HealthCheckResult => ({
  status: "healthy",
  checkedAt: 0,
  ...overrides,
});

describe("connectionRowPolicy", () => {
  it("offers Remove and Reconnect on an ordinary connection", () => {
    const policy = connectionRowPolicy(connection(), health());
    expect(policy).toMatchObject({ managed: false, canRemove: true, canReconnect: true });
  });

  it("withholds Remove on an enterprise-managed connection", () => {
    // There is nothing local to delete: renewal re-runs the ID-JAG chain from
    // the stored assertion, so a row that vanished would claim a revocation
    // that did not happen — the provider still authorizes the member.
    expect(connectionRowPolicy(connection({ enterpriseManaged: true }), health()).canRemove).toBe(
      false,
    );
  });

  it("withholds Reconnect on an enterprise-managed connection", () => {
    // Reconnect exists to re-consent through the browser. This profile has no
    // consent step, and the console holds no identity assertion to present.
    expect(
      connectionRowPolicy(connection({ enterpriseManaged: true }), health()).canReconnect,
    ).toBe(false);
  });

  it("withholds Reconnect from an ORDINARY connection an administrator blocked", () => {
    // The interactive flow is exactly the route the identity provider just
    // closed; offering it would route the user around the decision.
    const policy = connectionRowPolicy(
      connection(),
      health({ status: "expired", blockedByAdmin: true }),
    );
    expect(policy.canReconnect).toBe(false);
    // Removing an ordinary connection is still the member's own call.
    expect(policy.canRemove).toBe(true);
  });

  it("reads the administrator verdict from the field, never the status word", () => {
    expect(connectionRowPolicy(connection(), health({ status: "expired" })).blockedByAdmin).toBe(
      false,
    );
  });

  it("surfaces the provider's code only while the block stands", () => {
    expect(
      connectionRowPolicy(
        connection(),
        health({ blockedByAdmin: true, oauthErrorCode: "invalid_target" }),
      ).oauthErrorCode,
    ).toBe("invalid_target");
    // A code left over from some other refusal is not an administrator
    // decision, and must not be presented as one.
    expect(
      connectionRowPolicy(connection(), health({ oauthErrorCode: "invalid_grant" })).oauthErrorCode,
    ).toBeNull();
  });

  it("treats a never-checked connection as unblocked", () => {
    expect(connectionRowPolicy(connection({ enterpriseManaged: true }), null)).toMatchObject({
      managed: true,
      blockedByAdmin: false,
      oauthErrorCode: null,
    });
  });

  it("does not infer managed state from an absent field", () => {
    // `enterpriseManaged` is projected server-side from the connection's
    // persisted state. An older row that carries nothing is ordinary, not
    // ambiguous.
    expect(connectionRowPolicy(connection(), undefined).managed).toBe(false);
  });
});
