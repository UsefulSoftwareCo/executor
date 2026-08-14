import { describe, expect, it } from "@effect/vitest";
import { InsufficientScopeError, SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";

// oxlint-disable executor/no-error-constructor -- boundary: these tests reproduce the MCP SDK's own transport rejections, which are built-in Errors
import { insufficientScopeFromCause } from "./http-status";

// The MCP SDK surfaces a 403 two ways, and both must classify:
//   - no authProvider: the transport throws with the response body embedded
//     in the message ("Error POSTing to endpoint: <body>");
//   - with an authProvider (the production OAuth path): the StreamableHTTP
//     transport consumes the insufficient_scope challenge itself, retries
//     with the broader scope, and only when THAT fails throws the fixed
//     typed `InsufficientScopeError`, or after retry exhaustion the fixed
//     `SdkHttpError` step-up message.
describe("insufficientScopeFromCause", () => {
  it("detects the OAuth error body embedded in a transport message", () => {
    expect(
      insufficientScopeFromCause(
        new Error(
          'Error POSTing to endpoint: {"error":"insufficient_scope","error_description":"needs files.read"}',
        ),
      ),
    ).toBe(true);
  });

  it("detects a Google ErrorInfo body embedded in a transport message", () => {
    expect(
      insufficientScopeFromCause(
        new Error(
          'Error POSTing to endpoint: {"error":{"details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}',
        ),
      ),
    ).toBe(true);
  });

  it("detects the SDK's typed insufficient-scope failure", () => {
    expect(
      insufficientScopeFromCause(new InsufficientScopeError({ requiredScope: "files.read" })),
    ).toBe(true);
  });

  it("detects the SDK's exhausted step-up failure (the authProvider path)", () => {
    expect(
      insufficientScopeFromCause(
        new SdkHttpError(
          SdkErrorCode.ClientHttpForbidden,
          "Server returned 403 insufficient_scope after step-up re-authorization (retry limit 2 reached)",
          { status: 403 },
        ),
      ),
    ).toBe(true);
  });

  it("ignores prose that merely mentions the tokens", () => {
    expect(
      insufficientScopeFromCause(
        new Error(
          "Error POSTing to endpoint: see the OAuth docs about insufficient_scope handling",
        ),
      ),
    ).toBe(false);
  });

  it("ignores non-error causes", () => {
    expect(insufficientScopeFromCause(undefined)).toBe(false);
    expect(insufficientScopeFromCause("insufficient_scope")).toBe(false);
  });
});
