import { describe, expect, it } from "@effect/vitest";

import { platformVariantVersion } from "./platform-variant-version";

describe("platformVariantVersion", () => {
  it("keeps a beta platform package below its wrapper version", () => {
    expect(platformVariantVersion("2.0.0-beta.31", "windows-x64")).toBe(
      "2.0.0-0.beta.31.windows-x64",
    );
  });

  it("keeps a stable platform package below its wrapper version", () => {
    expect(platformVariantVersion("1.6.11", "linux-x64")).toBe("1.6.11-0.linux-x64");
  });

  it("preserves build metadata", () => {
    expect(platformVariantVersion("2.0.0-beta.31+build.4", "windows-x64")).toBe(
      "2.0.0-0.beta.31.windows-x64+build.4",
    );
  });
});
