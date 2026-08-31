// ---------------------------------------------------------------------------
// Unit tests for the shared update-check resolver. Pins the resolution order
// (disable, JSON override, single-value override, registry, failure) and the
// semver verdict that both the CLI notice and the web UpdateCard depend on.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";

import {
  __resetDistTagsCache,
  checkForUpdate,
  compareVersions,
  isUnstampedVersion,
  isUpdateAvailable,
  resolveComparisonChannel,
  resolveDistTags,
  resolveUpdateChannel,
} from "./update-check";

const jsonResponse = (body: unknown, ok = true): Response =>
  new Response(JSON.stringify(body), {
    status: ok ? 200 : 500,
    headers: { "content-type": "application/json" },
  });

const fetchReturning = (body: unknown, ok = true): typeof fetch =>
  (async () => jsonResponse(body, ok)) as typeof fetch;

// A fetch impl whose body is not valid JSON, exercising resolveDistTags'
// best-effort catch: any registry misbehaviour collapses to {}.
const fetchThatFails = (): typeof fetch =>
  (async () => new Response("<not json>", { status: 200 })) as typeof fetch;

describe("compareVersions", () => {
  it("orders by major, minor, patch", () => {
    expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
    expect(compareVersions("1.5.22", "1.5.21")).toBe(1);
    expect(compareVersions("1.5.22", "1.5.22")).toBe(0);
  });

  it("treats a prerelease as older than its release", () => {
    expect(compareVersions("1.6.0-beta.1", "1.6.0")).toBe(-1);
    expect(compareVersions("1.6.0-beta.1", "1.6.0-beta.2")).toBe(-1);
  });

  it("returns null for unparseable input", () => {
    expect(compareVersions("not-a-version", "1.0.0")).toBeNull();
  });
});

describe("resolveUpdateChannel", () => {
  it("routes beta builds to the beta channel", () => {
    expect(resolveUpdateChannel("1.6.0-beta.3")).toBe("beta");
    expect(resolveUpdateChannel("1.5.22")).toBe("latest");
    expect(resolveUpdateChannel("0.0.0-dev")).toBe("latest");
  });
});

describe("isUnstampedVersion", () => {
  it("flags 0.0.0, with or without a prerelease suffix", () => {
    expect(isUnstampedVersion("0.0.0")).toBe(true);
    expect(isUnstampedVersion("0.0.0-dev")).toBe(true);
  });

  it("leaves any published version alone", () => {
    expect(isUnstampedVersion("1.5.22")).toBe(false);
    expect(isUnstampedVersion("0.0.1")).toBe(false);
  });

  it("is false for unparseable input", () => {
    expect(isUnstampedVersion("not-a-version")).toBe(false);
  });
});

describe("resolveComparisonChannel", () => {
  it("suppresses unstamped build-time fallback versions", () => {
    expect(resolveComparisonChannel("0.0.0")).toBeNull();
    expect(resolveComparisonChannel("0.0.0-dev")).toBeNull();
  });

  it("suppresses unparseable input", () => {
    expect(resolveComparisonChannel("not-a-version")).toBeNull();
  });

  it("routes a release version to the latest tag", () => {
    expect(resolveComparisonChannel("1.6.0")).toBe("latest");
  });

  it("routes a beta prerelease to the beta tag", () => {
    expect(resolveComparisonChannel("1.6.0-beta.1")).toBe("beta");
  });

  it("suppresses prereleases with no matching dist-tag", () => {
    // rc, alpha, next, dev, ... — none of these publish a dist-tag, so
    // comparing against `latest` would nag forever.
    expect(resolveComparisonChannel("1.6.0-rc.1")).toBeNull();
    expect(resolveComparisonChannel("1.6.0-alpha.1")).toBeNull();
    expect(resolveComparisonChannel("1.6.0-next.1")).toBeNull();
  });
});

describe("isUpdateAvailable", () => {
  it("is false with no current version", () => {
    expect(isUpdateAvailable(undefined, "1.6.0")).toBe(false);
  });

  it("is false with no comparison channel", () => {
    expect(isUpdateAvailable("0.0.0-dev", "1.6.0")).toBe(false);
    expect(isUpdateAvailable("1.6.0-rc.1", "1.6.0")).toBe(false);
  });

  it("is false with no published tag", () => {
    expect(isUpdateAvailable("1.5.22", null)).toBe(false);
  });

  it("is false when already current", () => {
    expect(isUpdateAvailable("1.6.0", "1.6.0")).toBe(false);
  });

  it("is true when a newer version is published on the matching channel", () => {
    expect(isUpdateAvailable("1.6.0", "1.6.1")).toBe(true);
    expect(isUpdateAvailable("1.6.0-beta.1", "1.6.0-beta.2")).toBe(true);
  });
});

