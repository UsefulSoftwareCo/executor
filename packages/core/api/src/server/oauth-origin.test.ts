import { describe, expect, it } from "@effect/vitest";

import { requestWebOriginFromRequest } from "./execution-stack-middleware";
import { buildOAuthRedirectUri, resolveScopedWebBaseUrl } from "./scoped-executor";

describe("OAuth web origin resolution", () => {
  it("uses the browser loopback origin when a local proxy rewrites the request host", () => {
    const request = new Request("https://127.0.0.1:5394/api/oauth/start", {
      method: "POST",
      headers: { Origin: "https://localhost:5394" },
    });

    expect(requestWebOriginFromRequest(request)).toBe("https://localhost:5394");
  });

  it("does not trust a non-loopback Origin header for redirect origin derivation", () => {
    const request = new Request("https://127.0.0.1:5394/api/oauth/start", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });

    expect(requestWebOriginFromRequest(request)).toBe("https://127.0.0.1:5394");
  });

  it("prefers a loopback request origin over a configured base URL for local browser OAuth", () => {
    expect(
      resolveScopedWebBaseUrl({
        configuredWebBaseUrl: "https://executor.sh",
        requestOrigin: "https://localhost:5394",
      }),
    ).toBe("https://localhost:5394");
  });

  it("keeps the configured base URL for non-local requests", () => {
    expect(
      resolveScopedWebBaseUrl({
        configuredWebBaseUrl: "https://executor.sh",
        requestOrigin: "https://preview.example",
      }),
    ).toBe("https://executor.sh");
  });

  it("uses the host-provided callback path when building OAuth redirect URLs", () => {
    expect(
      buildOAuthRedirectUri({
        webBaseUrl: "https://executor.sh",
        oauthCallbackPath: "/api/oauth/callback",
      }),
    ).toBe("https://executor.sh/api/oauth/callback");
  });

  it("carries the URL org selector in OAuth redirect URLs", () => {
    expect(
      buildOAuthRedirectUri({
        webBaseUrl: "https://executor.sh",
        oauthCallbackPath: "/api/oauth/callback",
        orgSlug: "acme",
      }),
    ).toBe("https://executor.sh/api/oauth/callback?executor_org=acme");
  });
});
