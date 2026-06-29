// ---------------------------------------------------------------------------
// `mcpResourceKey` must never throw on a missing resource.
//
// Sessions persisted before scoped toolkits added the `resource` field
// deserialize with `resource: undefined`. Owner validation keys the stored
// session's resource against the request's, so an unguarded `resource.kind`
// read there threw `TypeError: Cannot read properties of undefined (reading
// 'kind')` on every reconnect to a legacy session. A missing resource is a
// default `/mcp` session, so it must key to "default".
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";

import { defaultMcpResource, mcpResourceKey } from "./index";

describe("mcpResourceKey", () => {
  it('keys the default resource to "default"', () => {
    expect(mcpResourceKey(defaultMcpResource)).toBe("default");
    expect(mcpResourceKey({ kind: "default" })).toBe("default");
  });

  it('keys a toolkit resource to "toolkit:<slug>"', () => {
    expect(mcpResourceKey({ kind: "toolkit", slug: "github" })).toBe("toolkit:github");
  });

  it("treats a missing resource (legacy session meta) as the default key", () => {
    expect(mcpResourceKey(undefined)).toBe("default");
    expect(mcpResourceKey(null)).toBe("default");
  });

  it("matches a legacy (missing) resource against an explicit default resource", () => {
    // The exact comparison owner validation performs: a reconnect carries the
    // default resource, the stored legacy meta carries none, and they match.
    expect(mcpResourceKey(undefined)).toBe(mcpResourceKey(defaultMcpResource));
  });
});
