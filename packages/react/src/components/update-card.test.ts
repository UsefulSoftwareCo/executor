import { describe, expect, it } from "@effect/vitest";

import { isUpdateAvailable } from "@executor-js/api";

import { updateFetchChannel } from "./update-card";

/**
 * `updateFetchChannel` is what lets the hook skip the network call for a
 * build that can never legitimately claim an update — the dev build's
 * unstamped fallback, or a prerelease channel with no published dist-tag.
 * Pinning it here is what keeps that decision testable without rendering.
 */
describe("updateFetchChannel", () => {
  it("fetches nothing for the unstamped dev build", () => {
    expect(updateFetchChannel("0.0.0-dev")).toBeNull();
  });

  it("fetches nothing for the desktop's plain unstamped fallback", () => {
    expect(updateFetchChannel("0.0.0")).toBeNull();
  });

  it("fetches nothing when there is no version yet", () => {
    expect(updateFetchChannel(undefined)).toBeNull();
  });

  it("fetches the latest tag for a release build", () => {
    expect(updateFetchChannel("1.6.0")).toBe("latest");
  });

  it("fetches the beta tag for a beta prerelease", () => {
    expect(updateFetchChannel("1.6.0-beta.2")).toBe("beta");
  });

  it("fetches nothing for a prerelease channel with no matching dist-tag", () => {
    expect(updateFetchChannel("1.6.0-rc.1")).toBeNull();
  });
});

/**
 * The card's verdict is the shared `isUpdateAvailable`, so the fetch decision
 * above and the "should we show the card?" decision can never disagree.
 */
describe("isUpdateAvailable through the card's fetch channel", () => {
  it("stays quiet on the unstamped dev build even if a tag comes back", () => {
    expect(updateFetchChannel("0.0.0-dev")).toBeNull();
    expect(isUpdateAvailable("0.0.0-dev", "1.6.0")).toBe(false);
  });

  it("flags a real update on the latest channel", () => {
    expect(updateFetchChannel("1.6.0")).toBe("latest");
    expect(isUpdateAvailable("1.6.0", "1.6.1")).toBe(true);
  });

  it("flags a real update on the beta channel", () => {
    expect(updateFetchChannel("1.6.0-beta.1")).toBe("beta");
    expect(isUpdateAvailable("1.6.0-beta.1", "1.6.0-beta.2")).toBe(true);
  });
});
