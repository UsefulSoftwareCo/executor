import { describe, expect, it } from "@effect/vitest";
import { isExpectedNavigationAbort } from "./navigation-errors";

const abort = (overrides: Partial<Parameters<typeof isExpectedNavigationAbort>[0]> = {}) =>
  isExpectedNavigationAbort({
    message: "ERR_FAILED (-2) loading 'http://127.0.0.1:4789/?_token=redacted'",
    windowDestroyed: false,
    appQuitting: false,
    ...overrides,
  });

describe("isExpectedNavigationAbort", () => {
  it("treats ERR_FAILED as expected when the window was destroyed mid-load", () => {
    expect(abort({ windowDestroyed: true })).toBe(true);
  });

  it("treats ERR_CONNECTION_RESET as expected while the app is quitting", () => {
    expect(
      abort({
        message: "ERR_CONNECTION_RESET (-101) loading 'http://127.0.0.1:4789/'",
        appQuitting: true,
      }),
    ).toBe(true);
  });

  it("keeps ERR_FAILED unexpected under a live window", () => {
    // A load that fails while the window is alive and the app is running is a
    // genuine "cannot reach the local server" failure and must still surface.
    expect(abort()).toBe(false);
  });

  it("keeps an unrelated navigation failure unexpected even during teardown", () => {
    expect(
      abort({
        message: "ERR_CERT_AUTHORITY_INVALID (-202) loading 'https://example.invalid/'",
        windowDestroyed: true,
      }),
    ).toBe(false);
  });
});
