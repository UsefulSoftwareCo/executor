import { describe, expect, it } from "@effect/vitest";
import type { ContentBlock } from "@modelcontextprotocol/client";

import { classifyMcpHealthFailure, classifyMcpHealthProbe } from "./health-probe";

describe("configured MCP health probe", () => {
  it("treats an isError result as a failure and keeps none of its text", () => {
    const errorContents: ContentBlock[][] = [
      [{ type: "text", text: "synthetic private account and message" }],
      [{ type: "text", text: "CUSTOMER_PRIVATE_NAME" }],
      [
        { type: "text", text: "FIRST_CODE" },
        { type: "text", text: "SECOND_CODE" },
      ],
      [{ type: "text", text: "KEY_SYNTHETICSECRET" }],
    ];
    for (const content of errorContents) {
      // Structured output beside the error is ignored too: no sample, no identity.
      const result = classifyMcpHealthProbe(
        { isError: true, content, structuredContent: { email: "private@example.test" } },
        { identityField: "email", secrets: ["SYNTHETICSECRET"] },
      );
      expect(result).toEqual({
        status: "degraded",
        checkedAt: expect.any(Number),
        reason: "probe_failed",
        detail: "MCP health probe returned an error.",
      });
    }
  });

  // The SDK client has already validated the rest of the result; structured
  // output is the one part it leaves untyped.
  it("refuses structured output that is not a JSON object", () => {
    for (const structuredContent of [42, "text", null, ["array"]]) {
      expect(classifyMcpHealthProbe({ content: [], structuredContent })).toMatchObject({
        status: "degraded",
        reason: "probe_failed",
        detail: "Malformed MCP probe response.",
      });
    }
  });

  it("takes identity from structured output and redacts credential values", () => {
    const result = classifyMcpHealthProbe(
      {
        content: [],
        structuredContent: { name: "synthetic", token: "x", innocent: "pre-secret-post" },
      },
      { identityField: "name", secrets: ["secret", ""] },
    );
    expect(result.status).toBe("healthy");
    expect(result.identity).toBe("synthetic");
    expect(result.responseSample).toEqual([
      { path: "name", value: "synthetic" },
      { path: "token", value: "[redacted]" },
      { path: "innocent", value: "pre-[redacted]-post" },
    ]);
  });

  it("redacts an identity field that names a credential or echoes one", () => {
    const structuredContent = { api_key: "sk-synthetic", login: "user-secret" };
    expect(
      classifyMcpHealthProbe({ content: [], structuredContent }, { identityField: "api_key" })
        .identity,
    ).toBe("[redacted]");
    expect(
      classifyMcpHealthProbe(
        { content: [], structuredContent },
        { identityField: "login", secrets: ["secret"] },
      ).identity,
    ).toBe("user-[redacted]");
  });

  it("reads identity from a later JSON text block unless structured output exists", () => {
    const content: ContentBlock[] = [
      { type: "image", data: "", mimeType: "image/png" },
      { type: "text", text: "synthetic explanation" },
      { type: "text", text: '{"email":"synthetic@example.test"}' },
    ];
    expect(classifyMcpHealthProbe({ content }, { identityField: "email" })).toMatchObject({
      identity: "synthetic@example.test",
      responseSample: [{ path: "email", value: "synthetic@example.test" }],
    });
    expect(
      classifyMcpHealthProbe(
        { content, structuredContent: { email: "structured@example.test" } },
        { identityField: "email" },
      ).identity,
    ).toBe("structured@example.test");
  });

  it("stays healthy without identity when the response has no usable body", () => {
    const result = classifyMcpHealthProbe(
      { content: [{ type: "text", text: "plain prose" }] },
      { identityField: "email" },
    );
    expect(result.status).toBe("healthy");
    expect(result.identity).toBeUndefined();
    expect(result.responseSample).toEqual([]);
  });

  it("drops a sample whose path holds a credential", () => {
    const result = classifyMcpHealthProbe(
      {
        content: [],
        structuredContent: { SYNTHETIC_CREDENTIAL: "ok", nested: { SYNTHETIC_CREDENTIAL: 1 } },
      },
      { secrets: ["SYNTHETIC_CREDENTIAL"] },
    );
    expect(result.status).toBe("healthy");
    expect(result.responseSample).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_CREDENTIAL");
  });

  it("removes overlapping and nested credentials whole", () => {
    const result = classifyMcpHealthProbe(
      {
        content: [],
        structuredContent: {
          contained: "a-abc-b-abcdef-c",
          overlapping: "x-abcXdef-y",
        },
      },
      { secrets: ["abc", "abcdef", "abcX", "Xdef"] },
    );
    expect(result.responseSample).toEqual([
      { path: "contained", value: "a-[redacted]-b-[redacted]-c" },
      { path: "overlapping", value: "x-[redacted]-y" },
    ]);
  });
});

describe("MCP health failure classification", () => {
  it("separates scope shortfall, rejected credential, and unavailable server", () => {
    expect(
      classifyMcpHealthFailure({ stage: "list_tools", httpStatus: 403, insufficientScope: true }),
    ).toMatchObject({ status: "misconfigured", httpStatus: 403, reason: "upstream_status" });
    expect(classifyMcpHealthFailure({ stage: "connect", httpStatus: 401 })).toMatchObject({
      status: "expired",
      reason: "upstream_status",
    });
    expect(
      classifyMcpHealthFailure({ stage: "list_tools", reauthorizationRequired: true }),
    ).toMatchObject({ status: "expired", reason: "probe_failed" });
    expect(classifyMcpHealthFailure({ stage: "connect", timedOut: true })).toMatchObject({
      status: "degraded",
      reason: "probe_timeout",
    });
    expect(classifyMcpHealthFailure({ stage: "call_tool", httpStatus: 503 })).toEqual({
      status: "degraded",
      checkedAt: expect.any(Number),
      httpStatus: 503,
      reason: "upstream_status",
      detail: "MCP health probe call failed (HTTP 503).",
    });
    expect(classifyMcpHealthFailure({ stage: "list_tools" })).toMatchObject({
      status: "degraded",
      reason: "probe_failed",
      detail: "Failed listing MCP tools.",
    });
  });
});
