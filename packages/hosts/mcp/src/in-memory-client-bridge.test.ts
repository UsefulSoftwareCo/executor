import { describe, expect, it } from "@effect/vitest";

import { makeInMemoryMcpClientBridge, type McpClientManifest } from "./in-memory-client-bridge";
import type { Principal } from "./seams";

const principal = (accountId: string): Principal => ({
  accountId,
  organizationId: "org",
  organizationName: "Org",
  email: `${accountId}@example.com`,
  name: null,
  avatarUrl: null,
  roles: [],
  orgRoleModel: "none",
});

const manifest = (name: string): McpClientManifest => ({
  tools: [{ name }],
  resources: [{ uri: `file:///${name}` }],
  prompts: [{ name }],
});

describe("in-memory MCP client bridge", () => {
  it("isolates identities and rejects principal mismatches", () => {
    const bridge = makeInMemoryMcpClientBridge();
    const owner = principal("a");
    const a = bridge.connect({ principal: owner, send: () => {}, manifest: manifest("a") });
    const b = bridge.connect({
      principal: principal("b"),
      send: () => {},
      manifest: manifest("b"),
    });
    expect(bridge.authenticate(a.bindingToken, owner)).toEqual(expect.any(String));
    expect(bridge.authenticate(a.bindingToken, principal("b"))).toBeNull();
    expect(bridge.authenticate(b.bindingToken, owner)).toBeNull();
    expect(bridge.getManifest(a.bindingToken, owner)?.manifest.tools[0]?.name).toBe("a");
  });

  it("routes duplicate tool names only to their originating client", async () => {
    const bridge = makeInMemoryMcpClientBridge();
    const owner = principal("shared-owner");
    const makeClient = (result: string) => {
      let connection!: ReturnType<typeof bridge.connect>;
      connection = bridge.connect({
        principal: owner,
        manifest: {
          tools: [{ name: "filesystem.read" }, { name: `${result}.only` }],
          resources: [],
          prompts: [],
        },
        send: (frame) => connection.respond(frame.id, result),
      });
      return connection;
    };
    const clientA = makeClient("client-a");
    const clientB = makeClient("client-b");
    const call = (bindingToken: string, name: string) =>
      bridge.request(bindingToken, owner, {
        method: "tools/call",
        params: { name },
      });

    await expect(call(clientA.bindingToken, "filesystem.read")).resolves.toBe("client-a");
    await expect(call(clientB.bindingToken, "filesystem.read")).resolves.toBe("client-b");
    await expect(
      bridge.requestForIdentity(
        bridge.authenticate(clientA.bindingToken, owner)!,
        owner,
        clientA.manifestGeneration,
        { method: "tools/call", params: { name: "filesystem.read" } },
      ),
    ).resolves.toBe("client-a");
    await expect(call(clientA.bindingToken, "client-b.only")).rejects.toMatchObject({
      reason: "capability-not-found",
    });
    await expect(call(clientB.bindingToken, "client-a.only")).rejects.toMatchObject({
      reason: "capability-not-found",
    });
  });

  it("replaces manifests without crossing client boundaries", () => {
    const bridge = makeInMemoryMcpClientBridge();
    const owner = principal("a");
    const a = bridge.connect({ principal: owner, send: () => {}, manifest: manifest("old") });
    const b = bridge.connect({ principal: owner, send: () => {}, manifest: manifest("b") });
    const nextGeneration = bridge.replaceManifest(a.bindingToken, owner, manifest("new"));
    expect(nextGeneration).not.toBeNull();
    expect(nextGeneration!.manifestGeneration).toBeGreaterThan(a.manifestGeneration);
    expect(bridge.getManifest(a.bindingToken, owner)?.manifest.tools[0]?.name).toBe("old");
    expect(bridge.getManifest(nextGeneration!.bindingToken, owner)?.manifest.tools[0]?.name).toBe(
      "new",
    );
    expect(bridge.getManifest(b.bindingToken, owner)?.manifest.tools[0]?.name).toBe("b");
  });

  it("rejects stale pinned generations while preserving existing sessions", async () => {
    const bridge = makeInMemoryMcpClientBridge();
    const owner = principal("a");
    let oldConnection!: ReturnType<typeof bridge.connect>;
    oldConnection = bridge.connect({
      principal: owner,
      manifest: manifest("old"),
      send: (frame) => oldConnection.respond(frame.id, "old-result"),
    });
    const replacement = bridge.replaceManifest(oldConnection.bindingToken, owner, manifest("new"));
    expect(replacement).not.toBeNull();
    const nextConnection = replacement!;

    await expect(
      bridge.request(
        nextConnection.bindingToken,
        owner,
        {
          method: "tools/call",
          params: { name: "new" },
        },
        oldConnection.manifestGeneration,
      ),
    ).rejects.toMatchObject({ reason: "stale-generation" });
    expect(
      await bridge.request(
        oldConnection.bindingToken,
        owner,
        { method: "tools/call", params: { name: "old" } },
        oldConnection.manifestGeneration,
      ),
    ).toBe("old-result");
  });

  it("correlates outbound tool, resource and prompt responses", async () => {
    const bridge = makeInMemoryMcpClientBridge();
    const owner = principal("a");
    const frames: Array<{ id: string; method: string }> = [];
    let connection!: ReturnType<typeof bridge.connect>;
    connection = bridge.connect({
      principal: owner,
      manifest: manifest("capability"),
      send: (frame) => {
        frames.push(frame);
        connection.respond(frame.id, { method: frame.method });
      },
    });
    const methods = [
      { method: "tools/call" as const, params: { name: "capability" } },
      { method: "resources/read" as const, params: { uri: "file:///capability" } },
      { method: "prompts/get" as const, params: { name: "capability" } },
    ];
    for (const request of methods) {
      expect(await bridge.request(connection.bindingToken, owner, request)).toEqual({
        method: request.method,
      });
    }
    expect(frames.map((frame) => frame.method)).toEqual(methods.map((request) => request.method));
    expect(new Set(frames.map((frame) => frame.id)).size).toBe(3);
  });

  it("cleans pending requests on disconnect and timeout", async () => {
    const bridge = makeInMemoryMcpClientBridge({ requestTimeoutMs: 10 });
    const owner = principal("a");
    let connection!: ReturnType<typeof bridge.connect>;
    connection = bridge.connect({
      principal: owner,
      manifest: manifest("a"),
      send: () => {},
    });
    const disconnected = bridge.request(connection.bindingToken, owner, {
      method: "tools/call",
      params: { name: "a" },
    });
    connection.disconnect();
    await expect(disconnected).rejects.toThrow("disconnected");
    expect(bridge.size).toBe(0);

    const timeoutClient = bridge.connect({
      principal: owner,
      send: () => {},
      manifest: manifest("a"),
    });
    await expect(
      bridge.request(timeoutClient.bindingToken, owner, {
        method: "resources/read",
        params: { uri: "file:///a" },
      }),
    ).rejects.toThrow("timed out");
  });

  it("binds tokens to stable ownership rather than mutable claims", () => {
    const bridge = makeInMemoryMcpClientBridge();
    const owner = principal("a");
    const connection = bridge.connect({
      principal: owner,
      send: () => {},
      manifest: manifest("a"),
    });
    const refreshedPrincipal: Principal = {
      ...owner,
      organizationName: "Renamed Org",
      email: "updated@example.com",
      roles: ["admin"],
      orgRoleModel: "organization",
      orgRole: "admin",
    };
    expect(bridge.authenticate(connection.bindingToken, refreshedPrincipal)).toEqual(
      expect.any(String),
    );
  });
});
