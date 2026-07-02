import { afterEach, describe, expect, it } from "@effect/vitest";

import { oauthCallbackUrl, oauthClientIdMetadataDocumentUrl } from "./oauth-sign-in";

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
