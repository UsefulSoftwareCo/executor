import { describe, expect, it } from "@effect/vitest";

import { connectionIdentifier } from "./connection-name";

describe("connectionIdentifier", () => {
  it("converts display labels to lower camel case", () => {
    expect(String(connectionIdentifier("Personal GitHub"))).toBe("personalGithub");
    expect(String(connectionIdentifier("github_com oauth"))).toBe("githubComOauth");
    expect(String(connectionIdentifier("axiom-mcp-oauth"))).toBe("axiomMcpOauth");
  });

  it("uses a valid leading identifier character", () => {
    expect(String(connectionIdentifier("123 key"))).toBe("connection123Key");
  });

  it("uses the fallback for empty labels", () => {
    expect(String(connectionIdentifier("   ", "apiKey"))).toBe("apiKey");
  });
});
