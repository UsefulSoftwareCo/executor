import { describe, expect, it } from "@effect/vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { createToolCaller } from "./proxy";

describe("artifact tool-call failure surfacing", () => {
  const hostReturning = (structuredContent: Record<string, unknown>) => ({
    callServerTool: (): Promise<CallToolResult> =>
      Promise.resolve({
        content: [{ type: "text", text: "" }],
        structuredContent,
      }),
  });

  const call = (host: { callServerTool: () => Promise<CallToolResult> }) =>
    createToolCaller(host, () => Promise.resolve({ action: "cancel" as const }))(
      ["github_com", "search_pull_requests"],
      [{ query: "is:open" }],
    );

  it("rejects with the error message of a code-mode failure envelope", async () => {
    const host = hostReturning({
      status: "completed",
      result: {
        ok: false,
        error: {
          code: "tool_not_found",
          message: "Tool not found: github_com.search_pull_requests",
        },
      },
    });
    await expect(call(host)).rejects.toThrow("Tool not found: github_com.search_pull_requests");
  });

  it("falls back to the error code when no message is present", async () => {
    const host = hostReturning({
      status: "completed",
      result: { ok: false, error: { code: "binding_unresolved" } },
    });
    await expect(call(host)).rejects.toThrow("binding_unresolved");
  });

  it("passes a successful envelope through as data", async () => {
    const host = hostReturning({
      status: "completed",
      result: { ok: true, data: { total_count: 2, items: [{ id: 1 }, { id: 2 }] } },
    });
    await expect(call(host)).resolves.toEqual({
      ok: true,
      data: { total_count: 2, items: [{ id: 1 }, { id: 2 }] },
    });
  });
});
