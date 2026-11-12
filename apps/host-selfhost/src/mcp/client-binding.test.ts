import { describe, expect, it } from "@effect/vitest";

import { makeInMemoryMcpClientBridge } from "@executor-js/host-mcp/in-memory-client-bridge";
import type { Principal } from "@executor-js/host-mcp";
import { authenticateClientBinding } from "./auth";

const owner: Principal = {
  accountId: "account",
  organizationId: "organization",
  organizationName: "Organization",
  email: "owner@example.test",
  name: "Owner",
  avatarUrl: null,
  roles: [],
  orgRoleModel: "none",
};
const manifest = {
  tools: [{ name: "hello" }],
  resources: [],
  prompts: [],
};

describe("self-host MCP client binding authentication", () => {
  it("keeps requests remote-only when no client binding token is supplied", () => {
    const bridge = makeInMemoryMcpClientBridge();
    const outcome = authenticateClientBinding(
      owner,
      new Request("http://localhost/mcp"),
      bridge,
      "Bearer challenge",
    );
    expect(outcome).toEqual({ _tag: "Authenticated", principal: owner });
  });

  it("rejects invalid or cross-principal tokens and ignores spoofed identity", () => {
    const bridge = makeInMemoryMcpClientBridge();
    const connection = bridge.connect({ principal: owner, manifest, send: () => {} });
    const spoofed = new Headers({
      "x-executor-client-token": connection.bindingToken,
      "x-executor-client-identity": "attacker-selected",
    });
    const bound = authenticateClientBinding(
      owner,
      new Request("http://localhost/mcp", { headers: spoofed }),
      bridge,
      "Bearer challenge",
    );
    expect(bound).toEqual({
      _tag: "Authenticated",
      principal: owner,
      clientIdentity: bridge.getBinding(connection.bindingToken, owner)?.clientIdentity,
      clientManifestGeneration: connection.manifestGeneration,
    });
    const outcome = authenticateClientBinding(
      { ...owner, accountId: "other-account" },
      new Request("http://localhost/mcp", { headers: spoofed }),
      bridge,
      "Bearer challenge",
    );
    expect(outcome).toEqual({ _tag: "Unauthorized", challenge: "Bearer challenge" });
    expect(
      authenticateClientBinding(
        owner,
        new Request("http://localhost/mcp", {
          headers: { "x-executor-client-token": "not-a-binding" },
        }),
        bridge,
        "Bearer challenge",
      ),
    ).toEqual({ _tag: "Unauthorized", challenge: "Bearer challenge" });
  });

  it("creates a fresh identity and generation for every reconnect", () => {
    const bridge = makeInMemoryMcpClientBridge();
    const first = bridge.connect({ principal: owner, manifest, send: () => {} });
    const second = bridge.connect({ principal: owner, manifest, send: () => {} });
    const firstBinding = bridge.getBinding(first.bindingToken, owner);
    const secondBinding = bridge.getBinding(second.bindingToken, owner);

    expect(secondBinding?.clientIdentity).not.toBe(firstBinding?.clientIdentity);
    expect(secondBinding?.manifestGeneration).toBeGreaterThan(
      firstBinding?.manifestGeneration ?? 0,
    );
    expect(bridge.authenticate(first.bindingToken, owner)).toBe(firstBinding?.clientIdentity);
    expect(bridge.authenticate(second.bindingToken, owner)).toBe(secondBinding?.clientIdentity);
  });
});
