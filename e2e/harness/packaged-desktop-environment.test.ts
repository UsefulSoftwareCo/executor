import { describe, expect, it } from "@effect/vitest";

import { selectPackagedDesktopRuntimeEnvironment } from "../src/desktop/packaged";

describe("packaged desktop environment isolation", () => {
  it("inherits GUI runtime state without forwarding ambient credentials", () => {
    const selected = selectPackagedDesktopRuntimeEnvironment({
      PATH: "/fixture/bin",
      DISPLAY: ":99",
      XAUTHORITY: "/fixture/.Xauthority",
      LANG: "en_US.UTF-8",
      GITHUB_TOKEN: "github-secret",
      ANTHROPIC_API_KEY: "anthropic-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      HTTPS_PROXY: "https://user:password@proxy.example",
      NODE_OPTIONS: "--require=/tmp/ambient-hook.js",
    });

    expect(selected).toEqual({
      PATH: "/fixture/bin",
      DISPLAY: ":99",
      XAUTHORITY: "/fixture/.Xauthority",
      LANG: "en_US.UTF-8",
    });
    expect("GITHUB_TOKEN" in selected).toBe(false);
    expect("ANTHROPIC_API_KEY" in selected).toBe(false);
    expect("AWS_SECRET_ACCESS_KEY" in selected).toBe(false);
    expect("HTTPS_PROXY" in selected).toBe(false);
    expect("NODE_OPTIONS" in selected).toBe(false);
  });
});