describe("resolveDistTags", () => {
  it("returns nothing when the check is disabled", async () => {
    const tags = await resolveDistTags({
      env: { EXECUTOR_DISABLE_UPDATE_CHECK: "1", EXECUTOR_FORCE_LATEST_VERSION: "9.9.9" },
      fetchImpl: fetchThatFails(),
    });
    expect(tags).toEqual({});
  });

  it("honours a JSON dist-tags override", async () => {
    const tags = await resolveDistTags({
      env: { EXECUTOR_NPM_DIST_TAGS: JSON.stringify({ latest: "9.9.9", beta: "9.9.9-beta.1" }) },
      fetchImpl: fetchThatFails(),
    });
    expect(tags).toEqual({ latest: "9.9.9", beta: "9.9.9-beta.1" });
  });

  it("honours a single-value override on both channels", async () => {
    const tags = await resolveDistTags({
      env: { EXECUTOR_FORCE_LATEST_VERSION: "2.0.0" },
      fetchImpl: fetchThatFails(),
    });
    expect(tags).toEqual({ latest: "2.0.0", beta: "2.0.0" });
  });

  it("falls back to the registry, keeping only string tags", async () => {
    __resetDistTagsCache();
    const tags = await resolveDistTags({
      env: {},
      fetchImpl: fetchReturning({ latest: "1.5.22", beta: "1.6.0-beta.1", next: 5 }),
    });
    expect(tags).toEqual({ latest: "1.5.22", beta: "1.6.0-beta.1" });
  });

  it("swallows a failing registry into an empty result", async () => {
    __resetDistTagsCache();
    const tags = await resolveDistTags({ env: {}, fetchImpl: fetchThatFails() });
    expect(tags).toEqual({});
  });

  it("negative-caches a failure so the next call skips the fetch", async () => {
    __resetDistTagsCache();
    const failed = await resolveDistTags({ env: {}, fetchImpl: fetchThatFails() });
    expect(failed).toEqual({});
    // Within the negative TTL the cached empty result is reused, even though a
    // working registry is now reachable (so an offline server pays the timeout
    // once, not per request).
    const cached = await resolveDistTags({
      env: {},
      fetchImpl: fetchReturning({ latest: "1.5.22" }),
    });
    expect(cached).toEqual({});
  });
});

describe("checkForUpdate", () => {
  it("flags an available update on the resolved channel", async () => {
    const status = await checkForUpdate("1.5.22", {
      env: { EXECUTOR_NPM_DIST_TAGS: JSON.stringify({ latest: "1.6.0" }) },
    });
    expect(status.updateAvailable).toBe(true);
    expect(status.latestVersion).toBe("1.6.0");
    expect(status.channel).toBe("latest");
    expect(status.command).toBe("npm i -g executor@latest");
  });

  it("stays quiet when already current", async () => {
    const status = await checkForUpdate("1.6.0", {
      env: { EXECUTOR_NPM_DIST_TAGS: JSON.stringify({ latest: "1.6.0" }) },
    });
    expect(status.updateAvailable).toBe(false);
  });

  it("flags a patch release on the latest channel", async () => {
    const status = await checkForUpdate("1.6.0", {
      env: { EXECUTOR_NPM_DIST_TAGS: JSON.stringify({ latest: "1.6.1" }) },
    });
    expect(status.updateAvailable).toBe(true);
    expect(status.latestVersion).toBe("1.6.1");
  });

  it("compares a beta build against the beta tag", async () => {
    const status = await checkForUpdate("1.6.0-beta.1", {
      env: { EXECUTOR_NPM_DIST_TAGS: JSON.stringify({ latest: "1.5.22", beta: "1.6.0-beta.2" }) },
    });
    expect(status.channel).toBe("beta");
    expect(status.updateAvailable).toBe(true);
    expect(status.latestVersion).toBe("1.6.0-beta.2");
    expect(status.command).toBe("npm i -g executor@beta");
  });

  it("stays quiet on an unstamped dev build", async () => {
    // 0.0.0-dev is the build-time fallback, not a real release. It must never
    // claim an update is available, and — because there is no dist-tag it
    // could legitimately compare against — must not even hit the registry.
    const status = await checkForUpdate("0.0.0-dev", {
      env: { EXECUTOR_FORCE_LATEST_VERSION: "1.5.22" },
      fetchImpl: fetchThatFails(),
    });
    expect(status.updateAvailable).toBe(false);
    expect(status.latestVersion).toBeNull();
  });

  it("stays quiet on the desktop's unstamped fallback (plain 0.0.0)", async () => {
    const status = await checkForUpdate("0.0.0", {
      env: { EXECUTOR_FORCE_LATEST_VERSION: "1.5.22" },
      fetchImpl: fetchThatFails(),
    });
    expect(status.updateAvailable).toBe(false);
    expect(status.latestVersion).toBeNull();
  });

  it("stays quiet on a prerelease channel with no matching dist-tag", async () => {
    const status = await checkForUpdate("1.6.0-rc.1", {
      env: { EXECUTOR_NPM_DIST_TAGS: JSON.stringify({ latest: "1.6.0" }) },
      fetchImpl: fetchThatFails(),
    });
    expect(status.updateAvailable).toBe(false);
    expect(status.latestVersion).toBeNull();
  });
});
