import { describe, expect, it } from "@effect/vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validateReleaseTag, validateReleaseVersion } from "../scripts/validate-release-ref";

const workflow = (name: string): string =>
  readFileSync(resolve(import.meta.dirname, "..", ".github/workflows", name), "utf8");

describe("release workflow hardening", () => {
  it("accepts only semver release versions and v-prefixed semver tags", () => {
    expect(validateReleaseVersion("1.2.3")).toBe("1.2.3");
    expect(validateReleaseVersion("1.2.3-beta.4")).toBe("1.2.3-beta.4");
    expect(validateReleaseTag("v1.2.3")).toBe("v1.2.3");
    expect(validateReleaseTag("v1.2.3-beta.4+build.5")).toBe("v1.2.3-beta.4+build.5");

    expect(() => validateReleaseVersion("v1.2.3")).toThrow();
    expect(() => validateReleaseVersion("1.2")).toThrow();
    expect(() => validateReleaseTag("1.2.3")).toThrow();
    expect(() => validateReleaseTag("v1.2.3; echo unsafe")).toThrow();
    expect(() => validateReleaseTag("v01.2.3")).toThrow();
  });

  it("validates release values through environment variables before shell use", () => {
    const publishExecutor = workflow("publish-executor-package.yml");
    const release = workflow("release.yml");
    const publishDesktop = workflow("publish-desktop.yml");

    expect(publishExecutor).toContain(
      "bun run scripts/validate-release-ref.ts --tag-env RAW_RELEASE_TAG --write-env RELEASE_TAG",
    );
    expect(release).toContain(
      "bun run scripts/validate-release-ref.ts --version-env RELEASE_VERSION --output tag",
    );
    expect(publishDesktop).toContain(
      "bun run scripts/validate-release-ref.ts --tag-env RAW_RELEASE_TAG --write-env RELEASE_TAG",
    );

    expect(release).not.toContain('tag="v${{ steps.detect_release.outputs.version }}"');
    expect(publishDesktop).not.toContain("ref: refs/tags/${{ inputs.tag }}");
    expect(publishDesktop).not.toContain('gh release download "${{ inputs.tag }}"');
    expect(publishExecutor).not.toMatch(/\n\s+RELEASE_TAG: \$\{\{ github\.event_name/u);
  });

  it("does not persist checkout credentials in release workflows", () => {
    for (const name of [
      "publish-executor-package.yml",
      "release.yml",
      "publish-desktop.yml",
      "pkg-pr-new.yml",
    ]) {
      expect(workflow(name)).toContain("persist-credentials: false");
    }
  });
});
