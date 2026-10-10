import { describe, expect, it } from "@effect/vitest";

import { isCredentialRejection, upstreamErrorMessage } from "./credential-rejection";

describe("isCredentialRejection", () => {
  it("treats every 401 as a credential rejection", () => {
    expect(isCredentialRejection({ status: 401, body: "" })).toBe(true);
    expect(isCredentialRejection({ status: 401, body: { message: "nope" } })).toBe(true);
  });

  it("does not treat a plan or permission 403 as a credential rejection", () => {
    for (const body of [
      { message: "feature not available on current billing plan" },
      '{"message":"feature not available on current billing plan"}',
      { error: { status: "PERMISSION_DENIED", message: "Caller lacks permission" } },
      { message: "Resource not accessible by integration" },
      "Forbidden",
      "",
      null,
    ]) {
      expect(isCredentialRejection({ status: 403, body }), JSON.stringify(body)).toBe(false);
    }
  });

  it("treats a 403 carrying an authentication challenge as a credential rejection", () => {
    expect(
      isCredentialRejection({
        status: 403,
        body: null,
        headers: { "WWW-Authenticate": 'Bearer realm="api", error="invalid_token"' },
      }),
    ).toBe(true);
  });

  it("treats a 403 naming a credential error code as a credential rejection", () => {
    expect(isCredentialRejection({ status: 403, body: { error: "invalid_token" } })).toBe(true);
    expect(
      isCredentialRejection({
        status: 403,
        body: { error: { status: "UNAUTHENTICATED", message: "Request had invalid auth" } },
      }),
    ).toBe(true);
  });

  it("treats a 403 whose message names a bad credential as a credential rejection", () => {
    for (const body of [
      { message: "Invalid API key" },
      { message: "Bad credentials" },
      { errors: [{ detail: "The access token has expired" }] },
      "API key is invalid",
      { error: "Not authenticated" },
    ]) {
      expect(isCredentialRejection({ status: 403, body }), JSON.stringify(body)).toBe(true);
    }
  });

  it("does not classify non-credential prose that shares a word", () => {
    expect(isCredentialRejection({ status: 403, body: { message: "invalid request body" } })).toBe(
      false,
    );
    expect(isCredentialRejection({ status: 403, body: { message: "missing field: name" } })).toBe(
      false,
    );
  });
});

describe("upstreamErrorMessage", () => {
  it("reads the message from JSON and plain-text bodies", () => {
    expect(upstreamErrorMessage({ message: "feature not available on current billing plan" })).toBe(
      "feature not available on current billing plan",
    );
    expect(upstreamErrorMessage('{"error":{"message":"db timeout"}}')).toBe("db timeout");
    expect(upstreamErrorMessage("Forbidden")).toBe("Forbidden");
    expect(upstreamErrorMessage({ errors: [{ message: "Not authenticated" }] })).toBe(
      "Not authenticated",
    );
  });

  it("returns undefined when the body carries no text", () => {
    expect(upstreamErrorMessage("")).toBeUndefined();
    expect(upstreamErrorMessage(null)).toBeUndefined();
    expect(upstreamErrorMessage({ data: null })).toBeUndefined();
  });
});
