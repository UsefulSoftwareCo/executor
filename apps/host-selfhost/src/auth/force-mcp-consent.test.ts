import { describe, expect, it } from "@effect/vitest";

import {
  consentRedirectClientId,
  promptWithConsent,
  withClientName,
  withForcedMcpConsent,
} from "./force-mcp-consent";

describe("promptWithConsent", () => {
  it("adds consent to an empty prompt", () => {
    expect(promptWithConsent(null)).toBe("consent");
    expect(promptWithConsent("")).toBe("consent");
  });
  it("preserves other prompt values without duplicating consent", () => {
    expect(promptWithConsent("login")).toBe("login consent");
    expect(promptWithConsent("consent")).toBe("consent");
    expect(promptWithConsent("login consent")).toBe("login consent");
  });
});

describe("withForcedMcpConsent", () => {
  const authorize = (qs: string) => new Request(`https://host.example/api/auth/mcp/authorize${qs}`);

  it("injects prompt=consent on MCP authorize", () => {
    const out = withForcedMcpConsent(authorize("?client_id=abc&response_type=code"));
    expect(new URL(out.url).searchParams.get("prompt")).toBe("consent");
  });

  it("merges with an existing prompt", () => {
    const out = withForcedMcpConsent(authorize("?client_id=abc&prompt=login"));
    expect(new URL(out.url).searchParams.get("prompt")).toBe("login consent");
  });

  it("leaves an already-consent request unchanged (same instance)", () => {
    const req = authorize("?client_id=abc&prompt=consent");
    expect(withForcedMcpConsent(req)).toBe(req);
  });

  it("never touches non-authorize or non-GET requests", () => {
    const other = new Request("https://host.example/api/auth/mcp/token", { method: "POST" });
    expect(withForcedMcpConsent(other)).toBe(other);
    const consent = new Request("https://host.example/api/auth/oauth2/consent", { method: "POST" });
    expect(withForcedMcpConsent(consent)).toBe(consent);
  });
});

describe("consentRedirectClientId", () => {
  it("returns the client id of a consent redirect lacking a name", () => {
    expect(consentRedirectClientId("/mcp-consent?consent_code=c&client_id=abc&scope=openid")).toBe(
      "abc",
    );
  });
  it("returns null when the name is already present, or it isn't a consent redirect", () => {
    expect(consentRedirectClientId("/mcp-consent?client_id=abc&client_name=Codex")).toBeNull();
    expect(consentRedirectClientId("/login?client_id=abc")).toBeNull();
    expect(consentRedirectClientId(null)).toBeNull();
  });
});

describe("withClientName", () => {
  it("appends client_name to a consent redirect (path+query only)", () => {
    expect(withClientName("/mcp-consent?consent_code=c&client_id=abc", "Claude Code")).toBe(
      "/mcp-consent?consent_code=c&client_id=abc&client_name=Claude+Code",
    );
  });
});
