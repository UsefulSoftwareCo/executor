import { describe, expect, it } from "@effect/vitest";

import { serverInitiatedMessagesPossible, standaloneStreamNotOffered } from "./standalone-stream";

describe("serverInitiatedMessagesPossible", () => {
  it("keeps the stream available before capabilities are negotiated", () => {
    expect(serverInitiatedMessagesPossible(undefined)).toBe(true);
  });

  it("refuses the stream for a client that declared no capabilities", () => {
    expect(serverInitiatedMessagesPossible({})).toBe(false);
  });

  it("offers the stream to clients the server may send requests to", () => {
    expect(serverInitiatedMessagesPossible({ elicitation: {} })).toBe(true);
    expect(serverInitiatedMessagesPossible({ elicitation: { form: {} } })).toBe(true);
    expect(serverInitiatedMessagesPossible({ sampling: {} })).toBe(true);
    expect(serverInitiatedMessagesPossible({ roots: { listChanged: true } })).toBe(true);
  });

  it("offers the stream to an MCP Apps host, whose tool list can change", () => {
    expect(
      serverInitiatedMessagesPossible({
        extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
      } as never),
    ).toBe(true);
  });

  it("ignores capabilities that admit no server-initiated message", () => {
    expect(serverInitiatedMessagesPossible({ experimental: { anything: {} } })).toBe(false);
    expect(
      serverInitiatedMessagesPossible({
        extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/plain"] } },
      } as never),
    ).toBe(false);
  });
});

describe("standaloneStreamNotOffered", () => {
  it("is a 405 that names the methods the endpoint still serves", async () => {
    const response = standaloneStreamNotOffered();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, DELETE");
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = (await response.json()) as { error: { code: number }; id: null };
    expect(body.error.code).toBe(-32000);
    expect(body.id).toBeNull();
  });
});
