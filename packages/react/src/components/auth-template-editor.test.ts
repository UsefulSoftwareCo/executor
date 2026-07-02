import { describe, expect, it } from "@effect/vitest";

import {
  emptyApiKeyValue,
  emptyOAuthValue,
  emptyValueForKind,
  parseScopes,
  type AuthTemplateEditorValue,
} from "./auth-template-editor";

describe("parseScopes", () => {
  it("splits a comma-separated string into trimmed, non-empty scopes", () => {
    expect(parseScopes("read, write,  admin ")).toEqual(["read", "write", "admin"]);
  });

  it("drops empty segments (trailing comma, double comma)", () => {
    expect(parseScopes("read,,write,")).toEqual(["read", "write"]);
  });

  it("returns an empty list for a blank string", () => {
    expect(parseScopes("   ")).toEqual([]);
    expect(parseScopes("")).toEqual([]);
  });
});

describe("emptyValueForKind (tab switching)", () => {
  it("none → { kind: 'none' }", () => {
    expect(emptyValueForKind("none")).toEqual({ kind: "none" });
  });

  it("apikey → one editable Authorization header placement", () => {
    expect(emptyValueForKind("apikey")).toEqual(emptyApiKeyValue());
    const value = emptyValueForKind("apikey");
    if (value.kind !== "apikey") throw new Error("expected apikey");
    expect(value.placements).toEqual([{ carrier: "header", name: "Authorization", prefix: "" }]);
  });

  it("oauth → empty endpoints + scopes", () => {
    expect(emptyValueForKind("oauth")).toEqual(emptyOAuthValue());
    const value: AuthTemplateEditorValue = emptyValueForKind("oauth");
    if (value.kind !== "oauth") throw new Error("expected oauth");
    expect(value.authorizationUrl).toBe("");
    expect(value.tokenUrl).toBe("");
    expect(value.scopes).toEqual([]);
  });
});
