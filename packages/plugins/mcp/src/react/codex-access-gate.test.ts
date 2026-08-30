import { describe, expect, it } from "@effect/vitest";

import { accessBlocked, accessPending } from "./codex-access-gate";

describe("accessBlocked", () => {
  it("holds the add only on a refusal", () => {
    expect(accessBlocked({ status: "blocked", message: "macOS blocked this" })).toBe(true);
  });

  it("lets through every answer that is not a refusal", () => {
    // `unsupported` and `nothing-to-check` are answers about the HOST and the
    // PLUGIN, not about permission. Treating either as a block would strand a
    // plugin that needs no grant at all.
    for (const status of ["ok", "unsupported", "nothing-to-check", "unknown", "not-installed"]) {
      expect(accessBlocked({ status })).toBe(false);
    }
  });

  it("does not hold before an answer exists", () => {
    // `accessPending` owns that window; a card without permissions has no
    // probe to wait for and must not be blocked by its own silence.
    expect(accessBlocked(null)).toBe(false);
  });
});

describe("accessPending", () => {
  it("waits while the probe runs", () => {
    expect(accessPending({ checking: true, declaresPermissions: true, access: null })).toBe(true);
    // Still pending on a re-check, even though a previous answer is in hand:
    // that answer is what the user just acted on.
    expect(
      accessPending({ checking: true, declaresPermissions: true, access: { status: "blocked" } }),
    ).toBe(true);
  });

  it("waits for the first answer on a plugin that declares permissions", () => {
    expect(accessPending({ checking: false, declaresPermissions: true, access: null })).toBe(true);
  });

  it("does not wait once an answer has arrived", () => {
    expect(
      accessPending({ checking: false, declaresPermissions: true, access: { status: "ok" } }),
    ).toBe(false);
  });

  it("does not wait when nothing will be checked", () => {
    expect(accessPending({ checking: false, declaresPermissions: false, access: null })).toBe(
      false,
    );
  });
});
