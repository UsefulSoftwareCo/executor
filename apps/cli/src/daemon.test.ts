import { describe, expect, it } from "@effect/vitest";

import { canAutoStartLocalDaemonForHost } from "./daemon";

describe("canAutoStartLocalDaemonForHost", () => {
  it("allows loopback hosts", () => {
    expect(canAutoStartLocalDaemonForHost("localhost")).toBe(true);
    expect(canAutoStartLocalDaemonForHost("127.0.0.1")).toBe(true);
    expect(canAutoStartLocalDaemonForHost("[::1]")).toBe(true);
  });

  it("does not treat wildcard binds as loopback", () => {
    expect(canAutoStartLocalDaemonForHost("0.0.0.0")).toBe(false);
    expect(canAutoStartLocalDaemonForHost("::")).toBe(false);
  });
});
