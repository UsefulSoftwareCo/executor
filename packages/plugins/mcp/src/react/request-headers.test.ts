// ---------------------------------------------------------------------------
// The row -> wire conversion behind the request-headers editor. What matters
// is that a half-typed row never reaches the transport and that a pasted
// token still works, so both are pinned here.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";

import { emptyHeaderRow, isValidHeaderName, mcpHeadersFromRows } from "./request-headers";

describe("mcpHeadersFromRows", () => {
  it("returns undefined when nothing is configured", () => {
    expect(mcpHeadersFromRows([])).toBeUndefined();
    expect(mcpHeadersFromRows([emptyHeaderRow()])).toBeUndefined();
  });

  it("builds the wire map from completed rows", () => {
    expect(
      mcpHeadersFromRows([
        { name: "CF-Access-Client-Id", value: "client-id" },
        { name: "CF-Access-Client-Secret", value: "client-secret" },
      ]),
    ).toEqual({
      "CF-Access-Client-Id": "client-id",
      "CF-Access-Client-Secret": "client-secret",
    });
  });

  it("drops a row the user has not finished naming", () => {
    expect(
      mcpHeadersFromRows([
        { name: "X-Api-Key", value: "k" },
        { name: "   ", value: "orphaned" },
      ]),
    ).toEqual({ "X-Api-Key": "k" });
  });

  it("trims surrounding whitespace off a pasted token", () => {
    expect(mcpHeadersFromRows([{ name: "  X-Token  ", value: "  abc123\n" }])).toEqual({
      "X-Token": "abc123",
    });
  });

  it("drops a name that cannot be put on the wire", () => {
    expect(
      mcpHeadersFromRows([
        { name: "Bad Header", value: "v" },
        { name: "Also:Bad", value: "v" },
        { name: "Good-Header", value: "v" },
      ]),
    ).toEqual({ "Good-Header": "v" });
  });

  it("keeps a header whose value is deliberately empty", () => {
    expect(mcpHeadersFromRows([{ name: "X-Empty", value: "" }])).toEqual({ "X-Empty": "" });
  });

  it("lets a later row win a duplicated name", () => {
    expect(
      mcpHeadersFromRows([
        { name: "X-Token", value: "old" },
        { name: "X-Token", value: "new" },
      ]),
    ).toEqual({ "X-Token": "new" });
  });
});

describe("isValidHeaderName", () => {
  it("accepts an RFC 7230 token", () => {
    expect(isValidHeaderName("CF-Access-Client-Id")).toBe(true);
    expect(isValidHeaderName("X_Api_Key")).toBe(true);
  });

  it("treats a blank name as unfinished rather than invalid", () => {
    expect(isValidHeaderName("")).toBe(true);
    expect(isValidHeaderName("   ")).toBe(true);
  });

  it("rejects a name with a space or a colon", () => {
    expect(isValidHeaderName("Bad Header")).toBe(false);
    expect(isValidHeaderName("Also:Bad")).toBe(false);
  });
});
