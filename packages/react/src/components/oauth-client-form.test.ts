import { describe, expect, it } from "@effect/vitest";

import { canSubmitOAuthClientForm, registrationScopes } from "./oauth-client-form";

const validBase = {
  submitting: false,
  name: "PostHog",
  clientId: "https://example.com/oauth/client-id-metadata.json",
  clientSecret: "secret",
  authorizationUrl: "https://us.posthog.com/oauth/authorize",
  tokenUrl: "https://us.posthog.com/oauth/token",
} as const;

describe("registrationScopes", () => {
  it("sends declared scopes and ignores discovered when declared scopes exist", () => {
    // Declared (template) scopes are authoritative — a discovered set never wins.
    expect(registrationScopes(["a", "b"], ["x"])).toEqual(["a", "b"]);
  });

  it("sends discovered scopes when none are declared", () => {
    expect(registrationScopes([], ["x", "y"])).toEqual(["x", "y"]);
  });

  it("uses the current discovered set so a re-Discover replaces a prefilled probe", () => {
    // Probe of server A seeds the discovered state; a later Discover of server B
    // replaces it. With nothing declared, B's scopes register — not the stale A
    // set that arrived via the DCR fallback prefill.
    const seededFromProbeA = ["a:read"];
    const rediscoveredFromB = ["b:write"];
    expect(registrationScopes([], seededFromProbeA)).toEqual(["a:read"]);
    expect(registrationScopes([], rediscoveredFromB)).toEqual(["b:write"]);
  });

  it("returns empty when nothing is declared or discovered", () => {
    expect(registrationScopes([], [])).toEqual([]);
  });
});

describe("canSubmitOAuthClientForm", () => {
  it("allows authorization-code public clients with no client secret", () => {
    expect(
      canSubmitOAuthClientForm({
        ...validBase,
        grant: "authorization_code",
        clientSecret: "",
      }),
    ).toBe(true);
  });

  it("keeps client secret required for client-credentials clients", () => {
    expect(
      canSubmitOAuthClientForm({
        ...validBase,
        grant: "client_credentials",
        clientSecret: "",
      }),
    ).toBe(false);
  });

  it("requires an authorization URL for authorization-code clients", () => {
    expect(
      canSubmitOAuthClientForm({
        ...validBase,
        grant: "authorization_code",
        clientSecret: "",
        authorizationUrl: "",
      }),
    ).toBe(false);
  });
});
