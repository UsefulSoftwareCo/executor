import { describe, expect, it } from "@effect/vitest";

import {
  isClientChannelFrameWithinLimit,
  isValidMcpClientManifest,
  MCP_CLIENT_CHANNEL_MAX_FRAME_LENGTH,
} from "./client-channel";

describe("self-host MCP client channel manifest validation", () => {
  it("accepts a valid capability manifest", () => {
    expect(
      isValidMcpClientManifest({
        tools: [{ name: "read" }],
        resources: [{ uri: "workspace://README.md" }],
        prompts: [{ name: "review" }],
      }),
    ).toBe(true);
  });

  it("rejects manifests over the capability count and duplicate-name limits", () => {
    expect(
      isValidMcpClientManifest({
        tools: Array.from({ length: 101 }, (_, index) => ({ name: `tool-${index}` })),
        resources: [],
        prompts: [],
      }),
    ).toBe(false);
    expect(
      isValidMcpClientManifest({
        tools: [{ name: "same" }, { name: "same" }],
        resources: [],
        prompts: [],
      }),
    ).toBe(false);
  });

  it("rejects invalid and oversized channel frames", () => {
    expect(
      isValidMcpClientManifest({
        tools: [{ name: "" }],
        resources: [],
        prompts: [],
      }),
    ).toBe(false);
    expect(isClientChannelFrameWithinLimit("x".repeat(MCP_CLIENT_CHANNEL_MAX_FRAME_LENGTH))).toBe(
      true,
    );
    expect(
      isClientChannelFrameWithinLimit("x".repeat(MCP_CLIENT_CHANNEL_MAX_FRAME_LENGTH + 1)),
    ).toBe(false);
  });
});
