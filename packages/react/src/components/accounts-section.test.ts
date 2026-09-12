import { describe, expect, it } from "@effect/vitest";

import { canReconnectConnectionForAccess } from "./accounts-section";

describe("connection reconnect access", () => {
  it("requires management access for OAuth and non-OAuth connections", () => {
    expect(canReconnectConnectionForAccess(false, "oauth")).toBe(false);
    expect(canReconnectConnectionForAccess(false, "refresh")).toBe(false);
    expect(canReconnectConnectionForAccess(true, "oauth")).toBe(true);
    expect(canReconnectConnectionForAccess(true, "refresh")).toBe(true);
  });
});
