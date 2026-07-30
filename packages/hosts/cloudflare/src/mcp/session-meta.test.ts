import { describe, expect, it } from "@effect/vitest";

import type { Principal } from "@executor-js/host-mcp";

import type { SessionMeta } from "./agent-session-durable-object";
import { carrySessionInit } from "./session-meta";

const resolved: SessionMeta = {
  organizationId: "org-1",
  organizationName: "Org One",
  userId: "acct-1",
  elicitationMode: "model",
  resource: { kind: "default" },
};

const principal: Principal = {
  accountId: "acct-1",
  organizationId: "org-1",
  organizationName: "Org One",
  email: "person@example.com",
  name: "Person",
  avatarUrl: null,
  roles: ["admin"],
};

describe("carrySessionInit", () => {
  it("carries the verified principal onto the stored meta", () => {
    const meta = carrySessionInit(resolved, { principal });
    expect(meta.principal).toEqual(principal);
  });

  it("carries webOrigin and principal together", () => {
    const meta = carrySessionInit(resolved, {
      webOrigin: "https://executor.example.com",
      principal,
    });
    expect(meta.webOrigin).toBe("https://executor.example.com");
    expect(meta.principal).toEqual(principal);
  });

  it("leaves both unset when the init carries neither", () => {
    const meta = carrySessionInit(resolved, {});
    expect(meta).toEqual(resolved);
    expect("principal" in meta).toBe(false);
    expect("webOrigin" in meta).toBe(false);
  });

  it("does not let carried fields clobber host-resolved meta", () => {
    const meta = carrySessionInit(resolved, { principal });
    expect(meta.organizationId).toBe("org-1");
    expect(meta.userId).toBe("acct-1");
    expect(meta.resource).toEqual({ kind: "default" });
  });
});
