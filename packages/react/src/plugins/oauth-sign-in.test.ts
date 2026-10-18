import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  canUseClientIdMetadataDocument,
  isPubliclyReachableUrl,
  oauthCallbackUrl,
  oauthClientIdMetadataDocumentUrl,
} from "./oauth-sign-in";

// The legacy query-param org selector the metadata-document URL must NOT use
// (org is carried in the path instead). Mirrors the server-side constant.
const OAUTH_CALLBACK_ORG_QUERY_PARAM = "executor_org";

const originalWindow = globalThis.window;

const setLocation = (href: string): void => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: new URL(href) },
  });
};

afterEach(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
    return;
  }
  Reflect.deleteProperty(globalThis, "window");
});

describe("oauthClientIdMetadataDocumentUrl", () => {
  it("returns a relative default metadata path outside the browser", () => {
    Reflect.deleteProperty(globalThis, "window");
    expect(oauthClientIdMetadataDocumentUrl()).toBe("/api/oauth/client-id-metadata/default.json");
  });

  it("carries the active org slug from the console URL", () => {
    setLocation("https://executor.sh/acme/integrations/posthog");

    const url = new URL(oauthClientIdMetadataDocumentUrl());

    expect(url.toString()).toBe("https://executor.sh/api/oauth/client-id-metadata/acme.json");
    expect(url.search).toBe("");
  });

  it("uses the hosted local document when configured", () => {
    setLocation("http://localhost:4788/integrations/posthog");

    expect(
      oauthClientIdMetadataDocumentUrl({
        hostedBaseUrl: "https://executor.sh",
      }),
    ).toBe("https://executor.sh/api/oauth/client-id-metadata/local.json");
  });
});

describe("oauthCallbackUrl", () => {
  it("returns a relative callback path outside the browser", () => {
    Reflect.deleteProperty(globalThis, "window");
    expect(oauthCallbackUrl()).toBe("/api/oauth/callback");
  });

  it("keeps the callback URL static from an org console URL", () => {
    setLocation("https://executor.sh/acme/integrations/posthog");

    const url = new URL(oauthCallbackUrl());

    expect(url.toString()).toBe("https://executor.sh/api/oauth/callback");
    expect(url.search).toBe("");
  });

  it("does not add an org selector on bare app routes", () => {
    setLocation("https://executor.sh/login");

    expect(oauthCallbackUrl()).toBe("https://executor.sh/api/oauth/callback");
  });
});

describe("oauthClientIdMetadataDocumentUrl", () => {
  it("returns a relative metadata path outside the browser", () => {
    Reflect.deleteProperty(globalThis, "window");
    expect(oauthClientIdMetadataDocumentUrl()).toBe("/api/oauth/client-id-metadata/default.json");
  });

  it("carries the active org slug from the console URL", () => {
    setLocation("https://executor.sh/acme/integrations/posthog");

    const url = new URL(oauthClientIdMetadataDocumentUrl());

    expect(url.toString()).toBe("https://executor.sh/api/oauth/client-id-metadata/acme.json");
    expect(url.searchParams.has(OAUTH_CALLBACK_ORG_QUERY_PARAM)).toBe(false);
  });
});

describe("isPubliclyReachableUrl", () => {
  it("accepts public https hosts", () => {
    expect(
      isPubliclyReachableUrl("https://executor.sh/api/oauth/client-id-metadata/default.json"),
    ).toBe(true);
    expect(isPubliclyReachableUrl("https://8.8.8.8:8446/x.json")).toBe(true);
  });

  it("rejects hosts an authorization server can't fetch", () => {
    for (const url of [
      "/api/oauth/client-id-metadata/default.json",
      "http://executor.example.com/x.json",
      "https://localhost:4788/x.json",
      "https://executor/x.json",
      "https://box.example.ts.net:8446/x.json",
      "https://nas.local/x.json",
      "https://10.0.0.5/x.json",
      "https://192.168.1.20/x.json",
      "https://172.20.0.3/x.json",
      "https://100.64.0.7/x.json",
      "https://[::1]/x.json",
      "https://[fd7a:115c:a1e0::1]/x.json",
    ]) {
      expect(isPubliclyReachableUrl(url), url).toBe(false);
    }
  });
});

describe("canUseClientIdMetadataDocument", () => {
  const privateDocument =
    "https://box.example.ts.net:8446/api/oauth/client-id-metadata/default.json";

  it("uses CIMD when the document is public", () => {
    expect(
      canUseClientIdMetadataDocument({
        clientIdMetadataDocumentUrl:
          "https://executor.sh/api/oauth/client-id-metadata/default.json",
        authorizationUrl: "https://auth.example.com/authorize",
      }),
    ).toBe(true);
  });

  it("uses DCR when a public provider can't fetch a private document", () => {
    expect(
      canUseClientIdMetadataDocument({
        clientIdMetadataDocumentUrl: privateDocument,
        authorizationUrl: "https://auth.example.com/authorize",
      }),
    ).toBe(false);
  });

  it("uses CIMD when the provider is on a private host too", () => {
    expect(
      canUseClientIdMetadataDocument({
        clientIdMetadataDocumentUrl:
          "http://localhost:4788/api/oauth/client-id-metadata/default.json",
        authorizationUrl: "http://localhost:9000/authorize",
      }),
    ).toBe(true);
    expect(
      canUseClientIdMetadataDocument({
        clientIdMetadataDocumentUrl: privateDocument,
        authorizationUrl: "https://sso.example.ts.net/authorize",
      }),
    ).toBe(true);
  });

  it("keeps CIMD when the provider is unknown", () => {
    expect(canUseClientIdMetadataDocument({ clientIdMetadataDocumentUrl: privateDocument })).toBe(
      true,
    );
  });
});
