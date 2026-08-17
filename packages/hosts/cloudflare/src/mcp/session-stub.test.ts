import { describe, expect, it, vi } from "@effect/vitest";

import { mcpSessionStub } from "./session-stub";

describe("mcpSessionStub", () => {
  it("returns null when Cloudflare rejects a client-supplied Durable Object id", () => {
    const get = vi.fn();
    const namespace = {
      idFromString: (_id: string): string => {
        // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- test boundary: model Cloudflare's throwing namespace checksum parser
        throw new Error("Durable Object ID is not valid for this namespace");
      },
      get,
    };

    expect(mcpSessionStub(namespace, "0".repeat(64))).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("resolves a namespace-validated id to its generated RPC stub", () => {
    const stub = { fetch: vi.fn() };
    const namespace = {
      idFromString: (id: string): string => `parsed:${id}`,
      get: vi.fn(() => stub),
    };

    expect(mcpSessionStub(namespace, "issued-id")).toBe(stub);
    expect(namespace.get).toHaveBeenCalledWith("parsed:issued-id");
  });
});
