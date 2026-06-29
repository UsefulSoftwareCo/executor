import { describe, expect, it } from "@effect/vitest";
import {
  AuthTemplateSlug,
  ConnectionAddress,
  ConnectionName,
  IntegrationSlug,
  ProviderKey,
  type Connection,
  type Owner,
} from "@executor-js/sdk/shared";

import { toolProxyAddress } from "./tool-run-panel";

const connection = (input: { readonly owner: Owner; readonly name: string }): Connection => ({
  owner: input.owner,
  name: ConnectionName.make(input.name),
  integration: IntegrationSlug.make("vercel"),
  template: AuthTemplateSlug.make("default"),
  provider: ProviderKey.make("default"),
  address: ConnectionAddress.make(`tools.vercel.${input.owner}.${input.name}`),
  identityLabel: null,
  expiresAt: null,
});

describe("toolProxyAddress", () => {
  it("builds the address under the SELECTED connection's own owner — user", () => {
    expect(
      toolProxyAddress({
        integration: IntegrationSlug.make("vercel"),
        connection: connection({ owner: "user", name: "scratch" }),
        toolName: "deploy",
      }),
    ).toBe("vercel.user.scratch.deploy");
  });

  it("builds the address under the SELECTED connection's own owner — org", () => {
    expect(
      toolProxyAddress({
        integration: IntegrationSlug.make("vercel"),
        connection: connection({ owner: "org", name: "prod" }),
        toolName: "deploy",
      }),
    ).toBe("vercel.org.prod.deploy");
  });

  it("keeps a dotted tool name intact (never split on dots)", () => {
    expect(
      toolProxyAddress({
        integration: IntegrationSlug.make("vercel"),
        connection: connection({ owner: "org", name: "prod" }),
        toolName: "aliases.deleteAlias",
      }),
    ).toBe("vercel.org.prod.aliases.deleteAlias");
  });

  it("addresses two connections of different owners independently (merged list)", () => {
    const integration = IntegrationSlug.make("vercel");
    const orgAddr = toolProxyAddress({
      integration,
      connection: connection({ owner: "org", name: "prod" }),
      toolName: "deploy",
    });
    const userAddr = toolProxyAddress({
      integration,
      connection: connection({ owner: "user", name: "scratch" }),
      toolName: "deploy",
    });
    // Same tool, two accounts — each addressed under its OWN owner, never an
    // ambient one.
    expect(orgAddr).toBe("vercel.org.prod.deploy");
    expect(userAddr).toBe("vercel.user.scratch.deploy");
  });
});
