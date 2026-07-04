import { describe, expect, it } from "@effect/vitest";
import {
  AuthTemplateSlug,
  ConnectionAddress,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderKey,
  type Connection,
  type HealthCheckResult,
} from "@executor-js/sdk/shared";

import {
  connectionHealthProbeSnapshot,
  resolveConnectionHealthProbe,
} from "./use-connection-health";

const health = (status: HealthCheckResult["status"], checkedAt: number): HealthCheckResult => ({
  status,
  checkedAt,
});

const connection = (
  lastHealth: HealthCheckResult | null,
  overrides: Partial<Connection> = {},
): Connection => ({
  owner: "user",
  name: ConnectionName.make("main"),
  integration: IntegrationSlug.make("mcp"),
  template: AuthTemplateSlug.make("oauth2"),
  provider: ProviderKey.make("default"),
  address: ConnectionAddress.make("tools.mcp.user.main"),
  identityLabel: "Main account",
  description: null,
  expiresAt: 1_000,
  oauthClient: OAuthClientSlug.make("mcp-client"),
  oauthClientOwner: "user",
  oauthScope: "channels:history users:read",
  lastHealth,
  ...overrides,
});

describe("resolveConnectionHealthProbe", () => {
  it("surfaces a live Check now result for the row snapshot that was checked", () => {
    const row = connection(health("expired", 100));
    const live = connectionHealthProbeSnapshot(row, health("healthy", 200));

    expect(resolveConnectionHealthProbe(row, live)?.status).toBe("healthy");
  });

  it("does not let a stale live probe shadow a fresher persisted server verdict", () => {
    const before = connection(health("expired", 100));
    const live = connectionHealthProbeSnapshot(before, health("expired", 150));
    const after = connection(health("healthy", 250));

    expect(resolveConnectionHealthProbe(after, live)?.status).toBe("healthy");
  });

  it("clears a stale live probe after the credential row is reminted", () => {
    const before = connection(health("expired", 100), { expiresAt: 1_000 });
    const live = connectionHealthProbeSnapshot(before, health("expired", 150));
    const after = connection(null, { expiresAt: 2_000 });

    expect(resolveConnectionHealthProbe(after, live)).toBeNull();
  });
});
