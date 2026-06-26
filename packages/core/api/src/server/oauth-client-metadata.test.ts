import { describe, expect, it } from "@effect/vitest";

import { oauthClientIdMetadataDocumentFromRequest } from "./oauth-client-metadata";

describe("OAuth client ID metadata document", () => {
  it("builds an org-scoped hosted document from a target path", () => {
    const metadata = oauthClientIdMetadataDocumentFromRequest({
      requestUrl: "/api/oauth/client-id-metadata/acme.json",
      webRequest: new Request("http://127.0.0.1:42384/api/oauth/client-id-metadata/acme.json", {
        headers: { Host: "100.81.219.45:42384" },
      }),
      mountPrefix: "/api",
    });

    expect(metadata.client_id).toBe(
      "http://100.81.219.45:42384/api/oauth/client-id-metadata/acme.json",
    );
    expect(metadata.redirect_uris).toEqual([
      "http://100.81.219.45:42384/api/oauth/callback?executor_org=acme",
    ]);
    expect(metadata.token_endpoint_auth_method).toBe("none");
    expect(metadata.application_type).toBe("web");
  });

  it("uses forwarded host and protocol for proxy-facing hosted documents", () => {
    const metadata = oauthClientIdMetadataDocumentFromRequest({
      requestUrl: "/api/oauth/client-id-metadata/default.json",
      webRequest: new Request("http://127.0.0.1:3000/api/oauth/client-id-metadata/default.json", {
        headers: {
          "x-forwarded-host": "wsl-dev.tail5665af.ts.net",
          "x-forwarded-proto": "https",
          Host: "127.0.0.1:3000",
        },
      }),
      mountPrefix: "/api",
    });

    expect(metadata.client_id).toBe(
      "https://wsl-dev.tail5665af.ts.net/api/oauth/client-id-metadata/default.json",
    );
    expect(metadata.redirect_uris).toEqual([
      "https://wsl-dev.tail5665af.ts.net/api/oauth/callback",
    ]);
  });

  it("serves a hosted local document with portless loopback callbacks", () => {
    const metadata = oauthClientIdMetadataDocumentFromRequest({
      requestUrl: "/api/oauth/client-id-metadata/local.json",
      webRequest: new Request("http://127.0.0.1:3000/api/oauth/client-id-metadata/local.json", {
        headers: {
          "x-forwarded-host": "executor.sh",
          "x-forwarded-proto": "https",
          Host: "127.0.0.1:3000",
        },
      }),
      mountPrefix: "/api",
    });

    expect(metadata.client_id).toBe("https://executor.sh/api/oauth/client-id-metadata/local.json");
    expect(metadata.redirect_uris).toEqual([
      "http://127.0.0.1/api/oauth/callback",
      "http://localhost/api/oauth/callback",
      "http://[::1]/api/oauth/callback",
    ]);
    expect(metadata.application_type).toBe("native");
  });

  it("still reads the org selector from the legacy query form", () => {
    const metadata = oauthClientIdMetadataDocumentFromRequest({
      requestUrl: "/api/oauth/client-id-metadata.json?executor_org=acme",
      webRequest: new Request("http://127.0.0.1:42384/api/oauth/client-id-metadata.json", {
        headers: { Host: "100.81.219.45:42384" },
      }),
      mountPrefix: "/api",
    });

    expect(metadata.client_id).toBe(
      "http://100.81.219.45:42384/api/oauth/client-id-metadata.json?executor_org=acme",
    );
    expect(metadata.redirect_uris).toEqual([
      "http://100.81.219.45:42384/api/oauth/callback?executor_org=acme",
    ]);
  });
});
